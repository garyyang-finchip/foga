import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jcs, sha256Hex } from "../core/canonical.js";
import type { Catalog } from "../tools/catalog.js";
import type { Caller } from "../tools/types.js";
import { chooseTender } from "./model/stub.js";
import { ModelError, type ContentBlock, type ModelAdapter, type ModelMessage, type Situation, type SituationTender, type ToolSpec } from "./model/types.js";
import type { Node } from "./node.js";

/** The model's proposals arrive through this caller: act level, the operator's view, entrance `runner`. */
export const RUNNER_CALLER: Caller = { id: "runner", entrance: "runner", level: "act", visibility: "operator" };

export interface RunnerOptions {
  /** Tool calls the runner carries out per tick (default from the configuration, 12). */
  maxToolCallsPerTick?: number;
  /** Acts per tick, pre-checks not counted (default from the configuration, 2). */
  maxActsPerTick?: number;
  /** Write each tick's full transcript here (debugging only; nothing of it enters the store or the evidence). */
  transcriptsDir?: string;
  log?: (line: string) => void;
}

export interface RunnerTickReport {
  at: string;
  block: number;
  /** Why the model was not called, when it was not. */
  skipped: string | null;
  modelCalls: number;
  toolCalls: number;
  acts: number;
  decisions: number[];
  refusals: { capability: string; gate: string; reason: string }[];
  trajectoryHash: string | null;
  error: string | null;
  tenders: { tokenId: string; status: SituationTender["status"]; gate?: string }[];
}

/** The key under which the runner counts the model calls of one UTC day. */
export const modelCallsKey = (day = new Date().toISOString().slice(0, 10)) => `runner.model.calls.${day}`;

const JOURNAL_SEQ_FACT = "runner.journal.seq";

/**
 * The runner (design memo, Phase 3, section 8): the node's loop with a model in it. Each tick perceives through the
 * read capabilities, hands the situation and the capability catalog to the model as tools, carries out what it
 * proposes — reads at once, acts through `Catalog.invoke` where the three checks decide — gives the result or the
 * refusal back so the model can revise, and records the tick: the decision records the catalog wrote, the hash of
 * the whole transcript, and the counts. Limits bound a tick (tool calls, acts, the day's model calls); nothing a
 * model says reaches the chain except through the catalog, and nothing it says is kept except by hash. The watchers
 * (heartbeat, settlement, withdrawal, discovery) do not pass through the model; they run beside the runner.
 */
/**
 * How long a refusal at a gate that depends on what others do, or on time, is held against a tender before the
 * runner looks again. A tender is minted and its answer committed in the hashlock verifier in two transactions, so a
 * pre-check that lands between them is refused at the verifier ("no committed answer for this tender yet") — true
 * then, false a block later; the budget's day rolls; a safety verdict changes with the guardian. Such a refusal
 * lapses after this long and the tender reads as open again, to be pre-checked afresh (a read: no cost, no act).
 * A refusal at a gate the situation cannot change — policy, skill, input, a verifier mismatch — stands.
 */
export const TRANSIENT_REFUSAL_MS = 60_000;

/** A settlement the chain will never take: the verifier holds a different answer than this submission's. */
export function settlementDead(d: { gate: string; reason: string }): boolean {
  return /verification failed/i.test(d.reason);
}

export function refusalLapsed(d: { gate: string; reason: string; at: string }, nowMs: number): boolean {
  const transient = d.gate === "budget" || d.gate === "safety" || (d.gate === "verifier" && /no committed answer/.test(d.reason)) || (d.gate === "wallet" && !settlementDead(d));
  if (!transient) return false;
  const at = Date.parse(d.at);
  return Number.isFinite(at) && nowMs - at >= TRANSIENT_REFUSAL_MS;
}

export class Runner {
  private readonly maxToolCalls: number;
  private readonly maxActs: number;
  private readonly log: (line: string) => void;
  private ticks = 0;

  constructor(
    readonly node: Node,
    readonly catalog: Catalog,
    readonly adapter: ModelAdapter,
    private readonly opts: RunnerOptions = {},
  ) {
    this.maxToolCalls = opts.maxToolCallsPerTick ?? node.config.runtime.model.maxToolCallsPerTick;
    this.maxActs = opts.maxActsPerTick ?? node.config.runtime.model.maxActsPerTick;
    this.log = opts.log ?? node.log;
  }

  /** The tools the model gets: the reads and the acts of the catalog as this caller sees them (no admin, no build or dry-run variants). */
  tools(): ToolSpec[] {
    return this.catalog
      .list(RUNNER_CALLER)
      .filter((c) => c.action === "read" || (c.action === "act" && c.modes.includes("act")))
      .map((c) => ({ name: c.name, description: c.description, inputSchema: c.inputSchema }));
  }

  /** What the model is told once per tick, before the situation. */
  system(): string {
    const cfg = this.node.config;
    return [
      `You are the runner of FOGA cell ${cfg.name} (account ${this.node.body.address}), an agent on the ten-ERC stack. You decide which open ERC-8414 tenders the cell takes and carry them through: tender_inspect, tender_precheck (eligible: false names the gate that refuses), skill_run with the task's input, tender_submit with the run's resultHash and runReceipt, tender_settle with the run's answer, credit_withdraw when a settlement credited rather than paid.`,
      `Every act you propose is judged by the cell's catalog: permission, the policy below, the budget, the account's own gate. A refusal (ok: false, gate, reason, decisionId) is the cell's verdict; do not look for a way around it and do not retry the same act with cosmetic changes. A tender whose status is failed (a run or a submission of the cell's failed) answers with that failure; leave it. Reads are free; acts are limited per tick (the situation says how many). Say briefly what you are doing and why; stop when there is nothing left to decide.`,
      `The cell's policy (what it takes and how much it may move): ${JSON.stringify(cfg.policy)}.`,
    ].join("\n");
  }

  /** The situation of this tick, composed from the read capabilities and the store. */
  async situation(): Promise<Situation> {
    const node = this.node;
    const k = node.kernel;
    const cell = node.body.address;
    const invoke = (name: string, input: Record<string, unknown> = {}) => this.catalog.invoke(node, name, input, RUNNER_CALLER);
    const [block, statusR, listR, anchor] = await Promise.all([k.blockNumber(), invoke("cell_status"), invoke("tender_list"), k.aid.stateName(cell)]);
    const status = statusR.ok ? (statusR.output as { safety: { verdict: string; reasons: string[] }; skills: { held: string[]; offered: string[] } }) : null;
    const decisions = node.store.decisions({ limit: 5000 });
    const runnerPrechecks = decisions.filter((d) => d.caller === RUNNER_CALLER.id && d.capability === "tender_precheck");
    const runnerSettles = decisions.filter((d) => d.capability === "tender_settle");
    const jobs = node.store.jobs(null, 5000);
    const runs = jobs.filter((j) => j.kind === "skill-run" && j.status === "done");
    const held = await node.heldSkills().catch(() => []);

    const tenders: SituationTender[] = [];
    if (listR.ok) {
      const open = (listR.output as { tenders: { tokenId: string; demander: string }[] }).tenders.filter((t) => t.demander.toLowerCase() !== cell.toLowerCase());
      for (const t of open.slice(0, 20)) {
        const r = await invoke("tender_inspect", { tokenId: t.tokenId });
        if (!r.ok) continue;
        const v = r.output as { tokenId: string; demander: string; rewardWei: string; escrowWei: string; submitBy: number; settleBy: number; completions: number; maxCompletions: number; acceptanceAuthority: string; task: SituationTender["task"]; submissions: { id: string; fulfiller: string; status: number; resultHash: string }[] };
        const mine = v.submissions.filter((s) => s.fulfiller.toLowerCase() === cell.toLowerCase()).at(-1) ?? null;
        const credit = await k.tenders.creditOf(BigInt(t.tokenId), cell).catch(() => 0n);
        let st: SituationTender["status"] = "open";
        let gate: string | undefined;
        let reason: string | undefined;
        const failedJob = jobs.find((j) => j.status === "failed" && ((j.kind === "skill-run" && String((j.input as { tokenId?: string } | null)?.tokenId) === t.tokenId) || (j.kind === "tender" && j.id.startsWith(`tender:${t.tokenId}:`))));
        if (mine && mine.status === 1) st = "settled";
        else if (mine && mine.status === 0) {
          // a pending submission the cell has tried to settle: a refusal the chain will not take back (the committed
          // answer is not this one) ends the matter, and a refusal that may pass holds the tender back for a while, so
          // the runner's one tender a tick is not the same dead one forever while others wait (the Sepolia tender 48)
          const lastSettle = runnerSettles.filter((d) => d.jobId?.startsWith(`tender:${t.tokenId}:`)).at(-1);
          if (lastSettle?.verdict === "refused" && settlementDead(lastSettle)) {
            st = "failed";
            gate = lastSettle.gate;
            reason = lastSettle.reason;
          } else if (lastSettle?.verdict === "refused" && !refusalLapsed(lastSettle, Date.now())) {
            st = "refused";
            gate = lastSettle.gate;
            reason = lastSettle.reason;
          } else st = "submitted";
        } else if (failedJob) {
          st = "failed";
          gate = "execution";
          reason = `${failedJob.kind} ${failedJob.id} failed: ${(failedJob.error ?? "no reason recorded").slice(0, 200)}`;
        } else {
          const last = runnerPrechecks.filter((d) => d.jobId === `precheck:${t.tokenId}`).at(-1);
          if (last?.verdict === "allowed") st = "eligible";
          else if (last && !refusalLapsed(last, Date.now())) {
            st = "refused";
            gate = last.gate;
            reason = last.reason;
          }
        }
        const answer = mine ? ((runs.find((j) => (j.result as { resultHash?: string } | null)?.resultHash?.toLowerCase() === mine.resultHash.toLowerCase())?.result as { answer?: string } | null)?.answer ?? null) : null;
        tenders.push({
          tokenId: v.tokenId,
          demander: v.demander,
          rewardWei: v.rewardWei,
          escrowWei: v.escrowWei,
          submitBy: v.submitBy,
          settleBy: v.settleBy,
          completions: v.completions,
          maxCompletions: v.maxCompletions,
          acceptanceAuthority: v.acceptanceAuthority,
          task: v.task ? { skill: v.task.skill, packageHash: v.task.packageHash, input: v.task.input, acceptance: v.task.acceptance } : null,
          status: st,
          ...(gate ? { gate, reason } : {}),
          submission: mine ? { submissionId: mine.id, status: mine.status, resultHash: mine.resultHash, answer } : null,
          creditWei: credit.toString(),
        });
      }
    }

    const since = node.store.getFact<number>(JOURNAL_SEQ_FACT) ?? 0;
    const events = node.store
      .journalEntries()
      .filter((e) => e.seq > since && (e.event === "tender-discovered" || e.event === "safety-changed"))
      .map((e) => ({ seq: e.seq, at: e.at, event: e.event, detail: e.detail }));
    const use = node.budgetUse();
    const cfg = node.config;
    return {
      at: new Date().toISOString(),
      block,
      chainId: node.chainId,
      cell: { name: cfg.name, account: cell, operator: cfg.identity.operator, anchor, safety: status?.safety ?? { verdict: "unknown", reasons: [] } },
      budget: {
        dailyValueWei: cfg.policy.budget.dailyValueWei,
        perOperationValueWei: cfg.policy.budget.perOperationValueWei,
        dailyGasWei: cfg.policy.budget.dailyGasWei,
        maxConcurrentCommitments: cfg.policy.budget.maxConcurrentCommitments,
        valueWei: use.valueWei.toString(),
        gasWei: use.gasWei.toString(),
        reservedValueWei: use.reservedValueWei.toString(),
        reservedFeeWei: use.reservedFeeWei.toString(),
        runningCommitments: use.runningCommitments,
        model: { callsToday: this.modelCallsToday(), dailyCalls: cfg.runtime.model.dailyCalls },
      },
      policy: cfg.policy.tenders,
      skills: { held: held.map((h) => ({ name: h.name, packageHash: h.packageHash })), offered: cfg.skills.offered },
      tenders,
      events,
      // the last forty, plus the runner's own mints however old (the stub's one-time over-budget proposal is recognized by its record)
      recentDecisions: [...decisions.filter((d) => d.caller === RUNNER_CALLER.id && d.capability === "tender_mint" && !decisions.slice(-40).includes(d)), ...decisions.slice(-40)].map((d) => ({ id: d.id, at: d.at, caller: d.caller, capability: d.capability, mode: d.mode, verdict: d.verdict, gate: d.gate, reason: d.reason, jobId: d.jobId })),
      limits: { toolCalls: this.maxToolCalls, acts: this.maxActs },
    };
  }

  modelCallsToday(): number {
    return this.node.store.getFact<number>(modelCallsKey()) ?? 0;
  }

  private countModelCall(): void {
    const key = modelCallsKey();
    this.node.store.setFact(key, (this.node.store.getFact<number>(key) ?? 0) + 1);
  }

  /** One tick: perceive, propose, decide, execute, record. */
  async tick(): Promise<RunnerTickReport> {
    const node = this.node;
    this.ticks++;
    const situation = await this.situation();
    const lastSeq = Math.max(node.store.getFact<number>(JOURNAL_SEQ_FACT) ?? 0, ...situation.events.map((e) => e.seq));
    const report: RunnerTickReport = { at: situation.at, block: situation.block, skipped: null, modelCalls: 0, toolCalls: 0, acts: 0, decisions: [], refusals: [], trajectoryHash: null, error: null, tenders: situation.tenders.map((t) => ({ tokenId: t.tokenId, status: t.status, ...(t.gate ? { gate: t.gate } : {}) })) };

    // event-driven: the model is called when something asks for a decision — an actionable tender or a new event
    if (!chooseTender(situation) && situation.events.length === 0) {
      report.skipped = "nothing to propose";
      node.store.setFact(JOURNAL_SEQ_FACT, lastSeq);
      return report;
    }
    if (situation.budget.model.callsToday >= situation.budget.model.dailyCalls) {
      report.skipped = `the day's ${situation.budget.model.dailyCalls} model calls are spent`;
      node.store.journal("runner-skipped", { at: situation.at, block: situation.block, reason: report.skipped });
      node.store.setFact(JOURNAL_SEQ_FACT, lastSeq);
      return report;
    }

    const system = this.system();
    const tools = this.tools();
    const offered = new Set(tools.map((t) => t.name));
    const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: JSON.stringify(situation) }] }];
    const maxRounds = this.maxToolCalls + 2;
    try {
      for (let round = 0; round < maxRounds; round++) {
        const request = { system, messages, tools };
        const promptHash = sha256Hex(jcs(request));
        this.countModelCall();
        report.modelCalls++;
        const res = await this.adapter.propose(request);
        const responseHash = sha256Hex(jcs(res.content));
        messages.push({ role: "assistant", content: res.content });
        const uses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
        if (uses.length === 0) break;
        const results: ContentBlock[] = [];
        for (const use of uses) {
          const answer = (content: unknown, isError = false): void => {
            results.push({ type: "tool_result", tool_use_id: use.id, content: typeof content === "string" ? content : JSON.stringify(content, (_k, v) => (typeof v === "bigint" ? v.toString() : v)), ...(isError ? { is_error: true } : {}) });
          };
          if (!offered.has(use.name)) {
            answer({ ok: false, gate: "permission", reason: `${use.name} is not a tool of this runner` }, true);
            continue;
          }
          if (report.toolCalls >= this.maxToolCalls) {
            answer({ ok: false, gate: "limit", reason: `this tick's ${this.maxToolCalls} tool calls are used; the rest waits for the next tick` }, true);
            continue;
          }
          report.toolCalls++;
          const cap = this.catalog.get(use.name)!;
          if (cap.action === "read") {
            const r = await this.catalog.invoke(node, use.name, use.input, RUNNER_CALLER);
            answer(r.ok ? r.output : { ok: false, gate: r.gate, reason: r.reason }, !r.ok);
            continue;
          }
          const counted = use.name !== "tender_precheck";
          if (counted && report.acts >= this.maxActs) {
            answer({ ok: false, gate: "limit", reason: `this tick's ${this.maxActs} acts are used; the rest waits for the next tick` }, true);
            continue;
          }
          if (counted) report.acts++;
          const r = await this.catalog.invoke(node, use.name, use.input, RUNNER_CALLER, { mode: "act", model: { provider: this.adapter.provider, model: this.adapter.model, promptHash, responseHash } });
          if (r.decisionId !== undefined) report.decisions.push(r.decisionId);
          if (use.name === "tender_precheck") {
            answer(r.ok ? { eligible: true, decisionId: r.decisionId ?? null, result: r.output } : { eligible: false, gate: r.gate, reason: r.reason, decisionId: r.decisionId ?? null });
            if (!r.ok) report.refusals.push({ capability: use.name, gate: r.gate, reason: r.reason });
            continue;
          }
          if (r.ok) answer({ ok: true, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null, operations: r.operations ?? [], output: r.output });
          else {
            report.refusals.push({ capability: use.name, gate: r.gate, reason: r.reason });
            answer({ ok: false, gate: r.gate, reason: r.reason, decisionId: r.decisionId ?? null, jobId: r.jobId ?? null }, true);
          }
        }
        messages.push({ role: "user", content: results });
      }
    } catch (e) {
      report.error = e instanceof ModelError ? `model: ${e.message}` : (e as Error).message;
      this.log(`runner: ${report.error}`);
      node.store.journal("runner-model-error", { at: situation.at, block: situation.block, provider: this.adapter.provider, model: this.adapter.model, message: report.error });
    }

    report.trajectoryHash = sha256Hex(jcs({ system, tools: tools.map((t) => t.name), messages }));
    node.store.journal("runner-tick", { at: situation.at, block: situation.block, provider: this.adapter.provider, model: this.adapter.model, modelCalls: report.modelCalls, toolCalls: report.toolCalls, acts: report.acts, decisions: report.decisions, refusals: report.refusals, trajectoryHash: report.trajectoryHash, tenders: report.tenders, error: report.error });
    node.store.setFact(JOURNAL_SEQ_FACT, lastSeq);
    if (this.opts.transcriptsDir) {
      mkdirSync(this.opts.transcriptsDir, { recursive: true });
      writeFileSync(join(this.opts.transcriptsDir, `${situation.at.replace(/[:.]/g, "-")}-tick-${String(this.ticks).padStart(4, "0")}.json`), JSON.stringify({ at: situation.at, system, tools: tools.map((t) => t.name), messages, report }, null, 2));
    }
    this.log(`runner tick ${this.ticks} at block ${report.block}: ${report.modelCalls} model call(s), ${report.toolCalls} tool call(s), ${report.acts} act(s), decisions [${report.decisions.join(", ")}]${report.refusals.length ? `, refused at ${report.refusals.map((r) => `${r.capability}:${r.gate}`).join(", ")}` : ""}; trajectory ${report.trajectoryHash.slice(0, 18)}…`);
    return report;
  }
}

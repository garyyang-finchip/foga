import { z } from "zod";
import { jcs, sha256Hex } from "../core/canonical.js";
import { OperationConflict, type DecisionRecord, type JobRecord, type OpBinding } from "../kernel/store.js";
import { OperationAmbiguous, OperationReverted, type Confirmed } from "../kernel/tx.js";
import { budgetGate, firstRefusal, type Gate } from "../node/policy.js";
import type { Node } from "../node/node.js";
import { ACTION_RANK, VISIBILITY_RANK, type ActCapability, type ActPlan, type ActStep, type Action, type Caller, type Capability, type Intent, type Mode, type Refusal, type Success, type ToolResult, type Visibility } from "./types.js";

/** Gas reserved per step against the fee budget until the operation settles and its real cost replaces it. */
export const FEE_RESERVE_GAS = 300_000n;

export interface InvokeOptions {
  mode?: Mode;
  /** The model behind a proposal (the runner): recorded by hash, never by text. */
  model?: { provider: string; model: string; promptHash: string; responseHash: string };
}

/** What `list` tells a caller about a capability it may use. */
export interface CapabilitySummary {
  name: string;
  title: string;
  description: string;
  action: Action;
  visibility: Visibility;
  principal: string;
  ercs: number[];
  /** The highest mode this caller may use: null for read capabilities and for capabilities the caller may not use at all. */
  modes: Mode[];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

/**
 * The capability catalog and the one place authorization happens (design memo, Phase 3, section 3). `invoke` runs
 * the three checks for every act — call permission (who may use what, at which level), business authorization (the
 * policy engine over the plan the capability made), wallet permission (the account's own scope, simulated before
 * the send and enforced again on chain) — and writes a decision record for every attempt. Reads pass the
 * permission check alone and leave no record. The entrances (CLI, MCP, HTTP, A2A) call this and nothing else.
 */
export class Catalog {
  private readonly caps = new Map<string, Capability>();

  register(cap: Capability): this {
    if (this.caps.has(cap.name)) throw new Error(`capability ${cap.name} registered twice`);
    this.caps.set(cap.name, cap);
    return this;
  }

  get(name: string): Capability | undefined {
    return this.caps.get(name);
  }

  names(): string[] {
    return [...this.caps.keys()];
  }

  /** The capabilities a caller may use, with the modes its level allows. */
  list(caller: Caller): CapabilitySummary[] {
    const out: CapabilitySummary[] = [];
    for (const cap of this.caps.values()) {
      if (VISIBILITY_RANK[caller.visibility] < VISIBILITY_RANK[cap.visibility]) continue;
      const modes = modesFor(caller, cap);
      if (cap.action !== "read" && modes.length === 0) continue;
      out.push({
        name: cap.name,
        title: cap.title,
        description: cap.description,
        action: cap.action,
        visibility: cap.visibility,
        principal: cap.principal,
        ercs: cap.ercs,
        modes,
        inputSchema: z.toJSONSchema(cap.input, { target: "draft-2020-12", io: "input" }) as Record<string, unknown>,
        outputSchema: z.toJSONSchema(cap.output, { target: "draft-2020-12", io: "output" }) as Record<string, unknown>,
      });
    }
    return out;
  }

  async invoke(node: Node, name: string, rawInput: unknown, caller: Caller, opts: InvokeOptions = {}): Promise<ToolResult> {
    const cap = this.caps.get(name);
    if (!cap) return { ok: false, gate: "input", reason: `unknown capability ${name}` };
    const mode: Mode = opts.mode ?? "act";
    const inputHash = hashInput(rawInput);

    // the data scope first: a capability the caller may not see is as if it did not exist (a read leaves no record)
    if (VISIBILITY_RANK[caller.visibility] < VISIBILITY_RANK[cap.visibility]) {
      const reason = `${cap.name} is ${cap.visibility}-visible; this caller sees ${caller.visibility} data`;
      return cap.action === "read" ? { ok: false, gate: "permission", reason } : this.refuse(node, cap, caller, mode, inputHash, "permission", reason);
    }
    const parsed = cap.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
      return this.refuse(node, cap, caller, mode, inputHash, "input", issues);
    }
    const input = parsed.data;

    if (cap.action === "read") {
      if (ACTION_RANK[caller.level] < ACTION_RANK.read) return { ok: false, gate: "permission", reason: "no read permission" };
      const output = await cap.handler({ node, caller }, input);
      return { ok: true, output: cap.output.parse(output) };
    }

    // call permission: the mode decides the level needed (a build or a dry run needs build; the act itself needs act or admin)
    const needed: Action = mode === "act" ? cap.action : "build";
    if (ACTION_RANK[caller.level] < ACTION_RANK[needed]) {
      return this.refuse(node, cap, caller, mode, inputHash, "permission", `${cap.name} in mode ${mode} needs level ${needed}; this caller has ${caller.level}`);
    }
    if (mode === "act" && cap.signer && !node.hasKey(cap.signer)) {
      return this.refuse(node, cap, caller, mode, inputHash, "permission", `${cap.name} is the ${cap.signer}'s act and this process holds no ${cap.signer} key`);
    }
    const asInput = (input as { as?: string }).as;
    const as = mode === "build" && asInput ? asInput : node.cell?.address ?? asInput ?? "0x0000000000000000000000000000000000000000";

    let plan: ActPlan;
    try {
      plan = await cap.plan({ node, caller, mode, as }, input);
    } catch (e) {
      return this.refuse(node, cap, caller, mode, inputHash, "input", explain(e));
    }
    const jobId = plan.job.id;

    if (mode === "build") {
      const calls = plan.calls ?? (await buildAll(plan.steps));
      const decision = node.store.decide({ entrance: caller.entrance, caller: caller.id, capability: cap.name, mode, inputHash, verdict: "allowed", gate: "build", reason: `${calls.length} call(s) built for ${as}`, jobId, operationId: null, model: opts.model ?? null });
      return { ok: true, output: { as, calls: calls.map((c) => ({ to: c.target, value: c.value.toString(), data: c.data, label: c.label })) }, decisionId: decision.id, jobId };
    }

    // an act under a known job: the same job with the same input is answered from the store, never done twice;
    // a job is created only once every gate has passed, so a refusal leaves a decision record and nothing else
    let job: JobRecord | null = null;
    if (mode === "act" && !plan.job.ephemeral) {
      const existing = node.store.getJob(jobId);
      if (existing) {
        if (existing.inputHash !== inputHash) return this.refuse(node, cap, caller, mode, inputHash, "conflict", `job ${jobId} exists for another request (${existing.inputHash}); the same job id must carry the same request`, jobId);
        if (existing.status === "done") {
          const decision = node.store.decide({ entrance: caller.entrance, caller: caller.id, capability: cap.name, mode, inputHash, verdict: "allowed", gate: "idempotent", reason: `job ${jobId} is done; its result is returned, nothing is sent again`, jobId, operationId: existing.operations[0] ?? null, model: opts.model ?? null });
          return { ok: true, output: existing.result, decisionId: decision.id, jobId, operations: existing.operations };
        }
        if (existing.status === "failed" || existing.status === "cancelled") {
          return this.refuse(node, cap, caller, mode, inputHash, "execution", `job ${jobId} ${existing.status} before (${existing.error ?? "no reason recorded"}); the same job answers with that outcome. A new attempt is a new job (another idempotency key).`, jobId);
        }
        job = existing; // accepted or running: a run that stopped before finishing is continued (the kernel sends nothing twice)
      }
    }

    // business authorization: the capability's gates, then the budget (a cell's act only; an admin step is the owner's own transaction)
    const gates: Gate[] = [...plan.gates];
    if (cap.action === "act" && (plan.steps.length || plan.valueWei > 0n || plan.job.commitment)) {
      const fee = await feeReserve(node, plan.steps.length);
      gates.push(budgetGate(node.config, node.budgetUse(), { valueWei: plan.valueWei, feeReserveWei: fee, commitment: Boolean(plan.job.commitment) && !job }));
    }
    const refusal = firstRefusal(gates);
    if (refusal) return this.refuse(node, cap, caller, mode, inputHash, refusal.gate, refusal.reason, jobId);

    // wallet permission: the first step is simulated from its signer (the account's allow-list, gate and daily cap decide on chain as well)
    const confirmed: Confirmed[] = [];
    if (plan.steps.length) {
      const first = plan.steps[0];
      const intent = await first.build(confirmed);
      const route = routeOf(first);
      const from = node.config.identity[route.signer];
      const to = route.route === "execute" ? node.body.address : intent.target;
      const data = route.route === "execute" ? node.body.encodeExecute(intent.target, intent.value, intent.data) : intent.data;
      const value = route.route === "execute" ? 0n : intent.value;
      const revert = await node.wouldRevert(from, to, data, value);
      if (revert !== null) return this.refuse(node, cap, caller, mode, inputHash, "wallet", `${first.name} would revert: ${revert}`, jobId);
    }

    if (mode === "simulate") {
      const decision = node.store.decide({ entrance: caller.entrance, caller: caller.id, capability: cap.name, mode, inputHash, verdict: "allowed", gate: "all", reason: summarize(gates, plan.steps.length), jobId, operationId: null, model: opts.model ?? null });
      const output = await plan.output([], undefined);
      return { ok: true, output: cap.output.parse(output), decisionId: decision.id, jobId };
    }

    // the act: recorded as allowed before anything is sent, then each step as a keyed, bound operation
    const allowed = node.store.decide({ entrance: caller.entrance, caller: caller.id, capability: cap.name, mode, inputHash, verdict: "allowed", gate: "all", reason: summarize(gates, plan.steps.length), jobId, operationId: plan.steps.length ? `job:${jobId}:${plan.steps[0].name}` : null, model: opts.model ?? null });
    if (plan.job.ephemeral) {
      const output = cap.output.parse(await plan.output([], plan.work ? await plan.work() : undefined));
      return { ok: true, output, decisionId: allowed.id, jobId };
    }
    if (!job) job = node.store.createJob({ id: jobId, kind: plan.job.kind, caller: caller.id, cell: node.cell?.address, inputHash, input: plan.job.input });
    node.store.updateJob(jobId, { status: "running" });
    const operations: string[] = [...job.operations];
    try {
      const work = plan.work ? await plan.work() : undefined;
      const fee = await feeReserve(node, 1);
      for (const step of plan.steps) {
        const intent = await step.build(confirmed);
        const key = `job:${jobId}:${step.name}`;
        const binding: OpBinding = { requestHash: inputHash, capability: cap.name, caller: caller.id, cell: node.cell?.address, valueWei: intent.value, feeCapWei: fee };
        const route = routeOf(step);
        let c: Confirmed;
        if (route.route === "execute") {
          c = await node.body.execute(key, intent.target, intent.data, { value: intent.value, by: route.signer === "owner" ? "owner" : "operator", binding });
        } else {
          c = await node.kernel.tx.send({ key, signer: node.signerOf(route.signer), kind: "direct", binding, build: () => ({ to: intent.target, data: intent.data, value: intent.value }) });
        }
        confirmed.push(c);
        if (!operations.includes(key)) operations.push(key);
        node.store.updateJob(jobId, { addOperation: key });
      }
      const output = cap.output.parse(await plan.output(confirmed, work));
      node.store.updateJob(jobId, { status: "done", result: output });
      return { ok: true, output, decisionId: allowed.id, jobId, operations };
    } catch (e) {
      const reason = explain(e);
      const operationId = e instanceof OperationReverted || e instanceof OperationAmbiguous ? (e as { key?: string; op?: { key: string } }).key ?? (e as { op?: { key: string } }).op?.key ?? null : operations.at(-1) ?? null;
      node.store.updateJob(jobId, { status: "failed", error: reason });
      const decision = node.store.decide({ entrance: caller.entrance, caller: caller.id, capability: cap.name, mode, inputHash, verdict: "refused", gate: "execution", reason, jobId, operationId, model: opts.model ?? null });
      return { ok: false, gate: "execution", reason, decisionId: decision.id, jobId };
    }
  }

  private refuse(node: Node, cap: Capability, caller: Caller, mode: Mode, inputHash: string, gate: string, reason: string, jobId?: string): Refusal {
    const decision: DecisionRecord = node.store.decide({ entrance: caller.entrance, caller: caller.id, capability: cap.name, mode, inputHash, verdict: "refused", gate, reason, jobId: jobId ?? null, operationId: null, model: null });
    return { ok: false, gate, reason, decisionId: decision.id, jobId };
  }
}

export function hashInput(input: unknown): string {
  return sha256Hex(jcs(input ?? {}));
}

function modesFor(caller: Caller, cap: Capability): Mode[] {
  if (cap.action === "read") return [];
  const out: Mode[] = [];
  if (ACTION_RANK[caller.level] >= ACTION_RANK.build) out.push("simulate", "build");
  if (ACTION_RANK[caller.level] >= ACTION_RANK[cap.action]) out.push("act");
  return out;
}

function routeOf(step: ActStep): { route: "execute" | "direct"; signer: "operator" | "owner" | "guardian" } {
  return { route: step.route ?? "execute", signer: step.by ?? "operator" };
}

async function buildAll(steps: ActStep[]): Promise<Intent[]> {
  const out: Intent[] = [];
  for (const s of steps) {
    try {
      out.push(await s.build([]));
    } catch {
      break; // a later step that needs an earlier receipt cannot be built ahead
    }
  }
  return out;
}

async function feeReserve(node: Node, steps: number): Promise<bigint> {
  if (!steps) return 0n;
  const fee = await node.world.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  return BigInt(steps) * FEE_RESERVE_GAS * price;
}

function summarize(gates: Gate[], steps: number): string {
  const names = [...new Set(gates.map((g) => g.gate))];
  return `all gates passed (${names.join(", ")}); ${steps} step(s)`;
}

function explain(e: unknown): string {
  if (e instanceof OperationReverted || e instanceof OperationAmbiguous) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/** True when a result is a success (for callers that narrow). */
export function succeeded<O>(r: ToolResult<O>): r is Success<O> {
  return r.ok;
}

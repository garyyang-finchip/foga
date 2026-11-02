import type { ContentBlock, ModelAdapter, ProposeRequest, ProposeResult, Situation, SituationTender } from "./types.js";

/**
 * The deterministic stand-in for a model (design memo, Phase 3, section 8): a fixed decision table over the
 * situation and the transcript of the tick so far, so the same situation always yields the same proposals and a
 * CI run needs no key and no network. It does what a careful operator's model would — inspect a tender, pre-check
 * it, run the skill, submit, settle, withdraw — and one thing a careful model would not: once per cell it proposes a
 * tender whose reward is five times the per-operation cap, so the evidence shows the budget gate closing on a
 * proposal (case g). It never looks for a way around a refusal: a refused pre-check ends its interest in that
 * tender until the situation changes (a safety refusal is retried once the binding is Satisfied again).
 *
 * The stub is a pure function of the request: it keeps no state between calls. Everything it needs to know about
 * what happened earlier in the tick is in the tool_use and tool_result blocks the runner put in the transcript.
 */
export const STUB_MODEL = "foga-stub/1";

interface Done {
  name: string;
  input: Record<string, unknown>;
  result: unknown;
  isError: boolean;
}

function firstUserText(req: ProposeRequest): string {
  for (const m of req.messages) if (m.role === "user") for (const b of m.content) if (b.type === "text") return b.text;
  throw new Error("the stub needs the situation as the first user message");
}

/** The tool calls of this tick so far, each with its result (parsed when it is JSON). */
function transcript(req: ProposeRequest): Done[] {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const out: Done[] = [];
  for (const m of req.messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") uses.set(b.id, { name: b.name, input: b.input });
      if (b.type === "tool_result") {
        const use = uses.get(b.tool_use_id);
        if (!use) continue;
        let result: unknown = b.content;
        try {
          result = JSON.parse(b.content);
        } catch {
          /* text */
        }
        out.push({ name: use.name, input: use.input, result, isError: Boolean(b.is_error) });
      }
    }
  }
  return out;
}

const tokenOf = (d: Done): string | undefined => (typeof d.input.tokenId === "string" ? d.input.tokenId : undefined);

/** Which tender to work on: the lowest id that still asks for something. */
export function chooseTender(s: Situation): SituationTender | null {
  const satisfied = s.cell.safety.verdict === "Satisfied";
  const actionable = s.tenders.filter((t) => {
    if (t.status === "open" || t.status === "eligible") return true;
    if (t.status === "submitted") return t.submission?.status === 0;
    if (t.status === "settled") return BigInt(t.creditWei) > 0n;
    if (t.status === "refused") return t.gate === "safety" && satisfied;
    return false;
  });
  actionable.sort((a, b) => (BigInt(a.tokenId) < BigInt(b.tokenId) ? -1 : 1));
  return actionable[0] ?? null;
}

export class StubAdapter implements ModelAdapter {
  readonly provider = "stub" as const;
  readonly model = STUB_MODEL;

  async propose(req: ProposeRequest): Promise<ProposeResult> {
    const s = JSON.parse(firstUserText(req)) as Situation;
    const done = transcript(req);
    let n = done.length;
    const call = (name: string, input: Record<string, unknown>): ContentBlock => ({ type: "tool_use", id: `stub-${++n}`, name, input });
    const turn = (text: string, ...uses: ContentBlock[]): ProposeResult => ({ content: [{ type: "text", text }, ...uses], stopReason: uses.length ? "tool_use" : "end_turn", usage: { inputTokens: 0, outputTokens: 0 } });
    const has = (name: string) => req.tools.some((t) => t.name === name);

    // g. once per cell: a tender above the per-operation cap, on purpose — the budget gate must refuse it
    const triedBefore = s.recentDecisions.some((d) => d.capability === "tender_mint" && d.caller === "runner") || done.some((d) => d.name === "tender_mint");
    if (!triedBefore && has("tender_mint") && s.skills.held.length) {
      const probe = s.skills.held.find((h) => h.name === "foga-probe") ?? s.skills.held[0];
      const reward = (BigInt(s.budget.perOperationValueWei) * 5n).toString();
      return turn(
        `Proposing a tender for ${probe.name} with a reward of ${reward} wei, five times the per-operation cap of ${s.budget.perOperationValueWei} wei. The budget gate should refuse this; the refusal is the point.`,
        call("tender_mint", { skill: probe.name, packageHash: probe.packageHash, input: { purpose: "stub case g" }, answerHash: "0x" + "11".repeat(32), rewardWei: reward, submitIn: 86400, settleIn: 7 * 86400 }),
      );
    }

    const t = chooseTender(s);
    if (!t) return turn("Nothing to do: no open tender asks for a decision and nothing of mine is pending.");
    const mine = done.filter((d) => tokenOf(d) === t.tokenId);
    const last = mine.at(-1);
    if (last?.isError) return turn(`${last.name} on tender ${t.tokenId} answered an error; stopping here for this tick.`);
    const by = (name: string) => mine.find((d) => d.name === name);

    // a pending submission of mine: settle, then withdraw what was credited
    if (t.status === "submitted" && t.submission?.status === 0) {
      const settled = by("tender_settle");
      if (!settled) {
        if (!t.submission.answer) return turn(`Tender ${t.tokenId}: my submission is pending but no run of mine holds its answer; leaving it to the operator.`);
        return turn(`Tender ${t.tokenId}: settling my pending submission ${t.submission.submissionId}.`, call("tender_settle", { tokenId: t.tokenId, submissionId: t.submission.submissionId, answer: t.submission.answer }));
      }
      const out = (settled.result as { output?: { creditWei?: string } }).output;
      if (out?.creditWei && BigInt(out.creditWei) > 0n && !by("credit_withdraw")) return turn(`Tender ${t.tokenId}: ${out.creditWei} wei were credited rather than paid; withdrawing.`, call("credit_withdraw", { tokenId: t.tokenId }));
      return turn(`Tender ${t.tokenId}: settled.`);
    }
    if (t.status === "settled") {
      if (!by("credit_withdraw")) return turn(`Tender ${t.tokenId}: withdrawing the credited ${t.creditWei} wei.`, call("credit_withdraw", { tokenId: t.tokenId }));
      return turn(`Tender ${t.tokenId}: credit withdrawn.`);
    }

    // a tender to judge: inspect, pre-check, run, submit — in that order, one step per turn
    if (!by("tender_inspect")) return turn(`Looking at tender ${t.tokenId} (${t.task?.skill ?? "no task document"}, reward ${t.rewardWei} wei).`, call("tender_inspect", { tokenId: t.tokenId }));
    const pre = by("tender_precheck");
    if (!pre) return turn(`Pre-checking tender ${t.tokenId} against the cell's gates.`, call("tender_precheck", { tokenId: t.tokenId }));
    const verdict = pre.result as { eligible?: boolean; gate?: string; reason?: string };
    if (!verdict.eligible) return turn(`Tender ${t.tokenId} is not for this cell: refused at ${verdict.gate ?? "?"} (${verdict.reason ?? "no reason given"}). Not looking for a way around it.`);
    if (!t.task) return turn(`Tender ${t.tokenId} passed the pre-check but has no readable task document; stopping.`);
    const run = by("skill_run");
    if (!run) return turn(`Running ${t.task.skill} for tender ${t.tokenId}.`, call("skill_run", { skill: t.task.skill, input: t.task.input, tokenId: t.tokenId }));
    const runOut = (run.result as { output?: { resultHash?: string; runReceipt?: unknown } }).output;
    if (!runOut?.resultHash) return turn(`The run for tender ${t.tokenId} returned no result hash; stopping.`);
    if (!by("tender_submit")) return turn(`Submitting the result of tender ${t.tokenId}.`, call("tender_submit", { tokenId: t.tokenId, resultHash: runOut.resultHash, runReceipt: runOut.runReceipt }));
    return turn(`Tender ${t.tokenId}: submitted; the settlement is the next tick's (or the watchers').`);
  }
}

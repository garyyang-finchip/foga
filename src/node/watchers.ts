import type { Catalog } from "../tools/catalog.js";
import type { Caller } from "../tools/types.js";
import type { Node } from "./node.js";

/** The node acting for itself: the watchers propose nothing to a model and need no key beyond the operator's. */
export const WATCHER_CALLER: Caller = { id: "watcher", entrance: "runner", level: "act", visibility: "operator" };

export interface TickReport {
  at: string;
  block: number;
  heartbeat: { sent: boolean; reason: string };
  discovered: string[];
  settled: { tokenId: string; submissionId: string; outcome: string }[];
  withdrawn: { tokenId: string; outcome: string }[];
  safety: { verdict: string; reasons: string[]; changed: boolean };
  anchor: string;
}

/**
 * The watchers (design memo, Phase 3, section 2): what a node does without being asked and without a model —
 * keep the anchor alive, notice new tenders, finish what it committed to once the chain lets it (settle a pending
 * submission whose answer it holds, withdraw credited reward), and record a change of its safety state. Each duty
 * goes through the catalog like any caller, so it passes the same gates and leaves the same records. `tick` runs
 * every duty once; the serve loop (3b) calls it on the poll interval.
 */
export class Watchers {
  constructor(
    readonly node: Node,
    readonly catalog: Catalog,
  ) {}

  async tick(): Promise<TickReport> {
    const node = this.node;
    const k = node.kernel;
    const cell = node.body;
    const block = await k.blockNumber();
    const now = await node.now();

    // 1. liveness: heartbeat when less than half the window is left
    const anchor = await k.aid.stateName(cell.address);
    let heartbeat: TickReport["heartbeat"] = { sent: false, reason: `anchor ${anchor}` };
    if (anchor === "ACTIVE" || anchor === "STALE") {
      const [window, lastSeen] = await Promise.all([k.aid.livenessWindow(cell.address), k.aid.lastSeen(cell.address)]);
      const left = Number(lastSeen) + window - now;
      if (anchor === "STALE" || left < window / 2) {
        const r = await this.catalog.invoke(node, "aid_heartbeat", { jobId: `heartbeat:${Math.floor(now / Math.max(60, Math.floor(window / 2)))}` }, WATCHER_CALLER);
        heartbeat = r.ok ? { sent: true, reason: `${left} s of ${window} s left` } : { sent: false, reason: `${r.gate}: ${r.reason}` };
      } else heartbeat = { sent: false, reason: `${left} s of ${window} s left` };
    }

    // 2. discovery: open tenders not seen before are recorded as facts for the runner (3c) and reported
    const discovered: string[] = [];
    const list = await this.catalog.invoke(node, "tender_list", {}, WATCHER_CALLER);
    if (list.ok) {
      for (const t of (list.output as { tenders: { tokenId: string; demander: string; rewardWei: string }[] }).tenders) {
        if (t.demander.toLowerCase() === cell.address.toLowerCase()) continue;
        const key = `watch.tender.${t.tokenId}`;
        if (k.fact(key) === undefined) {
          k.setFact(key, { seenAt: now, block, rewardWei: t.rewardWei, demander: t.demander });
          k.store.journal("tender-discovered", { tokenId: t.tokenId, demander: t.demander, rewardWei: t.rewardWei, block });
          discovered.push(t.tokenId);
        }
      }
    }

    // 3. completion: a pending submission of the cell whose answer a skill run holds is settled; credited reward is withdrawn
    const settled: TickReport["settled"] = [];
    const withdrawn: TickReport["withdrawn"] = [];
    const jobs = k.store.jobs(null, 1000);
    const runs = jobs.filter((j) => j.kind === "skill-run" && j.status === "done");
    for (const job of jobs.filter((j) => j.kind === "tender" && j.status === "done")) {
      const result = job.result as { tokenId?: string; submissionId?: string } | null;
      if (!result?.tokenId || result.submissionId === undefined) continue;
      const tokenId = BigInt(result.tokenId);
      const sub = await k.tenders.submissionOf(tokenId, BigInt(result.submissionId)).catch(() => null);
      if (!sub) continue;
      if (sub.status === 0) {
        const run = runs.find((r) => (r.result as { resultHash?: string } | null)?.resultHash?.toLowerCase() === sub.resultHash.toLowerCase());
        const answer = (run?.result as { answer?: string } | null)?.answer;
        if (!answer) continue;
        const r = await this.catalog.invoke(node, "tender_settle", { tokenId: result.tokenId, submissionId: result.submissionId, answer, jobId: `${job.id}:settle` }, WATCHER_CALLER);
        settled.push({ tokenId: result.tokenId, submissionId: result.submissionId, outcome: r.ok ? "settled" : `${r.gate}: ${r.reason}` });
      }
      const credit = await k.tenders.creditOf(tokenId, cell.address);
      if (credit > 0n) {
        const r = await this.catalog.invoke(node, "credit_withdraw", { tokenId: result.tokenId, jobId: `${job.id}:withdraw:${credit}` }, WATCHER_CALLER);
        withdrawn.push({ tokenId: result.tokenId, outcome: r.ok ? `withdrew ${credit} wei` : `${r.gate}: ${r.reason}` });
      }
    }

    // 4. safety: a change of verdict is journaled (the decision records show what it stopped)
    const status = await cell.status();
    const last = k.fact<{ verdict: string }>("watch.safety");
    const changed = !last || last.verdict !== status.verdictName;
    if (changed) {
      k.setFact("watch.safety", { verdict: status.verdictName, reasons: status.reasonNames, at: now });
      k.store.journal("safety-changed", { from: last?.verdict ?? null, to: status.verdictName, reasons: status.reasonNames, restrictions: status.restrictions, block });
    }

    return { at: new Date().toISOString(), block, heartbeat, discovered, settled, withdrawn, safety: { verdict: status.verdictName, reasons: status.reasonNames, changed }, anchor };
  }
}

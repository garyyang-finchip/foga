import type { Catalog } from "../tools/catalog.js";
import type { Caller } from "../tools/types.js";
import { anchorPlan, cellChannelId, currentEligibility, marketOf, reconcileAnchors, roleNow } from "./flows.js";
import type { Node } from "./node.js";

/**
 * The flows watcher (ERC-8489, 0.9.0; docs/flows.md, "What the node does on its own"): on its pace it looks for the two
 * things a cell owes its channels and does one of them a tick — a publication not anchored yet (the documents were
 * published while the channel did not exist, or by a build before 0.9.0) is anchored, and a market the configuration
 * says to join is joined once the cell is eligible. Nothing to do is nothing sent; a refusal is recorded and the next
 * check is after the pace, so a cell that cannot be admitted (NOT_SATISFIED, an UNDETERMINABLE condition) does not
 * ask the chain every tick. Each act is `flow_anchor` or `flow_admit` through the catalog, as the caller `watcher`.
 */
export interface FlowsWatch {
  checked: boolean;
  action: "none" | "skipped" | "anchored" | "admitted" | "pending" | "refused";
  reason: string;
  nextCheckAt: number | null;
}

export const FLOWS_WATCH_FACT = "watch.flows";

interface WatchFact {
  checkedAt: number;
  nextCheckAt: number;
  lastAction?: string;
}

const none = (reason: string): FlowsWatch => ({ checked: false, action: "none", reason, nextCheckAt: null });

export async function flowsTick(node: Node, catalog: Catalog, caller: Caller, now = Math.floor(Date.now() / 1000)): Promise<FlowsWatch> {
  const k = node.kernel;
  const cfg = node.config.flows;
  if (!k.flows.available) return none("this world has no ERC-8489 registries");
  if (!cfg.auto) return none("flows.auto is off");
  if (!node.cell) return none("the cell has not been born");
  const paced = k.fact<WatchFact>(FLOWS_WATCH_FACT);
  if (paced && now < paced.nextCheckAt) return { ...none(`next check at ${new Date(paced.nextCheckAt * 1000).toISOString()}`), nextCheckAt: paced.nextCheckAt };
  const nextCheckAt = now + cfg.checkEverySeconds;
  const settle = (action: FlowsWatch["action"], reason: string): FlowsWatch => {
    k.setFact(FLOWS_WATCH_FACT, { checkedAt: now, nextCheckAt, lastAction: `${action}: ${reason}` } satisfies WatchFact);
    if (action !== "skipped") k.store.journal("flows-watch", { action, reason });
    return { checked: true, action, reason, nextCheckAt };
  };
  const channelId = cellChannelId(node);
  if (!channelId) return settle("skipped", "the cell has no channel (foga cell extend --covenants 8489)");

  // 1. a publication not anchored: the first docs_publish of a cell born before the channel, or one anchored by no one (what
  //    the chain holds already is recorded first, so a dropped fact is not a second anchor)
  const known = await reconcileAnchors(node);
  const plan = anchorPlan(node);
  if (plan && plan !== "unpublished" && known?.anchoredBy !== "another subject") {
    const role = await roleNow(node, channelId, k.flows.subjectOf(node.cell.address), "submit");
    if (role.outcome === "SATISFIED") {
      const r = await catalog.invoke(node, "flow_anchor", {}, caller, { mode: "act" });
      if (r.ok) return settle("anchored", `${plan.action} ${plan.objectRef.slice(0, 10)}… in ${channelId.slice(0, 10)}…`);
      if (r.gate === "pending") return settle("pending", r.reason);
      return settle("refused", `anchor: ${r.gate}: ${r.reason}`);
    }
    return settle("skipped", `publication ${plan.objectRef.slice(0, 10)}… not anchored: the cell does not hold SUBMIT now (${role.outcome ?? `call failed: ${role.error}`})`);
  }

  // 2. the market: admitted for the configured roles once eligible
  const market = cfg.market.join ? marketOf(node) : null;
  if (market) {
    const subject = k.flows.subjectOf(node.cell.address);
    const missing: string[] = [];
    for (const r of cfg.market.roles) {
      const o = await roleNow(node, market.channelId, subject, r);
      if (o.outcome !== "SATISFIED") missing.push(`${r} ${o.outcome ?? "unreadable"}`);
    }
    if (missing.length) {
      const e = await currentEligibility(node);
      if (!e.ok) return settle("skipped", `market ${market.channelId.slice(0, 10)}…: ${missing.join(", ")}; not eligible now (${e.detail})`);
      const r = await catalog.invoke(node, "flow_admit", {}, caller, { mode: "act" });
      if (r.ok) return settle("admitted", `market ${market.channelId.slice(0, 10)}…: ${(r.output as { admitted: { role: string }[] }).admitted.map((a) => a.role).join(", ") || "nothing new"}`);
      if (r.gate === "pending") return settle("pending", r.reason);
      return settle("refused", `admit: ${r.gate}: ${r.reason}`);
    }
  }
  return settle("skipped", `publication anchored${market ? ", market roles held" : ""}`);
}

/** The watcher's words in a tick line: nothing between checks, one clause when it checked and did something. */
export function formatFlowsWatch(f: FlowsWatch): string {
  if (!f.checked || f.action === "skipped") return "";
  return `; flows ${f.action}: ${f.reason}`;
}

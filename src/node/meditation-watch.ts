import { getAddress } from "ethers";
import { LAYER_NAMES, commitLayerDocument, type LayerName, type TriggerName } from "../core/amm.js";
import type { Catalog } from "../tools/catalog.js";
import type { Caller } from "../tools/types.js";
import { currentLock, reconcile } from "./meditation-cycle.js";
import { buildLayerDocuments, loadSalts } from "./meditation.js";
import type { Node } from "./node.js";

/**
 * The maintenance watcher (ERC-8490, the second slice of 4a; docs/meditation.md, "Automatic cycles"): the one duty a
 * node has toward its own upkeep without being asked. On its pace it consults the registry and its own documents and
 * runs a cycle when there is a reason to — a required layer DUE or OVERDUE under the requirements (a controller's
 * demand among them), or the runtime or memory-skills document drifted from the registered one — and not otherwise.
 * Bounded four ways: the check pace (`maintenance.checkEverySeconds`, wall time), one cycle at a time (an earlier one
 * is reconciled first; one still in flight blocks), the cooldown (`maintenance.cooldownSeconds` after the last
 * record, which an OVERDUE layer passes), and the budget (the catalog's gate, and the operator's gas against the
 * report's reserve before the catalog is asked). The cycle itself is `meditate_run` through the catalog, so it leaves
 * the same records as a commanded one; the scope is the layers that gave the reason, so each layer keeps its own rhythm.
 */
export interface MaintenanceWatch {
  /** The registry and the documents were consulted this tick (false between checks, or with the watcher off). */
  checked: boolean;
  action: "none" | "skipped" | "ran" | "pending" | "refused";
  reason: string;
  due: { layer: number; name: LayerName; status: string; deadline: number; demanded: boolean }[];
  drift: number[];
  cycleId?: string;
  trigger?: TriggerName;
  layers?: number[];
  outcome?: string;
  newVersion?: string;
  nextCheckAt: number | null;
}

export const WATCH_FACT = "watch.maintenance";

interface WatchFact {
  checkedAt: number;
  nextCheckAt: number;
  lastAction?: string;
  /** The registry's clock when the watcher last started a cycle (ran or left pending); the cooldown counts from the later of this and the last record. */
  lastAttemptChainAt?: number;
}

const none = (reason: string): MaintenanceWatch => ({ checked: false, action: "none", reason, due: [], drift: [], nextCheckAt: null });

/** One pass of the maintenance watcher; `now` is wall time in seconds. */
export async function maintenanceTick(node: Node, catalog: Catalog, caller: Caller, now = Math.floor(Date.now() / 1000)): Promise<MaintenanceWatch> {
  const k = node.kernel;
  const cfg = node.config.maintenance;
  if (!k.meditation.available) return none("this world has no ERC-8490 registry");
  if (!cfg.auto) return none("automatic cycles are off (maintenance.auto false)");
  if (!node.cell) return none("the cell has not been born");
  const paced = k.fact<WatchFact>(WATCH_FACT);
  if (paced && now < paced.nextCheckAt) return { ...none(`next check at ${new Date(paced.nextCheckAt * 1000).toISOString()}`), nextCheckAt: paced.nextCheckAt };
  const nextCheckAt = now + cfg.checkEverySeconds;
  let chainNow = 0;
  const settle = (w: Omit<MaintenanceWatch, "checked" | "nextCheckAt">): MaintenanceWatch => {
    const attempted = w.action === "ran" || w.action === "pending" ? chainNow || undefined : paced?.lastAttemptChainAt;
    k.setFact(WATCH_FACT, { checkedAt: now, nextCheckAt, lastAction: `${w.action}: ${w.reason}`, ...(attempted ? { lastAttemptChainAt: attempted } : {}) } satisfies WatchFact);
    if (w.action !== "none") k.store.journal("maintenance-watch", { action: w.action, reason: w.reason, due: w.due.map((d) => `${d.name} ${d.status}`), drift: w.drift, cycleId: w.cycleId ?? null, trigger: w.trigger ?? null, layers: w.layers ?? null, outcome: w.outcome ?? null, newVersion: w.newVersion ?? null });
    return { ...w, checked: true, nextCheckAt };
  };
  const subject = getAddress(node.cell.address);

  // 1. what an earlier cycle left behind, and whether one is still in flight
  const rec = await reconcile(node);
  if (rec.state === "pending" || rec.state === "resumable") return settle({ action: "pending", reason: rec.note, due: [], drift: [] });
  if (rec.state === "released") node.log(`  maintenance: ${rec.note}`);
  if (currentLock(node)) return settle({ action: "pending", reason: `cycle ${currentLock(node)!.cycleId} is in progress`, due: [], drift: [] });

  // 2. the registry: enrolled, and which required layers are due
  const head = await k.meditation.headOf(subject);
  if (!head.enrolled) return settle({ action: "skipped", reason: `${subject} is not enrolled (foga cell extend --covenants 8490)`, due: [], drift: [] });
  const statuses = await k.meditation.layerStatuses(subject);
  const due: MaintenanceWatch["due"] = [];
  for (const s of statuses) {
    if (s.statusName !== "DUE" && s.statusName !== "OVERDUE") continue;
    const demand = await k.meditation.demandOf(subject, s.layer);
    due.push({ layer: s.layer, name: s.name, status: s.statusName, deadline: s.deadline, demanded: demand.demandedAt !== 0 });
  }

  // 3. the documents: a runtime or memory-skills document that no longer commits to what is registered is a reason of its own
  //    (an upgrade, a role rotation, a skill minted); tasks-roles and cognition follow their schedule, their churn is not
  const drift: number[] = [];
  try {
    const [docs, checkpoints] = await Promise.all([buildLayerDocuments(node), k.meditation.checkpoints(subject)]);
    const salts = loadSalts(node);
    for (const i of [0, 1]) if (commitLayerDocument(i, docs[i], salts[i]).commitment.toLowerCase() !== checkpoints[i].commitment.toLowerCase()) drift.push(i);
  } catch (e) {
    node.log(`  maintenance: the documents could not be built for the drift check: ${(e as Error).message}`);
  }
  if (!due.length && !drift.length) return settle({ action: "skipped", reason: "nothing due, no drift", due, drift });

  // 4. the cooldown, which an OVERDUE layer passes: counted from the last record, or from the watcher's own last attempt
  const lastCycleId = k.fact<string>("meditation.lastCycle");
  const last = lastCycleId ? k.fact<{ result?: { recordedAt?: number } }>(`meditation.cycle.${lastCycleId}`) : undefined;
  const lastAt = Math.max(last?.result?.recordedAt ?? 0, paced?.lastAttemptChainAt ?? 0);
  chainNow = await k.meditation.clock();
  const overdue = due.some((d) => d.status === "OVERDUE");
  if (!overdue && lastAt && chainNow - lastAt < cfg.cooldownSeconds) return settle({ action: "skipped", reason: `cooldown: the last cycle was recorded ${chainNow - lastAt} s ago (${cfg.cooldownSeconds} s)`, due, drift });

  // 5. the operator's gas against the report's reserve, before the catalog is asked
  const fee = await k.world.provider.getFeeData();
  const price = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const reserve = BigInt(cfg.gasPerReport) * price;
  const gas = await k.balance(node.config.identity.operator);
  if (gas < reserve) return settle({ action: "skipped", reason: `the operator holds ${gas} wei; a report is reserved at ${reserve} wei (${cfg.gasPerReport} gas at ${price} wei)`, due, drift });

  // 6. the cycle, over the layers that gave the reason
  const layers = [...new Set([...due.map((d) => d.layer), ...drift])].sort();
  const trigger: TriggerName = due.some((d) => d.demanded) ? "commanded" : due.length ? "scheduled" : "event";
  const detail = [...due.map((d) => `${d.name} ${d.status}${d.demanded ? " (controller demand)" : ""} by ${new Date(d.deadline * 1000).toISOString()}`), ...drift.map((i) => `${LAYER_NAMES[i]} drifted from the registered document`)].join("; ");
  const r = await catalog.invoke(node, "meditate_run", { layers, trigger, detail: `watcher: ${detail}`.slice(0, 400) }, caller, { mode: "act" });
  if (r.ok) {
    const out = r.output as { cycleId: string; outcome: string; newVersion: string };
    return settle({ action: "ran", reason: detail, due, drift, cycleId: out.cycleId, trigger, layers, outcome: out.outcome, newVersion: out.newVersion });
  }
  if (r.gate === "pending") return settle({ action: "pending", reason: r.reason, due, drift, cycleId: r.jobId, trigger, layers });
  return settle({ action: "refused", reason: `${r.gate}: ${r.reason}`, due, drift, cycleId: r.jobId, trigger, layers });
}

/** The watcher's words in a tick line: nothing between checks, one clause when it checked. */
export function formatMaintenanceWatch(m: MaintenanceWatch): string {
  if (!m.checked) return "";
  if (m.action === "ran") return `; maintenance: cycle ${m.cycleId} ran (${m.trigger}, layers ${m.layers?.join(",")}) — ${m.outcome}, version ${m.newVersion}`;
  if (m.action === "skipped") return `; maintenance: ${m.reason}`;
  return `; maintenance ${m.action}: ${m.reason}`;
}

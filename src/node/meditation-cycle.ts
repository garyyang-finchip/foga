import { join } from "node:path";
import { formatEther, getAddress } from "ethers";
import { LAYER_NAMES, buildReport, contentHash, layerCommitment, outcomeOf, reportArray, schemaHash, stateRoot, type Commitments, type CycleRecordDocument, type CycleReportStruct, type LayerDocument, type LayerName, type OpName, type OutcomeName, type TriggerName } from "../core/amm.js";
import { jcs } from "../core/canonical.js";
import { NODE_SCOPE_GROUPS, applicableGroups, mergeScope, operatorScope, ownerExecuteScope } from "../genesis/operator-scope.js";
import type { Confirmed } from "../kernel/tx.js";
import { writeJson } from "../util/fs.js";
import { documentsDir, publishSteps, readBuilt } from "./documents.js";
import { CYCLES_DIR, CYCLE_RECORD_SCHEMA, MAINTENANCE_FACTS, buildLayerDocuments, inFlightTenders, layersOf, loadSalts, maintenanceDir, maintenanceUrl, readState, writeState, type LayerDocuments, type MaintenanceState } from "./meditation.js";
import type { Node } from "./node.js";

/**
 * One maintenance cycle (ERC-8490), as the node runs it: planned against the state the registry holds, executed
 * locally layer by layer, reported through the account, confirmed from the receipt. Every phase is a fact in the
 * store under `meditation.cycle.<id>`, with the documents, the record and the report frozen as they were computed,
 * so a run that stops anywhere resumes with the same calldata and a reviewer re-derives every hash from the record
 * (docs/meditation.md). Nothing here sends: the catalog's `meditate_run` owns the one transaction.
 *
 * What a cycle may change on its own is bounded by what the node may do alone: its own documents and its own store.
 * A finding about code, policy, allow-list or a counterparty's work becomes a candidate in the record, for the owner
 * or the operator to act on through the capability that governs it; it is never adopted here.
 */
/**
 * planned: begun against the head; executed: routines run, record and report frozen (the report's operation row in the
 * store says whether it was sent); confirmed: the report was mined and the state registered; failed: the report failed;
 * superseded: interrupted before the report was sent and replaced by a later cycle.
 */
export type CyclePhase = "planned" | "executed" | "confirmed" | "failed" | "superseded";

export type CheckResult = "pass" | "fail" | "finding" | "skipped";
export type Adoption = "adopted" | "kept" | "candidate" | "failed" | "restored";

export interface LayerResult {
  layer: number;
  name: LayerName;
  scope: true;
  completed: boolean;
  checks: { name: string; result: CheckResult; details?: string }[];
  observations: Record<string, unknown>;
  candidates: Record<string, unknown>[];
  changes: { op: OpName; description: string }[];
  evaluation: { method: string; result: string; details?: string };
  adoption: Adoption;
}

export interface CycleFact {
  id: string;
  phase: CyclePhase;
  subject: string;
  trigger: TriggerName;
  triggerDetail: string;
  layerMask: number;
  policyVersion: number;
  /** The registry's clock when the cycle began (its reportedStartedAt). */
  startedAt: number;
  /** The completion time the report carries, fixed when the local work ended; null until then. */
  endedAt: number | null;
  pre: { stateVersion: string; root: string; commitments: Commitments; recordCount: string };
  post: { commitments: Commitments; root: string; docs: (LayerDocument | null)[] } | null;
  results: LayerResult[] | null;
  record: CycleRecordDocument | null;
  /** The CycleReport struct, bigints as strings. */
  report: Record<string, unknown> | null;
  recordURI: string;
  outcome: OutcomeName | null;
  result: CycleResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CycleResult {
  cycleId: string;
  seq: string;
  baseVersion: string;
  newVersion: string;
  changedLayers: number;
  outcome: OutcomeName;
  layerMask: number;
  completedLayers: number;
  opsMask: number;
  preRoot: string;
  postRoot: string;
  recordHash: string;
  recordURI: string;
  txHash: string;
  recordedAt: number;
  layers: { layer: number; name: LayerName; completed: boolean; adoption: Adoption; changes: { op: OpName; description: string }[]; checks: number; findings: number; candidates: number }[];
}

export function cycleFact(node: Node, id: string): CycleFact | undefined {
  return node.store.getFact<CycleFact>(MAINTENANCE_FACTS.cycle(id));
}

function saveCycle(node: Node, c: CycleFact): CycleFact {
  c.updatedAt = new Date().toISOString();
  node.store.setFact(MAINTENANCE_FACTS.cycle(c.id), c);
  return c;
}

export function currentLock(node: Node): { cycleId: string } | undefined {
  return node.store.getFact<{ cycleId: string }>(MAINTENANCE_FACTS.lock);
}

function setLock(node: Node, cycleId: string | null): void {
  node.store.setFact(MAINTENANCE_FACTS.lock, cycleId ? { cycleId } : null);
}

/** The operation key of a cycle's report (the job's one step). */
export function reportKey(cycleId: string): string {
  return `job:${cycleId}:report`;
}

// ---------------------------------------------------------------------------- reconciliation

export type Reconciliation = { state: "free" } | { state: "resumable"; cycleId: string; note: string } | { state: "pending"; cycleId: string; txHash: string; note: string } | { state: "released"; cycleId: string; note: string };

/**
 * What an interrupted cycle left behind, decided from the store and the chain before a new cycle begins: a report
 * that was mined completes the old cycle (its job is marked done from the receipt, its state adopted); one still
 * pending blocks a new cycle (the same job resumes it); one that failed, or a cycle that never reached the chain,
 * is superseded. The chain is consulted, nothing is sent.
 */
export async function reconcile(node: Node): Promise<Reconciliation> {
  const lock = currentLock(node);
  if (!lock) return { state: "free" };
  const c = cycleFact(node, lock.cycleId);
  if (!c || c.phase === "confirmed" || c.phase === "failed" || c.phase === "superseded") {
    setLock(node, null);
    return { state: "released", cycleId: lock.cycleId, note: c ? `cycle ${lock.cycleId} had ended (${c.phase}); the lock was stale` : `cycle ${lock.cycleId} has no record; the lock was stale` };
  }
  const key = reportKey(c.id);
  const op = node.store.get(key);
  if (!op) {
    // planned or executed, never sent: the local work is discarded, the next cycle recomputes it against the chain
    c.phase = "superseded";
    c.error = "interrupted before its report was sent; superseded by the next cycle";
    saveCycle(node, c);
    const job = node.store.getJob(c.id);
    if (job && (job.status === "accepted" || job.status === "running")) node.store.updateJob(c.id, { status: "cancelled", error: c.error });
    setLock(node, null);
    return { state: "released", cycleId: c.id, note: `cycle ${c.id} was interrupted before its report was sent; superseded` };
  }
  if (op.status === "failed") {
    c.phase = "failed";
    c.error = op.error ?? "the report failed";
    saveCycle(node, c);
    const job = node.store.getJob(c.id);
    if (job && (job.status === "accepted" || job.status === "running")) node.store.updateJob(c.id, { status: "failed", error: c.error });
    setLock(node, null);
    return { state: "released", cycleId: c.id, note: `cycle ${c.id}'s report failed (${c.error}); the next cycle starts afresh` };
  }
  let reverted: string | null = null;
  const settled = await node.kernel.tx.resolveSent(key).catch((e: Error) => {
    reverted = e.message; // a reverted receipt: the report was mined and failed on chain
    return null;
  });
  if (reverted !== null) {
    failCycle(node, c, reverted);
    const job = node.store.getJob(c.id);
    if (job && (job.status === "accepted" || job.status === "running")) node.store.updateJob(c.id, { status: "failed", error: reverted });
    return { state: "released", cycleId: c.id, note: `cycle ${c.id}'s report reverted on chain (${reverted}); the next cycle starts afresh` };
  }
  if (settled) {
    const result = confirmCycle(node, c, settled);
    const job = node.store.getJob(c.id);
    if (job && job.status !== "done") node.store.updateJob(c.id, { status: "done", result, addOperation: key, error: null });
    return { state: "released", cycleId: c.id, note: `cycle ${c.id}'s report was mined while the node was away (tx ${settled.txHash}); recorded as state version ${result.newVersion}` };
  }
  if (op.status === "sent") return { state: "pending", cycleId: c.id, txHash: op.txHash ?? "?", note: `cycle ${c.id}'s report ${op.txHash ?? ""} is still pending; the same job resumes it (foga meditate run --job-id ${c.id})` };
  return { state: "resumable", cycleId: c.id, note: `cycle ${c.id} is ${c.phase} with its report ${op.status}; the same job resumes it` };
}

// ---------------------------------------------------------------------------- planning and local execution

export interface BeginOptions {
  id: string;
  layerMask: number;
  trigger: TriggerName;
  triggerDetail: string;
}

/**
 * Begin a cycle against the registry's current head: the pre-state is what the chain holds, never what the node
 * remembers. With `persist` off (a dry run) nothing is written: no lock, no fact, no file.
 */
export async function beginCycle(node: Node, o: BeginOptions, persist = true): Promise<CycleFact> {
  const k = node.kernel;
  const subject = getAddress(node.body.address);
  const [head, checkpoints, clock] = await Promise.all([k.meditation.headOf(subject), k.meditation.checkpoints(subject), k.meditation.clock()]);
  if (!head.enrolled) throw new Error(`${subject} is not enrolled in the maintenance registry ${k.meditation.address} (foga cell extend --covenants 8490)`);
  const at = new Date().toISOString();
  const c: CycleFact = {
    id: o.id,
    phase: "planned",
    subject,
    trigger: o.trigger,
    triggerDetail: o.triggerDetail,
    layerMask: o.layerMask,
    policyVersion: head.policyVersion,
    startedAt: clock,
    endedAt: null,
    pre: { stateVersion: head.stateVersion.toString(), root: head.root, commitments: checkpoints.map((cp) => cp.commitment) as Commitments, recordCount: head.recordCount.toString() },
    post: null,
    results: null,
    record: null,
    report: null,
    recordURI: maintenanceUrl(node, `${CYCLES_DIR}/${o.id}.json`),
    outcome: null,
    result: null,
    error: null,
    createdAt: at,
    updatedAt: at,
  };
  if (!persist) return c;
  setLock(node, c.id);
  return saveCycle(node, c);
}

/**
 * Run the routines of the scoped layers, build the post state, the record and the report. Pure with respect to the
 * chain (reads only) and idempotent with respect to the cycle: a cycle already executed is returned as it was frozen.
 * With `persist` off (a dry run) the store's own clean-up is still what the routine does, but no fact or file is written.
 */
export async function executeCycle(node: Node, c: CycleFact, persist = true): Promise<CycleFact> {
  if (c.phase !== "planned") return c;
  const k = node.kernel;
  const started = Date.now();
  const salts = loadSalts(node);
  const prior = readState(node);
  const docs = await buildLayerDocuments(node);
  const layers = layersOf(c.layerMask);
  const results: LayerResult[] = [];
  const postDocs: (LayerDocument | null)[] = [null, null, null, null];
  const postCommitments = [...c.pre.commitments] as Commitments;
  for (const layer of layers) {
    const priorDoc = prior?.docs[layer] ?? null;
    const r = await runRoutine(node, layer, docs[layer], priorDoc, c);
    // the layer's state after the cycle: the document as built, when the routine completed; the registered state otherwise
    const candidate = layerCommitment(layer, schemaHash(docs[layer].schema), contentHash(docs[layer]), salts[layer]);
    const differs = candidate.toLowerCase() !== c.pre.commitments[layer].toLowerCase();
    if (r.completed) {
      postCommitments[layer] = candidate;
      postDocs[layer] = docs[layer];
      if (differs) {
        if (!r.changes.some((ch) => ch.op === "update" || ch.op === "repair")) r.changes.push({ op: "update", description: describeChange(priorDoc, docs[layer]) });
        r.adoption = "adopted";
      } else if (r.adoption !== "candidate") r.adoption = "kept";
    } else {
      postDocs[layer] = priorDoc;
      r.adoption = "failed";
      r.changes = r.changes.filter((ch) => ch.op === "clean"); // what was done stays recorded; nothing was adopted
    }
    results.push(r);
  }
  const completedLayers = results.reduce((m, r) => (r.completed ? m | (1 << r.layer) : m), 0);
  const outcome = outcomeOf(c.layerMask, completedLayers);

  // the completion time: the registry's clock now, and later than every scoped layer's last completion (the registry
  // refuses a completion that is not later than the recorded one; two cycles in one block would collide otherwise)
  const [checkpoints, clock, head, requirements] = await Promise.all([k.meditation.checkpoints(c.subject), k.meditation.clock(), k.meditation.headOf(c.subject), k.meditation.requirementsOf(c.subject)]);
  let endedAt = Math.max(c.startedAt, clock);
  for (const r of results) if (r.completed && checkpoints[r.layer].lastCompletedAt >= endedAt) endedAt = checkpoints[r.layer].lastCompletedAt + 1;
  // the planning hint: with the watcher on, when it will next find a required layer DUE — the earliest coming deadline
  // less the due window, and not before the cooldown has passed; 0 when cycles run on command alone
  const nextPlannedAt = node.config.maintenance.auto ? plannedNext(node, { endedAt, completed: completedLayers, checkpoints, enrolledAt: head.enrolledAt, requirements }) : 0;

  const record: CycleRecordDocument = {
    schema: CYCLE_RECORD_SCHEMA,
    subject: c.subject,
    policyVersion: c.policyVersion,
    baseVersion: Number(c.pre.stateVersion),
    trigger: c.trigger,
    triggerDetail: c.triggerDetail,
    reportedStartedAt: c.startedAt,
    reportedEndedAt: endedAt,
    budgetsUsed: { duration: Math.max(1, Math.round((Date.now() - started) / 1000)), program: node.config.name },
    layers: results.map((r) => ({ layer: r.layer, scope: true as const, completed: r.completed, checks: r.checks, observations: r.observations, candidates: r.candidates, changes: r.changes, evaluation: r.evaluation, adoption: r.adoption })),
    outcome,
    nextPlannedAt,
    restoresVersion: 0,
    preState: { stateVersion: Number(c.pre.stateVersion), root: c.pre.root, commitments: c.pre.commitments },
    postState: { commitments: postCommitments, root: stateRoot(postCommitments), salts: layers.map((l) => ({ layer: l, salt: salts[l] })) },
    cycleId: c.id,
  };
  const { report } = buildReport(record, { commitments: c.pre.commitments, root: c.pre.root }, { commitments: postCommitments }, c.recordURI);
  c.post = { commitments: postCommitments, root: stateRoot(postCommitments), docs: postDocs };
  c.results = results;
  c.record = record;
  c.report = serializeReport(report);
  c.endedAt = endedAt;
  c.outcome = outcome;
  c.phase = "executed";
  if (!persist) return c;
  writeJson(join(maintenanceDir(node), CYCLES_DIR, `${c.id}.json`), record);
  return saveCycle(node, c);
}

/** The next time a required layer falls DUE, as the watcher will see it: the earliest deadline less the due window, after the cooldown. */
export function plannedNext(node: Node, p: { endedAt: number; completed: number; checkpoints: { lastCompletedAt: number }[]; enrolledAt: number; requirements: { requiredLayers: number; dueWindow: number; maxInterval: number[] } }): number {
  let earliest = 0;
  for (let i = 0; i < 4; i++) {
    if ((p.requirements.requiredLayers & (1 << i)) === 0 || !p.requirements.maxInterval[i]) continue;
    const completedAt = (p.completed & (1 << i)) !== 0 ? p.endedAt : p.checkpoints[i].lastCompletedAt || p.enrolledAt;
    const deadline = completedAt + p.requirements.maxInterval[i];
    if (!earliest || deadline < earliest) earliest = deadline;
  }
  if (!earliest) return 0;
  return Math.max(earliest - p.requirements.dueWindow, p.endedAt + node.config.maintenance.cooldownSeconds);
}

export function serializeReport(r: CycleReportStruct): Record<string, unknown> {
  return JSON.parse(JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function deserializeReport(r: Record<string, unknown>): CycleReportStruct {
  return { ...(r as unknown as CycleReportStruct), baseVersion: BigInt(r.baseVersion as string), restoresVersion: BigInt(r.restoresVersion as string) };
}

/** The frozen report of an executed cycle, as the registry takes it. */
export function reportOf(c: CycleFact): CycleReportStruct {
  if (!c.report) throw new Error(`cycle ${c.id} has no report yet (phase ${c.phase})`);
  return deserializeReport(c.report);
}

/**
 * The report confirmed: read the versions from the event, register the post documents as the state behind the new
 * commitments, release the lock, write the files. Idempotent: a confirmed cycle returns its result.
 */
export function confirmCycle(node: Node, c: CycleFact, confirmed: Confirmed): CycleResult {
  if (c.phase === "confirmed" && c.result) return c.result;
  const k = node.kernel;
  const ev = k.meditation.cycleRecordedFromReceipt(confirmed.receipt);
  const report = reportOf(c);
  const results = c.results ?? [];
  const post = c.post!;
  const prior = readState(node);
  const docs: LayerDocuments = [0, 1, 2, 3].map((i) => post.docs[i] ?? prior?.docs[i] ?? null) as unknown as LayerDocuments;
  const state: MaintenanceState = { stateVersion: ev.newVersion.toString(), root: post.root, commitments: post.commitments, docs, by: c.id, updatedAt: new Date().toISOString() };
  writeState(node, state);
  const result: CycleResult = {
    cycleId: c.id,
    seq: ev.seq.toString(),
    baseVersion: ev.baseVersion.toString(),
    newVersion: ev.newVersion.toString(),
    changedLayers: ev.changedLayers,
    outcome: c.outcome ?? "failed",
    layerMask: report.layerMask,
    completedLayers: report.completedLayers,
    opsMask: report.opsMask,
    preRoot: c.pre.root,
    postRoot: post.root,
    recordHash: report.recordHash,
    recordURI: c.recordURI,
    txHash: confirmed.txHash,
    recordedAt: ev.recordedAt,
    layers: results.map((r) => ({ layer: r.layer, name: r.name, completed: r.completed, adoption: r.adoption, changes: r.changes, checks: r.checks.length, findings: r.checks.filter((x) => x.result === "finding" || x.result === "fail").length, candidates: r.candidates.length })),
  };
  c.phase = "confirmed";
  c.result = result;
  saveCycle(node, c);
  node.store.setFact(MAINTENANCE_FACTS.lastCycle, c.id);
  setLock(node, null);
  writeJson(join(maintenanceDir(node), CYCLES_DIR, `${c.id}.report.json`), { cycleId: c.id, report: reportArray(report).map((x) => (typeof x === "bigint" ? x.toString() : x)), result, submittedAs: confirmed.receipt.from });
  return result;
}

/** The report failed (an estimate that reverted, a revert on chain): the cycle ends, the lock is released, nothing was adopted. */
export function failCycle(node: Node, c: CycleFact, error: string): void {
  if (c.phase === "confirmed") return;
  c.phase = "failed";
  c.error = error;
  saveCycle(node, c);
  if (currentLock(node)?.cycleId === c.id) setLock(node, null);
}

// ---------------------------------------------------------------------------- the routines

/** What a layer's document changed, by its top-level members, for the record. */
function describeChange(before: LayerDocument | null, after: LayerDocument): string {
  if (!before) return "state document registered for the first time from the cell as it is";
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => jcs(before[k] ?? null) !== jcs(after[k] ?? null)).sort();
  return keys.length ? `state document updated: ${keys.join(", ")}` : "state document updated";
}

async function runRoutine(node: Node, layer: number, doc: LayerDocument, prior: LayerDocument | null, c: CycleFact): Promise<LayerResult> {
  const r: LayerResult = { layer, name: LAYER_NAMES[layer], scope: true, completed: false, checks: [], observations: {}, candidates: [], changes: [], evaluation: { method: "", result: "" }, adoption: "kept" };
  try {
    if (layer === 0) await runtimeRoutine(node, r, doc, prior);
    else if (layer === 1) await memorySkillsRoutine(node, r, doc, prior);
    else if (layer === 2) await tasksRolesRoutine(node, r, doc, prior, c);
    else cognitionRoutine(node, r, doc, prior);
    r.completed = true;
    const findings = r.checks.filter((x) => x.result === "finding" || x.result === "fail").length;
    r.evaluation.result = findings ? `${findings} finding(s)` : "pass";
    if (r.candidates.length && r.adoption === "kept") r.adoption = "candidate";
  } catch (e) {
    r.completed = false;
    r.checks.push({ name: "routine", result: "fail", details: (e as Error).message.slice(0, 400) });
    r.evaluation = { method: r.evaluation.method || "routine", result: "failed", details: (e as Error).message.slice(0, 400) };
  }
  return r;
}

/** Layer 0: the program and the account as they are, checked against the configuration; nothing is changed here but the document. */
async function runtimeRoutine(node: Node, r: LayerResult, doc: LayerDocument, _prior: LayerDocument | null): Promise<void> {
  const k = node.kernel;
  const cfg = node.config;
  const cell = node.body;
  r.evaluation.method = "the account's roles, revision and allow-list against the configuration; the dependencies resolved; the endpoint's chain";
  const auth = doc.authorization as { owner: string; operator: string; accountRevision: number };
  const rolesOk = getAddress(auth.owner) === getAddress(cfg.identity.owner) && getAddress(auth.operator) === getAddress(cfg.identity.operator);
  r.checks.push({ name: "account-roles", result: rolesOk ? "pass" : "fail", details: `owner ${auth.owner}, operator ${auth.operator}${rolesOk ? "" : `; the configuration names ${cfg.identity.owner} / ${cfg.identity.operator}`}` });
  r.checks.push({ name: "account-revision", result: auth.accountRevision >= 2 ? "pass" : "finding", details: `FogaCellAccount revision ${auth.accountRevision}${auth.accountRevision >= 2 ? "" : ": no operator allow-list (foga cell migrate)"}` });
  if (auth.accountRevision >= 2) {
    const groups = applicableGroups(k, NODE_SCOPE_GROUPS);
    const oneKey = getAddress(auth.owner) === getAddress(auth.operator);
    const ownerPairs = ownerExecuteScope(k);
    const scope = oneKey ? mergeScope(operatorScope(k, groups), ownerPairs) : operatorScope(k, groups);
    const missing: string[] = [];
    for (let i = 0; i < scope.targets.length; i++) if (!(await cell.contract().operatorAllowed(scope.targets[i], scope.selectors[i]))) missing.push(scope.names[i]);
    r.checks.push({ name: "operator-allow-list", result: missing.length ? "finding" : "pass", details: missing.length ? `${missing.length} of ${scope.names.length} pairs missing: ${missing.join(", ")}` : `${scope.names.length} (target, selector) pairs allowed` });
    if (missing.length) r.candidates.push({ id: "allow-list-completion", statement: `the owner adds ${missing.length} missing (target, selector) pair(s) with scope_complete`, missing, decision: "the owner's act; not made here" });
    if (!oneKey && ownerPairs.targets.length) {
      const open: string[] = [];
      for (let i = 0; i < ownerPairs.targets.length; i++) if (await cell.contract().operatorAllowed(ownerPairs.targets[i], ownerPairs.selectors[i])) open.push(ownerPairs.names[i]);
      r.checks.push({ name: "owner-pairs-closed", result: open.length ? "finding" : "pass", details: open.length ? `allowed to a separate operator: ${open.join(", ")}` : "the owner's pairs through execute are not open to the operator" });
      if (open.length) r.candidates.push({ id: "owner-pairs-closure", statement: `the owner closes ${open.join(", ")} to the operator (setOperatorAllowedBatch(…, false)); they belong to a one-key cell alone`, decision: "the owner's act; not made here" });
    }
  }
  const deps = doc.dependencies as { name: string; version: string }[];
  const unresolved = deps.filter((d) => d.version === "unresolved").map((d) => d.name);
  r.checks.push({ name: "dependencies-resolved", result: unresolved.length ? "finding" : "pass", details: unresolved.length ? `not resolvable from here: ${unresolved.join(", ")}` : deps.map((d) => `${d.name} ${d.version}`).join(", ") });
  const net = await k.world.provider.getNetwork();
  r.checks.push({ name: "endpoint-chain", result: Number(net.chainId) === node.chainId ? "pass" : "fail", details: `the endpoint serves chain ${net.chainId}; the world is on ${node.chainId}` });
  // the world file records the bundle it was made with; a later program carries a later bundle, which is the ordinary
  // state of a long-lived cell and nothing to act on (the doctor checks the contracts against the current bundle), so it
  // is recorded, not raised
  const sameBundle = !node.world.file.bundleHash || node.world.file.bundleHash.toLowerCase() === node.world.bundle.hash.toLowerCase();
  r.checks.push({ name: "bundle-of-record", result: "pass", details: sameBundle ? `the program's bundle ${node.world.bundle.hash.slice(0, 10)}… is the one the world was made with` : `the program carries bundle ${node.world.bundle.hash.slice(0, 10)}…; the world was made with ${String(node.world.file.bundleHash).slice(0, 10)}… (a later release on an older world; the contracts are checked against the current bundle by the doctor)` });
  const [balance, operatorGas, block] = await Promise.all([k.balance(cell.address), k.balance(cfg.identity.operator), k.blockNumber()]);
  r.observations = { nativeBalanceWei: balance.toString(), nativeBalanceEth: formatEther(balance), operatorGasWei: operatorGas.toString(), block };
}

/** Layer 1: the skills' packages against their tokens; the store checked and compacted (a clean that loses nothing). */
async function memorySkillsRoutine(node: Node, r: LayerResult, doc: LayerDocument, _prior: LayerDocument | null): Promise<void> {
  r.evaluation.method = "every held package rebuilt and compared with its token; SQLite quick_check and a write-ahead log checkpoint";
  try {
    const held = await node.heldSkills();
    r.checks.push({ name: "skill-package-hashes", result: "pass", details: held.length ? held.map((h) => `${h.name} token ${h.tokenId} ${h.packageHash.slice(0, 10)}…`).join("; ") : "no skills held" });
  } catch (e) {
    r.checks.push({ name: "skill-package-hashes", result: "finding", details: (e as Error).message.slice(0, 300) });
    r.candidates.push({ id: "skill-package-mismatch", statement: "a held skill's directory no longer matches its token's commitment; restore the package or mint the new version (skill_mint)", decision: "the operator's act; not made here" });
  }
  const offeredNotHeld = node.config.skills.offered.filter((s) => !(s in node.config.skills.held));
  r.checks.push({ name: "offered-skills-held", result: offeredNotHeld.length ? "finding" : "pass", details: offeredNotHeld.length ? `offered but not held: ${offeredNotHeld.join(", ")}` : `${node.config.skills.offered.length} offered of ${Object.keys(node.config.skills.held).length} held` });
  const verdict = node.store.quickCheck();
  r.checks.push({ name: "store-integrity", result: verdict === "ok" ? "pass" : "fail", details: `quick_check: ${verdict}` });
  const before = node.store.pageStats();
  const cp = node.store.checkpoint();
  const after = node.store.pageStats();
  if (cp.checkpointedFrames > 0) r.changes.push({ op: "clean", description: `write-ahead log folded into the store: ${cp.checkpointedFrames} of ${cp.logFrames} frames; nothing dropped` });
  r.checks.push({ name: "store-checkpoint", result: cp.busy ? "finding" : "pass", details: cp.busy ? "another connection held the store; the checkpoint was partial" : `${cp.checkpointedFrames} frames checkpointed` });
  r.observations = { store: { pageSize: after.pageSize, pages: after.pageCount, freePages: after.freelistCount, pagesBefore: before.pageCount }, wal: cp, facts: node.store.summary().facts, journal: node.store.summary().journal };
  void doc;
}

/** Layer 2: roles and terms as configured; the tenders in flight against the chain; the documents against the chain. */
async function tasksRolesRoutine(node: Node, r: LayerResult, doc: LayerDocument, _prior: LayerDocument | null, _c: CycleFact): Promise<void> {
  const k = node.kernel;
  r.evaluation.method = "in-flight tenders read on chain; built documents compared with the chain's commitments; roles from the account's scope";
  const inFlight = inFlightTenders(node);
  const stale: string[] = [];
  for (const t of inFlight) {
    const id = BigInt(t.tokenId);
    const [count, cancelled] = await Promise.all([k.tenders.submissionCount(id), k.tenders.isCancelled(id)]);
    let settled = false;
    for (let i = 1n; i <= count; i++) {
      const s = await k.tenders.submissionOf(id, i);
      if (s.fulfiller.toLowerCase() === node.body.address.toLowerCase() && s.status === 1) settled = true;
    }
    if (settled || cancelled) stale.push(`${t.tokenId} (${settled ? "settled on chain" : "cancelled"})`);
  }
  r.checks.push({ name: "in-flight-tenders", result: stale.length ? "finding" : "pass", details: inFlight.length ? `${inFlight.length} submitted and unsettled in the store${stale.length ? `; the chain says otherwise for ${stale.join(", ")}` : ""}` : "none in flight" });
  if (stale.length) r.candidates.push({ id: "in-flight-reconciliation", statement: `the store's view of ${stale.length} tender(s) lags the chain; the runner's tender_settle / tender_withdraw brings the books level`, tenders: stale, decision: "the runner's act; not made here" });
  const built = readBuilt(documentsDir(node));
  if (!built) r.checks.push({ name: "documents-built", result: "finding", details: `nothing under ${documentsDir(node)} (foga cell docs build)` });
  else {
    const { steps, unchanged } = await publishSteps(node, built);
    r.checks.push({ name: "documents-published", result: steps.length ? "finding" : "pass", details: steps.length ? `${steps.length} commitment(s) differ from the chain: ${steps.map((s) => s.name).join(", ")}; as built: ${unchanged.join(", ") || "none"}` : `${unchanged.length} commitment(s) as built (v${built.manifest.version})` });
    if (steps.length) r.candidates.push({ id: "documents-publish", statement: `docs_publish commits ${steps.map((s) => s.name).join(", ")}`, decision: "a keyed job of its own with its own budget; not made here" });
  }
  const roles = (doc.roles as { id: string }[]).map((x) => x.id);
  r.checks.push({ name: "roles", result: "pass", details: roles.join(", ") });
  const jobs = node.store.jobs(null, 5000);
  r.observations = { jobs: jobs.length, byStatus: jobs.reduce<Record<string, number>>((m, j) => ((m[j.status] = (m[j.status] ?? 0) + 1), m), {}), inFlight: inFlight.map((t) => t.tokenId) };
}

/** Layer 3: the decisions of the window by gate; the program's assumptions restated; candidates only. */
function cognitionRoutine(node: Node, r: LayerResult, doc: LayerDocument, _prior: LayerDocument | null): void {
  r.evaluation.method = "decision records of the last 7 days grouped by gate and verdict; assumptions and strategies restated from the program";
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const decisions = node.store.decisions({ since, limit: 5000 });
  const byGate: Record<string, { allowed: number; refused: number }> = {};
  for (const d of decisions) {
    const g = (byGate[d.gate] ??= { allowed: 0, refused: 0 });
    if (d.verdict === "allowed") g.allowed++;
    else g.refused++;
  }
  const refused = decisions.filter((d) => d.verdict === "refused").length;
  const ratio = decisions.length ? refused / decisions.length : 0;
  r.checks.push({ name: "decision-review", result: decisions.length >= 20 && ratio > 0.8 ? "finding" : "pass", details: decisions.length ? `${decisions.length} decisions, ${refused} refused (${Math.round(ratio * 100)}%); gates: ${Object.entries(byGate).map(([g, n]) => `${g} ${n.allowed}/${n.refused}`).join(", ")}` : "no decisions in the window" });
  if (decisions.length >= 20 && ratio > 0.8) {
    const worst = Object.entries(byGate).sort((a, b) => b[1].refused - a[1].refused)[0];
    r.candidates.push({ id: "refusal-pattern", statement: `most of what was asked in the window was refused, chiefly at the ${worst?.[0] ?? "?"} gate; the policy's thresholds or the callers' requests want a look`, decision: "the operator's judgment; nothing adopted here" });
  }
  const assumptions = (doc.assumptions as { id: string; status: string }[]).map((a) => a.id);
  r.checks.push({ name: "assumption-review", result: "pass", details: `${assumptions.length} assumptions held: ${assumptions.join(", ")}` });
  r.observations = { window: { since, decisions: decisions.length, refused, byGate } };
}

// ---------------------------------------------------------------------------- the status, for people

export interface MaintenanceStatusView {
  registry: string | null;
  subject: string | null;
  enrolled: boolean;
  meaning: string;
  head: { controller: string; controllerRights: number; policyVersion: number; floorVersion: number; stateVersion: string; recordCount: string; root: string; enrolledAt: number; lastSignalAt: number; nextPlannedAt: number } | null;
  layers: { layer: number; name: string; status: string; deadline: number; neverCompleted: boolean; commitment: string; lastCompletedAt: number; lastChangedVersion: string }[] | null;
  signal: { status: string; lastSignalAt: number; silentSince: number } | null;
  requirements: { supportedLayers: number; requiredLayers: number; dueWindow: number; pulseInterval: number; maxInterval: number[] } | null;
  policy: { policyHash: string; policyURI: string; disclosure: number } | null;
  asOf: number | null;
  local: { stateVersion: string | null; rootMatchesChain: boolean | null; policyHashMatchesChain: boolean | null; lastCycle: string | null; inProgress: { cycleId: string; phase: string; reportOperation: string | null } | null; dir: string; watcher?: { auto: boolean; checkEverySeconds: number; cooldownSeconds: number; nextCheckAt: number | null; lastAction: string | null } };
}

const iso = (t: number) => (t ? new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, "Z") : "-");

/** The status as `foga meditate status` prints it: one table, then what the node keeps. */
export function formatMaintenanceStatus(s: MaintenanceStatusView): string {
  const lines: string[] = [];
  if (!s.registry) return `${s.meaning}\n`;
  lines.push(`maintenance registry ${s.registry}; subject ${s.subject ?? "(no cell)"}; registry clock ${s.asOf ? iso(s.asOf) : "-"}`);
  if (!s.enrolled || !s.head) {
    lines.push("not enrolled (foga cell extend --covenants 8490 enrolls a running cell; foga cell init enrolls a new one on a world that has the registry)");
    return lines.join("\n") + "\n";
  }
  const h = s.head;
  lines.push(`enrolled ${iso(h.enrolledAt)}; state version ${h.stateVersion}, root ${h.root}; ${h.recordCount} record(s); policy v${h.policyVersion}, floor v${h.floorVersion}; controller ${h.controllerRights ? `${h.controller} (rights ${h.controllerRights})` : "none"}`);
  if (s.requirements) lines.push(`requirements: supported ${s.requirements.supportedLayers}, required ${s.requirements.requiredLayers}, due window ${s.requirements.dueWindow} s, pulse ${s.requirements.pulseInterval || "not tracked"}, intervals ${s.requirements.maxInterval.join("/")} s`);
  if (s.layers) {
    lines.push("");
    lines.push(`${"layer".padEnd(18)} ${"status".padEnd(13)} ${"deadline".padEnd(21)} ${"last completed".padEnd(21)} ${"changed at v".padEnd(13)} commitment`);
    for (const l of s.layers) lines.push(`${`${l.layer} ${l.name}`.padEnd(18)} ${l.status.padEnd(13)} ${iso(l.deadline).padEnd(21)} ${(l.neverCompleted ? "never" : iso(l.lastCompletedAt)).padEnd(21)} ${l.lastChangedVersion.padEnd(13)} ${l.commitment}`);
  }
  if (s.signal) lines.push(`signal: ${s.signal.status}${s.signal.lastSignalAt ? `, last ${iso(s.signal.lastSignalAt)}` : ""}${s.signal.silentSince ? `, silent since ${iso(s.signal.silentSince)}` : ""}`);
  lines.push("");
  lines.push(`local: registered documents at version ${s.local.stateVersion ?? "(none kept)"}${s.local.rootMatchesChain === null ? "" : s.local.rootMatchesChain ? " (root matches the chain)" : " (ROOT DIFFERS from the chain: the documents kept here are not what is registered)"}; policy ${s.local.policyHashMatchesChain === null ? "not kept" : s.local.policyHashMatchesChain ? "matches the chain" : "DIFFERS from the chain (foga meditate policy records the configuration's)"}; last cycle ${s.local.lastCycle ?? "none"}${s.local.inProgress ? `; in progress: ${s.local.inProgress.cycleId} (${s.local.inProgress.phase}${s.local.inProgress.reportOperation ? `, report ${s.local.inProgress.reportOperation}` : ""})` : ""}; documents under ${s.local.dir}`);
  if (s.local.watcher) lines.push(s.local.watcher.auto ? `watcher: on — checks every ${s.local.watcher.checkEverySeconds} s, cooldown ${s.local.watcher.cooldownSeconds} s${s.local.watcher.nextCheckAt ? `, next check ${iso(s.local.watcher.nextCheckAt)}` : ""}${s.local.watcher.lastAction ? `, last: ${s.local.watcher.lastAction}` : ""}` : "watcher: off (maintenance.auto false) — cycles run on command");
  lines.push(s.meaning);
  return lines.join("\n") + "\n";
}

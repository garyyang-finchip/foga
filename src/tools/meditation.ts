import { getAddress } from "ethers";
import { z } from "zod";
import { ALL_RIGHTS, LAYER_NAMES, MAINTENANCE_STATUS, SIGNAL_STATUS, TRIGGERS, contentHash, validatePolicy, type TriggerName } from "../core/amm.js";
import { NODE_SCOPE_GROUPS, applicableGroups, mergeScope, operatorScope, ownerExecuteScope, type ScopeGroup, type ScopeList } from "../genesis/operator-scope.js";
import { beginCycle, confirmCycle, currentLock, cycleFact, executeCycle, reconcile, reportOf, type CycleFact } from "../node/meditation-cycle.js";
import { cellPolicyStruct, controllerOf, enrollmentPlan, layerMaskOf, layersOf, maintenanceDir, policyDocument, readPolicy, readState, recordEnrollment, writePolicy, type EnrollmentPlan } from "../node/meditation.js";
import { ok, refused, safetyGate, type Gate } from "../node/policy.js";
import { derivedJobId, zAddress, zJobId } from "./common.js";
import type { Node } from "../node/node.js";
import type { ActCapability, ActStep, ReadCapability } from "./types.js";

/**
 * ERC-8490 as capabilities (docs/meditation.md). The cell's own records — a cycle report, an activity pulse — are
 * acts of the cell through its account under the operator's `maintenance` scope; enrolling, the policy, and the
 * controller are the owner's acts through the account (admin, CLI only); the controller's floor and demand are the
 * guardian's own transactions. The status is a public read: what the registry holds and what it means — FRESH says a
 * routine was completed in time, nothing more.
 */
const CycleResultSchema = z
  .object({
    cycleId: z.string(),
    seq: z.string(),
    baseVersion: z.string(),
    newVersion: z.string(),
    changedLayers: z.number(),
    outcome: z.string(),
    layerMask: z.number(),
    completedLayers: z.number(),
    opsMask: z.number(),
    preRoot: z.string(),
    postRoot: z.string(),
    recordHash: z.string(),
    recordURI: z.string(),
    txHash: z.string(),
    recordedAt: z.number(),
    layers: z.array(z.object({ layer: z.number(), name: z.string(), completed: z.boolean(), adoption: z.string(), changes: z.array(z.object({ op: z.string(), description: z.string() })), checks: z.number(), findings: z.number(), candidates: z.number() })),
  })
  .passthrough();

const DryRunSchema = z
  .object({
    cycleId: z.string(),
    dryRun: z.literal(true),
    outcome: z.string(),
    baseVersion: z.string(),
    preRoot: z.string(),
    postRoot: z.string(),
    wouldChangeLayers: z.number(),
    layers: z.array(z.object({ layer: z.number(), name: z.string(), completed: z.boolean(), adoption: z.string(), changes: z.array(z.object({ op: z.string(), description: z.string() })), checks: z.array(z.object({ name: z.string(), result: z.string(), details: z.string().optional() })), candidates: z.array(z.unknown()) })),
    record: z.unknown(),
  })
  .passthrough();

const zTrigger = z.enum(Object.keys(TRIGGERS) as [TriggerName, ...TriggerName[]]);
const zLayers = z.union([z.string(), z.array(z.union([z.number(), z.string()]))]).optional().describe("the layers in scope: 0..3 or their names, comma-separated or as a list; all four by default");

/** True when the cell's owner is its operator: the account then scope-checks the owner's `execute` calls too (operator-scope.ts). */
export function oneKey(node: Node): boolean {
  return getAddress(node.config.identity.owner) === getAddress(node.config.identity.operator);
}

/** The pairs of `scope` the account does not allow its operator yet, as indices. */
export async function missingOf(node: Node, scope: ScopeList): Promise<number[]> {
  const missing: number[] = [];
  for (let i = 0; i < scope.targets.length; i++) if (!(await node.body.contract().operatorAllowed(scope.targets[i], scope.selectors[i]))) missing.push(i);
  return missing;
}

/** The owner's `execute` call `fn` on a registry can be made: always with separated roles; in a one-key cell only when the pair is allowed. */
export async function ownerExecuteGate(node: Node, fn: string): Promise<Gate | null> {
  if (!oneKey(node)) return null;
  const scope = ownerExecuteScope(node.kernel);
  const i = scope.names.findIndex((n) => n.includes(`.${fn}(`));
  if (i < 0) return null;
  const missing = await missingOf(node, scope);
  if (!missing.includes(i)) return null;
  return refused("wallet", `this cell's owner is its operator, and the account scope-checks that address: ${scope.names[i]} is not in the allow-list yet (foga cell owner scope_complete opens the owner's pairs for a one-key cell)`);
}

export const meditate_status: ReadCapability = {
  name: "meditate_status",
  title: "Maintenance status (ERC-8490)",
  description: "What the maintenance registry holds for the cell — enrollment, state version and root, per-layer commitments, timeliness (FRESH, DUE, OVERDUE), the activity signal, the policy in force — and what the node keeps beside it: the registered documents' version, the last cycle, a cycle in progress. FRESH means a routine completed within its interval; the cycle record says what was checked.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8490],
  input: z.object({ subject: zAddress.optional().describe("another subject's status (default: this cell)") }),
  output: z
    .object({
      registry: z.string().nullable(),
      subject: z.string().nullable(),
      enrolled: z.boolean(),
      meaning: z.string(),
      head: z.unknown().nullable(),
      layers: z.array(z.object({ layer: z.number(), name: z.string(), status: z.string(), deadline: z.number(), neverCompleted: z.boolean(), commitment: z.string(), lastCompletedAt: z.number(), lastChangedVersion: z.string() })).nullable(),
      signal: z.object({ status: z.string(), lastSignalAt: z.number(), silentSince: z.number() }).nullable(),
      requirements: z.unknown().nullable(),
      policy: z.unknown().nullable(),
      asOf: z.number().nullable(),
      local: z.object({ stateVersion: z.string().nullable(), rootMatchesChain: z.boolean().nullable(), policyHashMatchesChain: z.boolean().nullable(), lastCycle: z.string().nullable(), inProgress: z.object({ cycleId: z.string(), phase: z.string(), reportOperation: z.string().nullable() }).nullable(), dir: z.string(), watcher: z.object({ auto: z.boolean(), checkEverySeconds: z.number(), cooldownSeconds: z.number(), nextCheckAt: z.number().nullable(), lastAction: z.string().nullable() }) }),
    })
    .passthrough(),
  async handler({ node }, input) {
    const k = node.kernel;
    const dir = maintenanceDir(node);
    const w = node.store.getFact<{ nextCheckAt?: number; lastAction?: string }>("watch.maintenance");
    const watcher = { auto: node.config.maintenance.auto, checkEverySeconds: node.config.maintenance.checkEverySeconds, cooldownSeconds: node.config.maintenance.cooldownSeconds, nextCheckAt: w?.nextCheckAt ?? null, lastAction: w?.lastAction ?? null };
    const meaning = "FRESH, DUE and OVERDUE are the registry's timeliness of each layer's last completed routine against the policy's interval (and a controller's floor or demand); a completed routine is what the cycle record says it is, not a certificate of correctness.";
    if (!k.meditation.available) return { registry: null, subject: null, enrolled: false, meaning: "this world has no ERC-8490 registry; maintenance is not registered on chain", head: null, layers: null, signal: null, requirements: null, policy: null, asOf: null, local: { stateVersion: null, rootMatchesChain: null, policyHashMatchesChain: null, lastCycle: null, inProgress: null, dir, watcher } };
    const subject = input.subject ? getAddress(input.subject) : node.cell ? getAddress(node.cell.address) : null;
    if (!subject) return { registry: k.meditation.address, subject: null, enrolled: false, meaning, head: null, layers: null, signal: null, requirements: null, policy: null, asOf: null, local: { stateVersion: null, rootMatchesChain: null, policyHashMatchesChain: null, lastCycle: null, inProgress: null, dir, watcher } };
    const s = await k.meditation.summary(subject);
    const mine = node.cell && subject.toLowerCase() === node.cell.address.toLowerCase();
    const state = mine ? readState(node) : undefined;
    const policy = mine ? readPolicy(node) : undefined;
    const lock = mine ? currentLock(node) : undefined;
    const inProgress = lock ? (() => {
      const c = cycleFact(node, lock.cycleId);
      return c ? { cycleId: c.id, phase: c.phase, reportOperation: node.store.get(`job:${c.id}:report`)?.status ?? null } : { cycleId: lock.cycleId, phase: "unknown", reportOperation: null };
    })() : null;
    return {
      registry: s.registry,
      subject,
      enrolled: s.enrolled,
      meaning,
      head: s.enrolled ? { ...s.head, stateVersion: s.head.stateVersion.toString(), recordCount: s.head.recordCount.toString() } : null,
      layers: s.enrolled && s.layers && s.checkpoints ? s.layers.map((l, i) => ({ layer: l.layer, name: l.name, status: l.statusName, deadline: l.deadline, neverCompleted: l.neverCompleted, commitment: s.checkpoints![i].commitment, lastCompletedAt: s.checkpoints![i].lastCompletedAt, lastChangedVersion: s.checkpoints![i].lastChangedVersion.toString() })) : null,
      signal: s.signal ? { status: s.signal.statusName, lastSignalAt: s.signal.lastSignalAt, silentSince: s.signal.silentSince } : null,
      requirements: s.requirements,
      policy: s.policy,
      asOf: s.asOf,
      local: {
        stateVersion: state?.stateVersion ?? null,
        rootMatchesChain: state && s.enrolled ? state.root.toLowerCase() === s.head.root.toLowerCase() : null,
        policyHashMatchesChain: policy && s.policy ? policy.policyHash.toLowerCase() === s.policy.policyHash.toLowerCase() : null,
        lastCycle: mine ? (node.store.getFact<string>("meditation.lastCycle") ?? null) : null,
        inProgress,
        dir,
        watcher,
      },
    };
  },
};

export const meditate_run: ActCapability = {
  name: "meditate_run",
  title: "Run a maintenance cycle (ERC-8490)",
  description: "One maintenance cycle over the layers named (all four by default): the routines run locally — the account, program and allow-list checked; the skills' packages and the store checked and compacted; the tenders in flight and the documents compared with the chain; the window's decisions reviewed — the four state documents are rebuilt from the cell as it is, and one `report` is submitted through the account. The state version moves only when a commitment changed; findings the node may not act on alone are candidates in the record. Resumable: the same job id continues an interrupted cycle, and a report mined while the node was away is reconciled before a new cycle begins. In simulate mode the cycle is computed and shown, nothing is sent and nothing is kept.",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [8490],
  input: z.object({ layers: zLayers, trigger: zTrigger.default("commanded"), detail: z.string().max(400).optional().describe("what prompted the cycle, for the record"), jobId: zJobId }),
  output: z.union([CycleResultSchema, DryRunSchema]),
  async plan({ node, mode }, input) {
    const k = node.kernel;
    const cfg = node.config;
    const gates: Gate[] = [];
    if (!k.meditation.available) throw new Error("this world has no ERC-8490 registry: nothing to register maintenance in");
    const cell = node.body;
    const subject = getAddress(cell.address);
    const layerMask = layerMaskOf(input.layers);
    const trigger: TriggerName = input.trigger;
    const persist = mode === "act";

    const head = await k.meditation.headOf(subject);
    const jobId = input.jobId ?? derivedJobId("meditate", { layerMask, trigger, baseVersion: head.stateVersion.toString(), recordCount: head.recordCount.toString() });

    // what an earlier cycle left behind, decided before anything else: a report mined while the node was away completes
    // that cycle; one still pending or claimed blocks a new cycle unless this request is that same job (which resumes it)
    const rec = persist ? await reconcile(node) : { state: "free" as const };
    if ((rec.state === "pending" || rec.state === "resumable") && rec.cycleId !== jobId) gates.push(refused("concurrency", rec.note));
    else if (rec.state === "released") node.log(`  maintenance: ${rec.note}`);
    if (!head.enrolled) gates.push(refused("policy", `${subject} is not enrolled in ${k.meditation.address} (foga cell extend --covenants 8490, or foga cell owner meditate_enroll)`));
    const [aidState, status] = await Promise.all([k.aid.stateName(subject), cell.status()]);
    gates.push(safetyGate(aidState, status, "plain"));
    let policyVersion = 0;
    if (head.enrolled) {
      policyVersion = head.policyVersion;
      const policy = await k.meditation.policyOf(subject, head.policyVersion);
      if ((layerMask & ~policy.supportedLayers) !== 0) gates.push(refused("policy", `layers ${layersOf(layerMask & ~policy.supportedLayers).join(",")} are not supported by policy v${head.policyVersion} (supported ${policy.supportedLayers})`));
      if ((policy.allowedTriggers & (1 << TRIGGERS[trigger])) === 0) gates.push(refused("policy", `trigger ${trigger} is not allowed by policy v${head.policyVersion} (allowed ${policy.allowedTriggers})`));
      if (!gates.some((g) => !g.ok)) gates.push(ok("policy", `policy v${head.policyVersion}: layers ${layersOf(layerMask).map((l) => LAYER_NAMES[l]).join(", ")}, trigger ${trigger}; base version ${head.stateVersion}`));
    }
    const detail = input.detail ?? (trigger === "commanded" ? "commanded by the operator (foga meditate run)" : `${trigger} trigger`);

    // the cycle: an existing one (resumed) as it was frozen; a new one begun against the head and executed locally
    let cycle: CycleFact | null = null;
    const refusedAlready = gates.some((g) => !g.ok);
    if (!refusedAlready) {
      cycle = (persist ? cycleFact(node, jobId) : undefined) ?? null;
      if (cycle && (cycle.phase === "failed" || cycle.phase === "superseded")) gates.push(refused("concurrency", `cycle ${jobId} ${cycle.phase} before (${cycle.error ?? "no reason recorded"}); a new attempt is a new job id`));
      if (!cycle) cycle = await beginCycle(node, { id: jobId, layerMask, trigger, triggerDetail: detail }, persist);
      cycle = await executeCycle(node, cycle, persist);
      if (cycle.phase === "executed") {
        const changed = cycle.post!.commitments.reduce((m, c, i) => (c.toLowerCase() !== cycle!.pre.commitments[i].toLowerCase() ? m | (1 << i) : m), 0);
        gates.push(ok("maintenance", `${cycle.outcome}: ${cycle.results!.filter((r) => r.completed).length}/${cycle.results!.length} routines completed; ${changed ? `layers ${layersOf(changed).join(",")} change` : "no layer changes"}; ${cycle.results!.reduce((n, r) => n + r.candidates.length, 0)} candidate(s)`));
      }
    }
    const steps: ActStep[] = cycle && (cycle.phase === "executed" || cycle.phase === "confirmed")
      ? [
          {
            name: "report",
            kind: "plain",
            build: async () => {
              const c = cycle!;
              // the registry refuses a completion time in its future: wait for the chain's clock to reach it (a block on anvil,
              // real time elsewhere; only when a completion was recorded in this very block, so a dry run may wait too)
              if (c.endedAt) {
                const now = await k.meditation.clock();
                if (c.endedAt > now) await k.advanceTime(c.endedAt - now, "maintenance: the completion time must not be in the registry's future");
              }
              return { target: k.meditation.address, value: 0n, data: k.meditation.encodeReport(subject, reportOf(c)), label: `report(${subject}, base v${c.pre.stateVersion}, ${c.outcome}, layers ${layersOf(c.layerMask).join(",")})` };
            },
          },
        ]
      : [];
    return {
      job: { id: jobId, kind: "maintenance", input: { layerMask, trigger, detail, policyVersion, baseVersion: head.stateVersion.toString() } },
      gates,
      valueWei: 0n,
      gasPerStep: BigInt(cfg.maintenance.gasPerReport),
      steps,
      output: (confirmed) => {
        const c = cycle!;
        if (!confirmed.length) {
          const changed = c.post!.commitments.reduce((m, x, i) => (x.toLowerCase() !== c.pre.commitments[i].toLowerCase() ? m | (1 << i) : m), 0);
          return { cycleId: c.id, dryRun: true as const, outcome: c.outcome!, baseVersion: c.pre.stateVersion, preRoot: c.pre.root, postRoot: c.post!.root, wouldChangeLayers: changed, layers: c.results!.map((r) => ({ layer: r.layer, name: r.name, completed: r.completed, adoption: r.adoption, changes: r.changes, checks: r.checks, candidates: r.candidates })), record: c.record };
        }
        return confirmCycle(node, c, confirmed[0]);
      },
    };
  },
};

export const meditate_pulse: ActCapability = {
  name: "meditate_pulse",
  title: "Activity pulse (ERC-8490)",
  description: "Record an activity signal in the maintenance registry through the account (`pulse`), with an optional planning hint. Meaningful only when the requirements track a pulse interval (the policy's or the controller's); refused otherwise unless forced. A cycle report is a signal of its own.",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [8490],
  input: z.object({ nextPlannedAt: z.coerce.number().int().min(0).default(0), force: z.coerce.boolean().default(false), jobId: zJobId }),
  output: z.object({ seq: z.string(), lastSignalAt: z.number(), signal: z.string(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.meditation.available) throw new Error("this world has no ERC-8490 registry");
    const cell = node.body;
    const subject = getAddress(cell.address);
    const gates: Gate[] = [];
    const [head, req, aidState, status] = await Promise.all([k.meditation.headOf(subject), k.meditation.requirementsOf(subject), k.aid.stateName(subject), cell.status()]);
    if (!head.enrolled) gates.push(refused("policy", `${subject} is not enrolled`));
    else if (req.pulseInterval === 0 && !input.force) gates.push(refused("policy", "the requirements track no pulse interval (policy.pulseInterval 0 and no controller floor): a pulse records nothing the registry judges; pass force to send one anyway"));
    else gates.push(ok("policy", `pulse interval ${req.pulseInterval} s; last signal ${head.lastSignalAt}`));
    gates.push(safetyGate(aidState, status, "plain"));
    const jobId = input.jobId ?? derivedJobId("pulse", { subject, recordCount: head.recordCount.toString(), nextPlannedAt: input.nextPlannedAt });
    return {
      job: { id: jobId, kind: "maintenance", input: { pulse: true, nextPlannedAt: input.nextPlannedAt } },
      gates,
      valueWei: 0n,
      gasPerStep: 120_000n,
      steps: [{ name: "pulse", kind: "plain", build: () => ({ target: k.meditation.address, value: 0n, data: k.meditation.encodePulse(subject, input.nextPlannedAt), label: `pulse(${subject}, ${input.nextPlannedAt})` }) }],
      output: async (confirmed) => {
        const [h, sig] = await Promise.all([k.meditation.headOf(subject), k.meditation.signalStatus(subject)]);
        return { seq: (confirmed[0] ? k.meditation.seqFromReceipt(confirmed[0].receipt) ?? h.recordCount : h.recordCount).toString(), lastSignalAt: h.lastSignalAt, signal: sig.statusName, txHash: confirmed[0]?.txHash ?? "", jobId };
      },
    };
  },
};

// ---------------------------------------------------------------------------- the owner's acts (admin, CLI only)

export const meditate_enroll: ActCapability = {
  name: "meditate_enroll",
  title: "Enroll in the maintenance registry (ERC-8490)",
  description: "The owner enrolls the cell through its account: the baseline is the commitments of the four layer documents built from the cell as it is, the policy is the configuration's maintenance.policy, the controller is the guardian with the configured rights (or none). When the operator's allow-list lacks the `maintenance` group (a cell born before 0.8.0), the owner opens it first in the same job. The documents, salts and policy are kept so every commitment can be re-derived.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8490],
  input: z.object({ jobId: zJobId }),
  output: z.object({ registry: z.string(), subject: z.string(), stateVersion: z.string(), root: z.string(), commitments: z.array(z.string()), policyVersion: z.number(), policyHash: z.string(), controller: z.string(), controllerRights: z.number(), scopeOpened: z.array(z.string()), txHashes: z.array(z.string()), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.meditation.available) throw new Error("this world has no ERC-8490 registry: foga cell extend --covenants 8490 adds it to the cell's world file when the chain has one");
    const cell = node.body;
    const subject = getAddress(cell.address);
    const gates: Gate[] = [];
    const head = await k.meditation.headOf(subject);
    if (head.enrolled) gates.push(refused("policy", `${subject} is enrolled already (state version ${head.stateVersion}, policy v${head.policyVersion})`));
    const bad = validatePolicy(cellPolicyStruct(node));
    if (bad) gates.push(refused("input", `maintenance.policy: ${bad}`));
    const { controller, rights } = controllerOf(node);
    if (rights !== 0 && controller.toLowerCase() === subject.toLowerCase()) gates.push(refused("input", "the controller cannot be the subject itself"));
    const version = await node.accountVersion();
    if (version < 2) gates.push(refused("policy", `the account is a revision-${version} FogaCellAccount (no operator allow-list); migrate first`));
    // the operator's scope for the cell's own records — and, in a one-key cell, the owner's own pairs through `execute` (the
    // enrollment itself among them): opened by the owner when missing, before the enrollment is sent
    const scope = oneKey(node) ? mergeScope(operatorScope(k, ["maintenance"]), ownerExecuteScope(k)) : operatorScope(k, ["maintenance"]);
    const missing: number[] = version >= 2 ? await missingOf(node, scope) : [];
    if (!gates.some((g) => !g.ok)) gates.push(ok("policy", `enroll ${subject} with controller ${rights ? `${controller} (rights ${rights})` : "none"}; ${missing.length ? `${missing.length} allow-list pair(s) to open first` : "allow-list already open"}`));
    const jobId = input.jobId ?? derivedJobId("meditate-enroll", { subject });
    // the enrollment plan is frozen under the job so a resumed job sends the same baseline
    const factKey = `meditation.enroll.${jobId}`;
    let plan = node.store.getFact<EnrollmentPlan>(factKey);
    if (!plan && !gates.some((g) => !g.ok)) {
      plan = await enrollmentPlan(node);
      node.store.setFact(factKey, plan);
    }
    const steps: ActStep[] = [];
    if (missing.length) steps.push({ name: "scope", kind: "plain", by: "owner", route: "direct", build: () => ({ target: cell.address, value: 0n, data: cell.iface.encodeFunctionData("setOperatorAllowedBatch", [missing.map((i) => scope.targets[i]), missing.map((i) => scope.selectors[i]), true]), label: `setOperatorAllowedBatch(${missing.map((i) => scope.names[i]).join(", ")})` }) });
    steps.push({ name: "enroll", kind: "plain", by: "owner", route: "execute", build: () => ({ target: k.meditation.address, value: 0n, data: k.meditation.encodeEnroll(plan!.committed.commitments, plan!.policyStruct, plan!.controller, plan!.controllerRights), label: `enroll(root ${plan!.committed.root.slice(0, 10)}…, policy ${plan!.policyStruct.policyHash.slice(0, 10)}…, controller ${plan!.controller})` }) });
    return {
      job: { id: jobId, kind: "maintenance-admin", input: { enroll: subject, root: plan?.committed.root ?? null, policyHash: plan?.policyStruct.policyHash ?? null, controller, rights, scope: missing.map((i) => scope.names[i]) } },
      gates,
      valueWei: 0n,
      gasPerStep: 2_600_000n,
      steps,
      output: async (confirmed) => {
        recordEnrollment(node, plan!);
        if (missing.length) node.store.setFact("extend.scope", { groups: [...new Set([...(node.store.getFact<{ groups: string[] }>("extend.scope")?.groups ?? []), "maintenance"])], entries: missing.map((i) => scope.names[i]) });
        const h = await k.meditation.headOf(subject);
        if (!h.enrolled || h.root.toLowerCase() !== plan!.committed.root.toLowerCase()) throw new Error(`the registry holds root ${h.root} after the enrollment; the baseline was ${plan!.committed.root}`);
        return { registry: k.meditation.address, subject, stateVersion: h.stateVersion.toString(), root: h.root, commitments: plan!.committed.commitments, policyVersion: h.policyVersion, policyHash: plan!.policyStruct.policyHash, controller: h.controller, controllerRights: h.controllerRights, scopeOpened: missing.map((i) => scope.names[i]), txHashes: confirmed.map((c) => c.txHash), jobId };
      },
    };
  },
};

export const meditate_policy: ActCapability = {
  name: "meditate_policy",
  title: "Record a new maintenance policy version (ERC-8490)",
  description: "The owner records the configuration's maintenance.policy as a new policy version through the account (`setPolicy`) when its hash differs from the version in force. The policy document is kept and served; cycles begun under the old version report under it.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8490],
  input: z.object({ jobId: zJobId }),
  output: z.object({ subject: z.string(), policyVersion: z.number(), policyHash: z.string(), previousVersion: z.number(), txHash: z.string().nullable(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.meditation.available) throw new Error("this world has no ERC-8490 registry");
    const cell = node.body;
    const subject = getAddress(cell.address);
    const gates: Gate[] = [];
    const head = await k.meditation.headOf(subject);
    const struct = cellPolicyStruct(node);
    const doc = policyDocument(node);
    const bad = validatePolicy(struct);
    if (bad) gates.push(refused("input", `maintenance.policy: ${bad}`));
    if (!head.enrolled) gates.push(refused("policy", `${subject} is not enrolled`));
    else {
      const current = await k.meditation.policyOf(subject, head.policyVersion);
      if (current.policyHash.toLowerCase() === struct.policyHash.toLowerCase() && current.policyURI === struct.policyURI) gates.push(refused("policy", `policy v${head.policyVersion} already has hash ${struct.policyHash.slice(0, 10)}… and this locator; nothing to record`));
      else gates.push(ok("policy", `v${head.policyVersion} ${current.policyHash.slice(0, 10)}… -> ${struct.policyHash.slice(0, 10)}…`));
    }
    const walletGate = await ownerExecuteGate(node, "setPolicy");
    if (walletGate) gates.push(walletGate);
    const jobId = input.jobId ?? derivedJobId("meditate-policy", { subject, policyHash: struct.policyHash, uri: struct.policyURI });
    return {
      job: { id: jobId, kind: "maintenance-admin", input: { setPolicy: subject, policyHash: struct.policyHash, policyURI: struct.policyURI } },
      gates,
      valueWei: 0n,
      gasPerStep: 700_000n,
      steps: [{ name: "setPolicy", kind: "plain", by: "owner", route: "execute", build: () => ({ target: k.meditation.address, value: 0n, data: k.meditation.encodeSetPolicy(subject, struct), label: `setPolicy(${subject}, ${struct.policyHash.slice(0, 10)}…)` }) }],
      output: async (confirmed) => {
        const h = await k.meditation.headOf(subject);
        writePolicy(node, doc, h.policyVersion);
        return { subject, policyVersion: h.policyVersion, policyHash: struct.policyHash, previousVersion: head.policyVersion, txHash: confirmed[0]?.txHash ?? null, jobId };
      },
    };
  },
};

export const meditate_controller: ActCapability = {
  name: "meditate_controller",
  title: "Set, transfer, shrink or renounce the maintenance controller (ERC-8490)",
  description: "With no controller set, the owner appoints one through the account (`setController` by the subject). With a controller set, only the controller may act: the guardian transfers the role (rights a subset of its own), shrinks its rights, or renounces (to the zero address with rights 0) — its own transaction. The rotation of a guardian is this: the outgoing guardian transfers to the incoming one.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  ercs: [8490],
  input: z.object({ to: zAddress.describe("the new controller; the zero address renounces"), rights: z.coerce.number().int().min(0).max(ALL_RIGHTS).default(ALL_RIGHTS), jobId: zJobId }),
  output: z.object({ subject: z.string(), controller: z.string(), controllerRights: z.number(), previous: z.string(), by: z.string(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.meditation.available) throw new Error("this world has no ERC-8490 registry");
    const cell = node.body;
    const subject = getAddress(cell.address);
    const gates: Gate[] = [];
    const head = await k.meditation.headOf(subject);
    const to = getAddress(input.to);
    const zero = to === "0x0000000000000000000000000000000000000000";
    if (!head.enrolled) gates.push(refused("policy", `${subject} is not enrolled`));
    if (to.toLowerCase() === subject.toLowerCase()) gates.push(refused("input", "the controller cannot be the subject"));
    if (zero !== (input.rights === 0)) gates.push(refused("input", "renouncing is the zero address with rights 0; any other controller needs rights above 0"));
    const none = head.controller === "0x0000000000000000000000000000000000000000";
    const by: "owner" | "guardian" = none ? "owner" : "guardian";
    if (none && zero) gates.push(refused("input", "no controller is set; nothing to renounce"));
    if (!none && getAddress(head.controller) !== getAddress(node.config.identity.guardian)) gates.push(refused("policy", `the controller is ${head.controller}, not this cell's guardian ${node.config.identity.guardian}; only the controller may transfer, shrink or renounce`));
    if (!none && (input.rights & ~head.controllerRights) !== 0) gates.push(refused("input", `rights ${input.rights} are not a subset of the controller's ${head.controllerRights}`));
    if (!node.hasKey(by)) gates.push(refused("permission", `this is the ${by}'s act (${none ? "no controller is set: the subject appoints one" : "the controller transfers, shrinks or renounces"}); this process holds no ${by} key — foga cell ${by} meditate_controller …`));
    if (none) {
      const walletGate = await ownerExecuteGate(node, "setController");
      if (walletGate) gates.push(walletGate);
    }
    if (!gates.some((g) => !g.ok)) gates.push(ok("policy", `${none ? "appoint" : zero ? "renounce" : "transfer"}: ${head.controller} (rights ${head.controllerRights}) -> ${to} (rights ${input.rights}) by the ${by}`));
    const jobId = input.jobId ?? derivedJobId("meditate-controller", { subject, to, rights: input.rights, previous: head.controller });
    const step: ActStep = none
      ? { name: "setController", kind: "plain", by: "owner", route: "execute", build: () => ({ target: k.meditation.address, value: 0n, data: k.meditation.encodeSetController(subject, to, input.rights), label: `setController(${subject}, ${to}, ${input.rights}) by the subject` }) }
      : { name: "setController", kind: "plain", by: "guardian", route: "direct", build: () => ({ target: k.meditation.address, value: 0n, data: k.meditation.encodeSetController(subject, to, input.rights), label: `setController(${subject}, ${to}, ${input.rights}) by the controller` }) };
    return {
      job: { id: jobId, kind: "maintenance-admin", input: { setController: subject, to, rights: input.rights, previous: head.controller } },
      gates,
      valueWei: 0n,
      steps: [step],
      output: async (confirmed) => {
        const h = await k.meditation.headOf(subject);
        return { subject, controller: h.controller, controllerRights: h.controllerRights, previous: head.controller, by, txHash: confirmed[0]?.txHash ?? "", jobId };
      },
    };
  },
};

// ---------------------------------------------------------------------------- the controller's acts (the guardian's own transactions)

export const meditate_demand: ActCapability = {
  name: "meditate_demand",
  title: "Demand a maintenance cycle (ERC-8490 controller)",
  description: "The guardian, as controller with the demand right, requires the cell to complete the named layers by a deadline (`demand`): their status turns DUE or OVERDUE against that deadline until a cycle completes them. `withdraw` lifts an outstanding demand.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "guardian",
  ercs: [8490],
  input: z.object({ layers: zLayers, dueInSeconds: z.coerce.number().int().min(60).default(86400), withdraw: z.coerce.boolean().default(false), jobId: zJobId }),
  output: z.object({ subject: z.string(), layerMask: z.number(), dueBy: z.number().nullable(), withdrawn: z.boolean(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.meditation.available) throw new Error("this world has no ERC-8490 registry");
    const subject = getAddress(node.body.address);
    const gates: Gate[] = [];
    const head = await k.meditation.headOf(subject);
    const layerMask = layerMaskOf(input.layers);
    if (!head.enrolled) gates.push(refused("policy", `${subject} is not enrolled`));
    else if (getAddress(head.controller) !== getAddress(node.config.identity.guardian)) gates.push(refused("policy", `the controller is ${head.controller}, not the guardian ${node.config.identity.guardian}`));
    else if (!input.withdraw && (head.controllerRights & 2) === 0) gates.push(refused("policy", `the controller's rights ${head.controllerRights} lack the demand right (2)`));
    else gates.push(ok("policy", `${input.withdraw ? "withdraw demand" : "demand"} for layers ${layersOf(layerMask).join(",")} by controller ${head.controller}`));
    const now = await k.meditation.clock();
    const dueBy = input.withdraw ? null : now + input.dueInSeconds;
    const jobId = input.jobId ?? derivedJobId("meditate-demand", { subject, layerMask, dueBy, withdraw: input.withdraw });
    return {
      job: { id: jobId, kind: "maintenance-admin", input: { demand: subject, layerMask, dueBy, withdraw: input.withdraw } },
      gates,
      valueWei: 0n,
      steps: [{ name: input.withdraw ? "withdrawDemand" : "demand", kind: "plain", by: "guardian", route: "direct", build: () => ({ target: k.meditation.address, value: 0n, data: input.withdraw ? k.meditation.encodeWithdrawDemand(subject, layerMask) : k.meditation.encodeDemand(subject, layerMask, dueBy!), label: input.withdraw ? `withdrawDemand(${subject}, ${layerMask})` : `demand(${subject}, ${layerMask}, ${dueBy})` }) }],
      output: (confirmed) => ({ subject, layerMask, dueBy, withdrawn: input.withdraw, txHash: confirmed[0]?.txHash ?? "", jobId }),
    };
  },
};

export const meditate_floor: ActCapability = {
  name: "meditate_floor",
  title: "Set the maintenance floor (ERC-8490 controller)",
  description: "The guardian, as controller with the floor right, sets minimum requirements the policy cannot relax (`setFloor`): required layers, a pulse interval, per-layer maximum intervals. The effective requirements are the tighter of policy and floor. The floor says nothing about budgets.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "guardian",
  ercs: [8490],
  input: z.object({ requiredLayers: z.coerce.number().int().min(0).max(15).default(0), pulseInterval: z.coerce.number().int().min(0).default(0), maxInterval: z.array(z.coerce.number().int().min(0)).length(4).default([0, 0, 0, 0]), jobId: zJobId }),
  output: z.object({ subject: z.string(), floorVersion: z.number(), requirements: z.unknown(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.meditation.available) throw new Error("this world has no ERC-8490 registry");
    const subject = getAddress(node.body.address);
    const gates: Gate[] = [];
    const head = await k.meditation.headOf(subject);
    if (!head.enrolled) gates.push(refused("policy", `${subject} is not enrolled`));
    else if (getAddress(head.controller) !== getAddress(node.config.identity.guardian)) gates.push(refused("policy", `the controller is ${head.controller}, not the guardian ${node.config.identity.guardian}`));
    else if ((head.controllerRights & 1) === 0) gates.push(refused("policy", `the controller's rights ${head.controllerRights} lack the floor right (1)`));
    for (let i = 0; i < 4; i++) if ((input.requiredLayers & (1 << i)) !== 0 && input.maxInterval[i] === 0) gates.push(refused("input", `layer ${i} is required by the floor but its maxInterval is 0`));
    if (!gates.some((g) => !g.ok)) gates.push(ok("policy", `floor: required ${input.requiredLayers}, pulse ${input.pulseInterval}, intervals ${input.maxInterval.join("/")}`));
    const floor = { requiredLayers: input.requiredLayers, pulseInterval: input.pulseInterval, maxInterval: input.maxInterval as [number, number, number, number] };
    const jobId = input.jobId ?? derivedJobId("meditate-floor", { subject, floor, floorVersion: head.floorVersion });
    return {
      job: { id: jobId, kind: "maintenance-admin", input: { setFloor: subject, floor } },
      gates,
      valueWei: 0n,
      steps: [{ name: "setFloor", kind: "plain", by: "guardian", route: "direct", build: () => ({ target: k.meditation.address, value: 0n, data: k.meditation.encodeSetFloor(subject, floor), label: `setFloor(${subject}, ${input.requiredLayers}, ${input.pulseInterval}, ${input.maxInterval.join("/")})` }) }],
      output: async (confirmed) => {
        const [h, req] = await Promise.all([k.meditation.headOf(subject), k.meditation.requirementsOf(subject)]);
        return { subject, floorVersion: h.floorVersion, requirements: req, txHash: confirmed[0]?.txHash ?? "", jobId };
      },
    };
  },
};

// ---------------------------------------------------------------------------- the operator's scope, completed by the owner

export const scope_complete: ActCapability = {
  name: "scope_complete",
  title: "Complete the operator's allow-list",
  description: "The owner adds to the account's operator allow-list every (target, selector) pair of the node's scope groups that is missing — a cell born before a group existed (the `maintenance` group of 0.8.0), or a world that gained a contract — and, for a one-key cell whose owner is its operator, the owner's own pairs through `execute` (the ERC-8490 enrollment, policy and controller). One `setOperatorAllowedBatch`; nothing is removed.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8468, 8490],
  input: z.object({ groups: z.array(z.string()).optional().describe("the scope groups to complete (default: the node's groups this world can honour)"), jobId: zJobId }),
  output: z.object({ groups: z.array(z.string()), added: z.array(z.string()), alreadyAllowed: z.number(), txHash: z.string().nullable(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const cell = node.body;
    const gates: Gate[] = [];
    const version = await node.accountVersion();
    if (version < 2) gates.push(refused("policy", `the account is a revision-${version} FogaCellAccount (no operator allow-list); migrate first`));
    const groups = applicableGroups(k, (input.groups as ScopeGroup[] | undefined) ?? NODE_SCOPE_GROUPS);
    // a one-key cell also holds the owner's pairs through `execute` (operator-scope.ts); a separated one never does
    const scope = oneKey(node) ? mergeScope(operatorScope(k, groups), ownerExecuteScope(k)) : operatorScope(k, groups);
    const missing: number[] = version >= 2 ? await missingOf(node, scope) : [];
    if (version >= 2 && !missing.length) gates.push(refused("policy", `every pair of ${groups.join(", ")} is allowed already (${scope.names.length})`));
    else if (version >= 2) gates.push(ok("policy", `${missing.length} of ${scope.names.length} pairs to add: ${missing.map((i) => scope.names[i]).join(", ")}`));
    const jobId = input.jobId ?? derivedJobId("scope-complete", { groups, missing: missing.map((i) => scope.names[i]) });
    return {
      job: { id: jobId, kind: "admin", input: { groups, missing: missing.map((i) => scope.names[i]) } },
      gates,
      valueWei: 0n,
      steps: [{ name: "scope", kind: "plain", by: "owner", route: "direct", build: () => ({ target: cell.address, value: 0n, data: cell.iface.encodeFunctionData("setOperatorAllowedBatch", [missing.map((i) => scope.targets[i]), missing.map((i) => scope.selectors[i]), true]), label: `setOperatorAllowedBatch(${missing.length} pairs)` }) }],
      output: (confirmed) => {
        const have = node.store.getFact<{ groups: string[]; entries: string[] }>("extend.scope");
        node.store.setFact("extend.scope", { groups: [...new Set([...(have?.groups ?? []), ...groups])], entries: [...new Set([...(have?.entries ?? []), ...missing.map((i) => scope.names[i])])] });
        return { groups, added: missing.map((i) => scope.names[i]), alreadyAllowed: scope.names.length - missing.length, txHash: confirmed[0]?.txHash ?? null, jobId };
      },
    };
  },
};

export const MEDITATION_CAPABILITIES = [meditate_status, meditate_run, meditate_pulse, meditate_enroll, meditate_policy, meditate_controller, meditate_demand, meditate_floor, scope_complete];

export { MAINTENANCE_STATUS, SIGNAL_STATUS, contentHash };

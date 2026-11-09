import { keccak256, type Contract, type ContractRunner } from "ethers";
import { abi, jcs, keccakUtf8 } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/**
 * ERC-8490 Agent Meditation Mechanism: attributable, versioned registration of an agent's own maintenance across
 * four fixed layers (runtime; memory and skills; tasks and roles; cognition). The registry holds commitments and
 * timeliness, never the documents: a layer's state is a JSON document kept by the agent, committed as
 * keccak256(abi.encode(TAG, layer, schemaHash, keccak256(JCS(document)), salt)), and the four commitments roll up
 * into one state root. This module is the kernel's view of the registry: the hashing that must agree with the
 * contract bit for bit (checked against the upstream vectors in test/amm.test.ts), the calldata encoders the
 * catalog's steps use, and the reads the node and the card need.
 *
 * Who may call what (0.8.0): `enroll` names msg.sender as the subject, so a cell enrolls through its account's
 * `execute` (the subject is the cell account); `report` and `pulse` are the subject's own calls through the same
 * route, which the operator makes under the account's allow-list (the `maintenance` scope group). No operator
 * permission is granted on the registry itself: one authorization path, the account's.
 */
export const AMM_CONTRACT = "8490/AgentMeditationRegistry";
export const AMM_INTERFACE_ID = "0x9c81b550";

export const LAYER_NAMES = ["runtime", "memory-skills", "tasks-roles", "cognition"] as const;
export type LayerName = (typeof LAYER_NAMES)[number];
export const LAYER_SCHEMAS = ["amm.layer.runtime/1", "amm.layer.memory-skills/1", "amm.layer.tasks-roles/1", "amm.layer.cognition/1"] as const;
export const ALL_LAYERS = 0x0f;

export const OPS = { clean: 0, repair: 1, update: 2, iterate: 3 } as const;
export type OpName = keyof typeof OPS;
export const TRIGGERS = { scheduled: 0, event: 1, commanded: 2, self: 3 } as const;
export type TriggerName = keyof typeof TRIGGERS;
export const OUTCOMES = { completed: 0, partial: 1, aborted: 2, failed: 3 } as const;
export type OutcomeName = keyof typeof OUTCOMES;

/** Controller rights (bits). */
export const RIGHTS = { floor: 1, demand: 2, revokeOperators: 4 } as const;
export const ALL_RIGHTS = 7;
/** Operator permissions on the registry (bits); FOGA grants none by default (see the module comment). */
export const PERMS = { report: 1, pulse: 2, policy: 4 } as const;

export const MAINTENANCE_STATUS = ["NOT_ENROLLED", "UNSUPPORTED", "UNSCHEDULED", "FRESH", "DUE", "OVERDUE"] as const;
export const SIGNAL_STATUS = ["NOT_ENROLLED", "NOT_TRACKED", "PRESENT", "SILENT"] as const;
export const DISCLOSURE = { commitment: 0, summary: 1, full: 2 } as const;

export const TAG_LAYER_COMMITMENT = keccakUtf8("AgentMeditationMechanism/LayerCommitment/v1");
export const TAG_STATE_ROOT = keccakUtf8("AgentMeditationMechanism/StateRoot/v1");
export const ZERO32 = "0x" + "00".repeat(32);

export type Commitments = [string, string, string, string];

/** keccak256 of the canonical (RFC 8785) UTF-8 serialization of a JSON document. */
export function contentHash(doc: unknown): string {
  return keccakUtf8(jcs(doc));
}

export function schemaHash(schemaId: string): string {
  return keccakUtf8(schemaId);
}

/** Layer commitment: keccak256(abi.encode(TAG, uint8 layer, bytes32 schemaHash, bytes32 contentHash, bytes32 salt)). */
export function layerCommitment(layer: number, schemaHashHex: string, contentHashHex: string, salt = ZERO32): string {
  if (!(Number.isInteger(layer) && layer >= 0 && layer <= 3)) throw new RangeError(`layer must be 0..3, got ${layer}`);
  return keccak256(abi.encode(["bytes32", "uint8", "bytes32", "bytes32", "bytes32"], [TAG_LAYER_COMMITMENT, layer, schemaHashHex, contentHashHex, salt]));
}

export interface LayerDocument {
  schema: string;
  layer: number;
  [k: string]: unknown;
}

export interface LayerCommitmentRecord {
  layer: number;
  schemaId: string;
  schemaHash: string;
  contentHash: string;
  salt: string;
  commitment: string;
}

/** Commitment of a layer state document, validating that its `schema` and `layer` members match the layer. */
export function commitLayerDocument(layer: number, doc: LayerDocument, salt = ZERO32): LayerCommitmentRecord {
  if (doc.layer !== layer) throw new Error(`document layer ${doc.layer} does not match ${layer}`);
  if (doc.schema !== LAYER_SCHEMAS[layer]) throw new Error(`document schema ${doc.schema} does not match ${LAYER_SCHEMAS[layer]}`);
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error(`salt must be 32 bytes of hex, got ${salt}`);
  const sh = schemaHash(doc.schema);
  const ch = contentHash(doc);
  return { layer, schemaId: doc.schema, schemaHash: sh, contentHash: ch, salt, commitment: layerCommitment(layer, sh, ch, salt) };
}

/** State root over four layer commitments: keccak256(abi.encode(TAG, c0, c1, c2, c3)). */
export function stateRoot(commitments: readonly string[]): string {
  if (commitments.length !== 4) throw new RangeError("four commitments required");
  return keccak256(abi.encode(["bytes32", "bytes32", "bytes32", "bytes32", "bytes32"], [TAG_STATE_ROOT, ...commitments]));
}

/** Commitment to an off-chain cycle record document (keccak256 of its JCS). */
export function recordHash(doc: unknown): string {
  return contentHash(doc);
}

// ---------------------------------------------------------------------------- the policy

/** The on-chain fields of a policy document (`amm.policy/1`, member `onchain`). */
export interface PolicyOnchain {
  supportedLayers: number;
  requiredLayers: number;
  allowedTriggers: number;
  disclosure: number;
  dueWindow: number;
  pulseInterval: number;
  maxInterval: [number, number, number, number];
}

export interface PolicyDocument {
  schema: "amm.policy/1";
  version: number;
  onchain: PolicyOnchain;
  [k: string]: unknown;
}

/** The registry's Policy struct (named, as ethers encodes a tuple from an object). */
export interface PolicyStruct {
  policyHash: string;
  policyURI: string;
  supportedLayers: number;
  requiredLayers: number;
  allowedTriggers: number;
  disclosure: number;
  dueWindow: number;
  pulseInterval: number;
  maxInterval: [number, number, number, number];
}

/** Build the on-chain Policy struct from a policy document: the hash commits to the whole document, the fields come from `onchain`. */
export function policyStruct(doc: PolicyDocument, policyURI = ""): PolicyStruct {
  const o = doc.onchain;
  return {
    policyHash: contentHash(doc),
    policyURI,
    supportedLayers: o.supportedLayers,
    requiredLayers: o.requiredLayers,
    allowedTriggers: o.allowedTriggers,
    disclosure: o.disclosure,
    dueWindow: o.dueWindow,
    pulseInterval: o.pulseInterval,
    maxInterval: [...o.maxInterval] as [number, number, number, number],
  };
}

/** The struct in interface order, as an array (what the upstream vectors print). */
export function policyArray(p: PolicyStruct): unknown[] {
  return [p.policyHash, p.policyURI, p.supportedLayers, p.requiredLayers, p.allowedTriggers, p.disclosure, p.dueWindow, p.pulseInterval, p.maxInterval];
}

/** The checks `enroll` and `setPolicy` make (`_validatePolicy`), so a bad policy is refused before it is sent. */
export function validatePolicy(p: PolicyStruct): string | null {
  if (p.supportedLayers === 0 || (p.supportedLayers & ~ALL_LAYERS) !== 0) return `supportedLayers ${p.supportedLayers} is not a non-empty subset of the four layers`;
  if ((p.requiredLayers & ~p.supportedLayers) !== 0) return `requiredLayers ${p.requiredLayers} is not a subset of supportedLayers ${p.supportedLayers}`;
  if (p.allowedTriggers === 0 || (p.allowedTriggers & ~0x0f) !== 0) return `allowedTriggers ${p.allowedTriggers} is not a non-empty subset of the four triggers`;
  if (p.disclosure > 2) return `disclosure ${p.disclosure} is not 0, 1 or 2`;
  for (let i = 0; i < 4; i++) if ((p.requiredLayers & (1 << i)) !== 0 && p.maxInterval[i] === 0) return `layer ${i} is required but its maxInterval is 0`;
  return null;
}

// ---------------------------------------------------------------------------- the cycle report

export interface CycleRecordLayer {
  layer: number;
  scope: boolean;
  completed: boolean;
  changes?: { op: OpName; [k: string]: unknown }[];
  [k: string]: unknown;
}

/** The off-chain cycle record (`amm.cycle-record/1`): the source the on-chain summary is derived from. */
export interface CycleRecordDocument {
  schema: "amm.cycle-record/1";
  subject: string;
  policyVersion: number;
  baseVersion: number | string;
  trigger: TriggerName;
  reportedStartedAt: number;
  reportedEndedAt: number;
  nextPlannedAt?: number;
  restoresVersion?: number | string;
  layers: CycleRecordLayer[];
  outcome: OutcomeName;
  [k: string]: unknown;
}

/** The registry's CycleReport struct (named). */
export interface CycleReportStruct {
  baseVersion: bigint;
  preRoot: string;
  postCommitments: Commitments;
  layerMask: number;
  completedLayers: number;
  opsMask: number;
  outcome: number;
  trigger: number;
  policyVersion: number;
  reportedStartedAt: number;
  reportedEndedAt: number;
  nextPlannedAt: number;
  restoresVersion: bigint;
  recordHash: string;
  recordURI: string;
}

export interface ReportSummary {
  layerMask: number;
  completedLayers: number;
  opsMask: number;
  changedLayers: number;
  outcome: number;
  trigger: number;
  recordHash: string;
  postRoot: string;
}

/**
 * Derive the on-chain report from a cycle record and the pre/post commitments. Layers out of scope must carry the
 * pre-state commitment (the registry reverts with UnscopedLayerChanged otherwise); the outcome must agree with the
 * completed set (`_checkShape`): both are checked here so the refusal is local.
 */
export function buildReport(record: CycleRecordDocument, pre: { commitments: readonly string[]; root: string }, post: { commitments: readonly string[] }, recordURI = ""): { report: CycleReportStruct; summary: ReportSummary } {
  let layerMask = 0;
  let completedLayers = 0;
  let opsMask = 0;
  for (const l of record.layers) {
    if (!l.scope) continue;
    layerMask |= 1 << l.layer;
    if (l.completed) completedLayers |= 1 << l.layer;
    for (const c of l.changes ?? []) {
      if (!(c.op in OPS)) throw new Error(`unknown op ${String(c.op)}`);
      opsMask |= 1 << (l.layer * 4 + OPS[c.op]);
    }
  }
  if (!(record.outcome in OUTCOMES)) throw new Error(`unknown outcome ${String(record.outcome)}`);
  if (!(record.trigger in TRIGGERS)) throw new Error(`unknown trigger ${String(record.trigger)}`);
  if (pre.commitments.length !== 4 || post.commitments.length !== 4) throw new RangeError("four commitments required");
  const postCommitments = [...post.commitments] as Commitments;
  for (let i = 0; i < 4; i++) {
    if ((layerMask & (1 << i)) === 0 && postCommitments[i].toLowerCase() !== pre.commitments[i].toLowerCase()) throw new Error(`layer ${i} is out of scope but its commitment differs from the pre state`);
  }
  const shape = checkShape({ layerMask, completedLayers, opsMask, outcome: OUTCOMES[record.outcome], trigger: TRIGGERS[record.trigger] });
  if (shape) throw new Error(shape);
  const rh = recordHash(record);
  const changedLayers = postCommitments.reduce((m, c, i) => (c.toLowerCase() !== pre.commitments[i].toLowerCase() ? m | (1 << i) : m), 0);
  return {
    report: {
      baseVersion: BigInt(record.baseVersion),
      preRoot: pre.root,
      postCommitments,
      layerMask,
      completedLayers,
      opsMask,
      outcome: OUTCOMES[record.outcome],
      trigger: TRIGGERS[record.trigger],
      policyVersion: record.policyVersion,
      reportedStartedAt: record.reportedStartedAt,
      reportedEndedAt: record.reportedEndedAt,
      nextPlannedAt: record.nextPlannedAt ?? 0,
      restoresVersion: BigInt(record.restoresVersion ?? 0),
      recordHash: rh,
      recordURI,
    },
    summary: { layerMask, completedLayers, opsMask, changedLayers, outcome: OUTCOMES[record.outcome], trigger: TRIGGERS[record.trigger], recordHash: rh, postRoot: stateRoot(postCommitments) },
  };
}

/** The registry's `_checkShape`, locally: null when the report's masks and outcome agree. */
export function checkShape(r: { layerMask: number; completedLayers: number; opsMask: number; outcome: number; trigger: number }): string | null {
  if (r.layerMask === 0 || (r.layerMask & ~ALL_LAYERS) !== 0) return `layerMask ${r.layerMask} is not a non-empty subset of the four layers`;
  if ((r.completedLayers & ~r.layerMask) !== 0) return `completedLayers ${r.completedLayers} is not a subset of layerMask ${r.layerMask}`;
  for (let i = 0; i < 4; i++) if ((r.layerMask & (1 << i)) === 0 && ((r.opsMask >> (i * 4)) & 0x0f) !== 0) return `opsMask names operations on layer ${i}, which is out of scope`;
  if (r.trigger > 3) return `trigger ${r.trigger} is not 0..3`;
  if (r.outcome > 3) return `outcome ${r.outcome} is not 0..3`;
  if (r.outcome === OUTCOMES.completed && r.completedLayers !== r.layerMask) return "outcome COMPLETED needs every scoped layer completed";
  if (r.outcome === OUTCOMES.partial && (r.completedLayers === 0 || r.completedLayers === r.layerMask)) return "outcome PARTIAL needs some but not all scoped layers completed";
  if (r.outcome === OUTCOMES.aborted && r.completedLayers === r.layerMask) return "outcome ABORTED cannot have every scoped layer completed";
  if (r.outcome === OUTCOMES.failed && r.completedLayers !== 0) return "outcome FAILED cannot have a completed layer";
  return null;
}

/** The struct in interface order, as an array (what the upstream vectors print). */
export function reportArray(r: CycleReportStruct): unknown[] {
  return [r.baseVersion, r.preRoot, r.postCommitments, r.layerMask, r.completedLayers, r.opsMask, r.outcome, r.trigger, r.policyVersion, r.reportedStartedAt, r.reportedEndedAt, r.nextPlannedAt, r.restoresVersion, r.recordHash, r.recordURI];
}

/** The outcome a cycle declares from what its scoped layers did: every routine completed, some, or none. */
export function outcomeOf(layerMask: number, completedLayers: number, aborted = false): OutcomeName {
  if (completedLayers === layerMask) return "completed";
  if (completedLayers === 0) return "failed";
  return aborted ? "aborted" : "partial";
}

// ---------------------------------------------------------------------------- the registry

export interface Head {
  enrolled: boolean;
  controller: string;
  controllerRights: number;
  policyVersion: number;
  floorVersion: number;
  stateVersion: bigint;
  recordCount: bigint;
  root: string;
  enrolledAt: number;
  lastSignalAt: number;
  nextPlannedAt: number;
}

export interface LayerCheckpoint {
  commitment: string;
  lastCompletedAt: number;
  lastCompletedRecordedAt: number;
  completedUnderPolicy: number;
  lastChangedVersion: bigint;
}

export interface Requirements {
  supportedLayers: number;
  requiredLayers: number;
  dueWindow: number;
  pulseInterval: number;
  maxInterval: [number, number, number, number];
}

export interface LayerStatus {
  layer: number;
  name: LayerName;
  status: number;
  statusName: (typeof MAINTENANCE_STATUS)[number];
  deadline: number;
  neverCompleted: boolean;
}

export interface SignalState {
  status: number;
  statusName: (typeof SIGNAL_STATUS)[number];
  lastSignalAt: number;
  silentSince: number;
}

export class Meditation {
  constructor(readonly world: World) {}

  /** True when this world has the registry (an extension in 0.8.0: a world without it has no maintenance registration). */
  get available(): boolean {
    return this.world.has(AMM_CONTRACT);
  }

  registry(runner?: ContractRunner): Contract {
    return this.world.contract(AMM_CONTRACT, runner);
  }

  get address(): string {
    return this.world.address(AMM_CONTRACT);
  }

  // ---- encoders (the subject's own calls, made through the cell account's `execute`)

  encodeEnroll(baseline: Commitments, policy: PolicyStruct, controller: string, controllerRights: number): string {
    return this.registry().interface.encodeFunctionData("enroll", [baseline, policy, controller, controllerRights]);
  }

  encodeReport(subject: string, report: CycleReportStruct): string {
    return this.registry().interface.encodeFunctionData("report", [subject, report]);
  }

  encodePulse(subject: string, nextPlannedAt: number): string {
    return this.registry().interface.encodeFunctionData("pulse", [subject, nextPlannedAt]);
  }

  encodeSetPolicy(subject: string, policy: PolicyStruct): string {
    return this.registry().interface.encodeFunctionData("setPolicy", [subject, policy]);
  }

  encodeSetController(subject: string, newController: string, rights: number): string {
    return this.registry().interface.encodeFunctionData("setController", [subject, newController, rights]);
  }

  /** The controller's calls (the guardian's own transactions, `route: direct`). */
  encodeSetFloor(subject: string, floor: { requiredLayers: number; pulseInterval: number; maxInterval: [number, number, number, number] }): string {
    return this.registry().interface.encodeFunctionData("setFloor", [subject, floor]);
  }

  encodeDemand(subject: string, layerMask: number, dueBy: number): string {
    return this.registry().interface.encodeFunctionData("demand", [subject, layerMask, dueBy]);
  }

  encodeWithdrawDemand(subject: string, layerMask: number): string {
    return this.registry().interface.encodeFunctionData("withdrawDemand", [subject, layerMask]);
  }

  // ---- receipts

  /** The sequence number a `report` or `pulse` assigned (CycleRecorded / Pulsed), or null when neither event is in the receipt. */
  seqFromReceipt(receipt: any): bigint | null {
    for (const name of ["CycleRecorded", "Pulsed"]) {
      try {
        return BigInt(eventArgs(this.registry().interface, receipt, name, this.address).seq);
      } catch {
        /* not this one */
      }
    }
    return null;
  }

  /** The CycleRecorded event of a report receipt: the versions before and after, the changed layers, the clock value. */
  cycleRecordedFromReceipt(receipt: any): { seq: bigint; baseVersion: bigint; newVersion: bigint; changedLayers: number; recordedAt: number; submitter: string } {
    const a = eventArgs(this.registry().interface, receipt, "CycleRecorded", this.address);
    return { seq: BigInt(a.seq), baseVersion: BigInt(a.baseVersion), newVersion: BigInt(a.newVersion), changedLayers: Number(a.changedLayers), recordedAt: Number(a.recordedAt), submitter: String(a.submitter) };
  }

  // ---- reads

  async clock(): Promise<number> {
    return Number(await this.registry().clock());
  }

  async headOf(subject: string): Promise<Head> {
    const h = await this.registry().headOf(subject);
    return { enrolled: Boolean(h.enrolled), controller: String(h.controller), controllerRights: Number(h.controllerRights), policyVersion: Number(h.policyVersion), floorVersion: Number(h.floorVersion), stateVersion: BigInt(h.stateVersion), recordCount: BigInt(h.recordCount), root: String(h.root), enrolledAt: Number(h.enrolledAt), lastSignalAt: Number(h.lastSignalAt), nextPlannedAt: Number(h.nextPlannedAt) };
  }

  async checkpointOf(subject: string, layer: number): Promise<LayerCheckpoint> {
    const c = await this.registry().checkpointOf(subject, layer);
    return { commitment: String(c.commitment), lastCompletedAt: Number(c.lastCompletedAt), lastCompletedRecordedAt: Number(c.lastCompletedRecordedAt), completedUnderPolicy: Number(c.completedUnderPolicy), lastChangedVersion: BigInt(c.lastChangedVersion) };
  }

  async checkpoints(subject: string): Promise<[LayerCheckpoint, LayerCheckpoint, LayerCheckpoint, LayerCheckpoint]> {
    const out = await Promise.all([0, 1, 2, 3].map((l) => this.checkpointOf(subject, l)));
    return out as [LayerCheckpoint, LayerCheckpoint, LayerCheckpoint, LayerCheckpoint];
  }

  async rootAt(subject: string, stateVersion: bigint | number): Promise<string> {
    return String(await this.registry().rootAt(subject, stateVersion));
  }

  async policyOf(subject: string, version: number): Promise<PolicyStruct> {
    const p = await this.registry().policyOf(subject, version);
    return { policyHash: String(p.policyHash), policyURI: String(p.policyURI), supportedLayers: Number(p.supportedLayers), requiredLayers: Number(p.requiredLayers), allowedTriggers: Number(p.allowedTriggers), disclosure: Number(p.disclosure), dueWindow: Number(p.dueWindow), pulseInterval: Number(p.pulseInterval), maxInterval: Array.from(p.maxInterval, (x: any) => Number(x)) as [number, number, number, number] };
  }

  async policyEffectiveFrom(subject: string, version: number): Promise<number> {
    return Number(await this.registry().policyEffectiveFrom(subject, version));
  }

  async floorOf(subject: string): Promise<{ requiredLayers: number; pulseInterval: number; maxInterval: [number, number, number, number] }> {
    const f = await this.registry().floorOf(subject);
    return { requiredLayers: Number(f.requiredLayers), pulseInterval: Number(f.pulseInterval), maxInterval: Array.from(f.maxInterval, (x: any) => Number(x)) as [number, number, number, number] };
  }

  async demandOf(subject: string, layer: number): Promise<{ demandedAt: number; dueBy: number }> {
    const d = await this.registry().demandOf(subject, layer);
    return { demandedAt: Number(d.demandedAt), dueBy: Number(d.dueBy) };
  }

  async operatorPermissions(subject: string, operator: string): Promise<number> {
    return Number(await this.registry().operatorPermissions(subject, operator));
  }

  async requirementsOf(subject: string): Promise<Requirements> {
    const r = await this.registry().requirementsOf(subject);
    return { supportedLayers: Number(r.supportedLayers), requiredLayers: Number(r.requiredLayers), dueWindow: Number(r.dueWindow), pulseInterval: Number(r.pulseInterval), maxInterval: Array.from(r.maxInterval, (x: any) => Number(x)) as [number, number, number, number] };
  }

  async layerStatus(subject: string, layer: number): Promise<LayerStatus> {
    const s = await this.registry().layerStatus(subject, layer);
    const status = Number(s.status ?? s[0]);
    return { layer, name: LAYER_NAMES[layer], status, statusName: MAINTENANCE_STATUS[status] ?? ("UNKNOWN" as any), deadline: Number(s.deadline ?? s[1]), neverCompleted: Boolean(s.neverCompleted ?? s[2]) };
  }

  async layerStatuses(subject: string): Promise<LayerStatus[]> {
    return Promise.all([0, 1, 2, 3].map((l) => this.layerStatus(subject, l)));
  }

  async signalStatus(subject: string): Promise<SignalState> {
    const s = await this.registry().signalStatus(subject);
    const status = Number(s.status ?? s[0]);
    return { status, statusName: SIGNAL_STATUS[status] ?? ("UNKNOWN" as any), lastSignalAt: Number(s.lastSignalAt ?? s[1]), silentSince: Number(s.silentSince ?? s[2]) };
  }

  /** The registry's own root computation, for a cross-check of the kernel's hashing on a live chain. */
  async computeRoot(commitments: Commitments): Promise<string> {
    return String(await this.registry().computeRoot(commitments));
  }

  /** Everything the status read and the card need about one subject, in one place. */
  async summary(subject: string): Promise<MaintenanceSummary> {
    const head = await this.headOf(subject);
    if (!head.enrolled) return { registry: this.address, subject, enrolled: false, head, checkpoints: null, requirements: null, layers: null, signal: null, policy: null, asOf: await this.clock() };
    const [checkpoints, requirements, layers, signal, policy, asOf] = await Promise.all([this.checkpoints(subject), this.requirementsOf(subject), this.layerStatuses(subject), this.signalStatus(subject), this.policyOf(subject, head.policyVersion), this.clock()]);
    return { registry: this.address, subject, enrolled: true, head, checkpoints, requirements, layers, signal, policy, asOf };
  }
}

export interface MaintenanceSummary {
  registry: string;
  subject: string;
  enrolled: boolean;
  head: Head;
  checkpoints: [LayerCheckpoint, LayerCheckpoint, LayerCheckpoint, LayerCheckpoint] | null;
  requirements: Requirements | null;
  layers: LayerStatus[] | null;
  signal: SignalState | null;
  policy: PolicyStruct | null;
  /** The registry's clock when this was read (mode=timestamp: the block timestamp). */
  asOf: number;
}

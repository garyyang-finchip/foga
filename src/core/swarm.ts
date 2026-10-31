import { Interface, keccak256, toUtf8Bytes, type Contract, type ContractRunner } from "ethers";
import { abi, dataUriJcs, jcs, sha256Hex } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/** ERC-8447 Swarm AI Framework: how cells organize into purpose-bound swarms. */
export const Boundary = { OPEN: 0, GATED: 1, CLOSED: 2 } as const;
export const Admission = { RECRUIT: 0, INHERIT: 1, SELECT: 2 } as const;
export const AuthorityKind = { NONE: 0, ADDRESS: 1, ROLE: 2, ANY_MEMBER: 3, INITIATOR: 4 } as const;
export const DecisionPoint = { ACTIVATE: 0, ABORT: 1, SUSPEND: 2, RESUME: 3, ADVANCE: 4, CONCLUDE: 5, DISSOLVE: 6, SUCCEED: 7, ADMIT: 8, REMOVE: 9, REINSTATE: 10, AMEND: 11, ATTACH: 12, DETACH: 13, SET_ACCOUNT: 14, REPRESENT: 15 } as const;
export const DECISION_POINTS = 16;
export const Activation = { ROSTER_MET: 0, AUTHORITY: 1, BOTH: 2 } as const;
export const Contributions = { DISABLED: 0, MEMBERS: 1, OPEN: 2 } as const;
export const ObjectiveKind = { TERMINAL: 0, MILESTONED: 1, EXPLORATORY: 2, STANDING: 3 } as const;
export const LifecycleStateName = ["NONE", "FORMING", "ACTIVE", "SUSPENDED", "CONCLUDING", "DISSOLVED"] as const;
export const OutcomeTypeName = ["NONE", "ACHIEVED", "PARTIAL", "FAILED", "ABANDONED", "SUPERSEDED"] as const;
export const MemberStatusName = ["NONE", "CANDIDATE", "ACTIVE", "SUSPENDED", "EXITED"] as const;
export const SuspensionCauseName = ["NONE", "AUTHORITY", "INELIGIBLE"] as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
export const ZERO32 = "0x" + "00".repeat(32);

export function saiId(name: string): string {
  return keccak256(toUtf8Bytes(name));
}

export const roleId = (name: string) => saiId(`sai.role.${name}`);
export const term = { payoff: (n: string) => saiId(`sai.payoff.${n}`), topology: (n: string) => saiId(`sai.topology.${n}`), coordination: (n: string) => saiId(`sai.coordination.${n}`) };
export const originKind = (name: string) => saiId(`sai.origin.${name}`);

export function bytes32Label(label: string): string {
  const b = toUtf8Bytes(label);
  if (b.length > 32) throw new Error(`label ${label} exceeds 32 bytes`);
  return "0x" + Buffer.from(b).toString("hex").padEnd(64, "0");
}

export interface RoleSpec {
  roleId: string;
  min: number;
  max: number;
  eligibility: string;
  selfJoin: boolean;
}

export interface PhaseSpec {
  name: string;
  payoff: string;
  topology: string;
  coordination: string;
  boundary: number;
  admission: number;
  inputWindow: number;
  descriptorHash: string;
}

export interface Authority {
  kind: number;
  target: string;
  roleId: string;
}

export interface SwarmSpec {
  roles: RoleSpec[];
  phases: PhaseSpec[];
  authorities: Authority[];
  activation: number;
  contributions: number;
  minMembers: number;
  maxMembers: number;
  recruitmentWindow: number;
  maxDuration: number;
  inactivityTimeout: number;
  ineligibleGrace: number;
  settlementWindow: number;
  amendmentExitWindow: number;
  descriptorHash: string;
}

export interface ObjectiveInput {
  objectiveHash: string;
  kind: number;
  acceptanceAuthority: string;
  obligation: { chainId: number; target: string; id: bigint };
  milestoneCount: number;
}

export const none: Authority = { kind: AuthorityKind.NONE, target: ZERO_ADDRESS, roleId: ZERO32 };
export const initiator: Authority = { kind: AuthorityKind.INITIATOR, target: ZERO_ADDRESS, roleId: ZERO32 };
export const byAddress = (target: string): Authority => ({ kind: AuthorityKind.ADDRESS, target, roleId: ZERO32 });
export const byRole = (role: string): Authority => ({ kind: AuthorityKind.ROLE, target: ZERO_ADDRESS, roleId: role });

/** Sixteen authorities indexed by decision point, from a partial map; the rest are NONE. */
export function authorities(map: Partial<Record<keyof typeof DecisionPoint, Authority>>): Authority[] {
  const out: Authority[] = new Array(DECISION_POINTS).fill(none);
  for (const [name, a] of Object.entries(map)) out[DecisionPoint[name as keyof typeof DecisionPoint]] = a!;
  return out;
}

export const SWARM_SPEC_TUPLE =
  "tuple(tuple(bytes32 roleId,uint32 min,uint32 max,address eligibility,bool selfJoin)[] roles,tuple(bytes32 name,bytes32 payoff,bytes32 topology,bytes32 coordination,uint8 boundary,uint8 admission,uint64 inputWindow,bytes32 descriptorHash)[] phases,tuple(uint8 kind,address target,bytes32 roleId)[] authorities,uint8 activation,uint8 contributions,uint32 minMembers,uint32 maxMembers,uint64 recruitmentWindow,uint64 maxDuration,uint64 inactivityTimeout,uint64 ineligibleGrace,uint64 settlementWindow,uint64 amendmentExitWindow,bytes32 descriptorHash)";

/** specHash = keccak256(abi.encode(spec)). */
export function specHashOf(spec: SwarmSpec): string {
  return keccak256(abi.encode([SWARM_SPEC_TUPLE], [spec]));
}

/** Swarm Pack commitments: SHA-256 over the JCS form of the root, the objective and the commitment members. */
export function packHashes(pack: Record<string, unknown>): { charterHash: string; objectiveHash: string; commitmentHash: string; charterURI: string } {
  return {
    charterHash: sha256Hex(jcs(pack)),
    objectiveHash: sha256Hex(jcs(pack.objective)),
    commitmentHash: pack.commitment ? sha256Hex(jcs(pack.commitment)) : ZERO32,
    charterURI: dataUriJcs(pack),
  };
}

export function taskOriginRef(chainId: number, taskToken: string, tokenId: bigint): string {
  return keccak256(abi.encode(["uint256", "address", "uint256"], [chainId, taskToken, tokenId]));
}

export interface SwarmRecord {
  specHash: string;
  charterHash: string;
  commitmentHash: string;
  charterVersion: number;
  commitmentVersion: number;
  charterURI: string;
  initiator: string;
  account: string;
  state: number;
  stateName: string;
  outcome: number;
  outcomeName: string;
  phase: number;
  resultHash: string;
  activatedAt: bigint;
}

export class Swarms {
  readonly address: string;
  constructor(readonly world: World) {
    this.address = world.address("8447/SwarmRegistry");
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.contract("8447/SwarmRegistry", runner);
  }

  // ---- calldata builders

  encodeForm(spec: SwarmSpec, charterHash: string, commitmentHash: string, charterURI: string, origin: { kind: string; ref: string }, objective: ObjectiveInput): string {
    return this.contract().interface.encodeFunctionData("form", [spec, charterHash, commitmentHash, charterURI, ZERO32, origin, objective]);
  }

  encodeJoin(swarmId: string, role: string, charterHash: string): string {
    return this.contract().interface.encodeFunctionData("join", [swarmId, role, charterHash]);
  }

  encodeActivate(swarmId: string): string {
    return this.contract().interface.encodeFunctionData("activate", [swarmId]);
  }

  encodeSetAccount(swarmId: string, account: string): string {
    return this.contract().interface.encodeFunctionData("setAccount", [swarmId, account]);
  }

  encodeChallenge(swarmId: string, account: string): string {
    return this.contract().interface.encodeFunctionData("challenge", [swarmId, account]);
  }

  encodeAmend(swarmId: string, charterHash: string, charterURI: string, objectiveHash = ZERO32, commitmentHash = ZERO32, material = false): string {
    return this.contract().interface.encodeFunctionData("amend", [swarmId, charterHash, charterURI, objectiveHash, commitmentHash, material]);
  }

  encodeLeave(swarmId: string): string {
    return this.contract().interface.encodeFunctionData("leave", [swarmId]);
  }

  swarmIdFromReceipt(receipt: any): string {
    return eventArgs(this.contract().interface, receipt, "SwarmFormed", this.address).swarmId;
  }

  selector(fn: string): string {
    return this.contract().interface.getFunction(fn)!.selector;
  }

  // ---- views

  async getSwarm(swarmId: string): Promise<SwarmRecord> {
    const s = await this.contract().getSwarm(swarmId);
    const state = Number(s.state);
    const outcome = Number(s.outcome);
    return {
      specHash: s.specHash,
      charterHash: s.charterHash,
      commitmentHash: s.commitmentHash,
      charterVersion: Number(s.charterVersion),
      commitmentVersion: Number(s.commitmentVersion),
      charterURI: s.charterURI,
      initiator: s.initiator,
      account: s.account,
      state,
      stateName: LifecycleStateName[state] ?? String(state),
      outcome,
      outcomeName: OutcomeTypeName[outcome] ?? String(outcome),
      phase: Number(s.phase),
      resultHash: s.resultHash,
      activatedAt: BigInt(s.activatedAt),
    };
  }

  async memberStatus(swarmId: string, account: string): Promise<{ status: number; statusName: string; exitReason: number }> {
    const r = await this.contract().memberStatus(swarmId, account);
    const status = Number(r[0]);
    return { status, statusName: MemberStatusName[status] ?? String(status), exitReason: Number(r[1]) };
  }

  async member(swarmId: string, account: string): Promise<{ roleId: string; status: number; suspension: number; suspensionName: string; acceptedCharter: string; acceptedVersion: number }> {
    const m = await this.contract().getMember(swarmId, account);
    const suspension = Number(m.suspension);
    return { roleId: m.roleId, status: Number(m.status), suspension, suspensionName: SuspensionCauseName[suspension] ?? String(suspension), acceptedCharter: m.acceptedCharter, acceptedVersion: Number(m.acceptedVersion) };
  }

  async rosterMet(swarmId: string): Promise<boolean> {
    return this.contract().rosterMet(swarmId);
  }

  async roleCount(swarmId: string, role: string): Promise<{ active: number; suspended: number }> {
    const r = await this.contract().roleCount(swarmId, role);
    return { active: Number(r[0]), suspended: Number(r[1]) };
  }

  async isAuthorized(swarmId: string, dp: number, account: string): Promise<boolean> {
    return this.contract().isAuthorized(swarmId, dp, account);
  }

  async seatEpoch(swarmId: string, account: string): Promise<bigint> {
    return BigInt(await this.contract().seatEpochOf(swarmId, account));
  }

  async hardDeadline(swarmId: string): Promise<bigint> {
    return BigInt(await this.contract().hardDeadlineOf(swarmId));
  }
}

/** The swarm account the SwarmRegistry reference ships: `execute` by whoever holds REPRESENT. */
export class SwarmAccountRef {
  readonly iface: Interface;
  constructor(
    readonly world: World,
    readonly address: string,
  ) {
    this.iface = world.ifaceOf("swarm-ai-framework:SwarmAccount");
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.at("swarm-ai-framework:SwarmAccount", this.address, runner);
  }

  encodeExecute(target: string, value: bigint, data: string): string {
    return this.iface.encodeFunctionData("execute", [target, value, data]);
  }

  get executeSelector(): string {
    return this.iface.getFunction("execute")!.selector;
  }
}

export class SwarmTenderAdapterRef {
  constructor(
    readonly world: World,
    readonly address: string,
  ) {}

  contract(runner?: ContractRunner): Contract {
    return this.world.contract("8447/SwarmTenderAdapter", runner);
  }

  encodeSettle(swarmId: string, submissionId: bigint): string {
    return this.contract().interface.encodeFunctionData("settle", [swarmId, submissionId]);
  }
}

export class SwarmDecisionAdapterRef {
  readonly iface: Interface;
  constructor(
    readonly world: World,
    readonly address: string,
  ) {
    this.iface = world.ifaceOf("swarm-ai-framework:SwarmDecisionAdapter");
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.at("swarm-ai-framework:SwarmDecisionAdapter", this.address, runner);
  }

  encodeOpen(swarmId: string, dp: number, call: string, roster: string[]): string {
    return this.iface.encodeFunctionData("open", [swarmId, dp, call, roster]);
  }

  encodeExecute(issueId: string): string {
    return this.iface.encodeFunctionData("execute", [issueId]);
  }

  issueIdFromReceipt(receipt: any): string {
    return eventArgs(this.iface, receipt, "ProposalOpened", this.address).issueId;
  }

  async proposal(issueId: string): Promise<{ exists: boolean; enacted: boolean; swarmId: string; charterVersion: number; phase: number }> {
    const p = await this.contract().proposalOf(issueId);
    return { exists: Boolean(p.exists), enacted: Boolean(p.enacted), swarmId: p.swarmId, charterVersion: Number(p.charterVersion), phase: Number(p.phase) };
  }
}

import { Interface, keccak256, toUtf8Bytes, type Contract, type ContractRunner } from "ethers";
import { keccakJcs } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/** ERC-8436 Agent Collective Decision Framework: how cells decide together. */
export const BodyKind = { ROSTER_KOFN: 0, AUTHORIZED_SUBMITTER: 1 } as const;
export const Acceptance = { ON_CHAIN_TALLY: 0, SIGNED_BALLOTS: 1, AUTHORIZED_SUBMITTER: 2 } as const;
export const Combinator = { BODY: 0, ALL: 1, ANY: 2, KOFM: 3, VETO: 4 } as const;
export const VetoSilence = { PASS_THROUGH: 0, REQUIRE_CLEARANCE: 1 } as const;
export const AppealStanding = { ANYONE: 0, CONSUMER_OR_FILER: 1 } as const;
export const AppealMode = { PRESERVE_UNLESS_OVERTURNED: 0, REQUIRE_FRESH_DECISION: 1 } as const;
export const ProcedureStateName = ["None", "Filed", "Deciding", "Provisional", "Final", "Withdrawn"] as const;
export const OutcomeTypeName = ["None", "Decided", "NoDecision"] as const;
export const ReasonName = ["NONE", "QUORUM_NOT_MET", "SUBMITTER_SILENT", "VETOED", "NO_CLEARANCE", "NOT_REACHED", "TOTAL_TIMEOUT", "NO_ACCEPTANCE"] as const;
export const EnactmentStatusName = ["NotEnacted", "Enacted", "Failed"] as const;

export interface BodySpec {
  kind: number;
  acceptance: number;
  members: string[];
  k: number;
  window: number;
}

export interface Node {
  op: number;
  body: number;
  k: number;
  target: number;
  vetoBody: number;
  silence: number;
  children: number[];
}

export interface PolicySpec {
  family: string;
  version: number;
  previous: string;
  updateAuthority: string;
  bodies: BodySpec[];
  nodes: Node[];
  maxAppeals: number;
  appealWindow: number;
  appealable: number;
  appealStanding: number;
  appealMode: number;
  maxTotalDuration: number;
  ackWindow: number;
  allowAdvisory: boolean;
  descriptorHash: string;
}

export interface Result {
  state: number;
  stateName: string;
  outcomeType: number;
  outcomeName: string;
  outcomeYes: boolean;
  reason: number;
  reasonName: string;
  roundCount: number;
  sourceRound: number;
  adoptedFromEarlierRound: boolean;
  decidedAt: bigint;
  finalAt: bigint;
}

const ZERO32 = "0x" + "00".repeat(32);

export function familyId(name: string): string {
  return keccak256(toUtf8Bytes(name));
}

/**
 * The FOGA-Council policy: one roster body of judges deciding K-of-N by on-chain tally within `window`, one
 * appeal allowed for a Decided result (an appeal round that ends without a decision preserves the first one),
 * no appeal of a NoDecision, hard cap covering every round and the appeal window.
 */
export function councilPolicySpec(p: { judges: string[]; k: number; window: number; appealWindow: number; updateAuthority: string; version?: number; previous?: string; descriptor: Record<string, unknown> }): PolicySpec {
  const maxAppeals = 1;
  return {
    family: familyId("foga.council"),
    version: p.version ?? 1,
    previous: p.previous ?? ZERO32,
    updateAuthority: p.updateAuthority,
    bodies: [{ kind: BodyKind.ROSTER_KOFN, acceptance: Acceptance.ON_CHAIN_TALLY, members: p.judges, k: p.k, window: p.window }],
    nodes: [{ op: Combinator.BODY, body: 0, k: 0, target: 0, vetoBody: 0, silence: VetoSilence.PASS_THROUGH, children: [] }],
    maxAppeals,
    appealWindow: p.appealWindow,
    appealable: 1, // bit0: Decided results may be appealed; a NoDecision is final at once
    appealStanding: AppealStanding.ANYONE,
    appealMode: AppealMode.PRESERVE_UNLESS_OVERTURNED,
    maxTotalDuration: p.window * (maxAppeals + 1) + p.appealWindow * maxAppeals,
    ackWindow: 0,
    allowAdvisory: false,
    descriptorHash: keccakJcs(p.descriptor),
  };
}

/** The off-chain descriptor the policy's descriptorHash commits to. */
export function councilDescriptor(p: { judges: string[]; k: number; window: number; appealWindow: number }): Record<string, unknown> {
  return {
    acdf: "1.0",
    kind: "policy-descriptor",
    name: "FOGA-Council",
    summary: "The judging body of the Finch OG Agent genesis: three judges, two approvals decide, one appeal of a decision, silence is no decision.",
    bodies: [{ role: "judge", members: p.judges.map((j) => j.toLowerCase()), k: p.k, acceptance: "on-chain-tally", window: p.window }],
    appeals: { max: 1, window: p.appealWindow, appealable: ["Decided"], mode: "preserve-unless-overturned" },
    consumers: ["ACDFTaskTenderAdapter (ERC-8414 acceptance)", "ADRFACDFBridge (ERC-8471 judgment tier, phase 2b)"],
    independence: "A judge is never a party: not a demander, fulfiller, swarm member or world operator of the matter judged; checked by the genesis before each case.",
  };
}

export class ACDF {
  constructor(readonly world: World) {}

  policies(runner?: ContractRunner): Contract {
    return this.world.contract("8436/ACDFPolicyRegistry", runner);
  }

  registry(runner?: ContractRunner): Contract {
    return this.world.contract("8436/ACDFRegistry", runner);
  }

  get policyRegistryAddress(): string {
    return this.world.address("8436/ACDFPolicyRegistry");
  }

  get registryAddress(): string {
    return this.world.address("8436/ACDFRegistry");
  }

  encodeRegisterPolicy(spec: PolicySpec): string {
    return this.policies().interface.encodeFunctionData("registerPolicy", [spec]);
  }

  async policyIdOf(spec: PolicySpec): Promise<string> {
    return this.policies().policyIdOf(spec);
  }

  policyIdFromReceipt(receipt: any): string {
    return eventArgs(this.policies().interface, receipt, "PolicyRegistered", this.policyRegistryAddress).policyId;
  }

  encodeCastBallot(issueId: string, round: number, body: number, approve: boolean): string {
    return this.registry().interface.encodeFunctionData("castBallot", [issueId, round, body, approve]);
  }

  encodeSettleRound(issueId: string): string {
    return this.registry().interface.encodeFunctionData("settleRound", [issueId]);
  }

  encodeFinalize(issueId: string): string {
    return this.registry().interface.encodeFunctionData("finalize", [issueId]);
  }

  async getResult(issueId: string): Promise<Result> {
    const r = await this.registry().getResult(issueId);
    const state = Number(r.state);
    const outcomeType = Number(r.outcomeType);
    const reason = Number(r.reason);
    return {
      state,
      stateName: ProcedureStateName[state] ?? String(state),
      outcomeType,
      outcomeName: OutcomeTypeName[outcomeType] ?? String(outcomeType),
      outcomeYes: Boolean(r.outcomeYes),
      reason,
      reasonName: ReasonName[reason] ?? String(reason),
      roundCount: Number(r.roundCount),
      sourceRound: Number(r.sourceRound),
      adoptedFromEarlierRound: Boolean(r.adoptedFromEarlierRound),
      decidedAt: BigInt(r.decidedAt),
      finalAt: BigInt(r.finalAt),
    };
  }

  async roundOf(issueId: string): Promise<number> {
    return Number((await this.registry().getIssue(issueId)).roundCount);
  }

  async roundState(issueId: string, round: number): Promise<{ startedAt: bigint; deadline: bigint; settled: boolean; appealOpenUntil: bigint }> {
    const r = await this.registry().getRound(issueId, round);
    return { startedAt: BigInt(r.startedAt), deadline: BigInt(r.deadline), settled: Boolean(r.settled), appealOpenUntil: BigInt(r.appealOpenUntil) };
  }

  async hasVoted(issueId: string, round: number, body: number, voter: string): Promise<boolean> {
    return this.registry().hasVoted(issueId, round, body, voter);
  }

  async enactment(issueId: string, consumer: string, effectId: string): Promise<{ status: number; statusName: string; reporter: string; ref: string }> {
    const e = await this.registry().getEnactment(issueId, consumer, effectId);
    const status = Number(e.status);
    return { status, statusName: EnactmentStatusName[status] ?? String(status), reporter: e.reporter, ref: e.ref };
  }

  /** Decode the first IssueFiled event of a receipt (filed by an adapter). */
  issueIdFromReceipt(receipt: any): string {
    return eventArgs(this.registry().interface, receipt, "IssueFiled", this.registryAddress).issueId;
  }
}

/** An ACDFTaskTenderAdapter instance (the upstream adapter, deployed by FOGA for its policy). */
export class TenderAdapterRef {
  readonly iface: Interface;
  constructor(
    readonly world: World,
    readonly address: string,
  ) {
    this.iface = world.ifaceOf("acd-framework:ACDFTaskTenderAdapter");
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.at("acd-framework:ACDFTaskTenderAdapter", this.address, runner);
  }

  encodeOpen(tokenId: bigint, submissionId: bigint): string {
    return this.iface.encodeFunctionData("open", [tokenId, submissionId]);
  }

  encodeExecute(issueId: string): string {
    return this.iface.encodeFunctionData("execute", [issueId]);
  }

  issueIdFromReceipt(receipt: any): string {
    return eventArgs(this.iface, receipt, "CaseOpened", this.address).issueId;
  }

  async caseOf(issueId: string): Promise<{ exists: boolean; enacted: boolean; tokenId: bigint; submissionId: bigint; consumerDeadline: bigint }> {
    const c = await this.contract().caseOf(issueId);
    return { exists: Boolean(c.exists), enacted: Boolean(c.enacted), tokenId: BigInt(c.tokenId), submissionId: BigInt(c.submissionId), consumerDeadline: BigInt(c.consumerDeadline) };
  }

  async effects(): Promise<{ accept: string; reject: string }> {
    const c = this.contract();
    return { accept: await c.EFFECT_ACCEPT(), reject: await c.EFFECT_REJECT() };
  }
}

import { Interface, keccak256, toUtf8Bytes, type Contract, type ContractRunner } from "ethers";
import { abi, keccakJcs } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/**
 * ERC-8471 AI Dispute Resolution Framework: disputes about deliveries and declarations, decided by methods a
 * policy binds (a deterministic verifier, an evidence rule, or an ERC-8436 collective decision through the
 * bridge), with rulings enacted by the bound business contract within its own authority.
 */
export const QuestionType = { FORMAL: 0, EVIDENCED: 1, JUDGED: 2 } as const;
export const Value = { UNDETERMINED: 0, TRUE: 1, FALSE: 2 } as const;
export const ValueName = ["UNDETERMINED", "TRUE", "FALSE"] as const;
export const AcceptanceMode = { PRE_COMMIT: 0, POST_DISPUTE: 1 } as const;
export const EffectClass = { Advisory: 0, Binding: 1 } as const;
export const EffectCategory = { SUBSTANTIVE: 0, PROCEDURAL_ECONOMIC: 1 } as const;
export const OnUndetermined = { NOT_SUSTAINED: 0, NO_DECISION: 1 } as const;
export const StandingMode = { PARTIES: 0, BENEFICIARIES: 1, OPEN: 2 } as const;
export const SilenceRule = { NONE: 0, SUSTAIN: 1, NOT_SUSTAIN: 2 } as const;
export const ReviewMode = { PRESERVE_UNLESS_OVERTURNED: 0, REQUIRE_FRESH_DECISION: 1 } as const;
export const ProcedureStateName = ["None", "Filed", "Admitted", "Provisional", "Final", "NotAdmitted", "Withdrawn", "Expired"] as const;
export const SubstantiveResultName = ["None", "Sustained", "NotSustained", "NoDecision"] as const;
export const ReasonName = ["NONE", "MISSING_ELEMENT", "NO_BINDING_AUTHORITY", "CLOCK_INCOMPATIBLE", "DUPLICATE", "PREMISE_NOT_ESTABLISHED", "METHOD_UNDETERMINED", "BURDEN_NOT_MET", "TIMEOUT", "REVIEW_LAPSED", "ACCEPTANCE_LAPSED", "SILENCE", "PROCEDURE_FAILURE"] as const;
export const EnactmentStatusName = ["NotRequested", "Pending", "Enacted", "Failed", "Unknown"] as const;
export const SettlementStateName = ["Held", "Released", "Refunded"] as const;

export const REVIEW_FACT = 1;
export const REVIEW_EVIDENCE = 2;
export const REVIEW_RULE_APPLICATION = 4;
export const RESULT_PROFILE_V1 = keccak256(toUtf8Bytes("adrf:result/v1"));

/** Obligation kinds as the worked-example escrow declares them. */
export const KIND_RESULT = 1;
export const KIND_LIMIT = 3;

/** Identifiers of the worked-example escrow (ADRFServiceEscrow). */
export const EFFECT_REFUND = keccak256(toUtf8Bytes("adrf:effect/refund"));
export const DISPOSITION_STATUS_QUO = keccak256(toUtf8Bytes("adrf:disposition/status-quo"));
export const EVENT_DELIVERY = keccak256(toUtf8Bytes("delivery"));
export const STATEMENT_ACTUAL_VERSION = keccak256(toUtf8Bytes("the version actually used for the call matches the committed version"));
const DECLARED_VERSION_STATEMENT = keccak256(toUtf8Bytes("adrf:prop/declared-version-differs/v1"));

const ZERO32 = "0x" + "00".repeat(32);

export interface MethodBinding {
  obligationKind: number;
  qType: number;
  method: string;
  params: string;
  onUndetermined: number;
}

export interface Effect {
  id: string;
  category: number;
}

export interface Track {
  filingWindow: number;
  acceptanceWindow: number;
  evidenceWindow: number;
  decisionWindow: number;
  reviewWindow: number;
  maxReviews: number;
  reviewTypes: number;
  reviewMode: number;
  maxTotalDuration: number;
  enactmentMargin: number;
  optimistic: boolean;
  answerWindow: number;
  silenceRule: number;
}

export interface PolicySpec {
  family: string;
  version: number;
  previous: string;
  updateAuthority: string;
  objectKind: string;
  methods: MethodBinding[];
  effects: Effect[];
  track: Track;
  standing: number;
  resultProfile: string;
  economicDeclaration: string;
  descriptorHash: string;
}

export interface BindingInput {
  policyId: string;
  scopeKey: string;
  mode: number;
  authorizedEffects: string[];
  executors: string[];
  beneficiaries: string[];
  openChallenge: boolean;
  downgradeOnClock: boolean;
  validUntil: number;
  termsHash: string;
}

export interface ObjectRef {
  chainId: bigint;
  target: string;
  id: bigint;
  versionHash: string;
}

export interface SubQuestionInput {
  proposition: string;
  qType: number;
  obligationKind: number;
  inputsHash: string;
  dependsOn: number[];
  requiredValues: number[];
}

export interface ClaimInput {
  object: ObjectRef;
  eventRef: string;
  proposition: string;
  normRef: string;
  clause: string;
  obligationKind: number;
  respondent: string;
  actorRef: string;
  requestedEffects: string[];
  effectOnSustained: string;
  effectOnNotSustained: string;
  fallbackRef: string;
  evidenceScopeHash: string;
  documentHash: string;
  decisive: number;
  supportsWhen: number;
  subQuestions: SubQuestionInput[];
}

/** The windows of FOGA's service-call dispute policy, derived from the council's timing. */
export interface ServiceTiming {
  filingWindow: number;
  evidenceWindow: number;
  decisionWindow: number;
  reviewWindow: number;
  enactmentMargin: number;
  /** How long the escrow holds a settlement: must cover the whole procedure plus the margin. */
  disputePeriod: number;
}

export function familyId(name: string): string {
  return keccak256(toUtf8Bytes(name));
}

/**
 * FOGA-Service-v1: the dispute policy for service calls between cells. A (result, FORMAL) question goes to the
 * upstream DeclaredVersionVerifier over the escrow; a (result, JUDGED) question goes to FOGA-Council through
 * the ADRF/ACDF bridge, with NO_DECISION as the burden rule (an undecided council leaves the status quo). One
 * substantive effect: the escrow's refund. Standing: the parties of the call. One review round.
 */
export function servicePolicySpec(p: { escrow: string; versionVerifier: string; bridge: string; councilPolicyId: string; updateAuthority: string; timing: ServiceTiming; descriptor: Record<string, unknown>; version?: number; previous?: string }): PolicySpec {
  const t = p.timing;
  const maxReviews = 1;
  return {
    family: familyId("foga.service"),
    version: p.version ?? 1,
    previous: p.previous ?? ZERO32,
    updateAuthority: p.updateAuthority,
    objectKind: keccak256(toUtf8Bytes("service-call")),
    methods: [
      { obligationKind: KIND_RESULT, qType: QuestionType.FORMAL, method: p.versionVerifier, params: addressParam(p.escrow), onUndetermined: OnUndetermined.NOT_SUSTAINED },
      { obligationKind: KIND_RESULT, qType: QuestionType.JUDGED, method: p.bridge, params: p.councilPolicyId, onUndetermined: OnUndetermined.NO_DECISION },
    ],
    effects: [{ id: EFFECT_REFUND, category: EffectCategory.SUBSTANTIVE }],
    track: {
      filingWindow: t.filingWindow,
      acceptanceWindow: 0,
      evidenceWindow: t.evidenceWindow,
      decisionWindow: t.decisionWindow,
      reviewWindow: t.reviewWindow,
      maxReviews,
      reviewTypes: REVIEW_FACT | REVIEW_EVIDENCE | REVIEW_RULE_APPLICATION,
      reviewMode: ReviewMode.PRESERVE_UNLESS_OVERTURNED,
      maxTotalDuration: t.decisionWindow + maxReviews * (t.reviewWindow + t.decisionWindow),
      enactmentMargin: t.enactmentMargin,
      optimistic: false,
      answerWindow: 0,
      silenceRule: SilenceRule.NONE,
    },
    standing: StandingMode.PARTIES,
    resultProfile: RESULT_PROFILE_V1,
    economicDeclaration: keccakJcs({ kind: "economic-declaration", name: "FOGA-Service-v1", bonds: "none", fees: "none", rewards: "none" }),
    descriptorHash: keccakJcs(p.descriptor),
  };
}

/** The off-chain descriptor the policy's descriptorHash commits to. */
export function serviceDescriptor(p: { escrow: string; versionVerifier: string; bridge: string; councilPolicyId: string; timing: ServiceTiming }): Record<string, unknown> {
  return {
    adrf: "0.2",
    kind: "policy-descriptor",
    name: "FOGA-Service-v1",
    summary: "Disputes about service calls between Finch OG Agent cells settled through the worked-example escrow: a formal question on the declared version, a judged question on the version actually used, decided by FOGA-Council; one effect, the refund of the held settlement.",
    object: { kind: "service-call", escrow: p.escrow.toLowerCase() },
    methods: [
      { obligation: "result", question: "FORMAL", method: p.versionVerifier.toLowerCase(), params: "the escrow", burden: "NOT_SUSTAINED" },
      { obligation: "result", question: "JUDGED", method: p.bridge.toLowerCase(), params: p.councilPolicyId, burden: "NO_DECISION" },
    ],
    effects: [{ id: "adrf:effect/refund", category: "substantive", executor: "the escrow, within the settlement it holds" }],
    windows: { ...p.timing },
    standing: "parties",
    reviews: { max: 1, mode: "preserve-unless-overturned", types: ["fact", "evidence", "rule-application"] },
    noDecision: "status quo: balances stay where the call left them",
  };
}

export function addressParam(a: string): string {
  return "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** The declared-version verifier's canonical proposition for a call of a service. */
export function declaredVersionProposition(service: string, callId: bigint): string {
  return keccak256(abi.encode(["bytes32", "address", "uint256"], [DECLARED_VERSION_STATEMENT, service, callId]));
}

export function declaredVersionInputs(callId: bigint): string {
  return abi.encode(["uint256"], [callId]);
}

export function declaredVersionInputsHash(callId: bigint): string {
  return keccak256(declaredVersionInputs(callId));
}

export class ADRF {
  constructor(readonly world: World) {}

  policies(runner?: ContractRunner): Contract {
    return this.world.contract("8471/ADRFPolicyRegistry", runner);
  }

  /** The dispute registry through its full interface: the deployed contract is a router whose own ABI only names its modules. */
  registry(runner?: ContractRunner): Contract {
    return this.world.at("ai-dispute-resolution:IADRFDisputeRegistry", this.registryAddress, runner);
  }

  bridge(runner?: ContractRunner): Contract {
    return this.world.contract("8471/ADRFACDFBridge", runner);
  }

  escrow(runner?: ContractRunner): Contract {
    return this.world.contract("8471/ADRFServiceEscrow", runner);
  }

  get policyRegistryAddress(): string {
    return this.world.address("8471/ADRFPolicyRegistry");
  }

  get registryAddress(): string {
    return this.world.address("8471/ADRFDisputeRegistry");
  }

  get bridgeAddress(): string {
    return this.world.address("8471/ADRFACDFBridge");
  }

  get escrowAddress(): string {
    return this.world.address("8471/ADRFServiceEscrow");
  }

  get versionVerifierAddress(): string {
    return this.world.address("8471/DeclaredVersionVerifier");
  }

  policyIdFromReceipt(receipt: any): string {
    return eventArgs(this.policies().interface, receipt, "PolicyRegistered", this.policyRegistryAddress).policyId;
  }

  bindingIdFromReceipt(receipt: any): string {
    return eventArgs(this.registry().interface, receipt, "BindingRegistered", this.registryAddress).bindingId;
  }

  caseIdFromReceipt(receipt: any): string {
    return eventArgs(this.registry().interface, receipt, "CaseFiled", this.registryAddress).caseId;
  }

  callIdFromReceipt(receipt: any): bigint {
    return BigInt(eventArgs(this.escrow().interface, receipt, "CallOpened", this.escrowAddress).callId);
  }

  // ---- escrow (business) ----

  encodeDeposit(): string {
    return this.escrow().interface.encodeFunctionData("deposit", []);
  }

  encodeOpenCall(provider: string, amount: bigint, termsHash: string, committedVersion: string, disputePeriod: number): string {
    return this.escrow().interface.encodeFunctionData("openCall", [provider, amount, termsHash, committedVersion, disputePeriod]);
  }

  encodeDeliver(callId: bigint, declaredVersion: string): string {
    return this.escrow().interface.encodeFunctionData("deliver", [callId, declaredVersion]);
  }

  encodeSettle(callId: bigint): string {
    return this.escrow().interface.encodeFunctionData("settle", [callId]);
  }

  encodeRelease(callId: bigint): string {
    return this.escrow().interface.encodeFunctionData("release", [callId]);
  }

  encodeWithdrawBalance(amount: bigint): string {
    return this.escrow().interface.encodeFunctionData("withdrawBalance", [amount]);
  }

  encodeEnact(caseId: string, effectId: string): string {
    return this.escrow().interface.encodeFunctionData("enact", [caseId, effectId]);
  }

  async objectOf(callId: bigint): Promise<ObjectRef> {
    const o = await this.escrow().objectOf(callId);
    return { chainId: BigInt(o.chainId), target: o.target, id: BigInt(o.id), versionHash: o.versionHash };
  }

  async call(callId: bigint): Promise<{ client: string; provider: string; amount: bigint; termsHash: string; committedVersion: string; declaredVersion: string; createdAt: number; deliveredAt: number; disputePeriod: number }> {
    const c = await this.escrow().calls(callId);
    return { client: c.client, provider: c.provider, amount: BigInt(c.amount), termsHash: c.termsHash, committedVersion: c.committedVersion, declaredVersion: c.declaredVersion, createdAt: Number(c.createdAt), deliveredAt: Number(c.deliveredAt), disputePeriod: Number(c.disputePeriod) };
  }

  async settlementOf(callId: bigint, ordinal: number): Promise<{ at: number; state: number; stateName: string }> {
    const s = await this.escrow().settlementOf(callId, ordinal);
    // positional: the output is named `at`, which on an ethers Result is shadowed by Array.prototype.at
    const state = Number(s[1]);
    return { at: Number(s[0]), state, stateName: SettlementStateName[state] ?? String(state) };
  }

  async escrowBalanceOf(account: string): Promise<bigint> {
    return BigInt(await this.escrow().balanceOf(account));
  }

  async heldOf(callId: bigint): Promise<bigint> {
    return BigInt(await this.escrow().heldOf(callId));
  }

  // ---- registry (procedure) ----

  encodeFile(bindingId: string, claim: ClaimInput): string {
    return this.registry().interface.encodeFunctionData("file", [bindingId, claim]);
  }

  async getCase(caseId: string): Promise<{ state: number; stateName: string; effectClass: number; claimant: string; respondent: string; source: string; bindingId: string; exclusivityKey: string; decisive: number }> {
    const c = await this.registry().getCase(caseId);
    const state = Number(c.state);
    return { state, stateName: ProcedureStateName[state] ?? String(state), effectClass: Number(c.effectClass), claimant: c.claimant, respondent: c.respondent, source: c.source, bindingId: c.bindingId, exclusivityKey: c.exclusivityKey, decisive: Number(c.decisive) };
  }

  async getClock(caseId: string): Promise<{ eventAt: number; filedAt: number; admittedAt: number; decisionDeadline: number; hardDeadline: number; reviewOpenUntil: number; roundCount: number }> {
    const c = await this.registry().getClock(caseId);
    return { eventAt: Number(c.eventAt), filedAt: Number(c.filedAt), admittedAt: Number(c.admittedAt), decisionDeadline: Number(c.decisionDeadline), hardDeadline: Number(c.hardDeadline), reviewOpenUntil: Number(c.reviewOpenUntil), roundCount: Number(c.roundCount) };
  }

  async getFinding(caseId: string, subQuestion: number): Promise<{ resolved: boolean; value: number; valueName: string; supportKinds: number; acceptedBy: string; reason: number; reasonName: string; issueId: string }> {
    const f = await this.registry().getFinding(caseId, subQuestion);
    const value = Number(f.value);
    const reason = Number(f.reason);
    return { resolved: Boolean(f.resolved), value, valueName: ValueName[value] ?? String(value), supportKinds: Number(f.supportKinds), acceptedBy: f.acceptedBy, reason, reasonName: ReasonName[reason] ?? String(reason), issueId: f.source.issueId };
  }

  async getRuling(caseId: string): Promise<{ state: number; stateName: string; result: number; resultName: string; reason: number; reasonName: string; closure: number; closureName: string; allowedEffect: string; fallbackRef: string; supportKinds: number; judgmentIssueId: string }> {
    const u = await this.registry().getRuling(caseId);
    const state = Number(u.state);
    const result = Number(u.result);
    const reason = Number(u.reason);
    const closure = Number(u.closure);
    return { state, stateName: ProcedureStateName[state] ?? String(state), result, resultName: SubstantiveResultName[result] ?? String(result), reason, reasonName: ReasonName[reason] ?? String(reason), closure, closureName: ReasonName[closure] ?? String(closure), allowedEffect: u.allowedEffect, fallbackRef: u.fallbackRef, supportKinds: Number(u.supportKinds), judgmentIssueId: u.judgment.issueId };
  }

  async getEnactment(caseId: string, effectId: string): Promise<{ status: number; statusName: string; reporter: string; ref: string }> {
    const e = await this.registry().getEnactment(caseId, effectId);
    const status = Number(e.status);
    return { status, statusName: EnactmentStatusName[status] ?? String(status), reporter: e.reporter, ref: e.ref };
  }

  async issueOf(caseId: string, subQuestion: number): Promise<string> {
    return this.bridge().issueOf(keccak256(abi.encode(["bytes32", "uint32"], [caseId, subQuestion])));
  }
}

/** Builders for the dispute of T6 (the delivered version is not the committed one). */
export const claims = {
  /**
   * The claim of a client against a provider on the delivery of a call: "the service did not run the committed
   * version". Sub-question 0 (FORMAL, informative): the declared version differs from the committed one, decided by
   * the verifier over the escrow's own records. Sub-question 1 (JUDGED, decisive): "the version actually used
   * matches the committed version", put to FOGA-Council; the claim is sustained when the council finds it FALSE.
   */
  versionCommitment(p: { object: ObjectRef; escrow: string; callId: bigint; termsHash: string; provider: string; documentHash: string; evidenceScopeHash: string }): ClaimInput {
    return {
      object: p.object,
      eventRef: EVENT_DELIVERY,
      proposition: keccak256(toUtf8Bytes("claim: the service did not run the committed version")),
      normRef: p.termsHash,
      clause: keccak256(toUtf8Bytes("terms: the service runs the committed version")),
      obligationKind: KIND_RESULT,
      respondent: p.provider,
      actorRef: ZERO32,
      requestedEffects: [EFFECT_REFUND],
      effectOnSustained: EFFECT_REFUND,
      effectOnNotSustained: ZERO32,
      fallbackRef: DISPOSITION_STATUS_QUO,
      evidenceScopeHash: p.evidenceScopeHash,
      documentHash: p.documentHash,
      decisive: 1,
      supportsWhen: Value.FALSE,
      subQuestions: [
        { proposition: declaredVersionProposition(p.escrow, p.callId), qType: QuestionType.FORMAL, obligationKind: KIND_RESULT, inputsHash: declaredVersionInputsHash(p.callId), dependsOn: [], requiredValues: [] },
        { proposition: STATEMENT_ACTUAL_VERSION, qType: QuestionType.JUDGED, obligationKind: KIND_RESULT, inputsHash: ZERO32, dependsOn: [], requiredValues: [] },
      ],
    };
  },
};

/** The escrow's binding to FOGA-Service-v1: all its calls, pre-committed, the refund authorized, the escrow as executor. */
export function escrowBindingInput(policyId: string, termsHash: string): BindingInput {
  return { policyId, scopeKey: ZERO32, mode: AcceptanceMode.PRE_COMMIT, authorizedEffects: [EFFECT_REFUND], executors: [], beneficiaries: [], openChallenge: false, downgradeOnClock: false, validUntil: 0, termsHash };
}

export type { Interface };

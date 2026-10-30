import { keccak256, type Contract, type ContractRunner } from "ethers";
import { abi, accountRef, dataUriJcs, jcs, keccakUtf8 } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/** ERC-8468 Agent Safety Framework: specifications a cell adopts and interventions it must honor. */
export const Enforcement = { self: 1, account: 2, runtime: 4, custodian: 8, contract: 16, collective: 32 } as const;
export const Rights = { suspend: 1, resume: 2, terminate: 4 } as const;
export const Restriction = { noNewRisk: 1, shrink: 2, essentialOnly: 4, deriskOnly: 8, fullStop: 16 } as const;
export const Combinator = { All: 0, Any: 1, KOf: 2 } as const;
export const Verdict = { Unknown: 0, Satisfied: 1, NotSatisfied: 2 } as const;
export const VerdictName = ["Unknown", "Satisfied", "NotSatisfied"] as const;
export const ReasonName = ["None", "NoBinding", "Terminated", "Suspended", "NotYetValid", "Expired", "SpecMismatch", "VersionMismatch", "AdopterMismatch", "SubjectMismatch", "ScopeMismatch", "EnforcementMismatch", "ParentNotSatisfied", "SpecRegistryUnavailable", "IntervenerMismatch", "StoppedByIntervener"] as const;
export const BindingStateName = ["None", "Active", "Suspended", "Terminated"] as const;

export interface Intervener {
  account: string;
  rights: number;
}

export interface Clause {
  specRegistry: string;
  specId: string;
  versions: number[];
  adopter: string;
  subjectKey: string;
  scopeKey: string;
  enforcement: number;
  interveners: Intervener[];
}

export interface RequirementSet {
  combinator: number;
  k: number;
  clauses: Clause[];
}

export interface BindingInput {
  subjectKey: string;
  scopeKey: string;
  specRegistry: string;
  specId: string;
  version: number;
  contentHash: string;
  paramsHash: string;
  paramsLocator: string;
  authorityRef: string;
  enforcement: number;
  validFrom: number;
  validUntil: number;
  parentBindingId: string;
  salt: string;
  interveners: Intervener[];
}

const ZERO32 = "0x" + "00".repeat(32);

export function subjectKeyOf(ref: string): string {
  return keccakUtf8(ref);
}

export function accountSubjectKey(chainId: number | bigint, account: string): string {
  return keccakUtf8(accountRef(chainId, account));
}

export function scopeKeyOf(scope: Record<string, unknown>): string {
  return keccakUtf8(jcs(scope));
}

export function specIdOf(chainId: number | bigint, registry: string, publisher: string, salt: string): string {
  return keccak256(abi.encode(["uint256", "address", "address", "bytes32"], [chainId, registry, publisher, salt]));
}

export const REQUIREMENT_TUPLE = "tuple(uint8 combinator,uint16 k,tuple(address specRegistry,bytes32 specId,uint32[] versions,address adopter,bytes32 subjectKey,bytes32 scopeKey,uint16 enforcement,tuple(address account,uint8 rights)[] interveners)[] clauses)";

export function requirementIdOf(req: RequirementSet): string {
  return keccak256(abi.encode([REQUIREMENT_TUPLE], [req]));
}

export function oneClause(p: { specRegistry: string; specId: string; versions?: number[]; adopter?: string; subjectKey?: string; scopeKey?: string; enforcement?: number; interveners?: Intervener[] }): RequirementSet {
  return {
    combinator: Combinator.All,
    k: 0,
    clauses: [
      {
        specRegistry: p.specRegistry,
        specId: p.specId,
        versions: p.versions ?? [1],
        adopter: p.adopter ?? "0x0000000000000000000000000000000000000000",
        subjectKey: p.subjectKey ?? ZERO32,
        scopeKey: p.scopeKey ?? ZERO32,
        enforcement: p.enforcement ?? Enforcement.account,
        interveners: p.interveners ?? [],
      },
    ],
  };
}

export class ASF {
  constructor(readonly world: World) {}

  specs(runner?: ContractRunner): Contract {
    return this.world.contract("8468/ASFSpecificationRegistry", runner);
  }

  bindings(runner?: ContractRunner): Contract {
    return this.world.contract("8468/ASFBindingRegistry", runner);
  }

  get specRegistryAddress(): string {
    return this.world.address("8468/ASFSpecificationRegistry");
  }

  get bindingRegistryAddress(): string {
    return this.world.address("8468/ASFBindingRegistry");
  }

  /** The commitment of a specification document: contentHash = keccak256(JCS(document)); locator = data: URI. */
  specificationCommitment(document: Record<string, unknown>): { contentHash: string; locator: string } {
    return { contentHash: keccakUtf8(jcs(document)), locator: dataUriJcs(document) };
  }

  encodeRegisterSpecification(salt: string, document: Record<string, unknown>, requiredProfiles: string[] = []): string {
    const c = this.specificationCommitment(document);
    return this.specs().interface.encodeFunctionData("registerSpecification", [salt, c.contentHash, c.locator, requiredProfiles]);
  }

  specIdFromReceipt(receipt: any): string {
    return eventArgs(this.specs().interface, receipt, "SpecificationRegistered", this.specRegistryAddress).specId;
  }

  encodeSuspend(bindingId: string, restrictions: number, responseRef: string, reasonRef: string): string {
    return this.bindings().interface.encodeFunctionData("suspend", [bindingId, restrictions, responseRef, reasonRef]);
  }

  encodeResume(bindingId: string, reasonRef: string): string {
    return this.bindings().interface.encodeFunctionData("resume", [bindingId, reasonRef]);
  }

  /** Publish a safety specification document (version 1). contentHash = keccak256(JCS(document)); the locator is a data: URI. */
  async registerSpecification(publisher: ContractRunner, salt: string, document: Record<string, unknown>, requiredProfiles: string[] = []): Promise<{ specId: string; contentHash: string; locator: string; receipt: any }> {
    const contentHash = keccakUtf8(jcs(document));
    const locator = dataUriJcs(document);
    const tx = await this.specs(publisher).registerSpecification(salt, contentHash, locator, requiredProfiles);
    const receipt = await tx.wait();
    return { specId: eventArgs(this.specs().interface, receipt, "SpecificationRegistered").specId, contentHash, locator, receipt };
  }

  async versionOf(specId: string, version: number): Promise<{ contentHash: string; locator: string; publishedAt: bigint; deprecated: boolean }> {
    const v = await this.specs().versionOf(specId, version);
    return { contentHash: v.contentHash, locator: v.locator, publishedAt: BigInt(v.publishedAt), deprecated: Boolean(v.deprecated) };
  }

  encodeAdopt(input: BindingInput): string {
    return this.bindings().interface.encodeFunctionData("adopt", [input]);
  }

  async computeBindingId(adopter: string, input: BindingInput): Promise<string> {
    return this.bindings().computeBindingId(adopter, input);
  }

  bindingIdFromReceipt(receipt: any): string {
    return eventArgs(this.bindings().interface, receipt, "BindingCreated", this.bindingRegistryAddress).bindingId;
  }

  async suspend(intervener: ContractRunner, bindingId: string, restrictions: number, responseRef: string, reasonRef: string): Promise<any> {
    const tx = await this.bindings(intervener).suspend(bindingId, restrictions, responseRef, reasonRef);
    return tx.wait();
  }

  async resume(intervener: ContractRunner, bindingId: string, reasonRef: string): Promise<any> {
    const tx = await this.bindings(intervener).resume(bindingId, reasonRef);
    return tx.wait();
  }

  async check(requirement: RequirementSet, bindingIds: string[]): Promise<{ verdict: number; reasons: number[]; restrictions: number[] }> {
    const r = await this.bindings().check(requirement, bindingIds);
    return { verdict: Number(r[0]), reasons: Array.from(r[1], (x: any) => Number(x)), restrictions: Array.from(r[2], (x: any) => Number(x)) };
  }

  async bindingOf(bindingId: string): Promise<{ adopter: string; state: number; restrictions: number; validUntil: bigint }> {
    const b = await this.bindings().bindingOf(bindingId);
    return { adopter: b.adopter, state: Number(b.state), restrictions: Number(b.restrictions), validUntil: BigInt(b.validUntil) };
  }

  /** The binding a cell adopts for the FOGA cell specification. */
  cellBindingInput(p: { chainId: number; cell: string; specId: string; version: number; contentHash: string; guardian: string; params: Record<string, unknown>; authority: Record<string, unknown>; validUntil?: number; salt?: string }): BindingInput {
    return {
      subjectKey: accountSubjectKey(p.chainId, p.cell),
      scopeKey: scopeKeyOf({ ref: accountRef(p.chainId, p.cell) }),
      specRegistry: this.specRegistryAddress,
      specId: p.specId,
      version: p.version,
      contentHash: p.contentHash,
      paramsHash: keccakUtf8(jcs(p.params)),
      paramsLocator: dataUriJcs(p.params),
      authorityRef: keccakUtf8(jcs(p.authority)),
      enforcement: Enforcement.account | Enforcement.contract,
      validFrom: 0,
      validUntil: p.validUntil ?? 0,
      parentBindingId: ZERO32,
      salt: p.salt ?? "0x" + "00".repeat(31) + "01",
      interveners: [{ account: p.guardian, rights: Rights.suspend | Rights.resume }],
    };
  }
}

/** The FOGA cell safety specification, version 1. */
export function fogaCellSpecification(): Record<string, unknown> {
  return {
    asf: "1.0",
    kind: "safety-specification",
    name: "FOGA Cell Safety Specification",
    version: 1,
    summary: "The baseline every FOGA cell adopts: commitment-class actions only while the anchor is ACTIVE, interventions honored at the execution gate, de-risking always open.",
    clauses: [
      { id: "aid-active", text: "A cell MUST NOT make a commitment-class call (submit, join, adopt, assert) while its ERC-8434 anchor is not ACTIVE. Enforced by the cell account's AID-state gate." },
      { id: "honor-stop", text: "A cell MUST stop commitment-class calls while its binding is suspended and MUST NOT continue under a full stop. Enforced by the cell account's execution gate against the Binding Registry." },
      { id: "derisk-open", text: "Withdrawals of earned credit, refunds and leaving a swarm remain allowed under a derisk-only suspension and MUST be listed as de-risk actions by the owner." },
      { id: "attribution", text: "Only calls routed through the cell account are the cell's acts; a direct call by the operator key is the operator's own." },
    ],
    enforcement: ["account", "contract"],
    profiles: [],
  };
}

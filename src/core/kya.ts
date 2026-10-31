import { keccak256, toUtf8Bytes, type Contract, type ContractRunner } from "ethers";
import { abi, dataUri } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/** ERC-8419 Know-Your-Agent: schemes, attested assertions, checks. */
export const SubjectType = {
  erc8004: keccak256(toUtf8Bytes("erc8004")),
  account: keccak256(toUtf8Bytes("account")),
  erc721: keccak256(toUtf8Bytes("erc721")),
  did: keccak256(toUtf8Bytes("did")),
} as const;

export const SchemeMode = { ATTESTED: 0, PROVED: 1 } as const;
export const BindingKind = { IDENTITY: 0, CONTROLLER: 1, INSTANCE: 2 } as const;
export const ResultKind = { ORDERED_LEVEL: 0, CATEGORICAL: 1, OPAQUE: 2 } as const;

export interface Subject {
  subjectType: string;
  subjectData: string;
}

/** An `account` subject: abi.encode(uint256 chainId, address account). Schemes for it must use IDENTITY binding. */
export function accountSubject(chainId: number | bigint, account: string): Subject {
  return { subjectType: SubjectType.account, subjectData: abi.encode(["uint256", "address"], [chainId, account]) };
}

export function erc8004Subject(chainId: number | bigint, identityRegistry: string, agentId: bigint): Subject {
  return { subjectType: SubjectType.erc8004, subjectData: abi.encode(["uint256", "address", "uint256"], [chainId, identityRegistry, agentId]) };
}

export function subjectKey(s: Subject): string {
  return keccak256(abi.encode(["bytes32", "bytes"], [s.subjectType, s.subjectData]));
}

/** levelMask: bit n set <=> level n is a declared result. */
export function levelMaskOf(levels: number[]): bigint {
  return levels.reduce((m, l) => m | (1n << BigInt(l)), 0n);
}

export interface SchemeDescriptor {
  type: string;
  name: string;
  mode: "attested" | "proved";
  binding: "identity" | "controller" | "instance";
  result: { kind: "ordered-level" | "categorical" | "opaque" };
  levels: Record<string, { label: string; meaning: string }>;
  [k: string]: unknown;
}

export interface SchemeInput {
  schemeURI: string;
  schemeHash: string;
  mode: number;
  binding: number;
  resultKind: number;
  levelMask: bigint;
  verifier: string;
  predecessor: string;
}

export interface AttestParams {
  subject: Subject;
  schemeId: string;
  level: number;
  claimDigest: string;
  expiresAt: number;
  evidenceURI?: string;
  evidenceHash?: string;
}

export class KYA {
  constructor(readonly world: World) {}

  schemes(runner?: ContractRunner): Contract {
    return this.world.contract("8419/KYASchemeRegistry", runner);
  }

  registry(runner?: ContractRunner): Contract {
    return this.world.contract("8419/KYARegistry", runner);
  }

  get registryAddress(): string {
    return this.world.address("8419/KYARegistry");
  }

  /** SchemeInput for an ATTESTED, ORDERED_LEVEL scheme (IDENTITY binding: the only kind a plain address satisfies). */
  attestedSchemeInput(descriptor: SchemeDescriptor): SchemeInput {
    const bytes = Buffer.from(JSON.stringify(descriptor));
    return {
      schemeURI: dataUri(descriptor),
      schemeHash: keccak256(bytes),
      mode: SchemeMode.ATTESTED,
      binding: BindingKind.IDENTITY,
      resultKind: ResultKind.ORDERED_LEVEL,
      levelMask: levelMaskOf(Object.keys(descriptor.levels).map(Number)),
      verifier: "0x0000000000000000000000000000000000000000",
      predecessor: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
  }

  /** SchemeInput for a PROVED scheme admitted by an IKYAVerifier. */
  provedSchemeInput(descriptor: SchemeDescriptor, verifier: string): SchemeInput {
    return { ...this.attestedSchemeInput(descriptor), mode: SchemeMode.PROVED, verifier };
  }

  encodeRegisterScheme(input: SchemeInput): string {
    return this.schemes().interface.encodeFunctionData("registerScheme", [input]);
  }

  encodeAttest(p: AttestParams): string {
    return this.registry().interface.encodeFunctionData("attest", [p.subject, p.schemeId, p.level, p.claimDigest, p.expiresAt, p.evidenceURI ?? "", p.evidenceHash ?? "0x" + "00".repeat(32)]);
  }

  /** attestWithProof(subject, schemeId, publicInputs, proof, evidenceURI): the proved path; the verifier adapter becomes the issuer. */
  encodeAttestWithProof(subject: Subject, schemeId: string, publicInputs: string, proof: string, evidenceURI = ""): string {
    return this.registry().interface.encodeFunctionData("attestWithProof", [subject, schemeId, publicInputs, proof, evidenceURI]);
  }

  async isNullifierUsed(schemeId: string, nullifier: string): Promise<boolean> {
    return this.registry().isNullifierUsed(schemeId, nullifier);
  }

  encodeRevoke(assertionId: string, reasonCode: number): string {
    return this.registry().interface.encodeFunctionData("revoke", [assertionId, reasonCode]);
  }

  schemeIdFromReceipt(receipt: any): string {
    return eventArgs(this.schemes().interface, receipt, "SchemeRegistered", this.world.address("8419/KYASchemeRegistry")).schemeId;
  }

  assertionIdFromReceipt(receipt: any): string {
    return eventArgs(this.registry().interface, receipt, "Asserted", this.registryAddress).assertionId;
  }

  get schemeRegistryAddress(): string {
    return this.world.address("8419/KYASchemeRegistry");
  }

  /**
   * Register an ATTESTED, ORDERED_LEVEL scheme for `account` subjects (IDENTITY binding, the only binding
   * kind a plain address can satisfy). The descriptor is published as a data: URI and committed by keccak.
   */
  async registerAttestedScheme(controller: ContractRunner, descriptor: SchemeDescriptor): Promise<{ schemeId: string; receipt: any; schemeHash: string }> {
    const bytes = Buffer.from(JSON.stringify(descriptor));
    const schemeHash = keccak256(bytes);
    const levels = Object.keys(descriptor.levels).map(Number);
    const input = {
      schemeURI: dataUri(descriptor),
      schemeHash,
      mode: SchemeMode.ATTESTED,
      binding: BindingKind.IDENTITY,
      resultKind: ResultKind.ORDERED_LEVEL,
      levelMask: levelMaskOf(levels),
      verifier: "0x0000000000000000000000000000000000000000",
      predecessor: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
    const tx = await this.schemes(controller).registerScheme(input);
    const receipt = await tx.wait();
    const schemeId: string = eventArgs(this.schemes().interface, receipt, "SchemeRegistered").schemeId;
    return { schemeId, receipt, schemeHash };
  }

  /** Register a PROVED scheme whose assertions are admitted by an IKYAVerifier (e.g. the Groth16 adapter). */
  async registerProvedScheme(controller: ContractRunner, descriptor: SchemeDescriptor, verifier: string): Promise<{ schemeId: string; receipt: any; schemeHash: string }> {
    const bytes = Buffer.from(JSON.stringify(descriptor));
    const schemeHash = keccak256(bytes);
    const levels = Object.keys(descriptor.levels).map(Number);
    const input = {
      schemeURI: dataUri(descriptor),
      schemeHash,
      mode: SchemeMode.PROVED,
      binding: BindingKind.IDENTITY,
      resultKind: ResultKind.ORDERED_LEVEL,
      levelMask: levelMaskOf(levels),
      verifier,
      predecessor: "0x0000000000000000000000000000000000000000000000000000000000000000",
    };
    const tx = await this.schemes(controller).registerScheme(input);
    const receipt = await tx.wait();
    return { schemeId: eventArgs(this.schemes().interface, receipt, "SchemeRegistered").schemeId, receipt, schemeHash };
  }

  /** The issuer records an assertion about a subject (ATTESTED mode). */
  async attest(issuer: ContractRunner, p: AttestParams): Promise<{ assertionId: string; receipt: any }> {
    const tx = await this.registry(issuer).attest(p.subject, p.schemeId, p.level, p.claimDigest, p.expiresAt, p.evidenceURI ?? "", p.evidenceHash ?? "0x" + "00".repeat(32));
    const receipt = await tx.wait();
    return { assertionId: eventArgs(this.registry().interface, receipt, "Asserted").assertionId, receipt };
  }

  async revoke(issuer: ContractRunner, assertionId: string, reasonCode: number): Promise<any> {
    const tx = await this.registry(issuer).revoke(assertionId, reasonCode);
    return tx.wait();
  }

  async check(subject: Subject, schemeId: string, minLevel: number, issuers: string[]): Promise<boolean> {
    return this.registry().check(subject, schemeId, minLevel, issuers);
  }

  async resolve(subject: Subject, schemeId: string, issuers: string[]): Promise<{ level: number; expiresAt: bigint; assertionId: string }> {
    const r = await this.registry().resolve(subject, schemeId, issuers);
    return { level: Number(r.level), expiresAt: BigInt(r.expiresAt), assertionId: r.assertionId };
  }

  async admissionDomain(): Promise<string> {
    return this.registry().admissionDomain();
  }
}

/** The descriptor FOGA registers for its attested scheme: a plain ordered ladder of operational levels. */
export function fogaAttestedSchemeDescriptor(): SchemeDescriptor {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8419#kya-scheme-v1",
    name: "FOGA cell standing (attested) v1",
    description: "An issuer's ordered judgment of a cell's operational standing: 1 = known, 2 = operating under a safety binding, 3 = audited.",
    mode: "attested",
    binding: "identity",
    result: { kind: "ordered-level" },
    dimensions: ["cell-standing"],
    levels: {
      "0": { label: "none", meaning: "no standing asserted" },
      "1": { label: "known", meaning: "the issuer has identified the cell" },
      "2": { label: "bound", meaning: "the cell operates under an adopted safety specification" },
      "3": { label: "audited", meaning: "the issuer reviewed the cell's conduct" },
    },
    evidenceKinds: ["foga:cell-document", "erc8468:binding"],
    issuerPolicy: { kind: "open" },
  };
}

/** The descriptor for the credential-pattern proved scheme admitted by the Groth16 adapter (levels 0..4 as the reference circuit). */
export function fogaProvedSchemeDescriptor(): SchemeDescriptor {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8419#kya-scheme-v1",
    name: "FOGA cell standing (proved, credential pattern) v1",
    description: "A hidden issuer from the admitted issuer set signed a standing level; the cell proves it in zero knowledge (kya-public-v1 layout).",
    mode: "proved",
    binding: "identity",
    result: { kind: "ordered-level" },
    dimensions: ["cell-standing"],
    levels: {
      "0": { label: "none", meaning: "no standing" },
      "1": { label: "known", meaning: "identified" },
      "2": { label: "bound", meaning: "safety-bound" },
      "3": { label: "audited", meaning: "conduct reviewed" },
      "4": { label: "verified", meaning: "credential verified by an admitted issuer" },
    },
    evidenceKinds: ["zk:groth16:kya-public-v1"],
    issuerPolicy: { kind: "issuer-set" },
  };
}

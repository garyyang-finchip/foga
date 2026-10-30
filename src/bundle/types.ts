import type { ImmutableReferences, LinkReferences } from "../util/bytecode.js";

export type ContractKind = "contract" | "library" | "interface";

export interface CompilerSettings {
  optimizer: boolean;
  runs: number | null;
  viaIr: boolean;
  evmVersion: string | null;
  bytecodeHash: string | null;
  remappings: string[];
}

export interface BundleContract {
  /** `<repo>:<ContractName>` */
  key: string;
  repo: string;
  erc: number | "foga";
  name: string;
  /** Path of the compilation unit relative to the upstream repository root. */
  upstreamPath: string;
  kind: ContractKind;
  abstract: boolean;
  /** Heuristic role: kernel | registry | adapter | module | library | interface | verifier | bridge | example | mock | companion | types | local-stub | contract */
  role: string;
  deployable: boolean;
  baseContracts: string[];
  /** ERC-165 id computed from the contract's own function selectors (meaningful for interfaces). */
  interfaceId: string | null;
  abi: any[];
  methodIdentifiers: Record<string, string>;
  bytecode: string;
  deployedBytecode: string;
  linkReferences: LinkReferences;
  deployedLinkReferences: LinkReferences;
  immutableReferences: ImmutableReferences;
  /** keccak256 of the runtime code with metadata stripped and link / immutable slots masked — what the doctor compares against chain code. */
  runtimeIdentity: string;
  creationCodeSize: number;
  runtimeCodeSize: number;
  compiler: string;
  settings: CompilerSettings;
  sourceKeccak: string | null;
}

export interface BundleSource {
  erc: number | "foga";
  repo: string;
  url: string | null;
  commit: string | null;
  contractsRoot: string;
  mode: "native" | "staged" | "local";
  upstreamToolchain: string;
  solc: string;
  mirrors?: string;
}

export interface InterfaceIdRecord {
  computed: string;
  upstream: string | null;
  match: boolean | null;
  source: string | null;
}

export interface Bundle {
  schema: "foga.bundle/1";
  builtAt: string;
  builtWith: { forge: string; solc: Record<string, string> };
  sources: BundleSource[];
  contracts: Record<string, BundleContract>;
  interfaceIds: Record<string, Record<string, InterfaceIdRecord>>;
  extras: Record<string, any>;
  /** sha256 over the canonical, machine-independent subset (see bundleHash in build/bundle.ts). */
  hash: string;
}

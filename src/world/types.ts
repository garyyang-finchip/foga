/** Input: how to build or attach to a world. */
export interface WorldConfig {
  schema: "foga.world-config/1";
  name: string;
  network: string;
  chainId: number;
  rpc: string;
  /** "deploy": FOGA deploys the stack; "attach": the stack already exists (public chains) and only the address book is authored. */
  mode: "deploy" | "attach";
  deployer?: { privateKeyEnv: string; defaultPrivateKey?: string; note?: string };
  identity8004: { mode: "stub"; note?: string } | { mode: "address"; address: string; note?: string };
  params: {
    skillToken: { name: string; symbol: string };
    taskToken: { name: string; symbol: string };
    aid: { defaultLivenessWindow: number; maxLivenessWindow: number };
    kya: { issuerSetRoot: string; epochLength: number; epochGrace: number };
    ard: { kindURIs: Record<string, string> };
  };
  /** For attach mode: the address book, authored by hand from the upstream deployment records. */
  contracts?: Record<string, WorldContract>;
  /** Layer-4 expectations that override the plan's defaults: "<stepId>.<getter>" -> expected value. */
  expectations?: Record<string, string>;
  notes?: string[];
}

export interface WorldContract {
  address: string;
  /** `<repo>:<Name>` in the bundle, when the contract is one the bundle knows. */
  bundleKey?: string;
  txHash?: string;
  block?: number;
  args?: unknown[];
  libraries?: Record<string, string>;
  /** Upstream revision the deployment was made from, when it differs from the locked source. */
  deployedRevision?: string;
  note?: string;
}

/** Output / address book: a world instance. */
export interface WorldFile {
  schema: "foga.world/1";
  worldId: string;
  name: string;
  network: string;
  chainId: number;
  mode: "deployed" | "attached";
  bundleHash: string | null;
  batch: string;
  forkSourceBlock: number | null;
  deployer: string | null;
  identity8004: { mode: "stub" | "official" | "address"; address: string; note?: string };
  params: WorldConfig["params"];
  contracts: Record<string, WorldContract>;
  wiring: Record<string, unknown>;
  steps: { id: string; status: "deployed" | "attached" | "skipped" | "wired"; txHash?: string; note?: string }[];
  notes: string[];
}

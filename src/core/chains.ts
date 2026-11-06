import { existsSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../util/fs.js";

/**
 * The chains a cell can join by name (`foga join --chain <name>`): where the world's address book ships, which
 * environment variable names its RPC, a public RPC to fall back on, where test ether comes from and where to look
 * the chain up. One key is one address on every EVM chain, so a wallet made once serves them all; what a chain needs
 * before a cell can be born on it is a deployed world — `foga world deploy` makes one on any chain the bundle can
 * reach, and its address book is then this table's `world` for that chain (docs/join.md).
 */
export interface ChainInfo {
  name: string;
  chainId: number;
  /** The deployed world's address book, relative to the package root; null when none ships (deploy one, then `--world`). */
  world: string | null;
  /** The environment variable a world of this chain names for its RPC. */
  rpcEnv: string;
  /** Public RPC endpoints, tried in order when no RPC is given; shared and rate-limited — a dedicated one is advised. */
  rpc: string[];
  /** Where test ether comes from (testnets); empty on a mainnet. */
  faucets: string[];
  explorer: string | null;
  /** A testnet's ether is free; a mainnet's is not — the join says which it is before anything is sent. */
  testnet: boolean;
}

export const CHAINS: Record<string, ChainInfo> = {
  sepolia: {
    name: "sepolia",
    chainId: 11155111,
    world: "deployments/sepolia.example.json",
    rpcEnv: "SEPOLIA_RPC_URL",
    rpc: ["https://ethereum-sepolia-rpc.publicnode.com", "https://rpc.sepolia.org", "https://1rpc.io/sepolia"],
    faucets: ["https://cloud.google.com/application/web3/faucet/ethereum/sepolia", "https://www.alchemy.com/faucets/ethereum-sepolia", "https://sepoliafaucet.com"],
    explorer: "https://sepolia.etherscan.io",
    testnet: true,
  },
  "base-sepolia": {
    name: "base-sepolia",
    chainId: 84532,
    world: null,
    rpcEnv: "BASE_SEPOLIA_RPC_URL",
    rpc: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com"],
    faucets: ["https://docs.base.org/base-chain/tools/network-faucets", "https://cloud.google.com/application/web3/faucet/base/sepolia"],
    explorer: "https://sepolia.basescan.org",
    testnet: true,
  },
  "optimism-sepolia": {
    name: "optimism-sepolia",
    chainId: 11155420,
    world: null,
    rpcEnv: "OPTIMISM_SEPOLIA_RPC_URL",
    rpc: ["https://sepolia.optimism.io", "https://optimism-sepolia-rpc.publicnode.com"],
    faucets: ["https://console.optimism.io/faucet", "https://cloud.google.com/application/web3/faucet/optimism/sepolia"],
    explorer: "https://sepolia-optimism.etherscan.io",
    testnet: true,
  },
  "arbitrum-sepolia": {
    name: "arbitrum-sepolia",
    chainId: 421614,
    world: null,
    rpcEnv: "ARBITRUM_SEPOLIA_RPC_URL",
    rpc: ["https://sepolia-rollup.arbitrum.io/rpc", "https://arbitrum-sepolia-rpc.publicnode.com"],
    faucets: ["https://docs.arbitrum.io/for-devs/dev-tools-and-resources/chain-info", "https://cloud.google.com/application/web3/faucet/arbitrum/sepolia"],
    explorer: "https://sepolia.arbiscan.io",
    testnet: true,
  },
  anvil: {
    name: "anvil",
    chainId: 31337,
    world: null,
    rpcEnv: "FOGA_RPC_URL",
    rpc: ["http://127.0.0.1:8545"],
    faucets: [],
    explorer: null,
    testnet: true,
  },
};

/** The chain by name, or null; names are case-insensitive. */
export function chainByName(name: string): ChainInfo | null {
  return CHAINS[name.toLowerCase()] ?? null;
}

/** The chain whose id this is, or null. */
export function chainById(chainId: number): ChainInfo | null {
  return Object.values(CHAINS).find((c) => c.chainId === chainId) ?? null;
}

/** The absolute path of the packaged world for a chain, or null when none ships or the file is missing. */
export function packagedWorld(chain: ChainInfo): string | null {
  if (!chain.world) return null;
  const path = join(repoRoot(), chain.world);
  return existsSync(path) ? path : null;
}

/** The RPC for a chain: the one given, the chain's own variable, the general one, then the first public endpoint. */
export function resolveRpc(chain: ChainInfo | null, given?: string): { url: string; source: "flag" | "env" | "public" } {
  if (given) return { url: given, source: "flag" };
  if (chain && process.env[chain.rpcEnv]) return { url: process.env[chain.rpcEnv]!, source: "env" };
  if (process.env.FOGA_RPC_URL) return { url: process.env.FOGA_RPC_URL, source: "env" };
  if (chain?.rpc[0]) return { url: chain.rpc[0], source: "public" };
  throw new Error("no RPC: pass --rpc <url> or set FOGA_RPC_URL");
}

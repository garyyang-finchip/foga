import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Wallet, isHexString } from "ethers";

/**
 * The wallet: an agent's own keys, the first thing it makes (design memo, Phase 3, section 3, "wallet first").
 * One directory holds one key per role in its own 0600 file — owner, operator and guardian for an agent that will
 * be a cell, or a single signer for one that only calls other cells — and a `wallet.json` naming the addresses.
 * Making one touches no network and no chain; it is pure entropy on the agent's own machine, so it does not fail,
 * and it is never made twice: an existing wallet is reported, never overwritten. The node's key rules
 * (`src/node/keys.ts`) read the files as they are; `FOGA_OPERATOR_KEY_FILE=<wallet>/operator.key` is a node's
 * environment, `--wallet <dir>` the CLI's shorthand for the same.
 */
export const WALLET_SCHEMA = "foga.wallet/1";
export const CELL_ROLES = ["owner", "operator", "guardian"] as const;
export type WalletRole = (typeof CELL_ROLES)[number] | "signer";

export interface WalletFile {
  schema: typeof WALLET_SCHEMA;
  name: string;
  createdAt: string;
  roles: Record<string, { address: string; file: string }>;
}

export interface WalletInfo {
  name: string;
  dir: string;
  createdAt: string;
  roles: WalletRole[];
  addresses: Record<string, string>;
  /** The key file of each role, absolute. */
  files: Record<string, string>;
}

/** The default wallet: ~/.foga/wallet. A named wallet lives beside it under ~/.foga/wallets/<name>. */
export function walletDir(name?: string): string {
  const home = process.env.FOGA_HOME ?? join(homedir(), ".foga");
  return name ? join(home, "wallets", name) : join(home, "wallet");
}

function readKeyFile(path: string): string {
  const key = readFileSync(path, "utf8").trim();
  if (!isHexString(key, 32)) throw new Error(`${path} does not hold a private key (expected 0x followed by 64 hex digits)`);
  return key;
}

/** The wallet at `dir`, read from its files (the addresses are derived from the keys, never trusted from wallet.json); null when there is none. */
export function loadWallet(dir: string): WalletInfo | null {
  const abs = resolve(dir);
  const manifest = join(abs, "wallet.json");
  if (!existsSync(manifest)) return null;
  const file = JSON.parse(readFileSync(manifest, "utf8")) as WalletFile;
  if (file.schema !== WALLET_SCHEMA) throw new Error(`${manifest} is not a ${WALLET_SCHEMA} file (schema ${String(file.schema)})`);
  const roles = Object.keys(file.roles) as WalletRole[];
  const addresses: Record<string, string> = {};
  const files: Record<string, string> = {};
  for (const role of roles) {
    const path = join(abs, file.roles[role].file);
    if (!existsSync(path)) throw new Error(`wallet ${abs}: the ${role} key file ${file.roles[role].file} is missing`);
    addresses[role] = new Wallet(readKeyFile(path)).address;
    files[role] = path;
  }
  return { name: file.name, dir: abs, createdAt: file.createdAt, roles, addresses, files };
}

/** The private key of one role of a wallet. */
export function walletKey(wallet: WalletInfo, role: WalletRole): string {
  const path = wallet.files[role];
  if (!path) throw new Error(`wallet ${wallet.dir} has no ${role} key (roles: ${wallet.roles.join(", ")})`);
  return readKeyFile(path);
}

export interface CreateWalletOptions {
  name?: string;
  /** owner, operator and guardian (a cell's roles; default) or a single signer. */
  roles?: WalletRole[];
}

/** Make a wallet at `dir`. Refuses a directory that already holds one (or anything else): a wallet is never overwritten. */
export function createWallet(dir: string, o: CreateWalletOptions = {}): WalletInfo {
  const abs = resolve(dir);
  if (existsSync(join(abs, "wallet.json"))) throw new Error(`${abs} already holds a wallet; foga wallet show prints it (a wallet is never overwritten)`);
  if (existsSync(abs) && readdirSync(abs).length) throw new Error(`${abs} exists and is not empty; choose another directory`);
  const roles = o.roles ?? [...CELL_ROLES];
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  const file: WalletFile = { schema: WALLET_SCHEMA, name: o.name ?? "default", createdAt: new Date().toISOString(), roles: {} };
  for (const role of roles) {
    const w = Wallet.createRandom();
    const name = `${role}.key`;
    writeFileSync(join(abs, name), w.privateKey + "\n", { mode: 0o600 });
    file.roles[role] = { address: w.address, file: name };
  }
  writeFileSync(join(abs, "wallet.json"), JSON.stringify(file, null, 2) + "\n");
  return loadWallet(abs)!;
}

export type EnsuredWallet = { wallet: WalletInfo; created: boolean; ephemeral: false } | { wallet: WalletInfo; created: true; ephemeral: true; reason: string };

/**
 * The wallet to use, made on the spot when there is none (the first step, done by default). A disk that refuses the
 * write does not stop anything: keys are made in memory, the caller is told they are not kept, and the work goes on.
 */
export function ensureWallet(dir: string, o: CreateWalletOptions = {}): EnsuredWallet {
  const existing = loadWallet(dir);
  if (existing) return { wallet: existing, created: false, ephemeral: false };
  try {
    return { wallet: createWallet(dir, o), created: true, ephemeral: false };
  } catch (e) {
    const roles = o.roles ?? [...CELL_ROLES];
    const addresses: Record<string, string> = {};
    const files: Record<string, string> = {};
    for (const role of roles) {
      const w = Wallet.createRandom();
      addresses[role] = w.address;
      files[role] = `memory:${w.privateKey}`;
    }
    return { wallet: { name: o.name ?? "ephemeral", dir: resolve(dir), createdAt: new Date().toISOString(), roles, addresses, files }, created: true, ephemeral: true, reason: (e as Error).message };
  }
}

/** The private key of a role of an ensured wallet, whether it lives in a file or in memory. */
export function ensuredKey(w: EnsuredWallet, role: WalletRole): string {
  const path = w.wallet.files[role];
  if (!path) throw new Error(`wallet ${w.wallet.dir} has no ${role} key`);
  return path.startsWith("memory:") ? path.slice("memory:".length) : readKeyFile(path);
}

/** Whether a wallet's key files are private to their owner (POSIX); a note per file that is not. */
export function walletFileProblems(wallet: WalletInfo): string[] {
  if (process.platform === "win32") return [];
  const out: string[] = [];
  for (const role of wallet.roles) {
    const path = wallet.files[role];
    if (path.startsWith("memory:")) continue;
    const st = statSync(path);
    if (st.mode & 0o077) out.push(`${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); chmod 600`);
  }
  return out;
}

import { readFileSync, statSync } from "node:fs";
import { Wallet, isHexString } from "ethers";

/**
 * The one key a running node holds: its cell's operator key, and nothing else (design memo, Phase 3, key
 * isolation). The genesis derives twelve roles from one phrase because it plays every part; a node plays one, and
 * the process that signs for the public must not be able to derive the owner, the guardian or the treasury. So
 * the node reads its key from FOGA_OPERATOR_KEY (the hex key) or FOGA_OPERATOR_KEY_FILE (a file holding it, readable
 * by its user alone) and refuses to start when its environment also carries a phrase, a deployer key or any
 * FOGA_KEY_<ROLE>: those belong to the operator's shell, never to the node's user. `foga keys export` writes the
 * file for the node from the operator's phrase.
 */
export const OPERATOR_KEY_ENV = "FOGA_OPERATOR_KEY";
export const OPERATOR_KEY_FILE_ENV = "FOGA_OPERATOR_KEY_FILE";

/** Variables whose presence means the process could sign as more than the operator. */
export const FORBIDDEN_IN_NODE_ENV = ["FOGA_MNEMONIC", "FOGA_MNEMONIC_FILE", "FOGA_DEPLOYER_PK", "FOGA_OWNER_KEY", "FOGA_OWNER_KEY_FILE", "FOGA_GUARDIAN_KEY", "FOGA_GUARDIAN_KEY_FILE"];

export type KeyRole = "operator" | "owner" | "guardian";

/** The variables a role's key is read from: FOGA_<ROLE>_KEY or FOGA_<ROLE>_KEY_FILE. */
export function roleKeyEnv(role: KeyRole): { inline: string; file: string } {
  const up = role.toUpperCase();
  return { inline: `FOGA_${up}_KEY`, file: `FOGA_${up}_KEY_FILE` };
}

export interface OperatorKey {
  privateKey: string;
  address: string;
  source: { kind: "env"; name: string } | { kind: "file"; path: string };
}

export class KeyIsolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyIsolationError";
  }
}

/** The variables of `env` a node must not see, with their names (never their values). */
export function forbiddenVariables(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const name of Object.keys(env)) {
    if (env[name] === undefined || env[name] === "") continue;
    if (FORBIDDEN_IN_NODE_ENV.includes(name) || name.startsWith("FOGA_KEY_")) out.push(name);
  }
  return out.sort();
}

function parseKey(text: string, where: string): string {
  const key = text.trim();
  if (!isHexString(key, 32)) throw new KeyIsolationError(`${where} does not hold a private key (expected 0x followed by 64 hex digits)`);
  return key;
}

/**
 * Load the operator key from the environment. Exactly one of FOGA_OPERATOR_KEY and FOGA_OPERATOR_KEY_FILE must be
 * set; the file must be a regular file owned by the current user and readable by nobody else (mode 0600 or
 * tighter; the ownership and mode checks are POSIX-only).
 */
export function loadOperatorKey(env: NodeJS.ProcessEnv = process.env): OperatorKey {
  const forbidden = forbiddenVariables(env);
  if (forbidden.length) {
    throw new KeyIsolationError(`the node's environment holds ${forbidden.join(", ")}: a node runs with its operator key alone (${OPERATOR_KEY_ENV} or ${OPERATOR_KEY_FILE_ENV}). Unset these for the node's user; they belong to the operator's shell.`);
  }
  return loadRoleKey("operator", env);
}

/**
 * Read one role's key from the environment without the isolation check: for the CLI's one-shot commands in the
 * operator's own shell (an owner's or guardian's act, a cell's birth), never for a running node. The file rules
 * are the same as the node's.
 */
export function loadRoleKey(role: KeyRole, env: NodeJS.ProcessEnv = process.env): OperatorKey {
  const names = roleKeyEnv(role);
  const inline = env[names.inline]?.trim();
  const file = env[names.file]?.trim();
  if (inline && file) throw new KeyIsolationError(`both ${names.inline} and ${names.file} are set; set one`);
  if (!inline && !file) {
    if (role === "operator") throw new KeyIsolationError(`no operator key: set ${names.file} to a file written by 'foga keys export --role operator.<X>' (or ${names.inline} to the key itself)`);
    throw new KeyIsolationError(`no ${role} key: set ${names.file} (a 0600 file holding the key) or ${names.inline} for this one command`);
  }
  if (inline) {
    const privateKey = parseKey(inline, names.inline);
    return { privateKey, address: new Wallet(privateKey).address, source: { kind: "env", name: names.inline } };
  }
  const path = file!;
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new KeyIsolationError(`${names.file}=${path}: no such file`);
  }
  if (!st.isFile()) throw new KeyIsolationError(`${names.file}=${path} is not a regular file`);
  if (process.platform !== "win32") {
    if (st.mode & 0o077) throw new KeyIsolationError(`${path} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); make it 0600 (chmod 600)`);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) throw new KeyIsolationError(`${path} is owned by uid ${st.uid}, not by the node's user (uid ${uid}); the node's user must own its key file`);
  }
  const privateKey = parseKey(readFileSync(path, "utf8"), path);
  return { privateKey, address: new Wallet(privateKey).address, source: { kind: "file", path } };
}

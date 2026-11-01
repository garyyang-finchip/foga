import { readFileSync } from "node:fs";
import { HDNodeWallet, Mnemonic, Wallet, randomBytes } from "ethers";
import type { WorldFile } from "../world/types.js";

/**
 * The accounts of the genesis scenario (design memo, section 3.1). Keys are signer names in the kernel.
 *
 *   W            world operator: deploys / attaches the world, registers schemes and specifications, issues
 *                the attested standing assertions, funds the other roles and the cells
 *   G            guardian: the intervener named in every cell's safety binding
 *   owner.<X>    cold principal of cell X (deploys the account, administers it)
 *   operator.<X> hot signer of cell X (acts through the account's execute)
 *   E            evaluator (ERC-8454 measurement receipts, Phase 2b)
 *   J1..J3       judges of the FOGA-Council policy (Phase 2a-2)
 *
 * Every key is derived from one BIP-39 phrase at the standard Ethereum path, role i at m/44'/60'/0'/0/i in the
 * order below. On anvil the phrase is anvil's well-known one, so every local run uses the same addresses. On any
 * other chain the phrase comes from FOGA_MNEMONIC (the words) or FOGA_MNEMONIC_FILE (a file holding them), and
 * FOGA_KEY_<ROLE> ("." as "_", upper case) overrides the key of one role — W = the key that already holds the
 * chain's gas token, for instance. `foga keys new` writes a fresh phrase; `foga keys show` lists the addresses.
 */
export const CELLS = ["A", "B", "C"] as const;
export type CellName = (typeof CELLS)[number];

export const ROLE_ORDER = ["W", "G", "owner.A", "owner.B", "owner.C", "operator.A", "operator.B", "operator.C", "E", "J1", "J2", "J3"] as const;
export type Role = (typeof ROLE_ORDER)[number];

export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/** Roles that must be funded by W on a local chain because anvil only pre-funds its first ten accounts. */
export const DERIVED_BEYOND_ANVIL_DEFAULTS: Role[] = ["J1", "J2", "J3"];

export function rolePath(index: number): string {
  return `m/44'/60'/0'/0/${index}`;
}

export function envNameOf(role: Role): string {
  return `FOGA_KEY_${role.replace(".", "_").toUpperCase()}`;
}

/** Every role's key from one phrase, role i at the i-th standard Ethereum path. */
export function mnemonicKeys(phrase: string): Record<Role, string> {
  const m = Mnemonic.fromPhrase(phrase.trim().split(/\s+/).join(" "));
  const out: Partial<Record<Role, string>> = {};
  ROLE_ORDER.forEach((role, i) => {
    out[role] = HDNodeWallet.fromMnemonic(m, rolePath(i)).privateKey;
  });
  return out as Record<Role, string>;
}

export function anvilKeys(): Record<Role, string> {
  return mnemonicKeys(ANVIL_MNEMONIC);
}

/** A new 12-word phrase from 128 bits of the platform's randomness. */
export function newMnemonic(): string {
  return Mnemonic.fromEntropy(randomBytes(16)).phrase;
}

/** The phrase the environment names, if any: FOGA_MNEMONIC (the words) or FOGA_MNEMONIC_FILE (a file holding them). */
export function envMnemonic(): string | undefined {
  const inline = process.env.FOGA_MNEMONIC?.trim();
  if (inline) return inline;
  const file = process.env.FOGA_MNEMONIC_FILE;
  if (file) return readFileSync(file, "utf8").trim();
  return undefined;
}

/**
 * The keys of a non-anvil chain: the phrase's derivation, each role overridable by FOGA_KEY_<ROLE>. Without a
 * phrase every required role needs its own variable.
 */
export function envKeys(required: readonly Role[]): Record<string, string> {
  const phrase = envMnemonic();
  const derived = phrase ? mnemonicKeys(phrase) : null;
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const role of required) {
    const override = process.env[envNameOf(role)];
    if (override) out[role] = override;
    else if (derived) out[role] = derived[role];
    else missing.push(envNameOf(role));
  }
  if (missing.length) throw new Error(`missing keys for this world: set FOGA_MNEMONIC (or FOGA_MNEMONIC_FILE) for all roles, or ${missing.join(", ")}`);
  return out;
}

/** The keys a genesis run needs for a world: anvil's derived set, or the environment on other chains. */
export function roleKeys(world: WorldFile, required: readonly Role[] = ROLE_ORDER): Record<string, string> {
  if (world.network === "anvil") {
    const all = anvilKeys();
    return Object.fromEntries(required.map((r) => [r, all[r]]));
  }
  return envKeys(required);
}

/** The address of every role for a key set. */
export function roleAddresses(keys: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(keys).map(([role, pk]) => [role, new Wallet(pk).address]));
}

export function ownerRole(cell: CellName): Role {
  return `owner.${cell}` as Role;
}

export function operatorRole(cell: CellName): Role {
  return `operator.${cell}` as Role;
}

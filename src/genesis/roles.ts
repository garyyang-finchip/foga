import { HDNodeWallet, Mnemonic } from "ethers";
import type { WorldFile } from "../world/types.js";

/**
 * The accounts of the genesis scenario (design memo, section 3.1). Keys are signer names in the kernel.
 *
 *   W            world operator: deploys / attaches the world, registers schemes and specifications, issues
 *                the attested standing assertions, funds the cells on local chains
 *   G            guardian: the intervener named in every cell's safety binding
 *   owner.<X>    cold principal of cell X (deploys the account, administers it)
 *   operator.<X> hot signer of cell X (acts through the account's execute)
 *   E            evaluator (ERC-8454 measurement receipts, Phase 2b)
 *   J1..J3       judges of the FOGA-Council policy (Phase 2a-2)
 *
 * On anvil the keys are derived from its well-known mnemonic in a fixed order, so every run uses the same
 * addresses. On any other chain each role's key comes from the environment (FOGA_KEY_<ROLE>, with "." as "_").
 */
export const CELLS = ["A", "B", "C"] as const;
export type CellName = (typeof CELLS)[number];

export const ROLE_ORDER = ["W", "G", "owner.A", "owner.B", "owner.C", "operator.A", "operator.B", "operator.C", "E", "J1", "J2", "J3"] as const;
export type Role = (typeof ROLE_ORDER)[number];

export const ANVIL_MNEMONIC = "test test test test test test test test test test test junk";

/** Roles that must be funded by W on a local chain because anvil only pre-funds its first ten accounts. */
export const DERIVED_BEYOND_ANVIL_DEFAULTS: Role[] = ["J1", "J2", "J3"];

export function anvilKeys(): Record<Role, string> {
  const m = Mnemonic.fromPhrase(ANVIL_MNEMONIC);
  const out: Partial<Record<Role, string>> = {};
  ROLE_ORDER.forEach((role, i) => {
    out[role] = HDNodeWallet.fromMnemonic(m, `m/44'/60'/0'/0/${i}`).privateKey;
  });
  return out as Record<Role, string>;
}

export function envKeys(required: readonly Role[]): Record<string, string> {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const role of required) {
    const name = `FOGA_KEY_${role.replace(".", "_").toUpperCase()}`;
    const v = process.env[name];
    if (!v) missing.push(name);
    else out[role] = v;
  }
  if (missing.length) throw new Error(`missing keys for this world: set ${missing.join(", ")}`);
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

export function ownerRole(cell: CellName): Role {
  return `owner.${cell}` as Role;
}

export function operatorRole(cell: CellName): Role {
  return `operator.${cell}` as Role;
}

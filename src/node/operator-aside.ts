import { getAddress, ZeroAddress } from "ethers";
import type { Cell } from "../kernel/cell.js";

/**
 * The owner's asset moves on a single-key account.
 *
 * FogaCellAccount (revision 2) asks `msg.sender == operator` before `msg.sender == owner` in `execute`, so on an
 * account whose owner is also its operator (a cell born from a one-key wallet: `foga wallet new`, `foga quickstart`)
 * the owner's own call is judged as the operator's, and an asset-moving selector (transferFrom, safeTransferFrom)
 * reverts with `OperatorAssetSelector`. The owner can still move the assets: it sets the operator aside
 * (`setOperator(0)`) for the moves and puts back the setting it found — operator, expiry and daily cap — afterwards.
 *
 * What is sent is decided from the chain, under keyed operations: a resumed run sets the operator aside again only
 * when it is back, restores only while it is still aside, and leaves alone an operator someone else set in between.
 */
export interface OperatorSetting {
  operator: string;
  validUntil: string;
  dailyValueCap: string;
}

/** The account's operator setting as the chain has it now. */
export async function operatorSetting(cell: Cell): Promise<OperatorSetting> {
  const c = cell.contract();
  const [operator, validUntil, dailyValueCap] = await Promise.all([c.operator(), c.operatorValidUntil(), c.operatorDailyValueCap()]);
  return { operator: getAddress(operator), validUntil: BigInt(validUntil).toString(), dailyValueCap: BigInt(dailyValueCap).toString() };
}

/** Whether the owner's asset moves through `execute` would be judged as the operator's. */
export function ownerIsOperator(setting: OperatorSetting, owner: string): boolean {
  return getAddress(setting.operator) === getAddress(owner);
}

export function isAside(setting: OperatorSetting): boolean {
  return getAddress(setting.operator) === ZeroAddress;
}

/** `setOperator` arguments that put `setting` back. */
export function setOperatorArgs(setting: OperatorSetting): [string, bigint, bigint] {
  return [setting.operator, BigInt(setting.validUntil), BigInt(setting.dailyValueCap)];
}

export const ASIDE_ARGS: [string, bigint, bigint] = [ZeroAddress, 0n, 0n];

/**
 * Send the owner's `setOperator(...args)` under `base` when `needed`, resuming a key that was started and not
 * finished. A key already confirmed while the chain needs the call again (the operator came back after it was set
 * aside) takes the next free suffix (`base.1`, `base.2`, ...). Returns the key used, or null when nothing was needed.
 */
async function keyedSetOperator(cell: Cell, base: string, needed: boolean, args: [string, bigint, bigint]): Promise<string | null> {
  const store = cell.kernel.store;
  let key = base;
  for (let i = 1; needed && store.get(key)?.status === "confirmed"; i++) key = `${base}.${i}`;
  const rec = store.get(key);
  if (rec && rec.status !== "confirmed") {
    await cell.admin(key, "setOperator", args);
    return key;
  }
  if (!needed) return rec ? key : null;
  await cell.admin(key, "setOperator", args);
  return key;
}

/** Set the operator aside when the owner still has assets to move and is the operator now. */
export async function setOperatorAside(cell: Cell, base: string, owner: string, movesLeft: boolean): Promise<string | null> {
  return keyedSetOperator(cell, base, movesLeft && ownerIsOperator(await operatorSetting(cell), owner), ASIDE_ARGS);
}

/** Put `saved` back while the operator is still aside (and was not aside before). */
export async function restoreOperator(cell: Cell, base: string, saved: OperatorSetting): Promise<string | null> {
  return keyedSetOperator(cell, base, isAside(await operatorSetting(cell)) && !isAside(saved), setOperatorArgs(saved));
}

/**
 * An owner's asset-moving operation that failed only because the owner was judged as the operator: its estimate
 * reverted with `OperatorAssetSelector`, so nothing reached the chain, and with the operator set aside it can be sent.
 */
export function failedAsOperator(cell: Cell, key: string): boolean {
  const rec = cell.kernel.store.get(key);
  return rec?.status === "failed" && /OperatorAssetSelector/.test(rec.error ?? "");
}

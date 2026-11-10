import { getAddress } from "ethers";
import type { Node } from "./node.js";

/**
 * Whether this cell's owner can move the account's assets through `execute` — or why not. Moving an asset (the
 * ERC-8004 identity, a skill token) is the owner's act: the account refuses the transfer selectors to the operator by
 * construction (`OperatorAssetSelector`). A FogaCellAccount of revision 2 or earlier asks `msg.sender == operator`
 * before it asks for the owner, so on an account whose owner is also its operator — one key in every role, as
 * `foga wallet new` and `foga quickstart` birth a cell — the owner's own moves were judged as the operator's and
 * refused; revision 3 (1.0.3) asks for the owner first. An account keeps the revision it was deployed with, so a
 * one-key cell born before 1.0.3 is told the way out before anything is sent: rotate the operator to a second key
 * (the node then runs with that key) and move the assets with the owner key alone. Null when the owner moves them.
 */
export async function ownerMovesAssets(node: Node): Promise<string | null> {
  const cfg = node.config.identity;
  if (getAddress(cfg.owner) !== getAddress(cfg.operator)) return null;
  const revision = await node.accountVersion();
  if (revision >= 3) return null;
  return `the account ${node.body.address} is a revision-${revision} FogaCellAccount whose owner is also its operator: it asks for the operator before the owner, so the owner's asset moves (the ERC-8004 identity, the skill tokens) are refused as the operator's (OperatorAssetSelector). Rotate the operator to a second key first — foga cell owner operator_rotate --config <cell.config.json> --operator <address> --wallet <dir>, then run the node with that key — and move the assets with the owner key alone. A cell born under 1.0.3 or later has a revision-3 account, which asks for the owner first.`;
}

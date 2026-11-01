import { getAddress } from "ethers";
import type { CellStatus } from "../kernel/cell.js";
import type { CellConfig } from "./config.js";

/**
 * The policy engine: business authorization, the second of the three checks every act passes (design memo, Phase 3,
 * section 3). It is deterministic code over the cell's configuration and facts read from the chain and the store;
 * it never reads a model's words. Each rule answers with a gate — the name of the check and why it passed or
 * refused — and the catalog writes the first refusing gate into the decision record.
 *
 * Gate names (the vocabulary the decision records and the Loop D acceptance use): `permission` (the caller's
 * level), `input` (the request), `skill`, `verifier`, `policy` (reward, deadlines, cancellation, escrow), `safety`
 * (anchor and binding), `budget`, `wallet` (the account's own scope, simulated), `conflict` (the same key under
 * another request), `execution` (the chain refused what every check allowed).
 */
export interface Gate {
  gate: string;
  ok: boolean;
  reason: string;
}

export const ok = (gate: string, reason: string): Gate => ({ gate, ok: true, reason });
export const refused = (gate: string, reason: string): Gate => ({ gate, ok: false, reason });

/** The first refusal, or null when every gate passed. */
export function firstRefusal(gates: Gate[]): Gate | null {
  return gates.find((g) => !g.ok) ?? null;
}

export interface TenderFacts {
  tokenId: bigint;
  rewardWei: bigint;
  asset: string;
  submitBy: bigint;
  settleBy: bigint;
  maxCompletions: bigint;
  completions: bigint;
  acceptanceAuthority: string;
  cancelled: boolean;
  escrowWei: bigint;
  /** From the task document (foga.task/1): the skill asked for and the package it must be run with. */
  skill: string | null;
  packageHash: string | null;
  acceptanceProfile: string | null;
  /** The demander's level under the cell's standing scheme, when the policy asks for one; null when not read. */
  counterpartyLevel: number | null;
}

export interface Clock {
  now: number;
}

/** What the world calls its acceptance authorities, so a policy can say "hashlock" instead of an address. */
export interface AcceptanceDirectory {
  hashlock: string;
}

/** The policy block of a cell applied to one tender: reward, deadlines, state, verifier, counterparty. */
export function tenderGates(cfg: CellConfig, t: TenderFacts, clock: Clock, dir: AcceptanceDirectory): Gate[] {
  const p = cfg.policy.tenders;
  const gates: Gate[] = [];
  const minReward = BigInt(p.minRewardWei);

  // reward and state
  if (t.asset !== "0x0000000000000000000000000000000000000000") gates.push(refused("policy", `the reward is paid in ${t.asset}; the cell takes native-asset tenders only`));
  else if (t.rewardWei < minReward) gates.push(refused("policy", `reward ${t.rewardWei} wei is below the policy floor ${minReward} wei`));
  else gates.push(ok("policy", `reward ${t.rewardWei} wei meets the floor ${minReward} wei`));
  if (t.cancelled) gates.push(refused("policy", "the tender is cancelled"));
  if (t.maxCompletions !== 0n && t.completions >= t.maxCompletions) gates.push(refused("policy", `the tender has its ${t.maxCompletions} completion(s) already`));
  if (t.escrowWei < t.rewardWei) gates.push(refused("policy", `escrow ${t.escrowWei} wei does not cover the reward ${t.rewardWei} wei`));

  // deadlines: enough time left to submit and to settle
  const submitLeft = t.submitBy === 0n ? null : Number(t.submitBy) - clock.now;
  const settleLeft = t.settleBy === 0n ? null : Number(t.settleBy) - clock.now;
  const deadlines: Gate[] = [];
  if (submitLeft !== null && submitLeft < p.minSubmitWindowSeconds) deadlines.push(refused("policy", submitLeft <= 0 ? "past submitBy" : `only ${submitLeft} s left to submit; the policy wants ${p.minSubmitWindowSeconds} s`));
  if (settleLeft !== null && settleLeft < p.minSettleWindowSeconds) deadlines.push(refused("policy", settleLeft <= 0 ? "past settleBy" : `only ${settleLeft} s left to settle; the policy wants ${p.minSettleWindowSeconds} s`));
  gates.push(...(deadlines.length ? deadlines : [ok("policy", `deadlines open (submitBy ${submitLeft === null ? "none" : `in ${submitLeft} s`}, settleBy ${settleLeft === null ? "none" : `in ${settleLeft} s`})`)]));

  // the acceptance authority the cell works under
  const resolveName = (a: string) => (a === "hashlock" ? dir.hashlock : a);
  const match = p.acceptance.find((a) => resolveName(a).toLowerCase() === t.acceptanceAuthority.toLowerCase());
  if (!match) gates.push(refused("verifier", `acceptance authority ${t.acceptanceAuthority} is not one the cell works under (${p.acceptance.join(", ")})`));
  else if (match === "hashlock" && t.acceptanceProfile && t.acceptanceProfile !== "x-hashlock-v1") gates.push(refused("verifier", `the task document names acceptance profile ${t.acceptanceProfile}; the hashlock verifier settles x-hashlock-v1 only`));
  else gates.push(ok("verifier", `acceptance authority ${t.acceptanceAuthority} (${match})`));

  // the counterparty's standing, when the policy asks for it
  if (p.counterpartyMinLevel > 0) {
    if (t.counterpartyLevel === null) gates.push(refused("policy", `the policy requires the demander at KYA level ${p.counterpartyMinLevel} and no level could be read`));
    else if (t.counterpartyLevel < p.counterpartyMinLevel) gates.push(refused("policy", `the demander's KYA level ${t.counterpartyLevel} is below the required ${p.counterpartyMinLevel}`));
    else gates.push(ok("policy", `demander at KYA level ${t.counterpartyLevel} (required ${p.counterpartyMinLevel})`));
  }
  return gates;
}

/** Whether the cell holds and offers the skill a tender asks for, with the package the chain commits to. */
export function skillGate(cfg: CellConfig, t: { skill: string | null; packageHash: string | null }, held: { name: string; packageHash: string }[]): Gate {
  if (!t.skill) return refused("skill", "the task document names no skill (foga.task/1 expected)");
  const have = held.find((h) => h.name === t.skill);
  if (!have) return refused("skill", `the cell holds no skill named ${t.skill} (held: ${held.map((h) => h.name).join(", ") || "none"})`);
  if (!cfg.skills.offered.includes(t.skill)) return refused("skill", `the cell holds ${t.skill} but does not offer it (policy: offered = ${cfg.skills.offered.join(", ") || "none"})`);
  if (t.packageHash && t.packageHash.toLowerCase() !== have.packageHash.toLowerCase()) return refused("skill", `the task wants package ${t.packageHash.slice(0, 10)}… of ${t.skill}; the cell's token commits to ${have.packageHash.slice(0, 10)}…`);
  return ok("skill", `${t.skill} held and offered; package ${have.packageHash.slice(0, 10)}… matches the token's commitment`);
}

/** Liveness and safety: the anchor must be ACTIVE and the binding Satisfied for a commitment; de-risk actions pass under a derisk-only suspension. */
export function safetyGate(aidState: string, status: CellStatus, kind: "commitment" | "derisk" | "plain"): Gate {
  if (kind === "commitment" && aidState !== "ACTIVE") return refused("safety", `anchor ${aidState}: no commitment-class call while not ACTIVE`);
  if (status.verdictName === "Satisfied") return ok("safety", `anchor ${aidState}, binding Satisfied`);
  const stopped = status.reasonNames.filter((r) => r === "Suspended" || r === "StoppedByIntervener" || r === "Terminated");
  if (kind === "derisk" && status.verdictName === "NotSatisfied" && stopped.length && !status.restrictions.includes(16)) return ok("safety", `binding ${status.verdictName} [${status.reasonNames.join(",")}]: a de-risk action, allowed under the suspension`);
  return refused("safety", `binding ${status.verdictName} [${status.reasonNames.join(",")}]${status.restrictions.length ? `, restrictions ${status.restrictions.join(",")}` : ""}`);
}

export interface BudgetUse {
  /** Native value the cell moved out in the window, and fees its operator paid. */
  valueWei: bigint;
  gasWei: bigint;
  /** Reserved by open operations (claimed or in flight). */
  reservedValueWei: bigint;
  reservedFeeWei: bigint;
  /** Jobs taken and not yet settled. */
  runningCommitments: number;
}

export interface BudgetRequest {
  valueWei: bigint;
  feeReserveWei: bigint;
  /** A new commitment (a tender taken) counts against maxConcurrentCommitments. */
  commitment: boolean;
}

/** The four books of the budget (value, gas, model, resources; the first two here) against a request. */
export function budgetGate(cfg: CellConfig, use: BudgetUse, req: BudgetRequest): Gate {
  const b = cfg.policy.budget;
  const perOp = BigInt(b.perOperationValueWei);
  const dailyValue = BigInt(b.dailyValueWei);
  const dailyGas = BigInt(b.dailyGasWei);
  if (req.valueWei > perOp) return refused("budget", `the operation would move ${req.valueWei} wei; the per-operation cap is ${perOp} wei`);
  const valueAfter = use.valueWei + use.reservedValueWei + req.valueWei;
  if (valueAfter > dailyValue) return refused("budget", `value moved and reserved in the last 24 h would reach ${valueAfter} wei; the daily cap is ${dailyValue} wei`);
  const gasAfter = use.gasWei + use.reservedFeeWei + req.feeReserveWei;
  if (gasAfter > dailyGas) return refused("budget", `fees paid and reserved in the last 24 h would reach ${gasAfter} wei; the daily cap is ${dailyGas} wei`);
  if (req.commitment && use.runningCommitments >= b.maxConcurrentCommitments) return refused("budget", `${use.runningCommitments} commitment(s) open; the policy allows ${b.maxConcurrentCommitments} at a time`);
  return ok("budget", `value ${valueAfter}/${dailyValue} wei, fees ${gasAfter}/${dailyGas} wei in the window${req.commitment ? `, commitments ${use.runningCommitments + 1}/${b.maxConcurrentCommitments}` : ""}`);
}

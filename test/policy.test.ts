import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEther } from "ethers";
import { newCellConfig } from "../src/node/config.js";
import { budgetGate, firstRefusal, safetyGate, skillGate, tenderGates, type TenderFacts } from "../src/node/policy.js";

/**
 * The policy engine's rules, offline: each gate answers from the configuration and the facts it is given, and the
 * first refusal names the check that decided (the vocabulary the decision records and Loop D use).
 */
const HASHLOCK = "0x" + "aa".repeat(20);
const cfg = newCellConfig({ name: "T", world: "w.json", store: "s.sqlite", owner: "0x" + "11".repeat(20), operator: "0x" + "22".repeat(20), guardian: "0x" + "33".repeat(20) });
cfg.policy.budget = { dailyValueWei: parseEther("0.002").toString(), perOperationValueWei: parseEther("0.001").toString(), dailyGasWei: parseEther("0.01").toString(), maxConcurrentCommitments: 2 };
cfg.policy.tenders = { minRewardWei: parseEther("0.0005").toString(), minSubmitWindowSeconds: 600, minSettleWindowSeconds: 600, acceptance: ["hashlock"], counterpartyMinLevel: 0, lookbackBlocks: 9000 };
cfg.skills.offered = ["foga-probe"];

const now = 1_700_000_000;
const good: TenderFacts = { tokenId: 7n, rewardWei: parseEther("0.001"), asset: "0x0000000000000000000000000000000000000000", submitBy: BigInt(now + 86400), settleBy: BigInt(now + 7 * 86400), maxCompletions: 1n, completions: 0n, acceptanceAuthority: HASHLOCK, cancelled: false, escrowWei: parseEther("0.001"), skill: "foga-probe", packageHash: "0x" + "01".repeat(32), acceptanceProfile: "x-hashlock-v1", counterpartyLevel: null };
const dir = { hashlock: HASHLOCK };

test("a tender within the policy passes every tender gate", () => {
  const gates = tenderGates(cfg, good, { now }, dir);
  assert.equal(firstRefusal(gates), null, JSON.stringify(gates));
  assert.deepEqual([...new Set(gates.map((g) => g.gate))].sort(), ["policy", "verifier"]);
});

test("reward, deadlines, state and escrow refuse at policy; the authority at verifier", () => {
  const refusal = (t: Partial<TenderFacts>, clock = now) => firstRefusal(tenderGates(cfg, { ...good, ...t }, { now: clock }, dir));
  assert.equal(refusal({ rewardWei: parseEther("0.0001") })?.gate, "policy");
  assert.match(refusal({ rewardWei: parseEther("0.0001") })!.reason, /below the policy floor/);
  assert.equal(refusal({ asset: "0x" + "ee".repeat(20) })?.gate, "policy");
  assert.equal(refusal({ cancelled: true })?.gate, "policy");
  assert.equal(refusal({ escrowWei: 0n })?.gate, "policy");
  assert.equal(refusal({ completions: 1n })?.gate, "policy");
  assert.match(refusal({ submitBy: BigInt(now + 120) })!.reason, /120 s left to submit/);
  assert.match(refusal({}, now + 2 * 86400)!.reason, /past submitBy/);
  assert.equal(refusal({ settleBy: BigInt(now + 100) })?.gate, "policy");
  assert.equal(refusal({ submitBy: 0n, settleBy: 0n }), null, "open-ended deadlines pass");
  assert.equal(refusal({ acceptanceAuthority: "0x" + "bb".repeat(20) })?.gate, "verifier");
  assert.equal(refusal({ acceptanceProfile: "x-judged-v1" })?.gate, "verifier");
  // an authority named by address in the policy
  const byAddress = { ...cfg, policy: { ...cfg.policy, tenders: { ...cfg.policy.tenders, acceptance: ["0x" + "bb".repeat(20)] } } };
  assert.equal(firstRefusal(tenderGates(byAddress, { ...good, acceptanceAuthority: "0x" + "bb".repeat(20), acceptanceProfile: null }, { now }, dir)), null);
  assert.equal(firstRefusal(tenderGates(byAddress, good, { now }, dir))?.gate, "verifier");
});

test("the counterparty's standing is required only when the policy asks", () => {
  const strict = { ...cfg, policy: { ...cfg.policy, tenders: { ...cfg.policy.tenders, counterpartyMinLevel: 2 } } };
  assert.equal(firstRefusal(tenderGates(strict, good, { now }, dir))?.gate, "policy", "no level read");
  assert.equal(firstRefusal(tenderGates(strict, { ...good, counterpartyLevel: 1 }, { now }, dir))?.gate, "policy");
  assert.equal(firstRefusal(tenderGates(strict, { ...good, counterpartyLevel: 2 }, { now }, dir)), null);
  assert.equal(firstRefusal(tenderGates(cfg, { ...good, counterpartyLevel: 0 }, { now }, dir)), null, "level 0 required: anyone");
});

test("the skill gate wants the skill held, offered and committed to the same package", () => {
  const held = [{ name: "foga-probe", packageHash: "0x" + "01".repeat(32) }, { name: "finch-extract-verify", packageHash: "0x" + "02".repeat(32) }];
  assert.equal(skillGate(cfg, { skill: "foga-probe", packageHash: "0x" + "01".repeat(32) }, held).ok, true);
  assert.equal(skillGate(cfg, { skill: "foga-probe", packageHash: null }, held).ok, true, "a task naming no package accepts the held one");
  assert.match(skillGate(cfg, { skill: "foga-oracle", packageHash: null }, held).reason, /holds no skill named foga-oracle/);
  assert.match(skillGate(cfg, { skill: "finch-extract-verify", packageHash: null }, held).reason, /does not offer it/);
  assert.match(skillGate(cfg, { skill: "foga-probe", packageHash: "0x" + "ff".repeat(32) }, held).reason, /commits to/);
  assert.match(skillGate(cfg, { skill: null, packageHash: null }, held).reason, /names no skill/);
  for (const g of [skillGate(cfg, { skill: "foga-oracle", packageHash: null }, held)]) assert.equal(g.gate, "skill");
});

test("the safety gate: commitments need ACTIVE and Satisfied; de-risk actions pass a derisk-only suspension, nothing passes a full stop", () => {
  const satisfied = { verdict: 1, verdictName: "Satisfied", reasons: [], reasonNames: [], restrictions: [] };
  const suspended = { verdict: 2, verdictName: "NotSatisfied", reasons: [3], reasonNames: ["Suspended"], restrictions: [1, 8] };
  const stopped = { verdict: 2, verdictName: "NotSatisfied", reasons: [15], reasonNames: ["StoppedByIntervener"], restrictions: [16] };
  assert.equal(safetyGate("ACTIVE", satisfied, "commitment").ok, true);
  assert.equal(safetyGate("STALE", satisfied, "commitment").ok, false);
  assert.match(safetyGate("STALE", satisfied, "commitment").reason, /not ACTIVE/);
  assert.equal(safetyGate("STALE", satisfied, "plain").ok, true, "a plain call does not need ACTIVE");
  assert.equal(safetyGate("ACTIVE", suspended, "commitment").ok, false);
  assert.equal(safetyGate("ACTIVE", suspended, "derisk").ok, true);
  assert.equal(safetyGate("ACTIVE", stopped, "derisk").ok, false, "a full stop closes de-risk actions too");
  assert.equal(safetyGate("ACTIVE", suspended, "plain").ok, false);
  for (const g of [safetyGate("STALE", satisfied, "commitment"), safetyGate("ACTIVE", suspended, "plain")]) assert.equal(g.gate, "safety");
});

test("the budget gate: per-operation cap, daily value and fees with reservations, concurrent commitments", () => {
  const use = { valueWei: parseEther("0.001"), gasWei: parseEther("0.001"), reservedValueWei: parseEther("0.0005"), reservedFeeWei: parseEther("0.001"), runningCommitments: 1 };
  assert.equal(budgetGate(cfg, use, { valueWei: parseEther("0.0004"), feeReserveWei: parseEther("0.001"), commitment: true }).ok, true);
  assert.match(budgetGate(cfg, use, { valueWei: parseEther("0.0011"), feeReserveWei: 0n, commitment: false }).reason, /per-operation cap/);
  assert.match(budgetGate(cfg, use, { valueWei: parseEther("0.0006"), feeReserveWei: 0n, commitment: false }).reason, /daily cap is 2000000000000000/);
  assert.match(budgetGate(cfg, use, { valueWei: 0n, feeReserveWei: parseEther("0.0081"), commitment: false }).reason, /fees paid and reserved/);
  assert.match(budgetGate(cfg, { ...use, runningCommitments: 2 }, { valueWei: 0n, feeReserveWei: 0n, commitment: true }).reason, /2 commitment\(s\) open/);
  assert.equal(budgetGate(cfg, { ...use, runningCommitments: 2 }, { valueWei: 0n, feeReserveWei: 0n, commitment: false }).ok, true, "a non-commitment does not count");
  assert.equal(budgetGate(cfg, use, { valueWei: 0n, feeReserveWei: 0n, commitment: true }).gate, "budget");
});

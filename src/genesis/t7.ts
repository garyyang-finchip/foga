import { join } from "node:path";
import { getAddress, parseEther } from "ethers";
import { Restriction } from "../core/asf.js";
import { accountRef, dataUri, keccakJcs, sha256Hex } from "../core/canonical.js";
import { hashlock, nativeTerms } from "../core/tenders.js";
import { extractVerifyFile } from "./extract.js";
import { LIVENESS_DEMO_WINDOW, type Genesis } from "./scenario.js";

/**
 * T7 — safety: the stop is enforced where the cell acts, not where it promises.
 *  (0) B tenders two completions of the finch-extract-verify report (a pending opportunity for A).
 *  (1) The guardian suspends A's binding (no new risk, de-risk only). The kernel reads `status()` and records its
 *      decision: no new commitments, de-risk actions allowed.
 *  (2) Bypass: the operator key sends a transaction straight to the account, around the kernel, for a
 *      commitment-class call; the account's gate reverts it on chain. A de-risk call through the same gate
 *      succeeds (A withdraws its escrow earnings from T6).
 *  (3) Attribution: the operator key submits to the tender directly, not through the account; the chain accepts
 *      it, but the fulfiller is the operator's own address, and the kernel marks the submission and its payout
 *      as not the cell's.
 *  (4) Escape attempts: the owner presents a fresh binding; the standing stop recorded by the intervener still
 *      applies (StoppedByIntervener); the adopter cannot lift the intervener's suspension; a non-guardian cannot
 *      suspend.
 *  (5) The guardian resumes; A submits and is paid through its account.
 *  (6) The anchor gate: A shortens its liveness window (an anchor's own parameter) and the window passes without a
 *      heartbeat; A is STALE and a commitment-class call is refused by the gate's AID clause; after a heartbeat it
 *      passes the gate again and A restores the registry's default window. B and C heartbeat too. The same path runs
 *      on every chain: the clock is moved on anvil and waited for elsewhere.
 */
export async function t7(g: Genesis): Promise<void> {
  const k = g.kernel;
  const W = "W";
  const A = g.cell("A");
  const B = g.cell("B");
  const C = g.cell("C");
  const chainId = g.chainId;
  const G = k.address("G");
  const bindingId = k.requireFact<string>("T1.A.bindingId");
  const extractSkill = k.requireFact<{ tokenId: string; packageHash: string }>("T2.skill.finch-extract-verify");
  const spec = k.requireFact<{ specId: string; version: number; contentHash: string }>("T0.asf.spec");
  const reward = parseEther("0.001");
  const escrow = k.adrf.escrowAddress;
  // the suspension was lifted in an earlier run: state checks of the suspended phase cannot be remade
  const replayedStop = k.store.get("T7.G.resume")?.status === "confirmed";
  const replayedStale = k.store.get("T7.A.aid.heartbeat")?.status === "confirmed";

  // --- (0) the pending opportunity: a hashlock tender over the deterministic report, two completions
  const run = extractVerifyFile(join(g.cfg.fixturesDir, "sample-filing.txt"), join(g.cfg.skillsDir, "finch-extract-verify", "fields.json"), extractSkill.packageHash);
  const answer = run.canonical;
  const answerHash = hashlock.answerHash(answer);
  const task = { schema: "foga.task/1", skill: "finch-extract-verify", packageHash: extractSkill.packageHash, input: { document: "scenarios/fixtures/sample-filing.txt", documentDigest: run.report.documentDigest }, acceptance: { mode: "verifier", profile: "x-hashlock-v1", verifier: k.tenders.hashlockAddress, answerHash }, deliverable: "the canonical finch.extract-verify/1 report; resultHash = sha256(report || fulfiller)", completions: 2 };
  const taskURI = dataUri(task);
  const taskHash = sha256Hex(JSON.stringify(task));
  const settleBy = await k.memo("T7.settleBy", async () => (await k.blockTimestamp()) + 7 * 86400);
  const terms = nativeTerms(reward, { maxCompletions: 2n, submitBy: BigInt(settleBy - 86400), settleBy: BigInt(settleBy) });
  const mint = await B.execute("T7.B.mint", k.tenders.address, k.tenders.encodeMint({ to: B.address, updateAuthority: B.address, acceptanceAuthority: k.tenders.hashlockAddress, tdHash: keccakJcs({ td: "foga.task/1", skill: "finch-extract-verify" }), taskHash, taskURI, terms }));
  const tokenId = k.tenders.tokenIdFromReceipt(mint.receipt);
  k.setFact("T7.tokenId", tokenId.toString());
  await B.execute("T7.B.fund", k.tenders.address, k.tenders.encodeFund(tokenId, reward * 2n), { value: reward * 2n });
  await B.execute("T7.B.commit", k.tenders.hashlockAddress, k.tenders.encodeCommitAnswer(tokenId, answerHash));

  const receipt = { schema: "foga.run-receipt/1", skill: "finch-extract-verify", packageHash: extractSkill.packageHash, tokenId: extractSkill.tokenId, input: task.input, answerHash, fulfiller: accountRef(chainId, A.address), worker: "deterministic extractor in the kernel process" };
  const submitAsA = k.tenders.encodeSubmit(tokenId, hashlock.resultHash(answer, A.address), dataUri(receipt));

  // --- (1) the guardian stops A: no new risk, de-risk only
  const response = { kind: "response", restrictions: ["no-new-risk", "derisk-only"], allowed: ["withdrawals of earned credit", "refunds", "leaving a swarm", "withdrawing escrow balances"], text: "Stop taking on new work and new counterparties; bring exposures home; await the guardian's review." };
  const reason = { kind: "reason", summary: "guardian review of the cell's conduct after the T6 dispute", step: "T7" };
  const notGuardian = await g.wouldRevertCall(k.address(W), k.asf.bindingRegistryAddress, k.asf.encodeSuspend(bindingId, Restriction.noNewRisk | Restriction.deriskOnly, keccakJcs(response), keccakJcs(reason)));
  g.check("T7", "suspend.stranger.refused", notGuardian !== null, `W (not the intervener) suspending A's binding reverts: ${notGuardian}`);
  await k.call("T7.G.suspend", "G", k.asf.bindingRegistryAddress, k.asf.bindings().interface, "suspend", [bindingId, Restriction.noNewRisk | Restriction.deriskOnly, keccakJcs(response), keccakJcs(reason)]);

  if (!replayedStop) {
    const status = await A.status();
    const decision = { cell: "A", verdict: status.verdictName, reasons: status.reasonNames, restrictions: status.restrictions, decision: "no new commitment-class calls; de-risk actions continue; wait for resume", recordedAt: await k.blockTimestamp() };
    k.setFact("T7.kernel.decision", decision);
    // Suspended through the presented binding, or StoppedByIntervener when a resumed run already presents the second one
    g.check("T7", "status.suspended", status.verdictName === "NotSatisfied" && status.reasonNames.some((r) => r === "Suspended" || r === "StoppedByIntervener"), `status() = ${status.verdictName} [${status.reasonNames.join(",")}], restrictions ${status.restrictions.join(",")}; kernel decision recorded`);

    // --- (2) bypass: the operator key goes around the kernel and straight to the account; the gate refuses
    const bypass = await k.memo("T7.bypass", async () => {
      const operator = k.signer(A.roles.operator);
      const data = A.iface.encodeFunctionData("execute", [k.tenders.address, 0n, submitAsA]);
      const reasonText = await g.wouldRevertCall(operator.address, A.address, data);
      const tx = await operator.sendTransaction({ to: A.address, data, gasLimit: 400_000n });
      const r = await g.world.provider.waitForTransaction(tx.hash); // unlike tx.wait(), returns a status-0 receipt instead of throwing
      return { txHash: tx.hash, status: r?.status ?? null, gasUsed: r?.gasUsed.toString() ?? null, reason: reasonText };
    });
    g.check("T7", "bypass.reverted", bypass.status === 0 && bypass.reason !== null, `operator.A's direct transaction ${bypass.txHash.slice(0, 10)}… to execute(submitFulfillment) failed on chain (status ${bypass.status}, ${bypass.gasUsed} gas): ${bypass.reason}`);
    const deposit = await g.wouldRevert(A, escrow, k.adrf.encodeDeposit());
    g.check("T7", "newrisk.refused", deposit !== null, `a call that is neither de-risk nor allow-listed (escrow deposit) reverts under the suspension: ${deposit}`);
  } else {
    g.skipped("T7", "status.suspended", "replayed run: the suspension was already lifted");
    g.skipped("T7", "bypass.reverted", "replayed run: the suspension was already lifted");
    g.skipped("T7", "newrisk.refused", "replayed run: the suspension was already lifted");
  }

  // de-risk through the same gate: A brings its T6 earnings home from the escrow
  const earned = await k.adrf.escrowBalanceOf(A.address);
  const withdrawDone = k.store.get("T7.A.derisk.withdraw")?.status === "confirmed";
  const before = await A.balance();
  if (earned > 0n) await A.execute("T7.A.derisk.withdraw", escrow, k.adrf.encodeWithdrawBalance(earned));
  if (!withdrawDone) g.check("T7", "derisk.allowed", (await A.balance()) - before === earned && earned > 0n, `withdrawBalance(${earned}) through the account succeeded under the suspension (de-risk allow-list); A's account rose by ${(await A.balance()) - before} wei`);
  else g.skipped("T7", "derisk.allowed", "replayed run: the withdrawal was already made");

  // --- (3) attribution: the operator key acts on its own, not through the account
  const operatorAddress = A.operatorAddress;
  const rogue = await k.call("T7.operator.submit", A.roles.operator, k.tenders.address, k.tenders.contract().interface, "submitFulfillment", [tokenId, hashlock.resultHash(answer, operatorAddress), dataUri({ ...receipt, fulfiller: accountRef(chainId, operatorAddress), note: "submitted by the operator key directly" })]);
  const rogueId = k.tenders.submissionIdFromReceipt(rogue.receipt);
  k.setFact("T7.operator.submissionId", rogueId.toString());
  const rogueSub = await k.tenders.submissionOf(tokenId, rogueId);
  const attributable = getAddress(rogueSub.fulfiller) === getAddress(A.address);
  g.check("T7", "attribution.operator", !attributable && getAddress(rogueSub.fulfiller) === getAddress(operatorAddress), `submission ${rogueId}: fulfiller ${rogueSub.fulfiller} is the operator key, not the cell; the kernel marks it "not attributable to A"`);
  const opBefore = await k.balance(operatorAddress);
  const settleDone = k.store.get("T7.operator.settle")?.status === "confirmed";
  await k.call("T7.operator.settle", A.roles.operator, k.tenders.address, k.tenders.contract().interface, "settleFulfillment", [tokenId, rogueId, Buffer.from(answer, "utf8")]);
  const rogueAfter = await k.tenders.submissionOf(tokenId, rogueId);
  if (!settleDone) g.check("T7", "attribution.payout", rogueAfter.status === 1 && (await k.balance(operatorAddress)) > opBefore - parseEther("0.0005"), `the operator settled its own submission and was paid ${reward} wei to its key: income outside the cell's boundary (T8 does not count it)`);
  else g.skipped("T7", "attribution.payout", "replayed run: the operator's settlement was already made");
  k.setFact("T7.unattributed", { tokenId: tokenId.toString(), submissionId: rogueId.toString(), fulfiller: operatorAddress, reward: reward.toString(), reason: "fulfiller is the operator key, not the cell account" });

  // --- (4) escape attempts
  const input2 = k.asf.cellBindingInput({ chainId, cell: A.address, specId: spec.specId, version: spec.version, contentHash: spec.contentHash, guardian: G, params: { profile: "foga-cell/1", cell: "A", note: "second binding presented while the first is suspended" }, authority: { kind: "owner", owner: accountRef(chainId, A.ownerAddress), guardian: accountRef(chainId, G) }, salt: "0x" + "00".repeat(31) + "02" });
  const { bindingId: binding2 } = await A.adoptBinding("T7.A.adopt2", input2, 0);
  k.setFact("T7.A.bindingId2", binding2);
  if (!replayedStop) {
    const status2 = await A.status();
    g.check("T7", "escape.sibling.refused", status2.verdictName === "NotSatisfied" && status2.reasonNames.includes("StoppedByIntervener"), `with a fresh binding ${binding2.slice(0, 10)}… presented, status() = ${status2.verdictName} [${status2.reasonNames.join(",")}]: the intervener's standing stop follows the adopter and the subject`);
    const stillBlocked = await g.wouldRevert(A, k.tenders.address, submitAsA);
    g.check("T7", "escape.sibling.gate", stillBlocked !== null, `the commitment-class call through the fresh binding still reverts: ${stillBlocked}`);
    const adopterLift = await g.wouldRevert(A, k.asf.bindingRegistryAddress, k.asf.encodeResume(bindingId, keccakJcs({ by: "adopter" })), "owner");
    g.check("T7", "escape.adopter.refused", adopterLift !== null, `the adopter (owner through the account) resuming the intervener's suspension reverts: ${adopterLift}`);
  } else {
    for (const n of ["escape.sibling.refused", "escape.sibling.gate", "escape.adopter.refused"]) g.skipped("T7", n, "replayed run: the suspension was already lifted");
  }

  // --- (5) resume, then A works through its account
  await k.call("T7.G.resume", "G", k.asf.bindingRegistryAddress, k.asf.bindings().interface, "resume", [bindingId, keccakJcs({ kind: "reason", summary: "review complete; the cell may resume", step: "T7" })]);
  const resumed = await A.status();
  g.check("T7", "status.resumed", resumed.verdictName === "Satisfied", `status() = ${resumed.verdictName} after the guardian's resume (the standing stop is lifted with it)`);
  const aBefore = await A.balance();
  const submitDone = k.store.get("T7.A.settle")?.status === "confirmed";
  const sub = await A.execute("T7.A.submit", k.tenders.address, submitAsA);
  const subId = k.tenders.submissionIdFromReceipt(sub.receipt);
  k.setFact("T7.A.submissionId", subId.toString());
  await A.execute("T7.A.settle", k.tenders.address, k.tenders.encodeSettle(tokenId, subId, Buffer.from(answer, "utf8")));
  const aSub = await k.tenders.submissionOf(tokenId, subId);
  g.check("T7", "A.accepted", aSub.status === 1 && getAddress(aSub.fulfiller) === getAddress(A.address), `submission ${subId}: Accepted, fulfiller = the cell account`);
  if (!submitDone) g.check("T7", "A.paid", (await A.balance()) - aBefore === reward, `A's account rose by ${(await A.balance()) - aBefore} wei`);
  else g.skipped("T7", "A.paid", "replayed run: the settlement was already made");

  // --- (6) the anchor gate: STALE once a liveness window passes without a heartbeat, back to ACTIVE after one
  const defaultWindow = await k.aid.defaultLivenessWindow();
  if (!replayedStale) {
    // the anchor shortens its own window (setLivenessWindow is the anchor's call; it also counts as a heartbeat)
    await A.execute("T7.A.aid.window", k.aid.address, k.aid.encodeSetLivenessWindow(LIVENESS_DEMO_WINDOW));
    const window = await k.aid.livenessWindow(A.address);
    const lastSeen = Number(await k.aid.lastSeen(A.address));
    const now = await k.blockTimestamp();
    const staleAt = (lastSeen || now) + window + 1;
    if (staleAt > now) await k.advanceTime(staleAt - now, `A's liveness window (${window} s) passes without a heartbeat`);
    const stateA = await k.aid.stateName(A.address);
    const staleGate = await g.wouldRevert(A, k.tenders.address, submitAsA);
    g.check("T7", "anchor.stale.gate", window === LIVENESS_DEMO_WINDOW && stateA === "STALE" && staleGate !== null && /AnchorNotActive/.test(staleGate), `livenessWindow(A) = ${window} s (default ${defaultWindow} s); after it passes, state(A) = ${stateA} and a commitment-class call reverts at the gate: ${staleGate}`);
  } else {
    g.skipped("T7", "anchor.stale.gate", "replayed run: the heartbeat was already sent");
  }
  for (const X of [A, B, C]) {
    await X.execute(`T7.${X.name}.aid.heartbeat`, k.aid.address, k.aid.encodeHeartbeat());
    if (k.aid.backing) await X.execute(`T7.${X.name}.aid.backing.heartbeat`, k.aid.backing.address, k.aid.encodeHeartbeat());
  }
  const states = await Promise.all([A, B, C].map((X) => k.aid.stateName(X.address)));
  const afterBeat = await g.wouldRevert(A, k.tenders.address, submitAsA);
  // A's anchor state changes first at the identity transfer of T9 (STALE, then taken over), then at the retirement
  const untilA = ["T9.A.8004.transfer", "T9.A.aid.retire"];
  g.check("T7", "anchor.active.gate", states.every((s) => s === "ACTIVE") && afterBeat !== null && !/AnchorNotActive/.test(afterBeat), `states ${states.join("/")} after heartbeats; the same call now passes the gate and fails only inside the tender: ${afterBeat}`, untilA);
  // the default window again: the demonstration leaves no short window behind
  await A.execute("T7.A.aid.window.reset", k.aid.address, k.aid.encodeSetLivenessWindow(0));
  const restored = await k.aid.livenessWindow(A.address);
  g.check("T7", "anchor.window.restored", restored === defaultWindow, `livenessWindow(A) = ${restored} s after the reset (the registry's default)`, "T9.A.aid.retire");
  if (k.aid.backing) {
    const backingStates = await Promise.all([A, B, C].map((X) => k.aid.stateName(X.address, k.aid.backing!.address)));
    g.check("T7", "anchor.backing.active", backingStates.every((s) => s === "ACTIVE"), `states ${backingStates.join("/")} in the backing registry ${k.aid.backing.address} after heartbeats`, untilA);
  }

  k.evidence("T7", "safety", {
    binding: bindingId,
    binding2,
    tender: { tokenId: tokenId.toString(), completions: 2, reward: reward.toString() },
    suspension: { by: G, restrictions: Restriction.noNewRisk | Restriction.deriskOnly, response, reason },
    kernelDecision: k.fact("T7.kernel.decision") ?? null,
    bypass: k.fact("T7.bypass") ?? null,
    derisk: { action: "ADRFServiceEscrow.withdrawBalance", amount: earned.toString() },
    unattributed: k.fact("T7.unattributed"),
    attributed: { submissionId: subId.toString(), fulfiller: A.address },
    liveness: { demonstrationWindow: LIVENESS_DEMO_WINDOW, defaultWindow, backingRegistry: k.aid.backing?.address ?? null },
    txs: { suspend: k.store.get("T7.G.suspend")?.txHash, resume: k.store.get("T7.G.resume")?.txHash, operatorSubmit: rogue.txHash, submit: sub.txHash, window: k.store.get("T7.A.aid.window")?.txHash, heartbeats: [A, B, C].map((X) => k.store.get(`T7.${X.name}.aid.heartbeat`)?.txHash), windowReset: k.store.get("T7.A.aid.window.reset")?.txHash },
  });
}

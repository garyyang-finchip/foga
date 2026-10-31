import { join } from "node:path";
import { getAddress, parseEther } from "ethers";
import { TenderAdapterRef } from "../core/acdf.js";
import { dataUri, keccakJcs, sha256Hex } from "../core/canonical.js";
import { DecisionPoint, SwarmAccountRef, SwarmDecisionAdapterRef, SwarmTenderAdapterRef, packHashes } from "../core/swarm.js";
import { nativeTerms } from "../core/tenders.js";
import { extractVerifyFile } from "./extract.js";
import type { Genesis } from "./scenario.js";

/**
 * T5 — governance: collective acceptance, collective labour, collective decisions.
 *  (1) the swarm account submits the finch-extract-verify report to the judged tender of T4;
 *  (2) anyone opens the council's case; two judges approve; the round settles, the appeal window passes, the
 *      decision is Final; the adapter enacts acceptFulfillment and the swarm account is paid;
 *  (3) the workers amend the charter through the decision adapter (2 of 2);
 *  (4) a second judged tender ends without a decision: the adapter enacts nothing and the tender's own default
 *      path (claimUnjudged) pays the fulfiller after the judgment window;
 *  (5) the swarm tender adapter concludes the swarm ACHIEVED.
 */
export async function t5(g: Genesis): Promise<void> {
  const k = g.kernel;
  const W = "W";
  const A = g.cell("A");
  const B = g.cell("B");
  const C = g.cell("C");
  const chainId = g.chainId;
  const timing = g.timing;
  const tokenId = BigInt(k.requireFact<string>("T4.tokenId"));
  const swarmId = k.requireFact<string>("T4.swarmId");
  const extractSkill = k.requireFact<{ tokenId: string; packageHash: string }>("T2.skill.finch-extract-verify");
  const judges = ["J1", "J2", "J3"].map((j) => k.address(j));
  const adapter = new TenderAdapterRef(g.world, k.requireFact<string>("T0.acdf.tenderAdapter"));
  const account = new SwarmAccountRef(g.world, k.requireFact<string>("T4.swarmAccount"));
  const decision = new SwarmDecisionAdapterRef(g.world, k.requireFact<string>("T4.decisionAdapter"));
  const swarmTender = new SwarmTenderAdapterRef(g.world, g.world.address("8447/SwarmTenderAdapter"));
  const effects = await adapter.effects();

  // the judges are nobody's party: not the demander, not a member, not the swarm account, not an operator
  const parties = new Set([k.address(W), A.address, B.address, C.address, account.address, A.operatorAddress, B.operatorAddress, C.operatorAddress].map((a) => a.toLowerCase()));
  g.check("T5", "judges.independent", judges.every((j) => !parties.has(j.toLowerCase())), `J1-J3 are not the demander, a member, the swarm account or an operator`);

  // --- (1) the deliverable: the deterministic finch-extract-verify report over the pinned filing
  const run = extractVerifyFile(join(g.cfg.fixturesDir, "sample-filing.txt"), join(g.cfg.skillsDir, "finch-extract-verify", "fields.json"), extractSkill.packageHash);
  const resultHash = run.resultHash;
  k.setFact("T5.report", { resultHash, documentDigest: run.report.documentDigest, rules: run.report.rules });
  const submitCall = account.encodeExecute(k.tenders.address, 0n, k.tenders.encodeSubmit(tokenId, resultHash, dataUri(run.report)));
  const submit = await B.execute("T5.swarm.submit", account.address, submitCall);
  const submissionId = k.tenders.submissionIdFromReceipt(submit.receipt);
  k.setFact("T5.submissionId", submissionId.toString());
  const sub = await k.tenders.submissionOf(tokenId, submissionId);
  g.check("T5", "submission.bySwarmAccount", getAddress(sub.fulfiller) === getAddress(account.address) && sub.machineSettled === false, `submission ${submissionId}: fulfiller ${sub.fulfiller} (the swarm account, not a member), judged path`);
  const workerCannot = await g.wouldRevert(A, account.address, submitCall);
  g.check("T5", "represent.enforced", workerCannot !== null, `a worker driving the swarm account reverts: ${workerCannot}`);

  // --- (2) the council: open, two approvals, settle, appeal window, finalize, enact
  const open = await k.call("T5.open", W, adapter.address, adapter.iface, "open", [tokenId, submissionId]);
  const issueId = adapter.issueIdFromReceipt(open.receipt);
  k.setFact("T5.issueId", issueId);
  const round = await k.acdf.roundOf(issueId);
  const wrongRound = await g.wouldRevertCall(judges[2], k.acdf.registryAddress, k.acdf.encodeCastBallot(issueId, round + 1, 0, true));
  g.check("T5", "ballot.wrongRound.refused", wrongRound !== null, `a ballot for round ${round + 1} reverts: ${wrongRound}`);
  const nonJudge = await g.wouldRevertCall(k.address("E"), k.acdf.registryAddress, k.acdf.encodeCastBallot(issueId, round, 0, true));
  g.check("T5", "ballot.nonJudge.refused", nonJudge !== null, `a ballot by a non-judge reverts: ${nonJudge}`);
  const early = await g.wouldRevertCall(k.address(W), adapter.address, adapter.encodeExecute(issueId));
  g.check("T5", "execute.beforeFinal.refused", early !== null, `adapter.execute before Final reverts: ${early}`);

  await k.call("T5.J1.ballot", "J1", k.acdf.registryAddress, k.acdf.registry().interface, "castBallot", [issueId, round, 0, true]);
  await k.call("T5.J2.ballot", "J2", k.acdf.registryAddress, k.acdf.registry().interface, "castBallot", [issueId, round, 0, true]);
  await k.call("T5.settleRound", W, k.acdf.registryAddress, k.acdf.registry().interface, "settleRound", [issueId]);
  let result = await k.acdf.getResult(issueId);
  const settledState = result.stateName;
  if (result.stateName === "Provisional") {
    const r = await k.acdf.roundState(issueId, round);
    const now = await k.blockTimestamp();
    const wait = Number(r.appealOpenUntil) - now + 1;
    if (wait > 0) await k.advanceTime(wait, "appeal window of the council's decision");
    await k.call("T5.finalize", W, k.acdf.registryAddress, k.acdf.registry().interface, "finalize", [issueId]);
    result = await k.acdf.getResult(issueId);
  }
  g.check("T5", "council.final.yes", result.stateName === "Final" && result.outcomeName === "Decided" && result.outcomeYes && result.sourceRound === round, `settleRound -> ${settledState}; after the appeal window: ${result.stateName} ${result.outcomeName} yes=${result.outcomeYes} (round ${result.roundCount}, source ${result.sourceRound})`);

  const balanceBefore = await k.balance(account.address);
  await k.call("T5.execute", W, adapter.address, adapter.iface, "execute", [issueId]);
  const accepted = await k.tenders.submissionOf(tokenId, submissionId);
  const enacted = await k.acdf.enactment(issueId, adapter.address, effects.accept);
  const paid = (await k.balance(account.address)) - balanceBefore;
  const alreadySettled = k.store.get("T5.execute")?.status === "confirmed" && paid === 0n;
  g.check("T5", "fulfilment.accepted", accepted.status === 1 && enacted.statusName === "Enacted", `submission ${submissionId} status ${accepted.status} (1 = Accepted); enactment ${enacted.statusName} by ${enacted.reporter}`);
  if (!alreadySettled) g.check("T5", "swarmAccount.paid", paid === parseEther("0.002"), `the swarm account received ${paid} wei (reward 0.002 ETH); members received nothing directly`);
  else g.skipped("T5", "swarmAccount.paid", "replayed run: the payout was already made");
  const twice = await g.wouldRevertCall(k.address(W), adapter.address, adapter.encodeExecute(issueId));
  g.check("T5", "execute.twice.refused", twice !== null, `adapter.execute again reverts: ${twice}`);

  // --- (3) governance: the workers amend the charter through the decision adapter (2 of 2)
  const pack = k.requireFact<Record<string, unknown>>("T4.pack.document");
  const pack2 = { ...pack, version: 2, charter: { path: "charter.md", digest: `sha256:${sha256Hex("FOGA genesis swarm charter v2: the coordinator publishes the report package digest before submitting.").slice(2)}` }, prev: `sha256:${(k.requireFact<{ charterHash: string }>("T4.pack").charterHash).slice(2)}` };
  const h2 = packHashes(pack2);
  const amendCall = k.swarms.encodeAmend(swarmId, h2.charterHash, h2.charterURI);
  const roster = [A.address, C.address];
  const openGov = await B.execute("T5.gov.open", decision.address, decision.encodeOpen(swarmId, DecisionPoint.AMEND, amendCall, roster));
  const govIssue = decision.issueIdFromReceipt(openGov.receipt);
  k.setFact("T5.gov.issueId", govIssue);
  const govRound = await k.acdf.roundOf(govIssue);
  const outsider = await g.wouldRevert(B, k.acdf.registryAddress, k.acdf.encodeCastBallot(govIssue, govRound, 0, true));
  g.check("T5", "gov.coordinator.cannotVote", outsider !== null, `B (coordinator) voting on the workers' decision reverts: ${outsider}`);
  await A.execute("T5.gov.A.ballot", k.acdf.registryAddress, k.acdf.encodeCastBallot(govIssue, govRound, 0, true));
  await C.execute("T5.gov.C.ballot", k.acdf.registryAddress, k.acdf.encodeCastBallot(govIssue, govRound, 0, true));
  await k.call("T5.gov.settle", W, k.acdf.registryAddress, k.acdf.registry().interface, "settleRound", [govIssue]);
  const govResult = await k.acdf.getResult(govIssue);
  await k.call("T5.gov.execute", W, decision.address, decision.iface, "execute", [govIssue]);
  const amended = await k.swarms.getSwarm(swarmId);
  g.check("T5", "gov.amended", govResult.stateName === "Final" && govResult.outcomeYes && amended.charterHash === h2.charterHash && amended.charterVersion === 2 && amended.commitmentVersion === 1, `decision ${govResult.stateName} yes=${govResult.outcomeYes}; charterHash ${amended.charterHash.slice(0, 10)}… version ${amended.charterVersion} (commitment version ${amended.commitmentVersion}: not material)`);
  const proposal = await decision.proposal(govIssue);
  g.check("T5", "gov.enacted", proposal.enacted === true, `proposal ${govIssue.slice(0, 10)}… enacted through the registry as the AMEND authority`);

  // --- (4) no decision: one approval only, the window passes, the kernel's own default path pays
  const ndReward = parseEther("0.001");
  const ndTask = { schema: "foga.task/1", skill: "finch-extract-verify", packageHash: extractSkill.packageHash, input: { document: "scenarios/fixtures/sample-filing.txt", fields: "fields.json" }, acceptance: { mode: "judge", policy: "FOGA-Council", authority: adapter.address, judgmentWindow: timing.noDecisionJudgmentWindow }, note: "second judged tender: the council stays silent" };
  const ndMint = await k.call("T5.nd.mint", W, k.tenders.address, k.tenders.contract().interface, "mintTask", [k.address(W), k.address(W), adapter.address, keccakJcs({ td: "foga.task/1", skill: "finch-extract-verify", variant: "no-decision" }), sha256Hex(JSON.stringify(ndTask)), dataUri(ndTask), nativeTerms(ndReward, { judgmentWindow: BigInt(timing.noDecisionJudgmentWindow) })]);
  const ndToken = k.tenders.tokenIdFromReceipt(ndMint.receipt);
  k.setFact("T5.nd.tokenId", ndToken.toString());
  await k.call("T5.nd.fund", W, k.tenders.address, k.tenders.contract().interface, "fundTask", [ndToken, ndReward], ndReward);
  const ndSubmit = await B.execute("T5.nd.submit", account.address, account.encodeExecute(k.tenders.address, 0n, k.tenders.encodeSubmit(ndToken, resultHash, dataUri(run.report))));
  const ndSubmission = k.tenders.submissionIdFromReceipt(ndSubmit.receipt);
  k.setFact("T5.nd.submissionId", ndSubmission.toString());
  const ndOpen = await k.call("T5.nd.open", W, adapter.address, adapter.iface, "open", [ndToken, ndSubmission]);
  const ndIssue = adapter.issueIdFromReceipt(ndOpen.receipt);
  k.setFact("T5.nd.issueId", ndIssue);
  const ndRound = await k.acdf.roundOf(ndIssue);
  await k.call("T5.nd.J1.ballot", "J1", k.acdf.registryAddress, k.acdf.registry().interface, "castBallot", [ndIssue, ndRound, 0, true]);
  const ndState = await k.acdf.roundState(ndIssue, ndRound);
  const nowNd = await k.blockTimestamp();
  if (Number(ndState.deadline) >= nowNd) await k.advanceTime(Number(ndState.deadline) - nowNd + 1, "the council's window on the second tender passes with one approval");
  await k.call("T5.nd.settleRound", W, k.acdf.registryAddress, k.acdf.registry().interface, "settleRound", [ndIssue]);
  const ndResult = await k.acdf.getResult(ndIssue);
  g.check("T5", "nd.noDecision", ndResult.stateName === "Final" && ndResult.outcomeName === "NoDecision" && ndResult.reasonName === "QUORUM_NOT_MET", `one approval of three, window over: ${ndResult.stateName} ${ndResult.outcomeName} (${ndResult.reasonName})`);
  const ndExecute = await g.wouldRevertCall(k.address(W), adapter.address, adapter.encodeExecute(ndIssue));
  g.check("T5", "nd.adapter.inert", ndExecute !== null, `adapter.execute on a NoDecision reverts: ${ndExecute}`);
  const ndSub = await k.tenders.submissionOf(ndToken, ndSubmission);
  const claimAt = Number(ndSub.submittedAt) + timing.noDecisionJudgmentWindow;
  const nowClaim = await k.blockTimestamp();
  if (claimAt >= nowClaim) await k.advanceTime(claimAt - nowClaim + 1, "the tender's judgment window passes with no ruling");
  const ndBalanceBefore = await k.balance(account.address);
  await k.call("T5.nd.claimUnjudged", W, k.tenders.address, k.tenders.contract().interface, "claimUnjudged", [ndToken, ndSubmission]);
  const ndPaid = (await k.balance(account.address)) - ndBalanceBefore;
  const ndAfter = await k.tenders.submissionOf(ndToken, ndSubmission);
  const ndAlready = k.store.get("T5.nd.claimUnjudged")?.status === "confirmed" && ndPaid === 0n;
  g.check("T5", "nd.claimUnjudged", ndAfter.status === 1, `claimUnjudged after the judgment window: submission status ${ndAfter.status} (1 = Accepted) - silence pays the fulfiller`);
  if (!ndAlready) g.check("T5", "nd.paid", ndPaid === ndReward, `the swarm account received ${ndPaid} wei from the second tender`);
  else g.skipped("T5", "nd.paid", "replayed run: the payout was already made");

  // --- (5) the objective: the swarm tender adapter concludes ACHIEVED from the tender's own record
  await k.call("T5.swarmTender.settle", W, swarmTender.address, swarmTender.contract().interface, "settle", [swarmId, submissionId]);
  const concluded = await k.swarms.getSwarm(swarmId);
  g.check("T5", "swarm.achieved", concluded.stateName === "CONCLUDING" && concluded.outcomeName === "ACHIEVED" && concluded.resultHash === resultHash, `swarm ${concluded.stateName}, outcome ${concluded.outcomeName}, resultHash = the report's hash`);
  const members = await Promise.all(["A", "B", "C"].map((X) => k.swarms.memberStatus(swarmId, g.cell(X as "A" | "B" | "C").address)));
  const balances = await Promise.all(["A", "B", "C"].map((X) => k.balance(g.cell(X as "A" | "B" | "C").address)));

  k.evidence("T5", "governance", {
    tenderId: tokenId.toString(),
    submissionId: submissionId.toString(),
    resultHash,
    issueId,
    result: { state: result.stateName, outcome: result.outcomeName, yes: result.outcomeYes, roundCount: result.roundCount, sourceRound: result.sourceRound },
    enactment: enacted,
    swarmAccountPaid: paid.toString(),
    governance: { issueId: govIssue, roster, charterHashV2: h2.charterHash, charterVersion: amended.charterVersion, enacted: proposal.enacted },
    noDecision: { tenderId: ndToken.toString(), submissionId: ndSubmission.toString(), issueId: ndIssue, result: { state: ndResult.stateName, outcome: ndResult.outcomeName, reason: ndResult.reasonName }, claimedUnjudged: ndAfter.status === 1, paid: ndPaid.toString() },
    swarm: { state: concluded.stateName, outcome: concluded.outcomeName, members: members.map((m) => m.statusName), memberBalances: balances.map(String) },
    txs: { submit: submit.txHash, open: open.txHash, execute: k.store.get("T5.execute")?.txHash, govOpen: openGov.txHash, govExecute: k.store.get("T5.gov.execute")?.txHash, ndMint: ndMint.txHash, claimUnjudged: k.store.get("T5.nd.claimUnjudged")?.txHash, settle: k.store.get("T5.swarmTender.settle")?.txHash },
  });
}

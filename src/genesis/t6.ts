import { join } from "node:path";
import { getAddress, parseEther } from "ethers";
import { EFFECT_REFUND, Value, claims, declaredVersionInputs, declaredVersionProposition, addressParam } from "../core/adrf.js";
import { accountRef, keccakJcs } from "../core/canonical.js";
import { buildSkillPackage, readSkillDir } from "../core/pack/skillpack.js";
import type { Genesis } from "./scenario.js";

/**
 * T6 — dispute: a service call between cells, settled through the world's ADRFServiceEscrow (bound in T0 to
 * FOGA-Service-v1), ends in a ruling the escrow enacts within its own authority.
 *  (1) C deposits and opens a call against A for one run of finch-extract-verify, the terms committing A to the
 *      package version C evaluated (v1); A publishes v2 of the skill, delivers declaring v2 and charges the call;
 *      the charge is held for the dispute period.
 *  (2) C files: the decisive question "the version actually used matches the committed version" is JUDGED by
 *      FOGA-Council through the bridge; the informative FORMAL question "the declared version differs" is
 *      answered by the upstream verifier over the escrow's own records. Two judges find the proposition FALSE;
 *      the round settles, the appeal window passes, the bridge imports the Final result with its provenance;
 *      the registry decides Sustained, the review window passes, the ruling is Final and allows the refund.
 *  (3) The escrow enacts the refund once (the held charge goes back to C) and reports it; a second enactment is
 *      refused; nothing is ever released to A for that call.
 *  (4) The control case: a second call committed to v2, delivered as v2; the verifier finds no departure; after
 *      the dispute period the charge is released to A, which withdraws it to its account.
 * Negative cases: a third party has no standing to file; the respondent cannot file against itself; the same
 * contested point cannot be filed twice; the refund cannot be enacted twice.
 */
export async function t6(g: Genesis): Promise<void> {
  const k = g.kernel;
  const W = "W";
  const A = g.cell("A");
  const B = g.cell("B");
  const C = g.cell("C");
  const chainId = g.chainId;
  const timing = g.timing.service;
  const adrf = k.requireFact<{ policyId: string; bindingId: string; escrow: string }>("T0.adrf");
  const council = k.requireFact<{ policyId: string }>("T0.acdf.policy");
  const skill = k.requireFact<{ tokenId: string; mdHash: string; packageHash: string }>("T2.skill.finch-extract-verify");
  const tokenId = BigInt(skill.tokenId);
  const escrow = k.adrf.escrowAddress;
  const price = parseEther("0.0005");
  const deposit = parseEther("0.002");

  // the judges are nobody's party here either
  const judges = ["J1", "J2", "J3"].map((j) => k.address(j));
  const parties = new Set([k.address(W), A.address, B.address, C.address, A.operatorAddress, C.operatorAddress].map((a) => a.toLowerCase()));
  g.check("T6", "judges.independent", judges.every((j) => !parties.has(j.toLowerCase())), `J1-J3 are neither client, provider, operator nor world operator of the call`);

  // --- (1) the call, committed to v1; then v2 is published and delivered
  const terms = { kind: "service-terms", service: "finch-extract-verify", provider: accountRef(chainId, A.address), client: accountRef(chainId, C.address), price: `${price} wei per call`, committedVersion: skill.packageHash, deliverable: "a finch.extract-verify/1 report over the client's pinned document", clause: "the service runs the committed skill version", disputePeriod: timing.disputePeriod };
  const termsHash = keccakJcs(terms);
  k.setFact("T6.terms", { termsHash, terms });

  const depositDone = k.store.get("T6.C.escrow.deposit")?.status === "confirmed";
  const cBalanceBefore = await k.adrf.escrowBalanceOf(C.address);
  await C.execute("T6.C.escrow.deposit", escrow, k.adrf.encodeDeposit(), { value: deposit });
  if (!depositDone) {
    const after = await k.adrf.escrowBalanceOf(C.address);
    g.check("T6", "C.deposited", after - cBalanceBefore === deposit, `C's escrow balance rose by ${after - cBalanceBefore} wei`);
  } else g.skipped("T6", "C.deposited", "replayed run: the deposit was already made");
  const open1 = await C.execute("T6.C.call1.open", escrow, k.adrf.encodeOpenCall(A.address, price, termsHash, skill.packageHash, timing.disputePeriod));
  const call1 = k.adrf.callIdFromReceipt(open1.receipt);
  k.setFact("T6.call1.id", call1.toString());

  // A publishes v2 of the skill: the same package with a new manifest version and a changelog note
  const v2 = await k.memo("T6.skill.v2", async () => {
    const files = { ...readSkillDir(join(g.cfg.skillsDir, "finch-extract-verify")) };
    const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
    manifest.skillVersion = "1.1.0";
    files["manifest.json"] = new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
    files["SKILL.md"] = new Uint8Array(Buffer.concat([Buffer.from(files["SKILL.md"]), Buffer.from("\n## Changes in 1.1.0\n\nEvidence spans now carry the line number of the quote in addition to the page.\n")]));
    const pkg = buildSkillPackage(files, { version: 2, previousPackageHash: skill.packageHash });
    return { mdHash: pkg.mdHash, packageHash: pkg.packageHash, rootCid: pkg.rootCid, version: pkg.version };
  });
  const v2Pkg = { mdHash: v2.mdHash, packageHash: v2.packageHash } as any;
  await A.execute("T6.A.skill.v2.update", k.skills.address, k.skills.encodeUpdate(tokenId, v2Pkg));
  const onchain = await k.skills.skillOf(tokenId);
  g.check("T6", "skill.v2", onchain.packageHash === v2.packageHash && onchain.version === 2n, `skillOf(${tokenId}) = {packageHash ${v2.packageHash.slice(0, 10)}…, v${onchain.version}}; the call was committed to v1 ${skill.packageHash.slice(0, 10)}…`);

  const deliver1 = await A.execute("T6.A.call1.deliver", escrow, k.adrf.encodeDeliver(call1, v2.packageHash));
  const settle1Done = k.store.get("T6.A.call1.settle")?.status === "confirmed";
  await A.execute("T6.A.call1.settle", escrow, k.adrf.encodeSettle(call1));
  const call1State = await k.adrf.call(call1);
  const held1 = await k.adrf.heldOf(call1);
  g.check("T6", "call1.held", call1State.committedVersion === skill.packageHash && call1State.declaredVersion === v2.packageHash && held1 === price, `call ${call1}: committed v1, declared v2, ${held1} wei held for ${timing.disputePeriod} s`, "T6.C.call1.enact");
  if (!settle1Done) g.check("T6", "call1.charged", (await k.adrf.escrowBalanceOf(C.address)) === deposit - price, `C's escrow balance is ${deposit - price} wei after the charge`, "T6.C.call1.enact");
  else g.skipped("T6", "call1.charged", "replayed run: the charge was already made");

  // --- (2) the case
  const object = await k.adrf.objectOf(call1);
  const caseDocument = {
    kind: "adrf-case",
    object: { ref: { chainId: object.chainId.toString(), target: object.target.toLowerCase(), id: object.id.toString(), versionHash: object.versionHash }, description: `service call ${call1} of the escrow, terms committing finch-extract-verify v1` },
    event: { eventRef: "delivery", description: `the delivery of call ${call1}` },
    claim: { statement: "The service did not run the committed version of finch-extract-verify.", decisive: 1, supportsWhen: "FALSE" },
    rules: { normRef: termsHash, clause: "the service runs the committed skill version", obligationKind: "result", policy: "FOGA-Service-v1" },
    aiRelation: "which version of an agent skill produced the deliverable of a service call",
    subjects: { claimant: accountRef(chainId, C.address), respondent: accountRef(chainId, A.address), roles: [{ account: accountRef(chainId, C.address), role: "client" }, { account: accountRef(chainId, A.address), role: "provider (obligor of the version commitment)" }] },
    authorization: { effectClass: "Binding", acceptanceMode: "PRE_COMMIT", acceptedBy: "the escrow, for all its calls, at binding time (T0)" },
    evidence: { scope: "the run receipt of the delivery and the skill token's commitments at delivery time", provision: "on chain (ERC-8338 skillOf, the escrow's declared version) and the provider's run receipt", verifiers: "FOGA-Council" },
    context: { committed: ["finch-extract-verify v1 (terms)"], declared: ["finch-extract-verify v2 (provider declaration at delivery)"], toEstablish: ["the version actually used for the call"] },
    effects: { requested: ["adrf:effect/refund"], onSustained: "adrf:effect/refund", onNotSustained: null, fallbackRef: "adrf:disposition/status-quo", atMost: `${price} wei` },
    subQuestions: [
      { index: 0, statement: "The version the provider declared at delivery differs from the committed version.", qType: "FORMAL", method: "DeclaredVersionVerifier over the escrow" },
      { index: 1, statement: "The version actually used for the call matches the committed version.", qType: "JUDGED", method: "FOGA-Council through the ADRF/ACDF bridge" },
    ],
  };
  const evidenceScopeHash = keccakJcs({ scope: caseDocument.evidence });
  const claim = claims.versionCommitment({ object, escrow, callId: call1, termsHash, provider: A.address, documentHash: keccakJcs(caseDocument), evidenceScopeHash });
  k.setFact("T6.caseDocument", caseDocument);

  // negatives at the door: a third party has no standing; the respondent cannot file against itself
  const stranger = await g.wouldRevert(B, k.adrf.registryAddress, k.adrf.encodeFile(adrf.bindingId, claim));
  g.check("T6", "file.stranger.refused", stranger !== null, `B (no party to the call) filing reverts: ${stranger}`);
  const selfClaim = await g.wouldRevert(A, k.adrf.registryAddress, k.adrf.encodeFile(adrf.bindingId, claim));
  g.check("T6", "file.respondent.refused", selfClaim !== null, `A filing against itself reverts: ${selfClaim}`);

  const filed = await C.execute("T6.C.call1.file", k.adrf.registryAddress, k.adrf.encodeFile(adrf.bindingId, claim));
  const caseId = k.adrf.caseIdFromReceipt(filed.receipt);
  k.setFact("T6.caseId", caseId);
  const header = await k.adrf.getCase(caseId);
  const clock = await k.adrf.getClock(caseId);
  g.check("T6", "case.admitted", header.stateName === "Admitted" && header.effectClass === 1 && getAddress(header.source) === getAddress(escrow) && header.bindingId === adrf.bindingId && getAddress(header.claimant) === getAddress(C.address) && getAddress(header.respondent) === getAddress(A.address), `case ${caseId.slice(0, 10)}…: ${header.stateName}, Binding, source = the escrow, claimant C, respondent A; decision by ${clock.decisionDeadline}, hard deadline ${clock.hardDeadline}`, "T6.call1.decide");
  const duplicate = await g.wouldRevert(C, k.adrf.registryAddress, k.adrf.encodeFile(adrf.bindingId, claim));
  g.check("T6", "file.duplicate.refused", duplicate !== null, `the same contested point filed again reverts: ${duplicate}`);

  // the formal question: anyone runs the verifier over the pinned inputs
  await k.call("T6.call1.resolveFormal", W, k.adrf.registryAddress, k.adrf.registry().interface, "resolveFormal", [caseId, 0, declaredVersionInputs(call1)]);
  const formal = await k.adrf.getFinding(caseId, 0);
  g.check("T6", "finding.declared", formal.resolved && formal.valueName === "TRUE" && formal.supportKinds === 2 && getAddress(formal.acceptedBy) === getAddress(k.adrf.versionVerifierAddress), `sub-question 0 (declared version differs) = ${formal.valueName}, COMPUTED by the DeclaredVersionVerifier`);

  // the judged question: the bridge files the council's issue; two judges find the proposition FALSE
  await k.call("T6.call1.openJudgment", W, k.adrf.registryAddress, k.adrf.registry().interface, "openJudgment", [caseId, 1]);
  const issueId = await k.adrf.issueOf(caseId, 1);
  k.setFact("T6.issueId", issueId);
  const issue = await k.acdf.registry().getIssue(issueId);
  g.check("T6", "judgment.opened", issue.policyId === council.policyId && getAddress(issue.consumer) === getAddress(k.adrf.bridgeAddress) && Number(issue.consumerDeadline) === clock.decisionDeadline, `issue ${issueId.slice(0, 10)}… under FOGA-Council, consumer = the bridge, consumer deadline = the case's decision deadline`);
  const round = await k.acdf.roundOf(issueId);
  await k.call("T6.call1.J1.ballot", "J1", k.acdf.registryAddress, k.acdf.registry().interface, "castBallot", [issueId, round, 0, false]);
  await k.call("T6.call1.J2.ballot", "J2", k.acdf.registryAddress, k.acdf.registry().interface, "castBallot", [issueId, round, 0, false]);
  await k.call("T6.call1.acdf.settleRound", W, k.acdf.registryAddress, k.acdf.registry().interface, "settleRound", [issueId]);
  const roundState = await k.acdf.roundState(issueId, round);
  const provisional = await k.acdf.getResult(issueId);
  if (provisional.stateName === "Provisional") {
    const now = await k.blockTimestamp();
    const wait = Number(roundState.appealOpenUntil) - now + 1;
    if (wait > 0) await k.advanceTime(wait, "appeal window of the council's finding on the delivered version");
    await k.call("T6.call1.acdf.finalize", W, k.acdf.registryAddress, k.acdf.registry().interface, "finalize", [issueId]);
  }
  const result = await k.acdf.getResult(issueId);
  g.check("T6", "council.final", result.stateName === "Final" && result.outcomeName === "Decided" && result.outcomeYes === false, `FOGA-Council: ${result.stateName} ${result.outcomeName}, proposition "actual version matches" held ${result.outcomeYes} (2 of 3 against)`);

  const importDone = k.store.get("T6.call1.import")?.status === "confirmed";
  if (!importDone) {
    const early = await g.wouldRevertCall(k.address(W), k.adrf.registryAddress, k.adrf.registry().interface.encodeFunctionData("decide", [caseId]));
    g.check("T6", "decide.early.refused", early !== null, `deciding before the judged finding exists reverts: ${early}`);
  } else g.skipped("T6", "decide.early.refused", "replayed run: the judged finding was already imported");
  await k.call("T6.call1.import", W, k.adrf.bridgeAddress, k.adrf.bridge().interface, "importResult", [caseId, 1]);
  const judged = await k.adrf.getFinding(caseId, 1);
  g.check("T6", "finding.judged", judged.resolved && judged.valueName === "FALSE" && judged.supportKinds === 8 && getAddress(judged.acceptedBy) === getAddress(k.adrf.bridgeAddress) && judged.issueId === issueId, `sub-question 1 (actual version matches) = ${judged.valueName}, JUDGED, provenance issue ${judged.issueId.slice(0, 10)}…`);

  await k.call("T6.call1.decide", W, k.adrf.registryAddress, k.adrf.registry().interface, "decide", [caseId]);
  const afterDecide = await k.adrf.getCase(caseId);
  if (afterDecide.stateName === "Provisional") {
    const c = await k.adrf.getClock(caseId);
    const now = await k.blockTimestamp();
    const early = await g.wouldRevertCall(k.address(W), k.adrf.registryAddress, k.adrf.registry().interface.encodeFunctionData("finalize", [caseId]));
    g.check("T6", "finalize.early.refused", early !== null, `finalizing inside the review window reverts: ${early}`);
    if (c.reviewOpenUntil >= now) await k.advanceTime(c.reviewOpenUntil - now + 1, "review window of the dispute's round decision");
    await k.call("T6.call1.finalize", W, k.adrf.registryAddress, k.adrf.registry().interface, "finalize", [caseId]);
  } else g.skipped("T6", "finalize.early.refused", "replayed run: the case was already finalized");
  const ruling = await k.adrf.getRuling(caseId);
  g.check("T6", "ruling.sustained", ruling.stateName === "Final" && ruling.resultName === "Sustained" && ruling.allowedEffect === EFFECT_REFUND && ruling.closureName === "REVIEW_LAPSED" && ruling.judgmentIssueId === issueId, `ruling: ${ruling.stateName} ${ruling.resultName}, allowed effect = refund, closure ${ruling.closureName}, judgment provenance = the council's issue`);

  // --- (3) enactment by the escrow, within its own authority, once
  const enactDone = k.store.get("T6.C.call1.enact")?.status === "confirmed";
  const cBefore = await k.adrf.escrowBalanceOf(C.address);
  await C.execute("T6.C.call1.enact", escrow, k.adrf.encodeEnact(caseId, EFFECT_REFUND));
  const cAfter = await k.adrf.escrowBalanceOf(C.address);
  if (!enactDone) g.check("T6", "refund.enacted", cAfter - cBefore === price, `C's escrow balance rose by ${cAfter - cBefore} wei: the held charge went back`);
  else g.skipped("T6", "refund.enacted", "replayed run: the refund was already enacted");
  const s1 = await k.adrf.settlementOf(call1, 1);
  const enactment = await k.adrf.getEnactment(caseId, EFFECT_REFUND);
  g.check("T6", "refund.reported", s1.stateName === "Refunded" && enactment.statusName === "Enacted" && getAddress(enactment.reporter) === getAddress(escrow) && (await k.adrf.heldOf(call1)) === 0n, `settlement 1 of call ${call1} is ${s1.stateName}; the registry records ${enactment.statusName} by the escrow; nothing held`);
  const again = await g.wouldRevert(C, escrow, k.adrf.encodeEnact(caseId, EFFECT_REFUND));
  g.check("T6", "refund.twice.refused", again !== null, `a second enactment reverts: ${again}`);
  const aEscrow = await k.adrf.escrowBalanceOf(A.address);
  g.check("T6", "provider.unpaid", aEscrow === 0n, `A's escrow balance is ${aEscrow} wei: the disputed charge was never released`);

  // --- (4) the control case: a call committed to v2, delivered as v2, released after the dispute period
  const open2 = await C.execute("T6.C.call2.open", escrow, k.adrf.encodeOpenCall(A.address, price, termsHash, v2.packageHash, timing.disputePeriod));
  const call2 = k.adrf.callIdFromReceipt(open2.receipt);
  k.setFact("T6.call2.id", call2.toString());
  await A.execute("T6.A.call2.deliver", escrow, k.adrf.encodeDeliver(call2, v2.packageHash));
  await A.execute("T6.A.call2.settle", escrow, k.adrf.encodeSettle(call2));
  const verdict = await g.world.contract("8471/DeclaredVersionVerifier").verify(declaredVersionProposition(escrow, call2), addressParam(escrow), declaredVersionInputs(call2));
  g.check("T6", "call2.conforms", Number(verdict.value) === Value.FALSE, `DeclaredVersionVerifier on call ${call2}: "declared differs" = ${["UNDETERMINED", "TRUE", "FALSE"][Number(verdict.value)]} (declared v2 = committed v2)`);
  const s2 = await k.adrf.settlementOf(call2, 1);
  const releaseAt = s2.at + timing.disputePeriod;
  const now2 = await k.blockTimestamp();
  if (s2.stateName === "Held" && releaseAt >= now2) await k.advanceTime(releaseAt - now2 + 1, "the dispute period of the undisputed call");
  await k.call("T6.call2.release", W, escrow, k.adrf.escrow().interface, "release", [call2]);
  const s2After = await k.adrf.settlementOf(call2, 1);
  const aEscrowAfter = await k.adrf.escrowBalanceOf(A.address);
  g.check("T6", "call2.released", s2After.stateName === "Released" && aEscrowAfter === price, `settlement 1 of call ${call2} is ${s2After.stateName}; A's escrow balance ${aEscrowAfter} wei`, "T7.A.derisk.withdraw");

  // A's earnings stay in the escrow for now: T7 brings them home under a suspension (a de-risk action)
  const cRest = await k.adrf.escrowBalanceOf(C.address);
  if (cRest > 0n) await C.execute("T6.C.escrow.withdraw", escrow, k.adrf.encodeWithdrawBalance(cRest));
  g.check("T6", "balances.settled", (await k.adrf.escrowBalanceOf(C.address)) === 0n && aEscrowAfter === price, `C withdrew its balance (paid for one conforming call, refunded the disputed one); A's ${price} wei stay in the escrow until T7`, "T7.A.derisk.withdraw");

  k.evidence("T6", "dispute", {
    escrow,
    policyId: adrf.policyId,
    bindingId: adrf.bindingId,
    terms: { termsHash, committedVersion: skill.packageHash, declaredVersion: v2.packageHash, price: price.toString(), disputePeriod: timing.disputePeriod },
    skillV2: v2,
    call1: call1.toString(),
    caseId,
    caseDocumentHash: keccakJcs(caseDocument),
    findings: { declaredVersionDiffers: formal.valueName, actualVersionMatches: judged.valueName },
    council: { issueId, policyId: council.policyId, ballots: { J1: false, J2: false }, result: `${result.outcomeName} ${result.outcomeYes}` },
    ruling: { state: ruling.stateName, result: ruling.resultName, allowedEffect: ruling.allowedEffect, closure: ruling.closureName },
    enactment: { effect: "adrf:effect/refund", status: enactment.statusName, reporter: enactment.reporter, settlement: s1.stateName },
    call2: { id: call2.toString(), committedVersion: v2.packageHash, settlement: s2After.stateName },
    txs: { open1: open1.txHash, deliver1: deliver1.txHash, settle1: k.store.get("T6.A.call1.settle")?.txHash, file: filed.txHash, resolveFormal: k.store.get("T6.call1.resolveFormal")?.txHash, openJudgment: k.store.get("T6.call1.openJudgment")?.txHash, import: k.store.get("T6.call1.import")?.txHash, decide: k.store.get("T6.call1.decide")?.txHash, finalize: k.store.get("T6.call1.finalize")?.txHash, enact: k.store.get("T6.C.call1.enact")?.txHash, open2: open2.txHash, release2: k.store.get("T6.call2.release")?.txHash },
  });
}

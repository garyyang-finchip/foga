import { getAddress, parseEther } from "ethers";
import { kindId, taskDescriptor } from "../core/ard.js";
import { accountRef, dataUri, dataUriJcs, keccakJcs, sha256Hex, jcs } from "../core/canonical.js";
import { accountSubject } from "../core/kya.js";
import { Activation, Admission, Boundary, Contributions, DecisionPoint, ObjectiveKind, SwarmAccountRef, authorities, byAddress, byRole, bytes32Label, initiator, none, originKind, packHashes, roleId, specHashOf, taskOriginRef, term, type SwarmSpec } from "../core/swarm.js";
import { nativeTerms } from "../core/tenders.js";
import type { UnitRef } from "../core/units.js";
import { CELLS } from "./roles.js";
import type { Genesis } from "./scenario.js";

export const ROLE_COORDINATOR = roleId("coordinator");
export const ROLE_WORKER = roleId("worker");

/**
 * T4 — organization. The judged tender the swarm will fulfil is minted first (the objective binds to it); the
 * eligibility modules that need a scheme id are deployed; B forms the swarm, A and C join as workers through
 * their accounts, the roster is met, the swarm account is bound, and the swarm becomes an AUF unit containing
 * the members' units at pinned versions. Negative cases: an ineligible candidate is refused; a revoked assertion
 * suspends a member on challenge and a fresh one reinstates it.
 */
export async function t4(g: Genesis): Promise<void> {
  const k = g.kernel;
  const W = "W";
  const A = g.cell("A");
  const B = g.cell("B");
  const C = g.cell("C");
  const chainId = g.chainId;
  const sAtt = k.requireFact<{ schemeId: string }>("T0.kya.S_att").schemeId;
  const tenderAdapter = k.requireFact<string>("T0.acdf.tenderAdapter");
  const extractSkill = k.requireFact<{ tokenId: string; packageHash: string }>("T2.skill.finch-extract-verify");
  const timing = g.timing;

  // --- 1. the judged tender, by W as demander: acceptance by the council through FOGA's adapter
  const reward = parseEther("0.002");
  const settleBy = await k.memo("T4.settleBy", async () => (await k.blockTimestamp()) + 14 * 86400);
  const documentDigest = sha256Hex(jcs({ fixture: "scenarios/fixtures/sample-filing.txt" }));
  const task = {
    schema: "foga.task/1",
    skill: "finch-extract-verify",
    packageHash: extractSkill.packageHash,
    input: { document: "scenarios/fixtures/sample-filing.txt", fields: "fields.json" },
    acceptance: { mode: "judge", policy: "FOGA-Council", authority: tenderAdapter, judgmentWindow: timing.judgmentWindow },
    deliverable: "a finch.extract-verify/1 report over the pinned document; resultHash = sha256(JCS(report))",
    documentRef: documentDigest,
  };
  const taskHash = sha256Hex(JSON.stringify(task));
  const taskURI = dataUri(task);
  const mint = await k.call("T4.D.mint", W, k.tenders.address, k.tenders.contract().interface, "mintTask", [k.address(W), k.address(W), tenderAdapter, keccakJcs({ td: "foga.task/1", skill: "finch-extract-verify" }), taskHash, taskURI, nativeTerms(reward, { settleBy: BigInt(settleBy), judgmentWindow: BigInt(timing.judgmentWindow) })]);
  const tokenId = k.tenders.tokenIdFromReceipt(mint.receipt);
  k.setFact("T4.tokenId", tokenId.toString());
  await k.call("T4.D.fund", W, k.tenders.address, k.tenders.contract().interface, "fundTask", [tokenId, reward], reward);
  const taskDesc = taskDescriptor({
    chainId,
    demander: k.address(W),
    slug: `extract-verify-${tokenId}`,
    name: `finch-extract-verify over the pinned filing (tender ${tokenId})`,
    wants: "a structured extraction with consistency verdicts over the pinned document, judged by the FOGA-Council",
    taskHash,
    taskURI,
    bounty: { amount: "0.002", currency: "ETH", asset: `eip155:${chainId}/slip44:60` },
    acceptance: { mode: "judge", ref: accountRef(chainId, tenderAdapter) },
    settleBy,
    judgmentWindow: `PT${timing.judgmentWindow}S`,
  });
  const taskRec = await k.call("T4.D.ard", W, k.ard.address, k.ard.contract().interface, "register", [kindId("task"), k.tenders.address, tokenId, k.ard.publication(taskDesc).descriptorHash, k.ard.publication(taskDesc).descriptorURI, k.ard.publication(taskDesc).urn]);
  k.setFact("T4.recordId", k.ard.recordIdFromReceipt(taskRec.receipt));
  // On a resumed run the later steps have already moved the chain on; checks on states they change are made
  // only while those operations are still ahead (the end-state checks of T5 cover them afterwards).
  const t5Executed = k.store.get("T5.execute")?.status === "confirmed";
  const t5Settled = k.store.get("T5.swarmTender.settle")?.status === "confirmed";
  const reinstateDone = k.store.get("T4.challenge.C.reinstate")?.status === "confirmed";
  const auth = await k.tenders.acceptanceAuthorityOf(tokenId);
  const escrow = await k.tenders.escrowBalanceOf(tokenId);
  g.check("T4", "tender.judged", getAddress(auth) === getAddress(tenderAdapter) && (t5Executed || escrow === reward), `tender ${tokenId}: acceptance authority ${auth}, escrow ${escrow} wei${t5Executed ? " (already paid out in T5)" : ""}`);

  // --- 2. eligibility: a registered agent, an ACTIVE anchor, standing >= 2 from W; all three required
  const assertionLevel = await k.deploy("T4.deploy.assertionLevel", W, "swarm-ai-framework:AssertionLevelEligibility", [k.kya.registryAddress, sAtt, 2, [k.address(W)]]);
  const composite = await k.deploy("T4.deploy.composite", W, "swarm-ai-framework:CompositeEligibility", [[g.world.address("8447/ERC8004Eligibility"), g.world.address("8447/IdentityStateEligibility"), assertionLevel.address], true]);
  k.setFact("T4.eligibility", { assertionLevel: assertionLevel.address, composite: composite.address });
  const erc8004Elig = g.world.contract("8447/ERC8004Eligibility");
  for (const X of CELLS) {
    const cell = g.cell(X);
    const agentId = BigInt(k.requireFact<string>(`T1.${X}.agentId`));
    await cell.execute(`T4.${X}.declareAgent`, g.world.address("8447/ERC8004Eligibility"), erc8004Elig.interface.encodeFunctionData("declareAgent", [agentId]));
  }
  const compositeContract = g.world.at("swarm-ai-framework:CompositeEligibility", composite.address);
  const eligible = await Promise.all(CELLS.map((X) => compositeContract.isEligible("0x" + "00".repeat(32), ROLE_WORKER, g.cell(X).address)));
  g.check("T4", "eligibility.members", eligible.every(Boolean), `CompositeEligibility(requireAll: 8004 agent, AID ACTIVE, S_att >= 2 from W) = ${eligible.join(",")} for A, B, C`, "T9.A.aid.retire");
  const strangerEligible = await compositeContract.isEligible("0x" + "00".repeat(32), ROLE_WORKER, k.address("E"));
  g.check("T4", "eligibility.stranger", strangerEligible === false, `a plain account without identity or standing is not eligible (${strangerEligible})`);

  // --- 3. the decision adapter the workers decide amendments through (2 of 2 workers)
  const decision = await k.deploy("T4.deploy.decisionAdapter", W, "swarm-ai-framework:SwarmDecisionAdapter", [k.swarms.address, k.acdf.registryAddress, ROLE_WORKER, 2, 2, timing.governanceWindow, timing.margin]);
  k.setFact("T4.decisionAdapter", decision.address);
  g.world.attach("foga/SwarmDecisionAdapter", decision.address, "swarm-ai-framework:SwarmDecisionAdapter");
  // the coordinator opens decisions on it (T5): B's owner widens the operator's scope to this one selector
  await B.admin("T4.B.scope.decisionAdapter.open", "setOperatorAllowed", [decision.address, g.world.ifaceOf("swarm-ai-framework:SwarmDecisionAdapter").getFunction("open")!.selector, true]);

  // --- 4. the spec and the pack
  const phase = { name: "execution", payoff: "sai.payoff.shared", topology: "sai.topology.partitioned", coordination: "sai.coordination.collective", boundary: "OPEN", admission: "RECRUIT", inputWindow: 0, description: "The coordinator splits the extraction into field groups; each worker owns a group and records its contribution; the coordinator assembles the report and submits it from the swarm account." };
  const roles = [
    { roleId: ROLE_COORDINATOR, name: "sai.role.coordinator", description: "Forms the swarm, binds the swarm account, submits the fulfilment from it (REPRESENT), settles the objective", eligibility: { module: composite.address, description: "registered agent, ACTIVE anchor, S_att >= 2 from W" } },
    { roleId: ROLE_WORKER, name: "sai.role.worker", description: "Owns a field group of the extraction; two workers decide charter amendments through the decision adapter", eligibility: { module: composite.address, description: "registered agent, ACTIVE anchor, S_att >= 2 from W" } },
  ];
  const packBase = {
    version: 1,
    origin: { kind: "sai.origin.task", ref: taskOriginRef(chainId, k.tenders.address, tokenId), description: `Formed by cell B to fulfil task tender ${tokenId}` },
    charter: { path: "charter.md", digest: `sha256:${sha256Hex("FOGA genesis swarm charter v1: three cells, one judged tender, shared payoff, collective coordination.").slice(2)}` },
    objective: {
      kind: "TERMINAL",
      goal: `Deliver the accepted fulfilment of task tender ${tokenId}: the finch-extract-verify report over the pinned filing.`,
      preconditions: ["The tender is funded for one completion", "Every member holds S_att >= 2 from W"],
      successCriteria: ["The swarm account's submission is accepted by the FOGA-Council through the tender adapter"],
      acceptance: { kind: "obligation", authority: g.world.address("8447/SwarmTenderAdapter"), obligation: { chainId, target: k.tenders.address, id: tokenId.toString() }, description: "The swarm tender adapter concludes ACHIEVED when the tender records the swarm account's submission as Accepted." },
      amendmentRule: "Charter text changes are decided by the workers (2 of 2) through the decision adapter; objective and allocation changes are material and open the exit window.",
    },
    commitment: {
      allocation: [{ phase: "execution", rule: "equal", params: { coordinator: 1, worker: 1 }, description: "The reward stays in the swarm account in this version; allocation inside the swarm is the account's business." }],
      costs: ["Gas of each member's own transactions"],
      liabilities: ["No bond; a seat left before conclusion earns nothing"],
      dataAccess: ["Every member receives the pinned filing"],
      externalActions: ["The coordinator submits the fulfilment to the tender from the swarm account"],
    },
    mode: { namedProfile: "cooperation", phases: [phase] },
    roles,
    resources: [],
    prev: null,
  };
  const spec: SwarmSpec = {
    roles: [
      { roleId: ROLE_COORDINATOR, min: 1, max: 1, eligibility: composite.address, selfJoin: true },
      { roleId: ROLE_WORKER, min: 2, max: 3, eligibility: composite.address, selfJoin: true },
    ],
    phases: [{ name: bytes32Label("execution"), payoff: term.payoff("shared"), topology: term.topology("partitioned"), coordination: term.coordination("collective"), boundary: Boundary.OPEN, admission: Admission.RECRUIT, inputWindow: 0, descriptorHash: sha256Hex(jcs(phase)) }],
    authorities: authorities({
      ACTIVATE: none,
      ABORT: initiator,
      SUSPEND: initiator,
      RESUME: initiator,
      ADVANCE: none,
      CONCLUDE: initiator,
      DISSOLVE: initiator,
      SUCCEED: none,
      ADMIT: initiator,
      REMOVE: initiator,
      REINSTATE: initiator,
      AMEND: byAddress(decision.address),
      ATTACH: initiator,
      DETACH: initiator,
      SET_ACCOUNT: initiator,
      REPRESENT: byRole(ROLE_COORDINATOR),
    }),
    activation: Activation.ROSTER_MET,
    contributions: Contributions.MEMBERS,
    minMembers: 3,
    maxMembers: 4,
    recruitmentWindow: 7 * 86400,
    maxDuration: 30 * 86400,
    inactivityTimeout: 0,
    ineligibleGrace: 86400,
    settlementWindow: 7 * 86400,
    amendmentExitWindow: 86400,
    descriptorHash: sha256Hex(jcs({ roles, mode: packBase.mode })),
  };
  const specHash = specHashOf(spec);
  const pack = { ...packBase, specHash };
  const hashes = packHashes(pack);
  k.setFact("T4.pack", { specHash, ...hashes, charterURI: undefined });
  k.setFact("T4.pack.document", pack);

  // --- 5. B forms, everyone joins through their accounts, anyone activates once the roster is met
  const form = await B.execute("T4.B.form", k.swarms.address, k.swarms.encodeForm(spec, hashes.charterHash, hashes.commitmentHash, hashes.charterURI, { kind: originKind("task"), ref: taskOriginRef(chainId, k.tenders.address, tokenId) }, { objectiveHash: hashes.objectiveHash, kind: ObjectiveKind.TERMINAL, acceptanceAuthority: g.world.address("8447/SwarmTenderAdapter"), obligation: { chainId, target: k.tenders.address, id: tokenId }, milestoneCount: 0 }));
  const swarmId = k.swarms.swarmIdFromReceipt(form.receipt);
  k.setFact("T4.swarmId", swarmId);
  const onchainSpecHash = (await k.swarms.getSwarm(swarmId)).specHash;
  g.check("T4", "swarm.specHash", onchainSpecHash === specHash, `specHash ${specHash.slice(0, 10)}… = keccak256(abi.encode(spec)) computed off-chain`);

  await B.execute("T4.B.join", k.swarms.address, k.swarms.encodeJoin(swarmId, ROLE_COORDINATOR, hashes.charterHash));
  await A.execute("T4.A.join", k.swarms.address, k.swarms.encodeJoin(swarmId, ROLE_WORKER, hashes.charterHash));
  await C.execute("T4.C.join", k.swarms.address, k.swarms.encodeJoin(swarmId, ROLE_WORKER, hashes.charterHash));
  const met = await k.swarms.rosterMet(swarmId);
  g.check("T4", "swarm.rosterMet", met === true, `rosterMet after three joins = ${met}`);
  await k.call("T4.activate", W, k.swarms.address, k.swarms.contract().interface, "activate", [swarmId]);

  // --- 6. the swarm account: deployed, bound by the initiator, and a commitment-class target for B
  const account = await k.deploy("T4.deploy.swarmAccount", W, "swarm-ai-framework:SwarmAccount", [k.swarms.address, swarmId, B.address]);
  k.setFact("T4.swarmAccount", account.address);
  g.world.attach("foga/SwarmAccount", account.address, "swarm-ai-framework:SwarmAccount");
  await B.execute("T4.B.setAccount", k.swarms.address, k.swarms.encodeSetAccount(swarmId, account.address));
  const swarmAccount = new SwarmAccountRef(g.world, account.address);
  await B.admin("T4.B.scope.swarmAccount.execute", "setOperatorAllowed", [account.address, swarmAccount.executeSelector, true]);
  await B.admin("T4.B.class.swarmAccount.execute", "setCommitmentClass", [account.address, swarmAccount.executeSelector, true]);

  // --- 7. the swarm's economic boundary: a unit containing the members' units at their pinned versions
  const contains: UnitRef[] = [];
  for (const X of CELLS) {
    const unitId = BigInt(k.requireFact<string>(`T1.${X}.unitId`));
    contains.push({ unitId, version: await k.units.latestVersion(unitId) });
  }
  const unitDef = {
    auf: "1.0" as const,
    kind: "unit-definition" as const,
    unit: { name: "FOGA genesis swarm", summary: "Three cells cooperating on one judged tender; the swarm account is the economic boundary", tags: ["foga", "swarm"] },
    elements: [
      { kind: "agent", ref: accountRef(chainId, account.address), label: "swarm account" },
      { kind: "financial-position", ref: accountRef(chainId, account.address), label: "swarm account balance" },
    ],
    relations: [{ type: "holds", from: "unit", to: accountRef(chainId, account.address), quantity: { amount: "0", unit: "ETH" }, scope: "native balance of the swarm account" }],
    ports: [{ id: "funds-in", direction: "in", class: "funds", template: "auf:port:funds-in@1", asset: `eip155:${chainId}/slip44:60`, account: accountRef(chainId, account.address), conditions: "tender rewards accepted for the swarm" }],
    authorities: { definitionController: accountRef(chainId, B.address), settlementAccounts: [accountRef(chainId, account.address)] },
  };
  const unit = await B.execute("T4.B.unit", k.units.registryAddress, k.units.encodeRegisterUnit(B.address, unitDef, contains));
  const unitId = k.units.unitIdFromReceipt(unit.receipt);
  k.setFact("T4.unitId", unitId.toString());

  // --- checks (memo T4 "expected")
  const statuses = await Promise.all(CELLS.map((X) => k.swarms.memberStatus(swarmId, g.cell(X).address)));
  g.check("T4", "members.active", statuses.every((s) => s.statusName === "ACTIVE"), `memberStatus A, B, C = ${statuses.map((s) => s.statusName).join(", ")}`);
  const swarm = await k.swarms.getSwarm(swarmId);
  const stateOk = t5Settled ? swarm.stateName === "CONCLUDING" : swarm.stateName === "ACTIVE";
  g.check("T4", "swarm.active", stateOk && getAddress(swarm.account) === getAddress(account.address) && getAddress(swarm.initiator) === getAddress(B.address), `swarm ${swarmId.slice(0, 10)}… ${swarm.stateName}, account ${swarm.account}, initiator ${swarm.initiator}`);
  const represent = await k.swarms.isAuthorized(swarmId, DecisionPoint.REPRESENT, B.address);
  const representA = await k.swarms.isAuthorized(swarmId, DecisionPoint.REPRESENT, A.address);
  g.check("T4", "represent.coordinator", represent === true && representA === false, `REPRESENT: B (coordinator) ${represent}, A (worker) ${representA}`);
  const contained = await Promise.all(contains.map((_, i) => k.units.registry().containedAt(unitId, 1, i)));
  g.check("T4", "unit.containment", contained.length === 3 && contained.every((c: any, i) => BigInt(c[0] ?? c.unitId) === contains[i].unitId && Number(c[1] ?? c.version) === contains[i].version), `swarm unit ${unitId} contains ${contains.map((c) => `${c.unitId}@v${c.version}`).join(", ")}`);
  const seatEpochs = await Promise.all(CELLS.map((X) => k.swarms.seatEpoch(swarmId, g.cell(X).address)));

  // --- negatives: an ineligible candidate; a revoked assertion suspends on challenge, a fresh one reinstates
  const strangerJoin = await g.wouldRevertCall(k.address("E"), k.swarms.address, k.swarms.encodeJoin(swarmId, ROLE_WORKER, hashes.charterHash));
  g.check("T4", "join.ineligible.refused", strangerJoin !== null, `E (no identity, no standing) joining as worker reverts: ${strangerJoin}`);

  const cAssertion = k.requireFact<string>("T1.C.assertionId");
  await k.call("T4.W.revoke.C", W, k.kya.registryAddress, k.kya.registry().interface, "revoke", [cAssertion, 1]);
  // challenge treats a module's `false` with too little gas left as unevaluable (anti-starvation rule), so the
  // gas limit is set explicitly rather than taken from an estimate that stops at the first non-reverting path
  await k.call("T4.challenge.C.suspend", W, k.swarms.address, k.swarms.contract().interface, "challenge", [swarmId, C.address], 0n, "call", 600_000n);
  if (!reinstateDone) {
    const suspended = await k.swarms.member(swarmId, C.address);
    const suspendedStatus = await k.swarms.memberStatus(swarmId, C.address);
    g.check("T4", "challenge.suspends", suspendedStatus.statusName === "SUSPENDED" && suspended.suspensionName === "INELIGIBLE", `after W revokes C's S_att assertion, challenge(swarm, C) -> ${suspendedStatus.statusName} (${suspended.suspensionName})`);
    const stillRoster = await k.swarms.rosterMet(swarmId);
    g.check("T4", "roster.under.suspension", stillRoster === false, `rosterMet with one worker suspended = ${stillRoster} (the roster is lost, the swarm is not: enforceRoster is anyone's call, not taken here)`);
  } else {
    g.skipped("T4", "challenge.suspends", "replayed run: C was already reinstated");
    g.skipped("T4", "roster.under.suspension", "replayed run: C was already reinstated");
  }

  const claim = { scheme: "S_att", level: 2, subject: accountRef(chainId, C.address), basis: "re-attested after review; operates under FOGA-Cell-v1" };
  const expiresAt = await k.memo("T4.C.reattest.expiresAt", async () => (await k.blockTimestamp()) + 365 * 86400);
  const re = await k.call("T4.W.reattest.C", W, k.kya.registryAddress, k.kya.registry().interface, "attest", [accountSubject(chainId, C.address), sAtt, 2, keccakJcs(claim), expiresAt, dataUriJcs(claim), keccakJcs(claim)]);
  k.setFact("T4.C.assertionId", k.kya.assertionIdFromReceipt(re.receipt));
  await k.call("T4.challenge.C.reinstate", W, k.swarms.address, k.swarms.contract().interface, "challenge", [swarmId, C.address], 0n, "call", 600_000n);
  const reinstated = await k.swarms.memberStatus(swarmId, C.address);
  g.check("T4", "challenge.reinstates", reinstated.statusName === "ACTIVE" && (await k.swarms.rosterMet(swarmId)) === true, `after a fresh assertion, challenge(swarm, C) -> ${reinstated.statusName}; rosterMet again`);

  k.evidence("T4", "swarm", {
    tenderId: tokenId.toString(),
    tenderAdapter,
    eligibility: { assertionLevel: assertionLevel.address, composite: composite.address },
    decisionAdapter: decision.address,
    swarmId,
    specHash,
    charterHash: hashes.charterHash,
    objectiveHash: hashes.objectiveHash,
    commitmentHash: hashes.commitmentHash,
    swarmAccount: account.address,
    unitId: unitId.toString(),
    contains: contains.map((c) => ({ unitId: c.unitId.toString(), version: c.version })),
    seatEpochs: Object.fromEntries(CELLS.map((X, i) => [X, seatEpochs[i].toString()])),
    members: Object.fromEntries(CELLS.map((X) => [X, g.cell(X).address])),
    negatives: { strangerJoin, suspendedThenReinstated: "C" },
    txs: { mint: mint.txHash, form: form.txHash, unit: unit.txHash },
  });
}

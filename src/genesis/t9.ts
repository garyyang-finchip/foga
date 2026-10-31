import { getAddress } from "ethers";
import { AID, type AIDDocument } from "../core/aid.js";
import { agentDescriptor, kindId, recordIdOf } from "../core/ard.js";
import { Enforcement, Rights, accountSubjectKey, oneClause, scopeKeyOf } from "../core/asf.js";
import { accountRef, dataUri, keccakJcs } from "../core/canonical.js";
import { accountSubject } from "../core/kya.js";
import { cellUnitDefinition } from "../core/units.js";
import { Cell } from "../kernel/cell.js";
import type { Genesis } from "./scenario.js";

/**
 * T9 — succession: an identity moves to a new body while the old one is still in full possession of its keys.
 *  (9a) The owner deploys A-prime and configures it as a cell (operator, AID registry, classes); nothing executes
 *       before A-prime presents its own safety binding (the old binding is A's). A transfers its ERC-8004 agent to
 *       A-prime through its account; A's anchor turns STALE (the binding predicate no longer holds); A-prime binds
 *       (takeover: the stale binding does not hold the agent hostage) and is ACTIVE; A retires naming A-prime as
 *       successor; A-prime publishes a new ARD agent record and its own AID document. Failure cases: A-prime
 *       binding before it holds the identity; a retirement acts only on its sender (no delegated form).
 *  (9b) A transfers its finch-extract-verify skill token to A-prime; the ARD skill record's controller follows the
 *       token, the record is no longer adopted (committed by a former controller) until A-prime recommits the
 *       same descriptor hash.
 *  (9c) Nothing else is inherited: A-prime has no KYA standing (A's assertions are A's), no swarm seat, no unit,
 *       no binding of A's; A cannot make commitment-class calls once RETIRED; the successor pointer links the two
 *       histories without merging them.
 *  (9d) Key loss is documented, not demonstrated: with the guarded profile the owner rotates the operator and the
 *       anchor stays; a lost anchor key under a lite profile cannot retire and the address stays STALE forever.
 */
export async function t9(g: Genesis): Promise<void> {
  const k = g.kernel;
  const A = g.cell("A");
  const chainId = g.chainId;
  const G = k.address("G");
  const spec = k.requireFact<{ specId: string; version: number; contentHash: string }>("T0.asf.spec");
  const sAtt = k.requireFact<{ schemeId: string }>("T0.kya.S_att").schemeId;
  const agentId = BigInt(k.requireFact<string>("T1.A.agentId"));
  const skill = k.requireFact<{ tokenId: string; recordId: string; packageHash: string }>("T2.skill.finch-extract-verify");
  const swarmId = k.requireFact<string>("T4.swarmId");
  const roles = { owner: A.roles.owner, operator: A.roles.operator, guardian: G };

  // --- (9a) the new body
  const prime = await Cell.deploy(k, {
    key: "T9.Aprime.deploy",
    name: "A-prime",
    roles,
    requirement: (predicted) =>
      oneClause({
        specRegistry: k.asf.specRegistryAddress,
        specId: spec.specId,
        versions: [spec.version],
        adopter: predicted,
        subjectKey: accountSubjectKey(chainId, predicted),
        scopeKey: scopeKeyOf({ ref: accountRef(chainId, predicted) }),
        enforcement: Enforcement.account | Enforcement.contract,
        interveners: [{ account: G, rights: Rights.suspend | Rights.resume }],
      }),
  });
  k.setFact("T9.Aprime.address", prime.address);
  g.log(`  A-prime: account ${prime.address} (same owner and operator keys as A)`);
  if (g.world.file.network === "anvil") await k.transfer("T9.Aprime.fund", "W", prime.address, 10n ** 16n);
  await prime.admin("T9.Aprime.setOperator", "setOperator", [prime.operatorAddress, 0, 10n ** 16n]);
  await prime.admin("T9.Aprime.setAIDRegistry", "setAIDRegistry", [k.aid.address]);
  const tasks = k.tenders.contract().interface;
  await prime.admin("T9.Aprime.class.8414.submitFulfillment", "setCommitmentClass", [k.tenders.address, g.selector(tasks, "submitFulfillment"), true]);

  // the binding is A's, not A-prime's: nothing executes before A-prime presents its own
  const bindCall = k.aid.encodeBind(k.identity.address, agentId);
  const adopted = k.store.get("T9.Aprime.adopt")?.status === "confirmed";
  if (!adopted) {
    const unbound = await g.wouldRevert(prime, k.aid.address, bindCall);
    g.check("T9", "inherit.binding.refused", unbound !== null && /BindingsNotPresented/.test(unbound), `A-prime executing before presenting a binding reverts: ${unbound}`);
  } else g.skipped("T9", "inherit.binding.refused", "replayed run: A-prime already presents its binding");
  const params = { profile: "foga-cell/1", cell: "A-prime", successorOf: accountRef(chainId, A.address) };
  const authority = { kind: "owner", owner: accountRef(chainId, prime.ownerAddress), guardian: accountRef(chainId, G) };
  const input = k.asf.cellBindingInput({ chainId, cell: prime.address, specId: spec.specId, version: spec.version, contentHash: spec.contentHash, guardian: G, params, authority });
  const { bindingId: primeBinding } = await prime.adoptBinding("T9.Aprime.adopt", input, 0);
  k.setFact("T9.Aprime.bindingId", primeBinding);
  const primeStatus = await prime.status();
  g.check("T9", "Aprime.binding", primeStatus.verdictName === "Satisfied", `A-prime adopted its own binding ${primeBinding.slice(0, 10)}…: status() = ${primeStatus.verdictName}`);

  // before the identity moves: A-prime cannot bind what it does not hold
  const transferred = k.store.get("T9.A.8004.transfer")?.status === "confirmed";
  if (!transferred) {
    const premature = await g.wouldRevert(prime, k.aid.address, bindCall);
    g.check("T9", "bind.premature.refused", premature !== null && /NotAgentOfAnchor/.test(premature), `A-prime binding agent ${agentId} before holding it reverts: ${premature}`);
    const stateBefore = await k.aid.stateName(A.address);
    g.check("T9", "A.active.before", stateBefore === "ACTIVE", `state(A) = ${stateBefore} before the transfer`);
  } else {
    g.skipped("T9", "bind.premature.refused", "replayed run: the identity was already transferred");
    g.skipped("T9", "A.active.before", "replayed run: the identity was already transferred");
  }

  // the identity moves through A's own account
  const transfer = await A.execute("T9.A.8004.transfer", k.identity.address, k.identity.encodeTransfer(A.address, prime.address, agentId));
  const ownerNow = await k.identity.contract().ownerOf(agentId);
  const taken = k.store.get("T9.Aprime.aid.bind")?.status === "confirmed";
  if (!taken) {
    const stale = await k.aid.stateName(A.address);
    g.check("T9", "A.stale", getAddress(ownerNow) === getAddress(prime.address) && stale === "STALE", `ownerOf(${agentId}) = A-prime; state(A) = ${stale}: the binding predicate no longer holds`);
  } else g.skipped("T9", "A.stale", "replayed run: A-prime already took the binding over");

  // takeover: the stale binding does not hold the agent hostage
  const bind = await prime.execute("T9.Aprime.aid.bind", k.aid.address, bindCall);
  const anchorNow: string = await k.aid.contract().anchorOf(k.identity.address, agentId);
  const primeState = await k.aid.stateName(prime.address);
  const aBinding = await k.aid.bindingOf(A.address);
  g.check("T9", "Aprime.active", getAddress(anchorNow) === getAddress(prime.address) && primeState === "ACTIVE" && aBinding.registry === "0x0000000000000000000000000000000000000000", `anchorOf(agent ${agentId}) = A-prime, state(A-prime) = ${primeState}; A's binding record is cleared by the takeover`);

  // retirement: only the anchor itself, naming its successor
  const retireFn = k.aid.contract().interface.getFunction("retire");
  g.check("T9", "retire.noDelegate", retireFn !== null && retireFn.inputs.length === 1 && retireFn.inputs[0].name === "successor", `retire(successor) acts on msg.sender only: there is no form by which a third party retires A`);
  await A.execute("T9.A.aid.retire", k.aid.address, k.aid.encodeRetire(prime.address));
  const aState = await k.aid.stateName(A.address);
  const successor: string = await k.aid.contract().successorOf(A.address);
  g.check("T9", "A.retired", aState === "RETIRED" && getAddress(successor) === getAddress(prime.address), `state(A) = ${aState}, successorOf(A) = ${successor}`);
  const afterRetire = await g.wouldRevert(A, k.aid.address, k.aid.encodeHeartbeat());
  g.check("T9", "A.retired.final", afterRetire !== null, `a retired anchor cannot heartbeat again: ${afterRetire}`);

  // the new record and document of A-prime: a new agent, linked to the old one by the successor pointer only
  const registration = { type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1", name: "FOGA cell A-prime", description: "The successor body of cell A of the Finch OG Agent genesis; the ERC-8004 agent moved here from A", services: [], supportedTrust: ["reputation"], "x-foga": { cell: "A-prime", anchor: accountRef(chainId, prime.address), predecessor: accountRef(chainId, A.address), binding: primeBinding } };
  const descriptor = agentDescriptor({ chainId, anchor: prime.address, slug: "cell-a-prime", name: "FOGA cell A-prime", description: registration.description, capabilities: ["erc8414:fulfiller", "erc8338:holder"], registration: { registry: `eip155:${chainId}:${k.identity.address.toLowerCase()}`, agentId: agentId.toString() } });
  const ard = await prime.execute("T9.Aprime.ard.register", k.ard.address, k.ard.encodeRegister(kindId("agent"), prime.address, 0n, descriptor));
  const primeRecord = k.ard.recordIdFromReceipt(ard.receipt);
  k.setFact("T9.Aprime.recordId", primeRecord);
  const oldRecord = k.requireFact<string>("T1.A.recordId");
  const [newBacked, oldBacked] = await Promise.all([k.ard.backed(primeRecord), k.ard.backed(oldRecord)]);
  g.check("T9", "Aprime.record", newBacked && primeRecord !== oldRecord && primeRecord === recordIdOf(chainId, prime.address, 0n), `A-prime's agent record ${primeRecord.slice(0, 10)}… (anchor (${chainId}, A-prime, 0)) is backed; A's record ${oldRecord.slice(0, 10)}… is a different record, backed = ${oldBacked} (its anchor is retired)`);
  const doc: AIDDocument = {
    version: "aid-document/v1",
    aid: accountRef(chainId, prime.address),
    did: `did:aid:${accountRef(chainId, prime.address)}`,
    binding: { registry: k.identity.address, agentId: Number(agentId) },
    livenessWindow: Number(g.world.file.params.aid.defaultLivenessWindow),
    facets: [{ facetType: "aid:core/identity/v1", provenance: "SELF", issuer: accountRef(chainId, prime.address), validUntil: 0, digest: keccakJcs(registration), access: { mode: "PUBLIC" }, resolver: { kind: "erc8004-identity", chainId, registry: k.identity.address, agentId: Number(agentId) } }],
  };
  const commitment = AID.documentCommitment(doc);
  await prime.execute("T9.Aprime.aid.document", k.aid.address, k.aid.encodeSetDocumentURI(commitment.uri, commitment.digest));
  const published = await k.aid.documentURI(prime.address);
  g.check("T9", "Aprime.document", published.digest === commitment.digest, `documentURI(A-prime).digest = ${commitment.digest.slice(0, 10)}… (its own document; A's standing facet is not carried over)`);

  // --- (9b) the skill moves; its record follows the token and is adopted again by recommitment
  const tokenId = BigInt(skill.tokenId);
  await A.execute("T9.A.skill.transfer", k.skills.address, k.skills.encodeSafeTransfer(A.address, prime.address, tokenId));
  const skillOwner = await k.skills.ownerOf(tokenId);
  const controller = await k.ard.controllerOf(skill.recordId);
  const adoptedNow = await k.ard.isAdopted(skill.recordId);
  const recommitted = k.store.get("T9.Aprime.skill.adopt")?.status === "confirmed";
  g.check("T9", "skill.transferred", getAddress(skillOwner) === getAddress(prime.address) && getAddress(controller) === getAddress(prime.address) && (recommitted || adoptedNow === false), `ownerOf(${tokenId}) = A-prime; the ARD skill record's controller follows the token (${controller}); adopted = ${adoptedNow}${recommitted ? " (already recommitted in an earlier run)" : " until the new controller recommits"}`);
  const rec = await k.ard.recordOf(skill.recordId);
  await prime.execute("T9.Aprime.skill.adopt", k.ard.address, k.ard.encodeRecommit(skill.recordId, rec));
  const adoptedAfter = await k.ard.isAdopted(skill.recordId);
  const recAfter = await k.ard.recordOf(skill.recordId);
  g.check("T9", "skill.adopted", adoptedAfter && getAddress(recAfter.attestor) === getAddress(prime.address) && recAfter.descriptorHash === rec.descriptorHash, `A-prime recommitted the same descriptor hash ${rec.descriptorHash.slice(0, 10)}…: attestor = controller = A-prime, adopted = ${adoptedAfter}`);

  // --- (9c) nothing else is inherited
  const standing = await k.kya.check(accountSubject(chainId, prime.address), sAtt, 2, [k.address("W")]);
  const standingA = await k.kya.check(accountSubject(chainId, A.address), sAtt, 2, [k.address("W")]);
  g.check("T9", "inherit.kya.none", standing === false && standingA === true, `check({account, A-prime}, S_att, 2, [W]) = ${standing}; A's own assertion still resolves for A (${standingA}): standing is the subject's, not the agent's`);
  const seat = await k.swarms.memberStatus(swarmId, prime.address);
  const seatA = await k.swarms.memberStatus(swarmId, A.address);
  g.check("T9", "inherit.swarm.none", seat.statusName === "NONE" && seatA.statusName !== "NONE", `swarm seat: A-prime ${seat.statusName}, A ${seatA.statusName}: the seat stays with the account that joined`);
  const primeUnits = (await Promise.all([k.units.controllerOf(BigInt(k.requireFact<string>("T1.A.unitId")))])).map((c) => getAddress(c));
  g.check("T9", "inherit.unit.none", primeUnits[0] === getAddress(A.address), `A's unit ${k.requireFact<string>("T1.A.unitId")} is still controlled by A; A-prime registers its own`);
  const unitDef = cellUnitDefinition({ chainId, cell: prime.address, name: "FOGA cell A-prime" });
  const unit = await prime.execute("T9.Aprime.auf.unit", k.units.registryAddress, k.units.encodeRegisterUnit(prime.address, unitDef, []));
  const primeUnit = k.units.unitIdFromReceipt(unit.receipt);
  k.setFact("T9.Aprime.unitId", primeUnit.toString());
  const retiredGate = await g.wouldRevert(A, k.tenders.address, k.tenders.encodeSubmit(BigInt(k.requireFact<string>("T7.tokenId")), "0x" + "11".repeat(32), "retired"));
  g.check("T9", "A.retired.gate", retiredGate !== null && /AnchorNotActive/.test(retiredGate), `a commitment-class call by the retired A reverts at the gate: ${retiredGate}`);
  const primeBindings = await prime.presentedBindings();
  const aBindings = await A.presentedBindings();
  g.check("T9", "histories.separate", getAddress(successor) === getAddress(prime.address) && !primeBindings.includes(aBindings[0]) && primeRecord !== oldRecord, `successorOf(A) points at A-prime; A-prime's bindings, record and unit are its own: two histories, one pointer`);

  k.evidence("T9", "succession", {
    A: { account: A.address, state: aState, successor, record: oldRecord, bindings: aBindings },
    Aprime: { account: prime.address, owner: prime.ownerAddress, operator: prime.operatorAddress, state: primeState, binding: primeBinding, record: primeRecord, unitId: primeUnit.toString(), documentDigest: commitment.digest },
    agentId: agentId.toString(),
    skill: { tokenId: skill.tokenId, recordId: skill.recordId, owner: skillOwner, adopted: adoptedAfter },
    notInherited: ["KYA assertions (S_att level of A)", "swarm seat", "AUF unit", "ASF binding", "AID document facets"],
    keyLoss: "documented in docs/genesis.md (9d): guarded profile rotates the operator under the same anchor; a lost anchor key under a lite profile cannot retire and stays STALE",
    txs: { deploy: k.store.get("T9.Aprime.deploy")?.txHash, adopt: k.store.get("T9.Aprime.adopt")?.txHash, transfer: transfer.txHash, bind: bind.txHash, retire: k.store.get("T9.A.aid.retire")?.txHash, record: ard.txHash, skillTransfer: k.store.get("T9.A.skill.transfer")?.txHash, skillAdopt: k.store.get("T9.Aprime.skill.adopt")?.txHash, unit: unit.txHash },
  });
}

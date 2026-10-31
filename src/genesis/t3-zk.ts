import { keccak256 } from "ethers";
import { abi, accountRef, dataUriJcs, keccakJcs } from "../core/canonical.js";
import { accountSubject, subjectKey } from "../core/kya.js";
import type { Cell } from "../kernel/cell.js";
import type { Genesis } from "./scenario.js";
import { PREDICATE_WINDOW, epochFor, proverSecretFrom, sourceKeyFrom, zk, type SignedRecord } from "./zk.js";

/**
 * T3 (end), the predicate-pattern proved path for cell A, right after its first accepted completion: the source
 * (W's node, which indexes completions) signs a record of the settlement; A proves under S_pred that at least
 * one record about it, signed by a source of the committed set, is Accepted inside the last 30 days, for this
 * registry's admission domain, the current epoch and a challenge chosen by the relying party; the registry
 * records the assertion with FOGA's predicate adapter as issuer and the source set root as anchor. The chain
 * never sees the record. Negative cases: the same proof again (nullifier spent), the proof for another subject,
 * the proof under another scheme, a rule the records do not satisfy (K = 2 with one completion: the circuit
 * says 0 and the adapter refuses), the result bit flipped outside the proof, a proof for a stale epoch.
 */
export async function predicateProof(g: Genesis, cell: Cell, completion: { tokenId: bigint; submissionId: bigint; settledAt: number }): Promise<void> {
  const k = g.kernel;
  const X = cell.name;
  const sPredFact = k.requireFact<{ schemeId: string; verifier: string; groth16: string; sourceSetRoot: string; pinned: boolean; zk: "on" | "off" }>("T0.kya.S_pred");
  if (sPredFact.zk !== "on") {
    g.skipped("T3", `${X}.kya.S_pred`, "the predicate proving material is not in this store (T0.zk.predicate = off)");
    return;
  }
  const sPred = sPredFact.schemeId;
  const adapter = sPredFact.verifier;
  const set = k.requireFact<{ root: string; sources: { pub: [string, string]; leaf: string }[] }>("T0.kya.sourceSet");
  const sourcePrv = sourceKeyFrom(k.signer("W").privateKey, "completions");
  const subject = accountSubject(g.chainId, cell.address);
  const key = subjectKey(subject);
  const secret = proverSecretFrom(k.signer(cell.roles.operator).privateKey, sPred);

  // The record of the completion, as the source identifies it: the top 128 bits of keccak256(chainId, TaskToken,
  // tokenId, submissionId), status 1 (Accepted), the settlement's block time. Signed once; the chain never sees it.
  const record = await k.memo<SignedRecord>(`T3.${X}.kya.S_pred.record`, async () => {
    const ref = BigInt(keccak256(abi.encode(["uint256", "address", "uint256", "uint256"], [g.chainId, k.tenders.address, completion.tokenId, completion.submissionId]))) >> 128n;
    const r = { taskRef: "0x" + ref.toString(16).padStart(32, "0"), status: 1, timestamp: completion.settledAt };
    const signed = await zk.signRecord(sourcePrv, key, r);
    return { ...r, sig: signed.sig };
  });

  // The rule's parameters are chosen by the relying party (here the genesis, for the registry): a challenge
  // binding the request, the window and K. They are disclosed; the records are not.
  const admissionDomain: string = await k.kya.admissionDomain();
  const rule = await k.memo(`T3.${X}.kya.S_pred.rule`, async () => {
    const t1 = await k.blockTimestamp();
    return { challenge: keccakJcs({ purpose: "foga.kya.predicate.challenge/1", relyingParty: k.kya.registryAddress, subject: accountRef(g.chainId, cell.address), tender: completion.tokenId.toString(), submission: completion.submissionId.toString() }), t0: t1 - PREDICATE_WINDOW, t1, k: 1 };
  });
  const prove = (p: { k: number; epoch: bigint; label: string }) =>
    k.memo(`T3.${X}.kya.S_pred.proof.${p.label}`, async () => {
      const started = Date.now();
      const r = await zk.provePredicate({ sourcePubs: set.sources.map((s) => s.pub), sourcePub: set.sources[0].pub, subjectKey: key, records: [record], challenge: rule.challenge, t0: rule.t0, t1: rule.t1, k: p.k, schemeId: sPred, epoch: p.epoch, admissionDomain, secret });
      g.log(`  ${X}: Groth16 proof for S_pred (${p.label}) in ${Date.now() - started} ms: k = ${p.k}, count ${r.count}, result ${r.result}, epoch ${p.epoch}, local verification ${r.verified}`);
      return { publicInputs: r.publicInputs, proof: r.proof, nullifier: r.nullifier, result: r.result, count: r.count, verified: r.verified, epoch: p.epoch.toString() };
    });

  const epoch = epochFor(await k.blockTimestamp());
  const shown = await prove({ k: rule.k, epoch, label: "k1" });
  g.check("T3", `${X}.kya.S_pred.prover`, shown.result === 1 && shown.count === 1 && shown.verified === true, `the prover counts ${shown.count} accepted completion(s) in [t0, t1], result ${shown.result} for k = ${rule.k}; the proof verifies locally against the committed verification key`);

  const evidence = dataUriJcs({ scheme: "S_pred", pattern: "predicate (kya-predicate-count-v1)", rule: { challenge: rule.challenge, t0: rule.t0, t1: rule.t1, k: rule.k }, sourceSetRoot: set.root, epoch: shown.epoch, nullifier: shown.nullifier });
  const op = await cell.execute(`T3.${X}.kya.attestWithProof`, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sPred, shown.publicInputs, shown.proof, evidence));
  const assertionId = k.kya.assertionIdFromReceipt(op.receipt);
  k.setFact(`T3.${X}.kya.S_pred.assertionId`, assertionId);

  const passes = await k.kya.check(subject, sPred, 1, [adapter]);
  g.check("T3", `${X}.kya.S_pred.shown`, passes === true, `check({account, ${X}}, S_pred, 1, [adapter]) = ${passes}; issuer of record is FOGA's predicate adapter (valid 30 days)`, `T7.${X}.aid.heartbeat`);
  const a = await k.kya.getAssertion(assertionId);
  const expectedDigest = keccak256(abi.encode(["bytes32", "uint64", "uint64", "uint16", "bytes32"], [rule.challenge, rule.t0, rule.t1, rule.k, set.root]));
  g.check("T3", `${X}.kya.S_pred.assertion`, a.anchor === set.root && a.claimDigest === expectedDigest && a.level === 1 && a.expiresAt > a.issuedAt, `assertion ${assertionId.slice(0, 10)}…: level ${a.level}, anchor = source set root, claimDigest = keccak(challenge, t0, t1, k, root), expires ${a.expiresAt - a.issuedAt} s after issuance`);
  const used = await k.kya.isNullifierUsed(sPred, shown.nullifier);
  g.check("T3", `${X}.kya.S_pred.nullifier`, used === true, `isNullifierUsed(S_pred, ${shown.nullifier.slice(0, 10)}…) = ${used}`);

  // negatives on the recorded proof
  const replay = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sPred, shown.publicInputs, shown.proof, evidence));
  g.check("T3", `${X}.kya.S_pred.replay.refused`, replay !== null, `the same proof again reverts: ${replay}`);
  const wrongSubject = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(accountSubject(g.chainId, k.address("G")), sPred, shown.publicInputs, shown.proof, evidence));
  g.check("T3", `${X}.kya.S_pred.subject.refused`, wrongSubject !== null, `the proof presented for another subject reverts: ${wrongSubject}`);
  const sCred = k.requireFact<{ schemeId: string }>("T0.kya.S_cred").schemeId;
  const wrongScheme = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sCred, shown.publicInputs, shown.proof, evidence));
  g.check("T3", `${X}.kya.S_pred.scheme.refused`, wrongScheme !== null, `the proof presented under S_cred reverts: ${wrongScheme}`);

  // a rule the records do not satisfy: k = 2 with one completion. The circuit outputs result 0 and the adapter
  // refuses to record a false predicate; flipping the result bit outside the proof fails verification.
  const below = await prove({ k: 2, epoch, label: "k2" });
  g.check("T3", `${X}.kya.S_pred.below.prover`, below.result === 0 && below.count === 1, `for k = 2 the circuit reports result ${below.result} over ${below.count} accepted completion(s)`);
  const belowRefused = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sPred, below.publicInputs, below.proof, evidence));
  g.check("T3", `${X}.kya.S_pred.below.refused`, belowRefused !== null, `a proof whose result is 0 reverts: ${belowRefused}`);
  const flipped = flipResult(below.publicInputs);
  const flippedRefused = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sPred, flipped, below.proof, evidence));
  g.check("T3", `${X}.kya.S_pred.flipped.refused`, flippedRefused !== null, `the same proof with the result bit set to 1 outside the circuit reverts: ${flippedRefused}`);

  // a proof for an epoch outside the adapter's grace is refused before any nullifier is spent
  const stale = await prove({ k: rule.k, epoch: epoch - 2n, label: "stale" });
  const staleRefused = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sPred, stale.publicInputs, stale.proof, evidence));
  g.check("T3", `${X}.kya.S_pred.epoch.refused`, staleRefused !== null, `a proof for epoch ${stale.epoch} (current - 2) reverts: ${staleRefused}`);

  k.evidence("T3", `${X}.S_pred`, {
    schemeId: sPred,
    adapter,
    groth16: sPredFact.groth16,
    sourceSetRoot: set.root,
    rule: { challenge: rule.challenge, t0: rule.t0, t1: rule.t1, k: rule.k },
    records: { count: 1, taskRef: record.taskRef, settledAt: record.timestamp, note: "signed by the source; present only in the prover's input, never on chain" },
    epoch: shown.epoch,
    nullifier: shown.nullifier,
    assertionId,
    publicInputs: shown.publicInputs,
    tx: op.txHash,
  });
}

/** The same public inputs with the result byte set to 1 (what a prover would have to forge to record a false predicate). */
function flipResult(publicInputs: string): string {
  const types = ["bytes32", "bytes32", "bytes32", "uint64", "uint64", "uint16", "bytes32", "uint64", "uint8"];
  const v = abi.decode(types, publicInputs);
  return abi.encode(types, [v[0], v[1], v[2], v[3], v[4], v[5], v[6], v[7], 1]);
}

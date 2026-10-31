import { accountRef, dataUriJcs, keccakJcs } from "../core/canonical.js";
import { accountSubject, subjectKey } from "../core/kya.js";
import type { Cell } from "../kernel/cell.js";
import type { Genesis } from "./scenario.js";
import { attestorKeyFrom, epochFor, proverSecretFrom, zk, type Claim } from "./zk.js";

/**
 * T1 (4), the proved path for cell A: W's attestor signs a scheme-bound credential over A's commitment, A proves
 * it in zero knowledge for this registry's admission domain and the current epoch, and records the assertion
 * through its account; the Groth16 adapter becomes the issuer of record. Negative cases: a replayed proof
 * (nullifier spent), the same proof for another subject, a proof for a stale epoch.
 */
export async function credentialProof(g: Genesis, cell: Cell): Promise<void> {
  const k = g.kernel;
  const X = cell.name;
  if (k.fact<string>("T0.zk") !== "on") {
    g.skipped("T1", `${X}.kya.S_cred`, "the ZK path is not in this store (T0.zk = off)");
    return;
  }
  const sCred = k.requireFact<{ schemeId: string }>("T0.kya.S_cred").schemeId;
  const adapter = k.requireFact<string>("T0.kya.adapter");
  const set = k.requireFact<{ root: string; attestors: { pub: [string, string]; leaf: string }[] }>("T0.kya.issuerSet");
  const attestorPrv = attestorKeyFrom(k.signer("W").privateKey, "W");
  const subject = accountSubject(g.chainId, cell.address);
  const key = subjectKey(subject);

  // the prover's secret never leaves the cell's side; the attestor sees its Poseidon commitment only
  const secret = proverSecretFrom(k.signer(cell.roles.operator).privateKey, sCred);
  const expiresAt = await k.memo(`T1.${X}.kya.S_cred.expiresAt`, async () => (await k.blockTimestamp()) + 365 * 86400);
  const claimDoc = { scheme: "S_cred", level: 4, subject: accountRef(g.chainId, cell.address), basis: "credential signed by an attestor of FOGA's issuer set; proved in zero knowledge" };
  const claim: Claim = { subjectKey: key, schemeId: sCred, level: 4, claimDigest: keccakJcs(claimDoc), expiresAt };

  const credential = await k.memo(`T1.${X}.kya.S_cred.credential`, async () => {
    const { commitment } = await zk.commit(secret);
    const { sig } = await zk.attest(attestorPrv, claim, commitment);
    return { commitment, sig, attestorPub: set.attestors[0].pub };
  });

  const admissionDomain: string = await k.kya.admissionDomain();
  const bundle = await k.memo(`T1.${X}.kya.S_cred.proof`, async () => {
    const epoch = epochFor(await k.blockTimestamp());
    const started = Date.now();
    const p = await zk.prove({ issuerPubs: set.attestors.map((a) => a.pub), attestorPub: credential.attestorPub, claim, secret, sig: credential.sig, epoch, admissionDomain });
    g.log(`  ${X}: Groth16 proof for S_cred in ${Date.now() - started} ms (epoch ${epoch})`);
    return { publicInputs: p.publicInputs, proof: p.proof, nullifier: p.nullifier, epoch: epoch.toString() };
  });

  const evidence = dataUriJcs({ scheme: "S_cred", pattern: "credential (kya-public-v1)", issuerSetRoot: set.root, epoch: bundle.epoch, nullifier: bundle.nullifier, claim: claimDoc });
  const op = await cell.execute(`T1.${X}.kya.attestWithProof`, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sCred, bundle.publicInputs, bundle.proof, evidence));
  const assertionId = k.kya.assertionIdFromReceipt(op.receipt);
  k.setFact(`T1.${X}.kya.S_cred.assertionId`, assertionId);

  const passes = await k.kya.check(subject, sCred, 4, [adapter]);
  g.check("T1", `${X}.kya.S_cred.level4`, passes === true, `check({account, ${X}}, S_cred, 4, [adapter]) = ${passes}; issuer of record is the adapter`);
  const used = await k.kya.isNullifierUsed(sCred, bundle.nullifier);
  g.check("T1", `${X}.kya.S_cred.nullifier`, used === true, `isNullifierUsed(S_cred, ${bundle.nullifier.slice(0, 10)}…) = ${used}`);

  const replay = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sCred, bundle.publicInputs, bundle.proof, evidence));
  g.check("T1", `${X}.kya.S_cred.replay.refused`, replay !== null, `the same proof again reverts: ${replay}`);
  const wrongSubject = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(accountSubject(g.chainId, k.address("G")), sCred, bundle.publicInputs, bundle.proof, evidence));
  g.check("T1", `${X}.kya.S_cred.subject.refused`, wrongSubject !== null, `the proof presented for another subject reverts: ${wrongSubject}`);

  // a proof for an epoch outside the adapter's grace is refused before any nullifier is spent
  const stale = await k.memo(`T1.${X}.kya.S_cred.staleProof`, async () => {
    const epoch = epochFor(await k.blockTimestamp()) - 2n;
    const p = await zk.prove({ issuerPubs: set.attestors.map((a) => a.pub), attestorPub: credential.attestorPub, claim, secret, sig: credential.sig, epoch, admissionDomain });
    return { publicInputs: p.publicInputs, proof: p.proof, epoch: epoch.toString() };
  });
  const staleRefused = await g.wouldRevert(cell, k.kya.registryAddress, k.kya.encodeAttestWithProof(subject, sCred, stale.publicInputs, stale.proof, evidence));
  g.check("T1", `${X}.kya.S_cred.epoch.refused`, staleRefused !== null, `a proof for epoch ${stale.epoch} (current - 2) reverts: ${staleRefused}`);

  k.evidence("T1", `${X}.S_cred`, { schemeId: sCred, adapter, issuerSetRoot: set.root, commitment: credential.commitment, epoch: bundle.epoch, nullifier: bundle.nullifier, assertionId, publicInputs: bundle.publicInputs, tx: op.txHash });
}

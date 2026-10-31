#!/usr/bin/env node
// Bridge between the kernel and the upstream prover of kya-standard (companions/zk-kya-groth16/prover.js):
// reads one JSON job on stdin, writes one JSON result on stdout. The upstream module and its dependencies
// (snarkjs, circomlibjs, ethers) are resolved from this directory's node_modules, which `npm run zk:install`
// populates; the kernel's own dependency tree stays free of them.
//
// Jobs:
//   { "op": "root",   "attestors": [<32-byte hex private key>, ...] }
//        -> { "root": bytes32, "attestors": [{ "pub": [hex, hex], "leaf": hex }] }
//   { "op": "commit", "secret": <hex> }
//        -> { "commitment": hex }                        Poseidon(secret): what the attestor signs
//   { "op": "attest", "attestor": <hex prv>, "claim": {...}, "commitment": <hex> }
//        -> { "sig": { "R8x", "R8y", "S" } }              the attestor never sees the secret
//   { "op": "prove",  "issuerPubs": [[hex, hex], ...], "attestorPub": [hex, hex], "claim": {...}, "secret": <hex>,
//                     "sig": {...}, "epoch": <decimal string>, "admissionDomain": bytes32 }
//        -> { "publicInputs": hex, "proof": hex, "nullifier": bytes32, "publicSignals": [...] }
//        the prover holds the secret and public material only; no attestor private key is involved
// claim = { subjectKey, schemeId, level, claimDigest, expiresAt }.
//
// Predicate-pattern jobs (FOGA's own circuit zk/circuits/kya_predicate_count_v1.circom, built by
// prover/build-predicate.mjs into zk/build; FOGA_ZK_PREDICATE_DIR overrides the build directory):
//   { "op": "record.sign", "source": <hex prv>, "record": { "subjectKey": bytes32, "taskRef": <hex, 128-bit>,
//                          "status": <number>, "timestamp": <number> } }
//        -> { "sig": { "R8x", "R8y", "S" }, "pub": [hex, hex], "message": hex }
//        a source signs one task-completion record about a subject; the same `root` job gives the source set
//   { "op": "predicate.prove", "sourcePubs": [[hex, hex], ...], "sourcePub": [hex, hex], "subjectKey": bytes32,
//                              "records": [{ "taskRef", "status", "timestamp", "sig" }], "challenge": bytes32,
//                              "t0", "t1", "k": <number>, "schemeId": bytes32, "epoch": <decimal string>,
//                              "admissionDomain": bytes32, "secret": <hex> }
//        -> { "publicInputs": hex, "proof": hex, "nullifier": bytes32, "result": 0|1, "count": n,
//             "publicSignals": [...], "verified": bool }
//        records are sorted by taskRef (which must be distinct) and padded to the circuit's N slots
"use strict";
const path = require("node:path");
const Module = require("node:module");

const root = __dirname;
process.env.NODE_PATH = path.join(root, "node_modules") + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : "");
Module._initPaths();

const upstream = process.env.FOGA_ZK_PROVER || path.join(root, "..", "vendor", "kya-standard", "companions", "zk-kya-groth16", "prover.js");
const predicateDir = process.env.FOGA_ZK_PREDICATE_DIR || path.join(root, "..", "zk", "build");
const PREDICATE = { name: "kya_predicate_count_v1", slots: 8, depth: 16 };
const MASK128 = (1n << 128n) - 1n;
const split128 = (hex) => {
  const v = BigInt(hex);
  return [v >> 128n, v & MASK128];
};

function toBig(hex) {
  return BigInt(hex);
}

function attestorFromPrv(zk, prvHex) {
  const prv = Buffer.from(prvHex.replace(/^0x/, ""), "hex");
  if (prv.length !== 32) throw new Error("attestor private key must be 32 bytes");
  const pubP = zk.eddsa.prv2pub(prv);
  const pub = [zk.F.toObject(pubP[0]), zk.F.toObject(pubP[1])];
  return { prv, pub, leaf: zk.H(pub[0], pub[1]) };
}

/** The signed message, as the circuit recomputes it, from the secret's Poseidon commitment. */
function messageFromCommitment(zk, claim, commitment) {
  const split = (hex) => {
    const v = BigInt(hex);
    return [v >> 128n, v & ((1n << 128n) - 1n)];
  };
  const [skHi, skLo] = split(claim.subjectKey);
  const [siHi, siLo] = split(claim.schemeId);
  const [cdHi, cdLo] = split(claim.claimDigest);
  return zk.H(skHi, skLo, siHi, siLo, BigInt(claim.level), cdHi, cdLo, BigInt(claim.expiresAt), toBig(commitment));
}

/** Poseidon(5) over a task-completion record, as the predicate circuit recomputes it. */
function recordMessage(zk, subjectKey, record) {
  const [skHi, skLo] = split128(subjectKey);
  const taskRef = BigInt(record.taskRef);
  if (taskRef < 0n || taskRef > MASK128) throw new Error("taskRef must be a 128-bit value");
  return zk.H(skHi, skLo, taskRef, BigInt(record.status), BigInt(record.timestamp));
}

async function provePredicate(zk, job) {
  // ethers v6 from the repository root (this sub-package's own tree holds the v5 that circomlibjs depends on)
  const { ethers } = require(require.resolve("ethers", { paths: [path.join(root, "..")] }));
  const snarkjs = require("snarkjs");
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const wasm = path.join(predicateDir, `${PREDICATE.name}_js`, `${PREDICATE.name}.wasm`);
  const zkey = path.join(predicateDir, `${PREDICATE.name}_final.zkey`);
  const vkeyPath = path.join(predicateDir, "verification_key.json");
  for (const f of [wasm, zkey]) if (!require("node:fs").existsSync(f)) throw new Error(`predicate proving material missing: ${f} (run: node prover/build-predicate.mjs)`);

  const pubs = job.sourcePubs.map(([x, y]) => [toBig(x), toBig(y)]);
  const set = zk.issuerSet(pubs); // the source set: the same Poseidon Merkle tree (depth 16) as the issuer set
  const sourcePub = [toBig(job.sourcePub[0]), toBig(job.sourcePub[1])];
  const leaf = zk.H(sourcePub[0], sourcePub[1]);
  const idx = set.leaves.indexOf(leaf);
  if (idx < 0) throw new Error("source not in the source set");
  const { pathElements, pathIndices } = set.proofFor(idx);

  const records = job.records.map((r) => ({ taskRef: BigInt(r.taskRef), status: BigInt(r.status), timestamp: BigInt(r.timestamp), sig: r.sig }));
  records.sort((a, b) => (a.taskRef < b.taskRef ? -1 : a.taskRef > b.taskRef ? 1 : 0));
  for (let i = 1; i < records.length; i++) if (records[i].taskRef === records[i - 1].taskRef) throw new Error("records must have distinct taskRefs");
  if (records.length > PREDICATE.slots) throw new Error(`at most ${PREDICATE.slots} records per proof`);
  const n = PREDICATE.slots;
  const slot = (f, pad) => Array.from({ length: n }, (_, i) => (i < records.length ? f(records[i]) : pad));

  const [skHi, skLo] = split128(job.subjectKey);
  const [chHi, chLo] = split128(job.challenge);
  const [rtHi, rtLo] = split128(set.rootHex);
  const [siHi, siLo] = split128(job.schemeId);
  const [adHi, adLo] = split128(job.admissionDomain);
  const t0 = BigInt(job.t0);
  const t1 = BigInt(job.t1);
  const k = BigInt(job.k);
  const epoch = BigInt(job.epoch);
  const input = {
    subjectKeyHi: skHi, subjectKeyLo: skLo, challengeHi: chHi, challengeLo: chLo, t0, t1, k,
    sourceSetRootHi: rtHi, sourceSetRootLo: rtLo, schemeIdHi: siHi, schemeIdLo: siLo, epoch,
    admissionDomainHi: adHi, admissionDomainLo: adLo,
    secret: toBig(job.secret), Ax: sourcePub[0], Ay: sourcePub[1], pathElements, pathIndices,
    present: slot(() => 1n, 0n),
    taskRef: slot((r) => r.taskRef, 0n),
    status: slot((r) => r.status, 0n),
    timestamp: slot((r) => r.timestamp, 0n),
    S: slot((r) => BigInt(r.sig.S), 0n),
    R8x: slot((r) => toBig(r.sig.R8x), 0n),
    R8y: slot((r) => toBig(r.sig.R8y), 0n),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, wasm, zkey);
  const nullifier = ethers.toBeHex((BigInt(publicSignals[0]) << 128n) | BigInt(publicSignals[1]), 32);
  const result = Number(publicSignals[2]);
  const count = records.filter((r) => r.status === 1n && r.timestamp >= t0 && r.timestamp <= t1).length;
  const publicInputs = coder.encode(
    ["bytes32", "bytes32", "bytes32", "uint64", "uint64", "uint16", "bytes32", "uint64", "uint8"],
    [job.subjectKey, nullifier, job.challenge, t0, t1, k, set.rootHex, epoch, result],
  );
  const proofBytes = coder.encode(
    ["uint256[2]", "uint256[2][2]", "uint256[2]"],
    [[proof.pi_a[0], proof.pi_a[1]], [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]], [proof.pi_c[0], proof.pi_c[1]]],
  );
  let verified = null;
  if (require("node:fs").existsSync(vkeyPath)) verified = await snarkjs.groth16.verify(JSON.parse(require("node:fs").readFileSync(vkeyPath, "utf8")), publicSignals, proof);
  return { publicInputs, proof: proofBytes, nullifier, result, count, publicSignals: publicSignals.map(String), verified };
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const { ZK } = require(upstream);
  const zk = await ZK.create();
  const hex32 = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");

  let out;
  if (job.op === "root") {
    const atts = job.attestors.map((p) => attestorFromPrv(zk, p));
    const set = zk.issuerSet(atts.map((a) => a.pub));
    out = { root: set.rootHex, attestors: atts.map((a) => ({ pub: [hex32(a.pub[0]), hex32(a.pub[1])], leaf: hex32(a.leaf) })) };
  } else if (job.op === "commit") {
    out = { commitment: hex32(zk.H(toBig(job.secret))) };
  } else if (job.op === "attest") {
    const attestor = attestorFromPrv(zk, job.attestor);
    const m = zk.F.e(messageFromCommitment(zk, job.claim, job.commitment));
    const s = zk.eddsa.signPoseidon(attestor.prv, m);
    out = { sig: { R8x: hex32(zk.F.toObject(s.R8[0])), R8y: hex32(zk.F.toObject(s.R8[1])), S: s.S.toString() } };
  } else if (job.op === "prove") {
    const pubs = job.issuerPubs.map(([x, y]) => [toBig(x), toBig(y)]);
    const set = zk.issuerSet(pubs);
    const pub = [toBig(job.attestorPub[0]), toBig(job.attestorPub[1])];
    const attestor = { pub, leaf: zk.H(pub[0], pub[1]) };
    const sig = { R8x: toBig(job.sig.R8x), R8y: toBig(job.sig.R8y), S: BigInt(job.sig.S) };
    const r = await zk.prove({
      ...job.claim,
      epoch: BigInt(job.epoch),
      admissionDomain: job.admissionDomain,
      secret: toBig(job.secret),
      attestor,
      sig,
      set,
    });
    out = { publicInputs: r.publicInputs, proof: r.proof, nullifier: r.nullifier, publicSignals: r.publicSignals.map(String) };
  } else if (job.op === "record.sign") {
    const source = attestorFromPrv(zk, job.source);
    const m = recordMessage(zk, job.record.subjectKey, job.record);
    const sg = zk.eddsa.signPoseidon(source.prv, zk.F.e(m));
    out = { sig: { R8x: hex32(zk.F.toObject(sg.R8[0])), R8y: hex32(zk.F.toObject(sg.R8[1])), S: sg.S.toString() }, pub: [hex32(source.pub[0]), hex32(source.pub[1])], message: hex32(m) };
  } else if (job.op === "predicate.prove") {
    out = await provePredicate(zk, job);
  } else {
    throw new Error(`unknown op ${job.op}`);
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e));
  process.exit(1);
});

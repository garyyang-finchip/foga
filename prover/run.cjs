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
"use strict";
const path = require("node:path");
const Module = require("node:module");

const root = __dirname;
process.env.NODE_PATH = path.join(root, "node_modules") + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : "");
Module._initPaths();

const upstream = process.env.FOGA_ZK_PROVER || path.join(root, "..", "vendor", "kya-standard", "companions", "zk-kya-groth16", "prover.js");

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

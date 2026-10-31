import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBeHex, toUtf8Bytes } from "ethers";
import { abi } from "../core/canonical.js";
import { repoRoot } from "../util/fs.js";

/**
 * The credential-pattern ZK path of ERC-8419 (kya-public-v1), driven through prover/run.cjs: a bridge over the
 * upstream prover that keeps snarkjs and circomlibjs out of the kernel's own dependency tree. The roles stay
 * separate: the prover computes Poseidon(secret) and hands over the commitment; the attestor signs the
 * scheme-bound credential; the prover alone produces the proof for the admitting registry and the epoch.
 */
export interface Claim {
  subjectKey: string;
  schemeId: string;
  level: number;
  claimDigest: string;
  expiresAt: number;
}

export interface Signature {
  R8x: string;
  R8y: string;
  S: string;
}

export interface ProofBundle {
  publicInputs: string;
  proof: string;
  nullifier: string;
  publicSignals: string[];
}

export const EPOCH_LENGTH = 2_592_000; // 30 days, as the upstream Sepolia adapter
export const EPOCH_GRACE = 1;

const BUILD = join("vendor", "kya-standard", "companions", "zk-kya-groth16", "build");

/** Where the proving material and the libraries stand on this machine. */
export function zkAvailability(root = repoRoot()): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  for (const f of ["kya_public_v1_js/kya_public_v1.wasm", "kya_final.zkey", "verification_key.json"]) {
    if (!existsSync(join(root, BUILD, f))) missing.push(join(BUILD, f));
  }
  if (!existsSync(join(root, "vendor", "kya-standard", "companions", "zk-kya-groth16", "prover.js"))) missing.push("vendor/kya-standard/companions/zk-kya-groth16/prover.js (run: foga vendor sync)");
  if (!existsSync(join(root, "prover", "node_modules", "snarkjs"))) missing.push("prover/node_modules/snarkjs (run: npm run zk:install)");
  return { ok: missing.length === 0, missing };
}

/** A deterministic 32-byte EdDSA private key for an attestor, derived from an EOA key and a label. */
export function attestorKeyFrom(privateKey: string, label: string): string {
  return keccak256(abi.encode(["bytes32", "bytes32"], [keccak256(toUtf8Bytes(`foga.kya.attestor:${label}`)), privateKey]));
}

/** A deterministic prover secret below the BN254 scalar field (248 bits), derived from an EOA key and a scheme. */
export function proverSecretFrom(privateKey: string, schemeId: string): string {
  const h = BigInt(keccak256(abi.encode(["bytes32", "bytes32", "bytes32"], [keccak256(toUtf8Bytes("foga.kya.secret")), privateKey, schemeId])));
  return toBeHex(h >> 8n, 32);
}

export function epochFor(timestamp: number, epochLength = EPOCH_LENGTH): bigint {
  return epochLength === 0 ? 0n : BigInt(Math.floor(timestamp / epochLength));
}

async function run<T>(job: Record<string, unknown>, timeoutMs = 180_000): Promise<T> {
  const root = repoRoot();
  const script = join(root, "prover", "run.cjs");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "", FOGA_ZK_PROVER: process.env.FOGA_ZK_PROVER ?? "" } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`prover ${job.op} exceeded ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => out.push(Buffer.from(d)));
    child.stderr.on("data", (d) => err.push(Buffer.from(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`prover ${job.op} exited with ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 2000)}`));
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch (e) {
        reject(new Error(`prover ${job.op} returned no JSON: ${String(e)}`));
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

export const zk = {
  /** The issuer set of the given attestor keys: Poseidon Merkle root (depth 16) and the public keys. */
  issuerSet(attestors: string[]): Promise<{ root: string; attestors: { pub: [string, string]; leaf: string }[] }> {
    return run({ op: "root", attestors });
  },
  /** Poseidon(secret): the prover's commitment, the only thing the attestor needs from it. */
  commit(secret: string): Promise<{ commitment: string }> {
    return run({ op: "commit", secret });
  },
  /** The attestor signs (claim, commitment). */
  attest(attestor: string, claim: Claim, commitment: string): Promise<{ sig: Signature }> {
    return run({ op: "attest", attestor, claim, commitment });
  },
  /** The prover builds the Groth16 proof for the registry's admission domain and the epoch; public material only. */
  prove(p: { issuerPubs: [string, string][]; attestorPub: [string, string]; claim: Claim; secret: string; sig: Signature; epoch: bigint; admissionDomain: string }): Promise<ProofBundle> {
    return run({ ...p, op: "prove", epoch: p.epoch.toString() });
  },
};

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBeHex, toUtf8Bytes } from "ethers";
import { abi } from "../core/canonical.js";
import { repoRoot } from "../util/fs.js";

/**
 * The two ZK paths of ERC-8419, driven through prover/run.cjs: a bridge that keeps snarkjs and circomlibjs out of
 * the kernel's own dependency tree.
 *
 * Credential pattern (kya-public-v1, the upstream circuit): the prover computes Poseidon(secret) and hands over
 * the commitment; the attestor signs the scheme-bound credential; the prover alone produces the proof for the
 * admitting registry and the epoch.
 *
 * Predicate pattern (kya-predicate-count-v1, FOGA's circuit in zk/circuits): a source signs task-completion
 * records about a subject; the prover shows that at least K of them are Accepted inside a window, without
 * revealing them. The source set is a Poseidon Merkle tree of source keys, built like the issuer set.
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

/** One task-completion record as a source signs it: about `subjectKey`, identified by a 128-bit `taskRef`. */
export interface CompletionRecord {
  taskRef: string;
  status: number;
  timestamp: number;
}

export interface SignedRecord extends CompletionRecord {
  sig: Signature;
}

export interface PredicateProof extends ProofBundle {
  result: number;
  count: number;
  verified: boolean | null;
}

export const EPOCH_LENGTH = 2_592_000; // 30 days, as the upstream Sepolia adapter
export const EPOCH_GRACE = 1;
/** How long an assertion issued from a predicate proof stays valid: the rule was shown as of the proof's time. */
export const PREDICATE_VALIDITY = 30 * 86400;
/** The rule's window: completions inside the last 30 days before the proof. */
export const PREDICATE_WINDOW = 30 * 86400;

const BUILD = join("vendor", "kya-standard", "companions", "zk-kya-groth16", "build");
export const PREDICATE_BUILD = join("zk", "build");
export const PREDICATE_CIRCUIT = "kya_predicate_count_v1";
/** Record slots per predicate proof (the committed circuit instance). */
export const PREDICATE_SLOTS = 8;

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

/** Whether the proving libraries (the prover sub-package) are installed; the source set root needs them. */
export function proverLibsAvailable(root = repoRoot()): boolean {
  return existsSync(join(root, "prover", "node_modules", "snarkjs")) && existsSync(join(root, "prover", "node_modules", "circomlibjs"));
}

/** Where the predicate circuit's proving material stands (built by prover/build-predicate.mjs; FOGA_ZK_PREDICATE_DIR overrides). */
export function predicateAvailability(root = repoRoot()): { ok: boolean; missing: string[] } {
  const missing: string[] = [];
  const dir = process.env.FOGA_ZK_PREDICATE_DIR || join(root, PREDICATE_BUILD);
  for (const f of [`${PREDICATE_CIRCUIT}_js/${PREDICATE_CIRCUIT}.wasm`, `${PREDICATE_CIRCUIT}_final.zkey`, "verification_key.json"]) {
    if (!existsSync(join(dir, f))) missing.push(`${join(PREDICATE_BUILD, f)} (run: node prover/build-predicate.mjs)`);
  }
  if (!proverLibsAvailable(root)) missing.push("prover/node_modules (run: npm run zk:install)");
  return { ok: missing.length === 0, missing };
}

/** A deterministic 32-byte EdDSA private key for a source of task-completion records, from an EOA key and a label. */
export function sourceKeyFrom(privateKey: string, label: string): string {
  return keccak256(abi.encode(["bytes32", "bytes32"], [keccak256(toUtf8Bytes(`foga.kya.source:${label}`)), privateKey]));
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
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    if (process.env.FOGA_ZK_PROVER) env.FOGA_ZK_PROVER = process.env.FOGA_ZK_PROVER;
    if (process.env.FOGA_ZK_PREDICATE_DIR) env.FOGA_ZK_PREDICATE_DIR = process.env.FOGA_ZK_PREDICATE_DIR;
    const child = spawn(process.execPath, [script], { stdio: ["pipe", "pipe", "pipe"], env });
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
  /** The source set of the given source keys: the same Poseidon Merkle tree (depth 16) as the issuer set. */
  sourceSet(sources: string[]): Promise<{ root: string; attestors: { pub: [string, string]; leaf: string }[] }> {
    return run({ op: "root", attestors: sources });
  },
  /** A source signs one task-completion record about a subject. */
  signRecord(source: string, subjectKey: string, record: CompletionRecord): Promise<{ sig: Signature; pub: [string, string]; message: string }> {
    return run({ op: "record.sign", source, record: { ...record, subjectKey } });
  },
  /** The prover shows that at least k of the records are Accepted inside [t0, t1]; records and source stay private. */
  provePredicate(p: {
    sourcePubs: [string, string][];
    sourcePub: [string, string];
    subjectKey: string;
    records: SignedRecord[];
    challenge: string;
    t0: number;
    t1: number;
    k: number;
    schemeId: string;
    epoch: bigint;
    admissionDomain: string;
    secret: string;
  }): Promise<PredicateProof> {
    return run({ ...p, op: "predicate.prove", epoch: p.epoch.toString() }, 600_000);
  },
};

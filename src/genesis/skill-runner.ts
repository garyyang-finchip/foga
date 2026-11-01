import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { repoRoot } from "../util/fs.js";
import type { ExtractReport } from "./extract.js";
import type { SkillJob } from "./skill-worker.js";
import { buildSkillPackage, readSkillDir, type SkillPackage } from "../core/pack/skillpack.js";
import type { Kernel } from "../kernel/kernel.js";
import type { ProbeInput, ProbeReport } from "./probe.js";

/**
 * Before a cell executes a skill it holds, the kernel rebuilds the package from the local directory and compares
 * it with the on-chain commitment of the token: a tampered file changes the package hash and the run is refused.
 */
export function verifySkillAgainstChain(pkg: SkillPackage, onchain: { mdHash: string; packageHash: string; version: bigint }): { ok: boolean; reason?: string } {
  if (pkg.packageHash.toLowerCase() !== onchain.packageHash.toLowerCase()) return { ok: false, reason: `packageHash ${pkg.packageHash} differs from the token's ${onchain.packageHash}` };
  if (pkg.mdHash.toLowerCase() !== onchain.mdHash.toLowerCase()) return { ok: false, reason: `mdHash ${pkg.mdHash} differs from the token's ${onchain.mdHash}` };
  return { ok: true };
}

export async function verifiedPackage(kernel: Kernel, dir: string, tokenId: bigint): Promise<SkillPackage> {
  const pkg = buildSkillPackage(readSkillDir(dir));
  const onchain = await kernel.skills.skillOf(tokenId);
  const v = verifySkillAgainstChain(pkg, onchain);
  if (!v.ok) throw new Error(`skill package at ${dir} does not match token ${tokenId}: ${v.reason}`);
  return pkg;
}

function workerPath(): string {
  const here = import.meta.url;
  const ext = here.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./skill-worker${ext}`, here).pathname;
}

/** True under the development loader (tsx): Node's permission model cannot be combined with a custom loader. */
function underLoader(): boolean {
  return process.execArgv.some((a) => /--import|--loader|--require|tsx/.test(a)) || /\.ts$/.test(workerPath());
}

export interface IsolationOptions {
  timeoutMs?: number;
  /** Bytes of stdout the worker may produce before it is killed (default 1 MiB). */
  maxOutputBytes?: number;
  /** Directories the worker may read (Node's permission model, when not under the development loader). */
  readDirs?: string[];
}

/**
 * Run one skill job in a separate process: the environment is reduced to PATH (no NODE_OPTIONS, no keys), the heap
 * is capped, stdout is capped, the run has a time limit, and — when the parent is not running under the development
 * loader — Node's permission model restricts the worker to reading the directories the job needs (the compiled
 * code, node_modules, the world file and bundle, the skills and the input directory). The worker cannot sign: it
 * never sees a key. Network is not restricted at the process level: `foga-probe` needs the RPC.
 */
export async function runIsolated<T>(job: SkillJob, opts: IsolationOptions = {}): Promise<T> {
  const limit = opts.maxOutputBytes ?? 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const args: string[] = [...process.execArgv, "--max-old-space-size=512"];
  if (!underLoader() && opts.readDirs?.length) {
    args.push("--permission");
    for (const d of new Set([...opts.readDirs, dirname(workerPath())])) args.push(`--allow-fs-read=${resolve(d)}`);
  }
  args.push(workerPath());
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "" } });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let killed: string | null = null;
    const timer = setTimeout(() => {
      killed = `exceeded ${timeoutMs} ms`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      outBytes += d.length;
      if (outBytes > limit) {
        killed = `produced more than ${limit} bytes`;
        child.kill("SIGKILL");
        return;
      }
      out.push(Buffer.from(d));
    });
    child.stderr.on("data", (d) => {
      if (err.reduce((a, b) => a + b.length, 0) < 64 * 1024) err.push(Buffer.from(d));
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error(`skill worker (${job.executor}) ${killed}`));
      if (code !== 0) return reject(new Error(`skill worker (${job.executor}) exited with ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 2000)}`));
      try {
        resolvePromise(JSON.parse(Buffer.concat(out).toString("utf8")) as T);
      } catch (e) {
        reject(new Error(`skill worker (${job.executor}) returned no JSON: ${String(e)}`));
      }
    });
    child.stdin.end(JSON.stringify(job));
  });
}

/** Run `foga-probe` in the worker: view calls against the world at the input's block, no key. */
export async function runProbeIsolated(p: { worldPath: string; rpc: string; bundlePath?: string; input: ProbeInput; timeoutMs?: number }): Promise<{ answer: string; report: ProbeReport }> {
  const readDirs = [repoRoot(), dirname(resolve(p.worldPath))];
  if (p.bundlePath) readDirs.push(dirname(resolve(p.bundlePath)));
  return runIsolated({ executor: "probe", worldPath: p.worldPath, rpc: p.rpc, bundlePath: p.bundlePath, input: p.input }, { timeoutMs: p.timeoutMs, readDirs });
}

/** Run `finch-extract-verify`'s deterministic path in the worker over a document inside `inputDir`. */
export async function runExtractIsolated(p: { documentPath: string; fieldsPath: string; packageHash: string; inputDir: string; skillsDir: string; timeoutMs?: number }): Promise<{ report: ExtractReport; canonical: string; resultHash: string }> {
  return runIsolated(
    { executor: "extract", documentPath: p.documentPath, fieldsPath: p.fieldsPath, packageHash: p.packageHash, inputDir: p.inputDir, skillsDir: p.skillsDir },
    { timeoutMs: p.timeoutMs ?? 30_000, readDirs: [repoRoot(), resolve(p.inputDir), resolve(p.skillsDir)] },
  );
}

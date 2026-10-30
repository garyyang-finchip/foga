import { spawn } from "node:child_process";
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
  return new URL(`./probe-worker${ext}`, here).pathname;
}

/**
 * Run `foga-probe` in a separate process with a time limit. The child inherits the loader flags of this process
 * (so it runs under tsx in development and plain node from dist) but no keys: the environment is reduced to PATH.
 */
export async function runProbeIsolated(p: { worldPath: string; rpc: string; bundlePath?: string; input: ProbeInput; timeoutMs?: number }): Promise<{ answer: string; report: ProbeReport }> {
  const job = JSON.stringify({ worldPath: p.worldPath, rpc: p.rpc, bundlePath: p.bundlePath, input: p.input });
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, workerPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`probe worker exceeded ${p.timeoutMs ?? 60_000} ms`));
    }, p.timeoutMs ?? 60_000);
    child.stdout.on("data", (d) => out.push(Buffer.from(d)));
    child.stderr.on("data", (d) => err.push(Buffer.from(d)));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`probe worker exited with ${code}: ${Buffer.concat(err).toString("utf8").slice(0, 2000)}`));
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch (e) {
        reject(new Error(`probe worker returned no JSON: ${String(e)}`));
      }
    });
    child.stdin.end(job);
  });
}

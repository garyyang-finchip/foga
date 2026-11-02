import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadBundle } from "../bundle/load.js";
import { readJson, repoRoot } from "../util/fs.js";
import type { WorldFile } from "./types.js";

/**
 * Source verification on Sourcify (design memo, section 8, the 2c leftover, and section 9, 3d-2): every contract a world deployed
 * from the bundle is submitted with the very standard JSON input its compiler run took — the `build-info` files
 * `forge build` leaves beside the artifacts (`.foga-build/out/<repo>/build-info/`, written by `npm run bundle:verify`
 * and `foga build`) — the compiler version from the contract's metadata, and the creation transaction the world file
 * recorded. Nothing is recompiled or rewritten for the verifier: what Sourcify checks is what the bundle was built
 * from, at the locked commits. A dry run writes each request to a file instead of sending it; a chain Sourcify does
 * not serve (anvil's 31337) is always a dry run.
 */
export const SOURCIFY_SERVER = "https://sourcify.dev/server";

export interface BuildInfo {
  file: string;
  repo: string;
  solcVersion: string;
  input: { language: string; sources: Record<string, { content: string }>; settings: Record<string, unknown> };
  output: { contracts: Record<string, Record<string, { metadata?: string; evm?: { deployedBytecode?: { object?: string } } }>> };
}

/** Every full build-info file under the work directory, by repository. */
export function collectBuildInfo(outRoot = join(repoRoot(), ".foga-build", "out")): BuildInfo[] {
  const out: BuildInfo[] = [];
  if (!existsSync(outRoot)) return out;
  for (const repo of readdirSync(outRoot)) {
    const dir = join(outRoot, repo, "build-info");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
      const b = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<BuildInfo> & { solcLongVersion?: string };
      if (!b.input || !b.output?.contracts) continue; // a minimal build-info (no --build-info): nothing to submit
      out.push({ file: join(dir, name), repo, solcVersion: b.solcLongVersion ?? b.solcVersion ?? "", input: b.input, output: b.output });
    }
  }
  return out;
}

export interface VerificationRequest {
  id: string;
  address: string;
  bundleKey: string;
  creationTransactionHash: string | null;
  contractIdentifier: string;
  compilerVersion: string;
  buildInfo: string;
  stdJsonInput: BuildInfo["input"];
}

function normalizeCode(hex: string | undefined): string {
  return (hex ?? "").toLowerCase().replace(/^0x/, "");
}

/** The compiler's long version (0.8.28+commit.7893614a) from a contract's metadata, the build-info's otherwise. */
function compilerVersionOf(meta: string | undefined, fallback: string): string {
  try {
    const m = JSON.parse(meta ?? "{}") as { compiler?: { version?: string } };
    return m.compiler?.version ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * The verification requests of a world: for every step the world deployed from the bundle, the build-info whose
 * output holds a contract of that name in that repository with the bundle's runtime code, the path solc saw as the
 * identifier.
 */
export function verificationRequests(world: WorldFile, infos: BuildInfo[], o: { only?: string[] } = {}): { requests: VerificationRequest[]; missing: { id: string; reason: string }[] } {
  const bundle = loadBundle();
  const requests: VerificationRequest[] = [];
  const missing: { id: string; reason: string }[] = [];
  for (const step of world.steps.filter((s) => s.status === "deployed")) {
    if (o.only && !o.only.includes(step.id)) continue;
    const entry = world.contracts[step.id];
    if (!entry?.address || !entry.bundleKey) {
      missing.push({ id: step.id, reason: "the world file names no address or bundle key for this step" });
      continue;
    }
    const contract = bundle.contracts[entry.bundleKey];
    if (!contract) {
      missing.push({ id: step.id, reason: `bundle key ${entry.bundleKey} is not in the committed bundle` });
      continue;
    }
    const [repo, name] = entry.bundleKey.split(":");
    const wanted = normalizeCode(contract.deployedBytecode);
    let found: VerificationRequest | null = null;
    for (const info of infos.filter((i) => i.repo === repo)) {
      for (const [path, byName] of Object.entries(info.output.contracts)) {
        const c = byName[name];
        if (!c) continue;
        const code = normalizeCode(c.evm?.deployedBytecode?.object);
        // immutables and the metadata hash make exact equality too strict only when they differ; the bundle was built the same way, so equality is the check
        if (code && wanted && code !== wanted) continue;
        found = { id: step.id, address: entry.address, bundleKey: entry.bundleKey, creationTransactionHash: step.txHash ?? null, contractIdentifier: `${path}:${name}`, compilerVersion: compilerVersionOf(c.metadata, info.solcVersion), buildInfo: info.file, stdJsonInput: info.input };
        break;
      }
      if (found) break;
    }
    if (!found) missing.push({ id: step.id, reason: `no build-info under .foga-build/out/${repo}/build-info holds ${name} with the bundle's runtime code (run npm run bundle:verify to produce the build-info files)` });
    else requests.push(found);
  }
  return { requests, missing };
}

export interface VerificationResult {
  id: string;
  address: string;
  contractIdentifier: string;
  compilerVersion: string;
  outcome: "exact_match" | "match" | "already" | "dry-run" | "failed" | "error";
  detail: string;
  verificationId?: string;
  creationMatch?: string | null;
  runtimeMatch?: string | null;
}

export interface SourcifyReport {
  schema: "foga.sourcify/1";
  worldId: string;
  chainId: number;
  server: string;
  dryRun: boolean;
  at: string;
  results: VerificationResult[];
  missing: { id: string; reason: string }[];
  summary: Record<string, number>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface VerifyWorldOptions {
  worldPath: string;
  server?: string;
  dryRun?: boolean;
  only?: string[];
  /** Where the requests of a dry run are written (default .foga-build/sourcify/<world>). */
  outDir?: string;
  buildInfoRoot?: string;
  pollMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
}

/** Verify a world's deployed contracts on Sourcify, or write what would be sent. */
export async function verifyWorld(o: VerifyWorldOptions): Promise<{ report: SourcifyReport; outDir: string }> {
  const log = o.log ?? (() => {});
  const world = readJson<WorldFile>(resolve(o.worldPath));
  const server = (o.server ?? SOURCIFY_SERVER).replace(/\/+$/, "");
  const served = ![31337, 1337].includes(world.chainId);
  const dryRun = o.dryRun ?? !served;
  if (!served && !dryRun) throw new Error(`chain ${world.chainId} is a local chain Sourcify does not serve; use --dry-run`);
  const infos = collectBuildInfo(o.buildInfoRoot);
  const { requests, missing } = verificationRequests(world, infos, { only: o.only });
  const outDir = resolve(o.outDir ?? join(repoRoot(), ".foga-build", "sourcify", world.name));
  mkdirSync(outDir, { recursive: true });
  const f = o.fetchImpl ?? fetch;
  const results: VerificationResult[] = [];
  log(`sourcify: world ${world.worldId} (chain ${world.chainId}): ${requests.length} contract(s) to verify, ${missing.length} without a build-info; ${dryRun ? "dry run" : server}`);
  for (const r of requests) {
    const body = { stdJsonInput: r.stdJsonInput, compilerVersion: r.compilerVersion, contractIdentifier: r.contractIdentifier, ...(r.creationTransactionHash ? { creationTransactionHash: r.creationTransactionHash } : {}) };
    const file = join(outDir, `${r.id.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
    writeFileSync(file, JSON.stringify({ chainId: world.chainId, address: r.address, ...body }, null, 2) + "\n");
    if (dryRun) {
      results.push({ id: r.id, address: r.address, contractIdentifier: r.contractIdentifier, compilerVersion: r.compilerVersion, outcome: "dry-run", detail: `request written to ${file}` });
      continue;
    }
    try {
      const existing = await f(`${server}/v2/contract/${world.chainId}/${r.address}`, { signal: AbortSignal.timeout(30_000) });
      if (existing.ok) {
        const e = (await existing.json()) as { match?: string | null; creationMatch?: string | null; runtimeMatch?: string | null };
        if (e.match === "exact_match" || e.match === "match") {
          results.push({ id: r.id, address: r.address, contractIdentifier: r.contractIdentifier, compilerVersion: r.compilerVersion, outcome: "already", detail: `already verified (${e.match})`, creationMatch: e.creationMatch ?? null, runtimeMatch: e.runtimeMatch ?? null });
          log(`  ${r.id}: already verified (${e.match})`);
          continue;
        }
      }
      const submitted = await f(`${server}/v2/verify/${world.chainId}/${r.address}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
      const ticket = (await submitted.json()) as { verificationId?: string; customCode?: string; message?: string; errorId?: string };
      if (!submitted.ok || !ticket.verificationId) {
        results.push({ id: r.id, address: r.address, contractIdentifier: r.contractIdentifier, compilerVersion: r.compilerVersion, outcome: "error", detail: `HTTP ${submitted.status}: ${ticket.customCode ?? ""} ${ticket.message ?? ""}`.trim() });
        log(`  ${r.id}: refused — HTTP ${submitted.status} ${ticket.customCode ?? ""} ${ticket.message ?? ""}`);
        continue;
      }
      const started = Date.now();
      let outcome: VerificationResult | null = null;
      while (Date.now() - started < (o.timeoutMs ?? 300_000)) {
        await sleep(o.pollMs ?? 3000);
        const status = await f(`${server}/v2/verify/${ticket.verificationId}`, { signal: AbortSignal.timeout(30_000) });
        const job = (await status.json()) as { isJobCompleted?: boolean; contract?: { match?: string | null; creationMatch?: string | null; runtimeMatch?: string | null }; error?: { customCode?: string; message?: string } };
        if (!job.isJobCompleted) continue;
        if (job.error) outcome = { id: r.id, address: r.address, contractIdentifier: r.contractIdentifier, compilerVersion: r.compilerVersion, outcome: "failed", detail: `${job.error.customCode ?? ""} ${job.error.message ?? ""}`.trim(), verificationId: ticket.verificationId };
        else outcome = { id: r.id, address: r.address, contractIdentifier: r.contractIdentifier, compilerVersion: r.compilerVersion, outcome: job.contract?.match === "exact_match" ? "exact_match" : "match", detail: `creation ${job.contract?.creationMatch ?? "-"}, runtime ${job.contract?.runtimeMatch ?? "-"}`, verificationId: ticket.verificationId, creationMatch: job.contract?.creationMatch ?? null, runtimeMatch: job.contract?.runtimeMatch ?? null };
        break;
      }
      if (!outcome) outcome = { id: r.id, address: r.address, contractIdentifier: r.contractIdentifier, compilerVersion: r.compilerVersion, outcome: "error", detail: `verification ${ticket.verificationId} did not complete in time; check ${server}/v2/verify/${ticket.verificationId}`, verificationId: ticket.verificationId };
      results.push(outcome);
      log(`  ${r.id}: ${outcome.outcome} — ${outcome.detail}`);
    } catch (e) {
      results.push({ id: r.id, address: r.address, contractIdentifier: r.contractIdentifier, compilerVersion: r.compilerVersion, outcome: "error", detail: (e as Error).message });
      log(`  ${r.id}: error — ${(e as Error).message}`);
    }
  }
  const summary: Record<string, number> = {};
  for (const r of results) summary[r.outcome] = (summary[r.outcome] ?? 0) + 1;
  const report: SourcifyReport = { schema: "foga.sourcify/1", worldId: world.worldId, chainId: world.chainId, server, dryRun, at: new Date().toISOString(), results, missing, summary };
  writeFileSync(join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  return { report, outDir };
}

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { Wallet, getAddress, parseEther } from "ethers";
import { dataUriJcs, keccakJcs } from "../../src/core/canonical.js";
import { accountSubject, fogaAttestedSchemeDescriptor } from "../../src/core/kya.js";
import { anvilKeys } from "../../src/genesis/roles.js";
import { Kernel } from "../../src/kernel/kernel.js";

/** Shared fixture of the node tests: an anvil, a world deployed by the CLI, a cell born by `foga cell init`, standing and skills. */
export const ROOT = resolve(".");

export function anvilPath(): string | null {
  const dir = process.env.FOGA_FOUNDRY_DIR;
  const candidate = dir ? `${dir}/anvil` : "anvil";
  try {
    execFileSync(candidate, ["--version"], { stdio: "ignore" });
    return candidate;
  } catch {
    return null;
  }
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => (s.destroy(), resolve(false)));
  });
}

export async function startAnvil(bin: string, port: number): Promise<ChildProcess> {
  const child = spawn(bin, ["--port", String(port), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    if (await portOpen(port)) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("anvil did not come up");
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

/** A clean FOGA_* environment with only the keys named, plus the RPC. */
export function cleanEnv(rpc: string, env: Record<string, string> = {}): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FOGA_")) clean[k] = v;
  return { ...clean, FOGA_RPC_URL: rpc, ...env };
}

/** Run the CLI as a user would. */
export function foga(rpc: string, args: string[], env: Record<string, string> = {}): CliResult {
  const child = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: ROOT, env: cleanEnv(rpc, env), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const stdout = String(child.stdout ?? "");
  let json: any = null;
  const start = stdout.indexOf("{");
  const startArr = stdout.indexOf("[");
  const at = start < 0 ? startArr : startArr < 0 ? start : Math.min(start, startArr);
  if (at >= 0) {
    try {
      json = JSON.parse(stdout.slice(at));
    } catch {
      json = null;
    }
  }
  return { code: child.status ?? -1, stdout, stderr: String(child.stderr ?? ""), json };
}

/** The same, without blocking the event loop: for a CLI call that must reach a server running in this process. */
export function fogaAsync(rpc: string, args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: ROOT, env: cleanEnv(rpc, env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("close", (code) => {
      let json: any = null;
      const at = stdout.indexOf("{");
      if (at >= 0) {
        try {
          json = JSON.parse(stdout.slice(at));
        } catch {
          json = null;
        }
      }
      resolve({ code: code ?? -1, stdout, stderr, json });
    });
  });
}

export function ok(r: CliResult, what: string): any {
  assert.equal(r.code, 0, `${what} failed (exit ${r.code}):\n${r.stderr.slice(-3000)}\n${r.stdout.slice(-1500)}`);
  assert.ok(r.json, `${what} printed no JSON: ${r.stdout.slice(0, 500)}`);
  return r.json;
}

export interface BornCell {
  rpc: string;
  dir: string;
  worldPath: string;
  configPath: string;
  account: string;
  agentId: string;
  schemeId: string;
  chainId: number;
  keys: { W: Wallet; owner: Wallet; operator: Wallet; guardian: Wallet };
  skills: Record<string, { tokenId: string; packageHash: string }>;
  kernel: Kernel;
}

/** Deploy the world, register the standing scheme, birth cell D, attest level 2, mint the two skills. */
export async function bornCell(rpc: string, dir: string, name = "D"): Promise<BornCell> {
  const keys = anvilKeys();
  const W = new Wallet(keys.W);
  const owner = new Wallet(keys["owner.A"]);
  const guardian = new Wallet(keys.G);
  const operator = new Wallet(keys["operator.A"]);
  const worldPath = join(dir, "world.json");
  const configPath = join(dir, `${name}.json`);
  const deployed = foga(rpc, ["world", "deploy", "--world", "worlds/local.json", "--rpc", rpc, "--out", worldPath]);
  assert.equal(deployed.code, 0, `world deploy failed:\n${deployed.stderr.slice(-2000)}`);
  const kernel = await Kernel.open({ worldPath, rpc, storePath: join(dir, "driver.sqlite"), keys: { W: keys.W } });
  const chainId = kernel.chainId;
  const attInput = kernel.kya.attestedSchemeInput(fogaAttestedSchemeDescriptor());
  const att = await kernel.call("scheme", "W", kernel.kya.schemeRegistryAddress, kernel.kya.schemes().interface, "registerScheme", [attInput]);
  const schemeId = kernel.kya.schemeIdFromReceipt(att.receipt);
  const created = foga(rpc, ["cell", "new", "--name", name, "--world", worldPath, "--store", join(dir, `${name}.ops.sqlite`), "--owner", owner.address, "--operator", operator.address, "--guardian", guardian.address, "--out", configPath]);
  assert.equal(created.code, 0, `cell new failed:\n${created.stderr.slice(-2000)}`);
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  cfg.identity.standing = { schemeId, issuers: [W.address] };
  cfg.policy.budget = { dailyValueWei: parseEther("0.002").toString(), perOperationValueWei: parseEther("0.001").toString(), dailyGasWei: parseEther("0.01").toString(), maxConcurrentCommitments: 2 };
  cfg.policy.tenders = { minRewardWei: parseEther("0.0005").toString(), minSubmitWindowSeconds: 600, minSettleWindowSeconds: 600, acceptance: ["hashlock"], counterpartyMinLevel: 0, lookbackBlocks: 9000 };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  const born = ok(foga(rpc, ["cell", "init", "--config", configPath], { FOGA_OWNER_KEY: owner.privateKey }), "cell init");
  const account = getAddress(born.account);
  const claim = { scheme: "S_att", level: 2, subject: `eip155:${chainId}:${account.toLowerCase()}` };
  const expiresAt = (await kernel.blockTimestamp()) + 365 * 86400;
  await kernel.call("attest", "W", kernel.kya.registryAddress, kernel.kya.registry().interface, "attest", [accountSubject(chainId, account), schemeId, 2, keccakJcs(claim), expiresAt, dataUriJcs(claim), keccakJcs(claim)]);
  ok(foga(rpc, ["cell", "skill_mint", "--config", configPath, "--skill", "foga-probe"], { FOGA_OPERATOR_KEY: operator.privateKey }), "skill_mint foga-probe");
  ok(foga(rpc, ["cell", "skill_mint", "--config", configPath, "--skill", "finch-extract-verify"], { FOGA_OPERATOR_KEY: operator.privateKey }), "skill_mint finch-extract-verify");
  const withSkills = JSON.parse(readFileSync(configPath, "utf8"));
  const skills: BornCell["skills"] = {};
  for (const [n, h] of Object.entries(withSkills.skills.held as Record<string, { tokenId: string; packageHash: string }>)) skills[n] = { tokenId: h.tokenId, packageHash: h.packageHash };
  return { rpc, dir, worldPath, configPath, account, agentId: born.agentId, schemeId, chainId, keys: { W, owner, operator, guardian }, skills, kernel };
}

/** Wait until an HTTP endpoint answers. */
export async function waitForHttp(url: string, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${url} did not come up`);
}

#!/usr/bin/env node
// Pack the npm tarball, install it in a clean directory and exercise the packaged CLI as a user would: --help, the
// public catalog, a cell born on the given world through the packaged `foga cell new` / `foga cell init`, and
// `foga node mcp` without a key, driven over stdio by a raw JSON-RPC client (no SDK: this checks that stdout carries
// protocol messages alone and that the tools a keyless local user gets are the reads, dry runs and builds).
// Needs a running anvil at <rpc> and a world file deployed on it; CI runs it after the genesis, on the same anvil.
//
//   node scripts/pack-smoke.mjs <rpc> <world.json> [work dir]
//
// The roles of the smoke cell are three accounts of anvil's phrase beyond the ten it pre-funds (indexes 12-14), so
// they collide with no genesis role; the owner is funded from anvil's first account, which anvil leaves unlocked.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [rpc, worldArg, workArg] = process.argv.slice(2);
if (!rpc || !worldArg) {
  console.error("usage: node scripts/pack-smoke.mjs <rpc> <world.json> [work dir]");
  process.exit(2);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const world = resolve(worldArg);
const work = workArg ? resolve(workArg) : mkdtempSync(join(tmpdir(), "foga-pack-"));
mkdirSync(work, { recursive: true }); // npm pack does not create a missing --pack-destination
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("FOGA_")));

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, ...opts });
}
function step(name) {
  console.log(`\n== ${name}`);
}
function firstJson(text) {
  const at = text.indexOf("{");
  if (at < 0) throw new Error(`no JSON in: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(at));
}
async function rpcCall(method, params) {
  const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = await r.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

step(`npm pack into ${work}`);
const tarball = run("npm", ["pack", "--silent", "--pack-destination", work], { cwd: root }).trim().split("\n").pop();
console.log(tarball);

step("a clean install of the tarball");
run("npm", ["init", "-y"], { cwd: work });
run("npm", ["install", "--no-audit", "--no-fund", "--silent", join(work, tarball)], { cwd: work });
const foga = join(work, "node_modules", ".bin", "foga");
const cli = (args, env = {}) => run(foga, args, { cwd: work, env: { ...cleanEnv, ...env } });

step("foga --help, foga cell help");
const help = cli(["--help"]);
if (!/foga node tick \| watch \| mcp \| serve/.test(help) || !/foga mcp --config/.test(help)) throw new Error("--help does not list the node commands");
const cellHelp = cli(["cell", "help"]);
if (!/foga node mcp --config/.test(cellHelp) || !/foga node serve --config/.test(cellHelp) || !/foga node key new/.test(cellHelp)) throw new Error("foga cell help does not list the node commands");

step("foga cell list --public");
const list = cli(["cell", "list", "--public"]);
if (!/tender_precheck/.test(list) || !/spec_read/.test(list) || /operator_rotate/.test(list) || /evidence_export/.test(list)) throw new Error(`the public catalog is wrong:\n${list}`);

step("foga cell schema tender_submit");
const schema = firstJson(cli(["cell", "schema", "tender_submit"]));
if (schema.input?.$schema !== "https://json-schema.org/draft/2020-12/schema" || !schema.input.properties?.resultHash) throw new Error("the schema command is wrong");

step("a cell born by the packaged CLI");
const require = createRequire(join(work, "package.json"));
const { HDNodeWallet, Mnemonic, parseEther, toBeHex } = require("ethers");
const phrase = Mnemonic.fromPhrase("test test test test test test test test test test test junk");
const role = (i) => HDNodeWallet.fromMnemonic(phrase, `m/44'/60'/0'/0/${i}`);
const owner = role(12);
const operator = role(13);
const guardian = role(14);
const funder = role(0).address;
const tx = await rpcCall("eth_sendTransaction", [{ from: funder, to: owner.address, value: toBeHex(parseEther("1")) }]);
for (let i = 0; i < 100; i++) {
  if (await rpcCall("eth_getTransactionReceipt", [tx])) break;
  await new Promise((r) => setTimeout(r, 100));
}
const config = join(work, "P.json");
cli(["cell", "new", "--name", "P", "--world", world, "--store", join(work, "P.ops.sqlite"), "--owner", owner.address, "--operator", operator.address, "--guardian", guardian.address, "--out", config, "--rpc", rpc]);
const born = firstJson(cli(["cell", "init", "--config", config, "--rpc", rpc], { FOGA_OWNER_KEY: owner.privateKey }));
console.log(`account ${born.account}, agent ${born.agentId}, ${born.operations.length} operations`);
const status = firstJson(cli(["cell", "status", "--config", config, "--rpc", rpc]));
if (status.output?.account !== born.account || status.output?.accountVersion !== 2) throw new Error(`cell status: ${JSON.stringify(status).slice(0, 500)}`);

step("foga node mcp over stdio, without a key: a raw 2025-era client");
const child = spawn(foga, ["node", "mcp", "--config", config, "--rpc", rpc], { cwd: work, env: cleanEnv, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const pending = new Map();
let buffer = "";
child.stdout.on("data", (d) => {
  buffer += d;
  let i;
  while ((i = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error(`stdout carried something other than a protocol message: ${line.slice(0, 300)}`);
      process.exit(1);
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});
const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
let nextId = 1;
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out; server stderr:\n${stderr}`)), 90_000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${JSON.stringify(msg.error)}`));
      else resolve(msg.result);
    });
    send({ jsonrpc: "2.0", id, method, params });
  });
}
try {
  const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "pack-smoke", version: "0" } });
  if (init.serverInfo?.name !== "foga") throw new Error(`initialize answered ${JSON.stringify(init).slice(0, 300)}`);
  console.log(`server foga ${init.serverInfo.version}, protocol ${init.protocolVersion}`);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const tools = await request("tools/list", {});
  const names = tools.tools.map((t) => t.name);
  for (const n of ["cell_status", "spec_read", "evidence_export", "tender_precheck_simulate", "tender_submit_simulate", "tender_submit_build"]) if (!names.includes(n)) throw new Error(`tool ${n} missing from ${names.join(",")}`);
  for (const n of ["tender_submit", "tender_precheck", "skill_mint", "operator_rotate"]) if (names.includes(n)) throw new Error(`tool ${n} offered without the operator key`);
  console.log(`${names.length} tools; no act without the key`);
  const cellStatus = await request("tools/call", { name: "cell_status", arguments: {} });
  if (cellStatus.isError || cellStatus.structuredContent?.account !== born.account) throw new Error(`cell_status answered ${JSON.stringify(cellStatus).slice(0, 300)}`);
  const resources = await request("resources/list", {});
  if (!resources.resources.some((r) => r.uri === "foga://policy")) throw new Error("foga://policy is not listed");
  const spec = await request("tools/call", { name: "spec_read", arguments: { name: "compatibility-matrix" } });
  if (spec.isError || spec.structuredContent?.mediaType !== "text/markdown" || !/Compatibility matrix/.test(spec.structuredContent?.text ?? "")) throw new Error(`spec_read answered ${JSON.stringify(spec).slice(0, 300)}`);
  console.log("cell_status, resources/list and spec_read answered from the packaged server");
} finally {
  child.stdin.end();
  const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 10_000))]);
  if (!done) child.kill("SIGTERM");
}
if (/0x[0-9a-fA-F]{64}/.test(stderr)) throw new Error("the server's stderr carries a 32-byte hex value; keys must never be logged");
console.log("\npack smoke: ok");

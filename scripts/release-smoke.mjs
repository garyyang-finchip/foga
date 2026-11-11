#!/usr/bin/env node
// The assertions of the cross-platform release check (.github/workflows/release-check.yml), one implementation for
// every operating system and shell in its matrix. The workflow runs the packaged CLI as a user would — `foga demo
// --genesis T9`, `foga quickstart --exit` — from the shell under test (bash, PowerShell, Git Bash); this script then
// reads what those runs wrote and says, in one line per check, whether it is what a release must produce. It runs
// against an installed package (`npm install -g` of the tarball, or of the published alias), never a checkout — except
// `pack`, which makes the tarball from the checkout first.
//
//   node scripts/release-smoke.mjs pack <dest dir>                    in a checkout: the versions agree (package.json, package-lock.json, server.json,
//                                                                     the alias; the CHANGELOG has the entry), `npm pack` into <dest>, the tarball holds
//                                                                     what a run needs and nothing it must not (outputs tarball=, version=, mode=tree)
//   node scripts/release-smoke.mjs registry <version>                 the published alias @finchtech.ai/foga@<version> pins @finchip.ai/foga@<version>,
//                                                                     and both are on the registry (outputs version=, mode=registry)
//   node scripts/release-smoke.mjs where                              the installed package's root (also written to $GITHUB_OUTPUT as root=)
//   node scripts/release-smoke.mjs genesis [evidence.json]            the demo's T0-T9 evidence: no check failed, the chain-side checks that need no
//                                                                     proving material passed, the skill worker ran (T3's run receipt)
//   node scripts/release-smoke.mjs quickstart <dir> <wallet> [out]    the quickstart's directory, wallet and summary: every file a user is
//                                                                     told about is there (the flow documents included), the MCP client
//                                                                     configuration names the wallet's key, the key files are private
//
// Exit 0 when every check holds, 1 on the first that does not (the line says which), 2 on usage.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
const win32 = process.platform === "win32";

function fail(message) {
  console.error(`release-smoke: FAIL ${message}`);
  process.exit(1);
}
function ok(message) {
  console.log(`release-smoke: ok   ${message}`);
}
function readJson(path) {
  if (!existsSync(path)) fail(`${path} does not exist`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail(`${path} is not JSON: ${e.message}`);
  }
}

/** The installed package's root: a global install of @finchip.ai/foga, or of the @finchtech.ai/foga alias (the package then nested under it). */
function installedRoot() {
  const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
  const candidates = [join(globalRoot, "@finchip.ai", "foga"), join(globalRoot, "@finchtech.ai", "foga", "node_modules", "@finchip.ai", "foga")];
  for (const dir of candidates) if (existsSync(join(dir, "package.json"))) return dir;
  fail(`@finchip.ai/foga is not installed globally (looked under ${globalRoot})`);
}

function output(pairs) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(pairs).map(([k, v]) => `${k}=${v}\n`).join(""));
}

if (command === "pack") {
  const dest = args[0] ? resolve(args[0]) : fail("usage: release-smoke pack <dest dir>");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pkg = readJson(join(root, "package.json"));
  const version = String(pkg.version);
  if (pkg.name !== "@finchip.ai/foga") fail(`package.json names ${pkg.name}`);
  // one version everywhere a release states it
  const lock = readJson(join(root, "package-lock.json"));
  if (lock.version !== version || lock.packages?.[""]?.version !== version) fail(`package-lock.json says ${lock.version} / ${lock.packages?.[""]?.version}, package.json ${version}`);
  const server = readJson(join(root, "server.json"));
  const serverVersions = [server.version, ...(server.packages ?? []).map((p) => p.version)];
  if (serverVersions.some((v) => v !== version)) fail(`server.json says ${serverVersions.join(", ")}, package.json ${version}`);
  const alias = readJson(join(root, "alias", "finchtech.ai", "package.json"));
  if (alias.version !== version || alias.dependencies?.["@finchip.ai/foga"] !== version) fail(`the alias says ${alias.version} and pins ${alias.dependencies?.["@finchip.ai/foga"]}, package.json ${version}`);
  const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
  if (!new RegExp(`^## ${version.replace(/[.]/g, "\\.")}( |$)`, "m").test(changelog)) fail(`CHANGELOG.md has no "## ${version}" entry`);
  ok(`version ${version} in package.json, package-lock.json, server.json, the alias and the CHANGELOG`);
  // the tarball, as `npm publish` would send it (npm pack does not create a missing --pack-destination: ENOENT)
  mkdirSync(dest, { recursive: true });
  let packOutput;
  try {
    packOutput = execSync(`npm pack --json --pack-destination "${dest}"`, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    fail(`npm pack failed (exit ${e.status}): ${String(e.stdout ?? e.message).slice(0, 600)}`);
  }
  const packed = JSON.parse(packOutput)[0];
  const files = new Set(packed.files.map((f) => f.path));
  ok(`${packed.filename}: ${packed.entryCount} files, ${(packed.size / 1024 / 1024).toFixed(1)} MB packed, ${(packed.unpackedSize / 1024 / 1024).toFixed(1)} MB unpacked`);
  // what a run needs: the launcher, the compiled CLI with the skill worker it spawns, the bundle, the worlds, the shipped
  // skills and paradigm descriptors (read at the birth), the prover's runner, the Sepolia address book, the docs the MCP
  // server serves
  for (const f of ["bin/foga.js", "dist/cli.js", "dist/cli-cell.js", "dist/genesis/skill-worker.js", "dist/mcp/server.js", "dist/demo/quickstart.js", "artifacts/bundle.json", "artifacts/bundle.sha256", "worlds/local.json", "worlds/sepolia.json", "deployments/sepolia.example.json", "scenarios/flows/cell-source.v1.json", "scenarios/flows/tender-market.v1.json", "scenarios/skills/foga-probe/manifest.json", "scenarios/skills/foga-probe/SKILL.md", "scenarios/skills/finch-extract-verify/manifest.json", "scenarios/skills/finch-extract-verify/SKILL.md", "scenarios/fixtures/sample-filing.txt", "prover/run.cjs", "prover/package.json", "zk/build/verification_key.json", "build/profiles.json", "build/known-interface-ids.json", "vendor/LOCK.json", "scripts/prepare.mjs", "server.json", "README.md", "LICENSE", "NOTICE", "docs/join.md", "docs/quickstart.md", "docs/mcp.md", "docs/compatibility-matrix.md"]) {
    if (!files.has(f)) fail(`the tarball lacks ${f}`);
  }
  ok("the tarball holds the launcher, the compiled CLI and skill worker, the bundle, the worlds, the skills, the paradigm descriptors, the prover runner and the docs");
  // what it must not carry: sources and tests, build and CI output, keys, stores, deployments other than the Sepolia example
  for (const f of files) {
    if (/^(src|test|contracts|\.foga-build|\.github|node_modules)\//.test(f) || /\.(key|sqlite|sqlite-wal|sqlite-shm|log)$/.test(f) || (/^deployments\//.test(f) && f !== "deployments/sepolia.example.json") || /^keys\//.test(f)) fail(`the tarball carries ${f}`);
  }
  ok("no sources, tests, contracts, build output, keys, stores or deployments in the tarball");
  if (packed.unpackedSize > 40 * 1024 * 1024) fail(`the tarball unpacks to ${packed.unpackedSize} bytes; a release stays under 40 MB`);
  if (packed.filename !== `finchip.ai-foga-${version}.tgz`) fail(`the tarball is ${packed.filename}, not finchip.ai-foga-${version}.tgz`);
  if (!existsSync(join(dest, packed.filename))) fail(`${packed.filename} is not in ${dest}`);
  output({ tarball: packed.filename, version, mode: "tree" });
} else if (command === "registry") {
  const version = args[0] ?? fail("usage: release-smoke registry <version>");
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) fail(`${version} is not a version`);
  const view = (spec, field) => {
    try {
      return execSync(`npm view ${spec} ${field} --json`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "null"; // E404: not on the registry
    }
  };
  const main = JSON.parse(view(`@finchip.ai/foga@${version}`, "version") || "null");
  if (main !== version) fail(`@finchip.ai/foga@${version} is not on the registry (npm view says ${JSON.stringify(main)})`);
  const aliasVersion = JSON.parse(view(`@finchtech.ai/foga@${version}`, "version") || "null");
  if (aliasVersion !== version) fail(`@finchtech.ai/foga@${version} is not on the registry (npm view says ${JSON.stringify(aliasVersion)})`);
  const deps = JSON.parse(view(`@finchtech.ai/foga@${version}`, "dependencies") || "{}");
  if (deps["@finchip.ai/foga"] !== version) fail(`@finchtech.ai/foga@${version} pins @finchip.ai/foga@${deps["@finchip.ai/foga"]}, not ${version}`);
  ok(`@finchtech.ai/foga@${version} is published and pins @finchip.ai/foga@${version}, which is published`);
  output({ version, mode: "registry" });
} else if (command === "where") {
  const root = installedRoot();
  const pkg = readJson(join(root, "package.json"));
  console.log(root);
  ok(`${pkg.name} ${pkg.version} at ${root}`);
  output({ root, version: pkg.version });
} else if (command === "genesis") {
  const path = args[0] ? resolve(args[0]) : join(installedRoot(), "deployments", "local.genesis.json");
  const e = readJson(path);
  ok(`evidence ${path}`);
  if (e.summary?.failed !== 0) fail(`checks failed: ${JSON.stringify((e.checks ?? []).filter((c) => !c.pass).map((c) => c.name))}`);
  ok(`${e.summary.passed}/${e.summary.checks} checks passed, ${e.summary.failed} failed`);
  // 197 checks with the proving material (the CI's `--zk require`); a clean install has none, the demo's `--zk auto` skips
  // what needs it and 180 remain — what a user's machine runs
  if (e.summary.checks < 180) fail(`only ${e.summary.checks} checks ran; T0-T9 run 180 at least`);
  const skipped = (e.checks ?? []).filter((c) => /^skipped:/.test(String(c.detail ?? ""))).map((c) => c.name);
  ok(`zk credential path ${e.facts?.["T0.zk"] ?? "?"}, predicate path ${e.facts?.["T0.zk.predicate"] ?? "?"}; ${skipped.length} check(s) skipped${skipped.length ? `: ${skipped.join(", ")}` : ""}`);
  // checks that need no proving material: the tender taken and paid (T3), the channel and the anchors (ERC-8489), the
  // enrollment (ERC-8490), the swarm, the ruling, the retirement, the skill handed on
  for (const name of ["submissions.one", "A.skill.verified", "A.answer", "A.paid", "A.channel.open", "A.flows.anchored", "A.meditation.enrolled", "swarm.achieved", "ruling.sustained", "A.retired", "skill.adopted"]) {
    const c = (e.checks ?? []).find((c) => c.name === name);
    if (!c) fail(`check ${name} is missing from the evidence`);
    if (!c.pass) fail(`check ${name} failed: ${c.detail ?? ""}`);
    if (/^skipped:/.test(String(c.detail ?? ""))) fail(`check ${name} was skipped: ${c.detail}`);
  }
  ok("the chain-side checks that need no proving material all passed");
  // T3: the fulfiller ran foga-probe in the isolated worker — the step the first Windows run died at (1.0.4)
  const receipt = e.facts?.["T3.A.runReceipt"];
  if (receipt?.skill !== "foga-probe" || !/isolated child process/.test(String(receipt?.worker ?? ""))) fail(`T3's run receipt does not show the skill worker running foga-probe: ${JSON.stringify(receipt ?? null).slice(0, 300)}`);
  ok(`the skill worker ran ${receipt.skill} (${receipt.worker})`);
  if (e.summary.operations?.failed) fail(`${e.summary.operations.failed} operation(s) failed`);
  ok(`${e.summary.operations?.confirmed ?? "?"} operations confirmed, none failed`);
} else if (command === "quickstart") {
  const [dirArg, walletArg, outArg] = args;
  if (!dirArg || !walletArg) fail("usage: release-smoke quickstart <dir> <wallet> [summary.out]");
  const dir = resolve(dirArg);
  const wallet = resolve(walletArg);
  // what the summary tells the user is there (docs/quickstart.md): the cell, its documents, the flow documents the birth writes
  // after it opens the channel (1.0.5: the file name on Windows), the keys, the MCP client configurations
  for (const f of ["cell.config.json", "connect.md", "quickstart.json", "world.json", "keys/agent.api-key", "documents/manifest.json", "documents/agent-card.json", "documents/registration.json", "documents/aid-document.json", "documents/ard-agent.json", "documents/auf-unit.json", "documents/server.json", "flows/channel.json", "flows/paradigms/cell-source.v1.json", "flows/paradigms/tender-market.v1.json", "meditation/state/root.json", "mcp/claude_desktop_config.json", "mcp/claude-code.mcp.json", "mcp/cursor-mcp.json", "mcp/http-mcp.json"]) {
    if (!existsSync(join(dir, ...f.split("/")))) fail(`the quickstart did not write ${f} under ${dir}`);
  }
  ok("the cell's directory holds its configuration, documents, flow documents, maintenance state, key and MCP configurations");
  for (const f of ["wallet.json", "signer.key"]) if (!existsSync(join(wallet, f))) fail(`the wallet lacks ${f}`);
  ok("the wallet holds wallet.json and signer.key");
  const marker = readJson(join(dir, "quickstart.json"));
  if (marker.schema !== "foga.quickstart/1" || !/^0x[0-9a-fA-F]{40}$/.test(String(marker.account)) || !/^\d+$/.test(String(marker.agentId))) fail(`quickstart.json is not a cell's marker: ${JSON.stringify(marker).slice(0, 300)}`);
  if (!Array.isArray(marker.tenders) || marker.tenders.length !== 2) fail(`quickstart.json names ${marker.tenders?.length ?? 0} tenders, not the two minted for the cell`);
  if (!/^anvil/.test(String(marker.anvil))) fail(`quickstart.json does not record the anvil version: ${marker.anvil}`);
  ok(`cell ${marker.cell}: account ${marker.account}, agent ${marker.agentId}, tenders ${marker.tenders.join(", ")}, ${marker.anvil}`);
  const channel = readJson(join(dir, "flows", "channel.json"));
  if (channel.schema !== "foga.flow-channel/1" || channel.paradigm !== "foga:cell-source/v1") fail(`flows/channel.json is not the channel's metadata: ${JSON.stringify(channel).slice(0, 200)}`);
  for (const p of ["cell-source.v1.json", "tender-market.v1.json"]) {
    const d = readJson(join(dir, "flows", "paradigms", p));
    if (!d.aifp || !d.family) fail(`flows/paradigms/${p} is not a paradigm descriptor`);
  }
  ok("the channel's metadata and both paradigm descriptors are served beside the documents");
  const desktop = readJson(join(dir, "mcp", "claude_desktop_config.json"));
  const server = desktop.mcpServers?.foga;
  if (!server || !Array.isArray(server.args) || !server.args.includes("mcp")) fail("claude_desktop_config.json does not start the stdio server");
  const keyFile = String(server.env?.FOGA_OPERATOR_KEY_FILE ?? "");
  const same = (a, b) => (win32 ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(resolve(keyFile), join(wallet, "signer.key"))) fail(`the client configuration names ${keyFile}, not the wallet's signer.key`);
  ok(`the MCP client configuration starts "${server.command} ${server.args.slice(0, 2).join(" ")} …" with the wallet's key`);
  if (!win32) {
    for (const f of [join(wallet, "signer.key"), join(dir, "keys", "agent.api-key")]) {
      const mode = statSync(f).mode & 0o777;
      if (mode !== 0o600) fail(`${f} has mode ${mode.toString(8)}, not 600`);
    }
    ok("the key files are readable by their owner alone");
  } else ok("key file modes are not checked on Windows (ACLs)");
  if (outArg) {
    const out = readFileSync(resolve(outArg), "utf8");
    for (const re of [/a FOGA cell is live/, /Authorization: Bearer foga\.agent\./, /wallet +.*\(made now\)/, /documents .*committed on chain as URLs/, /A2A +POST http:\/\/127\.0\.0\.1:\d+\/a2a/]) if (!re.test(out)) fail(`the summary lacks ${re}`);
    ok("the summary names the live cell, the Bearer key, the new wallet, the committed documents and the A2A entrance");
    // the summary names hashes (package hashes, scheme ids), never the wallet's key: the key file's own text must be absent
    const secret = readFileSync(join(wallet, "signer.key"), "utf8").trim().replace(/^0x/i, "");
    if (secret.length >= 32 && out.toLowerCase().includes(secret.toLowerCase())) fail("the summary carries the wallet's private key");
    ok("the wallet's key is not in the summary");
  }
} else {
  console.error("usage: node scripts/release-smoke.mjs pack <dest> | registry <version> | where | genesis [evidence.json] | quickstart <dir> <wallet> [summary.out]");
  process.exit(2);
}

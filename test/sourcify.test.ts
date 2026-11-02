import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadBundle } from "../src/bundle/load.js";
import { collectBuildInfo, verificationRequests, verifyWorld, type BuildInfo } from "../src/world/sourcify.js";
import type { WorldFile } from "../src/world/types.js";

/**
 * Sourcify verification (3d, a 2c leftover): the requests are the standard JSON inputs of the bundle's own compiler
 * runs, matched to the world's deployed contracts by repository, name and runtime code; a dry run writes them; the
 * live path talks to the v2 API (a stand-in here: the ticket, the poll, the match, the already-verified shortcut, an
 * error). No network and no compiler needed: the build-info is synthesized from the committed bundle.
 */
function syntheticBuildInfo(dir: string, repo: string, contracts: { path: string; name: string; code: string; version: string }[]): string {
  const biDir = join(dir, "out", repo, "build-info");
  mkdirSync(biDir, { recursive: true });
  const output: BuildInfo["output"] = { contracts: {} };
  for (const c of contracts) {
    output.contracts[c.path] = output.contracts[c.path] ?? {};
    output.contracts[c.path][c.name] = { metadata: JSON.stringify({ compiler: { version: c.version }, language: "Solidity" }), evm: { deployedBytecode: { object: c.code } } };
  }
  const file = join(biDir, "abc123.json");
  writeFileSync(file, JSON.stringify({ id: "abc123", _format: "hh-sol-build-info-1", solcVersion: contracts[0].version.split("+")[0], solcLongVersion: contracts[0].version, input: { language: "Solidity", sources: Object.fromEntries(contracts.map((c) => [c.path, { content: `contract ${c.name} {}` }])), settings: { optimizer: { enabled: true, runs: 200 } } }, output }));
  return file;
}

function world(steps: { id: string; bundleKey: string; address: string; txHash?: string }[], chainId = 31337): WorldFile {
  return {
    schema: "foga.world/1",
    worldId: `test-${chainId}`,
    name: "test",
    network: chainId === 31337 ? "anvil" : "sepolia",
    chainId,
    mode: "deploy",
    bundleHash: "0x",
    deployer: "0x0000000000000000000000000000000000000001",
    contracts: Object.fromEntries(steps.map((s) => [s.id, { address: s.address, bundleKey: s.bundleKey }])),
    steps: steps.map((s) => ({ id: s.id, status: "deployed" as const, ...(s.txHash ? { txHash: s.txHash } : {}) })),
  } as unknown as WorldFile;
}

test("sourcify: requests are matched by repository, name and runtime code; a dry run writes them; the live path reads the v2 API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-sourcify-"));
  try {
    const bundle = loadBundle();
    const stub = bundle.contracts["foga:Identity8004Stub"];
    const account = bundle.contracts["foga:FogaCellAccount"];
    assert.ok(stub && account, "the committed bundle holds the local contracts");
    syntheticBuildInfo(dir, "foga", [
      { path: "src/Identity8004Stub.sol", name: "Identity8004Stub", code: stub.deployedBytecode, version: "0.8.30+commit.73712a01" },
      { path: "src/FogaCellAccount.sol", name: "FogaCellAccount", code: "0x6000", version: "0.8.30+commit.73712a01" }, // another build of the same name: not this bundle's code
    ]);
    const infos = collectBuildInfo(join(dir, "out"));
    assert.equal(infos.length, 1);
    assert.equal(infos[0].repo, "foga");
    const w = world([
      { id: "identity8004", bundleKey: "foga:Identity8004Stub", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", txHash: "0x" + "11".repeat(32) },
      { id: "foga/FogaCellAccount", bundleKey: "foga:FogaCellAccount", address: "0x" + "22".repeat(20) },
      { id: "8414/TaskToken", bundleKey: "task-token-standard:TaskToken", address: "0x" + "33".repeat(20) },
      { id: "nothing", bundleKey: "foga:NoSuchContract", address: "0x" + "44".repeat(20) },
    ]);
    const { requests, missing } = verificationRequests(w, infos);
    assert.equal(requests.length, 1);
    assert.deepEqual({ ...requests[0], stdJsonInput: undefined }, { id: "identity8004", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3", bundleKey: "foga:Identity8004Stub", creationTransactionHash: "0x" + "11".repeat(32), contractIdentifier: "src/Identity8004Stub.sol:Identity8004Stub", compilerVersion: "0.8.30+commit.73712a01", buildInfo: infos[0].file, stdJsonInput: undefined });
    assert.equal(requests[0].stdJsonInput.language, "Solidity");
    assert.deepEqual(missing.map((m) => m.id).sort(), ["8414/TaskToken", "foga/FogaCellAccount", "nothing"]);
    assert.match(missing.find((m) => m.id === "foga/FogaCellAccount")!.reason, /runtime code/);
    assert.match(missing.find((m) => m.id === "nothing")!.reason, /not in the committed bundle/);
    assert.deepEqual(verificationRequests(w, infos, { only: ["nothing"] }).requests, []);

    // a dry run on a local chain: the request files and the report
    const worldPath = join(dir, "world.json");
    writeFileSync(worldPath, JSON.stringify(w));
    const dry = await verifyWorld({ worldPath, buildInfoRoot: join(dir, "out"), outDir: join(dir, "dry"), only: ["identity8004", "nothing"] });
    assert.equal(dry.report.dryRun, true, "chain 31337 is always a dry run");
    assert.deepEqual(dry.report.summary, { "dry-run": 1 });
    assert.equal(dry.report.missing.length, 1);
    const written = JSON.parse(readFileSync(join(dir, "dry", "identity8004.json"), "utf8"));
    assert.equal(written.chainId, 31337);
    assert.equal(written.contractIdentifier, "src/Identity8004Stub.sol:Identity8004Stub");
    assert.equal(written.compilerVersion, "0.8.30+commit.73712a01");
    assert.equal(written.creationTransactionHash, "0x" + "11".repeat(32));
    assert.ok(existsSync(join(dir, "dry", "report.json")));
    await assert.rejects(verifyWorld({ worldPath, buildInfoRoot: join(dir, "out"), outDir: join(dir, "x"), dryRun: false }), /local chain/);

    // the live path against a stand-in of the v2 API: not yet verified → ticket → completed exact match; already verified; a refusal
    const sepolia = world([{ id: "identity8004", bundleKey: "foga:Identity8004Stub", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3" }], 11155111);
    const sepoliaPath = join(dir, "sepolia.json");
    writeFileSync(sepoliaPath, JSON.stringify(sepolia));
    const calls: string[] = [];
    let polls = 0;
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (/\/v2\/contract\/11155111\/0x5fbdb/i.test(url)) return json(404, { customCode: "contract_not_found" });
      if (/\/v2\/verify\/11155111\//.test(url) && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { stdJsonInput: { language: string }; compilerVersion: string; contractIdentifier: string };
        assert.equal(body.stdJsonInput.language, "Solidity");
        assert.equal(body.compilerVersion, "0.8.30+commit.73712a01");
        return json(202, { verificationId: "11111111-2222-3333-4444-555555555555" });
      }
      if (/\/v2\/verify\/11111111-/.test(url)) return json(200, ++polls < 2 ? { isJobCompleted: false, verificationId: "x" } : { isJobCompleted: true, verificationId: "x", contract: { match: "exact_match", creationMatch: "exact_match", runtimeMatch: "exact_match", chainId: "11155111", address: "0x5FbDB2315678afecb367f032d93F642f64180aa3" } });
      return json(500, {});
    }) as typeof fetch;
    const live = await verifyWorld({ worldPath: sepoliaPath, buildInfoRoot: join(dir, "out"), outDir: join(dir, "live"), server: "https://sourcify.example/server", fetchImpl: fake, pollMs: 1 });
    assert.equal(live.report.dryRun, false);
    assert.deepEqual(live.report.summary, { exact_match: 1 });
    assert.equal(live.report.results[0].verificationId, "11111111-2222-3333-4444-555555555555");
    assert.ok(calls[0].startsWith("GET https://sourcify.example/server/v2/contract/11155111/") && calls[1].startsWith("POST https://sourcify.example/server/v2/verify/11155111/"));
    const already = (async (input: string | URL | Request) => new Response(JSON.stringify(/\/v2\/contract\//.test(String(input)) ? { match: "match", creationMatch: null, runtimeMatch: "match" } : {}), { status: 200 })) as typeof fetch;
    const skipped = await verifyWorld({ worldPath: sepoliaPath, buildInfoRoot: join(dir, "out"), outDir: join(dir, "already"), server: "https://sourcify.example/server", fetchImpl: already });
    assert.deepEqual(skipped.report.summary, { already: 1 });
    const refusing = (async (input: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? { customCode: "unsupported_chain", message: "chain not supported", errorId: "e" } : {}), { status: init?.method === "POST" ? 400 : 404 })) as typeof fetch;
    const refused = await verifyWorld({ worldPath: sepoliaPath, buildInfoRoot: join(dir, "out"), outDir: join(dir, "refused"), server: "https://sourcify.example/server", fetchImpl: refusing });
    assert.deepEqual(refused.report.summary, { error: 1 });
    assert.match(refused.report.results[0].detail, /unsupported_chain/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

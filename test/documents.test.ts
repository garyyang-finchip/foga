import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AID } from "../src/core/aid.js";
import { descriptorHash } from "../src/core/ard.js";
import { keccakJcs } from "../src/core/canonical.js";
import { createHttpServer, type RunningHttpServer } from "../src/http/server.js";
import { buildDocuments, onChainState, publishSteps, readBack, readBuilt } from "../src/node/documents.js";
import { Node } from "../src/node/node.js";
import { defaultCatalog, OPERATOR_CALLER } from "../src/tools/index.js";
import { version } from "../src/util/version.js";
import { anvilPath, bornCell, foga, ok, startAnvil } from "./helpers/anvil-cell.js";

/**
 * One configuration, several documents (3d): built from the cell's configuration and the chain, served by the node
 * at /documents and the well-known paths, committed on chain by `docs_publish` as one keyed job — only what differs
 * from the chain, nothing twice — and read back. First without a public URL (data: URIs), then with one (the
 * running node's), where the read-back fetches the registration and the AID document from the node itself.
 */
const PORT = 8570;
const RPC = `http://127.0.0.1:${PORT}`;

test("documents: built, served, published on chain once, read back; a public URL moves the commitments to URLs", { timeout: 600_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-docs-"));
  let node: Node | null = null;
  let running: RunningHttpServer | null = null;
  try {
    const cell = await bornCell(RPC, dir);
    const cfg = JSON.parse(readFileSync(cell.configPath, "utf8"));
    cfg.skills.offered = ["foga-probe", "finch-extract-verify"];
    cfg.presence.provider = { organization: "Test Org", url: "https://example.org" };
    cfg.runtime.http.rateLimitPerMinute = 100_000;
    cfg.policy.budget.dailyGasWei = "50000000000000000"; // two publishes of three to four commitments each, on anvil's gas price
    writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));

    // --- build (the CLI, no key): the six files and the manifest; a publish would commit what the birth did not say
    const built1 = ok(foga(RPC, ["cell", "docs", "build", "--config", cell.configPath]), "docs build");
    assert.equal(built1.schema, "foga.documents/1");
    assert.equal(built1.version, 1);
    const docsDir = join(dir, "documents");
    for (const f of ["registration.json", "aid-document.json", "ard-agent.json", "auf-unit.json", "agent-card.json", "server.json", "manifest.json"]) assert.ok(existsSync(join(docsDir, f)), f);
    const registration = JSON.parse(readFileSync(join(docsDir, "registration.json"), "utf8"));
    assert.equal(registration.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
    assert.deepEqual(registration.registrations, [{ agentId: Number(cell.agentId), agentRegistry: `eip155:${cell.chainId}:${cell.kernel.identity.address.toLowerCase()}` }]);
    assert.deepEqual(registration.services, [], "no public URL, no endpoints");
    const aid = JSON.parse(readFileSync(join(docsDir, "aid-document.json"), "utf8"));
    assert.deepEqual(aid.facets.map((f: { facetType: string }) => f.facetType), ["aid:core/identity/v1", "aid:core/kya/v1", "aid:skills/erc8338/v1"], "identity, the attested standing, the skills; no endpoints without a URL");
    assert.equal(aid.facets[0].digest, keccakJcs(registration), "the identity facet is the registration's digest");
    const card = JSON.parse(readFileSync(join(docsDir, "agent-card.json"), "utf8"));
    assert.deepEqual(card.supportedInterfaces, [], "no A2A URL without a public URL");
    assert.deepEqual(card.skills.map((s: { id: string }) => s.id).sort(), ["finch-extract-verify@1.0.0", "foga-probe@2.0.0"].sort());
    assert.equal(card.provider.organization, "Test Org");
    assert.equal(card.capabilities.streaming, false);
    const serverJson = JSON.parse(readFileSync(join(docsDir, "server.json"), "utf8"));
    assert.equal(serverJson.name, "io.github.garyyang-finchip/foga");
    assert.deepEqual(serverJson.remotes, [], "no remote without a public URL");

    // --- the node serves them
    node = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    const catalog = defaultCatalog();
    running = await createHttpServer({ node, catalog, version, log: () => {} }).listen("127.0.0.1:0");
    const url = running.url;
    const served = await fetch(`${url}/.well-known/agent-card.json`);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get("content-type"), "application/json; charset=utf-8");
    assert.deepEqual(await served.json(), card);
    assert.deepEqual(await (await fetch(`${url}/.well-known/agent-registration.json`)).json(), registration);
    assert.deepEqual(await (await fetch(`${url}/documents/aid-document.json`)).json(), aid);
    assert.equal((await fetch(`${url}/documents/manifest.json`)).status, 200);
    assert.equal((await fetch(`${url}/documents/..%2Fcell.config.json`)).status, 404, "only the built files are served");
    assert.equal((await fetch(`${url}/documents/other.json`)).status, 404);

    // --- publish: everything the birth left behind differs now (the registration gained registrations, the document its facets, the descriptor its skills, the unit its summary)
    const before = await onChainState(node);
    assert.ok(before.agentURI?.startsWith("data:"), "the birth committed a data: URI");
    const plan = await publishSteps(node, readBuilt(docsDir)!);
    assert.deepEqual(plan.steps.map((s) => s.name), ["identity-uri", "aid-document", "ard-descriptor", "unit-version"]);
    // through the CLI (the operator key in its environment); the server above cannot answer while the CLI runs, and with data: URIs nothing needs fetching
    const out = ok(foga(RPC, ["cell", "docs", "publish", "--config", cell.configPath], { FOGA_OPERATOR_KEY: cell.keys.operator.privateKey }), "docs publish (CLI)") as { version: number; committed: string[]; unchanged: string[]; readBack: { commitment: string; ok: boolean | null }[]; jobId: string; operations: string[] };
    assert.equal(out.version, 1);
    assert.deepEqual(out.committed, ["identity-uri", "aid-document", "ard-descriptor", "unit-version"]);
    // the four commitments, and since 0.9.0 the publication anchored in the cell's ERC-8489 channel (docs/flows.md)
    assert.equal(out.operations.length, 5);
    assert.ok(out.operations.some((o) => o.endsWith(":anchor")), "the publication is anchored in the same job");
    assert.ok(out.readBack.every((r) => r.ok === true), JSON.stringify(out.readBack));
    await node.kernel.world.provider.getBlockNumber(); // the CLI's transactions happened in another process: move this kernel's read pin to the head
    const after = await onChainState(node);
    assert.ok(after.agentURI?.startsWith("data:application/json"), "the registration as a data: URI");
    assert.equal(after.aid?.digest, AID.documentCommitment(aid).digest);
    assert.equal(after.ard?.descriptorHash, descriptorHash(JSON.parse(readFileSync(join(docsDir, "ard-agent.json"), "utf8"))).hex);
    assert.equal(after.unit?.version, 2, "the birth's unit gained a version");
    const decisions = node.store.decisions({ limit: 100 }).filter((d) => d.capability === "docs_publish");
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].jobId, out.jobId);

    // --- the same documents again: the same job, nothing sent; nothing to commit
    const again = await catalog.invoke(node, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
    assert.ok(again.ok);
    assert.equal(again.jobId, out.jobId, "the same documents are the same job");
    assert.equal(node.store.all().filter((o) => o.key.startsWith(`job:${out.jobId}:`)).length, 5, "no new operation: the four commitments and the anchor");
    const planAfter = await publishSteps(node, readBuilt(docsDir)!);
    assert.deepEqual(planAfter.steps, []);
    assert.deepEqual(planAfter.unchanged.sort(), ["aid-document", "ard-descriptor", "identity-uri", "unit-version"]);
    const status = await catalog.invoke(node, "docs_status", {}, { id: "anyone", entrance: "http", level: "build", visibility: "public" });
    assert.ok(status.ok && (status.output as { pending: string[] }).pending.length === 0);

    // --- a public URL: the endpoints appear, the commitments move to URLs, the read-back fetches them from the node
    running.close();
    running = null;
    node.close();
    node = null;
    const cfg2 = JSON.parse(readFileSync(cell.configPath, "utf8"));
    cfg2.runtime.http.publicUrl = url; // the port is free again; the server below listens on the same one
    writeFileSync(cell.configPath, JSON.stringify(cfg2, null, 2));
    node = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    const port = Number(new URL(url).port);
    running = await createHttpServer({ node, catalog, version, log: () => {} }).listen(`127.0.0.1:${port}`);
    const built2 = await buildDocuments(node, { version });
    assert.equal(built2.manifest.version, 2, "the documents changed: a new version");
    assert.deepEqual(built2.registration.services, [
      { name: "MCP", endpoint: `${url}/mcp`, version: "2026-07-28" },
      { name: "A2A", endpoint: `${url}/a2a`, version: "1.0" },
      { name: "web", endpoint: url },
    ]);
    assert.deepEqual(built2.agentCard.supportedInterfaces, [{ url: `${url}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    assert.equal((built2.serverJson as { remotes: { url: string }[] }).remotes[0].url, `${url}/mcp`);
    assert.ok(built2.aidDocument.facets.some((f) => f.facetType === "aid:endpoints/v1"));
    const published2 = await catalog.invoke(node, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
    assert.ok(published2.ok, JSON.stringify(published2));
    const out2 = published2.output as { committed: string[]; readBack: { ok: boolean | null }[] };
    assert.deepEqual(out2.committed, ["identity-uri", "aid-document", "ard-descriptor"], "the unit's boundary did not change: no new version");
    assert.ok(out2.readBack.every((r) => r.ok !== false), JSON.stringify(out2.readBack));
    assert.equal(out2.readBack.find((r) => /agentURI/.test((r as { commitment: string }).commitment))!.ok, null, "the capability does not fetch URLs; the CLI's read-back does");
    const state2 = await onChainState(node);
    assert.equal(state2.agentURI, `${url}/.well-known/agent-registration.json`);
    assert.equal(state2.aid?.uri, `${url}/documents/aid-document.json`);
    assert.equal(state2.unit?.version, 2);
    const rows = await readBack(node, readBuilt(join(dir, "documents"))!, { fetchUrls: true });
    assert.ok(rows.find((r) => r.commitment === "ERC-8004 agentURI")!.ok === true && /hashes to the AID identity facet/.test(rows.find((r) => r.commitment === "ERC-8004 agentURI")!.detail), JSON.stringify(rows));
    assert.ok(rows.find((r) => r.commitment === "ERC-8434 document content")?.ok === true, "the AID document fetched from the node matches its on-chain digest");
  } finally {
    if (running) await running.close();
    node?.close();
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

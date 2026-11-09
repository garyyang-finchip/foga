import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHttpServer, type RunningHttpServer } from "../src/http/server.js";
import { buildPropagationManifest, FOGA_COVENANTS } from "../src/node/propagation.js";
import { Node } from "../src/node/node.js";
import { defaultCatalog, PUBLIC_CALLER } from "../src/tools/index.js";
import { version } from "../src/util/version.js";
import { anvilPath, bornCell, startAnvil } from "./helpers/anvil-cell.js";

/**
 * Propagation and discovery (3d-3): the free, off-chain material a cell offers so FOGA spreads — flexible, by
 * consent, at no fixed cost. The manifest builds from the configuration alone (no chain, no key); `propagation_kit`
 * is a public read that returns it; the node serves it at /.well-known/foga-cell.json, live, even before any
 * document is published. The chain part only needs a born cell so the manifest names a real account and agent id.
 */
const PORT = 8573;
const RPC = `http://127.0.0.1:${PORT}`;

test("propagation: a free manifest from the configuration, served live and read as a public capability; no chain, no cost", { timeout: 600_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-prop-"));
  let node: Node | null = null;
  let running: RunningHttpServer | null = null;
  try {
    const cell = await bornCell(RPC, dir);
    const cfg = JSON.parse(readFileSync(cell.configPath, "utf8"));
    cfg.skills.offered = ["foga-probe", "finch-extract-verify"];
    cfg.runtime.http.rateLimitPerMinute = 100_000;
    writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));

    node = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: {}, log: () => {} });
    const catalog = defaultCatalog();
    const before = node.store.decisions({ limit: 1000 }).length;

    // --- the manifest, built from the configuration alone: the covenants, the program, the declinable pointer
    const m = buildPropagationManifest(node, { version });
    assert.equal(m.schema, "foga.propagation/1");
    assert.equal(m.cell.account, cell.account);
    assert.equal(m.cell.agentId, cell.agentId);
    assert.deepEqual(m.covenants, FOGA_COVENANTS);
    assert.equal(m.covenants.length, 11, "the ten covenants plus ERC-8004");
    assert.equal(m.program.package, "@finchip.ai/foga");
    assert.match(m.program.becomeACell, /quickstart/);
    assert.equal(m.replication.optional, true);
    assert.equal(m.replication.consensual, true);
    assert.deepEqual(m.skills.sort(), ["finch-extract-verify", "foga-probe"]);
    assert.equal(m.discovery.onchain.optional, true, "on-chain discoverability is opt-in");
    assert.ok(m.discovery.free.length >= 2, "there are free discovery routes");
    // the covenants the world actually has, read off its contract keys — the local world attaches all eleven, no extension
    assert.deepEqual(m.world.covenants, [...FOGA_COVENANTS, "ERC-8490"], "the deployed local world attaches the ten covenants, ERC-8004 and the ERC-8490 extension");
    assert.deepEqual(m.world.extensions, ["ERC-8490"], "the maintenance registry is the one covenant beyond the base set (0.8.0)");
    assert.ok(m.maintenance && m.maintenance.registry, "the manifest points at the maintenance registry");
    // the services slot: the maintainer's catalog by default, visible and declinable, planned offers not for sale
    assert.ok(m.services, "the services block is present by default");
    assert.equal(m.services!.catalog, "https://foga.finchip.ai/services.json");
    assert.ok(m.services!.offers.some((s) => s.id === "become-a-cell" && s.kind === "free" && s.status === "available"));
    assert.ok(m.services!.offers.every((s) => s.kind === "free" || s.status === "planned"), "nothing paid is for sale yet");

    // --- served by the node (no public URL in this config: endpoint URLs are null, the manifest still answers)
    running = await createHttpServer({ node, catalog, version, log: () => {} }).listen("127.0.0.1:0");
    const url = running.url;
    const served = await (await fetch(`${url}/.well-known/foga-cell.json`)).json();
    assert.equal(served.schema, "foga.propagation/1");
    assert.equal(served.cell.account, cell.account);
    assert.deepEqual(served.covenants, [...FOGA_COVENANTS]);
    const front = await (await fetch(`${url}/`)).json();
    assert.equal(front.endpoints.manifest, "/.well-known/foga-cell.json", "the front page points at the manifest");
    assert.equal((await fetch(`${url}/services.json`)).status, 404, "no public URL: the pointer names the maintainer's host, this cell serves no catalog");

    // --- the public capability returns the same thing, and leaves no decision record (a read: no key, no chain, no cost)
    const kit = await catalog.invoke(node, "propagation_kit", {}, { ...PUBLIC_CALLER, entrance: "http" }, { mode: "act" });
    assert.ok(kit.ok);
    const out = kit.output as { schema: string; replication: { pointer: string }; cell: { account: string | null } };
    assert.equal(out.schema, "foga.propagation/1");
    assert.equal(out.cell.account, cell.account);
    assert.match(out.replication.pointer, /npx -y @finchip\.ai\/foga quickstart/);
    const api = await (await fetch(`${url}/api/propagation_kit`)).json();
    assert.equal(api.schema ?? api.output?.schema ?? api.result?.schema, "foga.propagation/1");
    assert.equal(node.store.decisions({ limit: 1000 }).length, before, "propagation_kit writes no decision record (it is a read)");

    // --- a config with a public URL fills the coordinates in; still no chain, still free
    const cfg2 = JSON.parse(readFileSync(cell.configPath, "utf8"));
    cfg2.runtime.http.publicUrl = "https://foga.finchip.ai";
    writeFileSync(cell.configPath, JSON.stringify(cfg2, null, 2));
    const node3 = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: {}, log: () => {} });
    try {
      const m3 = buildPropagationManifest(node3, { version });
      assert.equal(m3.endpoints.mcp, "https://foga.finchip.ai/mcp");
      assert.equal(m3.endpoints.manifest, "https://foga.finchip.ai/.well-known/foga-cell.json");
      assert.equal(m3.endpoints.card, "https://foga.finchip.ai/.well-known/agent-card.json");
      // the reference cell's public URL is the maintainer's host, so the services pointer is its own and it serves the catalog
      const serving3 = await createHttpServer({ node: node3, catalog, version, log: () => {} }).listen("127.0.0.1:0");
      try {
        const res = await fetch(`${serving3.url}/services.json`);
        assert.equal(res.status, 200);
        const doc = await res.json();
        assert.equal(doc.schema, "foga.services/1");
        assert.equal(doc.catalog, m3.services!.catalog, "the document is at the URL the manifest points at");
        assert.equal(doc.program.version, version);
        assert.ok(doc.offers.some((s: { id: string }) => s.id === "become-a-cell"));
      } finally {
        await serving3.close();
      }
    } finally {
      node3.close();
    }
  } finally {
    if (running) await running.close();
    node?.close();
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

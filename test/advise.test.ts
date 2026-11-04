import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { adviseCell, formatAdvice } from "../src/node/advise.js";
import { CellConfigSchema, newCellConfig } from "../src/node/config.js";
import { servicesOf, servicesCatalogOf, MAINTAINER_SERVICES_CATALOG, MAINTAINER_OFFERS } from "../src/node/propagation.js";
import { cleanLoopDDir } from "../src/demo/loop-d.js";
import { World } from "../src/core/world.js";
import { loadBundle } from "../src/bundle/load.js";
import type { Node } from "../src/node/node.js";

/**
 * The post-success advice (`foga cell advise`), the services slot of the manifest and the covenant list read off a
 * world — all offline: none of it touches a chain or a key, so none of it needs anvil.
 */
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

function fakeNode(p: { owner: string; operator: string; guardian: string; network: string; rpc: string; mutate?: (cfg: ReturnType<typeof newCellConfig>) => void }): Node {
  const cfg = newCellConfig({ name: "t", world: "w.json", store: "t.sqlite", owner: p.owner, operator: p.operator, guardian: p.guardian, rpc: p.rpc });
  p.mutate?.(cfg);
  const config = CellConfigSchema.parse(cfg);
  return { config, world: { network: p.network }, rpc: p.rpc } as unknown as Node;
}

test("advise: a one-key cell on a public chain is told to separate the roles first; a separated one to keep the owner offline", () => {
  const one = adviseCell(fakeNode({ owner: A, operator: A, guardian: A, network: "sepolia", rpc: "https://ethereum-sepolia-rpc.publicnode.com" }));
  assert.equal(one[0].id, "separate-roles", "the single key is the first thing said");
  assert.equal(one[0].level, "recommended");
  const ids = one.map((a) => a.id);
  for (const id of ["tune-policy", "standing", "public-face", "supervise", "backup", "dedicated-rpc"]) assert.ok(ids.includes(id), `${id} applies to a fresh public-chain cell`);
  assert.ok(!ids.includes("owner-offline"), "owner-offline is for a separated set");
  assert.ok(one.findIndex((a) => a.level === "optional") > one.findLastIndex((a) => a.level === "recommended"), "recommended before optional");

  const sep = adviseCell(fakeNode({ owner: A, operator: B, guardian: C, network: "sepolia", rpc: "https://my-own-endpoint.example/v2/key" }));
  const sids = sep.map((a) => a.id);
  assert.ok(sids.includes("owner-offline") && !sids.includes("separate-roles"));
  assert.ok(!sids.includes("dedicated-rpc"), "a dedicated endpoint draws no RPC advice");
});

test("advise: a local cell gets the local version — standing and the public face are optional, no supervisor or backup talk", () => {
  const local = adviseCell(fakeNode({ owner: A, operator: A, guardian: A, network: "anvil", rpc: "http://127.0.0.1:8545" }));
  const by = Object.fromEntries(local.map((a) => [a.id, a.level]));
  assert.equal(by["separate-roles"], "recommended");
  assert.equal(by["standing"], "optional");
  assert.equal(by["public-face"], "optional");
  assert.ok(!("supervise" in by) && !("backup" in by) && !("dedicated-rpc" in by));
});

test("advise: what is already done is not advised; the brief form is at most five recommended lines and names the command", () => {
  const done = adviseCell(
    fakeNode({
      owner: A,
      operator: B,
      guardian: C,
      network: "sepolia",
      rpc: "https://my-own-endpoint.example/v2/key",
      mutate: (cfg) => {
        cfg.policy.budget.dailyValueWei = "123";
        cfg.policy.tenders.minRewardWei = "456";
        cfg.identity.standing = { schemeId: "0x" + "ab".repeat(32), issuers: [A] };
        cfg.runtime.http.publicUrl = "https://cell.example";
        cfg.access.keys.push({ id: "p", sha256: "0x" + "cd".repeat(32), level: "act", visibility: "caller" });
      },
    }),
  );
  const ids = done.map((a) => a.id);
  for (const id of ["tune-policy", "standing", "public-face", "partner-keys", "separate-roles", "dedicated-rpc"]) assert.ok(!ids.includes(id), `${id} is settled`);
  assert.ok(ids.includes("list-registry"), "a public cell may list itself");
  const brief = formatAdvice(done, { brief: true, config: "c.json" });
  assert.ok(brief.split("\n").filter((l) => l.startsWith("  - ")).length <= 5);
  assert.match(brief, /foga cell advise --config c\.json/);
  assert.match(formatAdvice(done), /Advice, not requirements/);
  assert.equal(formatAdvice([], { brief: true }), "", "nothing recommended, nothing printed after a success");
});

test("services: the maintainer's catalog by default, the operator's own when named, none when declined", () => {
  const d = servicesOf({ presence: {} });
  assert.equal(d!.catalog, MAINTAINER_SERVICES_CATALOG);
  assert.equal(d!.maintainer, "FinChip.ai");
  assert.equal(d!.offers, MAINTAINER_OFFERS);
  assert.ok(MAINTAINER_OFFERS.filter((o) => o.kind === "paid").every((o) => o.status === "planned"), "paid offers are slots, not sales");
  const own = servicesOf({ presence: { services: { catalog: "https://ops.example/services.json", offers: [{ id: "x", name: "X", kind: "free", status: "available", url: "https://ops.example/x", description: "" }] } } });
  assert.equal(own!.catalog, "https://ops.example/services.json");
  assert.equal(own!.maintainer, "the operator of this cell");
  assert.equal(own!.offers.length, 1);
  assert.equal(servicesOf({ presence: { services: { catalog: null } } }), null, "catalog: null drops the block");
});

test("services: a cell serves the catalog its pointer names only when that catalog is its own", () => {
  const at = (publicUrl: string | undefined, services?: Record<string, unknown>) =>
    fakeNode({ owner: A, operator: A, guardian: A, network: "sepolia", rpc: "https://x.example", mutate: (cfg) => { cfg.runtime.http.publicUrl = publicUrl; if (services) (cfg.presence as Record<string, unknown>).services = services; } });
  const og = servicesCatalogOf(at("https://foga.finchip.ai"), { version: "0.6.0" });
  assert.equal(og!.schema, "foga.services/1");
  assert.equal(og!.catalog, MAINTAINER_SERVICES_CATALOG);
  assert.equal(og!.maintainer, "FinChip.ai");
  assert.equal(og!.offers, MAINTAINER_OFFERS);
  assert.equal(og!.program.version, "0.6.0");
  assert.equal(servicesCatalogOf(at("https://cell.example"), { version: "0.6.0" }), null, "the default pointer names the maintainer's host, not this cell");
  assert.equal(servicesCatalogOf(at(undefined), { version: "0.6.0" }), null, "no public URL, nothing to serve");
  const own = servicesCatalogOf(at("https://cell.example", { catalog: "https://cell.example/services.json", offers: [{ id: "x", name: "X", kind: "free", status: "available", url: "https://cell.example/x", description: "" }] }), { version: "0.6.0" });
  assert.equal(own!.maintainer, "the operator of this cell");
  assert.equal(own!.offers.length, 1);
  assert.equal(servicesCatalogOf(at("https://cell.example", { catalog: null }), { version: "0.6.0" }), null, "declined: nothing served");
});

test("world: the covenants are read off the contract keys — the base set, and an extension under a new key", () => {
  const file = (contracts: Record<string, { address: string; bundleKey: string }>) => ({ schema: "foga.world/1", worldId: "w", name: "w", network: "anvil", chainId: 31337, contracts }) as never;
  const entry = { address: A, bundleKey: "x:Y" };
  const base = new World(file({ "8338/SkillToken": entry, "8414/TaskToken": entry, "8414/HashlockVerifier": entry, "identity8004/IdentityRegistry": entry, "8471/ADRFRegistry": entry }), loadBundle(), {} as never);
  assert.deepEqual(base.covenants(), ["ERC-8004", "ERC-8338", "ERC-8414", "ERC-8471"], "one id per covenant, sorted, ERC-8004 from its identity key");
  const extended = new World(file({ "8414/TaskToken": entry, "9001/FutureRegistry": entry }), loadBundle(), {} as never);
  assert.deepEqual(extended.covenants(), ["ERC-8414", "ERC-9001"], "an eleventh covenant appears with no code change");
});

test("loop D: a second run in the same working directory starts from the run's own files cleared, nothing else touched", () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-loopd-dir-"));
  try {
    for (const f of ["D.json", "D.ops.sqlite", "D.ops.sqlite-wal", "orchestrator.sqlite", "demander.sqlite", "cases-1.json", "cases-2.json", "agent-brief.md", "keep-me.txt"]) writeFileSync(join(dir, f), "x");
    mkdirSync(join(dir, "transcripts"));
    writeFileSync(join(dir, "transcripts", "t1.json"), "x");
    mkdirSync(join(dir, "elsewhere"));
    const removed = cleanLoopDDir(dir);
    for (const f of ["D.json", "D.ops.sqlite", "D.ops.sqlite-wal", "orchestrator.sqlite", "demander.sqlite", "cases-1.json", "cases-2.json", "agent-brief.md", "transcripts/"]) assert.ok(removed.includes(f), `${f} cleared`);
    assert.ok(existsSync(join(dir, "keep-me.txt")) && existsSync(join(dir, "elsewhere")), "a file that is not the run's is left alone");
    assert.deepEqual(cleanLoopDDir(dir), [], "a clean directory removes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

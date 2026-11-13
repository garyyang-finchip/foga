import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chainByName, packagedWorldId } from "../src/core/chains.js";
import { joinLine } from "../src/node/card.js";
import { CellConfigSchema, configPath, loadCellConfig, newCellConfig, saveCellConfig } from "../src/node/config.js";
import { PACKAGE_NAME } from "../src/util/version.js";

/** The cell configuration: defaults filled in, bad values refused with their path, paths resolved against the config's directory. */
test("a new config carries the roles and the defaults of policy and runtime; invalid values are refused by path", () => {
  const cfg = newCellConfig({ name: "D", world: "deployments/local.json", store: "cells/D.sqlite", owner: "0x" + "11".repeat(20), operator: "0x" + "22".repeat(20), guardian: "0x" + "33".repeat(20) });
  assert.equal(cfg.schema, "foga.cell-config/1");
  assert.equal(cfg.policy.budget.maxConcurrentCommitments, 2);
  assert.deepEqual(cfg.policy.tenders.acceptance, ["hashlock"]);
  assert.equal(cfg.runtime.model.provider, "stub");
  assert.equal(cfg.skills.inputDir, "scenarios/fixtures");
  const bad = CellConfigSchema.safeParse({ ...cfg, policy: { ...cfg.policy, budget: { ...cfg.policy.budget, dailyValueWei: "1.5" } } });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.error!.issues[0].path, ["policy", "budget", "dailyValueWei"]);
  const minimal = CellConfigSchema.safeParse({ schema: "foga.cell-config/1", name: "m", world: "w", store: "s", identity: { owner: cfg.identity.owner, operator: cfg.identity.operator, guardian: cfg.identity.guardian }, presence: { name: "m" } });
  assert.equal(minimal.success, true);
  assert.equal(minimal.data!.identity.safety.version, 1);
});

test("a config is saved and loaded with its paths resolved against its own directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-cfg-"));
  const path = join(dir, "cells", "D.json");
  const cfg = newCellConfig({ name: "D", world: "../world.json", store: "D.sqlite", owner: "0x" + "11".repeat(20), operator: "0x" + "22".repeat(20), guardian: "0x" + "33".repeat(20) });
  saveCellConfig(path, cfg);
  const loaded = loadCellConfig(path);
  assert.equal(loaded.config.name, "D");
  assert.equal(configPath(loaded, loaded.config.world), join(dir, "world.json"));
  assert.equal(configPath(loaded, loaded.config.store), join(dir, "cells", "D.sqlite"));
  writeFileSync(path, "{ not json");
  assert.throws(() => loadCellConfig(path), /cannot read cell config/);
  writeFileSync(path, JSON.stringify({ schema: "foga.cell-config/2" }));
  assert.throws(() => loadCellConfig(path), /not a valid foga.cell-config\/1 document/);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 1.0.9: a cell joined from a published address book records where it came from (`worldSource`), and the card's
 * invitation names the chain only when the world the package ships for that chain is this very world — a project's
 * own world on a chain the table knows (a second world on Sepolia, say) is reached by its book, not the chain's name.
 */
test("worldSource is kept with the configuration; the card's join line names the chain only for the packaged world", () => {
  const base = { name: "D", world: "world.json", store: "D.sqlite", owner: "0x" + "11".repeat(20), operator: "0x" + "22".repeat(20), guardian: "0x" + "33".repeat(20) };
  assert.equal(newCellConfig(base).worldSource, undefined, "a cell joined from a file has no source URL");
  const fromUrl = newCellConfig({ ...base, worldSource: "https://example.org/chain/world/book.json" });
  assert.equal(fromUrl.worldSource, "https://example.org/chain/world/book.json");
  assert.equal(CellConfigSchema.safeParse({ ...fromUrl, worldSource: "not a url" }).success, false, "a source is a URL");
  const dir = mkdtempSync(join(tmpdir(), "foga-cfg-"));
  try {
    const path = join(dir, "cell.config.json");
    saveCellConfig(path, fromUrl);
    assert.equal(loadCellConfig(path).config.worldSource, "https://example.org/chain/world/book.json", "and it survives a save and a load");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const sepolia = chainByName("sepolia")!;
  const packaged = packagedWorldId(sepolia);
  assert.ok(packaged, "the package ships a Sepolia world");
  assert.equal(joinLine(null, packaged!, sepolia.chainId), `npx -y ${PACKAGE_NAME} join --chain sepolia`, "the packaged world: by the chain's name");
  assert.equal(joinLine(null, "sepolia-11155111-20991231T000000Z", sepolia.chainId), `npx -y ${PACKAGE_NAME} join --world <this world's address book: a file or https URL> --rpc <an RPC of chain ${sepolia.chainId}>`, "another world on the same chain: by its book, not the chain's name");
  assert.equal(joinLine("https://example.org/chain/world/book.json", "sepolia-11155111-20991231T000000Z", sepolia.chainId), `npx -y ${PACKAGE_NAME} join --world https://example.org/chain/world/book.json --rpc <an RPC of chain ${sepolia.chainId}>`, "and by the URL it came from, when it did");
  assert.equal(joinLine("https://example.org/w.json", "x-976411-20260101T000000Z", 976411), `npx -y ${PACKAGE_NAME} join --world https://example.org/w.json --rpc <an RPC of chain 976411>`, "a chain the table does not know");
});

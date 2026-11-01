import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CellConfigSchema, configPath, loadCellConfig, newCellConfig, saveCellConfig } from "../src/node/config.js";

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

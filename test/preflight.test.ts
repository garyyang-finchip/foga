import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Node } from "../src/node/node.js";
import { preflight } from "../src/node/preflight.js";
import { anvilPath, bornCell, foga, ok, startAnvil } from "./helpers/anvil-cell.js";

/**
 * `foga node preflight` (3d): the readiness reconciliation on a born cell — green where the birth left things right,
 * and naming what is wrong when the environment, the configuration or the chain disagree: a missing operator key,
 * an owner key in the node's environment, a skill offered but not held, a public URL nobody answers at, a scope
 * entry the account does not allow. Skipped without anvil.
 */
const PORT = 8572;
const RPC = `http://127.0.0.1:${PORT}`;

test("preflight: reconciles the account, keys, standing, skills, documents and public face; names what is wrong", { timeout: 600_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-preflight-"));
  try {
    const cell = await bornCell(RPC, dir);
    const cfg = JSON.parse(readFileSync(cell.configPath, "utf8"));
    cfg.skills.offered = ["foga-probe", "finch-extract-verify"];
    writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));
    const operatorKeyFile = join(dir, "operator.key");
    writeFileSync(operatorKeyFile, cell.keys.operator.privateKey + "\n", { mode: 0o600 });

    // --- in process: the node's environment as it should be
    const node = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: {}, log: () => {} });
    try {
      const env = { FOGA_OPERATOR_KEY_FILE: operatorKeyFile, PATH: process.env.PATH } as NodeJS.ProcessEnv;
      const report = await preflight(node, { env, network: false });
      const by = (check: string) => report.rows.find((r) => r.check === check);
      assert.equal(report.schema, "foga.preflight/1");
      assert.equal(by("the RPC serves the world's chain")?.verdict, "Pass");
      assert.equal(by("a revision-2 account (operator allow-list)")?.verdict, "Pass");
      assert.equal(by("the account names the configuration's owner and operator")?.verdict, "Pass");
      assert.equal(by("anchor ACTIVE and binding Satisfied")?.verdict, "Pass");
      assert.equal(by("the operator allow-list covers the node's capabilities")?.verdict, "Pass", by("the operator allow-list covers the node's capabilities")?.detail);
      assert.equal(by("the operator key is here, alone, and is the account's operator")?.verdict, "Pass");
      assert.equal(by("the operator holds gas (a quarter of the daily gas budget at least)")?.verdict, "Pass");
      assert.equal(by("the cell's KYA standing is attested and current")?.verdict, "Pass");
      assert.equal(by("every held skill's package is here and matches its on-chain commitment")?.verdict, "Pass");
      assert.equal(by("every offered skill is held")?.verdict, "Pass");
      assert.equal(by("foga-probe runs in the worker")?.verdict, "Pass", by("foga-probe runs in the worker")?.detail);
      assert.equal(by("finch-extract-verify runs in the worker")?.verdict, "Pass", by("finch-extract-verify runs in the worker")?.detail);
      assert.equal(by("the documents are built")?.verdict, "Warn", "nothing built yet");
      assert.equal(by("a public URL is configured")?.verdict, "Warn");
      assert.equal(by("the model")?.verdict, "Pass");
      assert.equal(report.summary.Fail, 0, JSON.stringify(report.rows.filter((r) => r.verdict === "Fail")));

      // --- what is wrong is named: no key, an owner key beside it, a skill offered but not held, a public URL that does not answer
      const noKey = await preflight(node, { env: { PATH: process.env.PATH }, executors: false, network: false });
      assert.equal(noKey.rows.find((r) => r.check.startsWith("the operator key is here"))?.verdict, "Fail");
      const mixed = await preflight(node, { env: { FOGA_OPERATOR_KEY_FILE: operatorKeyFile, FOGA_OWNER_KEY: cell.keys.owner.privateKey }, executors: false, network: false });
      assert.equal(mixed.rows.find((r) => r.check === "the owner key stays out of the node's environment")?.verdict, "Fail");
      assert.equal(mixed.rows.find((r) => r.check.startsWith("the operator key is here"))?.verdict, "Fail", "the isolation rule refuses a mixed environment");
    } finally {
      node.close();
    }
    cfg.skills.offered = ["foga-probe", "finch-extract-verify", "foga-oracle"];
    cfg.runtime.http.publicUrl = "http://127.0.0.1:1"; // nobody listens there
    writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));
    const wrong = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: {}, log: () => {} });
    try {
      const report = await preflight(wrong, { env: { FOGA_OPERATOR_KEY_FILE: operatorKeyFile }, executors: false });
      assert.equal(report.rows.find((r) => r.check === "every offered skill is held")?.verdict, "Fail");
      assert.equal(report.rows.find((r) => r.check === "every offered skill has an executor in this node")?.verdict, "Fail");
      assert.equal(report.rows.find((r) => r.check === "the public URL answers for this cell")?.verdict, "Warn");
    } finally {
      wrong.close();
    }

    // --- through the CLI: the table, the report file, --strict's exit code on the broken configuration, and the clean one with --wallet-less env
    const cli = foga(RPC, ["node", "preflight", "--config", cell.configPath, "--no-executors", "--no-network", "--out", join(dir, "preflight.json"), "--strict"], { FOGA_OPERATOR_KEY_FILE: operatorKeyFile });
    assert.equal(cli.code, 5, "--strict: a Fail is an exit code");
    assert.match(cli.stdout, /preflight: cell D/);
    assert.match(cli.stdout, /Fail\s+every offered skill is held/);
    const written = JSON.parse(readFileSync(join(dir, "preflight.json"), "utf8"));
    assert.equal(written.schema, "foga.preflight/1");
    cfg.skills.offered = ["foga-probe", "finch-extract-verify"];
    delete cfg.runtime.http.publicUrl;
    writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));
    const clean = foga(RPC, ["node", "preflight", "--config", cell.configPath, "--no-executors", "--strict"], { FOGA_OPERATOR_KEY_FILE: operatorKeyFile });
    assert.equal(clean.code, 0, clean.stdout.slice(-2000));
    assert.match(clean.stdout, /0 fail/);
    ok(foga(RPC, ["cell", "status", "--config", cell.configPath]), "the cell is still fine");
  } finally {
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

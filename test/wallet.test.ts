import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Wallet, parseEther } from "ethers";
import { anvilKeys } from "../src/genesis/roles.js";
import { Kernel } from "../src/kernel/kernel.js";
import { CELL_ROLES, createWallet, ensureWallet, ensuredKey, loadWallet, walletDir, walletKey } from "../src/node/wallet.js";
import { anvilPath, foga, ok, startAnvil } from "./helpers/anvil-cell.js";

/**
 * The wallet (3d): the first thing an agent makes — by default one key, its identity, which answers for every role a
 * cell needs; never overwritten, never a reason to stop — and the CLI's --wallet, which takes the place of the
 * FOGA_*_KEY environment for a cell's birth and for a node. The owner/operator/guardian split is the guarded profile's
 * opt-in hardening (--cell). The chain part births a cell with a single-key wallet through the CLI alone.
 */
const PORT = 8568;
const RPC = `http://127.0.0.1:${PORT}`;

test("wallet: one key by default, answering for every role; --cell makes the separated set; never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-wallet-"));
  try {
    // the base: one signer key
    const w = createWallet(join(dir, "w"), { name: "t" });
    assert.deepEqual(w.roles, ["signer"], "the default wallet is a single key");
    assert.equal(new Wallet(walletKey(w, "signer")).address, w.addresses.signer);
    if (process.platform !== "win32") assert.equal(statSync(w.files.signer).mode & 0o777, 0o600, "signer.key is private");
    // the one key fills owner, operator and guardian — the same address, the same file, the same key
    for (const role of CELL_ROLES) {
      assert.equal(w.addresses[role], w.addresses.signer, `${role} resolves to the signer`);
      assert.equal(walletKey(w, role), walletKey(w, "signer"), `${role}'s key is the signer's`);
    }
    const manifest = JSON.parse(readFileSync(join(dir, "w", "wallet.json"), "utf8"));
    assert.equal(manifest.schema, "foga.wallet/1");
    assert.deepEqual(Object.keys(manifest.roles), ["signer"], "only the one key is on disk");
    const again = loadWallet(join(dir, "w"))!;
    assert.deepEqual(again.addresses, w.addresses, "the addresses come from the key files");
    assert.throws(() => createWallet(join(dir, "w")), /never overwritten/);
    writeFileSync(join(dir, "full"), "x");
    assert.throws(() => createWallet(join(dir, "full")), /exists and is not empty|not a directory|ENOTDIR/);
    assert.equal(loadWallet(join(dir, "none")), null);
    // --cell: the separated owner/operator/guardian set, three distinct keys, no signer to fall back on
    const cell = createWallet(join(dir, "c"), { roles: [...CELL_ROLES] });
    assert.deepEqual(cell.roles, ["owner", "operator", "guardian"]);
    assert.equal(new Set(CELL_ROLES.map((r) => cell.addresses[r])).size, 3, "three distinct addresses");
    assert.throws(() => walletKey(cell, "signer"), /no signer key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wallet: ensureWallet makes, reuses, and falls back to keys in memory when the directory cannot be written", () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-wallet-ensure-"));
  try {
    const first = ensureWallet(join(dir, "w"));
    assert.equal(first.created, true);
    assert.equal(first.ephemeral, false);
    const second = ensureWallet(join(dir, "w"));
    assert.equal(second.created, false);
    assert.deepEqual(second.wallet.addresses, first.wallet.addresses);
    assert.equal(ensuredKey(second, "operator"), walletKey(second.wallet, "operator"));
    writeFileSync(join(dir, "blocker"), "a file in the way");
    const eph = ensureWallet(join(dir, "blocker", "w"));
    assert.equal(eph.ephemeral, true);
    assert.equal(eph.created, true);
    assert.equal(new Wallet(ensuredKey(eph, "owner")).address, eph.wallet.addresses.owner);
    assert.ok(!existsSync(join(dir, "blocker", "w")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wallet: the default and named directories follow FOGA_HOME", () => {
  const before = process.env.FOGA_HOME;
  process.env.FOGA_HOME = "/x/foga-home";
  try {
    assert.equal(walletDir(), join("/x/foga-home", "wallet"));
    assert.equal(walletDir("agent-x"), join("/x/foga-home", "wallets", "agent-x"));
  } finally {
    if (before === undefined) delete process.env.FOGA_HOME;
    else process.env.FOGA_HOME = before;
  }
});

test("wallet: a cell born through the CLI with --wallet alone, then a node tick with the same wallet", { timeout: 300_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-wallet-cell-"));
  try {
    const worldPath = join(dir, "world.json");
    const deployed = foga(RPC, ["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", worldPath]);
    assert.equal(deployed.code, 0, `world deploy failed:\n${deployed.stderr.slice(-2000)}`);
    const made = foga(RPC, ["wallet", "new", "--dir", join(dir, "wallet")]);
    assert.equal(made.code, 0, made.stderr);
    assert.match(made.stdout, /wallet made at/);
    const w = loadWallet(join(dir, "wallet"))!;
    assert.deepEqual(w.roles, ["signer"], "foga wallet new makes one key");
    // one key is owner, operator and guardian all at once; anvil's first account funds that one address
    assert.equal(w.addresses.owner, w.addresses.signer);
    assert.equal(w.addresses.operator, w.addresses.signer);
    assert.equal(w.addresses.guardian, w.addresses.signer);
    const k = await Kernel.open({ worldPath, rpc: RPC, storePath: join(dir, "funder.sqlite"), keys: { W: anvilKeys().W } });
    try {
      await k.transfer("fund.identity", "W", w.addresses.signer, parseEther("1.5"));
    } finally {
      k.close();
      k.world.provider.destroy();
    }
    const configPath = join(dir, "W.json");
    const created = foga(RPC, ["cell", "new", "--name", "W", "--world", worldPath, "--store", join(dir, "W.ops.sqlite"), "--wallet", join(dir, "wallet"), "--out", configPath]);
    assert.equal(created.code, 0, created.stderr);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(cfg.identity.owner, w.addresses.signer, "owner, operator and guardian are the one key");
    assert.equal(cfg.identity.operator, w.addresses.signer);
    assert.equal(cfg.identity.guardian, w.addresses.signer);
    const born = ok(foga(RPC, ["cell", "init", "--config", configPath, "--wallet", join(dir, "wallet")]), "cell init --wallet");
    assert.match(born.account, /^0x[0-9a-fA-F]{40}$/);
    const status = ok(foga(RPC, ["cell", "status", "--config", configPath]), "cell status");
    assert.equal(status.output.account, born.account);
    const tick = ok(foga(RPC, ["node", "tick", "--config", configPath, "--wallet", join(dir, "wallet")]), "node tick --wallet");
    assert.equal(tick.anchor, "ACTIVE");
    const both = foga(RPC, ["node", "tick", "--config", configPath, "--wallet", join(dir, "wallet")], { FOGA_OPERATOR_KEY_FILE: w.files.operator });
    assert.notEqual(both.code, 0, "--wallet beside FOGA_OPERATOR_KEY_FILE is refused");
    assert.match(both.stderr, /both set/);
  } finally {
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

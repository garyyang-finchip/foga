import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Wallet, parseEther } from "ethers";
import { anvilKeys } from "../src/genesis/roles.js";
import { Kernel } from "../src/kernel/kernel.js";
import { loadWallet } from "../src/node/wallet.js";
import { anvilPath, foga, ok, startAnvil } from "./helpers/anvil-cell.js";

/**
 * A simulation changes nothing. The capabilities that write the configuration or a fact from their output
 * (`operator_rotate`, `binding_present`, `skill_mint`, among others) wrote it even in `--mode simulate`, where nothing
 * is confirmed, and then failed reading the transaction hash of an empty list: the configuration named an operator or
 * a binding the chain did not, a later `cell status` refused to open the cell, and a guardian's suspension looked up
 * a binding that does not exist. A simulation now answers with an empty transaction hash and leaves the file and the
 * store as they were; an act still writes them. Skipped without anvil.
 */
const PORT = 8587;
const RPC = `http://127.0.0.1:${PORT}`;

test("simulate: capabilities answer without a transaction and leave the configuration as it was", { timeout: 300_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-simulate-admin-"));
  try {
    const worldPath = join(dir, "world.json");
    assert.equal(foga(RPC, ["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", worldPath]).code, 0);
    const wallet = join(dir, "wallet");
    assert.equal(foga(RPC, ["wallet", "new", "--dir", wallet]).code, 0);
    const signer = new Wallet(readFileSync(loadWallet(wallet)!.files.operator, "utf8").trim());
    const k = await Kernel.open({ worldPath, rpc: RPC, storePath: join(dir, "funder.sqlite"), keys: { W: anvilKeys().W } });
    try {
      await k.transfer("fund", "W", signer.address, parseEther("1"));
    } finally {
      k.close();
      k.world.provider.destroy();
    }
    const configPath = join(dir, "S.json");
    assert.equal(foga(RPC, ["cell", "new", "--name", "S", "--world", worldPath, "--store", join(dir, "S.ops.sqlite"), "--wallet", wallet, "--out", configPath]).code, 0);
    ok(foga(RPC, ["cell", "init", "--config", configPath, "--wallet", wallet]), "cell init");
    const before = readFileSync(configPath, "utf8");
    const unchanged = (what: string) => assert.equal(readFileSync(configPath, "utf8"), before, `${what} left the configuration as it was`);

    const rotate = ok(foga(RPC, ["cell", "owner", "operator_rotate", "--config", configPath, "--operator", "0x" + "44".repeat(20), "--mode", "simulate"]), "operator_rotate simulate");
    assert.equal(rotate.ok, true, JSON.stringify(rotate));
    assert.equal(rotate.output.txHash, "");
    unchanged("operator_rotate --mode simulate");

    const present = ok(foga(RPC, ["cell", "owner", "binding_present", "--config", configPath, "--json", JSON.stringify({ bindingIds: ["0x" + "ab".repeat(32)] }), "--mode", "simulate"]), "binding_present simulate");
    assert.equal(present.ok, true, JSON.stringify(present));
    assert.equal(present.output.txHash, "");
    unchanged("binding_present --mode simulate");

    // a skill the cell would mint: the package it would commit, nothing held
    const mint = ok(foga(RPC, ["cell", "skill_mint", "--config", configPath, "--skill", "foga-probe", "--mode", "simulate"]), "skill_mint simulate");
    assert.equal(mint.ok, true, JSON.stringify(mint));
    assert.equal(mint.output.tokenId, "0");
    assert.match(mint.output.packageHash, /^0x[0-9a-f]{64}$/);
    unchanged("skill_mint --mode simulate");

    // the cell opens as before, and the guardian still reaches the binding the chain holds
    ok(foga(RPC, ["cell", "status", "--config", configPath]), "cell status");
    const suspendSim = ok(foga(RPC, ["cell", "guardian", "guardian_suspend", "--config", configPath, "--reason", "drill", "--mode", "simulate"]), "guardian_suspend simulate");
    assert.equal(suspendSim.ok, true, JSON.stringify(suspendSim));
    assert.equal(suspendSim.output.txHash, "");
    const suspended = ok(foga(RPC, ["cell", "guardian", "guardian_suspend", "--config", configPath, "--wallet", wallet, "--reason", "drill"]), "guardian_suspend");
    assert.equal(suspended.output.state, "Suspended");
    assert.match(suspended.output.txHash, /^0x[0-9a-f]{64}$/);
    const resumeSim = ok(foga(RPC, ["cell", "guardian", "guardian_resume", "--config", configPath, "--reason", "done", "--mode", "simulate"]), "guardian_resume simulate");
    assert.equal(resumeSim.ok, true, JSON.stringify(resumeSim));
    assert.equal(resumeSim.output.txHash, "");
    ok(foga(RPC, ["cell", "guardian", "guardian_resume", "--config", configPath, "--wallet", wallet, "--reason", "done"]), "guardian_resume");
    unchanged("the guardian's acts");

    // an act still writes the configuration
    const next = new Wallet(anvilKeys().G).address;
    const rotated = ok(foga(RPC, ["cell", "owner", "operator_rotate", "--config", configPath, "--wallet", wallet, "--operator", next]), "operator_rotate");
    assert.equal(rotated.ok, true, JSON.stringify(rotated));
    assert.match(rotated.output.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(JSON.parse(readFileSync(configPath, "utf8")).identity.operator, next, "the act wrote the new operator");
  } finally {
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

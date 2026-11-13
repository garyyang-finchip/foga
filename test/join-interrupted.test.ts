import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { anvilKeys } from "../src/genesis/roles.js";
import { INIT_COMPLETE_FACT, INIT_STARTED_FACT, birthState } from "../src/node/init.js";
import { runJoin } from "../src/node/join.js";
import { Node } from "../src/node/node.js";
import { ensureWallet } from "../src/node/wallet.js";
import { anvilPath, foga, startAnvil } from "./helpers/anvil-cell.js";

/**
 * A join interrupted inside the birth, then joined again (the second Windows run's P1, 1.0.8). The account is saved the
 * moment it is deployed, so a join that took an account for a birth skipped the rest — the binding, the registration,
 * the record, the unit, the enrollment, the channel — and the first act after it, the skill mint, was refused by the
 * account (ASF `LengthMismatch`: one clause in the requirement, no binding presented). The birth now leaves its start
 * and its end on record; a join that finds the start without the end resumes the birth from the journal, whatever the
 * configuration already holds, and sends nothing twice.
 */
const PORT = 8592;
const RPC = `http://127.0.0.1:${PORT}`;

/** A log that ends the process, in effect, the moment the birth prints `pattern`: the line comes right after the step's own save. */
const dyingAt = (pattern: RegExp) => (line: string) => {
  if (pattern.test(line)) throw new Error(`simulated interruption at: ${line.trim()}`);
};
const state = async (configPath: string) => {
  const reader = await Node.open({ configPath, rpc: RPC, keys: {}, allowUnborn: true, log: () => {} });
  try {
    return { birth: birthState(reader), started: reader.kernel.fact(INIT_STARTED_FACT) !== undefined, complete: reader.kernel.fact(INIT_COMPLETE_FACT) !== undefined };
  } finally {
    reader.close();
  }
};

test("join: a birth interrupted after the account is deployed, and one interrupted after its last step, are both resumed by the next join", { timeout: 600_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-join-interrupted-"));
  try {
    const worldPath = join(dir, "world.json");
    const deployed = foga(RPC, ["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", worldPath]);
    assert.equal(deployed.code, 0, `world deploy failed:\n${deployed.stderr.slice(-1500)}`);
    const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
    const faucet = new Wallet(anvilKeys().W, provider);

    // --- early: the process dies right after the account is deployed and saved; nothing else of the birth happened
    const walletA = join(dir, "walletA");
    await (await faucet.sendTransaction({ to: ensureWallet(walletA, { name: "a" }).wallet.addresses.signer, value: parseEther("1") })).wait();
    const cellA = join(dir, "cellA");
    await assert.rejects(runJoin({ world: worldPath, rpc: RPC, wallet: walletA, dir: cellA, listen: null, exit: true, log: dyingAt(/^join:\s+account: /), out: () => {} }), /simulated interruption at: join:\s+account:/);
    const configA = join(cellA, "cell.config.json");
    const afterA = JSON.parse(readFileSync(configA, "utf8"));
    assert.ok(afterA.identity.account, "the account was saved before the interruption");
    assert.equal(afterA.identity.agentId, undefined, "nothing after the account happened");
    assert.deepEqual(await state(configA), { birth: "interrupted", started: true, complete: false });

    // the next join resumes the birth from the journal — the same account, every later step done — then the skills
    const linesA: string[] = [];
    const resumedA = await runJoin({ world: worldPath, rpc: RPC, wallet: walletA, dir: cellA, listen: null, exit: true, log: (l) => linesA.push(l), out: () => {} });
    assert.equal(resumedA.account, afterA.identity.account, "the same account, not a second one");
    assert.match(linesA.join("\n"), /did not reach its end; resuming it from the journal/);
    assert.match(linesA.join("\n"), /the birth resumed/);
    assert.match(linesA.join("\n"), /skill foga-probe minted/);
    const doneA = JSON.parse(readFileSync(configA, "utf8"));
    assert.ok(doneA.identity.agentId && doneA.identity.bindingId && doneA.identity.recordId && doneA.identity.unitId, "the birth's late fields are there now");
    assert.ok(doneA.skills.held["foga-probe"] && doneA.skills.held["finch-extract-verify"], "the skills minted after the birth");
    assert.deepEqual(await state(configA), { birth: "born", started: true, complete: true });

    // a third join: born before, nothing sent (the store does not grow)
    const storeA = join(cellA, "cell.ops.sqlite");
    const sizeA = statSync(storeA).size;
    const linesA3: string[] = [];
    const thirdA = await runJoin({ world: worldPath, rpc: RPC, wallet: walletA, dir: cellA, listen: null, exit: true, log: (l) => linesA3.push(l), out: () => {} });
    assert.equal(thirdA.account, resumedA.account);
    assert.match(linesA3.join("\n"), /born before/);
    assert.equal(statSync(storeA).size, sizeA, "a resume of a complete birth writes no new operation");

    // --- late: the process dies after the enrollment, when every field the birth fills is already in the configuration;
    // the start without the end still says interrupted, and the channel (the step after) is opened on the resume
    const walletB = join(dir, "walletB");
    await (await faucet.sendTransaction({ to: ensureWallet(walletB, { name: "b" }).wallet.addresses.signer, value: parseEther("1") })).wait();
    const cellB = join(dir, "cellB");
    await assert.rejects(runJoin({ world: worldPath, rpc: RPC, wallet: walletB, dir: cellB, listen: null, exit: true, log: dyingAt(/^join:\s+maintenance: enrolled/), out: () => {} }), /simulated interruption at: join:\s+maintenance:/);
    const configB = join(cellB, "cell.config.json");
    const afterB = JSON.parse(readFileSync(configB, "utf8"));
    assert.ok(afterB.identity.agentId && afterB.identity.bindingId && afterB.identity.recordId && afterB.identity.unitId, "the late fields are filled");
    assert.equal(afterB.flows?.channelId, undefined, "the channel was not opened");
    assert.deepEqual(await state(configB), { birth: "interrupted", started: true, complete: false });
    const linesB: string[] = [];
    const resumedB = await runJoin({ world: worldPath, rpc: RPC, wallet: walletB, dir: cellB, listen: null, exit: true, log: (l) => linesB.push(l), out: () => {} });
    assert.equal(resumedB.account, afterB.identity.account);
    assert.match(linesB.join("\n"), /the birth resumed/);
    const doneB = JSON.parse(readFileSync(configB, "utf8"));
    assert.ok(doneB.flows?.channelId, "the channel was opened on the resume");
    assert.deepEqual(await state(configB), { birth: "born", started: true, complete: true });
  } finally {
    anvil.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

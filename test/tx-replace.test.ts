import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { test } from "node:test";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { OperationStore } from "../src/kernel/store.js";
import { TxManager } from "../src/kernel/tx.js";

/**
 * The fee-replacement path of the transaction manager, against a real anvil with automine switched off: a
 * transaction that is still pending when the receipt timeout passes is re-sent with higher fees under the same
 * nonce, and whichever of the two is mined completes the operation. Skipped when anvil is not installed.
 */
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const PORT = 8599;

function anvilPath(): string | null {
  const dir = process.env.FOGA_FOUNDRY_DIR;
  const candidate = dir ? `${dir}/anvil` : "anvil";
  try {
    execFileSync(candidate, ["--version"], { stdio: "ignore" });
    return candidate;
  } catch {
    return null;
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => (s.destroy(), resolve(false)));
  });
}

async function startAnvil(bin: string): Promise<ChildProcess> {
  const child = spawn(bin, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    if (await portOpen(PORT)) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("anvil did not come up");
}

test("a transaction pending past the receipt timeout is replaced with higher fees and the operation completes", { timeout: 120_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin);
  const provider = new JsonRpcProvider(`http://127.0.0.1:${PORT}`, undefined, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = 100;
  try {
    const wallet = new Wallet(ANVIL_0, provider);
    const store = OperationStore.open(":memory:");
    const lines: string[] = [];
    const tx = new TxManager(provider, store, { W: wallet }, { receiptTimeoutMs: 1_500, maxReplacements: 2, log: (l) => lines.push(l) });
    await provider.send("anvil_setAutomine", [false]);
    const to = Wallet.createRandom().address;

    // mine one block a little after the first timeout: by then the replacement is in the pool and wins on fee
    const miner = setTimeout(() => provider.send("evm_mine", []).catch(() => {}), 2_600);
    const confirmed = await tx.send({ key: "t.transfer", signer: "W", kind: "transfer", build: () => ({ to, value: parseEther("0.5") }) });
    clearTimeout(miner);

    const events = store.journalEntries().filter((j) => j.opKey === "t.transfer").map((j) => j.event);
    assert.ok(events.includes("receipt-timeout"), `timed out once: ${events.join(",")}`);
    assert.ok(events.includes("replaced"), `replaced: ${events.join(",")}`);
    assert.equal(events.at(-1), "confirmed");
    const replaced = store.journalEntries().find((j) => j.event === "replaced")!.detail!;
    assert.equal(replaced.replaces, store.journalEntries().find((j) => j.event === "sent")!.detail!.txHash, "the replacement names the hash it replaces");
    assert.equal(confirmed.txHash, replaced.txHash, "the replacement is the transaction that was mined");
    assert.equal(store.get("t.transfer")?.status, "confirmed");
    assert.equal(store.get("t.transfer")?.txHash, confirmed.txHash);
    assert.equal(await provider.getBalance(to), parseEther("0.5"), "paid once");
    assert.equal(await provider.getTransactionCount(wallet.address), 1, "one nonce consumed");
    assert.ok(lines.some((l) => /replaced by/.test(l)));

    // the same key again is a replay: nothing new is sent
    const again = await tx.send({ key: "t.transfer", signer: "W", kind: "transfer", build: () => ({ to, value: parseEther("0.5") }) });
    assert.equal(again.replayed, true);
    assert.equal(again.txHash, confirmed.txHash);
    store.close();
  } finally {
    provider.destroy();
    anvil.kill("SIGTERM");
  }
});

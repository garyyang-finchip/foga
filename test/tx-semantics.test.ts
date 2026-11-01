import assert from "node:assert/strict";
import { test } from "node:test";
import { JsonRpcProvider, Wallet, parseEther, parseUnits } from "ethers";
import { OperationConflict, OperationStore } from "../src/kernel/store.js";
import { OperationAmbiguous, OperationReverted, TxManager, type TxManagerOptions } from "../src/kernel/tx.js";
import { MockChain } from "./mock-chain.js";

/**
 * The transaction manager's semantics, offline, against the in-process mock chain (test/mock-chain.ts): the
 * replacement limit is cumulative and persisted, the same key with another request is a conflict, a failed
 * operation is not sent again unless the caller says so, one signer's operations take nonces in order whoever
 * asks concurrently, the fee cap stops both the first send and a replacement, and a receipt lookup that fails
 * leaves the row `sent` for the next run to resolve. Each test is a fresh chain, store and signer.
 */
interface Rig {
  chain: MockChain;
  provider: JsonRpcProvider;
  store: OperationStore;
  wallet: Wallet;
  tx: TxManager;
  lines: string[];
  close(): void;
}

async function rig(options: TxManagerOptions = {}, extraSigners = 0): Promise<Rig & { others: Wallet[] }> {
  const chain = new MockChain();
  chain.autoMine = true;
  await chain.start();
  const provider = new JsonRpcProvider(chain.url, undefined, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 20;
  const wallet = new Wallet(Wallet.createRandom().privateKey, provider);
  const others = Array.from({ length: extraSigners }, () => new Wallet(Wallet.createRandom().privateKey, provider));
  const signers: Record<string, Wallet> = { W: wallet };
  others.forEach((w, i) => (signers[`S${i}`] = w));
  const store = OperationStore.open(":memory:");
  const lines: string[] = [];
  const tx = new TxManager(provider, store, signers, { receiptTimeoutMs: 200, log: (l) => lines.push(l), ...options });
  return {
    chain,
    provider,
    store,
    wallet,
    tx,
    lines,
    others,
    close() {
      store.close();
      provider.destroy();
      chain.stop();
    },
  };
}

const to = Wallet.createRandom().address;
const transfer = (key: string, extra: Record<string, unknown> = {}) => ({ key, signer: "W", kind: "transfer", build: () => ({ to, value: parseEther("0.01") }), ...extra });
const broadcasts = (chain: MockChain) => chain.calls.filter((c) => c.method === "eth_sendRawTransaction").length;
const events = (store: OperationStore, key: string) => store.journalEntries().filter((j) => j.opKey === key).map((j) => j.event);
const later = (ms: number, fn: () => void) => setTimeout(fn, ms);

test("the replacement limit is cumulative: a resumed operation at the limit waits instead of replacing again", async () => {
  const r = await rig({ maxReplacements: 1 });
  r.chain.autoMine = false;
  try {
    await assert.rejects(r.tx.send(transfer("t.cap")), (e: Error) => /after 1 fee replacement \(still pending; the limit is 1\)/.test(e.message));
    let ev = events(r.store, "t.cap");
    assert.equal(ev.filter((e) => e === "replaced").length, 1, `one replacement: ${ev.join(",")}`);
    assert.equal(ev.filter((e) => e === "receipt-timeout").length, 2, "timed out before and after the replacement");
    assert.equal(broadcasts(r.chain), 2, "the original and one replacement were broadcast");
    let rec = r.store.get("t.cap")!;
    assert.equal(rec.status, "sent");
    assert.equal(rec.replacements, 1);
    assert.equal(r.chain.poolCount(r.wallet.address), 1, "the replacement holds the nonce in the pool");
    const replacement = r.store.journalEntries().find((j) => j.event === "replaced")!.detail!.txHash as string;
    assert.equal(rec.txHash, replacement, "the row names the latest hash");
    assert.equal(r.store.journalEntries().at(-1)?.detail?.replacements, 1, "the last timeout reports the persisted count");

    // the next run: the pending transaction is found, the limit is already reached, so it is waited for as it is
    const timer = later(80, () => r.chain.mine());
    const done = await r.tx.send(transfer("t.cap"));
    clearTimeout(timer);
    ev = events(r.store, "t.cap");
    assert.equal(ev.filter((e) => e === "replaced").length, 1, "no second replacement");
    assert.ok(ev.includes("recovered-pending"), ev.join(","));
    assert.ok(ev.includes("replace-limit"), ev.join(","));
    assert.equal(ev.at(-1), "confirmed");
    assert.equal(broadcasts(r.chain), 2, "nothing new was broadcast");
    assert.equal(done.recovered, true);
    assert.equal(done.txHash, replacement, "the replacement is what was mined");
    rec = r.store.get("t.cap")!;
    assert.equal(rec.status, "confirmed");
    assert.equal(rec.replacements, 1);
    assert.equal(r.chain.minedCount(r.wallet.address), 1, "one nonce consumed");
  } finally {
    r.close();
  }
});

test("the same key with another request is a conflict, never a silent reuse; the same request is a replay", async () => {
  const r = await rig();
  try {
    const first = await r.tx.send(transfer("tender.submit:7", { binding: { requestHash: "0x" + "aa".repeat(32), capability: "tender.submit", caller: "k1" } }));
    assert.equal(first.replayed, false);
    const again = await r.tx.send(transfer("tender.submit:7", { binding: { requestHash: "0x" + "aa".repeat(32), capability: "tender.submit", caller: "k1" } }));
    assert.equal(again.replayed, true);
    assert.equal(again.txHash, first.txHash);
    const before = broadcasts(r.chain);
    await assert.rejects(r.tx.send(transfer("tender.submit:7", { binding: { requestHash: "0x" + "bb".repeat(32), capability: "tender.submit", caller: "k2" } })), (e: Error) => {
      assert.ok(e instanceof OperationConflict, e.message);
      assert.equal(e.key, "tender.submit:7");
      assert.equal(e.storedHash, "0x" + "aa".repeat(32));
      assert.equal(e.requestHash, "0x" + "bb".repeat(32));
      return true;
    });
    assert.equal(broadcasts(r.chain), before, "the conflict is decided before anything touches the chain");
    const rec = r.store.get("tender.submit:7")!;
    assert.equal(rec.status, "confirmed");
    assert.equal(rec.caller, "k1", "the binding is the first claimant's");
    assert.equal(rec.capability, "tender.submit");
    assert.equal(events(r.store, "tender.submit:7").filter((e) => e === "sent").length, 1);
  } finally {
    r.close();
  }
});

test("a key the genesis claimed without a binding gains the first binding it is asked with", async () => {
  const r = await rig();
  try {
    await r.tx.send(transfer("T3.A.submit"));
    assert.equal(r.store.get("T3.A.submit")!.requestHash, null);
    const replay = await r.tx.send(transfer("T3.A.submit", { binding: { requestHash: "0x" + "cc".repeat(32), cell: "A" } }));
    assert.equal(replay.replayed, true);
    assert.equal(r.store.get("T3.A.submit")!.requestHash, "0x" + "cc".repeat(32));
    assert.equal(r.store.get("T3.A.submit")!.cell, "A");
    await assert.rejects(r.tx.send(transfer("T3.A.submit", { binding: { requestHash: "0x" + "dd".repeat(32) } })), OperationConflict);
  } finally {
    r.close();
  }
});

test("an operation reverted on chain answers with that failure until it is retried explicitly", async () => {
  const r = await rig();
  try {
    r.chain.revertNext = 1;
    await assert.rejects(r.tx.send(transfer("t.rev")), (e: Error) => e instanceof OperationReverted && /reverted on chain/.test(e.message));
    let rec = r.store.get("t.rev")!;
    assert.equal(rec.status, "failed");
    assert.equal(rec.attempts, 1);
    assert.equal(rec.gasCostWei, 21_000n * (r.chain.baseFee + r.chain.priorityFee), "the fee of the reverted transaction is recorded");
    assert.equal(broadcasts(r.chain), 1);

    await assert.rejects(r.tx.send(transfer("t.rev")), (e: Error) => e instanceof OperationReverted && /failed before/.test(e.message) && /Retry explicitly/.test(e.message));
    assert.equal(broadcasts(r.chain), 1, "the failure is the answer; nothing was sent again");
    assert.equal(events(r.store, "t.rev").at(-1), "replayed-failure");
    assert.equal(r.store.get("t.rev")!.status, "failed");

    const done = await r.tx.send(transfer("t.rev", { retryFailed: true }));
    assert.equal(done.replayed, false);
    assert.equal(broadcasts(r.chain), 2, "the explicit retry sent a new transaction");
    rec = r.store.get("t.rev")!;
    assert.equal(rec.status, "confirmed");
    assert.equal(rec.attempts, 2);
    assert.equal(rec.nonce, 1, "a new nonce: the reverted transaction consumed nonce 0");
    const ev = events(r.store, "t.rev");
    assert.ok(ev.includes("retry"), ev.join(","));
    assert.deepEqual(ev.slice(-2), ["sent", "confirmed"]);
    const retry = r.store.journalEntries().find((j) => j.event === "retry")!.detail!;
    assert.match(String(retry.previousError), /reverted on chain/);
    const use = r.store.budgetUse("W", "1970-01-01T00:00:00.000Z");
    assert.equal(use.spentWei, parseEther("0.01") + 2n * 21_000n * (r.chain.baseFee + r.chain.priorityFee), "value moved once, fees paid twice");
    assert.equal(use.reservedWei, 0n);
  } finally {
    r.close();
  }
});

test("an estimate that reverts fails the operation before any broadcast, and the manager-level retry option re-sends it", async () => {
  const r = await rig({ retryFailed: true });
  try {
    r.chain.revertEstimates = 1;
    await assert.rejects(r.tx.send(transfer("t.est")), (e: Error) => {
      assert.ok(e instanceof OperationReverted);
      assert.match(e.message, /would revert: Error\("not yet"\)/);
      assert.ok(e.data?.startsWith("0x08c379a0"), "the revert data is kept");
      return true;
    });
    assert.equal(broadcasts(r.chain), 0);
    assert.equal(r.store.get("t.est")!.status, "failed");
    assert.equal(r.store.get("t.est")!.gasCostWei, null, "nothing was paid");
    assert.deepEqual(events(r.store, "t.est"), ["estimate-failed"]);

    // a request may still refuse the retry the manager would make
    await assert.rejects(r.tx.send(transfer("t.est", { retryFailed: false })), (e: Error) => /failed before/.test(e.message));
    assert.equal(broadcasts(r.chain), 0);

    const done = await r.tx.send(transfer("t.est"));
    assert.equal(done.replayed, false);
    assert.equal(r.store.get("t.est")!.status, "confirmed");
    assert.equal(broadcasts(r.chain), 1);
  } finally {
    r.close();
  }
});

test("one signer's operations are sent and confirmed one at a time, whoever asks concurrently; other signers run side by side", async () => {
  const r = await rig({}, 1);
  r.chain.autoMine = false;
  try {
    // a block every 30 ms: each operation waits for its receipt before the signer's next one is sent
    const miner = setInterval(() => r.chain.mine(), 30);
    const [a, b, c] = await Promise.all([r.tx.send(transfer("q.a")), r.tx.send(transfer("q.b")), r.tx.send({ key: "q.c", signer: "S0", kind: "transfer", build: () => ({ to, value: parseEther("0.01") }) })]);
    clearInterval(miner);
    assert.equal(r.store.get("q.a")!.nonce, 0);
    assert.equal(r.store.get("q.b")!.nonce, 1, "the second request took the next nonce");
    assert.equal(r.store.get("q.c")!.nonce, 0, "another signer's nonces are its own");
    for (const k of [a, b, c]) assert.equal(k.receipt.status, 1);
    assert.equal(r.chain.minedCount(r.wallet.address), 2);
    assert.equal(r.chain.minedCount(r.others[0].address), 1);
    assert.equal(broadcasts(r.chain), 3, "no replacement, no resend");
    const journal = r.store.journalEntries();
    const seq = (key: string, event: string) => journal.find((j) => j.opKey === key && j.event === event)!.seq;
    assert.ok(seq("q.a", "confirmed") < seq("q.b", "sent"), "q.b was sent only after q.a was confirmed");
    assert.ok(seq("q.c", "sent") < seq("q.a", "confirmed"), "the other signer did not wait for W's queue");
  } finally {
    r.close();
  }
});

test("a failure in one operation does not block the signer's queue", async () => {
  const r = await rig();
  try {
    r.chain.revertEstimates = 1;
    const [bad, good] = await Promise.allSettled([r.tx.send(transfer("q.bad")), r.tx.send(transfer("q.good"))]);
    assert.equal(bad.status, "rejected");
    assert.equal(good.status, "fulfilled");
    assert.equal(r.store.get("q.good")!.nonce, 0, "the failed operation took no nonce");
    assert.equal(r.store.get("q.good")!.status, "confirmed");
  } finally {
    r.close();
  }
});

test("the fee cap is applied to the first send and stops a replacement that would pass it", async () => {
  // populate: the quote is 2 x base fee + priority = 2.1 gwei; a cap below it clamps the transaction
  const r = await rig({ maxReplacements: 3 });
  try {
    const capped = await r.tx.send(transfer("f.first", { maxFeePerGasCap: parseUnits("1.5", "gwei") }));
    assert.ok(events(r.store, "f.first").includes("fee-capped"));
    const mined = [...r.chain.mined.values()].find((m) => m.hash === capped.txHash)!;
    assert.equal(mined.tx.maxFeePerGas, parseUnits("1.5", "gwei"));
    assert.equal(mined.tx.maxPriorityFeePerGas, r.chain.priorityFee, "the priority fee was already under the cap");
    assert.equal(r.store.get("f.first")!.gasCostWei, 21_000n * (r.chain.baseFee + r.chain.priorityFee));

    // replacement: a cap above the quote but below the bumped fee leaves the pending transaction as it is
    r.chain.autoMine = false;
    await assert.rejects(r.tx.send(transfer("f.replace", { maxFeePerGasCap: parseUnits("2.5", "gwei") })), (e: Error) => /raising its fees would pass the fee cap/.test(e.message));
    let ev = events(r.store, "f.replace");
    assert.ok(ev.includes("replace-capped"), ev.join(","));
    assert.ok(!ev.includes("replaced"), ev.join(","));
    assert.ok(!ev.includes("fee-capped"), "the first send was under the cap");
    const wanted = r.store.journalEntries().find((j) => j.event === "replace-capped")!.detail!;
    assert.ok(BigInt(String(wanted.wanted)) > parseUnits("2.5", "gwei"));
    assert.equal(r.store.get("f.replace")!.status, "sent");
    assert.equal(r.store.get("f.replace")!.replacements, 0);
    assert.equal(r.chain.poolCount(r.wallet.address), 1);

    // the next run finds it pending, still cannot raise it, waits, and takes the receipt when it is mined
    const timer = later(80, () => r.chain.mine());
    const done = await r.tx.send(transfer("f.replace", { maxFeePerGasCap: parseUnits("2.5", "gwei") }));
    clearTimeout(timer);
    ev = events(r.store, "f.replace");
    assert.equal(ev.filter((e) => e === "replace-capped").length, 2);
    assert.equal(ev.at(-1), "confirmed");
    assert.equal(done.recovered, true);
    assert.equal(r.store.get("f.replace")!.replacements, 0);
  } finally {
    r.close();
  }
});

test("a receipt lookup that fails leaves the row sent; the next run recovers the receipt without re-sending", async () => {
  const r = await rig();
  try {
    r.chain.failReceiptLookups = 1;
    await assert.rejects(r.tx.send(transfer("r.flaky")), (e: Error) => /receipt lookup failed/.test(e.message) || /could not coalesce/.test(e.message));
    const rec = r.store.get("r.flaky")!;
    assert.equal(rec.status, "sent", "an RPC failure is not the operation's failure");
    assert.equal(rec.error, null);
    assert.equal(r.chain.minedCount(r.wallet.address), 1, "the transaction itself was mined");
    assert.equal(broadcasts(r.chain), 1);

    const done = await r.tx.send(transfer("r.flaky"));
    assert.equal(done.recovered, true);
    assert.equal(done.replayed, false);
    assert.equal(broadcasts(r.chain), 1, "not re-sent");
    assert.equal(r.store.get("r.flaky")!.status, "confirmed");
    assert.ok(events(r.store, "r.flaky").includes("recovered-receipt"));
    assert.ok(r.lines.some((l) => /recovered receipt/.test(l)));
  } finally {
    r.close();
  }
});

test("a transaction the pool forgot is sent again as it was when its nonce is still free", async () => {
  const r = await rig({ maxReplacements: 3 });
  r.chain.autoMine = false;
  try {
    const timer = later(60, () => {
      r.chain.dropPool();
      r.chain.autoMine = true;
    });
    const done = await r.tx.send(transfer("p.drop"));
    clearTimeout(timer);
    const ev = events(r.store, "p.drop");
    assert.ok(ev.includes("resend"), ev.join(","));
    assert.ok(!ev.includes("replaced"), "a vanished transaction is re-sent, not replaced");
    assert.equal(ev.at(-1), "confirmed");
    assert.equal(broadcasts(r.chain), 2);
    const sent = r.store.journalEntries().find((j) => j.event === "sent")!.detail!.txHash;
    assert.equal(done.txHash, sent, "the same signed payload, so the same hash");
    assert.equal(r.chain.minedCount(r.wallet.address), 1);
  } finally {
    r.close();
  }
});

test("a vanished transaction whose nonce was consumed by something else is ambiguous and never retried automatically", async () => {
  const r = await rig({ maxReplacements: 3 });
  r.chain.autoMine = false;
  try {
    const timer = later(60, () => {
      r.chain.dropPool();
      r.chain.consumeNonce(r.wallet.address);
    });
    await assert.rejects(r.tx.send(transfer("p.amb")), (e: Error) => e instanceof OperationAmbiguous && /consumed by another transaction/.test(e.message));
    clearTimeout(timer);
    const rec = r.store.get("p.amb")!;
    assert.equal(rec.status, "sent", "left for a human to decide");
    assert.equal(broadcasts(r.chain), 1);
    assert.equal(events(r.store, "p.amb").at(-1), "ambiguous");

    // and the next run reaches the same verdict rather than guessing
    await assert.rejects(r.tx.send(transfer("p.amb")), OperationAmbiguous);
    assert.equal(broadcasts(r.chain), 1);
  } finally {
    r.close();
  }
});

test("the manager replaces a pending transaction with fees raised by a third, and the replacement completes the operation", async () => {
  const r = await rig({ maxReplacements: 3 });
  r.chain.autoMine = false;
  try {
    // mined a little after the first timeout: by then the replacement is in the pool and wins on fee
    const timer = later(300, () => r.chain.mine());
    const done = await r.tx.send(transfer("p.replace"));
    clearTimeout(timer);
    const ev = events(r.store, "p.replace");
    assert.equal(ev.filter((e) => e === "replaced").length, 1, ev.join(","));
    assert.equal(ev.at(-1), "confirmed");
    const replaced = r.store.journalEntries().find((j) => j.event === "replaced")!.detail!;
    const original = r.store.journalEntries().find((j) => j.event === "sent")!.detail!;
    assert.equal(replaced.replaces, original.txHash);
    assert.equal(done.txHash, replaced.txHash);
    assert.equal(replaced.attempt, 1);
    const pending = [...r.chain.mined.values()].find((m) => m.hash === done.txHash)!;
    assert.equal(pending.tx.maxFeePerGas, parseUnits("2.1", "gwei") + parseUnits("2.1", "gwei") / 3n + 1n, "a third above the original");
    assert.equal(r.store.get("p.replace")!.replacements, 1);
    assert.equal(r.chain.minedCount(r.wallet.address), 1);
    assert.ok(r.lines.some((l) => /replaced by .* \(replacement 1 of 3\)/.test(l)));
  } finally {
    r.close();
  }
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OperationStore } from "../src/kernel/store.js";

test("operation rows move prepared -> sent -> confirmed and keep their key", () => {
  const store = OperationStore.open(":memory:");
  const first = store.prepare("T3.A.submit", "execute", "operator.A");
  assert.equal(first.status, "prepared");
  assert.deepEqual(store.prepare("T3.A.submit", "execute", "operator.A"), first, "prepare is idempotent");
  store.markSent("T3.A.submit", "0xabc", 13);
  assert.equal(store.get("T3.A.submit")?.status, "sent");
  assert.equal(store.get("T3.A.submit")?.nonce, 13);
  store.markConfirmed("T3.A.submit", "0xabc", 120, { gasUsed: "1" });
  const done = store.get("T3.A.submit")!;
  assert.equal(done.status, "confirmed");
  assert.equal(done.block, 120);
  assert.deepEqual(done.result, { gasUsed: "1" });
  assert.equal(done.attempts, 1);
  assert.equal(store.summary().ops.confirmed, 1);
  store.close();
});

test("facts round-trip bigints as strings and journal entries are ordered", () => {
  const store = OperationStore.open(":memory:");
  store.setFact("T3.tokenId", 7n);
  assert.equal(store.getFact("T3.tokenId"), "7");
  store.setFact("T1.A", { address: "0x1", agentId: 3n });
  assert.deepEqual(store.getFact("T1.A"), { address: "0x1", agentId: "3" });
  assert.deepEqual(Object.keys(store.facts("T1.")), ["T1.A"]);
  assert.throws(() => store.requireFact("missing"));
  const a = store.journal("sent", { nonce: 1 }, "k");
  const b = store.journal("confirmed", undefined, "k");
  assert.ok(b > a);
  const entries = store.journalEntries();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].event, "sent");
  assert.deepEqual(entries[0].detail, { nonce: 1 });
  assert.equal(entries[1].detail, null);
  store.close();
});

test("a file-backed store survives close and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-store-"));
  const path = join(dir, "ops.sqlite");
  const s1 = OperationStore.open(path);
  s1.setMeta("genesisBlockHash", "0xgenesis");
  s1.prepare("T0.spec", "call", "W");
  s1.markSent("T0.spec", "0xdead", 0);
  s1.close();
  const s2 = OperationStore.open(path);
  assert.equal(s2.getMeta("genesisBlockHash"), "0xgenesis");
  assert.equal(s2.get("T0.spec")?.status, "sent");
  assert.equal(s2.get("T0.spec")?.txHash, "0xdead");
  s2.markFailed("T0.spec", "reverted");
  assert.equal(s2.get("T0.spec")?.error, "reverted");
  s2.close();
  rmSync(dir, { recursive: true, force: true });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationStore } from "../src/kernel/store.js";
import { newCellConfig } from "../src/node/config.js";
import type { Node } from "../src/node/node.js";
import { defaultCatalog, OPERATOR_CALLER, PUBLIC_CALLER, hashInput, type Caller } from "../src/tools/index.js";

/**
 * The catalog's own layer, offline: what each caller sees, the permission and visibility checks that stand before
 * any capability runs, the input check, and the decision record every refused attempt leaves. Nothing here
 * reaches a chain: every call is refused before the capability's plan would need one.
 */
function fakeNode(store: OperationStore, keys: Record<string, boolean> = {}): Node {
  const config = newCellConfig({ name: "T", world: "w.json", store: ":memory:", owner: "0x" + "11".repeat(20), operator: "0x" + "22".repeat(20), guardian: "0x" + "33".repeat(20) });
  return { store, config, cell: null, hasKey: (role: string) => Boolean(keys[role]), log: () => {} } as unknown as Node;
}

const apiKeyCaller: Caller = { id: "k1", entrance: "http", level: "act", visibility: "caller" };

test("the public sees reads and dry runs; an API-key caller its acts; the operator everything", () => {
  const c = defaultCatalog();
  const pub = c.list(PUBLIC_CALLER);
  assert.ok(pub.every((x) => x.visibility === "public"));
  assert.ok(pub.some((x) => x.name === "tender_precheck" && x.modes.join("/") === "simulate/build"), "the public may dry-run a precheck but not act");
  assert.ok(!pub.some((x) => x.action === "admin"));
  const caller = c.list(apiKeyCaller);
  assert.ok(caller.some((x) => x.name === "tender_submit" && x.modes.includes("act")));
  assert.ok(caller.some((x) => x.name === "job_status"), "a caller sees the caller-visible reads");
  assert.ok(!caller.some((x) => x.name === "evidence_export"), "operator data stays out of a caller's list");
  assert.ok(!caller.some((x) => x.name === "operator_rotate"), "admin capabilities are not listed to a caller");
  const op = c.list(OPERATOR_CALLER);
  assert.equal(op.length, c.names().length);
  for (const x of op) {
    assert.ok(x.inputSchema.$schema === "https://json-schema.org/draft/2020-12/schema", `${x.name} input schema is 2020-12`);
    assert.ok(x.outputSchema.$schema === "https://json-schema.org/draft/2020-12/schema", `${x.name} has an output schema`);
  }
});

test("visibility and level are checked before anything else, and every refused act leaves a decision record", async () => {
  const store = OperationStore.open(":memory:");
  const node = fakeNode(store);
  const c = defaultCatalog();
  // an operator-only capability is as if absent for a caller
  const hidden = await c.invoke(node, "evidence_export", {}, apiKeyCaller);
  assert.equal(hidden.ok, false);
  assert.equal((hidden as { gate: string }).gate, "permission");
  // a caller-visible act asked by the public: refused for its data scope first
  const scope = await c.invoke(node, "tender_submit", { tokenId: "1", resultHash: "0x" + "aa".repeat(32) }, PUBLIC_CALLER, { mode: "act" });
  assert.equal(scope.ok, false);
  assert.match((scope as { reason: string }).reason, /caller-visible; this caller sees public data/);
  // an act above the caller's level (a public capability, in act mode)
  const low = await c.invoke(node, "tender_precheck", { tokenId: "1" }, PUBLIC_CALLER, { mode: "act" });
  assert.equal(low.ok, false);
  assert.match((low as { reason: string }).reason, /needs level act; this caller has build/);
  // an admin act without the owner's key in this process
  const noKey = await c.invoke(node, "operator_rotate", { operator: "0x" + "44".repeat(20) }, OPERATOR_CALLER, { mode: "act" });
  assert.equal(noKey.ok, false);
  assert.match((noKey as { reason: string }).reason, /holds no owner key/);
  // bad input
  const bad = await c.invoke(node, "tender_submit", { tokenId: "x" }, OPERATOR_CALLER, { mode: "simulate" });
  assert.equal(bad.ok, false);
  assert.equal((bad as { gate: string }).gate, "input");
  assert.match((bad as { reason: string }).reason, /tokenId/);
  // unknown capability
  const unknown = await c.invoke(node, "nothing_here", {}, OPERATOR_CALLER);
  assert.equal(unknown.ok, false);
  assert.equal((unknown as { gate: string }).gate, "input");

  const decisions = store.decisions();
  assert.equal(decisions.length, 4, "the three permission refusals and the input refusal are recorded; the hidden read and the unknown capability leave none");
  assert.deepEqual(decisions.map((d) => d.gate), ["permission", "permission", "permission", "input"]);
  assert.ok(decisions.every((d) => d.verdict === "refused"));
  assert.equal(decisions[0].caller, "anonymous");
  assert.equal(decisions[0].entrance, "http");
  assert.equal(decisions[0].inputHash, hashInput({ tokenId: "1", resultHash: "0x" + "aa".repeat(32) }));
  assert.equal(decisions[3].mode, "simulate");
  assert.equal(store.decisions({ caller: "anonymous" }).length, 2, "a caller's own records");
  assert.equal(store.decisions({ verdict: "allowed" }).length, 0);
  store.close();
});

test("a read is answered without a record; a read above the caller's visibility is refused", async () => {
  const store = OperationStore.open(":memory:");
  const node = fakeNode(store);
  const c = defaultCatalog();
  const own = await c.invoke(node, "job_status", { jobId: "j" }, apiKeyCaller);
  assert.equal(own.ok, true);
  assert.equal((own as { output: unknown }).output, null);
  const hidden = await c.invoke(node, "job_status", { jobId: "j" }, PUBLIC_CALLER);
  assert.equal(hidden.ok, false);
  assert.equal(store.decisions().length, 0, "reads leave no decision records");
  store.close();
});

test("the input hash is canonical: key order does not matter, values do", () => {
  assert.equal(hashInput({ a: 1, b: "x" }), hashInput({ b: "x", a: 1 }));
  assert.notEqual(hashInput({ a: 1 }), hashInput({ a: 2 }));
  assert.equal(hashInput(undefined), hashInput({}));
});

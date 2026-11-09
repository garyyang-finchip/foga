import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Interface, keccak256, toUtf8Bytes } from "ethers";
import { z } from "zod";
import { ALL_LAYERS, AMM_INTERFACE_ID, LAYER_SCHEMAS, TAG_LAYER_COMMITMENT, TAG_STATE_ROOT, buildReport, checkShape, commitLayerDocument, contentHash, outcomeOf, policyArray, policyStruct, reportArray, stateRoot, validatePolicy, type CycleRecordDocument, type PolicyDocument } from "../src/core/amm.js";
import { jcs } from "../src/core/canonical.js";
import { OperationStore } from "../src/kernel/store.js";
import { OperationPending } from "../src/kernel/tx.js";
import { newCellConfig } from "../src/node/config.js";
import { layerMaskOf, layersOf } from "../src/node/meditation.js";
import type { Node } from "../src/node/node.js";
import { Catalog, OPERATOR_CALLER, type ActCapability } from "../src/tools/index.js";

/**
 * ERC-8490 offline: the kernel's hashing against the upstream vectors (test/fixtures/amm/SOURCE.md), the local
 * shape checks the registry would make, and the catalog's pending semantics — an operation that is still in flight
 * when the manager stops waiting leaves the job running and the same request resumes it.
 */
const FIX = resolve("test/fixtures/amm");
const rd = <T = any>(p: string): T => JSON.parse(readFileSync(join(FIX, p), "utf8")) as T;

test("the upstream worked example: every commitment, both roots, the policy struct, the report struct and its calldata", () => {
  const v = rd("example-mcp-timeout.json");
  assert.equal(TAG_LAYER_COMMITMENT, v.tags.layerCommitment);
  assert.equal(TAG_STATE_ROOT, v.tags.stateRoot);
  const salts = rd("mcp-timeout-cycle/salts.json");
  const files = ["runtime.json", "memory-skills.json", "tasks-roles.json", "cognition.json"];
  const commit = (set: "baseline" | "post") => {
    const records = files.map((f, i) => commitLayerDocument(i, rd(`mcp-timeout-cycle/${set}/${f}`), salts[set][i]));
    return { records, commitments: records.map((r) => r.commitment), root: stateRoot(records.map((r) => r.commitment)) };
  };
  const pre = commit("baseline");
  const post = commit("post");
  for (let i = 0; i < 4; i++) {
    assert.equal(pre.records[i].schemaId, LAYER_SCHEMAS[i]);
    assert.equal(pre.records[i].schemaHash, v.pre.layers[i].schemaHash, `layer ${i} schema hash`);
    assert.equal(pre.records[i].contentHash, v.pre.layers[i].contentHash, `layer ${i} pre content hash`);
    assert.equal(pre.records[i].commitment, v.pre.layers[i].commitment, `layer ${i} pre commitment`);
    assert.equal(post.records[i].contentHash, v.post.layers[i].contentHash, `layer ${i} post content hash`);
    assert.equal(post.records[i].commitment, v.post.layers[i].commitment, `layer ${i} post commitment`);
  }
  assert.equal(pre.root, v.pre.root);
  assert.equal(post.root, v.post.root);
  const policy = policyStruct(rd<PolicyDocument>("mcp-timeout-cycle/policy.json"));
  assert.deepEqual(policyArray(policy), v.policy.struct);
  assert.equal(policy.policyHash, v.policy.policyHash);
  assert.equal(validatePolicy(policy), null);
  const record = rd<CycleRecordDocument>("mcp-timeout-cycle/cycle-record.json");
  const { report, summary } = buildReport(record, pre, post, "ipfs://example/mcp-timeout-cycle/cycle-record.json");
  assert.deepEqual(reportArray(report).map((x) => (typeof x === "bigint" ? x.toString() : x)), v.report);
  assert.deepEqual(summary, v.summary);
  assert.equal(report.recordHash, v.record.recordHash);
  assert.equal(jcs(record).length, v.record.canonicalLength, "the canonical form is the upstream's, byte for byte");
  // the calldata the registry takes, from the upstream ABI (the same encoding the kernel module makes through the world's bundle)
  const iface = new Interface(rd("IAgentMeditation.abi.json"));
  assert.equal(iface.encodeFunctionData("report", [v.subject, report]), v.calldata);
  let acc = 0n;
  for (const f of iface.fragments) if (f.type === "function") acc ^= BigInt((f as { selector: string }).selector);
  assert.equal("0x" + acc.toString(16).padStart(8, "0"), AMM_INTERFACE_ID);
});

test("RFC 8785 canonicalization agrees with the upstream cases", () => {
  for (const c of rd("jcs.json").cases) {
    assert.equal(jcs(c.input), c.canonical);
    assert.equal(keccak256(toUtf8Bytes(jcs(c.input))), c.keccak256);
    assert.equal(contentHash(c.input), c.keccak256);
  }
});

test("the shape checks refuse what the registry refuses; the outcome follows the completed set", () => {
  assert.equal(checkShape({ layerMask: 0, completedLayers: 0, opsMask: 0, outcome: 3, trigger: 0 })?.includes("layerMask"), true);
  assert.match(checkShape({ layerMask: 1, completedLayers: 3, opsMask: 0, outcome: 0, trigger: 0 }) ?? "", /completedLayers/);
  assert.match(checkShape({ layerMask: 1, completedLayers: 1, opsMask: 1 << 4, outcome: 0, trigger: 0 }) ?? "", /out of scope/);
  assert.match(checkShape({ layerMask: 3, completedLayers: 1, opsMask: 0, outcome: 0, trigger: 0 }) ?? "", /COMPLETED/);
  assert.match(checkShape({ layerMask: 3, completedLayers: 3, opsMask: 0, outcome: 1, trigger: 0 }) ?? "", /PARTIAL/);
  assert.match(checkShape({ layerMask: 3, completedLayers: 3, opsMask: 0, outcome: 2, trigger: 0 }) ?? "", /ABORTED/);
  assert.match(checkShape({ layerMask: 3, completedLayers: 1, opsMask: 0, outcome: 3, trigger: 0 }) ?? "", /FAILED/);
  assert.equal(checkShape({ layerMask: 15, completedLayers: 15, opsMask: 0x0456, outcome: 0, trigger: 1 }), null);
  assert.equal(outcomeOf(15, 15), "completed");
  assert.equal(outcomeOf(15, 0), "failed");
  assert.equal(outcomeOf(15, 3), "partial");
  assert.equal(outcomeOf(15, 3, true), "aborted");
  // an unscoped layer must carry the pre commitment
  const pre = { commitments: ["0x" + "01".repeat(32), "0x" + "02".repeat(32), "0x" + "03".repeat(32), "0x" + "04".repeat(32)], root: "0x" + "00".repeat(32) };
  const record: CycleRecordDocument = { schema: "amm.cycle-record/1", subject: "0x" + "aa".repeat(20), policyVersion: 1, baseVersion: 1, trigger: "commanded", reportedStartedAt: 1, reportedEndedAt: 2, layers: [{ layer: 0, scope: true, completed: true, changes: [{ op: "update", description: "x" }], adoption: "adopted" }], outcome: "completed" };
  assert.throws(() => buildReport(record, pre, { commitments: ["0x" + "11".repeat(32), "0x" + "22".repeat(32), pre.commitments[2], pre.commitments[3]] }), /layer 1 is out of scope/);
  const ok = buildReport(record, pre, { commitments: ["0x" + "11".repeat(32), pre.commitments[1], pre.commitments[2], pre.commitments[3]] });
  assert.equal(ok.report.layerMask, 1);
  assert.equal(ok.report.opsMask, 1 << 2);
  assert.equal(ok.summary.changedLayers, 1);
  // the policy checks
  assert.match(validatePolicy({ policyHash: "0x" + "00".repeat(32), policyURI: "", supportedLayers: 3, requiredLayers: 7, allowedTriggers: 15, disclosure: 2, dueWindow: 0, pulseInterval: 0, maxInterval: [1, 1, 1, 1] }) ?? "", /requiredLayers/);
  assert.match(validatePolicy({ policyHash: "0x" + "00".repeat(32), policyURI: "", supportedLayers: 15, requiredLayers: 1, allowedTriggers: 15, disclosure: 2, dueWindow: 0, pulseInterval: 0, maxInterval: [0, 1, 1, 1] }) ?? "", /layer 0 is required/);
  // layer naming
  assert.equal(layerMaskOf(undefined), ALL_LAYERS);
  assert.equal(layerMaskOf("0,2"), 5);
  assert.equal(layerMaskOf(["runtime", "cognition"]), 9);
  assert.deepEqual(layersOf(10), [1, 3]);
  assert.throws(() => layerMaskOf("4"), /unknown layer/);
});

/** A node with a kernel whose `send` the test scripts: pending once, then confirmed; the account simulates as told. */
function scriptedNode(store: OperationStore, script: { pendingTimes: number; revertSimulation: boolean }): { node: Node; sends: number } {
  const state = { node: null as unknown as Node, sends: 0 };
  const config = newCellConfig({ name: "P", world: "w.json", store: ":memory:", owner: "0x" + "11".repeat(20), operator: "0x" + "22".repeat(20), guardian: "0x" + "33".repeat(20) });
  config.identity.account = "0x" + "44".repeat(20);
  const key = "job:pend-1:step";
  const tx = {
    async send(req: { key: string; signer: string }) {
      state.sends++;
      const rec = store.prepare(req.key, "direct", req.signer, {});
      if (rec.status === "sent" && store.get(req.key)?.txHash) {
        // a resumed operation: the chain has it by now
        store.markConfirmed(req.key, store.get(req.key)!.txHash!, 7, { txHash: store.get(req.key)!.txHash }, 1n);
        return { key: req.key, txHash: store.get(req.key)!.txHash!, receipt: { hash: store.get(req.key)!.txHash, blockNumber: 7, logs: [] }, replayed: false, recovered: true };
      }
      store.markSent(req.key, "0x" + "ab".repeat(32), 1, 0n);
      if (state.sends <= script.pendingTimes) throw new OperationPending(req.key, "0x" + "ab".repeat(32), `operation ${req.key}: 0x${"ab".repeat(32)} is still pending after 1 s; the row stays 'sent' and is recovered on the next run.`);
      store.markConfirmed(req.key, "0x" + "ab".repeat(32), 7, {}, 1n);
      return { key: req.key, txHash: "0x" + "ab".repeat(32), receipt: { hash: "0x" + "ab".repeat(32), blockNumber: 7, logs: [] }, replayed: false, recovered: false };
    },
  };
  const node = {
    store,
    config,
    cell: null,
    hasKey: () => true,
    signerOf: (r: string) => r,
    log: () => {},
    serialize: (fn: () => Promise<unknown>) => fn(),
    budgetUse: () => ({ valueWei: 0n, gasWei: 0n, reservedValueWei: 0n, reservedFeeWei: 0n, runningCommitments: 0 }),
    world: { provider: { getFeeData: async () => ({ maxFeePerGas: 1n, gasPrice: 1n }) } },
    kernel: { tx },
    wouldRevert: async () => (script.revertSimulation ? "Simulated()" : null),
  } as unknown as Node;
  void key;
  state.node = node;
  return state;
}

const stepCap: ActCapability = {
  name: "pend_step",
  title: "a direct step",
  description: "test",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [],
  input: z.object({ jobId: z.string().optional() }),
  output: z.object({ txHash: z.string() }),
  async plan(_ctx, input) {
    return {
      job: { id: input.jobId ?? "pend-1", kind: "test", input: {} },
      gates: [],
      valueWei: 0n,
      steps: [{ name: "step", route: "direct", by: "operator", build: () => ({ target: "0x" + "55".repeat(20), value: 0n, data: "0x", label: "step" }) }],
      output: (confirmed) => ({ txHash: confirmed[0].txHash }),
    };
  },
};

test("an operation still pending when the manager stops waiting leaves the job running; the same request resumes it without a second simulation", async () => {
  const store = OperationStore.open(":memory:");
  const s = scriptedNode(store, { pendingTimes: 1, revertSimulation: false });
  const c = new Catalog().register(stepCap);
  const first = await c.invoke(s.node, "pend_step", {}, OPERATOR_CALLER, { mode: "act" });
  assert.equal(first.ok, false);
  assert.equal((first as { gate: string }).gate, "pending");
  assert.match((first as { reason: string }).reason, /still pending/);
  const job = store.getJob("pend-1")!;
  assert.equal(job.status, "running", "the job is not failed: its operation is on its way");
  assert.deepEqual(job.operations, ["job:pend-1:step"]);
  assert.equal(store.get("job:pend-1:step")?.status, "sent");
  const d1 = store.decisions().at(-1)!;
  assert.equal(d1.verdict, "allowed");
  assert.equal(d1.gate, "pending");
  assert.equal(d1.operationId, "job:pend-1:step");

  // the same request again: the simulation would refuse now (the chain already holds the transaction), but a resumed
  // operation is not simulated; the kernel resolves it from the chain and the job completes
  (s.node as unknown as { wouldRevert: () => Promise<string | null> }).wouldRevert = async () => "BaseVersionMismatch()";
  const second = await c.invoke(s.node, "pend_step", {}, OPERATOR_CALLER, { mode: "act" });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(store.getJob("pend-1")!.status, "done");
  assert.equal(store.get("job:pend-1:step")?.status, "confirmed");
  assert.equal(s.sends, 2);

  // a third call is answered from the store: nothing sent
  const third = await c.invoke(s.node, "pend_step", {}, OPERATOR_CALLER, { mode: "act" });
  assert.equal(third.ok, true);
  assert.equal(s.sends, 2);
  assert.equal(store.decisions().at(-1)!.gate, "idempotent");
  store.close();
});

test("a fresh act is still simulated first: a simulation that reverts is a wallet refusal and sends nothing", async () => {
  const store = OperationStore.open(":memory:");
  const s = scriptedNode(store, { pendingTimes: 0, revertSimulation: true });
  const c = new Catalog().register(stepCap);
  const r = await c.invoke(s.node, "pend_step", {}, OPERATOR_CALLER, { mode: "act" });
  assert.equal(r.ok, false);
  assert.equal((r as { gate: string }).gate, "wallet");
  assert.equal(s.sends, 0);
  assert.equal(store.getJob("pend-1"), undefined, "no job is created for a refused act");
  store.close();
});

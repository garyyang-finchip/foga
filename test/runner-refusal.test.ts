import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalLapsed, TRANSIENT_REFUSAL_MS } from "../src/node/runner.js";

/** A refusal the situation can outgrow lapses; one it cannot stands (offline: the rule alone). */
test("runner: a verifier refusal for a not-yet-committed answer lapses; a mismatch, a policy or a skill refusal stands", () => {
  const now = Date.parse("2026-11-06T06:40:00.000Z");
  const earlier = new Date(now - TRANSIENT_REFUSAL_MS - 1).toISOString();
  const justNow = new Date(now - 1000).toISOString();
  assert.equal(refusalLapsed({ gate: "verifier", reason: "the hashlock verifier holds no committed answer for this tender yet", at: earlier }, now), true, "the demander commits a block after minting: look again");
  assert.equal(refusalLapsed({ gate: "verifier", reason: "the hashlock verifier holds no committed answer for this tender yet", at: justNow }, now), false, "not yet");
  assert.equal(refusalLapsed({ gate: "verifier", reason: "the task document's answerHash 0x… differs from the verifier's commitment 0x…", at: earlier }, now), false, "a mismatch stands");
  assert.equal(refusalLapsed({ gate: "budget", reason: "fees paid and reserved in the last 24 h would reach …", at: earlier }, now), true, "the day rolls");
  assert.equal(refusalLapsed({ gate: "safety", reason: "Suspended", at: earlier }, now), true);
  for (const gate of ["policy", "skill", "input", "permission", "conflict", "execution"]) assert.equal(refusalLapsed({ gate, reason: "x", at: earlier }, now), false, `${gate} stands`);
  assert.equal(refusalLapsed({ gate: "wallet", reason: "settle would revert: CallFailed(TooEarly())", at: earlier }, now), true, "a wallet refusal that may pass lapses");
  assert.equal(refusalLapsed({ gate: "budget", reason: "x", at: "not a date" }, now), false, "no timestamp, no lapse");
});

import { AbiCoder } from "ethers";
import { PROBE_RPC_FAILURE, PROBE_STATE_GONE, RECENT_BLOCKS, blocksBehind, transientRpcError } from "../src/genesis/probe.js";
import { chainAnswered, isRevertError, rpcErrorText } from "../src/kernel/provider.js";

/** What ethers hands the probe for a failed eth_call: every JSON-RPC error becomes a CALL_EXCEPTION ("missing revert data") with the node's words in info.error. */
function callFailure(nodeError: { code: number; message: string; data?: string }): Error {
  // as ethers' getRpcError does: the node's data is revert data only when it is hex (nethermind's "Reverted 0x…" is not)
  const data = nodeError.data && /^0x[0-9a-fA-F]*$/.test(nodeError.data) ? nodeError.data : null;
  const e = AbiCoder.getBuiltinCallException("call", { to: "0x" + "01".repeat(20), data: "0x31e658a5" }, data) as Error & { info?: unknown };
  e.info = { error: nodeError, payload: { method: "eth_call" } };
  return e;
}

/**
 * The probe's rule for a failed read: the chain's answer (a revert, or data of another shape) makes a null section, the
 * same in both runs; anything the transport did not deliver is transient — retried, and never a report. The code alone
 * does not tell them apart (Sepolia tenders 48 and 49: a node's "missing trie node" arrived as CALL_EXCEPTION).
 */
test("probe: a revert makes a null section; an eth_call the node did not answer is transient, whatever ethers calls it", () => {
  // reverts: data (a custom error's selector), a decoded reason, or the node's own words
  assert.equal(transientRpcError(callFailure({ code: 3, message: "execution reverted", data: "0x5f9d6a8e" })), false, "geth/erigon/reth/anvil: code 3 with data");
  assert.equal(transientRpcError(callFailure({ code: -32000, message: "execution reverted" })), false, "geth: a revert without data");
  assert.equal(transientRpcError(callFailure({ code: -32015, message: "VM execution error.", data: "Reverted 0x" })), false, "nethermind");
  assert.equal(transientRpcError(callFailure({ code: -32000, message: "Execution reverted" })), false, "besu");
  assert.equal(transientRpcError({ code: "CALL_EXCEPTION", reason: "KYA: unknown scheme", data: "0x08c379a0" }), false, "a decoded Error(string)");
  assert.equal(transientRpcError({ code: "CALL_EXCEPTION", reason: "KYA: unknown scheme" }), false, "a reason alone");
  // the chain answered with data that is not the ABI's shape: an account without that code at that block
  assert.equal(transientRpcError({ code: "BAD_DATA", value: "0x", info: { method: "status", signature: "status()" } }), false, "0x from an account without the code");
  // the transport: the node lacks the block or its state, is limited, or did not answer — all CALL_EXCEPTION to ethers
  assert.equal(transientRpcError(callFailure({ code: -32000, message: "missing trie node 7a3f…ab (path ) state 0x…: no state" })), true, "geth: state pruned");
  assert.equal(transientRpcError(callFailure({ code: -32000, message: "header not found" })), true, "geth: a block it has not reached");
  assert.equal(transientRpcError(callFailure({ code: -32000, message: "required historical state unavailable (reexec=128)" })), true, "geth: beyond reexec");
  assert.equal(transientRpcError(callFailure({ code: -32001, message: "historical state for block 12075502 is not available" })), true, "nethermind: pruned");
  assert.equal(transientRpcError(callFailure({ code: -32005, message: "rate limit exceeded" })), true, "a limit");
  assert.equal(transientRpcError(callFailure({ code: -32603, message: "Internal error" })), true, "an unexplained failure is not a revert");
  for (const code of ["SERVER_ERROR", "NETWORK_ERROR", "TIMEOUT", "UNKNOWN_ERROR", "BAD_DATA"]) assert.equal(transientRpcError({ code }), true, code);
  assert.equal(transientRpcError({ code: "UNKNOWN_ERROR", info: { error: { code: -32602, message: "block range extends beyond current head block" } } }), true, "a lagging node's log scan");
  assert.equal(transientRpcError(new Error("fetch failed")), true);
  // the shared rule and the node's words, as the kernel's pinned provider uses them
  assert.equal(isRevertError(callFailure({ code: -32000, message: "missing trie node" })), false);
  assert.equal(chainAnswered(callFailure({ code: 3, message: "execution reverted", data: "0x5f9d6a8e" })), true);
  assert.match(rpcErrorText(callFailure({ code: -32000, message: "missing trie node 7a3f" })), /^missing trie node 7a3f/, "the node's words come first");
  assert.ok(PROBE_RPC_FAILURE !== PROBE_STATE_GONE && !PROBE_STATE_GONE.startsWith(PROBE_RPC_FAILURE), "the two failures are told apart by their first words");
});

import { runFailureLapsed } from "../src/node/runner.js";
import { RUN_ATTEMPTS, runJobId, transientRunFailure } from "../src/tools/common.js";
import { OperationStore } from "../src/kernel/store.js";
import type { Node } from "../src/node/node.js";

/** A run the endpoint failed is no verdict: held back a minute, then a new job, up to RUN_ATTEMPTS; a run that failed on its merits stands. */
test("runner: a skill run the endpoint failed lapses and is a new job; one that failed on its merits stands", () => {
  const now = Date.parse("2026-11-06T18:00:00.000Z");
  const earlier = new Date(now - TRANSIENT_REFUSAL_MS - 1).toISOString();
  const justNow = new Date(now - 1000).toISOString();
  const rpc = `${PROBE_RPC_FAILURE} 7 times (missing trie node): the endpoint has not reached block 12075502; no report is made from a partial read`;
  const gone = `${PROBE_STATE_GONE} 12075502 (900 blocks behind its head; its words: historical state 5053…af79 is not available); no report is made from a partial read`;
  assert.equal(blocksBehind(gone), 900, "how far behind, from the message");
  assert.equal(blocksBehind(`${PROBE_STATE_GONE} 12075502 (its head unknown; its words: header not found)`), null);
  assert.ok(RECENT_BLOCKS >= 64 && RECENT_BLOCKS <= 256, "about a full node's window");
  assert.equal(transientRunFailure({ status: "failed", error: `skill worker (probe) exited with 1: Error: ${rpc}` }), true, "the worker's stderr carries the probe's words");
  assert.equal(transientRunFailure({ status: "failed", error: `skill worker (probe) exited with 1: Error: ${gone}` }), false, "a block the endpoint no longer serves is not tried again");
  assert.equal(transientRunFailure({ status: "failed", error: "finch-extract-verify needs input.document" }), false);
  assert.equal(transientRunFailure({ status: "done", error: null }), false);
  assert.equal(runFailureLapsed({ status: "failed", error: rpc, updatedAt: earlier }, now), true);
  assert.equal(runFailureLapsed({ status: "failed", error: rpc, updatedAt: justNow }, now), false, "not yet");
  assert.equal(runFailureLapsed({ status: "failed", error: gone, updatedAt: earlier }, now), false, "stands");

  const store = OperationStore.open(":memory:");
  const node = { store } as unknown as Node;
  const base = "skill-run:foga-probe:0123456789abcdef";
  assert.equal(runJobId(node, base), base, "no prior run: the derived id");
  store.createJob({ id: base, kind: "skill-run", inputHash: "0x" + "aa".repeat(32), input: {} });
  store.updateJob(base, { status: "failed", error: rpc });
  assert.equal(runJobId(node, base), `${base}:r2`, "after the endpoint's failure, the next attempt is a new job");
  store.createJob({ id: `${base}:r2`, kind: "skill-run", inputHash: "0x" + "aa".repeat(32), input: {} });
  store.updateJob(`${base}:r2`, { status: "failed", error: "finch-extract-verify needs input.document" });
  assert.equal(runJobId(node, base), `${base}:r2`, "a run that failed on its merits is met again (the catalog answers with it)");
  store.updateJob(`${base}:r2`, { status: "failed", error: gone });
  assert.equal(runJobId(node, base), `${base}:r2`, "so is a block the endpoint does not serve");
  store.updateJob(`${base}:r2`, { status: "failed", error: rpc });
  for (let n = 3; n <= RUN_ATTEMPTS; n++) {
    assert.equal(runJobId(node, base), `${base}:r${n}`);
    store.createJob({ id: `${base}:r${n}`, kind: "skill-run", inputHash: "0x" + "aa".repeat(32), input: {} });
    store.updateJob(`${base}:r${n}`, { status: "failed", error: rpc });
  }
  assert.equal(runJobId(node, base), `${base}:r${RUN_ATTEMPTS}`, "past the limit the last failure stands");
  store.close();
});

import { settlementDead } from "../src/node/runner.js";

/** A settlement the chain will never take ends the matter; one it may take later is held back, then looked at again. */
test("runner: a dead settlement is final; another wallet refusal lapses", () => {
  const now = Date.parse("2026-11-06T09:05:00.000Z");
  const dead = { gate: "wallet", reason: 'settle would revert: CallFailed(Error("TaskToken: verification failed")) [execution reverted]', at: new Date(now - 10 * 60_000).toISOString() };
  assert.equal(settlementDead(dead), true);
  assert.equal(refusalLapsed(dead, now), false, "a dead settlement never comes back as open");
  const early = { gate: "wallet", reason: "settle would revert: CallFailed(TooEarly())", at: new Date(now - 2 * 60_000).toISOString() };
  assert.equal(settlementDead(early), false);
  assert.equal(refusalLapsed(early, now), true, "a settle refused for a reason that passes is tried again after a minute");
  assert.equal(refusalLapsed({ ...early, at: new Date(now - 5000).toISOString() }, now), false);
});

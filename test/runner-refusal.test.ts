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
  for (const gate of ["policy", "skill", "input", "permission", "conflict", "execution", "wallet"]) assert.equal(refusalLapsed({ gate, reason: "x", at: earlier }, now), false, `${gate} stands`);
  assert.equal(refusalLapsed({ gate: "budget", reason: "x", at: "not a date" }, now), false, "no timestamp, no lapse");
});

import { transientRpcError } from "../src/genesis/probe.js";

/** The probe's rule for a failed read: a revert is the chain's answer (a null section); anything else is the transport's, retried, never a report. */
test("probe: a revert makes a null section; a transport failure is transient", () => {
  assert.equal(transientRpcError({ code: "CALL_EXCEPTION", reason: "KYA: unknown scheme" }), false);
  for (const code of ["SERVER_ERROR", "NETWORK_ERROR", "TIMEOUT", "UNKNOWN_ERROR", "BAD_DATA"]) assert.equal(transientRpcError({ code }), true, code);
  assert.equal(transientRpcError({ code: "UNKNOWN_ERROR", info: { error: { code: -32602, message: "block range extends beyond current head block" } } }), true, "a lagging node");
  assert.equal(transientRpcError(new Error("fetch failed")), true);
});

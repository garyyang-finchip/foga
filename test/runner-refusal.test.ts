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

import { transientRpcError } from "../src/genesis/probe.js";

/** The probe's rule for a failed read: a revert is the chain's answer (a null section); anything else is the transport's, retried, never a report. */
test("probe: a revert makes a null section; a transport failure is transient", () => {
  assert.equal(transientRpcError({ code: "CALL_EXCEPTION", reason: "KYA: unknown scheme" }), false);
  for (const code of ["SERVER_ERROR", "NETWORK_ERROR", "TIMEOUT", "UNKNOWN_ERROR", "BAD_DATA"]) assert.equal(transientRpcError({ code }), true, code);
  assert.equal(transientRpcError({ code: "UNKNOWN_ERROR", info: { error: { code: -32602, message: "block range extends beyond current head block" } } }), true, "a lagging node");
  assert.equal(transientRpcError(new Error("fetch failed")), true);
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

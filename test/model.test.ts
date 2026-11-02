import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { AnthropicAdapter } from "../src/node/model/anthropic.js";
import { StubAdapter, chooseTender } from "../src/node/model/stub.js";
import { ModelError, type ContentBlock, type ModelMessage, type Situation, type SituationTender, type ToolSpec } from "../src/node/model/types.js";
import { loopDVerdicts } from "../src/doctor/loop-d.js";
import type { LoopDEvidence } from "../src/demo/evidence.js";

/**
 * The model layer offline: the stub's decision table over synthetic situations (what it proposes, in what order, and
 * when it stops), the Anthropic adapter's wire shape against a stand-in for the Messages API (headers, tools, the
 * tool_result turn, retries, errors without the key), and the doctor's Loop D verdicts over a synthetic evidence file
 * where every rule is broken once.
 */
const CELL = "0x" + "aa".repeat(20);
const TOOLS: ToolSpec[] = ["tender_inspect", "tender_precheck", "skill_run", "tender_submit", "tender_settle", "credit_withdraw", "tender_mint", "cell_status"].map((name) => ({ name, description: name, inputSchema: { type: "object" } }));

function tender(tokenId: string, extra: Partial<SituationTender> = {}): SituationTender {
  return { tokenId, demander: "0x" + "bb".repeat(20), rewardWei: "1000000000000000", escrowWei: "1000000000000000", submitBy: 2_000_000_000, settleBy: 2_000_600_000, completions: 0, maxCompletions: 1, acceptanceAuthority: "0x" + "cc".repeat(20), task: { skill: "foga-probe", packageHash: "0x" + "11".repeat(32), input: { subject: CELL }, acceptance: {} }, status: "open", submission: null, creditWei: "0", ...extra };
}

function situation(tenders: SituationTender[], extra: Partial<Situation> = {}): Situation {
  return {
    at: "2026-11-02T00:00:00.000Z",
    block: 100,
    chainId: 31337,
    cell: { name: "D", account: CELL, operator: "0x" + "dd".repeat(20), anchor: "ACTIVE", safety: { verdict: "Satisfied", reasons: [] } },
    budget: { dailyValueWei: "2000000000000000", perOperationValueWei: "1000000000000000", dailyGasWei: "50000000000000000", maxConcurrentCommitments: 2, valueWei: "0", gasWei: "0", reservedValueWei: "0", reservedFeeWei: "0", runningCommitments: 0, model: { callsToday: 0, dailyCalls: 20 } },
    policy: { minRewardWei: "500000000000000", minSubmitWindowSeconds: 600, minSettleWindowSeconds: 600, acceptance: ["hashlock"], counterpartyMinLevel: 0, lookbackBlocks: 9000 },
    skills: { held: [{ name: "foga-probe", packageHash: "0x" + "11".repeat(32) }], offered: ["foga-probe"] },
    tenders,
    events: [],
    recentDecisions: [{ id: 1, at: "2026-11-02T00:00:00.000Z", caller: "runner", capability: "tender_mint", mode: "act", verdict: "refused", gate: "budget", reason: "over", jobId: null }],
    limits: { toolCalls: 12, acts: 2 },
    ...extra,
  };
}

/** Drive the stub through one tick, answering each tool call with `answers[name]`. */
async function drive(s: Situation, answers: Record<string, (input: Record<string, unknown>) => { content: unknown; isError?: boolean }>): Promise<{ calls: string[]; texts: string[] }> {
  const stub = new StubAdapter();
  const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: JSON.stringify(s) }] }];
  const calls: string[] = [];
  const texts: string[] = [];
  for (let round = 0; round < 20; round++) {
    const res = await stub.propose({ system: "", messages, tools: TOOLS });
    messages.push({ role: "assistant", content: res.content });
    for (const b of res.content) if (b.type === "text") texts.push(b.text);
    const uses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (!uses.length) break;
    const results: ContentBlock[] = [];
    for (const u of uses) {
      calls.push(u.name);
      const a = answers[u.name]?.(u.input) ?? { content: { ok: false, gate: "permission", reason: "no such tool in this test" }, isError: true };
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(a.content), ...(a.isError ? { is_error: true } : {}) });
    }
    messages.push({ role: "user", content: results });
  }
  return { calls, texts };
}

test("the stub works a tender in order — inspect, precheck, run, submit — and stops after the submission", async () => {
  const r = await drive(situation([tender("5")]), {
    tender_inspect: () => ({ content: { tokenId: "5" } }),
    tender_precheck: () => ({ content: { eligible: true, result: {} } }),
    skill_run: (input) => {
      assert.equal(input.skill, "foga-probe");
      assert.equal(input.tokenId, "5");
      return { content: { ok: true, output: { resultHash: "0x" + "ee".repeat(32), runReceipt: { schema: "foga.run-receipt/1" } } } };
    },
    tender_submit: (input) => {
      assert.equal(input.resultHash, "0x" + "ee".repeat(32));
      return { content: { ok: true, output: { submissionId: "1" } } };
    },
  });
  assert.deepEqual(r.calls, ["tender_inspect", "tender_precheck", "skill_run", "tender_submit"]);
  assert.match(r.texts.at(-1)!, /submitted/);
});

test("the stub takes a refusal as the verdict and does not look for a way around it", async () => {
  const r = await drive(situation([tender("5")]), {
    tender_inspect: () => ({ content: {} }),
    tender_precheck: () => ({ content: { eligible: false, gate: "policy", reason: "reward below the floor" } }),
  });
  assert.deepEqual(r.calls, ["tender_inspect", "tender_precheck"]);
  assert.match(r.texts.at(-1)!, /refused at policy/);
  assert.match(r.texts.at(-1)!, /Not looking for a way around it/);
});

test("the stub proposes one over-budget mint when none was tried, and never again once a decision records it", async () => {
  const fresh = situation([tender("5")], { recentDecisions: [] });
  const r = await drive(fresh, {
    tender_mint: (input) => {
      assert.equal(input.rewardWei, (5n * 1000000000000000n).toString(), "five times the per-operation cap");
      return { content: { ok: false, gate: "budget", reason: "the per-operation cap" }, isError: true };
    },
    tender_inspect: () => ({ content: {} }),
    tender_precheck: () => ({ content: { eligible: false, gate: "skill", reason: "not held" } }),
  });
  assert.deepEqual(r.calls, ["tender_mint", "tender_inspect", "tender_precheck"]);
  const again = await drive(situation([tender("5")]), { tender_inspect: () => ({ content: {} }), tender_precheck: () => ({ content: { eligible: false, gate: "skill", reason: "not held" } }) });
  assert.ok(!again.calls.includes("tender_mint"), "a recorded tender_mint decision is enough");
});

test("the stub settles a pending submission with the run's answer, withdraws credit, and leaves failed and refused tenders alone", async () => {
  const pending = tender("7", { status: "submitted", submission: { submissionId: "2", status: 0, resultHash: "0x" + "ee".repeat(32), answer: "the answer" } });
  const r = await drive(situation([pending]), {
    tender_settle: (input) => {
      assert.equal(input.submissionId, "2");
      assert.equal(input.answer, "the answer");
      return { content: { ok: true, output: { creditWei: "1000000000000000", status: 1 } } };
    },
    credit_withdraw: (input) => {
      assert.equal(input.tokenId, "7");
      return { content: { ok: true, output: { withdrawnWei: "1000000000000000" } } };
    },
  });
  assert.deepEqual(r.calls, ["tender_settle", "credit_withdraw"]);
  const s = situation([tender("1", { status: "failed", gate: "execution", reason: "the run failed" }), tender("2", { status: "refused", gate: "policy" }), tender("3", { status: "settled", creditWei: "0" })]);
  assert.equal(chooseTender(s), null, "nothing actionable");
  const idle = await drive(s, {});
  assert.deepEqual(idle.calls, []);
  assert.match(idle.texts[0], /Nothing to do/);
  const retry = situation([tender("4", { status: "refused", gate: "safety", reason: "suspended" })]);
  assert.equal(chooseTender(retry)?.tokenId, "4", "a safety refusal is retried once the binding is Satisfied again");
  assert.equal(chooseTender({ ...retry, cell: { ...retry.cell, safety: { verdict: "Suspended", reasons: ["review"] } } }), null, "not while it is suspended");
  assert.equal(chooseTender(situation([tender("9"), tender("3")]))?.tokenId, "3", "the lowest id first");
});

test("the anthropic adapter speaks the Messages API: headers, tools, tool results, retries, and errors that never carry the key", async () => {
  const seen: { headers: Record<string, string | string[] | undefined>; body: any }[] = [];
  let failures = 1;
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const body = JSON.parse(data);
      seen.push({ headers: req.headers, body });
      if (req.url !== "/v1/messages") {
        res.writeHead(404).end();
        return;
      }
      if (failures > 0) {
        failures--;
        res.writeHead(529, { "content-type": "application/json", "retry-after": "0" }).end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        return;
      }
      if (body.messages.length === 1) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_1", name: "cell_status", input: {} }], stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 5 } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "msg_2", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "Done." }], stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 2 } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    assert.throws(() => new AnthropicAdapter("", { apiKey: "k" }), /names no model/);
    assert.throws(() => new AnthropicAdapter("claude-test", { apiKey: undefined, baseUrl: `http://127.0.0.1:${port}` }), /ANTHROPIC_API_KEY/);
    const adapter = new AnthropicAdapter("claude-test", { apiKey: "sk-ant-test-secret", baseUrl: `http://127.0.0.1:${port}`, retries: 2 });
    const tools: ToolSpec[] = [{ name: "cell_status", description: "status", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, additionalProperties: false } }];
    const first = await adapter.propose({ system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "{}" }] }], tools });
    assert.equal(first.stopReason, "tool_use");
    assert.deepEqual(first.content[1], { type: "tool_use", id: "toolu_1", name: "cell_status", input: {} });
    assert.deepEqual(first.usage, { inputTokens: 10, outputTokens: 5 });
    assert.equal(seen.length, 2, "one overloaded answer, one retry");
    const req = seen[1];
    assert.equal(req.headers["x-api-key"], "sk-ant-test-secret");
    assert.equal(req.headers["anthropic-version"], "2023-06-01");
    assert.equal(req.body.model, "claude-test");
    assert.equal(req.body.system, "sys");
    assert.deepEqual(req.body.tools, [{ name: "cell_status", description: "status", input_schema: { type: "object", properties: {}, additionalProperties: false } }], "the $schema marker is dropped");
    const second = await adapter.propose({ system: "sys", messages: [{ role: "user", content: [{ type: "text", text: "{}" }] }, { role: "assistant", content: first.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "{\"name\":\"D\"}" }, { type: "tool_result", tool_use_id: "toolu_x", content: "refused", is_error: true }] }], tools });
    assert.equal(second.stopReason, "end_turn");
    const wire = seen[2].body.messages[2].content;
    assert.deepEqual(wire[0], { type: "tool_result", tool_use_id: "toolu_1", content: "{\"name\":\"D\"}" });
    assert.deepEqual(wire[1], { type: "tool_result", tool_use_id: "toolu_x", content: "refused", is_error: true });
    // a 4xx is final and the message never carries the key
    const bad = new AnthropicAdapter("claude-test", { apiKey: "sk-ant-test-secret", baseUrl: `http://127.0.0.1:${port}/nowhere`, retries: 0 });
    await assert.rejects(bad.propose({ system: "", messages: [], tools: [] }), (e: unknown) => e instanceof ModelError && e.status === 404 && !/secret/.test(e.message));
  } finally {
    server.close();
  }
});

function evidence(over: Partial<LoopDEvidence> = {}): LoopDEvidence {
  const at = "2026-11-02T00:00:01.000Z";
  const base: LoopDEvidence = {
    schema: "foga.loop-d-evidence/1",
    worldId: "w",
    chainId: 31337,
    network: "anvil",
    ranAt: at,
    finishedAt: at,
    seed: 1,
    model: { provider: "stub", model: "foga-stub/1" },
    cell: { name: "D", account: CELL, agentId: "1", owner: "0x" + "01".repeat(20), operator: "0x" + "02".repeat(20), guardian: "0x" + "03".repeat(20), bornAtBlock: 1, specId: null },
    demander: "0x" + "bb".repeat(20),
    cases: [
      { id: "a", tokenId: "1", skill: "foga-probe", rewardWei: "100", submitBy: 0, settleBy: 0, expect: { outcome: "taken" }, note: "a", answer: "x", mintTx: "0x", outcome: { status: "taken", gates: ["allowed"], decisions: [2, 3], submissions: [{ id: "1", fulfiller: CELL, status: 1, byCell: true }], settled: true, paidWei: "100", creditWei: "0", withdrawnWei: "0" } },
      { id: "c", tokenId: "2", skill: "foga-oracle", rewardWei: "100", submitBy: 0, settleBy: 0, expect: { outcome: "refused", gate: "skill" }, note: "c", answer: "x", mintTx: "0x", outcome: { status: "refused", gates: ["skill"], decisions: [4], submissions: [], settled: false, paidWei: "0", creditWei: "0", withdrawnWei: "0" } },
    ],
    budgetProbe: { attempted: true, decisionId: 1, gate: "budget", capability: "tender_mint" },
    runner: { ticks: 2, skipped: 0, errors: 0, modelCalls: 5, toolCalls: 6, acts: 2, trajectoryHashes: ["0x1", "0x2"] },
    recovery: { performed: true, killedAfterOperation: "job:tender:1:c0:submit", killedAt: at, restartedAt: "2026-11-02T00:00:02.000Z", tokenId: "1" },
    entrances: { idempotent: { decisionId: 5, gate: "idempotent", sameTxHash: true }, conflict: { decisionId: 6, gate: "conflict" }, concurrent: { requested: 3, allowed: 2, refused: [{ gate: "budget", reason: "cap" }] } },
    budget: { dailyValueWei: "2000", perOperationValueWei: "1000", dailyGasWei: "5000", maxConcurrentCommitments: 2, dailyModelCalls: 20, used: { valueWei: "1600", gasWei: "100", modelCalls: 5, skillRuns: 1, commitmentsMade: 1 } },
    chain: { fromBlock: 1, toBlock: 9, account: CELL, operator: "0x" + "02".repeat(20), operatorTxs: [{ hash: "0xt1", block: 2, nonce: 0, to: CELL, toIsAccount: true, valueWei: "0", inner: { target: "0x" + "cc".repeat(20), selector: "0x12345678", valueWei: "0", allowed: true }, status: 1 }], ownerTxs: 20, guardianTxs: 0, accountBalanceWei: { start: "0", end: "100" } },
    decisions: [
      { id: 1, at, entrance: "runner", caller: "runner", capability: "tender_mint", mode: "act", inputHash: "0x", verdict: "refused", gate: "budget", reason: "cap", jobId: "tender-mint:x", operationId: null, model: null },
      { id: 2, at, entrance: "runner", caller: "runner", capability: "tender_precheck", mode: "act", inputHash: "0x", verdict: "allowed", gate: "all", reason: "", jobId: "precheck:1", operationId: null, model: null },
      { id: 3, at, entrance: "runner", caller: "runner", capability: "tender_submit", mode: "act", inputHash: "0x", verdict: "allowed", gate: "all", reason: "", jobId: "tender:1:c0", operationId: "job:tender:1:c0:submit", model: null },
      { id: 4, at, entrance: "runner", caller: "runner", capability: "tender_precheck", mode: "act", inputHash: "0x", verdict: "refused", gate: "skill", reason: "", jobId: "precheck:2", operationId: null, model: null },
      { id: 7, at: "2026-11-02T00:00:03.000Z", entrance: "runner", caller: "watcher", capability: "tender_settle", mode: "act", inputHash: "0x", verdict: "allowed", gate: "all", reason: "", jobId: "tender:1:c0:settle", operationId: "job:tender:1:c0:settle:settle", model: null },
    ],
    jobs: [],
    operations: [
      { key: "job:tender:1:c0:submit", kind: "execute", signer: "operator", status: "confirmed", txHash: "0xt1", block: 2, nonce: 0, attempts: 1, replacements: 0, error: null, capability: "tender_submit", caller: "runner", valueWei: "0", gasCostWei: "100", createdAt: at, updatedAt: at },
      { key: "job:tender:1:c0:settle:settle", kind: "execute", signer: "operator", status: "confirmed", txHash: "0xt2", block: 5, nonce: 1, attempts: 1, replacements: 0, error: null, capability: "tender_settle", caller: "watcher", valueWei: "0", gasCostWei: "0", createdAt: "2026-11-02T00:00:03.000Z", updatedAt: "2026-11-02T00:00:03.000Z" },
    ],
    journal: [],
    summary: { cases: 2, taken: 1, refused: 1, pending: 0, decisions: { allowed: 3, refused: 2 }, operations: 2 },
  };
  return { ...base, ...over };
}

test("the Loop D verdicts pass on a clean run and name what is wrong on a broken one", () => {
  const clean = loopDVerdicts(evidence());
  assert.ok(clean.every((r) => r.verdict === "Pass" || r.check.startsWith("model-agnostic")), clean.filter((r) => r.verdict !== "Pass").map((r) => `${r.check}: ${r.actual}`).join("\n"));
  assert.equal(clean.find((r) => r.check.startsWith("model-agnostic"))!.verdict, "NotTested");
  const compared = loopDVerdicts(evidence(), evidence({ model: { provider: "anthropic", model: "claude-test" } }));
  assert.equal(compared.find((r) => r.check.startsWith("model-agnostic"))!.verdict, "Pass");
  const differing = evidence();
  differing.cases[1] = { ...differing.cases[1], outcome: { ...differing.cases[1].outcome, status: "taken", gates: ["allowed"] } };
  assert.equal(loopDVerdicts(evidence(), differing).find((r) => r.check.startsWith("model-agnostic"))!.verdict, "Fail");

  const byCheck = (rows: { check: string; verdict: string }[], prefix: string) => rows.find((r) => r.check.startsWith(prefix))!.verdict;
  // an operation without an allowed decision
  const orphan = evidence();
  orphan.operations.push({ ...orphan.operations[0], key: "job:tender:9:c0:submit", nonce: 2 });
  assert.equal(byCheck(loopDVerdicts(orphan), "every operation"), "Fail");
  // a refusal followed by an operation of its job
  const leak = evidence();
  leak.operations.push({ ...leak.operations[0], key: "job:tender-mint:x:mint", nonce: 3, createdAt: "2026-11-02T00:00:02.000Z" });
  assert.equal(byCheck(loopDVerdicts(leak), "a refused attempt"), "Fail");
  // value over the day's cap
  const spent = evidence({ budget: { ...evidence().budget, used: { ...evidence().budget.used, valueWei: "3000" } } });
  assert.equal(byCheck(loopDVerdicts(spent), "spend within"), "Fail");
  // an operator transaction elsewhere, and one whose inner call is not allow-listed
  const astray = evidence();
  astray.chain.operatorTxs.push({ hash: "0xt9", block: 3, nonce: 4, to: "0x" + "ee".repeat(20), toIsAccount: false, valueWei: "0", inner: null, status: 1 });
  assert.equal(byCheck(loopDVerdicts(astray), "operator transactions"), "Fail");
  // a taken case whose reward did not reach the account; a refused case refused at another gate
  const unpaid = evidence();
  unpaid.cases[0].outcome.paidWei = "0";
  assert.equal(byCheck(loopDVerdicts(unpaid), "case a"), "Fail");
  const wrongGate = evidence();
  wrongGate.cases[1].outcome.gates = ["policy"];
  assert.equal(byCheck(loopDVerdicts(wrongGate), "case c"), "Fail");
  // the budget probe never made, the recovery not performed: not tested, not failed
  const noProbe = evidence({ budgetProbe: { attempted: false, decisionId: null, gate: null, capability: null }, recovery: { performed: false, killedAfterOperation: null, killedAt: null, restartedAt: null, tokenId: null } });
  assert.equal(byCheck(loopDVerdicts(noProbe), "case g"), "NotTested");
  assert.equal(byCheck(loopDVerdicts(noProbe), "recovery"), "NotTested");
  // two submissions after a recovery: something was sent twice
  const twice = evidence();
  twice.operations.push({ ...twice.operations[0], key: "job:tender:1:c1:submit", nonce: 5 });
  twice.decisions.push({ ...twice.decisions[2], id: 8, jobId: "tender:1:c1" });
  assert.equal(byCheck(loopDVerdicts(twice), "recovery"), "Fail");
  // a repeated nonce
  const nonce = evidence();
  nonce.operations[1] = { ...nonce.operations[1], nonce: 0 };
  assert.equal(byCheck(loopDVerdicts(nonce), "concurrent acts"), "Fail");
});

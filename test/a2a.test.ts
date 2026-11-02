import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseEther } from "ethers";
import { fogaRequestOf } from "../src/a2a/server.js";
import { A2A_ERRORS } from "../src/a2a/types.js";
import { dataUri, keccakJcs, sha256Hex } from "../src/core/canonical.js";
import { hashlock, nativeTerms } from "../src/core/tenders.js";
import { runProbe, type ProbeInput } from "../src/genesis/probe.js";
import { createHttpServer, type RunningHttpServer } from "../src/http/server.js";
import { buildDocuments } from "../src/node/documents.js";
import { Node } from "../src/node/node.js";
import { Watchers } from "../src/node/watchers.js";
import { defaultCatalog } from "../src/tools/index.js";
import { version } from "../src/util/version.js";
import { anvilPath, bornCell, foga, startAnvil } from "./helpers/anvil-cell.js";

/**
 * The A2A entrance (3d; A2A 1.0, JSON-RPC binding): the card at the well-known path, the version header, a quote
 * for anyone (in words or as a data part; a skill the cell lacks is REJECTED), the tender road for an act-level
 * caller — the cell works an existing funded tender through its own catalog and the task carries the submission —
 * and the roads closed to the public, the follow-up on INPUT_REQUIRED, GetTask, ListTasks (one's own tasks only),
 * CancelTask (not after a broadcast), duplicate messages, unknown and unsupported methods. Skipped without anvil.
 */
const PORT = 8571;
const RPC = `http://127.0.0.1:${PORT}`;

test("a2a: the foga request of a message — a data part with a foga object, or words", () => {
  assert.deepEqual(fogaRequestOf({ messageId: "1", role: "ROLE_USER", parts: [{ text: "can you probe me?" }] }), { mode: "quote", text: "can you probe me?" });
  assert.deepEqual(fogaRequestOf({ messageId: "2", role: "ROLE_USER", parts: [{ data: { foga: { mode: "tender", tokenId: 7 } } }] }), { mode: "tender", skill: undefined, input: undefined, tokenId: "7" });
  assert.deepEqual(fogaRequestOf({ messageId: "3", role: "ROLE_USER", parts: [{ text: "hi" }, { data: { foga: { mode: "quote", skill: "foga-probe", input: { block: 1 } } } }] }), { mode: "quote", skill: "foga-probe", input: { block: 1 }, tokenId: undefined });
  assert.deepEqual(fogaRequestOf({ messageId: "4", role: "ROLE_USER", parts: [{ data: { something: "else" } }] }), { mode: "quote", text: undefined });
});

test("a2a over JSON-RPC on a born cell: card, quote, tender, tasks", { timeout: 600_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-a2a-"));
  let node: Node | null = null;
  let running: RunningHttpServer | null = null;
  try {
    const cell = await bornCell(RPC, dir);
    const k = cell.kernel;
    const W = cell.keys.W;
    const D = cell.account;
    const cfg = JSON.parse(readFileSync(cell.configPath, "utf8"));
    cfg.skills.offered = ["foga-probe", "finch-extract-verify"];
    cfg.runtime.http.rateLimitPerMinute = 100_000;
    writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));
    const keyOut = foga(RPC, ["node", "key", "new", "--config", cell.configPath, "--id", "integration", "--level", "act"]);
    assert.equal(keyOut.code, 0, keyOut.stderr);
    const bearer = keyOut.stdout.trim();

    // a tender the cell should take, minted by W
    const mint = async (label: string, p: { skill: string; packageHash: string; input: unknown; answer: string; rewardWei: bigint }) => {
      const t0 = await k.blockTimestamp();
      const answerHash = hashlock.answerHash(p.answer);
      const task = { schema: "foga.task/1", skill: p.skill, packageHash: p.packageHash, input: p.input, acceptance: { mode: "verifier", profile: "x-hashlock-v1", verifier: k.tenders.hashlockAddress, answerHash }, deliverable: `case ${label}` };
      const terms = nativeTerms(p.rewardWei, { submitBy: BigInt(t0 + 86400), settleBy: BigInt(t0 + 7 * 86400) });
      const m = await k.call(`mint.${label}`, "W", k.tenders.address, k.tenders.contract().interface, "mintTask", [W.address, W.address, k.tenders.hashlockAddress, keccakJcs({ td: "foga.task/1", skill: p.skill }), sha256Hex(JSON.stringify(task)), dataUri(task), terms]);
      const tokenId = k.tenders.tokenIdFromReceipt(m.receipt);
      await k.call(`fund.${label}`, "W", k.tenders.address, k.tenders.contract().interface, "fundTask", [tokenId, p.rewardWei], p.rewardWei);
      await k.call(`commit.${label}`, "W", k.tenders.hashlockAddress, k.tenders.hashlockVerifier().interface, "commitAnswer", [k.tenders.address, tokenId, answerHash]);
      return tokenId.toString();
    };
    const inputA: ProbeInput = { subject: D, block: await k.blockNumber(), lookback: 9000, kya: { schemeId: cell.schemeId, issuers: [W.address] } };
    const a = await mint("a", { skill: "foga-probe", packageHash: cell.skills["foga-probe"].packageHash, input: inputA, answer: (await runProbe(k.world, inputA)).answer, rewardWei: parseEther("0.001") });
    const c = await mint("c", { skill: "foga-oracle", packageHash: "0x" + "ab".repeat(32), input: {}, answer: "x", rewardWei: parseEther("0.001") });

    node = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    const catalog = defaultCatalog();
    running = await createHttpServer({ node, catalog, version, log: () => {} }).listen("127.0.0.1:0");
    const url = running.url;
    await buildDocuments(node, { version });

    // --- the card at the well-known path names the JSON-RPC interface and the offered skills
    const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as { supportedInterfaces: unknown[]; skills: { id: string }[]; capabilities: { streaming: boolean } };
    assert.deepEqual(card.supportedInterfaces, [], "no public URL yet: no interface declared (the node is reached by the URL the caller knows)");
    assert.equal(card.skills.length, 2);

    let n = 0;
    const rpc = async (method: string, params: unknown, o: { auth?: string; version?: string | null } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (o.version !== null) headers["a2a-version"] = o.version ?? "1.0";
      if (o.auth) headers.authorization = o.auth;
      const r = await fetch(`${url}/a2a`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }) });
      return { status: r.status, body: (await r.json()) as { id: number; result?: any; error?: { code: number; message: string; data?: any[] } } };
    };
    const msg = (parts: unknown[], extra: Record<string, unknown> = {}) => ({ message: { messageId: `m-${++n}-${Date.now()}`, role: "ROLE_USER", parts, ...extra } });

    // --- the binding's edges
    assert.equal((await fetch(`${url}/a2a`)).status, 405, "GET is not the JSON-RPC binding");
    const noVersion = await rpc("SendMessage", msg([{ text: "hello" }]), { version: null });
    assert.equal(noVersion.body.error?.code, A2A_ERRORS.VersionNotSupportedError, "an empty version is 0.3, which this agent does not speak");
    assert.equal((await rpc("SendMessage", msg([{ text: "hello" }]), { version: "0.3" })).body.error?.code, A2A_ERRORS.VersionNotSupportedError);
    assert.equal((await rpc("NoSuchMethod", {})).body.error?.code, A2A_ERRORS.MethodNotFoundError);
    assert.equal((await rpc("SendStreamingMessage", msg([{ text: "x" }]))).body.error?.code, A2A_ERRORS.UnsupportedOperationError);
    assert.equal((await rpc("GetExtendedAgentCard", {})).body.error?.code, A2A_ERRORS.UnsupportedOperationError);
    assert.equal((await rpc("CreateTaskPushNotificationConfig", {})).body.error?.code, A2A_ERRORS.PushNotificationNotSupportedError);
    assert.equal((await rpc("SendMessage", { message: { messageId: "x", role: "ROLE_USER", parts: [] } })).body.error?.code, A2A_ERRORS.InvalidParamsError);
    assert.equal((await rpc("SendMessage", msg([{ url: "https://example.org/file" }]))).body.error?.code, A2A_ERRORS.ContentTypeNotSupportedError);
    assert.equal((await rpc("GetTask", { id: "nope" })).body.error?.code, A2A_ERRORS.TaskNotFoundError);
    const badJson = await fetch(`${url}/a2a`, { method: "POST", headers: { "content-type": "application/json", "a2a-version": "1.0" }, body: "{not json" });
    assert.equal(((await badJson.json()) as { error: { code: number } }).error.code, A2A_ERRORS.JSONParseError);

    // --- a quote in words, for anyone: COMPLETED with the quote artifact; a quote for a skill the cell lacks: REJECTED
    const words = await rpc("SendMessage", msg([{ text: "Can you probe my address against the stack?" }]));
    assert.equal(words.status, 200, JSON.stringify(words.body));
    const q = words.body.result.task;
    assert.equal(q.status.state, "TASK_STATE_COMPLETED");
    assert.equal(q.artifacts.length, 1);
    const quote = q.artifacts[0].parts[0].data.foga.quote;
    assert.deepEqual(quote.skills.map((s: { name: string }) => s.name).sort(), ["finch-extract-verify", "foga-probe"]);
    assert.equal(quote.terms.acceptance, "hashlock");
    assert.equal(quote.terms.verifier, k.tenders.hashlockAddress);
    assert.equal(quote.terms.minRewardWei, cfg.policy.tenders.minRewardWei);
    assert.equal(q.history.length, 2, "the user's message and the agent's answer");
    const missing = await rpc("SendMessage", msg([{ data: { foga: { mode: "quote", skill: "foga-oracle" } }, mediaType: "application/json" }]));
    assert.equal(missing.body.result.task.status.state, "TASK_STATE_REJECTED");
    assert.deepEqual(missing.body.result.task.status.message.parts[1].data.foga.quote.available.sort(), ["finch-extract-verify", "foga-probe"]);

    // --- the tender road: closed to the public, open to the key holder; INPUT_REQUIRED without a tokenId, then the follow-up
    const pub = await rpc("SendMessage", msg([{ data: { foga: { mode: "tender", tokenId: a } } }]));
    assert.equal(pub.body.result.task.status.state, "TASK_STATE_REJECTED");
    assert.equal(pub.body.result.task.status.message.parts[1].data.foga.gate, "permission");
    const ask = await rpc("SendMessage", msg([{ data: { foga: { mode: "tender" } } }]), { auth: `Bearer ${bearer}` });
    const asked = ask.body.result.task;
    assert.equal(asked.status.state, "TASK_STATE_INPUT_REQUIRED");
    assert.deepEqual(asked.status.message.parts[1].data.foga.need, ["tokenId"]);
    const followUp = await rpc("SendMessage", msg([{ data: { foga: { mode: "tender", tokenId: a } } }], { taskId: asked.id, contextId: asked.contextId }), { auth: `Bearer ${bearer}` });
    const working = followUp.body.result.task;
    assert.equal(working.id, asked.id, "the follow-up continues the task");
    assert.equal(working.status.state, "TASK_STATE_WORKING");
    let done = working;
    for (let i = 0; i < 60 && done.status.state === "TASK_STATE_WORKING"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      done = (await rpc("GetTask", { id: asked.id }, { auth: `Bearer ${bearer}` })).body.result;
    }
    assert.equal(done.status.state, "TASK_STATE_COMPLETED", JSON.stringify(done.status));
    const submission = done.artifacts[0].parts[0].data.foga;
    assert.equal(submission.tokenId, a);
    assert.match(submission.txHash, /^0x[0-9a-f]{64}$/);
    assert.equal(typeof submission.decisionId, "number");
    assert.ok(node.store.decisions({ limit: 100 }).some((d) => d.caller === "integration" && d.capability === "tender_submit" && d.verdict === "allowed"), "the catalog decided as the A2A caller");
    // the watchers settle what the task submitted: the reward reaches the account
    const watchers = new Watchers(node, catalog);
    await k.world.provider.getBlockNumber(); // this kernel's reads are pinned to the last block it saw: move the pin
    const before = await k.balance(D);
    let settled = false;
    for (let i = 0; i < 10 && !settled; i++) {
      const r = await watchers.tick();
      settled = r.settled.some((s) => s.tokenId === a && s.outcome === "settled");
      if (!settled) await new Promise((r2) => setTimeout(r2, 300));
    }
    assert.ok(settled, "settled by the watchers, not by the A2A caller");
    await k.world.provider.getBlockNumber();
    assert.ok((await k.balance(D)) > before, "the reward arrived");

    // --- a message to a finished task is refused; the same messageId again is the same task; a tender the cell must refuse is REJECTED with the gate
    const after = await rpc("SendMessage", msg([{ text: "again?" }], { taskId: asked.id }), { auth: `Bearer ${bearer}` });
    assert.equal(after.body.error?.code, A2A_ERRORS.UnsupportedOperationError);
    const dupParams = msg([{ text: "quote please" }]);
    const first = await rpc("SendMessage", dupParams);
    const second = await rpc("SendMessage", dupParams);
    assert.equal(second.body.result.task.id, first.body.result.task.id, "the same messageId from the same caller is the same task");
    const refused = await rpc("SendMessage", msg([{ data: { foga: { mode: "tender", tokenId: c } } }]), { auth: `Bearer ${bearer}` });
    let rt = refused.body.result.task;
    for (let i = 0; i < 40 && rt.status.state === "TASK_STATE_WORKING"; i++) {
      await new Promise((r) => setTimeout(r, 250));
      rt = (await rpc("GetTask", { id: rt.id }, { auth: `Bearer ${bearer}` })).body.result;
    }
    assert.equal(rt.status.state, "TASK_STATE_REJECTED");
    assert.equal(rt.status.message.parts[1].data.foga.gate, "skill");
    assert.equal(typeof rt.status.message.parts[1].data.foga.decisionId, "number");

    // --- ListTasks: one's own; the operator's view sees all; CancelTask: a finished one is not cancelable
    const mine = (await rpc("ListTasks", { pageSize: 10 }, { auth: `Bearer ${bearer}` })).body.result;
    assert.ok(mine.tasks.every((x: { metadata: { caller: string } }) => x.metadata.caller === "integration"));
    assert.equal(mine.totalSize, 2, "the asked task and the refused one; nothing of the public's");
    const theirs = (await rpc("ListTasks", {})).body.result;
    assert.ok(theirs.tasks.every((x: { metadata: { caller: string } }) => x.metadata.caller === "anonymous"));
    assert.equal((await rpc("GetTask", { id: asked.id })).body.error?.code, A2A_ERRORS.TaskNotFoundError, "the public cannot see the key holder's task");
    const notCancelable = await rpc("CancelTask", { id: asked.id }, { auth: `Bearer ${bearer}` });
    assert.equal(notCancelable.body.error?.code, A2A_ERRORS.TaskNotCancelableError);
    const open = (await rpc("SendMessage", msg([{ data: { foga: { mode: "tender" } } }]), { auth: `Bearer ${bearer}` })).body.result.task;
    const cancelled = (await rpc("CancelTask", { id: open.id }, { auth: `Bearer ${bearer}` })).body.result;
    assert.equal(cancelled.status.state, "TASK_STATE_CANCELED");
    const byState = (await rpc("ListTasks", { status: "TASK_STATE_CANCELED" }, { auth: `Bearer ${bearer}` })).body.result;
    assert.equal(byState.totalSize, 1);
    const paged = (await rpc("ListTasks", { pageSize: 1 }, { auth: `Bearer ${bearer}` })).body.result;
    assert.equal(paged.tasks.length, 1);
    assert.equal(paged.nextPageToken, "1");
  } finally {
    if (running) await running.close();
    node?.close();
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

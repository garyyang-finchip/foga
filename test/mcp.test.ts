import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEther } from "ethers";
import { dataUri, keccakJcs, sha256Hex } from "../src/core/canonical.js";
import { hashlock, nativeTerms } from "../src/core/tenders.js";
import { runProbe, type ProbeInput } from "../src/genesis/probe.js";
import { createHttpServer, type RunningHttpServer } from "../src/http/server.js";
import { Node } from "../src/node/node.js";
import { defaultCatalog } from "../src/tools/index.js";
import { version } from "../src/util/version.js";
import { ROOT, anvilPath, bornCell, cleanEnv, foga, startAnvil } from "./helpers/anvil-cell.js";

/**
 * The MCP and HTTP entrances on anvil (design memo, Phase 3, the 3b gate), with the reference client: a cell D is
 * born through the CLI (test/helpers/anvil-cell.ts), a demander mints a tender the cell should take (a) and one it
 * must refuse (c); then the node serves them. Over Streamable HTTP a client pinned to the 2026-07-28 revision lists
 * the public's tools, pre-checks as the public (eligible: false is an ordinary result) and finds no act to call; the
 * holder of an API key made by `foga node key new` walks case a through the tools (precheck, skill_run, submit,
 * settle), sees the same job twice answered once, and reads its own job, operation and decisions; a legacy
 * (2025-era) client lists the same tools. Over stdio `foga node mcp` serves a keyless local client at build level and
 * the operator with the key. The HTTP API itself answers 401, 403, 413, 415, 429 and the Origin and Host refusals at
 * the edge. Skipped when anvil is not installed.
 */
const PORT = 8563;
const RPC = `http://127.0.0.1:${PORT}`;

type ToolCall = { isError?: boolean; structuredContent?: Record<string, any>; content?: Array<{ type: string; text?: string }> };

function pinned(): Client {
  return new Client({ name: "foga-test", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
}

function names(tools: { tools: Array<{ name: string }> }): string[] {
  return tools.tools.map((t) => t.name).sort();
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolCall> {
  return (await client.callTool({ name, arguments: args })) as ToolCall;
}

function rawGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({ host: u.hostname, port: u.port, path: u.pathname + u.search, method: "GET", headers, setHost: false }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function api(url: string, path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const r = await fetch(url + path, init);
  const text = await r.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: r.status, json };
}

const post = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

test("MCP over Streamable HTTP and stdio, and the HTTP API, on a born cell", { timeout: 900_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-mcp-"));
  let node: Node | null = null;
  let limited: Node | null = null;
  let running: RunningHttpServer | null = null;
  let runningLimited: RunningHttpServer | null = null;
  const clients: Client[] = [];
  try {
    const cell = await bornCell(RPC, dir);
    const k = cell.kernel;
    const W = cell.keys.W;
    const D = cell.account;

    // --- the demander (W) mints two tenders: a, which the cell should take; c, for a skill it lacks
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
    const probeHash = cell.skills["foga-probe"].packageHash;
    const inputA: ProbeInput = { subject: D, block: await k.blockNumber(), lookback: 9000, kya: { schemeId: cell.schemeId, issuers: [W.address] } };
    const answerA = (await runProbe(k.world, inputA)).answer;
    const a = await mint("a", { skill: "foga-probe", packageHash: probeHash, input: inputA, answer: answerA, rewardWei: parseEther("0.001") });
    const c = await mint("c", { skill: "foga-oracle", packageHash: "0x" + "ab".repeat(32), input: {}, answer: "x", rewardWei: parseEther("0.001") });

    // --- an API key for a partner: printed once, kept as its hash
    const minted = foga(RPC, ["node", "key", "new", "--config", cell.configPath, "--id", "partner", "--level", "act", "--visibility", "caller", "--note", "the test's partner"]);
    assert.equal(minted.code, 0, minted.stderr);
    const apiKey = minted.stdout.trim();
    assert.match(apiKey, /^foga\.partner\.[A-Za-z0-9_-]{32}$/, "the key alone on stdout");
    assert.match(minted.stderr, /recorded .* as its hash/);
    const withKey = JSON.parse(readFileSync(cell.configPath, "utf8"));
    assert.equal(withKey.access.keys.length, 1);
    assert.deepEqual({ ...withKey.access.keys[0] }, { id: "partner", sha256: "0x" + createHash("sha256").update(apiKey).digest("hex"), level: "act", visibility: "caller", note: "the test's partner" });
    assert.ok(!readFileSync(cell.configPath, "utf8").includes(apiKey.split(".")[2]), "the key's secret is not in the config");
    const twice = foga(RPC, ["node", "key", "new", "--config", cell.configPath, "--id", "partner"]);
    assert.notEqual(twice.code, 0);
    assert.match(twice.stderr, /a key with id partner exists/);
    // the test makes far more than sixty requests a minute from one address; the limiter itself is tested on a second server below
    withKey.runtime.http.rateLimitPerMinute = 100_000;
    writeFileSync(cell.configPath, JSON.stringify(withKey, null, 2));

    // --- a node in a mixed environment is refused before anything is read; `foga node mcp` is a node
    const mixed = foga(RPC, ["node", "mcp", "--config", cell.configPath], { FOGA_OPERATOR_KEY: cell.keys.operator.privateKey, FOGA_OWNER_KEY: cell.keys.owner.privateKey });
    assert.notEqual(mixed.code, 0);
    assert.match(mixed.stderr, /environment holds FOGA_OWNER_KEY/);

    // --- the HTTP server, in process, holding the operator key
    node = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    const catalog = defaultCatalog();
    running = await createHttpServer({ node, catalog, version, log: () => {} }).listen("127.0.0.1:0");
    const url = running.url;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const mcpUrl = new URL(`${url}/mcp`);

    // --- health and the front page
    const health = await api(url, "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.cell, "D");
    assert.equal(health.json.account, D);
    assert.equal(health.json.version, version);
    assert.equal(typeof health.json.block, "number");
    const front = await api(url, "/");
    assert.equal(front.status, 200);
    assert.equal(front.json.status.name, "D");
    assert.equal(front.json.status.budget, null, "the public sees no budget");
    assert.deepEqual(front.json.endpoints, { mcp: "/mcp", api: "/api/<capability>", health: "/healthz" });

    // --- the edge: credentials, Origin, Host, body size, content type, unknown paths
    assert.equal((await api(url, "/api/capabilities", { headers: { authorization: "Bearer foga.partner.not-the-key" } })).status, 401);
    assert.equal((await api(url, "/api/capabilities", { headers: { authorization: "Bearer nonsense" } })).status, 401);
    assert.equal((await api(url, "/api/capabilities", { headers: { authorization: `Bearer foga.nobody.${apiKey.split(".")[2]}` } })).status, 401, "a known secret under another id is nobody");
    assert.equal((await api(url, "/api/capabilities", { headers: { authorization: "Basic abc" } })).status, 401);
    const origin = await api(url, "/api/capabilities", { headers: { origin: "https://evil.example" } });
    assert.equal(origin.status, 403);
    assert.equal(origin.json.gate, "origin");
    assert.equal((await api(url, "/api/capabilities", { headers: { origin: "http://localhost:5173" } })).status, 200, "a local page may call a loopback server");
    const host = await rawGet(`${url}/healthz`, { host: "foga.example.com" });
    assert.equal(host.status, 403);
    assert.equal(JSON.parse(host.body).gate, "host");
    const big = await api(url, "/api/tender_precheck?mode=simulate", post({ tokenId: a, padding: "x".repeat(300_000) }));
    assert.equal(big.status, 413);
    assert.equal((await api(url, "/api/tender_precheck?mode=simulate", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await api(url, "/api/tender_precheck?mode=simulate", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })).status, 400);
    assert.equal((await api(url, "/api/tender_precheck?mode=dance", post({ tokenId: a }))).status, 400);
    assert.equal((await api(url, "/api/no_such_capability", post({}))).status, 404);
    assert.equal((await api(url, "/api/tender_precheck")).status, 405, "an act is not a GET");
    assert.equal((await api(url, "/.well-known/agent-card.json")).json.reason, "not published yet");
    assert.equal((await api(url, "/nothing")).status, 404);

    // --- the JSON API as the public: reads and dry runs, no acts
    const pubCaps = await api(url, "/api/capabilities");
    assert.equal(pubCaps.status, 200);
    assert.deepEqual(pubCaps.json.caller, { id: "anonymous", level: "build", visibility: "public" });
    const pubNames = pubCaps.json.capabilities.map((x: any) => x.name);
    assert.ok(pubNames.includes("tender_precheck") && pubNames.includes("cell_status") && pubNames.includes("spec_read"));
    assert.ok(!pubNames.includes("tender_submit") && !pubNames.includes("evidence_export") && !pubNames.includes("operator_rotate"));
    const inspectA = await api(url, `/api/tender_inspect?tokenId=${a}`);
    assert.equal(inspectA.status, 200);
    assert.equal(inspectA.json.output.task.skill, "foga-probe");
    const pubAct = await api(url, "/api/tender_precheck", post({ tokenId: a }));
    assert.equal(pubAct.status, 403, "an act needs a key");
    assert.equal(pubAct.json.gate, "permission");
    const pubSubmit = await api(url, "/api/tender_submit?mode=simulate", post({ tokenId: a, resultHash: "0x" + "aa".repeat(32) }));
    assert.equal(pubSubmit.status, 403, "a caller-visible capability is refused to the public");
    const pubPre = await api(url, "/api/tender_precheck?mode=simulate", post({ tokenId: c }));
    assert.equal(pubPre.status, 200, "a business refusal is an ordinary answer");
    assert.equal(pubPre.json.ok, false);
    assert.equal(pubPre.json.gate, "skill");
    assert.equal(typeof pubPre.json.decisionId, "number");
    const badInput = await api(url, "/api/tender_precheck?mode=simulate", post({ tokenId: "x" }));
    assert.equal(badInput.status, 400);
    assert.equal(badInput.json.gate, "input");

    // --- MCP as the public, pinned to 2026-07-28
    const pub = pinned();
    clients.push(pub);
    await pub.connect(new StreamableHTTPClientTransport(mcpUrl));
    assert.equal(pub.getProtocolEra(), "modern");
    assert.equal(pub.getNegotiatedProtocolVersion(), "2026-07-28");
    const pubTools = await pub.listTools();
    const pubToolNames = names(pubTools);
    assert.deepEqual(pubToolNames, ["cell_status", "identity_resolve", "kya_check", "safety_status", "skill_inspect", "skill_list", "spec_read", "tender_inspect", "tender_list", "tender_precheck_simulate", "world_describe"], "the public's tools: the public reads and the dry run of a pre-check");
    const statusTool = pubTools.tools.find((x) => x.name === "cell_status")!;
    assert.equal(statusTool.annotations?.readOnlyHint, true);
    assert.equal((statusTool.outputSchema as { type?: string })?.type, "object");
    const preTool = pubTools.tools.find((x) => x.name === "tender_precheck_simulate")!;
    assert.equal(preTool.annotations?.readOnlyHint, false);
    assert.equal(preTool.annotations?.destructiveHint, false);
    assert.match(preTool.description ?? "", /Dry run/);
    const status = await call(pub, "cell_status");
    assert.ok(!status.isError);
    assert.equal(status.structuredContent?.name, "D");
    assert.equal(status.structuredContent?.account, D);
    assert.equal(status.structuredContent?.budget, null);
    const ineligible = await call(pub, "tender_precheck_simulate", { tokenId: c });
    assert.ok(!ineligible.isError, "an ineligible tender is an ordinary result");
    assert.equal(ineligible.structuredContent?.eligible, false);
    assert.equal(ineligible.structuredContent?.gate, "skill");
    assert.equal(typeof ineligible.structuredContent?.decisionId, "number");
    const eligible = await call(pub, "tender_precheck_simulate", { tokenId: a });
    assert.equal(eligible.structuredContent?.eligible, true);
    assert.ok(eligible.structuredContent?.result.gates.every((g: any) => g.ok));
    await assert.rejects(call(pub, "tender_submit", { tokenId: a, resultHash: "0x" + "aa".repeat(32) }), /tender_submit/, "no act is offered to the public");
    await assert.rejects(call(pub, "tender_precheck", { tokenId: a }), /tender_precheck/);
    const badArgs = await call(pub, "tender_inspect", { tokenId: "x" });
    assert.ok(badArgs.isError, "bad input is a tool error");
    const resources = await pub.listResources();
    assert.deepEqual(resources.resources.map((r) => r.uri).sort(), ["foga://cell/status", "foga://docs/compatibility-matrix", "foga://policy", "foga://spec/foga-cell-v1", "foga://world"]);
    const policy = await pub.readResource({ uri: "foga://policy" });
    const policyText = (policy.contents[0] as { text: string }).text;
    assert.equal(JSON.parse(policyText).budget.dailyValueWei, parseEther("0.002").toString());
    const spec = await pub.readResource({ uri: "foga://spec/foga-cell-v1" });
    assert.equal(JSON.parse((spec.contents[0] as { text: string }).text).kind, "safety-specification");
    const prompts = await pub.listPrompts();
    assert.deepEqual(prompts.prompts.map((p) => p.name), ["take-tender"]);
    const prompt = await pub.getPrompt({ name: "take-tender", arguments: { tokenId: a } });
    assert.match((prompt.messages[0].content as { text: string }).text, new RegExp(`tender_precheck \\{"tokenId":"${a}"\\}`));

    // --- MCP as the key holder: the act path of case a
    const partner = pinned();
    clients.push(partner);
    await partner.connect(new StreamableHTTPClientTransport(mcpUrl, { requestInit: { headers: { authorization: `Bearer ${apiKey}` } } }));
    const partnerTools = names(await partner.listTools());
    for (const n of ["tender_precheck", "tender_precheck_simulate", "skill_run", "skill_run_simulate", "tender_submit", "tender_submit_simulate", "tender_submit_build", "tender_settle", "credit_withdraw", "tender_mint", "tender_mint_build", "tender_fund", "aid_heartbeat", "job_status", "operation_status", "operation_list", "decision_list"]) assert.ok(partnerTools.includes(n), `${n} is offered to the key holder`);
    for (const n of ["skill_mint", "skill_mint_simulate", "evidence_export", "operator_rotate", "guardian_suspend", "tender_precheck_build", "skill_run_build"]) assert.ok(!partnerTools.includes(n), `${n} is not offered to the key holder`);
    const submitTool = (await partner.listTools()).tools.find((x) => x.name === "tender_submit")!;
    assert.equal(submitTool.annotations?.destructiveHint, true);
    const pre = await call(partner, "tender_precheck", { tokenId: a });
    assert.equal(pre.structuredContent?.eligible, true);
    const run = await call(partner, "skill_run", { skill: "foga-probe", input: inputA, tokenId: a });
    assert.ok(!run.isError, JSON.stringify(run.structuredContent));
    assert.equal(run.structuredContent?.ok, true);
    const runOut = run.structuredContent?.output;
    assert.equal(runOut.answerHash, hashlock.answerHash(answerA), "the cell reproduces the demander's answer");
    assert.equal(runOut.resultHash, hashlock.resultHash(answerA, D));
    const submit = await call(partner, "tender_submit", { tokenId: a, resultHash: runOut.resultHash, runReceipt: runOut.runReceipt });
    assert.ok(!submit.isError, JSON.stringify(submit.structuredContent));
    assert.equal(submit.structuredContent?.ok, true);
    assert.deepEqual(submit.structuredContent?.operations, [`job:${submit.structuredContent?.jobId}:submit`]);
    const submission = submit.structuredContent?.output;
    assert.match(submission.submissionId, /^\d+$/);
    const again = await call(partner, "tender_submit", { tokenId: a, resultHash: runOut.resultHash, runReceipt: runOut.runReceipt });
    assert.equal(again.structuredContent?.output.txHash, submission.txHash, "the same job is answered once");
    const conflict = await call(partner, "tender_submit", { tokenId: a, resultHash: "0x" + "cd".repeat(32), jobId: submit.structuredContent?.jobId });
    assert.equal(conflict.isError, true);
    assert.equal(conflict.structuredContent?.gate, "conflict");
    assert.match(conflict.content?.[0].text ?? "", /^refused at conflict: /);
    await k.world.provider.getBlockNumber();
    const before = await k.balance(D);
    const settle = await call(partner, "tender_settle", { tokenId: a, submissionId: submission.submissionId, answer: answerA });
    assert.ok(!settle.isError, JSON.stringify(settle.structuredContent));
    assert.equal(settle.structuredContent?.output.status, 1, "accepted");
    await k.world.provider.getBlockNumber();
    const paid = (await k.balance(D)) - before + BigInt(settle.structuredContent?.output.creditWei);
    assert.equal(paid, parseEther("0.001"), "the reward reached the cell");
    if (BigInt(settle.structuredContent?.output.creditWei) > 0n) assert.equal((await call(partner, "credit_withdraw", { tokenId: a })).structuredContent?.ok, true);
    // what the partner may read of its own work
    // (a nullable output rides under `result`, since structuredContent must be an object)
    const job = await call(partner, "job_status", { jobId: submit.structuredContent?.jobId });
    assert.equal(job.structuredContent?.result.status, "done");
    assert.equal(job.structuredContent?.result.caller, "partner");
    const op = await call(partner, "operation_status", { operationId: `job:${submit.structuredContent?.jobId}:submit` });
    assert.equal(op.structuredContent?.result.status, "confirmed");
    assert.equal(op.structuredContent?.result.txHash, submission.txHash);
    await assert.rejects(call(pub, "job_status", { jobId: submit.structuredContent?.jobId }), /job_status/, "a caller-visible read is not a tool of the public");
    const decisions = await call(partner, "decision_list");
    const own = decisions.structuredContent?.decisions as any[];
    assert.ok(own.length >= 6, `the partner's records (${own.length})`);
    assert.ok(own.every((d) => d.caller === "partner" && d.entrance === "http"), "a caller sees its own records only");
    assert.ok(own.some((d) => d.gate === "idempotent"));
    assert.ok(own.some((d) => d.gate === "conflict" && d.verdict === "refused"));
    // the public's records are the public's: the operator sees them all, the partner none of them
    assert.equal(node.store.decisions({ caller: "anonymous" }).length >= 3, true);
    // a build for a third party's account
    const built = await call(partner, "tender_mint_build", { as: W.address, skill: "foga-probe", packageHash: probeHash, input: inputA, answerHash: hashlock.answerHash(answerA), rewardWei: parseEther("0.0006").toString(), submitIn: 86400, settleIn: 7 * 86400 });
    assert.ok(!built.isError, JSON.stringify(built.structuredContent));
    assert.equal(built.structuredContent?.as, W.address);
    assert.ok((built.structuredContent?.calls as any[]).length >= 1);
    assert.match(built.structuredContent?.calls[0].data, /^0x[0-9a-f]+$/);
    // the JSON API, same caller, same answers
    const apiJob = await api(url, `/api/jobs/${encodeURIComponent(submit.structuredContent?.jobId)}`, { headers: { authorization: `Bearer ${apiKey}` } });
    assert.equal(apiJob.status, 200);
    assert.equal(apiJob.json.output.status, "done");
    const apiCaps = await api(url, "/api/capabilities", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.deepEqual(apiCaps.json.caller, { id: "partner", level: "act", visibility: "caller" });
    assert.ok(apiCaps.json.capabilities.some((x: any) => x.name === "tender_submit" && x.modes.includes("act")));
    // the settled tender's next completion would be another job; the first job, named, is answered from the store
    const apiAgain = await api(url, "/api/tender_submit", post({ tokenId: a, resultHash: runOut.resultHash, runReceipt: runOut.runReceipt, jobId: submit.structuredContent?.jobId }, { authorization: `Bearer ${apiKey}` }));
    assert.equal(apiAgain.status, 200);
    assert.equal(apiAgain.json.ok, true, JSON.stringify(apiAgain.json));
    assert.equal(apiAgain.json.output.txHash, submission.txHash);
    const apiDecisions = await api(url, "/api/decisions?verdict=refused", { headers: { authorization: `Bearer ${apiKey}` } });
    assert.ok(apiDecisions.json.output.decisions.every((d: any) => d.verdict === "refused" && d.caller === "partner"));

    // --- a legacy (2025-era) client and an auto-negotiating one see the same server
    const legacy = new Client({ name: "foga-test-legacy", version: "0" }, { versionNegotiation: { mode: "legacy" } });
    clients.push(legacy);
    await legacy.connect(new StreamableHTTPClientTransport(mcpUrl));
    assert.equal(legacy.getProtocolEra(), "legacy");
    assert.match(legacy.getNegotiatedProtocolVersion() ?? "", /^2025-/);
    assert.equal(legacy.getServerVersion()?.name, "foga");
    assert.equal(legacy.getServerVersion()?.version, version);
    assert.match(legacy.getInstructions() ?? "", /Finch OG Agent node of cell D/);
    assert.deepEqual(names(await legacy.listTools()), pubToolNames);
    assert.equal((await call(legacy, "cell_status")).structuredContent?.name, "D");
    const auto = new Client({ name: "foga-test-auto", version: "0" }, { versionNegotiation: { mode: "auto" } });
    clients.push(auto);
    await auto.connect(new StreamableHTTPClientTransport(mcpUrl));
    assert.equal(auto.getProtocolEra(), "modern");
    assert.deepEqual(names(await auto.listTools()), pubToolNames);

    // --- the rate limiter, on a second server with a budget of three requests a minute
    const limitedPath = join(dir, "D.limited.json");
    const limitedCfg = JSON.parse(readFileSync(cell.configPath, "utf8"));
    limitedCfg.runtime.http.rateLimitPerMinute = 3;
    limitedCfg.store = "D.limited.sqlite";
    writeFileSync(limitedPath, JSON.stringify(limitedCfg, null, 2));
    limited = await Node.open({ configPath: limitedPath, rpc: RPC, keys: {}, log: () => {} });
    runningLimited = await createHttpServer({ node: limited, catalog, version, log: () => {} }).listen("127.0.0.1:0");
    const limitedUrl = runningLimited.url;
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api(limitedUrl, "/healthz")).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);

    // --- stdio: `foga node mcp` without a key is the machine's user at build level with the operator's view
    const stdioArgs = ["--import", "tsx", "src/cli.ts", "node", "mcp", "--config", cell.configPath, "--rpc", RPC];
    const local = pinned();
    clients.push(local);
    await local.connect(new StdioClientTransport({ command: process.execPath, args: stdioArgs, env: cleanEnv(RPC), cwd: ROOT, stderr: "pipe" }));
    assert.equal(local.getProtocolEra(), "modern");
    const localTools = names(await local.listTools());
    for (const n of ["evidence_export", "decision_list", "tender_submit_simulate", "tender_submit_build", "skill_mint_simulate", "tender_precheck_simulate"]) assert.ok(localTools.includes(n), `${n} is offered to the local user`);
    for (const n of ["tender_submit", "tender_precheck", "skill_mint", "aid_heartbeat", "operator_rotate"]) assert.ok(!localTools.includes(n), `${n} is not offered without the operator key`);
    const evidence = await call(local, "evidence_export");
    assert.ok(!evidence.isError);
    assert.equal(evidence.structuredContent?.schema, "foga.node-evidence/1");
    assert.ok((evidence.structuredContent?.decisions as any[]).some((d) => d.caller === "partner"), "the operator's view holds every caller's records");
    await local.close();

    // --- stdio with the operator key: the operator, every level
    const operator = new Client({ name: "foga-test-operator", version: "0" }, { versionNegotiation: { mode: "legacy" } });
    clients.push(operator);
    await operator.connect(new StdioClientTransport({ command: process.execPath, args: stdioArgs, env: cleanEnv(RPC, { FOGA_OPERATOR_KEY: cell.keys.operator.privateKey }), cwd: ROOT, stderr: "pipe" }));
    const operatorTools = names(await operator.listTools());
    for (const n of ["tender_submit", "tender_precheck", "skill_mint", "aid_heartbeat", "evidence_export"]) assert.ok(operatorTools.includes(n), `${n} is offered to the operator`);
    for (const n of ["operator_rotate", "guardian_suspend", "guardian_resume", "binding_present", "identity_transfer"]) assert.ok(!operatorTools.includes(n), `${n} is not offered over MCP`);
    const opPre = await call(operator, "tender_precheck", { tokenId: c });
    assert.equal(opPre.structuredContent?.eligible, false);
    assert.equal(opPre.structuredContent?.gate, "skill");
    await operator.close();
    const mcpRecords = node.store.decisions({ caller: "operator" }).filter((d) => d.entrance === "mcp");
    assert.ok(mcpRecords.some((d) => d.capability === "tender_precheck" && d.gate === "skill"), "the stdio act left its record in the cell's store");
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    if (running) await running.close();
    if (runningLimited) await runningLimited.close();
    node?.close();
    limited?.close();
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

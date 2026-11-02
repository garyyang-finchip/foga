import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Wallet, parseEther } from "ethers";
import { dataUri } from "../src/core/canonical.js";
import { createHttpServer, type RunningHttpServer } from "../src/http/server.js";
import { NonceCache, REQUEST_MAX_SECONDS, SESSION_MAX_SECONDS, bodyHashOf, signAuthorization, verifyAuthorization } from "../src/http/signed.js";
import { Node } from "../src/node/node.js";
import { defaultCatalog } from "../src/tools/index.js";
import { version } from "../src/util/version.js";
import { anvilKeys } from "../src/genesis/roles.js";
import { Kernel } from "../src/kernel/kernel.js";
import { anvilPath, bornCell, foga, fogaAsync, startAnvil } from "./helpers/anvil-cell.js";

/**
 * Signed calls (3d): a caller's credential is its wallet. Offline: the envelope verifies for the cell it was made
 * for, within its validity, once, bound to its request when it says so. On anvil: the HTTP entrance grants what the
 * configuration says — any signer builds, a named signer acts (with a request-bound envelope; a session envelope
 * reaches build), the cell's own operator acts with the operator's view, an ERC-8004 agent's wallet is granted as
 * that agent, a standing grants its level — and Bearer keys and anonymous reads are exactly as before.
 */
const PORT = 8569;
const RPC = `http://127.0.0.1:${PORT}`;
const CELL = "0x" + "ab".repeat(20);

test("signed envelopes: verify for their cell, within their validity, once; request-bound ones match the request", async () => {
  const w = Wallet.createRandom();
  const now = 1_800_000_000;
  const session = await signAuthorization(w, { chainId: 31337, cell: CELL, now });
  assert.match(session, /^FOGA-EIP712 [A-Za-z0-9_-]+$/);
  const nonces = new NonceCache();
  const v = verifyAuthorization(session, { chainId: 31337, cell: CELL, method: "GET", path: "/api/cell_status", now: now + 1, nonces });
  assert.ok(v.ok && !v.bound && v.envelope.signer === w.address && v.envelope.expiresAt - v.envelope.issuedAt === SESSION_MAX_SECONDS);
  const again = verifyAuthorization(session, { chainId: 31337, cell: CELL, method: "GET", path: "/x", now: now + 2, nonces });
  assert.ok(again.ok, "a session envelope is presented as often as the session lasts");
  assert.ok(!verifyAuthorization(session, { chainId: 31337, cell: "0x" + "cd".repeat(20), method: "GET", path: "/x", now: now + 1 }).ok, "another cell: the signature does not verify");
  assert.ok(!verifyAuthorization(session, { chainId: 1, cell: CELL, method: "GET", path: "/x", now: now + 1 }).ok, "another chain: the signature does not verify");
  const late = verifyAuthorization(session, { chainId: 31337, cell: CELL, method: "GET", path: "/x", now: now + SESSION_MAX_SECONDS + 1 });
  assert.ok(!late.ok && /expired/.test(late.reason));

  const body = JSON.stringify({ tokenId: "1" });
  const bound = await signAuthorization(w, { chainId: 31337, cell: CELL, now, request: { method: "post", path: "/api/tender_precheck", body }, ttlSeconds: 30 });
  const ok = verifyAuthorization(bound, { chainId: 31337, cell: CELL, method: "POST", path: "/api/tender_precheck", body: Buffer.from(body), now: now + 1 });
  assert.ok(ok.ok && ok.bound && ok.envelope.request?.bodyHash === bodyHashOf(body) && ok.envelope.expiresAt - ok.envelope.issuedAt === 30);
  const once = verifyAuthorization(bound, { chainId: 31337, cell: CELL, method: "POST", path: "/api/tender_precheck", body: Buffer.from(body), now: now + 1, nonces });
  assert.ok(once.ok);
  const twice = verifyAuthorization(bound, { chainId: 31337, cell: CELL, method: "POST", path: "/api/tender_precheck", body: Buffer.from(body), now: now + 2, nonces });
  assert.ok(!twice.ok && /nonce reused/.test(twice.reason), "a request-bound envelope is good once");
  const otherBody = verifyAuthorization(bound, { chainId: 31337, cell: CELL, method: "POST", path: "/api/tender_precheck", body: Buffer.from('{"tokenId":"2"}'), now: now + 1 });
  assert.ok(!otherBody.ok && /another body/.test(otherBody.reason));
  const otherPath = verifyAuthorization(bound, { chainId: 31337, cell: CELL, method: "POST", path: "/api/tender_submit", body: Buffer.from(body), now: now + 1 });
  assert.ok(!otherPath.ok && /bound to \/api\/tender_precheck/.test(otherPath.reason));
  const otherMethod = verifyAuthorization(bound, { chainId: 31337, cell: CELL, method: "GET", path: "/api/tender_precheck", body: null, now: now + 1 });
  assert.ok(!otherMethod.ok && /bound to POST/.test(otherMethod.reason));
  const tooLong = await signAuthorization(w, { chainId: 31337, cell: CELL, now, request: { method: "GET", path: "/" }, ttlSeconds: 10_000 });
  const tl = verifyAuthorization(tooLong, { chainId: 31337, cell: CELL, method: "GET", path: "/", now: now + 1 });
  assert.ok(tl.ok && tl.envelope.expiresAt - tl.envelope.issuedAt === REQUEST_MAX_SECONDS, "the validity is capped at signing");

  // a tampered envelope: the signer field changed
  const parts = session.split(" ");
  const env = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  env.signer = Wallet.createRandom().address;
  const forged = `FOGA-EIP712 ${Buffer.from(JSON.stringify(env)).toString("base64url")}`;
  const f = verifyAuthorization(forged, { chainId: 31337, cell: CELL, method: "GET", path: "/", now: now + 1 });
  assert.ok(!f.ok && /not made by the signer it names/.test(f.reason));
  assert.ok(!verifyAuthorization("Bearer foga.x.y", { chainId: 31337, cell: CELL, method: "GET", path: "/" }).ok);
  assert.ok(!verifyAuthorization("FOGA-EIP712 not-json", { chainId: 31337, cell: CELL, method: "GET", path: "/" }).ok);
});

test("the HTTP entrance grants a signer what the configuration says; keys and the public are untouched", { timeout: 600_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-signed-"));
  let node: Node | null = null;
  let running: RunningHttpServer | null = null;
  const clients: Client[] = [];
  try {
    const cell = await bornCell(RPC, dir);
    const k = cell.kernel;
    const D = cell.account;
    const chainId = cell.chainId;
    const partner = Wallet.createRandom();
    const stranger = Wallet.createRandom();
    const agentKey = new Wallet(anvilKeys().E); // a funded anvil account: registers an ERC-8004 agent of its own
    const ek = await Kernel.open({ worldPath: cell.worldPath, rpc: RPC, storePath: join(dir, "e.sqlite"), keys: { E: anvilKeys().E } });
    let agentId: string;
    try {
      const agentReg = await ek.call("agent.register", "E", k.identity.address, k.identity.contract().interface, "register(string)", [dataUri({ name: "an agent of its own" })]);
      agentId = k.identity.agentIdFromReceipt(agentReg.receipt).toString();
    } finally {
      ek.close();
      ek.world.provider.destroy();
    }
    const api = foga(RPC, ["node", "key", "new", "--config", cell.configPath, "--id", "partner-key", "--level", "act"]);
    assert.equal(api.code, 0, api.stderr);
    const bearer = api.stdout.trim();
    const cfg = JSON.parse(readFileSync(cell.configPath, "utf8"));
    cfg.runtime.http.rateLimitPerMinute = 100_000;
    cfg.access.signers = { default: "build", allow: [{ address: partner.address, level: "act", note: "the test's partner" }, { agentId, level: "act", visibility: "caller" }], actsNeedRequestBinding: true };
    writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));

    node = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    const catalog = defaultCatalog();
    running = await createHttpServer({ node, catalog, version, log: () => {} }).listen("127.0.0.1:0");
    const url = running.url;
    const get = async (path: string, auth?: string) => {
      const r = await fetch(`${url}${path}`, { headers: auth ? { authorization: auth } : {} });
      return { status: r.status, body: (await r.json()) as any };
    };
    const post = async (path: string, body: unknown, auth?: string) => {
      const text = JSON.stringify(body);
      const r = await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: text });
      return { status: r.status, body: (await r.json()) as any };
    };
    const sign = (w: Wallet, o: { method?: string; path?: string; body?: unknown; agentId?: string; ttl?: number } = {}) => signAuthorization(w, { chainId, cell: D, agentId: o.agentId, ttlSeconds: o.ttl, request: o.method ? { method: o.method, path: o.path!, body: o.body === undefined ? null : JSON.stringify(o.body) } : undefined });

    // the public and the key holder, as before
    const anon = await get("/api/capabilities");
    assert.equal(anon.body.caller.id, "anonymous");
    assert.equal(anon.body.caller.via, "anonymous");
    const keyed = await get("/api/capabilities", `Bearer ${bearer}`);
    assert.deepEqual([keyed.body.caller.id, keyed.body.caller.level, keyed.body.caller.via], ["partner-key", "act", "key"]);
    assert.equal((await get("/api/capabilities", "Digest abc")).status, 401, "an unknown scheme is refused as a credential");

    // any valid signer: build, as the public, but as itself (its address is its caller id)
    const strangerSession = await sign(stranger);
    const s1 = await get("/api/capabilities", strangerSession);
    assert.equal(s1.status, 200);
    assert.deepEqual([s1.body.caller.id, s1.body.caller.level, s1.body.caller.visibility, s1.body.caller.via], [stranger.address, "build", "caller", "signature"]);
    assert.equal((await get("/api/capabilities", strangerSession)).status, 200, "a session envelope serves the whole session");
    const strangerAct = await post("/api/tender_mint", { skill: "foga-probe", packageHash: cell.skills["foga-probe"].packageHash, input: {}, answerHash: "0x" + "11".repeat(32), rewardWei: "1000", submitIn: 86400, settleIn: 7 * 86400 }, await sign(stranger, { method: "POST", path: "/api/tender_mint", body: { skill: "foga-probe", packageHash: cell.skills["foga-probe"].packageHash, input: {}, answerHash: "0x" + "11".repeat(32), rewardWei: "1000", submitIn: 86400, settleIn: 7 * 86400 } }));
    assert.equal(strangerAct.status, 403, "build cannot act, signed or not");
    assert.equal(strangerAct.body.gate, "permission");

    // a named signer: act with a request-bound envelope; build with a session envelope; the operator's view stays the operator's
    const partnerSession = await sign(partner);
    const p1 = await get("/api/capabilities", partnerSession);
    assert.deepEqual([p1.body.caller.id, p1.body.caller.level], [partner.address, "build"], "a session envelope reaches build even for an act grant");
    const precheckBody = { tokenId: "1" };
    const boundHeader = await sign(partner, { method: "POST", path: "/api/tender_precheck", body: precheckBody });
    const boundOtherBody = await post("/api/tender_precheck", { tokenId: "2" }, boundHeader);
    assert.equal(boundOtherBody.status, 401, "the envelope is bound to its body");
    assert.match(boundOtherBody.body.reason, /another body/);
    // tender 1 does not exist on this fresh world: the act goes through permission and the catalog answers input — which is the act level at work
    const bound = await post("/api/tender_precheck", precheckBody, await sign(partner, { method: "POST", path: "/api/tender_precheck", body: precheckBody }));
    assert.equal(bound.status, 400, JSON.stringify(bound.body));
    assert.equal(bound.body.gate, "input", "permission passed: the catalog judged the input");
    const decisions = await get("/api/decisions", await sign(partner));
    assert.ok(decisions.body.output.decisions.some((d: any) => d.caller === partner.address && d.entrance === "http"), "the signer's decisions are recorded under its address");

    // the cell's operator, signing remotely: act, operator data
    const op = await get("/api/capabilities", await sign(cell.keys.operator));
    assert.deepEqual([op.body.caller.id, op.body.caller.level, op.body.caller.visibility], [cell.keys.operator.address, "build", "operator"], "a session envelope of the operator: build, with the operator's view");
    const opBound = await post("/api/tender_precheck", precheckBody, await sign(cell.keys.operator, { method: "POST", path: "/api/tender_precheck", body: precheckBody }));
    assert.equal(opBound.body.gate, "input", "the operator's request-bound envelope acts");

    // an ERC-8004 agent's wallet, claiming its agent id: granted as that agent; a stranger claiming it is not
    const asAgent = await get("/api/capabilities", await sign(agentKey, { agentId }));
    assert.deepEqual([asAgent.body.caller.id, asAgent.body.caller.level], [agentKey.address, "build"], "session: build");
    const agentBound = await post("/api/tender_precheck", precheckBody, await sign(agentKey, { method: "POST", path: "/api/tender_precheck", body: precheckBody, agentId }));
    assert.equal(agentBound.body.gate, "input", "the agent's wallet acts under the agent grant");
    const impostor = await post("/api/tender_precheck", precheckBody, await sign(stranger, { method: "POST", path: "/api/tender_precheck", body: precheckBody, agentId }));
    assert.equal(impostor.status, 403, "a stranger claiming the agent id is the default signer, which cannot act");

    // over MCP (Streamable HTTP) with a session envelope as the static header: the signer's own tool set (build: reads, _simulate and _build)
    const mcpClient = new Client({ name: "signed-test", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    clients.push(mcpClient);
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`), { requestInit: { headers: { authorization: await sign(partner) } } }));
    const tools = (await mcpClient.listTools()).tools.map((x) => x.name);
    assert.ok(tools.includes("tender_precheck_simulate") && tools.includes("cell_status") && !tools.includes("tender_submit"), `a session signer's tools over MCP: ${tools.length}`);
    const st = (await mcpClient.callTool({ name: "cell_status", arguments: {} })) as { structuredContent?: { account?: string } };
    assert.equal(st.structuredContent?.account, D);
    const first = await post("/api/tender_precheck", precheckBody, boundHeader);
    assert.equal(first.status, 400, "the envelope's first use with its own body reaches the catalog");
    const replay = await post("/api/tender_precheck", precheckBody, boundHeader);
    assert.equal(replay.status, 401, "a request-bound envelope presented again is refused (nonce)");
    assert.match(replay.body.reason, /nonce reused/);

    // signatures switched off: refused outright
    cfg.access.signers.default = "none";
    cfg.access.signers.allow = [];
    writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));
    const off = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: {}, log: () => {} });
    const offServer = await createHttpServer({ node: off, catalog, version, log: () => {} }).listen("127.0.0.1:0");
    try {
      const r = await fetch(`${offServer.url}/api/capabilities`, { headers: { authorization: await sign(stranger) } });
      assert.equal(r.status, 403);
      const r2 = await fetch(`${offServer.url}/api/capabilities`);
      assert.equal(r2.status, 200, "the public is untouched");
    } finally {
      await offServer.close();
      off.close();
    }

    // the CLI's own signer: foga wallet sign makes a header this node accepts
    const made = foga(RPC, ["wallet", "new", "--dir", join(dir, "w"), "--single"]);
    assert.equal(made.code, 0, made.stderr);
    const signed = foga(RPC, ["wallet", "sign", "--config", cell.configPath, "--dir", join(dir, "w")]);
    assert.equal(signed.code, 0, signed.stderr);
    const header = signed.stdout.trim();
    assert.match(header, /^FOGA-EIP712 /);
    const viaCli = await get("/api/capabilities", header);
    assert.equal(viaCli.status, 200);
    assert.equal(viaCli.body.caller.via, "signature");
    const boundCli = foga(RPC, ["wallet", "sign", "--config", cell.configPath, "--dir", join(dir, "w"), "--method", "GET", "--path", "/api/cell_status"]);
    const viaCliBound = await get("/api/cell_status", boundCli.stdout.trim());
    assert.equal(viaCliBound.status, 200);
    assert.equal(viaCliBound.body.output.account, D);
    // an agent that knows the cell by its URL alone: /healthz names the account and the chain
    const byUrl = await fogaAsync(RPC, ["wallet", "sign", "--url", url, "--dir", join(dir, "w")]);
    assert.equal(byUrl.code, 0, byUrl.stderr);
    assert.match(byUrl.stderr, new RegExp(`for cell .*\\(${D}, chain ${chainId}\\)`));
    const viaUrl = await get("/api/capabilities", byUrl.stdout.trim());
    assert.equal(viaUrl.status, 200);
    assert.equal(viaUrl.body.caller.via, "signature");
    const byHand = foga(RPC, ["wallet", "sign", "--cell", D, "--chain-id", String(chainId), "--dir", join(dir, "w")]);
    assert.equal(byHand.code, 0, byHand.stderr);
    assert.equal((await get("/api/capabilities", byHand.stdout.trim())).status, 200);
    const noCell = foga(RPC, ["wallet", "sign", "--dir", join(dir, "w")]);
    assert.notEqual(noCell.code, 0);
    assert.match(noCell.stderr, /--config .* --url .* --cell/);
  } finally {
    for (const c of clients) await c.close().catch(() => {});
    if (running) await running.close();
    node?.close();
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

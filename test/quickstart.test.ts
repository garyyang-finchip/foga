import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { clientConfigs, clientLauncher, MARKER, runQuickstart } from "../src/demo/quickstart.js";
import { anvilPath, portOpen } from "./helpers/anvil-cell.js";

/**
 * `foga quickstart` (3d): from nothing to a cell a client can connect to, in one call. The test runs it on its own
 * ports, reads the configurations it writes, connects to the HTTP entrance exactly as the printed http-mcp.json says
 * and works one of the two tenders the quickstart minted — list, inspect, pre-check, run, submit — then watches the
 * node's watchers settle it. Skipped when anvil is not installed; the offline parts run everywhere.
 */
const PORT = 8567;
const LISTEN = "127.0.0.1:8797";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("quickstart: the client configurations name this CLI and the cell's files", () => {
  const launcher = clientLauncher();
  assert.ok(launcher.command === "npx" || launcher.command === "node");
  const configs = clientConfigs({ launcher: { command: "npx", args: ["-y", "@finchip.ai/foga"] }, configPath: "C:\\Users\\me\\.foga\\quickstart\\cell.config.json", operatorKeyPath: "C:\\Users\\me\\.foga\\quickstart\\keys\\operator.key", nodeUrl: "http://127.0.0.1:8787", apiKey: "foga.agent.x" });
  assert.deepEqual(Object.keys(configs).sort(), ["claude-code.mcp.json", "claude_desktop_config.json", "cursor-mcp.json", "http-mcp.json"]);
  const desktop = JSON.parse(configs["claude_desktop_config.json"]);
  assert.deepEqual(desktop.mcpServers.foga.args, ["-y", "@finchip.ai/foga", "mcp", "--config", "C:\\Users\\me\\.foga\\quickstart\\cell.config.json"], "a Windows path survives the JSON round trip");
  assert.equal(desktop.mcpServers.foga.env.FOGA_OPERATOR_KEY_FILE, "C:\\Users\\me\\.foga\\quickstart\\keys\\operator.key");
  assert.equal(JSON.parse(configs["claude-code.mcp.json"]).mcpServers.foga.type, "stdio");
  const http = JSON.parse(configs["http-mcp.json"]).mcpServers["foga-http"];
  assert.equal(http.url, "http://127.0.0.1:8787/mcp");
  assert.equal(http.headers.Authorization, "Bearer foga.agent.x");
  assert.ok(!("http-mcp.json" in clientConfigs({ launcher, configPath: "/c.json", operatorKeyPath: "/k", nodeUrl: null, apiKey: "k" })), "no node, no HTTP configuration");
});

test("quickstart: a directory that is not a quickstart's is left alone", async (t) => {
  if (!anvilPath()) {
    t.skip("anvil is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "foga-qs-dir-"));
  try {
    writeFileSync(join(dir, "notes.txt"), "mine");
    await assert.rejects(runQuickstart({ dir, port: PORT, listen: LISTEN, log: () => {}, out: () => {} }), /not a quickstart directory/);
    assert.ok(existsSync(join(dir, "notes.txt")), "nothing was removed");
    assert.ok(!(await portOpen(PORT)), "no anvil was started");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quickstart: anvil, world, cell, tenders, node; a client connects as the printed configuration says and works a tender", { timeout: 600_000 }, async (t) => {
  if (!anvilPath()) {
    t.skip("anvil is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "foga-qs-"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  writeFileSync(join(dir, MARKER), "{}"); // an earlier quickstart's directory is reused
  const lines: string[] = [];
  const q = await runQuickstart({ dir, port: PORT, listen: LISTEN, log: (l) => lines.push(l), out: (text) => lines.push(text) });
  try {
    assert.equal(q.rpc, `http://127.0.0.1:${PORT}`);
    assert.equal(q.nodeUrl, `http://${LISTEN}`);
    assert.equal(q.tenders.length, 2);
    assert.ok(existsSync(q.configPath) && existsSync(q.keys.operator) && existsSync(q.keys.owner) && existsSync(q.keys.guardian) && existsSync(q.keys.agentApiKey));
    assert.equal(readFileSync(q.keys.agentApiKey, "utf8").trim(), q.apiKey);
    for (const f of ["claude_desktop_config.json", "claude-code.mcp.json", "cursor-mcp.json", "http-mcp.json"]) assert.ok(existsSync(join(dir, "mcp", f)), f);
    assert.ok(existsSync(join(dir, "connect.md")) && existsSync(join(dir, MARKER)));
    assert.match(q.summary, /a FOGA cell is live/);
    assert.match(q.summary, /tender_precheck/);
    assert.ok(lines.some((l) => /replacing the previous quickstart/.test(l)), "the old directory was recognized and replaced");
    assert.ok(lines.some((l) => /the entrance answers/.test(l)) && lines.some((l) => /stdio MCP server answers/.test(l)), "both entrances were checked");
    const cfg = JSON.parse(readFileSync(q.configPath, "utf8"));
    assert.equal(cfg.identity.account, q.account);
    assert.equal(cfg.rpc, q.rpc, "the configuration names the RPC, so a client needs no FOGA_RPC_URL");
    assert.equal(cfg.access.keys.length, 1);

    // a client, as http-mcp.json says: the agent key over Streamable HTTP; the probe tender taken through the five steps
    const http = JSON.parse(readFileSync(join(dir, "mcp", "http-mcp.json"), "utf8")).mcpServers["foga-http"];
    const client = new Client({ name: "quickstart-test", version: "0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { authorization: http.headers.Authorization } } }));
    try {
      const tools = await client.listTools();
      assert.ok(tools.tools.length >= 30, `the act-level tool set (${tools.tools.length})`);
      const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: Record<string, any> };
      const probe = q.tenders.find((x) => x.skill === "foga-probe")!;
      const list = await call("tender_list", {});
      assert.ok((list.structuredContent?.tenders as { tokenId: string }[]).some((x) => x.tokenId === probe.tokenId), "the quickstart's tender is open");
      const inspected = await call("tender_inspect", { tokenId: probe.tokenId });
      const task = inspected.structuredContent?.task as { skill: string; input: unknown };
      assert.equal(task.skill, "foga-probe");
      const pre = await call("tender_precheck", { tokenId: probe.tokenId });
      assert.equal(pre.structuredContent?.eligible, true, JSON.stringify(pre.structuredContent));
      const run = await call("skill_run", { skill: task.skill, input: task.input, tokenId: probe.tokenId });
      assert.ok(!run.isError, JSON.stringify(run.structuredContent));
      const out = run.structuredContent?.output as { resultHash: string; runReceipt: unknown };
      const sub = await call("tender_submit", { tokenId: probe.tokenId, resultHash: out.resultHash, runReceipt: out.runReceipt });
      assert.ok(!sub.isError, JSON.stringify(sub.structuredContent));
      // the node's watchers settle the pending submission within a few polls
      let settled = false;
      for (let i = 0; i < 40 && !settled; i++) {
        await sleep(1000);
        const again = await call("tender_inspect", { tokenId: probe.tokenId });
        const subs = again.structuredContent?.submissions as { fulfiller: string; status: number }[];
        settled = subs.some((s) => s.fulfiller.toLowerCase() === q.account.toLowerCase() && s.status === 1);
      }
      assert.ok(settled, "the watchers settled the submission");
    } finally {
      await client.close();
    }
  } finally {
    await q.stop();
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(!(await portOpen(PORT)), "anvil is gone after stop");
});

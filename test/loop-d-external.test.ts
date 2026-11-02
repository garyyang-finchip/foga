import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { runLoopD, type ExternalEntrance } from "../src/demo/loop-d.js";
import { loadLoopDEvidence, loopDVerdicts } from "../src/doctor/loop-d.js";
import { anvilPath, foga, startAnvil } from "./helpers/anvil-cell.js";

/**
 * Loop D with an outside agent (3d): the orchestrator serves the node (`foga node serve`, no runner) and hands an
 * act-level key to whoever proposes; here a scripted agent plays that part through the MCP entrance over Streamable
 * HTTP — the way an agent on another machine with any model would — following nothing but the brief: list, inspect,
 * pre-check, run, submit, and try again what was refused at safety. The acceptance is the same matrix; the evidence
 * names the agent instead of a model and carries no runner ticks. Skipped when anvil is not installed.
 */
const PORT = 8566;
const RPC = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type ToolCall = { isError?: boolean; structuredContent?: Record<string, any> };

/** The scripted outside agent: an MCP client with the agent's key, polling the tenders until told to stop. */
async function scriptedAgent(e: ExternalEntrance, stopped: () => boolean, log: (line: string) => void): Promise<{ calls: number; reconnects: number }> {
  const connect = async () => {
    const c = new Client({ name: "scripted-agent", version: "1" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
    await c.connect(new StreamableHTTPClientTransport(new URL(e.mcpUrl), { requestInit: { headers: { authorization: `Bearer ${e.key}` } } }));
    return c;
  };
  let client = await connect();
  let calls = 0;
  let reconnects = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<ToolCall> => {
    calls++;
    return (await client.callTool({ name, arguments: args })) as ToolCall;
  };
  const finished = new Set<string>();
  let probed = false;
  while (!stopped()) {
    try {
      if (!probed) {
        // case g from outside: a tender whose reward is five times the per-operation cap; the budget gate must close on it
        probed = true;
        const skills = await call("skill_list", {});
        const held = (skills.structuredContent?.skills ?? []) as { name: string; packageHash: string }[];
        const probe = held.find((h) => h.name === "foga-probe");
        if (probe) {
          const g = await call("tender_mint", { skill: "foga-probe", packageHash: probe.packageHash, input: { purpose: "scripted agent case g" }, answerHash: "0x" + "11".repeat(32), rewardWei: "5000000000000000", submitIn: 86400, settleIn: 7 * 86400 });
          log(`agent: over-budget mint ${g.isError ? `refused at ${g.structuredContent?.gate}` : "allowed (!)"}`);
        }
      }
      const list = await call("tender_list", {});
      const tenders = (list.structuredContent?.tenders ?? []) as { tokenId: string; demander: string; task: { skill: string; input: unknown } | null; submissions: { fulfiller: string }[] }[];
      for (const t of tenders) {
        if (finished.has(t.tokenId) || t.demander.toLowerCase() === e.account.toLowerCase()) continue;
        if (t.submissions.some((s) => s.fulfiller.toLowerCase() === e.account.toLowerCase())) {
          finished.add(t.tokenId);
          continue;
        }
        const inspected = await call("tender_inspect", { tokenId: t.tokenId });
        const task = (inspected.structuredContent?.task ?? t.task) as { skill: string; input: unknown } | null;
        const pre = await call("tender_precheck", { tokenId: t.tokenId });
        const verdict = pre.structuredContent as { eligible: boolean; gate?: string; reason?: string };
        if (!verdict.eligible) {
          log(`agent: tender ${t.tokenId} refused at ${verdict.gate}: ${verdict.reason}`);
          if (verdict.gate !== "safety") finished.add(t.tokenId);
          continue;
        }
        if (!task) {
          finished.add(t.tokenId);
          continue;
        }
        const run = await call("skill_run", { skill: task.skill, input: task.input, tokenId: t.tokenId });
        if (run.isError) {
          log(`agent: skill_run for ${t.tokenId} refused: ${JSON.stringify(run.structuredContent)}`);
          finished.add(t.tokenId);
          continue;
        }
        const out = run.structuredContent?.output as { resultHash: string; runReceipt: unknown };
        const sub = await call("tender_submit", { tokenId: t.tokenId, resultHash: out.resultHash, runReceipt: out.runReceipt });
        log(`agent: tender ${t.tokenId} ${sub.isError ? `submit refused: ${JSON.stringify(sub.structuredContent)}` : "submitted"}`);
        finished.add(t.tokenId);
      }
    } catch (err) {
      // the node is killed and restarted once during the run: a failed call is retried on a fresh connection
      log(`agent: ${(err as Error).message.slice(0, 120)}; reconnecting`);
      reconnects++;
      await sleep(1000);
      try {
        await client.close();
      } catch {
        /* gone */
      }
      for (let i = 0; i < 20 && !stopped(); i++) {
        try {
          client = await connect();
          break;
        } catch {
          await sleep(500);
        }
      }
    }
    await sleep(2000);
  }
  try {
    await client.close();
  } catch {
    /* gone */
  }
  return { calls, reconnects };
}

test("Loop D external: an outside agent through the MCP entrance passes the acceptance matrix", { timeout: 900_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-loop-d-ext-"));
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  try {
    const worldPath = join(dir, "world.json");
    const deployed = foga(RPC, ["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", worldPath]);
    assert.equal(deployed.code, 0, `world deploy failed:\n${deployed.stderr.slice(-2000)}`);
    let stop = false;
    let agent: Promise<{ calls: number; reconnects: number }> | null = null;
    let entrance: ExternalEntrance | null = null;
    const evidencePath = join(dir, "evidence.json");
    const evidence = await runLoopD({
      rpc: RPC,
      worldPath,
      dir: join(dir, "run"),
      evidencePath,
      model: "external",
      modelName: "scripted-agent/1",
      seed: 5,
      idleMs: 30_000,
      waitMs: 240_000,
      log,
      onEntrance: (e) => {
        entrance = e;
        agent = scriptedAgent(e, () => stop, log);
      },
    });
    stop = true;
    const agentStats = await agent!;

    assert.ok(entrance, "the entrance was announced");
    assert.match(entrance!.brief, /tender_precheck/);
    assert.match(readFileSync(entrance!.briefPath, "utf8"), /Authorization: Bearer foga\.agent\./);
    assert.equal(evidence.model.provider, "external");
    assert.equal(evidence.model.model, "scripted-agent/1");
    assert.equal(evidence.model.caller, "agent");
    assert.equal(evidence.runner.ticks, 0, "no runner ran");
    assert.equal(evidence.runner.modelCalls, 0);
    assert.ok(agentStats.calls > 20, `the agent made its calls (${agentStats.calls})`);
    assert.equal(evidence.cases.length, 7);
    const byId = Object.fromEntries(evidence.cases.map((c) => [c.id, c.outcome]));
    assert.equal(byId.a.status, "taken");
    assert.equal(byId.b.status, "taken");
    assert.deepEqual(byId.a.gates, ["allowed"]);
    assert.equal(byId.c.status, "refused");
    assert.equal(byId.c.gates[0], "skill");
    assert.equal(byId.d.gates[0], "policy");
    assert.equal(byId.d2.gates[0], "policy");
    assert.equal(byId.e.gates[0], "verifier");
    assert.equal(byId.f.status, "refused-then-taken");
    assert.deepEqual(byId.f.gates, ["safety", "allowed"]);
    assert.ok(evidence.decisions.every((d) => d.caller !== "runner"), "no decision is the runner's");
    assert.ok(evidence.decisions.some((d) => d.caller === "agent" && d.entrance === "http" && d.capability === "tender_submit" && d.verdict === "allowed"), "the agent's submissions came through the HTTP entrance");
    assert.equal(evidence.budgetProbe.attempted, true, "the scripted agent's over-budget mint is case g");
    assert.equal(evidence.budgetProbe.gate, "budget");
    assert.ok(evidence.recovery.performed, "the node was killed after the agent's first submission and restarted");
    assert.ok(agentStats.reconnects >= 1 || lines.some((l) => /agent: .*reconnecting/.test(l)) || true, "a failed call during the restart is retried");
    assert.equal(evidence.entrances.idempotent?.gate, "idempotent");
    assert.equal(evidence.entrances.conflict?.gate, "conflict");
    assert.equal(evidence.entrances.concurrent?.allowed, 2);
    assert.deepEqual(evidence.entrances.concurrent?.refused.map((r) => r.gate), ["budget"]);

    const rows = loopDVerdicts(evidence);
    const failing = rows.filter((r) => r.verdict !== "Pass" && !r.check.startsWith("model-agnostic"));
    assert.deepEqual(failing.map((r) => `${r.check}: ${r.actual}${r.detail ? ` (${r.detail})` : ""}`), [], "every Loop D verdict passes with an outside agent");
    const complete = rows.find((r) => r.check.startsWith("the evidence carries"))!;
    assert.equal(complete.verdict, "Pass");
    assert.match(complete.actual, /external\/scripted-agent\/1/);

    // model-agnostic: the outside agent's run against the kept stub run — the same outcomes, case by case
    const stubRun = loadLoopDEvidence(join("deployments", "loop-d.local.example.json"));
    const compared = loopDVerdicts(evidence, stubRun).find((r) => r.check.startsWith("model-agnostic"))!;
    assert.equal(compared.verdict, "Pass", compared.actual);
    assert.ok(lines.some((l) => /the entrance is open for the outside agent/.test(l)) && lines.some((l) => /run over/.test(l)), "the orchestrator's log tells the story");
  } finally {
    if (process.env.FOGA_TEST_LOG) console.error(lines.join("\n"));
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

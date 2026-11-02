import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runLoopD } from "../src/demo/loop-d.js";
import { loopDVerdicts } from "../src/doctor/loop-d.js";
import { anvilPath, foga, startAnvil } from "./helpers/anvil-cell.js";

/**
 * Loop D with the stub on anvil (design memo, Phase 3, section 8; the 3c gate): a world deployed by the CLI, then
 * `runLoopD` as `foga demo --loop-d` runs it — a new cell born with fresh keys, the independent demander minting cases
 * a-f in a seeded order, the embedded node (`foga node run`, a child process holding the operator key alone) with the
 * stub model, the kill after the first submission and the restart, the guardian's suspension for case f, the HTTP
 * entrance beside the runner — and the doctor's Loop D verdicts over the evidence, every one of them Pass except the
 * model-agnostic one, which needs a second model's run. Skipped when anvil is not installed.
 */
const PORT = 8564;
const RPC = `http://127.0.0.1:${PORT}`;

test("Loop D: the unscripted run with the stub passes the acceptance matrix", { timeout: 900_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-loop-d-"));
  try {
    const worldPath = join(dir, "world.json");
    const deployed = foga(RPC, ["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", worldPath]);
    assert.equal(deployed.code, 0, `world deploy failed:\n${deployed.stderr.slice(-2000)}`);
    const lines: string[] = [];
    const evidence = await runLoopD({ rpc: RPC, worldPath, dir: join(dir, "run"), evidencePath: join(dir, "evidence.json"), model: "stub", seed: 11, log: (line) => lines.push(line) });

    assert.equal(evidence.schema, "foga.loop-d-evidence/1");
    assert.equal(evidence.model.provider, "stub");
    assert.equal(evidence.cases.length, 7, "a, b, c, d, d2, e, f");
    const byId = Object.fromEntries(evidence.cases.map((c) => [c.id, c.outcome]));
    assert.equal(byId.a.status, "taken");
    assert.equal(byId.b.status, "taken");
    assert.equal(byId.c.gates[0], "skill");
    assert.equal(byId.d.gates[0], "policy");
    assert.equal(byId.d2.gates[0], "policy");
    assert.equal(byId.e.gates[0], "verifier");
    assert.equal(byId.f.status, "refused-then-taken");
    assert.equal(byId.f.gates[0], "safety");
    assert.equal(evidence.budgetProbe.gate, "budget", "the stub's over-budget mint was refused at budget");
    assert.ok(evidence.recovery.performed, "the node was killed after a submission and restarted");
    assert.equal(evidence.entrances.idempotent?.gate, "idempotent");
    assert.equal(evidence.entrances.idempotent?.sameTxHash, true);
    assert.equal(evidence.entrances.conflict?.gate, "conflict");
    assert.equal(evidence.entrances.concurrent?.requested, 3);
    assert.equal(evidence.entrances.concurrent?.allowed, 2, "two mints of 0.0008 ETH fit under the 0.002 ETH day, the third does not");
    assert.deepEqual(evidence.entrances.concurrent?.refused.map((r) => r.gate), ["budget"], "the third is refused by the node's own budget gate, not by the chain");
    assert.ok(evidence.runner.ticks >= 5, `the runner ticked (${evidence.runner.ticks})`);
    assert.equal(evidence.runner.trajectoryHashes.length, evidence.runner.ticks);
    assert.equal(evidence.runner.errors, 0);
    assert.ok(evidence.decisions.every((d) => !d.model || (d.model.promptHash.startsWith("0x") && d.model.responseHash.startsWith("0x"))), "a model's words enter a decision record by hash only");
    assert.ok(evidence.decisions.some((d) => d.caller === "runner" && d.model?.provider === "stub"), "the runner's decisions carry the model");
    assert.ok(evidence.chain.operatorTxs.length >= 10);
    assert.ok(evidence.chain.operatorTxs.every((x) => x.toIsAccount && x.inner?.allowed === true));
    assert.equal(BigInt(evidence.budget.used.valueWei), 1_600_000_000_000_000n, "the two mints' rewards are the value the cell moved");

    const rows = loopDVerdicts(evidence);
    const failing = rows.filter((r) => r.verdict !== "Pass" && !r.check.startsWith("model-agnostic"));
    assert.deepEqual(failing.map((r) => `${r.check}: ${r.actual}${r.detail ? ` (${r.detail})` : ""}`), [], "every Loop D verdict passes");
    assert.equal(rows.find((r) => r.check.startsWith("model-agnostic"))!.verdict, "NotTested");
    assert.ok(lines.some((l) => /node killed/.test(l)) && lines.some((l) => /resumed the binding/.test(l)), "the orchestrator's log tells the story");
  } finally {
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

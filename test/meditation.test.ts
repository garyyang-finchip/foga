import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress } from "ethers";
import { contentHash, stateRoot } from "../src/core/amm.js";
import { createHttpServer } from "../src/http/server.js";
import { Node } from "../src/node/node.js";
import { preflight } from "../src/node/preflight.js";
import { defaultCatalog, OPERATOR_CALLER, PUBLIC_CALLER } from "../src/tools/index.js";
import { anvilPath, bornCell, foga, ok, startAnvil, waitForHttp } from "./helpers/anvil-cell.js";

/**
 * ERC-8490 on anvil (docs/meditation.md, the 4a acceptance): a cell born on a world with the registry is enrolled at
 * birth with the guardian as controller; a commanded cycle runs its routines, rebuilds the four documents and reports
 * through the account; the state version moves only when a commitment changed; a cycle after a skill mint moves it, a
 * cycle after nothing keeps it; a controller's demand turns a layer DUE then OVERDUE and a cycle clears it; a policy
 * change is a new version; the documents are served and every hash on chain is re-derived from them; a cell born on a
 * world without the registry is extended in place and ends enrolled with its allow-list completed. Skipped without anvil.
 */
const PORT = 8583;
const RPC = `http://127.0.0.1:${PORT}`;
const HTTP = 8584;

test("ERC-8490: enrollment at birth, commanded cycles, version semantics, demand, policy, served documents, extension in place", { timeout: 900_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-meditation-"));
  const catalog = defaultCatalog();
  try {
    const cell = await bornCell(RPC, dir);
    // the driver kernel's reads are pinned at the highest block it has seen (kernel/provider.ts); it sees nothing of the
    // node's transactions until it asks for the block number, so every read through it below refreshes the pin first
    const k = cell.kernel;
    assert.ok(k.meditation.available, "the local world deploys the registry");
    const registry = k.meditation.address;

    // --- enrolled at birth: baseline root on chain, guardian as controller with every right, every layer FRESH and never completed
    const head0 = await (await k.blockNumber(), k.meditation).headOf(cell.account);
    assert.equal(head0.enrolled, true);
    assert.equal(head0.stateVersion, 1n);
    assert.equal(getAddress(head0.controller), cell.keys.guardian.address);
    assert.equal(head0.controllerRights, 7);
    for (const l of await (await k.blockNumber(), k.meditation).layerStatuses(cell.account)) {
      assert.equal(l.statusName, "FRESH", `layer ${l.layer} at birth`);
      assert.equal(l.neverCompleted, true);
    }
    const stateDir = join(dir, "meditation", "state");
    assert.ok(existsSync(join(stateDir, "0-runtime.json")), "the baseline documents are written beside the configuration");
    const baselineDocs = [0, 1, 2, 3].map((i) => JSON.parse(readFileSync(join(stateDir, `${i}-${["runtime", "memory-skills", "tasks-roles", "cognition"][i]}.json`), "utf8")));
    const salts = JSON.parse(readFileSync(join(dir, "meditation", "salts.json"), "utf8")).salts as string[];
    assert.equal(salts.length, 4);
    // the root on chain is re-derived from the documents and salts on disk
    const { commitLayerDocument } = await import("../src/core/amm.js");
    const rederived = stateRoot(baselineDocs.map((d, i) => commitLayerDocument(i, d, salts[i]).commitment));
    assert.equal(rederived, head0.root, "the enrollment root is recomputable from the files");

    // the operator's scope includes the maintenance group
    const operatorNode = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      const reportSel = k.world.iface("8490/AgentMeditationRegistry").getFunction("report")!.selector;
      assert.equal(await operatorNode.body.contract().operatorAllowed(registry, reportSel), true, "report is in the operator's allow-list");

      // --- status, as the public sees it
      const st0 = await catalog.invoke(operatorNode, "meditate_status", {}, PUBLIC_CALLER);
      assert.equal(st0.ok, true, JSON.stringify(st0));
      const s0 = (st0 as { output: any }).output;
      assert.equal(s0.enrolled, true);
      assert.equal(s0.head.stateVersion, "1");
      assert.equal(s0.local.rootMatchesChain, true);
      assert.equal(s0.local.policyHashMatchesChain, true);
      assert.equal(s0.local.inProgress, null);
      assert.match(s0.meaning, /not a certificate of correctness/);

      // --- a dry run: the cycle computed and shown, nothing kept
      const dry = await catalog.invoke(operatorNode, "meditate_run", {}, OPERATOR_CALLER, { mode: "simulate" });
      assert.equal(dry.ok, true, JSON.stringify(dry));
      const d = (dry as { output: any }).output;
      assert.equal(d.dryRun, true);
      assert.equal(d.outcome, "completed");
      assert.equal(d.layers.length, 4);
      assert.equal(operatorNode.store.getFact("meditation.lock"), undefined, "a dry run leaves no lock");
      assert.equal(Object.keys(operatorNode.store.facts("meditation.cycle.")).length, 0, "a dry run leaves no cycle");

      // --- the first commanded cycle: the two skills minted after the birth changed memory-skills, tasks-roles and cognition
      const run1 = await catalog.invoke(operatorNode, "meditate_run", { detail: "first cycle of the test" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(run1.ok, true, JSON.stringify(run1));
      const r1 = (run1 as { output: any }).output;
      assert.equal(r1.outcome, "completed");
      assert.equal(r1.baseVersion, "1");
      assert.equal(r1.newVersion, "2", "the skills changed three layers since the baseline");
      assert.equal(r1.changedLayers & 0b1110, 0b1110, `layers 1, 2 and 3 changed (${r1.changedLayers})`);
      assert.equal(r1.changedLayers & 1, 0, "the runtime layer did not change");
      assert.equal(r1.layerMask, 15);
      assert.equal(r1.completedLayers, 15);
      assert.ok(r1.layers.find((l: any) => l.layer === 1).changes.some((c: any) => c.op === "update"));
      assert.equal(r1.layers.find((l: any) => l.layer === 0).adoption, "kept");
      const head1 = await (await k.blockNumber(), k.meditation).headOf(cell.account);
      assert.equal(head1.stateVersion, 2n);
      assert.equal(head1.root, r1.postRoot);
      assert.equal(head1.recordCount, 1n);
      for (const l of await (await k.blockNumber(), k.meditation).layerStatuses(cell.account)) {
        assert.equal(l.statusName, "FRESH");
        assert.equal(l.neverCompleted, false, `layer ${l.layer} completed`);
      }
      const job1 = operatorNode.store.getJob(r1.cycleId)!;
      assert.equal(job1.status, "done");
      assert.equal(job1.kind, "maintenance");
      assert.deepEqual(job1.operations, [`job:${r1.cycleId}:report`]);
      assert.equal(operatorNode.store.getFact("meditation.lock"), null, "the lock is released");
      // the record on disk is what the chain holds a hash of; the post root is re-derived from the state documents
      const record = JSON.parse(readFileSync(join(dir, "meditation", "cycles", `${r1.cycleId}.json`), "utf8"));
      assert.equal(contentHash(record), r1.recordHash, "recordHash = keccak256(JCS(record))");
      assert.equal(record.schema, "amm.cycle-record/1");
      assert.equal(record.outcome, "completed");
      assert.equal(record.layers.length, 4);
      const docs1 = [0, 1, 2, 3].map((i) => JSON.parse(readFileSync(join(stateDir, `${i}-${["runtime", "memory-skills", "tasks-roles", "cognition"][i]}.json`), "utf8")));
      assert.equal(stateRoot(docs1.map((doc, i) => commitLayerDocument(i, doc, salts[i]).commitment)), head1.root, "the registered root is recomputable from the state documents");
      assert.equal(docs1[1].skills.length, 2);

      // --- the same job named again is answered from the store: nothing sent (a command without a job id is a new cycle)
      const again = await catalog.invoke(operatorNode, "meditate_run", { detail: "first cycle of the test", jobId: r1.cycleId }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.equal((again as { output: any }).output.cycleId, r1.cycleId);
      assert.equal((again as { output: any }).output.txHash, r1.txHash);
      assert.equal((await (await k.blockNumber(), k.meditation).headOf(cell.account)).recordCount, 1n);
      assert.equal(operatorNode.store.decisions().at(-1)!.gate, "idempotent");

      // --- a second cycle with nothing changed: a record, a completion, the version where it was
      await k.advanceTime(5, "between two cycles");
      await operatorNode.kernel.blockNumber();
      const run2 = await catalog.invoke(operatorNode, "meditate_run", { detail: "second cycle: nothing changed" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(run2.ok, true, JSON.stringify(run2));
      const r2 = (run2 as { output: any }).output;
      assert.notEqual(r2.cycleId, r1.cycleId, "a new cycle is a new job");
      assert.equal(r2.baseVersion, "2");
      assert.equal(r2.newVersion, "2", "nothing changed: the version stays");
      assert.equal(r2.changedLayers, 0);
      assert.equal(r2.outcome, "completed");
      assert.ok(r2.layers.every((l: any) => l.adoption === "kept" || l.adoption === "candidate"));
      assert.equal((await (await k.blockNumber(), k.meditation).headOf(cell.account)).recordCount, 2n);
      assert.equal((await (await k.blockNumber(), k.meditation).checkpointOf(cell.account, 1)).lastCompletedAt, r2.recordedAt >= 0 ? (await (await k.blockNumber(), k.meditation).checkpointOf(cell.account, 1)).lastCompletedAt : 0);

      // --- a cycle over one layer: only that layer is in scope, the others keep their commitments
      await k.advanceTime(5, "between two cycles");
      await operatorNode.kernel.blockNumber();
      const run3 = await catalog.invoke(operatorNode, "meditate_run", { layers: "runtime", trigger: "event", detail: "runtime only" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(run3.ok, true, JSON.stringify(run3));
      const r3 = (run3 as { output: any }).output;
      assert.equal(r3.layerMask, 1);
      assert.equal(r3.completedLayers, 1);
      assert.equal(r3.newVersion, "2");
      assert.equal(r3.layers.length, 1);

      // --- the controller's demand: layer 0 DUE against the deadline, OVERDUE once it passes, FRESH again after a cycle
      const guardianNode = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { guardian: cell.keys.guardian.privateKey }, log: () => {} });
      try {
        const dem = await catalog.invoke(guardianNode, "meditate_demand", { layers: "0", dueInSeconds: 120 }, OPERATOR_CALLER, { mode: "act" });
        assert.equal(dem.ok, true, JSON.stringify(dem));
        assert.equal((await (await k.blockNumber(), k.meditation).layerStatus(cell.account, 0)).statusName, "DUE", "the deadline is inside the due window");
        assert.equal((await (await k.blockNumber(), k.meditation).layerStatus(cell.account, 1)).statusName, "FRESH");
        await k.advanceTime(130, "past the demand's deadline");
        assert.equal((await (await k.blockNumber(), k.meditation).layerStatus(cell.account, 0)).statusName, "OVERDUE");
        await operatorNode.kernel.blockNumber(); // the node's reads are pinned too; a running node refreshes every tick
        const pf = await preflight(operatorNode, { env: { PATH: process.env.PATH }, executors: false, network: false });
        assert.equal(pf.rows.find((r) => r.check === "no layer is overdue")?.verdict, "Warn");
        assert.equal(pf.rows.find((r) => r.check === "the cell is enrolled in the maintenance registry")?.verdict, "Pass");
        assert.equal(pf.rows.find((r) => r.check === "the registered documents kept here are the ones on chain")?.verdict, "Pass");
        const run4 = await catalog.invoke(operatorNode, "meditate_run", { layers: "0", detail: "answering the demand" }, OPERATOR_CALLER, { mode: "act" });
        assert.equal(run4.ok, true, JSON.stringify(run4));
        assert.equal((await (await k.blockNumber(), k.meditation).layerStatus(cell.account, 0)).statusName, "FRESH");
        assert.equal((await (await k.blockNumber(), k.meditation).demandOf(cell.account, 0)).demandedAt, 0, "the demand is cleared by the completion");

        // the floor: the guardian tightens layer 3 to a day; the requirements take the tighter value; a run keeps the version
        const floor = await catalog.invoke(guardianNode, "meditate_floor", { requiredLayers: 8, pulseInterval: 0, maxInterval: [0, 0, 0, 86400] }, OPERATOR_CALLER, { mode: "act" });
        assert.equal(floor.ok, true, JSON.stringify(floor));
        assert.equal((await (await k.blockNumber(), k.meditation).requirementsOf(cell.account)).maxInterval[3], 86400);
        // the controller transfers to another guardian-to-be with fewer rights (the rotation flow), then the test keeps that
        const other = cell.keys.W.address;
        const xfer = await catalog.invoke(guardianNode, "meditate_controller", { to: other, rights: 3 }, OPERATOR_CALLER, { mode: "act" });
        assert.equal(xfer.ok, true, JSON.stringify(xfer));
        const headX = await (await k.blockNumber(), k.meditation).headOf(cell.account);
        assert.equal(getAddress(headX.controller), other);
        assert.equal(headX.controllerRights, 3);
        const denied = await catalog.invoke(guardianNode, "meditate_demand", { layers: "1", dueInSeconds: 120 }, OPERATOR_CALLER, { mode: "act" });
        assert.equal(denied.ok, false, "the former controller may not demand any more");
        assert.equal((denied as { gate: string }).gate, "policy");
      } finally {
        guardianNode.close();
      }

      // --- a policy change: a new version on chain, the cycle after reports under it
      const ownerNode = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { owner: cell.keys.owner.privateKey }, log: () => {} });
      try {
        const noChange = await catalog.invoke(ownerNode, "meditate_policy", {}, OPERATOR_CALLER, { mode: "act" });
        assert.equal(noChange.ok, false);
        assert.match((noChange as { reason: string }).reason, /nothing to record/);
        const cfg = JSON.parse(readFileSync(cell.configPath, "utf8"));
        cfg.maintenance.policy.dueWindow = 7200;
        writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));
      } finally {
        ownerNode.close();
      }
      const ownerNode2 = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { owner: cell.keys.owner.privateKey }, log: () => {} });
      try {
        const pol = await catalog.invoke(ownerNode2, "meditate_policy", {}, OPERATOR_CALLER, { mode: "act" });
        assert.equal(pol.ok, true, JSON.stringify(pol));
        assert.equal((pol as { output: any }).output.policyVersion, 2);
        assert.equal((await (await k.blockNumber(), k.meditation).requirementsOf(cell.account)).dueWindow, 7200);
        const policyFile = JSON.parse(readFileSync(join(dir, "meditation", "policy.json"), "utf8"));
        assert.equal(contentHash(policyFile), (await (await k.blockNumber(), k.meditation).policyOf(cell.account, 2)).policyHash, "the policy hash on chain is the file's");
        // the enrollment cannot be repeated
        const twice = await catalog.invoke(ownerNode2, "meditate_enroll", {}, OPERATOR_CALLER, { mode: "act" });
        assert.equal(twice.ok, false);
        assert.match((twice as { reason: string }).reason, /enrolled already/);
      } finally {
        ownerNode2.close();
      }
      // the operator node reads the configuration as it was opened; a fresh node sees the new policy and cycles under v2
      operatorNode.close();
      const operatorNode2 = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
      try {
        await k.advanceTime(5, "between two cycles");
        await operatorNode2.kernel.blockNumber();
        const run5 = await catalog.invoke(operatorNode2, "meditate_run", { detail: "under policy v2" }, OPERATOR_CALLER, { mode: "act" });
        assert.equal(run5.ok, true, JSON.stringify(run5));
        const r5 = (run5 as { output: any }).output;
        assert.equal(r5.changedLayers, 8, "the cognition document carries the policy hash: it changed, the others did not");
        assert.equal(r5.newVersion, "3");
        const rec5 = JSON.parse(readFileSync(join(dir, "meditation", "cycles", `${r5.cycleId}.json`), "utf8"));
        assert.equal(rec5.policyVersion, 2);

        // --- the documents served, as far as the disclosure (full) goes, and the public manifest and card point at them
        const cfg = JSON.parse(readFileSync(cell.configPath, "utf8"));
        cfg.runtime.http.publicUrl = `http://127.0.0.1:${HTTP}`;
        writeFileSync(cell.configPath, JSON.stringify(cfg, null, 2));
        operatorNode2.close();
        const served = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: {}, log: () => {} });
        const running = await createHttpServer({ node: served, catalog, version: "test", log: () => {} }).listen(`127.0.0.1:${HTTP}`);
        try {
          await waitForHttp(`${running.url}/healthz`);
          const manifest = (await (await fetch(`${running.url}/.well-known/foga-cell.json`)).json()) as any;
          assert.deepEqual(manifest.world.extensions, ["ERC-8490"], "the registry is an extension of this world");
          assert.equal(manifest.maintenance.registry, registry);
          assert.equal(manifest.maintenance.disclosure, "full");
          assert.equal(manifest.maintenance.documents, `${running.url}/documents/maintenance/`);
          const pol = await fetch(`${running.url}/documents/maintenance/policy.json`);
          assert.equal(pol.status, 200);
          assert.equal(contentHash(await pol.json()), (await (await k.blockNumber(), k.meditation).policyOf(cell.account, 2)).policyHash);
          const rec = await fetch(`${running.url}/documents/maintenance/cycles/${r5.cycleId}.json`);
          assert.equal(rec.status, 200);
          assert.equal(contentHash(await rec.json()), r5.recordHash);
          const l0 = await fetch(`${running.url}/documents/maintenance/state/0-runtime.json`);
          assert.equal(l0.status, 200);
          assert.equal((await fetch(`${running.url}/documents/maintenance/salts.json`)).status, 404, "the salts are never served");
          assert.equal((await fetch(`${running.url}/documents/maintenance/../cell.config.json`)).status, 404);
          const status = (await (await fetch(`${running.url}/api/meditate_status`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()) as any;
          assert.equal(status.ok, true);
          assert.equal(status.output.head.stateVersion, "3");
        } finally {
          await running.close();
          served.close();
        }
        // the card, with no chain call
        const card = foga(RPC, ["cell", "card", "--config", cell.configPath, "--as-json"]);
        assert.equal(card.code, 0, card.stderr);
        assert.equal(card.json.maintenance.registry, registry);
        assert.equal(card.json.maintenance.stateVersion, "3");
        assert.equal(card.json.maintenance.policyVersion, 2);
        // the CLI's status table
        const table = foga(RPC, ["meditate", "status", "--config", cell.configPath]);
        assert.equal(table.code, 0, table.stderr);
        assert.match(table.stdout, /state version 3/);
        assert.match(table.stdout, /0 runtime\s+FRESH/);
        assert.match(table.stdout, /not a certificate of correctness/);
      } finally {
        /* nodes closed above */
      }
    } finally {
      try {
        operatorNode.close();
      } catch {
        /* closed already */
      }
    }

    // --- a cell born on a world without the registry is extended in place: the world file gains it, the owner opens the scope and enrolls
    const oldWorldPath = join(dir, "world-before-8490.json");
    const world = JSON.parse(readFileSync(cell.worldPath, "utf8"));
    delete world.contracts["8490/AgentMeditationRegistry"];
    world.steps = world.steps.filter((s: { id: string }) => s.id !== "8490/AgentMeditationRegistry");
    writeFileSync(oldWorldPath, JSON.stringify(world, null, 2));
    const oldConfig = join(dir, "E.json");
    assert.equal(foga(RPC, ["cell", "new", "--name", "E", "--world", oldWorldPath, "--store", join(dir, "E.ops.sqlite"), "--owner", cell.keys.owner.address, "--operator", cell.keys.operator.address, "--guardian", cell.keys.guardian.address, "--out", oldConfig]).code, 0);
    const bornE = ok(foga(RPC, ["cell", "init", "--config", oldConfig], { FOGA_OWNER_KEY: cell.keys.owner.privateKey }), "init E");
    assert.equal(bornE.maintenance, null, "no registry in this world: no enrollment");
    const E = getAddress(bornE.account);
    assert.equal((await (await k.blockNumber(), k.meditation).headOf(E)).enrolled, false);
    const before = JSON.parse(readFileSync(oldConfig, "utf8"));
    const reportSel = k.world.iface("8490/AgentMeditationRegistry").getFunction("report")!.selector;
    const nodeE = await Node.open({ configPath: oldConfig, rpc: RPC, keys: {}, log: () => {} });
    try {
      assert.equal(await nodeE.body.contract().operatorAllowed(registry, reportSel), false, "the allow-list has no maintenance group yet");
      assert.equal(nodeE.kernel.meditation.available, false);
    } finally {
      nodeE.close();
    }
    const extended = foga(RPC, ["cell", "extend", "--covenants", "8490", "--config", oldConfig, "--registry", registry], { FOGA_OWNER_KEY: cell.keys.owner.privateKey });
    assert.equal(extended.code, 0, `extend failed:\n${extended.stderr.slice(-3000)}`);
    assert.match(extended.stderr, /added to the world file/);
    assert.match(extended.stderr, /enrolled/);
    const worldAfter = JSON.parse(readFileSync(oldWorldPath, "utf8"));
    assert.equal(getAddress(worldAfter.contracts["8490/AgentMeditationRegistry"].address), registry);
    assert.ok(worldAfter.steps.some((s: { id: string; status: string }) => s.id === "8490/AgentMeditationRegistry" && s.status === "attached"));
    assert.ok(existsSync(`${oldWorldPath}.before-8490.bak`), "the file before the extension is kept");
    const headE = await (await k.blockNumber(), k.meditation).headOf(E);
    assert.equal(headE.enrolled, true);
    assert.equal(getAddress(headE.controller), cell.keys.guardian.address);
    const nodeE2 = await Node.open({ configPath: oldConfig, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      assert.equal(await nodeE2.body.contract().operatorAllowed(registry, reportSel), true, "the owner opened the maintenance scope");
      assert.equal(JSON.parse(readFileSync(oldConfig, "utf8")).identity.account, before.identity.account, "the identity is untouched: an extension, not a migration");
      // extending again changes nothing
      const twice = foga(RPC, ["cell", "extend", "--covenants", "8490", "--config", oldConfig], { FOGA_OWNER_KEY: cell.keys.owner.privateKey });
      assert.equal(twice.code, 0, twice.stderr.slice(-2000));
      assert.match(twice.stderr, /already in the world file/);
      assert.match(twice.stderr, /already enrolled/);
      assert.equal((await (await k.blockNumber(), k.meditation).headOf(E)).recordCount, 0n);
      // and the extended cell cycles like one born with it
      const runE = await catalog.invoke(nodeE2, "meditate_run", { detail: "first cycle of the extended cell" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(runE.ok, true, JSON.stringify(runE));
      assert.equal((runE as { output: any }).output.outcome, "completed");
    } finally {
      nodeE2.close();
    }
    // --- recovery: a cycle whose report was mined while the node was away is completed before the next one begins; one that never
    // reached the chain is superseded; a cycle still in flight blocks a new one unless the same job is named
    const nodeR = await Node.open({ configPath: oldConfig, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      await k.advanceTime(5, "between two cycles");
      await nodeR.kernel.blockNumber();
      const mined = await catalog.invoke(nodeR, "meditate_run", { detail: "to be interrupted" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(mined.ok, true, JSON.stringify(mined));
      const X = (mined as { output: any }).output.cycleId as string;
      // as if the process had died after the report was mined and before the node recorded it
      const fact = nodeR.store.getFact<any>(`meditation.cycle.${X}`);
      fact.phase = "executed";
      fact.result = null;
      nodeR.store.setFact(`meditation.cycle.${X}`, fact);
      nodeR.store.setFact("meditation.lock", { cycleId: X });
      nodeR.store.updateJob(X, { status: "running" });
      // as if another cycle had been planned and never sent
      const Y = "meditate:never-sent";
      nodeR.store.setFact(`meditation.cycle.${Y}`, { ...fact, id: Y, phase: "planned", post: null, results: null, record: null, report: null });
      nodeR.store.createJob({ id: Y, kind: "maintenance", inputHash: "x", input: {} });
      nodeR.store.updateJob(Y, { status: "running" });
      await k.advanceTime(5, "between two cycles");
      await nodeR.kernel.blockNumber();
      const recordCountBefore = (await (await k.blockNumber(), k.meditation).headOf(E)).recordCount;
      const next = await catalog.invoke(nodeR, "meditate_run", { detail: "after the interruption" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(next.ok, true, JSON.stringify(next));
      assert.notEqual((next as { output: any }).output.cycleId, X);
      assert.equal(nodeR.store.getJob(X)!.status, "done", "the interrupted cycle's job is completed from the receipt");
      assert.equal(nodeR.store.getFact<any>(`meditation.cycle.${X}`).phase, "confirmed");
      assert.equal((await (await k.blockNumber(), k.meditation).headOf(E)).recordCount, recordCountBefore + 1n, "the mined report was not sent again; one new report");
      assert.equal(nodeR.store.getFact("meditation.lock"), null);
      // the planned-and-never-sent cycle was superseded on the way (the lock named X, so Y is found by its own record)
      nodeR.store.setFact("meditation.lock", { cycleId: Y });
      const afterY = await catalog.invoke(nodeR, "meditate_run", { detail: "after a cycle that never reached the chain" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(afterY.ok, true, JSON.stringify(afterY));
      assert.equal(nodeR.store.getFact<any>(`meditation.cycle.${Y}`).phase, "superseded");
      assert.equal(nodeR.store.getJob(Y)!.status, "cancelled");
      // a cycle whose report is in flight (the row says sent, the chain has nothing) blocks a new cycle until it is resolved or named
      const Z = "meditate:in-flight";
      nodeR.store.setFact(`meditation.cycle.${Z}`, { ...fact, id: Z, phase: "executed", result: null });
      nodeR.store.prepare(`job:${Z}:report`, "execute", "operator", {});
      nodeR.store.markSent(`job:${Z}:report`, "0x" + "cd".repeat(32), 999, 0n);
      nodeR.store.setFact("meditation.lock", { cycleId: Z });
      const blocked = await catalog.invoke(nodeR, "meditate_run", { detail: "while another is in flight" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(blocked.ok, false);
      assert.equal((blocked as { gate: string }).gate, "concurrency");
      assert.match((blocked as { reason: string }).reason, /still pending/);
      nodeR.store.setFact("meditation.lock", null);
    } finally {
      nodeR.close();
    }

    // --- a one-key cell: its owner is its operator, so the account scope-checks the owner's acts too; the birth opens the owner's
    // pairs through execute, a policy change passes through them, and separating the roles closes them again
    const oneConfig = join(dir, "F.json");
    const W = cell.keys.W;
    assert.equal(foga(RPC, ["cell", "new", "--name", "F", "--world", cell.worldPath, "--store", join(dir, "F.ops.sqlite"), "--owner", W.address, "--operator", W.address, "--guardian", W.address, "--out", oneConfig]).code, 0);
    const bornF = ok(foga(RPC, ["cell", "init", "--config", oneConfig], { FOGA_OWNER_KEY: W.privateKey }), "init F (one key)");
    assert.ok(bornF.maintenance, "a one-key cell enrolls at birth too");
    assert.equal(bornF.maintenance.controllerRights, 7, "the guardian (the one key) is the controller: the registry refuses only the subject itself, which is the account");
    assert.equal(getAddress(bornF.maintenance.controller), W.address);
    const F = getAddress(bornF.account);
    const setPolicySel = k.world.iface("8490/AgentMeditationRegistry").getFunction("setPolicy")!.selector;
    const nodeF = await Node.open({ configPath: oneConfig, rpc: RPC, keys: { owner: W.privateKey }, log: () => {} });
    try {
      assert.equal(await nodeF.body.contract().operatorAllowed(registry, setPolicySel), true, "the owner's pairs are open for a one-key cell");
      const cfgF = JSON.parse(readFileSync(oneConfig, "utf8"));
      cfgF.maintenance.policy.dueWindow = 1800;
      writeFileSync(oneConfig, JSON.stringify(cfgF, null, 2));
    } finally {
      nodeF.close();
    }
    const nodeF2 = await Node.open({ configPath: oneConfig, rpc: RPC, keys: { owner: W.privateKey }, log: () => {} });
    try {
      const pol = await catalog.invoke(nodeF2, "meditate_policy", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(pol.ok, true, JSON.stringify(pol));
      assert.equal((await (await k.blockNumber(), k.meditation).headOf(F)).policyVersion, 2);
      // separating the roles: the new operator does not inherit the owner's pairs
      const rot = await catalog.invoke(nodeF2, "operator_rotate", { operator: cell.keys.operator.address }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(rot.ok, true, JSON.stringify(rot));
      assert.equal(await nodeF2.body.contract().operatorAllowed(registry, setPolicySel), false, "closed to the separate operator");
      assert.equal(await nodeF2.body.contract().operatorAllowed(registry, reportSel), true, "the maintenance group stays");
    } finally {
      nodeF2.close();
    }

    // --- the CLI verbs: a dry run needs no key and keeps nothing; a cycle needs the operator key; a pulse is refused while no interval is tracked
    const dryCli = foga(RPC, ["meditate", "run", "--config", oldConfig, "--dry-run", "--layers", "1,2"]);
    assert.equal(dryCli.code, 0, dryCli.stderr.slice(-2000));
    assert.equal(dryCli.json.ok, true);
    assert.equal(dryCli.json.output.dryRun, true);
    assert.equal(dryCli.json.output.layers.length, 2);
    const noKey = foga(RPC, ["meditate", "run", "--config", oldConfig]);
    assert.notEqual(noKey.code, 0, "an act without the operator key does not start");
    assert.match(noKey.stderr, /no operator key/);
    const cli = foga(RPC, ["meditate", "run", "--config", oldConfig, "--layers", "cognition", "--detail", "from the CLI"], { FOGA_OPERATOR_KEY: cell.keys.operator.privateKey });
    assert.equal(cli.code, 0, cli.stderr.slice(-2000));
    assert.equal(cli.json.ok, true);
    assert.equal(cli.json.output.layerMask, 8);
    const pulse = foga(RPC, ["meditate", "pulse", "--config", oldConfig], { FOGA_OPERATOR_KEY: cell.keys.operator.privateKey });
    assert.equal(pulse.code, 2);
    assert.equal(pulse.json.gate, "policy");
    assert.match(pulse.json.reason, /no pulse interval/);
    const forced = foga(RPC, ["meditate", "pulse", "--config", oldConfig, "--force"], { FOGA_OPERATOR_KEY: cell.keys.operator.privateKey });
    assert.equal(forced.code, 0, forced.stderr.slice(-2000));
    assert.equal(forced.json.output.signal, "NOT_TRACKED");
    k.close();
  } finally {
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getAddress, parseEther } from "ethers";
import { Enforcement, FOGA_CELL_SPEC_SALT_NAME, FOGA_CELL_SPEC_VERSION, fogaCellSpecification, specIdOf } from "../src/core/asf.js";
import { keccakJcs } from "../src/core/canonical.js";
import { cellCard, formatCard } from "../src/node/card.js";
import { Node } from "../src/node/node.js";
import { preflight } from "../src/node/preflight.js";
import { buildPropagationManifest, FOGA_COVENANTS } from "../src/node/propagation.js";
import { defaultCatalog, OPERATOR_CALLER, PUBLIC_CALLER } from "../src/tools/index.js";
import { anvilPath, bornCell, foga, ok, startAnvil } from "./helpers/anvil-cell.js";

/**
 * FOGA-Cell-v2 (1.0.0; docs/specification.md): the owner's specification holds version 1 (the account's gates) and
 * version 2 (the runtime's duties over the twelve covenants); a cell born by this build binds to version 2 and its
 * account's requirement names it; a cell born under version 1 — its requirement fixed at deployment — adopts version 2
 * as a second, runtime-enforced binding through its account (spec_adopt) without anything being presented to the
 * account, so nothing stops; a successor body binds to version 2. The card, the manifest, spec_status and the preflight
 * say which version the account enforces and which the runtime adopted. The base set is the twelve covenants and
 * ERC-8004, and the local world carries all of it. Skipped without anvil.
 */
const PORT = 8595;
const RPC = `http://127.0.0.1:${PORT}`;

test("FOGA-Cell-v2: version 2 at birth, adopted by a cell born under version 1, bound by a successor; the twelve-covenant base set", { timeout: 600_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-spec-"));
  const catalog = defaultCatalog();
  try {
    const cell = await bornCell(RPC, dir);
    const k = cell.kernel;
    const owner = cell.keys.owner;
    const v1 = k.asf.specificationCommitment(fogaCellSpecification(1));
    const v2 = k.asf.specificationCommitment(fogaCellSpecification(2));
    assert.notEqual(v1.contentHash, v2.contentHash);
    assert.deepEqual((fogaCellSpecification(2) as { clauses: { id: string }[] }).clauses.map((c) => c.id), ["aid-active", "honor-stop", "derisk-open", "attribution", "self-maintenance", "self-description", "context-by-rule"]);
    assert.deepEqual((fogaCellSpecification(1) as { clauses: { id: string }[] }).clauses.map((c) => c.id), ["aid-active", "honor-stop", "derisk-open", "attribution"], "version 1's bytes never change");

    // --- the owner's specification: version 1 registered, version 2 published under it; D bound to version 2 at birth
    const cfgD = JSON.parse(readFileSync(cell.configPath, "utf8"));
    const specId: string = cfgD.identity.safety.specId;
    assert.equal(specId.toLowerCase(), specIdOf(cell.chainId, k.asf.specRegistryAddress, owner.address, keccakJcs({ spec: FOGA_CELL_SPEC_SALT_NAME, publisher: owner.address.toLowerCase() })).toLowerCase(), "the owner's one specification, by the fixed salt");
    assert.equal(cfgD.identity.safety.version, 2);
    assert.equal(cfgD.identity.safety.contentHash.toLowerCase(), v2.contentHash.toLowerCase());
    assert.equal((await k.asf.versionOf(specId, 1)).contentHash.toLowerCase(), v1.contentHash.toLowerCase());
    assert.equal((await k.asf.versionOf(specId, 2)).contentHash.toLowerCase(), v2.contentHash.toLowerCase());
    assert.equal(Number(await k.asf.specs().latestVersion(specId)), 2);
    const nodeD = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { owner: owner.privateKey }, log: () => {} });
    try {
      const req = await nodeD.body.contract().requirement();
      assert.deepEqual(Array.from(req.clauses[0].versions, (v: bigint) => Number(v)), [2], "the account's requirement names version 2");
      assert.equal(Number(req.clauses[0].enforcement), Enforcement.account | Enforcement.contract | Enforcement.runtime);
      const binding = await k.asf.bindingOf(cfgD.identity.bindingId);
      assert.equal(getAddress(binding.adopter), cell.account);
      const status = await nodeD.body.status();
      assert.equal(status.verdictName, "Satisfied");
      const st = await catalog.invoke(nodeD, "spec_status", {}, PUBLIC_CALLER);
      assert.equal(st.ok, true, JSON.stringify(st));
      const out = (st as { output: any }).output;
      assert.equal(out.operatesUnder, 2);
      assert.equal(out.account.version, 2);
      assert.equal(out.adopted, null);
      assert.equal(out.current.version, FOGA_CELL_SPEC_VERSION);
      assert.equal(out.verdict.verdict, "Satisfied");
      const refusedD = await catalog.invoke(nodeD, "spec_adopt", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(refusedD.ok, false);
      assert.match((refusedD as { reason: string }).reason, /bound to version 2 already/);
      // the twelve-covenant base set: the local world carries all of it
      const card = cellCard(nodeD, { version: "test" });
      assert.deepEqual(card.covenants.program, FOGA_COVENANTS);
      assert.equal(card.covenants.program.length, 13);
      assert.deepEqual(card.covenants.missing, []);
      assert.equal(card.specification.operatesUnder, 2);
      assert.match(formatCard(card), /spec {6}FOGA-Cell-v2\n/);
      const manifest = buildPropagationManifest(nodeD, { version: "test" });
      assert.deepEqual(manifest.world.extensions, []);
      assert.deepEqual(manifest.world.missing, []);
      assert.deepEqual(manifest.specification, { operatesUnder: 2, account: 2, adopted: null, program: 2 });
    } finally {
      nodeD.close();
    }

    // --- a cell born under version 1 (as every cell before 1.0.0 was): its configuration names version 1 of the owner's
    //     specification, so the birth binds it to version 1 and the account's requirement is fixed to [1]
    const configV = join(dir, "V.json");
    assert.equal(foga(RPC, ["cell", "new", "--name", "V", "--world", cell.worldPath, "--store", join(dir, "V.ops.sqlite"), "--owner", owner.address, "--operator", cell.keys.operator.address, "--guardian", cell.keys.guardian.address, "--out", configV]).code, 0);
    const cfgV = JSON.parse(readFileSync(configV, "utf8"));
    cfgV.identity.safety = { specId, version: 1, contentHash: v1.contentHash };
    cfgV.policy.budget = { dailyValueWei: parseEther("0.002").toString(), perOperationValueWei: parseEther("0.001").toString(), dailyGasWei: parseEther("0.05").toString(), maxConcurrentCommitments: 2 };
    cfgV.runtime.http.documentsDir = "documents-V";
    cfgV.flows.dir = "flows-V";
    cfgV.maintenance.dir = "meditation-V";
    writeFileSync(configV, JSON.stringify(cfgV, null, 2));
    const bornV = ok(foga(RPC, ["cell", "init", "--config", configV], { FOGA_OWNER_KEY: owner.privateKey }), "cell V init");
    const V = getAddress(bornV.account);
    const nodeV = await Node.open({ configPath: configV, rpc: RPC, keys: { owner: owner.privateKey, operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      const req = await nodeV.body.contract().requirement();
      assert.deepEqual(Array.from(req.clauses[0].versions, (v: bigint) => Number(v)), [1]);
      const before = await catalog.invoke(nodeV, "spec_status", {}, PUBLIC_CALLER);
      assert.equal((before as { output: any }).output.operatesUnder, 1);
      assert.match((before as { output: any }).output.meaning, /foga cell adopt/);
      const pre1 = await preflight(nodeV, { network: false, executors: false });
      const specRow = pre1.rows.find((r) => /operates under FOGA-Cell-v2/.test(r.check))!;
      assert.equal(specRow.verdict, "Warn", JSON.stringify(specRow));
      // the adoption: a second binding to version 2, enforcement runtime, adopter the account; nothing presented, the account's verdict unchanged
      const adopted = await catalog.invoke(nodeV, "spec_adopt", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(adopted.ok, true, JSON.stringify(adopted));
      const a = (adopted as { output: any }).output;
      assert.equal(a.version, 2);
      assert.equal(a.published, false, "version 2 exists under the owner's specification already (D's birth)");
      assert.deepEqual(a.enforcement, ["runtime"]);
      await k.blockNumber();
      const b2 = await k.asf.bindingOf(a.bindingId);
      assert.equal(getAddress(b2.adopter), V, "adopted through the account: the account is the adopter");
      assert.equal(b2.state, 1, "Active");
      const presented: string[] = Array.from(await nodeV.body.contract().presentedBindings(), (x: string) => String(x));
      assert.deepEqual(presented.map((x) => x.toLowerCase()), [String(JSON.parse(readFileSync(configV, "utf8")).identity.bindingId).toLowerCase()], "the account still presents its version-1 binding alone");
      assert.equal((await nodeV.body.status()).verdictName, "Satisfied", "nothing stopped");
      const cfgV2 = JSON.parse(readFileSync(configV, "utf8"));
      assert.equal(cfgV2.identity.adopted.version, 2);
      assert.equal(cfgV2.identity.adopted.bindingId.toLowerCase(), a.bindingId.toLowerCase());
      assert.equal(cfgV2.identity.safety.version, 1, "the account's binding is what it was");
      const after = await catalog.invoke(nodeV, "spec_status", {}, PUBLIC_CALLER);
      const o = (after as { output: any }).output;
      assert.equal(o.operatesUnder, 2);
      assert.equal(o.account.version, 1);
      assert.equal(o.adopted.version, 2);
      assert.equal(o.adopted.state, "Active");
      assert.match(o.meaning, /runtime-enforced binding/);
      const again = await catalog.invoke(nodeV, "spec_adopt", { jobId: "spec-adopt-V-again" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(again.ok, false);
      assert.match((again as { reason: string }).reason, /adopted already/);
      const pre2 = await preflight(nodeV, { network: false, executors: false });
      const specRow2 = pre2.rows.find((r) => /operates under FOGA-Cell-v2/.test(r.check))!;
      assert.equal(specRow2.verdict, "Pass", JSON.stringify(specRow2));
      assert.match(specRow2.detail, /adopted as a runtime-enforced binding/);
      const cardV = cellCard(nodeV, { version: "test" });
      assert.match(formatCard(cardV), /spec {6}FOGA-Cell-v2 \(the account enforces v1; v2 adopted by the runtime\)/);
      assert.deepEqual(buildPropagationManifest(nodeV, { version: "test" }).specification, { operatesUnder: 2, account: 1, adopted: 2, program: 2 });
    } finally {
      nodeV.close();
    }

    // --- a successor body (foga cell migrate) binds to version 2 and fixes it in its requirement; the adoption is not carried
    const configV2 = join(dir, "V-next.json");
    const moved = ok(foga(RPC, ["cell", "migrate", "--config", configV, "--to", configV2], { FOGA_OWNER_KEY: owner.privateKey }), "cell migrate");
    const next = JSON.parse(readFileSync(configV2, "utf8"));
    assert.equal(next.identity.safety.version, 2);
    assert.equal(next.identity.safety.contentHash.toLowerCase(), v2.contentHash.toLowerCase());
    assert.equal(next.identity.adopted, undefined);
    const nodeNext = await Node.open({ configPath: configV2, rpc: RPC, keys: {}, log: () => {} });
    try {
      const req = await nodeNext.body.contract().requirement();
      assert.deepEqual(Array.from(req.clauses[0].versions, (v: bigint) => Number(v)), [2]);
      assert.equal(getAddress(nodeNext.body.address), getAddress(moved.to));
      assert.equal((await nodeNext.body.status()).verdictName, "Satisfied");
      const st = await catalog.invoke(nodeNext, "spec_status", {}, PUBLIC_CALLER);
      assert.deepEqual([(st as { output: any }).output.operatesUnder, (st as { output: any }).output.adopted], [2, null]);
    } finally {
      nodeNext.close();
    }

    // --- a skill whose package the program moved on (foga-probe 1.x -> 2.0.0 in 1.0.0): the token D holds commits to the
    //     old package, so the held skill fails its check until skill_update commits the new one — version + 1, the old
    //     package as predecessor, the ERC-8444 record re-committed, the lineage kept in the configuration
    const skillsCopy = join(dir, "skills");
    cpSync(join("scenarios", "skills"), skillsCopy, { recursive: true });
    {
      const c = JSON.parse(readFileSync(cell.configPath, "utf8"));
      c.skills.dir = skillsCopy;
      writeFileSync(cell.configPath, JSON.stringify(c, null, 2));
    }
    const nodeS = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      const same = await catalog.invoke(nodeS, "skill_update", { skill: "foga-probe" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(same.ok, false);
      assert.match((same as { reason: string }).reason, /nothing to update/);
      // the program's package changes
      appendFileSync(join(skillsCopy, "foga-probe", "SKILL.md"), "\n## Changes in 2.1.0\n\nA line the next program added.\n");
      await assert.rejects(nodeS.heldSkills(), /differs from token .* skill update/);
      const before = await k.skills.skillOf(BigInt(cell.skills["foga-probe"].tokenId));
      const up = await catalog.invoke(nodeS, "skill_update", { skill: "foga-probe" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(up.ok, true, JSON.stringify(up));
      const u = (up as { output: any }).output;
      assert.equal(u.version, Number(before.version) + 1);
      assert.equal(u.previousPackageHash.toLowerCase(), before.packageHash.toLowerCase());
      assert.equal(u.operations.length, 2, "updateSkill and the record's descriptor");
      await k.blockNumber();
      const after = await k.skills.skillOf(BigInt(cell.skills["foga-probe"].tokenId));
      assert.equal(after.packageHash.toLowerCase(), u.packageHash.toLowerCase());
      assert.equal(Number(after.version), u.version);
      const cfgS = JSON.parse(readFileSync(cell.configPath, "utf8"));
      assert.equal(cfgS.skills.held["foga-probe"].version, u.version);
      assert.equal(cfgS.skills.held["foga-probe"].previousPackageHash.toLowerCase(), before.packageHash.toLowerCase());
      const held = await nodeS.heldSkills();
      assert.equal(held.find((h) => h.name === "foga-probe")!.packageHash.toLowerCase(), after.packageHash.toLowerCase(), "rebuilt from the directory with the token's lineage");
      const again = await catalog.invoke(nodeS, "skill_update", { skill: "foga-probe", jobId: "skill-update-again" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(again.ok, false);
      assert.match((again as { reason: string }).reason, /nothing to update/);
      const rec = await k.ard.recordOf(cfgS.skills.held["foga-probe"].recordId);
      assert.ok(rec, "the skill record stands, re-committed");
    } finally {
      nodeS.close();
    }
  } finally {
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

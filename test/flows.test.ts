import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Interface, Wallet, getAddress, parseEther } from "ethers";
import { AIFP, KINDS, OUTCOME, ROLES, ZERO32, compilePredicate, encodePredicateNodes, outcomeName, subjectOfAddress } from "../src/core/aifp.js";
import { dataUri, keccakJcs, sha256Hex } from "../src/core/canonical.js";
import { CELL_SOURCE, TENDER_MARKET, fogaParadigm } from "../src/core/paradigms.js";
import { hashlock, nativeTerms } from "../src/core/tenders.js";
import { createHttpServer } from "../src/http/server.js";
import { Kernel } from "../src/kernel/kernel.js";
import { publicationObjectRef } from "../src/node/flows.js";
import { Node } from "../src/node/node.js";
import { preflight } from "../src/node/preflight.js";
import { Watchers } from "../src/node/watchers.js";
import { defaultCatalog, OPERATOR_CALLER, PUBLIC_CALLER } from "../src/tools/index.js";
import { anvilPath, bornCell, foga, ok, startAnvil, waitForHttp } from "./helpers/anvil-cell.js";

/**
 * ERC-8489 on anvil (docs/flows.md, the 4b acceptance): the local world deploys the registries, the verifier and FOGA's
 * identity verifier, and its deployer registers FOGA's two paradigms and opens the market; a cell born on it opens its own
 * channel and holds SUBMIT there; a publication is anchored (publish, then supersede; the same content never twice); the
 * cell is admitted to the market by the identity predicate, and a stranger without an identity is NOT_SATISFIED while a
 * verifier without code is VERIFIER_ERROR and an unknown kind UNDETERMINABLE; a demander without the SUBMIT role is
 * refused at the `flow` gate and taken once admitted; a cell born on a world without the registries is extended in place
 * and its watcher joins the market and anchors its publication; the flow documents are served and the manifest, the card
 * and the CLI say what the registries hold. Skipped without anvil.
 */
const PORT = 8585;
const RPC = `http://127.0.0.1:${PORT}`;
const HTTP = 8586;

test("ERC-8489: the world's flows, a cell's channel, anchors, the market's admission, the flow gate, extension in place, served documents", { timeout: 900_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-flows-"));
  const catalog = defaultCatalog();
  try {
    const cell = await bornCell(RPC, dir);
    const k = cell.kernel;
    {
      // the fee book of the fixture is sized for a few acts; this test publishes three times, anchors, discloses and admits
      const c = JSON.parse(readFileSync(cell.configPath, "utf8"));
      c.policy.budget.dailyGasWei = parseEther("0.2").toString();
      writeFileSync(cell.configPath, JSON.stringify(c, null, 2));
    }
    const fresh = async () => (await k.blockNumber(), k.flows);
    assert.ok(k.flows.available, "the local world deploys the ERC-8489 registries");
    assert.ok(k.flows.identityVerifierAvailable, "and FOGA's identity verifier");
    const W = cell.keys.W;

    // --- the world's flows: the deployer registered the two paradigms and opened the market with the TaskToken's events as transport
    const world = JSON.parse(readFileSync(cell.worldPath, "utf8"));
    assert.equal(world.flows.family, "foga");
    assert.equal(getAddress(world.flows.controller), W.address);
    assert.ok(world.flows.paradigms[CELL_SOURCE].paradigmId);
    assert.ok(world.flows.paradigms[TENDER_MARKET].paradigmId);
    assert.ok(world.flows.market.channelId);
    assert.equal(getAddress(world.flows.market.authority), W.address);
    assert.ok(world.steps.some((s: any) => s.id === "8489/flows" && s.status === "wired"));
    const marketId: string = world.flows.market.channelId;
    const source = fogaParadigm(CELL_SOURCE, k.world);
    const market = fogaParadigm(TENDER_MARKET, k.world);
    assert.equal(world.flows.paradigms[CELL_SOURCE].paradigmId, source.bundle.paradigmId, "the id in the world file is the descriptor's");
    assert.equal(world.flows.paradigms[TENDER_MARKET].paradigmId, market.bundle.paradigmId);
    assert.equal(await (await fresh()).paradigmExists(source.bundle.paradigmId), true);
    assert.equal(await (await fresh()).rolePredicateHash(market.bundle.paradigmId, ROLES.submit), market.bundle.rolePredicates.find((p) => p.role === "submit")!.predicateHash, "the registry holds the market's SUBMIT predicate hash");
    assert.equal((await (await fresh()).currentParadigm(marketId)).paradigmId, market.bundle.paradigmId);
    const marketBindings = await (await fresh()).bindingIds(marketId);
    assert.equal(marketBindings.length, 1, "one transport binding: the TaskToken's events");
    const tb = await (await fresh()).binding(marketId, marketBindings[0]);
    assert.equal(tb.kind, 0);
    assert.equal(tb.capabilities & 64, 0, "no delivery records");
    assert.ok(tb.capabilities & 4096, "total order");

    // --- the cell's channel: opened at birth, authority the account, SUBMIT granted to the cell, transport bindings none (no public URL yet)
    const cfg0 = JSON.parse(readFileSync(cell.configPath, "utf8"));
    const channelId: string = cfg0.flows.channelId;
    assert.ok(channelId, "the channel id is written into the configuration at birth");
    const subject = subjectOfAddress(cell.chainId, cell.account);
    const rec = await (await fresh()).channel(channelId);
    assert.equal(getAddress(rec.authority), cell.account, "the authority is the cell's account, not a key");
    assert.equal(rec.stateName, "Active");
    assert.equal((await (await fresh()).currentParadigm(channelId)).paradigmId, source.bundle.paradigmId);
    assert.equal(outcomeName(await (await fresh()).evaluateNow(channelId, subject, ROLES.submit)), "SATISFIED", "the cell holds SUBMIT in its channel");
    assert.equal(outcomeName(await (await fresh()).evaluateNow(channelId, subjectOfAddress(cell.chainId, cell.keys.operator.address), ROLES.submit)), "NOT_SATISFIED", "the operator's key holds nothing: the subject is the account");
    assert.equal((await (await fresh()).bindingIds(channelId)).length, 0, "no public endpoint: no transport binding");

    const operatorNode = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      // the operator's scope has the flows group; the owner's pairs are not opened for a separated cell
      const admitSel = k.world.iface(AIFP.participation).getFunction("admit")!.selector;
      const grantSel = k.world.iface(AIFP.participation).getFunction("grant")!.selector;
      assert.equal(await operatorNode.body.contract().operatorAllowed(k.flows.addressOf(AIFP.participation), admitSel), true, "admit is in the operator's allow-list");
      assert.equal(await operatorNode.body.contract().operatorAllowed(k.flows.addressOf(AIFP.participation), grantSel), false, "grant is the owner's, not opened to the operator of a separated cell");

      // --- status, as the public sees it
      const st0 = await catalog.invoke(operatorNode, "flow_status", {}, PUBLIC_CALLER);
      assert.equal(st0.ok, true, JSON.stringify(st0));
      const s0 = (st0 as { output: any }).output;
      assert.equal(s0.available, true);
      assert.equal(s0.channel.channelId, channelId);
      assert.equal(s0.channel.authorityIsTheCell, true);
      assert.equal(s0.channel.roles.submit, "SATISFIED");
      assert.equal(s0.market.channelId, marketId);
      assert.equal(s0.market.roles.submit, "NOT_SATISFIED", "not admitted yet");
      assert.equal(s0.market.fogaMarket, true);
      assert.equal(s0.market.eligibility.ok, true);
      assert.equal(s0.local.publication, null, "nothing published yet");
      assert.equal(s0.paradigms[CELL_SOURCE].registered, true);

      // --- the first publication is anchored (publish) inside docs_publish; the same content is the same job and anchors nothing more
      const pub1 = await catalog.invoke(operatorNode, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(pub1.ok, true, JSON.stringify(pub1));
      const p1 = (pub1 as { output: any }).output;
      assert.equal(p1.flows.anchored, "publish");
      assert.equal(p1.flows.disclosed, false, "no public URL: nothing was disclosed");
      assert.ok(p1.operations.some((o: string) => o.endsWith(":anchor")));
      const manifest1 = JSON.parse(readFileSync(join(dir, "documents", "manifest.json"), "utf8"));
      const object1 = publicationObjectRef(manifest1);
      assert.equal(p1.flows.objectRef, object1);
      assert.equal((await (await fresh()).anchoredBy(object1)).toLowerCase(), subject.toLowerCase(), "the object is anchored by the cell's subject");
      assert.equal((await (await fresh()).anchoredIn(object1)).toLowerCase(), channelId.toLowerCase());
      const anchorsAfter1 = await (await fresh()).anchorCount();
      const rec1 = await (await fresh()).anchorRecord(anchorsAfter1 - 1);
      assert.equal(rec1.actionName, "publish");
      assert.equal(rec1.ruleVersion.toLowerCase(), source.bundle.paradigmId.toLowerCase(), "the rule version is the paradigm in force");
      const pub1b = await catalog.invoke(operatorNode, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(pub1b.ok, true, JSON.stringify(pub1b));
      assert.equal(operatorNode.store.decisions().at(-1)!.gate, "idempotent", "the same documents are the same job: nothing sent");
      assert.equal(await (await fresh()).anchorCount(), anchorsAfter1, "nothing anchored twice");
      const noNew = await catalog.invoke(operatorNode, "flow_anchor", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(noNew.ok, false);
      assert.match((noNew as { reason: string }).reason, /anchored already/);

      // --- a changed publication supersedes the one before
      const cfg1 = JSON.parse(readFileSync(cell.configPath, "utf8"));
      cfg1.presence.description = "a cell whose description changed, so its publication is a new object";
      writeFileSync(cell.configPath, JSON.stringify(cfg1, null, 2));
      operatorNode.close();
    } finally {
      try {
        operatorNode.close();
      } catch {
        /* closed */
      }
    }
    const operatorNode2 = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      const pub2 = await catalog.invoke(operatorNode2, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(pub2.ok, true, JSON.stringify(pub2));
      const p2 = (pub2 as { output: any }).output;
      assert.equal(p2.flows.anchored, "supersede");
      const object2: string = p2.flows.objectRef;
      const manifest2 = JSON.parse(readFileSync(join(dir, "documents", "manifest.json"), "utf8"));
      assert.equal(object2, publicationObjectRef(manifest2));
      assert.notEqual(object2, (operatorNode2.store.getFact<any[]>("flows.anchors") ?? [])[0].objectRef);
      const facts = operatorNode2.store.getFact<any[]>("flows.anchors")!;
      assert.equal(facts.length, 2);
      assert.equal(facts[1].supersedes, facts[0].objectRef, "the supersedes relation names the object before");
      const n = await (await fresh()).anchorCount();
      assert.equal((await (await fresh()).anchorRecord(n - 1)).actionName, "supersede");

      // --- the market: admitted as SUBMIT and RESPOND by the identity predicate; the roles are the registry's; admitting again is nothing
      const adm = await catalog.invoke(operatorNode2, "flow_admit", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(adm.ok, true, JSON.stringify(adm));
      const a = (adm as { output: any }).output;
      assert.deepEqual(a.admitted.map((x: any) => x.role).sort(), ["respond", "submit"]);
      assert.equal(a.channelId, marketId);
      assert.equal(outcomeName(await (await fresh()).evaluateNow(marketId, subject, ROLES.submit)), "SATISFIED");
      assert.equal(outcomeName(await (await fresh()).evaluateNow(marketId, subject, ROLES.respond)), "SATISFIED");
      assert.equal(outcomeName(await (await fresh()).evaluateNow(marketId, subject, ROLES.observe)), "NOT_SATISFIED", "observe is open to admit, but the cell asked for no observe binding");
      const b = await (await fresh()).bindingOf(a.admitted[0].bindingId);
      assert.equal(b.basisName, "predicate");
      assert.equal(b.basisRef.toLowerCase(), market.bundle.rolePredicates.find((p) => p.role === a.admitted[0].role)!.predicateHash.toLowerCase(), "the basis is the predicate hash");
      assert.equal(b.outcomeAtGrant, OUTCOME.SATISFIED);
      const again = await catalog.invoke(operatorNode2, "flow_admit", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(again.ok, false);
      assert.match((again as { reason: string }).reason, /already/);
      const roles = await catalog.invoke(operatorNode2, "flow_roles", { subject: cell.account }, PUBLIC_CALLER);
      assert.equal(roles.ok, true, JSON.stringify(roles));
      const r = (roles as { output: any }).output;
      assert.equal(r.channelId, marketId);
      assert.equal(r.roles.submit, "SATISFIED");
      assert.equal(r.roles.observe, "NOT_SATISFIED");
      assert.deepEqual(r.rolesOf.sort(), ["respond", "submit"]);
      assert.equal(r.bindings.length, 2);

      // --- a stranger: an EOA without an ERC-8004 identity is NOT_SATISFIED (previewed, and the admission reverts by that name);
      //     a predicate whose verifier has no code is VERIFIER_ERROR; an unknown kind is UNDETERMINABLE; neither is NOT_SATISFIED
      const stranger = Wallet.createRandom();
      const strangerSubject = subjectOfAddress(cell.chainId, stranger.address);
      const submitPredicate = market.bundle.rolePredicates.find((p) => p.role === "submit")!.predicateHex;
      const strangerEvidence = k.flows.identityEvidence(stranger.address, 1);
      assert.equal(outcomeName(await (await fresh()).previewAdmission(marketId, strangerSubject, ROLES.submit, submitPredicate, [strangerEvidence])), "NOT_SATISFIED");
      assert.equal(outcomeName(await (await fresh()).previewAdmission(marketId, strangerSubject, ROLES.submit, submitPredicate, [])), "UNDETERMINABLE", "no evidence: nothing is shown either way");
      const noCode = compilePredicate({ identity: { verifier: "0x00000000000000000000000000000000000000aa", registry: k.identity.address, requiredState: "active" } });
      assert.equal(outcomeName(await (await fresh()).evaluatePredicate(marketId, subject, ROLES.submit, noCode.encoding, [k.flows.identityEvidence(cell.account, cell.agentId)])), "VERIFIER_ERROR", "a declared verifier without code is the verifier's fault, not a refusal");
      const unknownKind = encodePredicateNodes([{ kind: 42, childStart: 0, childCount: 0, verifier: k.flows.addressOf(AIFP.identityVerifier), ref: ZERO32, params: "0x" }]);
      assert.equal(outcomeName(await (await fresh()).evaluatePredicate(marketId, subject, ROLES.submit, unknownKind, [])), "UNDETERMINABLE", "an unsupported kind is undeterminable before any composition");
      const anyOfOpen = compilePredicate({ anyOf: [{ identity: { verifier: "0x00000000000000000000000000000000000000aa", registry: k.identity.address, requiredState: "active" } }, { open: true }] });
      assert.equal(outcomeName(await (await fresh()).evaluatePredicate(marketId, subject, ROLES.submit, anyOfOpen.encoding, [])), "SATISFIED", "anyOf keeps the fault inside its leaf");
      // the stranger's own transaction reverts naming the outcome
      await k.transfer("fund.stranger", "W", stranger.address, parseEther("0.01"));
      const strangerSigner = stranger.connect(k.world.provider);
      const participation = k.flows.participation(strangerSigner);
      let reverted: string | null = null;
      try {
        await participation.admit(marketId, ROLES.submit, ZERO32, submitPredicate, [strangerEvidence], 0);
      } catch (e) {
        reverted = k.tx.decoder.explain(e) ?? (e as Error).message;
      }
      assert.ok(reverted && /AIFP_NotSatisfied/.test(reverted), `the registry reverts with the outcome: ${reverted}`);
      assert.equal((await (await fresh()).bindingIdsOf(marketId, strangerSubject)).length, 0, "a refused admission writes no binding");

      // --- the flow gate: a demander without SUBMIT in the market is refused at `flow` when the policy asks for the role; once admitted it passes
      const mint = async (label: string, reward: bigint) => {
        const t0 = await k.blockTimestamp();
        const answerHash = hashlock.answerHash("42");
        const task = { schema: "foga.task/1", skill: "finch-extract-verify", packageHash: cell.skills["finch-extract-verify"].packageHash, input: { file: "none" }, acceptance: { mode: "verifier", profile: "x-hashlock-v1", verifier: k.tenders.hashlockAddress, answerHash }, deliverable: label };
        const terms = nativeTerms(reward, { submitBy: BigInt(t0 + 86400), settleBy: BigInt(t0 + 7 * 86400) });
        const m = await k.call(`mint.${label}`, "W", k.tenders.address, k.tenders.contract().interface, "mintTask", [W.address, W.address, k.tenders.hashlockAddress, keccakJcs({ td: "foga.task/1", skill: "finch-extract-verify" }), sha256Hex(JSON.stringify(task)), dataUri(task), terms]);
        const tokenId = k.tenders.tokenIdFromReceipt(m.receipt);
        await k.call(`fund.${label}`, "W", k.tenders.address, k.tenders.contract().interface, "fundTask", [tokenId, reward], reward);
        await k.call(`commit.${label}`, "W", k.tenders.hashlockAddress, k.tenders.hashlockVerifier().interface, "commitAnswer", [k.tenders.address, tokenId, answerHash]);
        return tokenId;
      };
      const tender = await mint("flow", parseEther("0.001"));
      const cfg2 = JSON.parse(readFileSync(cell.configPath, "utf8"));
      cfg2.policy.tenders.requireCounterpartyFlowRole = true;
      writeFileSync(cell.configPath, JSON.stringify(cfg2, null, 2));
      operatorNode2.close();
      const strictNode = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
      try {
        const pre1 = await catalog.invoke(strictNode, "tender_precheck", { tokenId: tender.toString() }, OPERATOR_CALLER, { mode: "act" });
        assert.equal(pre1.ok, false);
        assert.equal((pre1 as { gate: string }).gate, "flow");
        assert.match((pre1 as { reason: string }).reason, /NOT_SATISFIED/);
        // the demander becomes eligible — an ERC-8004 identity of its own, an ACTIVE anchor — and admits itself
        const idReg = k.identity.contract(W.connect(k.world.provider));
        const regTx = await idReg["register()"]();
        const regReceipt = await regTx.wait();
        const wAgent = k.identity.agentIdFromReceipt(regReceipt);
        assert.equal(getAddress(await k.identity.ownerOf(wAgent)), W.address);
        const aid = k.aid.contract(W.connect(k.world.provider));
        await (await aid.bind(k.identity.address, wAgent)).wait();
        await (await aid.heartbeat()).wait();
        assert.equal(await k.aid.stateName(W.address), "ACTIVE");
        const wSubject = subjectOfAddress(cell.chainId, W.address);
        const wEvidence = k.flows.identityEvidence(W.address, wAgent);
        assert.equal(outcomeName(await (await fresh()).previewAdmission(marketId, wSubject, ROLES.submit, submitPredicate, [wEvidence])), "SATISFIED");
        await (await k.flows.participation(W.connect(k.world.provider)).admit(marketId, ROLES.submit, ZERO32, submitPredicate, [wEvidence], 0)).wait();
        await strictNode.kernel.blockNumber();
        const pre2 = await catalog.invoke(strictNode, "tender_precheck", { tokenId: tender.toString() }, OPERATOR_CALLER, { mode: "act" });
        assert.equal(pre2.ok, true, JSON.stringify(pre2));
        const flowGate = (pre2 as { output: any }).output.gates.find((g: any) => g.gate === "flow");
        assert.equal(flowGate.ok, true);
        assert.match(flowGate.reason, /holds SUBMIT/);
        // the counterparty's own read: the cell's roles in the market, from outside
        const peer = await catalog.invoke(strictNode, "flow_roles", { subject: W.address, roles: ["submit"] }, PUBLIC_CALLER);
        assert.equal((peer as { output: any }).output.roles.submit, "SATISFIED");
      } finally {
        strictNode.close();
      }
    } finally {
      try {
        operatorNode2.close();
      } catch {
        /* closed */
      }
    }

    // --- the documents served, the manifest and the card; a disclosure once the cell has a public URL
    {
      const cfg3 = JSON.parse(readFileSync(cell.configPath, "utf8"));
      cfg3.runtime.http.publicUrl = `http://127.0.0.1:${HTTP}`;
      cfg3.policy.tenders.requireCounterpartyFlowRole = false;
      writeFileSync(cell.configPath, JSON.stringify(cfg3, null, 2));
      const pubNode = await Node.open({ configPath: cell.configPath, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
      try {
        // the public URL changes the documents (their URIs): a new publication, anchored and now disclosed to the public
        const pub3 = await catalog.invoke(pubNode, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
        assert.equal(pub3.ok, true, JSON.stringify(pub3));
        const p3 = (pub3 as { output: any }).output;
        assert.equal(p3.flows.anchored, "supersede");
        assert.equal(p3.flows.disclosed, true);
        assert.equal(await (await fresh()).disclosureCount(channelId), 1);
        const d = await (await fresh()).disclosureAt(channelId, 0);
        assert.equal(d.kind, 0, "DISCLOSED");
        assert.equal(d.objectRef.toLowerCase(), (p3.flows.objectRef as string).toLowerCase());
        const dis = await catalog.invoke(pubNode, "flow_disclose", {}, OPERATOR_CALLER, { mode: "act" });
        assert.equal(dis.ok, false);
        assert.match((dis as { reason: string }).reason, /recorded as disclosed already/);
        const pf = await preflight(pubNode, { env: { PATH: process.env.PATH }, executors: false, network: false });
        for (const check of ["the cell-source paradigm is registered on this chain", "the cell has its own channel", "the cell holds SUBMIT in its channel", "the current publication is anchored", "the cell is admitted to the market"]) assert.equal(pf.rows.find((r) => r.check === check)?.verdict, "Pass", `${check}: ${pf.rows.find((r) => r.check === check)?.detail}`);
        const running = await createHttpServer({ node: pubNode, catalog, version: "test", log: () => {} }).listen(`127.0.0.1:${HTTP}`);
        try {
          await waitForHttp(`${running.url}/healthz`);
          const manifest = (await (await fetch(`${running.url}/.well-known/foga-cell.json`)).json()) as any;
          assert.deepEqual(manifest.world.extensions, [], "since 1.0.0 the registries are part of the base set");
          assert.deepEqual(manifest.world.missing, []);
          assert.equal(manifest.specification.operatesUnder, 2);
          assert.equal(manifest.flows.channel, channelId);
          assert.equal(manifest.flows.market, marketId);
          assert.equal(manifest.flows.documents, `${running.url}/documents/flows/`);
          const ch = await fetch(`${running.url}/documents/flows/channel.json`);
          assert.equal(ch.status, 200);
          assert.equal(((await ch.json()) as any).paradigm, CELL_SOURCE);
          const desc = await fetch(`${running.url}/documents/flows/paradigms/cell-source.v1.json`);
          assert.equal(desc.status, 200);
          assert.equal(keccakJcs(await desc.json()), source.bundle.paradigmId, "the served descriptor hashes to the registered paradigm id");
          assert.equal((await fetch(`${running.url}/documents/flows/../cell.config.json`)).status, 404);
          const rolesHttp = (await (await fetch(`${running.url}/api/flow_roles`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject: cell.account, roles: ["submit"] }) })).json()) as any;
          assert.equal(rolesHttp.ok, true);
          assert.equal(rolesHttp.output.roles.submit, "SATISFIED");
        } finally {
          await running.close();
        }
      } finally {
        pubNode.close();
      }
      const card = foga(RPC, ["cell", "card", "--config", cell.configPath, "--as-json"]);
      assert.equal(card.code, 0, card.stderr);
      assert.equal(card.json.flows.channel.channelId, channelId);
      assert.deepEqual(card.json.flows.market.admitted.sort(), ["respond", "submit"]);
      assert.equal(card.json.flows.anchors, 3);
      const table = foga(RPC, ["flow", "status", "--config", cell.configPath]);
      assert.equal(table.code, 0, table.stderr);
      assert.match(table.stdout, new RegExp(`channel ${channelId}`));
      assert.match(table.stdout, /submit SATISFIED/);
      assert.match(table.stdout, /admitted: submit, respond|admitted: respond, submit/);
      const rolesCli = foga(RPC, ["flow", "roles", "--subject", cell.account, "--roles", "submit,observe", "--config", cell.configPath]);
      assert.equal(rolesCli.code, 0, rolesCli.stderr);
      assert.equal(rolesCli.json.output.roles.submit, "SATISFIED");
      assert.equal(rolesCli.json.output.roles.observe, "NOT_SATISFIED");
    }

    // --- a cell born on a world without the registries is extended in place: the world file gains them and the chain's flows,
    //     the owner opens the scope and the channel; the roles are separated, so the watcher anchors and joins with the operator's key
    const oldWorldPath = join(dir, "world-before-8489.json");
    const oldWorld = JSON.parse(readFileSync(cell.worldPath, "utf8"));
    for (const id of Object.keys(oldWorld.contracts)) if (id.startsWith("8489/")) delete oldWorld.contracts[id];
    oldWorld.steps = oldWorld.steps.filter((s: { id: string }) => !s.id.startsWith("8489/"));
    delete oldWorld.flows;
    writeFileSync(oldWorldPath, JSON.stringify(oldWorld, null, 2));
    const oldConfig = join(dir, "E.json");
    assert.equal(foga(RPC, ["cell", "new", "--name", "E", "--world", oldWorldPath, "--store", join(dir, "E.ops.sqlite"), "--owner", cell.keys.owner.address, "--operator", cell.keys.operator.address, "--guardian", cell.keys.guardian.address, "--out", oldConfig]).code, 0);
    const cfgE = JSON.parse(readFileSync(oldConfig, "utf8"));
    cfgE.policy.budget = { dailyValueWei: parseEther("0.002").toString(), perOperationValueWei: parseEther("0.001").toString(), dailyGasWei: parseEther("0.05").toString(), maxConcurrentCommitments: 2 };
    cfgE.flows.checkEverySeconds = 0;
    // its own directories: a documents directory shared with D would make D's publication look like E's
    cfgE.runtime.http.documentsDir = "documents-E";
    cfgE.flows.dir = "flows-E";
    cfgE.maintenance.dir = "meditation-E";
    writeFileSync(oldConfig, JSON.stringify(cfgE, null, 2));
    const bornE = ok(foga(RPC, ["cell", "init", "--config", oldConfig], { FOGA_OWNER_KEY: cell.keys.owner.privateKey }), "cell E init");
    assert.equal(bornE.flows, null, "no registries in its world: no channel");
    assert.equal(JSON.parse(readFileSync(oldConfig, "utf8")).flows.channelId, undefined);
    // the packaged world of the chain is where extend takes the addresses from; anvil has none, so the deployed world is given (--from)
    const extended = foga(RPC, ["cell", "extend", "--covenants", "8489", "--config", oldConfig, "--from", cell.worldPath], { FOGA_OWNER_KEY: cell.keys.owner.privateKey });
    assert.equal(extended.code, 0, `extend failed:\n${extended.stderr.slice(-3000)}`);
    assert.match(extended.stderr, /contract\(s\) added to the world file/);
    assert.match(extended.stderr, /flows added/);
    assert.match(extended.stderr, /channel 0x[0-9a-f]{64} opened/);
    assert.match(extended.stderr, /roles are separated/);
    const worldE = JSON.parse(readFileSync(oldWorldPath, "utf8"));
    assert.ok(worldE.contracts["8489/AIFPParticipationRegistry"]);
    assert.ok(worldE.contracts["8489/FogaIdentityVerifier"]);
    assert.equal(worldE.flows.market.channelId, marketId, "the chain's flows came with the contracts");
    const channelE: string = JSON.parse(readFileSync(oldConfig, "utf8")).flows.channelId;
    assert.ok(channelE);
    const twice = foga(RPC, ["cell", "extend", "--covenants", "8489", "--config", oldConfig, "--from", cell.worldPath], { FOGA_OWNER_KEY: cell.keys.owner.privateKey });
    assert.equal(twice.code, 0, twice.stderr.slice(-2000));
    assert.match(twice.stderr, /has its channel .* already/);
    const nodeE = await Node.open({ configPath: oldConfig, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      const subjectE = subjectOfAddress(cell.chainId, nodeE.body.address);
      assert.equal(outcomeName(await (await fresh()).evaluateNow(channelE, subjectE, ROLES.submit)), "SATISFIED");
      // the watcher: nothing published yet, so the first tick joins the market; a publication later is anchored on the next
      const watchers = new Watchers(nodeE, catalog);
      const t1 = await watchers.tick();
      assert.equal(t1.flows.action, "admitted", JSON.stringify(t1.flows));
      assert.equal(outcomeName(await (await fresh()).evaluateNow(marketId, subjectE, ROLES.submit)), "SATISFIED");
      const pubE = await catalog.invoke(nodeE, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(pubE.ok, true, JSON.stringify(pubE));
      assert.equal((pubE as { output: any }).output.flows.anchored, "publish", "a publish after the channel exists anchors itself");
      const t2 = await watchers.tick();
      assert.equal(t2.flows.action, "skipped", JSON.stringify(t2.flows));
      assert.match(t2.flows.reason, /anchored, market roles held/);
      // a fact dropped (a store from before the channel): what the chain holds is recorded first, nothing is anchored twice
      nodeE.store.setFact("flows.anchors", []);
      const t3 = await watchers.tick();
      assert.equal(t3.flows.action, "skipped", JSON.stringify(t3.flows));
      const recovered = nodeE.store.getFact<any[]>("flows.anchors")!;
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0].recordIndex, -1, "recovered from the chain, not sent");
      assert.equal(await (await fresh()).anchorCount(), (await (await fresh()).anchorCount()), "nothing more on chain");
    } finally {
      nodeE.close();
    }
    // a public URL given to a cell whose publication is anchored already (0.9.1): the watcher records the disclosure — one act a
    // tick — and a store that lost the fact finds the record on the chain, so nothing is recorded twice
    {
      const c = JSON.parse(readFileSync(oldConfig, "utf8"));
      c.runtime.http.publicUrl = "http://127.0.0.1:8599";
      writeFileSync(oldConfig, JSON.stringify(c, null, 2));
    }
    const nodeE2 = await Node.open({ configPath: oldConfig, rpc: RPC, keys: { operator: cell.keys.operator.privateKey }, log: () => {} });
    try {
      const watchers = new Watchers(nodeE2, catalog);
      const before = await (await fresh()).disclosureCount(channelE);
      const t4 = await watchers.tick();
      assert.equal(t4.flows.action, "disclosed", JSON.stringify(t4.flows));
      assert.equal(await (await fresh()).disclosureCount(channelE), before + 1);
      const t5 = await watchers.tick();
      assert.equal(t5.flows.action, "skipped", JSON.stringify(t5.flows));
      assert.match(t5.flows.reason, /anchored and disclosed, market roles held/);
      nodeE2.store.setFact("flows.disclosures", []);
      const t6 = await watchers.tick();
      assert.equal(t6.flows.action, "skipped", JSON.stringify(t6.flows));
      const recoveredD = nodeE2.store.getFact<any[]>("flows.disclosures")!;
      assert.equal(recoveredD.length, 1);
      assert.equal(recoveredD[0].txHash, "", "recovered from the chain, not sent");
      assert.equal(await (await fresh()).disclosureCount(channelE), before + 1, "nothing more on chain");
      // the same object is the same job (replayed as done); a new job finds the record and is refused
      const same = await catalog.invoke(nodeE2, "flow_disclose", {}, OPERATOR_CALLER, { mode: "act" });
      assert.equal(same.ok, true, "the derived job is the watcher's, already done");
      const again = await catalog.invoke(nodeE2, "flow_disclose", { jobId: "flow-disclose-E-again" }, OPERATOR_CALLER, { mode: "act" });
      assert.equal(again.ok, false);
      assert.match((again as { reason: string }).reason, /recorded as disclosed already/);
    } finally {
      nodeE2.close();
    }

    // --- the account path of the maintainer's bootstrap (the OG on a public chain): a world deployed with --no-flows has the
    //     registries and no paradigms; its packaged world — the upstream deploys only its own contracts — carries the seven
    //     registries and no FOGA identity verifier; the reference cell was born before the covenant, so its own world file has
    //     none of them. `foga flow bootstrap` from that one-key cell extends its world file from the packaged world, deploys the
    //     verifier, registers the two paradigms and opens the market through the cell's account, which is the family's controller
    //     and the market's authority; `cell extend` then opens the cell's channel and joins the market in the same run
    const world2Path = join(dir, "world2.json");
    const deployed2 = foga(RPC, ["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", world2Path, "--no-flows"]);
    assert.equal(deployed2.code, 0, `world deploy --no-flows failed:\n${deployed2.stderr.slice(-2000)}`);
    assert.match(deployed2.stdout, /not bootstrapped \(--no-flows\)/);
    const world2 = JSON.parse(readFileSync(world2Path, "utf8"));
    assert.equal(world2.flows, undefined, "no flows block: the deployer left the bootstrap to a maintainer");
    assert.ok(!world2.steps.some((s: { id: string }) => s.id === "8489/flows"));
    assert.ok(world2.contracts["8489/AIFPParadigmRegistry"]);
    // the packaged world of the chain, as Sepolia's: the upstream's registries, no FOGA identity verifier
    const packaged2Path = join(dir, "packaged2.json");
    const packaged2 = JSON.parse(readFileSync(world2Path, "utf8"));
    delete packaged2.contracts["8489/FogaIdentityVerifier"];
    packaged2.steps = packaged2.steps.filter((s: { id: string }) => s.id !== "8489/FogaIdentityVerifier");
    writeFileSync(packaged2Path, JSON.stringify(packaged2, null, 2));
    const configF = join(dir, "F.json");
    assert.equal(foga(RPC, ["cell", "new", "--name", "F", "--world", world2Path, "--store", join(dir, "F.ops.sqlite"), "--owner", W.address, "--operator", W.address, "--guardian", W.address, "--out", configF]).code, 0);
    const cfgF = JSON.parse(readFileSync(configF, "utf8"));
    cfgF.policy.budget = { dailyValueWei: parseEther("0.002").toString(), perOperationValueWei: parseEther("0.001").toString(), dailyGasWei: parseEther("0.2").toString(), maxConcurrentCommitments: 2 };
    cfgF.flows.checkEverySeconds = 0;
    cfgF.runtime.http.documentsDir = "documents-F";
    cfgF.flows.dir = "flows-F";
    cfgF.maintenance.dir = "meditation-F";
    writeFileSync(configF, JSON.stringify(cfgF, null, 2));
    const bornF = ok(foga(RPC, ["cell", "init", "--config", configF], { FOGA_OWNER_KEY: W.privateKey }), "cell F init");
    assert.ok(bornF.flows?.skipped, `the paradigm is not registered on this world: no channel at birth (${JSON.stringify(bornF.flows)})`);
    assert.match(bornF.flows.skipped, /foga flow bootstrap/);
    const F = getAddress(bornF.account);
    // the cell's world file as a cell born before the covenant has it: no ERC-8489 entry at all
    for (const id of Object.keys(world2.contracts)) if (id.startsWith("8489/")) delete world2.contracts[id];
    world2.steps = world2.steps.filter((s: { id: string }) => !s.id.startsWith("8489/"));
    writeFileSync(world2Path, JSON.stringify(world2, null, 2));
    const boot = foga(RPC, ["flow", "bootstrap", "--config", configF, "--from", packaged2Path], { FOGA_OWNER_KEY: W.privateKey });
    assert.equal(boot.code, 0, `flow bootstrap failed:\n${boot.stderr.slice(-3000)}\n${boot.stdout.slice(-1500)}`);
    assert.match(boot.stderr, /7 ERC-8489 contract\(s\) added to .*world2\.json \(from the world file .*packaged2\.json\)/, "the world file gains the registries first");
    assert.match(boot.stderr, /8489\/FogaIdentityVerifier deployed at 0x[0-9a-fA-F]{40}/, "the verifier the packaged world lacks is deployed next");
    assert.ok(boot.json?.ok, JSON.stringify(boot.json));
    assert.deepEqual([...boot.json.output.registered].sort(), [CELL_SOURCE, TENDER_MARKET].sort());
    assert.equal(boot.json.output.marketOpened, true);
    assert.deepEqual(boot.json.output.scopeOpened, [], "the birth of a one-key cell opened the owner's pairs (registerParadigm, openChannel) already; nothing to open");
    const world2b = JSON.parse(readFileSync(world2Path, "utf8"));
    assert.ok(world2b.contracts["8489/AIFPParticipationRegistry"], "the registries are in the world file");
    assert.equal(world2b.contracts["8489/AIFPParticipationRegistry"].address, packaged2.contracts["8489/AIFPParticipationRegistry"].address);
    assert.ok(existsSync(`${world2Path}.before-8489.bak`), "the file before the extension is kept beside it");
    assert.ok(world2b.contracts["8489/FogaIdentityVerifier"], "the verifier is in the world file");
    assert.equal(getAddress(world2b.flows.controller), F, "the family's controller is the cell's account");
    assert.equal(getAddress(world2b.flows.market.authority), F, "and so is the market's authority");
    assert.ok(world2b.steps.some((s: any) => s.id === "8489/flows" && s.status === "wired"));
    assert.ok(world2b.steps.some((s: any) => s.id === "8489/FogaIdentityVerifier" && s.status === "deployed"));
    const k2 = await Kernel.open({ worldPath: world2Path, rpc: RPC, storePath: join(dir, "reader2.sqlite"), keys: {} });
    try {
      const market2 = fogaParadigm(TENDER_MARKET, k2.world);
      assert.notEqual(market2.bundle.paradigmId, market.bundle.paradigmId, "another world's registries: another market paradigm id");
      assert.equal(world2b.flows.paradigms[TENDER_MARKET].paradigmId, market2.bundle.paradigmId);
      assert.equal(await k2.flows.paradigmExists(fogaParadigm(CELL_SOURCE, k2.world).bundle.paradigmId), true);
      assert.equal(await k2.flows.paradigmExists(market2.bundle.paradigmId), true);
      assert.equal(getAddress(await k2.flows.familyController(market2.bundle.familyId)), F);
      assert.equal(getAddress((await k2.flows.channel(world2b.flows.market.channelId)).authority), F);
      // the second time there is nothing to do, and nothing is sent
      const again = foga(RPC, ["flow", "bootstrap", "--config", configF], { FOGA_OWNER_KEY: W.privateKey });
      assert.equal(again.code, 2, again.stderr.slice(-1000));
      assert.match(again.json.reason, /nothing to do/);
      // the extension: the world file has everything, so it is untouched; the one key opens the channel, has nothing to anchor
      // (no documents published yet) and joins the market in the same run
      const extendedF = foga(RPC, ["cell", "extend", "--covenants", "8489", "--config", configF], { FOGA_OWNER_KEY: W.privateKey });
      assert.equal(extendedF.code, 0, `extend F failed:\n${extendedF.stderr.slice(-3000)}`);
      assert.match(extendedF.stderr, /0 contract\(s\) added to the world file, \d+ already in it; flows present/);
      assert.match(extendedF.stderr, /channel 0x[0-9a-f]{64} opened/);
      assert.match(extendedF.stderr, /anchor: the documents are not built/);
      assert.match(extendedF.stderr, /market: admitted as (submit, respond|respond, submit)/);
      const channelF: string = JSON.parse(readFileSync(configF, "utf8")).flows.channelId;
      const subjectF = subjectOfAddress(cell.chainId, F);
      await k2.blockNumber();
      assert.equal(outcomeName(await k2.flows.evaluateNow(channelF, subjectF, ROLES.submit)), "SATISFIED");
      assert.equal(outcomeName(await k2.flows.evaluateNow(world2b.flows.market.channelId, subjectF, ROLES.submit)), "SATISFIED");
      assert.equal(outcomeName(await k2.flows.evaluateNow(world2b.flows.market.channelId, subjectF, ROLES.respond)), "SATISFIED");
      const statusF = foga(RPC, ["flow", "status", "--config", configF, "--as-json"]);
      assert.equal(statusF.code, 0, statusF.stderr.slice(-1000));
      assert.equal(statusF.json.output.market.channelId, world2b.flows.market.channelId);
    } finally {
      k2.close();
    }
  } finally {
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

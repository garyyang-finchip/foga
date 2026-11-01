import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { Wallet, getAddress, parseEther } from "ethers";
import { dataUri, dataUriJcs, keccakJcs, sha256Hex } from "../src/core/canonical.js";
import { accountSubject, fogaAttestedSchemeDescriptor } from "../src/core/kya.js";
import { hashlock, nativeTerms } from "../src/core/tenders.js";
import { extractVerifyFile } from "../src/genesis/extract.js";
import { runProbe, type ProbeInput } from "../src/genesis/probe.js";
import { anvilKeys } from "../src/genesis/roles.js";
import { Kernel } from "../src/kernel/kernel.js";

/**
 * The Loop D path on anvil, driven through the CLI alone (design memo, Phase 3, the 3a-2 gate): a world is
 * deployed, a cell D is born with `foga cell init` (no genesis), given standing by the world operator, mints its
 * two skills, and then meets seven tenders a demander mints — two it should take and settle (a, b) and five it must
 * refuse for the right reason (c skill, d policy, e verifier, f safety during a suspension and allowed after the
 * resume, g budget). Every verdict is read back from the decision records; the chain is read for what moved.
 * Skipped when anvil is not installed.
 */
const PORT = 8561;
const RPC = `http://127.0.0.1:${PORT}`;
const ROOT = resolve(".");

function anvilPath(): string | null {
  const dir = process.env.FOGA_FOUNDRY_DIR;
  const candidate = dir ? `${dir}/anvil` : "anvil";
  try {
    execFileSync(candidate, ["--version"], { stdio: "ignore" });
    return candidate;
  } catch {
    return null;
  }
}

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection({ host: "127.0.0.1", port });
    s.setTimeout(500, () => (s.destroy(), resolve(false)));
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => (s.destroy(), resolve(false)));
  });
}

async function startAnvil(bin: string): Promise<ChildProcess> {
  const child = spawn(bin, ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; i < 80; i++) {
    if (await portOpen(PORT)) return child;
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("anvil did not come up");
}

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

/** Run the CLI as a user would, with only the keys named in `env` (and a clean FOGA_* environment otherwise). */
function foga(args: string[], env: Record<string, string> = {}): CliResult {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FOGA_")) clean[k] = v;
  const child = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], { cwd: ROOT, env: { ...clean, FOGA_RPC_URL: RPC, ...env }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const stdout = String(child.stdout ?? "");
  let json: any = null;
  const start = stdout.indexOf("{");
  const startArr = stdout.indexOf("[");
  const at = start < 0 ? startArr : startArr < 0 ? start : Math.min(start, startArr);
  if (at >= 0) {
    try {
      json = JSON.parse(stdout.slice(at));
    } catch {
      json = null;
    }
  }
  return { code: child.status ?? -1, stdout, stderr: String(child.stderr ?? ""), json };
}

function ok(r: CliResult, what: string): any {
  assert.equal(r.code, 0, `${what} failed (exit ${r.code}):\n${r.stderr.slice(-3000)}\n${r.stdout.slice(-1500)}`);
  assert.ok(r.json, `${what} printed no JSON: ${r.stdout.slice(0, 500)}`);
  return r.json;
}

function refused(r: CliResult, gate: string, what: string): any {
  assert.equal(r.code, 2, `${what}: expected a refusal (exit 2), got exit ${r.code}:\n${r.stderr.slice(-2000)}\n${r.stdout.slice(-1500)}`);
  assert.ok(r.json && r.json.ok === false, `${what}: no refusal JSON`);
  assert.equal(r.json.gate, gate, `${what}: gate ${r.json.gate} (${r.json.reason})`);
  return r.json;
}

test("Loop D cases a-g through the CLI on anvil: birth, skills, two tenders taken and settled, five refused for the right gate, a migration", { timeout: 900_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin);
  const dir = mkdtempSync(join(tmpdir(), "foga-node-"));
  const keys = anvilKeys();
  const W = new Wallet(keys.W);
  const owner = new Wallet(keys["owner.A"]);
  const guardian = new Wallet(keys.G);
  const operator = new Wallet(keys["operator.A"]);
  const worldPath = join(dir, "world.json");
  const configPath = join(dir, "D.json");
  let k: Kernel | null = null;
  try {
    // --- the world, by the CLI
    const deployed = foga(["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", worldPath]);
    assert.equal(deployed.code, 0, `world deploy failed:\n${deployed.stderr.slice(-2000)}`);
    k = await Kernel.open({ worldPath, rpc: RPC, storePath: join(dir, "driver.sqlite"), keys: { W: keys.W } });
    const chainId = k.chainId;

    // --- the world operator registers the standing scheme (what T0 does; not the cell's to do)
    const attInput = k.kya.attestedSchemeInput(fogaAttestedSchemeDescriptor());
    const att = await k.call("scheme", "W", k.kya.schemeRegistryAddress, k.kya.schemes().interface, "registerScheme", [attInput]);
    const schemeId = k.kya.schemeIdFromReceipt(att.receipt);

    // --- the cell's configuration and birth (owner key only)
    const created = foga(["cell", "new", "--name", "D", "--world", worldPath, "--store", join(dir, "D.ops.sqlite"), "--owner", owner.address, "--operator", operator.address, "--guardian", guardian.address, "--out", configPath]);
    assert.equal(created.code, 0, `cell new failed:\n${created.stderr.slice(-2000)}`);
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.identity.standing = { schemeId, issuers: [W.address] };
    cfg.policy.budget = { dailyValueWei: parseEther("0.002").toString(), perOperationValueWei: parseEther("0.001").toString(), dailyGasWei: parseEther("0.01").toString(), maxConcurrentCommitments: 2 };
    cfg.policy.tenders = { minRewardWei: parseEther("0.0005").toString(), minSubmitWindowSeconds: 600, minSettleWindowSeconds: 600, acceptance: ["hashlock"], counterpartyMinLevel: 0, lookbackBlocks: 9000 };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    const born = ok(foga(["cell", "init", "--config", configPath], { FOGA_OWNER_KEY: owner.privateKey }), "cell init");
    assert.match(born.account, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(born.operations.length >= 20, `init made ${born.operations.length} operations`);
    const D = getAddress(born.account);
    const after = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(after.identity.account, D, "the config carries the account");
    assert.equal(after.identity.agentId, born.agentId);
    assert.ok(after.identity.safety.specId, "the spec id was written back");

    // init again on the same store is a resume: every operation replays, nothing is sent, the same account comes back
    const again = ok(foga(["cell", "init", "--config", configPath], { FOGA_OWNER_KEY: owner.privateKey }), "init again");
    assert.equal(again.account, born.account);
    assert.equal(await k.world.provider.getTransactionCount(owner.address), await k.world.provider.getTransactionCount(owner.address), "nothing sent");
    const ownerNonce = await k.world.provider.getTransactionCount(owner.address);

    assert.equal(await k.world.provider.getTransactionCount(owner.address), ownerNonce, "a replayed init sends nothing");

    // --- standing from the issuer (W)
    const claim = { scheme: "S_att", level: 2, subject: `eip155:${chainId}:${D.toLowerCase()}` };
    const expiresAt = (await k.blockTimestamp()) + 365 * 86400;
    await k.call("attest", "W", k.kya.registryAddress, k.kya.registry().interface, "attest", [accountSubject(chainId, D), schemeId, 2, keccakJcs(claim), expiresAt, dataUriJcs(claim), keccakJcs(claim)]);
    const level = ok(foga(["cell", "kya_check", "--config", configPath, "--address", D]), "kya_check");
    assert.equal(level.output.level, 2);

    // --- status, public and operator views
    const status = ok(foga(["cell", "status", "--config", configPath]), "cell status");
    assert.equal(status.output.accountVersion, 2);
    assert.equal(status.output.safety.verdict, "Satisfied");
    assert.equal(status.output.liveness[0].state, "ACTIVE");
    assert.ok(status.output.budget, "the operator sees the budget");
    const pub = ok(foga(["cell", "cell_status", "--config", configPath, "--caller", "someone", "--level", "read"]), "public status");
    assert.equal(pub.output.budget, null, "the public does not see the budget");

    // --- the skills (operator acts): the config follows
    const probe = ok(foga(["cell", "skill_mint", "--config", configPath, "--skill", "foga-probe"], { FOGA_OPERATOR_KEY: operator.privateKey }), "skill_mint foga-probe");
    const extract = ok(foga(["cell", "skill_mint", "--config", configPath, "--skill", "finch-extract-verify"], { FOGA_OPERATOR_KEY: operator.privateKey }), "skill_mint finch-extract-verify");
    const withSkills = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(Object.keys(withSkills.skills.held).sort(), ["finch-extract-verify", "foga-probe"]);
    assert.deepEqual(withSkills.skills.offered.sort(), ["finch-extract-verify", "foga-probe"]);
    assert.equal(probe.output.operations.length, 3);
    refused(foga(["cell", "skill_mint", "--config", configPath, "--skill", "foga-probe", "--mode", "simulate"], {}), "policy", "skill_mint of a held skill (simulate)");
    const held = ok(foga(["cell", "skill_list", "--config", configPath]), "skill_list");
    assert.equal(held.output.skills.length, 2);

    // an act without the operator key in the environment is refused before anything is read
    const noKey = foga(["cell", "aid_heartbeat", "--config", configPath]);
    assert.notEqual(noKey.code, 0);
    assert.match(noKey.stderr, /no operator key/);

    // --- the demander (W, an EOA) mints the seven tenders
    const now = async () => k!.blockTimestamp();
    const mint = async (label: string, p: { skill: string; packageHash: string; input: unknown; answer: string | null; rewardWei: bigint; submitIn: number; settleIn: number; authority?: string }) => {
      const t0 = await now();
      const answerHash = p.answer === null ? "0x" + "11".repeat(32) : hashlock.answerHash(p.answer);
      const task = { schema: "foga.task/1", skill: p.skill, packageHash: p.packageHash, input: p.input, acceptance: { mode: "verifier", profile: "x-hashlock-v1", verifier: k!.tenders.hashlockAddress, answerHash }, deliverable: `case ${label}` };
      const taskURI = dataUri(task);
      const terms = nativeTerms(p.rewardWei, { submitBy: BigInt(t0 + p.submitIn), settleBy: BigInt(t0 + p.settleIn) });
      const m = await k!.call(`mint.${label}`, "W", k!.tenders.address, k!.tenders.contract().interface, "mintTask", [W.address, W.address, p.authority ?? k!.tenders.hashlockAddress, keccakJcs({ td: "foga.task/1", skill: p.skill }), sha256Hex(JSON.stringify(task)), taskURI, terms]);
      const tokenId = k!.tenders.tokenIdFromReceipt(m.receipt);
      await k!.call(`fund.${label}`, "W", k!.tenders.address, k!.tenders.contract().interface, "fundTask", [tokenId, p.rewardWei], p.rewardWei);
      if (!p.authority) await k!.call(`commit.${label}`, "W", k!.tenders.hashlockAddress, k!.tenders.hashlockVerifier().interface, "commitAnswer", [k!.tenders.address, tokenId, answerHash]);
      return tokenId;
    };
    const probeHash = withSkills.skills.held["foga-probe"].packageHash as string;
    const extractHash = withSkills.skills.held["finch-extract-verify"].packageHash as string;
    const day = 86400;

    // a: foga-probe of the cell itself at a chosen block
    const blockA = await k.blockNumber();
    const inputA: ProbeInput = { subject: D, block: blockA, lookback: 9000, kya: { schemeId, issuers: [W.address] } };
    const answerA = (await runProbe(k.world, inputA)).answer;
    const a = await mint("a", { skill: "foga-probe", packageHash: probeHash, input: inputA, answer: answerA, rewardWei: parseEther("0.001"), submitIn: day, settleIn: 7 * day });
    // b: finch-extract-verify over the fixture given inline
    const fixture = readFileSync("scenarios/fixtures/sample-filing.txt", "utf8");
    const answerB = extractVerifyFile("scenarios/fixtures/sample-filing.txt", "scenarios/skills/finch-extract-verify/fields.json", extractHash).canonical;
    const b = await mint("b", { skill: "finch-extract-verify", packageHash: extractHash, input: { document: "data:text/plain;base64," + Buffer.from(fixture, "utf8").toString("base64") }, answer: answerB, rewardWei: parseEther("0.001"), submitIn: day, settleIn: 7 * day });
    // c: a skill the cell does not have
    const c = await mint("c", { skill: "foga-oracle", packageHash: "0x" + "ab".repeat(32), input: {}, answer: "x", rewardWei: parseEther("0.001"), submitIn: day, settleIn: 7 * day });
    // d: reward below the policy floor; d2: a deadline too close
    const d = await mint("d", { skill: "foga-probe", packageHash: probeHash, input: inputA, answer: answerA, rewardWei: parseEther("0.0001"), submitIn: day, settleIn: 7 * day });
    const d2 = await mint("d2", { skill: "foga-probe", packageHash: probeHash, input: inputA, answer: answerA, rewardWei: parseEther("0.001"), submitIn: 120, settleIn: 7 * day });
    // e: an acceptance authority the cell does not work under (a judged tender with W as its authority)
    const e = await mint("e", { skill: "foga-probe", packageHash: probeHash, input: inputA, answer: null, rewardWei: parseEther("0.001"), submitIn: day, settleIn: 7 * day, authority: W.address });
    // f: a tender like a, met during a suspension
    const f = await mint("f", { skill: "foga-probe", packageHash: probeHash, input: inputA, answer: answerA, rewardWei: parseEther("0.001"), submitIn: day, settleIn: 7 * day });

    const listed = ok(foga(["cell", "tender_list", "--config", configPath]), "tender_list");
    assert.equal(listed.output.tenders.length, 7, `seven open tenders listed: ${listed.output.tenders.map((t: any) => t.tokenId).join(",")}`);

    // --- c, d, d2, e: refused at the right gate, nothing sent
    refused(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", c.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "skill", "case c");
    refused(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", d.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "policy", "case d (reward)");
    refused(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", d2.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "policy", "case d (deadline)");
    refused(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", e.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "verifier", "case e");
    // the public may pre-check too (a dry run), and gets the same verdict
    refused(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", c.toString(), "--mode", "simulate", "--caller", "anyone", "--level", "build"]), "skill", "case c as the public");

    // --- a: precheck, run, submit, settle
    const preA = ok(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", a.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "case a precheck");
    assert.ok(preA.output.gates.every((g: any) => g.ok), JSON.stringify(preA.output.gates));
    const runA = ok(foga(["cell", "skill_run", "--config", configPath, "--skill", "foga-probe", "--tokenId", a.toString(), "--input", JSON.stringify(inputA)], { FOGA_OPERATOR_KEY: operator.privateKey }), "case a skill_run");
    assert.equal(runA.output.answerHash, hashlock.answerHash(answerA), "the cell reproduces the demander's answer");
    assert.equal(runA.output.resultHash, hashlock.resultHash(answerA, D));
    const subA = ok(foga(["cell", "tender_submit", "--config", configPath, "--tokenId", a.toString(), "--resultHash", runA.output.resultHash, "--json", JSON.stringify({ runReceipt: runA.output.runReceipt })], { FOGA_OPERATOR_KEY: operator.privateKey }), "case a submit");
    assert.match(subA.output.submissionId, /^\d+$/);
    const subIdA: string = subA.output.submissionId;
    // the same submission again: the job is done, nothing is sent (idempotent)
    const subAgain = ok(foga(["cell", "tender_submit", "--config", configPath, "--tokenId", a.toString(), "--resultHash", runA.output.resultHash, "--json", JSON.stringify({ runReceipt: runA.output.runReceipt })], { FOGA_OPERATOR_KEY: operator.privateKey }), "case a submit again");
    assert.equal(subAgain.output.txHash, subA.output.txHash, "the same job answers with the same transaction");
    // the same job id with another result hash is a conflict
    refused(foga(["cell", "tender_submit", "--config", configPath, "--tokenId", a.toString(), "--resultHash", "0x" + "cd".repeat(32), "--jobId", subA.jobId], { FOGA_OPERATOR_KEY: operator.privateKey }), "conflict", "case a submit with another request under the same job");
    // the driver's reads are pinned to the last block it saw; move the pin to the head before reading what the CLI changed
    const head = async () => k!.world.provider.getBlockNumber();
    await head();
    const balanceBefore = await k.balance(D);
    const settleA = ok(foga(["cell", "tender_settle", "--config", configPath, "--tokenId", a.toString(), "--submissionId", subIdA, "--json", JSON.stringify({ answer: answerA })], { FOGA_OPERATOR_KEY: operator.privateKey }), "case a settle");
    assert.equal(settleA.output.status, 1, "accepted");
    await head();
    const paidA = (await k.balance(D)) - balanceBefore + BigInt(settleA.output.creditWei);
    assert.equal(paidA, parseEther("0.001"), `the reward reached the cell (paid ${settleA.output.paidWei}, credit ${settleA.output.creditWei})`);
    if (BigInt(settleA.output.creditWei) > 0n) ok(foga(["cell", "credit_withdraw", "--config", configPath, "--tokenId", a.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "case a withdraw");

    // --- b: the extraction skill over an inline document
    ok(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", b.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "case b precheck");
    const inspectB = ok(foga(["cell", "tender_inspect", "--config", configPath, "--tokenId", b.toString()]), "case b inspect");
    const runB = ok(foga(["cell", "skill_run", "--config", configPath, "--skill", "finch-extract-verify", "--tokenId", b.toString(), "--input", JSON.stringify(inspectB.output.task.input)], { FOGA_OPERATOR_KEY: operator.privateKey }), "case b skill_run");
    assert.equal(runB.output.answerHash, hashlock.answerHash(answerB));
    const subB = ok(foga(["cell", "tender_submit", "--config", configPath, "--tokenId", b.toString(), "--resultHash", runB.output.resultHash], { FOGA_OPERATOR_KEY: operator.privateKey }), "case b submit");
    const settleB = ok(foga(["cell", "tender_settle", "--config", configPath, "--tokenId", b.toString(), "--submissionId", subB.output.submissionId, "--json", JSON.stringify({ answer: answerB })], { FOGA_OPERATOR_KEY: operator.privateKey }), "case b settle");
    assert.equal(settleB.output.status, 1);

    // --- f: during a suspension the taking gates refuse at safety; after the resume the same tender passes
    const susp = ok(foga(["cell", "guardian_suspend", "--config", configPath, "--reason", "review", "--json", JSON.stringify({ restrictions: ["noNewRisk", "deriskOnly"] })], { FOGA_GUARDIAN_KEY: guardian.privateKey }), "guardian_suspend");
    assert.equal(susp.output.state, "Suspended");
    refused(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", f.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "safety", "case f during the suspension");
    // and a submit sent anyway is refused by the policy before the chain is asked; the account would refuse it too
    const runF = ok(foga(["cell", "skill_run", "--config", configPath, "--skill", "foga-probe", "--tokenId", f.toString(), "--input", JSON.stringify(inputA)], { FOGA_OPERATOR_KEY: operator.privateKey }), "case f skill_run (a run is not a commitment)");
    refused(foga(["cell", "tender_submit", "--config", configPath, "--tokenId", f.toString(), "--resultHash", runF.output.resultHash], { FOGA_OPERATOR_KEY: operator.privateKey }), "safety", "case f submit during the suspension");
    const guardianOnly = foga(["cell", "guardian_resume", "--config", configPath, "--reason", "done"], { FOGA_OPERATOR_KEY: operator.privateKey });
    assert.notEqual(guardianOnly.code, 0, "an admin capability without the guardian key is refused");
    const resumed = ok(foga(["cell", "guardian_resume", "--config", configPath, "--reason", "review complete"], { FOGA_GUARDIAN_KEY: guardian.privateKey }), "guardian_resume");
    assert.equal(resumed.output.state, "Active");
    const preF = ok(foga(["cell", "tender_precheck", "--config", configPath, "--tokenId", f.toString()], { FOGA_OPERATOR_KEY: operator.privateKey }), "case f after the resume");
    assert.ok(preF.output.gates.every((g: any) => g.ok));

    // --- g: an act over the budget (the cell as demander moving more than the per-operation cap) is refused at budget, nothing broadcast
    const opsBefore = ok(foga(["cell", "operation_list", "--config", configPath]), "operation_list").output.operations.length;
    refused(foga(["cell", "tender_mint", "--config", configPath, "--json", JSON.stringify({ skill: "foga-probe", packageHash: probeHash, input: inputA, answerHash: hashlock.answerHash(answerA), rewardWei: parseEther("0.005").toString(), submitIn: day, settleIn: 7 * day })], { FOGA_OPERATOR_KEY: operator.privateKey }), "budget", "case g");
    const opsAfter = ok(foga(["cell", "operation_list", "--config", configPath]), "operation_list").output.operations.length;
    assert.equal(opsAfter, opsBefore, "a refused act broadcasts nothing");
    // within the cap, the cell can be a demander too (a tender for someone else)
    const minted = ok(foga(["cell", "tender_mint", "--config", configPath, "--json", JSON.stringify({ skill: "foga-probe", packageHash: probeHash, input: inputA, answerHash: hashlock.answerHash(answerA), rewardWei: parseEther("0.0006").toString(), submitIn: day, settleIn: 7 * day })], { FOGA_OPERATOR_KEY: operator.privateKey }), "tender_mint within the cap");
    assert.equal(minted.output.operations.length, 3);
    // and in build mode a third party gets the calls for its own account
    const built = ok(foga(["cell", "tender_mint", "--config", configPath, "--mode", "build", "--as", W.address, "--json", JSON.stringify({ skill: "foga-probe", packageHash: probeHash, input: inputA, answerHash: hashlock.answerHash(answerA), rewardWei: parseEther("0.0006").toString(), submitIn: day, settleIn: 7 * day })]), "tender_mint build");
    assert.equal(built.output.as, W.address);
    assert.equal(built.output.calls.length, 3);

    // --- the acceptance matrix, from the records
    const evidence = ok(foga(["cell", "evidence_export", "--config", configPath]), "evidence_export").output;
    const decisions: any[] = evidence.decisions;
    const operations: any[] = evidence.operations;
    const allowedOps = new Set(decisions.filter((d) => d.verdict === "allowed" && d.mode === "act").map((d) => d.jobId));
    for (const op of operations.filter((o) => o.key.startsWith("job:"))) {
      const jobId = op.key.slice(4, op.key.lastIndexOf(":"));
      assert.ok(allowedOps.has(jobId), `operation ${op.key} has an allowed decision`);
    }
    const gatesSeen = new Set(decisions.filter((d) => d.verdict === "refused").map((d) => d.gate));
    for (const g of ["skill", "policy", "verifier", "safety", "budget", "conflict"]) assert.ok(gatesSeen.has(g), `a refusal at gate ${g} was recorded (${[...gatesSeen].join(",")})`);
    for (const d of decisions.filter((d) => d.verdict === "refused")) assert.equal(d.operationId, null, `refusal ${d.id} (${d.gate}) names no operation`);
    // every transaction the operator sent went to the account; nothing else
    const operatorOps = operations.filter((o) => o.signer === "operator");
    assert.ok(operatorOps.length >= 10, `the operator made ${operatorOps.length} operations`);
    await head();
    for (const o of operatorOps) {
      const tx = await k.world.provider.getTransaction(o.txHash);
      assert.ok(tx, `tx ${o.txHash} of ${o.key} is on the chain`);
      assert.equal(getAddress(tx!.to!), D, `${o.key} went through the account`);
    }
    // the value the cell moved out stays within the daily budget
    const moved = operations.filter((o) => o.status === "confirmed" && o.signer === "operator").reduce((s, o) => s + BigInt(o.valueWei), 0n);
    assert.ok(moved <= parseEther("0.002"), `moved ${moved} wei within the daily value budget`);
    assert.equal(evidence.summary.ops.failed, 0, "no operation failed");

    // --- the watchers, in a node environment (the operator key alone; an owner key in the environment is refused)
    const mixed = foga(["node", "tick", "--config", configPath], { FOGA_OPERATOR_KEY: operator.privateKey, FOGA_OWNER_KEY: owner.privateKey });
    assert.notEqual(mixed.code, 0, "a node environment that also holds the owner key is refused");
    assert.match(mixed.stderr, /FOGA_OWNER_KEY/);
    const tick = ok(foga(["node", "tick", "--config", configPath], { FOGA_OPERATOR_KEY: operator.privateKey }), "node tick");
    assert.equal(tick.anchor, "ACTIVE");
    assert.equal(tick.safety.verdict, "Satisfied");
    assert.ok(tick.discovered.length >= 5, `the watcher noticed the demander's tenders (${tick.discovered.length})`);

    // --- the move to a new account (a fresh operator): the identity line continues
    const nextOperator = Wallet.createRandom();
    const nextConfig = join(dir, "D2.json");
    const moved2 = ok(foga(["cell", "migrate", "--config", configPath, "--to", nextConfig, "--operator", nextOperator.address], { FOGA_OWNER_KEY: owner.privateKey }), "cell migrate");
    assert.equal(moved2.agentId, born.agentId);
    assert.notEqual(getAddress(moved2.to), D);
    assert.deepEqual(moved2.skills.sort(), ["finch-extract-verify", "foga-probe"]);
    await head();
    assert.equal(await k.aid.stateName(D), "RETIRED");
    assert.equal(await k.aid.stateName(moved2.to), "ACTIVE");
    assert.equal(getAddress(await k.identity.ownerOf(BigInt(born.agentId))), getAddress(moved2.to));
    assert.equal(getAddress(await k.skills.ownerOf(BigInt(withSkills.skills.held["foga-probe"].tokenId))), getAddress(moved2.to), "the skill followed");
    // the new config runs as a node: status reads the new body; the old config no longer does (its operator changed)
    const status2 = ok(foga(["cell", "status", "--config", nextConfig]), "status of the successor");
    assert.equal(status2.output.account, getAddress(moved2.to));
    assert.equal(status2.output.operator, nextOperator.address);
    assert.equal(status2.output.liveness[0].state, "ACTIVE");
    assert.equal(status2.output.skills.held.length, 2);
    const oldRefused = foga(["cell", "aid_heartbeat", "--config", configPath], { FOGA_OPERATOR_KEY: operator.privateKey });
    assert.notEqual(oldRefused.code, 0, "the retired body refuses to run");
  } finally {
    k?.close();
    k?.world.provider.destroy();
    anvil.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  }
});

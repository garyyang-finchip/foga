import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, Interface, Wallet, getAddress, parseEther } from "ethers";
import { dataUriJcs, keccakJcs } from "../core/canonical.js";
import { accountSubject, fogaAttestedSchemeDescriptor } from "../core/kya.js";
import { anvilKeys } from "../genesis/roles.js";
import { Kernel } from "../kernel/kernel.js";
import { OperationStore, type DecisionRecord, type JobRecord, type OpRecord } from "../kernel/store.js";
import { newApiKey } from "../http/server.js";
import { loadCellConfig, newCellConfig, saveCellConfig, type CellConfig } from "../node/config.js";
import { cellInit } from "../node/init.js";
import { Node } from "../node/node.js";
import { defaultCatalog, OPERATOR_CALLER } from "../tools/index.js";
import { repoRoot } from "../util/fs.js";
import { ALL_CASES, type CaseId, type DemandCase } from "./demander.js";
import type { CaseOutcome, LoopDEvidence, OperationOutput, OperatorTx } from "./evidence.js";

/**
 * Loop D, orchestrated (design memo, Phase 3, section 8): on a world that exists, a brand-new cell is born with keys
 * nobody held before, given standing by the world operator, given its two skills, and then run as an embedded node
 * (`foga node run`, a child process holding the operator key alone) with a model that proposes and a catalog that
 * decides, while an independent demander (another child process, its own key and store) mints the tenders of cases
 * a–f in an order the seed picks. Along the way the orchestrator kills the node after its first submission and
 * before the settlement and starts it again (nothing may be sent twice), suspends and resumes the binding as the
 * guardian for case f, and uses the HTTP entrance beside the runner — the same request repeated, the same job with
 * another request, three mints at once. What is left is the evidence file `foga doctor --loop-d` judges.
 *
 * Nothing in here tells the cell what to do: the input (which tenders exist, with what terms) is not in a script the
 * cell can read, and the cell's choices are the model's, bounded by the catalog.
 */
export interface LoopDOptions {
  rpc: string;
  worldPath: string;
  /** Working directory: the cell's configuration and store, the demander's store, the transcripts. */
  dir: string;
  evidencePath: string;
  model: "stub" | "anthropic";
  /** The model name for the anthropic provider (`runtime.model.model`). */
  modelName?: string;
  seed?: number;
  /** Kill the node after its first submission and restart it (default true). */
  recovery?: boolean;
  /** The key that funds the new cell's roles and plays the world operator and the demander (anvil's first account on a local world). */
  funderKey?: string;
  /** How to start the CLI for the child processes (default: this package's own CLI). */
  cli?: { command: string; args: string[] };
  /** The node's poll interval in seconds (default 1). */
  intervalSeconds?: number;
  /** The whole run's time budget (default 6 minutes). */
  timeoutMs?: number;
  cases?: CaseId[];
  log?: (line: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bigJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

/** The CLI of this very package: compiled when this module runs from dist/, the TypeScript source under tsx otherwise. */
export function ownCli(): { command: string; args: string[] } {
  const here = fileURLToPath(import.meta.url);
  const root = repoRoot();
  if (/[\\/]dist[\\/]/.test(here)) return { command: process.execPath, args: [join(root, "dist", "cli.js")] };
  return { command: process.execPath, args: ["--import", "tsx", join(root, "src", "cli.ts")] };
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolvePort(port));
    });
  });
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("FOGA_")) env[k] = v;
  return { ...env, ...extra };
}

function opOutput(op: OpRecord): OperationOutput {
  return { key: op.key, kind: op.kind, signer: op.signer, status: op.status, txHash: op.txHash, block: op.block, nonce: op.nonce, attempts: op.attempts, replacements: op.replacements, error: op.error, capability: op.capability, caller: op.caller, valueWei: op.valueWei.toString(), gasCostWei: op.gasCostWei === null ? null : op.gasCostWei.toString(), createdAt: op.createdAt, updatedAt: op.updatedAt };
}

/** A snapshot of the cell's store, read beside the running node. */
function snapshot(storePath: string): { ops: OpRecord[]; jobs: JobRecord[]; decisions: DecisionRecord[] } {
  const store = OperationStore.open(storePath);
  try {
    return { ops: store.all(), jobs: store.jobs(null, 10_000), decisions: store.decisions({ limit: 100_000 }) };
  } finally {
    store.close();
  }
}

export async function runLoopD(opts: LoopDOptions): Promise<LoopDEvidence> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const root = repoRoot();
  const dir = resolve(opts.dir);
  mkdirSync(dir, { recursive: true });
  const worldPath = resolve(opts.worldPath);
  const seed = opts.seed ?? 7;
  const cases = opts.cases ?? ALL_CASES;
  const cli = opts.cli ?? ownCli();
  const deadline = Date.now() + (opts.timeoutMs ?? 6 * 60_000);
  const ranAt = new Date().toISOString();
  const worldFile = JSON.parse(readFileSync(worldPath, "utf8")) as { worldId: string; chainId: number; network: string };
  const funderKey = opts.funderKey ?? (worldFile.network === "anvil" ? anvilKeys().W : undefined);
  if (!funderKey) throw new Error("loop D on a non-local world needs --funder-key (the key that funds the cell's roles and mints the tenders)");
  const timeLeft = () => {
    if (Date.now() > deadline) throw new Error("loop D ran out of time");
  };

  // --- the world operator's kernel: funds the roles, registers the standing scheme, attests
  const k = await Kernel.open({ worldPath, rpc: opts.rpc, storePath: join(dir, "orchestrator.sqlite"), keys: { W: funderKey } });
  const W = new Wallet(funderKey).address;
  let child: ChildProcess | null = null;
  try {
    const owner = Wallet.createRandom();
    const operator = Wallet.createRandom();
    const guardian = Wallet.createRandom();
    log(`loop D: a new cell — owner ${owner.address}, operator ${operator.address}, guardian ${guardian.address}; seed ${seed}; model ${opts.model}${opts.modelName ? `/${opts.modelName}` : ""}`);
    const price = (await k.world.provider.getFeeData()).gasPrice ?? 1_000_000_000n;
    const gas = (units: bigint) => units * price * 2n;
    await k.transfer("fund.owner", "W", owner.address, parseEther("0.05") + gas(12_000_000n));
    await k.transfer("fund.operator", "W", operator.address, gas(20_000_000n) + parseEther("0.003"));
    await k.transfer("fund.guardian", "W", guardian.address, gas(1_000_000n));
    const att = await k.call("scheme", "W", k.kya.schemeRegistryAddress, k.kya.schemes().interface, "registerScheme", [k.kya.attestedSchemeInput(fogaAttestedSchemeDescriptor())]);
    const schemeId = k.kya.schemeIdFromReceipt(att.receipt);
    const bornAtBlock = await k.blockNumber();

    // --- the cell's configuration and birth (the owner's act, in this process, as `foga cell init` would)
    const configPath = join(dir, "D.json");
    const storePath = join(dir, "D.ops.sqlite");
    const cfg: CellConfig = newCellConfig({ name: "D", world: worldPath, store: storePath, owner: owner.address, operator: operator.address, guardian: guardian.address, rpc: opts.rpc, skillsDir: join(root, "scenarios", "skills"), inputDir: join(root, "scenarios", "fixtures"), description: "Loop D: a cell born for one unscripted run" });
    cfg.identity.standing = { schemeId, issuers: [W] };
    // the fee book is sized for the run (two skill mints, a few mints, the tenders); the value caps stay tight so cases g and the concurrent mints meet them
    cfg.policy.budget = { dailyValueWei: parseEther("0.002").toString(), perOperationValueWei: parseEther("0.001").toString(), dailyGasWei: parseEther("0.05").toString(), maxConcurrentCommitments: 2 };
    cfg.policy.tenders = { minRewardWei: parseEther("0.0005").toString(), minSubmitWindowSeconds: 600, minSettleWindowSeconds: 600, acceptance: ["hashlock"], counterpartyMinLevel: 0, lookbackBlocks: 9000 };
    cfg.runtime.pollSeconds = opts.intervalSeconds ?? 1;
    cfg.runtime.model = { provider: opts.model, model: opts.modelName, dailyCalls: opts.model === "stub" ? 400 : 120, maxToolCallsPerTick: 12, maxActsPerTick: 2 };
    cfg.runtime.http.rateLimitPerMinute = 100_000;
    saveCellConfig(configPath, cfg);
    const birthNode = await Node.open({ configPath, rpc: opts.rpc, keys: { owner: owner.privateKey }, allowUnborn: true, log: () => {} });
    const born = await cellInit(birthNode, { log: () => {} });
    birthNode.close();
    const account = getAddress(born.account);
    log(`loop D: cell D born as ${account} (agent ${born.agentId}) in ${born.operations.length} operations`);
    const accountBalanceStart = await k.balance(account);

    // --- standing from the world operator, the two skills minted by the operator
    const claim = { scheme: "S_att", level: 2, subject: `eip155:${k.chainId}:${account.toLowerCase()}` };
    const expiresAt = (await k.blockTimestamp()) + 365 * 86400;
    await k.call("attest", "W", k.kya.registryAddress, k.kya.registry().interface, "attest", [accountSubject(k.chainId, account), schemeId, 2, keccakJcs(claim), expiresAt, dataUriJcs(claim), keccakJcs(claim)]);
    const catalog = defaultCatalog();
    const skillNode = await Node.open({ configPath, rpc: opts.rpc, keys: { operator: operator.privateKey }, log: () => {} });
    for (const skill of ["foga-probe", "finch-extract-verify"]) {
      const r = await catalog.invoke(skillNode, "skill_mint", { skill }, OPERATOR_CALLER, { mode: "act" });
      if (!r.ok) throw new Error(`skill_mint ${skill}: ${r.gate}: ${r.reason}`);
    }
    skillNode.close();
    const held = loadCellConfig(configPath).config.skills.held as Record<string, { packageHash: string }>;
    const packages = { "foga-probe": held["foga-probe"].packageHash, "finch-extract-verify": held["finch-extract-verify"].packageHash };
    log(`loop D: standing level 2 attested by ${W}; skills minted (${Object.keys(held).join(", ")})`);

    // --- an API key for the orchestrator's own calls through the HTTP entrance, and the node's port
    const key = newApiKey("orchestrator");
    {
      const loaded = loadCellConfig(configPath);
      loaded.config.access.keys.push({ id: "orchestrator", sha256: key.sha256, level: "act", visibility: "caller", note: "the loop D orchestrator" });
      saveCellConfig(configPath, loaded.config);
    }
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;

    // --- the independent demander: cases a–e (f comes later, during the suspension)
    const demanderStore = join(dir, "demander.sqlite");
    const demand = async (ids: CaseId[], batch: string): Promise<DemandCase[]> => {
      const out = join(dir, `cases-${batch}.json`);
      const r = await runChild(cli, ["demo", "demander", "--world", worldPath, "--rpc", opts.rpc, "--store", demanderStore, "--cell", account, "--scheme", schemeId, "--issuer", W, "--probe-hash", packages["foga-probe"], "--extract-hash", packages["finch-extract-verify"], "--cases", ids.join(","), "--seed", String(seed), "--out", out], cleanEnv({ FOGA_DEMANDER_KEY: funderKey }), (line) => log(`  demander| ${line}`));
      if (r.code !== 0) throw new Error(`the demander failed (exit ${r.code})`);
      return (JSON.parse(readFileSync(out, "utf8")) as { cases: DemandCase[] }).cases;
    };
    const firstBatch = cases.filter((c) => c !== "f");
    const minted: DemandCase[] = firstBatch.length ? await demand(firstBatch, "1") : [];

    // --- the node: `foga node run`, the operator key alone, a model proposing
    const startNode = (): ChildProcess => {
      const env = cleanEnv({ FOGA_OPERATOR_KEY: operator.privateKey });
      const args = [...cli.args, "node", "run", "--config", configPath, "--rpc", opts.rpc, "--model", opts.model, "--listen", `127.0.0.1:${port}`, "--interval", String(opts.intervalSeconds ?? 1), "--transcripts", join(dir, "transcripts")];
      const c = spawn(cli.command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
      c.stderr!.on("data", (d) => {
        for (const line of String(d).split("\n")) if (line.trim()) log(`  node| ${line}`);
      });
      return c;
    };
    const exited = (c: ChildProcess) => new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("exit", () => r())));
    child = startNode();
    log(`loop D: node started (pid ${child.pid}) at ${baseUrl}`);

    const api = async (path: string, body: unknown) => {
      const r = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` }, body: JSON.stringify(body) });
      return (await r.json()) as { ok: boolean; gate?: string; reason?: string; decisionId?: number; output?: Record<string, unknown>; jobId?: string };
    };
    const takenIds = minted.filter((c) => c.expect.outcome === "taken").map((c) => c.tokenId);
    const refusedIds = minted.filter((c) => c.expect.outcome === "refused").map((c) => c.tokenId);
    const recovery: LoopDEvidence["recovery"] = { performed: false, killedAfterOperation: null, killedAt: null, restartedAt: null, tokenId: null };
    const entrances: LoopDEvidence["entrances"] = { idempotent: null, conflict: null, concurrent: null };
    const submitKey = (tokenId: string) => new RegExp(`^job:tender:${tokenId}:c\\d+:submit$`);
    const settledOnChain = async (tokenId: string) => {
      const count = Number(await k.tenders.submissionCount(BigInt(tokenId)).catch(() => 0n));
      for (let i = 1; i <= count; i++) {
        const s = await k.tenders.submissionOf(BigInt(tokenId), BigInt(i));
        if (getAddress(s.fulfiller) === account && s.status === 1) return true;
      }
      return false;
    };

    // --- phase 1: the first batch is worked; the node is killed after its first submission and restarted; the other entrances join in
    // the orchestrator's reads are pinned to the last block its kernel saw; the pin moves with each look at the head
    const head = () => k.world.provider.getBlockNumber();
    let concurrentDone = false;
    for (;;) {
      timeLeft();
      await sleep(1000);
      await head();
      if (child.exitCode !== null && !recovery.performed) throw new Error(`the node exited with ${child.exitCode} before the run was done`);
      const snap = snapshot(storePath);
      if ((opts.recovery ?? true) && !recovery.performed) {
        const submit = snap.ops.find((o) => o.status === "confirmed" && takenIds.some((id) => submitKey(id).test(o.key)));
        if (submit) {
          const tokenId = /^job:tender:(\d+):/.exec(submit.key)![1];
          const settle = snap.ops.find((o) => o.key.startsWith(`job:tender:${tokenId}:`) && o.key.endsWith(":settle:settle") && o.status === "confirmed");
          if (!settle) {
            child.kill("SIGKILL");
            await exited(child);
            recovery.performed = true;
            recovery.killedAfterOperation = submit.key;
            recovery.killedAt = new Date().toISOString();
            recovery.tokenId = tokenId;
            log(`loop D: node killed (SIGKILL) after ${submit.key} and before its settlement; restarting`);
            await sleep(500);
            child = startNode();
            recovery.restartedAt = new Date().toISOString();
            continue;
          }
        }
      }
      // beside the runner: the same submission again through HTTP (one business operation), the same job under another request (a conflict), three mints at once
      if (!concurrentDone && recovery.performed && child.exitCode === null) {
        const submitted = snap.jobs.find((j) => j.kind === "tender" && j.status === "done" && takenIds.includes(String((j.input as { tokenId?: string })?.tokenId ?? "")));
        if (submitted) {
          const input = submitted.input as { tokenId: string; resultHash: string };
          const run = snap.jobs.find((j) => j.kind === "skill-run" && j.status === "done" && (j.result as { resultHash?: string } | null)?.resultHash?.toLowerCase() === input.resultHash.toLowerCase());
          const runReceipt = (run?.result as { runReceipt?: unknown } | null)?.runReceipt;
          await waitForHttp(`${baseUrl}/healthz`);
          const again = await api("/api/tender_submit", { tokenId: input.tokenId, resultHash: input.resultHash, ...(runReceipt ? { runReceipt } : {}), jobId: submitted.id });
          const txHash = (submitted.result as { txHash?: string } | null)?.txHash ?? null;
          entrances.idempotent = { decisionId: again.decisionId ?? null, gate: again.ok ? "idempotent" : (again.gate ?? null), sameTxHash: again.ok ? (again.output as { txHash?: string })?.txHash === txHash : false };
          const conflict = await api("/api/tender_submit", { tokenId: input.tokenId, resultHash: "0x" + "cd".repeat(32), jobId: submitted.id });
          entrances.conflict = { decisionId: conflict.decisionId ?? null, gate: conflict.ok ? null : (conflict.gate ?? null) };
          const reward = parseEther("0.0008").toString();
          const mints = await Promise.all([1, 2, 3].map((n) => api("/api/tender_mint", { skill: "foga-probe", packageHash: packages["foga-probe"], input: { concurrent: n }, answerHash: "0x" + "22".repeat(32), rewardWei: reward, submitIn: 86400, settleIn: 7 * 86400 })));
          entrances.concurrent = { requested: mints.length, allowed: mints.filter((m) => m.ok).length, refused: mints.filter((m) => !m.ok).map((m) => ({ gate: m.gate ?? "?", reason: m.reason ?? "" })) };
          concurrentDone = true;
          log(`loop D: through HTTP beside the runner — same submission: ${entrances.idempotent.gate}${entrances.idempotent.sameTxHash ? " (same transaction)" : ""}; same job, another request: ${entrances.conflict.gate}; three mints at once: ${entrances.concurrent.allowed} allowed, ${entrances.concurrent.refused.map((r) => r.gate).join("/") || "none refused"}`);
        }
      }
      // done when every taken case is settled with no credit left and every refused case has its refusal
      const refusalsSeen = refusedIds.every((id) => snap.decisions.some((d) => d.caller === "runner" && d.capability === "tender_precheck" && d.jobId === `precheck:${id}` && d.verdict === "refused"));
      let takenDone = true;
      for (const id of takenIds) {
        if (!(await settledOnChain(id)) || (await k.tenders.creditOf(BigInt(id), account)) > 0n) {
          takenDone = false;
          break;
        }
      }
      if (refusalsSeen && takenDone && (concurrentDone || !(opts.recovery ?? true) || !takenIds.length)) break;
    }
    log("loop D: phase 1 done (the first batch is settled or refused)");

    // --- phase 2, case f: the guardian suspends, the demander mints f, the runner refuses at safety, the guardian resumes, the runner takes f
    let fCase: DemandCase | null = null;
    if (cases.includes("f")) {
      const guardianAct = async (name: "guardian_suspend" | "guardian_resume", input: Record<string, unknown>) => {
        const g = await Node.open({ configPath, rpc: opts.rpc, keys: { guardian: guardian.privateKey }, log: () => {} });
        try {
          const r = await catalog.invoke(g, name, input, OPERATOR_CALLER, { mode: "act" });
          if (!r.ok) throw new Error(`${name}: ${r.gate}: ${r.reason}`);
        } finally {
          g.close();
        }
      };
      await guardianAct("guardian_suspend", { reason: "loop D case f: a review while a tender arrives", restrictions: ["noNewRisk", "deriskOnly"] });
      log("loop D: the guardian suspended the binding (noNewRisk, deriskOnly)");
      fCase = (await demand(["f"], "2"))[0];
      for (;;) {
        timeLeft();
        await sleep(1000);
        await head();
        const snap = snapshot(storePath);
        if (snap.decisions.some((d) => d.caller === "runner" && d.capability === "tender_precheck" && d.jobId === `precheck:${fCase!.tokenId}` && d.verdict === "refused" && d.gate === "safety")) break;
      }
      log(`loop D: tender ${fCase.tokenId} refused at safety during the suspension`);
      await guardianAct("guardian_resume", { reason: "loop D case f: review complete" });
      log("loop D: the guardian resumed the binding");
      for (;;) {
        timeLeft();
        await sleep(1000);
        await head();
        if ((await settledOnChain(fCase.tokenId)) && (await k.tenders.creditOf(BigInt(fCase.tokenId), account)) === 0n) break;
      }
      log(`loop D: tender ${fCase.tokenId} taken after the resume`);
    }

    // --- stop the node, then read everything it left
    child.kill("SIGTERM");
    await Promise.race([exited(child), sleep(15_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    child = null;
    const toBlock = await head();
    const store = OperationStore.open(storePath);
    const decisions = store.decisions({ limit: 100_000 });
    const jobs = store.jobs(null, 100_000);
    const ops = store.all();
    const journal = store.journalEntries().filter((e) => ["runner-tick", "runner-skipped", "runner-model-error", "tender-discovered", "safety-changed"].includes(e.event));
    const modelCalls = Object.values(store.facts("runner.model.calls.")).reduce<number>((a, b) => a + Number(b), 0);
    store.close();

    const allCases = fCase ? [...minted, fCase] : minted;
    const reader = await Node.open({ configPath, rpc: opts.rpc, keys: {}, log: () => {} });
    const outcomes: LoopDEvidence["cases"] = [];
    try {
      for (const c of allCases) {
        const r = await catalog.invoke(reader, "tender_inspect", { tokenId: c.tokenId }, OPERATOR_CALLER);
        const view = r.ok ? (r.output as { submissions: { id: string; fulfiller: string; status: number }[] }) : { submissions: [] };
        const mine = decisions.filter((d) => d.caller === "runner" && (d.jobId === `precheck:${c.tokenId}` || d.jobId?.startsWith(`tender:${c.tokenId}:`)));
        const gates = decisions.filter((d) => d.caller === "runner" && d.capability === "tender_precheck" && d.jobId === `precheck:${c.tokenId}`).map((d) => (d.verdict === "refused" ? d.gate : "allowed"));
        const subs = view.submissions.map((s) => ({ id: s.id, fulfiller: s.fulfiller, status: s.status, byCell: getAddress(s.fulfiller) === account }));
        const settled = subs.some((s) => s.byCell && s.status === 1);
        const settleJob = jobs.find((j) => j.kind === "tender-settle" && String((j.input as { tokenId?: string })?.tokenId) === c.tokenId && j.status === "done");
        const paid = (settleJob?.result as { paidWei?: string; creditWei?: string } | null) ?? {};
        const withdrawn = jobs.filter((j) => j.kind === "withdraw" && String((j.input as { tokenId?: string })?.tokenId) === c.tokenId && j.status === "done").reduce((a, j) => a + BigInt((j.result as { withdrawnWei?: string } | null)?.withdrawnWei ?? "0"), 0n);
        const refusedGates = gates.filter((g) => g !== "allowed");
        let status: CaseOutcome["status"] = "other";
        if (settled && refusedGates.length) status = "refused-then-taken";
        else if (settled) status = "taken";
        else if (refusedGates.length && !subs.some((s) => s.byCell)) status = "refused";
        else if (!gates.length && !subs.some((s) => s.byCell)) status = "pending";
        outcomes.push({ ...c, outcome: { status, gates, decisions: mine.map((d) => d.id), submissions: subs, settled, paidWei: paid.paidWei ?? "0", creditWei: paid.creditWei ?? "0", withdrawnWei: withdrawn.toString() } });
      }
    } finally {
      reader.close();
    }

    // --- every transaction the operator key signed, from the birth to now
    const accountIface = k.world.ifaceOf("foga:FogaCellAccount");
    const accountContract = new Contract(account, accountIface, k.world.provider);
    const operatorTxs: OperatorTx[] = [];
    let ownerTxs = 0;
    let guardianTxs = 0;
    for (let n = bornAtBlock; n <= toBlock; n++) {
      const block = await k.world.provider.getBlock(n, true);
      if (!block) continue;
      for (const tx of block.prefetchedTransactions) {
        const from = getAddress(tx.from);
        if (from === owner.address) ownerTxs++;
        if (from === guardian.address) guardianTxs++;
        if (from !== operator.address) continue;
        const receipt = await k.world.provider.getTransactionReceipt(tx.hash);
        let inner: OperatorTx["inner"] = null;
        if (tx.to && getAddress(tx.to) === account) {
          try {
            const parsed = accountIface.parseTransaction({ data: tx.data, value: tx.value });
            if (parsed && parsed.name === "execute") {
              const target = getAddress(parsed.args[0] as string);
              const data = parsed.args[2] as string;
              const selector = data.slice(0, 10);
              const allowed = Boolean(await accountContract.operatorAllowed(target, selector).catch(() => null));
              inner = { target, selector, valueWei: (parsed.args[1] as bigint).toString(), allowed };
            }
          } catch {
            inner = null;
          }
        }
        operatorTxs.push({ hash: tx.hash, block: n, nonce: tx.nonce, to: tx.to ? getAddress(tx.to) : null, toIsAccount: Boolean(tx.to && getAddress(tx.to) === account), valueWei: tx.value.toString(), inner, status: receipt?.status ?? null });
      }
    }

    const ticks = journal.filter((e) => e.event === "runner-tick");
    const detail = (e: { detail: unknown }) => e.detail as { modelCalls?: number; toolCalls?: number; acts?: number; trajectoryHash?: string; error?: string | null };
    const probeDecision = decisions.find((d) => d.caller === "runner" && d.capability === "tender_mint");
    const used = { valueWei: ops.filter((o) => o.signer === "operator" && o.status === "confirmed").reduce((a, o) => a + o.valueWei, 0n), gasWei: ops.filter((o) => o.signer === "operator").reduce((a, o) => a + (o.gasCostWei ?? 0n), 0n) };
    const config = loadCellConfig(configPath).config;
    const finishedAt = new Date().toISOString();
    const evidence: LoopDEvidence = {
      schema: "foga.loop-d-evidence/1",
      worldId: worldFile.worldId,
      chainId: worldFile.chainId,
      network: worldFile.network,
      ranAt,
      finishedAt,
      seed,
      model: { provider: opts.model, model: opts.model === "stub" ? "foga-stub/1" : (opts.modelName ?? "") },
      cell: { name: "D", account, agentId: born.agentId, owner: owner.address, operator: operator.address, guardian: guardian.address, bornAtBlock, specId: born.specId ?? null },
      demander: W,
      cases: outcomes,
      budgetProbe: { attempted: Boolean(probeDecision), decisionId: probeDecision?.id ?? null, gate: probeDecision ? (probeDecision.verdict === "refused" ? probeDecision.gate : "allowed") : null, capability: probeDecision?.capability ?? null },
      runner: {
        ticks: ticks.length,
        skipped: journal.filter((e) => e.event === "runner-skipped").length,
        errors: journal.filter((e) => e.event === "runner-model-error").length + ticks.filter((e) => detail(e).error).length,
        modelCalls,
        toolCalls: ticks.reduce((a, e) => a + (detail(e).toolCalls ?? 0), 0),
        acts: ticks.reduce((a, e) => a + (detail(e).acts ?? 0), 0),
        trajectoryHashes: ticks.map((e) => detail(e).trajectoryHash ?? "").filter(Boolean),
      },
      recovery,
      entrances,
      budget: { dailyValueWei: config.policy.budget.dailyValueWei, perOperationValueWei: config.policy.budget.perOperationValueWei, dailyGasWei: config.policy.budget.dailyGasWei, maxConcurrentCommitments: config.policy.budget.maxConcurrentCommitments, dailyModelCalls: config.runtime.model.dailyCalls, used: { valueWei: used.valueWei.toString(), gasWei: used.gasWei.toString(), modelCalls, skillRuns: jobs.filter((j) => j.kind === "skill-run").length, commitmentsMade: jobs.filter((j) => j.kind === "tender").length } },
      chain: { fromBlock: bornAtBlock, toBlock, account, operator: operator.address, operatorTxs, ownerTxs, guardianTxs, accountBalanceWei: { start: accountBalanceStart.toString(), end: (await k.balance(account)).toString() } },
      decisions,
      jobs,
      operations: ops.map(opOutput),
      journal,
      summary: { cases: outcomes.length, taken: outcomes.filter((c) => c.outcome.status === "taken" || c.outcome.status === "refused-then-taken").length, refused: outcomes.filter((c) => c.outcome.status === "refused").length, pending: outcomes.filter((c) => c.outcome.status === "pending" || c.outcome.status === "other").length, decisions: { allowed: decisions.filter((d) => d.verdict === "allowed").length, refused: decisions.filter((d) => d.verdict === "refused").length }, operations: ops.length },
    };
    mkdirSync(dirname(resolve(opts.evidencePath)), { recursive: true });
    writeFileSync(resolve(opts.evidencePath), bigJson(evidence) + "\n");
    log(`loop D: evidence written to ${opts.evidencePath} — ${evidence.summary.taken} taken, ${evidence.summary.refused} refused, ${evidence.summary.pending} pending; ${decisions.length} decision records, ${ops.length} operations, ${ticks.length} runner ticks, ${modelCalls} model calls`);
    return evidence;
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    k.close();
    k.world.provider.destroy();
  }
}

async function waitForHttp(url: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {
      /* not yet */
    }
    await sleep(250);
  }
  throw new Error(`${url} did not come up`);
}

function runChild(cli: { command: string; args: string[] }, args: string[], env: Record<string, string>, onLine: (line: string) => void): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolveRun, reject) => {
    const c = spawn(cli.command, [...cli.args, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    c.stdout!.on("data", (d) => (stdout += d));
    c.stderr!.on("data", (d) => {
      for (const line of String(d).split("\n")) if (line.trim()) onLine(line);
    });
    c.once("error", reject);
    c.once("exit", (code) => resolveRun({ code, stdout }));
  });
}

/** Where `foga demo --loop-d` keeps its working files. */
export function defaultLoopDDir(): string {
  const dir = join(repoRoot(), "deployments", "loop-d");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

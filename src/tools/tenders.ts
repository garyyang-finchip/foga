import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAddress, toUtf8Bytes, hexlify } from "ethers";
import { z } from "zod";
import { accountRef, dataUri, dataUriJcs, keccakJcs, sha256Hex } from "../core/canonical.js";
import { kindId, taskDescriptor } from "../core/ard.js";
import { hashlock, nativeTerms } from "../core/tenders.js";
import { runExtractIsolated, runProbeIsolated } from "../genesis/skill-runner.js";
import type { ProbeInput } from "../genesis/probe.js";
import type { Node } from "../node/node.js";
import { ok, refused, safetyGate, skillGate, tenderGates, type Gate } from "../node/policy.js";
import { GateSchema, TaskDocumentSchema, TenderOutputSchema, derivedJobId, readTender, tenderJobId, tenderOutput, zAddress, zAs, zBool, zBytes32, zHex, zJobId, zUint, type TenderView } from "./common.js";
import type { ActCapability, ActContext, Intent } from "./types.js";

/**
 * The tender path (ERC-8414) as capabilities: what the genesis does in T3 by hand, offered to a caller and judged by
 * the catalog. The fulfiller's side — precheck, run the skill, submit, settle, withdraw — is the Loop D path; the
 * demander's side — mint, fund — is what a counterparty (or a test) uses, in act mode through the cell or in build
 * mode as calldata for its own account.
 */
const ZERO32 = "0x" + "00".repeat(32);

/** The text of a data: URI (base64 or percent-encoded), whatever its media type. */
function decodeDataUriText(uri: string): string {
  const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(uri);
  if (!m) throw new Error("not a data: URI");
  return m[2] ? Buffer.from(m[3], "base64").toString("utf8") : decodeURIComponent(m[3]);
}

/** The business gates of taking a tender: liveness and safety, skill, the tender policy, the hashlock commitment. */
async function takingGates(node: Node, view: TenderView): Promise<Gate[]> {
  const k = node.kernel;
  const cell = node.body;
  const gates: Gate[] = [];
  const [aidState, status] = await Promise.all([k.aid.stateName(cell.address), cell.status()]);
  gates.push(safetyGate(aidState, status, "commitment"));
  const held = await node.heldSkills();
  gates.push(skillGate(node.config, { skill: view.facts.skill, packageHash: view.facts.packageHash }, held.map((h) => ({ name: h.name, packageHash: h.packageHash }))));
  gates.push(...tenderGates(node.config, view.facts, { now: await node.now() }, node.acceptance));
  if (getAddress(view.facts.acceptanceAuthority) === getAddress(node.acceptance.hashlock)) {
    const committed: string = await k.tenders.hashlockVerifier().answerHashOf(await k.tenders.hashlockVerifier().key(k.tenders.address, view.facts.tokenId));
    if (committed === ZERO32) gates.push(refused("verifier", "the hashlock verifier holds no committed answer for this tender yet"));
    else if (view.task?.acceptance.answerHash && view.task.acceptance.answerHash.toLowerCase() !== committed.toLowerCase()) gates.push(refused("verifier", `the task document's answerHash ${view.task.acceptance.answerHash.slice(0, 10)}… differs from the verifier's commitment ${committed.slice(0, 10)}…`));
    else gates.push(ok("verifier", `answer committed in the hashlock verifier (${committed.slice(0, 10)}…)`));
  }
  const gas = await k.balance(node.config.identity.operator);
  const floor = BigInt(node.config.policy.budget.dailyGasWei) / 4n;
  if (gas < floor) gates.push(refused("budget", `operator gas ${gas} wei is below a quarter of the daily gas budget (${floor} wei)`));
  else gates.push(ok("budget", `operator holds ${gas} wei of gas (floor ${floor} wei)`));
  return gates;
}

export const tender_precheck: ActCapability = {
  name: "tender_precheck",
  title: "Pre-check a tender",
  description: "Every gate the cell passes before taking a tender: anchor ACTIVE and binding Satisfied, the skill held and offered with the committed package, the policy on reward and deadlines, the acceptance authority, the hashlock commitment, the budget. Writes a decision record; sends nothing.",
  action: "act",
  visibility: "public",
  principal: "cell",
  ercs: [8414, 8434, 8468, 8338],
  input: z.object({ tokenId: zUint }),
  output: z.object({ tokenId: zUint, jobId: z.string(), gates: z.array(GateSchema), tender: TenderOutputSchema }),
  async plan({ node }, { tokenId }) {
    const id = BigInt(tokenId);
    const view = await readTender(node, id, { counterparty: true });
    const gates = await takingGates(node, view);
    return {
      job: { id: `precheck:${tokenId}`, kind: "precheck", input: { tokenId }, commitment: true, ephemeral: true },
      gates,
      valueWei: 0n,
      steps: [],
      output: () => ({ tokenId, jobId: tenderJobId(id, view.facts.completions), gates, tender: tenderOutput(view) }),
    };
  },
};

const RunOutput = z.object({
  skill: z.string(),
  packageHash: zBytes32,
  jobId: z.string(),
  answer: z.string(),
  answerHash: zBytes32,
  /** sha256(answer ‖ cell): what a hashlock submission by this cell carries. */
  resultHash: zBytes32,
  report: z.unknown(),
  runReceipt: z.unknown(),
  elapsedMs: z.number(),
});

export const skill_run: ActCapability = {
  name: "skill_run",
  title: "Run a held skill",
  description: "Run one of the cell's skills in the isolated worker (foga-probe: view calls at a pinned block; finch-extract-verify: the deterministic extraction over a document inside the input directory or given inline). A job with a persistent result; the same input is the same job.",
  action: "act",
  visibility: "caller",
  principal: "cell",
  ercs: [8338],
  input: z.object({ skill: z.string(), input: z.unknown(), tokenId: zUint.optional(), jobId: zJobId }),
  output: RunOutput,
  async plan({ node }, input) {
    const held = await node.heldSkills();
    const gates: Gate[] = [skillGate(node.config, { skill: input.skill, packageHash: null }, held.map((h) => ({ name: h.name, packageHash: h.packageHash })))];
    const skill = held.find((h) => h.name === input.skill);
    const jobId = input.jobId ?? derivedJobId(`skill-run:${input.skill}`, { input: input.input, tokenId: input.tokenId ?? null });
    const cell = node.body.address;
    return {
      job: { id: jobId, kind: "skill-run", input: { skill: input.skill, input: input.input, tokenId: input.tokenId ?? null } },
      gates,
      valueWei: 0n,
      steps: [],
      work: async () => {
        if (!skill) throw new Error(`skill ${input.skill} is not held`);
        const started = Date.now();
        let answer: string;
        let report: unknown;
        if (input.skill === "foga-probe") {
          const probe = input.input as ProbeInput;
          const run = await runProbeIsolated({ worldPath: node.worldPath, rpc: node.rpc, bundlePath: node.bundlePath, input: probe });
          answer = run.answer;
          report = run.report;
        } else if (input.skill === "finch-extract-verify") {
          const doc = (input.input as { document?: string })?.document;
          if (!doc) throw new Error("finch-extract-verify needs input.document: a file name inside the input directory or a data: URI holding the text");
          // an inline document is written beside the cell's store and read from there; a named one must be a bare file name in the input directory
          let documentPath: string;
          let inputDir = node.inputDir;
          if (doc.startsWith("data:")) {
            const text = decodeDataUriText(doc);
            inputDir = join(dirname(node.storePath), "inline");
            mkdirSync(inputDir, { recursive: true });
            documentPath = join(inputDir, `${sha256Hex(text).slice(2, 34)}.txt`);
            writeFileSync(documentPath, text);
          } else {
            if (/[\\/]|\.\./.test(doc)) throw new Error("input.document must be a bare file name inside the input directory");
            documentPath = join(node.inputDir, doc);
          }
          const run = await runExtractIsolated({ documentPath, fieldsPath: join(node.skillsDir, "finch-extract-verify", "fields.json"), packageHash: skill.packageHash, inputDir, skillsDir: node.skillsDir });
          answer = run.canonical;
          report = run.report;
        } else throw new Error(`no executor for skill ${input.skill}; the node runs foga-probe and finch-extract-verify`);
        const answerHash = hashlock.answerHash(answer);
        const runReceipt = { schema: "foga.run-receipt/1", skill: input.skill, packageHash: skill.packageHash, tokenId: input.tokenId ?? null, input: input.input, answerHash, fulfiller: accountRef(node.chainId, cell), worker: "isolated child process (skill-worker), view calls only" };
        return { answer, answerHash, resultHash: hashlock.resultHash(answer, cell), report, runReceipt, elapsedMs: Date.now() - started };
      },
      output: (_c, work) => ({ skill: input.skill, packageHash: skill?.packageHash ?? ZERO32, jobId, ...(work as object) }),
    };
  },
};

export const tender_submit: ActCapability = {
  name: "tender_submit",
  title: "Submit a fulfillment",
  description: "Submit the result of a run to a tender through the cell's account (ERC-8414 submitFulfillment): a commitment-class call that passes every taking gate again at the moment of sending. The job is the tender's n-th completion by this cell.",
  action: "act",
  visibility: "caller",
  principal: "cell",
  ercs: [8414],
  input: z.object({ tokenId: zUint, resultHash: zBytes32, resultURI: z.string().optional(), runReceipt: z.unknown().optional(), jobId: zJobId }),
  output: z.object({ tokenId: zUint, submissionId: zUint, txHash: z.string(), operationId: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const id = BigInt(input.tokenId);
    const view = await readTender(node, id, { counterparty: true });
    const gates = await takingGates(node, view);
    const jobId = input.jobId ?? tenderJobId(id, view.facts.completions);
    const resultURI = input.resultURI ?? (input.runReceipt ? dataUriJcs(input.runReceipt) : dataUriJcs({ schema: "foga.run-receipt/1", tokenId: input.tokenId, resultHash: input.resultHash, fulfiller: accountRef(node.chainId, node.body.address) }));
    const intent: Intent = { target: k.tenders.address, value: 0n, data: k.tenders.encodeSubmit(id, input.resultHash, resultURI), label: `submitFulfillment(${input.tokenId}, ${input.resultHash.slice(0, 10)}…)` };
    return {
      job: { id: jobId, kind: "tender", input: { tokenId: input.tokenId, resultHash: input.resultHash }, commitment: true },
      gates,
      valueWei: 0n,
      steps: [{ name: "submit", kind: "commitment", build: () => intent }],
      output: (confirmed) => {
        const c = confirmed[0];
        return { tokenId: input.tokenId, submissionId: k.tenders.submissionIdFromReceipt(c.receipt).toString(), txHash: c.txHash, operationId: `job:${jobId}:submit`, jobId };
      },
    };
  },
};

export const tender_settle: ActCapability = {
  name: "tender_settle",
  title: "Settle a submission",
  description: "Reveal the answer and settle the cell's submission (ERC-8414 settleFulfillment with the hashlock proof); the reward is paid to the account or credited for withdrawal.",
  action: "act",
  visibility: "caller",
  principal: "cell",
  ercs: [8414],
  input: z.object({ tokenId: zUint, submissionId: zUint, answer: z.string().optional(), proof: zHex.optional(), jobId: zJobId }),
  output: z.object({ tokenId: zUint, submissionId: zUint, txHash: z.string(), operationId: z.string(), jobId: z.string(), paidWei: zUint, creditWei: zUint, status: z.number() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const id = BigInt(input.tokenId);
    const sid = BigInt(input.submissionId);
    if (!input.answer && !input.proof) throw new Error("pass the answer (text) or the proof (hex)");
    const proof = input.proof ?? hexlify(toUtf8Bytes(input.answer!));
    const view = await readTender(node, id);
    const sub = view.submissions.find((s) => s.id === input.submissionId);
    const gates: Gate[] = [];
    const [aidState, status] = await Promise.all([k.aid.stateName(node.body.address), node.body.status()]);
    gates.push(safetyGate(aidState, status, "plain"));
    if (!sub) gates.push(refused("input", `tender ${input.tokenId} has no submission ${input.submissionId}`));
    else if (getAddress(sub.fulfiller) !== getAddress(node.body.address)) gates.push(refused("policy", `submission ${input.submissionId} is ${sub.fulfiller}'s, not the cell's`));
    else if (sub.status !== 0) gates.push(refused("policy", `submission ${input.submissionId} is not pending (status ${sub.status})`));
    else gates.push(ok("policy", `submission ${input.submissionId} by the cell is pending`));
    const now = await node.now();
    if (view.facts.settleBy !== 0n && Number(view.facts.settleBy) <= now) gates.push(refused("policy", "past settleBy"));
    const jobId = input.jobId ?? `${tenderJobId(id, view.facts.completions)}:settle`;
    const intent: Intent = { target: k.tenders.address, value: 0n, data: k.tenders.encodeSettle(id, sid, proof), label: `settleFulfillment(${input.tokenId}, ${input.submissionId})` };
    const before = await node.body.balance();
    return {
      job: { id: jobId, kind: "tender-settle", input: { tokenId: input.tokenId, submissionId: input.submissionId, proofHash: sha256Hex(proof) } },
      gates,
      valueWei: 0n,
      steps: [{ name: "settle", kind: "plain", build: () => intent }],
      output: async (confirmed) => {
        const c = confirmed[0];
        const [after, credit, s] = await Promise.all([node.body.balance(), k.tenders.creditOf(id, node.body.address), k.tenders.submissionOf(id, sid)]);
        return { tokenId: input.tokenId, submissionId: input.submissionId, txHash: c.txHash, operationId: `job:${jobId}:settle`, jobId, paidWei: (after > before ? after - before : 0n).toString(), creditWei: credit.toString(), status: s.status };
      },
    };
  },
};

export const credit_withdraw: ActCapability = {
  name: "credit_withdraw",
  title: "Withdraw credited reward",
  description: "Withdraw the cell's credited reward of a tender (ERC-8414 withdrawCredit), a de-risk action the account allows under a derisk-only suspension.",
  action: "act",
  visibility: "caller",
  principal: "cell",
  ercs: [8414],
  input: z.object({ tokenId: zUint, jobId: zJobId }),
  output: z.object({ tokenId: zUint, withdrawnWei: zUint, txHash: z.string(), operationId: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const id = BigInt(input.tokenId);
    const credit = await k.tenders.creditOf(id, node.body.address);
    const [aidState, status] = await Promise.all([k.aid.stateName(node.body.address), node.body.status()]);
    const gates: Gate[] = [safetyGate(aidState, status, "derisk")];
    if (credit === 0n) gates.push(refused("policy", `no credit of tender ${input.tokenId} is due to the cell`));
    else gates.push(ok("policy", `${credit} wei credited`));
    const jobId = input.jobId ?? derivedJobId(`credit-withdraw:${input.tokenId}`, { credit: credit.toString() });
    return {
      job: { id: jobId, kind: "withdraw", input: { tokenId: input.tokenId } },
      gates,
      valueWei: 0n,
      steps: [{ name: "withdraw", kind: "derisk", build: () => ({ target: k.tenders.address, value: 0n, data: k.tenders.encodeWithdrawCredit(id, node.body.address), label: `withdrawCredit(${input.tokenId}, cell)` }) }],
      output: (confirmed) => ({ tokenId: input.tokenId, withdrawnWei: credit.toString(), txHash: confirmed[0].txHash, operationId: `job:${jobId}:withdraw`, jobId }),
    };
  },
};

const MintInput = z.object({
  skill: z.string(),
  packageHash: zBytes32,
  input: z.unknown(),
  answerHash: zBytes32,
  rewardWei: zUint,
  /** Seconds from now. */
  submitIn: z.coerce.number().int().positive(),
  settleIn: z.coerce.number().int().positive(),
  judgmentWindowSeconds: z.coerce.number().int().positive().default(7 * 86400),
  title: z.string().max(200).optional(),
  deliverable: z.string().max(500).optional(),
  /** Whether to fund and commit the answer in the same job (default) or mint only. */
  fundAndCommit: zBool.default(true),
  /** Also register an ERC-8444 task record for discovery (act mode). */
  record: zBool.default(false),
  as: zAs,
  jobId: zJobId,
});

export const tender_mint: ActCapability = {
  name: "tender_mint",
  title: "Mint a hashlock tender",
  description: "The demander's side: mint an ERC-8414 tender for a skill run with a foga.task/1 document, fund it with the reward and commit the answer hash in the hashlock verifier (one job, three operations), optionally with an ERC-8444 task record. In build mode the three calls are returned for the caller's own account.",
  action: "act",
  visibility: "caller",
  principal: "cell",
  ercs: [8414, 8444],
  input: MintInput,
  output: z.object({ tokenId: zUint, taskHash: zBytes32, answerHash: zBytes32, rewardWei: zUint, submitBy: z.number(), settleBy: z.number(), operations: z.array(z.string()), jobId: z.string(), recordId: zBytes32.nullable() }),
  async plan(ctx, input) {
    const { node } = ctx;
    const k = node.kernel;
    const now = await node.now();
    const reward = BigInt(input.rewardWei);
    const submitBy = now + input.submitIn;
    const settleBy = now + input.settleIn;
    if (settleBy <= submitBy) throw new Error("settleIn must be later than submitIn");
    const task = { schema: "foga.task/1", skill: input.skill, packageHash: input.packageHash, input: input.input, acceptance: { mode: "verifier", profile: "x-hashlock-v1", verifier: k.tenders.hashlockAddress, answerHash: input.answerHash }, deliverable: input.deliverable ?? "the canonical answer; resultHash = sha256(answer || fulfiller)" };
    TaskDocumentSchema.parse(task);
    const taskURI = dataUri(task);
    const taskHash = sha256Hex(JSON.stringify(task));
    const tdHash = keccakJcs({ td: "foga.task/1", skill: input.skill });
    const terms = nativeTerms(reward, { submitBy: BigInt(submitBy), settleBy: BigInt(settleBy), judgmentWindow: BigInt(input.judgmentWindowSeconds) });
    const owner = ctx.mode === "build" ? ctx.as : node.body.address;
    const jobId = input.jobId ?? derivedJobId("tender-mint", { skill: input.skill, input: input.input, answerHash: input.answerHash, rewardWei: input.rewardWei, submitBy, settleBy, owner });
    const gates: Gate[] = [];
    if (ctx.mode !== "build") {
      const [aidState, status] = await Promise.all([k.aid.stateName(node.body.address), node.body.status()]);
      gates.push(safetyGate(aidState, status, "plain"));
      const balance = await node.body.balance();
      if (input.fundAndCommit && balance < reward) gates.push(refused("budget", `the account holds ${balance} wei; the reward is ${reward} wei`));
    }
    const mintIntent = (): Intent => ({ target: k.tenders.address, value: 0n, data: k.tenders.encodeMint({ to: owner, updateAuthority: owner, acceptanceAuthority: k.tenders.hashlockAddress, tdHash, taskHash, taskURI, terms }), label: `mintTask(${input.skill}, reward ${reward})` });
    const tokenOf = (prior: { receipt: unknown }[]) => k.tenders.tokenIdFromReceipt(prior[0].receipt);
    const steps = [
      { name: "mint", kind: "plain" as const, build: mintIntent },
      ...(input.fundAndCommit
        ? [
            { name: "fund", kind: "plain" as const, build: (prior: { receipt: unknown }[]) => ({ target: k.tenders.address, value: reward, data: k.tenders.encodeFund(tokenOf(prior), reward), label: `fundTask(reward ${reward})` }) },
            { name: "commit", kind: "plain" as const, build: (prior: { receipt: unknown }[]) => ({ target: k.tenders.hashlockAddress, value: 0n, data: k.tenders.encodeCommitAnswer(tokenOf(prior), input.answerHash), label: `commitAnswer(${input.answerHash.slice(0, 10)}…)` }) },
          ]
        : []),
      ...(input.record && ctx.mode !== "build"
        ? [
            {
              name: "record",
              kind: "plain" as const,
              build: (prior: { receipt: unknown }[]) => {
                const tokenId = tokenOf(prior);
                const desc = taskDescriptor({ chainId: node.chainId, demander: owner, slug: `tender-${tokenId}`, name: input.title ?? `${input.skill} tender ${tokenId}`, wants: input.deliverable ?? `a run of ${input.skill}`, taskHash, taskURI, bounty: { amount: (Number(reward) / 1e18).toString(), currency: "ETH", asset: `eip155:${node.chainId}/slip44:60` }, acceptance: { mode: "verifier", ref: accountRef(node.chainId, k.tenders.hashlockAddress) }, settleBy, judgmentWindow: `PT${input.judgmentWindowSeconds}S` });
                return { target: k.ard.address, value: 0n, data: k.ard.encodeRegister(kindId("task"), k.tenders.address, tokenId, desc), label: `ARD register(task ${tokenId})` };
              },
            },
          ]
        : []),
    ];
    // build mode: the calls for the caller's own account, the token id taken from nextId()
    let calls: Intent[] | undefined;
    if (ctx.mode === "build") {
      const next = await k.tenders.nextId();
      calls = [mintIntent()];
      if (input.fundAndCommit) calls.push({ target: k.tenders.address, value: reward, data: k.tenders.encodeFund(next, reward), label: `fundTask(${next}, ${reward}) — token id assumed from nextId()` }, { target: k.tenders.hashlockAddress, value: 0n, data: k.tenders.encodeCommitAnswer(next, input.answerHash), label: `commitAnswer(${next}) — token id assumed from nextId()` });
    }
    return {
      job: { id: jobId, kind: "tender-mint", input: { task, rewardWei: input.rewardWei, submitBy, settleBy, owner } },
      gates,
      valueWei: input.fundAndCommit ? reward : 0n,
      steps,
      calls,
      output: (confirmed) => {
        const tokenId = confirmed.length ? k.tenders.tokenIdFromReceipt(confirmed[0].receipt) : 0n;
        const recordStep = steps.findIndex((s) => s.name === "record");
        const recordId = recordStep >= 0 && confirmed[recordStep] ? k.ard.recordIdFromReceipt(confirmed[recordStep].receipt) : null;
        return { tokenId: tokenId.toString(), taskHash, answerHash: input.answerHash, rewardWei: input.rewardWei, submitBy, settleBy, operations: steps.slice(0, confirmed.length).map((s) => `job:${jobId}:${s.name}`), jobId, recordId };
      },
    };
  },
};

export const tender_fund: ActCapability = {
  name: "tender_fund",
  title: "Fund a tender",
  description: "Add native value to a tender's escrow (ERC-8414 fundTask) from the cell, or as calldata for another funder.",
  action: "act",
  visibility: "caller",
  principal: "cell",
  ercs: [8414],
  input: z.object({ tokenId: zUint, amountWei: zUint, as: zAs, jobId: zJobId }),
  output: z.object({ tokenId: zUint, amountWei: zUint, escrowWei: zUint, txHash: z.string().nullable(), operationId: z.string().nullable(), jobId: z.string() }),
  async plan(ctx, input) {
    const { node } = ctx;
    const k = node.kernel;
    const id = BigInt(input.tokenId);
    const amount = BigInt(input.amountWei);
    const gates: Gate[] = [];
    if (ctx.mode !== "build") {
      const [aidState, status] = await Promise.all([k.aid.stateName(node.body.address), node.body.status()]);
      gates.push(safetyGate(aidState, status, "plain"));
      const balance = await node.body.balance();
      if (balance < amount) gates.push(refused("budget", `the account holds ${balance} wei; ${amount} wei asked`));
    }
    const jobId = input.jobId ?? derivedJobId(`tender-fund:${input.tokenId}`, { amount: input.amountWei, escrowBefore: (await k.tenders.escrowBalanceOf(id)).toString() });
    const intent: Intent = { target: k.tenders.address, value: amount, data: k.tenders.encodeFund(id, amount), label: `fundTask(${input.tokenId}, ${amount})` };
    return {
      job: { id: jobId, kind: "tender-fund", input: { tokenId: input.tokenId, amountWei: input.amountWei } },
      gates,
      valueWei: amount,
      steps: [{ name: "fund", kind: "plain", build: () => intent }],
      calls: [intent],
      output: async (confirmed) => ({ tokenId: input.tokenId, amountWei: input.amountWei, escrowWei: (await k.tenders.escrowBalanceOf(id)).toString(), txHash: confirmed[0]?.txHash ?? null, operationId: confirmed.length ? `job:${jobId}:fund` : null, jobId }),
    };
  },
};

export const TENDER_CAPABILITIES: ActCapability[] = [tender_precheck, skill_run, tender_submit, tender_settle, credit_withdraw, tender_mint, tender_fund];

/** For other modules: the gates of taking a tender, as the precheck computes them. */
export { takingGates };
export type { ActContext };

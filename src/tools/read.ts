import { existsSync, readFileSync } from "node:fs";
import { getAddress } from "ethers";
import { z } from "zod";
import { accountRef } from "../core/canonical.js";
import { accountSubject } from "../core/kya.js";
import type { Node } from "../node/node.js";
import { TenderOutputSchema, readTender, tenderOutput, zAddress, zBool, zBytes32, zUint } from "./common.js";
import type { ReadCapability } from "./types.js";

/**
 * The read capabilities: chain and store, no key, no decision record. Public ones answer anyone; `caller` ones
 * return the caller's own jobs and operations (the operator sees every one); `evidence_export` is the operator's.
 */
const str = (v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export const world_describe: ReadCapability = {
  name: "world_describe",
  title: "Describe the world",
  description: "The world this cell lives in: id, chain, network, the contracts by id, the bundle hash, and the latest doctor summary when a report sits next to the world file.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8338, 8414, 8419, 8434, 8436, 8444, 8447, 8454, 8468, 8471, 8004],
  input: z.object({}),
  output: z.object({
    worldId: z.string(),
    chainId: z.number(),
    network: z.string(),
    bundleHash: z.string(),
    contracts: z.record(z.string(), zAddress),
    doctor: z.object({ summary: z.record(z.string(), z.number()), at: z.string().optional() }).nullable(),
  }),
  async handler({ node }) {
    const w = node.world.file;
    let doctor: { summary: Record<string, number>; at?: string } | null = null;
    const candidate = node.worldPath.replace(/\.json$/, ".doctor.json");
    if (existsSync(candidate)) {
      try {
        const r = JSON.parse(readFileSync(candidate, "utf8"));
        if (r?.summary) doctor = { summary: r.summary, at: r.ranAt ?? r.at };
      } catch {
        doctor = null;
      }
    }
    return { worldId: w.worldId, chainId: w.chainId, network: w.network, bundleHash: w.bundleHash, contracts: Object.fromEntries(Object.entries(w.contracts).map(([id, c]) => [id, c.address])), doctor };
  },
};

export const identity_resolve: ReadCapability = {
  name: "identity_resolve",
  title: "Resolve an identity",
  description: "The ten-ERC view of an address: ERC-8004 agent, ERC-8434 state in the reference and backing registries, ERC-8444 agent record, KYA level under the cell's standing scheme, ERC-8468 status when the address is a cell account.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8004, 8434, 8444, 8419, 8468],
  input: z.object({ address: zAddress }),
  output: z.object({
    address: zAddress,
    aid: z.string(),
    isContract: z.boolean(),
    agent: z.object({ registry: zAddress, agentId: zUint, owner: zAddress.nullable() }).nullable(),
    liveness: z.object({ registry: zAddress, state: z.string(), lastSeen: z.number() }).array(),
    record: z.object({ recordId: zBytes32, status: z.number(), backed: z.boolean(), descriptorURI: z.string() }).nullable(),
    standing: z.object({ schemeId: zBytes32, level: z.number(), expiresAt: z.number() }).nullable(),
    safety: z.object({ verdict: z.string(), reasons: z.array(z.string()), restrictions: z.array(z.number()), bindings: z.array(zBytes32) }).nullable(),
  }),
  async handler({ node }, { address }) {
    const k = node.kernel;
    const addr = getAddress(address);
    const code = await node.world.provider.getCode(addr);
    const liveness: { registry: string; state: string; lastSeen: number }[] = [];
    let agent: { registry: string; agentId: string; owner: string | null } | null = null;
    for (const registry of [k.aid.address, ...(k.aid.backing ? [k.aid.backing.address] : [])]) {
      try {
        const [state, bound] = await Promise.all([k.aid.stateName(addr, registry), k.aid.at(registry).bindingOf(addr)]);
        const lastSeen = Number(await k.aid.at(registry).lastSeen(addr).catch(() => 0n));
        liveness.push({ registry, state, lastSeen });
        if (!agent && bound && String(bound.registry) !== "0x0000000000000000000000000000000000000000") {
          const agentId = BigInt(bound.agentId);
          const owner = await k.identity.ownerOf(agentId).catch(() => null);
          agent = { registry: String(bound.registry), agentId: agentId.toString(), owner: owner ? getAddress(owner) : null };
        }
      } catch {
        /* not an anchor in this registry */
      }
    }
    let record: { recordId: string; status: number; backed: boolean; descriptorURI: string } | null = null;
    try {
      const recordId = k.ard.recordIdOf(addr, 0n);
      const r = await k.ard.recordOf(recordId);
      if (r.kind !== "0x" + "00".repeat(32)) record = { recordId, status: r.status, backed: await k.ard.backed(recordId), descriptorURI: r.descriptorURI.length > 200 ? r.descriptorURI.slice(0, 200) + "…" : r.descriptorURI };
    } catch {
      record = null;
    }
    let standing: { schemeId: string; level: number; expiresAt: number } | null = null;
    const st = node.config.identity.standing;
    if (st) {
      try {
        const r = await k.kya.resolve(accountSubject(node.chainId, addr), st.schemeId, st.issuers);
        standing = { schemeId: st.schemeId, level: r.level, expiresAt: Number(r.expiresAt) };
      } catch {
        standing = null;
      }
    }
    let safety: { verdict: string; reasons: string[]; restrictions: number[]; bindings: string[] } | null = null;
    if (code !== "0x") {
      try {
        const { Cell } = await import("../kernel/cell.js");
        const probe = new Cell(k, "probe", addr, { owner: "owner", operator: "operator", guardian: addr });
        const [status, bindings] = await Promise.all([probe.status(), probe.presentedBindings()]);
        safety = { verdict: status.verdictName, reasons: status.reasonNames, restrictions: status.restrictions, bindings };
      } catch {
        safety = null;
      }
    }
    return { address: addr, aid: accountRef(node.chainId, addr), isContract: code !== "0x", agent, liveness, record, standing, safety };
  },
};

export const tender_list: ReadCapability = {
  name: "tender_list",
  title: "List tenders",
  description: "Tenders minted within the lookback window (ERC-8414 TaskUpdated events), newest first; by default only those still open (funded, not cancelled, completions left, deadlines ahead).",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8414],
  input: z.object({ lookbackBlocks: z.coerce.number().int().min(1).max(100_000).optional(), includeClosed: zBool.default(false), limit: z.coerce.number().int().min(1).max(200).default(50) }),
  output: z.object({ fromBlock: z.number(), toBlock: z.number(), tenders: z.array(TenderOutputSchema) }),
  async handler({ node }, input) {
    const k = node.kernel;
    const head = await k.blockNumber();
    const fromBlock = Math.max(0, head - (input.lookbackBlocks ?? node.config.policy.tenders.lookbackBlocks));
    const token = k.tenders.contract();
    const events = await token.queryFilter(token.filters.TaskUpdated(), fromBlock, head);
    const ids = [...new Set(events.map((e: any) => BigInt(e.args.tokenId).toString()))].map((s) => BigInt(s)).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
    const now = await node.now();
    const out: ReturnType<typeof tenderOutput>[] = [];
    for (const id of ids) {
      if (out.length >= input.limit) break;
      const v = await readTender(node, id);
      const f = v.facts;
      const open = !f.cancelled && f.escrowWei >= f.rewardWei && (f.maxCompletions === 0n || f.completions < f.maxCompletions) && (f.submitBy === 0n || Number(f.submitBy) > now) && (f.settleBy === 0n || Number(f.settleBy) > now);
      if (open || input.includeClosed) out.push(tenderOutput(v));
    }
    return { fromBlock, toBlock: head, tenders: out };
  },
};

export const tender_inspect: ReadCapability = {
  name: "tender_inspect",
  title: "Inspect a tender",
  description: "One tender's terms, acceptance authority, escrow, deadlines, task document (when the task URI is a data: URI) and submissions.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8414, 8444],
  input: z.object({ tokenId: zUint }),
  output: TenderOutputSchema,
  async handler({ node }, { tokenId }) {
    return tenderOutput(await readTender(node, BigInt(tokenId)));
  },
};

const SkillOutput = z.object({ name: z.string().nullable(), tokenId: zUint, owner: zAddress, mdHash: zBytes32, packageHash: zBytes32, version: z.number(), skillURI: z.string(), record: z.object({ recordId: zBytes32, backed: z.boolean() }).nullable() });

async function skillView(node: Node, tokenId: bigint, name: string | null) {
  const k = node.kernel;
  const [onchain, owner, skillURI] = await Promise.all([k.skills.skillOf(tokenId), k.skills.ownerOf(tokenId), k.skills.skillURI(tokenId).catch(() => "")]);
  let record: { recordId: string; backed: boolean } | null = null;
  try {
    const recordId = k.ard.recordIdOf(k.skills.address, tokenId);
    const r = await k.ard.recordOf(recordId);
    if (r.kind !== "0x" + "00".repeat(32)) record = { recordId, backed: await k.ard.backed(recordId) };
  } catch {
    record = null;
  }
  return { name, tokenId: tokenId.toString(), owner: getAddress(owner), mdHash: onchain.mdHash, packageHash: onchain.packageHash, version: Number(onchain.version), skillURI: skillURI.length > 200 ? skillURI.slice(0, 200) + "…" : skillURI, record };
}

export const skill_list: ReadCapability = {
  name: "skill_list",
  title: "List skills",
  description: "The skill tokens a holder has: the cell's own from its configuration (verified against the chain), another holder's from the token's Transfer events in the lookback window.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8338, 8444],
  input: z.object({ holder: zAddress.optional(), lookbackBlocks: z.coerce.number().int().min(1).max(100_000).optional() }),
  output: z.object({ holder: zAddress, offered: z.array(z.string()), skills: z.array(SkillOutput) }),
  async handler({ node }, input) {
    const k = node.kernel;
    const holder = getAddress(input.holder ?? node.body.address);
    if (holder === getAddress(node.body.address)) {
      const held = await node.heldSkills();
      const skills = [];
      for (const h of held) skills.push(await skillView(node, h.tokenId, h.name));
      return { holder, offered: node.config.skills.offered, skills };
    }
    const head = await k.blockNumber();
    const from = Math.max(0, head - (input.lookbackBlocks ?? node.config.policy.tenders.lookbackBlocks));
    const token = k.skills.contract();
    const events = await token.queryFilter(token.filters.Transfer(null, holder), from, head);
    const ids = [...new Set(events.map((e: any) => BigInt(e.args.tokenId).toString()))].map((s) => BigInt(s));
    const skills = [];
    for (const id of ids) {
      const owner = await k.skills.ownerOf(id);
      if (getAddress(owner) === holder) skills.push(await skillView(node, id, null));
    }
    return { holder, offered: [], skills };
  },
};

export const skill_inspect: ReadCapability = {
  name: "skill_inspect",
  title: "Inspect a skill",
  description: "One skill token's commitment (mdHash, packageHash, version), owner, URI and ARD record.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8338, 8444],
  input: z.object({ tokenId: zUint }),
  output: SkillOutput,
  async handler({ node }, { tokenId }) {
    const id = BigInt(tokenId);
    const name = Object.entries(node.config.skills.held).find(([, h]) => h.tokenId === tokenId)?.[0] ?? null;
    return skillView(node, id, name);
  },
};

export const cell_status: ReadCapability = {
  name: "cell_status",
  title: "The cell's status",
  description: "The node's own cell: account and roles, anchor state in each registry, binding verdict, held and offered skills, policy summary; for the operator also the budget books, open operations and running jobs.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8434, 8468, 8004],
  input: z.object({}),
  output: z.object({
    name: z.string(),
    account: zAddress,
    owner: zAddress,
    operator: zAddress,
    guardian: zAddress,
    agentId: zUint.nullable(),
    accountVersion: z.number(),
    liveness: z.array(z.object({ registry: zAddress, state: z.string() })),
    safety: z.object({ verdict: z.string(), reasons: z.array(z.string()), restrictions: z.array(z.number()) }),
    skills: z.object({ held: z.array(z.string()), offered: z.array(z.string()) }),
    policy: z.object({ dailyValueWei: zUint, perOperationValueWei: zUint, dailyGasWei: zUint, maxConcurrentCommitments: z.number(), minRewardWei: zUint, acceptance: z.array(z.string()) }),
    budget: z.object({ valueWei: zUint, gasWei: zUint, reservedValueWei: zUint, reservedFeeWei: zUint, runningCommitments: z.number(), operatorBalanceWei: zUint, accountBalanceWei: zUint }).nullable(),
    open: z.object({ operations: z.array(z.string()), jobs: z.array(z.string()) }).nullable(),
  }),
  async handler({ node, caller }) {
    const k = node.kernel;
    const cell = node.body;
    const cfg = node.config;
    const liveness: { registry: string; state: string }[] = [];
    for (const registry of [k.aid.address, ...(k.aid.backing ? [k.aid.backing.address] : [])]) liveness.push({ registry, state: await k.aid.stateName(cell.address, registry) });
    const status = await cell.status();
    let version = 1;
    try {
      version = Number(await cell.contract().ACCOUNT_VERSION());
    } catch {
      version = 1;
    }
    const operator = caller.visibility === "operator";
    const use = operator ? node.budgetUse() : null;
    const [opBal, accBal] = operator ? await Promise.all([k.balance(cfg.identity.operator), cell.balance()]) : [0n, 0n];
    return {
      name: cfg.name,
      account: cell.address,
      owner: cfg.identity.owner,
      operator: cfg.identity.operator,
      guardian: cfg.identity.guardian,
      agentId: cfg.identity.agentId ?? null,
      accountVersion: version,
      liveness,
      safety: { verdict: status.verdictName, reasons: status.reasonNames, restrictions: status.restrictions },
      skills: { held: Object.keys(cfg.skills.held), offered: cfg.skills.offered },
      policy: { ...cfg.policy.budget, minRewardWei: cfg.policy.tenders.minRewardWei, acceptance: cfg.policy.tenders.acceptance },
      budget: use ? { valueWei: use.valueWei.toString(), gasWei: use.gasWei.toString(), reservedValueWei: use.reservedValueWei.toString(), reservedFeeWei: use.reservedFeeWei.toString(), runningCommitments: use.runningCommitments, operatorBalanceWei: opBal.toString(), accountBalanceWei: accBal.toString() } : null,
      open: operator ? { operations: node.store.openOps("operator").map((o) => o.key), jobs: node.store.jobs(null, 200).filter((j) => j.status === "accepted" || j.status === "running").map((j) => j.id) } : null,
    };
  },
};

const OperationOutput = z.object({ key: z.string(), kind: z.string(), signer: z.string(), status: z.string(), txHash: z.string().nullable(), block: z.number().nullable(), nonce: z.number().nullable(), attempts: z.number(), replacements: z.number(), error: z.string().nullable(), capability: z.string().nullable(), caller: z.string().nullable(), valueWei: zUint, gasCostWei: zUint.nullable(), result: z.unknown().nullable(), updatedAt: z.string() });
const JobOutput = z.object({ id: z.string(), kind: z.string(), status: z.string(), caller: z.string().nullable(), inputHash: z.string(), operations: z.array(z.string()), result: z.unknown().nullable(), error: z.string().nullable(), createdAt: z.string(), updatedAt: z.string() });

function mayseeJob(caller: { id: string; visibility: string }, jobCaller: string | null): boolean {
  return caller.visibility === "operator" || (jobCaller !== null && jobCaller === caller.id);
}

export const operation_status: ReadCapability = {
  name: "operation_status",
  title: "An operation's status",
  description: "One keyed operation of the store (prepared, sent, confirmed, failed; hash, block, cost). A caller sees the operations of its own jobs; an operation id is a locator, not a pass.",
  action: "read",
  visibility: "caller",
  principal: "none",
  ercs: [],
  input: z.object({ operationId: z.string().min(1) }),
  output: OperationOutput.nullable(),
  async handler({ node, caller }, { operationId }) {
    const op = node.store.get(operationId);
    if (!op) return null;
    if (!mayseeJob(caller, op.caller)) return null;
    return { key: op.key, kind: op.kind, signer: op.signer, status: op.status, txHash: op.txHash, block: op.block, nonce: op.nonce, attempts: op.attempts, replacements: op.replacements, error: op.error, capability: op.capability, caller: op.caller, valueWei: op.valueWei.toString(), gasCostWei: op.gasCostWei === null ? null : op.gasCostWei.toString(), result: op.result, updatedAt: op.updatedAt };
  },
};

export const job_status: ReadCapability = {
  name: "job_status",
  title: "A job's status",
  description: "One job (a tender taken, a skill run): its state, result and the operations it made. A caller sees its own jobs.",
  action: "read",
  visibility: "caller",
  principal: "none",
  ercs: [],
  input: z.object({ jobId: z.string().min(1) }),
  output: JobOutput.nullable(),
  async handler({ node, caller }, { jobId }) {
    const job = node.store.getJob(jobId);
    if (!job || !mayseeJob(caller, job.caller)) return null;
    return { id: job.id, kind: job.kind, status: job.status, caller: job.caller, inputHash: job.inputHash, operations: job.operations, result: job.result, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt };
  },
};

export const operation_list: ReadCapability = {
  name: "operation_list",
  title: "List jobs and operations",
  description: "The caller's jobs (newest first) with their operations; the operator sees every job and operation of the store.",
  action: "read",
  visibility: "caller",
  principal: "none",
  ercs: [],
  input: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
  output: z.object({ jobs: z.array(JobOutput), operations: z.array(OperationOutput) }),
  async handler({ node, caller }, { limit }) {
    const jobs = node.store.jobs(caller.visibility === "operator" ? null : caller.id, limit);
    const keys = new Set(jobs.flatMap((j) => j.operations));
    const operations = caller.visibility === "operator" ? node.store.all().slice(-limit) : node.store.all().filter((o) => keys.has(o.key));
    return {
      jobs: jobs.map((job) => ({ id: job.id, kind: job.kind, status: job.status, caller: job.caller, inputHash: job.inputHash, operations: job.operations, result: job.result, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt })),
      operations: operations.map((op) => ({ key: op.key, kind: op.kind, signer: op.signer, status: op.status, txHash: op.txHash, block: op.block, nonce: op.nonce, attempts: op.attempts, replacements: op.replacements, error: op.error, capability: op.capability, caller: op.caller, valueWei: op.valueWei.toString(), gasCostWei: op.gasCostWei === null ? null : op.gasCostWei.toString(), result: op.result, updatedAt: op.updatedAt })),
    };
  },
};

const DecisionOutput = z.object({ id: z.number(), at: z.string(), entrance: z.string(), caller: z.string(), capability: z.string(), mode: z.string(), inputHash: z.string(), verdict: z.string(), gate: z.string(), reason: z.string(), jobId: z.string().nullable(), operationId: z.string().nullable(), model: z.object({ provider: z.string(), model: z.string(), promptHash: z.string(), responseHash: z.string() }).nullable() });

export const decision_list: ReadCapability = {
  name: "decision_list",
  title: "List decision records",
  description: "Decision records, oldest first: every act attempt, allowed or refused, with the gate and reason. A caller sees its own; the operator every one.",
  action: "read",
  visibility: "caller",
  principal: "none",
  ercs: [],
  input: z.object({ capability: z.string().optional(), verdict: z.enum(["allowed", "refused"]).optional(), limit: z.coerce.number().int().min(1).max(1000).default(200) }),
  output: z.object({ decisions: z.array(DecisionOutput) }),
  async handler({ node, caller }, input) {
    const decisions = node.store.decisions({ caller: caller.visibility === "operator" ? null : caller.id, capability: input.capability, verdict: input.verdict, limit: input.limit });
    return { decisions };
  },
};

export const evidence_export: ReadCapability = {
  name: "evidence_export",
  title: "Export the node's evidence",
  description: "The operator's view of the store: every decision record, job, operation and fact, with the store's summary — what a reviewer of the node's conduct reads.",
  action: "read",
  visibility: "operator",
  principal: "none",
  ercs: [],
  input: z.object({}),
  output: z.object({ schema: z.literal("foga.node-evidence/1"), cell: z.string(), account: zAddress, worldId: z.string(), exportedAt: z.string(), summary: z.unknown(), decisions: z.array(DecisionOutput), jobs: z.array(JobOutput), operations: z.array(OperationOutput), facts: z.record(z.string(), z.unknown()) }),
  async handler({ node }) {
    const ops = node.store.all();
    return {
      schema: "foga.node-evidence/1" as const,
      cell: node.config.name,
      account: node.body.address,
      worldId: node.world.file.worldId,
      exportedAt: new Date().toISOString(),
      summary: node.store.summary(),
      decisions: node.store.decisions({ limit: 100_000 }),
      jobs: node.store.jobs(null, 100_000).map((job) => ({ id: job.id, kind: job.kind, status: job.status, caller: job.caller, inputHash: job.inputHash, operations: job.operations, result: job.result, error: job.error, createdAt: job.createdAt, updatedAt: job.updatedAt })),
      operations: ops.map((op) => ({ key: op.key, kind: op.kind, signer: op.signer, status: op.status, txHash: op.txHash, block: op.block, nonce: op.nonce, attempts: op.attempts, replacements: op.replacements, error: op.error, capability: op.capability, caller: op.caller, valueWei: op.valueWei.toString(), gasCostWei: op.gasCostWei === null ? null : op.gasCostWei.toString(), result: op.result, updatedAt: op.updatedAt })),
      facts: JSON.parse(JSON.stringify(node.store.facts(), (_k, v) => str(v))),
    };
  },
};

export const kya_check: ReadCapability = {
  name: "kya_check",
  title: "Check a KYA level",
  description: "An account's level under a KYA scheme as resolved by the registry for the given issuers (the cell's standing scheme and issuers by default).",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8419],
  input: z.object({ address: zAddress, schemeId: zBytes32.optional(), issuers: z.array(zAddress).optional(), minLevel: z.coerce.number().int().min(0).optional() }),
  output: z.object({ address: zAddress, schemeId: zBytes32, issuers: z.array(zAddress), level: z.number(), expiresAt: z.number(), assertionId: zBytes32, meets: z.boolean().nullable() }),
  async handler({ node }, input) {
    const st = node.config.identity.standing;
    const schemeId = input.schemeId ?? st?.schemeId;
    const issuers = input.issuers ?? st?.issuers;
    if (!schemeId || !issuers?.length) throw new Error("no scheme: pass schemeId and issuers, or configure identity.standing");
    const subject = accountSubject(node.chainId, input.address);
    const r = await node.kernel.kya.resolve(subject, schemeId, issuers);
    const meets = input.minLevel === undefined ? null : await node.kernel.kya.check(subject, schemeId, input.minLevel, issuers);
    return { address: getAddress(input.address), schemeId, issuers, level: r.level, expiresAt: Number(r.expiresAt), assertionId: r.assertionId, meets };
  },
};

export const safety_status: ReadCapability = {
  name: "safety_status",
  title: "Safety status",
  description: "The ERC-8468 verdict on a cell account (the node's own by default): verdict, reasons, restrictions, the presented bindings and their states.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8468],
  input: z.object({ address: zAddress.optional() }),
  output: z.object({ address: zAddress, verdict: z.string(), reasons: z.array(z.string()), restrictions: z.array(z.number()), bindings: z.array(z.object({ bindingId: zBytes32, state: z.string(), restrictions: z.number(), validUntil: z.number() })) }),
  async handler({ node }, input) {
    const { Cell } = await import("../kernel/cell.js");
    const { BindingStateName } = await import("../core/asf.js");
    const address = getAddress(input.address ?? node.body.address);
    const cell = input.address && getAddress(input.address) !== getAddress(node.body.address) ? new Cell(node.kernel, "probe", address, { owner: "owner", operator: "operator", guardian: address }) : node.body;
    const [status, ids] = await Promise.all([cell.status(), cell.presentedBindings()]);
    const bindings = [];
    for (const bindingId of ids) {
      const b = await node.kernel.asf.bindingOf(bindingId);
      bindings.push({ bindingId, state: BindingStateName[b.state] ?? String(b.state), restrictions: b.restrictions, validUntil: Number(b.validUntil) });
    }
    return { address, verdict: status.verdictName, reasons: status.reasonNames, restrictions: status.restrictions, bindings };
  },
};

export const READ_CAPABILITIES: ReadCapability[] = [world_describe, identity_resolve, tender_list, tender_inspect, skill_list, skill_inspect, cell_status, operation_status, job_status, operation_list, decision_list, evidence_export, kya_check, safety_status];

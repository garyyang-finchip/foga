import { getAddress } from "ethers";
import { z } from "zod";
import { accountSubject } from "../core/kya.js";
import { parseDataUri, sha256Hex, jcs } from "../core/canonical.js";
import { PROBE_RPC_FAILURE } from "../genesis/probe.js";
import type { Node } from "../node/node.js";
import type { TenderFacts } from "../node/policy.js";

/** Shared schema fragments. */
export const zAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an address (0x + 40 hex digits)");
export const zBytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "a 32-byte hex value");
export const zUint = z.string().regex(/^\d+$/, "a decimal integer");
export const zHex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, "hex bytes");
/** A boolean that also reads "true" / "false" (CLI flags). */
export const zBool = z.preprocess((v) => (v === "true" ? true : v === "false" ? false : v), z.boolean());
/** The caller's idempotency key for a job; derived from the semantic input when absent. */
export const zJobId = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_.-]+$/, "a job id: letters, digits, : _ . -").optional();
/** The account a build is for (`build` mode): a third party gets calldata it can execute itself. */
export const zAs = zAddress.optional().describe("build mode: the account the calldata is for (default: the cell)");

/** A task document a tender points at (foga.task/1), as the genesis publishes it. */
export const TaskDocumentSchema = z.object({
  schema: z.literal("foga.task/1"),
  skill: z.string(),
  packageHash: zBytes32,
  input: z.unknown(),
  acceptance: z.object({ mode: z.string(), profile: z.string().optional(), verifier: zAddress.optional(), answerHash: zBytes32.optional() }).passthrough(),
  deliverable: z.string().optional(),
});
export type TaskDocument = z.infer<typeof TaskDocumentSchema>;

export interface TenderView {
  facts: TenderFacts;
  demander: string;
  taskURI: string;
  /** The task document when the URI is a data: URI holding a foga.task/1 document; null otherwise (nothing is fetched). */
  task: TaskDocument | null;
  taskHash: string;
  tdHash: string;
  version: number;
  submissions: { id: string; fulfiller: string; status: number; machineSettled: boolean; resultHash: string }[];
}

/** Everything the policy and the capabilities need to know about one tender, read from the chain. */
export async function readTender(node: Node, tokenId: bigint, opts: { counterparty?: boolean } = {}): Promise<TenderView> {
  const k = node.kernel;
  const token = k.tenders.contract();
  const [terms, authority, escrow, cancelled, completions, demander, taskURI, binding] = await Promise.all([
    k.tenders.terms(tokenId),
    k.tenders.acceptanceAuthorityOf(tokenId),
    k.tenders.escrowBalanceOf(tokenId),
    k.tenders.isCancelled(tokenId),
    token.completionsOf(tokenId).then((v: bigint) => BigInt(v)),
    token.ownerOf(tokenId).then((a: string) => String(a)),
    token.taskURI(tokenId).then((u: string) => String(u)),
    token.taskOf(tokenId),
  ]);
  let task: TaskDocument | null = null;
  if (taskURI.startsWith("data:")) {
    try {
      const parsed = TaskDocumentSchema.safeParse(parseDataUri(taskURI));
      task = parsed.success ? parsed.data : null;
    } catch {
      task = null;
    }
  }
  // submission ids start at 1 (TaskToken: the count is the last id); the count and the entries read as one (core/tenders.ts)
  const submissions: TenderView["submissions"] = (await k.tenders.submissions(tokenId)).map((s, i) => ({ id: (i + 1).toString(), fulfiller: s.fulfiller, status: s.status, machineSettled: s.machineSettled, resultHash: s.resultHash }));
  let counterpartyLevel: number | null = null;
  if (opts.counterparty && node.config.identity.standing) {
    const st = node.config.identity.standing;
    try {
      const r = await k.kya.resolve(accountSubject(node.chainId, demander), st.schemeId, st.issuers);
      counterpartyLevel = Number(r.level);
    } catch {
      counterpartyLevel = null;
    }
  }
  return {
    facts: {
      tokenId,
      rewardWei: terms.rewardPerCompletion,
      asset: terms.asset,
      submitBy: terms.submitBy,
      settleBy: terms.settleBy,
      maxCompletions: terms.maxCompletions,
      completions,
      acceptanceAuthority: getAddress(authority),
      cancelled,
      escrowWei: escrow,
      skill: task?.skill ?? null,
      packageHash: task?.packageHash ?? null,
      acceptanceProfile: task?.acceptance.profile ?? null,
      counterpartyLevel,
    },
    demander: getAddress(demander),
    taskURI,
    task,
    taskHash: String(binding.taskHash),
    tdHash: String(binding.tdHash),
    version: Number(binding.version),
    submissions,
  };
}

/** A tender's JSON view for outputs (bigints as strings). */
export function tenderOutput(v: TenderView) {
  const f = v.facts;
  return {
    tokenId: f.tokenId.toString(),
    demander: v.demander,
    rewardWei: f.rewardWei.toString(),
    asset: f.asset,
    submitBy: Number(f.submitBy),
    settleBy: Number(f.settleBy),
    maxCompletions: Number(f.maxCompletions),
    completions: Number(f.completions),
    acceptanceAuthority: f.acceptanceAuthority,
    cancelled: f.cancelled,
    escrowWei: f.escrowWei.toString(),
    taskURI: v.taskURI.length > 200 ? `${v.taskURI.slice(0, 200)}… (${v.taskURI.length} chars)` : v.taskURI,
    task: v.task,
    taskHash: v.taskHash,
    tdHash: v.tdHash,
    version: v.version,
    submissions: v.submissions,
  };
}

export const TenderOutputSchema = z.object({
  tokenId: zUint,
  demander: zAddress,
  rewardWei: zUint,
  asset: zAddress,
  submitBy: z.number(),
  settleBy: z.number(),
  maxCompletions: z.number(),
  completions: z.number(),
  acceptanceAuthority: zAddress,
  cancelled: z.boolean(),
  escrowWei: zUint,
  taskURI: z.string(),
  task: TaskDocumentSchema.nullable(),
  taskHash: zBytes32,
  tdHash: zBytes32,
  version: z.number(),
  submissions: z.array(z.object({ id: zUint, fulfiller: zAddress, status: z.number(), machineSettled: z.boolean(), resultHash: zBytes32 })),
});

/** A short, stable id from semantic input (the default job id of an act). */
export function derivedJobId(prefix: string, parts: Record<string, unknown>): string {
  return `${prefix}:${sha256Hex(jcs(parts)).slice(2, 18)}`;
}

/** The job of a tender's n-th completion by this cell: the second legitimate completion of a tender is another job. */
export function tenderJobId(tokenId: bigint, completions: bigint): string {
  return `tender:${tokenId}:c${completions}`;
}

/** How many times a skill run the endpoint failed (PROBE_RPC_FAILURE) is attempted before the failure stands. */
export const RUN_ATTEMPTS = 5;

/** A failed run whose failure was the endpoint's, not a verdict on the request: the probe could not read the chain. */
export function transientRunFailure(job: { status: string; error: string | null }): boolean {
  return job.status === "failed" && (job.error ?? "").includes(PROBE_RPC_FAILURE);
}

/**
 * The job id of a skill run: the same request is the same job — except after a run the endpoint failed, which was no
 * verdict on the request; the next attempt is a new job (base:r2, :r3 … up to RUN_ATTEMPTS), so the catalog does not
 * answer it with the old failure. A run that failed on its merits, and the attempt past the limit, meet that failure.
 */
export function runJobId(node: Node, base: string): string {
  let id = base;
  for (let n = 2; n <= RUN_ATTEMPTS; n++) {
    const prior = node.store.getJob(id);
    if (!prior || !transientRunFailure(prior)) return id;
    id = `${base}:r${n}`;
  }
  return id;
}

export const GateSchema = z.object({ gate: z.string(), ok: z.boolean(), reason: z.string() });

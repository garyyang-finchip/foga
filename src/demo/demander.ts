import { Wallet } from "ethers";
import { join } from "node:path";
import { dataUri, keccakJcs, sha256Hex } from "../core/canonical.js";
import { hashlock, nativeTerms } from "../core/tenders.js";
import { extractVerifyFile } from "../genesis/extract.js";
import { runProbe, type ProbeInput } from "../genesis/probe.js";
import { Kernel } from "../kernel/kernel.js";
import { repoRoot } from "../util/fs.js";

/**
 * The demander of Loop D (design memo, Phase 3, section 8): an independent party — its own process, its own key,
 * its own store — that mints tenders the cell should take and tenders it must refuse, in an order a seed decides.
 * The cell's runner never sees this file; it meets the tenders on chain, as it would meet anyone's. Every case
 * carries what the acceptance expects of the cell, so the evidence can be judged without knowing how the cell
 * reached its verdict.
 *
 *   a   foga-probe at a block the seed picks                        taken: submitted, settled, paid
 *   b   finch-extract-verify over a document named by file name     taken: submitted, settled, paid
 *   c   a skill the cell does not have                             refused at `skill`
 *   d   a reward below the cell's floor                            refused at `policy`
 *   d2  a submit deadline too close                                refused at `policy`
 *   e   an acceptance authority the cell does not work under       refused at `verifier`
 *   f   a tender like a, minted during the guardian's suspension   refused at `safety`, then taken after the resume
 *
 * Case g (a proposal above the budget) is the model's, not the demander's: the stub makes it on purpose.
 */
export type CaseId = "a" | "b" | "c" | "d" | "d2" | "e" | "f";
export const ALL_CASES: CaseId[] = ["a", "b", "c", "d", "d2", "e", "f"];

export type Expectation = { outcome: "taken" } | { outcome: "refused"; gate: string } | { outcome: "refused-then-taken"; gate: string };

export interface DemandCase {
  id: CaseId;
  tokenId: string;
  skill: string;
  rewardWei: string;
  submitBy: number;
  settleBy: number;
  expect: Expectation;
  note: string;
  /** The answer the demander committed to the hashlock (null for a judged tender). Not shown to the cell. */
  answer: string | null;
  mintTx: string;
}

export interface DemanderOptions {
  worldPath: string;
  rpc: string;
  storePath: string;
  /** The demander's key (anvil's first account when the world is a local one and none is given). */
  key: string;
  /** The cell the probe case is about. */
  cell: string;
  /** The standing scheme and issuers the probe input names. */
  schemeId: string;
  issuers: string[];
  /** The package hashes the cell committed to; a tender names the package it wants. */
  packages: { "foga-probe": string; "finch-extract-verify": string };
  cases: CaseId[];
  seed: number;
  /** The cell's policy floor, so d falls below it and the others above (defaults: 0.0005 ETH floor, 0.001 ETH reward). */
  rewardWei?: bigint;
  belowFloorWei?: bigint;
  log?: (line: string) => void;
}

/** A small deterministic generator (mulberry32), so a seed reproduces the order and the probe block. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rnd: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const DAY = 86400;

export async function mintCases(opts: DemanderOptions): Promise<{ demander: string; cases: DemandCase[] }> {
  const log = opts.log ?? (() => {});
  const k = await Kernel.open({ worldPath: opts.worldPath, rpc: opts.rpc, storePath: opts.storePath, keys: { demander: opts.key } });
  try {
    const me = new Wallet(opts.key).address;
    const rnd = prng(opts.seed);
    const reward = opts.rewardWei ?? 1_000_000_000_000_000n; // 0.001 ETH
    const below = opts.belowFloorWei ?? 100_000_000_000_000n; // 0.0001 ETH
    const root = repoRoot();
    const head = await k.blockNumber();
    const probeBlock = Math.max(1, head - Math.floor(rnd() * Math.min(head - 1, 50)));
    const probeInput: ProbeInput = { subject: opts.cell, block: probeBlock, lookback: 9000, kya: { schemeId: opts.schemeId, issuers: opts.issuers } };
    const probeAnswer = (await runProbe(k.world, probeInput)).answer;
    const fixture = join(root, "scenarios", "fixtures", "sample-filing.txt");
    const extractAnswer = extractVerifyFile(fixture, join(root, "scenarios", "skills", "finch-extract-verify", "fields.json"), opts.packages["finch-extract-verify"]).canonical;

    const specs: Record<CaseId, { skill: string; packageHash: string; input: unknown; answer: string | null; rewardWei: bigint; submitIn: number; settleIn: number; authority?: string; expect: Expectation; note: string }> = {
      a: { skill: "foga-probe", packageHash: opts.packages["foga-probe"], input: probeInput, answer: probeAnswer, rewardWei: reward, submitIn: DAY, settleIn: 7 * DAY, expect: { outcome: "taken" }, note: `foga-probe of the cell at block ${probeBlock}` },
      b: { skill: "finch-extract-verify", packageHash: opts.packages["finch-extract-verify"], input: { document: "sample-filing.txt" }, answer: extractAnswer, rewardWei: reward, submitIn: DAY, settleIn: 7 * DAY, expect: { outcome: "taken" }, note: "finch-extract-verify over the fixture named by file name" },
      c: { skill: "foga-oracle", packageHash: "0x" + "ab".repeat(32), input: { question: "what is the price" }, answer: "unknown", rewardWei: reward, submitIn: DAY, settleIn: 7 * DAY, expect: { outcome: "refused", gate: "skill" }, note: "a skill the cell does not have" },
      d: { skill: "foga-probe", packageHash: opts.packages["foga-probe"], input: probeInput, answer: probeAnswer, rewardWei: below, submitIn: DAY, settleIn: 7 * DAY, expect: { outcome: "refused", gate: "policy" }, note: "a reward below the policy floor" },
      d2: { skill: "foga-probe", packageHash: opts.packages["foga-probe"], input: probeInput, answer: probeAnswer, rewardWei: reward, submitIn: 120, settleIn: 7 * DAY, expect: { outcome: "refused", gate: "policy" }, note: "a submit deadline too close" },
      e: { skill: "foga-probe", packageHash: opts.packages["foga-probe"], input: probeInput, answer: null, rewardWei: reward, submitIn: DAY, settleIn: 7 * DAY, authority: me, expect: { outcome: "refused", gate: "verifier" }, note: "a judged tender with the demander as its authority" },
      f: { skill: "foga-probe", packageHash: opts.packages["foga-probe"], input: probeInput, answer: probeAnswer, rewardWei: reward, submitIn: DAY, settleIn: 7 * DAY, expect: { outcome: "refused-then-taken", gate: "safety" }, note: "a tender like a, met during the guardian's suspension" },
    };

    const out: DemandCase[] = [];
    for (const id of shuffle(opts.cases, rnd)) {
      const p = specs[id];
      const t0 = await k.blockTimestamp();
      const answerHash = p.answer === null ? "0x" + "11".repeat(32) : hashlock.answerHash(p.answer);
      const task = { schema: "foga.task/1", skill: p.skill, packageHash: p.packageHash, input: p.input, acceptance: { mode: "verifier", profile: "x-hashlock-v1", verifier: k.tenders.hashlockAddress, answerHash }, deliverable: `loop D case ${id}: ${p.note}` };
      const terms = nativeTerms(p.rewardWei, { submitBy: BigInt(t0 + p.submitIn), settleBy: BigInt(t0 + p.settleIn) });
      const key = `demand.${opts.seed}.${id}`;
      const m = await k.call(`${key}.mint`, "demander", k.tenders.address, k.tenders.contract().interface, "mintTask", [me, me, p.authority ?? k.tenders.hashlockAddress, keccakJcs({ td: "foga.task/1", skill: p.skill }), sha256Hex(JSON.stringify(task)), dataUri(task), terms]);
      const tokenId = k.tenders.tokenIdFromReceipt(m.receipt);
      await k.call(`${key}.fund`, "demander", k.tenders.address, k.tenders.contract().interface, "fundTask", [tokenId, p.rewardWei], p.rewardWei);
      if (!p.authority) await k.call(`${key}.commit`, "demander", k.tenders.hashlockAddress, k.tenders.hashlockVerifier().interface, "commitAnswer", [k.tenders.address, tokenId, answerHash]);
      out.push({ id, tokenId: tokenId.toString(), skill: p.skill, rewardWei: p.rewardWei.toString(), submitBy: t0 + p.submitIn, settleBy: t0 + p.settleIn, expect: p.expect, note: p.note, answer: p.answer, mintTx: m.txHash });
      log(`demander: case ${id} is tender ${tokenId} (${p.note}; expect ${p.expect.outcome}${"gate" in p.expect ? ` at ${p.expect.gate}` : ""})`);
    }
    return { demander: me, cases: out };
  } finally {
    k.close();
    k.world.provider.destroy();
  }
}

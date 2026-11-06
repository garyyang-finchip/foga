import { Contract, getAddress, type BlockTag } from "ethers";
import { AIDStateName } from "../core/aid.js";
import { ReasonName, VerdictName, accountSubjectKey } from "../core/asf.js";
import { accountRef, jcs } from "../core/canonical.js";
import { ERC8004_ABI } from "../core/erc8004.js";
import { accountSubject } from "../core/kya.js";
import type { World } from "../core/world.js";
import { STATE_UNAVAILABLE, chainAnswered, rpcErrorText } from "../kernel/provider.js";

/** Inputs of one probe run (the task document carries them). */
export interface ProbeInput {
  subject: string;
  block: number;
  /**
   * How many blocks before `block` the log-based sections scan (`block - lookback`, at least 0); absent, they scan
   * from the chain's first block. Public endpoints cap the range of `eth_getLogs`, so a task on such a chain names
   * a lookback; being part of the input, it binds both runs to the same range.
   */
  lookback?: number;
  kya: { schemeId: string; issuers: string[] };
}

export interface ProbeReport {
  schema: "foga.probe/1";
  skill: "foga-probe";
  world: { worldId: string; chainId: number; block: number; blockHash: string };
  subject: string;
  checks: Record<string, Record<string, unknown> | null>;
}

const ZERO = "0x0000000000000000000000000000000000000000";
const PROBE_RETRIES = 6;
const PROBE_RETRY_MS = 500;
/**
 * The first words of the error a probe run ends with when the endpoint did not answer: the endpoint's failure, not a
 * verdict on the request, so the runner tries the run again later as a new job (tools/tenders.ts, node/runner.ts).
 */
export const PROBE_RPC_FAILURE = "probe: the RPC failed";
/**
 * The first words when the endpoint says it does not serve the state of the pinned block — it has not reached it, or
 * (a full node keeps the state of its recent blocks only) has let it go; the message says how far the block is behind
 * the endpoint's head. Asking the same endpoint again changes nothing; another endpoint may answer (tools/tenders.ts
 * asks the chain's other public ones in turn), and an archive endpoint (--rpc) answers any block.
 */
export const PROBE_STATE_GONE = "probe: the endpoint does not serve the state of block";
/**
 * How far behind the head a block is before "no state for it" is read as pruning rather than lag: a geth full node
 * keeps 128 blocks of state, other clients fewer. A younger block that no endpoint serves yet is a transient failure
 * (the run is tried again later); an older one is left to an archive endpoint.
 */
export const RECENT_BLOCKS = 128;

/** How far behind its head the endpoint said the block was, from a PROBE_STATE_GONE message; null when it did not say. */
export function blocksBehind(message: string): number | null {
  const m = /\((\d+) blocks behind its head/.exec(message);
  return m ? Number(m[1]) : null;
}

function describe(e: unknown): string {
  return (rpcErrorText(e) || String(e)).slice(0, 200);
}

/**
 * True for a failure of the transport rather than an answer of the chain. The chain's answer — a revert (a scheme
 * that does not exist, a contract that refuses the question) or return data of another shape than the ABI's ("0x"
 * from an account without that code at that block) — is the same for both runs of the probe, and the section is
 * null. Everything else is the endpoint's: a node that lags the pinned block or no longer holds its state, a rate
 * limit, a dropped connection, a timeout. ethers reports some of these as SERVER_ERROR, NETWORK_ERROR, TIMEOUT or
 * UNKNOWN_ERROR — and the rest, every JSON-RPC error of an eth_call, as CALL_EXCEPTION with "missing revert data",
 * the code a revert has. So the code alone does not decide; the revert's data or the node's own words do
 * (kernel/provider.ts). On Sepolia a cell's probe, run an hour after the tender was minted, asked a public endpoint
 * for the state of a block it did not serve; each refusal arrived as a CALL_EXCEPTION, was taken for a revert, and
 * the report had nulls where the demander's held values — tenders 48 and 49, "verification failed" at settlement.
 */
export function transientRpcError(e: unknown): boolean {
  return !chainAnswered(e);
}

/**
 * The `foga-probe` skill: eleven sections (ERC-8004 plus the ten), every read pinned to `input.block`, every
 * value rendered so that JCS of the report is byte-stable (numbers as decimal strings, addresses lower-case).
 */
export async function runProbe(world: World, input: ProbeInput): Promise<{ report: ProbeReport; answer: string }> {
  const subject = getAddress(input.subject);
  const low = subject.toLowerCase();
  const tag: BlockTag = input.block;
  // the block header first: a node behind the rest answers null for a block it has not imported, and is asked again
  let block = await world.provider.getBlock(input.block);
  for (let attempt = 0; !block && attempt < PROBE_RETRIES; attempt++) {
    await new Promise((r) => setTimeout(r, PROBE_RETRY_MS * 2 ** attempt));
    block = await world.provider.getBlock(input.block);
  }
  if (!block) throw new Error(`${PROBE_RPC_FAILURE}: block ${input.block} is not known to the endpoint after ${PROBE_RETRIES + 1} asks (it may not have reached the block yet); no report is made without it`);
  const at = { blockTag: tag };
  const fromBlock = input.lookback === undefined ? 0 : Math.max(0, input.block - input.lookback);
  // A bounded scan is asked in windows of 2000 blocks, the windows in parallel and their logs concatenated in block
  // order — the same logs a single query returns, in the same order (the answer hash is over them, so this must not
  // change), but each request small enough for a public endpoint, which caps the range of `eth_getLogs` and answers
  // a 9000-block scan slowly or not at all: a skill run on Sepolia overran its worker's budget on exactly this. An
  // unbounded scan (no lookback: a local chain) stays one query.
  const WINDOW = 2000;
  const logsOf = async (c: Contract, filter: Parameters<Contract["queryFilter"]>[0]) => {
    const to = input.block;
    if (input.lookback === undefined || to - fromBlock < WINDOW) return c.queryFilter(filter, fromBlock, to);
    const windows: [number, number][] = [];
    for (let a = fromBlock; a <= to; a += WINDOW) windows.push([a, Math.min(a + WINDOW - 1, to)]);
    const parts = await Promise.all(windows.map(([a, b]) => c.queryFilter(filter, a, b)));
    return parts.flat();
  };
  // A section is null when the chain says so — a call that reverts for this subject (a scheme that does not exist, a
  // contract that refuses the question): both runs of the probe see the same revert, and the report is the same. A
  // transport failure is not that: a public endpoint is a cluster whose nodes lag each other, a log scan up to the
  // pinned block is refused by a node that has not reached it ("block range extends beyond current head block"), a
  // state read at the pinned block by a node that has not reached it or no longer keeps that state ("missing trie
  // node"), and any request may be rate-limited or dropped. Turned into null, such a failure made the demander's
  // expected report and the cell's differ by a section, the hashes differ, and a right answer fail verification. So a
  // transport failure is retried with a pause, and if it persists the probe fails — a report with a hole in it is
  // never an answer. The failure names the cause when the node did: an endpoint that does not serve the block's
  // state (PROBE_STATE_GONE, with how far the block is behind its head) is one to replace for this read — another
  // endpoint, an archive one — not one to ask again (tools/tenders.ts does the replacing).
  const section = async (fn: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | null> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!transientRpcError(e)) return null;
        if (attempt >= PROBE_RETRIES) {
          const words = describe(e);
          if (STATE_UNAVAILABLE.test(words)) {
            const head = await world.provider.getBlockNumber().catch(() => 0);
            throw new Error(`${PROBE_STATE_GONE} ${input.block} (${head > 0 ? `${head - input.block} blocks behind its head` : "its head unknown"}; its words: ${words}); no report is made from a partial read`);
          }
          throw new Error(`${PROBE_RPC_FAILURE} ${attempt + 1} times (${words}): the endpoint did not answer; no report is made from a partial read`);
        }
        await new Promise((r) => setTimeout(r, PROBE_RETRY_MS * 2 ** attempt));
      }
    }
  };

  const aid = world.contract("8434/AIDRegistry");
  const checks: ProbeReport["checks"] = {};

  checks.erc8434 = await section(async () => {
    const state = Number(await aid.state(subject, at));
    const b = await aid.bindingOf(subject, at);
    const doc = await aid.documentURI(subject, at);
    return {
      state: AIDStateName[state],
      registry: String(b.registry).toLowerCase(),
      agentId: String(b.agentId),
      boundAt: String(b.boundAt),
      lastSeen: String(await aid.lastSeen(subject, at)),
      documentDigest: String(doc.digest ?? doc[1]),
    };
  });

  checks.erc8004 = await section(async () => {
    const b = await aid.bindingOf(subject, at);
    const registry = String(b.registry);
    if (registry === ZERO) return { bound: false };
    const identity = new Contract(registry, ERC8004_ABI, world.provider);
    const agentId = BigInt(b.agentId);
    return {
      bound: true,
      registry: registry.toLowerCase(),
      agentId: agentId.toString(),
      owner: String(await identity.ownerOf(agentId, at)).toLowerCase(),
      agentURI: String(await identity.tokenURI(agentId, at)),
    };
  });

  checks.erc8419 = await section(async () => {
    const kya = world.contract("8419/KYARegistry");
    const issuers = input.kya.issuers.map((a) => getAddress(a));
    const r = await kya.resolve(accountSubject(world.chainId, subject), input.kya.schemeId, issuers, at);
    return {
      schemeId: input.kya.schemeId,
      issuers: issuers.map((a) => a.toLowerCase()),
      level: String(r.level ?? r[0]),
      expiresAt: String(r.expiresAt ?? r[1]),
      assertionId: String(r.assertionId ?? r[2]),
    };
  });

  checks.erc8468 = await section(async () => {
    const bindings = world.contract("8468/ASFBindingRegistry");
    const count = Number(await bindings.countBySubject(accountSubjectKey(world.chainId, subject), subject, at));
    const out: Record<string, unknown> = { bindingsAsSubject: String(count) };
    try {
      const cell = world.at("foga:FogaCellAccount", subject);
      const s = await cell.status(at);
      out.status = { verdict: VerdictName[Number(s[0])], reasons: Array.from(s[1], (x: any) => ReasonName[Number(x)]), restrictions: Array.from(s[2], (x: any) => String(x)) };
    } catch (e) {
      // a subject that is not a cell account answers with a revert or with no data (null status); an endpoint that did not answer is retried by the section
      if (transientRpcError(e)) throw e;
      out.status = null;
    }
    return out;
  });

  checks.erc8444 = await section(async () => {
    const ard = world.contract("8444/ARDOnchainRegistry");
    const recordId = String(await ard.recordIdOf(subject, 0n, at));
    const rec = await ard.recordOf(recordId, at);
    const status = Number(rec.status);
    if (status === 0) return { agentRecord: null };
    return {
      agentRecord: { recordId, status: String(status), descriptorHash: String(rec.descriptorHash), urn: String(rec.urn), backed: Boolean(await ard.backed(recordId, at)) },
    };
  });

  checks.erc8454 = await section(async () => {
    const units = world.contract("8454/AUFUnitRegistry");
    const logs = await logsOf(units, units.filters.UnitRegistered(null, subject));
    return { unitsControlled: logs.map((l: any) => String(l.args.unitId)) };
  });

  checks.erc8338 = await section(async () => {
    const skills = world.contract("8338/SkillToken");
    const held = String(await skills.balanceOf(subject, at));
    const received = await logsOf(skills, skills.filters.Transfer(null, subject));
    const ids = new Set<string>();
    for (const l of received as any[]) ids.add(String(l.args.tokenId));
    const tokens: Record<string, unknown>[] = [];
    for (const id of [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
      try {
        if (String(await skills.ownerOf(BigInt(id), at)).toLowerCase() !== low) continue;
        const b = await skills.skillOf(BigInt(id), at);
        tokens.push({ tokenId: id, packageHash: String(b.packageHash), version: String(b.version) });
      } catch (e) {
        // burned or absent at that block (the chain's answer: a revert); an endpoint that did not answer is retried by the section
        if (transientRpcError(e)) throw e;
      }
    }
    return { held, tokens };
  });

  checks.erc8414 = await section(async () => {
    const tasks = world.contract("8414/TaskToken");
    const held = String(await tasks.balanceOf(subject, at));
    const submitted = await logsOf(tasks, tasks.filters.FulfillmentSubmitted(null, null, subject));
    const accepted = await logsOf(tasks, tasks.filters.FulfillmentAccepted(null, null, subject));
    return { held, submissions: String(submitted.length), accepted: String(accepted.length) };
  });

  checks.erc8447 = await section(async () => {
    const swarms = world.contract("8447/SwarmRegistry");
    const activated = await logsOf(swarms, swarms.filters.MemberActivated(null, subject));
    const ids = [...new Set((activated as any[]).map((l) => String(l.args.swarmId)))].sort();
    const memberships: Record<string, unknown>[] = [];
    for (const swarmId of ids) memberships.push({ swarmId, status: String(await swarms.memberStatus(swarmId, subject, at)) });
    return { memberships };
  });

  checks.erc8436 = await section(async () => {
    const acdf = world.contract("8436/ACDFRegistry");
    const filed = await logsOf(acdf, acdf.filters.IssueFiled(null, null, null, subject));
    return { issuesFiled: String(filed.length) };
  });

  checks.erc8471 = await section(async () => {
    const adrf = world.contract("8471/ADRFDisputeRegistry");
    const filed = await logsOf(adrf, adrf.filters.CaseFiled());
    let asParty = 0;
    for (const l of filed as any[]) {
      if (String(l.args.claimant).toLowerCase() === low || String(l.args.respondent).toLowerCase() === low) asParty++;
    }
    return { casesAsParty: String(asParty) };
  });

  const ordered: ProbeReport["checks"] = {};
  for (const k of ["erc8004", "erc8434", "erc8419", "erc8468", "erc8444", "erc8454", "erc8338", "erc8414", "erc8447", "erc8436", "erc8471"]) ordered[k] = checks[k] ?? null;

  const report: ProbeReport = {
    schema: "foga.probe/1",
    skill: "foga-probe",
    world: { worldId: world.file.worldId, chainId: world.chainId, block: input.block, blockHash: block.hash! },
    subject: accountRef(world.chainId, subject),
    checks: ordered,
  };
  return { report, answer: jcs(report) };
}

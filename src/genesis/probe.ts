import { Contract, getAddress, type BlockTag } from "ethers";
import { AIDStateName } from "../core/aid.js";
import { ReasonName, VerdictName, accountSubjectKey } from "../core/asf.js";
import { accountRef, jcs } from "../core/canonical.js";
import { ERC8004_ABI } from "../core/erc8004.js";
import { accountSubject } from "../core/kya.js";
import type { World } from "../core/world.js";

/** Inputs of one probe run (the task document carries them). */
export interface ProbeInput {
  subject: string;
  block: number;
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

/**
 * The `foga-probe` skill: eleven sections (ERC-8004 plus the ten), every read pinned to `input.block`, every
 * value rendered so that JCS of the report is byte-stable (numbers as decimal strings, addresses lower-case).
 */
export async function runProbe(world: World, input: ProbeInput): Promise<{ report: ProbeReport; answer: string }> {
  const subject = getAddress(input.subject);
  const low = subject.toLowerCase();
  const tag: BlockTag = input.block;
  const block = await world.provider.getBlock(input.block);
  if (!block) throw new Error(`block ${input.block} not found`);
  const at = { blockTag: tag };
  const section = async (fn: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown> | null> => {
    try {
      return await fn();
    } catch {
      return null;
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
    } catch {
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
    const logs = await units.queryFilter(units.filters.UnitRegistered(null, subject), 0, input.block);
    return { unitsControlled: logs.map((l: any) => String(l.args.unitId)) };
  });

  checks.erc8338 = await section(async () => {
    const skills = world.contract("8338/SkillToken");
    const held = String(await skills.balanceOf(subject, at));
    const received = await skills.queryFilter(skills.filters.Transfer(null, subject), 0, input.block);
    const ids = new Set<string>();
    for (const l of received as any[]) ids.add(String(l.args.tokenId));
    const tokens: Record<string, unknown>[] = [];
    for (const id of [...ids].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))) {
      try {
        if (String(await skills.ownerOf(BigInt(id), at)).toLowerCase() !== low) continue;
        const b = await skills.skillOf(BigInt(id), at);
        tokens.push({ tokenId: id, packageHash: String(b.packageHash), version: String(b.version) });
      } catch {
        /* burned or absent at that block */
      }
    }
    return { held, tokens };
  });

  checks.erc8414 = await section(async () => {
    const tasks = world.contract("8414/TaskToken");
    const held = String(await tasks.balanceOf(subject, at));
    const submitted = await tasks.queryFilter(tasks.filters.FulfillmentSubmitted(null, null, subject), 0, input.block);
    const accepted = await tasks.queryFilter(tasks.filters.FulfillmentAccepted(null, null, subject), 0, input.block);
    return { held, submissions: String(submitted.length), accepted: String(accepted.length) };
  });

  checks.erc8447 = await section(async () => {
    const swarms = world.contract("8447/SwarmRegistry");
    const activated = await swarms.queryFilter(swarms.filters.MemberActivated(null, subject), 0, input.block);
    const ids = [...new Set((activated as any[]).map((l) => String(l.args.swarmId)))].sort();
    const memberships: Record<string, unknown>[] = [];
    for (const swarmId of ids) memberships.push({ swarmId, status: String(await swarms.memberStatus(swarmId, subject, at)) });
    return { memberships };
  });

  checks.erc8436 = await section(async () => {
    const acdf = world.contract("8436/ACDFRegistry");
    const filed = await acdf.queryFilter(acdf.filters.IssueFiled(null, null, null, subject), 0, input.block);
    return { issuesFiled: String(filed.length) };
  });

  checks.erc8471 = await section(async () => {
    const adrf = world.contract("8471/ADRFDisputeRegistry");
    const filed = await adrf.queryFilter(adrf.filters.CaseFiled(), 0, input.block);
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

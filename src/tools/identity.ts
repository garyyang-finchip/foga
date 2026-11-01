import { join } from "node:path";
import { z } from "zod";
import { kindId, skillDescriptor } from "../core/ard.js";
import { dataUriJcs } from "../core/canonical.js";
import { buildSkillPackage, readSkillDir } from "../core/pack/skillpack.js";
import { skillUnitDefinition } from "../core/units.js";
import { ok, refused, safetyGate, type Gate } from "../node/policy.js";
import { derivedJobId, zBool, zBytes32, zJobId, zUint } from "./common.js";
import type { ActCapability, ActStep } from "./types.js";

/**
 * The cell's own identity and capability acts: minting a skill it will offer (ERC-8338 token, ERC-8444 record,
 * ERC-8454 unit — what the genesis does in T2) and keeping its anchor alive (ERC-8434 heartbeat in every registry
 * it is bound in). Both are the cell's acts through its account.
 */
export const skill_mint: ActCapability = {
  name: "skill_mint",
  title: "Mint a skill the cell holds",
  description: "Package a skill directory, mint its ERC-8338 token to the cell, register its ERC-8444 skill record and its ERC-8454 unit, and record it in the cell's configuration as held (and offered, when asked).",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [8338, 8444, 8454],
  input: z.object({ skill: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "a skill directory name"), offer: zBool.default(true), priceEth: z.string().regex(/^\d+(\.\d+)?$/).default("0"), jobId: zJobId }),
  output: z.object({ skill: z.string(), tokenId: zUint, recordId: zBytes32, unitId: zUint, mdHash: zBytes32, packageHash: zBytes32, offered: z.boolean(), operations: z.array(z.string()), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const cell = node.body;
    const chainId = node.chainId;
    const dir = join(node.skillsDir, input.skill);
    const pkg = buildSkillPackage(readSkillDir(dir));
    const gates: Gate[] = [];
    const [aidState, status] = await Promise.all([k.aid.stateName(cell.address), cell.status()]);
    gates.push(safetyGate(aidState, status, "plain"));
    const already = node.config.skills.held[input.skill];
    if (already) gates.push(refused("policy", `the cell already holds ${input.skill} as token ${already.tokenId}; update the skill instead`));
    else gates.push(ok("policy", `${input.skill} v${pkg.version}: mdHash ${pkg.mdHash.slice(0, 10)}…, packageHash ${pkg.packageHash.slice(0, 10)}…`));
    const packageURI = dataUriJcs({ skill: input.skill, version: pkg.version, mdHash: pkg.mdHash, packageHash: pkg.packageHash, rootCid: pkg.rootCid, source: `${node.config.skills.dir}/${input.skill}` });
    const jobId = input.jobId ?? derivedJobId(`skill-mint:${input.skill}`, { packageHash: pkg.packageHash, cell: cell.address });
    const tokenOf = (prior: { receipt: unknown }[]) => k.skills.tokenIdFromReceipt(prior[0].receipt);
    const steps: ActStep[] = [
      { name: "mint", kind: "plain", build: () => ({ target: k.skills.address, value: 0n, data: k.skills.encodeMint(cell.address, cell.address, pkg, packageURI), label: `mintSkill(${input.skill})` }) },
      {
        name: "record",
        kind: "plain",
        build: (prior) => {
          const tokenId = tokenOf(prior);
          const descriptor = skillDescriptor({ chainId, controller: cell.address, slug: input.skill, name: input.skill, description: String(pkg.manifest.summary ?? input.skill), packageHash: pkg.packageHash, packageURI, price: { amount: input.priceEth, currency: "ETH", asset: `eip155:${chainId}/slip44:60` } });
          return { target: k.ard.address, value: 0n, data: k.ard.encodeRegister(kindId("skill"), k.skills.address, tokenId, descriptor), label: `ARD register(skill ${tokenId})` };
        },
      },
      { name: "unit", kind: "plain", build: (prior) => ({ target: k.units.registryAddress, value: 0n, data: k.units.encodeRegisterUnit(cell.address, skillUnitDefinition({ chainId, skillToken: k.skills.address, tokenId: tokenOf(prior), holder: cell.address, name: input.skill }), []), label: `AUF registerUnit(skill ${input.skill})` }) },
    ];
    return {
      job: { id: jobId, kind: "skill-mint", input: { skill: input.skill, packageHash: pkg.packageHash } },
      gates,
      valueWei: 0n,
      steps,
      output: (confirmed) => {
        const tokenId = tokenOf(confirmed);
        const recordId = k.ard.recordIdFromReceipt(confirmed[1].receipt);
        const unitId = k.units.unitIdFromReceipt(confirmed[2].receipt);
        // the configuration follows the chain: the skill is now held (and offered, when asked)
        node.config.skills.held[input.skill] = { tokenId: tokenId.toString(), recordId, unitId: unitId.toString(), packageHash: pkg.packageHash };
        if (input.offer && !node.config.skills.offered.includes(input.skill)) node.config.skills.offered.push(input.skill);
        node.saveConfig();
        return { skill: input.skill, tokenId: tokenId.toString(), recordId, unitId: unitId.toString(), mdHash: pkg.mdHash, packageHash: pkg.packageHash, offered: node.config.skills.offered.includes(input.skill), operations: steps.map((s) => `job:${jobId}:${s.name}`), jobId };
      },
    };
  },
};

export const aid_heartbeat: ActCapability = {
  name: "aid_heartbeat",
  title: "Heartbeat",
  description: "Keep the cell's anchor ACTIVE: an ERC-8434 heartbeat in the reference registry and in the backing registry where the world has one. The watcher sends it on schedule; a caller may ask for one.",
  action: "act",
  visibility: "caller",
  principal: "cell",
  ercs: [8434],
  input: z.object({ jobId: zJobId }),
  output: z.object({ registries: z.array(z.object({ registry: z.string(), state: z.string(), txHash: z.string() })), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const cell = node.body;
    const gates: Gate[] = [];
    const [aidState, status] = await Promise.all([k.aid.stateName(cell.address), cell.status()]);
    if (aidState === "RETIRED") gates.push(refused("policy", "anchor RETIRED: nothing to keep alive"));
    else if (aidState === "DORMANT" && (await k.aid.bindingOf(cell.address)).registry === "0x0000000000000000000000000000000000000000") gates.push(refused("policy", "the anchor is not bound to an agent: nothing to keep alive"));
    else gates.push(ok("policy", `anchor ${aidState}`));
    gates.push(safetyGate(aidState, status, "plain"));
    const registries = [k.aid.address, ...(k.aid.backing ? [k.aid.backing.address] : [])];
    const jobId = input.jobId ?? derivedJobId("heartbeat", { at: Math.floor(Date.now() / 60_000) });
    const steps: ActStep[] = registries.map((registry, i) => ({ name: i === 0 ? "heartbeat" : "heartbeat.backing", kind: "plain" as const, build: () => ({ target: registry, value: 0n, data: k.aid.encodeHeartbeat(), label: `heartbeat() in ${registry}` }) }));
    return {
      job: { id: jobId, kind: "heartbeat", input: { registries } },
      gates,
      valueWei: 0n,
      steps,
      output: async (confirmed) => ({ registries: await Promise.all(registries.map(async (registry, i) => ({ registry, state: await k.aid.stateName(cell.address, registry), txHash: confirmed[i]?.txHash ?? "" }))), jobId }),
    };
  },
};

export const IDENTITY_CAPABILITIES: ActCapability[] = [skill_mint, aid_heartbeat];

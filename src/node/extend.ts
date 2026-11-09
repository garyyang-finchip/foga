import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { getAddress } from "ethers";
import { AIFP, AIFP_INTERFACE_IDS } from "../core/aifp.js";
import { AMM_CONTRACT, AMM_INTERFACE_ID } from "../core/amm.js";
import { chainById, packagedWorld } from "../core/chains.js";
import { PinnedProvider } from "../kernel/provider.js";
import { readJson, writeJson } from "../util/fs.js";
import { normalizeAddress } from "../world/deploy.js";
import type { WorldContract, WorldFile } from "../world/types.js";

/**
 * Extending a cell in place (docs/extending.md, docs/meditation.md, docs/flows.md): a covenant the program gained after
 * the cell's world file was written is added to that file — its contracts under their ERC keys, a step recorded as
 * attached, the chain's bootstrapped flows where the covenant has them — so the kernel opens them and the capabilities
 * find them. The cell's identity, account, store and documents are untouched; this is not a migration. What the cell
 * then does with the covenant (opening the operator's scope, enrolling, opening its channel) is the catalog's business
 * and is keyed in the store like any other act.
 */
export interface ExtensionContract {
  id: string;
  bundleKey: string;
  /** The ERC-165 id the contract answers for, checked over an RPC when one is at hand; null for a contract without one. */
  interfaceId: string | null;
  /** A contract the packaged world may lack and the extension still works without (deployed later by the maintainer). */
  optional?: boolean;
}

export interface Extension {
  title: string;
  contracts: ExtensionContract[];
  /** The contract `--registry <address>` names, for an extension of one registry; null when the address book is the packaged world's alone. */
  single: string | null;
  /** Whether the chain's bootstrapped flows (paradigms, market) are copied from the packaged world. */
  flows: boolean;
}

export const EXTENSIONS: Record<string, Extension> = {
  "8490": { title: "ERC-8490 Agent Meditation Mechanism", single: AMM_CONTRACT, flows: false, contracts: [{ id: AMM_CONTRACT, bundleKey: "agent-meditation-mechanism:AgentMeditationRegistry", interfaceId: AMM_INTERFACE_ID }] },
  "8489": {
    title: "ERC-8489 Agent Information Flow Paradigm",
    single: null,
    flows: true,
    contracts: [
      { id: AIFP.paradigms, bundleKey: "aif-paradigm:AIFPParadigmRegistry", interfaceId: AIFP_INTERFACE_IDS.IAIFPParadigmRegistry },
      { id: AIFP.channels, bundleKey: "aif-paradigm:AIFPChannelRegistry", interfaceId: AIFP_INTERFACE_IDS.IAIFPChannelRegistry },
      { id: AIFP.participation, bundleKey: "aif-paradigm:AIFPParticipationRegistry", interfaceId: AIFP_INTERFACE_IDS.IAIFPParticipationRegistry },
      { id: AIFP.verifier, bundleKey: "aif-paradigm:AIFPCompositeVerifier", interfaceId: AIFP_INTERFACE_IDS.IAIFPCompositeVerifier },
      { id: AIFP.anchor, bundleKey: "aif-paradigm:AIFPEventAnchor", interfaceId: AIFP_INTERFACE_IDS.IAIFPEventAnchor },
      { id: AIFP.subjectSet, bundleKey: "aif-paradigm:AIFPSubjectSet", interfaceId: AIFP_INTERFACE_IDS.IAIFPSubjectSet, optional: true },
      { id: AIFP.objectionWindow, bundleKey: "aif-paradigm:AIFPObjectionWindow", interfaceId: null, optional: true },
      { id: AIFP.identityVerifier, bundleKey: "foga:FogaIdentityVerifier", interfaceId: AIFP_INTERFACE_IDS.IAIFPPredicateVerifier, optional: true },
    ],
  },
};

export interface ExtendWorldOptions {
  /** The cell's world file (cell.config.json `world`). */
  worldPath: string;
  covenant: string;
  /** The registry's address when the packaged world of the chain does not carry it (another chain, a deployment of one's own); extensions of one registry only. */
  address?: string;
  /** A world file to take the covenant's contracts and flows from, instead of the packaged world of the chain (a world of one's own). */
  from?: string;
  /** An RPC to check that each address holds a contract answering ERC-165 for its interface id; skipped when absent. */
  rpc?: string;
  log?: (line: string) => void;
}

export interface ExtendWorldResult {
  covenant: string;
  contracts: { id: string; address: string; outcome: "present" | "added" }[];
  /** "present" when the world file had everything already; "added" when this call wrote something. */
  outcome: "present" | "added";
  source: string;
  backup: string | null;
  /** The chain's flows copied from the packaged world (ERC-8489), when they were. */
  flows: "present" | "added" | "none" | null;
  /** Optional contracts the packaged world does not carry yet. */
  missing: string[];
}

/** Add the covenant's contracts (and flows) to the world file when they are missing; idempotent. */
export async function extendWorld(o: ExtendWorldOptions): Promise<ExtendWorldResult> {
  const ext = EXTENSIONS[o.covenant];
  if (!ext) throw new Error(`unknown extension ${o.covenant}; this build knows ${Object.keys(EXTENSIONS).join(", ")}`);
  const log = o.log ?? (() => {});
  if (!existsSync(o.worldPath)) throw new Error(`world file ${o.worldPath} not found`);
  const world = readJson<WorldFile>(o.worldPath);
  if (world.schema !== "foga.world/1") throw new Error(`${o.worldPath} is not a world file (foga.world/1)`);
  if (o.address && !ext.single) throw new Error(`${ext.title} is several contracts; --registry names one. Extend from the packaged world of the chain, or add the entries to ${o.worldPath} by hand.`);

  // the address book: given (one registry), a world file given (--from), or the packaged world of the same chain
  const chain = chainById(world.chainId);
  const packaged = o.from ?? (chain ? packagedWorld(chain) : null);
  const pw = packaged && existsSync(packaged) ? readJson<WorldFile>(packaged) : null;
  if (pw && pw.chainId !== world.chainId) throw new Error(`${packaged} is a world of chain ${pw.chainId}; the cell's world is on ${world.chainId}`);
  const source = o.address ? "--registry" : o.from ? `the world file ${o.from}` : `the packaged world ${chain?.world ?? "(none)"}`;
  const entries: Record<string, WorldContract> = {};
  const missing: string[] = [];
  for (const c of ext.contracts) {
    const have = world.contracts[c.id];
    if (have) {
      if (o.address && c.id === ext.single && getAddress(o.address) !== getAddress(have.address)) throw new Error(`${o.worldPath} already has ${c.id} at ${have.address}; --registry ${o.address} disagrees. A world file names one instance; nothing was changed.`);
      continue;
    }
    if (o.address && c.id === ext.single) {
      entries[c.id] = { address: normalizeAddress(o.address, c.id), bundleKey: c.bundleKey, note: `${ext.title}; attached by foga cell extend from the address given` };
      continue;
    }
    const pc = pw?.contracts[c.id];
    if (!pc) {
      if (c.optional) {
        missing.push(c.id);
        continue;
      }
      throw new Error(`no ${c.id} is known for chain ${world.chainId}${chain ? ` (${chain.name})` : ""}: ${o.from ? `${o.from} does not carry one` : "the packaged world does not carry one"}. Deploy the covenant (foga world deploy adds it to a new world from the bundle)${ext.single ? ", pass --registry <address>" : ""} or --from <world.json> of a world that has it.`);
    }
    entries[c.id] = { ...pc, address: normalizeAddress(pc.address, c.id) };
  }
  const flowsToAdd = ext.flows && !world.flows && pw?.flows ? pw.flows : null;
  if (!Object.keys(entries).length && !flowsToAdd) {
    return { covenant: o.covenant, contracts: ext.contracts.filter((c) => world.contracts[c.id]).map((c) => ({ id: c.id, address: world.contracts[c.id].address, outcome: "present" as const })), outcome: "present", source: "the world file", backup: null, flows: ext.flows ? (world.flows ? "present" : "none") : null, missing };
  }

  // each address holds a contract that answers for its interface, when an RPC is at hand
  if (o.rpc && Object.keys(entries).length) {
    const provider = new PinnedProvider(o.rpc, undefined, { staticNetwork: true, cacheTimeout: -1 });
    try {
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== world.chainId) throw new Error(`the RPC serves chain ${net.chainId}; the world is on ${world.chainId}`);
      for (const [id, e] of Object.entries(entries)) {
        const code = await provider.getCode(e.address);
        if (code === "0x") throw new Error(`no contract at ${e.address} (${id}) on chain ${world.chainId}`);
        const iid = ext.contracts.find((c) => c.id === id)?.interfaceId;
        if (!iid) continue;
        const data = "0x01ffc9a7" + iid.slice(2).padEnd(64, "0");
        const answer = await provider.call({ to: e.address, data });
        if (!/^0x0*1$/.test(answer)) throw new Error(`${e.address} does not answer supportsInterface(${iid}) with true (${answer}); not the ${id} of ${ext.title}`);
        log(`  extend: ${id} at ${e.address} answers for ${iid} on chain ${world.chainId}`);
      }
    } finally {
      provider.destroy();
    }
  }

  const backup = `${o.worldPath}.before-${o.covenant}.bak`;
  if (!existsSync(backup)) copyFileSync(o.worldPath, backup);
  for (const [id, e] of Object.entries(entries)) {
    world.contracts[id] = e;
    world.steps.push({ id, status: "attached", note: `${ext.title} added in place by foga cell extend (${source})` });
  }
  if (flowsToAdd) world.flows = flowsToAdd;
  world.notes.push(`${ext.title} (${Object.keys(entries).join(", ") || "flows"}) attached by foga cell extend --covenants ${o.covenant} on ${new Date().toISOString()} (${source}); the previous file is ${backup}`);
  writeJson(o.worldPath, world);
  log(`  extend: ${Object.keys(entries).length} contract(s) of ${ext.title} added to ${o.worldPath} (from ${source})${flowsToAdd ? "; the chain's flows (paradigms, market) copied" : ""}${missing.length ? `; not in the packaged world yet: ${missing.join(", ")}` : ""}; the file before is ${backup}`);
  return {
    covenant: o.covenant,
    contracts: ext.contracts.filter((c) => world.contracts[c.id]).map((c) => ({ id: c.id, address: world.contracts[c.id].address, outcome: entries[c.id] ? ("added" as const) : ("present" as const) })),
    outcome: "added",
    source,
    backup,
    flows: ext.flows ? (flowsToAdd ? "added" : world.flows ? "present" : "none") : null,
    missing,
  };
}

/** The covenants a world file carries beyond the ten-ERC base, by number (every non-optional contract present). */
export function worldExtensions(worldPath: string): string[] {
  const world = JSON.parse(readFileSync(worldPath, "utf8")) as WorldFile;
  return Object.keys(EXTENSIONS).filter((c) => EXTENSIONS[c].contracts.filter((x) => !x.optional).every((x) => Boolean(world.contracts[x.id])));
}

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { getAddress } from "ethers";
import { AMM_CONTRACT, AMM_INTERFACE_ID } from "../core/amm.js";
import { chainById, packagedWorld } from "../core/chains.js";
import { PinnedProvider } from "../kernel/provider.js";
import { readJson, writeJson } from "../util/fs.js";
import { normalizeAddress } from "../world/deploy.js";
import type { WorldContract, WorldFile } from "../world/types.js";

/**
 * Extending a cell in place (docs/extending.md, docs/meditation.md): a covenant the program gained after the cell's
 * world file was written is added to that file — the contract under its ERC key, a step recorded as attached — so
 * the kernel opens it and the capabilities find it. The cell's identity, account, store and documents are untouched;
 * this is not a migration. What the cell then does with the covenant (opening the operator's scope, enrolling) is
 * the catalog's business and is keyed in the store like any other act.
 */
export const EXTENSIONS: Record<string, { contract: string; bundleKey: string; interfaceId: string; title: string }> = {
  "8490": { contract: AMM_CONTRACT, bundleKey: "agent-meditation-mechanism:AgentMeditationRegistry", interfaceId: AMM_INTERFACE_ID, title: "ERC-8490 Agent Meditation Mechanism" },
};

export interface ExtendWorldOptions {
  /** The cell's world file (cell.config.json `world`). */
  worldPath: string;
  covenant: string;
  /** The registry's address when the packaged world of the chain does not carry it (another chain, a deployment of one's own). */
  address?: string;
  /** An RPC to check that the address holds a contract answering ERC-165 for the covenant's interface id; skipped when absent. */
  rpc?: string;
  log?: (line: string) => void;
}

export interface ExtendWorldResult {
  covenant: string;
  contract: string;
  address: string;
  /** "present" when the world file had it already; "added" when this call wrote it. */
  outcome: "present" | "added";
  source: string;
  backup: string | null;
}

/** Add the covenant's contract to the world file when it is missing; idempotent. */
export async function extendWorld(o: ExtendWorldOptions): Promise<ExtendWorldResult> {
  const ext = EXTENSIONS[o.covenant];
  if (!ext) throw new Error(`unknown extension ${o.covenant}; this build knows ${Object.keys(EXTENSIONS).join(", ")}`);
  const log = o.log ?? (() => {});
  if (!existsSync(o.worldPath)) throw new Error(`world file ${o.worldPath} not found`);
  const world = readJson<WorldFile>(o.worldPath);
  if (world.schema !== "foga.world/1") throw new Error(`${o.worldPath} is not a world file (foga.world/1)`);
  const have = world.contracts[ext.contract];
  if (have) {
    if (o.address && getAddress(o.address) !== getAddress(have.address)) throw new Error(`${o.worldPath} already has ${ext.contract} at ${have.address}; --registry ${o.address} disagrees. A world file names one instance; nothing was changed.`);
    return { covenant: o.covenant, contract: ext.contract, address: have.address, outcome: "present", source: "the world file", backup: null };
  }

  // the address: given, or the packaged world of the same chain
  let address: string;
  let source: string;
  let entry: WorldContract;
  if (o.address) {
    address = normalizeAddress(o.address, ext.contract);
    source = "--registry";
    entry = { address, bundleKey: ext.bundleKey, note: `${ext.title}; attached by foga cell extend from the address given` };
  } else {
    const chain = chainById(world.chainId);
    const packaged = chain ? packagedWorld(chain) : null;
    const pw = packaged ? readJson<WorldFile>(packaged) : null;
    const pc = pw?.contracts[ext.contract];
    if (!pc) throw new Error(`no ${ext.title} registry is known for chain ${world.chainId}${chain ? ` (${chain.name})` : ""}: the packaged world does not carry one. Deploy one (foga world deploy adds it to a new world from the bundle) or pass --registry <address>.`);
    address = normalizeAddress(pc.address, ext.contract);
    source = `the packaged world ${chain!.world}`;
    entry = { ...pc, address };
  }

  // the address holds a contract that answers for the interface, when an RPC is at hand
  if (o.rpc) {
    const provider = new PinnedProvider(o.rpc, undefined, { staticNetwork: true, cacheTimeout: -1 });
    try {
      const net = await provider.getNetwork();
      if (Number(net.chainId) !== world.chainId) throw new Error(`the RPC serves chain ${net.chainId}; the world is on ${world.chainId}`);
      const code = await provider.getCode(address);
      if (code === "0x") throw new Error(`no contract at ${address} on chain ${world.chainId}`);
      const data = "0x01ffc9a7" + ext.interfaceId.slice(2).padEnd(64, "0");
      const answer = await provider.call({ to: address, data });
      if (!/^0x0*1$/.test(answer)) throw new Error(`${address} does not answer supportsInterface(${ext.interfaceId}) with true (${answer}); not a ${ext.title} registry`);
      log(`  extend: ${address} answers for ${ext.interfaceId} on chain ${world.chainId}`);
    } finally {
      provider.destroy();
    }
  }

  const backup = `${o.worldPath}.before-${o.covenant}.bak`;
  if (!existsSync(backup)) copyFileSync(o.worldPath, backup);
  world.contracts[ext.contract] = entry;
  world.steps.push({ id: ext.contract, status: "attached", note: `${ext.title} added in place by foga cell extend (${source})` });
  world.notes.push(`${ext.title} (${ext.contract} at ${address}) attached by foga cell extend --covenants ${o.covenant} on ${new Date().toISOString()}; the previous file is ${backup}`);
  writeJson(o.worldPath, world);
  log(`  extend: ${ext.contract} at ${address} added to ${o.worldPath} (from ${source}); the file before is ${backup}`);
  return { covenant: o.covenant, contract: ext.contract, address, outcome: "added", source, backup };
}

/** The covenants a world file carries beyond the ten-ERC base, by number. */
export function worldExtensions(worldPath: string): string[] {
  const world = JSON.parse(readFileSync(worldPath, "utf8")) as WorldFile;
  return Object.keys(EXTENSIONS).filter((c) => Boolean(world.contracts[EXTENSIONS[c].contract]));
}

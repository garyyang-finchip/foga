import { endpointsOf } from "../a2a/card.js";
import { chainById } from "../core/chains.js";
import { anchors, cellChannelId, marketFact, marketOf } from "./flows.js";
import { readPolicy, readState } from "./meditation.js";
import { FOGA_COVENANTS } from "./propagation.js";
import type { Node } from "./node.js";
import { PACKAGE_NAME } from "../util/version.js";

/**
 * A cell's card: what it is and how to reach it, said in the words another agent needs — its chain and account, its
 * ERC-8004 identity, the skills it holds and offers with their token ids, where a tender for it is minted, the
 * entrances it serves when it has a public face, and the program it runs. Read off the configuration and the world,
 * no chain call: a cell knows this about itself before it is online, and can hand it to anyone.
 */
export interface CellCard {
  schema: "foga.card/1";
  name: string;
  chain: { chainId: number; network: string; worldId: string; explorer: string | null };
  identity: { account: string | null; agentId: string | null; registry: string | null; owner: string; operator: string; guardian: string; oneKey: boolean };
  covenants: { program: readonly string[]; world: string[] };
  skills: { id: string; tokenId: string; packageHash: string; offered: boolean }[];
  /** Where a demander mints a tender this cell can take (ERC-8414), and the terms it holds a tender to. */
  work: { taskToken: string | null; minRewardWei: string; acceptance: string[]; counterpartyMinLevel: number };
  standing: { schemeId: string; issuers: string[] } | null;
  endpoints: { mcp: string | null; a2a: string | null; web: string | null; manifest: string | null; card: string | null };
  /**
   * The cell's own maintenance (ERC-8490, 0.8.0), from what the node keeps — the registry it enrolled in, the state version
   * and root it registered last, the policy version — with no chain call; null on a world without the registry. The
   * registry's own timeliness (FRESH / DUE / OVERDUE) is a live read: meditate_status. Registered maintenance says a
   * routine completed in time, not that the cell is correct.
   */
  maintenance: { registry: string; stateVersion: string | null; root: string | null; policyVersion: number | null; lastCycle: string | null; status: string } | null;
  /**
   * The cell's information flows (ERC-8489, 0.9.0), from what the node keeps — its own channel and the market it joined, the
   * roles it was admitted to, how many publications it anchored — with no chain call; null on a world without the registries.
   * The registry's own four-valued evaluation of a role is a live read: flow_roles.
   */
  flows: { registries: { channels: string; participation: string; anchor: string }; channel: { channelId: string; paradigm: string } | null; market: { channelId: string; admitted: string[] } | null; anchors: number; status: string } | null;
  program: { package: string; version: string; join: string };
}

export function cellCard(node: Node, o: { version: string }): CellCard {
  const cfg = node.config;
  const world = node.world;
  const chain = chainById(node.chainId);
  const ep = endpointsOf(node);
  const base = cfg.runtime.http.publicUrl?.replace(/\/+$/, "") ?? null;
  const has = (id: string) => {
    try {
      return world.address(id);
    } catch {
      return null;
    }
  };
  const id = cfg.identity;
  return {
    schema: "foga.card/1",
    name: cfg.name,
    chain: { chainId: node.chainId, network: world.file.network, worldId: world.file.worldId, explorer: chain?.explorer ?? null },
    identity: {
      account: id.account ?? null,
      agentId: id.agentId ?? null,
      registry: has("identity8004/IdentityRegistry"),
      owner: id.owner,
      operator: id.operator,
      guardian: id.guardian,
      oneKey: id.owner === id.operator && id.operator === id.guardian,
    },
    covenants: { program: FOGA_COVENANTS, world: world.covenants() },
    skills: Object.entries(cfg.skills.held).map(([sid, h]) => ({ id: sid, tokenId: String(h.tokenId), packageHash: h.packageHash ?? "", offered: cfg.skills.offered.includes(sid) })),
    work: { taskToken: has("8414/TaskToken"), minRewardWei: String(cfg.policy.tenders.minRewardWei), acceptance: cfg.policy.tenders.acceptance, counterpartyMinLevel: cfg.policy.tenders.counterpartyMinLevel },
    standing: id.standing ? { schemeId: id.standing.schemeId, issuers: id.standing.issuers } : null,
    endpoints: { mcp: ep.mcp, a2a: ep.a2a, web: ep.web, manifest: base ? `${base}/.well-known/foga-cell.json` : null, card: base ? `${base}/.well-known/agent-card.json` : null },
    maintenance: maintenanceOf(node),
    flows: flowsOf(node),
    program: { package: PACKAGE_NAME, version: o.version, join: `npx -y ${PACKAGE_NAME} join --chain ${chain?.name ?? "<chain>"}` },
  };
}

function flowsOf(node: Node): CellCard["flows"] {
  if (!node.kernel.flows.available) return null;
  const k = node.kernel;
  const channelId = cellChannelId(node);
  const market = marketOf(node);
  const admitted = marketFact(node);
  const roles = market && admitted && admitted.channelId.toLowerCase() === market.channelId.toLowerCase() ? Object.keys(admitted.admitted) : [];
  return {
    registries: { channels: k.flows.addressOf("8489/AIFPChannelRegistry"), participation: k.flows.addressOf("8489/AIFPParticipationRegistry"), anchor: k.flows.addressOf("8489/AIFPEventAnchor") },
    channel: channelId ? { channelId, paradigm: "foga:cell-source/v1" } : null,
    market: market ? { channelId: market.channelId, admitted: roles } : null,
    anchors: anchors(node).length,
    status: channelId ? `channel open (foga:cell-source/v1); ${market ? (roles.length ? `admitted to the market as ${roles.join(", ")}` : "not admitted to the market yet") : "no market named"}; the registry's roles are a live read (flow_roles)` : "no channel as far as this node knows (foga cell extend --covenants 8489)",
  };
}

function maintenanceOf(node: Node): CellCard["maintenance"] {
  const registry = (() => {
    try {
      return node.world.address("8490/AgentMeditationRegistry");
    } catch {
      return null;
    }
  })();
  if (!registry) return null;
  const state = readState(node);
  const policy = readPolicy(node);
  const lastCycle = node.store.getFact<string>("meditation.lastCycle") ?? null;
  return { registry, stateVersion: state?.stateVersion ?? null, root: state?.root ?? null, policyVersion: policy?.version ?? null, lastCycle, status: state ? `registered state version ${state.stateVersion} (${state.by}); the registry's timeliness is a live read (meditate_status)` : "not enrolled as far as this node knows (foga cell extend --covenants 8490)" };
}

/** The card as a few lines an agent can paste to another agent. */
export function formatCard(c: CellCard): string {
  const lines: string[] = [];
  const where = c.chain.explorer && c.identity.account ? ` (${c.chain.explorer}/address/${c.identity.account})` : "";
  lines.push(`I am ${c.name}, a FOGA cell on ${c.chain.network} (chain ${c.chain.chainId}), world ${c.chain.worldId}.`);
  if (c.identity.account) lines.push(`  account   ${c.identity.account}${where}`);
  else lines.push("  account   not born yet (foga cell init)");
  if (c.identity.agentId) lines.push(`  identity  ERC-8004 agent ${c.identity.agentId}${c.identity.registry ? ` in registry ${c.identity.registry}` : ""}`);
  lines.push(`  roles     ${c.identity.oneKey ? `one key, every role: ${c.identity.owner}` : `owner ${c.identity.owner}, operator ${c.identity.operator}, guardian ${c.identity.guardian}`}`);
  lines.push(`  covenants ${c.covenants.world.join(", ")}`);
  const offered = c.skills.filter((s) => s.offered);
  const heldOnly = c.skills.filter((s) => !s.offered);
  lines.push(`  skills    ${offered.length ? offered.map((s) => `${s.id} (token ${s.tokenId})`).join(", ") + " — offered" : "none offered"}${heldOnly.length ? `; held: ${heldOnly.map((s) => s.id).join(", ")}` : ""}`);
  if (c.standing) lines.push(`  standing  scheme ${c.standing.schemeId.slice(0, 10)}… by ${c.standing.issuers.join(", ")}`);
  if (c.work.taskToken) lines.push(`  work      mint an ERC-8414 tender on TaskToken ${c.work.taskToken} for one of my offered skills, reward ≥ ${c.work.minRewardWei} wei, acceptance ${c.work.acceptance.join("/")}${c.work.counterpartyMinLevel ? `, your KYA level ≥ ${c.work.counterpartyMinLevel}` : ""}; I find it on chain, run the skill, submit, settle`);
  if (c.endpoints.mcp) lines.push(`  reach me  MCP ${c.endpoints.mcp} · A2A ${c.endpoints.a2a} · manifest ${c.endpoints.manifest}`);
  else lines.push("  reach me  on chain (no public URL); a tender is the handshake");
  if (c.maintenance) lines.push(`  upkeep    ERC-8490 registry ${c.maintenance.registry}: ${c.maintenance.stateVersion ? `state version ${c.maintenance.stateVersion}, policy v${c.maintenance.policyVersion ?? "?"}${c.maintenance.lastCycle ? `, last cycle ${c.maintenance.lastCycle}` : ""}` : "not enrolled"} — the registry judges timeliness, the record says what was checked`);
  if (c.flows) lines.push(`  flows     ERC-8489: ${c.flows.channel ? `my channel ${c.flows.channel.channelId} (${c.flows.channel.paradigm}), ${c.flows.anchors} publication(s) anchored` : "no channel yet"}; ${c.flows.market ? `market ${c.flows.market.channelId}${c.flows.market.admitted.length ? ` — admitted as ${c.flows.market.admitted.join(", ")}` : " — not admitted yet"}` : "no market named"}; ask flow_roles for the registry's own evaluation`);
  lines.push(`  program   ${c.program.package} ${c.program.version} — become one too:  ${c.program.join}`);
  return lines.join("\n");
}

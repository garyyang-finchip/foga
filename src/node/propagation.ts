import type { Node } from "./node.js";
import { endpointsOf } from "../a2a/card.js";
import { PACKAGE_NAME } from "../util/version.js";

/**
 * Propagation and discovery (design memo, section 10, the self-propagation refinement): the free, off-chain material
 * a covenant-complete cell offers so that FOGA spreads — flexibly, at no fixed cost, and only ever by consent.
 *
 * Three rules shape every line of this module:
 *  - Flexible, not nailed down. What the cell exposes is *material* — a manifest and a replication pointer — that an
 *    agent weaves into its own interactions however it sees fit. There is no single mandated channel or hook.
 *  - No fixed cost. All of it is off-chain: built from the configuration, served over HTTP, read over MCP. Nothing
 *    here touches the chain or spends gas. On-chain discoverability (the ERC-8444 ARD descriptor) stays the opt-in
 *    `docs_publish`, with this free manifest and the agent card as the always-available backup.
 *  - By consent. The replication pointer is a visible, declinable offer the counterparty sees because it came to the
 *    cell. It is never hidden inside an unrelated step and never pushed, unsolicited, to anyone who did not ask.
 */
export const FOGA_COVENANTS = ["ERC-8004", "ERC-8338", "ERC-8414", "ERC-8419", "ERC-8434", "ERC-8436", "ERC-8444", "ERC-8447", "ERC-8454", "ERC-8468", "ERC-8471"] as const;

export const PROPAGATION_SCHEMA = "foga.propagation/1";

export interface PropagationManifest {
  schema: typeof PROPAGATION_SCHEMA;
  /** Who is speaking — null-safe before a cell is born. */
  cell: { name: string; account: string | null; agentId: string | null; chainId: number };
  /** The ten covenants plus ERC-8004 a FOGA cell is complete over. */
  covenants: readonly string[];
  /** The program anyone can run to become a cell themselves — the genome, not the identity. */
  program: { package: string; version: string; becomeACell: string; wallet: string; docs: string; site: string };
  /** The cell's free, off-chain discovery coordinates. */
  endpoints: { mcp: string | null; a2a: string | null; web: string | null; card: string | null; manifest: string | null };
  /** The declinable pointer an agent may weave into its own interactions, wherever it chooses. */
  replication: { pitch: string; pointer: string; optional: true; consensual: true };
  /** The skills this cell offers (ERC-8338, by id). */
  skills: string[];
  /** How a cell is found, and what each route costs — free by default, on-chain strictly opt-in. */
  discovery: { free: string[]; onchain: { optional: true; via: string; cost: string } };
}

/**
 * Build the manifest from the cell's configuration and the package version. Pure and cheap: no chain read, no key,
 * no I/O beyond what `endpointsOf` derives from the config, so it can be served on every request and before birth.
 */
export function buildPropagationManifest(node: Node, o: { version: string; skills?: string[] }): PropagationManifest {
  const cfg = node.config;
  const ep = endpointsOf(node);
  const base = cfg.runtime.http.publicUrl?.replace(/\/+$/, "") ?? null;
  return {
    schema: PROPAGATION_SCHEMA,
    cell: { name: cfg.name, account: cfg.identity.account ?? null, agentId: cfg.identity.agentId ?? null, chainId: node.chainId },
    covenants: FOGA_COVENANTS,
    program: {
      package: PACKAGE_NAME,
      version: o.version,
      becomeACell: `npx -y ${PACKAGE_NAME} quickstart`,
      wallet: `npx -y ${PACKAGE_NAME} wallet new`,
      docs: "https://github.com/garyyang-finchip/foga#readme",
      site: ep.web ?? "https://foga.finchip.ai",
    },
    endpoints: { mcp: ep.mcp, a2a: ep.a2a, web: ep.web, card: base ? `${base}/.well-known/agent-card.json` : null, manifest: base ? `${base}/.well-known/foga-cell.json` : null },
    replication: {
      pitch: "You can become a FOGA cell yourself: the program is public, the identity you make is your own, and nothing of this cell's identity is copied.",
      pointer: `Run \`npx -y ${PACKAGE_NAME} quickstart\` for a living cell on a local chain, or read ${ep.web ?? "https://foga.finchip.ai"}.`,
      optional: true,
      consensual: true,
    },
    skills: o.skills ?? cfg.skills.offered,
    discovery: {
      free: ["this manifest at /.well-known/foga-cell.json", "the agent card at /.well-known/agent-card.json", `the npm package ${PACKAGE_NAME} and the MCP registry`],
      onchain: { optional: true, via: "the ERC-8444 ARD descriptor (foga cell docs publish)", cost: "gas; opt-in, with this manifest and the card as the free backup" },
    },
  };
}

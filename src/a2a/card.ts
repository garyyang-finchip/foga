import type { Node } from "../node/node.js";
import { SIGNED_SCHEME } from "../http/signed.js";
import { A2A_PROTOCOL_VERSION, type AgentCard, type AgentSkill } from "./types.js";

/**
 * The agent card (A2A 1.0, section 4.4), derived from the cell's configuration (design memo, Phase 3, section 6):
 * one JSON-RPC interface at the node's A2A URL, the skills the policy offers to others (ERC-8338 packages by name
 * and version, never the whole token list), the two ways to present a credential, and no streaming, no push, no
 * extended card. The card is one of the documents `foga cell docs build` writes and the node serves at
 * /.well-known/agent-card.json.
 */
export interface CardEndpoints {
  a2a: string | null;
  mcp: string | null;
  web: string | null;
}

/** The public endpoints of a cell: the configuration's, or derived from runtime.http.publicUrl. */
export function endpointsOf(node: Node): CardEndpoints {
  const cfg = node.config;
  const base = cfg.runtime.http.publicUrl?.replace(/\/+$/, "") ?? null;
  return {
    a2a: cfg.presence.endpoints.a2a ?? (base ? `${base}/a2a` : null),
    mcp: cfg.presence.endpoints.mcp ?? (base ? `${base}/mcp` : null),
    web: cfg.presence.endpoints.web ?? cfg.presence.homepage ?? base,
  };
}

export async function buildAgentCard(node: Node, o: { version: string }): Promise<AgentCard> {
  const cfg = node.config;
  const endpoints = endpointsOf(node);
  const held = node.cell ? await node.heldSkills() : [];
  const skills: AgentSkill[] = held
    .filter((h) => cfg.skills.offered.includes(h.name))
    .map((h) => {
      const m = h.pkg.manifest as { skillVersion?: string; summary?: string; skillType?: string; standard?: string };
      const version = m.skillVersion ?? String(h.pkg.version);
      return {
        id: `${h.name}@${version}`,
        name: h.name,
        description: m.summary ?? `The ERC-8338 skill ${h.name} (package ${h.packageHash})`,
        tags: ["erc8338", "foga", h.name, ...(m.skillType ? [m.skillType] : [])],
        examples: [
          `{"foga":{"mode":"quote","skill":"${h.name}","input":{}}}`,
          `{"foga":{"mode":"tender","tokenId":"<an ERC-8414 tender for ${h.name}, funded, with the hashlock committed>"}}`,
        ],
        inputModes: ["application/json", "text/plain"],
        outputModes: ["application/json"],
      };
    });
  const card: AgentCard = {
    name: cfg.presence.name,
    description: cfg.presence.description || `FOGA cell ${cfg.name}`,
    supportedInterfaces: endpoints.a2a ? [{ url: endpoints.a2a, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }] : [],
    ...(cfg.presence.provider ? { provider: { organization: cfg.presence.provider.organization, url: cfg.presence.provider.url } } : {}),
    version: o.version,
    documentationUrl: "https://github.com/garyyang-finchip/foga#readme",
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    securitySchemes: {
      "api-key": { httpAuthSecurityScheme: { scheme: "Bearer", description: "An API key the cell's operator issued (foga node key new)." } },
      "wallet-signature": { httpAuthSecurityScheme: { scheme: SIGNED_SCHEME, description: "An EIP-712 envelope signed by the caller's own wallet for this cell (docs/mcp.md, signed calls)." } },
    },
    securityRequirements: [],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills,
    ...(cfg.presence.image ? { iconUrl: cfg.presence.image } : {}),
  };
  return card;
}

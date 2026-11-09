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
/** The covenants this program is complete over: the ten plus ERC-8004. The base set, not a ceiling — see `world`. */
export const FOGA_COVENANTS = ["ERC-8004", "ERC-8338", "ERC-8414", "ERC-8419", "ERC-8434", "ERC-8436", "ERC-8444", "ERC-8447", "ERC-8454", "ERC-8468", "ERC-8471"] as const;

export const PROPAGATION_SCHEMA = "foga.propagation/1";

/**
 * Where the program's maintainer lists the services around the covenants — free ones, and later paid ones. The
 * manifest carries the pointer; the catalog itself lives behind the URL, so what is on offer changes there, not here.
 */
export const MAINTAINER_SERVICES_CATALOG = "https://foga.finchip.ai/services.json";
export const MAINTAINER = "FinChip.ai";

export interface ServiceOffer {
  id: string;
  name: string;
  kind: "free" | "paid";
  /** `planned` is a slot, not a sale: it says what the maintainer intends to offer, so an agent can plan around it. */
  status: "available" | "planned";
  url: string;
  description: string;
}

/** The maintainer's offers as of this build; the live list is the catalog's. */
export const MAINTAINER_OFFERS: readonly ServiceOffer[] = [
  { id: "become-a-cell", name: "Become a cell", kind: "free", status: "available", url: "https://github.com/garyyang-finchip/foga#readme", description: "The program, the quickstart and the public-chain birth — free, with an identity of your own." },
  { id: "kya-attestation", name: "KYA standing attestation", kind: "paid", status: "planned", url: MAINTAINER_SERVICES_CATALOG, description: "Standing under the FOGA scheme, attested by an issuer, for the tenders that require it; a cell cannot attest itself." },
  { id: "hosted-cell", name: "Hosted cell", kind: "paid", status: "planned", url: MAINTAINER_SERVICES_CATALOG, description: "A cell served around the clock — the box, the TLS, the watchers, the backups — on keys that stay yours." },
  { id: "dispute-resolution", name: "Dispute resolution", kind: "paid", status: "planned", url: MAINTAINER_SERVICES_CATALOG, description: "An ERC-8471 arbiter for the disputes a tender economy produces." },
];

export interface PropagationManifest {
  schema: typeof PROPAGATION_SCHEMA;
  /** Who is speaking — null-safe before a cell is born. */
  cell: { name: string; account: string | null; agentId: string | null; chainId: number };
  /** The ten covenants plus ERC-8004 this program is complete over. */
  covenants: readonly string[];
  /**
   * What this cell's world actually has attached, read off the world's contract keys; `extensions` are the covenants
   * beyond the program's base set — the open slot for the eleventh and later (docs/extending.md).
   */
  world: { covenants: string[]; extensions: string[] };
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
  /**
   * The cell's own maintenance (ERC-8490, 0.8.0), when its world has the registry: where its cycles are registered and
   * where their records are served, as far as its disclosure goes. Null otherwise. The registry's timeliness is a live
   * read (meditate_status); "registered" never means "correct".
   */
  maintenance: { registry: string; documents: string | null; disclosure: "commitment" | "summary" | "full"; note: string } | null;
  /**
   * The services around the covenants, free and (later) paid, as the program's maintainer lists them: a pointer this
   * cell's operator may keep, replace with a catalog of their own, or drop (`presence.services`). Visible and
   * declinable, like everything else here; a `planned` offer is not for sale yet.
   */
  services: { catalog: string; maintainer: string; offers: readonly ServiceOffer[]; note: string } | null;
}

/** The services block from the configuration: the maintainer's by default, the operator's own, or none. */
export function servicesOf(cfg: { presence: { services?: { catalog?: string | null; offers?: ServiceOffer[] } } }): PropagationManifest["services"] {
  const s = cfg.presence.services;
  if (s && s.catalog === null) return null;
  return {
    catalog: s?.catalog ?? MAINTAINER_SERVICES_CATALOG,
    maintainer: s?.catalog ? "the operator of this cell" : MAINTAINER,
    offers: s?.offers ?? MAINTAINER_OFFERS,
    note: "optional and declinable; the catalog is the live list; a planned offer is not for sale yet",
  };
}

export const SERVICES_SCHEMA = "foga.services/1";

export interface ServicesCatalog {
  schema: typeof SERVICES_SCHEMA;
  catalog: string;
  maintainer: string;
  program: { package: string; version: string };
  offers: readonly ServiceOffer[];
  note: string;
}

/**
 * The catalog document a cell serves at `/services.json` when the catalog its manifest points at is its own — the
 * reference cell serving the maintainer's list, an operator serving theirs. A cell whose pointer names another host
 * serves nothing: the list is that host's, and the pointer resolves there. The list changes without a release by a
 * static file at the same path on the host (the proxy answering it before the node) — that is the live list; this
 * is what it says until then.
 */
export function servicesCatalogOf(node: Pick<Node, "config">, o: { version: string }): ServicesCatalog | null {
  const s = servicesOf(node.config);
  const base = node.config.runtime.http.publicUrl?.replace(/\/+$/, "") ?? null;
  if (!s || !base || s.catalog !== `${base}/services.json`) return null;
  return { schema: SERVICES_SCHEMA, catalog: s.catalog, maintainer: s.maintainer, program: { package: PACKAGE_NAME, version: o.version }, offers: s.offers, note: s.note };
}

/**
 * Build the manifest from the cell's configuration and the package version. Pure and cheap: no chain read, no key,
 * no I/O beyond what `endpointsOf` derives from the config, so it can be served on every request and before birth.
 */
export function buildPropagationManifest(node: Node, o: { version: string; skills?: string[] }): PropagationManifest {
  const cfg = node.config;
  const ep = endpointsOf(node);
  const base = cfg.runtime.http.publicUrl?.replace(/\/+$/, "") ?? null;
  const inWorld = node.world.covenants();
  return {
    schema: PROPAGATION_SCHEMA,
    cell: { name: cfg.name, account: cfg.identity.account ?? null, agentId: cfg.identity.agentId ?? null, chainId: node.chainId },
    covenants: FOGA_COVENANTS,
    world: { covenants: inWorld, extensions: inWorld.filter((c) => !(FOGA_COVENANTS as readonly string[]).includes(c)) },
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
    services: servicesOf(cfg),
    maintenance: maintenanceOf(node, base),
  };
}

function maintenanceOf(node: Node, base: string | null): PropagationManifest["maintenance"] {
  if (!node.world.has("8490/AgentMeditationRegistry")) return null;
  const level = node.config.maintenance.policy.disclosure;
  return {
    registry: node.world.address("8490/AgentMeditationRegistry"),
    documents: base && level > 0 ? `${base}/documents/maintenance/` : null,
    disclosure: (["commitment", "summary", "full"] as const)[level],
    note: "ERC-8490: the cell registers its own maintenance cycles — commitments to four layer state documents and a timeliness the registry judges; a cycle record says what was checked and what changed",
  };
}

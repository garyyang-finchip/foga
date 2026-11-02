import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildAgentCard, endpointsOf } from "../a2a/card.js";
import type { AgentCard } from "../a2a/types.js";
import { AID, type AIDDocument, type AIDFacet } from "../core/aid.js";
import { agentDescriptor, descriptorHash } from "../core/ard.js";
import { accountRef, dataUri, dataUriJcs, keccakJcs } from "../core/canonical.js";
import { cellUnitDefinition, type UnitDefinition } from "../core/units.js";
import { repoRoot } from "../util/fs.js";
import { configPath } from "./config.js";
import type { Node } from "./node.js";

/**
 * One configuration, several documents (design memo, Phase 3, section 7): everything the cell says about itself to
 * the outside is generated from `cell.config.json` and the chain — the ERC-8004 registration file, the ERC-8434
 * AID document, the ERC-8444 agent descriptor, the ERC-8454 unit definition, the A2A agent card and the MCP
 * registry manifest — each in its own file with only the fields its standard prescribes, the shared metadata
 * (version, content hash, built time) in `manifest.json` beside them. `foga cell docs build` writes them under the
 * configuration's documents directory; the node serves them (`/documents/<file>`, `/.well-known/agent-card.json`,
 * `/.well-known/agent-registration.json`); `foga cell docs publish` commits what changed on chain and reads it back.
 */
export const DOCUMENTS_SCHEMA = "foga.documents/1";

export interface DocumentEntry {
  file: string;
  /** keccak256 of the JCS form: what an on-chain commitment of the document is compared against. */
  contentHash: string;
  bytes: number;
  standard: string;
}

export interface DocumentsManifest {
  schema: typeof DOCUMENTS_SCHEMA;
  cell: string;
  account: string;
  agentId: string | null;
  chainId: number;
  version: number;
  builtAt: string;
  publicUrl: string | null;
  documents: Record<string, DocumentEntry>;
}

export interface BuiltDocuments {
  dir: string;
  manifest: DocumentsManifest;
  registration: Record<string, unknown>;
  aidDocument: AIDDocument;
  ardAgent: Record<string, unknown>;
  aufUnit: UnitDefinition;
  agentCard: AgentCard;
  serverJson: Record<string, unknown>;
}

export const DOCUMENT_FILES = {
  registration: "registration.json",
  aidDocument: "aid-document.json",
  ardAgent: "ard-agent.json",
  aufUnit: "auf-unit.json",
  agentCard: "agent-card.json",
  serverJson: "server.json",
} as const;

/** The directory the documents live in: runtime.http.documentsDir, relative to the configuration's directory. */
export function documentsDir(node: Node): string {
  return configPath(node.loaded, node.config.runtime.http.documentsDir);
}

/** The URI a document is published under: the public URL when the node has one, the document itself (data:) otherwise. */
export function documentUri(node: Node, file: string, doc: unknown): string {
  const base = node.config.runtime.http.publicUrl?.replace(/\/+$/, "");
  if (!base) return dataUri(doc);
  if (file === DOCUMENT_FILES.registration) return `${base}/.well-known/agent-registration.json`;
  if (file === DOCUMENT_FILES.agentCard) return `${base}/.well-known/agent-card.json`;
  return `${base}/documents/${file}`;
}

/** The ERC-8004 registration file (registration-v1) of the cell, from its configuration. */
export function buildRegistration(node: Node): Record<string, unknown> {
  const cfg = node.config;
  const chainId = node.chainId;
  const endpoints = endpointsOf(node);
  const account = cfg.identity.account!;
  const services = [
    ...(endpoints.mcp ? [{ name: "MCP", endpoint: endpoints.mcp, version: "2026-07-28" }] : []),
    ...(endpoints.a2a ? [{ name: "A2A", endpoint: endpoints.a2a, version: "1.0" }] : []),
    ...(endpoints.web ? [{ name: "web", endpoint: endpoints.web }] : []),
  ];
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: cfg.presence.name,
    description: cfg.presence.description,
    ...(cfg.presence.image ? { image: cfg.presence.image } : {}),
    services,
    ...(cfg.identity.agentId ? { registrations: [{ agentId: Number(cfg.identity.agentId), agentRegistry: `eip155:${chainId}:${node.kernel.identity.address.toLowerCase()}` }] } : {}),
    x402Support: false,
    active: true,
    supportedTrust: ["reputation"],
    "x-foga": { cell: cfg.name, anchor: accountRef(chainId, account), ...(cfg.identity.bindingId ? { binding: cfg.identity.bindingId } : {}), ...(cfg.identity.safety.specId ? { specification: cfg.identity.safety.specId } : {}) },
  };
}

/** The AID document: the identity facet over the registration, the standing facet when attested, the skills facet, the endpoints facet. */
export async function buildAidDocument(node: Node, registration: Record<string, unknown>): Promise<AIDDocument> {
  const cfg = node.config;
  const k = node.kernel;
  const chainId = node.chainId;
  const account = cfg.identity.account!;
  const self = accountRef(chainId, account);
  const agentId = cfg.identity.agentId ? Number(cfg.identity.agentId) : undefined;
  const facets: AIDFacet[] = [{ facetType: "aid:core/identity/v1", provenance: "SELF", issuer: self, validUntil: 0, digest: keccakJcs(registration), access: { mode: "PUBLIC" }, resolver: { kind: "erc8004-identity", chainId, registry: k.identity.address, ...(agentId !== undefined ? { agentId } : {}) } }];
  if (cfg.identity.standing) {
    try {
      const subject = (await import("../core/kya.js")).accountSubject(chainId, account);
      const r = await k.kya.resolve(subject, cfg.identity.standing.schemeId, cfg.identity.standing.issuers);
      if (r.level > 0) facets.push({ facetType: "aid:core/kya/v1", provenance: "ATTESTED", issuer: accountRef(chainId, cfg.identity.standing.issuers[0]), validUntil: Number(r.expiresAt), digest: r.assertionId, access: { mode: "PUBLIC" }, resolver: { kind: "erc8419-assertion", chainId, registry: k.kya.registryAddress, schemeId: cfg.identity.standing.schemeId, issuers: cfg.identity.standing.issuers, assertionId: r.assertionId, level: r.level } });
    } catch {
      /* no standing readable: no facet */
    }
  }
  const held = Object.entries(cfg.skills.held);
  if (held.length) {
    const skills = Object.fromEntries(held.map(([name, h]) => [name, { tokenId: h.tokenId, packageHash: h.packageHash ?? null, offered: cfg.skills.offered.includes(name) }]));
    facets.push({ facetType: "aid:skills/erc8338/v1", provenance: "SELF", issuer: self, validUntil: 0, digest: keccakJcs(skills), access: { mode: "PUBLIC" }, resolver: { kind: "erc8338-skill", chainId, registry: k.skills.address, tokenIds: held.map(([, h]) => h.tokenId) } });
  }
  const endpoints = endpointsOf(node);
  if (endpoints.mcp || endpoints.a2a || endpoints.web) {
    const ep = { mcp: endpoints.mcp, a2a: endpoints.a2a, web: endpoints.web };
    facets.push({ facetType: "aid:endpoints/v1", provenance: "SELF", issuer: self, validUntil: 0, digest: keccakJcs(ep), access: { mode: "PUBLIC" }, resolver: { kind: "foga-endpoints", ...ep } });
  }
  return {
    version: "aid-document/v1",
    aid: self,
    did: `did:aid:${self}`,
    ...(agentId !== undefined ? { binding: { registry: k.identity.address, agentId } } : {}),
    livenessWindow: cfg.identity.livenessWindow ?? Number(node.world.file.params.aid.defaultLivenessWindow),
    facets,
  };
}

/** The MCP registry manifest for this cell: the package's server.json with this cell's remote. */
export function buildServerJson(node: Node, version: string): Record<string, unknown> {
  const template = JSON.parse(readFileSync(join(repoRoot(), "server.json"), "utf8")) as Record<string, unknown>;
  const endpoints = endpointsOf(node);
  const remotes = endpoints.mcp ? [{ type: "streamable-http", url: endpoints.mcp, headers: [{ name: "Authorization", description: "Bearer <key> for acts (foga node key new), or a FOGA-EIP712 envelope signed by your wallet; reads and builds need none", isRequired: false, isSecret: true }] }] : [];
  return { ...template, description: `${node.config.presence.name}: a FOGA cell on ${node.world.file.network} (chain ${node.chainId}); reads, dry runs and builds for the public, acts by key or signature`.slice(0, 100), version, remotes };
}

/** Build every document from the configuration and the chain and write them, with the manifest, under the documents directory. */
export async function buildDocuments(node: Node, o: { version: string; dir?: string }): Promise<BuiltDocuments> {
  const cfg = node.config;
  if (!cfg.identity.account) throw new Error("the cell is not born: no account in the configuration (foga cell init first)");
  const dir = resolve(o.dir ?? documentsDir(node));
  mkdirSync(dir, { recursive: true });
  const registration = buildRegistration(node);
  const aidDocument = await buildAidDocument(node, registration);
  const chainId = node.chainId;
  const endpoints = endpointsOf(node);
  const offered = cfg.skills.offered.map((s) => `erc8338:${s}`);
  const ardAgent = agentDescriptor({ chainId, anchor: cfg.identity.account, slug: `cell-${cfg.name.toLowerCase()}`, name: cfg.presence.name, description: cfg.presence.description, url: endpoints.web ?? undefined, capabilities: ["erc8414:fulfiller", "erc8338:holder", ...offered], registration: cfg.identity.agentId ? { registry: `eip155:${chainId}:${node.kernel.identity.address.toLowerCase()}`, agentId: cfg.identity.agentId } : undefined, domain: cfg.runtime.http.publicUrl ? new URL(cfg.runtime.http.publicUrl).hostname : undefined });
  const aufUnit = cellUnitDefinition({ chainId, cell: cfg.identity.account, name: cfg.presence.name, summary: cfg.presence.description || undefined });
  const agentCard = await buildAgentCard(node, { version: o.version });
  const serverJson = buildServerJson(node, o.version);
  const previous = readManifest(dir);
  const docs: Record<string, unknown> = { [DOCUMENT_FILES.registration]: registration, [DOCUMENT_FILES.aidDocument]: aidDocument, [DOCUMENT_FILES.ardAgent]: ardAgent, [DOCUMENT_FILES.aufUnit]: aufUnit, [DOCUMENT_FILES.agentCard]: agentCard, [DOCUMENT_FILES.serverJson]: serverJson };
  const standards: Record<string, string> = { [DOCUMENT_FILES.registration]: "ERC-8004 registration-v1", [DOCUMENT_FILES.aidDocument]: "ERC-8434 aid-document/v1", [DOCUMENT_FILES.ardAgent]: "ERC-8444 agent descriptor", [DOCUMENT_FILES.aufUnit]: "ERC-8454 unit definition", [DOCUMENT_FILES.agentCard]: "A2A 1.0 AgentCard", [DOCUMENT_FILES.serverJson]: "MCP registry server.json (2025-12-11)" };
  const entries: Record<string, DocumentEntry> = {};
  let changed = !previous;
  for (const [file, doc] of Object.entries(docs)) {
    const text = JSON.stringify(doc, null, 2) + "\n";
    writeFileSync(join(dir, file), text);
    const contentHash = keccakJcs(doc);
    entries[file] = { file, contentHash, bytes: Buffer.byteLength(text), standard: standards[file] };
    if (previous && previous.documents[file]?.contentHash !== contentHash) changed = true;
  }
  const manifest: DocumentsManifest = {
    schema: DOCUMENTS_SCHEMA,
    cell: cfg.name,
    account: cfg.identity.account,
    agentId: cfg.identity.agentId ?? null,
    chainId,
    version: previous ? (changed ? previous.version + 1 : previous.version) : 1,
    builtAt: new Date().toISOString(),
    publicUrl: cfg.runtime.http.publicUrl ?? null,
    documents: entries,
  };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { dir, manifest, registration, aidDocument, ardAgent, aufUnit, agentCard, serverJson };
}

export function readManifest(dir: string): DocumentsManifest | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as DocumentsManifest;
    return m.schema === DOCUMENTS_SCHEMA ? m : null;
  } catch {
    return null;
  }
}

/** The documents as built, read back from their directory (for the node to serve and for a publish). */
export function readBuilt(dir: string): BuiltDocuments | null {
  const manifest = readManifest(dir);
  if (!manifest) return null;
  const read = <T>(file: string): T => JSON.parse(readFileSync(join(dir, file), "utf8")) as T;
  return { dir, manifest, registration: read(DOCUMENT_FILES.registration), aidDocument: read(DOCUMENT_FILES.aidDocument), ardAgent: read(DOCUMENT_FILES.ardAgent), aufUnit: read(DOCUMENT_FILES.aufUnit), agentCard: read(DOCUMENT_FILES.agentCard), serverJson: read(DOCUMENT_FILES.serverJson) };
}

export interface OnChainState {
  agentURI: string | null;
  aid: { uri: string; digest: string } | null;
  ard: { descriptorHash: string; descriptorURI: string } | null;
  unit: { version: number; boundaryHash: string } | null;
}

/** What the chain holds now for the four commitments. */
export async function onChainState(node: Node): Promise<OnChainState> {
  const cfg = node.config;
  const k = node.kernel;
  const account = cfg.identity.account!;
  const agentURI = cfg.identity.agentId ? await k.identity.contract().tokenURI(BigInt(cfg.identity.agentId)).catch(() => null) : null;
  const aid = await k.aid.documentURI(account).catch(() => null);
  const ard = cfg.identity.recordId ? await k.ard.recordOf(cfg.identity.recordId).then((r) => ({ descriptorHash: r.descriptorHash, descriptorURI: r.descriptorURI })).catch(() => null) : null;
  let unit: OnChainState["unit"] = null;
  if (cfg.identity.unitId) {
    try {
      const id = BigInt(cfg.identity.unitId);
      const version = await k.units.latestVersion(id);
      const v = await k.units.versionOf(id, version);
      unit = { version, boundaryHash: v.boundaryHash };
    } catch {
      unit = null;
    }
  }
  return { agentURI, aid, ard, unit };
}

export interface PublishStep {
  name: "identity-uri" | "aid-document" | "ard-descriptor" | "unit-version";
  target: string;
  data: string;
  label: string;
  /** What the chain will hold afterwards, for the read-back. */
  expect: { uri?: string; digest?: string; hash?: string };
}

/** The on-chain steps a publish needs: each commitment that differs from what the chain holds; nothing for one that matches. */
export async function publishSteps(node: Node, built: BuiltDocuments): Promise<{ steps: PublishStep[]; unchanged: string[] }> {
  const cfg = node.config;
  const k = node.kernel;
  const state = await onChainState(node);
  const steps: PublishStep[] = [];
  const unchanged: string[] = [];
  if (cfg.identity.agentId) {
    const uri = documentUri(node, DOCUMENT_FILES.registration, built.registration);
    if (state.agentURI === uri) unchanged.push("identity-uri");
    else steps.push({ name: "identity-uri", target: k.identity.address, data: k.identity.contract().interface.encodeFunctionData("setAgentURI", [BigInt(cfg.identity.agentId), uri]), label: `setAgentURI(${cfg.identity.agentId}, ${uri.slice(0, 60)}${uri.length > 60 ? "…" : ""})`, expect: { uri } });
  }
  {
    const c = AID.documentCommitment(built.aidDocument);
    const uri = cfg.runtime.http.publicUrl ? documentUri(node, DOCUMENT_FILES.aidDocument, built.aidDocument) : c.uri;
    if (state.aid && state.aid.digest.toLowerCase() === c.digest.toLowerCase() && state.aid.uri === uri) unchanged.push("aid-document");
    else steps.push({ name: "aid-document", target: k.aid.address, data: k.aid.encodeSetDocumentURI(uri, c.digest), label: `setDocumentURI(${uri.slice(0, 60)}${uri.length > 60 ? "…" : ""}, ${c.digest.slice(0, 10)}…)`, expect: { uri, digest: c.digest } });
  }
  if (cfg.identity.recordId) {
    const p = descriptorHash(built.ardAgent);
    if (state.ard && state.ard.descriptorHash.toLowerCase() === p.hex.toLowerCase()) unchanged.push("ard-descriptor");
    else steps.push({ name: "ard-descriptor", target: k.ard.address, data: k.ard.encodeUpdateDescriptor(cfg.identity.recordId, built.ardAgent), label: `updateDescriptor(${cfg.identity.recordId.slice(0, 10)}…, ${p.hex.slice(0, 10)}…)`, expect: { hash: p.hex } });
  }
  if (cfg.identity.unitId) {
    const hash = k.units.boundaryHash(built.aufUnit);
    if (state.unit && state.unit.boundaryHash.toLowerCase() === hash.toLowerCase()) unchanged.push("unit-version");
    else steps.push({ name: "unit-version", target: k.units.registryAddress, data: k.units.registry().interface.encodeFunctionData("publishVersion", [BigInt(cfg.identity.unitId), hash, dataUriJcs(built.aufUnit), []]), label: `publishVersion(${cfg.identity.unitId}, ${hash.slice(0, 10)}…)`, expect: { hash } });
  }
  return { steps, unchanged };
}

export interface ReadBackRow {
  commitment: string;
  ok: boolean | null;
  detail: string;
}

/** After a publish: what the chain holds against what was built; a URL is fetched when it can be. */
export async function readBack(node: Node, built: BuiltDocuments, o: { fetchUrls?: boolean; timeoutMs?: number } = {}): Promise<ReadBackRow[]> {
  const cfg = node.config;
  const k = node.kernel;
  const rows: ReadBackRow[] = [];
  const state = await onChainState(node);
  let lastFetchProblem = "";
  const fetchJson = async (url: string): Promise<unknown | null> => {
    if (!url.startsWith("http")) return null;
    if (o.fetchUrls === false) {
      lastFetchProblem = "not fetched";
      return null;
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(o.timeoutMs ?? 5000) });
      if (!r.ok) {
        lastFetchProblem = `HTTP ${r.status}`;
        return null;
      }
      return await r.json();
    } catch (e) {
      lastFetchProblem = (e as Error).message;
      return null;
    }
  };
  if (cfg.identity.agentId) {
    const expected = documentUri(node, DOCUMENT_FILES.registration, built.registration);
    if (!state.agentURI) rows.push({ commitment: "ERC-8004 agentURI", ok: false, detail: "no tokenURI readable" });
    else if (state.agentURI !== expected) rows.push({ commitment: "ERC-8004 agentURI", ok: false, detail: `the chain names ${state.agentURI.slice(0, 80)}; built ${expected.slice(0, 80)}` });
    else {
      const identityFacet = built.aidDocument.facets.find((f) => f.facetType === "aid:core/identity/v1");
      const content = state.agentURI.startsWith("data:") ? built.registration : await fetchJson(state.agentURI);
      if (content === null) rows.push({ commitment: "ERC-8004 agentURI", ok: null, detail: `${state.agentURI} is the committed URI; not read from here (${lastFetchProblem}; the node must serve it)` });
      else {
        const digest = keccakJcs(content);
        rows.push({ commitment: "ERC-8004 agentURI", ok: digest === identityFacet?.digest, detail: digest === identityFacet?.digest ? `the registration read from ${state.agentURI.startsWith("data:") ? "the data URI" : state.agentURI} hashes to the AID identity facet's digest ${digest.slice(0, 10)}…` : `the registration read back hashes to ${digest.slice(0, 10)}…, the AID identity facet says ${identityFacet?.digest.slice(0, 10)}…` });
      }
    }
  }
  {
    const c = AID.documentCommitment(built.aidDocument);
    const ok = Boolean(state.aid && state.aid.digest.toLowerCase() === c.digest.toLowerCase());
    rows.push({ commitment: "ERC-8434 documentURI", ok, detail: ok ? `digest ${c.digest.slice(0, 10)}… at ${state.aid!.uri.slice(0, 60)}${state.aid!.uri.length > 60 ? "…" : ""}` : `the chain holds ${state.aid?.digest.slice(0, 10) ?? "nothing"}, built ${c.digest.slice(0, 10)}…` });
    if (ok && state.aid!.uri.startsWith("http")) {
      const content = await fetchJson(state.aid!.uri);
      if (content !== null) rows.push({ commitment: "ERC-8434 document content", ok: AID.documentCommitment(content as AIDDocument).digest.toLowerCase() === c.digest.toLowerCase(), detail: `fetched from ${state.aid!.uri}` });
    }
  }
  if (cfg.identity.recordId) {
    const p = descriptorHash(built.ardAgent);
    const ok = Boolean(state.ard && state.ard.descriptorHash.toLowerCase() === p.hex.toLowerCase());
    rows.push({ commitment: "ERC-8444 descriptor", ok, detail: ok ? `descriptorHash ${p.hex.slice(0, 10)}… on record ${cfg.identity.recordId.slice(0, 10)}…` : `the record holds ${state.ard?.descriptorHash.slice(0, 10) ?? "nothing"}, built ${p.hex.slice(0, 10)}…` });
  }
  if (cfg.identity.unitId) {
    const hash = k.units.boundaryHash(built.aufUnit);
    const ok = Boolean(state.unit && state.unit.boundaryHash.toLowerCase() === hash.toLowerCase());
    rows.push({ commitment: "ERC-8454 unit version", ok, detail: ok ? `version ${state.unit!.version} boundaryHash ${hash.slice(0, 10)}…` : `the latest version holds ${state.unit?.boundaryHash.slice(0, 10) ?? "nothing"}, built ${hash.slice(0, 10)}…` });
  }
  return rows;
}

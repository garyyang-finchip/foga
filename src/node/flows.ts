import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "ethers";
import { endpointsOf } from "../a2a/card.js";
import { ACTIONS, AIFP, OUTCOME, PUBLIC_AUDIENCE, PUBLIC_AUDIENCE_CANONICAL, RELATIONS, ROLES, ZERO32, outcomeName, transportBinding, type BindingDecl, type OutcomeName, type RoleName } from "../core/aifp.js";
import { dataUriJcs, keccakJcs } from "../core/canonical.js";
import { CELL_SOURCE, TENDER_MARKET, fogaDescriptorStatic, fogaParadigm, paradigmFile, type FogaParadigm } from "../core/paradigms.js";
import { exists, readJson } from "../util/fs.js";
import { configPath } from "./config.js";
import { documentsDir, readManifest, type DocumentsManifest } from "./documents.js";
import type { Node } from "./node.js";

/**
 * The cell's information flows (ERC-8489, docs/flows.md): what it keeps beside the registries. Two contexts: its own
 * channel — the cell is the authority, the paradigm is `foga:cell-source/v1`, the cell holds SUBMIT by its own grant,
 * and every publication of its documents is anchored there (publish, then supersede) and, when the cell has a public
 * URL, recorded as disclosed to the public — and the market, where the cell is admitted as SUBMIT and RESPOND by the
 * identity predicate. The store's facts are the source of truth; the files under `flows.dir` are the channel's metadata
 * and the paradigms as registered, laid out for the node to serve.
 */
export const FLOW_FACTS = {
  channel: "flows.channel",
  market: "flows.market",
  anchors: "flows.anchors",
  disclosures: "flows.disclosures",
  watch: "watch.flows",
} as const;

export const FLOW_FILES = { channel: "channel.json", market: "market.json", paradigmsDir: "paradigms" } as const;

export interface ChannelFact {
  channelId: string;
  paradigm: string;
  paradigmId: string;
  authority: string;
  openedAt: number;
  txHash: string;
  metadataURI: string;
  bindingIds: string[];
  /** The cell's own SUBMIT grant (the authority holds no role until it grants itself one). */
  grant: { bindingId: string; roles: number; txHash: string } | null;
}

export interface MarketFact {
  channelId: string;
  admitted: Partial<Record<RoleName, { bindingId: string; txHash: string; at: number }>>;
}

export interface AnchorFact {
  objectRef: string;
  action: "publish" | "supersede";
  recordIndex: number;
  txHash: string;
  at: number;
  /** The documents' version the object is (the manifest's), for the reader. */
  version: number;
  supersedes: string | null;
}

export interface DisclosureFact {
  objectRef: string;
  audience: string;
  txHash: string;
  at: number;
}

/** The flows directory of a cell (configuration `flows.dir`, relative to the configuration's directory). */
export function flowsDir(node: Node): string {
  return configPath(node.loaded, node.config.flows.dir);
}

export function flowsUrl(node: Node, rel: string): string | null {
  const base = node.config.runtime.http.publicUrl;
  return base ? `${base.replace(/\/+$/, "")}/documents/flows/${rel}` : null;
}

/** The file behind `/documents/flows/<rel>`: the channel's and the market's metadata, or a paradigm descriptor as registered. */
export function publicFlowFile(node: Node, rel: string): string | null {
  const dir = flowsDir(node);
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 1 && (parts[0] === FLOW_FILES.channel || parts[0] === FLOW_FILES.market)) return join(dir, parts[0]);
  if (parts.length === 2 && parts[0] === FLOW_FILES.paradigmsDir && /^[a-z0-9.-]+\.json$/.test(parts[1])) return join(dir, parts[0], parts[1]);
  return null;
}

// ---------------------------------------------------------------------------- the channel

/** The channel's metadata document (`foga.flow-channel/1`): what the channel is and where its objects are read. */
export function channelMetadata(node: Node): Record<string, unknown> {
  const cfg = node.config;
  const base = cfg.runtime.http.publicUrl?.replace(/\/+$/, "") ?? null;
  return {
    schema: "foga.flow-channel/1",
    paradigm: CELL_SOURCE,
    purpose: "this cell's self-description: the documents it publishes about itself (registration, AID document, descriptor, unit, card), one publisher, read by anyone, kept as an archive; each publication is anchored here and supersedes the one before",
    cell: cfg.name,
    account: cfg.identity.account ?? null,
    agentId: cfg.identity.agentId ?? null,
    chainId: node.chainId,
    documents: base ? `${base}/documents/manifest.json` : null,
    card: base ? `${base}/.well-known/agent-card.json` : null,
    manifest: base ? `${base}/.well-known/foga-cell.json` : null,
    note: "the object anchored for a publication is keccak256(JCS({schema, documents})) over the manifest's content hashes; a disclosure to the public audience says the documents were readable by anyone, not that anyone read them",
  };
}

export function channelMetadataUri(node: Node): string {
  return flowsUrl(node, FLOW_FILES.channel) ?? dataUriJcs(channelMetadata(node));
}

/** The transport bindings of the cell's entrances, with the capabilities each one actually has (no delivery records anywhere). */
export function cellTransportBindings(node: Node): { name: string; endpoint: string; binding: BindingDecl }[] {
  const ep = endpointsOf(node);
  const out: { name: string; endpoint: string; binding: BindingDecl }[] = [];
  // MCP over Streamable HTTP: the sender proves itself with a FOGA-EIP712 envelope (identity), reads are pulled, responses may stream
  if (ep.mcp) out.push({ name: "mcp", endpoint: ep.mcp, binding: transportBinding(ep.mcp, "mcp/2026-07-28", ["identity", "pull", "stream"]) });
  // A2A 1.0 JSON-RPC: signed metadata identifies the sender; GetTask is a pull
  if (ep.a2a) out.push({ name: "a2a", endpoint: ep.a2a, binding: transportBinding(ep.a2a, "a2a/1.0", ["identity", "pull"]) });
  // the HTTP API and the served documents: the same envelope, pulled
  if (ep.web) out.push({ name: "web", endpoint: ep.web, binding: transportBinding(ep.web, "foga-http/1", ["identity", "pull", "history-retention", "late-join-history"]) });
  return out;
}

export function channelFact(node: Node): ChannelFact | undefined {
  return node.store.getFact<ChannelFact>(FLOW_FACTS.channel);
}

/** The cell's channel id: the configuration's (written back at the opening), else the fact's. */
export function cellChannelId(node: Node): string | null {
  return node.config.flows.channelId ?? channelFact(node)?.channelId ?? null;
}

/** The cell-source paradigm as this world knows it: the id the maintainer registered, else the id of the shipped descriptor. */
export function cellSourceParadigmId(node: Node): string {
  return node.world.file.flows?.paradigms?.[CELL_SOURCE]?.paradigmId ?? keccakJcs(fogaDescriptorStatic(CELL_SOURCE));
}

/** Write the channel's metadata and the paradigms' descriptors under the flows directory, for the node to serve. */
export function writeFlowDocuments(node: Node, paradigms?: FogaParadigm[]): void {
  const dir = flowsDir(node);
  mkdirSync(join(dir, FLOW_FILES.paradigmsDir), { recursive: true });
  writeFileSync(join(dir, FLOW_FILES.channel), JSON.stringify(channelMetadata(node), null, 2) + "\n");
  const list = paradigms ?? (() => {
    try {
      return [fogaParadigm(CELL_SOURCE, node.world), ...(node.kernel.flows.identityVerifierAvailable ? [fogaParadigm(TENDER_MARKET, node.world)] : [])];
    } catch {
      return [] as FogaParadigm[];
    }
  })();
  for (const p of list) writeFileSync(join(dir, FLOW_FILES.paradigmsDir, paradigmFile(p.name).split("/").pop()!), JSON.stringify(p.descriptor, null, 2) + "\n");
}

export function recordChannel(node: Node, fact: ChannelFact): void {
  node.store.setFact(FLOW_FACTS.channel, fact);
  node.config.flows.channelId = fact.channelId;
  node.saveConfig();
  writeFlowDocuments(node);
}

// ---------------------------------------------------------------------------- the publications

/** The object a publication of the documents is: keccak256(JCS({schema, documents})) over the manifest's content hashes — the same content is the same object. */
export function publicationObjectRef(manifest: Pick<DocumentsManifest, "documents">): string {
  const documents = Object.fromEntries(Object.entries(manifest.documents).map(([file, d]) => [file, d.contentHash]));
  return keccakJcs({ schema: "foga.publication/1", documents });
}

export function anchors(node: Node): AnchorFact[] {
  return node.store.getFact<AnchorFact[]>(FLOW_FACTS.anchors) ?? [];
}

export function lastAnchor(node: Node): AnchorFact | null {
  const list = anchors(node);
  return list.length ? list[list.length - 1] : null;
}

export function recordAnchor(node: Node, a: AnchorFact): void {
  const list = anchors(node).filter((x) => x.objectRef.toLowerCase() !== a.objectRef.toLowerCase());
  list.push(a);
  node.store.setFact(FLOW_FACTS.anchors, list);
}

export function disclosures(node: Node): DisclosureFact[] {
  return node.store.getFact<DisclosureFact[]>(FLOW_FACTS.disclosures) ?? [];
}

export function recordDisclosure(node: Node, d: DisclosureFact): void {
  const list = disclosures(node);
  if (!list.some((x) => x.objectRef.toLowerCase() === d.objectRef.toLowerCase() && x.audience === d.audience)) list.push(d);
  node.store.setFact(FLOW_FACTS.disclosures, list);
}

export interface AnchorPlan {
  objectRef: string;
  version: number;
  action: "publish" | "supersede";
  supersedes: string | null;
  relations: { kind: number; objectRef: string }[];
}

/** What anchoring the current publication would be: the first object is published, a later one supersedes the last anchored; null when it is anchored already. */
export function anchorPlan(node: Node, manifest = readManifest(documentsDir(node))): AnchorPlan | null | "unpublished" {
  if (!manifest) return "unpublished";
  const objectRef = publicationObjectRef(manifest);
  const last = lastAnchor(node);
  if (last && last.objectRef.toLowerCase() === objectRef.toLowerCase()) return null;
  if (anchors(node).some((a) => a.objectRef.toLowerCase() === objectRef.toLowerCase())) return null;
  if (!last) return { objectRef, version: manifest.version, action: "publish", supersedes: null, relations: [] };
  return { objectRef, version: manifest.version, action: "supersede", supersedes: last.objectRef, relations: [{ kind: RELATIONS.supersedes, objectRef: last.objectRef }] };
}

/**
 * What the chain knows that the store may not: a publication anchored by this cell (a store from before the channel, a
 * fact dropped) is recorded as such, with no record index and no transaction (recovered), so nothing is anchored twice.
 */
export async function reconcileAnchors(node: Node, manifest = readManifest(documentsDir(node))): Promise<{ objectRef: string; anchoredBy: "this cell" | "another subject" | "nobody" } | null> {
  if (!manifest || !node.cell || !node.kernel.flows.available) return null;
  const objectRef = publicationObjectRef(manifest);
  if (anchors(node).some((a) => a.objectRef.toLowerCase() === objectRef.toLowerCase())) return { objectRef, anchoredBy: "this cell" };
  const by = await node.kernel.flows.anchoredBy(objectRef).catch(() => ZERO32);
  if (by === ZERO32) return { objectRef, anchoredBy: "nobody" };
  if (by.toLowerCase() !== node.kernel.flows.subjectOf(node.cell.address).toLowerCase()) return { objectRef, anchoredBy: "another subject" }; // someone else's object: not ours to record
  recordAnchor(node, { objectRef, action: anchors(node).length ? "supersede" : "publish", recordIndex: -1, txHash: "", at: 0, version: manifest.version, supersedes: lastAnchor(node)?.objectRef ?? null });
  node.store.journal("flows-anchor-recovered", { objectRef, version: manifest.version });
  return { objectRef, anchoredBy: "this cell" };
}

/** Whether the current publication is disclosed to the public already (the store's fact). */
export function disclosedToPublic(node: Node, objectRef: string): boolean {
  return disclosures(node).some((d) => d.objectRef.toLowerCase() === objectRef.toLowerCase() && d.audience === PUBLIC_AUDIENCE_CANONICAL);
}

/**
 * The disclosure as the chain has it: when the store holds no record of the object's disclosure to the public, the channel's
 * disclosure records are read and a DISCLOSED record to the public audience is recorded (txHash empty: recovered, not sent),
 * so a store from before the record — or one that lost the fact — never records the same disclosure twice.
 */
export async function reconcileDisclosures(node: Node, channelId: string, objectRef: string): Promise<boolean> {
  if (disclosedToPublic(node, objectRef)) return true;
  const k = node.kernel;
  const count = await k.flows.disclosureCount(channelId).catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const d = await k.flows.disclosureAt(channelId, i).catch(() => null);
    if (!d) break;
    if (d.kind === 0 && d.objectRef.toLowerCase() === objectRef.toLowerCase() && d.audienceRef.toLowerCase() === PUBLIC_AUDIENCE.toLowerCase()) {
      recordDisclosure(node, { objectRef, audience: PUBLIC_AUDIENCE_CANONICAL, txHash: "", at: d.at });
      node.store.journal("flows-disclosure-recovered", { objectRef, channelId });
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------- the market

export interface MarketView {
  channelId: string;
  source: "configuration" | "world";
}

/** The market channel this cell joins: the configuration's, else the world's default; null when neither names one. */
export function marketOf(node: Node): MarketView | null {
  if (node.config.flows.market.channelId) return { channelId: node.config.flows.market.channelId, source: "configuration" };
  const w = node.world.file.flows?.market;
  return w ? { channelId: w.channelId, source: "world" } : null;
}

export function marketFact(node: Node): MarketFact | undefined {
  return node.store.getFact<MarketFact>(FLOW_FACTS.market);
}

export function recordAdmission(node: Node, channelId: string, role: RoleName, bindingId: string, txHash: string, at: number): void {
  const have = marketFact(node);
  const fact: MarketFact = have && have.channelId.toLowerCase() === channelId.toLowerCase() ? have : { channelId, admitted: {} };
  fact.admitted[role] = { bindingId, txHash, at };
  node.store.setFact(FLOW_FACTS.market, fact);
}

export interface AdmissionMaterial {
  paradigmId: string;
  /** The predicate bytes the registry expects for the role (FOGA's market descriptor compiled for this world), or null when the market's paradigm is another. */
  predicate: string | null;
  predicateHash: string;
  expectedHash: string;
  evidence: string[];
}

/** The predicate and evidence an admission to the market takes for a role; the market's paradigm must be FOGA's tender market for this world. */
export async function admissionMaterial(node: Node, channelId: string, role: RoleName): Promise<AdmissionMaterial> {
  const k = node.kernel;
  const { paradigmId } = await k.flows.currentParadigm(channelId);
  const expectedHash = await k.flows.rolePredicateHash(paradigmId, ROLES[role]);
  const market = k.flows.identityVerifierAvailable ? fogaParadigm(TENDER_MARKET, node.world) : null;
  const mine = market?.bundle.rolePredicates.find((p) => p.role === role) ?? null;
  const account = node.config.identity.account!;
  const agentId = node.config.identity.agentId ?? "0";
  return { paradigmId, predicate: mine && mine.predicateHash.toLowerCase() === expectedHash.toLowerCase() ? mine.predicateHex : null, predicateHash: mine?.predicateHash ?? ZERO32, expectedHash, evidence: [k.flows.identityEvidence(account, agentId)] };
}

export interface Eligibility {
  ok: boolean;
  identityOwned: boolean | null;
  anchorState: string | null;
  detail: string;
}

/** The cell's current eligibility for the identity predicate — read beside the historical role, never in its place. */
export async function currentEligibility(node: Node): Promise<Eligibility> {
  const k = node.kernel;
  const cfg = node.config;
  const account = cfg.identity.account!;
  let identityOwned: boolean | null = null;
  if (cfg.identity.agentId) {
    try {
      identityOwned = getAddress(await k.identity.ownerOf(BigInt(cfg.identity.agentId))) === getAddress(account);
    } catch {
      identityOwned = false;
    }
  } else identityOwned = false;
  const anchorState = await k.aid.stateName(account).catch(() => null);
  const ok = identityOwned === true && anchorState === "ACTIVE";
  return { ok, identityOwned, anchorState, detail: ok ? `agent ${cfg.identity.agentId} owned by the account, anchor ACTIVE` : `${identityOwned ? `agent ${cfg.identity.agentId} owned by the account` : cfg.identity.agentId ? `agent ${cfg.identity.agentId} is not owned by ${account}` : "no ERC-8004 agent id"}; anchor ${anchorState ?? "unreadable"}` };
}

/** The four-valued role of a subject in a channel, read now; a failed read is a failure of the call, not an outcome. */
export async function roleNow(node: Node, channelId: string, subject: string, role: RoleName): Promise<{ outcome: OutcomeName | null; error: string | null }> {
  try {
    return { outcome: outcomeName(await node.kernel.flows.evaluateNow(channelId, subject, ROLES[role])), error: null };
  } catch (e) {
    return { outcome: null, error: (e as Error).message.slice(0, 200) };
  }
}

export { ACTIONS, AIFP, OUTCOME, PUBLIC_AUDIENCE, PUBLIC_AUDIENCE_CANONICAL, exists, readJson };

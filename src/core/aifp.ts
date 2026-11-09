import { getAddress, keccak256, zeroPadValue, type Contract, type ContractRunner, type TransactionReceipt } from "ethers";
import { abi, jcs, keccakUtf8 } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/**
 * ERC-8489 Agent Information Flow Paradigm: versioned rules for how agents provide, observe and redistribute
 * information in a channel, with scoped role bindings and four-valued checks. Three registries (paradigms, channels,
 * participation), a composite predicate verifier and the optional event anchor. This module is the kernel's view of
 * them: the identifiers and encodings that must agree with the contracts bit for bit (subject references, the JCS
 * paradigm id, the predicate node encoding — checked against the upstream vectors in test/aifp.test.ts), the
 * descriptor validation the canonical validator performs (schema, label conditions, compatibility rules), the
 * calldata encoders the catalog's steps use, and the reads the node, the card and the preflight need.
 *
 * Who may call what (0.9.0, docs/flows.md): a cell is the authority of its own channel and admits itself to the
 * market through its account's `execute` — the subject the registries derive from msg.sender is the cell account,
 * never the operator's key. Opening the channel, granting the cell its roles and registering a paradigm are the
 * owner's acts through the account; admitting, anchoring and recording a disclosure are the operator's under the
 * account's allow-list (the `flows` scope group). Nothing is granted to the operator's address on the registries.
 */
export const AIFP = {
  paradigms: "8489/AIFPParadigmRegistry",
  channels: "8489/AIFPChannelRegistry",
  participation: "8489/AIFPParticipationRegistry",
  verifier: "8489/AIFPCompositeVerifier",
  anchor: "8489/AIFPEventAnchor",
  subjectSet: "8489/AIFPSubjectSet",
  objectionWindow: "8489/AIFPObjectionWindow",
  /** FOGA's own identity predicate verifier (contracts/src/FogaIdentityVerifier.sol). */
  identityVerifier: "8489/FogaIdentityVerifier",
} as const;

/** The registries a world must have for the flows to work; the anchor is needed for the records, the rest is optional. */
export const AIFP_CORE = [AIFP.paradigms, AIFP.channels, AIFP.participation, AIFP.verifier, AIFP.anchor] as const;

export const AIFP_INTERFACE_IDS = {
  IAIFPParadigmRegistry: "0xa30ca0da",
  IAIFPChannelRegistry: "0x94dbe6d5",
  IAIFPParticipationRegistry: "0x14c97260",
  IAIFPCompositeVerifier: "0xa5913d6e",
  IAIFPPredicateVerifier: "0xe7a501b7",
  IAIFPSubjectSet: "0x1d1a696d",
  IAIFPEventAnchor: "0x62b24396",
} as const;

/** Role bits (section 2.4). */
export const ROLES = { discover: 1, observe: 2, submit: 4, respond: 8, modify: 16, manageAdmission: 32, manageOrder: 64, manageRemove: 128, manageRules: 256, redistribute: 512, manageDisclosure: 1024 } as const;
export type RoleName = keyof typeof ROLES;
export const ROLE_NAMES: Record<number, RoleName> = Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [v, k])) as Record<number, RoleName>;

/** Verification outcomes (section 2.5). */
export const OUTCOMES = ["SATISFIED", "NOT_SATISFIED", "UNDETERMINABLE", "VERIFIER_ERROR"] as const;
export type OutcomeName = (typeof OUTCOMES)[number];
export const OUTCOME = { SATISFIED: 0, NOT_SATISFIED: 1, UNDETERMINABLE: 2, VERIFIER_ERROR: 3 } as const;

/** Predicate node kinds (section 6.2). */
export const KINDS = { open: 0, allowlist: 1, external: 2, allOf: 3, anyOf: 4, credential: 5, stake: 6, identity: 7, member: 8, decision: 9 } as const;
export type KindName = keyof typeof KINDS;
export const KIND_NAMES: Record<number, KindName> = Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [v, k])) as Record<number, KindName>;
export const MAX_NODES = 64;
export const MAX_DEPTH = 8;

/** Binding declaration kinds and governance effects (section 8.2). */
export const BINDING_KIND = { transport: 0, rules: 1, disputes: 2, safety: 3, economic: 4 } as const;
export const EFFECT = { rules: 1, participation: 2, disclosure: 4 } as const;
export const ADOPTION_MODE = { automatic: 0, confirmed: 1 } as const;

/** Transport binding capabilities (section 12). */
export const CAPABILITIES = { identity: 1, "rule-association": 2, push: 4, pull: 8, stream: 16, batch: 32, "delivery-records": 64, "history-retention": 128, "late-join-history": 256, "payload-protection": 512, "metadata-protection": 1024, "membership-privacy": 2048, "total-order": 4096, "absence-detection": 8192 } as const;
export type CapabilityName = keyof typeof CAPABILITIES;

/** Role binding basis kinds (section 9.1) and states. */
export const BASIS = { manager: 0, allowlist: 1, predicate: 2, decision: 3, external: 4 } as const;
export const BASIS_NAMES = ["manager", "allowlist", "predicate", "decision", "external"] as const;
export const BINDING_STATE = ["Granted", "Suspended", "Revoked"] as const;
export const CHANNEL_STATE = ["Active", "Frozen", "Closed"] as const;

/** Event-anchor actions and relations (section 13.1); disclosure record kinds (section 8.3). */
export const ACTIONS = { publish: 0, submit: 1, respond: 2, modify: 3, forward: 4, derive: 5, synthesize: 6, supersede: 7, retract: 8 } as const;
export type ActionName = keyof typeof ACTIONS;
export const RELATIONS = { replyTo: 0, forwards: 1, derivesFrom: 2, synthesizes: 3, references: 4, supersedes: 5, retracts: 6 } as const;
export type RelationName = keyof typeof RELATIONS;
export const DISCLOSURE_KIND = { disclosed: 0, restricted: 1 } as const;

export const ZERO32 = "0x" + "00".repeat(32);
export const ZERO_ADDRESS = "0x" + "00".repeat(20);

// ---------------------------------------------------------------------------- subject references (section 3)

function lowercaseAddress(address: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`${address} is not an address`);
  return address.toLowerCase();
}

/** `eip155-address:<chainId>:<0x + 40 lowercase hex>` — the reference of an account; the registries derive it from msg.sender. Any casing is accepted and lowercased. */
export function canonicalAddressSubject(chainId: number | bigint, address: string): string {
  return `eip155-address:${chainId}:${lowercaseAddress(address)}`;
}

export function subjectOfAddress(chainId: number | bigint, address: string): string {
  return keccakUtf8(canonicalAddressSubject(chainId, address));
}

/** `erc8004:<chainId>:<registry lowercase>:<agentId>` — an agent in an ERC-8004 identity registry. */
export function canonicalErc8004Subject(chainId: number | bigint, registry: string, agentId: bigint | number | string): string {
  return `erc8004:${chainId}:${lowercaseAddress(registry)}:${BigInt(agentId)}`;
}

export function subjectOfErc8004(chainId: number | bigint, registry: string, agentId: bigint | number | string): string {
  return keccakUtf8(canonicalErc8004Subject(chainId, registry, agentId));
}

/** `ext:<namespace>:<identifier>` — an identifier of some other system; the namespace is lowercase `a-z0-9.-`. */
export function canonicalExtSubject(namespace: string, identifier: string): string {
  if (!/^[a-z0-9.-]+$/.test(namespace)) throw new Error(`subject namespace ${namespace} is not lowercase a-z0-9.-`);
  if (!identifier) throw new Error("subject identifier is empty");
  return `ext:${namespace}:${identifier}`;
}

export function subjectOfExt(namespace: string, identifier: string): string {
  return keccakUtf8(canonicalExtSubject(namespace, identifier));
}

/** `did:<method>:<id>`. */
export function subjectOfDid(method: string, id: string): string {
  return keccakUtf8(`did:${method.toLowerCase()}:${id}`);
}

/** The reference of a canonical string given as such (`<scheme>:<domain>:<identifier>`). */
export function subjectOfCanonical(canonical: string): string {
  if (!/^[a-z0-9-]+:[^:]*:.+$/.test(canonical)) throw new Error(`${canonical} is not a canonical subject string (<scheme>:<domain>:<identifier>)`);
  return keccakUtf8(canonical);
}

/** The audience reference FOGA records a public disclosure to: everyone who can read the cell's documents. */
export const PUBLIC_AUDIENCE = subjectOfExt("foga", "public");
export const PUBLIC_AUDIENCE_CANONICAL = canonicalExtSubject("foga", "public");

// ---------------------------------------------------------------------------- identifiers (section 5.1)

/** paradigmId = keccak256(utf8(JCS(descriptor))). */
export function paradigmIdOf(descriptor: unknown): string {
  return keccakUtf8(jcs(descriptor));
}

export function familyIdOf(family: string): string {
  return keccakUtf8(family);
}

export function labelIdOf(label: string): string {
  return keccakUtf8(label);
}

// ---------------------------------------------------------------------------- predicates (section 6)

export interface PredicateNode {
  kind: number;
  childStart: number;
  childCount: number;
  verifier: string;
  ref: string;
  params: string;
}

export const NODE_TUPLE = "tuple(uint8 kind,uint8 childStart,uint8 childCount,address verifier,bytes32 ref,bytes params)[]";

const PROOF_MODE: Record<string, number> = { attested: 0, proved: 1 };
const STAKE_PERIOD: Record<string, number> = { active: 0, epoch: 1, lockup: 2 };
const IDENTITY_STATE: Record<string, number> = { registered: 0, active: 1, bound: 2 };

function lowerAddress(a: unknown, what: string): string {
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`predicate: ${what} is not an address: ${String(a)}`);
  return a.toLowerCase();
}

function bytes32Of(v: unknown, what: string): string {
  if (v === undefined) return ZERO32;
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`predicate: ${what} is not bytes32: ${String(v)}`);
  return v.toLowerCase();
}

function hexBytesOf(v: unknown, what: string): string {
  if (v === undefined) return "0x";
  if (typeof v !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(v)) throw new Error(`predicate: ${what} is not hex bytes: ${String(v)}`);
  return v.toLowerCase();
}

/** The node of a one-key JSON predicate object, and the child predicates when it is a composite. */
function nodeOf(json: unknown): { node: PredicateNode; children: unknown[] } {
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new Error("predicate: must be an object");
  const keys = Object.keys(json);
  if (keys.length !== 1) throw new Error(`predicate: exactly one key expected, got [${keys.join(", ")}]`);
  const key = keys[0];
  const v = (json as Record<string, any>)[key];
  const leaf = (kind: number, verifier: string, ref: string, params: string) => ({ node: { kind, childStart: 0, childCount: 0, verifier, ref, params }, children: [] });
  switch (key) {
    case "open":
      if (v !== true) throw new Error("predicate: open must be true");
      return leaf(KINDS.open, ZERO_ADDRESS, ZERO32, "0x");
    case "allowlist":
      return leaf(KINDS.allowlist, lowerAddress(v.set, "allowlist.set"), ZERO32, "0x");
    case "external":
      return leaf(KINDS.external, lowerAddress(v.verifier, "external.verifier"), bytes32Of(v.ref, "external.ref"), hexBytesOf(v.params, "external.params"));
    case "credential": {
      if (!(v.proofMode in PROOF_MODE)) throw new Error(`predicate: credential.proofMode invalid: ${v.proofMode}`);
      if (!Number.isInteger(v.minLevel) || v.minLevel < 0 || v.minLevel > 255) throw new Error("predicate: credential.minLevel must be 0..255");
      const issuers = ((v.issuers as unknown[] | undefined) ?? []).map((a) => lowerAddress(a, "credential.issuers[]"));
      const params = abi.encode(["uint256", "uint8", "uint256", "address[]"], [v.minLevel, PROOF_MODE[v.proofMode], v.freshnessSeconds ?? 0, issuers]);
      return leaf(KINDS.credential, lowerAddress(v.verifier, "credential.verifier"), bytes32Of(v.scheme, "credential.scheme"), params);
    }
    case "stake": {
      if (!(v.period in STAKE_PERIOD)) throw new Error(`predicate: stake.period invalid: ${v.period}`);
      if (typeof v.minAmount !== "string" || !/^[0-9]+$/.test(v.minAmount)) throw new Error("predicate: stake.minAmount must be a decimal string");
      const m = /^eip155:([0-9]+)$/.exec(String(v.chain ?? ""));
      if (!m) throw new Error(`predicate: stake.chain must be eip155:<id>, got ${v.chain}`);
      const asset = v.asset === "native" ? ZERO_ADDRESS : lowerAddress(v.asset, "stake.asset");
      const params = abi.encode(["uint256", "address", "address", "uint256", "uint8"], [BigInt(m[1]), lowerAddress(v.contract, "stake.contract"), asset, BigInt(v.minAmount), STAKE_PERIOD[v.period]]);
      return leaf(KINDS.stake, lowerAddress(v.verifier, "stake.verifier"), ZERO32, params);
    }
    case "identity": {
      if (!(v.requiredState in IDENTITY_STATE)) throw new Error(`predicate: identity.requiredState invalid: ${v.requiredState}`);
      const registry = lowerAddress(v.registry, "identity.registry");
      return leaf(KINDS.identity, lowerAddress(v.verifier, "identity.verifier"), zeroPadValue(registry, 32), abi.encode(["uint8"], [IDENTITY_STATE[v.requiredState]]));
    }
    case "member":
      return leaf(KINDS.member, lowerAddress(v.verifier, "member.verifier"), bytes32Of(v.group, "member.group"), "0x");
    case "decision":
      return leaf(KINDS.decision, lowerAddress(v.verifier, "decision.verifier"), bytes32Of(v.decision, "decision.decision"), "0x");
    case "allOf":
    case "anyOf": {
      if (!Array.isArray(v) || v.length === 0) throw new Error(`predicate: ${key} must be a non-empty array`);
      return { node: { kind: KINDS[key], childStart: 0, childCount: v.length, verifier: ZERO_ADDRESS, ref: ZERO32, params: "0x" }, children: v };
    }
    default:
      throw new Error(`predicate: unknown predicate key ${key}`);
  }
}

/** A JSON predicate as the node array: breadth-first allocation, so every child index is greater than its parent's. */
export function predicateNodes(json: unknown): PredicateNode[] {
  const nodes: (PredicateNode | null)[] = [null];
  const queue: { json: unknown; index: number; depth: number }[] = [{ json, index: 0, depth: 0 }];
  while (queue.length) {
    const { json: j, index, depth } = queue.shift()!;
    if (depth > MAX_DEPTH) throw new Error(`predicate: depth exceeds ${MAX_DEPTH}`);
    const { node, children } = nodeOf(j);
    if (children.length) {
      node.childStart = nodes.length;
      node.childCount = children.length;
      for (const child of children) {
        const childIndex = nodes.length;
        nodes.push(null);
        queue.push({ json: child, index: childIndex, depth: depth + 1 });
      }
    }
    nodes[index] = node;
    if (nodes.length > MAX_NODES) throw new Error(`predicate: more than ${MAX_NODES} nodes`);
  }
  return nodes as PredicateNode[];
}

export function encodePredicateNodes(nodes: PredicateNode[]): string {
  return abi.encode([NODE_TUPLE], [nodes.map((n) => [n.kind, n.childStart, n.childCount, n.verifier, n.ref, n.params])]);
}

export interface CompiledPredicate {
  nodes: PredicateNode[];
  /** abi.encode(Node[]): what `admit` takes as `predicate`. */
  encoding: string;
  /** keccak256 of the encoding: what the paradigm commits to per role. */
  hash: string;
}

export function compilePredicate(json: unknown): CompiledPredicate {
  const nodes = predicateNodes(json);
  const encoding = encodePredicateNodes(nodes);
  return { nodes, encoding, hash: keccak256(encoding) };
}

/** The four-valued composition (section 2.5): values above 3 normalize to VERIFIER_ERROR; an empty list is rejected. */
export function normalizeOutcome(v: number): number {
  return v > 3 ? OUTCOME.VERIFIER_ERROR : v;
}

export function allOf(outcomes: number[]): number {
  if (!outcomes.length) throw new Error("allOf: empty");
  const o = outcomes.map(normalizeOutcome);
  if (o.includes(OUTCOME.NOT_SATISFIED)) return OUTCOME.NOT_SATISFIED;
  if (o.includes(OUTCOME.UNDETERMINABLE)) return OUTCOME.UNDETERMINABLE;
  if (o.includes(OUTCOME.VERIFIER_ERROR)) return OUTCOME.VERIFIER_ERROR;
  return OUTCOME.SATISFIED;
}

export function anyOf(outcomes: number[]): number {
  if (!outcomes.length) throw new Error("anyOf: empty");
  const o = outcomes.map(normalizeOutcome);
  if (o.includes(OUTCOME.SATISFIED)) return OUTCOME.SATISFIED;
  if (o.includes(OUTCOME.UNDETERMINABLE)) return OUTCOME.UNDETERMINABLE;
  if (o.includes(OUTCOME.VERIFIER_ERROR)) return OUTCOME.VERIFIER_ERROR;
  return OUTCOME.NOT_SATISFIED;
}

export function outcomeName(v: number | bigint): OutcomeName {
  return OUTCOMES[normalizeOutcome(Number(v))];
}

// ---------------------------------------------------------------------------- descriptors (section 5)

const CARRIERS = ["delivery", "shared-object"];
const OPERATORS = ["fan-out", "fan-in", "feedback", "n-party", "select", "forward", "derive", "merge"];
const CONTRIBUTORS = ["single", "roster", "qualified", "open"];
const CONTROLLERS = ["source", "moderator", "protocol", "decision-body", "none"];
const ENUMS: Record<string, string[]> = {
  discovery: ["public-directory", "directed", "undiscoverable", "unspecified"],
  "observation.readScope": ["open", "members", "predicate", "collector-only", "unspecified"],
  "observation.submissionVisibility": ["all", "collector-only", "unspecified"],
  "observation.payloadProtection": ["none", "e2ee", "unspecified"],
  "observation.metadataProtection": ["none", "partial", "full", "unspecified"],
  "contribution.actions[]": ["publish", "submit", "respond", "modify"],
  "contribution.acquisition": ["open", "manager", "predicate", "closed", "unspecified"],
  "contribution.expiry": ["none", "fixed", "renewable", "unspecified"],
  "history.lateJoiner": ["none", "all", "since-join", "unspecified"],
  "history.retention": ["none", "bounded", "indefinite", "unspecified"],
  "time.correlation": ["none", "request-response", "unspecified"],
  "time.delivery[]": ["push", "pull", "stream", "batch"],
  "time.batching": ["none", "epoch", "unspecified"],
  "time.clock": ["registry"],
  "time.absence": ["none", "rule-defined"],
  disclosureTiming: ["immediate", "scheduled", "conditional", "commit-reveal", "unspecified"],
  contributorVisibility: ["identified", "pseudonymous", "anonymous-qualified", "anonymous", "per-audience", "unspecified"],
  "admissionBasis[]": ["prior-link", "referral", "open-discovery"],
  representation: ["allowed", "disallowed", "unspecified"],
  "objectRelations[]": ["replyTo", "forwards", "derivesFrom", "synthesizes", "references", "supersedes", "retracts"],
  "ordering.sequencer": ["protocol", "moderator", "none", "unspecified"],
  "ordering.order": ["total", "partial", "unspecified"],
};
const CAPABILITY_NAMES = Object.keys(CAPABILITIES);
const LABEL_RE = /^aifp:(paradigm|ext)\/([a-z0-9][a-z0-9.-]*)(?:\/([a-z0-9][a-z0-9.-]*))?\/v([0-9]+)$/;

/** The decidable identification conditions of the eleven named paradigms (section 5.2). */
export const LABEL_CONDITIONS: Record<string, (d: any) => boolean> = {
  source: (d) => d.cardinality.contributors === "single" && has(d.operators, "fan-out"),
  intake: (d) => has(d.operators, "fan-in") && d.dimensions.observation.submissionVisibility === "collector-only",
  direct: (d) => d.cardinality.pairwise === true && has(d.operators, "feedback"),
  panel: (d) => d.cardinality.contributors === "roster" && has(d.operators, "n-party") && ["open", "predicate"].includes(d.dimensions.observation.readScope) && ["manager", "closed"].includes(d.dimensions.contribution.acquisition),
  club: (d) => ["qualified", "open"].includes(d.cardinality.contributors) && has(d.operators, "n-party") && ["open", "predicate"].includes(d.dimensions.contribution.acquisition),
  meeting: (d) => d.cardinality.contributors === "roster" && has(d.operators, "n-party") && d.dimensions.observation.readScope === "members" && ["manager", "closed"].includes(d.dimensions.contribution.acquisition),
  archive: (d) => has(d.carriers, "shared-object") && has(d.dimensions.time.delivery, "pull") && d.dimensions.history.mutable === false,
  blackboard: (d) => has(d.carriers, "shared-object") && d.dimensions.history.mutable === true && has(d.operators, "n-party"),
  dispatch: (d) => has(d.operators, "select"),
  forward: (d) => has(d.operators, "forward") && d.dimensions.redistribution.forward === true,
  derive: (d) => (has(d.operators, "derive") || has(d.operators, "merge")) && d.dimensions.redistribution.derive === true,
};

function has(arr: unknown, v: string): boolean {
  return Array.isArray(arr) && arr.includes(v);
}

export interface RolePredicateBundle {
  role: RoleName;
  roleBit: number;
  predicateHex: string;
  predicateHash: string;
  nodeCount: number;
}

export interface DescriptorBundle {
  family: string;
  familyId: string;
  labels: string[];
  labelIds: { label: string; id: string }[];
  canonical: string;
  paradigmId: string;
  rolePredicates: RolePredicateBundle[];
  warnings: string[];
}

export interface DescriptorValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  bundle: DescriptorBundle | null;
}

/**
 * The canonical validator (section 5.3) as FOGA runs it before registering or opening anything: the descriptor's
 * shape and vocabulary, the identification condition of every reserved label, the compatibility rules (5.4), the
 * absence-rule consistency, and the per-role predicate encodings. The registry checks only the hash; this is where a
 * wrong descriptor is caught.
 */
export function validateDescriptor(d: any): DescriptorValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const obj = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!obj(d)) return { ok: false, errors: ["schema: the descriptor is not an object"], warnings, bundle: null };
  const allowedTop = new Set(["aifp", "family", "version", "title", "labels", "carriers", "operators", "cardinality", "dimensions", "predicates", "requiredBindings", "extensions"]);
  for (const k of Object.keys(d)) if (!allowedTop.has(k)) err(`schema: /${k} is not a descriptor member`);
  for (const k of ["aifp", "family", "version", "labels", "carriers", "operators", "cardinality", "dimensions"]) if (!(k in d)) err(`schema: / must have required property '${k}'`);
  if (d.aifp !== undefined && d.aifp !== "1") err('schema: /aifp must be "1"');
  if (d.family !== undefined && (typeof d.family !== "string" || !/^[a-z0-9][a-z0-9.-]*$/.test(d.family))) err("schema: /family must be a lowercase dotted name");
  if (d.version !== undefined && typeof d.version !== "string") err("schema: /version must be a string");
  if (d.title !== undefined && typeof d.title !== "string") err("schema: /title must be a string");
  const enumList = (path: string, v: unknown, values: string[], arr: boolean) => {
    if (arr) {
      if (!Array.isArray(v)) return err(`schema: /${path} must be an array`);
      for (const x of v) if (!values.includes(x as string)) err(`schema: /${path} has ${JSON.stringify(x)}, not one of [${values.join(", ")}]`);
      if (new Set(v).size !== v.length) err(`schema: /${path} repeats a value`);
    } else if (!values.includes(v as string)) err(`schema: /${path} is ${JSON.stringify(v)}, not one of [${values.join(", ")}]`);
  };
  if (d.labels !== undefined) {
    if (!Array.isArray(d.labels) || d.labels.some((l: unknown) => typeof l !== "string")) err("schema: /labels must be an array of strings");
  }
  if (d.carriers !== undefined) {
    enumList("carriers", d.carriers, CARRIERS, true);
    if (Array.isArray(d.carriers) && !d.carriers.length) err("schema: /carriers must not be empty");
  }
  if (d.operators !== undefined) {
    enumList("operators", d.operators, OPERATORS, true);
    if (Array.isArray(d.operators) && !d.operators.length) err("schema: /operators must not be empty");
  }
  if (d.cardinality !== undefined) {
    if (!obj(d.cardinality)) err("schema: /cardinality must be an object");
    else {
      for (const k of Object.keys(d.cardinality)) if (!["contributors", "pairwise"].includes(k)) err(`schema: /cardinality/${k} is not a member`);
      enumList("cardinality/contributors", d.cardinality.contributors, CONTRIBUTORS, false);
      if (typeof d.cardinality.pairwise !== "boolean") err("schema: /cardinality/pairwise must be a boolean");
    }
  }
  const dims = d.dimensions;
  if (dims !== undefined) {
    if (!obj(dims)) err("schema: /dimensions must be an object");
    else {
      const need = ["discovery", "observation", "contribution", "management", "redistribution", "history", "time", "disclosureTiming", "contributorVisibility", "admissionBasis", "representation", "objectRelations", "ordering"];
      for (const k of Object.keys(dims)) if (!need.includes(k)) err(`schema: /dimensions/${k} is not a dimension`);
      for (const k of need) if (!(k in dims)) err(`schema: /dimensions must have required property '${k}'`);
      const sub = (name: string, fields: Record<string, "enum" | "enum[]" | "boolean" | "controllers">) => {
        const s = dims[name];
        if (s === undefined) return;
        if (!obj(s)) return err(`schema: /dimensions/${name} must be an object`);
        for (const k of Object.keys(s)) if (!(k in fields)) err(`schema: /dimensions/${name}/${k} is not a member`);
        for (const [k, kind] of Object.entries(fields)) {
          if (!(k in s)) {
            err(`schema: /dimensions/${name} must have required property '${k}'`);
            continue;
          }
          if (kind === "boolean") {
            if (typeof s[k] !== "boolean") err(`schema: /dimensions/${name}/${k} must be a boolean`);
          } else if (kind === "controllers") enumList(`dimensions/${name}/${k}`, s[k], CONTROLLERS, true);
          else enumList(`dimensions/${name}/${k}`, s[k], ENUMS[`${name}.${k}${kind === "enum[]" ? "[]" : ""}`], kind === "enum[]");
        }
      };
      if (dims.discovery !== undefined) enumList("dimensions/discovery", dims.discovery, ENUMS.discovery, false);
      sub("observation", { readScope: "enum", submissionVisibility: "enum", payloadProtection: "enum", metadataProtection: "enum" });
      sub("contribution", { actions: "enum[]", acquisition: "enum", transferable: "boolean", expiry: "enum" });
      sub("management", { admission: "controllers", ordering: "controllers", removal: "controllers", rules: "controllers", disclosure: "controllers" });
      sub("redistribution", { forward: "boolean", quote: "boolean", derive: "boolean", publishElsewhere: "boolean" });
      sub("history", { lateJoiner: "enum", retention: "enum", mutable: "boolean" });
      sub("time", { realtime: "boolean", correlation: "enum", delivery: "enum[]", batching: "enum", clock: "enum", absence: "enum" });
      if (dims.disclosureTiming !== undefined) enumList("dimensions/disclosureTiming", dims.disclosureTiming, ENUMS.disclosureTiming, false);
      if (dims.contributorVisibility !== undefined) enumList("dimensions/contributorVisibility", dims.contributorVisibility, ENUMS.contributorVisibility, false);
      if (dims.admissionBasis !== undefined) enumList("dimensions/admissionBasis", dims.admissionBasis, ENUMS["admissionBasis[]"], true);
      if (dims.representation !== undefined) enumList("dimensions/representation", dims.representation, ENUMS.representation, false);
      if (dims.objectRelations !== undefined) enumList("dimensions/objectRelations", dims.objectRelations, ENUMS["objectRelations[]"], true);
      sub("ordering", { sequencer: "enum", order: "enum", observable: "boolean" });
    }
  }
  if (d.predicates !== undefined) {
    if (!obj(d.predicates)) err("schema: /predicates must be an object keyed by role name");
    else for (const k of Object.keys(d.predicates)) if (!(k in ROLES)) err(`predicates: unknown role ${k}`);
  }
  if (d.requiredBindings !== undefined) {
    if (!obj(d.requiredBindings)) err("schema: /requiredBindings must be an object");
    else {
      for (const k of Object.keys(d.requiredBindings)) if (k !== "capabilities") err(`schema: /requiredBindings/${k} is not a member`);
      if (d.requiredBindings.capabilities !== undefined) enumList("requiredBindings/capabilities", d.requiredBindings.capabilities, CAPABILITY_NAMES, true);
    }
  }
  if (d.extensions !== undefined) {
    if (!obj(d.extensions)) err("schema: /extensions must be an object");
    else {
      for (const k of Object.keys(d.extensions)) if (!["economic", "modality", "absence", "ext"].includes(k)) err(`schema: /extensions/${k} is not a member`);
      if (d.extensions.ext !== undefined) {
        if (!Array.isArray(d.extensions.ext)) err("schema: /extensions/ext must be an array");
        else {
          for (const e of d.extensions.ext) {
            if (!obj(e) || typeof e.id !== "string" || typeof e.required !== "boolean") err("schema: /extensions/ext[] entries are {id, required}");
            else if (!/^aifp:ext\/[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*\/v[0-9]+$/.test(e.id)) err(`schema: /extensions/ext id ${e.id} is not aifp:ext/<vendor>/<name>/vN`);
          }
          const ids = d.extensions.ext.map((e: any) => e?.id);
          if (new Set(ids).size !== ids.length) err("extensions.ext: duplicate extension ids");
        }
      }
      if (d.extensions.absence !== undefined) {
        const a = d.extensions.absence;
        if (!obj(a)) err("schema: /extensions/absence must be an object");
        else {
          for (const k of ["rule", "windowSeconds", "objectionRole", "defaultOutcome"]) if (!(k in a)) err(`schema: /extensions/absence must have required property '${k}'`);
          if (a.rule !== undefined && !["objection-window", "liveness"].includes(a.rule)) err(`schema: /extensions/absence/rule is ${JSON.stringify(a.rule)}`);
          if (a.objectionRole !== undefined && !["respond", "observe", "submit", "modify"].includes(a.objectionRole)) err(`schema: /extensions/absence/objectionRole is ${JSON.stringify(a.objectionRole)}`);
          if (a.windowSeconds !== undefined && (!Number.isInteger(a.windowSeconds) || a.windowSeconds <= 0)) err("schema: /extensions/absence/windowSeconds must be a positive integer");
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors, warnings, bundle: null };

  // the reserved labels: each must be a defined name whose identification condition holds
  for (const label of d.labels as string[]) {
    const m = LABEL_RE.exec(label);
    if (!m) {
      err(`label ${label}: malformed`);
      continue;
    }
    const [, ns, name, sub, version] = m;
    if (ns === "ext") continue;
    if (sub !== undefined) {
      err(`label ${label}: aifp:paradigm labels take a single name segment`);
      continue;
    }
    if (version !== "1") {
      err(`label ${label}: only v1 named paradigms are defined`);
      continue;
    }
    const cond = LABEL_CONDITIONS[name];
    if (!cond) {
      err(`label ${label}: "${name}" is not a defined named paradigm (reserved namespace)`);
      continue;
    }
    if (!cond(d)) err(`label ${label}: identification condition does not hold`);
  }
  const undeclared = Object.keys(LABEL_CONDITIONS).filter((n) => LABEL_CONDITIONS[n](d) && !(d.labels as string[]).includes(`aifp:paradigm/${n}/v1`));
  if (undeclared.length) warnings.push(`conditions also hold for undeclared names: ${undeclared.join(", ")}`);

  // the absence rule (5.1), as the canonical validator checks it
  const ruleDefined = dims.time.absence === "rule-defined";
  const hasAbsence = Boolean(d.extensions?.absence);
  if (ruleDefined && !hasAbsence) err('absence: dimensions.time.absence is "rule-defined" but extensions.absence is missing');
  if (!ruleDefined && hasAbsence) err('absence: extensions.absence is present but dimensions.time.absence is not "rule-defined"');
  // the compatibility rules (5.4). The ERC says a validator MUST reject these; the upstream canonical validator at the locked
  // commit checks none of them (its blind-review example carries anonymous-qualified visibility with no credential predicate
  // and is published as valid), so FOGA reports them as warnings and stays byte-compatible with what the registries hold —
  // a finding for the upstream repository, not a rule FOGA relaxes on its own paradigms (neither of which trips one).
  if (dims.disclosureTiming === "commit-reveal" && !has(d.carriers, "delivery") && !(has(d.carriers, "shared-object") && dims.history.retention !== "none")) warnings.push("compatibility (5.4): commit-reveal disclosure timing without a delivery carrier or a shared-object carrier that retains history");
  if (dims.contributorVisibility === "anonymous-qualified") {
    const contributionRoles = ["submit", "respond", "modify"];
    const hasCredential = contributionRoles.some((r) => JSON.stringify(d.predicates?.[r] ?? null).includes('"credential"'));
    if (!hasCredential) warnings.push("compatibility (5.4): anonymous-qualified contributor visibility without a credential predicate on a contribution role");
  }
  if (dims.ordering.sequencer === "moderator" && !has(dims.management.ordering, "moderator")) warnings.push("compatibility (5.4): ordering.sequencer is moderator while management.ordering does not contain moderator");

  // the per-role predicates
  const rolePredicates: RolePredicateBundle[] = [];
  for (const [role, json] of Object.entries(d.predicates ?? {})) {
    try {
      const c = compilePredicate(json);
      rolePredicates.push({ role: role as RoleName, roleBit: ROLES[role as RoleName], predicateHex: c.encoding, predicateHash: c.hash, nodeCount: c.nodes.length });
    } catch (e) {
      err(`predicates.${role}: ${(e as Error).message}`);
    }
  }
  rolePredicates.sort((a, b) => a.roleBit - b.roleBit);
  if (errors.length) return { ok: false, errors, warnings, bundle: null };

  const canonical = jcs(d);
  return {
    ok: true,
    errors,
    warnings,
    bundle: { family: d.family, familyId: familyIdOf(d.family), labels: d.labels, labelIds: (d.labels as string[]).map((l) => ({ label: l, id: labelIdOf(l) })), canonical, paradigmId: keccakUtf8(canonical), rolePredicates, warnings },
  };
}

/** The validated bundle, or an error naming every problem. */
export function descriptorBundle(d: unknown, what = "descriptor"): DescriptorBundle {
  const v = validateDescriptor(d);
  if (!v.ok) throw new Error(`${what} is not a valid AIFP paradigm descriptor:\n  ${v.errors.join("\n  ")}`);
  return v.bundle!;
}

/** The capability bitmask of a list of capability names. */
export function capabilityMask(names: readonly CapabilityName[]): number {
  return names.reduce((m, n) => m | CAPABILITIES[n], 0);
}

export function capabilityNames(mask: number): CapabilityName[] {
  return (Object.keys(CAPABILITIES) as CapabilityName[]).filter((n) => (mask & CAPABILITIES[n]) !== 0);
}

export function roleMask(names: readonly RoleName[]): number {
  return names.reduce((m, n) => m | ROLES[n], 0);
}

export function roleNames(mask: number): RoleName[] {
  return (Object.keys(ROLES) as RoleName[]).filter((n) => (mask & ROLES[n]) !== 0);
}

// ---------------------------------------------------------------------------- structs

export interface BindingDecl {
  kind: number;
  target: string;
  version: string;
  capabilities: number;
  effectScope: number;
  adoptionMode: number;
  authorizationRef: string;
}

/** A transport binding for an endpoint: the target is keccak256 of the endpoint URL, the version keccak256 of the protocol's name. */
export function transportBinding(endpoint: string, protocolVersion: string, capabilities: readonly CapabilityName[]): BindingDecl {
  return { kind: BINDING_KIND.transport, target: keccakUtf8(endpoint), version: keccakUtf8(protocolVersion), capabilities: capabilityMask(capabilities), effectScope: 0, adoptionMode: ADOPTION_MODE.automatic, authorizationRef: ZERO32 };
}

export function bindingArray(b: BindingDecl): unknown[] {
  return [b.kind, b.target, b.version, b.capabilities, b.effectScope, b.adoptionMode, b.authorizationRef, true];
}

export interface ChannelRecord {
  authority: string;
  parent: string;
  state: number;
  stateName: string;
  openedAt: number;
  metadataURI: string;
}

export interface RoleBinding {
  channelId: string;
  subject: string;
  onBehalfOf: string;
  roles: number;
  roleNames: RoleName[];
  scopeRef: string;
  basisKind: number;
  basisName: string;
  basisRef: string;
  outcomeAtGrant: number;
  ruleVersion: string;
  validFrom: number;
  validUntil: number;
  revokedAt: number;
  suspendedAt: number;
  reinstatedAt: number;
  suspendedBy: string;
  admittedEpoch: number;
  state: number;
  stateName: string;
}

export interface ParadigmRecord {
  family: string;
  supersedes: string;
  registrant: string;
  registeredAt: number;
  descriptorURI: string;
}

export interface EventRecord {
  channelId: string;
  subject: string;
  action: number;
  actionName: ActionName | string;
  objectRef: string;
  ruleVersion: string;
  at: number;
}

// ---------------------------------------------------------------------------- the kernel module

export class Flows {
  constructor(readonly world: World) {}

  /** True when this world has the registries, the verifier and the anchor (an extension in 0.9.0). */
  get available(): boolean {
    return AIFP_CORE.every((id) => this.world.has(id));
  }

  /** True when the world has FOGA's identity predicate verifier (needed for the market's admission). */
  get identityVerifierAvailable(): boolean {
    return this.world.has(AIFP.identityVerifier);
  }

  addressOf(id: (typeof AIFP)[keyof typeof AIFP]): string {
    return this.world.address(id);
  }

  paradigms(runner?: ContractRunner): Contract {
    return this.world.contract(AIFP.paradigms, runner);
  }

  channels(runner?: ContractRunner): Contract {
    return this.world.contract(AIFP.channels, runner);
  }

  participation(runner?: ContractRunner): Contract {
    return this.world.contract(AIFP.participation, runner);
  }

  verifier(runner?: ContractRunner): Contract {
    return this.world.contract(AIFP.verifier, runner);
  }

  anchor(runner?: ContractRunner): Contract {
    return this.world.contract(AIFP.anchor, runner);
  }

  identityVerifier(runner?: ContractRunner): Contract {
    return this.world.contract(AIFP.identityVerifier, runner);
  }

  /** The subject reference of an account on this world's chain. */
  subjectOf(address: string): string {
    return subjectOfAddress(this.world.chainId, address);
  }

  // ---- encoders (the subject's or the authority's own calls, made through the cell account's `execute` or by an EOA)

  encodeRegisterParadigm(b: DescriptorBundle, supersedes: string, descriptorURI: string): string {
    const canonicalHex = "0x" + Buffer.from(b.canonical, "utf8").toString("hex");
    return this.paradigms().interface.encodeFunctionData("registerParadigm", [canonicalHex, b.familyId, supersedes, b.labelIds.map((l) => l.id), b.rolePredicates.map((r) => [r.roleBit, r.predicateHash]), descriptorURI]);
  }

  encodeOpenChannel(paradigmId: string, authority: string, parent: string, metadataURI: string, bindings: BindingDecl[]): string {
    return this.channels().interface.encodeFunctionData("openChannel", [paradigmId, authority, parent, metadataURI, bindings.map(bindingArray)]);
  }

  encodeDeclareBinding(channelId: string, b: BindingDecl): string {
    return this.channels().interface.encodeFunctionData("declareBinding", [channelId, bindingArray(b)]);
  }

  encodeAdoptParadigm(channelId: string, paradigmId: string, effectiveAt: number, requiresReadmission: boolean, authorizationRef = ZERO32): string {
    return this.channels().interface.encodeFunctionData("adoptParadigm", [channelId, paradigmId, effectiveAt, requiresReadmission, authorizationRef]);
  }

  encodeRecordDisclosure(channelId: string, kind: number, objectRef: string, audienceRef: string, authorizationRef = ZERO32): string {
    return this.channels().interface.encodeFunctionData("recordDisclosure", [channelId, kind, objectRef, audienceRef, authorizationRef]);
  }

  encodeSetState(channelId: string, state: number): string {
    return this.channels().interface.encodeFunctionData("setState", [channelId, state]);
  }

  encodeGrant(channelId: string, subject: string, roles: number, o: { onBehalfOf?: string; scopeRef?: string; basisKind?: number; basisRef?: string; validFrom?: number; validUntil?: number } = {}): string {
    return this.participation().interface.encodeFunctionData("grant", [channelId, subject, o.onBehalfOf ?? ZERO32, roles, o.scopeRef ?? ZERO32, o.basisKind ?? BASIS.manager, o.basisRef ?? ZERO32, o.validFrom ?? 0, o.validUntil ?? 0]);
  }

  encodeAdmit(channelId: string, role: number, predicate: string, evidence: string[], scopeRef = ZERO32, validUntil = 0): string {
    return this.participation().interface.encodeFunctionData("admit", [channelId, role, scopeRef, predicate, evidence, validUntil]);
  }

  encodeReadmit(bindingId: string, predicate: string, evidence: string[]): string {
    return this.participation().interface.encodeFunctionData("readmit", [bindingId, predicate, evidence]);
  }

  encodeRevoke(bindingId: string, reasonRef = ZERO32): string {
    return this.participation().interface.encodeFunctionData("revoke", [bindingId, reasonRef]);
  }

  encodeAnchor(channelId: string, action: number, objectRef: string, relations: { kind: number; objectRef: string }[]): string {
    return this.anchor().interface.encodeFunctionData("anchor", [channelId, action, objectRef, relations.map((r) => [r.kind, r.objectRef])]);
  }

  // ---- receipts

  channelIdFromReceipt(receipt: TransactionReceipt): string {
    return String(eventArgs(this.channels().interface, receipt, "ChannelOpened", this.addressOf(AIFP.channels)).channelId);
  }

  bindingIdsFromReceipt(receipt: TransactionReceipt): string[] {
    const out: string[] = [];
    const iface = this.channels().interface;
    const at = this.addressOf(AIFP.channels).toLowerCase();
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== at) continue;
      try {
        const p = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (p?.name === "BindingDeclared") out.push(String(p.args.bindingId));
      } catch {
        /* not ours */
      }
    }
    return out;
  }

  roleBindingIdFromReceipt(receipt: TransactionReceipt): string {
    return String(eventArgs(this.participation().interface, receipt, "RoleGranted", this.addressOf(AIFP.participation)).bindingId);
  }

  anchorIndexFromReceipt(receipt: TransactionReceipt): number {
    return Number(eventArgs(this.anchor().interface, receipt, "EventAnchored", this.addressOf(AIFP.anchor)).recordIndex);
  }

  paradigmIdFromReceipt(receipt: TransactionReceipt): string {
    return String(eventArgs(this.paradigms().interface, receipt, "ParadigmRegistered", this.addressOf(AIFP.paradigms)).paradigmId);
  }

  // ---- reads

  async clock(): Promise<number> {
    return Number(await this.channels().clock());
  }

  async clockMode(): Promise<string> {
    return String(await this.channels().CLOCK_MODE());
  }

  async paradigmExists(paradigmId: string): Promise<boolean> {
    return Boolean(await this.paradigms().exists(paradigmId));
  }

  async paradigm(paradigmId: string): Promise<ParadigmRecord> {
    const p = await this.paradigms().paradigm(paradigmId);
    return { family: String(p.family), supersedes: String(p.supersedes), registrant: getAddress(String(p.registrant)), registeredAt: Number(p.registeredAt), descriptorURI: String(p.descriptorURI) };
  }

  async rolePredicateHash(paradigmId: string, role: number): Promise<string> {
    return String(await this.paradigms().rolePredicateHash(paradigmId, role));
  }

  async labelsOf(paradigmId: string): Promise<string[]> {
    return Array.from(await this.paradigms().labelsOf(paradigmId), String);
  }

  async familyController(familyId: string): Promise<string> {
    return getAddress(String(await this.paradigms().familyController(familyId)));
  }

  async channelExists(channelId: string): Promise<boolean> {
    return Boolean(await this.channels().channelExists(channelId));
  }

  async channel(channelId: string): Promise<ChannelRecord> {
    const c = await this.channels().channel(channelId);
    const state = Number(c.state);
    return { authority: getAddress(String(c.authority)), parent: String(c.parent), state, stateName: CHANNEL_STATE[state] ?? String(state), openedAt: Number(c.openedAt), metadataURI: String(c.metadataURI) };
  }

  async currentParadigm(channelId: string): Promise<{ paradigmId: string; effectiveSince: number }> {
    const r = await this.channels().currentParadigm(channelId);
    return { paradigmId: String(r.paradigmId ?? r[0]), effectiveSince: Number(r.effectiveSince ?? r[1]) };
  }

  async paradigmAt(channelId: string, timepoint: number): Promise<string> {
    return String(await this.channels().paradigmAt(channelId, timepoint));
  }

  async bindingIds(channelId: string): Promise<string[]> {
    return Array.from(await this.channels().bindingIds(channelId), String);
  }

  async binding(channelId: string, bindingId: string): Promise<BindingDecl & { active: boolean }> {
    const b = await this.channels().binding(channelId, bindingId);
    return { kind: Number(b.kind), target: String(b.target), version: String(b.version), capabilities: Number(b.capabilities), effectScope: Number(b.effectScope), adoptionMode: Number(b.adoptionMode), authorizationRef: String(b.authorizationRef), active: Boolean(b.active) };
  }

  async disclosureCount(channelId: string): Promise<number> {
    return Number(await this.channels().disclosureCount(channelId));
  }

  async disclosureAt(channelId: string, index: number): Promise<{ kind: number; objectRef: string; audienceRef: string; authorizationRef: string; at: number }> {
    const d = await this.channels().disclosureAt(channelId, index);
    return { kind: Number(d.kind ?? d[0]), objectRef: String(d.objectRef ?? d[1]), audienceRef: String(d.audienceRef ?? d[2]), authorizationRef: String(d.authorizationRef ?? d[3]), at: Number(d.at ?? d[4]) };
  }

  /** The four-valued role check at the current clock (section 9.5) — the historical role, not the current eligibility. */
  async evaluateNow(channelId: string, subject: string, role: number, scopeRef = ZERO32): Promise<number> {
    return Number(await this.participation().evaluateNow(channelId, subject, role, scopeRef));
  }

  async evaluate(channelId: string, subject: string, role: number, scopeRef: string, timepoint: number): Promise<number> {
    return Number(await this.participation().evaluate(channelId, subject, role, scopeRef, timepoint));
  }

  async rolesOf(channelId: string, subject: string, scopeRef: string, timepoint: number): Promise<number> {
    return Number(await this.participation().rolesOf(channelId, subject, scopeRef, timepoint));
  }

  async previewAdmission(channelId: string, subject: string, role: number, predicate: string, evidence: string[], scopeRef = ZERO32): Promise<number> {
    return Number(await this.participation().previewAdmission(channelId, subject, role, scopeRef, predicate, evidence));
  }

  async bindingIdsOf(channelId: string, subject: string): Promise<string[]> {
    return Array.from(await this.participation().bindingIdsOf(channelId, subject), String);
  }

  async bindingOf(bindingId: string): Promise<RoleBinding> {
    const b = await this.participation().bindingOf(bindingId);
    const roles = Number(b.roles);
    const basisKind = Number(b.basisKind);
    const state = Number(b.state);
    return {
      channelId: String(b.channelId),
      subject: String(b.subject),
      onBehalfOf: String(b.onBehalfOf),
      roles,
      roleNames: roleNames(roles),
      scopeRef: String(b.scopeRef),
      basisKind,
      basisName: BASIS_NAMES[basisKind] ?? String(basisKind),
      basisRef: String(b.basisRef),
      outcomeAtGrant: Number(b.outcomeAtGrant),
      ruleVersion: String(b.ruleVersion),
      validFrom: Number(b.validFrom),
      validUntil: Number(b.validUntil),
      revokedAt: Number(b.revokedAt),
      suspendedAt: Number(b.suspendedAt),
      reinstatedAt: Number(b.reinstatedAt),
      suspendedBy: getAddress(String(b.suspendedBy)),
      admittedEpoch: Number(b.admittedEpoch),
      state,
      stateName: BINDING_STATE[state] ?? String(state),
    };
  }

  /** Evaluate a predicate directly through the composite verifier (what `admit` would compute, for any predicate bytes). */
  async evaluatePredicate(channelId: string, subject: string, role: number, predicate: string, evidence: string[], scopeRef = ZERO32): Promise<number> {
    return Number(await this.verifier().evaluate(channelId, subject, role, scopeRef, predicate, evidence));
  }

  async anchorCount(): Promise<number> {
    return Number(await this.anchor().recordCount());
  }

  async anchorRecord(index: number): Promise<EventRecord> {
    const r = await this.anchor().record(index);
    const action = Number(r.action);
    return { channelId: String(r.channelId), subject: String(r.subject), action, actionName: (Object.keys(ACTIONS) as ActionName[]).find((a) => ACTIONS[a] === action) ?? String(action), objectRef: String(r.objectRef), ruleVersion: String(r.ruleVersion), at: Number(r.at) };
  }

  async anchoredBy(objectRef: string): Promise<string> {
    return String(await this.anchor().anchoredBy(objectRef));
  }

  async anchoredIn(objectRef: string): Promise<string> {
    return String(await this.anchor().anchoredIn(objectRef));
  }

  /** The evidence the identity leaf takes: the subject's account and its agent id. */
  identityEvidence(account: string, agentId: bigint | number | string): string {
    return abi.encode(["address", "uint256"], [getAddress(account), BigInt(agentId)]);
  }

  /** The outcome name of a refused admission, from the registry's revert (`AIFP_NotSatisfied` and the two others); null when the revert is something else. */
  static outcomeOfRevert(explanation: string | null): OutcomeName | null {
    if (!explanation) return null;
    if (/AIFP_NotSatisfied/.test(explanation)) return "NOT_SATISFIED";
    if (/AIFP_Undeterminable/.test(explanation)) return "UNDETERMINABLE";
    if (/AIFP_VerifierError/.test(explanation)) return "VERIFIER_ERROR";
    return null;
  }
}

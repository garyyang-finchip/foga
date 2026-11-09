import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { getAddress } from "ethers";
import { ALL_LAYERS, LAYER_NAMES, LAYER_SCHEMAS, ZERO32, commitLayerDocument, contentHash, policyStruct, stateRoot, type Commitments, type LayerCommitmentRecord, type LayerDocument, type PolicyDocument, type PolicyStruct } from "../core/amm.js";
import { keccakJcs } from "../core/canonical.js";
import { NODE_SCOPE_GROUPS } from "../genesis/operator-scope.js";
import { exists, readJson, writeJson } from "../util/fs.js";
import { version as programVersion } from "../util/version.js";
import { configPath } from "./config.js";
import { documentsDir, readManifest } from "./documents.js";
import type { Node } from "./node.js";

/**
 * The cell's maintenance (ERC-8490, docs/meditation.md): what it registers about itself. Four layer documents are
 * built from the cell's *stable* state — its configuration, the program and its dependencies, the skills it holds,
 * the roles it plays, the terms it works under, the assumptions it runs on — and nothing that moves on its own
 * between two cycles (balances, block numbers, counts of operations, the maintenance registry's own versions and
 * roots). A document that changes only when the cell changes makes the registered state version mean something:
 * a cycle that finds nothing to adopt leaves the version where it was.
 *
 * Everything the cycle needs to be recomputed later is kept: the documents and their salts (so the commitments on
 * chain can be re-derived from what is on disk), the policy document (so its hash can be checked), and the record of
 * every cycle (so a reviewer can re-derive the report from it). The store's facts are the source of truth; the
 * files under `maintenance.dir` are the same material laid out for people and for the node to serve.
 */
export const MAINTENANCE_FACTS = {
  policy: "meditation.policy",
  salts: "meditation.salts",
  state: "meditation.state",
  lock: "meditation.lock",
  lastCycle: "meditation.lastCycle",
  cycle: (id: string) => `meditation.cycle.${id}`,
} as const;

export const POLICY_FILE = "policy.json";
export const SALTS_FILE = "salts.json";
export const STATE_DIR = "state";
export const CYCLES_DIR = "cycles";
/** The schema id of the cycle record documents the cell writes. */
export const CYCLE_RECORD_SCHEMA = "amm.cycle-record/1";
export const POLICY_SCHEMA = "amm.policy/1";

/** The maintenance directory of a cell (configuration `maintenance.dir`, relative to the configuration's directory). */
export function maintenanceDir(node: Node): string {
  return configPath(node.loaded, node.config.maintenance.dir);
}

/** The URL a maintenance document is published at, when the node has a public URL; "" otherwise (no locator on chain). */
export function maintenanceUrl(node: Node, rel: string): string {
  const base = node.config.runtime.http.publicUrl;
  if (!base) return "";
  return `${base.replace(/\/+$/, "")}/documents/maintenance/${rel}`;
}

/**
 * The file behind `/documents/maintenance/<rel>`: the policy, a state document (`state/<layer>.json`) or a cycle
 * record (`cycles/<id>.json`). The salts are never served; nothing outside those three shapes resolves.
 */
export function publicMaintenanceFile(node: Node, rel: string): string | null {
  const dir = maintenanceDir(node);
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 1 && parts[0] === POLICY_FILE) return join(dir, POLICY_FILE);
  if (parts.length === 2 && (parts[0] === STATE_DIR || parts[0] === CYCLES_DIR)) {
    const name = basename(parts[1]);
    if (!/^[A-Za-z0-9:_.-]+\.json$/.test(name)) return null;
    return join(dir, parts[0], name);
  }
  return null;
}

// ---------------------------------------------------------------------------- the policy

/** The cell's maintenance policy document (`amm.policy/1`): the on-chain fields from the configuration, the routines from the program. */
export function policyDocument(node: Node): PolicyDocument {
  const p = node.config.maintenance.policy;
  return {
    schema: POLICY_SCHEMA,
    name: `${node.config.presence.name}: maintenance policy`,
    version: 1,
    profile: "foga-cell-maintenance/1",
    onchain: {
      supportedLayers: p.supportedLayers,
      requiredLayers: p.requiredLayers,
      allowedTriggers: p.allowedTriggers,
      disclosure: p.disclosure,
      dueWindow: p.dueWindow,
      pulseInterval: p.pulseInterval,
      maxInterval: [...p.maxInterval] as [number, number, number, number],
    },
    triggers: {
      scheduled: node.config.maintenance.auto ? `the node's watcher: a layer DUE or OVERDUE under the requirements, checked every ${node.config.maintenance.checkEverySeconds} s, no two cycles within ${node.config.maintenance.cooldownSeconds} s unless a layer is OVERDUE` : "off (maintenance.auto false): nothing is scheduled",
      event: node.config.maintenance.auto ? ["the runtime document drifted from the registered one (a program or dependency upgrade, a role rotation, a changed public face)", "the memory-skills document drifted (a skill minted, updated or offered)"] : ["none while maintenance.auto is off"],
      commanded: "the operator (foga meditate run), or the watcher answering a controller's demand",
      self: "not used by this program",
    },
    budgets: { maxCycleDuration: 600, cooldownAfterCycle: node.config.maintenance.cooldownSeconds, gasPerReport: node.config.maintenance.gasPerReport },
    layers: {
      "0": { routine: ["check the program, its dependencies and the account's roles and allow-list against the configuration", "record the runtime as it is"], adoption: "the runtime document follows what runs; a program or dependency change is an update the operator made, registered here; a missing allow-list entry is a candidate for the owner" },
      "1": { routine: ["rebuild every held skill package and check its commitment on chain", "check and compact the operation store (integrity check, write-ahead log checkpoint)"], adoption: "a skill set that changed is registered; a package that no longer matches its token is a finding and a candidate, never a repair made here" },
      "2": { routine: ["review the roles the account's scope allows and the terms the policy sets", "review the tenders in flight against the chain", "compare the built documents with what the chain holds"], adoption: "roles, terms and in-flight work follow the configuration and the store; commitments to counterparties are only changed through the tender mechanism; documents that differ from the chain are a candidate for docs_publish" },
      "3": { routine: ["review the decisions of the window by gate", "restate the program's assumptions and strategies"], adoption: "the cognition document changes with the program; a refusal pattern is a candidate for the operator, nothing is adopted here" },
    },
    disclosure: { level: ["commitment", "summary", "full"][p.disclosure], terms: p.disclosure === 2 ? "the policy, the four state documents and every cycle record are served under /documents/maintenance" : p.disclosure === 1 ? "cycle records are served under /documents/maintenance; the state documents are disclosed to named parties" : "commitments only" },
  };
}

/** The on-chain Policy struct of the cell's policy document, with its locator when the node has a public URL. */
export function cellPolicyStruct(node: Node): PolicyStruct {
  return policyStruct(policyDocument(node), maintenanceUrl(node, POLICY_FILE));
}

/** The controller the configuration names (the guardian, by default), as `enroll` and `setController` take it. */
export function controllerOf(node: Node): { controller: string; rights: number } {
  const m = node.config.maintenance;
  if (m.controller === "none" || m.controllerRights === 0) return { controller: "0x0000000000000000000000000000000000000000", rights: 0 };
  return { controller: getAddress(node.config.identity.guardian), rights: m.controllerRights };
}

// ---------------------------------------------------------------------------- the salts

/**
 * Per-layer salts, fixed the first time they are needed and reused for every later commitment: changing a salt
 * changes the commitment of an unchanged document, so they are kept in the store (and written beside the documents).
 * Zero by default: the cell's documents are public, there is nothing to hide behind a salt; an operator who wants a
 * layer's document private sets a random salt in salts.json before enrolling (the file is read when no fact exists).
 */
export function loadSalts(node: Node): Commitments {
  const have = node.store.getFact<string[]>(MAINTENANCE_FACTS.salts);
  if (have && have.length === 4) return have as Commitments;
  const file = join(maintenanceDir(node), SALTS_FILE);
  let salts: Commitments = [ZERO32, ZERO32, ZERO32, ZERO32];
  if (exists(file)) {
    const raw = readJson<{ salts?: string[] }>(file);
    if (Array.isArray(raw.salts) && raw.salts.length === 4 && raw.salts.every((s) => /^0x[0-9a-fA-F]{64}$/.test(s))) salts = raw.salts as Commitments;
    else throw new Error(`${file}: expected { "salts": [four 32-byte hex values] }`);
  }
  node.store.setFact(MAINTENANCE_FACTS.salts, salts);
  writeJson(file, { comment: "Per-layer salts of the ERC-8490 layer commitments. Fixed at enrollment and reused; never served. A random salt keeps a layer's document private to whoever is given the salt with it.", salts });
  return salts;
}

/** A random 32-byte salt (for an operator who wants a private layer). */
export function randomSalt(): string {
  return "0x" + randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------- the layer documents

export type LayerDocuments = [LayerDocument, LayerDocument, LayerDocument, LayerDocument];

/** The four layer documents of the cell as it is now. Reads the configuration, the store and the chain; sends nothing. */
export async function buildLayerDocuments(node: Node): Promise<LayerDocuments> {
  return [await runtimeDocument(node), await memorySkillsDocument(node), await tasksRolesDocument(node), cognitionDocument(node)];
}

const require_ = createRequire(import.meta.url);

/**
 * The installed version of a dependency, from the package.json of the package that `require.resolve` lands in. A
 * package whose `exports` map does not expose `./package.json` (ethers, the MCP SDK) cannot be asked for it directly,
 * so the entry module is resolved and the nearest package.json above it that bears the name is read. Null when the
 * package cannot be resolved from here at all.
 */
export function installedVersion(name: string): string | null {
  try {
    return String(require_(`${name}/package.json`).version);
  } catch {
    /* the exports map hides package.json: walk up from the entry module */
  }
  try {
    let dir = dirname(require_.resolve(name));
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, "package.json");
      if (exists(candidate)) {
        const pkg = readJson<{ name?: string; version?: string }>(candidate);
        if (pkg.name === name && pkg.version) return String(pkg.version);
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    /* not resolvable from here */
  }
  return null;
}

/** Layer 0, runtime: the program, its dependencies and adapters, the account's authorization and the self-check suite. */
export async function runtimeDocument(node: Node): Promise<LayerDocument> {
  const cfg = node.config;
  // the account as the chain has it (the node's handle, or — during the birth, before the handle exists — the address the
  // configuration was just given); a configuration without an account yet reads its own roles
  let owner = cfg.identity.owner;
  let operator = cfg.identity.operator;
  let accountVersion = 0;
  if (cfg.identity.account) {
    const c = node.cell?.contract() ?? node.world.at("foga:FogaCellAccount", cfg.identity.account);
    [owner, operator] = await Promise.all([c.owner().then(String), c.operator().then(String)]);
    accountVersion = await c
      .ACCOUNT_VERSION()
      .then((v: unknown) => Number(v))
      .catch(() => 1);
  }
  const deps = ["ethers", "zod", "@modelcontextprotocol/server"].map((name) => ({ name, version: installedVersion(name) ?? "unresolved" }));
  return {
    schema: LAYER_SCHEMAS[0],
    layer: 0,
    runtime: { name: "foga", version: programVersion, platform: `node${process.versions.node.split(".")[0]}/${process.platform}-${process.arch}` },
    code: [
      { component: "foga", version: programVersion },
      { component: "contracts-bundle", version: `${Object.keys(node.world.bundle.contracts).length} contracts`, hash: node.world.bundle.hash },
    ],
    dependencies: deps,
    adapters: [
      { kind: "rpc", name: `eip155:${node.chainId}`, version: "1", world: node.world.file.worldId },
      { kind: "model", name: cfg.runtime.model.provider, version: cfg.runtime.model.model ?? "-", limits: { dailyCalls: cfg.runtime.model.dailyCalls, maxToolCallsPerTick: cfg.runtime.model.maxToolCallsPerTick, maxActsPerTick: cfg.runtime.model.maxActsPerTick } },
      { kind: "http", name: cfg.runtime.http.publicUrl ?? "loopback", version: "1", entrances: ["api", "mcp", "a2a", "documents"] },
    ],
    authorization: {
      account: cfg.identity.account ? getAddress(cfg.identity.account) : null,
      accountRevision: accountVersion,
      owner: getAddress(owner),
      operator: getAddress(operator),
      guardian: getAddress(cfg.identity.guardian),
      recovery: cfg.identity.recovery ? getAddress(cfg.identity.recovery) : getAddress(cfg.identity.owner),
      operatorScope: node.store.getFact<{ groups: string[] }>("init.scope")?.groups ?? node.store.getFact<{ groups: string[] }>("extend.scope")?.groups ?? NODE_SCOPE_GROUPS,
    },
    selfCheckSuite: { name: "foga node preflight", version: programVersion, areas: ["config", "world", "account", "budget", "maintenance", "keys", "standing", "skills", "documents", "public", "model"] },
  };
}

/** Layer 1, memory and skills: the operation store's shape, the skills held (by token and package commitment) and the harness. */
export async function memorySkillsDocument(node: Node): Promise<LayerDocument> {
  const cfg = node.config;
  const skills = Object.entries(cfg.skills.held)
    .map(([name, h]) => ({ id: name, tokenId: h.tokenId, packageHash: h.packageHash ?? null, recordId: h.recordId ?? null, unitId: h.unitId ?? null, source: "erc-8338-package", offered: cfg.skills.offered.includes(name) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    schema: LAYER_SCHEMAS[1],
    layer: 1,
    memory: { store: "sqlite", organization: "operations+jobs+decisions+facts+journal", schema: "foga.ops/1", path: basename(node.storePath) },
    skills,
    harness: {
      configHash: keccakJcs({ dir: cfg.skills.dir, inputDir: cfg.skills.inputDir, timeoutMs: cfg.skills.timeoutMs ?? null }),
      skillsDir: cfg.skills.dir,
      inputDir: cfg.skills.inputDir,
      executors: ["foga-probe", "finch-extract-verify"],
    },
  };
}

/** The roles a cell plays, named after its operator scope groups. */
const ROLE_OF_GROUP: Record<string, { id: string; description: string }> = {
  identity: { id: "identity-holder", description: "keeps its ERC-8004 identity, ERC-8434 anchor, ERC-8444 record and ERC-8454 unit" },
  standing: { id: "standing-holder", description: "cites an ERC-8419 standing an issuer attests" },
  "skills-provider": { id: "skills-provider", description: "mints and updates ERC-8338 skill packages" },
  labour: { id: "fulfiller", description: "takes ERC-8414 tenders for the skills it offers and settles them" },
  demander: { id: "demander", description: "mints and funds ERC-8414 tenders of its own" },
  "organization-member": { id: "organization-member", description: "joins ERC-8447 swarms and votes in ERC-8436 councils" },
  "organization-coordinator": { id: "organization-coordinator", description: "forms ERC-8447 swarms" },
  "service-provider": { id: "service-provider", description: "delivers under ERC-8471 service escrows" },
  "service-client": { id: "service-client", description: "buys under ERC-8471 service escrows and files disputes" },
  maintenance: { id: "self-maintainer", description: "registers its own maintenance cycles (ERC-8490)" },
  flows: { id: "channel-source", description: "publishes its self-description in its own ERC-8489 channel and takes part in a tender market under its rules" },
};

/**
 * The tenders the cell has submitted to and not yet settled or withdrawn, from the store's jobs: a `tender` job done
 * (the submission confirmed) with no `tender-settle` or `withdraw` job done for the same token. Stable between two
 * ticks; it moves when a tender moves.
 */
export function inFlightTenders(node: Node): { tokenId: string; job: string }[] {
  const jobs = node.store.jobs(null, 5000);
  const tokenOf = (j: { input: unknown; id: string }) => String((j.input as { tokenId?: string } | null)?.tokenId ?? j.id.split(":")[1] ?? "");
  const closed = new Set(jobs.filter((j) => (j.kind === "tender-settle" || j.kind === "withdraw") && j.status === "done").map(tokenOf));
  return jobs
    .filter((j) => j.kind === "tender" && j.status === "done" && !closed.has(tokenOf(j)))
    .map((j) => ({ tokenId: tokenOf(j), job: j.id }))
    .sort((a, b) => Number(BigInt(a.tokenId || "0") - BigInt(b.tokenId || "0")));
}

/** Layer 2, tasks and roles: the roles the scope allows, the terms the policy sets, the tenders in flight, the services and documents offered. */
export async function tasksRolesDocument(node: Node): Promise<LayerDocument> {
  const cfg = node.config;
  const groups = node.store.getFact<{ groups: string[] }>("init.scope")?.groups ?? NODE_SCOPE_GROUPS;
  const extended = node.store.getFact<{ groups: string[] }>("extend.scope")?.groups ?? [];
  const allGroups = [...new Set([...groups, ...extended])];
  const roles = allGroups.map((g) => ROLE_OF_GROUP[g] ?? { id: g, description: `operator scope group ${g}` }).map((r) => ({ ...r, ...(r.id === "fulfiller" ? { skills: [...cfg.skills.offered].sort() } : {}) }));
  const inFlight = inFlightTenders(node).map((t) => ({ ref: `eip155:${node.chainId}/erc8414:${node.kernel.tenders.address.toLowerCase()}/${t.tokenId}`, job: t.job, status: "submitted" }));
  const manifest = readManifest(documentsDir(node));
  const services: Record<string, unknown>[] = [];
  if (manifest) services.push({ name: "documents", version: manifest.version, catalogHash: contentHash(manifest.documents), files: Object.keys(manifest.documents).sort() });
  for (const [name, url] of Object.entries(cfg.presence.endpoints)) if (url) services.push({ name, endpoint: url });
  for (const o of cfg.presence.services?.offers ?? []) services.push({ name: o.id, kind: o.kind, status: o.status, url: o.url });
  return {
    schema: LAYER_SCHEMAS[2],
    layer: 2,
    roles,
    plans: [{ id: "maintenance", horizon: cfg.maintenance.policy.maxInterval.map((s) => `${s}s`).join("/"), priority: 1, status: cfg.maintenance.auto ? "active" : "commanded" }],
    tasks: inFlight,
    terms: {
      tenders: { minRewardWei: cfg.policy.tenders.minRewardWei, minSubmitWindowSeconds: cfg.policy.tenders.minSubmitWindowSeconds, minSettleWindowSeconds: cfg.policy.tenders.minSettleWindowSeconds, acceptance: [...cfg.policy.tenders.acceptance], counterpartyMinLevel: cfg.policy.tenders.counterpartyMinLevel },
      budget: { dailyValueWei: cfg.policy.budget.dailyValueWei, perOperationValueWei: cfg.policy.budget.perOperationValueWei, dailyGasWei: cfg.policy.budget.dailyGasWei, maxConcurrentCommitments: cfg.policy.budget.maxConcurrentCommitments },
      safety: { specId: cfg.identity.safety.specId ?? null, version: cfg.identity.safety.version, bindingId: cfg.identity.bindingId ?? null },
    },
    services,
  };
}

/** Layer 3, cognition: the self-model, the assumptions the program runs on, its judgment strategies and reflection methods. */
export function cognitionDocument(node: Node): LayerDocument {
  const cfg = node.config;
  const offered = [...cfg.skills.offered].sort();
  const policy = policyDocument(node);
  return {
    schema: LAYER_SCHEMAS[3],
    layer: 3,
    selfModel: {
      capabilities: [
        ...(offered.length ? [`fulfil ERC-8414 tenders bound to ${offered.join(", ")}`] : []),
        "publish its registration, AID document, ARD descriptor and AUF unit, and keep them equal to the chain",
        "keep its anchor ACTIVE by heartbeat and its binding Satisfied",
        "register its own maintenance cycles (ERC-8490)",
      ],
      limits: ["acts only through its account, within the operator's allow-list and daily caps", "moves no asset out: transfers are the owner's", cfg.runtime.model.provider === "stub" ? "no model: acts are proposed by rules or by callers" : `one model backend (${cfg.runtime.model.provider}), ${cfg.runtime.model.dailyCalls} calls a day`],
      resources: [`eip155:${node.chainId} through one RPC endpoint`, "the skill packages it holds", "its operation store"],
      applicability: ["tenders whose acceptance is machine-verifiable under an authority the policy names", "counterparties whose standing meets the policy's level"],
    },
    assumptions: [
      { id: "idempotency", statement: "the same operation key is never sent twice; a resumed run reads the chain before it sends", status: "held", evidence: ["docs/kernel.md"] },
      { id: "rpc-state-availability", statement: "a public endpoint may not serve state at an old block; a read it refuses that is not a revert is transient and is retried elsewhere", status: "held", evidence: ["docs/join.md (0.7.4)"] },
      { id: "receipt-timeout", statement: "a receipt that does not arrive in time means pending, not failed; the operation is resolved from the chain, never resent blindly", status: "held", evidence: ["docs/kernel.md (0.8.0)"] },
      { id: "freshness", statement: "FRESH in the maintenance registry means a routine completed in time, not that the cell is correct; the record says what was checked", status: "held", evidence: ["docs/meditation.md"] },
    ],
    judgmentStrategies: [
      { id: "gates-before-acts", rule: "every act passes the policy, budget, wallet and safety gates and a simulation before it is sent; a refusal is a decision record", status: "adopted" },
      { id: "derived-job-ids", rule: "a job id derives from the semantic input, so the same request is one job", status: "adopted" },
      { id: "maintenance-within-authority", rule: "a maintenance cycle adopts only what the node may do alone (its documents, its store); code, policy and allow-list changes are candidates for the owner or operator", status: "adopted" },
    ],
    reflectionMethods: [
      { id: "preflight", description: "the readiness reconciliation (foga node preflight): every link from the account to the documents read and compared", version: 1 },
      { id: "decision-review", description: "the decisions of the window grouped by gate; a gate that refuses most of what is asked is a finding", version: 1 },
    ],
    policyRef: { policyHash: contentHash(policy), version: policy.version },
  };
}

// ---------------------------------------------------------------------------- commitments and the registered state

export interface CommittedDocuments {
  records: [LayerCommitmentRecord, LayerCommitmentRecord, LayerCommitmentRecord, LayerCommitmentRecord];
  commitments: Commitments;
  root: string;
}

export function commitDocuments(docs: LayerDocuments, salts: Commitments): CommittedDocuments {
  const records = docs.map((d, i) => commitLayerDocument(i, d, salts[i])) as CommittedDocuments["records"];
  const commitments = records.map((r) => r.commitment) as Commitments;
  return { records, commitments, root: stateRoot(commitments) };
}

/** The state the cell registered last: the documents behind the commitments on chain, by state version. */
export interface MaintenanceState {
  stateVersion: string;
  root: string;
  commitments: Commitments;
  docs: LayerDocuments;
  /** The cycle (or "enroll") that registered it. */
  by: string;
  updatedAt: string;
}

export function readState(node: Node): MaintenanceState | undefined {
  return node.store.getFact<MaintenanceState>(MAINTENANCE_FACTS.state);
}

/** Record the registered state: the fact, and the four documents under state/ for people and for the node to serve. */
export function writeState(node: Node, state: MaintenanceState): void {
  node.store.setFact(MAINTENANCE_FACTS.state, state);
  const dir = join(maintenanceDir(node), STATE_DIR);
  for (let i = 0; i < 4; i++) writeJson(join(dir, `${i}-${LAYER_NAMES[i]}.json`), state.docs[i]);
  writeJson(join(dir, "root.json"), { stateVersion: state.stateVersion, root: state.root, commitments: state.commitments, by: state.by, updatedAt: state.updatedAt, files: LAYER_NAMES.map((n, i) => `${i}-${n}.json`) });
}

export interface EnrollmentPlan {
  docs: LayerDocuments;
  salts: Commitments;
  committed: CommittedDocuments;
  policy: PolicyDocument;
  policyStruct: PolicyStruct;
  policyURI: string;
  controller: string;
  controllerRights: number;
}

/** Everything `enroll(baseline, policy, controller, rights)` needs, read from the cell; nothing is sent here. */
export async function enrollmentPlan(node: Node): Promise<EnrollmentPlan> {
  const docs = await buildLayerDocuments(node);
  const salts = loadSalts(node);
  const committed = commitDocuments(docs, salts);
  const policy = policyDocument(node);
  const policyURI = maintenanceUrl(node, POLICY_FILE);
  const { controller, rights } = controllerOf(node);
  return { docs, salts, committed, policy, policyStruct: policyStruct(policy, policyURI), policyURI, controller, controllerRights: rights };
}

/** After the enrollment confirmed: the registered state is the baseline, the policy is version 1. */
export function recordEnrollment(node: Node, plan: EnrollmentPlan): void {
  const at = new Date().toISOString();
  writeState(node, { stateVersion: "1", root: plan.committed.root, commitments: plan.committed.commitments, docs: plan.docs, by: "enroll", updatedAt: at });
  writePolicy(node, plan.policy, 1);
}

export function writePolicy(node: Node, policy: PolicyDocument, version: number): void {
  node.store.setFact(MAINTENANCE_FACTS.policy, { version, policyHash: contentHash(policy), document: policy, updatedAt: new Date().toISOString() });
  writeJson(join(maintenanceDir(node), POLICY_FILE), policy);
}

export function readPolicy(node: Node): { version: number; policyHash: string; document: PolicyDocument; updatedAt: string } | undefined {
  return node.store.getFact(MAINTENANCE_FACTS.policy);
}

/** The layers a request names ("0,1,3", [0, 1, 3], or nothing for all four), as a mask. */
export function layerMaskOf(layers: unknown): number {
  if (layers === undefined || layers === null || layers === "" || layers === "all") return ALL_LAYERS;
  const list = Array.isArray(layers) ? layers : String(layers).split(",");
  let mask = 0;
  for (const raw of list) {
    const s = String(raw).trim();
    const i = /^\d$/.test(s) ? Number(s) : LAYER_NAMES.indexOf(s as (typeof LAYER_NAMES)[number]);
    if (!(i >= 0 && i <= 3)) throw new Error(`unknown layer ${s}; layers are 0..3 or ${LAYER_NAMES.join(", ")}`);
    mask |= 1 << i;
  }
  if (mask === 0) throw new Error("no layer named");
  return mask;
}

export function layersOf(mask: number): number[] {
  return [0, 1, 2, 3].filter((i) => (mask & (1 << i)) !== 0);
}

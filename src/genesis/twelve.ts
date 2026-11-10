import { getAddress } from "ethers";
import { ACTIONS, CHANNEL_STATE, OUTCOME, RELATIONS, ROLES, ZERO32, outcomeName } from "../core/aifp.js";
import { LAYER_NAMES, LAYER_SCHEMAS, buildReport, commitLayerDocument, policyStruct, stateRoot, type Commitments, type CycleRecordDocument, type LayerDocument, type PolicyDocument, type TriggerName } from "../core/amm.js";
import { accountRef, dataUriJcs, keccakJcs } from "../core/canonical.js";
import { CELL_SOURCE, TENDER_MARKET, fogaDescriptorStatic, fogaParadigm } from "../core/paradigms.js";
import type { Cell } from "../kernel/cell.js";
import { CELL_GROUPS } from "./operator-scope.js";
import type { Genesis } from "./scenario.js";
import { version as programVersion } from "../util/version.js";

/**
 * The eleventh and twelfth covenants in the genesis (1.0.0, docs/genesis.md): what a FOGA-Cell-v2 cell does with its
 * own maintenance (ERC-8490) and its information flows (ERC-8489), done by the scripted cells of T0–T9 so the doctor's
 * layer 5 has evidence for both. The documents are the genesis's own, minimal and honest about what a scripted cell
 * is; the commitments, the roots, the reports, the channels, the anchors and the admissions are the real ones, through
 * the accounts, against the registries the world deployed.
 */
type Layers = [LayerDocument, LayerDocument, LayerDocument, LayerDocument];
const ZERO_SALTS: Commitments = [ZERO32, ZERO32, ZERO32, ZERO32];

export interface GenesisUpkeepState {
  stateVersion: string;
  root: string;
  commitments: Commitments;
  docs: Layers;
  policyVersion: number;
}

/** The four layer documents of a genesis cell as the genesis knows it: the program, the skills it holds, its roles, its scripted cognition. */
export function genesisLayerDocuments(g: Genesis, X: string, cell: Cell, o: { skills?: { name: string; tokenId: string; packageHash: string }[]; note?: string } = {}): Layers {
  const k = g.kernel;
  const chainId = g.chainId;
  const groups = CELL_GROUPS[X as keyof typeof CELL_GROUPS] ?? [];
  return [
    {
      schema: LAYER_SCHEMAS[0],
      layer: 0,
      runtime: { name: "foga-genesis", version: programVersion, platform: `node${process.versions.node.split(".")[0]}` },
      code: [
        { component: "foga", version: programVersion },
        { component: "contracts-bundle", version: `${Object.keys(k.world.bundle.contracts).length} contracts`, hash: k.world.bundle.hash },
      ],
      adapters: [{ kind: "rpc", name: `eip155:${chainId}`, version: "1", world: k.world.file.worldId }],
      authorization: { account: getAddress(cell.address), owner: getAddress(cell.ownerAddress), operator: getAddress(cell.operatorAddress), guardian: getAddress(k.address("G")), operatorScope: groups },
      selfCheckSuite: { name: "foga genesis checks", version: programVersion },
    },
    {
      schema: LAYER_SCHEMAS[1],
      layer: 1,
      store: { kind: "sqlite", role: "the genesis's operation store (shared by the scripted cells)" },
      skills: (o.skills ?? []).map((s) => ({ name: s.name, tokenId: s.tokenId, packageHash: s.packageHash })),
      harness: { kind: "scripted", runner: "the genesis driver" },
    },
    {
      schema: LAYER_SCHEMAS[2],
      layer: 2,
      roles: groups.map((gname) => ({ id: gname, description: `scope group ${gname} of cell ${X} in the genesis` })),
      tendersInFlight: [],
      terms: { note: "the genesis's own tenders, by the scenario" },
    },
    {
      schema: LAYER_SCHEMAS[3],
      layer: 3,
      model: { provider: "scripted", model: "the genesis scenario T0-T9" },
      strategies: ["take the tender the scenario names when the gates pass", "refuse otherwise"],
      assumptions: ["the world is the one the genesis deployed", o.note ?? "a scripted cell has no judgment of its own"],
    },
  ];
}

/** The maintenance policy of a genesis cell: the program's defaults, as `cell.config.json` would carry them. */
export function genesisPolicy(X: string): PolicyDocument {
  return {
    schema: "amm.policy/1",
    name: `FOGA cell ${X}: maintenance policy (genesis)`,
    version: 1,
    profile: "foga-cell-maintenance/1",
    onchain: { supportedLayers: 15, requiredLayers: 15, allowedTriggers: 15, disclosure: 2, dueWindow: 3600, pulseInterval: 0, maxInterval: [86400, 604800, 2592000, 7776000] },
    triggers: { scheduled: "the genesis driver", event: ["a skill minted (T2)"], commanded: "the genesis driver", self: "not used" },
    layers: { "0": { routine: ["record the runtime as it is"] }, "1": { routine: ["record the skills held"] }, "2": { routine: ["record the roles"] }, "3": { routine: ["record the scripted cognition"] } },
  };
}

function commit(docs: Layers): { commitments: Commitments; root: string } {
  const commitments = docs.map((d, i) => commitLayerDocument(i, d, ZERO_SALTS[i]).commitment) as Commitments;
  return { commitments, root: stateRoot(commitments) };
}

/** T1: the cell enrolls in the meditation registry through its account (the owner's act): the four commitments, the policy, the guardian as controller with every right. */
export async function enrollGenesisCell(g: Genesis, X: string, cell: Cell, keyPrefix = `T1.${X}`): Promise<GenesisUpkeepState> {
  const k = g.kernel;
  const docs = genesisLayerDocuments(g, X, cell);
  const { commitments, root } = commit(docs);
  const policy = genesisPolicy(X);
  const ps = policyStruct(policy, dataUriJcs(policy));
  const controller = k.address("G");
  await cell.execute(`${keyPrefix}.amm.enroll`, k.meditation.address, k.meditation.encodeEnroll(commitments, ps, controller, 7), { by: "owner" });
  const state: GenesisUpkeepState = { stateVersion: "1", root, commitments, docs, policyVersion: 1 };
  k.setFact(`amm.${X}.state`, state);
  return state;
}

/** A maintenance cycle of a genesis cell over the layers named, with the documents given, reported through the account (the operator's act). */
export async function cycleGenesisCell(g: Genesis, X: string, cell: Cell, key: string, o: { trigger: TriggerName; layers: number[]; docs: Layers; note: string }): Promise<{ state: GenesisUpkeepState; changedLayers: number; record: CycleRecordDocument }> {
  const k = g.kernel;
  const pre = k.requireFact<GenesisUpkeepState>(`amm.${X}.state`);
  const post = commit(o.docs);
  // the cycle's times are the chain's: the block before the report (the registry requires startedAt <= endedAt <= its clock,
  // and a completed layer's endedAt after its last completion — the enrollment's block, many blocks back)
  const startedAt = await k.memo(`${key}.startedAt`, async () => await g.world.blockTimestamp());
  const endedAt = startedAt;
  const record: CycleRecordDocument = {
    schema: "amm.cycle-record/1",
    subject: accountRef(g.chainId, cell.address),
    policyVersion: pre.policyVersion,
    baseVersion: pre.stateVersion,
    trigger: o.trigger,
    reportedStartedAt: startedAt,
    reportedEndedAt: endedAt,
    nextPlannedAt: 0,
    layers: [0, 1, 2, 3].map((layer) => ({ layer, scope: o.layers.includes(layer), completed: o.layers.includes(layer), changes: o.layers.includes(layer) && post.commitments[layer].toLowerCase() !== pre.commitments[layer].toLowerCase() ? [{ op: "update" as const, what: LAYER_NAMES[layer], note: o.note }] : [] })),
    outcome: "completed",
    note: o.note,
  };
  // layers out of scope keep the pre-state commitment (the registry refuses otherwise)
  const postCommitments = pre.commitments.map((c, i) => (o.layers.includes(i) ? post.commitments[i] : c)) as Commitments;
  const docs = pre.docs.map((d, i) => (o.layers.includes(i) ? o.docs[i] : d)) as Layers;
  const built = buildReport(record, { commitments: pre.commitments, root: pre.root }, { commitments: postCommitments }, dataUriJcs(record));
  await cell.execute(key, k.meditation.address, k.meditation.encodeReport(cell.address, built.report));
  const head = await k.meditation.headOf(cell.address);
  const state: GenesisUpkeepState = { stateVersion: head.stateVersion.toString(), root: stateRoot(postCommitments), commitments: postCommitments, docs, policyVersion: pre.policyVersion };
  k.setFact(`amm.${X}.state`, state);
  return { state, changedLayers: built.summary.changedLayers, record };
}

// ---------------------------------------------------------------------------------------------------- ERC-8489

export interface GenesisChannel {
  channelId: string;
  paradigmId: string;
  grantBindingId: string;
}

/** The cell-source paradigm id this world registered (the static descriptor's; the world file says it when the deployer bootstrapped the flows). */
export function cellSourceParadigm(g: Genesis): string {
  return g.world.file.flows?.paradigms[CELL_SOURCE]?.paradigmId ?? keccakJcs(fogaDescriptorStatic(CELL_SOURCE));
}

/** The world's default market channel, when the deployer bootstrapped the flows. */
export function marketOf(g: Genesis): string | null {
  return g.world.file.flows?.market?.channelId ?? null;
}

/**
 * T1: the cell opens its own channel (foga:cell-source/v1, the account as authority, `parent` the predecessor's channel for
 * a successor) and grants itself SUBMIT; the owner's acts through the account.
 */
export async function openGenesisChannel(g: Genesis, X: string, cell: Cell, o: { parent?: string; agentId: string; keyPrefix?: string } = { agentId: "0" }): Promise<GenesisChannel> {
  const k = g.kernel;
  const prefix = o.keyPrefix ?? `T1.${X}`;
  const paradigmId = cellSourceParadigm(g);
  const metadata = { schema: "foga.flow-channel/1", cell: X, account: accountRef(g.chainId, cell.address), agentId: o.agentId, paradigm: CELL_SOURCE, purpose: "the self-description of a genesis cell", parent: o.parent ?? null };
  const opened = await cell.execute(`${prefix}.flow.open`, k.flows.addressOf("8489/AIFPChannelRegistry"), k.flows.encodeOpenChannel(paradigmId, cell.address, o.parent ?? ZERO32, dataUriJcs(metadata), []), { by: "owner" });
  const channelId = k.flows.channelIdFromReceipt(opened.receipt);
  const granted = await cell.execute(`${prefix}.flow.grant`, k.flows.addressOf("8489/AIFPParticipationRegistry"), k.flows.encodeGrant(channelId, k.flows.subjectOf(cell.address), ROLES.submit), { by: "owner" });
  const grantBindingId = k.flows.roleBindingIdFromReceipt(granted.receipt);
  const rec: GenesisChannel = { channelId, paradigmId, grantBindingId };
  k.setFact(`flows.${X}.channel`, rec);
  return rec;
}

/** The cell anchors an object (its AID document commitment stands for its publication) in its channel: publish the first time, supersede after. */
export async function anchorGenesisObject(g: Genesis, X: string, cell: Cell, key: string, objectRef: string, extraRelations: { kind: number; objectRef: string }[] = []): Promise<{ action: "publish" | "supersede"; recordIndex: number }> {
  const k = g.kernel;
  const ch = k.requireFact<GenesisChannel>(`flows.${X}.channel`);
  // the plan is fixed the first time (a replayed run anchors nothing again and must say what the first run did)
  const plan = await k.memo(`${key}.plan`, async () => {
    const last = k.fact<string>(`flows.${X}.lastAnchored`) ?? null;
    return { action: (last ? "supersede" : "publish") as "publish" | "supersede", relations: [...(last ? [{ kind: RELATIONS.supersedes, objectRef: last }] : []), ...extraRelations] };
  });
  const done = await cell.execute(key, k.flows.addressOf("8489/AIFPEventAnchor"), k.flows.encodeAnchor(ch.channelId, ACTIONS[plan.action], objectRef, plan.relations));
  k.setFact(`flows.${X}.lastAnchored`, objectRef);
  return { action: plan.action, recordIndex: k.flows.anchorIndexFromReceipt(done.receipt) };
}

/** The cell admits itself to the world's market for a role by the identity predicate (the operator's act through the account). */
export async function admitGenesisCell(g: Genesis, X: string, cell: Cell, key: string, role: "submit" | "respond", agentId: string): Promise<{ outcomeBefore: string; bindingId: string | null }> {
  const k = g.kernel;
  const market = marketOf(g);
  if (!market) throw new Error("the world has no default market (the deployer's bootstrap is missing)");
  const paradigm = fogaParadigm(TENDER_MARKET, g.world);
  const predicate = paradigm.bundle.rolePredicates.find((p) => p.role === role);
  if (!predicate) throw new Error(`the market paradigm has no predicate for ${role}`);
  const subject = k.flows.subjectOf(cell.address);
  const evidence = [k.flows.identityEvidence(cell.address, agentId)];
  // the preview is the first run's: a replayed run (the identity may have moved since, T9) re-sends nothing and says what was read then
  const outcomeBefore = await k.memo(`${key}.preview`, async () => outcomeName(await k.flows.previewAdmission(market, subject, ROLES[role], predicate.predicateHex, evidence)));
  const started = Boolean(k.store.get(key)); // sent or confirmed before: the keyed operation recovers or replays it
  if (!started && outcomeBefore !== outcomeName(OUTCOME.SATISFIED)) return { outcomeBefore, bindingId: null };
  const done = await cell.execute(key, k.flows.addressOf("8489/AIFPParticipationRegistry"), k.flows.encodeAdmit(market, ROLES[role], predicate.predicateHex, evidence));
  return { outcomeBefore, bindingId: k.flows.roleBindingIdFromReceipt(done.receipt) };
}

/** The channel's state name, read live. */
export async function channelState(g: Genesis, channelId: string): Promise<string> {
  const c = await g.kernel.flows.channel(channelId);
  return CHANNEL_STATE[c.state] ?? String(c.state);
}

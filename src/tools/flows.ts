import { join } from "node:path";
import { getAddress } from "ethers";
import { z } from "zod";
import { ACTIONS, AIFP, DISCLOSURE_KIND, OUTCOME, PUBLIC_AUDIENCE, PUBLIC_AUDIENCE_CANONICAL, ROLES, ZERO32, outcomeName, roleNames, subjectOfAddress, subjectOfCanonical, type OutcomeName, type RoleName } from "../core/aifp.js";
import { CELL_SOURCE, TENDER_MARKET, descriptorUri, fogaParadigm, fogaParadigms, marketTransportBinding, type WorldFlows } from "../core/paradigms.js";
import { NODE_SCOPE_GROUPS, applicableGroups, mergeScope, operatorScope, ownerExecuteScope } from "../genesis/operator-scope.js";
import { documentsDir, readManifest } from "../node/documents.js";
import { admissionMaterial, anchorPlan, anchors, cellChannelId, reconcileAnchors, cellSourceParadigmId, cellTransportBindings, channelFact, channelMetadata, channelMetadataUri, currentEligibility, disclosedToPublic, disclosures, flowsDir, marketFact, marketOf, publicationObjectRef, recordAdmission, recordAnchor, recordChannel, recordDisclosure, reconcileDisclosures, roleNow, writeFlowDocuments, type ChannelFact } from "../node/flows.js";
import { dataUriJcs } from "../core/canonical.js";
import { marketMetadata } from "../world/flows-bootstrap.js";
import { ok, refused, safetyGate, type Gate } from "../node/policy.js";
import type { Node } from "../node/node.js";
import { readJson, writeJson } from "../util/fs.js";
import { derivedJobId, zAddress, zBytes32, zJobId } from "./common.js";
import { missingOf, oneKey, ownerExecuteGate } from "./meditation.js";
import type { ActCapability, ActStep, ReadCapability } from "./types.js";
import type { WorldFile } from "../world/types.js";

/**
 * ERC-8489 as capabilities (docs/flows.md). The cell's own channel is opened by the owner through the account (the
 * authority is the account, and the account grants itself SUBMIT); what the cell publishes is anchored there and
 * recorded as disclosed by the operator; the market admits the cell by the identity predicate, the operator's act
 * through the account. Every role check keeps its four values — SATISFIED, NOT_SATISFIED, UNDETERMINABLE,
 * VERIFIER_ERROR — and a refused admission names the one the registry would have obtained; a read that fails is a
 * failed call, never an outcome. The status and the roles are public reads.
 */
const zRole = z.enum(["submit", "respond"]);
const zRoleName = z.enum(Object.keys(ROLES) as [RoleName, ...RoleName[]]);
const OutcomeSchema = z.enum(["SATISFIED", "NOT_SATISFIED", "UNDETERMINABLE", "VERIFIER_ERROR"]);

/** A subject given as an address, a canonical subject string or a bytes32 reference. */
function subjectRefOf(node: Node, s: string): { ref: string; canonical: string | null } {
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return { ref: s.toLowerCase(), canonical: null };
  if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { ref: subjectOfAddress(node.chainId, s), canonical: `eip155-address:${node.chainId}:${s.toLowerCase()}` };
  return { ref: subjectOfCanonical(s), canonical: s };
}

async function rolesIn(node: Node, channelId: string, subject: string, roles: RoleName[]): Promise<Record<string, OutcomeName | string>> {
  const out: Record<string, OutcomeName | string> = {};
  for (const r of roles) {
    const x = await roleNow(node, channelId, subject, r);
    out[r] = x.outcome ?? `call failed: ${x.error}`;
  }
  return out;
}

export const flow_status: ReadCapability = {
  name: "flow_status",
  title: "Information flows (ERC-8489)",
  description: "The cell's own channel (its id, paradigm, authority, state and transport bindings, the roles the cell holds in it, what it anchored and disclosed), the market it joins (the channel, its paradigm and authority, the roles the cell was admitted to — the historical roles the registry evaluates — and its current eligibility for them), and the registries of the world. A role SATISFIED is a role bound in the registry; it is not a judgment of the cell.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8489],
  input: z.object({}),
  output: z
    .object({
      available: z.boolean(),
      meaning: z.string(),
      registries: z.object({ paradigms: z.string(), channels: z.string(), participation: z.string(), verifier: z.string(), anchor: z.string(), identityVerifier: z.string().nullable() }).nullable(),
      paradigms: z.record(z.string(), z.object({ paradigmId: z.string(), registered: z.boolean().nullable() })),
      channel: z.unknown().nullable(),
      market: z.unknown().nullable(),
      local: z.object({ dir: z.string(), anchors: z.number(), disclosures: z.number(), lastAnchor: z.unknown().nullable(), publication: z.object({ objectRef: z.string(), version: z.number(), anchored: z.boolean(), disclosed: z.boolean() }).nullable(), watcher: z.object({ auto: z.boolean(), checkEverySeconds: z.number(), nextCheckAt: z.number().nullable(), lastAction: z.string().nullable() }) }),
    })
    .passthrough(),
  async handler({ node }) {
    const k = node.kernel;
    const cfg = node.config;
    const w = node.store.getFact<{ nextCheckAt?: number; lastAction?: string }>("watch.flows");
    const watcher = { auto: cfg.flows.auto, checkEverySeconds: cfg.flows.checkEverySeconds, nextCheckAt: w?.nextCheckAt ?? null, lastAction: w?.lastAction ?? null };
    const meaning = "a role is a binding in the participation registry, evaluated at the registry's clock with four values; the market's identity predicate is re-judged only at admission and re-admission, so the current eligibility (the ERC-8004 identity owned, the ERC-8434 anchor ACTIVE) is read beside it";
    const manifest = readManifest(documentsDir(node));
    const publication = manifest ? (() => {
      const objectRef = publicationObjectRef(manifest);
      return { objectRef, version: manifest.version, anchored: anchors(node).some((a) => a.objectRef.toLowerCase() === objectRef.toLowerCase()), disclosed: disclosedToPublic(node, objectRef) };
    })() : null;
    const local = { dir: flowsDir(node), anchors: anchors(node).length, disclosures: disclosures(node).length, lastAnchor: anchors(node).at(-1) ?? null, publication, watcher };
    if (!k.flows.available) return { available: false, meaning: "this world has no ERC-8489 registries; the cell takes part in no registered information flow", registries: null, paradigms: {}, channel: null, market: null, local };
    const registries = { paradigms: k.flows.addressOf(AIFP.paradigms), channels: k.flows.addressOf(AIFP.channels), participation: k.flows.addressOf(AIFP.participation), verifier: k.flows.addressOf(AIFP.verifier), anchor: k.flows.addressOf(AIFP.anchor), identityVerifier: k.flows.identityVerifierAvailable ? k.flows.addressOf(AIFP.identityVerifier) : null };
    const paradigms: Record<string, { paradigmId: string; registered: boolean | null }> = {};
    const sourceId = cellSourceParadigmId(node);
    paradigms[CELL_SOURCE] = { paradigmId: sourceId, registered: await k.flows.paradigmExists(sourceId).catch(() => null) };
    if (k.flows.identityVerifierAvailable) {
      const m = fogaParadigm(TENDER_MARKET, node.world);
      paradigms[TENDER_MARKET] = { paradigmId: m.bundle.paradigmId, registered: await k.flows.paradigmExists(m.bundle.paradigmId).catch(() => null) };
    }
    const subject = node.cell ? k.flows.subjectOf(node.cell.address) : null;
    let channel: unknown = null;
    const channelId = cellChannelId(node);
    if (channelId && subject) {
      const fact = channelFact(node);
      const rec = await k.flows.channel(channelId).catch(() => null);
      const current = rec ? await k.flows.currentParadigm(channelId).catch(() => null) : null;
      const ids = rec ? await k.flows.bindingIds(channelId).catch(() => []) : [];
      channel = {
        channelId,
        paradigm: fact?.paradigm ?? CELL_SOURCE,
        paradigmId: current?.paradigmId ?? fact?.paradigmId ?? null,
        authority: rec?.authority ?? null,
        authorityIsTheCell: rec ? rec.authority.toLowerCase() === node.cell!.address.toLowerCase() : null,
        state: rec?.stateName ?? null,
        openedAt: rec?.openedAt ?? null,
        metadataURI: rec?.metadataURI ?? null,
        bindings: ids.length,
        roles: await rolesIn(node, channelId, subject, ["submit", "redistribute", "manageDisclosure"]),
        disclosureCount: rec ? await k.flows.disclosureCount(channelId).catch(() => null) : null,
      };
    }
    let market: unknown = null;
    const m = marketOf(node);
    if (m) {
      const rec = await k.flows.channel(m.channelId).catch(() => null);
      const current = rec ? await k.flows.currentParadigm(m.channelId).catch(() => null) : null;
      const fact = marketFact(node);
      market = {
        channelId: m.channelId,
        source: m.source,
        paradigmId: current?.paradigmId ?? null,
        fogaMarket: current && paradigms[TENDER_MARKET] ? current.paradigmId.toLowerCase() === paradigms[TENDER_MARKET].paradigmId.toLowerCase() : null,
        authority: rec?.authority ?? null,
        state: rec?.stateName ?? null,
        join: cfg.flows.market.join,
        wanted: cfg.flows.market.roles,
        roles: subject ? await rolesIn(node, m.channelId, subject, ["submit", "respond", "observe"]) : {},
        admitted: fact && fact.channelId.toLowerCase() === m.channelId.toLowerCase() ? fact.admitted : {},
        eligibility: node.cell ? await currentEligibility(node) : null,
      };
    }
    return { available: true, meaning, registries, paradigms, channel, market, local };
  },
};

export const flow_roles: ReadCapability = {
  name: "flow_roles",
  title: "Roles of a subject in a channel (ERC-8489)",
  description: "The participation registry's four-valued evaluation of a subject's roles in a channel at the current clock, the summary of role bits it reports, and the subject's bindings there (basis, interval, state). The subject is an address (its eip155-address reference), a canonical subject string or a bytes32 reference; the channel defaults to the market, then to the cell's own channel.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8489],
  input: z.object({ subject: z.string().min(3).describe("an address, a canonical subject string (<scheme>:<domain>:<id>) or a bytes32 reference"), channelId: zBytes32.optional(), roles: z.array(zRoleName).optional().describe("the roles to evaluate (default: submit, respond, observe, redistribute)") }),
  output: z.object({ channelId: z.string(), subject: z.string(), canonical: z.string().nullable(), asOf: z.number(), roles: z.record(z.string(), z.string()), rolesOf: z.array(z.string()), bindings: z.array(z.unknown()) }),
  async handler({ node }, input) {
    const k = node.kernel;
    if (!k.flows.available) throw new Error("this world has no ERC-8489 registries");
    const channelId = input.channelId ?? marketOf(node)?.channelId ?? cellChannelId(node);
    if (!channelId) throw new Error("no channel: pass channelId (this world names no market and the cell has no channel)");
    const { ref, canonical } = subjectRefOf(node, input.subject);
    const roles = (input.roles ?? ["submit", "respond", "observe", "redistribute"]) as RoleName[];
    const asOf = await k.flows.clock();
    const ids = await k.flows.bindingIdsOf(channelId, ref);
    const bindings = [];
    for (const id of ids) bindings.push({ bindingId: id, ...(await k.flows.bindingOf(id)) });
    return { channelId, subject: ref, canonical, asOf, roles: await rolesIn(node, channelId, ref, roles), rolesOf: roleNames(await k.flows.rolesOf(channelId, ref, ZERO32, asOf)), bindings };
  },
};

// ---------------------------------------------------------------------------- the owner's acts (admin, CLI only)

export const flow_open: ActCapability = {
  name: "flow_open",
  title: "Open the cell's channel (ERC-8489)",
  description: "The owner opens the cell's own channel through its account — paradigm foga:cell-source/v1, authority the account, the entrances declared as transport bindings with the capabilities they actually have — and grants the cell SUBMIT in it (an authority holds no role until it is granted one). When the operator's allow-list lacks the `flows` group, or a one-key cell its owner's pairs, the owner opens them first in the same job. The channel id is written into the configuration.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8489],
  input: z.object({ jobId: zJobId }),
  output: z.object({ channelId: z.string(), paradigmId: z.string(), authority: z.string(), bindingIds: z.array(z.string()), grant: z.object({ bindingId: z.string(), roles: z.array(z.string()) }), scopeOpened: z.array(z.string()), txHashes: z.array(z.string()), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.flows.available) throw new Error("this world has no ERC-8489 registries: foga cell extend --covenants 8489 adds them to the cell's world file when the chain has them");
    const cell = node.body;
    const account = getAddress(cell.address);
    const gates: Gate[] = [];
    const have = cellChannelId(node);
    if (have) gates.push(refused("policy", `the cell has a channel already: ${have}`));
    const paradigmId = cellSourceParadigmId(node);
    if (!(await k.flows.paradigmExists(paradigmId))) gates.push(refused("policy", `the paradigm ${CELL_SOURCE} (${paradigmId}) is not registered on this chain: the world's maintainer registers it (foga flow bootstrap) before any cell opens a channel`));
    const version = await node.accountVersion();
    if (version < 2) gates.push(refused("policy", `the account is a revision-${version} FogaCellAccount (no operator allow-list); migrate first`));
    const scope = oneKey(node) ? mergeScope(operatorScope(k, ["flows"]), ownerExecuteScope(k)) : operatorScope(k, ["flows"]);
    const missing: number[] = version >= 2 ? await missingOf(node, scope) : [];
    const transports = cellTransportBindings(node);
    if (!gates.some((g) => !g.ok)) gates.push(ok("policy", `open ${CELL_SOURCE} with authority ${account}; ${transports.length} transport binding(s): ${transports.map((t) => t.name).join(", ") || "none (no public endpoint)"}; ${missing.length ? `${missing.length} allow-list pair(s) to open first` : "allow-list already open"}`));
    const jobId = input.jobId ?? derivedJobId("flow-open", { account });
    const metadataURI = channelMetadataUri(node);
    const subject = k.flows.subjectOf(account);
    const grantRoles = ROLES.submit;
    const steps: ActStep[] = [];
    if (missing.length) steps.push({ name: "scope", kind: "plain", by: "owner", route: "direct", build: () => ({ target: cell.address, value: 0n, data: cell.iface.encodeFunctionData("setOperatorAllowedBatch", [missing.map((i) => scope.targets[i]), missing.map((i) => scope.selectors[i]), true]), label: `setOperatorAllowedBatch(${missing.map((i) => scope.names[i]).join(", ")})` }) });
    steps.push({ name: "openChannel", kind: "plain", by: "owner", route: "execute", build: () => ({ target: k.flows.addressOf(AIFP.channels), value: 0n, data: k.flows.encodeOpenChannel(paradigmId, account, ZERO32, metadataURI, transports.map((t) => t.binding)), label: `openChannel(${CELL_SOURCE}, authority ${account}, ${transports.length} binding(s))` }) });
    steps.push({
      name: "grant",
      kind: "plain",
      by: "owner",
      route: "execute",
      build: (prior) => {
        const channelId = k.flows.channelIdFromReceipt(prior[prior.length - 1].receipt);
        return { target: k.flows.addressOf(AIFP.participation), value: 0n, data: k.flows.encodeGrant(channelId, subject, grantRoles), label: `grant(${channelId.slice(0, 10)}…, the cell, SUBMIT)` };
      },
    });
    return {
      job: { id: jobId, kind: "flows-admin", input: { open: account, paradigmId, metadataURI, transports: transports.map((t) => t.name), scope: missing.map((i) => scope.names[i]) } },
      gates,
      valueWei: 0n,
      gasPerStep: 700_000n,
      steps,
      output: async (confirmed) => {
        const open = confirmed.find((c) => c.key.endsWith(":openChannel"))!;
        const grant = confirmed.find((c) => c.key.endsWith(":grant"))!;
        const channelId = k.flows.channelIdFromReceipt(open.receipt);
        const grantId = k.flows.roleBindingIdFromReceipt(grant.receipt);
        const rec = await k.flows.channel(channelId);
        const fact: ChannelFact = { channelId, paradigm: CELL_SOURCE, paradigmId, authority: rec.authority, openedAt: rec.openedAt, txHash: open.txHash, metadataURI, bindingIds: k.flows.bindingIdsFromReceipt(open.receipt), grant: { bindingId: grantId, roles: grantRoles, txHash: grant.txHash } };
        recordChannel(node, fact);
        if (missing.length) {
          const had = node.store.getFact<{ groups: string[]; entries: string[] }>("extend.scope");
          node.store.setFact("extend.scope", { groups: [...new Set([...(had?.groups ?? []), "flows"])], entries: [...new Set([...(had?.entries ?? []), ...missing.map((i) => scope.names[i])])] });
        }
        return { channelId, paradigmId, authority: rec.authority, bindingIds: fact.bindingIds, grant: { bindingId: grantId, roles: roleNames(grantRoles) }, scopeOpened: missing.map((i) => scope.names[i]), txHashes: confirmed.map((c) => c.txHash), jobId };
      },
    };
  },
};

export const flow_bootstrap: ActCapability = {
  name: "flow_bootstrap",
  title: "Bootstrap a world's flows (ERC-8489, the maintainer's act)",
  description: "The owner registers FOGA's two paradigms (foga:cell-source/v1, foga:tender-market/v1 for this world's registries) in the family `foga` and opens the default tender market channel with the TaskToken's events as its transport — through the cell's account, which becomes the family's controller and the market's authority. Once per chain, by the world's maintainer; a paradigm registered already is kept, a market recorded already is kept. The result is written into the cell's world file as its `flows` block and printed, to be carried into the packaged world.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8489],
  input: z.object({ jobId: zJobId }),
  output: z.object({ flows: z.unknown(), registered: z.array(z.string()), marketOpened: z.boolean(), scopeOpened: z.array(z.string()), txHashes: z.array(z.string()), jobId: z.string(), worldFile: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.flows.available) throw new Error("this world has no ERC-8489 registries");
    if (!k.flows.identityVerifierAvailable) throw new Error(`this world has no ${AIFP.identityVerifier}: the market's paradigm names it; deploy it (foga world deploy adds it to a world from the bundle) and add it to the world file first`);
    const cell = node.body;
    const account = getAddress(cell.address);
    const gates: Gate[] = [];
    const paradigms = fogaParadigms(node.world);
    const existing: string[] = [];
    for (const p of paradigms) if (await k.flows.paradigmExists(p.bundle.paradigmId)) existing.push(p.name);
    const toRegister = paradigms.filter((p) => !existing.includes(p.name));
    const controller = await k.flows.familyController(paradigms[0].bundle.familyId);
    if (toRegister.length && controller !== "0x0000000000000000000000000000000000000000" && controller !== account) gates.push(refused("policy", `the family ${paradigms[0].bundle.family} is controlled by ${controller}, not by this cell's account ${account}; only the controller registers further paradigms`));
    const worldFlows = node.world.file.flows;
    const marketKnown = Boolean(worldFlows?.market);
    const version = await node.accountVersion();
    if (version < 2) gates.push(refused("policy", `the account is a revision-${version} FogaCellAccount; migrate first`));
    const scope = oneKey(node) ? mergeScope(operatorScope(k, ["flows"]), ownerExecuteScope(k)) : operatorScope(k, ["flows"]);
    const missing: number[] = version >= 2 ? await missingOf(node, scope) : [];
    if (!toRegister.length && marketKnown) gates.push(refused("policy", `nothing to do: ${existing.join(", ")} registered; market ${worldFlows!.market!.channelId} recorded`));
    if (!gates.some((g) => !g.ok)) gates.push(ok("policy", `${toRegister.length ? `register ${toRegister.map((p) => p.name).join(", ")}` : "paradigms registered"}; ${marketKnown ? "market recorded" : "open the market channel"}; ${missing.length ? `${missing.length} allow-list pair(s) to open first` : "allow-list open"}`));
    const jobId = input.jobId ?? derivedJobId("flow-bootstrap", { account, toRegister: toRegister.map((p) => p.bundle.paradigmId), market: marketKnown });
    const publicUrl = node.config.runtime.http.publicUrl ?? null;
    const market = paradigms.find((p) => p.name === TENDER_MARKET)!;
    const metadataURI = publicUrl ? `${publicUrl.replace(/\/+$/, "")}/documents/flows/market.json` : dataUriJcs(marketMetadata(node.world, account));
    const steps: ActStep[] = [];
    if (missing.length) steps.push({ name: "scope", kind: "plain", by: "owner", route: "direct", build: () => ({ target: cell.address, value: 0n, data: cell.iface.encodeFunctionData("setOperatorAllowedBatch", [missing.map((i) => scope.targets[i]), missing.map((i) => scope.selectors[i]), true]), label: `setOperatorAllowedBatch(${missing.map((i) => scope.names[i]).join(", ")})` }) });
    for (const p of toRegister) steps.push({ name: `register:${p.name.replace(/[^a-z0-9]+/gi, "-")}`, kind: "plain", by: "owner", route: "execute", build: () => ({ target: k.flows.addressOf(AIFP.paradigms), value: 0n, data: k.flows.encodeRegisterParadigm(p.bundle, ZERO32, descriptorUri(p.name, p.descriptor, publicUrl)), label: `registerParadigm(${p.name} ${p.bundle.paradigmId.slice(0, 10)}…)` }) });
    if (!marketKnown) steps.push({ name: "openMarket", kind: "plain", by: "owner", route: "execute", build: () => ({ target: k.flows.addressOf(AIFP.channels), value: 0n, data: k.flows.encodeOpenChannel(market.bundle.paradigmId, account, ZERO32, metadataURI, [marketTransportBinding(node.world)]), label: `openChannel(${TENDER_MARKET}, authority ${account})` }) });
    return {
      job: { id: jobId, kind: "flows-admin", input: { bootstrap: account, register: toRegister.map((p) => p.name), market: !marketKnown } },
      gates,
      valueWei: 0n,
      gasPerStep: 1_600_000n,
      steps,
      output: async (confirmed) => {
        const flows: WorldFlows = {
          family: paradigms[0].bundle.family,
          familyId: paradigms[0].bundle.familyId,
          controller: worldFlows?.controller ?? account,
          paradigms: { ...(worldFlows?.paradigms ?? {}) },
          market: worldFlows?.market ?? null,
          note: "ERC-8489 flows of this world: FOGA's paradigms in the family foga and the default market channel, bootstrapped by the reference cell through its account; a cell's configuration may name another market",
        };
        for (const p of paradigms) {
          const c = confirmed.find((x) => x.key.endsWith(`:register:${p.name.replace(/[^a-z0-9]+/gi, "-")}`));
          const uri = c ? descriptorUri(p.name, p.descriptor, publicUrl) : (flows.paradigms[p.name]?.descriptorURI ?? (await k.flows.paradigm(p.bundle.paradigmId)).descriptorURI);
          flows.paradigms[p.name] = { paradigmId: p.bundle.paradigmId, descriptorURI: uri, ...(c ? { txHash: c.txHash } : flows.paradigms[p.name]?.txHash ? { txHash: flows.paradigms[p.name].txHash } : {}) };
        }
        const opened = confirmed.find((x) => x.key.endsWith(":openMarket"));
        if (opened) flows.market = { channelId: k.flows.channelIdFromReceipt(opened.receipt), paradigm: TENDER_MARKET, paradigmId: market.bundle.paradigmId, authority: account, txHash: opened.txHash, bindingIds: k.flows.bindingIdsFromReceipt(opened.receipt) };
        // the cell's own world file carries the block from here on; the packaged world gets it by hand (the maintainer's release)
        const worldPath = node.worldPath;
        const file = readJson<WorldFile>(worldPath);
        file.flows = flows;
        if (!file.steps.some((s) => s.id === "8489/flows")) file.steps.push({ id: "8489/flows", status: "wired", txHash: flows.market?.txHash, note: `bootstrapped by ${account} (flow_bootstrap)` });
        writeJson(worldPath, file);
        node.world.file.flows = flows;
        writeFlowDocuments(node, paradigms);
        if (publicUrl) writeJson(join(flowsDir(node), "market.json"), marketMetadata(node.world, account));
        if (missing.length) {
          const had = node.store.getFact<{ groups: string[]; entries: string[] }>("extend.scope");
          node.store.setFact("extend.scope", { groups: [...new Set([...(had?.groups ?? []), "flows"])], entries: [...new Set([...(had?.entries ?? []), ...missing.map((i) => scope.names[i])])] });
        }
        return { flows, registered: toRegister.map((p) => p.name), marketOpened: Boolean(opened), scopeOpened: missing.map((i) => scope.names[i]), txHashes: confirmed.map((c) => c.txHash), jobId, worldFile: worldPath };
      },
    };
  },
};

// ---------------------------------------------------------------------------- the operator's acts

export const flow_admit: ActCapability = {
  name: "flow_admit",
  title: "Admit the cell to the market (ERC-8489)",
  description: "The cell admits itself to the tender market channel for the roles the configuration names (SUBMIT and RESPOND by default) through its account: the market paradigm's identity predicate is evaluated by the registry's composite verifier over the evidence — the account and its ERC-8004 agent id — and a binding is created on SATISFIED. The outcome is previewed first: NOT_SATISFIED, UNDETERMINABLE and VERIFIER_ERROR are refused at the `admission` gate by name, nothing is sent, and the cell's current eligibility is said beside them. A role the cell already holds is not admitted again.",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [8489, 8004, 8434],
  input: z.object({ roles: z.array(zRole).min(1).optional().describe("the roles to acquire (default: the configuration's flows.market.roles)"), channelId: zBytes32.optional().describe("another market than the configured one"), jobId: zJobId }),
  output: z.object({ channelId: z.string(), paradigmId: z.string(), admitted: z.array(z.object({ role: z.string(), bindingId: z.string(), txHash: z.string() })), alreadyHeld: z.array(z.string()), eligibility: z.unknown(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.flows.available) throw new Error("this world has no ERC-8489 registries");
    const cell = node.body;
    const account = getAddress(cell.address);
    const gates: Gate[] = [];
    const market = input.channelId ? { channelId: input.channelId, source: "input" as const } : marketOf(node);
    if (!market) {
      return { job: { id: input.jobId ?? derivedJobId("flow-admit", { account, none: true }), kind: "flows", input: { account } }, gates: [refused("policy", "this world names no market channel and the configuration (flows.market.channelId) none either; nothing to be admitted to")], valueWei: 0n, steps: [], output: () => ({ channelId: ZERO32, paradigmId: ZERO32, admitted: [], alreadyHeld: [], eligibility: null, jobId: "" }) };
    }
    const [aidState, status] = await Promise.all([k.aid.stateName(account), cell.status()]);
    gates.push(safetyGate(aidState, status, "plain"));
    const roles = (input.roles ?? node.config.flows.market.roles) as RoleName[];
    const subject = k.flows.subjectOf(account);
    const eligibility = await currentEligibility(node);
    const held: RoleName[] = [];
    const wanted: RoleName[] = [];
    for (const r of roles) {
      const now = await roleNow(node, market.channelId, subject, r);
      if (now.outcome === "SATISFIED") held.push(r);
      else wanted.push(r);
    }
    let material = wanted.length ? await admissionMaterial(node, market.channelId, wanted[0]) : null;
    if (!wanted.length) gates.push(refused("policy", `the cell holds ${held.join(" and ")} in ${market.channelId} already; nothing to admit`));
    else if (!material!.predicate) gates.push(refused("policy", `the market's paradigm ${material!.paradigmId} expects predicate ${material!.expectedHash.slice(0, 10)}… for ${wanted[0]}; this build's tender-market descriptor for this world compiles to ${material!.predicateHash.slice(0, 10)}… — not FOGA's market, or another world's registries; the cell cannot produce the predicate bytes it would need`));
    else {
      // what the registry would decide, read first: a refused admission is a refusal here, never a reverted transaction
      const previews: string[] = [];
      let bad: { role: RoleName; outcome: OutcomeName } | null = null;
      for (const r of wanted) {
        const m = r === wanted[0] ? material! : await admissionMaterial(node, market.channelId, r);
        if (!m.predicate) {
          bad = { role: r, outcome: "UNDETERMINABLE" };
          previews.push(`${r}: predicate mismatch`);
          break;
        }
        const o = outcomeName(await k.flows.previewAdmission(market.channelId, subject, ROLES[r], m.predicate, m.evidence));
        previews.push(`${r}: ${o}`);
        if (o !== "SATISFIED") {
          bad = { role: r, outcome: o };
          break;
        }
      }
      if (bad) gates.push(refused("admission", `${bad.outcome} for ${bad.role} in ${market.channelId} (${previews.join("; ")}); eligibility now: ${eligibility.detail}`));
      else gates.push(ok("admission", `preview SATISFIED for ${wanted.join(", ")}; ${held.length ? `${held.join(", ")} held already; ` : ""}eligibility: ${eligibility.detail}`));
    }
    const jobId = input.jobId ?? derivedJobId("flow-admit", { account, channelId: market.channelId, roles: wanted });
    const steps: ActStep[] = wanted.map((r) => ({
      name: `admit:${r}`,
      kind: "plain" as const,
      build: async () => {
        const m = await admissionMaterial(node, market.channelId, r);
        if (!m.predicate) throw new Error(`the market's predicate for ${r} changed since the plan`);
        return { target: k.flows.addressOf(AIFP.participation), value: 0n, data: k.flows.encodeAdmit(market.channelId, ROLES[r], m.predicate, m.evidence), label: `admit(${market.channelId.slice(0, 10)}…, ${r}, identity predicate, evidence: the account and agent ${node.config.identity.agentId})` };
      },
    }));
    return {
      job: { id: jobId, kind: "flows", input: { admit: account, channelId: market.channelId, roles: wanted, held } },
      gates,
      valueWei: 0n,
      gasPerStep: 450_000n,
      steps,
      output: async (confirmed) => {
        const admitted: { role: string; bindingId: string; txHash: string }[] = [];
        const at = await k.flows.clock();
        for (const c of confirmed) {
          const role = c.key.split(":admit:")[1] as RoleName;
          const bindingId = k.flows.roleBindingIdFromReceipt(c.receipt);
          recordAdmission(node, market.channelId, role, bindingId, c.txHash, at);
          admitted.push({ role, bindingId, txHash: c.txHash });
        }
        return { channelId: market.channelId, paradigmId: material?.paradigmId ?? (await k.flows.currentParadigm(market.channelId)).paradigmId, admitted, alreadyHeld: held, eligibility, jobId };
      },
    };
  },
};

export const flow_anchor: ActCapability = {
  name: "flow_anchor",
  title: "Anchor the cell's publication (ERC-8489)",
  description: "Anchor the cell's current publication — the object keccak256(JCS({schema, documents})) over the documents manifest's content hashes — in its own channel through the account: `publish` for the first, `supersede` with a supersedes relation to the one before for every later one. The same content is the same object and is not anchored twice. Needs the SUBMIT role the cell granted itself at the opening.",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [8489],
  input: z.object({ jobId: zJobId }),
  output: z.object({ channelId: z.string(), objectRef: z.string(), action: z.string(), supersedes: z.string().nullable(), recordIndex: z.number(), version: z.number(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.flows.available) throw new Error("this world has no ERC-8489 registries");
    const cell = node.body;
    const account = getAddress(cell.address);
    const gates: Gate[] = [];
    const channelId = cellChannelId(node);
    if (!channelId) gates.push(refused("policy", "the cell has no channel (foga cell owner flow_open, or foga cell extend --covenants 8489)"));
    const known = await reconcileAnchors(node);
    const plan = anchorPlan(node);
    if (plan === "unpublished") gates.push(refused("policy", "the documents are not built: nothing to anchor (foga cell docs publish)"));
    else if (plan === null) gates.push(refused("policy", `the current publication is anchored already (${anchors(node).at(-1)?.objectRef.slice(0, 10) ?? "?"}…); nothing new`));
    else if (known?.anchoredBy === "another subject") gates.push(refused("policy", `the object ${known.objectRef.slice(0, 10)}… is anchored by another subject already: these documents are not this cell's own publication (a documents directory shared with another cell?)`));
    if (channelId) {
      const role = await roleNow(node, channelId, k.flows.subjectOf(account), "submit");
      if (role.outcome !== "SATISFIED") gates.push(refused("policy", `the cell does not hold SUBMIT in its channel now: ${role.outcome ?? `call failed: ${role.error}`}`));
      else gates.push(ok("policy", `SUBMIT held in ${channelId}`));
    }
    const [aidState, status] = await Promise.all([k.aid.stateName(account), cell.status()]);
    gates.push(safetyGate(aidState, status, "plain"));
    const p = typeof plan === "object" && plan ? plan : null;
    const jobId = input.jobId ?? derivedJobId("flow-anchor", { account, objectRef: p?.objectRef ?? null });
    return {
      job: { id: jobId, kind: "flows", input: { anchor: account, channelId, objectRef: p?.objectRef ?? null, action: p?.action ?? null, supersedes: p?.supersedes ?? null } },
      gates,
      valueWei: 0n,
      gasPerStep: 300_000n,
      steps: p && channelId ? [{ name: "anchor", kind: "plain", build: () => ({ target: k.flows.addressOf(AIFP.anchor), value: 0n, data: k.flows.encodeAnchor(channelId, ACTIONS[p.action], p.objectRef, p.relations), label: `anchor(${channelId.slice(0, 10)}…, ${p.action}, ${p.objectRef.slice(0, 10)}…${p.supersedes ? `, supersedes ${p.supersedes.slice(0, 10)}…` : ""})` }) }] : [],
      output: async (confirmed) => {
        const c = confirmed[0];
        // a dry run confirms nothing: what the anchor would be, and no fact recorded
        if (!c) return { channelId: channelId!, objectRef: p!.objectRef, action: p!.action, supersedes: p!.supersedes, recordIndex: -1, version: p!.version, txHash: "", jobId };
        const recordIndex = k.flows.anchorIndexFromReceipt(c.receipt);
        const at = await k.flows.clock();
        recordAnchor(node, { objectRef: p!.objectRef, action: p!.action, recordIndex, txHash: c.txHash, at, version: p!.version, supersedes: p!.supersedes });
        return { channelId: channelId!, objectRef: p!.objectRef, action: p!.action, supersedes: p!.supersedes, recordIndex, version: p!.version, txHash: c.txHash, jobId };
      },
    };
  },
};

export const flow_disclose: ActCapability = {
  name: "flow_disclose",
  title: "Record the public disclosure of a publication (ERC-8489)",
  description: "Record in the cell's channel that its current publication was made readable by anyone (`DISCLOSED` to the public audience, ext:foga:public), through the account. A fact about what happened — the documents were served at a public URL — not a right granted; recorded once per object. Refused when the cell has no public URL or the object is recorded already.",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [8489],
  input: z.object({ jobId: zJobId }),
  output: z.object({ channelId: z.string(), objectRef: z.string(), audience: z.string(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    if (!k.flows.available) throw new Error("this world has no ERC-8489 registries");
    const cell = node.body;
    const account = getAddress(cell.address);
    const gates: Gate[] = [];
    const channelId = cellChannelId(node);
    if (!channelId) gates.push(refused("policy", "the cell has no channel"));
    if (!node.config.runtime.http.publicUrl) gates.push(refused("policy", "the cell has no public URL: its documents are not served to anyone, so there is no disclosure to record"));
    const manifest = readManifest(documentsDir(node));
    const objectRef = manifest ? publicationObjectRef(manifest) : null;
    if (!objectRef) gates.push(refused("policy", "the documents are not built: nothing was disclosed"));
    else if (channelId && (await reconcileDisclosures(node, channelId, objectRef))) gates.push(refused("policy", `the current publication ${objectRef.slice(0, 10)}… is recorded as disclosed already`));
    else if (!gates.some((g) => !g.ok)) gates.push(ok("policy", `record DISCLOSED ${objectRef.slice(0, 10)}… to ${PUBLIC_AUDIENCE_CANONICAL} in ${channelId}`));
    const [aidState, status] = await Promise.all([k.aid.stateName(account), cell.status()]);
    gates.push(safetyGate(aidState, status, "plain"));
    const jobId = input.jobId ?? derivedJobId("flow-disclose", { account, objectRef });
    return {
      job: { id: jobId, kind: "flows", input: { disclose: account, channelId, objectRef, audience: PUBLIC_AUDIENCE_CANONICAL } },
      gates,
      valueWei: 0n,
      gasPerStep: 200_000n,
      steps: channelId && objectRef ? [{ name: "disclose", kind: "plain", build: () => ({ target: k.flows.addressOf(AIFP.channels), value: 0n, data: k.flows.encodeRecordDisclosure(channelId, DISCLOSURE_KIND.disclosed, objectRef, PUBLIC_AUDIENCE), label: `recordDisclosure(${channelId.slice(0, 10)}…, DISCLOSED, ${objectRef.slice(0, 10)}…, public)` }) }] : [],
      output: async (confirmed) => {
        // a dry run confirms nothing, and records no disclosure the chain does not hold
        if (!confirmed.length) return { channelId: channelId!, objectRef: objectRef!, audience: PUBLIC_AUDIENCE_CANONICAL, txHash: "", jobId };
        const at = await k.flows.clock();
        recordDisclosure(node, { objectRef: objectRef!, audience: PUBLIC_AUDIENCE_CANONICAL, txHash: confirmed[0].txHash, at });
        return { channelId: channelId!, objectRef: objectRef!, audience: PUBLIC_AUDIENCE_CANONICAL, txHash: confirmed[0].txHash, jobId };
      },
    };
  },
};

export const FLOW_CAPABILITIES = [flow_status, flow_roles, flow_open, flow_bootstrap, flow_admit, flow_anchor, flow_disclose];

export { OUTCOME, channelMetadata, NODE_SCOPE_GROUPS, applicableGroups, ownerExecuteGate };

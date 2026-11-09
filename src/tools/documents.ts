import { z } from "zod";
import { ACTIONS, AIFP, DISCLOSURE_KIND, PUBLIC_AUDIENCE, PUBLIC_AUDIENCE_CANONICAL } from "../core/aifp.js";
import { DOCUMENT_FILES, buildDocuments, documentsDir, onChainState, publishSteps, readBack, readBuilt, readManifest } from "../node/documents.js";
import { anchorPlan, cellChannelId, disclosedToPublic, publicationObjectRef, reconcileAnchors, recordAnchor, recordDisclosure, roleNow, type AnchorPlan } from "../node/flows.js";
import { ok, refused, safetyGate, type Gate } from "../node/policy.js";
import { version } from "../util/version.js";
import { derivedJobId, zJobId } from "./common.js";
import type { ActCapability, ActStep, ReadCapability } from "./types.js";

/**
 * The cell's documents as capabilities (design memo, Phase 3, section 7): `docs_status` reads what is built and what
 * the chain holds; `docs_publish` builds the documents from the configuration, commits each one that differs from
 * the chain — the ERC-8004 agentURI, the ERC-8434 document URI and digest, the ERC-8444 descriptor, a new ERC-8454
 * unit version — as one keyed job (the same documents are the same job, never sent twice), then reads them back.
 * Metadata updates are the operator's own calls through the account (the `identity` scope group), plain actions
 * that commit nothing and move nothing.
 */
const RowSchema = z.object({ commitment: z.string(), ok: z.boolean().nullable(), detail: z.string() });

export const docs_status: ReadCapability = {
  name: "docs_status",
  title: "Documents: built and on chain",
  description: "The cell's documents as last built (the manifest: files, content hashes, version) and what the chain holds for each commitment — agentURI, AID document, ARD descriptor, AUF unit version — with whether they agree.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8004, 8434, 8444, 8454],
  input: z.object({}),
  output: z.object({
    dir: z.string(),
    manifest: z.unknown().nullable(),
    onChain: z.object({ agentURI: z.string().nullable(), aid: z.object({ uri: z.string(), digest: z.string() }).nullable(), ard: z.object({ descriptorHash: z.string(), descriptorURI: z.string() }).nullable(), unit: z.object({ version: z.number(), boundaryHash: z.string() }).nullable() }),
    readBack: z.array(RowSchema),
    pending: z.array(z.string()),
  }),
  async handler({ node }) {
    const dir = documentsDir(node);
    const built = readBuilt(dir);
    const onChain = await onChainState(node);
    const rows = built ? await readBack(node, built, { fetchUrls: false }) : [];
    const pending = built ? (await publishSteps(node, built)).steps.map((s) => s.name) : [];
    return { dir, manifest: readManifest(dir), onChain, readBack: rows, pending };
  },
};

export const docs_publish: ActCapability = {
  name: "docs_publish",
  title: "Publish the cell's documents",
  description: "Build the documents from the configuration (registration, AID document, ARD descriptor, AUF unit, agent card, server.json) and commit on chain each one that differs from what the chain holds: setAgentURI, setDocumentURI, updateDescriptor, publishVersion. On a world with ERC-8489, the publication is then anchored in the cell's channel (publish, then supersede) and, when served at a public URL, recorded as disclosed to the public. One keyed job; nothing is sent twice for the same documents; read back afterwards.",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [8004, 8434, 8444, 8454, 8489],
  input: z.object({ jobId: zJobId }),
  output: z.object({ dir: z.string(), version: z.number(), documents: z.array(z.string()), committed: z.array(z.string()), unchanged: z.array(z.string()), readBack: z.array(RowSchema), flows: z.object({ objectRef: z.string().nullable(), anchored: z.string().nullable(), disclosed: z.boolean(), note: z.string() }), jobId: z.string(), operations: z.array(z.string()) }),
  async plan({ node }, input) {
    const k = node.kernel;
    const cell = node.body;
    const built = await buildDocuments(node, { version });
    const { steps: pending, unchanged } = await publishSteps(node, built);
    const gates: Gate[] = [];
    const [aidState, status] = await Promise.all([k.aid.stateName(cell.address), cell.status()]);
    gates.push(safetyGate(aidState, status, "plain"));
    if (!node.config.identity.agentId) gates.push(refused("policy", "the cell has no ERC-8004 agent id: nothing to publish a registration for"));
    else gates.push(ok("policy", `${pending.length} commitment(s) to make, ${unchanged.length} already as built`));
    const manifestHash = Object.values(built.manifest.documents).map((d) => d.contentHash).join(",");
    const jobId = input.jobId ?? derivedJobId("docs", { hashes: manifestHash, uri: built.manifest.publicUrl ?? "data" });
    const steps: ActStep[] = pending.map((s) => ({ name: s.name, kind: "plain" as const, build: () => ({ target: s.target, value: 0n, data: s.data, label: s.label }) }));

    // ERC-8489 (0.9.0, docs/flows.md): the publication is anchored in the cell's channel — publish the first time, supersede
    // the one before afterwards; the same content is the same object and is not anchored again — and, when the documents
    // are served at a public URL, recorded as disclosed to the public. In the same keyed job: a publish interrupted after
    // the commitments resumes here with the same calldata.
    const channelId = k.flows.available ? cellChannelId(node) : null;
    const objectRef = channelId ? publicationObjectRef(built.manifest) : null;
    let anchor: AnchorPlan | null = null;
    let disclose = false;
    let flowNote = "no ERC-8489 registries in this world";
    if (k.flows.available && !channelId) flowNote = "the cell has no channel (foga cell extend --covenants 8489)";
    else if (channelId && !node.config.flows.auto) flowNote = "flows.auto is off: the publication is not anchored";
    else if (channelId && objectRef) {
      const known = await reconcileAnchors(node, built.manifest);
      const plan = anchorPlan(node, built.manifest);
      if (known?.anchoredBy === "another subject") flowNote = `not anchored: the object ${objectRef.slice(0, 10)}… is anchored by another subject already (a documents directory shared with another cell?)`;
      else if (plan && plan !== "unpublished") {
        const role = await roleNow(node, channelId, k.flows.subjectOf(cell.address), "submit");
        if (role.outcome === "SATISFIED") anchor = plan;
        else flowNote = `not anchored: the cell does not hold SUBMIT in its channel now (${role.outcome ?? `call failed: ${role.error}`})`;
      } else flowNote = "the publication is anchored already";
      disclose = Boolean(node.config.runtime.http.publicUrl && node.config.flows.disclose && !disclosedToPublic(node, objectRef));
      if (anchor || disclose) flowNote = `${anchor ? `${anchor.action} ${objectRef.slice(0, 10)}…` : "anchored already"}${disclose ? "; disclosed to the public" : ""}`;
      if (anchor) steps.push({ name: "anchor", kind: "plain", build: () => ({ target: k.flows.addressOf(AIFP.anchor), value: 0n, data: k.flows.encodeAnchor(channelId, ACTIONS[anchor!.action], anchor!.objectRef, anchor!.relations), label: `anchor(${channelId.slice(0, 10)}…, ${anchor!.action}, ${anchor!.objectRef.slice(0, 10)}…)` }) });
      if (disclose) steps.push({ name: "disclose", kind: "plain", build: () => ({ target: k.flows.addressOf(AIFP.channels), value: 0n, data: k.flows.encodeRecordDisclosure(channelId, DISCLOSURE_KIND.disclosed, objectRef, PUBLIC_AUDIENCE), label: `recordDisclosure(${channelId.slice(0, 10)}…, DISCLOSED, ${objectRef.slice(0, 10)}…, public)` }) });
    }
    return {
      job: { id: jobId, kind: "docs", input: { version: built.manifest.version, documents: built.manifest.documents, steps: steps.map((s) => s.name) } },
      gates,
      valueWei: 0n,
      steps,
      output: async (confirmed) => {
        let anchored: string | null = null;
        let disclosed = false;
        if (channelId && objectRef) {
          const a = confirmed.find((c) => c.key.endsWith(":anchor"));
          if (a && anchor) {
            recordAnchor(node, { objectRef, action: anchor.action, recordIndex: k.flows.anchorIndexFromReceipt(a.receipt), txHash: a.txHash, at: await k.flows.clock(), version: built.manifest.version, supersedes: anchor.supersedes });
            anchored = anchor.action;
          }
          const d = confirmed.find((c) => c.key.endsWith(":disclose"));
          if (d) {
            recordDisclosure(node, { objectRef, audience: PUBLIC_AUDIENCE_CANONICAL, txHash: d.txHash, at: await k.flows.clock() });
            disclosed = true;
          }
        }
        return { dir: built.dir, version: built.manifest.version, documents: Object.values(DOCUMENT_FILES), committed: pending.map((s) => s.name), unchanged, readBack: await readBack(node, built, { fetchUrls: false }), flows: { objectRef, anchored, disclosed, note: flowNote }, jobId, operations: confirmed.map((c) => c.key) };
      },
    };
  },
};

export const DOCUMENT_CAPABILITIES = [docs_status, docs_publish];

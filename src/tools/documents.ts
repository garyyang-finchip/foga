import { z } from "zod";
import { DOCUMENT_FILES, buildDocuments, documentsDir, onChainState, publishSteps, readBack, readBuilt, readManifest } from "../node/documents.js";
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
  description: "Build the documents from the configuration (registration, AID document, ARD descriptor, AUF unit, agent card, server.json) and commit on chain each one that differs from what the chain holds: setAgentURI, setDocumentURI, updateDescriptor, publishVersion. One keyed job; nothing is sent twice for the same documents; read back afterwards.",
  action: "act",
  visibility: "operator",
  principal: "cell",
  ercs: [8004, 8434, 8444, 8454],
  input: z.object({ jobId: zJobId }),
  output: z.object({ dir: z.string(), version: z.number(), documents: z.array(z.string()), committed: z.array(z.string()), unchanged: z.array(z.string()), readBack: z.array(RowSchema), jobId: z.string(), operations: z.array(z.string()) }),
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
    return {
      job: { id: jobId, kind: "docs", input: { version: built.manifest.version, documents: built.manifest.documents, steps: pending.map((s) => s.name) } },
      gates,
      valueWei: 0n,
      steps,
      output: async (confirmed) => ({ dir: built.dir, version: built.manifest.version, documents: Object.values(DOCUMENT_FILES), committed: pending.map((s) => s.name), unchanged, readBack: await readBack(node, built, { fetchUrls: false }), jobId, operations: confirmed.map((c) => c.key) }),
    };
  },
};

export const DOCUMENT_CAPABILITIES = [docs_status, docs_publish];

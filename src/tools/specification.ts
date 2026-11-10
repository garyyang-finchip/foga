import { getAddress } from "ethers";
import { z } from "zod";
import { BindingStateName, Enforcement, FOGA_CELL_SPEC_VERSION, cellProfile, fogaCellSpecification } from "../core/asf.js";
import { accountRef, keccakJcs } from "../core/canonical.js";
import { mergeScope, operatorScope, ownerExecuteScope } from "../genesis/operator-scope.js";
import { ok, refused, type Gate } from "../node/policy.js";
import { derivedJobId, zJobId } from "./common.js";
import { missingOf, oneKey } from "./meditation.js";
import type { ActCapability, ActStep, ReadCapability } from "./types.js";

/**
 * The FOGA cell specification (ERC-8468; docs/specification.md): the safety specification every cell adopts. Version 1
 * (0.6.0) is the account's gates; version 2 (FOGA-Cell-v2, 1.0.0) adds the runtime's duties over the twelve covenants —
 * the state kept and maintained (ERC-8490), the self-description anchored in the cell's own channel (ERC-8489), a part
 * in a shared context taken under its rules through the account.
 *
 * A cell born by this build binds to version 2 at birth, and its account's requirement names version 2. A cell born
 * before was bound to version 1, and its account's requirement — fixed at deployment — names version 1 alone, so a
 * binding to version 2 cannot be presented to that account without stopping it (VersionMismatch). Such a cell adopts
 * version 2 as a **second binding, enforced by the runtime** (the node honours its clauses; the account keeps
 * enforcing version 1's through the binding it presents) — `spec_adopt`, `foga cell adopt`. The two bindings are
 * what they are: the card, the manifest and the preflight say which version the account enforces and which the
 * runtime adopted. A successor body (`foga cell migrate`) fixes version 2 in its own requirement.
 */
const enforcementNames = (mask: number) => (Object.keys(Enforcement) as (keyof typeof Enforcement)[]).filter((k) => mask & Enforcement[k]);

export const spec_status: ReadCapability = {
  name: "spec_status",
  title: "The specification the cell operates under (ERC-8468)",
  description: "Which version of the FOGA cell specification the cell's account enforces (the binding it presents), which later version the runtime adopted (a second binding, when the cell was born before that version), the registry's verdict on the presented bindings, and this build's current version with its content hash — so a counterparty can tell a FOGA-Cell-v2 cell from one still under version 1.",
  action: "read",
  visibility: "public",
  principal: "none",
  ercs: [8468],
  input: z.object({}),
  output: z.object({
    current: z.object({ version: z.number(), contentHash: z.string(), name: z.string() }),
    account: z.object({ specId: z.string().nullable(), version: z.number(), contentHash: z.string().nullable(), bindingId: z.string().nullable(), state: z.string().nullable(), enforcement: z.array(z.string()) }),
    adopted: z.object({ specId: z.string(), version: z.number(), contentHash: z.string(), bindingId: z.string(), state: z.string().nullable(), enforcement: z.array(z.string()), adoptedAt: z.string() }).nullable(),
    verdict: z.object({ verdict: z.string(), reasons: z.array(z.string()) }).nullable(),
    operatesUnder: z.number(),
    meaning: z.string(),
  }),
  async handler({ node }) {
    const k = node.kernel;
    const cfg = node.config.identity;
    const current = k.asf.specificationCommitment(fogaCellSpecification());
    const presented = cfg.bindingId ? await k.asf.bindingOf(cfg.bindingId).catch(() => null) : null;
    const adoptedFact = cfg.adopted ?? null;
    const adoptedBinding = adoptedFact ? await k.asf.bindingOf(adoptedFact.bindingId).catch(() => null) : null;
    let verdict: { verdict: string; reasons: string[] } | null = null;
    if (node.cell) {
      const s = await node.body.status().catch(() => null);
      if (s) verdict = { verdict: s.verdictName, reasons: s.reasonNames };
    }
    const operatesUnder = Math.max(cfg.safety.version, adoptedFact?.version ?? 0);
    const meaning = operatesUnder >= FOGA_CELL_SPEC_VERSION
      ? cfg.safety.version >= FOGA_CELL_SPEC_VERSION
        ? `the account enforces version ${cfg.safety.version} (bound at birth)`
        : `the account enforces version ${cfg.safety.version} (fixed at its deployment); version ${adoptedFact!.version} is adopted as a runtime-enforced binding, and the node honours its clauses`
      : `the cell operates under version ${operatesUnder}; this build's is ${FOGA_CELL_SPEC_VERSION} (foga cell adopt adopts it as a runtime-enforced binding; a successor body binds to it at its deployment)`;
    return {
      current: { version: FOGA_CELL_SPEC_VERSION, contentHash: current.contentHash, name: String((fogaCellSpecification() as { name: string }).name) },
      account: { specId: cfg.safety.specId ?? null, version: cfg.safety.version, contentHash: cfg.safety.contentHash ?? null, bindingId: cfg.bindingId ?? null, state: presented ? BindingStateName[presented.state] ?? String(presented.state) : null, enforcement: enforcementNames(cfg.safety.version >= 2 ? Enforcement.account | Enforcement.contract | Enforcement.runtime : Enforcement.account | Enforcement.contract) },
      adopted: adoptedFact ? { ...adoptedFact, state: adoptedBinding ? BindingStateName[adoptedBinding.state] ?? String(adoptedBinding.state) : null, enforcement: enforcementNames(adoptedFact.enforcement) } : null,
      verdict,
      operatesUnder,
      meaning,
    };
  },
};

export const spec_adopt: ActCapability = {
  name: "spec_adopt",
  title: "Adopt the current cell specification (FOGA-Cell-v2) as a runtime-enforced binding",
  description: "For a cell born before this build's specification version: the owner publishes the version under the owner's specification when it is missing (the owner is its publisher), then adopts a second binding to it through the account — adopter the account, enforcement `runtime` (the node honours the clauses; the account keeps enforcing version 1's through the binding it presents, since its requirement was fixed at deployment). Nothing is presented to the account, so nothing stops. Refused for a cell bound to the current version at birth, or that adopted it already; a one-key cell's owner pairs are opened first when missing.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8468],
  input: z.object({ jobId: zJobId }),
  output: z.object({ specId: z.string(), version: z.number(), contentHash: z.string(), bindingId: z.string(), enforcement: z.array(z.string()), published: z.boolean(), scopeOpened: z.array(z.string()), txHashes: z.array(z.string()), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const cell = node.body;
    const account = getAddress(cell.address);
    const cfg = node.config.identity;
    const gates: Gate[] = [];
    const version = FOGA_CELL_SPEC_VERSION;
    const document = fogaCellSpecification(version as 1 | 2);
    const commitment = k.asf.specificationCommitment(document);
    const specId = cfg.safety.specId;
    if (!specId) gates.push(refused("policy", "the configuration names no specification (identity.safety.specId): the cell was not born by foga cell init"));
    if (cfg.safety.version >= version) gates.push(refused("policy", `the account is bound to version ${cfg.safety.version} already (at birth); nothing to adopt`));
    if (cfg.adopted && cfg.adopted.version >= version) gates.push(refused("policy", `version ${cfg.adopted.version} is adopted already (binding ${cfg.adopted.bindingId})`));
    let publish = false;
    if (specId) {
      const publisher = await k.asf.specs().publisherOf(specId).catch(() => null);
      if (!publisher || getAddress(String(publisher)) !== getAddress(cfg.owner)) gates.push(refused("policy", `the specification ${specId} is published by ${publisher ?? "nobody"}, not by this cell's owner ${cfg.owner}; only its publisher can add version ${version}. Name a specification of the owner's in identity.safety, or publish the version there first.`));
      else {
        const got = await k.asf.versionOf(specId, version).catch(() => null);
        if (got && got.contentHash.toLowerCase() !== commitment.contentHash.toLowerCase()) gates.push(refused("policy", `version ${version} of ${specId} is published with contentHash ${got.contentHash}; this build's FOGA-Cell-v${version} hashes to ${commitment.contentHash}`));
        publish = !got;
      }
    }
    const accountVersion = await node.accountVersion();
    if (accountVersion < 2) gates.push(refused("policy", `the account is a revision-${accountVersion} FogaCellAccount (no operator allow-list); migrate first`));
    const scope = oneKey(node) ? mergeScope(operatorScope(k, []), ownerExecuteScope(k)) : operatorScope(k, []);
    const missing: number[] = accountVersion >= 2 && scope.targets.length ? await missingOf(node, scope) : [];
    if (!gates.some((g) => !g.ok)) gates.push(ok("policy", `${publish ? `publish version ${version} of ${specId} (the owner is its publisher), then ` : ""}adopt version ${version} (${commitment.contentHash.slice(0, 10)}…) through the account as a runtime-enforced binding; ${missing.length ? `${missing.length} allow-list pair(s) to open first` : "allow-list open"}`));
    const jobId = input.jobId ?? derivedJobId("spec-adopt", { account, specId, version });
    const enforcement = Enforcement.runtime;
    const chainId = node.chainId;
    const params = { profile: cellProfile(version), cell: node.config.name, adoptedBy: "spec_adopt", presentedToAccount: false, accountEnforces: cfg.safety.version, note: "the account's requirement was fixed at its deployment to an earlier version; this binding is the runtime's" };
    const authority = { kind: "owner", owner: accountRef(chainId, cfg.owner), guardian: accountRef(chainId, cfg.guardian) };
    const bindingInput = specId ? k.asf.cellBindingInput({ chainId, cell: account, specId, version, contentHash: commitment.contentHash, guardian: cfg.guardian, params, authority, enforcement, salt: keccakJcs({ adopt: cellProfile(version), cell: account.toLowerCase() }) }) : null;
    const steps: ActStep[] = [];
    if (missing.length) steps.push({ name: "scope", kind: "plain", by: "owner", route: "direct", build: () => ({ target: cell.address, value: 0n, data: cell.iface.encodeFunctionData("setOperatorAllowedBatch", [missing.map((i) => scope.targets[i]), missing.map((i) => scope.selectors[i]), true]), label: `setOperatorAllowedBatch(${missing.map((i) => scope.names[i]).join(", ")})` }) });
    if (publish && specId) steps.push({ name: "publish", kind: "plain", by: "owner", route: "direct", build: () => ({ target: k.asf.specRegistryAddress, value: 0n, data: k.asf.specs().interface.encodeFunctionData("publishVersion", [specId, commitment.contentHash, commitment.locator, []]), label: `publishVersion(${specId.slice(0, 10)}…, ${version})` }) });
    if (bindingInput) steps.push({ name: "adopt", kind: "plain", by: "owner", route: "execute", build: () => ({ target: k.asf.bindingRegistryAddress, value: 0n, data: k.asf.encodeAdopt(bindingInput), label: `adopt(FOGA-Cell-v${version}, runtime)` }) });
    return {
      job: { id: jobId, kind: "admin", input: { adopt: account, specId, version, contentHash: commitment.contentHash, publish } },
      gates,
      valueWei: 0n,
      gasPerStep: 600_000n,
      steps,
      output: async (confirmed) => {
        // a dry run confirms nothing: what the adoption would be, and the configuration as it was
        if (!confirmed.length) return { specId: specId!, version, contentHash: commitment.contentHash, bindingId: "0x" + "00".repeat(32), enforcement: enforcementNames(enforcement), published: publish, scopeOpened: missing.map((i) => scope.names[i]), txHashes: [], jobId };
        const adopt = confirmed.find((c) => c.key.endsWith(":adopt"))!;
        const bindingId = k.asf.bindingIdFromReceipt(adopt.receipt);
        node.config.identity.adopted = { specId: specId!, version, contentHash: commitment.contentHash, bindingId, enforcement, adoptedAt: new Date().toISOString() };
        node.saveConfig();
        if (missing.length) {
          const had = node.store.getFact<{ groups: string[]; entries: string[] }>("extend.scope");
          node.store.setFact("extend.scope", { groups: [...(had?.groups ?? [])], entries: [...new Set([...(had?.entries ?? []), ...missing.map((i) => scope.names[i])])] });
        }
        return { specId: specId!, version, contentHash: commitment.contentHash, bindingId, enforcement: enforcementNames(enforcement), published: publish, scopeOpened: missing.map((i) => scope.names[i]), txHashes: confirmed.map((c) => c.txHash), jobId };
      },
    };
  },
};

export const SPECIFICATION_CAPABILITIES = [spec_status, spec_adopt];

import { Contract, type Provider, type Signer } from "ethers";
import { AIFP, AIFP_CORE, Flows, ZERO32, type BindingDecl } from "../core/aifp.js";
import { dataUriJcs } from "../core/canonical.js";
import { TENDER_MARKET, descriptorUri, fogaParadigms, marketTransportBinding, type FogaParadigm, type WorldFlows } from "../core/paradigms.js";
import { World } from "../core/world.js";
import type { Bundle } from "../bundle/types.js";
import type { WorldFile } from "./types.js";

/**
 * The maintainer's one-time act on a world (ERC-8489, docs/flows.md): register FOGA's two paradigms in the family
 * `foga` and open the default market channel with the TaskToken's events as its transport. `foga world deploy` does
 * it with the deployer's key on a world it deploys (the deployer becomes the family's controller and the market's
 * authority); on a public world the reference cell does the same through its account (`flow_bootstrap`), and what
 * either records in the world file — the paradigm ids and the market channel id — is what every cell reads. A paradigm
 * already registered is left as it is (the same descriptor is the same id); a market already recorded is kept.
 */
export interface FlowsBootstrapPlan {
  paradigms: FogaParadigm[];
  market: { paradigm: FogaParadigm; metadataURI: string; bindings: BindingDecl[] };
}

/** The market channel's metadata document: what the channel is, for anyone who reads the registry. */
export function marketMetadata(world: Pick<World, "chainId" | "address">, authority: string): Record<string, unknown> {
  return {
    schema: "foga.flow-channel/1",
    paradigm: TENDER_MARKET,
    purpose: "the public tender market of this FOGA world: ERC-8414 tenders minted on the TaskToken, taken by cells admitted as SUBMIT, settled by the acceptance authority",
    chainId: world.chainId,
    taskToken: world.address("8414/TaskToken"),
    authority,
    note: "the default market a cell's configuration names; any cell may open or join another",
  };
}

export function flowsBootstrapPlan(world: World, authority: string, publicUrl: string | null = null): FlowsBootstrapPlan {
  const paradigms = fogaParadigms(world);
  const market = paradigms.find((p) => p.name === TENDER_MARKET)!;
  return {
    paradigms: paradigms.map((p) => ({ ...p })),
    market: { paradigm: market, metadataURI: publicUrl ? `${publicUrl.replace(/\/+$/, "")}/documents/flows/market.json` : dataUriJcs(marketMetadata(world, authority)), bindings: [marketTransportBinding(world)] },
  };
}

/** Whether the world file has every ERC-8489 contract the flows need (the core registries plus the identity verifier for the market). */
export function worldHasFlowContracts(world: WorldFile): boolean {
  return [...AIFP_CORE, AIFP.identityVerifier].every((id) => Boolean(world.contracts[id]));
}

export interface BootstrapOptions {
  worldFile: WorldFile;
  bundle: Bundle;
  provider: Provider;
  /** The maintainer's signer (an EOA): the family controller and the market authority. */
  signer: Signer;
  publicUrl?: string | null;
  say?: (line: string) => void;
}

/** Register the paradigms that are not registered yet and open the market; returns the flows block written into the world file. */
export async function bootstrapFlowsAsSigner(o: BootstrapOptions): Promise<WorldFlows> {
  const say = o.say ?? (() => {});
  const world = new World(o.worldFile, o.bundle, o.provider);
  const flows = new Flows(world);
  const authority = await o.signer.getAddress();
  const plan = flowsBootstrapPlan(world, authority, o.publicUrl ?? null);
  const have = o.worldFile.flows;
  const out: WorldFlows = {
    family: plan.paradigms[0].bundle.family,
    familyId: plan.paradigms[0].bundle.familyId,
    controller: have?.controller ?? authority,
    paradigms: { ...(have?.paradigms ?? {}) },
    market: have?.market ?? null,
    note: "ERC-8489 flows of this world: FOGA's paradigms in the family foga and the default market channel; a cell's configuration may name another market",
  };
  const registry = new Contract(flows.addressOf(AIFP.paradigms), world.abi(AIFP.paradigms), o.signer);
  for (const p of plan.paradigms) {
    const id = p.bundle.paradigmId;
    if (await flows.paradigmExists(id)) {
      say(`${p.name}: registered already as ${id}`);
      out.paradigms[p.name] = { paradigmId: id, descriptorURI: out.paradigms[p.name]?.descriptorURI ?? (await flows.paradigm(id)).descriptorURI, txHash: out.paradigms[p.name]?.txHash };
      continue;
    }
    const uri = descriptorUri(p.name, p.descriptor, o.publicUrl ?? null);
    const canonicalHex = "0x" + Buffer.from(p.bundle.canonical, "utf8").toString("hex");
    const tx = await registry.registerParadigm(canonicalHex, p.bundle.familyId, ZERO32, p.bundle.labelIds.map((l) => l.id), p.bundle.rolePredicates.map((r) => [r.roleBit, r.predicateHash]), uri);
    const receipt = await tx.wait();
    out.paradigms[p.name] = { paradigmId: id, descriptorURI: uri, txHash: receipt.hash };
    say(`${p.name}: registered as ${id} (labels ${p.bundle.labels.join(", ") || "none"}; ${p.bundle.rolePredicates.map((r) => r.role).join(", ")} predicated) in ${receipt.hash}`);
  }
  if (!out.market) {
    const channels = new Contract(flows.addressOf(AIFP.channels), world.abi(AIFP.channels), o.signer);
    const m = plan.market;
    const tx = await channels.openChannel(m.paradigm.bundle.paradigmId, authority, ZERO32, m.metadataURI, m.bindings.map((b) => [b.kind, b.target, b.version, b.capabilities, b.effectScope, b.adoptionMode, b.authorizationRef, true]));
    const receipt = await tx.wait();
    const channelId = flows.channelIdFromReceipt(receipt);
    out.market = { channelId, paradigm: TENDER_MARKET, paradigmId: m.paradigm.bundle.paradigmId, authority, txHash: receipt.hash, bindingIds: flows.bindingIdsFromReceipt(receipt) };
    say(`${TENDER_MARKET}: market channel ${channelId} opened with authority ${authority} (transport: the TaskToken's events) in ${receipt.hash}`);
  } else say(`market channel ${out.market.channelId} recorded already`);
  return out;
}

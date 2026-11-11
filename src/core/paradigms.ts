import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress } from "ethers";
import { AIFP, capabilityNames, descriptorBundle, transportBinding, type BindingDecl, type DescriptorBundle } from "./aifp.js";
import { dataUriJcs } from "./canonical.js";
import { repoRoot } from "../util/fs.js";
import type { World } from "./world.js";

/**
 * FOGA's own paradigms (ERC-8489, docs/flows.md): the two information-flow contexts every cell is part of, written as
 * descriptors in `scenarios/flows/` and registered once per world in the family `foga` by the world's maintainer —
 * the deployer of a local world, the reference cell's account on Sepolia.
 *
 *   foga:cell-source/v1    the cell's self-description: one publisher (the cell), open observation, a pulled and
 *                          immutable archive of what it said about itself (labels source + archive); the SUBMIT role is
 *                          the authority's to grant (the cell grants itself), REDISTRIBUTE is open
 *   foga:tender-market/v1  the world's public tender market: demanders mint, cells submit, every submission is public on
 *                          chain, the acceptance authority settles (no reserved label: submissions are public, so it
 *                          is not an intake; the verifier's choice is not a select); SUBMIT and RESPOND are acquired by
 *                          the `identity` predicate — an ERC-8004 identity owned by the subject's account and an ACTIVE
 *                          ERC-8434 anchor, judged by the world's FogaIdentityVerifier — so the descriptor, and with it
 *                          the paradigm id, is particular to the world whose registries it names
 *
 * The transport the market declares is the TaskToken's own events: identity (msg.sender), push, history and late-join
 * history (the chain keeps them), total order (block order); not delivery records, since an event proves nothing about
 * who received it.
 */
export const FLOWS_FAMILY = "foga";
export const CELL_SOURCE = "foga:cell-source/v1";
export const TENDER_MARKET = "foga:tender-market/v1";
export const FOGA_PARADIGMS = [CELL_SOURCE, TENDER_MARKET] as const;
export type FogaParadigmName = (typeof FOGA_PARADIGMS)[number];

const FILES: Record<FogaParadigmName, string> = { [CELL_SOURCE]: "cell-source.v1.json", [TENDER_MARKET]: "tender-market.v1.json" };

export function paradigmFile(name: FogaParadigmName): string {
  return join(repoRoot(), "scenarios", "flows", FILES[name]);
}

/** The descriptor's file name alone (`cell-source.v1.json`), for a copy served beside the cell's documents. */
export function paradigmFileName(name: FogaParadigmName): string {
  return FILES[name];
}

/** The descriptor as shipped, with `${<world contract id>}` placeholders filled from the world's address book (lowercase). */
export function fogaDescriptor(name: FogaParadigmName, world: Pick<World, "address" | "has">): Record<string, unknown> {
  const text = readFileSync(paradigmFile(name), "utf8");
  const filled = text.replace(/\$\{([^}]+)\}/g, (_m, id: string) => {
    if (!world.has(id)) throw new Error(`${name}: the world has no ${id}, which the descriptor's predicates name`);
    return getAddress(world.address(id)).toLowerCase();
  });
  return JSON.parse(filled) as Record<string, unknown>;
}

/** The descriptor of a paradigm that names no world contract (the cell-source paradigm): the same on every world. */
export function fogaDescriptorStatic(name: FogaParadigmName): Record<string, unknown> {
  const text = readFileSync(paradigmFile(name), "utf8");
  if (/\$\{/.test(text)) throw new Error(`${name} names world contracts; use fogaDescriptor(name, world)`);
  return JSON.parse(text) as Record<string, unknown>;
}

export interface FogaParadigm {
  name: FogaParadigmName;
  descriptor: Record<string, unknown>;
  bundle: DescriptorBundle;
}

/** Both paradigms, validated, for a world (the market needs the identity verifier and the ERC-8004 registry). */
export function fogaParadigms(world: Pick<World, "address" | "has">): FogaParadigm[] {
  return FOGA_PARADIGMS.map((name) => {
    const descriptor = fogaDescriptor(name, world);
    return { name, descriptor, bundle: descriptorBundle(descriptor, name) };
  });
}

export function fogaParadigm(name: FogaParadigmName, world: Pick<World, "address" | "has">): FogaParadigm {
  const descriptor = fogaDescriptor(name, world);
  return { name, descriptor, bundle: descriptorBundle(descriptor, name) };
}

/** The descriptor locator a registration carries: the maintainer's served copy when it has a public URL, the document itself otherwise. */
export function descriptorUri(name: FogaParadigmName, descriptor: unknown, publicUrl: string | null): string {
  const base = publicUrl?.replace(/\/+$/, "");
  return base ? `${base}/documents/flows/paradigms/${FILES[name]}` : dataUriJcs(descriptor);
}

/** The market's transport binding: the TaskToken's events as the delivery of tenders and submissions. */
export function marketTransportBinding(world: Pick<World, "address" | "chainId">): BindingDecl {
  return transportBinding(`eip155:${world.chainId}:${getAddress(world.address("8414/TaskToken")).toLowerCase()}#events`, "erc8414/TaskToken events", ["identity", "push", "history-retention", "late-join-history", "total-order"]);
}

/** A world file's record of the flows its maintainer bootstrapped (worlds/*.json, deployments/*.json). */
export interface WorldFlows {
  family: string;
  familyId: string;
  /** The family's controller: whoever registered the paradigms (the deployer of a local world; the reference cell's account on Sepolia). */
  controller: string;
  paradigms: Record<string, { paradigmId: string; descriptorURI: string; txHash?: string }>;
  /** The default market channel, which a cell's configuration may replace (flows.market.channelId); null when none was opened. */
  market: { channelId: string; paradigm: string; paradigmId: string; authority: string; txHash?: string; bindingIds: string[] } | null;
  note?: string;
}

/** The capability names of a mask, for the record. */
export function describeCapabilities(mask: number): string {
  return capabilityNames(mask).join("|") || "none";
}

export { AIFP };

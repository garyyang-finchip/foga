import { keccak256, toUtf8Bytes, type Contract, type ContractRunner } from "ethers";
import { abi, accountRef, dataUri, jcs, sha256Hex } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/** ERC-8444 ARD Onchain: how cells, skills and tasks are found. */
export const ARDStatus = { None: 0, Active: 1, Suspended: 2, Retired: 3 } as const;

export function kindId(name: "skill" | "task" | "agent" | "registry"): string {
  return keccak256(toUtf8Bytes(`ard-onchain.kind.${name}`));
}

const PUBLICATION_MEMBERS = ["@context", "@id", "identifier", "trustManifest"];
const RESOLVED_MEMBERS = ["value:anchor", "value:adopted", "value:binding", "value:level", "value:status", "value:aliases", "value:canonical", "value:registry", "value:descriptorHash", "value:stale", "value:claimedUrn"];

/** The authored (content) members of a descriptor: publication and resolver-computed members removed. */
export function authoredDescriptor(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) {
    if (PUBLICATION_MEMBERS.includes(k) || RESOLVED_MEMBERS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

/** descriptorHash = SHA-256(JCS(authored descriptor)). */
export function descriptorHash(entry: Record<string, unknown>): { canonical: string; hex: string; digest: string } {
  const canonical = jcs(authoredDescriptor(entry));
  const hex = sha256Hex(canonical);
  return { canonical, hex, digest: `sha256:${hex.slice(2)}` };
}

export function recordIdOf(chainId: number | bigint, target: string, id: bigint): string {
  return keccak256(abi.encode(["uint256", "address", "uint256"], [chainId, target, id]));
}

export interface ARDRecord {
  kind: string;
  target: string;
  id: bigint;
  descriptorHash: string;
  descriptorURI: string;
  urn: string;
  status: number;
  attestor: string;
  updatedAt: bigint;
}

const CONTEXT = ["https://agenticresourcediscovery.org/context/v1", { value: "https://eips.ethereum.org/assets/eip-8444/ns#" }];

export function agentDescriptor(p: { chainId: number; anchor: string; name: string; description: string; url?: string; tags?: string[]; capabilities?: string[]; registration?: Record<string, unknown>; settlement?: unknown[]; credit?: unknown[]; domain?: string; slug: string }): Record<string, unknown> {
  return {
    "@context": CONTEXT,
    identifier: `urn:air:${p.domain ?? "foga.local"}:agents:${p.slug}`,
    type: "application/a2a-agent-card+json",
    displayName: p.name,
    description: p.description,
    url: p.url ?? "",
    tags: p.tags ?? ["foga", "cell"],
    capabilities: p.capabilities ?? [],
    version: "1",
    trustManifest: { identity: p.domain ?? "foga.local" },
    "value:kind": "agent",
    "value:controller": `did:pkh:eip155:${p.chainId}:${p.anchor.toLowerCase()}`,
    ...(p.registration ? { "value:registration": p.registration } : {}),
    ...(p.settlement ? { "value:settlement": p.settlement } : {}),
    ...(p.credit ? { "value:credit": p.credit } : {}),
  };
}

export function skillDescriptor(p: { chainId: number; controller: string; name: string; description: string; packageHash: string; packageURI: string; price?: { amount: string; currency: string; asset: string }; payee?: string; domain?: string; slug: string; tags?: string[] }): Record<string, unknown> {
  return {
    "@context": CONTEXT,
    identifier: `urn:air:${p.domain ?? "foga.local"}:skills:${p.slug}`,
    type: "application/vnd.erc8338.skill+json",
    displayName: p.name,
    description: p.description,
    url: p.packageURI,
    tags: p.tags ?? ["foga", "skill"],
    version: "1",
    trustManifest: { identity: p.domain ?? "foga.local" },
    "value:kind": "skill",
    "value:controller": `did:pkh:eip155:${p.chainId}:${p.controller.toLowerCase()}`,
    "value:terms": { unit: "call", price: p.price ?? { amount: "0", currency: "ETH", asset: `eip155:${p.chainId}/slip44:60` } },
    "value:settlement": [{ rail: "onchain", payee: accountRef(p.chainId, p.payee ?? p.controller), asset: `eip155:${p.chainId}/slip44:60` }],
    "value:provenance": { packageDigest: `sha256:${p.packageHash.replace(/^0x/, "")}` },
  };
}

export function taskDescriptor(p: { chainId: number; demander: string; name: string; wants: string; taskHash: string; taskURI: string; bounty: { amount: string; currency: string; asset: string }; acceptance: { mode: "judge" | "verifier"; ref: string }; settleBy?: number; judgmentWindow: string; domain?: string; slug: string }): Record<string, unknown> {
  return {
    "@context": CONTEXT,
    identifier: `urn:air:${p.domain ?? "foga.local"}:tasks:${p.slug}`,
    type: "application/ai-task+json",
    displayName: p.name,
    description: p.wants,
    url: p.taskURI,
    tags: ["foga", "task"],
    version: "1",
    trustManifest: { identity: p.domain ?? "foga.local" },
    data: {
      wants: p.wants,
      specDigest: `sha256:${p.taskHash.replace(/^0x/, "")}`,
      specURI: p.taskURI,
      bounty: p.bounty,
      cardinality: "1-of-1",
      copies: 1,
      acceptance: p.acceptance,
      deadlines: { ...(p.settleBy ? { settleBy: new Date(p.settleBy * 1000).toISOString() } : {}), judgmentWindow: p.judgmentWindow },
    },
    "value:kind": "task",
    "value:controller": `did:pkh:eip155:${p.chainId}:${p.demander.toLowerCase()}`,
    "value:provenance": { packageDigest: `sha256:${p.taskHash.replace(/^0x/, "")}` },
  };
}

export class ARD {
  readonly address: string;
  constructor(readonly world: World) {
    this.address = world.address("8444/ARDOnchainRegistry");
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.contract("8444/ARDOnchainRegistry", runner);
  }

  /** Publication form: descriptorURI as a data: URI, descriptorHash over the authored members, urn = identifier. */
  publication(descriptor: Record<string, unknown>): { descriptorHash: string; descriptorURI: string; urn: string } {
    return { descriptorHash: descriptorHash(descriptor).hex, descriptorURI: dataUri(descriptor), urn: String(descriptor.identifier ?? "") };
  }

  encodeRegister(kind: string, target: string, id: bigint, descriptor: Record<string, unknown>): string {
    const p = this.publication(descriptor);
    return this.contract().interface.encodeFunctionData("register", [kind, target, id, p.descriptorHash, p.descriptorURI, p.urn]);
  }

  encodeUpdateDescriptor(recordId: string, descriptor: Record<string, unknown>): string {
    const p = this.publication(descriptor);
    return this.contract().interface.encodeFunctionData("updateDescriptor", [recordId, p.descriptorHash, p.descriptorURI, p.urn]);
  }

  async register(signer: ContractRunner, kind: string, target: string, id: bigint, descriptor: Record<string, unknown>): Promise<{ recordId: string; receipt: any }> {
    const p = this.publication(descriptor);
    const tx = await this.contract(signer).register(kind, target, id, p.descriptorHash, p.descriptorURI, p.urn);
    const receipt = await tx.wait();
    return { recordId: eventArgs(this.contract().interface, receipt, "Registered", this.address).recordId, receipt };
  }

  recordIdFromReceipt(receipt: any): string {
    return eventArgs(this.contract().interface, receipt, "Registered", this.address).recordId;
  }

  recordIdOf(target: string, id: bigint): string {
    return recordIdOf(this.world.chainId, target, id);
  }

  async recordOf(recordId: string): Promise<ARDRecord> {
    const r = await this.contract().recordOf(recordId);
    return { kind: r.kind, target: r.target, id: BigInt(r.id), descriptorHash: r.descriptorHash, descriptorURI: r.descriptorURI, urn: r.urn, status: Number(r.status), attestor: r.attestor, updatedAt: BigInt(r.updatedAt) };
  }

  async controllerOf(recordId: string): Promise<string> {
    return this.contract().controllerOf(recordId);
  }

  async backed(recordId: string): Promise<boolean> {
    return this.contract().backed(recordId);
  }

  async isAdopted(recordId: string): Promise<boolean> {
    const [rec, controller] = await Promise.all([this.recordOf(recordId), this.controllerOf(recordId)]);
    return controller !== "0x0000000000000000000000000000000000000000" && rec.attestor.toLowerCase() === controller.toLowerCase();
  }
}

import { keccak256, toUtf8Bytes, type Contract, type ContractRunner } from "ethers";
import { accountRef, dataUriJcs, jcs, keccakUtf8 } from "./canonical.js";
import type { World } from "./world.js";

/** ERC-8434 Agent Identity: the address-anchored identity and liveness of a cell. */
export const AIDState = { DORMANT: 0, ACTIVE: 1, STALE: 2, RETIRED: 3 } as const;
export const AIDStateName = ["DORMANT", "ACTIVE", "STALE", "RETIRED"] as const;

export function facetTypeKey(facetType: string): string {
  return keccak256(toUtf8Bytes(facetType));
}

export interface AIDFacet {
  facetType: string;
  provenance: "SELF" | "OBSERVED" | "ATTESTED" | "PROVED";
  issuer: string;
  validUntil: number;
  validFrom?: number;
  digest: string;
  access: { mode: "PUBLIC" | "GATED" | "ZK" };
  resolver: Record<string, unknown>;
  [k: string]: unknown;
}

export interface AIDDocument {
  version: "aid-document/v1";
  aid: string;
  did?: string;
  binding?: { registry: string; agentId: number | string };
  facets: AIDFacet[];
  livenessWindow?: number;
  updatedAt?: number;
  alsoKnownAs?: string[];
}

/**
 * A second ERC-8434 instance another standard's adapter reads. On Sepolia the ERC-8444 agent kind is anchored to
 * ARD's own fixture AIDRegistry, not to aid-standard's reference instance (docs/version-lock.md, seam 1); a cell
 * whose records must resolve as backed keeps its liveness in both. The world file names it under this id.
 */
export const BACKING_REGISTRY_ID = "8434/AIDRegistry(ard-fixture)";

export class AID {
  readonly address: string;
  /** The backing registry, when the world has one at another address than the primary registry. */
  readonly backing: { id: string; address: string } | null;
  constructor(readonly world: World) {
    this.address = world.address("8434/AIDRegistry");
    const backing = world.has(BACKING_REGISTRY_ID) ? world.address(BACKING_REGISTRY_ID) : null;
    this.backing = backing && backing.toLowerCase() !== this.address.toLowerCase() ? { id: BACKING_REGISTRY_ID, address: backing } : null;
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.contract("8434/AIDRegistry", runner);
  }

  /** The same ABI at another registry address (the backing registry). */
  at(address: string, runner?: ContractRunner): Contract {
    return this.world.at("aid-standard:AIDRegistry", address, runner);
  }

  encodeBind(identityRegistry: string, agentId: bigint): string {
    return this.contract().interface.encodeFunctionData("bind", [identityRegistry, agentId]);
  }

  encodeHeartbeat(): string {
    return this.contract().interface.encodeFunctionData("heartbeat", []);
  }

  encodeSetDocumentURI(uri: string, digest: string): string {
    return this.contract().interface.encodeFunctionData("setDocumentURI", [uri, digest]);
  }

  encodeSetFacet(facetType: string, digest: string, validFrom: number, validUntil: number, access: number, uri: string): string {
    return this.contract().interface.encodeFunctionData("setFacet", [facetTypeKey(facetType), digest, validFrom, validUntil, access, uri]);
  }

  encodeRetire(successor: string): string {
    return this.contract().interface.encodeFunctionData("retire", [successor]);
  }

  /** `window` in seconds, at most the registry's maximum; 0 restores the registry's default. */
  encodeSetLivenessWindow(window: number): string {
    return this.contract().interface.encodeFunctionData("setLivenessWindow", [window]);
  }

  async state(anchor: string, registry = this.address): Promise<number> {
    return Number(await this.at(registry).state(anchor));
  }

  async stateName(anchor: string, registry = this.address): Promise<string> {
    return AIDStateName[await this.state(anchor, registry)];
  }

  async livenessWindow(anchor: string): Promise<number> {
    return Number(await this.contract().livenessWindow(anchor));
  }

  async defaultLivenessWindow(): Promise<number> {
    return Number(await this.contract().defaultLivenessWindow());
  }

  async bindingOf(anchor: string): Promise<{ registry: string; agentId: bigint; boundAt: bigint }> {
    const b = await this.contract().bindingOf(anchor);
    return { registry: b.registry, agentId: BigInt(b.agentId), boundAt: BigInt(b.boundAt) };
  }

  async documentURI(anchor: string): Promise<{ uri: string; digest: string }> {
    const r = await this.contract().documentURI(anchor);
    return { uri: r.uri ?? r[0], digest: r.digest ?? r[1] };
  }

  async lastSeen(anchor: string): Promise<bigint> {
    return BigInt(await this.contract().lastSeen(anchor));
  }

  /** The AID document and its on-chain commitment: keccak256(UTF-8(JCS(document))). */
  static documentCommitment(doc: AIDDocument): { jcs: string; digest: string; uri: string } {
    const canonical = jcs(doc);
    return { jcs: canonical, digest: keccakUtf8(canonical), uri: dataUriJcs(doc) };
  }

  static aidOf(chainId: number | bigint, anchor: string): string {
    return accountRef(chainId, anchor);
  }
}

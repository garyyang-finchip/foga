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

export class AID {
  readonly address: string;
  constructor(readonly world: World) {
    this.address = world.address("8434/AIDRegistry");
  }

  contract(runner?: ContractRunner): Contract {
    return this.world.contract("8434/AIDRegistry", runner);
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

  async state(anchor: string): Promise<number> {
    return Number(await this.contract().state(anchor));
  }

  async stateName(anchor: string): Promise<string> {
    return AIDStateName[await this.state(anchor)];
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

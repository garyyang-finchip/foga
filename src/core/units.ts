import { concat, keccak256, toUtf8Bytes, type Contract, type ContractRunner } from "ethers";
import { accountRef, dataUriJcs, erc721Ref, jcs, keccakUtf8 } from "./canonical.js";
import { eventArgs, type World } from "./world.js";

/** ERC-8454 AIFi Unit Framework: the economic boundary of a cell, a skill or a swarm. */
export interface UnitRef {
  unitId: bigint;
  version: number;
}

export function elementId(kind: string, ref: string): string {
  return keccak256(concat([toUtf8Bytes(kind), new Uint8Array([0x3a]), toUtf8Bytes(ref)]));
}

export function unitRefString(chainId: number | bigint, registry: string, unitId: bigint, version: number): string {
  return `auf:eip155:${chainId}:${registry.toLowerCase()}:${unitId}@${version}`;
}

export interface UnitElement {
  kind: string;
  ref: string;
  label?: string;
  controller?: string;
  expectedAcks?: string[];
}

export interface UnitDefinition {
  auf: "1.0";
  kind: "unit-definition";
  unit: { name: string; summary?: string; tags?: string[] };
  elements: UnitElement[];
  relations: Record<string, unknown>[];
  ports: Record<string, unknown>[];
  authorities: { definitionController: string; settlementAccounts?: string[]; representatives?: unknown[]; notes?: string };
  validity?: { from?: string; until?: string };
  scale?: { window: string };
}

/** The unit of a single cell: the agent element, its treasury position and the deliverable/funds ports. */
export function cellUnitDefinition(p: { chainId: number; cell: string; name: string; summary?: string }): UnitDefinition {
  const agent: UnitElement = { kind: "agent", ref: accountRef(p.chainId, p.cell), label: `${p.name} (cell account)` };
  const treasury: UnitElement = { kind: "financial-position", ref: accountRef(p.chainId, p.cell), label: "cell account balance" };
  return {
    auf: "1.0",
    kind: "unit-definition",
    unit: { name: p.name, summary: p.summary ?? "A FOGA cell: one address acting under the ten-ERC stack", tags: ["foga", "cell"] },
    elements: [agent, treasury],
    relations: [
      { type: "owns", from: "unit", to: elementId(agent.kind, agent.ref), exclusive: true, share: "1", basis: ["erc8434:anchor"] },
      { type: "holds", from: "unit", to: elementId(treasury.kind, treasury.ref), quantity: { amount: "0", unit: "ETH" }, scope: "native balance of the cell account" },
    ],
    ports: [
      { id: "deliverable-out", direction: "out", class: "deliverable", template: "auf:port:deliverable-out@1", conditions: "accepted fulfillments on ERC-8414 tenders" },
      { id: "funds-in", direction: "in", class: "funds", template: "auf:port:funds-in@1", asset: `eip155:${p.chainId}/slip44:60`, account: accountRef(p.chainId, p.cell), conditions: "tender rewards and service fees" },
      { id: "funds-out", direction: "out", class: "funds", template: "auf:port:funds-out@1", asset: `eip155:${p.chainId}/slip44:60`, account: accountRef(p.chainId, p.cell), conditions: "gas and purchased services" },
    ],
    authorities: { definitionController: accountRef(p.chainId, p.cell), settlementAccounts: [accountRef(p.chainId, p.cell)] },
  };
}

/** The unit of a skill token held by a cell: a source element the cell licenses out. */
export function skillUnitDefinition(p: { chainId: number; skillToken: string; tokenId: bigint; holder: string; name: string; summary?: string }): UnitDefinition {
  const skill: UnitElement = { kind: "skill", ref: erc721Ref(p.chainId, p.skillToken, p.tokenId), label: p.name };
  return {
    auf: "1.0",
    kind: "unit-definition",
    unit: { name: p.name, summary: p.summary ?? "An ERC-8338 skill package as an economic source", tags: ["foga", "skill", "source"] },
    elements: [skill],
    relations: [{ type: "owns", from: "unit", to: elementId(skill.kind, skill.ref), exclusive: true, share: "1", basis: ["erc8338:owner"] }],
    ports: [
      { id: "calls-out", direction: "out", class: "deliverable", template: "auf:port:deliverable-out@1", conditions: "executions of the skill" },
      { id: "fees-in", direction: "in", class: "funds", template: "auf:port:funds-in@1", asset: `eip155:${p.chainId}/slip44:60`, account: accountRef(p.chainId, p.holder), conditions: "per-call fees and tender rewards earned with the skill" },
    ],
    authorities: { definitionController: accountRef(p.chainId, p.holder), settlementAccounts: [accountRef(p.chainId, p.holder)] },
  };
}

export class Units {
  constructor(readonly world: World) {}

  registry(runner?: ContractRunner): Contract {
    return this.world.contract("8454/AUFUnitRegistry", runner);
  }

  get registryAddress(): string {
    return this.world.address("8454/AUFUnitRegistry");
  }

  boundaryHash(def: UnitDefinition): string {
    return keccakUtf8(jcs(def));
  }

  encodeRegisterUnit(controller: string, def: UnitDefinition, contains: UnitRef[] = []): string {
    return this.registry().interface.encodeFunctionData("registerUnit", [controller, this.boundaryHash(def), dataUriJcs(def), contains.map((c) => [c.unitId, c.version])]);
  }

  async registerUnit(signer: ContractRunner, controller: string, def: UnitDefinition, contains: UnitRef[] = []): Promise<{ unitId: bigint; receipt: any }> {
    const planned = (await this.unitCount()) + 1n;
    const tx = await this.registry(signer).registerUnit(controller, this.boundaryHash(def), dataUriJcs(def), contains.map((c) => [c.unitId, c.version]));
    const receipt = await tx.wait();
    return { unitId: planned, receipt };
  }

  unitIdFromReceipt(receipt: any): bigint {
    return BigInt(eventArgs(this.registry().interface, receipt, "UnitRegistered", this.registryAddress).unitId);
  }

  async unitCount(): Promise<bigint> {
    return BigInt(await this.registry().unitCount());
  }

  async controllerOf(unitId: bigint): Promise<string> {
    return this.registry().controllerOf(unitId);
  }

  async latestVersion(unitId: bigint): Promise<number> {
    return Number(await this.registry().latestVersion(unitId));
  }

  async versionOf(unitId: bigint, version: number): Promise<{ boundaryHash: string; descriptorURI: string }> {
    const v = await this.registry().versionOf(unitId, version);
    return { boundaryHash: v.boundaryHash ?? v[0], descriptorURI: v.descriptorURI ?? v[1] };
  }
}

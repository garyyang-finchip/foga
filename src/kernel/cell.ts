import { Contract, Interface, type ContractRunner } from "ethers";
import { ReasonName, VerdictName, type BindingInput, type RequirementSet } from "../core/asf.js";
import type { Kernel } from "./kernel.js";
import type { OpBinding } from "./store.js";
import type { Confirmed } from "./tx.js";

export interface CellRoles {
  /** Signer names in the kernel. */
  owner: string;
  operator: string;
  /** Addresses. */
  guardian: string;
  recovery?: string;
}

export interface CellStatus {
  verdict: number;
  verdictName: string;
  reasons: number[];
  reasonNames: string[];
  restrictions: number[];
}

/**
 * A cell as the kernel drives it: one FogaCellAccount, the owner key for administration and the operator key for
 * acting. Every act of the cell is an `execute` through the account, keyed for the operation store.
 */
export class Cell {
  readonly iface: Interface;

  constructor(
    readonly kernel: Kernel,
    readonly name: string,
    readonly address: string,
    readonly roles: CellRoles,
  ) {
    this.iface = kernel.world.ifaceOf("foga:FogaCellAccount");
  }

  /**
   * Deploy the account from the owner key. The requirement may name the account itself (as adopter / subject),
   * so it is built from the address predicted for the deployment nonce and checked against the receipt.
   */
  static async deploy(kernel: Kernel, p: { key: string; name: string; roles: CellRoles; requirement: (predicted: string) => RequirementSet }): Promise<Cell> {
    const safety = kernel.asf.bindingRegistryAddress;
    const owner = kernel.address(p.roles.owner);
    const operator = kernel.address(p.roles.operator);
    const recovery = p.roles.recovery ?? owner;
    let predictedFor: string | null = null;
    const { address } = await kernel.deploy(p.key, p.roles.owner, "foga:FogaCellAccount", [], (predicted) => {
      predictedFor = predicted;
      return [safety, owner, operator, p.roles.guardian, recovery, p.requirement(predicted)];
    });
    if (predictedFor && (predictedFor as string).toLowerCase() !== address.toLowerCase()) {
      throw new Error(`cell ${p.name}: deployed at ${address} but the requirement was built for ${predictedFor}; the deployer's nonce moved between prediction and inclusion`);
    }
    return new Cell(kernel, p.name, address, p.roles);
  }

  contract(runner?: ContractRunner): Contract {
    return new Contract(this.address, this.iface, runner ?? this.kernel.world.provider);
  }

  // ---------------------------------------------------------------------------- acting

  /** The calldata of `execute(target, value, data)` on this account. */
  encodeExecute(target: string, value: bigint, data: string): string {
    return this.iface.encodeFunctionData("execute", [target, value, data]);
  }

  /** Act as the cell: `execute(target, value, data)` signed by the operator (default) or the owner; `binding` ties the operation to the request that asked for it (the node). */
  async execute(key: string, target: string, data: string, opts: { value?: bigint; by?: "operator" | "owner"; binding?: OpBinding } = {}): Promise<Confirmed> {
    const signer = opts.by === "owner" ? this.roles.owner : this.roles.operator;
    return this.kernel.tx.send({
      key,
      signer,
      kind: "execute",
      binding: opts.binding,
      build: () => ({ to: this.address, data: this.encodeExecute(target, opts.value ?? 0n, data) }),
    });
  }

  /** Owner administration (setOperator, setAIDRegistry, setCommitmentClass, setDeriskAllowed, ...). */
  async admin(key: string, fn: string, args: unknown[], binding?: OpBinding): Promise<Confirmed> {
    return this.kernel.tx.send({
      key,
      signer: this.roles.owner,
      kind: "admin",
      binding,
      build: () => ({ to: this.address, data: this.iface.encodeFunctionData(fn, args) }),
    });
  }

  /** Adopt a safety binding as the account and present it for a clause (owner-level bootstrap). */
  async adoptBinding(key: string, input: BindingInput, clauseIndex = 0): Promise<{ bindingId: string; confirmed: Confirmed }> {
    const confirmed = await this.admin(key, "adoptBinding", [input, clauseIndex]);
    const bindingId: string = this.kernel.event(confirmed.receipt, this.iface, "BindingAdopted", this.address).bindingId;
    return { bindingId, confirmed };
  }

  // ---------------------------------------------------------------------------- views

  async status(): Promise<CellStatus> {
    const r = await this.contract().status();
    const reasons = Array.from(r[1], (x: any) => Number(x));
    return {
      verdict: Number(r[0]),
      verdictName: VerdictName[Number(r[0])] ?? String(r[0]),
      reasons,
      reasonNames: reasons.map((x) => ReasonName[x] ?? String(x)),
      restrictions: Array.from(r[2], (x: any) => Number(x)),
    };
  }

  async presentedBindings(): Promise<string[]> {
    return Array.from(await this.contract().presentedBindings(), String);
  }

  async owner(): Promise<string> {
    return this.contract().owner();
  }

  async operator(): Promise<string> {
    return this.contract().operator();
  }

  async balance(): Promise<bigint> {
    return this.kernel.balance(this.address);
  }

  get operatorAddress(): string {
    return this.kernel.address(this.roles.operator);
  }

  get ownerAddress(): string {
    return this.kernel.address(this.roles.owner);
  }
}

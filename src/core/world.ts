import { Contract, Interface, JsonRpcProvider, type ContractRunner, type Provider, type Signer } from "ethers";
import { loadBundle } from "../bundle/load.js";
import type { Bundle, BundleContract } from "../bundle/types.js";
import { readJson } from "../util/fs.js";
import type { WorldFile } from "../world/types.js";

/**
 * A handle on one world instance: the address book plus the ABIs of everything in it (from the bundle),
 * so every module can open a typed ethers Contract by step id ("8414/TaskToken") without carrying ABIs
 * around. Contracts FOGA deploys during a scenario (cell accounts, adapters) are registered on the handle
 * with the bundle key they were built from.
 */
export class World {
  readonly extras: Record<string, any>;
  private readonly dynamic = new Map<string, { address: string; bundleKey: string }>();

  constructor(
    readonly file: WorldFile,
    readonly bundle: Bundle,
    readonly provider: Provider,
  ) {
    this.extras = bundle.extras;
  }

  static load(worldPath: string, rpc?: string, bundlePath?: string): World {
    const file = readJson<WorldFile>(worldPath);
    if (file.schema !== "foga.world/1") throw new Error(`${worldPath} is not a world file`);
    const bundle = loadBundle(bundlePath);
    const url = rpc ?? process.env.FOGA_RPC_URL ?? (file.network === "anvil" ? "http://127.0.0.1:8545" : undefined);
    if (!url) throw new Error("no RPC: pass --rpc or set FOGA_RPC_URL");
    const provider = new JsonRpcProvider(url, undefined, { staticNetwork: true, cacheTimeout: -1 });
    // A local node answers in microseconds and mines on demand; a public endpoint is shared, rate-limited and
    // makes a block every 12 s, so it is asked a few times per block, not several times per second.
    provider.pollingInterval = file.network === "anvil" ? 250 : 4_000;
    return new World(file, bundle, provider);
  }

  get chainId(): number {
    return this.file.chainId;
  }

  has(id: string): boolean {
    return Boolean(this.file.contracts[id] || this.dynamic.get(id));
  }

  address(id: string): string {
    const entry = this.file.contracts[id] ?? this.dynamic.get(id);
    if (!entry) throw new Error(`world ${this.file.worldId} has no contract ${id}`);
    return entry.address;
  }

  bundleKeyOf(id: string): string {
    const entry = this.file.contracts[id] ?? this.dynamic.get(id);
    if (!entry?.bundleKey) throw new Error(`world contract ${id} has no bundle key`);
    return entry.bundleKey;
  }

  artifact(bundleKey: string): BundleContract {
    const c = this.bundle.contracts[bundleKey];
    if (!c) throw new Error(`bundle has no contract ${bundleKey}`);
    return c;
  }

  abi(id: string): any[] {
    return this.artifact(this.bundleKeyOf(id)).abi;
  }

  iface(id: string): Interface {
    return new Interface(this.abi(id));
  }

  ifaceOf(bundleKey: string): Interface {
    return new Interface(this.artifact(bundleKey).abi);
  }

  /** Open a world contract; pass a signer to send transactions. */
  contract(id: string, runner?: ContractRunner): Contract {
    return new Contract(this.address(id), this.abi(id), runner ?? this.provider);
  }

  /** Open any address with the ABI of a bundle contract. */
  at(bundleKey: string, address: string, runner?: ContractRunner): Contract {
    return new Contract(address, this.artifact(bundleKey).abi, runner ?? this.provider);
  }

  /** Register a scenario-deployed contract under a step id for later lookups. */
  attach(id: string, address: string, bundleKey: string): void {
    this.dynamic.set(id, { address, bundleKey });
  }

  async blockTimestamp(): Promise<number> {
    const b = await this.provider.getBlock("latest");
    return Number(b!.timestamp);
  }
}

/** Decode the first event of a given name from a receipt using an Interface. */
export function eventArgs(iface: Interface, receipt: { logs: readonly { topics: readonly string[]; data: string; address: string }[] }, name: string, address?: string): any {
  for (const log of receipt.logs) {
    if (address && log.address.toLowerCase() !== address.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed && parsed.name === name) return parsed.args;
    } catch {
      /* not ours */
    }
  }
  throw new Error(`event ${name} not found in receipt`);
}

export type Runner = Signer | ContractRunner;

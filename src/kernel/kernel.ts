import { Contract, Interface, Wallet, getCreateAddress, type ContractRunner, type TransactionReceipt } from "ethers";
import { ACDF } from "../core/acdf.js";
import { ADRF } from "../core/adrf.js";
import { AID } from "../core/aid.js";
import { ARD } from "../core/ard.js";
import { ASF } from "../core/asf.js";
import { ERC8004_ABI, Identity8004 } from "../core/erc8004.js";
import { KYA } from "../core/kya.js";
import { Skills } from "../core/skills.js";
import { Swarms } from "../core/swarm.js";
import { Tenders } from "../core/tenders.js";
import { Units } from "../core/units.js";
import { World } from "../core/world.js";
import { OperationStore } from "./store.js";
import { TxManager, type Confirmed, type TxManagerOptions } from "./tx.js";

export interface KernelOptions extends TxManagerOptions {
  worldPath: string;
  rpc?: string;
  bundlePath?: string;
  /** SQLite file for the operation store, or ":memory:". */
  storePath: string;
  /** Signer name -> private key. Names are the scenario's roles ("W", "owner.A", "operator.A", ...). */
  keys: Record<string, string>;
}

export interface EvidenceRecord {
  step: string;
  label: string;
  values: Record<string, unknown>;
  at: string;
}

/**
 * The kernel: one world, one operation store, the signers the node holds, and the ten protocol modules opened on
 * that world. Everything that changes chain state goes through `tx` (idempotent by key); everything a later step
 * or a resumed run needs is a fact in the store; everything a reviewer needs is evidence.
 */
export class Kernel {
  readonly tx: TxManager;
  readonly signers: Record<string, Wallet>;
  readonly kya: KYA;
  readonly aid: AID;
  readonly asf: ASF;
  readonly ard: ARD;
  readonly units: Units;
  readonly skills: Skills;
  readonly tenders: Tenders;
  readonly identity: Identity8004;
  readonly acdf: ACDF;
  readonly adrf: ADRF;
  readonly swarms: Swarms;
  private readonly evidenceList: EvidenceRecord[] = [];

  private constructor(
    readonly world: World,
    readonly store: OperationStore,
    keys: Record<string, string>,
    options: TxManagerOptions,
  ) {
    this.signers = Object.fromEntries(Object.entries(keys).map(([name, pk]) => [name, new Wallet(pk, world.provider)]));
    // a public endpoint is usually a cluster: after a receipt, wait until the cluster answers from that block before reading
    this.tx = new TxManager(world.provider, store, this.signers, { awaitVisibility: world.file.network !== "anvil", ...options });
    // reads are pinned to the last seen block (kernel/provider.ts); a read that had to give the pin up is part of the record
    const pinned = world.provider as { onLag?: (e: Record<string, unknown>) => void };
    if ("pin" in world.provider) pinned.onLag = (e) => {
      store.journal("pinned-read", e);
      options.log?.(`  rpc: ${e.method} at block ${e.block} refused ${e.attempts} time(s) by the endpoint (${e.nodeError}); ${e.outcome === "fell-back" ? "read at latest instead" : "no answer at latest either"}`);
    };
    this.kya = new KYA(world);
    this.aid = new AID(world);
    this.asf = new ASF(world);
    this.ard = new ARD(world);
    this.units = new Units(world);
    this.skills = new Skills(world);
    this.tenders = new Tenders(world);
    this.identity = new Identity8004(world);
    this.acdf = new ACDF(world);
    this.adrf = new ADRF(world);
    this.swarms = new Swarms(world);
    for (const id of Object.keys(world.file.contracts)) {
      if (id === "identity8004") continue;
      try {
        this.tx.decoder.add(world.iface(id), id);
      } catch {
        /* no ABI for this entry */
      }
    }
    this.tx.decoder.add(world.ifaceOf("foga:FogaCellAccount"), "foga:FogaCellAccount");
    for (const key of ["swarm-ai-framework:SwarmAccount", "swarm-ai-framework:SwarmDecisionAdapter", "swarm-ai-framework:CompositeEligibility", "swarm-ai-framework:AssertionLevelEligibility", "acd-framework:ACDFTaskTenderAdapter", "kya-standard:Groth16KYAVerifierAdapter", "foga:Groth16PredicateKYAVerifierAdapter", "ai-dispute-resolution:ADRFErrors", "ai-dispute-resolution:IADRFDisputeRegistry", "ai-dispute-resolution:ADRFACDFBridge"]) {
      try {
        this.tx.decoder.add(world.ifaceOf(key), key);
      } catch {
        /* not in this bundle */
      }
    }
    this.tx.decoder.add(new Interface(ERC8004_ABI), "erc8004");
  }

  static async open(opts: KernelOptions): Promise<Kernel> {
    const world = World.load(opts.worldPath, opts.rpc, opts.bundlePath);
    const store = OperationStore.open(opts.storePath);
    const net = await world.provider.getNetwork();
    if (Number(net.chainId) !== world.chainId) throw new Error(`RPC chain ${net.chainId} is not the world's chain ${world.chainId}`);
    // A store belongs to one chain instance: the hash of block 0 tells a restarted local chain from a resumed one.
    const genesis = (await world.provider.getBlock(0))?.hash ?? "unknown";
    const known = store.getMeta("genesisBlockHash");
    if (known && known !== genesis) {
      throw new Error(`operation store ${opts.storePath} belongs to a chain whose block 0 is ${known}; this RPC's block 0 is ${genesis}. The chain was reset: delete the store (or pass a fresh --store) to start over.`);
    }
    if (!known) {
      store.setMeta("genesisBlockHash", genesis);
      store.setMeta("chainId", String(world.chainId));
      store.setMeta("worldId", world.file.worldId);
    }
    const { worldPath: _w, rpc: _r, bundlePath: _b, storePath: _s, keys, ...txOptions } = opts;
    return new Kernel(world, store, keys, txOptions);
  }

  close(): void {
    this.store.close();
  }

  get chainId(): number {
    return this.world.chainId;
  }

  signer(name: string): Wallet {
    return this.tx.signer(name);
  }

  address(signerName: string): string {
    return this.signer(signerName).address;
  }

  // ---------------------------------------------------------------------------- sending

  /**
   * Call a function on a contract as an EOA signer. `gasLimit` overrides the estimate for calls whose outcome
   * depends on the gas left (a registry that treats a module's `false` with little gas left as unevaluable).
   */
  async call(key: string, signer: string, target: string, iface: Interface, fn: string, args: unknown[], value = 0n, kind = "call", gasLimit?: bigint): Promise<Confirmed> {
    return this.tx.send({ key, signer, kind, build: () => ({ to: target, data: iface.encodeFunctionData(fn, args), value, ...(gasLimit ? { gasLimit } : {}) }) });
  }

  /** Deploy a bundle contract as an EOA signer. The predicted address is derived from the signer's nonce. */
  async deploy(key: string, signer: string, bundleKey: string, args: unknown[] = [], onPredict?: (predicted: string) => unknown[] | void): Promise<{ address: string; confirmed: Confirmed }> {
    const artifact = this.world.artifact(bundleKey);
    if (!artifact.deployable) throw new Error(`${bundleKey} is not deployable`);
    if (Object.keys(artifact.linkReferences ?? {}).length) throw new Error(`${bundleKey} needs library linking; not supported by Kernel.deploy`);
    const iface = new Interface(artifact.abi);
    const confirmed = await this.tx.send({
      key,
      signer,
      kind: "deploy",
      build: ({ nonce, from }) => {
        const predicted = getCreateAddress({ from, nonce });
        const finalArgs = (onPredict && onPredict(predicted)) || args;
        const ctor = iface.deploy;
        const data = artifact.bytecode + (ctor.inputs.length ? iface.encodeDeploy(finalArgs).slice(2) : "");
        return { data };
      },
    });
    const address = confirmed.receipt.contractAddress;
    if (!address) throw new Error(`deployment ${key} has no contract address in its receipt`);
    return { address, confirmed };
  }

  async transfer(key: string, signer: string, to: string, value: bigint): Promise<Confirmed> {
    return this.tx.send({ key, signer, kind: "transfer", build: () => ({ to, value }) });
  }

  // ---------------------------------------------------------------------------- facts and evidence

  fact<T = unknown>(key: string): T | undefined {
    return this.store.getFact<T>(key);
  }

  requireFact<T = unknown>(key: string): T {
    return this.store.requireFact<T>(key);
  }

  setFact(key: string, value: unknown): void {
    this.store.setFact(key, value);
  }

  /**
   * A value fixed the first time it is computed and read back on every later run. Anything that enters a
   * transaction and depends on the clock or on chain state at run time (deadlines, block numbers) goes through
   * here, so a resumed run rebuilds exactly the inputs the recorded transactions were made from.
   */
  async memo<T>(key: string, compute: () => T | Promise<T>): Promise<T> {
    const have = this.store.getFact<T>(key);
    if (have !== undefined) return have;
    const value = await compute();
    this.store.setFact(key, value);
    return value;
  }

  /** Record what a reviewer needs to check a step; kept in the store and in the run's evidence file. */
  evidence(step: string, label: string, values: Record<string, unknown>): void {
    const rec: EvidenceRecord = { step, label, values, at: new Date().toISOString() };
    this.evidenceList.push(rec);
    this.store.setFact(`evidence.${step}.${label}`, values);
  }

  evidenceRecords(): EvidenceRecord[] {
    return [...this.evidenceList];
  }

  // ---------------------------------------------------------------------------- views

  contract(id: string, runner?: ContractRunner): Contract {
    return this.world.contract(id, runner);
  }

  async balance(address: string): Promise<bigint> {
    return this.world.provider.getBalance(address);
  }

  async blockNumber(): Promise<number> {
    return this.world.provider.getBlockNumber();
  }

  async blockTimestamp(): Promise<number> {
    return this.world.blockTimestamp();
  }

  /** True for a local development chain whose clock the kernel may move. */
  get isLocalChain(): boolean {
    return this.world.file.network === "anvil";
  }

  /**
   * Let `seconds` of chain time pass. On anvil the clock is moved and a block mined (recorded in the journal:
   * a skipped interval is part of the evidence); on any other chain the kernel waits for real time.
   */
  async advanceTime(seconds: number, why: string): Promise<void> {
    const before = await this.blockTimestamp();
    if (this.isLocalChain) {
      await (this.world.provider as any).send("evm_increaseTime", [seconds]);
      await (this.world.provider as any).send("evm_mine", []);
      const after = await this.blockTimestamp();
      this.store.journal("time-skipped", { seconds, from: before, to: after, why });
      return;
    }
    const target = before + seconds;
    this.store.journal("time-waited", { seconds, from: before, until: target, why });
    while ((await this.blockTimestamp()) < target) await new Promise((r) => setTimeout(r, 5_000));
  }

  /** Decode the first event `name` from a receipt with the ABI of world contract `id` (or any interface). */
  event(receipt: TransactionReceipt, iface: Interface, name: string, address?: string): any {
    for (const log of receipt.logs) {
      if (address && log.address.toLowerCase() !== address.toLowerCase()) continue;
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed && parsed.name === name) return parsed.args;
      } catch {
        /* not ours */
      }
    }
    throw new Error(`event ${name} not found in receipt ${receipt.hash}`);
  }
}

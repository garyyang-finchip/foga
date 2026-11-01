import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, Wallet } from "ethers";
import { buildSkillPackage, readSkillDir, type SkillPackage } from "../core/pack/skillpack.js";
import { Cell } from "../kernel/cell.js";
import { Kernel } from "../kernel/kernel.js";
import { configPath, loadCellConfig, saveCellConfig, type CellConfig, type LoadedConfig } from "./config.js";
import type { AcceptanceDirectory, BudgetUse } from "./policy.js";

/** Keys this process holds, by role. A running node holds the operator's alone; the CLI's admin commands load the owner's or the guardian's for one run. */
export interface NodeKeys {
  operator?: string;
  owner?: string;
  guardian?: string;
}

export interface NodeOpenOptions {
  configPath: string;
  rpc?: string;
  keys: NodeKeys;
  /** Open a config whose cell has not been born yet (`foga cell init`). */
  allowUnborn?: boolean;
  log?: (line: string) => void;
}

/** Signer names the node uses in the kernel. */
export const ROLE = { operator: "operator", owner: "owner", guardian: "guardian" } as const;
export type NodeRole = keyof typeof ROLE;

export interface HeldSkill {
  name: string;
  tokenId: bigint;
  packageHash: string;
  mdHash: string;
  pkg: SkillPackage;
}

/**
 * The node: one cell's configuration, the kernel opened on the cell's world and store, the cell handle, and what
 * the capability catalog needs to decide and act (design memo, Phase 3, section 2). It knows which keys this
 * process holds and refuses an act whose signer is not here rather than looking for a key anywhere else.
 */
export class Node {
  private constructor(
    readonly loaded: LoadedConfig,
    readonly kernel: Kernel,
    readonly cell: Cell | null,
    private readonly held: NodeKeys,
    readonly rpc: string,
    readonly log: (line: string) => void,
  ) {}

  static async open(opts: NodeOpenOptions): Promise<Node> {
    const loaded = loadCellConfig(opts.configPath);
    const cfg = loaded.config;
    const keys: Record<string, string> = {};
    for (const role of ["operator", "owner", "guardian"] as NodeRole[]) {
      const pk = opts.keys[role];
      if (!pk) continue;
      const address = new Wallet(pk).address;
      const expected = cfg.identity[role];
      if (getAddress(address) !== getAddress(expected)) throw new Error(`the ${role} key loaded here is ${address}; the config names ${expected} as ${role}. The key and the config disagree; nothing was done.`);
      keys[ROLE[role]] = pk;
    }
    const worldPath = configPath(loaded, cfg.world);
    const storePath = configPath(loaded, cfg.store);
    const worldNetwork = (JSON.parse(readFileSync(worldPath, "utf8")) as { network?: string }).network;
    const rpc = opts.rpc ?? cfg.rpc ?? process.env.FOGA_RPC_URL ?? (worldNetwork === "anvil" ? "http://127.0.0.1:8545" : undefined);
    if (!rpc) throw new Error(`no RPC for cell ${cfg.name}: set "rpc" in the config, pass --rpc or set FOGA_RPC_URL`);
    const kernel = await Kernel.open({ worldPath, rpc, bundlePath: cfg.bundle ? configPath(loaded, cfg.bundle) : undefined, storePath, keys, log: opts.log });
    const log = opts.log ?? (() => {});
    const known = kernel.store.getMeta("cellAccount");
    if (known && cfg.identity.account && known.toLowerCase() !== cfg.identity.account.toLowerCase()) {
      kernel.close();
      throw new Error(`operation store ${storePath} belongs to cell account ${known}, not to ${cfg.identity.account} (${opts.configPath}). Point the config at its own store or start a fresh one.`);
    }
    let cell: Cell | null = null;
    if (cfg.identity.account) {
      cell = new Cell(kernel, cfg.name, cfg.identity.account, { owner: ROLE.owner, operator: ROLE.operator, guardian: cfg.identity.guardian, recovery: cfg.identity.recovery });
      // the account must be there, be revision 2 or later, and name the roles the config names
      const code = await kernel.world.provider.getCode(cfg.identity.account);
      if (code === "0x") {
        kernel.close();
        throw new Error(`no contract at the cell account ${cfg.identity.account} on this chain (${opts.configPath}); is the config for this world?`);
      }
      let version = 1;
      try {
        version = Number(await cell.contract().ACCOUNT_VERSION());
      } catch {
        version = 1;
      }
      if (version < 2) {
        kernel.close();
        throw new Error(`the cell account ${cfg.identity.account} is a revision-${version} FogaCellAccount: it has no operator allow-list, so a node must not run on it. Move the cell to a revision-2 account first (foga cell migrate).`);
      }
      const [onchainOperator, onchainOwner] = await Promise.all([cell.operator(), cell.owner()]);
      if (getAddress(onchainOperator) !== getAddress(cfg.identity.operator)) {
        kernel.close();
        throw new Error(`the account ${cfg.identity.account} names ${onchainOperator} as operator; the config names ${cfg.identity.operator}. Update the config (or rotate the operator) before running.`);
      }
      if (getAddress(onchainOwner) !== getAddress(cfg.identity.owner)) {
        kernel.close();
        throw new Error(`the account ${cfg.identity.account} is owned by ${onchainOwner}; the config names ${cfg.identity.owner} as owner.`);
      }
      if (!known) kernel.store.setMeta("cellAccount", cfg.identity.account);
    } else if (!opts.allowUnborn) {
      kernel.close();
      throw new Error(`${opts.configPath} names no account: the cell has not been born. Run foga cell init first.`);
    }
    return new Node(loaded, kernel, cell, opts.keys, rpc, log);
  }

  close(): void {
    this.kernel.close();
    this.kernel.world.provider.destroy();
  }

  get config(): CellConfig {
    return this.loaded.config;
  }

  get store() {
    return this.kernel.store;
  }

  get world() {
    return this.kernel.world;
  }

  get chainId(): number {
    return this.kernel.chainId;
  }

  /** The cell handle; an error when the cell has not been born. */
  get body(): Cell {
    if (!this.cell) throw new Error(`cell ${this.config.name} has not been born (foga cell init)`);
    return this.cell;
  }

  hasKey(role: NodeRole): boolean {
    return Boolean(this.held[role]);
  }

  /** The signer name of a role for the kernel, checked to be loaded. */
  signerOf(role: NodeRole): string {
    if (!this.hasKey(role)) throw new Error(`this process holds no ${role} key for cell ${this.config.name}`);
    return ROLE[role];
  }

  saveConfig(): void {
    saveCellConfig(this.loaded.path, this.loaded.config);
  }

  /** Paths the probe worker needs. */
  get worldPath(): string {
    return configPath(this.loaded, this.config.world);
  }

  get bundlePath(): string | undefined {
    return this.config.bundle ? configPath(this.loaded, this.config.bundle) : undefined;
  }

  get skillsDir(): string {
    return configPath(this.loaded, this.config.skills.dir);
  }

  get inputDir(): string {
    return configPath(this.loaded, this.config.skills.inputDir);
  }

  get storePath(): string {
    return configPath(this.loaded, this.config.store);
  }

  get acceptance(): AcceptanceDirectory {
    return { hashlock: this.kernel.tenders.hashlockAddress };
  }

  /** The skills the config says the cell holds, each rebuilt from its directory and checked against the chain's commitment. */
  async heldSkills(): Promise<HeldSkill[]> {
    const out: HeldSkill[] = [];
    for (const [name, h] of Object.entries(this.config.skills.held)) {
      const pkg = buildSkillPackage(readSkillDir(join(this.skillsDir, name)));
      const tokenId = BigInt(h.tokenId);
      const onchain = await this.kernel.skills.skillOf(tokenId);
      if (onchain.packageHash.toLowerCase() !== pkg.packageHash.toLowerCase()) throw new Error(`skill ${name}: the local package ${pkg.packageHash} differs from token ${tokenId}'s commitment ${onchain.packageHash}; the directory was changed since the mint`);
      out.push({ name, tokenId, packageHash: pkg.packageHash, mdHash: pkg.mdHash, pkg });
    }
    return out;
  }

  /** What the cell spent and reserved in the last 24 hours, and how many commitments are open. */
  budgetUse(): BudgetUse {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const books = this.store.budgetBooks(ROLE.operator, since);
    return { ...books, runningCommitments: this.store.countJobs("tender", ["accepted", "running"]) };
  }

  /** eth_estimateGas of a call: the decoded revert reason, or null when it would succeed. */
  async wouldRevert(from: string, to: string, data: string, value = 0n): Promise<string | null> {
    try {
      await this.world.provider.estimateGas({ from, to, data, value });
      return null;
    } catch (e: any) {
      return this.kernel.tx.decoder.explain(e);
    }
  }

  async now(): Promise<number> {
    return this.kernel.blockTimestamp();
  }
}

import { join } from "node:path";
import { Wallet, getAddress, parseEther, type HDNodeWallet } from "ethers";
import { dataUriJcs, keccakJcs } from "../core/canonical.js";
import { accountSubject, fogaAttestedSchemeDescriptor } from "../core/kya.js";
import type { Kernel } from "../kernel/kernel.js";
import { loadCellConfig, newCellConfig, saveCellConfig, type CellConfig } from "../node/config.js";
import { cellInit } from "../node/init.js";
import { Node } from "../node/node.js";
import { defaultCatalog, OPERATOR_CALLER } from "../tools/index.js";
import { repoRoot } from "../util/fs.js";

/**
 * A cell born for a demonstration (Loop D, the quickstart): keys nobody held before, funded by the world operator W,
 * who also registers the attested standing scheme and attests the cell's level-2 standing; the birth itself is the
 * owner's act (`cellInit`, as `foga cell init` does it); the two skills are minted by the operator. What the chain
 * decided — the account, the agent id, the binding, the skills' tokens and package hashes — is written back into the
 * cell's configuration, so a node can be started on it with the operator key alone.
 */
export interface BirthOptions {
  /** A kernel opened with the funder's key under the signer name W (anvil's first account on a local world). */
  kernel: Kernel;
  worldPath: string;
  rpc: string;
  name: string;
  configPath: string;
  storePath: string;
  description?: string;
  /** Adjust the configuration before the birth (policy, runtime, presence). */
  configure?: (cfg: CellConfig) => void;
  log?: (line: string) => void;
}

export interface BornCell {
  owner: HDNodeWallet;
  operator: HDNodeWallet;
  guardian: HDNodeWallet;
  account: string;
  agentId: string | null;
  specId: string | null;
  schemeId: string;
  /** The block before the first transaction of the birth. */
  bornAtBlock: number;
  birthOperations: number;
  held: Record<string, { tokenId: string; packageHash: string }>;
  packages: { "foga-probe": string; "finch-extract-verify": string };
  configPath: string;
  storePath: string;
}

export async function birthCell(o: BirthOptions): Promise<BornCell> {
  const k = o.kernel;
  const log = o.log ?? (() => {});
  const root = repoRoot();
  const W = k.address("W");
  const owner = Wallet.createRandom();
  const operator = Wallet.createRandom();
  const guardian = Wallet.createRandom();
  log(`cell ${o.name}: owner ${owner.address}, operator ${operator.address}, guardian ${guardian.address}`);

  // --- funding by W, the standing scheme registered by W
  const price = (await k.world.provider.getFeeData()).gasPrice ?? 1_000_000_000n;
  const gas = (units: bigint) => units * price * 2n;
  await k.transfer("fund.owner", "W", owner.address, parseEther("0.05") + gas(12_000_000n));
  await k.transfer("fund.operator", "W", operator.address, gas(20_000_000n) + parseEther("0.003"));
  await k.transfer("fund.guardian", "W", guardian.address, gas(1_000_000n));
  const att = await k.call("scheme", "W", k.kya.schemeRegistryAddress, k.kya.schemes().interface, "registerScheme", [k.kya.attestedSchemeInput(fogaAttestedSchemeDescriptor())]);
  const schemeId = k.kya.schemeIdFromReceipt(att.receipt);
  const bornAtBlock = await k.blockNumber();

  // --- the configuration and the birth (the owner's act, in this process, as `foga cell init` would)
  const cfg = newCellConfig({ name: o.name, world: o.worldPath, store: o.storePath, owner: owner.address, operator: operator.address, guardian: guardian.address, rpc: o.rpc, skillsDir: join(root, "scenarios", "skills"), inputDir: join(root, "scenarios", "fixtures"), description: o.description });
  cfg.identity.standing = { schemeId, issuers: [W] };
  o.configure?.(cfg);
  saveCellConfig(o.configPath, cfg);
  const birthNode = await Node.open({ configPath: o.configPath, rpc: o.rpc, keys: { owner: owner.privateKey }, allowUnborn: true, log: () => {} });
  const born = await cellInit(birthNode, { log: () => {} });
  birthNode.close();
  const account = getAddress(born.account);
  log(`cell ${o.name}: born as ${account} (agent ${born.agentId}) in ${born.operations.length} operations`);

  // --- standing from the world operator, the two skills minted by the operator
  const claim = { scheme: "S_att", level: 2, subject: `eip155:${k.chainId}:${account.toLowerCase()}` };
  const expiresAt = (await k.blockTimestamp()) + 365 * 86400;
  await k.call("attest", "W", k.kya.registryAddress, k.kya.registry().interface, "attest", [accountSubject(k.chainId, account), schemeId, 2, keccakJcs(claim), expiresAt, dataUriJcs(claim), keccakJcs(claim)]);
  const catalog = defaultCatalog();
  const skillNode = await Node.open({ configPath: o.configPath, rpc: o.rpc, keys: { operator: operator.privateKey }, log: () => {} });
  try {
    for (const skill of ["foga-probe", "finch-extract-verify"]) {
      const r = await catalog.invoke(skillNode, "skill_mint", { skill }, OPERATOR_CALLER, { mode: "act" });
      if (!r.ok) throw new Error(`skill_mint ${skill}: ${r.gate}: ${r.reason}`);
    }
  } finally {
    skillNode.close();
  }
  const held = loadCellConfig(o.configPath).config.skills.held as Record<string, { tokenId: string; packageHash: string }>;
  log(`cell ${o.name}: standing level 2 attested by ${W}; skills minted (${Object.keys(held).join(", ")})`);
  return {
    owner,
    operator,
    guardian,
    account,
    agentId: born.agentId,
    specId: born.specId ?? null,
    schemeId,
    bornAtBlock,
    birthOperations: born.operations.length,
    held,
    packages: { "foga-probe": held["foga-probe"].packageHash, "finch-extract-verify": held["finch-extract-verify"].packageHash },
    configPath: o.configPath,
    storePath: o.storePath,
  };
}

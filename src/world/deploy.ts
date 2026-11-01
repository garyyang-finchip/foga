import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, getAddress, isAddress } from "ethers";
import { join, relative } from "node:path";
import { loadBundle, getContract } from "../bundle/load.js";
import type { Bundle } from "../bundle/types.js";
import { linkBytecode } from "../util/bytecode.js";
import { exists, readJson, repoRoot, writeJson } from "../util/fs.js";
import { log } from "../util/log.js";
import { DEPLOY_PLAN, WIRE_PLAN, type PlanContext } from "./plan.js";
import type { WorldConfig, WorldContract, WorldFile } from "./types.js";
import { envMnemonic, mnemonicKeys } from "../genesis/roles.js";

export interface DeployOptions {
  worldConfigPath: string;
  rpc?: string;
  outPath?: string;
  resume?: boolean;
  bundlePath?: string;
  gasMultiplier?: number;
  /** Local chains only: deploy even if the configured chainId differs (e.g. a fork). */
  allowChainMismatch?: boolean;
}

export function loadWorldConfig(path: string): WorldConfig {
  const cfg = readJson<WorldConfig>(path);
  if (cfg.schema !== "foga.world-config/1") throw new Error(`unsupported world config schema in ${path}`);
  return cfg;
}

function newWorldFile(cfg: WorldConfig, bundle: Bundle | null, mode: "deployed" | "attached", deployer: string | null): WorldFile {
  const batch = new Date().toISOString();
  const compact = batch.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return {
    schema: "foga.world/1",
    worldId: `${cfg.network}-${cfg.chainId}-${compact}`,
    name: cfg.name,
    network: cfg.network,
    chainId: cfg.chainId,
    mode,
    bundleHash: bundle?.hash ?? null,
    batch,
    forkSourceBlock: null,
    deployer,
    identity8004: { mode: cfg.identity8004.mode === "stub" ? "stub" : "address", address: "0x0000000000000000000000000000000000000000", note: cfg.identity8004.note },
    params: cfg.params,
    contracts: {},
    wiring: {},
    steps: [],
    notes: [...(cfg.notes ?? [])],
  };
}

/** Pure transform for public chains: author the address book from the config, no transactions. */
export function attachWorld(cfg: WorldConfig, bundle: Bundle | null): WorldFile {
  if (cfg.mode !== "attach") throw new Error(`world ${cfg.name} is not an attach-mode config`);
  if (cfg.identity8004.mode !== "address") throw new Error("attach-mode worlds must name the ERC-8004 Identity Registry address");
  const world = newWorldFile(cfg, bundle, "attached", null);
  world.identity8004 = { mode: "official", address: cfg.identity8004.address, note: cfg.identity8004.note };
  for (const [id, c] of Object.entries(cfg.contracts ?? {})) {
    world.contracts[id] = { ...c, address: normalizeAddress(c.address, id) };
    world.steps.push({ id, status: "attached", note: c.note });
  }
  world.contracts["identity8004"] = { address: normalizeAddress(cfg.identity8004.address, "identity8004"), note: cfg.identity8004.note ?? "official ERC-8004 Identity Registry" };
  world.identity8004.address = world.contracts["identity8004"].address;
  if (cfg.expectations) {
    world.wiring.expectations = Object.fromEntries(
      Object.entries(cfg.expectations).map(([k, v]) => [k, /^0x[0-9a-fA-F]{40}$/.test(v) ? normalizeAddress(v, k) : v]),
    );
  }
  const kinds = bundle?.extras?.["ard-onchain-framework"]?.kindIds?.kinds;
  if (kinds) world.wiring["8444/kindIds"] = kinds;
  return world;
}

/** Accept any casing (upstream records are not all EIP-55) and return the checksummed form. */
export function normalizeAddress(address: string, label: string): string {
  const lower = address.toLowerCase();
  if (!isAddress(lower)) throw new Error(`${label}: bad address ${address}`);
  return getAddress(lower);
}

/** Expand ${ENV_VAR} references in an RPC URL. */
export function resolveRpc(rpc: string): string {
  return rpc.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, name) => {
    const v = process.env[name];
    if (!v) throw new Error(`RPC URL references ${name}, which is not set`);
    return v;
  });
}

export async function deployWorld(opts: DeployOptions): Promise<{ world: WorldFile; path: string }> {
  const root = repoRoot();
  const cfg = loadWorldConfig(opts.worldConfigPath);
  const bundle = loadBundle(opts.bundlePath);
  const outPath = opts.outPath ?? join(root, "deployments", `${cfg.name}.json`);

  // An attach-mode config lists what exists upstream. Plan steps it does not list are deployed from the bundle by
  // the deployer (W): a reference instance upstream never deployed, or one deployed at another revision than the
  // locked source. A config that lists everything needs no RPC and no key.
  const toDeploy = cfg.mode === "attach" ? missingPlanSteps(cfg) : [];
  if (cfg.mode === "attach" && toDeploy.length === 0) {
    const world = attachWorld(cfg, bundle);
    writeJson(outPath, world);
    log.info(`attached world ${world.worldId}: ${Object.keys(world.contracts).length} contracts -> ${relative(root, outPath)}`);
    return { world, path: outPath };
  }

  const rpc = opts.rpc ?? resolveRpc(cfg.rpc);
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, cacheTimeout: -1 });
  provider.pollingInterval = cfg.network === "anvil" ? 250 : 4_000;
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== cfg.chainId) {
    const msg = `chain id mismatch: rpc reports ${net.chainId}, world config says ${cfg.chainId}`;
    if (!opts.allowChainMismatch) throw new Error(msg + " (pass --allow-chain-mismatch for forks)");
    log.warn(msg);
  }
  const pk = deployerKey(cfg);
  if (!pk) throw new Error(`no deployer key: set ${cfg.deployer?.privateKeyEnv ?? "FOGA_DEPLOYER_PK"}, or FOGA_MNEMONIC / FOGA_MNEMONIC_FILE (the deployer is then W, the phrase's first account)`);
  // NonceManager keeps nonces strictly sequential even when a node mines instantly.
  const wallet = new NonceManager(new Wallet(pk, provider));
  const deployer = await wallet.getAddress();
  const balance = await provider.getBalance(deployer);
  log.info(`world ${cfg.name} on chain ${net.chainId} via ${rpc}; deployer ${deployer} (balance ${Number(balance) / 1e18} ETH)`);

  let world: WorldFile;
  if (opts.resume && exists(outPath)) {
    world = readJson<WorldFile>(outPath);
    if (world.chainId !== Number(net.chainId) && !opts.allowChainMismatch) throw new Error(`cannot resume ${outPath}: it belongs to chain ${world.chainId}`);
    log.info(`resuming world ${world.worldId} from ${relative(root, outPath)}`);
  } else if (cfg.mode === "attach") {
    world = attachWorld(cfg, bundle);
    world.notes.push(`${toDeploy.length} reference contracts the upstream records do not provide at the locked revision are deployed from the bundle by ${deployer}: ${toDeploy.join(", ")}`);
  } else {
    world = newWorldFile(cfg, bundle, "deployed", deployer);
  }
  world.deployer = deployer;
  world.bundleHash = bundle.hash;
  if (cfg.mode === "attach") log.info(`attach-mode world: ${Object.keys(cfg.contracts ?? {}).length} contracts attached; deploying ${toDeploy.length} from the bundle (${toDeploy.join(", ")})`);

  const stepById = new Map(DEPLOY_PLAN.map((s) => [s.id, s]));
  const ctx: PlanContext = {
    config: cfg,
    bundle,
    world,
    deployer,
    addr: (id) => {
      const c = world.contracts[id];
      if (!c) throw new Error(`step ${id} has no address yet (plan order?)`);
      return c.address;
    },
  };
  const gasMultiplier = opts.gasMultiplier ?? 1;

  for (const step of DEPLOY_PLAN) {
    const existing = world.contracts[step.id];
    if (existing && cfg.mode === "attach" && cfg.contracts?.[step.id]) {
      log.step(`${step.id}: attached at ${existing.address}`);
      continue;
    }
    if (existing && (await provider.getCode(existing.address)) !== "0x") {
      log.step(`${step.id}: already at ${existing.address}`);
      continue;
    }
    const skip = step.skip?.(ctx);
    if (skip) {
      if (step.id === "identity8004" && cfg.identity8004.mode === "address") {
        world.contracts[step.id] = { address: cfg.identity8004.address, note: cfg.identity8004.note ?? "existing ERC-8004 Identity Registry" };
        world.identity8004 = { mode: "address", address: cfg.identity8004.address, note: cfg.identity8004.note };
      }
      world.steps.push({ id: step.id, status: "skipped", note: skip });
      writeJson(outPath, world);
      log.step(`${step.id}: skipped (${skip})`);
      continue;
    }
    const art = getContract(bundle, step.bundleKey);
    if (!art.deployable) throw new Error(`${step.bundleKey} is not deployable (kind ${art.kind}, abstract ${art.abstract})`);
    const libraries: Record<string, string> = {};
    const linked = linkBytecode(art.bytecode, art.linkReferences, (_src, lib) => {
      const libStep = DEPLOY_PLAN.find((s) => s.bundleKey === `${art.repo}:${lib}`);
      if (!libStep) return undefined;
      const a = world.contracts[libStep.id]?.address;
      if (a) libraries[lib] = a;
      return a;
    });
    const args = step.args(ctx);
    const factory = new ContractFactory(art.abi, linked, wallet);
    const txReq = await factory.getDeployTransaction(...args);
    const estimate = await provider.estimateGas({ ...txReq, from: deployer });
    const gasLimit = BigInt(Math.ceil(Number(estimate) * gasMultiplier));
    const contract = await factory.deploy(...args, { gasLimit });
    const deployTx = contract.deploymentTransaction();
    const receipt = await deployTx!.wait();
    const address = await contract.getAddress();
    const rec: WorldContract = {
      address,
      bundleKey: step.bundleKey,
      txHash: receipt?.hash,
      block: receipt?.blockNumber,
      args: args.map((a) => (typeof a === "bigint" ? a.toString() : a)),
      libraries: Object.keys(libraries).length ? libraries : undefined,
      note: cfg.mode === "attach" ? `deployed by FOGA from the bundle (not provided upstream at the locked revision)${step.note ? "; " + step.note : ""}` : step.note,
    };
    world.contracts[step.id] = rec;
    if (step.id === "identity8004") world.identity8004 = { mode: "stub", address, note: cfg.identity8004.note ?? "local stand-in, not the reference registry" };
    world.steps.push({ id: step.id, status: "deployed", txHash: receipt?.hash });
    writeJson(outPath, world);
    log.step(`${step.id}: ${address} (gas ${receipt?.gasUsed}, block ${receipt?.blockNumber})`);
  }

  for (const wire of WIRE_PLAN) {
    if (world.steps.some((s) => s.id === wire.id && s.status === "wired")) {
      log.step(`${wire.id}: already wired`);
      continue;
    }
    const skip = wire.skip?.(ctx);
    if (skip) {
      world.steps.push({ id: wire.id, status: "skipped", note: skip });
      continue;
    }
    const hashes: string[] = [];
    for (const call of wire.calls(ctx)) {
      const target = world.contracts[call.stepId];
      const step = stepById.get(call.stepId);
      if (!target || !step) throw new Error(`wiring ${wire.id}: unknown step ${call.stepId}`);
      const art = getContract(bundle, step.bundleKey);
      const c = new Contract(target.address, art.abi, wallet);
      const tx = await c.getFunction(call.fn)(...call.args);
      const receipt = await tx.wait();
      hashes.push(receipt.hash);
      log.step(`${wire.id}: ${call.fn}(${call.note ?? ""}) in ${receipt.hash}`);
    }
    world.wiring[wire.id] = { txHashes: hashes };
    world.steps.push({ id: wire.id, status: "wired", txHash: hashes[hashes.length - 1] });
    writeJson(outPath, world);
  }

  const kinds = bundle.extras["ard-onchain-framework"]?.kindIds?.kinds;
  if (kinds) world.wiring["8444/kindIds"] = kinds;
  writeJson(outPath, world);
  log.info(`world ${world.worldId}: ${Object.keys(world.contracts).length} contracts -> ${relative(root, outPath)}`);
  return { world, path: outPath };
}

/**
 * The deployer's key: the configured variable (FOGA_DEPLOYER_PK), else W as the genesis will see it (FOGA_KEY_W, or
 * account 0 of the phrase in the environment), else the config's default. The genesis binds the escrow this deploys
 * as W, so the deployer is W unless the variable says otherwise.
 */
export function deployerKey(cfg: WorldConfig): string | undefined {
  const fromEnv = cfg.deployer?.privateKeyEnv ? process.env[cfg.deployer.privateKeyEnv] : process.env.FOGA_DEPLOYER_PK;
  if (fromEnv) return fromEnv;
  if (cfg.network !== "anvil") {
    // on anvil the genesis derives W from anvil's phrase, so a phrase in the environment must not move the deployer
    if (process.env.FOGA_KEY_W) return process.env.FOGA_KEY_W;
    const phrase = envMnemonic();
    if (phrase) return mnemonicKeys(phrase).W;
  }
  return cfg.deployer?.defaultPrivateKey;
}

/** Plan steps an attach-mode config does not list and does not skip: what `foga world deploy` adds from the bundle. */
export function missingPlanSteps(cfg: WorldConfig): string[] {
  const listed = cfg.contracts ?? {};
  return DEPLOY_PLAN.filter((s) => !listed[s.id] && !(s.id === "identity8004" && cfg.identity8004.mode === "address")).map((s) => s.id);
}

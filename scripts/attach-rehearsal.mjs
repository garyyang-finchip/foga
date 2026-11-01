#!/usr/bin/env node
// Rehearse the public-chain path on anvil: from a deployed local world (deployments/local.json) write an
// attach-mode world config that lists the upstream-style address book but leaves out what Sepolia's records do not
// provide at the locked revision (the ERC-8471 stack and the two ERC-8447 eligibility modules FOGA deploys), and
// names a second ERC-8434 registry as the ARD backing registry (Sepolia's seam 1). `foga world deploy` on that
// config attaches the listed contracts and deploys the rest; the genesis then runs its public-chain branches
// (backing registry binds and heartbeats, role funding) with anvil's keys and clock.
//
//   node scripts/attach-rehearsal.mjs [deployments/local.json] [.foga-build/local-attach.config.json] [http://127.0.0.1:8545]
//
// The backing registry is deployed here with anvil account #0 (30 d / 365 d, like the Sepolia fixture).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ContractFactory, JsonRpcProvider, Wallet } from "ethers";

const [worldPath = "deployments/local.json", outPath = ".foga-build/local-attach.config.json", rpc = "http://127.0.0.1:8545"] = process.argv.slice(2);
const ANVIL_0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OMIT = /^8471\/|^8447\/ERC8004Eligibility$|^8447\/IdentityStateEligibility$/;

const world = JSON.parse(readFileSync(resolve(worldPath), "utf8"));
if (world.schema !== "foga.world/1" || world.network !== "anvil") throw new Error(`${worldPath} is not a deployed anvil world`);
const bundle = JSON.parse(readFileSync(resolve("artifacts/bundle.json"), "utf8"));

const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
const wallet = new Wallet(ANVIL_0, provider);
const art = bundle.contracts["aid-standard:AIDRegistry"];
const factory = new ContractFactory(art.abi, art.bytecode, wallet);
const backing = await factory.deploy(30 * 86400, 365 * 86400);
await backing.deploymentTransaction().wait();
const backingAddress = await backing.getAddress();

const contracts = {};
for (const [id, c] of Object.entries(world.contracts)) {
  if (id === "identity8004" || OMIT.test(id)) continue;
  contracts[id] = { address: c.address, bundleKey: c.bundleKey, note: "attached from the deployed local world (rehearsal of the public-chain path)" };
}
contracts["8434/AIDRegistry(ard-fixture)"] = { address: backingAddress, bundleKey: "aid-standard:AIDRegistry", note: "a second registry standing in for ARD's fixture instance on Sepolia: cells keep their liveness here as well" };

const config = {
  schema: "foga.world-config/1",
  name: "local-attach",
  network: "anvil",
  chainId: world.chainId,
  rpc,
  mode: "attach",
  deployer: { privateKeyEnv: "FOGA_DEPLOYER_PK", defaultPrivateKey: ANVIL_0, note: "anvil account #0 = W" },
  identity8004: { mode: "address", address: world.identity8004.address, note: "the local stub, attached by address as a public world attaches the official registry" },
  params: world.params,
  contracts,
  notes: [
    "Rehearsal of the attach-mode path on anvil (scripts/attach-rehearsal.mjs): the ERC-8471 stack and the ERC-8004 / identity-state eligibility modules are left out of the address book so that `foga world deploy` adds them from the bundle, as on Sepolia; a second AIDRegistry is listed as the ARD backing registry.",
  ],
};
mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), JSON.stringify(config, null, 2) + "\n");
console.log(`attach-mode config -> ${outPath}: ${Object.keys(contracts).length} contracts listed (backing registry ${backingAddress}); ${Object.keys(world.contracts).filter((id) => OMIT.test(id)).length} left for foga world deploy`);
provider.destroy();

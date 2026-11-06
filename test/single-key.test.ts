import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Contract, Wallet, getAddress, parseEther } from "ethers";
import { dataUriJcs, keccakJcs } from "../src/core/canonical.js";
import { accountSubject, fogaAttestedSchemeDescriptor } from "../src/core/kya.js";
import { anvilKeys } from "../src/genesis/roles.js";
import { Kernel } from "../src/kernel/kernel.js";
import { loadWallet } from "../src/node/wallet.js";
import { anvilPath, foga, ok, startAnvil } from "./helpers/anvil-cell.js";

/**
 * A cell born from a one-key wallet (owner = operator = guardian, the quickstart's default) moves its own assets.
 * `FogaCellAccount.execute` asks for the owner first, so the one key acts as the owner: the ERC-8004 identity and the
 * skill tokens leave through `execute` (before, the key was judged as the operator and the transfers reverted with
 * `OperatorAssetSelector`), and the operator's expiry does not hold the owner back.
 */
const PORT = 8578;
const RPC = `http://127.0.0.1:${PORT}`;

interface SingleKeyCell {
  wallet: string;
  configPath: string;
  account: string;
  agentId: string;
  signer: Wallet;
}

/** The kernel pins its reads to the newest block it has seen; the CLI's transactions are another process's, so look at the head first. */
async function sync(k: Kernel): Promise<void> {
  await k.world.provider.send("eth_blockNumber", []);
}

async function birth(k: Kernel, worldPath: string, dir: string, name: string, schemeId?: string): Promise<SingleKeyCell> {
  const wallet = join(dir, `${name}.wallet`);
  assert.equal(foga(RPC, ["wallet", "new", "--dir", wallet]).code, 0);
  const signer = new Wallet(readFileSync(loadWallet(wallet)!.files.operator, "utf8").trim());
  await k.transfer(`fund.${name}`, "W", signer.address, parseEther("2"));
  const configPath = join(dir, `${name}.json`);
  assert.equal(foga(RPC, ["cell", "new", "--name", name, "--world", worldPath, "--store", join(dir, `${name}.ops.sqlite`), "--wallet", wallet, "--out", configPath]).code, 0);
  if (schemeId) {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.identity.standing = { schemeId, issuers: [k.address("W")] };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  }
  const born = ok(foga(RPC, ["cell", "init", "--config", configPath, "--wallet", wallet]), `cell init ${name}`);
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  assert.equal(cfg.identity.owner, cfg.identity.operator, "one key is owner and operator");
  return { wallet, configPath, account: getAddress(born.account), agentId: born.agentId, signer };
}

function accountOf(k: Kernel, address: string): Contract {
  return new Contract(address, k.world.ifaceOf("foga:FogaCellAccount"), k.world.provider);
}

async function setting(k: Kernel, address: string): Promise<[string, bigint, bigint]> {
  await sync(k);
  const c = accountOf(k, address);
  return [getAddress(await c.operator()), BigInt(await c.operatorValidUntil()), BigInt(await c.operatorDailyValueCap())];
}

/** The owner lets the operator expire (validUntil in the past): the owner's acts must not depend on it. */
async function expireOperator(k: Kernel, cell: SingleKeyCell): Promise<[string, bigint, bigint]> {
  await sync(k);
  const expired: [string, bigint, bigint] = [cell.signer.address, 1n, parseEther("0.001")];
  await (await (accountOf(k, cell.account).connect(cell.signer.connect(k.world.provider)) as Contract).setOperator(...expired)).wait();
  assert.deepEqual(await setting(k, cell.account), expired);
  return expired;
}

test("single key: the one key acts as the owner — identity_transfer and cell migrate move the cell's assets", { timeout: 900_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-single-key-"));
  const worldPath = join(dir, "world.json");
  let k: Kernel | null = null;
  try {
    assert.equal(foga(RPC, ["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", worldPath]).code, 0);
    k = await Kernel.open({ worldPath, rpc: RPC, storePath: join(dir, "driver.sqlite"), keys: { W: anvilKeys().W } });
    const to = new Wallet(anvilKeys().G).address;

    await t.test("identity_transfer", async () => {
      const cell = await birth(k!, worldPath, dir, "I");
      const expired = await expireOperator(k!, cell);
      const sim = ok(foga(RPC, ["cell", "owner", "identity_transfer", "--config", cell.configPath, "--to", to, "--mode", "simulate"]), "identity_transfer simulate");
      assert.equal(sim.ok, true, JSON.stringify(sim));
      const done = ok(foga(RPC, ["cell", "owner", "identity_transfer", "--config", cell.configPath, "--wallet", cell.wallet, "--to", to, "--jobId", "move-1"]), "identity_transfer");
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.deepEqual(done.operations, ["job:move-1:transfer"], "one transaction: the owner's execute");
      await sync(k!);
      assert.equal(getAddress(await k!.identity.ownerOf(BigInt(cell.agentId))), getAddress(to));
      assert.deepEqual(await setting(k!, cell.account), expired, "the operator setting is not touched");
    });

    await t.test("cell migrate", async () => {
      // standing for the skill mint, as the quickstart gives it
      const scheme = await k!.call("scheme", "W", k!.kya.schemeRegistryAddress, k!.kya.schemes().interface, "registerScheme", [k!.kya.attestedSchemeInput(fogaAttestedSchemeDescriptor())]);
      const schemeId = k!.kya.schemeIdFromReceipt(scheme.receipt);
      const cell = await birth(k!, worldPath, dir, "M", schemeId);
      await sync(k!);
      const chainId = k!.chainId;
      const claim = { scheme: "S_att", level: 2, subject: `eip155:${chainId}:${cell.account.toLowerCase()}` };
      await k!.call("attest", "W", k!.kya.registryAddress, k!.kya.registry().interface, "attest", [accountSubject(chainId, cell.account), schemeId, 2, keccakJcs(claim), (await k!.blockTimestamp()) + 365 * 86400, dataUriJcs(claim), keccakJcs(claim)]);
      ok(foga(RPC, ["cell", "skill_mint", "--config", cell.configPath, "--wallet", cell.wallet, "--skill", "foga-probe"]), "skill_mint");
      const tokenId = BigInt(JSON.parse(readFileSync(cell.configPath, "utf8")).skills.held["foga-probe"].tokenId);
      const expired = await expireOperator(k!, cell);
      const moved = ok(foga(RPC, ["cell", "migrate", "--config", cell.configPath, "--wallet", cell.wallet, "--to", join(dir, "M2.json")]), "cell migrate");
      await sync(k!);
      assert.equal(getAddress(await k!.identity.ownerOf(BigInt(cell.agentId))), getAddress(moved.to));
      assert.equal(getAddress(await k!.skills.ownerOf(tokenId)), getAddress(moved.to));
      assert.equal(await k!.aid.stateName(cell.account), "RETIRED");
      assert.equal(await k!.aid.stateName(moved.to), "ACTIVE");
      assert.deepEqual(moved.skills, ["foga-probe"]);
      assert.deepEqual(await setting(k!, cell.account), expired, "the old account's operator setting is not touched");
      // the successor is a single-key account too, and acts the same way
      const next = JSON.parse(readFileSync(join(dir, "M2.json"), "utf8"));
      assert.equal(next.identity.owner, next.identity.operator);
      const after = ok(foga(RPC, ["cell", "owner", "identity_transfer", "--config", join(dir, "M2.json"), "--wallet", cell.wallet, "--to", to]), "identity_transfer from the successor");
      assert.equal(after.ok, true, JSON.stringify(after));
      await sync(k!);
      assert.equal(getAddress(await k!.identity.ownerOf(BigInt(cell.agentId))), getAddress(to));
    });
  } finally {
    if (k) {
      k.close();
      k.world.provider.destroy();
    }
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

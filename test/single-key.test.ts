import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Contract, Wallet, ZeroAddress, getAddress, parseEther } from "ethers";
import { dataUriJcs, keccakJcs } from "../src/core/canonical.js";
import { accountSubject, fogaAttestedSchemeDescriptor } from "../src/core/kya.js";
import { anvilKeys } from "../src/genesis/roles.js";
import { Kernel } from "../src/kernel/kernel.js";
import { OperationStore } from "../src/kernel/store.js";
import { loadWallet } from "../src/node/wallet.js";
import { anvilPath, foga, ok, startAnvil } from "./helpers/anvil-cell.js";

/**
 * A cell born from a one-key wallet (owner = operator = guardian, the quickstart's default) moves its assets: the
 * owner's transferFrom / safeTransferFrom through `execute` would be judged as the operator's (OperatorAssetSelector),
 * so the owner sets the operator aside for the moves and puts back exactly what it found — also when a step fails —
 * and a binding that is not satisfied refuses the move before anything is sent.
 */
const PORT = 8577;
const RPC = `http://127.0.0.1:${PORT}`;
const EXPIRY_DAYS = 30;
const CAP = parseEther("0.001");

interface SingleKeyCell {
  dir: string;
  wallet: string;
  configPath: string;
  storePath: string;
  account: string;
  agentId: string;
  signer: Wallet;
}

async function birth(k: Kernel, worldPath: string, dir: string, name: string, schemeId?: string): Promise<SingleKeyCell> {
  const wallet = join(dir, `${name}.wallet`);
  assert.equal(foga(RPC, ["wallet", "new", "--dir", wallet]).code, 0);
  const w = loadWallet(wallet)!;
  const signer = new Wallet(readFileSync(w.files.operator, "utf8").trim());
  await k.transfer(`fund.${name}`, "W", signer.address, parseEther("2"));
  const configPath = join(dir, `${name}.json`);
  const storePath = join(dir, `${name}.ops.sqlite`);
  assert.equal(foga(RPC, ["cell", "new", "--name", name, "--world", worldPath, "--store", storePath, "--wallet", wallet, "--out", configPath]).code, 0);
  if (schemeId) {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.identity.standing = { schemeId, issuers: [k.address("W")] };
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
  }
  const born = ok(foga(RPC, ["cell", "init", "--config", configPath, "--wallet", wallet]), `cell init ${name}`);
  return { dir, wallet, configPath, storePath, account: getAddress(born.account), agentId: born.agentId, signer };
}

/** The kernel pins its reads to the newest block it has seen; the CLI's transactions are another process's, so look at the head first. */
async function sync(k: Kernel): Promise<void> {
  await k.world.provider.send("eth_blockNumber", []);
}

function accountOf(k: Kernel, address: string): Contract {
  return new Contract(address, k.world.ifaceOf("foga:FogaCellAccount"), k.world.provider);
}

async function setting(k: Kernel, address: string): Promise<[string, bigint, bigint]> {
  await sync(k);
  const c = accountOf(k, address);
  return [getAddress(await c.operator()), BigInt(await c.operatorValidUntil()), BigInt(await c.operatorDailyValueCap())];
}

/** The owner narrows the operator (an expiry and a cap the config does not record): a move must put back exactly this. */
async function narrow(k: Kernel, cell: SingleKeyCell): Promise<[string, bigint, bigint]> {
  await sync(k);
  const wanted: [string, bigint, bigint] = [cell.signer.address, BigInt((await k.blockTimestamp()) + EXPIRY_DAYS * 86400), CAP];
  const signer = cell.signer.connect(k.world.provider);
  await (await (accountOf(k, cell.account).connect(signer) as Contract).setOperator(...wanted)).wait();
  assert.deepEqual(await setting(k, cell.account), wanted);
  return wanted;
}

function suspend(cell: SingleKeyCell): void {
  const r = ok(foga(RPC, ["cell", "guardian", "guardian_suspend", "--config", cell.configPath, "--wallet", cell.wallet, "--reason", "drill"]), "guardian_suspend");
  assert.equal(r.output.state, "Suspended");
}

function resume(cell: SingleKeyCell): void {
  const r = ok(foga(RPC, ["cell", "guardian", "guardian_resume", "--config", cell.configPath, "--wallet", cell.wallet, "--reason", "drill over"]), "guardian_resume");
  assert.equal(r.output.state, "Active");
}

function opKeys(storePath: string): Map<string, string> {
  const s = OperationStore.open(storePath);
  try {
    return new Map(s.all().map((o) => [o.key, o.status]));
  } finally {
    s.close();
  }
}

test("single key: identity_transfer and cell migrate set the operator aside, put back what they found, refuse a suspended move up front", { timeout: 900_000 }, async (t) => {
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
      const wanted = await narrow(k!, cell);
      // suspended: refused at the safety gate, nothing sent, the operator untouched
      suspend(cell);
      const sim = foga(RPC, ["cell", "owner", "identity_transfer", "--config", cell.configPath, "--to", to, "--mode", "simulate"]);
      assert.equal(sim.json?.ok, false, `simulate must refuse a suspended transfer: ${sim.stdout.slice(0, 400)}`);
      assert.equal(sim.json.gate, "safety");
      const refusedAct = foga(RPC, ["cell", "owner", "identity_transfer", "--config", cell.configPath, "--wallet", cell.wallet, "--to", to]);
      assert.equal(refusedAct.json?.ok, false);
      assert.equal(refusedAct.json.gate, "safety");
      assert.ok(![...opKeys(cell.storePath).keys()].some((key) => key.startsWith("job:identity-transfer")), "a refused transfer sends nothing");
      assert.deepEqual(await setting(k!, cell.account), wanted);
      // satisfied: the operator is set aside, the agent moves, the operator comes back with its expiry and cap
      resume(cell);
      // a step that fails after the operator was set aside: the job fails, and the operator is put back (ActPlan.undo)
      const s = OperationStore.open(cell.storePath);
      s.prepare("job:undo-1:transfer", "execute", "owner");
      s.markFailed("job:undo-1:transfer", "injected by the test");
      s.close();
      const undone = foga(RPC, ["cell", "owner", "identity_transfer", "--config", cell.configPath, "--wallet", cell.wallet, "--to", to, "--jobId", "undo-1"]);
      assert.equal(undone.json?.ok, false, undone.stdout.slice(0, 400));
      assert.equal(undone.json.gate, "execution");
      const undoOps = opKeys(cell.storePath);
      assert.equal(undoOps.get("job:undo-1:clearOperator"), "confirmed");
      assert.equal(undoOps.get("job:undo-1:restoreOperator"), "confirmed");
      assert.deepEqual(await setting(k!, cell.account), wanted, "a failed job leaves the operator as it found it");
      const done = ok(foga(RPC, ["cell", "owner", "identity_transfer", "--config", cell.configPath, "--wallet", cell.wallet, "--to", to, "--jobId", "move-1"]), "identity_transfer");
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.deepEqual(done.operations, ["job:move-1:clearOperator", "job:move-1:transfer", "job:move-1:restoreOperator"]);
      await sync(k!);
      assert.equal(getAddress(await k!.identity.ownerOf(BigInt(cell.agentId))), getAddress(to));
      const receipt = await k!.world.provider.getTransactionReceipt(done.output.txHash);
      assert.equal(getAddress(receipt!.to!), cell.account, "the txHash answered is the transfer's (an execute on the account)");
      assert.deepEqual(await setting(k!, cell.account), wanted, "expiry and cap put back as they were");
    });

    await t.test("cell migrate", async () => {
      // standing for the skill mints (as the quickstart gives it)
      const scheme = await k!.call("scheme", "W", k!.kya.schemeRegistryAddress, k!.kya.schemes().interface, "registerScheme", [k!.kya.attestedSchemeInput(fogaAttestedSchemeDescriptor())]);
      const schemeId = k!.kya.schemeIdFromReceipt(scheme.receipt);
      const cell = await birth(k!, worldPath, dir, "M", schemeId);
      const chainId = k!.chainId;
      await sync(k!);
      const claim = { scheme: "S_att", level: 2, subject: `eip155:${chainId}:${cell.account.toLowerCase()}` };
      await k!.call("attest", "W", k!.kya.registryAddress, k!.kya.registry().interface, "attest", [accountSubject(chainId, cell.account), schemeId, 2, keccakJcs(claim), (await k!.blockTimestamp()) + 365 * 86400, dataUriJcs(claim), keccakJcs(claim)]);
      ok(foga(RPC, ["cell", "skill_mint", "--config", cell.configPath, "--wallet", cell.wallet, "--skill", "foga-probe"]), "skill_mint");
      const tokenId = BigInt(JSON.parse(readFileSync(cell.configPath, "utf8")).skills.held["foga-probe"].tokenId);
      const wanted = await narrow(k!, cell);
      const P = `migrate.${cell.agentId}`;
      const migrate = (out: string) => foga(RPC, ["cell", "migrate", "--config", cell.configPath, "--wallet", cell.wallet, "--to", join(dir, out)]);

      // suspended: stopped before the successor is deployed
      suspend(cell);
      const stopped = migrate("M2.json");
      assert.notEqual(stopped.code, 0);
      assert.match(stopped.stderr, /Suspended|NotSatisfied/);
      assert.ok(![...opKeys(cell.storePath).keys()].some((key) => key.startsWith(P)), "nothing of the migration was sent");
      resume(cell);

      // the store an earlier version left: the identity's transfer failed as the operator's call (nothing reached the
      // chain), and a later step fails too, inside the window where the operator is aside
      const s = OperationStore.open(cell.storePath);
      s.prepare(`${P}.8004.transfer`, "execute", "owner");
      s.markFailed(`${P}.8004.transfer`, "OperatorAssetSelector(0x5FbDB2315678afecb367f032d93F642f64180aa3, 0x23b872dd) [execution reverted (unknown custom error)]");
      s.prepare(`${P}.aid.bind`, "execute", "owner");
      s.markFailed(`${P}.aid.bind`, "injected by the test");
      s.close();
      const failed = migrate("M2.json");
      assert.notEqual(failed.code, 0);
      assert.match(failed.stderr, /aid\.bind failed before/);
      assert.match(failed.stderr, /8004\.transfer: failed before as the operator's call/);
      assert.deepEqual(await setting(k!, cell.account), wanted, "a failure inside the window puts the operator back");
      // with the operator back on the account, the owner, the guardian and a reader open it as ever
      ok(foga(RPC, ["cell", "status", "--config", cell.configPath]), "cell status");

      // resumed: the operator is set aside again under a new key, the move completes, the setting comes back
      const r = OperationStore.open(cell.storePath);
      r.markRetry(`${P}.aid.bind`);
      r.close();
      const moved = ok(migrate("M2.json"), "cell migrate (resumed)");
      assert.ok(moved.operations.includes(`${P}.clearOperator.1`) && moved.operations.includes(`${P}.restoreOperator.1`), moved.operations.join(" "));
      await sync(k!);
      assert.equal(getAddress(await k!.identity.ownerOf(BigInt(cell.agentId))), getAddress(moved.to));
      assert.equal(getAddress(await k!.skills.ownerOf(tokenId)), getAddress(moved.to));
      assert.equal(await k!.aid.stateName(cell.account), "RETIRED");
      assert.deepEqual(await setting(k!, cell.account), wanted, "expiry and cap put back as they were");

      // replayed: nothing is sent again
      const before = opKeys(cell.storePath).size;
      const again = migrate("M3.json");
      assert.equal(again.code, 0, again.stderr.slice(-1500));
      assert.doesNotMatch(again.stderr, /: sent 0x/);
      assert.equal(opKeys(cell.storePath).size, before);
    });

    await t.test("a node holding the operator key refuses an account whose operator is aside; the guardian and readers do not", async () => {
      const cell = await birth(k!, worldPath, dir, "N");
      const signer = cell.signer.connect(k!.world.provider);
      await sync(k!);
      await (await (accountOf(k!, cell.account).connect(signer) as Contract).setOperator(ZeroAddress, 0, 0)).wait();
      const tick = foga(RPC, ["node", "tick", "--config", cell.configPath, "--wallet", cell.wallet]);
      assert.notEqual(tick.code, 0);
      assert.match(tick.stderr, /operator set aside/);
      ok(foga(RPC, ["cell", "status", "--config", cell.configPath]), "cell status");
      suspend(cell);
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

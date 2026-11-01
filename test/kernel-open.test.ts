import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonRpcProvider } from "ethers";
import { Kernel } from "../src/kernel/kernel.js";
import { OperationStore } from "../src/kernel/store.js";
import { anvilKeys } from "../src/genesis/roles.js";
import { MockChain } from "./mock-chain.js";

/**
 * A store belongs to one chain instance and one world. Opening it against another world file, or a chain whose
 * block 0 differs, is refused with both identities named; a 0.5.0 store that recorded only the block-0 hash gains
 * the world and chain identity on its first open.
 */
test("the kernel refuses a store that belongs to another world and completes an older store's identity", async () => {
  const chain = new MockChain();
  await chain.start();
  const dir = mkdtempSync(join(tmpdir(), "foga-kernel-"));
  const storePath = join(dir, "ops.sqlite");
  const worldA = join(dir, "a.json");
  const worldB = join(dir, "b.json");
  const example = JSON.parse(readFileSync("deployments/local.example.json", "utf8"));
  writeFileSync(worldA, JSON.stringify(example));
  writeFileSync(worldB, JSON.stringify({ ...example, worldId: "anvil-31337-other" }));
  const keys = anvilKeys();
  try {
    // an older store: block-0 hash only
    const old = OperationStore.open(storePath);
    const probe = new JsonRpcProvider(chain.url, undefined, { staticNetwork: true });
    const genesis = (await probe.getBlock(0))!.hash;
    probe.destroy();
    old.setMeta("genesisBlockHash", genesis);
    old.close();

    const k = await Kernel.open({ worldPath: worldA, rpc: chain.url, storePath, keys });
    assert.equal(k.store.getMeta("worldId"), example.worldId, "the world id is recorded on first open");
    assert.equal(k.store.getMeta("chainId"), "31337");
    assert.equal(k.store.getMeta("genesisBlockHash"), genesis);
    k.close();
    k.world.provider.destroy();

    await assert.rejects(Kernel.open({ worldPath: worldB, rpc: chain.url, storePath, keys }), (e: Error) => {
      assert.match(e.message, /belongs to world anvil-31337-\d+T\d+Z, not to anvil-31337-other/);
      return true;
    });

    // the right world again: opens
    const again = await Kernel.open({ worldPath: worldA, rpc: chain.url, storePath, keys });
    again.close();
    again.world.provider.destroy();

    // a chain that was reset (another block 0) is refused too
    chain.resetGenesis = true;
    await assert.rejects(Kernel.open({ worldPath: worldA, rpc: chain.url, storePath, keys }), /The chain was reset/);
  } finally {
    chain.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

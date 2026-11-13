import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { JsonRpcProvider, Wallet, parseEther } from "ethers";
import { mintCases } from "../src/demo/demander.js";
import { freePort } from "../src/demo/loop-d.js";
import { anvilKeys } from "../src/genesis/roles.js";
import { formatCard } from "../src/node/card.js";
import { fundingMessage, runJoin } from "../src/node/join.js";
import { ensureWallet } from "../src/node/wallet.js";
import { anvilPath, foga, fogaAsync, startAnvil } from "./helpers/anvil-cell.js";

/**
 * `foga join` on a local world: the persistent public-chain birth, end to end — the wallet, the funding gate, the
 * birth, the skills, the documents, the node served; a second join in the same directory resumes with nothing sent
 * twice; and the social loop with a model: a demander (another party) mints tenders for the cell on the chain, and
 * the cell run with the stub takes them, submits, and settles — the handshake is the chain, no network between them.
 */
const PORT = 8577;
const RPC = `http://127.0.0.1:${PORT}`;

test("join: a cell that lives — born, equipped, published, served; resumed; and working for a stranger over the chain", { timeout: 600_000 }, async (t) => {
  const bin = anvilPath();
  if (!bin) {
    t.skip("anvil is not installed");
    return;
  }
  const anvil = await startAnvil(bin, PORT);
  const dir = mkdtempSync(join(tmpdir(), "foga-join-"));
  const log = () => {};
  let running: { stop(): Promise<void> } | null = null;
  try {
    // the world, deployed as any world is; a fresh wallet, funded by anvil's first account (a faucet, in effect)
    const worldPath = join(dir, "world.json");
    const deployed = foga(RPC, ["world", "deploy", "--world", "worlds/local.json", "--rpc", RPC, "--out", worldPath]);
    assert.equal(deployed.code, 0, `world deploy failed:\n${deployed.stderr.slice(-1500)}`);
    // --- the address book by URL (1.0.9): served from a local http server (the one exception to https), the CLI fetches
    // it once, keeps it under FOGA_WORLDS_DIR named by worldId and runs on that file; what it kept is what was served
    const served = readFileSync(worldPath, "utf8");
    const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(served));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const addr = server.address() as { port: number };
      const worldsDir = join(dir, "worlds");
      // the CLI runs asynchronously here: the server answering it lives in this process
      const status = await fogaAsync(RPC, ["genesis", "status", "--world", `http://127.0.0.1:${addr.port}/chain/world/local.json`, "--store", join(dir, "none.sqlite")], { FOGA_WORLDS_DIR: worldsDir });
      assert.match(status.stdout + status.stderr, /world .* from http:\/\/127\.0\.0\.1:\d+\/chain\/world\/local\.json \(sha256 [0-9a-f]{16}…\) kept at /);
      const worldId = JSON.parse(served).worldId as string;
      assert.equal(readFileSync(join(worldsDir, `${worldId}.json`), "utf8"), served);
      assert.notEqual(status.code, 0, "no store there yet: the command still ends as it did before, after the world was resolved");
      const refused = await fogaAsync(RPC, ["genesis", "status", "--world", "http://example.invalid/w.json"], { FOGA_WORLDS_DIR: worldsDir });
      assert.notEqual(refused.code, 0);
      assert.match(refused.stdout + refused.stderr, /must be https/);
    } finally {
      server.close();
    }
    const walletDir = join(dir, "wallet");
    const w = ensureWallet(walletDir, { name: "t" });
    const identity = w.wallet.addresses.signer;
    const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true });
    const faucet = new Wallet(anvilKeys().W, provider);

    // --- the funding gate: nothing is sent while the identity holds less than it needs
    await assert.rejects(runJoin({ world: worldPath, rpc: RPC, wallet: walletDir, dir: join(dir, "cell"), minWei: parseEther("0.5"), wait: false, listen: null, log }), /not funded yet[\s\S]*needs 0\.5/);
    assert.ok(!existsSync(join(dir, "cell", "cell.ops.sqlite")) || !readFileSync(join(dir, "cell", "cell.config.json"), "utf8").includes('"account"'), "no birth before the funding");
    assert.match(fundingMessage({ address: identity, chain: null, network: "sepolia", chainId: 11155111, balanceWei: 0n, minWei: parseEther("0.03") }), /fund .* on sepolia .* 0\.03 ETH/);
    await (await faucet.sendTransaction({ to: identity, value: parseEther("1") })).wait();

    // --- the join: served, then stopped (--exit)
    const port = await freePort();
    const first = await runJoin({ world: worldPath, rpc: RPC, wallet: walletDir, dir: join(dir, "cell"), listen: `127.0.0.1:${port}`, exit: true, log, out: () => {} });
    try {
      assert.equal(first.resumed, true, "the refused attempt left the cell configured; the funded one resumes it");
      assert.equal(first.network, "anvil");
      assert.match(first.account, /^0x[0-9a-fA-F]{40}$/);
      assert.ok(first.agentId, "an ERC-8004 agent id");
      assert.equal(first.nodeUrl, `http://127.0.0.1:${port}`);
      const cfg = JSON.parse(readFileSync(first.configPath, "utf8"));
      assert.deepEqual(Object.keys(cfg.skills.held).sort(), ["finch-extract-verify", "foga-probe"], "both packaged skills minted");
      assert.deepEqual([...cfg.skills.offered].sort(), ["finch-extract-verify", "foga-probe"], "and offered");
      assert.equal(cfg.world, "world.json", "the world's address book travels with the cell");
      assert.ok(existsSync(join(dir, "cell", "skills", "foga-probe", "manifest.json")), "the skill packages travel with the cell");
      assert.ok(existsSync(join(dir, "cell", "keys", "agent.api-key")) && existsSync(join(dir, "cell", "connect.md")) && existsSync(join(dir, "cell", "join.json")));
      assert.ok(cfg.access.keys.some((k: { id: string }) => k.id === "agent"), "an act-level key for the entrance");
      // the card: what the cell says about itself
      assert.equal(first.card.identity.account, first.account);
      assert.equal(first.card.identity.oneKey, true);
      assert.equal(first.card.skills.filter((s) => s.offered).length, 2);
      assert.ok(first.card.work.taskToken, "where a tender for it is minted");
      assert.match(formatCard(first.card), /I am cell-[0-9a-f]{4}, a FOGA cell on anvil/);
      assert.match(formatCard(first.card), /a tender is the handshake/);
      // served: the manifest and the card answer from the node
      const manifest = (await (await fetch(`${first.nodeUrl}/.well-known/foga-cell.json`)).json()) as { cell: { account: string } };
      assert.equal(manifest.cell.account.toLowerCase(), first.account.toLowerCase());
    } finally {
      await first.stop();
    }

    // --- the same command again: resumed, nothing sent twice
    const store = join(dir, "cell", "cell.ops.sqlite");
    const sizeBefore = readFileSync(store).length;
    const again = await runJoin({ world: worldPath, rpc: RPC, wallet: walletDir, dir: join(dir, "cell"), listen: null, exit: true, log, out: () => {} });
    assert.equal(again.resumed, true);
    assert.equal(again.account, first.account, "the same cell");
    assert.equal(again.agentId, first.agentId);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(store, { readOnly: true });
    const ops = (db.prepare("select count(*) as c from ops").get() as { c: number }).c;
    db.close();
    assert.ok(ops >= 20, `the birth's operations are in the store (${ops})`);
    assert.equal(readFileSync(store).length, sizeBefore, "a resume writes no new operation");

    // --- the social loop: a stranger mints tenders for the cell on the chain; the cell, run with the stub, takes them
    const port2 = await freePort();
    running = await runJoin({ world: worldPath, rpc: RPC, wallet: walletDir, dir: join(dir, "cell"), listen: `127.0.0.1:${port2}`, run: "stub", log, out: () => {} });
    const cfg = JSON.parse(readFileSync(first.configPath, "utf8"));
    const minted = await mintCases({
      worldPath,
      rpc: RPC,
      storePath: join(dir, "demander.sqlite"),
      key: anvilKeys().W,
      cell: first.account,
      schemeId: "0x" + "00".repeat(31) + "01",
      issuers: [faucet.address],
      packages: { "foga-probe": cfg.skills.held["foga-probe"].packageHash, "finch-extract-verify": cfg.skills.held["finch-extract-verify"].packageHash },
      cases: ["a", "b"],
      seed: 3,
      log,
    });
    assert.equal(minted.cases.length, 2);
    const settled = async (tokenId: string) => {
      const r = (await (await fetch(`http://127.0.0.1:${port2}/api/tender_inspect`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tokenId }) })).json()) as { ok: boolean; output?: { submissions: { fulfiller: string; status: number; machineSettled: boolean }[] } };
      const mine = r.output?.submissions.find((s) => s.fulfiller.toLowerCase() === first.account.toLowerCase());
      return Boolean(mine && mine.status === 1 && mine.machineSettled);
    };
    const deadline = Date.now() + 240_000;
    let done = 0;
    while (Date.now() < deadline) {
      const states = await Promise.all(minted.cases.map((c) => settled(c.tokenId)));
      done = states.filter(Boolean).length;
      if (done === 2) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    assert.equal(done, 2, "both tenders taken by the cell on its own, accepted by the hashlock verifier and settled");
  } finally {
    if (running) await running.stop();
    anvil.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

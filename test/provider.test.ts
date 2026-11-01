import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { PinnedProvider } from "../src/kernel/provider.js";

/**
 * The pinned provider against a mock of a load-balanced endpoint: one "node" is a block behind. State reads at
 * "latest" must be sent at the pin, a node without that block must be retried, and explicit tags left alone.
 */
function mockRpc(): Promise<{ server: Server; url: string; calls: { method: string; params: any[] }[]; state: { tip: number; laggingAnswers: number } }> {
  const calls: { method: string; params: any[] }[] = [];
  const state = { tip: 100, laggingAnswers: 0, laggingHead: 99 };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const batch = JSON.parse(body);
      const requests = Array.isArray(batch) ? batch : [batch];
      const answers = requests.map((r: any) => {
        calls.push({ method: r.method, params: r.params });
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: r.id, result });
        const err = (message: string) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32000, message } });
        switch (r.method) {
          case "eth_chainId":
            return ok("0x7a69");
          case "eth_blockNumber":
            return ok("0x" + state.tip.toString(16));
          case "eth_call": {
            const tag = r.params[1];
            if (tag === "latest") return ok("0x" + "00".repeat(31) + "aa"); // the stale answer a lagging node would give
            const n = parseInt(tag, 16);
            if (n > state.laggingHead && state.laggingAnswers > 0) {
              state.laggingAnswers--;
              return err("header not found"); // this request landed on a node whose head is laggingHead
            }
            return ok("0x" + "00".repeat(31) + "bb");
          }
          case "eth_getBalance":
            return ok(r.params[1] === "0x64" ? "0x10" : "0x1");
          case "eth_getTransactionCount":
            return ok(r.params[1] === "pending" ? "0x7" : "0x6");
          default:
            return err(`unsupported ${r.method}`);
        }
      });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(batch) ? answers : answers[0]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any).port;
      resolve({ server, url: `http://127.0.0.1:${port}`, calls, state });
    });
  });
}

test("state reads at latest are pinned to the highest block seen and retried past a lagging node", async () => {
  const { server, url, calls, state } = await mockRpc();
  const provider = new PinnedProvider(url, 31337, { staticNetwork: true, cacheTimeout: -1 });
  provider.settleMs = 5_000;
  try {
    assert.equal(provider.pin, 0);
    // before any block is seen, reads pass through as they are
    const before = await provider.call({ to: "0x" + "11".repeat(20), data: "0x" });
    assert.equal(before, "0x" + "00".repeat(31) + "aa");
    assert.equal(calls.find((c) => c.method === "eth_call")!.params[1], "latest");

    // the block number moves the pin; a read now goes at that block, and a lagging node's refusal is retried
    assert.equal(await provider.getBlockNumber(), 100);
    assert.equal(provider.pin, 100);
    state.laggingAnswers = 2;
    const pinned = await provider.call({ to: "0x" + "11".repeat(20), data: "0x" });
    assert.equal(pinned, "0x" + "00".repeat(31) + "bb");
    const pinnedCalls = calls.filter((c) => c.method === "eth_call" && c.params[1] === "0x64");
    assert.equal(pinnedCalls.length, 3, "two refusals, then the answer");
    assert.equal(state.laggingAnswers, 0);

    // balances read at the pin; the pending nonce is left alone; an explicit tag is left alone
    assert.equal(await provider.getBalance("0x" + "22".repeat(20)), 16n);
    assert.equal(await provider.getTransactionCount("0x" + "22".repeat(20), "pending"), 7);
    await provider.call({ to: "0x" + "11".repeat(20), data: "0x", blockTag: 42 });
    assert.ok(calls.some((c) => c.method === "eth_call" && c.params[1] === "0x2a"));

    // the pin never moves backwards on its own
    state.tip = 90;
    await provider.getBlockNumber();
    assert.equal(provider.pin, 100);
    provider.advanceTo(120);
    assert.equal(provider.pin, 120);

    // a pin ahead of every node (an outlier's head): after the retries the head is sampled and the pin lowered
    state.tip = 100;
    state.laggingHead = 100; // every node has block 100, nobody has 120
    state.laggingAnswers = 1_000;
    provider.settleMs = 600;
    const events: any[] = [];
    provider.onLag = (e) => events.push(e);
    const repinned = await provider.call({ to: "0x" + "11".repeat(20), data: "0x" });
    assert.equal(repinned, "0x" + "00".repeat(31) + "bb");
    assert.equal(provider.pin, 100);
    assert.equal(events.length, 1);
    assert.equal(events[0].outcome, "re-pinned");
    assert.match(events[0].nodeError, /header not found/);
    assert.ok(!calls.some((c) => c.method === "eth_call" && c.params[1] === "latest" && calls.indexOf(c) > 3), "never read at latest once pinned");

    // a block the endpoint reports but no node serves the state of: raised with the node's words, never answered from latest
    state.tip = 100;
    state.laggingHead = 99;
    provider.pin = 100;
    state.laggingAnswers = 1_000;
    await assert.rejects(() => provider.call({ to: "0x" + "11".repeat(20), data: "0x" }), /refused .* by the endpoint: .*header not found/);
    assert.equal(events.at(-1).outcome, "raised");
  } finally {
    provider.destroy();
    server.close();
  }
});

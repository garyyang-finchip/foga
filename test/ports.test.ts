import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { test } from "node:test";
import { nextFreePort, portInUse } from "../src/demo/anvil.js";

/** The port fallback a quickstart uses when its defaults are taken — offline, a dummy listener standing in for a served cell. */
function hold(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(port, "127.0.0.1", () => resolve(s));
  });
}

test("ports: the next free port skips what is held, and a held port reads as in use", async () => {
  const base = 18700 + Math.floor(Math.random() * 200);
  const a = await hold(base);
  const b = await hold(base + 1);
  try {
    assert.equal(await portInUse(base), true);
    assert.equal(await nextFreePort(base), base + 2, "the first two are held");
    assert.equal(await nextFreePort(base, 2), null, "two tries over two held ports: none");
    assert.equal(await nextFreePort(base + 2), base + 2, "a free port is itself");
  } finally {
    a.close();
    b.close();
  }
});

// Runs a FOGA probe plan against a JSON-RPC endpoint and prints the results JSON.
// usage (node 18+): node relay.mjs <rpc-url> <probe.json> > results.json
import { readFileSync } from "node:fs";
const [rpc, planPath] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, "utf8"));
(async () => {
  const results = {};
  for (let i = 0; i < plan.requests.length; i += 20) {
    const batch = plan.requests.slice(i, i + 20);
    const body = batch.map((r, j) => ({ jsonrpc: "2.0", id: j, method: r.method, params: r.params }));
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const arr = await res.json();
    for (const item of Array.isArray(arr) ? arr : [arr]) {
      const req = batch[item.id];
      results[req.key] = item.error ? { error: String(item.error.message || item.error) } : { result: item.result };
    }
  }
  process.stdout.write(JSON.stringify({ schema: "foga.probe-results/1", worldId: plan.worldId, at: new Date().toISOString(), rpc, results }, null, 2));
})();

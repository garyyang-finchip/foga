import { Interface, JsonRpcProvider } from "ethers";
import type { Bundle } from "../bundle/types.js";
import type { WorldFile } from "../world/types.js";
import { READOUTS, WIRING_CHECKS } from "./checks.js";

/**
 * A doctor run is split in two: a deterministic probe plan (every JSON-RPC request the doctor would make,
 * derived from the world file and the bundle alone) and its execution, which can happen live against an
 * RPC or be replayed from results collected elsewhere (a relay, a pinned-block archive, CI).
 */
export interface ProbeRequest {
  key: string;
  method: "eth_chainId" | "eth_blockNumber" | "eth_getCode" | "eth_call";
  params: unknown[];
  note?: string;
}

export interface ProbePlan {
  schema: "foga.probe/1";
  worldId: string;
  chainId: number;
  bundleHash: string;
  requests: ProbeRequest[];
}

export type ProbeOutcome = { result: string } | { error: string };

export interface ProbeResults {
  schema: "foga.probe-results/1";
  worldId: string;
  at: string;
  rpc: string;
  results: Record<string, ProbeOutcome>;
}

export function buildProbePlan(world: WorldFile, bundle: Bundle): ProbePlan {
  const requests: ProbeRequest[] = [
    { key: "chainId", method: "eth_chainId", params: [] },
    { key: "blockNumber", method: "eth_blockNumber", params: [] },
  ];
  const ifacesByRepo = new Map<string, { name: string; id: string }[]>();
  for (const c of Object.values(bundle.contracts)) {
    if (c.kind === "interface" && c.interfaceId) {
      const l = ifacesByRepo.get(c.repo) ?? [];
      l.push({ name: c.name, id: c.interfaceId });
      ifacesByRepo.set(c.repo, l);
    }
  }
  const erc165 = new Interface(["function supportsInterface(bytes4) view returns (bool)"]);

  for (const [id, entry] of Object.entries(world.contracts)) {
    requests.push({ key: `code:${id}`, method: "eth_getCode", params: [entry.address, "latest"] });
    const art = entry.bundleKey ? bundle.contracts[entry.bundleKey] : undefined;
    if (!art || !art.abi.some((f: any) => f.type === "function" && f.name === "supportsInterface")) continue;
    requests.push({ key: `iface:${id}:erc165`, method: "eth_call", params: [{ to: entry.address, data: erc165.encodeFunctionData("supportsInterface", ["0x01ffc9a7"]) }, "latest"] });
    for (const iface of ifacesByRepo.get(art.repo) ?? []) {
      requests.push({ key: `iface:${id}:${iface.name}`, method: "eth_call", params: [{ to: entry.address, data: erc165.encodeFunctionData("supportsInterface", [iface.id]) }, "latest"], note: iface.id });
    }
  }

  for (const check of WIRING_CHECKS) {
    const subject = world.contracts[check.subject];
    if (!subject) continue;
    const art = subject.bundleKey ? bundle.contracts[subject.bundleKey] : undefined;
    if (!art || !art.abi.some((f: any) => f.type === "function" && f.name === check.fn)) continue;
    const args = check.args ? check.args(world) : [];
    if (args === null) continue;
    const data = new Interface(art.abi).encodeFunctionData(check.fn, args);
    requests.push({ key: `wire:${check.subject}:${check.label ?? check.fn}`, method: "eth_call", params: [{ to: subject.address, data }, "latest"] });
  }
  for (const r of READOUTS) {
    const subject = world.contracts[r.subject];
    const art = subject?.bundleKey ? bundle.contracts[subject.bundleKey] : undefined;
    if (!subject || !art || !art.abi.some((f: any) => f.type === "function" && f.name === r.fn)) continue;
    const data = new Interface(art.abi).encodeFunctionData(r.fn, []);
    requests.push({ key: `readout:${r.subject}:${r.fn}`, method: "eth_call", params: [{ to: subject.address, data }, "latest"] });
  }
  return { schema: "foga.probe/1", worldId: world.worldId, chainId: world.chainId, bundleHash: bundle.hash, requests };
}

export async function executeProbeLive(plan: ProbePlan, rpc: string, concurrency = 8): Promise<ProbeResults> {
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  const results: Record<string, ProbeOutcome> = {};
  const queue = [...plan.requests];
  const worker = async () => {
    for (;;) {
      const req = queue.shift();
      if (!req) return;
      try {
        const result = await provider.send(req.method, req.params);
        results[req.key] = { result: typeof result === "string" ? result : JSON.stringify(result) };
      } catch (e: any) {
        results[req.key] = { error: e?.shortMessage ?? e?.message ?? String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { schema: "foga.probe-results/1", worldId: plan.worldId, at: new Date().toISOString(), rpc, results };
}

/** Minimal browser/relay-side executor, emitted as text so a relay without this package can run the plan. */
export const RELAY_SCRIPT = `// Runs a FOGA probe plan against a JSON-RPC endpoint and prints the results JSON.
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
`;

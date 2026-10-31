import assert from "node:assert/strict";
import { test } from "node:test";
import { keccakJcs } from "../src/core/canonical.js";
import { METHOD_KIND, checkReceipt, realizedNetCashFlowMethod, receiptHash, totals, type ChainView, type Receipt } from "../src/core/measure.js";

const A = "0x663F3ad617193148711d28f5334eE4Ed07016602";
const S = "0x057ef64E23666F000b34aE31332854aCBd1c8544";
const methodHash = keccakJcs(realizedNetCashFlowMethod());

function receipt(unitId: string, boundary: string, inflows: Receipt["inflows"], gas = 1000n): Receipt {
  return {
    schema: "foga.measurement-receipt/1",
    method: "foga.realized-net-cash-flow/1",
    methodHash,
    unit: { registry: "0x0000000000000000000000000000000000000001", unitId, version: 1, name: "u" },
    boundary: { accounts: [boundary], note: "" },
    asset: "eip155:31337/slip44:60",
    denomination: "wei",
    window: { start: 10, end: 20, steps: ["T3"] },
    inflows,
    costs: { gasWei: gas.toString(), operations: 3, payer: "operator", note: "" },
    missing: ["model fees"],
    totals: totals(inflows, gas),
    measurer: "eip155:31337:0x0000000000000000000000000000000000000008",
  };
}

/** A chain where tender 1/1 paid A 1000 wei, tender 2/1 paid the swarm account 2000 wei, and call 3/1 was refunded. */
const chain: ChainView = {
  descriptor: async (h) => (h === methodHash ? { kind: METHOD_KIND, publisher: "0x0000000000000000000000000000000000000008" } : null),
  latestVersion: async () => 1,
  settled: async (inflow) => {
    if (inflow.ref === "erc8414:T/1/1") return { recipient: A, amount: 1000n, settled: true };
    if (inflow.ref === "erc8414:T/2/1") return { recipient: S, amount: 2000n, settled: true };
    if (inflow.ref === "erc8471:E/3/1") return { recipient: A, amount: 500n, settled: false };
    return null;
  },
};

test("a receipt whose counted inflows settled inside the boundary passes; excluded items need a reason", async () => {
  const r = receipt("1", A, [
    { ref: "erc8414:T/1/1", source: "tender", recipient: A, amount: "1000", status: "counted" },
    { ref: "erc8471:E/3/1", source: "call", recipient: A, amount: "0", status: "excluded", reason: "refunded by ruling" },
  ]);
  const c = await checkReceipt(r, [], chain);
  assert.equal(c.pass, true, JSON.stringify(c.lines.filter((l) => !l.pass)));
  assert.equal(c.receiptHash, receiptHash(r));
  assert.equal(r.totals.netWei, "0");
});

test("an inflow to an account outside the boundary, or counted twice across receipts, fails", async () => {
  const swarm = receipt("2", S, [{ ref: "erc8414:T/2/1", source: "tender", recipient: S, amount: "2000", status: "counted" }], 0n);
  const greedy = receipt("1", A, [
    { ref: "erc8414:T/1/1", source: "tender", recipient: A, amount: "1000", status: "counted" },
    { ref: "erc8414:T/2/1", source: "tender", recipient: A, amount: "2000", status: "counted" },
  ]);
  const c = await checkReceipt(greedy, [swarm], chain);
  assert.equal(c.pass, false);
  assert.equal(c.lines.find((l) => l.rule === "inflow.erc8414:T/2/1")?.pass, false);
  assert.equal(c.lines.find((l) => l.rule === "once")?.pass, false);
  assert.equal(c.lines.find((l) => l.rule === "totals.inflows")?.pass, false, "the chain does not confirm 3000 wei inside the boundary");
  const fine = await checkReceipt(swarm, [receipt("1", A, [{ ref: "erc8414:T/1/1", source: "tender", recipient: A, amount: "1000", status: "counted" }])], chain);
  assert.equal(fine.pass, true);
});

test("an unsettled inflow cannot be counted; an unregistered method and a value field are refused", async () => {
  const held = receipt("1", A, [{ ref: "erc8471:E/3/1", source: "call", recipient: A, amount: "500", status: "counted" }]);
  const c1 = await checkReceipt(held, [], chain);
  assert.equal(c1.lines.find((l) => l.rule === "inflow.erc8471:E/3/1")?.pass, false);
  const foreign = { ...receipt("1", A, []), methodHash: keccakJcs({ other: true }) };
  const c2 = await checkReceipt(foreign, [], chain);
  assert.equal(c2.lines.find((l) => l.rule === "method.registered")?.pass, false);
  assert.equal(c2.lines.find((l) => l.rule === "method.named")?.pass, false);
  const valued = { ...receipt("1", A, []), unit: { registry: "0x0000000000000000000000000000000000000001", unitId: "1", version: 1, name: "u", value: "1" } } as unknown as Receipt;
  const c3 = await checkReceipt(valued, [], chain);
  assert.equal(c3.lines.find((l) => l.rule === "no-value")?.pass, false);
});

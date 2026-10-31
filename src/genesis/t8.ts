import { getAddress } from "ethers";
import { accountRef, dataUriJcs, keccakJcs } from "../core/canonical.js";
import { AssertionKind, METHOD_KIND, checkReceipt, observationPayload, realizedNetCashFlowMethod, receiptHash, receiptUri, totals, type ChainView, type Inflow, type Receipt } from "../core/measure.js";
import type { Genesis } from "./scenario.js";

/**
 * T8 — value, as measured: realized net cash flow receipts (ERC-8454 observation profile), asserted by E, an
 * independent measurer, and checked by a deterministic resolver.
 *  (1) E registers the method descriptor foga.realized-net-cash-flow/1 once.
 *  (2) The receipt for cell A's unit over T3-T7: the tender rewards and the released escrow settlement that
 *      reached A's account are counted; the refunded call and the operator key's own payout are shown and
 *      excluded; the cost is the gas A's keys paid for the account's operations; model fees are missing, not zero.
 *  (3) The receipt for the swarm unit over T4-T5: the two tender payouts to the swarm account; the members' own
 *      accounts are outside the boundary, and so is the gas their keys paid.
 *  (4) The resolver recomputes both from the chain and passes them; a receipt that counts the swarm's tender for
 *      A's unit fails the boundary and the double-count rules; a receipt citing an unregistered method is refused.
 * No field of a receipt states a value.
 */
export async function t8(g: Genesis): Promise<void> {
  const k = g.kernel;
  const E = "E";
  const A = g.cell("A");
  const chainId = g.chainId;
  const method = realizedNetCashFlowMethod();
  const methodHash = keccakJcs(method);
  const unitA = BigInt(k.requireFact<string>("T1.A.unitId"));
  const unitSwarm = BigInt(k.requireFact<string>("T4.unitId"));
  const swarmAccount = k.requireFact<string>("T4.swarmAccount");
  const escrow = k.adrf.escrowAddress;
  const tenders = k.tenders.address;

  // --- (1) the method, registered once by E
  const existing = await k.units.descriptorOf(methodHash);
  if (!existing) await k.call("T8.E.method.register", E, k.units.assertionRegistryAddress, k.units.assertions().interface, "registerDescriptor", [methodHash, METHOD_KIND, dataUriJcs(method)]);
  const descriptor = await k.units.descriptorOf(methodHash);
  g.check("T8", "method.registered", descriptor !== null && getAddress(descriptor.publisher) === getAddress(k.address(E)) && descriptor.kind === METHOD_KIND, `descriptor ${methodHash.slice(0, 10)}… (foga.realized-net-cash-flow/1) registered by E ${k.address(E)}`);

  // --- the chain view the resolver reads
  const chain: ChainView = {
    descriptor: async (h) => {
      const d = await k.units.descriptorOf(h);
      return d ? { kind: d.kind, publisher: d.publisher } : null;
    },
    latestVersion: (unitId) => k.units.latestVersion(unitId),
    settled: async (inflow) => {
      const m = /^erc8414:[^/]+\/(\d+)\/(\d+)$/.exec(inflow.ref);
      if (m) {
        const sub = await k.tenders.submissionOf(BigInt(m[1]), BigInt(m[2]));
        const terms = await k.tenders.terms(BigInt(m[1]));
        return { recipient: sub.fulfiller, amount: terms.rewardPerCompletion, settled: sub.status === 1 };
      }
      const e = /^erc8471:[^/]+\/(\d+)\/(\d+)$/.exec(inflow.ref);
      if (e) {
        const call = await k.adrf.call(BigInt(e[1]));
        const s = await k.adrf.settlementOf(BigInt(e[1]), Number(e[2]));
        return { recipient: call.provider, amount: call.amount, settled: s.stateName === "Released" };
      }
      return null;
    },
    assertion: async (id) => {
      const a = await k.units.assertionOf(id);
      if (a.kind === 0) return null;
      const o = await k.units.observationOf(id);
      return { kind: a.kind, profileId: a.profileId, contentHash: a.contentHash, unitId: a.unitId, version: a.version, windowStart: o.windowStart, windowEnd: o.windowEnd };
    },
  };

  const blockTime = async (block: number | null | undefined): Promise<number> => (await g.world.provider.getBlock(block ?? "latest"))!.timestamp;
  /** The gas the given signers paid for the confirmed operations whose keys match, from the chain's receipts. */
  const gasPaid = async (keyPattern: RegExp, signers: string[]): Promise<{ wei: bigint; operations: number }> => {
    let wei = 0n;
    let operations = 0;
    for (const op of k.store.all()) {
      if (op.status !== "confirmed" || !op.txHash || !keyPattern.test(op.key) || !signers.includes(op.signer)) continue;
      const r = await g.world.provider.getTransactionReceipt(op.txHash);
      if (!r) continue;
      wei += r.gasUsed * r.gasPrice;
      operations++;
    }
    return { wei, operations };
  };

  // --- (2) cell A over T3-T7
  const receiptA = await k.memo<Receipt>("T8.receipt.A", async () => {
    const t3 = k.requireFact<string>("T3.tokenId");
    const t3Sub = k.requireFact<string>("T3.submissionId");
    const call1 = k.requireFact<string>("T6.call1.id");
    const call2 = k.requireFact<string>("T6.call2.id");
    const t7 = k.requireFact<string>("T7.tokenId");
    const t7Sub = k.requireFact<string>("T7.A.submissionId");
    const rogue = k.requireFact<{ submissionId: string; fulfiller: string; reward: string }>("T7.unattributed");
    const price = (await k.adrf.call(BigInt(call2))).amount;
    const reward3 = (await k.tenders.terms(BigInt(t3))).rewardPerCompletion;
    const reward7 = (await k.tenders.terms(BigInt(t7))).rewardPerCompletion;
    const inflows: Inflow[] = [
      { ref: `erc8414:${tenders}/${t3}/${t3Sub}`, source: "ERC-8414 tender settlement (T3, foga-probe)", recipient: A.address, amount: reward3.toString(), status: "counted", tx: k.store.get("T3.A.settle")?.txHash ?? null },
      { ref: `erc8471:${escrow}/${call1}/1`, source: "ERC-8471 service call 1 (T6): settlement refunded by ruling", recipient: A.address, amount: "0", status: "excluded", reason: "the settlement was refunded to the client by the enacted ruling; nothing reached the provider", tx: k.store.get("T6.C.call1.enact")?.txHash ?? null },
      { ref: `erc8471:${escrow}/${call2}/1`, source: "ERC-8471 service call 2 (T6): settlement released after the dispute period, withdrawn in T7", recipient: A.address, amount: price.toString(), status: "counted", tx: k.store.get("T7.A.derisk.withdraw")?.txHash ?? null },
      { ref: `erc8414:${tenders}/${t7}/${rogue.submissionId}`, source: "ERC-8414 tender settlement (T7) to the operator key", recipient: rogue.fulfiller, amount: rogue.reward, status: "excluded", reason: "paid to the operator's own key, not through the cell account: not attributable to the unit", tx: k.store.get("T7.operator.settle")?.txHash ?? null },
      { ref: `erc8414:${tenders}/${t7}/${t7Sub}`, source: "ERC-8414 tender settlement (T7, finch-extract-verify)", recipient: A.address, amount: reward7.toString(), status: "counted", tx: k.store.get("T7.A.settle")?.txHash ?? null },
    ];
    const gas = await gasPaid(/^T[3-7]\./, [A.roles.operator, A.roles.owner]);
    const start = await blockTime(k.store.get("T3.B.mint")?.block);
    const end = await k.blockTimestamp();
    return {
      schema: "foga.measurement-receipt/1",
      method: "foga.realized-net-cash-flow/1",
      methodHash,
      unit: { registry: k.units.registryAddress, unitId: unitA.toString(), version: await k.units.latestVersion(unitA), name: "FOGA cell A" },
      boundary: { accounts: [A.address], note: "the cell account only; the operator and owner keys are outside (their payments are not the cell's income; their gas is the cell's cost)" },
      asset: `eip155:${chainId}/slip44:60`,
      denomination: "wei",
      window: { start, end, steps: ["T3", "T4", "T5", "T6", "T7"] },
      inflows,
      costs: { gasWei: gas.wei.toString(), operations: gas.operations, payer: `${accountRef(chainId, A.operatorAddress)} (operator), ${accountRef(chainId, A.ownerAddress)} (owner)`, note: "gas of the account's confirmed operations in the window, at the price paid" },
      missing: ["model and inference fees of the skill runs (not observable on chain)", "the operator's gas for the refused bypass transaction (the operator's own act)"],
      totals: totals(inflows, gas.wei),
      measurer: accountRef(chainId, k.address(E)),
    };
  });

  // --- (3) the swarm unit over T4-T5
  const receiptSwarm = await k.memo<Receipt>("T8.receipt.swarm", async () => {
    const t4 = k.requireFact<string>("T4.tokenId");
    const t5Sub = k.requireFact<string>("T5.submissionId");
    const nd = k.requireFact<string>("T5.nd.tokenId");
    const ndSub = k.requireFact<string>("T5.nd.submissionId");
    const reward4 = (await k.tenders.terms(BigInt(t4))).rewardPerCompletion;
    const rewardNd = (await k.tenders.terms(BigInt(nd))).rewardPerCompletion;
    const inflows: Inflow[] = [
      { ref: `erc8414:${tenders}/${t4}/${t5Sub}`, source: "ERC-8414 judged tender (T5): accepted by FOGA-Council, paid to the swarm account", recipient: swarmAccount, amount: reward4.toString(), status: "counted", tx: k.store.get("T5.execute")?.txHash ?? null },
      { ref: `erc8414:${tenders}/${nd}/${ndSub}`, source: "ERC-8414 judged tender (T5, no decision): claimed after the judgment window, paid to the swarm account", recipient: swarmAccount, amount: rewardNd.toString(), status: "counted", tx: k.store.get("T5.nd.claimUnjudged")?.txHash ?? null },
    ];
    const start = await blockTime(k.store.get("T4.D.mint")?.block);
    const end = await blockTime(k.store.get("T5.nd.claimUnjudged")?.block);
    return {
      schema: "foga.measurement-receipt/1",
      method: "foga.realized-net-cash-flow/1",
      methodHash,
      unit: { registry: k.units.registryAddress, unitId: unitSwarm.toString(), version: await k.units.latestVersion(unitSwarm), name: "FOGA swarm (A, B, C)" },
      boundary: { accounts: [swarmAccount], note: "the swarm account's receipts and payments; the members' own accounts and keys are outside" },
      asset: `eip155:${chainId}/slip44:60`,
      denomination: "wei",
      window: { start, end, steps: ["T4", "T5"] },
      inflows,
      costs: { gasWei: "0", operations: 0, payer: "none inside the boundary", note: "the swarm account paid no gas itself; the members' keys paid for its transactions, outside the boundary" },
      missing: ["gas paid by the members' keys for the swarm account's transactions", "model and inference fees of the deliverable"],
      totals: totals(inflows, 0n),
      measurer: accountRef(chainId, k.address(E)),
    };
  });

  // the assertions: E, an independent measurer (not the units' controller)
  const assertInput = (r: Receipt) => ({ kind: AssertionKind.Observation, unitId: BigInt(r.unit.unitId), version: r.unit.version, profileId: methodHash, contentHash: receiptHash(r), contentURI: receiptUri(r), validFrom: 0, validUntil: 0, supersedes: "0x" + "00".repeat(32), payload: observationPayload(receiptHash(r), r.window.start, r.window.end) });
  const opA = await k.call("T8.E.assert.A", E, k.units.assertionRegistryAddress, k.units.assertions().interface, "assertStatement", [assertInput(receiptA)]);
  const assertionA = k.units.assertionIdFromReceipt(opA.receipt);
  const opS = await k.call("T8.E.assert.swarm", E, k.units.assertionRegistryAddress, k.units.assertions().interface, "assertStatement", [assertInput(receiptSwarm)]);
  const assertionS = k.units.assertionIdFromReceipt(opS.receipt);
  k.setFact("T8.assertions", { A: assertionA, swarm: assertionS });
  const storedA = await k.units.assertionOf(assertionA);
  g.check("T8", "assertion.A", storedA.kind === AssertionKind.Observation && storedA.byController === false && getAddress(storedA.asserter) === getAddress(k.address(E)) && storedA.contentHash === receiptHash(receiptA), `assertion ${assertionA.slice(0, 10)}… on unit ${unitA}: Observation by E (not the controller), contentHash = keccak(JCS(receipt))`);

  // --- (4) the resolver
  const checkA = await checkReceipt(receiptA, [receiptSwarm], chain, assertionA);
  const checkS = await checkReceipt(receiptSwarm, [receiptA], chain, assertionS);
  k.setFact("T8.checks", { A: checkA, swarm: checkS });
  g.check("T8", "resolver.A", checkA.pass, `receipt A: ${checkA.lines.filter((l) => l.pass).length}/${checkA.lines.length} rules pass; inflows ${receiptA.totals.inflowsWei} wei, gas ${receiptA.totals.costsWei} wei over ${receiptA.costs.operations} operations, net ${receiptA.totals.netWei} wei; missing: ${receiptA.missing.length} item(s)`);
  g.check("T8", "resolver.swarm", checkS.pass, `receipt swarm: ${checkS.lines.filter((l) => l.pass).length}/${checkS.lines.length} rules pass; inflows ${receiptSwarm.totals.inflowsWei} wei to the swarm account; gas outside the boundary listed as missing`);
  for (const [name, c] of [["A", checkA], ["swarm", checkS]] as const) for (const l of c.lines) if (!l.pass) g.log(`    ${name} ${l.rule}: ${l.detail}`);

  // the boundary case: the swarm's tender counted for A's unit as well
  const swarmInflow = receiptSwarm.inflows[0];
  const bad: Receipt = { ...receiptA, inflows: [...receiptA.inflows, { ...swarmInflow, recipient: A.address, source: `${swarmInflow.source} (wrongly attributed to A)` }] };
  bad.totals = totals(bad.inflows, BigInt(receiptA.costs.gasWei));
  const checkBad = await checkReceipt(bad, [receiptSwarm], chain);
  const boundaryLine = checkBad.lines.find((l) => l.rule === `inflow.${swarmInflow.ref}`);
  const onceLine = checkBad.lines.find((l) => l.rule === "once");
  g.check("T8", "resolver.doubleCount", !checkBad.pass && boundaryLine?.pass === false && onceLine?.pass === false, `the swarm's tender counted for A: boundary rule fails (${boundaryLine?.detail}); once rule fails (${onceLine?.detail})`);

  // an unregistered method is refused
  const foreign: Receipt = { ...receiptA, method: "someone-else/1", methodHash: keccakJcs({ method: "someone-else/1" }) };
  const checkForeign = await checkReceipt(foreign, [], chain);
  g.check("T8", "resolver.unregistered", !checkForeign.pass && checkForeign.lines.find((l) => l.rule === "method.registered")?.pass === false, `a receipt citing an unregistered method is refused: ${checkForeign.lines.find((l) => l.rule === "method.registered")?.detail}`);

  // no receipt states a value
  g.check("T8", "no.value", checkA.lines.find((l) => l.rule === "no-value")?.pass === true && checkS.lines.find((l) => l.rule === "no-value")?.pass === true, "neither receipt carries a value, price, worth, valuation or score field");

  k.evidence("T8", "measurement", {
    method: { hash: methodHash, kind: METHOD_KIND, publisher: k.address(E) },
    receipts: { A: receiptA, swarm: receiptSwarm },
    assertions: { A: assertionA, swarm: assertionS },
    checks: { A: checkA, swarm: checkS, doubleCount: checkBad.lines.filter((l) => !l.pass), unregistered: checkForeign.lines.filter((l) => !l.pass) },
    txs: { method: k.store.get("T8.E.method.register")?.txHash ?? null, assertA: opA.txHash, assertSwarm: opS.txHash },
  });
}

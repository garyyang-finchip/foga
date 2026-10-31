import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { abi, dataUriJcs, keccakJcs, parseDataUri } from "./canonical.js";

/**
 * Realized net cash flow, measured (ERC-8454 observation profile). A receipt states what was observed inside an
 * economic boundary over a window — inflows with their on-chain references, costs, the items that could not be
 * observed — and never a value. The resolver recomputes the receipt from the chain and checks the boundary, the
 * method registration and double counting across receipts.
 */
export const METHOD_KIND = keccak256(toUtf8Bytes("auf:method-descriptor"));
export const RECEIPT_SCHEMA = "foga.measurement-receipt/1";
export const CHECK_SCHEMA = "foga.measurement-check/1";
export const AssertionKind = { None: 0, Characterization: 1, Observation: 2, Valuation: 3, Extension: 4 } as const;

/** The method FOGA registers once and every receipt cites by its descriptor hash. */
export function realizedNetCashFlowMethod(): Record<string, unknown> {
  return {
    auf: "1.0",
    kind: "method-descriptor",
    name: "foga.realized-net-cash-flow/1",
    profile: "observation",
    summary: "Realized net cash flow of a unit over a window: inflows that settled on chain to accounts inside the unit's economic boundary, minus the gas the unit's own operations paid, in the asset's smallest denomination. Items that cannot be observed on chain are listed as missing, never written as zero. The result is a measurement, not a valuation: no field of a receipt states a value.",
    rules: [
      { id: "boundary", text: "An inflow counts only when its on-chain recipient is an account of the unit's economic boundary." },
      { id: "settled", text: "An inflow counts only once it settled on chain (a tender settlement, a released escrow settlement); pending, held and refunded amounts are shown and not counted." },
      { id: "attribution", text: "A payment to a key of the unit's operator that did not pass through the unit's account is not the unit's inflow." },
      { id: "once", text: "An inflow reference appears in at most one receipt of a set; a settlement counted for two units is a double count." },
      { id: "costs", text: "Costs are the gas of the unit's own operations in the window, as paid; other costs are listed as missing when not observable." },
      { id: "no-value", text: "A receipt carries no value, price, worth or score." },
    ],
    receiptSchema: RECEIPT_SCHEMA,
  };
}

export interface Inflow {
  ref: string;
  source: string;
  recipient: string;
  amount: string;
  status: "counted" | "excluded";
  reason?: string;
  tx?: string | null;
}

export interface Receipt {
  schema: typeof RECEIPT_SCHEMA;
  method: string;
  methodHash: string;
  unit: { registry: string; unitId: string; version: number; name: string };
  boundary: { accounts: string[]; note: string };
  asset: string;
  denomination: string;
  window: { start: number; end: number; steps: string[] };
  inflows: Inflow[];
  costs: { gasWei: string; operations: number; payer: string; note: string };
  missing: string[];
  totals: { inflowsWei: string; costsWei: string; netWei: string };
  measurer: string;
}

export function receiptHash(receipt: Receipt): string {
  return keccakJcs(receipt as unknown as Record<string, unknown>);
}

export function receiptUri(receipt: Receipt): string {
  return dataUriJcs(receipt as unknown as Record<string, unknown>);
}

export function totals(inflows: Inflow[], gasWei: bigint): Receipt["totals"] {
  const inflowsWei = inflows.filter((i) => i.status === "counted").reduce((s, i) => s + BigInt(i.amount), 0n);
  return { inflowsWei: inflowsWei.toString(), costsWei: gasWei.toString(), netWei: (inflowsWei - gasWei).toString() };
}

/** ObservationCore payload: (snapshotHash, windowStart, windowEnd). */
export function observationPayload(snapshotHash: string, windowStart: number, windowEnd: number): string {
  return abi.encode(["bytes32", "uint64", "uint64"], [snapshotHash, windowStart, windowEnd]);
}

export interface CheckLine {
  rule: string;
  pass: boolean;
  detail: string;
}

export interface CheckReport {
  schema: typeof CHECK_SCHEMA;
  receiptHash: string;
  unit: Receipt["unit"];
  lines: CheckLine[];
  pass: boolean;
}

/** What the resolver reads from the chain to re-derive a receipt. */
export interface ChainView {
  /** The registered descriptor for a method hash, or null when none is registered. */
  descriptor(hash: string): Promise<{ kind: string; publisher: string } | null>;
  /** The latest version of a unit. */
  latestVersion(unitId: bigint): Promise<number>;
  /** The on-chain recipient and settled amount of an inflow reference, or null when it cannot be re-derived. */
  settled(inflow: Inflow): Promise<{ recipient: string; amount: bigint; settled: boolean } | null>;
  /** The assertion recorded for the receipt, if any. */
  assertion?(assertionId: string): Promise<{ kind: number; profileId: string; contentHash: string; unitId: bigint; version: number; windowStart: number; windowEnd: number } | null>;
}

const FORBIDDEN = /"(value|price|worth|valuation|score)"\s*:/i;

/**
 * Checks one receipt against the chain and against the other receipts of the set. Deterministic: the same
 * receipts and the same chain state give the same report.
 */
export async function checkReceipt(receipt: Receipt, others: Receipt[], chain: ChainView, assertionId?: string): Promise<CheckReport> {
  const lines: CheckLine[] = [];
  const hash = receiptHash(receipt);

  const d = await chain.descriptor(receipt.methodHash);
  lines.push({ rule: "method.registered", pass: d !== null && d.kind === METHOD_KIND, detail: d ? `descriptor ${receipt.methodHash.slice(0, 10)}… registered by ${d.publisher}` : `descriptor ${receipt.methodHash.slice(0, 10)}… is not registered: the receipt is not resolvable` });
  lines.push({ rule: "method.named", pass: receipt.method === "foga.realized-net-cash-flow/1" && receipt.methodHash === keccakJcs(realizedNetCashFlowMethod()), detail: `method ${receipt.method}, hash ${receipt.methodHash === keccakJcs(realizedNetCashFlowMethod()) ? "matches" : "does not match"} the committed descriptor` });

  const latest = await chain.latestVersion(BigInt(receipt.unit.unitId));
  lines.push({ rule: "unit.version", pass: receipt.unit.version >= 1 && receipt.unit.version <= latest, detail: `unit ${receipt.unit.unitId} version ${receipt.unit.version} (latest ${latest})` });

  lines.push({ rule: "window", pass: receipt.window.end >= receipt.window.start, detail: `window [${receipt.window.start}, ${receipt.window.end}]` });
  lines.push({ rule: "no-value", pass: !FORBIDDEN.test(JSON.stringify(receipt)), detail: "no value, price, worth, valuation or score field" });

  const boundary = new Set(receipt.boundary.accounts.map((a) => getAddress(a)));
  let counted = 0n;
  for (const inflow of receipt.inflows) {
    const s = await chain.settled(inflow);
    if (inflow.status === "counted") {
      const ok = s !== null && s.settled && boundary.has(getAddress(s.recipient)) && s.amount === BigInt(inflow.amount);
      if (ok) counted += s.amount;
      lines.push({ rule: `inflow.${inflow.ref}`, pass: ok, detail: s ? `${inflow.amount} wei to ${s.recipient}${boundary.has(getAddress(s.recipient)) ? " (inside the boundary)" : " (OUTSIDE the boundary)"}, settled ${s.settled}, chain amount ${s.amount}` : `could not be re-derived from the chain` });
    } else {
      const outside = s === null || !boundary.has(getAddress(s.recipient)) || !s.settled;
      lines.push({ rule: `excluded.${inflow.ref}`, pass: outside || Boolean(inflow.reason), detail: `${inflow.amount} wei excluded: ${inflow.reason ?? "no reason given"}` });
    }
  }
  lines.push({ rule: "totals.inflows", pass: counted.toString() === receipt.totals.inflowsWei, detail: `counted ${counted} wei; receipt says ${receipt.totals.inflowsWei}` });
  const net = BigInt(receipt.totals.inflowsWei) - BigInt(receipt.totals.costsWei);
  lines.push({ rule: "totals.net", pass: net.toString() === receipt.totals.netWei && receipt.totals.costsWei === receipt.costs.gasWei, detail: `net ${net} wei = inflows - gas ${receipt.costs.gasWei}` });

  // double counting across the set: the same settlement reference counted in two receipts
  const mine = new Set(receipt.inflows.filter((i) => i.status === "counted").map((i) => i.ref));
  const dup: string[] = [];
  for (const o of others) for (const i of o.inflows) if (i.status === "counted" && mine.has(i.ref)) dup.push(`${i.ref} (also counted for unit ${o.unit.unitId})`);
  lines.push({ rule: "once", pass: dup.length === 0, detail: dup.length ? `double count: ${dup.join("; ")}` : `no inflow of this receipt is counted by another receipt of the set (${others.length} other${others.length === 1 ? "" : "s"})` });

  if (assertionId && chain.assertion) {
    const a = await chain.assertion(assertionId);
    const ok = a !== null && a.kind === AssertionKind.Observation && a.profileId === receipt.methodHash && a.contentHash === hash && a.unitId === BigInt(receipt.unit.unitId) && a.version === receipt.unit.version && a.windowStart === receipt.window.start && a.windowEnd === receipt.window.end;
    lines.push({ rule: "assertion", pass: ok, detail: a ? `assertion ${assertionId.slice(0, 10)}…: kind ${a.kind}, profile ${a.profileId === receipt.methodHash ? "= method" : "differs"}, contentHash ${a.contentHash === hash ? "= receipt" : "differs"}, window ${a.windowStart}-${a.windowEnd}` : `assertion ${assertionId.slice(0, 10)}… not found` });
  }

  return { schema: CHECK_SCHEMA, receiptHash: hash, unit: receipt.unit, lines, pass: lines.every((l) => l.pass) };
}

export function receiptFromUri(uri: string): Receipt {
  return parseDataUri(uri) as unknown as Receipt;
}

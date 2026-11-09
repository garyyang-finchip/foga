import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Interface } from "ethers";
import {
  AIFP_INTERFACE_IDS,
  OUTCOME,
  allOf,
  anyOf,
  canonicalAddressSubject,
  canonicalErc8004Subject,
  compilePredicate,
  familyIdOf,
  labelIdOf,
  outcomeName,
  paradigmIdOf,
  predicateNodes,
  subjectOfAddress,
  subjectOfCanonical,
  subjectOfDid,
  subjectOfErc8004,
  subjectOfExt,
  validateDescriptor,
  descriptorBundle,
} from "../src/core/aifp.js";
import { CELL_SOURCE, TENDER_MARKET, fogaDescriptor, fogaDescriptorStatic, marketTransportBinding } from "../src/core/paradigms.js";
import { loadBundle } from "../src/bundle/load.js";

/**
 * ERC-8489 held to its published vectors (test/fixtures/aifp, copied from the locked upstream commit): subject references,
 * predicate node arrays with their ABI encodings and hashes, the four-valued composition table, the ERC-165 ids as the
 * bundle computes them, and the canonical bytes and paradigm ids of every example descriptor — plus FOGA's own two
 * descriptors, which must validate, and the upstream invalid examples, which must not.
 */
const FIX = join("test", "fixtures", "aifp");
const read = <T>(f: string): T => JSON.parse(readFileSync(join(FIX, f), "utf8")) as T;

test("subject references: the canonical strings and their keccak256 agree with the vectors", () => {
  const v = read<{ vectors: { kind: string; chainId?: number; address?: string; registry?: string; agentId?: number | string; method?: string; id?: string; namespace?: string; identifier?: string; canonical: string; ref: string }[] }>("subject-refs.json");
  assert.ok(v.vectors.length >= 5);
  for (const x of v.vectors) {
    let canonical: string;
    let ref: string;
    if (x.kind === "eip155-address") {
      canonical = canonicalAddressSubject(x.chainId!, x.address!);
      ref = subjectOfAddress(x.chainId!, x.address!);
    } else if (x.kind === "erc8004") {
      canonical = canonicalErc8004Subject(x.chainId!, x.registry!, x.agentId!);
      ref = subjectOfErc8004(x.chainId!, x.registry!, x.agentId!);
    } else if (x.kind === "did") {
      canonical = x.canonical;
      ref = subjectOfDid(x.method!, x.id!);
    } else {
      canonical = x.canonical;
      ref = subjectOfExt(x.namespace!, x.identifier!);
    }
    assert.equal(canonical, x.canonical, `${x.kind}: canonical string`);
    assert.equal(ref, x.ref, `${x.kind}: reference`);
    assert.equal(subjectOfCanonical(x.canonical), x.ref, `${x.kind}: reference of the canonical string`);
  }
  // mixed case canonicalizes to lowercase; an address is never left-padded into a bytes32
  assert.equal(subjectOfAddress(1, "0xAbCDef0123456789aBCDeF0123456789AbCdEf01"), subjectOfAddress(1, "0xabcdef0123456789abcdef0123456789abcdef01"));
  assert.throws(() => subjectOfExt("FinChip", "x"), /lowercase/);
});

test("predicates: breadth-first node arrays, ABI encodings and hashes agree with the vectors", () => {
  const v = read<{ vectors: { name: string; json: unknown; nodes: { kind: number; childStart: number; childCount: number; verifier: string; ref: string; params: string }[]; encoding: string; predicateHash: string }[] }>("predicate-encoding.json");
  assert.ok(v.vectors.length >= 8);
  for (const x of v.vectors) {
    const c = compilePredicate(x.json);
    assert.deepEqual(
      c.nodes.map((n) => ({ kind: n.kind, childStart: n.childStart, childCount: n.childCount, verifier: n.verifier, ref: n.ref, params: n.params })),
      x.nodes.map((n) => ({ kind: n.kind, childStart: n.childStart, childCount: n.childCount, verifier: n.verifier.toLowerCase(), ref: n.ref.toLowerCase(), params: n.params.toLowerCase() })),
      `${x.name}: nodes`,
    );
    assert.equal(c.encoding.toLowerCase(), x.encoding.toLowerCase(), `${x.name}: encoding`);
    assert.equal(c.hash.toLowerCase(), x.predicateHash.toLowerCase(), `${x.name}: hash`);
  }
  // the ERC's nested example: allOf(allowlist, anyOf(open, external), anyOf(member, allOf(stake, decision))) allocates breadth-first
  const nested = predicateNodes({
    allOf: [
      { allowlist: { set: "0x0000000000000000000000000000000000000001" } },
      { anyOf: [{ open: true }, { external: { verifier: "0x0000000000000000000000000000000000000002" } }] },
      { anyOf: [{ member: { verifier: "0x0000000000000000000000000000000000000003", group: "0x" + "11".repeat(32) } }, { allOf: [{ stake: { verifier: "0x0000000000000000000000000000000000000004", chain: "eip155:1", contract: "0x0000000000000000000000000000000000000005", asset: "native", minAmount: "1", period: "active" } }, { decision: { verifier: "0x0000000000000000000000000000000000000006", decision: "0x" + "22".repeat(32) } }] }] },
    ],
  });
  assert.deepEqual(nested.map((n) => [n.kind, n.childStart, n.childCount]), [[3, 1, 3], [1, 0, 0], [4, 4, 2], [4, 6, 2], [0, 0, 0], [2, 0, 0], [8, 0, 0], [3, 8, 2], [6, 0, 0], [9, 0, 0]]);
  assert.throws(() => compilePredicate({ allOf: [] }), /non-empty/);
  assert.throws(() => compilePredicate({ open: false }), /open must be true/);
  assert.throws(() => compilePredicate({ gossip: true }), /unknown predicate key/);
});

test("outcomes: the four-valued composition table", () => {
  const v = read<{ vectors: { inputs: number[]; allOf: number; anyOf: number }[] }>("outcome-tables.json");
  assert.equal(v.vectors.length, 25);
  for (const x of v.vectors) {
    assert.equal(allOf(x.inputs), x.allOf, `allOf(${x.inputs})`);
    assert.equal(anyOf(x.inputs), x.anyOf, `anyOf(${x.inputs})`);
    // the tables are symmetric
    assert.equal(allOf([...x.inputs].reverse()), x.allOf);
    assert.equal(anyOf([...x.inputs].reverse()), x.anyOf);
  }
  assert.equal(allOf([7]), OUTCOME.VERIFIER_ERROR, "a value above 3 normalizes to VERIFIER_ERROR");
  assert.equal(outcomeName(2), "UNDETERMINABLE");
  assert.throws(() => allOf([]), /empty/);
});

test("interface ids: the bundle's ERC-8489 interfaces match the published ids", () => {
  const v = read<{ vectors: { name: string; interfaceId: string }[] }>("interface-ids.json");
  const bundle = loadBundle();
  for (const x of v.vectors) {
    const c = bundle.contracts[`aif-paradigm:${x.name}`];
    assert.ok(c, `${x.name} in the bundle`);
    assert.equal(c.interfaceId, x.interfaceId, `${x.name} id`);
    assert.equal(AIFP_INTERFACE_IDS[x.name as keyof typeof AIFP_INTERFACE_IDS], x.interfaceId);
    // and as ethers computes it over the ABI
    const iface = new Interface(c.abi);
    let acc = 0n;
    iface.forEachFunction((f) => (acc ^= BigInt(f.selector)));
    assert.equal("0x" + acc.toString(16).padStart(8, "0"), x.interfaceId);
  }
  assert.ok(bundle.contracts["foga:FogaIdentityVerifier"]?.deployable, "FOGA's identity verifier is in the bundle");
});

test("descriptors: every example validates to its published canonical bytes, id, family, labels and role predicates", () => {
  const v = read<{ vectors: { file: string; family: string; familyId: string; labels: string[]; labelIds: { label: string; id: string }[]; canonical: string; paradigmId: string; rolePredicates?: { role: string; roleBit: number; predicateHash: string }[] }[] }>("paradigm-ids.json");
  assert.equal(v.vectors.length, 17);
  for (const x of v.vectors) {
    const doc = read<unknown>(x.file);
    const r = validateDescriptor(doc);
    assert.equal(r.ok, true, `${x.file}: ${r.errors.join("; ")}`);
    const b = r.bundle!;
    assert.equal(b.canonical, x.canonical, `${x.file}: canonical`);
    assert.equal(b.paradigmId, x.paradigmId, `${x.file}: paradigm id`);
    assert.equal(paradigmIdOf(doc), x.paradigmId);
    assert.equal(b.familyId, x.familyId);
    assert.equal(familyIdOf(x.family), x.familyId);
    assert.deepEqual(b.labelIds, x.labelIds);
    for (const l of x.labels) assert.equal(labelIdOf(l), x.labelIds.find((y) => y.label === l)!.id);
    assert.deepEqual(b.rolePredicates.map((p) => ({ role: p.role, roleBit: p.roleBit, predicateHash: p.predicateHash })), (x.rolePredicates ?? []).map((p) => ({ role: p.role, roleBit: p.roleBit, predicateHash: p.predicateHash })), `${x.file}: role predicates`);
  }
});

test("descriptors: the upstream invalid examples are rejected, each for its reason", () => {
  const dir = join(FIX, "examples", "invalid");
  const reasons: Record<string, RegExp> = { "empty-allof.json": /allOf must be a non-empty array/, "false-label-condition.json": /identification condition does not hold/, "reserved-namespace-label.json": /not a defined named paradigm/, "schema-violation.json": /^schema:/ };
  for (const f of readdirSync(dir)) {
    const r = validateDescriptor(JSON.parse(readFileSync(join(dir, f), "utf8")));
    assert.equal(r.ok, false, `${f} must be rejected`);
    assert.ok(r.errors.some((e) => reasons[f].test(e)), `${f}: ${r.errors.join("; ")}`);
  }
  // the absence rule is an error; the compatibility rules of 5.4 are warnings here, as the upstream validator at the locked
  // commit accepts descriptors that trip them (its blind-review composite is one) and FOGA stays byte-compatible with it
  const source = read<any>("examples/paradigms/source.json");
  const abs = JSON.parse(JSON.stringify(source));
  abs.dimensions.time.absence = "rule-defined";
  assert.match(validateDescriptor(abs).errors.join("; "), /extensions.absence is missing/);
  const bad = JSON.parse(JSON.stringify(source));
  bad.dimensions.ordering.sequencer = "moderator";
  const r1 = validateDescriptor(bad);
  assert.equal(r1.ok, true);
  assert.match(r1.warnings.join("; "), /management.ordering does not contain moderator/);
  const anon = JSON.parse(JSON.stringify(source));
  anon.dimensions.contributorVisibility = "anonymous-qualified";
  const r2 = validateDescriptor(anon);
  assert.equal(r2.ok, true);
  assert.match(r2.warnings.join("; "), /credential predicate/);
});

test("FOGA's own paradigms validate, carry their labels, and the market's id follows the world's addresses", () => {
  const source = fogaDescriptorStatic(CELL_SOURCE);
  const s = validateDescriptor(source);
  assert.equal(s.ok, true, s.errors.join("; "));
  assert.deepEqual(s.warnings, [], "no undeclared label condition holds for the cell-source paradigm");
  assert.deepEqual(s.bundle!.labels, ["aifp:paradigm/source/v1", "aifp:paradigm/archive/v1"]);
  assert.equal(s.bundle!.family, "foga");
  assert.deepEqual(s.bundle!.rolePredicates.map((p) => p.role), ["discover", "observe", "redistribute"]);
  assert.equal(s.bundle!.rolePredicates[0].predicateHash, "0xd9748b88542c28c751ee2cfb24a3b2ab8d9ce5e6f55c9df01f4a1a4bbf53a91e", "open");
  // the same bytes on every world: the id the upstream canonical validator computed for this file
  assert.equal(s.bundle!.paradigmId, "0xc5a7f453e921deadfc3c13e2db540a60487ce40946647e3fa83086e23ac55fbe");

  const worldA = { has: () => true, address: (id: string) => (id === "identity8004" ? "0x0000000000000000000000000000000000000003" : "0x0000000000000000000000000000000000000002"), chainId: 31337 };
  const market = fogaDescriptor(TENDER_MARKET, worldA);
  const m = validateDescriptor(market);
  assert.equal(m.ok, true, m.errors.join("; "));
  assert.deepEqual(m.warnings, [], "the market carries no reserved label and none applies: submissions are public (not an intake), the verifier's choice is not a select");
  assert.deepEqual(m.bundle!.labels, ["aifp:ext/finchip.ai/tender-market/v1"]);
  assert.deepEqual(m.bundle!.rolePredicates.map((p) => p.role), ["observe", "submit", "respond"]);
  assert.equal(m.bundle!.rolePredicates[1].predicateHash, m.bundle!.rolePredicates[2].predicateHash, "submit and respond take the same identity predicate");
  assert.equal(m.bundle!.paradigmId, "0xad8cb87a4370dd346559838a02159048f165f7214fbab60d9975848bb5df2af9", "the id the upstream validator computed for these addresses");
  const worldB = { ...worldA, address: (id: string) => (id === "identity8004" ? "0x0000000000000000000000000000000000000004" : "0x0000000000000000000000000000000000000002") };
  assert.notEqual(descriptorBundle(fogaDescriptor(TENDER_MARKET, worldB)).paradigmId, m.bundle!.paradigmId, "another registry is another paradigm");
  assert.throws(() => fogaDescriptor(TENDER_MARKET, { has: () => false, address: () => "0x" }), /the world has no/);
  // the market's transport: the TaskToken's events, without delivery records
  const b = marketTransportBinding({ chainId: 31337, address: () => "0x0000000000000000000000000000000000000009" });
  assert.equal(b.kind, 0);
  assert.equal(b.capabilities, 1 | 4 | 128 | 256 | 4096);
  assert.equal(b.capabilities & 64, 0, "no delivery-records");
  const required = (market as any).requiredBindings.capabilities as string[];
  assert.deepEqual(required, ["identity", "push", "history-retention", "late-join-history", "total-order"]);
});

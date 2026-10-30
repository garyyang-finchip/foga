import assert from "node:assert/strict";
import { test } from "node:test";
import { accountRef, dataUri, dataUriJcs, jcs, parseDataUri, sha256Hex } from "../src/core/canonical.js";
import { accountSubjectKey, oneClause, requirementIdOf, scopeKeyOf } from "../src/core/asf.js";
import { descriptorHash } from "../src/core/ard.js";
import { hashlock } from "../src/core/tenders.js";

test("JCS sorts keys, drops undefined, keeps arrays and rejects bigints", () => {
  assert.equal(jcs({ b: 1, a: [true, null, "x"], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(jcs({ "é": 1, "z": 2, "a": 3 }), '{"a":3,"z":2,"é":1}');
  assert.throws(() => jcs({ n: 1n }));
  assert.throws(() => jcs({ n: Number.NaN }));
});

test("data: URIs round-trip and the JCS variant is canonical", () => {
  const doc = { b: 2, a: "1" };
  assert.deepEqual(parseDataUri(dataUri(doc)), doc);
  assert.equal(parseDataUri(dataUriJcs(doc)) && Buffer.from(dataUriJcs(doc).split(",")[1], "base64").toString(), '{"a":"1","b":2}');
});

test("CAIP-10 account references are lower-case and chain-scoped", () => {
  assert.equal(accountRef(31337, "0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266"), "eip155:31337:0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
  assert.equal(accountSubjectKey(1, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"), accountSubjectKey(1, "0xF39FD6E51AAD88F6F4CE6AB8827279CFFFB92266"));
  assert.notEqual(scopeKeyOf({ ref: "a" }), scopeKeyOf({ ref: "b" }));
});

test("ARD descriptorHash ignores publication and resolved members", () => {
  const base = { displayName: "x", description: "y", "value:kind": "agent" };
  const a = descriptorHash({ ...base, "@context": ["c"], identifier: "urn:air:x", trustManifest: { identity: "d" }, "value:status": "Active" });
  const b = descriptorHash(base);
  assert.equal(a.hex, b.hex);
  assert.equal(a.hex, sha256Hex(jcs(base)));
  assert.equal(a.digest, `sha256:${a.hex.slice(2)}`);
});

test("hashlock: resultHash binds the answer to the fulfiller", () => {
  const answer = '{"schema":"foga.probe/1"}';
  const a = hashlock.resultHash(answer, "0x663F3ad617193148711d28f5334eE4Ed07016602");
  const b = hashlock.resultHash(answer, "0x057ef64E23666F000b34aE31332854aCBd1c8544");
  assert.notEqual(a, b);
  assert.equal(hashlock.answerHash(answer), sha256Hex(answer));
});

test("requirementIdOf is deterministic and sensitive to every clause field", () => {
  const p = { specRegistry: "0x84eA74d481Ee0A5332c457a4d796187F6Ba67fEB", specId: "0x" + "11".repeat(32), adopter: "0x663F3ad617193148711d28f5334eE4Ed07016602" };
  const r1 = requirementIdOf(oneClause(p));
  assert.equal(r1, requirementIdOf(oneClause(p)));
  assert.notEqual(r1, requirementIdOf(oneClause({ ...p, versions: [2] })));
  assert.notEqual(r1, requirementIdOf(oneClause({ ...p, interveners: [{ account: p.adopter, rights: 1 }] })));
});

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { councilPolicySpec, familyId } from "../src/core/acdf.js";
import { Activation, Admission, Boundary, Contributions, authorities, bytes32Label, byRole, initiator, none, packHashes, roleId, specHashOf, term } from "../src/core/swarm.js";
import { repoRoot } from "../src/util/fs.js";

const vectors = join(repoRoot(), "vendor", "swarm-ai-framework", "assets", "erc-8447");
const haveVendor = existsSync(join(vectors, "vectors", "charter-hash.json"));

test("role, term and family identifiers follow the upstream naming", () => {
  assert.equal(roleId("coordinator"), "0x4fc13b418c06e66bee8d79228bef6e44cc720286e48578225bdc8c8c0b62c27d");
  assert.equal(roleId("worker"), "0x0e3a19745aa9b7079f93a3673c0bba2e976f355a1a9469cbe536fcb9df620fc1");
  assert.equal(term.payoff("shared"), "0xefad6aa8c92c03410cd7fa4f87ebc00ba64c967137c7b00fb8d0615535809dc9");
  assert.equal(term.topology("partitioned"), "0x1c75a4f5855a46b5822d3307010ad19ab1f3d33adbb9d9804c4f42f5731be03a");
  assert.equal(term.coordination("leader"), "0x3c8fcb23f6e961408b5b5de1fbeaaecf62e20b64949267a3f39105ff0d23482a");
  assert.equal(bytes32Label("execution"), "0x657865637574696f6e0000000000000000000000000000000000000000000000");
  assert.notEqual(familyId("foga.council"), familyId("foga.council.v2"));
});

test("authorities() places entries by decision point and fills the rest with NONE", () => {
  const a = authorities({ ABORT: initiator, REPRESENT: byRole(roleId("coordinator")) });
  assert.equal(a.length, 16);
  assert.deepEqual(a[0], none);
  assert.deepEqual(a[1], initiator);
  assert.equal(a[15].roleId, roleId("coordinator"));
});

test("the council policy's hard cap covers every round and the appeal window", () => {
  const spec = councilPolicySpec({ judges: ["0x" + "11".repeat(20), "0x" + "22".repeat(20), "0x" + "33".repeat(20)], k: 2, window: 86400, appealWindow: 3600, updateAuthority: "0x" + "44".repeat(20), descriptor: { a: 1 } });
  assert.equal(spec.maxTotalDuration, 86400 * 2 + 3600);
  assert.equal(spec.bodies[0].k, 2);
  assert.equal(spec.appealable, 1);
  assert.equal(spec.nodes.length, 1);
});

test("swarm pack hashes match the upstream charter-hash vectors", { skip: !haveVendor && "vendor/swarm-ai-framework not synced" }, () => {
  const v = JSON.parse(readFileSync(join(vectors, "vectors", "charter-hash.json"), "utf8"));
  for (const vec of v.vectors) {
    const pack = JSON.parse(readFileSync(join(vectors, "examples", vec.file), "utf8"));
    const h = packHashes(pack);
    assert.equal(h.charterHash, vec.charterHash, `${vec.file} charterHash`);
    assert.equal(h.objectiveHash, vec.objectiveHash, `${vec.file} objectiveHash`);
    assert.equal(h.commitmentHash, vec.commitmentHash, `${vec.file} commitmentHash`);
  }
});

test("specHashOf matches the upstream spec-hash vectors", { skip: !haveVendor && "vendor/swarm-ai-framework not synced" }, () => {
  const v = JSON.parse(readFileSync(join(vectors, "vectors", "spec-hash.json"), "utf8"));
  for (const vec of v.vectors) {
    const spec = {
      ...vec.spec,
      roles: vec.spec.roles.map((r: any) => ({ ...r, min: Number(r.min), max: Number(r.max) })),
      phases: vec.spec.phases.map((p: any) => ({ ...p, boundary: Number(p.boundary), admission: Number(p.admission), inputWindow: Number(p.inputWindow) })),
      authorities: vec.spec.authorities.map((a: any) => ({ ...a, kind: Number(a.kind) })),
      activation: Number(vec.spec.activation),
      contributions: Number(vec.spec.contributions),
    };
    assert.equal(specHashOf(spec), vec.specHash, vec.name);
  }
  void Activation;
  void Admission;
  void Boundary;
  void Contributions;
});

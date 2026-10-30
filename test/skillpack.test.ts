import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSkillPackage, verifySkillPackage } from "../src/core/pack/skillpack.js";
import { cidString, encode, leafLink } from "../src/core/pack/cbor.js";
import { jcs } from "../src/core/canonical.js";
import { repoRoot } from "../src/util/fs.js";

const vectors = join(repoRoot(), "vendor", "skill-token-standard", "vectors");
const present = existsSync(join(vectors, "public-v1", "vector.json"));

function filesFromVector(dir: string): { files: Record<string, Uint8Array>; vector: any } {
  const vector = JSON.parse(readFileSync(join(dir, "vector.json"), "utf8"));
  const files: Record<string, Uint8Array> = {};
  for (const [path, hex] of Object.entries(vector.leaves as Record<string, string>)) {
    files[path] = new Uint8Array(readFileSync(join(dir, "objects", hex.slice(2))));
  }
  return { files, vector };
}

test("DAG-CBOR encoder: heads, key order and links match the reference rules", () => {
  // shortest heads
  assert.equal(Buffer.from(encode(23)).toString("hex"), "17");
  assert.equal(Buffer.from(encode(24)).toString("hex"), "1818");
  assert.equal(Buffer.from(encode(256)).toString("hex"), "190100");
  assert.equal(Buffer.from(encode(-1)).toString("hex"), "20");
  // map keys sorted by encoded bytes: "b" (0x61 62) before "aa" (0x62 61 61) because the head byte (length) sorts first
  assert.equal(Buffer.from(encode({ aa: 1, b: 2 })).toString("hex"), "a2" + "6162" + "02" + "626161" + "01");
  // a raw leaf link: d8 2a 58 25 00 01 55 12 20 <digest>
  const link = leafLink(new Uint8Array([1, 2, 3]));
  const hex = Buffer.from(encode(link)).toString("hex");
  assert.ok(hex.startsWith("d82a582500015512 20".replace(/ /g, "")));
  assert.equal(hex.length, 2 * (4 + 1 + 36));
  assert.ok(cidString(link.cid).startsWith("bafkrei"));
});

test("public-v1 vector reproduces mdHash, packageHash and the exact skillroot.cbor", { skip: !present && "vendor sources not present" }, () => {
  const { files, vector } = filesFromVector(join(vectors, "public-v1"));
  const pkg = buildSkillPackage(files);
  assert.equal(pkg.mdHash, vector.mdHash);
  assert.equal(pkg.packageHash, vector.packageHash);
  assert.equal(pkg.rootCid, vector.rootCID_digest);
  const cbor = readFileSync(join(vectors, "public-v1", "skillroot.cbor"));
  assert.equal(Buffer.from(pkg.rootBytes).toString("hex"), cbor.toString("hex"));
  assert.deepEqual(pkg.leaves, vector.leaves);
  assert.deepEqual(verifySkillPackage(files, { mdHash: vector.mdHash, packageHash: vector.packageHash }), []);
  // a tampered file changes the package hash and is detected
  const tampered = { ...files, "requirements.txt": new Uint8Array(Buffer.from("tampered")) };
  assert.ok(verifySkillPackage(tampered, { mdHash: vector.mdHash, packageHash: vector.packageHash }).length > 0);
});

test("custom-primary-path-v1 (primary under a subdirectory) and update-v2 (prev link) vectors", { skip: !present && "vendor sources not present" }, () => {
  const custom = filesFromVector(join(vectors, "custom-primary-path-v1"));
  const pkgCustom = buildSkillPackage(custom.files, { primaryPath: "docs/agent.md" });
  assert.equal(pkgCustom.mdHash, custom.vector.mdHash);
  assert.equal(pkgCustom.packageHash, custom.vector.packageHash);
  assert.equal(Buffer.from(pkgCustom.rootBytes).toString("hex"), readFileSync(join(vectors, "custom-primary-path-v1", "skillroot.cbor")).toString("hex"));

  const v1 = filesFromVector(join(vectors, "public-v1"));
  const v2 = filesFromVector(join(vectors, "update-v2-companion-only"));
  const pkgV2 = buildSkillPackage(v2.files, { version: 2, previousPackageHash: v1.vector.packageHash });
  assert.equal(pkgV2.packageHash, v2.vector.packageHash);
  assert.equal(Buffer.from(pkgV2.rootBytes).toString("hex"), readFileSync(join(vectors, "update-v2-companion-only", "skillroot.cbor")).toString("hex"));
});

test("jcs sorts keys, skips undefined and serializes like JSON.stringify", () => {
  assert.equal(jcs({ b: 1, a: [true, null, "x"], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(jcs({ "é": 1, "z": 2, "A": 3 }), '{"A":3,"z":2,"é":1}');
  assert.throws(() => jcs({ n: Number.NaN }));
});

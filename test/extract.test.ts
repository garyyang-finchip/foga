import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { extractVerify, extractVerifyFile } from "../src/genesis/extract.js";
import { repoRoot } from "../src/util/fs.js";

const root = repoRoot();

test("the fixture filing extracts and both rules pass; the result hash is stable", () => {
  const a = extractVerifyFile(join(root, "scenarios", "fixtures", "sample-filing.txt"), join(root, "scenarios", "skills", "finch-extract-verify", "fields.json"), "0x" + "ab".repeat(32));
  const b = extractVerifyFile(join(root, "scenarios", "fixtures", "sample-filing.txt"), join(root, "scenarios", "skills", "finch-extract-verify", "fields.json"), "0x" + "ab".repeat(32));
  assert.equal(a.resultHash, b.resultHash);
  assert.equal(a.report.fields.totalAssets.value, "1250");
  assert.equal(a.report.fields.issuer.value, "Example Holdings Ltd");
  assert.deepEqual(a.report.rules.map((r) => r.verdict), ["pass", "pass"]);
  assert.equal(a.report.fields.totalAssets.evidence[0].quote, "Total assets: 1,250");
});

test("a missing field yields null and makes the dependent rule unknown; an inconsistent sheet fails the rule", () => {
  const spec = { schema: "x", fields: [{ name: "totalAssets", kind: "amount" as const, label: "Total assets" }, { name: "totalLiabilities", kind: "amount" as const, label: "Total liabilities" }, { name: "totalEquity", kind: "amount" as const, label: "Total equity" }], rules: [{ id: "balance", check: "", tolerance: "1" }] };
  const missing = extractVerify("Total assets: 10\nTotal equity: 4\n", spec, "0x00");
  assert.equal(missing.fields.totalLiabilities.value, null);
  assert.equal(missing.rules[0].verdict, "unknown");
  const bad = extractVerify("Total assets: 10\nTotal liabilities: 5\nTotal equity: 3\n", spec, "0x00");
  assert.equal(bad.rules[0].verdict, "fail");
});

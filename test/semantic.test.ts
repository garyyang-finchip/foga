import assert from "node:assert/strict";
import { test } from "node:test";
import { ercsOf, semanticVerdicts, type GenesisEvidenceFile } from "../src/doctor/semantic.js";

function evidence(checks: GenesisEvidenceFile["checks"]): GenesisEvidenceFile {
  return { schema: "foga.genesis-evidence/1", worldId: "w", chainId: 31337, until: "T9", ranAt: "now", checks, summary: { checks: checks.length, passed: checks.filter((c) => c.pass).length, failed: checks.filter((c) => !c.pass).length, operations: {} }, facts: {} };
}

test("checks are attributed to the standards their names exercise, with the step as fallback", () => {
  assert.deepEqual(ercsOf({ step: "T1", name: "A.kya.S_cred.level4", pass: true, detail: "" }), ["8419"]);
  assert.deepEqual(ercsOf({ step: "T6", name: "ruling.sustained", pass: true, detail: "" }), ["8471"]);
  assert.ok(ercsOf({ step: "T7", name: "bypass.reverted", pass: true, detail: "" }).includes("8468"));
  assert.ok(ercsOf({ step: "T5", name: "nd.claimUnjudged", pass: true, detail: "" }).includes("8436"));
  assert.deepEqual(ercsOf({ step: "T8", name: "something.else", pass: true, detail: "" }), ["8454"]);
});

test("a standard passes when every effective check passes, fails on any failure, and is untested when only skipped", () => {
  const e = evidence([
    { step: "T1", name: "A.kya.S_cred.level4", pass: true, detail: "ok" },
    { step: "T3", name: "A.kya.S_pred.shown", pass: true, detail: "skipped: no proving material" },
    { step: "T6", name: "ruling.sustained", pass: false, detail: "Final NoDecision" },
    { step: "T6", name: "case.admitted", pass: true, detail: "ok" },
  ]);
  const v = Object.fromEntries(semanticVerdicts(e, ["8419", "8471", "8454"]).map((x) => [x.erc, x]));
  assert.equal(v["8419"].verdict, "Pass");
  assert.equal(v["8419"].skipped, 1);
  assert.equal(v["8471"].verdict, "Fail");
  assert.deepEqual(v["8471"].failing, ["T6 ruling.sustained"]);
  assert.equal(v["8454"].verdict, "NotTested");
  const onlySkipped = semanticVerdicts(evidence([{ step: "T3", name: "A.kya.S_pred.shown", pass: true, detail: "skipped: x" }]), ["8419"])[0];
  assert.equal(onlySkipped.verdict, "NotTested");
});

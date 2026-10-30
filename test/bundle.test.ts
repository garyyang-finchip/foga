import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { loadBundle } from "../src/bundle/load.js";
import { defaultBundlePath } from "../src/bundle/load.js";
import { DEPLOY_PLAN } from "../src/world/plan.js";
import { bundleHash } from "../src/build/bundle.js";

const present = existsSync(defaultBundlePath());

test("every published upstream interface id matches the computed one", { skip: !present && "no bundle built" }, () => {
  const bundle = loadBundle();
  const mismatched: string[] = [];
  let checked = 0;
  for (const [repo, ids] of Object.entries(bundle.interfaceIds)) {
    for (const [name, rec] of Object.entries(ids)) {
      if (rec.upstream === null) continue;
      checked++;
      if (!rec.match) mismatched.push(`${repo}:${name} computed ${rec.computed} upstream ${rec.upstream}`);
    }
  }
  assert.ok(checked >= 30, `expected the upstream-published ids to be present, checked ${checked}`);
  assert.deepEqual(mismatched, []);
});

test("the deployment plan only references deployable bundle contracts", { skip: !present && "no bundle built" }, () => {
  const bundle = loadBundle();
  for (const step of DEPLOY_PLAN) {
    const c = bundle.contracts[step.bundleKey];
    assert.ok(c, `${step.id}: ${step.bundleKey} missing from the bundle`);
    assert.ok(c.deployable, `${step.id}: ${step.bundleKey} is not deployable`);
  }
});

test("the committed hash is the hash of the committed content", { skip: !present && "no bundle built" }, () => {
  const bundle = loadBundle();
  assert.equal(bundleHash(bundle.contracts, bundle.sources), bundle.hash);
});

test("the ten ERCs and the local stub are all represented", { skip: !present && "no bundle built" }, () => {
  const bundle = loadBundle();
  const ercs = new Set(bundle.sources.map((s) => String(s.erc)));
  for (const erc of ["8338", "8414", "8419", "8434", "8436", "8444", "8447", "8454", "8468", "8471", "foga"]) {
    assert.ok(ercs.has(erc), `missing ${erc}`);
  }
  assert.ok(bundle.contracts["foga:Identity8004Stub"]?.deployable);
});

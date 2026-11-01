import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Wallet } from "ethers";
import { KeyIsolationError, forbiddenVariables, loadOperatorKey } from "../src/node/keys.js";

/**
 * Key isolation for a node: it loads its operator key alone and refuses an environment from which any other role
 * could be derived (a phrase, a deployer key, a FOGA_KEY_<ROLE>), or a key file other users can read.
 */
const key = Wallet.createRandom();
const posix = process.platform !== "win32";

test("the operator key comes from FOGA_OPERATOR_KEY or a 0600 file, never both, never neither", () => {
  const fromEnv = loadOperatorKey({ FOGA_OPERATOR_KEY: key.privateKey, PATH: "/usr/bin" });
  assert.equal(fromEnv.address, key.address);
  assert.deepEqual(fromEnv.source, { kind: "env", name: "FOGA_OPERATOR_KEY" });

  const dir = mkdtempSync(join(tmpdir(), "foga-keys-"));
  const file = join(dir, "operator.A.key");
  writeFileSync(file, key.privateKey + "\n", { mode: 0o600 });
  const fromFile = loadOperatorKey({ FOGA_OPERATOR_KEY_FILE: file });
  assert.equal(fromFile.address, key.address);
  assert.deepEqual(fromFile.source, { kind: "file", path: file });

  assert.throws(() => loadOperatorKey({ FOGA_OPERATOR_KEY: key.privateKey, FOGA_OPERATOR_KEY_FILE: file }), (e: Error) => e instanceof KeyIsolationError && /set one/.test(e.message));
  assert.throws(() => loadOperatorKey({}), (e: Error) => e instanceof KeyIsolationError && /no operator key/.test(e.message));
  assert.throws(() => loadOperatorKey({ FOGA_OPERATOR_KEY: "0x1234" }), /does not hold a private key/);
  assert.throws(() => loadOperatorKey({ FOGA_OPERATOR_KEY_FILE: join(dir, "missing.key") }), /no such file/);
  assert.throws(() => loadOperatorKey({ FOGA_OPERATOR_KEY_FILE: dir }), /not a regular file/);
  rmSync(dir, { recursive: true, force: true });
});

test("an environment that could derive another role is refused, and the refusal names the variables, not their values", () => {
  for (const extra of [{ FOGA_MNEMONIC: "test test test test test test test test test test test junk" }, { FOGA_MNEMONIC_FILE: "/somewhere/phrase" }, { FOGA_DEPLOYER_PK: key.privateKey }, { FOGA_KEY_OWNER_A: key.privateKey }, { FOGA_KEY_W: key.privateKey }]) {
    const env = { FOGA_OPERATOR_KEY: key.privateKey, ...extra };
    const name = Object.keys(extra)[0];
    assert.throws(
      () => loadOperatorKey(env),
      (e: Error) => {
        assert.ok(e instanceof KeyIsolationError);
        assert.match(e.message, new RegExp(name));
        assert.ok(!e.message.includes(key.privateKey.slice(2, 20)), "the value stays out of the message");
        assert.ok(!e.message.includes("junk"), "the phrase stays out of the message");
        return true;
      },
      name,
    );
  }
  assert.deepEqual(forbiddenVariables({ FOGA_KEY_J1: "x", FOGA_MNEMONIC: "y", FOGA_OPERATOR_KEY: "z", FOGA_RPC_URL: "http://x", FOGA_KEY_EMPTY: "" }), ["FOGA_KEY_J1", "FOGA_MNEMONIC"], "empty variables do not count; ordinary FOGA_* settings are fine");
  // the check comes first: even a complete operator key is refused next to a phrase
  assert.throws(() => loadOperatorKey({ FOGA_OPERATOR_KEY: key.privateKey, FOGA_MNEMONIC_FILE: "/p" }), /FOGA_MNEMONIC_FILE/);
});

test("a key file other users can read is refused", { skip: !posix }, () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-keys-"));
  const file = join(dir, "operator.A.key");
  writeFileSync(file, key.privateKey, { mode: 0o600 });
  chmodSync(file, 0o640);
  assert.throws(() => loadOperatorKey({ FOGA_OPERATOR_KEY_FILE: file }), /readable by other users \(mode 640\)/);
  chmodSync(file, 0o604);
  assert.throws(() => loadOperatorKey({ FOGA_OPERATOR_KEY_FILE: file }), /readable by other users \(mode 604\)/);
  chmodSync(file, 0o400);
  assert.equal(loadOperatorKey({ FOGA_OPERATOR_KEY_FILE: file }).address, key.address, "read-only for the owner is fine");
  rmSync(dir, { recursive: true, force: true });
});

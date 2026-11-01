import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Wallet } from "ethers";
import { ANVIL_MNEMONIC, ROLE_ORDER, anvilKeys, envKeys, envNameOf, mnemonicKeys, newMnemonic, roleAddresses } from "../src/genesis/roles.js";

const saved: Record<string, string | undefined> = {};
function setEnv(values: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(values)) {
    if (!(k in saved)) saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

test("the twelve roles are anvil's first twelve accounts, in order", () => {
  const keys = anvilKeys();
  const addresses = roleAddresses(keys);
  assert.equal(addresses.W, "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  assert.equal(addresses["owner.A"], "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC");
  assert.equal(addresses["operator.A"], "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc");
  assert.equal(addresses.J3, "0x71bE63f3384f5fb98995898A86B02Fb2426c5788");
  assert.deepEqual(mnemonicKeys(ANVIL_MNEMONIC), keys);
  assert.equal(new Set(Object.values(keys)).size, ROLE_ORDER.length, "twelve distinct keys");
});

test("a fresh phrase has twelve words and derives twelve distinct roles; the same phrase derives the same roles", () => {
  const phrase = newMnemonic();
  assert.equal(phrase.split(" ").length, 12);
  const a = mnemonicKeys(phrase);
  const b = mnemonicKeys("  " + phrase.replace(/ /g, "   ") + "\n");
  assert.deepEqual(a, b, "surrounding and repeated whitespace does not matter");
  assert.equal(new Set(Object.values(a)).size, 12);
  assert.notEqual(a.W, anvilKeys().W);
});

test("on a public chain the keys come from the phrase, a role at a time overridable, and a file can hold the phrase", () => {
  const phrase = newMnemonic();
  const dir = mkdtempSync(join(tmpdir(), "foga-roles-"));
  const file = join(dir, "phrase");
  writeFileSync(file, phrase + "\n");
  const other = Wallet.createRandom().privateKey;
  try {
    setEnv({ FOGA_MNEMONIC: undefined, FOGA_MNEMONIC_FILE: undefined, FOGA_KEY_W: undefined, FOGA_KEY_OPERATOR_A: undefined });
    assert.throws(() => envKeys(ROLE_ORDER), /FOGA_MNEMONIC/);
    assert.throws(() => envKeys(["G"]), /FOGA_KEY_G/);

    setEnv({ FOGA_MNEMONIC: phrase });
    assert.deepEqual(envKeys(ROLE_ORDER), mnemonicKeys(phrase));

    setEnv({ FOGA_KEY_OPERATOR_A: other });
    const withOverride = envKeys(ROLE_ORDER);
    assert.equal(withOverride["operator.A"], other);
    assert.equal(withOverride.W, mnemonicKeys(phrase).W);
    assert.equal(envNameOf("operator.A"), "FOGA_KEY_OPERATOR_A");

    setEnv({ FOGA_MNEMONIC: undefined, FOGA_KEY_OPERATOR_A: undefined, FOGA_MNEMONIC_FILE: file });
    assert.deepEqual(envKeys(ROLE_ORDER), mnemonicKeys(phrase));

    // without a phrase, every role needs its own variable
    setEnv({ FOGA_MNEMONIC_FILE: undefined, FOGA_KEY_W: other });
    assert.deepEqual(envKeys(["W"]), { W: other });
    assert.throws(() => envKeys(["W", "G"]), /FOGA_KEY_G/);
  } finally {
    restoreEnv();
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak256 } from "ethers";
import { linkBytecode, maskImmutables, maskLinks, runtimeIdentity, stripMetadata } from "../src/util/bytecode.js";

// A fake runtime: 8 bytes of code, then a CBOR map trailer a2 64 69 70 66 73 ... (length 0x0007), then the 2-byte length.
const body = "6080604052600080fd";
const trailer = "a26469706673"; // 6 bytes
const code = "0x" + body + trailer + "0006";

test("stripMetadata removes a CBOR trailer and leaves the code", () => {
  assert.equal(stripMetadata(code), "0x" + body);
});

test("stripMetadata leaves code without a CBOR trailer untouched", () => {
  assert.equal(stripMetadata("0x" + body), "0x" + body);
  assert.equal(stripMetadata("0x"), "0x");
});

test("maskImmutables zeroes the declared slots", () => {
  const hex = "0x" + "11".repeat(4) + "aa".repeat(32) + "22".repeat(4);
  const masked = maskImmutables(hex, { "123": [{ start: 4, length: 32 }] });
  assert.equal(masked, "0x" + "11".repeat(4) + "00".repeat(32) + "22".repeat(4));
});

test("linkBytecode fills placeholders and maskLinks hides them again", () => {
  const placeholder = "__$" + "ab".repeat(17) + "$__"; // 40 chars
  const unlinked = "0x" + "60".repeat(3) + placeholder + "61".repeat(2);
  const refs = { "lib/L.sol": { L: [{ start: 3, length: 20 }] } };
  const lib = "0x" + "cd".repeat(20);
  const linked = linkBytecode(unlinked, refs, () => lib);
  assert.equal(linked, "0x" + "60".repeat(3) + "cd".repeat(20) + "61".repeat(2));
  assert.equal(maskLinks(linked, refs), "0x" + "60".repeat(3) + "00".repeat(20) + "61".repeat(2));
  assert.throws(() => linkBytecode(unlinked, refs, () => undefined), /unlinked library/);
});

test("runtimeIdentity is the same for a build and its deployed, patched runtime", () => {
  const immutableSlot = { "7": [{ start: 2, length: 32 }] };
  const built = "0x" + "6080" + "00".repeat(32) + "fe" + trailer + "0006";
  const deployed = "0x" + "6080" + "ff".repeat(32) + "fe" + "a2" + "deadbeef99" + "0006"; // different metadata, immutable filled
  assert.equal(runtimeIdentity(built, {}, immutableSlot), runtimeIdentity(deployed, {}, immutableSlot));
  assert.equal(runtimeIdentity(built, {}, immutableSlot), keccak256("0x" + "6080" + "00".repeat(32) + "fe"));
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isWorldUrl, resolveWorldSource } from "../src/world/source.js";

/**
 * `--world` by URL (1.0.9): a published address book is fetched once, checked to be a world file and kept as a plain
 * file the command then reads; a path is untouched; anything that is not an https world file is refused with its
 * reason. The fetch is injected, so no network is involved here.
 */
const WORLD = { schema: "foga.world/1", worldId: "testchain-99-20260101T000000Z", name: "testchain", network: "testchain", chainId: 99, contracts: { "8338/SkillToken": { address: "0x0000000000000000000000000000000000000001" } } };
const body = JSON.stringify(WORLD, null, 2) + "\n";

function fetchReturning(status: number, text: string, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("world source: a path passes through; a URL is fetched, checked, cached and reused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-worlds-"));
  try {
    assert.equal(isWorldUrl("deployments/sepolia.json"), false);
    assert.equal(isWorldUrl("https://example.org/w.json"), true);

    const byPath = await resolveWorldSource("deployments/sepolia.json", { dir });
    assert.equal(byPath.url, null);
    assert.equal(byPath.sha256, null);
    assert.ok(byPath.path.endsWith("deployments/sepolia.json"));

    const calls: string[] = [];
    const lines: string[] = [];
    const first = await resolveWorldSource("https://example.org/chain/world/testchain.json", { dir, fetchImpl: fetchReturning(200, body, calls), log: (l) => lines.push(l) });
    assert.equal(first.worldId, WORLD.worldId);
    assert.equal(first.url, "https://example.org/chain/world/testchain.json");
    assert.equal(first.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(first.path, join(dir, `${WORLD.worldId}.json`));
    assert.ok(existsSync(first.path));
    assert.equal(readFileSync(first.path, "utf8"), body, "the bytes received are what is kept");
    assert.equal(calls.length, 1);
    assert.match(lines[0], /kept at/);

    // the same file again: fetched again (a command fetches once), found unchanged, not rewritten
    const before = readFileSync(first.path, "utf8");
    const again = await resolveWorldSource("https://example.org/chain/world/testchain.json", { dir, fetchImpl: fetchReturning(200, body, calls), log: (l) => lines.push(l) });
    assert.equal(again.path, first.path);
    assert.equal(readFileSync(first.path, "utf8"), before);
    assert.match(lines[1], /unchanged/);

    // the cached file is a plain file: a stale local edit is replaced by what the URL serves
    writeFileSync(first.path, "{}");
    await resolveWorldSource("https://example.org/chain/world/testchain.json", { dir, fetchImpl: fetchReturning(200, body) });
    assert.equal(readFileSync(first.path, "utf8"), body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("world source: what is refused, and why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-worlds-"));
  try {
    await assert.rejects(resolveWorldSource("http://example.org/w.json", { dir, fetchImpl: fetchReturning(200, body) }), /must be https/);
    await assert.rejects(resolveWorldSource("https://example.org/missing.json", { dir, fetchImpl: fetchReturning(404, "no") }), /HTTP 404/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, "not json") }), /not JSON/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, JSON.stringify({ schema: "foga.world-config/1", name: "x" })) }), /not a world file/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, JSON.stringify({ ...WORLD, worldId: "../../etc/passwd" })) }), /worldId/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, JSON.stringify({ ...WORLD, contracts: undefined })) }), /no contracts/);
    assert.equal(existsSync(join(dir, `${WORLD.worldId}.json`)), false, "nothing refused is kept");

    // a local http server is the one exception to https (a rehearsal, a test)
    const local = await resolveWorldSource("http://127.0.0.1:8080/w.json", { dir, fetchImpl: fetchReturning(200, body) });
    assert.equal(local.worldId, WORLD.worldId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkWorldJson, isWorldUrl, resolveWorldSource, safeSegment } from "../src/world/source.js";

/**
 * `--world` by URL (1.0.9): a published address book is fetched once, checked to be a world file and kept as a plain
 * file the command then reads; a path is untouched; anything that is not an https world file is refused with its
 * reason. The kept file is named by chain, world and content, so two worlds that share a worldId, or two revisions
 * of one, never overwrite each other. The fetch is injected, so no network is involved here.
 */
const WORLD = { schema: "foga.world/1", worldId: "testchain-99-20260101T000000Z", name: "testchain", network: "testchain", chainId: 99, contracts: { "8338/SkillToken": { address: "0x0000000000000000000000000000000000000001" } } };
const body = JSON.stringify(WORLD, null, 2) + "\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const kept = (w: { chainId: number; worldId: string }, text: string) => `${w.chainId}-${w.worldId}-${sha(text).slice(0, 12)}.json`;

function fetchReturning(status: number, text: string, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

test("world source: a path passes through; a URL is fetched, checked, kept by chain, world and content, and reused", async () => {
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
    assert.equal(first.chainId, WORLD.chainId);
    assert.equal(first.url, "https://example.org/chain/world/testchain.json");
    assert.equal(first.sha256, sha(body));
    assert.equal(first.path, join(dir, kept(WORLD, body)));
    assert.ok(existsSync(first.path));
    assert.equal(readFileSync(first.path, "utf8"), body, "the bytes received are what is kept");
    assert.equal(calls.length, 1);
    assert.match(lines[0], /\(chain 99\) from https:\/\/example\.org\/chain\/world\/testchain\.json \(sha256 [0-9a-f]{16}…\) kept at /);

    // the same file again: fetched again (a command fetches once), found unchanged, not rewritten
    const before = readFileSync(first.path, "utf8");
    const again = await resolveWorldSource("https://example.org/chain/world/testchain.json", { dir, fetchImpl: fetchReturning(200, body, calls), log: (l) => lines.push(l) });
    assert.equal(again.path, first.path);
    assert.equal(readFileSync(first.path, "utf8"), before);
    assert.match(lines[1], /unchanged at/);

    // the kept file is a plain file: a stale local edit is replaced by what the URL serves
    writeFileSync(first.path, "{}");
    await resolveWorldSource("https://example.org/chain/world/testchain.json", { dir, fetchImpl: fetchReturning(200, body) });
    assert.equal(readFileSync(first.path, "utf8"), body);

    // --- no collisions: another project's world with the same worldId on another chain is another file, and a new
    // revision of this world (one more contract) is another file; the first is untouched by either
    const otherChain = { ...WORLD, chainId: 976411, network: "otherchain" };
    const otherBody = JSON.stringify(otherChain, null, 2) + "\n";
    const other = await resolveWorldSource("https://other.example/world.json", { dir, fetchImpl: fetchReturning(200, otherBody) });
    assert.equal(other.path, join(dir, kept(otherChain, otherBody)));
    assert.notEqual(other.path, first.path, "the same worldId on another chain is another file");

    const revised = { ...WORLD, contracts: { ...WORLD.contracts, "8414/TaskToken": { address: "0x0000000000000000000000000000000000000002" } } };
    const revisedBody = JSON.stringify(revised, null, 2) + "\n";
    const rev = await resolveWorldSource("https://example.org/chain/world/testchain.json", { dir, fetchImpl: fetchReturning(200, revisedBody) });
    assert.equal(rev.path, join(dir, kept(revised, revisedBody)));
    assert.notEqual(rev.path, first.path, "a new revision of the same world is another file");
    assert.equal(readFileSync(first.path, "utf8"), body, "the first revision is still there, unchanged");
    assert.equal(readdirSync(dir).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("world source: what is refused, and why; what may name a directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "foga-worlds-"));
  try {
    await assert.rejects(resolveWorldSource("http://example.org/w.json", { dir, fetchImpl: fetchReturning(200, body) }), /must be https/);
    await assert.rejects(resolveWorldSource("https://example.org/missing.json", { dir, fetchImpl: fetchReturning(404, "no") }), /HTTP 404/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, "not json") }), /not JSON/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, JSON.stringify({ schema: "foga.world-config/1", name: "x" })) }), /not a world file/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, JSON.stringify({ ...WORLD, worldId: "../../etc/passwd" })) }), /worldId/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, JSON.stringify({ ...WORLD, network: "../elsewhere" })) }), /network/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, JSON.stringify({ ...WORLD, chainId: "99" })) }), /chainId/);
    await assert.rejects(resolveWorldSource("https://example.org/w.json", { dir, fetchImpl: fetchReturning(200, JSON.stringify({ ...WORLD, contracts: undefined })) }), /no contracts/);
    assert.equal(readdirSync(dir).length, 0, "nothing refused is kept");

    // a local http server is the one exception to https (a rehearsal, a test)
    const local = await resolveWorldSource("http://127.0.0.1:8080/w.json", { dir, fetchImpl: fetchReturning(200, body) });
    assert.equal(local.worldId, WORLD.worldId);

    // the fields a remote file contributes to local paths: one segment each, nothing that walks or hides
    for (const ok of ["sepolia", "optimism-sepolia", "anvil-31337-20261101T194545Z", "a.b_c-d", "x"]) assert.equal(safeSegment(ok), true, ok);
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a b", "a\u0000b", "x".repeat(121), 7, null, undefined]) assert.equal(safeSegment(bad), false, String(bad));
    assert.deepEqual(checkWorldJson(body, "w"), { worldId: WORLD.worldId, chainId: 99, network: "testchain" });
    assert.equal(checkWorldJson(JSON.stringify({ ...WORLD, network: undefined }), "w").network, null, "network is optional in the check (the join requires it)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

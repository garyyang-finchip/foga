import assert from "node:assert/strict";
import { test } from "node:test";
import { Tenders, type Submission } from "../src/core/tenders.js";

/**
 * Tenders.submissions(), offline: the count and the entries are read as one. A node can answer a read from a state
 * newer than the block it names (anvil 1.7.1 under automine does, about one call in a thousand), so the count can
 * announce an id that the next read, at the same tag, calls nonexistent; the walk then starts over from a fresh count.
 */
const sub = (fulfiller: string, status = 1): Submission => ({ fulfiller, resultHash: "0x" + "ab".repeat(32), taskVersion: 1n, submittedAt: 1n, machineSettled: status === 1, status });
const revert = () => Object.assign(new Error('execution reverted: "TaskToken: nonexistent submission" (action="call", code=CALL_EXCEPTION)'), { code: "CALL_EXCEPTION", reason: "TaskToken: nonexistent submission" });

/** A Tenders whose two reads answer from scripts: `counts` in order, and per (id, call number) what submissionOf gives. */
function scripted(counts: bigint[], answers: Record<string, (Submission | Error)[]>) {
  const world = { address: () => "0x" + "55".repeat(20), contract: () => { throw new Error("no chain in this test"); } } as unknown as ConstructorParameters<typeof Tenders>[0];
  const t = new Tenders(world);
  const calls = { count: 0, reads: [] as string[] };
  t.submissionCount = async () => {
    const c = counts[Math.min(calls.count, counts.length - 1)];
    calls.count++;
    return c;
  };
  t.submissionOf = async (_tokenId: bigint, id: bigint) => {
    const key = id.toString();
    calls.reads.push(key);
    const script = answers[key] ?? [];
    const n = calls.reads.filter((k) => k === key).length - 1;
    const a = script[Math.min(n, script.length - 1)];
    if (a instanceof Error) throw a;
    if (!a) throw revert();
    return a;
  };
  return { t, calls };
}

test("submissions: a steady chain gives the count's entries in order", async () => {
  const { t, calls } = scripted([2n], { "1": [sub("0x" + "01".repeat(20))], "2": [sub("0x" + "02".repeat(20), 0)] });
  const subs = await t.submissions(9n);
  assert.equal(subs.length, 2);
  assert.equal(subs[0].fulfiller, "0x" + "01".repeat(20));
  assert.equal(subs[1].status, 0);
  assert.equal(calls.count, 1);
});

test("submissions: a count read ahead of its tag, then the honest state — the walk starts over and returns what the chain says twice", async () => {
  // the first count (1) was served from the next block; the read of id 1 at the same tag reverts; the second count (0) is the tag's own
  const { t, calls } = scripted([1n, 0n], { "1": [revert()] });
  const subs = await t.submissions(9n);
  assert.deepEqual(subs, []);
  assert.equal(calls.count, 2);
  assert.deepEqual(calls.reads, ["1"]);
});

test("submissions: the chain catches up between the attempts — the second walk reads the entry", async () => {
  const { t, calls } = scripted([1n, 1n], { "1": [revert(), sub("0x" + "aa".repeat(20))] });
  const subs = await t.submissions(9n);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].fulfiller, "0x" + "aa".repeat(20));
  assert.equal(calls.count, 2);
  assert.deepEqual(calls.reads, ["1", "1"]);
});

test("submissions: a revert for any other reason is raised at once", async () => {
  const other = Object.assign(new Error('execution reverted: "TaskToken: nonexistent token"'), { code: "CALL_EXCEPTION" });
  const { t, calls } = scripted([1n], { "1": [other] });
  await assert.rejects(() => t.submissions(9n), /nonexistent token/);
  assert.equal(calls.count, 1);
});

test("submissions: a count that keeps announcing an id the chain lacks is raised after three walks", async () => {
  const { t, calls } = scripted([1n], { "1": [revert()] });
  await assert.rejects(() => t.submissions(9n), /nonexistent submission/);
  assert.equal(calls.count, 3);
  assert.deepEqual(calls.reads, ["1", "1", "1"]);
});

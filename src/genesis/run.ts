import { basename, join, relative, resolve } from "node:path";
import { readJson, repoRoot, writeJson } from "../util/fs.js";
import { log } from "../util/log.js";
import type { WorldFile } from "../world/types.js";
import { Genesis, STEPS, type CheckResult, type StepName } from "./scenario.js";

export interface GenesisRunOptions {
  worldPath: string;
  rpc?: string;
  bundlePath?: string;
  storePath?: string;
  evidencePath?: string;
  skillsDir?: string;
  fixturesDir?: string;
  zk?: "auto" | "require" | "skip";
  until?: StepName;
  crashBeforeBroadcast?: string;
  crashAfterBroadcast?: string;
  quiet?: boolean;
}

export interface GenesisEvidence {
  schema: "foga.genesis-evidence/1";
  worldId: string;
  chainId: number;
  world: string;
  store: string;
  ranAt: string;
  until: StepName;
  checks: CheckResult[];
  summary: { checks: number; passed: number; failed: number; operations: Record<string, number>; sent: number; replayed: number; recovered: number; resent: number };
  facts: Record<string, unknown>;
  evidence: { step: string; label: string; values: Record<string, unknown>; at: string }[];
  journal: { seq: number; at: string; opKey: string | null; event: string; detail: Record<string, unknown> | null }[];
}

/** `foga genesis run`: open the kernel on a deployed world, run T0..until, write the evidence file. */
export async function runGenesis(opts: GenesisRunOptions): Promise<{ evidence: GenesisEvidence; failed: number }> {
  const root = repoRoot();
  const worldPath = resolve(opts.worldPath);
  const world = readJson<WorldFile>(worldPath);
  if (world.schema !== "foga.world/1") throw new Error(`${worldPath} is not a deployed world file (run foga world deploy first)`);
  const name = basename(worldPath).replace(/\.json$/, "");
  const rpc = opts.rpc ?? process.env.FOGA_RPC_URL ?? (world.network === "anvil" ? "http://127.0.0.1:8545" : undefined);
  if (!rpc) throw new Error("no RPC: pass --rpc or set FOGA_RPC_URL");
  const storePath = resolve(opts.storePath ?? join(root, "deployments", `${name}.genesis.sqlite`));
  const evidencePath = resolve(opts.evidencePath ?? join(root, "deployments", `${name}.genesis.json`));
  const skillsDir = resolve(opts.skillsDir ?? join(root, "scenarios", "skills"));
  const fixturesDir = resolve(opts.fixturesDir ?? join(root, "scenarios", "fixtures"));
  const until = opts.until ?? "T5";
  if (!STEPS.includes(until)) throw new Error(`--until must be one of ${STEPS.join(", ")}`);

  const say = opts.quiet ? () => {} : (line: string) => log.step(line);
  const g = await Genesis.open({ worldPath, rpc, bundlePath: opts.bundlePath, storePath, skillsDir, fixturesDir, zk: opts.zk ?? "auto", crashBeforeBroadcast: opts.crashBeforeBroadcast, crashAfterBroadcast: opts.crashAfterBroadcast, log: say });
  log.info(`genesis on world ${world.worldId} (chain ${world.chainId}) via ${rpc}; store ${storePath}`);
  const before = g.kernel.store.summary();
  if (before.ops.confirmed + before.ops.sent + before.ops.failed > 0) log.info(`resuming: store holds ${before.ops.confirmed} confirmed, ${before.ops.sent} sent, ${before.ops.failed} failed operations`);
  const startSeq = g.kernel.store.journalEntries().at(-1)?.seq ?? 0;

  let runError: unknown = null;
  try {
    await g.run(until);
  } catch (e) {
    runError = e;
  }

  const journal = g.kernel.store.journalEntries();
  const thisRun = journal.filter((j) => j.seq > startSeq);
  const ops = g.kernel.store.summary().ops;
  const failed = g.checks.filter((c) => !c.pass).length;
  const evidence: GenesisEvidence = {
    schema: "foga.genesis-evidence/1",
    worldId: world.worldId,
    chainId: world.chainId,
    world: relative(root, worldPath),
    store: relative(root, storePath),
    ranAt: new Date().toISOString(),
    until,
    checks: g.checks,
    summary: {
      checks: g.checks.length,
      passed: g.checks.length - failed,
      failed,
      operations: ops,
      sent: thisRun.filter((j) => j.event === "sent").length,
      replayed: thisRun.filter((j) => j.event === "replayed").length,
      recovered: thisRun.filter((j) => j.event === "recovered-receipt" || j.event === "recovered-pending").length,
      resent: thisRun.filter((j) => j.event === "resend").length,
    },
    facts: g.kernel.store.facts(),
    evidence: g.kernel.evidenceRecords(),
    journal,
  };
  writeJson(evidencePath, evidence);
  g.close();
  if (runError) throw runError;
  log.info(`genesis ${until}: ${evidence.summary.passed}/${evidence.summary.checks} checks passed; ${ops.confirmed} operations confirmed in the store; this run: ${evidence.summary.sent} sent, ${evidence.summary.replayed} replayed, ${evidence.summary.recovered} recovered, ${evidence.summary.resent} re-sent -> ${evidencePath}`);
  return { evidence, failed };
}

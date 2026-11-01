import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { World } from "../core/world.js";
import { extractVerifyFile } from "./extract.js";
import { runProbe, type ProbeInput } from "./probe.js";

/**
 * The skill worker: one job on stdin, one JSON result on stdout, nothing else on stdout. It runs the two built-in
 * executors the genesis and the node offer — `foga-probe` (view calls against the world at a pinned block) and
 * `finch-extract-verify` (the deterministic extraction path over a document) — and holds no key. The parent starts
 * it with an environment reduced to PATH, a time limit, an output limit and, outside the development loader, Node's
 * permission model with read access to the directories the job needs. A document path is accepted only inside the
 * input directory the parent names; a fields file only inside the skills directory.
 */
export type SkillJob =
  | { executor: "probe"; worldPath: string; rpc: string; bundlePath?: string; input: ProbeInput }
  | { executor: "extract"; documentPath: string; fieldsPath: string; packageHash: string; inputDir: string; skillsDir: string };

function inside(path: string, dir: string, what: string): string {
  const real = realpathSync(resolve(path));
  const root = realpathSync(resolve(dir));
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`${what} ${path} is outside ${dir}`);
  return real;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  const job = JSON.parse(Buffer.concat(chunks).toString("utf8")) as SkillJob;
  if (job.executor === "probe") {
    const world = World.load(job.worldPath, job.rpc, job.bundlePath);
    try {
      const { report, answer } = await runProbe(world, job.input);
      process.stdout.write(JSON.stringify({ answer, report }));
    } finally {
      world.provider.destroy();
    }
    return;
  }
  if (job.executor === "extract") {
    const document = inside(job.documentPath, job.inputDir, "document");
    const fields = inside(job.fieldsPath, job.skillsDir, "fields file");
    const out = extractVerifyFile(document, fields, job.packageHash);
    process.stdout.write(JSON.stringify(out));
    return;
  }
  throw new Error(`unknown executor ${(job as { executor?: string }).executor}`);
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});

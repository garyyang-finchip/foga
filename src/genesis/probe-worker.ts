import { World } from "../core/world.js";
import { runProbe, type ProbeInput } from "./probe.js";

/**
 * Isolated worker for the `foga-probe` skill: reads one job from stdin, runs the probe against the world
 * (view calls only) and writes the canonical answer to stdout. It holds no key and the kernel starts it with no
 * environment beyond what the job states, so a skill run can read the chain but cannot act as the cell.
 */
interface Job {
  worldPath: string;
  rpc: string;
  bundlePath?: string;
  input: ProbeInput;
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.from(c));
  const job = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Job;
  const world = World.load(job.worldPath, job.rpc, job.bundlePath);
  const { report, answer } = await runProbe(world, job.input);
  process.stdout.write(JSON.stringify({ answer, report }));
  world.provider.destroy();
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});

#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { buildBundle } from "./build/bundle.js";
import { syncVendor, verifyVendor } from "./build/vendor.js";
import { runDoctor } from "./doctor/doctor.js";
import { exists, readJson, repoRoot, writeJson } from "./util/fs.js";
import { fail, log } from "./util/log.js";
import { attachWorld, deployWorld, loadWorldConfig } from "./world/deploy.js";
import { loadBundle } from "./bundle/load.js";

const USAGE = `foga — Finch OG Agent toolchain (Phase 1 world layer; Phase 2a cells and genesis)

usage:
  foga vendor sync [--only <repo,repo>]          fetch the locked upstream sources into vendor/
  foga vendor verify                             check vendor/ against vendor/LOCK.json
  foga build [--verify] [--solc-dir <dir>]       compile the ten reference implementations into artifacts/bundle.json
  foga world deploy --world <config.json> [--rpc <url>] [--out <file>] [--resume] [--gas-multiplier <x>] [--allow-chain-mismatch]
  foga world attach --world <config.json> [--out <file>]
  foga doctor --world <world.json> [--rpc <url>] [--out <report.json>]
  foga doctor --world <config.json> --attach [--rpc <url>] [--out <report.json>]
  foga doctor --world <...> --export-probe <probe.json>      write the JSON-RPC probe plan instead of calling an RPC
  foga doctor --world <...> --import-results <results.json>  evaluate results collected by a relay (offline replay)
  foga probe relay-script                        print a dependency-free node script that runs a probe plan
  foga genesis run --world <world.json> [--rpc <url>] [--until T0|T1|T2|T3] [--store <file.sqlite>] [--out <evidence.json>]
                   [--crash-after <opKey>] [--crash-before <opKey>]   run the genesis scenario (idempotent; re-run to resume)
  foga genesis status --world <world.json> [--store <file.sqlite>]    list the operations the store holds
  foga demo [--port <n>] [--keep] [--genesis <T0..T3>]   start anvil, deploy the local world, run the doctor (and the genesis)
  foga bundle info                               summarize the committed bundle

environment:
  FOGA_SOLC_DIR   directory with solc-<version> static binaries (offline builds; otherwise forge downloads solc)
  FOGA_RPC_URL    default RPC for doctor and genesis
  FOGA_DEPLOYER_PK  deployer key for world deploy (worlds/local.json falls back to anvil account #0)
  FOGA_KEY_<ROLE>   genesis keys on non-anvil chains (W, G, OWNER_A, OPERATOR_A, ... ); anvil derives them
`;

interface Args {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else positional.push(a);
  }
  return { positional, flags };
}

function str(flags: Args["flags"], key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [group, cmd] = positional;
  const root = repoRoot();

  if (!group || flags.help || group === "help") {
    console.log(USAGE);
    return;
  }

  if (group === "vendor" && cmd === "sync") {
    const only = str(flags, "only")?.split(",");
    syncVendor({ only });
    log.info("vendor tree matches vendor/LOCK.json");
    return;
  }
  if (group === "vendor" && cmd === "verify") {
    const problems = verifyVendor();
    if (problems.length) fail("vendor tree problems:\n  " + problems.join("\n  "));
    log.info("vendor tree matches vendor/LOCK.json");
    return;
  }

  if (group === "build") {
    const res = await buildBundle({ verify: Boolean(flags.verify), solcDir: str(flags, "solc-dir"), only: str(flags, "only")?.split(",") });
    if (flags.verify && !res.verified) process.exit(2);
    return;
  }

  if (group === "bundle" && cmd === "info") {
    const b = loadBundle(str(flags, "bundle"));
    console.log(`bundle ${b.hash}\nbuilt ${b.builtAt} with forge ${b.builtWith.forge}; solc ${Object.values(b.builtWith.solc).join(", ")}`);
    for (const s of b.sources) {
      const n = Object.values(b.contracts).filter((c) => c.repo === s.repo);
      const dep = n.filter((c) => c.deployable).length;
      console.log(`  ${String(s.erc).padEnd(5)} ${s.repo.padEnd(24)} ${(s.commit ?? "local").slice(0, 7)}  ${String(n.length).padStart(3)} targets, ${String(dep).padStart(3)} deployable (${s.mode}, solc ${s.solc})`);
    }
    for (const [repo, ids] of Object.entries(b.interfaceIds)) {
      const mismatched = Object.entries(ids).filter(([, r]) => r.match === false);
      if (mismatched.length) console.log(`  warning: ${repo} interface id mismatches: ${mismatched.map(([n, r]) => `${n} computed ${r.computed} upstream ${r.upstream}`).join("; ")}`);
    }
    return;
  }

  if (group === "world" && (cmd === "deploy" || cmd === "attach")) {
    const worldConfigPath = str(flags, "world");
    if (!worldConfigPath) fail("--world <config.json> is required");
    const cfg = loadWorldConfig(resolve(worldConfigPath));
    const outPath = resolve(str(flags, "out") ?? join(root, "deployments", `${cfg.name}.json`));
    if (cmd === "attach" || cfg.mode === "attach") {
      const bundle = exists(join(root, "artifacts", "bundle.json")) ? loadBundle() : null;
      const world = attachWorld(cfg, bundle);
      writeJson(outPath, world);
      log.info(`attached world ${world.worldId}: ${Object.keys(world.contracts).length} contracts -> ${outPath}`);
      return;
    }
    const gm = str(flags, "gas-multiplier");
    await deployWorld({
      worldConfigPath: resolve(worldConfigPath),
      rpc: str(flags, "rpc"),
      outPath,
      resume: Boolean(flags.resume),
      gasMultiplier: gm ? Number(gm) : undefined,
      allowChainMismatch: Boolean(flags["allow-chain-mismatch"]),
    });
    return;
  }

  if (group === "doctor") {
    let worldPath = str(flags, "world");
    if (!worldPath) fail("--world <world.json> is required");
    worldPath = resolve(worldPath);
    if (flags.attach) {
      const cfg = loadWorldConfig(worldPath);
      const bundle = loadBundle();
      const world = attachWorld(cfg, bundle);
      const tmp = join(root, ".foga-build", `${cfg.name}.attached.json`);
      writeJson(tmp, world);
      worldPath = tmp;
    }
    const { report } = await runDoctor({
      worldPath,
      rpc: str(flags, "rpc"),
      outPath: str(flags, "out") ? resolve(str(flags, "out")!) : undefined,
      exportProbePath: str(flags, "export-probe") ? resolve(str(flags, "export-probe")!) : undefined,
      importResultsPath: str(flags, "import-results") ? resolve(str(flags, "import-results")!) : undefined,
    });
    if (report && report.summary.Fail > 0) process.exitCode = 3;
    return;
  }

  if (group === "probe" && cmd === "relay-script") {
    const { RELAY_SCRIPT } = await import("./doctor/probe.js");
    process.stdout.write(RELAY_SCRIPT);
    return;
  }

  if (group === "genesis" && cmd === "run") {
    const worldPath = str(flags, "world");
    if (!worldPath) fail("--world <world.json> is required (a deployed world)");
    const { runGenesis } = await import("./genesis/run.js");
    const { failed } = await runGenesis({
      worldPath,
      rpc: str(flags, "rpc"),
      storePath: str(flags, "store"),
      evidencePath: str(flags, "out"),
      skillsDir: str(flags, "skills"),
      until: str(flags, "until") as any,
      crashAfterBroadcast: str(flags, "crash-after"),
      crashBeforeBroadcast: str(flags, "crash-before"),
    });
    if (failed > 0) process.exitCode = 4;
    return;
  }

  if (group === "genesis" && cmd === "status") {
    const worldPath = str(flags, "world");
    if (!worldPath) fail("--world <world.json> is required");
    const { OperationStore } = await import("./kernel/store.js");
    const name = worldPath.replace(/^.*\//, "").replace(/\.json$/, "");
    const storePath = resolve(str(flags, "store") ?? join(root, "deployments", `${name}.genesis.sqlite`));
    if (!exists(storePath)) fail(`no operation store at ${storePath}`);
    const store = OperationStore.open(storePath);
    const ops = store.all();
    console.log(`store ${storePath}: ${ops.length} operations (chain ${store.getMeta("chainId")}, world ${store.getMeta("worldId")})`);
    for (const op of ops) console.log(`  ${op.status.padEnd(9)} ${op.key.padEnd(36)} ${op.signer.padEnd(11)} nonce ${String(op.nonce ?? "-").padStart(3)}  ${op.txHash ?? ""}${op.error ? "  error: " + op.error : ""}`);
    const s = store.summary();
    console.log(`  facts ${s.facts}, journal entries ${s.journal}`);
    store.close();
    return;
  }

  if (group === "demo") {
    await demo({ port: Number(str(flags, "port") ?? 8545), keep: Boolean(flags.keep), genesis: str(flags, "genesis") as any });
    return;
  }

  console.log(USAGE);
  fail(`unknown command: ${positional.join(" ")}`);
}

async function demo(opts: { port: number; keep: boolean; genesis?: string }): Promise<void> {
  const root = repoRoot();
  const rpc = `http://127.0.0.1:${opts.port}`;

  // Say what is wrong before starting anything: a port that is already taken makes anvil exit at once, and a
  // silent exit would otherwise surface only as "the RPC did not come up".
  if (await portInUse(opts.port)) {
    const answers = await rpcAnswers(rpc);
    fail(
      answers
        ? `${rpc} already answers JSON-RPC (another anvil or node is running). Stop it, or pass --port <n> to use another port.`
        : `port ${opts.port} is in use by something that does not speak JSON-RPC. Free it, or pass --port <n>.`,
    );
  }

  log.info(`starting anvil on ${rpc}`);
  const anvil = spawn("anvil", ["--port", String(opts.port), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  anvil.stderr?.on("data", (d) => {
    stderr = (stderr + String(d)).slice(-8000);
  });
  let exited: string | null = null;
  anvil.on("exit", (code, signal) => {
    exited = code !== null ? `exit code ${code}` : `signal ${signal}`;
  });
  const stop = () => {
    if (!opts.keep && !anvil.killed) anvil.kill("SIGTERM");
  };
  anvil.on("error", (e: NodeJS.ErrnoException) =>
    fail(
      e.code === "ENOENT"
        ? "anvil not found on PATH. Install Foundry (https://getfoundry.sh: `curl -L https://foundry.sh | bash && foundryup`) or use docker compose."
        : `could not start anvil: ${e.message}`,
    ),
  );
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
  try {
    await waitForRpc(rpc, 20000, () => exited !== null);
  } catch (e: any) {
    const why = exited ? `anvil stopped (${exited}) before serving ${rpc}` : `anvil did not serve ${rpc} within 20 s`;
    fail(`${why}.${stderr.trim() ? `\n--- anvil stderr ---\n${stderr.trim()}\n--------------------` : ""}\nRun \`anvil --port ${opts.port}\` by hand to see its output; \`anvil --version\` shows the installed version (CI uses Foundry v1.7.1).`);
  }
  const worldConfig = join(root, "worlds", "local.json");
  const out = join(root, "deployments", "local.json");
  await deployWorld({ worldConfigPath: worldConfig, rpc, outPath: out });
  const { report } = await runDoctor({ worldPath: out, rpc, outPath: join(root, "deployments", "local.doctor.json") });
  if (report && report.summary.Fail > 0) process.exitCode = 3;
  if (opts.genesis) {
    const { runGenesis } = await import("./genesis/run.js");
    const { rmSync } = await import("node:fs");
    const storePath = join(root, "deployments", "local.genesis.sqlite");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(storePath + suffix, { force: true }); // a fresh chain means a fresh store
    const { failed } = await runGenesis({ worldPath: out, rpc, storePath, until: opts.genesis as any });
    if (failed > 0) process.exitCode = 4;
  }
  if (opts.keep) log.info(`anvil left running on ${rpc} (pid ${anvil.pid}); world at deployments/local.json`);
  else stop();
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (v: boolean) => {
      socket.destroy();
      resolve(v);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function rpcAnswers(rpc: string): Promise<boolean> {
  try {
    const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForRpc(rpc: string, timeoutMs: number, giveUp?: () => boolean): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await rpcAnswers(rpc)) return;
    if (giveUp?.()) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`RPC at ${rpc} did not come up within ${timeoutMs} ms`);
}

main().catch((e) => {
  fail(e?.stack ?? String(e));
});

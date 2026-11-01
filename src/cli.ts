#!/usr/bin/env node
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { cpus, homedir, loadavg } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { buildBundle } from "./build/bundle.js";
import { syncVendor, verifyVendor } from "./build/vendor.js";
import { runDoctor } from "./doctor/doctor.js";
import { ensureDir, exists, readJson, repoRoot, writeJson } from "./util/fs.js";
import { fail, log } from "./util/log.js";
import { attachWorld, deployWorld, loadWorldConfig, missingPlanSteps } from "./world/deploy.js";
import { loadBundle } from "./bundle/load.js";

const USAGE = `foga — Finch OG Agent toolchain (Phase 1 world layer; Phase 2 cells and the genesis T0-T9, local and public chains; Phase 3 a cell as a node)

usage:
  foga vendor sync [--only <repo,repo>]          fetch the locked upstream sources into vendor/
  foga vendor verify                             check vendor/ against vendor/LOCK.json
  foga build [--verify] [--solc-dir <dir>]       compile the ten reference implementations into artifacts/bundle.json
  foga world deploy --world <config.json> [--rpc <url>] [--out <file>] [--resume] [--gas-multiplier <x>] [--allow-chain-mismatch]
                                                 deploy-mode config: the whole stack; attach-mode config: attach what it
                                                 lists and deploy the reference contracts it does not (deployer = W)
  foga world attach --world <config.json> [--out <file>]   address book only, no transactions (every contract listed)
  foga keys new [--out <file>]                   write a fresh 12-word phrase (default ~/.foga/genesis.mnemonic) and print the role addresses
  foga keys show                                 print the role addresses the environment derives (FOGA_MNEMONIC[_FILE], FOGA_KEY_*)
  foga keys export --role <role> [--out <file>]  write one role's key to a 0600 file for a node that holds that key alone
                                                 (default ~/.foga/keys/<role>.key; the node reads it from FOGA_OPERATOR_KEY_FILE)
  foga keys check                                check the current environment as a node would: its operator key alone, nothing that derives other roles
  foga doctor --world <world.json> [--rpc <url>] [--out <report.json>] [--genesis <evidence.json>]
  foga doctor --world <config.json> --attach [--rpc <url>] [--out <report.json>]
  foga doctor --world <...> --export-probe <probe.json>      write the JSON-RPC probe plan instead of calling an RPC
  foga doctor --world <...> --import-results <results.json>  evaluate results collected by a relay (offline replay)
  foga probe relay-script                        print a dependency-free node script that runs a probe plan
  foga genesis preflight --world <world.json> [--rpc <url>]   check RPC, keys, balances against the floors, escrow admin, proving material; sends nothing
  foga genesis run --world <world.json> [--rpc <url>] [--until T0..T9] [--store <file.sqlite>] [--out <evidence.json>]
                   [--zk auto|require|skip] [--crash-after <opKey>] [--crash-before <opKey>]
                                                 run the genesis scenario (idempotent; re-run to resume)
  foga genesis status --world <world.json> [--store <file.sqlite>]    list the operations the store holds
  foga demo [--port <n>] [--keep] [--genesis <T0..T9>]   start anvil, deploy the local world, run the doctor (and the genesis)
  foga bundle info                               summarize the committed bundle
  foga cell …                                    a cell as a node: birth, migration, and every capability of the catalog as a subcommand (foga cell help)
  foga node tick | watch --config <cell.config.json>   the watchers of a running node (operator key alone)

environment:
  FOGA_SOLC_DIR   directory with solc-<version> static binaries (offline builds; otherwise forge downloads solc)
  FOGA_FOUNDRY_DIR  directory holding anvil (scripts/install-foundry.sh: the static Foundry build for older Linux)
  FOGA_RPC_URL    default RPC for doctor and genesis (world configs may name their own variable, e.g. SEPOLIA_RPC_URL)
  FOGA_MNEMONIC   the 12-word phrase the twelve genesis roles are derived from on non-anvil chains (role i at m/44'/60'/0'/0/i;
                  W = account 0 is also the world deployer); FOGA_MNEMONIC_FILE names a file holding it instead
  FOGA_KEY_<ROLE>   overrides one role's key (W, G, OWNER_A, OPERATOR_A, ..., E, J1, J2, J3); anvil derives all of them
  FOGA_DEPLOYER_PK  deployer key for world deploy when it is not W of the phrase (worlds/local.json falls back to anvil account #0)
  FOGA_OPERATOR_KEY_FILE  a node's one key (its cell's operator), written by 'foga keys export'; FOGA_OPERATOR_KEY holds the key itself.
                  A node refuses to start when its environment also carries FOGA_MNEMONIC[_FILE], FOGA_DEPLOYER_PK or any FOGA_KEY_<ROLE>
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

  if (group === "cell") {
    const { cellCommand } = await import("./cli-cell.js");
    await cellCommand(cmd, positional.slice(2), flags);
    return;
  }
  if (group === "node") {
    const { nodeCommand } = await import("./cli-cell.js");
    await nodeCommand(cmd, flags);
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
    if (cmd === "attach") {
      if (cfg.mode !== "attach") fail(`${worldConfigPath} is a deploy-mode config; use foga world deploy`);
      const bundle = exists(join(root, "artifacts", "bundle.json")) ? loadBundle() : null;
      const missing = missingPlanSteps(cfg);
      if (missing.length) log.warn(`the config does not list ${missing.length} reference contracts (${missing.join(", ")}); this address book is incomplete for a genesis — foga world deploy adds them from the bundle`);
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
      genesisPath: str(flags, "genesis") ? resolve(str(flags, "genesis")!) : undefined,
    });
    if (report && report.summary.Fail > 0) process.exitCode = 3;
    return;
  }

  if (group === "probe" && cmd === "relay-script") {
    const { RELAY_SCRIPT } = await import("./doctor/probe.js");
    process.stdout.write(RELAY_SCRIPT);
    return;
  }

  if (group === "keys" && cmd === "export") {
    const { ROLE_ORDER, envKeys, roleAddresses } = await import("./genesis/roles.js");
    const role = str(flags, "role");
    if (!role || !(ROLE_ORDER as readonly string[]).includes(role)) fail(`--role <role> is required: one of ${ROLE_ORDER.join(", ")}`);
    const out = resolve(str(flags, "out") ?? join(homedir(), ".foga", "keys", `${role}.key`));
    if (exists(out)) fail(`${out} exists; pass --out <file> for another file (an existing key file is never overwritten)`);
    const keys = envKeys([role as (typeof ROLE_ORDER)[number]]);
    mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, keys[role] + "\n", { mode: 0o600 });
    const address = roleAddresses(keys)[role];
    console.log(`${role} ${address}`);
    console.log(`key written to ${out} (mode 0600). Move it to the node's user (chown) and keep the phrase out of that user's environment:`);
    console.log(`  export FOGA_OPERATOR_KEY_FILE=${out}`);
    return;
  }

  if (group === "keys" && cmd === "check") {
    const { loadOperatorKey, KeyIsolationError } = await import("./node/keys.js");
    try {
      const key = loadOperatorKey();
      console.log(`operator key: ${key.address} (from ${key.source.kind === "env" ? key.source.name : key.source.path})`);
      console.log("the environment holds nothing that derives another role");
    } catch (e) {
      if (e instanceof KeyIsolationError) {
        console.log(`not a node environment: ${e.message}`);
        process.exitCode = 6;
        return;
      }
      throw e;
    }
    return;
  }

  if (group === "keys" && (cmd === "new" || cmd === "show")) {
    const { ROLE_ORDER, envKeys, newMnemonic, roleAddresses, mnemonicKeys } = await import("./genesis/roles.js");
    let keys: Record<string, string>;
    if (cmd === "new") {
      const out = resolve(str(flags, "out") ?? join(homedir(), ".foga", "genesis.mnemonic"));
      if (exists(out)) fail(`${out} exists; pass --out <file> for another phrase (an existing phrase is never overwritten)`);
      const phrase = newMnemonic();
      mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
      writeFileSync(out, phrase + "\n", { mode: 0o600 });
      keys = mnemonicKeys(phrase);
      console.log(`new phrase written to ${out} (mode 0600). Keep it out of the repository; anyone holding it holds every role.`);
      console.log(`  export FOGA_MNEMONIC_FILE=${out}`);
    } else {
      keys = envKeys(ROLE_ORDER);
    }
    const addresses = roleAddresses(keys);
    console.log("roles (W is the world deployer and the treasury: fund W, the genesis funds the rest):");
    for (const role of ROLE_ORDER) console.log(`  ${role.padEnd(11)} ${addresses[role]}${role === "W" ? "   <- fund this address" : ""}`);
    return;
  }

  if (group === "genesis" && cmd === "preflight") {
    const worldPath = str(flags, "world");
    if (!worldPath) fail("--world <world.json> is required (a deployed world)");
    const world = readJson<{ network: string }>(resolve(worldPath));
    const rpc = str(flags, "rpc") ?? process.env.FOGA_RPC_URL ?? (world.network === "anvil" ? "http://127.0.0.1:8545" : undefined);
    if (!rpc) fail("no RPC: pass --rpc or set FOGA_RPC_URL");
    const { preflight } = await import("./genesis/preflight.js");
    const problems = await preflight({ worldPath: resolve(worldPath), rpc, log: (line) => console.log(line) });
    if (problems.length) {
      console.log("\nproblems:");
      for (const p of problems) console.log(`  - ${p}`);
      process.exitCode = 5;
    } else console.log("\npreflight: ready");
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
      zk: str(flags, "zk") as any,
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

  // A machine that is already saturated (a proving-key build, for instance) starves anvil: blocks come late and the
  // kernel gives up on a receipt after its timeout. Say so before starting rather than after a failure.
  const cores = cpus().length || 1;
  const load = loadavg()[0];
  if (load > cores * 0.8) {
    log.warn(`this machine is busy (load ${load.toFixed(1)} on ${cores} core${cores === 1 ? "" : "s"}): another heavy process slows anvil down and can make the genesis time out waiting for receipts. If a proving-key build (npm run zk:predicate) is running, let it finish or stop it first.`);
  }

  // FOGA_FOUNDRY_DIR points at a Foundry install of its own (scripts/install-foundry.sh puts the static build there).
  const foundryDir = process.env.FOGA_FOUNDRY_DIR;
  const anvilBin = foundryDir ? join(foundryDir, "anvil") : "anvil";
  // anvil's output goes to a log file rather than a pipe: with --keep the node survives this process, and a
  // Rust program whose stderr pipe has gone away dies on its next write.
  const logPath = join(root, ".foga-build", "anvil.log");
  ensureDir(join(root, ".foga-build"));
  const logFd = openSync(logPath, "w");
  log.info(`starting anvil on ${rpc}${foundryDir ? ` (${anvilBin})` : ""}; log ${relative(root, logPath)}`);
  const anvil = spawn(anvilBin, ["--port", String(opts.port), "--silent"], { stdio: ["ignore", logFd, logFd], detached: opts.keep });
  closeSync(logFd);
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
        ? foundryDir
          ? `${anvilBin} not found (FOGA_FOUNDRY_DIR=${foundryDir}). Run scripts/install-foundry.sh ${foundryDir} first.`
          : "anvil not found on PATH. Install Foundry (https://getfoundry.sh: `curl -L https://foundry.sh | bash && foundryup`), or run scripts/install-foundry.sh and export FOGA_FOUNDRY_DIR, or use docker compose."
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
    let output = "";
    try {
      output = readFileSync(logPath, "utf8").slice(-8000);
    } catch {
      /* no log */
    }
    const why = exited ? `anvil stopped (${exited}) before serving ${rpc}` : `anvil did not serve ${rpc} within 20 s`;
    const glibc = /GLIBC_[0-9.]+' not found/.test(output)
      ? "\nThis anvil is the glibc build and this machine's glibc is older than it needs (GLIBC >= 2.35: Ubuntu 22.04 or newer). Install the static build next to it: `scripts/install-foundry.sh` then `export FOGA_FOUNDRY_DIR=~/.foga/foundry` (or put that directory first on PATH)."
      : "";
    fail(`${why}.${output.trim() ? `\n--- anvil output ---\n${output.trim()}\n--------------------` : ""}${glibc}\nRun \`${anvilBin} --port ${opts.port}\` by hand to see its output; \`${anvilBin} --version\` shows the installed version (CI uses Foundry v1.7.1).`);
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
    const evidencePath = join(root, "deployments", "local.genesis.json");
    const { failed } = await runGenesis({ worldPath: out, rpc, storePath, evidencePath, until: opts.genesis as any });
    if (failed > 0) process.exitCode = 4;
    // the doctor's fifth layer: what the genesis established, per standard
    const second = await runDoctor({ worldPath: out, rpc, outPath: join(root, "deployments", "local.doctor.json"), genesisPath: evidencePath, quiet: true });
    if (second.report && second.report.summary.Fail > 0) process.exitCode = 3;
  }
  if (opts.keep) {
    // Let this process return while anvil, started detached, keeps serving.
    anvil.unref();
    log.info(`anvil left running on ${rpc} (pid ${anvil.pid}, log ${relative(root, logPath)}); world at deployments/local.json. Stop it with: kill ${anvil.pid}`);
  } else stop();
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

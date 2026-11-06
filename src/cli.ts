#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, homedir, loadavg } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { buildBundle } from "./build/bundle.js";
import { syncVendor, verifyVendor } from "./build/vendor.js";
import { anvilBinary, launchAnvil, portProblem } from "./demo/anvil.js";
import { LOOP_D_MODELS, type LoopDModel } from "./demo/loop-d.js";
import { runDoctor } from "./doctor/doctor.js";
import { exists, readJson, repoRoot, writeJson } from "./util/fs.js";
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
  foga world verify --world <world.json> --sourcify [--dry-run] [--only <id,id>] [--server <url>] [--out <dir>] [--build-info <dir>]
                                                 submit every contract the world deployed from the bundle to Sourcify, with the standard JSON input of its
                                                 compiler run (.foga-build/out/<repo>/build-info, written by npm run bundle:verify); a local chain is a dry run
  foga wallet new [--name <n> | --dir <dir>] [--cell]   the first step: a key of your own — one signer in a 0600 file, your identity, which fills
                                                 every role a cell needs (default ~/.foga/wallet; --name under ~/.foga/wallets/<n>; --cell: the
                                                 separated owner/operator/guardian set for a guarded cell account). Never overwrites; prints the addresses
  foga wallet show [--name <n> | --dir <dir>] [--rpc <url>]   the wallet's addresses (and balances with an RPC)
  foga wallet sign (--config <cell.config.json> | --url <node url> | --cell <account> --chain-id <n>) [--name <n> | --dir <dir>]
                   [--role signer|operator|owner|guardian] [--ttl <s>] [--agent-id <id>] [--method <METHOD> --path <path> [--body '<json>' | --body-file <f>]]
                                                 an Authorization header (FOGA-EIP712) proving the wallet to that cell — named by its configuration, by its node's
                                                 URL (/healthz says which account and chain) or by hand: a session envelope, or one bound to a request
  foga keys new [--out <file>]                   write a fresh 12-word phrase (default ~/.foga/genesis.mnemonic) and print the role addresses
  foga keys show                                 print the role addresses the environment derives (FOGA_MNEMONIC[_FILE], FOGA_KEY_*)
  foga keys export --role <role> [--out <file>]  write one role's key to a 0600 file for a node that holds that key alone
                                                 (default ~/.foga/keys/<role>.key; the node reads it from FOGA_OPERATOR_KEY_FILE)
  foga keys check                                check the current environment as a node would: its operator key alone, nothing that derives other roles
  foga doctor --world <world.json> [--rpc <url>] [--out <report.json>] [--genesis <evidence.json>]
  foga doctor --world <config.json> --attach [--rpc <url>] [--out <report.json>]
  foga doctor --world <...> --export-probe <probe.json>      write the JSON-RPC probe plan instead of calling an RPC
  foga doctor --world <...> --import-results <results.json>  evaluate results collected by a relay (offline replay)
  foga doctor [--world <world.json>] --loop-d <evidence.json> [--compare <evidence2.json>] [--out <report.json>]
                                                 the Loop D verdicts from a run's evidence (beside layer 5 when --world is given; alone otherwise)
  foga probe relay-script                        print a dependency-free node script that runs a probe plan
  foga genesis preflight --world <world.json> [--rpc <url>]   check RPC, keys, balances against the floors, escrow admin, proving material; sends nothing
  foga genesis run --world <world.json> [--rpc <url>] [--until T0..T9] [--store <file.sqlite>] [--out <evidence.json>]
                   [--zk auto|require|skip] [--crash-after <opKey>] [--crash-before <opKey>]
                                                 run the genesis scenario (idempotent; re-run to resume)
  foga genesis status --world <world.json> [--store <file.sqlite>]    list the operations the store holds
  foga quickstart [--dir <dir>] [--wallet <dir>] [--port <n>] [--listen <host:port> | --no-serve] [--name <cell>] [--no-tenders] [--exit]
                                                 one command to a live cell: the wallet (made on the first run, reused after), anvil, the local world, a cell born with
                                                 the wallet's keys and its two skills, two tenders, the node serving HTTP and MCP, and the MCP client configurations
                                                 printed with every path filled in (~/.foga/quickstart)
  foga join [--chain sepolia | --world <deployed.json>] [--rpc <url>] [--name <cell>] [--dir <dir>] [--wallet <dir>]
            [--listen <host:port> | --no-serve] [--public-url <url>] [--run stub|anthropic] [--no-wait] [--min-wei <n>] [--capital-wei <n>] [--exit]
                                                 one command to a cell that lives on a public chain: the wallet (made once, the same address on every chain), the
                                                 chain's world from the package, a wait for the identity to be funded, the birth, the skills minted and offered, the
                                                 documents on chain, the node served (or run with a model); resumable, in ~/.foga/cells/<network>/<name>, never cleared
  foga demo [--port <n>] [--keep] [--genesis <T0..T9>]   start anvil, deploy the local world, run the doctor (and the genesis)
  foga demo --loop-d [--model stub|anthropic|external] [--model-name <name>] [--seed <n>] [--no-recovery] [--port <n>] [--keep]
                                                 the above, then Loop D: a new cell born, a demander minting cases a-g, the node with a model (or served for an
                                                 outside agent), the recovery drill, the guardian's suspension; evidence to deployments/loop-d.local.json, judged by the doctor
  foga loop-d run --world <world.json> --rpc <url> [--dir <dir>] [--out <evidence.json>] [--model stub|anthropic|external] [--model-name <name>] [--seed <n>] [--no-recovery]
                  [--listen <host:port>] [--wait <s>] [--idle <s>]
                                                 Loop D on a world that exists (FOGA_FUNDER_KEY funds the cell's roles on a non-local chain); with --model external the
                                                 node is served and an outside agent — any model, any runtime — works the tenders through /mcp or /api with the key printed
  foga demo demander --world <w> --rpc <url> --store <sqlite> --cell <addr> --scheme <id> --issuer <addr> --probe-hash <h> --extract-hash <h> --cases a,b,c --seed <n> --out <json>
                                                 the independent demander of Loop D (FOGA_DEMANDER_KEY; anvil's first account by default)
  foga bundle info                               summarize the committed bundle
  foga cell …                                    a cell as a node: birth, migration, and every capability of the catalog as a subcommand (foga cell help)
  foga node tick | watch | mcp | serve | run | key new --config <cell.config.json>   a running node: the watchers, MCP over stdio, the HTTP server, the embedded runner, API keys
  foga mcp --config <cell.config.json>          = foga node mcp (what an MCP client's command line runs)

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
    await nodeCommand(cmd, positional.slice(2), flags);
    return;
  }
  if (group === "mcp") {
    // `npx -y @finchip.ai/foga mcp --config <cell.config.json>`: the stdio MCP server
    const { nodeCommand } = await import("./cli-cell.js");
    await nodeCommand("mcp", [], flags);
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

  if (group === "world" && cmd === "verify") {
    if (!flags.sourcify) fail("foga world verify --sourcify --world <world.json> (Sourcify is the one verifier wired so far)");
    const worldPath = str(flags, "world") ?? fail("--world <world.json> is required (a deployed world)");
    const { verifyWorld } = await import("./world/sourcify.js");
    const { report, outDir } = await verifyWorld({ worldPath: resolve(worldPath), server: str(flags, "server"), dryRun: flags["dry-run"] ? true : undefined, only: str(flags, "only")?.split(","), outDir: str(flags, "out") ? resolve(str(flags, "out")!) : undefined, buildInfoRoot: str(flags, "build-info") ? resolve(str(flags, "build-info")!) : undefined, log: (line) => console.error(line) });
    for (const r of report.results) console.log(`  ${r.outcome.padEnd(12)} ${r.id.padEnd(32)} ${r.address}  ${r.contractIdentifier} (${r.compilerVersion})${r.outcome === "dry-run" ? "" : `  ${r.detail}`}`);
    for (const m of report.missing) console.log(`  missing      ${m.id.padEnd(32)} ${m.reason}`);
    console.log(`sourcify: ${Object.entries(report.summary).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing to do"}${report.missing.length ? `, ${report.missing.length} missing` : ""}; report ${relative(root, join(outDir, "report.json"))}`);
    if (report.missing.length || report.results.some((r) => r.outcome === "failed" || r.outcome === "error")) process.exitCode = 3;
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
    if (!worldPath && str(flags, "loop-d")) {
      const { runLoopDDoctor } = await import("./doctor/doctor.js");
      const report = runLoopDDoctor({ evidencePath: resolve(str(flags, "loop-d")!), comparePath: str(flags, "compare") ? resolve(str(flags, "compare")!) : undefined, outPath: str(flags, "out") ? resolve(str(flags, "out")!) : undefined });
      if (report.summary.Fail > 0) process.exitCode = 3;
      return;
    }
    if (!worldPath) fail("--world <world.json> is required (or --loop-d <evidence.json> alone)");
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
      loopDPath: str(flags, "loop-d") ? resolve(str(flags, "loop-d")!) : undefined,
      loopDComparePath: str(flags, "compare") ? resolve(str(flags, "compare")!) : undefined,
    });
    if (report && report.summary.Fail > 0) process.exitCode = 3;
    return;
  }

  if (group === "probe" && cmd === "relay-script") {
    const { RELAY_SCRIPT } = await import("./doctor/probe.js");
    process.stdout.write(RELAY_SCRIPT);
    return;
  }

  if (group === "wallet") {
    const { CELL_ROLES, createWallet, loadWallet, walletDir, walletFileProblems } = await import("./node/wallet.js");
    const dir = resolve(str(flags, "dir") ?? walletDir(str(flags, "name")));
    const printWallet = async (w: Awaited<ReturnType<typeof loadWallet>> & object, made: boolean) => {
      console.log(`${made ? "wallet made at" : "wallet"} ${w.dir}${w.name !== "default" ? ` (${w.name})` : ""}, ${w.createdAt}`);
      const rpc = str(flags, "rpc") ?? process.env.FOGA_RPC_URL;
      const provider = rpc ? new (await import("ethers")).JsonRpcProvider(rpc) : null;
      for (const role of w.roles) {
        let balance = "";
        if (provider) {
          try {
            balance = `   ${(await import("ethers")).formatEther(await provider.getBalance(w.addresses[role]))} ETH`;
          } catch {
            balance = "   (balance: RPC did not answer)";
          }
        }
        console.log(`  ${role.padEnd(9)} ${w.addresses[role]}${balance}   ${w.files[role]}`);
      }
      provider?.destroy();
      for (const p of walletFileProblems(w)) log.warn(p);
      const single = w.roles.length === 1 && w.roles[0] === "signer";
      if (single) console.log(`one key, your identity; it fills every role a cell needs. For a cell's birth, fund this address (capital and gas), then: foga cell new --wallet ${dir} … and foga cell init --config <cfg> --wallet ${dir}`);
      else if (w.roles.includes("owner")) console.log(`a separated cell wallet; fund the owner for a cell's birth (capital and gas) and the operator for its gas, then: foga cell new --wallet ${dir} … and foga cell init --config <cfg> --wallet ${dir}`);
    };
    if (cmd === "new") {
      const existing = loadWallet(dir);
      if (existing) {
        await printWallet(existing, false);
        console.log("(already there; a wallet is never overwritten — foga wallet new --name <n> makes another)");
        return;
      }
      // the base is one key (--single, now the default); --cell makes the separated owner/operator/guardian set (the guarded FogaCellAccount profile)
      const roles = flags.cell ? [...CELL_ROLES] : undefined;
      try {
        await printWallet(createWallet(dir, { name: str(flags, "name") ?? "default", roles }), true);
      } catch (e) {
        fail((e as Error).message);
      }
      return;
    }
    if (cmd === "show") {
      const w = loadWallet(dir);
      if (!w) fail(`no wallet at ${dir}; foga wallet new makes one`);
      await printWallet(w, false);
      return;
    }
    if (cmd === "sign") {
      const w = loadWallet(dir);
      if (!w) fail(`no wallet at ${dir}; foga wallet new makes one`);
      const { walletKey } = await import("./node/wallet.js");
      const { loadCellConfig, configPath } = await import("./node/config.js");
      const { signAuthorization } = await import("./http/signed.js");
      const { Wallet } = await import("ethers");
      // the cell the signature is for: its own configuration (the operator's shell), its node's URL (anyone's: /healthz names the account and the chain), or both values by hand
      let cellAddress: string;
      let chainId: number;
      let cellName: string;
      if (str(flags, "config")) {
        const loaded = loadCellConfig(str(flags, "config")!);
        cellAddress = loaded.config.identity.account ?? fail("the config names no account yet (the cell is not born)");
        chainId = readJson<{ chainId: number }>(configPath(loaded, loaded.config.world)).chainId;
        cellName = loaded.config.name;
      } else if (str(flags, "url")) {
        const base = str(flags, "url")!.replace(/\/+$/, "");
        let health: { ok?: boolean; cell?: string; account?: string | null; chainId?: number };
        try {
          health = (await (await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) })).json()) as typeof health;
        } catch (e) {
          fail(`${base}/healthz did not answer: ${(e as Error).message}`);
        }
        if (!health.account || !health.chainId) fail(`${base}/healthz names no account or chain (${JSON.stringify(health).slice(0, 200)}); the cell is not born or this is not a FOGA node`);
        cellAddress = health.account;
        chainId = health.chainId;
        cellName = health.cell ?? base;
      } else if (str(flags, "cell") && str(flags, "chain-id")) {
        cellAddress = str(flags, "cell")!;
        chainId = Number(str(flags, "chain-id"));
        cellName = cellAddress;
      } else fail("the signature is made for one cell: --config <cell.config.json>, or --url <its node's URL>, or --cell <account> --chain-id <n>");
      const role = (str(flags, "role") ?? (w.roles.includes("signer") ? "signer" : "operator")) as "signer" | "operator" | "owner" | "guardian";
      let key: string;
      try {
        key = walletKey(w, role);
      } catch (e) {
        fail((e as Error).message);
      }
      const method = str(flags, "method");
      const path = str(flags, "path");
      if ((method && !path) || (!method && path)) fail("--method and --path go together");
      const bodyText = str(flags, "body") ?? (str(flags, "body-file") ? readFileSync(resolve(str(flags, "body-file")!), "utf8") : undefined);
      const header = await signAuthorization(new Wallet(key), { chainId, cell: cellAddress, ttlSeconds: str(flags, "ttl") ? Number(str(flags, "ttl")) : undefined, agentId: str(flags, "agent-id"), request: method ? { method, path: path!, body: bodyText ?? null } : undefined });
      console.error(`${role} ${new Wallet(key).address} signed ${method ? `a ${method} ${path} envelope` : "a session envelope"} for cell ${cellName} (${cellAddress}, chain ${chainId}); the header value follows (one line):`);
      console.log(header);
      return;
    }
    fail("foga wallet new | show | sign");
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

  if (group === "demo" && cmd === "demander") {
    const { mintCases } = await import("./demo/demander.js");
    const { anvilKeys } = await import("./genesis/roles.js");
    const need = (k: string) => str(flags, k) ?? fail(`--${k} is required`);
    const worldPath = resolve(need("world"));
    const worldFile = readJson<{ network?: string }>(worldPath);
    const key = process.env.FOGA_DEMANDER_KEY ?? (worldFile.network === "anvil" ? anvilKeys().W : undefined);
    if (!key) fail("FOGA_DEMANDER_KEY is required on a non-local world");
    const cases = (str(flags, "cases") ?? "a,b,c,d,d2,e").split(",").map((c) => c.trim()) as any;
    const result = await mintCases({ worldPath, rpc: need("rpc"), storePath: resolve(need("store")), key, cell: need("cell"), schemeId: need("scheme"), issuers: need("issuer").split(","), packages: { "foga-probe": need("probe-hash"), "finch-extract-verify": need("extract-hash") }, cases, seed: Number(str(flags, "seed") ?? 7), log: (line) => console.error(line) });
    const out = str(flags, "out");
    if (out) writeJson(resolve(out), result);
    else console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (group === "loop-d" && cmd === "run") {
    const { runLoopD, defaultLoopDDir } = await import("./demo/loop-d.js");
    const worldPath = str(flags, "world") ?? fail("--world <world.json> is required");
    const rpc = str(flags, "rpc") ?? process.env.FOGA_RPC_URL ?? fail("--rpc <url> is required");
    await runLoopD({ rpc, worldPath: resolve(worldPath), dir: str(flags, "dir") ? resolve(str(flags, "dir")!) : defaultLoopDDir(), evidencePath: resolve(str(flags, "out") ?? join(root, "deployments", "loop-d.local.json")), funderKey: process.env.FOGA_FUNDER_KEY, ...loopDFlags(flags) });
    return;
  }

  if (group === "quickstart") {
    const { runQuickstart } = await import("./demo/quickstart.js");
    let result;
    try {
      result = await runQuickstart({ dir: str(flags, "dir"), wallet: str(flags, "wallet"), port: str(flags, "port") ? Number(str(flags, "port")) : undefined, listen: flags["no-serve"] ? null : str(flags, "listen"), name: str(flags, "name"), tenders: !flags["no-tenders"], exit: Boolean(flags.exit) });
    } catch (e) {
      fail((e as Error).message);
    }
    if (flags.exit) {
      await result.stop();
      return;
    }
    let asked = false;
    const stopping = () => {
      if (asked) return;
      asked = true;
      console.error("quickstart: stopping the node and the chain");
      result.stop().finally(() => process.exit(0));
    };
    process.on("SIGINT", stopping);
    process.on("SIGTERM", stopping);
    const why = await result.ended;
    if (why === "stopped") return; // a stop that was asked for: both children are gone
    fail(`${why}; the quickstart is over`);
  }

  if (group === "join") {
    const { runJoin } = await import("./node/join.js");
    const run = str(flags, "run");
    if (run && run !== "stub" && run !== "anthropic") fail("--run must be stub or anthropic");
    let result;
    try {
      result = await runJoin({
        chain: str(flags, "chain"),
        world: str(flags, "world"),
        rpc: str(flags, "rpc"),
        name: str(flags, "name"),
        dir: str(flags, "dir"),
        wallet: str(flags, "wallet"),
        listen: flags["no-serve"] ? null : str(flags, "listen"),
        publicUrl: str(flags, "public-url"),
        run: (run as "stub" | "anthropic" | undefined) ?? null,
        wait: !flags["no-wait"],
        minWei: str(flags, "min-wei") ? BigInt(str(flags, "min-wei")!) : undefined,
        capitalWei: str(flags, "capital-wei") ? BigInt(str(flags, "capital-wei")!) : undefined,
        exit: Boolean(flags.exit),
      });
    } catch (e) {
      fail((e as Error).message);
    }
    if (flags.exit || !result.nodeUrl) {
      await result.stop();
      return;
    }
    // Ctrl-C / SIGTERM: runJoin installed the handler (the node stops, the cell stays)
    const why = await result.ended;
    if (why === "stopped") return;
    fail(`${why}; start it again with the same command`);
  }

  if (group === "demo") {
    await demo({ port: Number(str(flags, "port") ?? 8545), keep: Boolean(flags.keep), genesis: str(flags, "genesis") as any, loopD: flags["loop-d"] ? loopDFlags(flags) : undefined });
    return;
  }

  console.log(USAGE);
  fail(`unknown command: ${positional.join(" ")}`);
}

/** The Loop D options the flags name (shared by `foga demo --loop-d` and `foga loop-d run`). */
function loopDFlags(flags: Args["flags"]): { model: LoopDModel; modelName?: string; seed?: number; recovery: boolean; listen?: string; waitMs?: number; idleMs?: number } {
  const model = (str(flags, "model") ?? "stub") as LoopDModel;
  if (!LOOP_D_MODELS.includes(model)) fail(`--model must be one of ${LOOP_D_MODELS.join(", ")}`);
  const seconds = (key: string) => (str(flags, key) ? Number(str(flags, key)) * 1000 : undefined);
  return { model, modelName: str(flags, "model-name") ?? process.env.FOGA_MODEL, seed: str(flags, "seed") ? Number(str(flags, "seed")) : undefined, recovery: !flags["no-recovery"], listen: str(flags, "listen"), waitMs: seconds("wait"), idleMs: seconds("idle") };
}

async function demo(opts: { port: number; keep: boolean; genesis?: string; loopD?: ReturnType<typeof loopDFlags> }): Promise<void> {
  const root = repoRoot();
  const rpc = `http://127.0.0.1:${opts.port}`;

  // Say what is wrong before starting anything: a port that is already taken makes anvil exit at once, and a
  // silent exit would otherwise surface only as "the RPC did not come up".
  const problem = await portProblem(opts.port);
  if (problem) fail(problem);

  // A machine that is already saturated (a proving-key build, for instance) starves anvil: blocks come late and the
  // kernel gives up on a receipt after its timeout. Say so before starting rather than after a failure.
  const cores = cpus().length || 1;
  const load = loadavg()[0];
  if (load > cores * 0.8) {
    log.warn(`this machine is busy (load ${load.toFixed(1)} on ${cores} core${cores === 1 ? "" : "s"}): another heavy process slows anvil down and can make the genesis time out waiting for receipts. If a proving-key build (npm run zk:predicate) is running, let it finish or stop it first.`);
  }

  // FOGA_FOUNDRY_DIR points at a Foundry install of its own (scripts/install-foundry.sh puts the static build there).
  // anvil's output goes to a log file rather than a pipe: with --keep the node survives this process, and a
  // Rust program whose stderr pipe has gone away dies on its next write.
  const { path: anvilBin, fromDir } = anvilBinary();
  const logPath = join(root, ".foga-build", "anvil.log");
  log.info(`starting anvil on ${rpc}${fromDir ? ` (${anvilBin})` : ""}; log ${relative(root, logPath)}`);
  let anvil;
  try {
    anvil = await launchAnvil({ port: opts.port, logPath, detached: opts.keep });
  } catch (e) {
    fail((e as Error).message);
  }
  const stop = () => {
    if (!opts.keep && !anvil.killed) anvil.kill("SIGTERM");
  };
  process.on("exit", stop);
  process.on("SIGINT", () => {
    stop();
    process.exit(130);
  });
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
  if (opts.loopD) {
    const { runLoopD, defaultLoopDDir } = await import("./demo/loop-d.js");
    const evidencePath = join(root, "deployments", "loop-d.local.json");
    await runLoopD({ rpc, worldPath: out, dir: defaultLoopDDir(), evidencePath, ...opts.loopD });
    const judged = await runDoctor({ worldPath: out, rpc, outPath: join(root, "deployments", "local.doctor.json"), genesisPath: opts.genesis ? join(root, "deployments", "local.genesis.json") : undefined, loopDPath: evidencePath, quiet: true });
    if (judged.report && judged.report.summary.Fail > 0) process.exitCode = 3;
  }
  if (opts.keep) {
    // Let this process return while anvil, started detached, keeps serving.
    anvil.unref();
    log.info(`anvil left running on ${rpc} (pid ${anvil.pid}, log ${relative(root, logPath)}); world at deployments/local.json. Stop it with: kill ${anvil.pid}`);
  } else stop();
}

main().catch((e) => {
  fail(e?.stack ?? String(e));
});

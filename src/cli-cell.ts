import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { newCellConfig, saveCellConfig } from "./node/config.js";
import { cellInit } from "./node/init.js";
import { KeyIsolationError, forbiddenVariables, loadOperatorKey, loadRoleKey } from "./node/keys.js";
import { cellMigrate } from "./node/migrate.js";
import { Node, type NodeKeys } from "./node/node.js";
import { loadWallet, walletKey, type WalletInfo, type WalletRole } from "./node/wallet.js";
import { Watchers } from "./node/watchers.js";
import { defaultCatalog, OPERATOR_CALLER, PUBLIC_CALLER, type Caller, type Mode } from "./tools/index.js";
import { exists, repoRoot } from "./util/fs.js";
import { fail } from "./util/log.js";

/**
 * `foga cell …` and `foga node …`: the CLI entrance to the capability catalog (design memo, Phase 3, section 5).
 * Every capability is a subcommand generated from the catalog; the differences from the other entrances are who
 * is calling (the operator, at full level, unless --caller and --level say otherwise) and where the keys are (this
 * shell's environment, loaded for the one command: the operator's for an act, the owner's or guardian's for an
 * admin capability, none for reads, builds and dry runs).
 */
export const CELL_USAGE = `
  foga cell list [--public] [--as-json]          the capabilities (action, visibility, principal, modes) as the operator or as the public sees them
  foga cell schema <capability>                  the input and output JSON Schema of a capability
  foga cell new --name <cell> --world <world.json> --store <ops.sqlite> --out <cell.config.json> (--wallet <dir> | --owner <addr> --operator <addr> --guardian <addr>) [--rpc <url>] [--skills <dir>] [--input-dir <dir>]
  foga cell init --config <cell.config.json> [--wallet <dir>] [--rpc <url>] [--capital-wei <n>]
                                                 the cell's birth (the owner's key: the wallet's, or FOGA_OWNER_KEY[_FILE]); writes the account, agent id, binding, record and unit into the config
  foga cell migrate --config <cell.config.json> --to <new.config.json> [--store <new ops.sqlite>] [--operator <addr>] [--capital-wei <n>] [--no-sweep]
                                                 move the cell to a new revision-2 account (the owner's key); the new config and store are written beside
  foga cell extend --covenants 8490 --config <cell.config.json> [--wallet <dir>] [--rpc <url>] [--registry <addr>]
                                                 extend a running cell in place with a covenant the program gained (ERC-8490): the registry enters the
                                                 cell's world file (from the packaged world of its chain, or --registry), the owner opens the operator's
                                                 maintenance scope and enrolls the cell through its account, the registry is read back; idempotent, no migration
  foga cell status --config <cell.config.json>   cell_status as the operator
  foga cell card --config <cell.config.json> [--as-json]
                                                 the cell's card: what it is and how to reach it, in the words another agent needs (no chain call)
  foga cell advise --config <cell.config.json> [--brief] [--as-json]
                                                 what a running cell should do next — separate the roles, tune the policy, standing, a public face, a supervisor,
                                                 backups, a dedicated RPC — only what applies to this cell; advice, never required; no chain read, no key
  foga cell docs build --config <cell.config.json> [--rpc <url>] [--out <dir>]
                                                 the cell's documents from its configuration and the chain (registration, AID document, ARD descriptor, AUF unit,
                                                 agent card, server.json, manifest) under runtime.http.documentsDir — what the node serves at /documents and /.well-known
  foga cell docs publish --config <cell.config.json> [--wallet <dir>] [--rpc <url>]
                                                 build, then commit on chain what differs (setAgentURI, setDocumentURI, updateDescriptor, publishVersion; the operator
                                                 key, one keyed job), then read every commitment back
  foga cell docs status --config <cell.config.json> [--rpc <url>]   what is built, what the chain holds, what a publish would commit
  foga cell <capability> --config <cell.config.json> [--wallet <dir>] [--mode simulate|build|act] [--json '<input json>' | --json-file <f>] [--<field> <value> ...]
                                                 any capability; an act loads the operator key, an admin capability the owner's or the guardian's — from --wallet, or from
                                                 FOGA_OPERATOR_KEY[_FILE], FOGA_OWNER_KEY[_FILE], FOGA_GUARDIAN_KEY[_FILE]
                                                 [--caller <id> --level read|build|act] call as another caller (what the public or an API-key holder would get)
  foga cell owner <capability> … | foga cell guardian <capability> …   the same, said explicitly
  foga node <command> … [--wallet <dir>]         every node command takes the operator key from the wallet's operator.key (= FOGA_OPERATOR_KEY_FILE)
  foga node preflight --config <cell.config.json> [--wallet <dir>] [--rpc <url>] [--no-executors] [--no-network] [--out <report.json>] [--strict]
                                                 the readiness reconciliation before the public is served: the account and its allow-list, the operator key and its
                                                 gas, the standing, the skills' packages and executors, the documents against the chain, the public URL, the model;
                                                 advisory (exit 5 on a Fail only with --strict)
  foga node tick --config <cell.config.json>     run the watchers once (heartbeat, discovery, settlement, safety) in a node environment (operator key alone)
  foga node watch --config <cell.config.json> [--interval <s>]   run the watchers on the poll interval until stopped
  foga node mcp --config <cell.config.json>      MCP over stdio for a local client (Claude Desktop, Claude Code, Cursor): the operator's full level with
                                                 FOGA_OPERATOR_KEY[_FILE] in the environment, read and build without it; logs go to stderr
  foga node serve --config <cell.config.json> [--listen <host:port>] [--no-watch]
                                                 host mode: POST /api/<capability>, /mcp (Streamable HTTP), /a2a (A2A 1.0), /.well-known/agent-card.json, /documents/*,
                                                 /healthz, / — the public reads and builds, a Bearer key or a wallet signature (FOGA-EIP712) acts as its grant says;
                                                 the watchers run beside it; no model
  foga node key new --config <cell.config.json> --id <id> [--level read|build|act] [--visibility public|caller|operator] [--note <text>]
                                                 mint an API key for the HTTP entrance: printed once, kept only as its hash in the config
  foga node run --config <cell.config.json> [--model stub|anthropic] [--listen <host:port> | --no-http] [--interval <s>] [--once | --ticks <n>] [--transcripts <dir>]
                                                 the embedded node: the HTTP server, the watchers and the runner (a model proposing acts the catalog
                                                 judges) on the poll interval; the operator key alone; anthropic needs ANTHROPIC_API_KEY and runtime.model.model
  foga meditate status --config <cell.config.json> [--rpc <url>] [--as-json]   the ERC-8490 maintenance status: enrollment, state version and root, each layer's
                                                 timeliness (FRESH / DUE / OVERDUE) and commitment, the signal, the policy; what the node keeps beside it
  foga meditate run --config <cell.config.json> [--wallet <dir>] [--layers 0,1,2,3] [--trigger commanded|scheduled|event|self] [--detail <text>] [--dry-run] [--job-id <id>]
                                                 one maintenance cycle (meditate_run, the operator key): the routines locally, the four state documents
                                                 rebuilt, one report through the account; --dry-run computes and shows the cycle, sends and keeps nothing;
                                                 --job-id resumes an interrupted cycle
  foga meditate enroll | policy --config <cell.config.json> [--wallet <dir>]   the owner's acts through the account: enroll (baseline, policy, guardian as
                                                 controller; opens the maintenance scope when missing), policy (record maintenance.policy as a new version)
  foga meditate controller --to <addr> [--rights 7] --config … [--wallet <dir>]   appoint (the owner, when none is set) or transfer / shrink / renounce (the guardian)
  foga meditate demand [--layers …] [--due-in-seconds 86400] [--withdraw] | floor [--required-layers n] [--pulse-interval s] [--max-interval a,b,c,d]
                                                 the controller's acts (the guardian key): a demand with a deadline, a floor the policy cannot relax
  foga meditate pulse [--next-planned-at <ts>] [--force] --config … [--wallet <dir>]   an activity signal through the account (the operator key)
`;

type Flags = Record<string, string | boolean>;
const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);

const RESERVED = new Set(["config", "mode", "json", "json-file", "caller", "level", "rpc", "public", "help", "wallet"]);

function inputFromFlags(flags: Flags): Record<string, unknown> {
  let input: Record<string, unknown> = {};
  const inline = str(flags, "json");
  const file = str(flags, "json-file");
  if (inline) input = JSON.parse(inline);
  if (file) input = { ...input, ...JSON.parse(readFileSync(resolve(file), "utf8")) };
  for (const [k, v] of Object.entries(flags)) {
    if (RESERVED.has(k)) continue;
    if (typeof v === "boolean") input[k] = v;
    else if (/^[\[{]/.test(v)) {
      try {
        input[k] = JSON.parse(v);
      } catch {
        input[k] = v;
      }
    } else input[k] = v;
  }
  return input;
}

function callerFromFlags(flags: Flags): Caller {
  const id = str(flags, "caller");
  const level = str(flags, "level") as Caller["level"] | undefined;
  if (!id && !level) return OPERATOR_CALLER;
  const lvl = level ?? "build";
  if (!["read", "build", "act", "admin"].includes(lvl)) fail(`--level must be read, build, act or admin`);
  return { id: id ?? "caller", entrance: "cli", level: lvl, visibility: lvl === "admin" ? "operator" : id ? "caller" : "public" };
}

/** The wallet `--wallet <dir>` names, or null without the flag. */
function walletFromFlags(flags: Flags): WalletInfo | null {
  const dir = str(flags, "wallet");
  if (!dir) return null;
  const w = loadWallet(resolve(dir));
  if (!w) fail(`${resolve(dir)} holds no wallet (no wallet.json); foga wallet new --dir ${resolve(dir)} makes one`);
  return w;
}

/**
 * The RPC a one-shot command uses: `--rpc`, the configuration's `rpc`, `FOGA_RPC_URL`, else — on a chain the program
 * knows — its first public endpoint, said once on stderr (what `foga join` does; shared and rate-limited, a dedicated one
 * is advised). A local world needs none (Node.open falls back to anvil's address).
 */
async function rpcFor(configPath: string, flagRpc: string | undefined, log: (line: string) => void): Promise<string | undefined> {
  if (flagRpc) return flagRpc;
  try {
    const { loadCellConfig, configPath: cfgPath } = await import("./node/config.js");
    const loaded = loadCellConfig(configPath);
    if (loaded.config.rpc) return loaded.config.rpc;
    if (process.env.FOGA_RPC_URL) return process.env.FOGA_RPC_URL;
    const world = JSON.parse(readFileSync(cfgPath(loaded, loaded.config.world), "utf8")) as { chainId?: number; network?: string };
    if (world.network === "anvil") return undefined;
    const { chainById } = await import("./core/chains.js");
    const chain = world.chainId ? chainById(Number(world.chainId)) : null;
    if (chain && process.env[chain.rpcEnv]) return process.env[chain.rpcEnv];
    if (chain?.rpc[0]) {
      log(`no RPC given; using the public endpoint ${chain.rpc[0]} (shared and rate-limited — a dedicated one is advised: --rpc <url> or ${chain.rpcEnv})`);
      return chain.rpc[0];
    }
  } catch {
    /* Node.open says what is missing */
  }
  return undefined;
}

/** A role's key: from the wallet when --wallet is given, from the environment otherwise. */
function keysFor(role: "operator" | "owner" | "guardian", strict = false, wallet: WalletInfo | null = null): string {
  if (wallet) {
    try {
      return walletKey(wallet, role as WalletRole);
    } catch (e) {
      fail((e as Error).message);
    }
  }
  try {
    return (role === "operator" && strict ? loadOperatorKey() : loadRoleKey(role)).privateKey;
  } catch (e) {
    if (e instanceof KeyIsolationError) fail(e.message);
    throw e;
  }
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
}

export async function cellCommand(cmd: string | undefined, rest: string[], flags: Flags): Promise<void> {
  const catalog = defaultCatalog();
  if (!cmd || cmd === "help") {
    console.log(CELL_USAGE);
    return;
  }
  if (cmd === "list") {
    const caller = flags.public ? PUBLIC_CALLER : OPERATOR_CALLER;
    const rows = catalog.list(caller).map((c) => ({ name: c.name, action: c.action, visibility: c.visibility, principal: c.principal, modes: c.modes.join("/") || "-", ercs: c.ercs.join(" "), title: c.title }));
    if (flags["as-json"]) return print(rows);
    const w = Math.max(...rows.map((r) => r.name.length));
    console.log(`${"capability".padEnd(w)}  action  visibility  principal  modes               ercs`);
    for (const r of rows) console.log(`${r.name.padEnd(w)}  ${r.action.padEnd(6)}  ${r.visibility.padEnd(10)}  ${r.principal.padEnd(9)}  ${r.modes.padEnd(18)}  ${r.ercs}`);
    console.log(`\n${rows.length} capabilities${flags.public ? " visible to the public" : ""}; foga cell schema <capability> for the input and output schemas`);
    return;
  }
  if (cmd === "schema") {
    const name = rest[0];
    const cap = name ? catalog.get(name) : undefined;
    if (!cap) fail(`unknown capability ${name ?? "(none)"}; foga cell list shows them`);
    return print({ name: cap.name, title: cap.title, description: cap.description, action: cap.action, visibility: cap.visibility, principal: cap.principal, ercs: cap.ercs, input: z.toJSONSchema(cap.input, { target: "draft-2020-12", io: "input" }), output: z.toJSONSchema(cap.output, { target: "draft-2020-12", io: "output" }) });
  }
  if (cmd === "new") {
    const wallet = walletFromFlags(flags);
    const need = (k: string) => str(flags, k) ?? (wallet && wallet.addresses[k] ? wallet.addresses[k] : fail(`--${k} is required (or --wallet <dir> with a ${k} key)`));
    const out = resolve(need("out"));
    if (exists(out)) fail(`${out} exists; choose another --out (a config is never overwritten)`);
    // paths in a config resolve against the config's directory; the defaults point at the repository's skills and
    // fixtures, relative when the config lives inside the repository and absolute when it does not
    const outDir = dirname(out);
    const root = repoRoot();
    const defaultDir = (sub: string) => (outDir.startsWith(root) ? relative(outDir, join(root, sub)) || "." : join(root, sub));
    const cfg = newCellConfig({ name: need("name"), world: relative(outDir, resolve(need("world"))), store: relative(outDir, resolve(need("store"))), owner: need("owner"), operator: need("operator"), guardian: need("guardian"), rpc: str(flags, "rpc"), skillsDir: str(flags, "skills") ?? defaultDir("scenarios/skills"), inputDir: str(flags, "input-dir") ?? defaultDir("scenarios/fixtures") });
    saveCellConfig(out, cfg);
    console.log(`cell config written to ${out}; fill presence and policy as you like, then: foga cell init --config ${out}`);
    return;
  }

  const configPath = str(flags, "config") ?? fail("--config <cell.config.json> is required");
  const log = (line: string) => console.error(line);
  const rpc = await rpcFor(configPath, str(flags, "rpc"), log);
  const wallet = walletFromFlags(flags);

  if (cmd === "card") {
    const { cellCard, formatCard } = await import("./node/card.js");
    const { version } = await import("./util/version.js");
    const node = await Node.open({ configPath, rpc, keys: {}, allowUnborn: true, log: () => {} });
    try {
      const card = cellCard(node, { version });
      if (flags["as-json"]) return print(card);
      console.log(formatCard(card));
    } finally {
      node.close();
    }
    return;
  }

  if (cmd === "advise") {
    const { adviseCell, formatAdvice } = await import("./node/advise.js");
    const node = await Node.open({ configPath, rpc, keys: {}, allowUnborn: true, log: () => {} });
    try {
      const advice = adviseCell(node);
      if (flags["as-json"]) return print(advice);
      console.log(formatAdvice(advice, { brief: Boolean(flags.brief), config: configPath }));
    } finally {
      node.close();
    }
    return;
  }

  if (cmd === "init") {
    const owner = keysFor("owner", false, wallet);
    const node = await Node.open({ configPath, rpc, keys: { owner }, allowUnborn: true, log });
    try {
      const capital = str(flags, "capital-wei");
      const result = await cellInit(node, { capitalWei: capital ? BigInt(capital) : undefined, log });
      print(result);
      // Born: say what a cell should do next, once, briefly — the first run stays minimal, the hardening is advice.
      const { adviseCell, formatAdvice } = await import("./node/advise.js");
      const next = formatAdvice(adviseCell(node), { brief: true, config: configPath });
      if (next) console.error(`\n${next}`);
    } finally {
      node.close();
    }
    return;
  }
  if (cmd === "migrate") {
    const owner = keysFor("owner", false, wallet);
    const to = resolve(str(flags, "to") ?? fail("--to <new.config.json> is required"));
    if (exists(to)) fail(`${to} exists; choose another --to`);
    const node = await Node.open({ configPath, rpc, keys: { owner }, log });
    try {
      const capital = str(flags, "capital-wei");
      const result = await cellMigrate(node, { toConfigPath: to, toStorePath: str(flags, "store") ?? to.replace(/\.json$/, "") + ".ops.sqlite", operator: str(flags, "operator"), capitalWei: capital ? BigInt(capital) : undefined, sweep: !flags["no-sweep"], log });
      print(result);
    } finally {
      node.close();
    }
    return;
  }

  if (cmd === "extend") {
    const covenants = (str(flags, "covenants") ?? fail("--covenants 8490 is required (the covenant to extend the cell with)")).split(",").map((c) => c.trim()).filter(Boolean);
    const { extendWorld, EXTENSIONS } = await import("./node/extend.js");
    const { loadCellConfig, configPath: cfgPath } = await import("./node/config.js");
    for (const c of covenants) if (!EXTENSIONS[c]) fail(`unknown covenant ${c}; this build extends with ${Object.keys(EXTENSIONS).join(", ")}`);
    const owner = keysFor("owner", false, wallet);
    const loaded = loadCellConfig(configPath);
    const worldPath = cfgPath(loaded, loaded.config.world);
    const rpcUrl = rpc;
    const results: Record<string, unknown> = {};
    for (const c of covenants) {
      // 1. the world file: the covenant's contract, from the packaged world of the chain or the address given
      const ext = await extendWorld({ worldPath, covenant: c, address: str(flags, "registry"), rpc: rpcUrl, log });
      log(`extend ${c}: ${ext.contract} ${ext.outcome === "added" ? "added to" : "already in"} the world file at ${ext.address}`);
      // 2. the cell: the owner opens the maintenance scope and enrolls through the account (one keyed job; a refusal because it is enrolled already is the end state)
      const node = await Node.open({ configPath, rpc: rpcUrl, keys: { owner }, log });
      try {
        if (c === "8490") {
          const head = await node.kernel.meditation.headOf(node.body.address);
          let enrollment: unknown;
          if (head.enrolled) {
            enrollment = { alreadyEnrolled: true, stateVersion: head.stateVersion.toString(), root: head.root, policyVersion: head.policyVersion };
            log(`extend ${c}: ${node.body.address} is already enrolled (state version ${head.stateVersion}, policy v${head.policyVersion}); nothing sent`);
          } else {
            const r = await catalog.invoke(node, "meditate_enroll", {}, OPERATOR_CALLER, { mode: "act" });
            if (!r.ok) {
              print(r);
              process.exitCode = 2;
              return;
            }
            enrollment = r.output;
            log(`extend ${c}: enrolled — state version ${(r.output as { stateVersion: string }).stateVersion}, root ${(r.output as { root: string }).root}${(r.output as { scopeOpened: string[] }).scopeOpened.length ? `; scope opened: ${(r.output as { scopeOpened: string[] }).scopeOpened.join(", ")}` : ""} (job ${r.jobId})`);
          }
          // the scope, when the cell was enrolled before this build added the group
          const sc = await catalog.invoke(node, "scope_complete", { groups: ["maintenance"] }, OPERATOR_CALLER, { mode: "act" });
          if (sc.ok) log(`extend ${c}: allow-list completed: ${(sc.output as { added: string[] }).added.join(", ")}`);
          else if (!/allowed already/.test(sc.reason)) log(`extend ${c}: scope: ${sc.reason}`);
          // 3. read back
          const st = await catalog.invoke(node, "meditate_status", {}, OPERATOR_CALLER);
          results[c] = { world: ext, enrollment, status: st.ok ? st.output : st.reason };
        }
      } finally {
        node.close();
      }
    }
    print(results);
    return;
  }

  if (cmd === "docs") {
    const sub = rest[0];
    const { buildDocuments, readBack, documentsDir, onChainState, readBuilt, publishSteps } = await import("./node/documents.js");
    const { version } = await import("./util/version.js");
    if (sub === "build") {
      const node = await Node.open({ configPath, rpc, keys: {}, log });
      try {
        const built = await buildDocuments(node, { version, dir: str(flags, "out") });
        console.error(`documents v${built.manifest.version} written to ${built.dir}:`);
        for (const [file, d] of Object.entries(built.manifest.documents)) console.error(`  ${file.padEnd(20)} ${d.standard.padEnd(40)} ${d.contentHash}`);
        const { steps, unchanged } = await publishSteps(node, built);
        console.error(steps.length ? `a publish would commit: ${steps.map((x) => x.label).join("; ")}` : "every commitment on chain matches what was built");
        if (unchanged.length) console.error(`already as built: ${unchanged.join(", ")}`);
        print(built.manifest);
      } finally {
        node.close();
      }
      return;
    }
    if (sub === "status") {
      const node = await Node.open({ configPath, rpc, keys: {}, log });
      try {
        const dir = documentsDir(node);
        const built = readBuilt(dir);
        const rows = built ? await readBack(node, built) : [];
        print({ dir, manifest: built?.manifest ?? null, onChain: await onChainState(node), readBack: rows, pending: built ? (await publishSteps(node, built)).steps.map((x) => x.label) : [] });
        if (rows.some((r) => r.ok === false)) process.exitCode = 2;
      } finally {
        node.close();
      }
      return;
    }
    if (sub === "publish") {
      const node = await Node.open({ configPath, rpc, keys: { operator: keysFor("operator", false, wallet) }, log });
      try {
        const result = await catalog.invoke(node, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
        if (!result.ok) {
          print(result);
          process.exitCode = 2;
          return;
        }
        const out = result.output as { dir: string; version: number; committed: string[]; unchanged: string[]; readBack: { commitment: string; ok: boolean | null; detail: string }[]; jobId: string; operations: string[] };
        console.error(`documents v${out.version} in ${out.dir}: ${out.committed.length ? `committed ${out.committed.join(", ")}` : "nothing to commit"}${out.unchanged.length ? `; already as built: ${out.unchanged.join(", ")}` : ""} (job ${out.jobId}, ${out.operations.length} operation(s))`);
        // the read-back from here fetches the URLs too, when the node serves them
        const built = readBuilt(out.dir)!;
        const rows = await readBack(node, built, { fetchUrls: true });
        for (const r of rows) console.error(`  ${r.ok === true ? "ok     " : r.ok === false ? "FAIL   " : "unread "} ${r.commitment.padEnd(26)} ${r.detail}`);
        print({ ...out, readBack: rows });
        if (rows.some((r) => r.ok === false)) {
          console.error("a commitment read back from the chain does not match what was built: the publish is not complete");
          process.exitCode = 2;
        }
      } finally {
        node.close();
      }
      return;
    }
    fail("foga cell docs build | publish | status");
  }

  // a capability, possibly said as "owner <capability>" / "guardian <capability>"
  let name = cmd;
  let explicitRole: "owner" | "guardian" | null = null;
  if (cmd === "owner" || cmd === "guardian") {
    explicitRole = cmd;
    name = rest.shift() ?? fail(`foga cell ${cmd} <capability> …`);
  }
  if (name === "status") name = "cell_status";
  const cap = catalog.get(name);
  if (!cap) fail(`unknown capability ${name}; foga cell list shows them`);
  const mode = (str(flags, "mode") ?? "act") as Mode;
  if (!["simulate", "build", "act"].includes(mode)) fail("--mode must be simulate, build or act");
  const caller = callerFromFlags(flags);
  const keys: NodeKeys = {};
  if (cap.action !== "read" && mode === "act") {
    if (cap.action === "admin") {
      const role = cap.signer ?? explicitRole ?? "owner";
      keys[role] = keysFor(role, false, wallet);
    } else keys.operator = keysFor("operator", false, wallet);
  }
  const node = await Node.open({ configPath, rpc, keys, log });
  try {
    const input = inputFromFlags(flags);
    const result = await catalog.invoke(node, name, input, caller, { mode });
    print(result);
    if (!result.ok) process.exitCode = 2;
  } finally {
    node.close();
  }
}

/**
 * `foga meditate <verb> …`: the ERC-8490 capabilities said in the maintenance vocabulary. Each verb is one capability
 * of the catalog with the key its signer needs: run and pulse the operator's, enroll and policy the owner's, demand and
 * floor the guardian's, controller the owner's or the guardian's as the registry's state decides (docs/meditation.md).
 */
export async function meditateCommand(verb: string | undefined, _rest: string[], flags: Flags): Promise<void> {
  const catalog = defaultCatalog();
  const verbs: Record<string, { capability: string; role: "operator" | "owner" | "guardian" | "none" | "either" }> = {
    status: { capability: "meditate_status", role: "none" },
    run: { capability: "meditate_run", role: "operator" },
    pulse: { capability: "meditate_pulse", role: "operator" },
    enroll: { capability: "meditate_enroll", role: "owner" },
    policy: { capability: "meditate_policy", role: "owner" },
    controller: { capability: "meditate_controller", role: "either" },
    demand: { capability: "meditate_demand", role: "guardian" },
    floor: { capability: "meditate_floor", role: "guardian" },
  };
  if (!verb || verb === "help" || !verbs[verb]) {
    if (verb && verb !== "help") console.error(`unknown verb ${verb}`);
    const lines = CELL_USAGE.split("\n");
    const from = lines.findIndex((l) => /foga meditate status/.test(l));
    const to = lines.findIndex((l) => /foga meditate pulse/.test(l));
    console.log(from >= 0 && to >= from ? lines.slice(from, to + 1).join("\n") : CELL_USAGE);
    return;
  }
  const { capability, role } = verbs[verb];
  const configPath = str(flags, "config") ?? fail("--config <cell.config.json> is required");
  const log = (line: string) => console.error(line);
  const rpc = await rpcFor(configPath, str(flags, "rpc"), log);
  const wallet = walletFromFlags(flags);
  const dryRun = Boolean(flags["dry-run"]);
  const mode: Mode = dryRun ? "simulate" : "act";
  // the input: the flags, in the capability's names
  const input: Record<string, unknown> = {};
  const take = (flag: string, field: string, f: (v: string) => unknown = (v) => v) => {
    const v = str(flags, flag);
    if (v !== undefined) input[field] = f(v);
    else if (flags[flag] === true) input[field] = true;
  };
  take("layers", "layers");
  take("trigger", "trigger");
  take("detail", "detail");
  take("job-id", "jobId");
  take("next-planned-at", "nextPlannedAt", Number);
  take("force", "force");
  take("to", "to");
  take("rights", "rights", Number);
  take("due-in-seconds", "dueInSeconds", Number);
  take("withdraw", "withdraw");
  take("required-layers", "requiredLayers", Number);
  take("pulse-interval", "pulseInterval", Number);
  take("max-interval", "maxInterval", (v) => v.split(",").map((x) => Number(x.trim())));
  take("subject", "subject");
  const keys: NodeKeys = {};
  if (mode === "act" && role !== "none") {
    if (role === "either") {
      // the registry's state decides whose act it is; both keys may be at hand, and the plan refuses when the right one is not
      for (const r of ["owner", "guardian"] as const) {
        try {
          keys[r] = keysFor(r, false, wallet);
        } catch {
          /* not here */
        }
      }
      if (!keys.owner && !keys.guardian) fail("meditate controller needs the owner's key (to appoint a controller) or the guardian's (to transfer, shrink or renounce)");
    } else keys[role] = keysFor(role, false, wallet);
  }
  const node = await Node.open({ configPath, rpc, keys, log });
  try {
    const result = await catalog.invoke(node, capability, input, OPERATOR_CALLER, { mode });
    if (verb === "status" && result.ok && !flags["as-json"]) {
      const { formatMaintenanceStatus } = await import("./node/meditation-cycle.js");
      console.log(formatMaintenanceStatus(result.output as Parameters<typeof formatMaintenanceStatus>[0]));
      return;
    }
    print(result);
    if (!result.ok) process.exitCode = result.gate === "pending" ? 3 : 2;
  } finally {
    node.close();
  }
}

/** The node's own key situation: the operator key alone (acting), or none at all (reads and builds); anything else is refused. */
function nodeKeys(): { operator?: string } {
  const forbidden = forbiddenVariables(process.env);
  if (forbidden.length) fail(`the node's environment holds ${forbidden.join(", ")}: a node runs with its operator key alone (FOGA_OPERATOR_KEY or FOGA_OPERATOR_KEY_FILE), or with no key for reads and builds`);
  try {
    return { operator: loadOperatorKey().privateKey };
  } catch (e) {
    if (e instanceof KeyIsolationError && /no operator key/.test(e.message)) return {};
    if (e instanceof KeyIsolationError) fail(e.message);
    throw e;
  }
}

/** Who a local stdio client is: the operator when the key is here, otherwise the machine's user — operator data, build level. */
function localCaller(hasKey: boolean): Caller {
  return hasKey ? { ...OPERATOR_CALLER, entrance: "mcp" } : { id: "local", entrance: "mcp", level: "build", visibility: "operator" };
}

export async function nodeCommand(cmd: string | undefined, rest: string[], flags: Flags): Promise<void> {
  if (!cmd || cmd === "help") {
    console.log(CELL_USAGE);
    return;
  }
  const configPath = str(flags, "config") ?? fail("--config <cell.config.json> is required");
  const log = (line: string) => console.error(line);
  const rpcGiven = await rpcFor(configPath, str(flags, "rpc"), log);
  if (rpcGiven) flags.rpc = rpcGiven;
  // --wallet <dir>: the operator key file of the wallet, as FOGA_OPERATOR_KEY_FILE would name it; never beside another key source
  const wallet = walletFromFlags(flags);
  if (wallet) {
    if (process.env.FOGA_OPERATOR_KEY || process.env.FOGA_OPERATOR_KEY_FILE) fail("--wallet and FOGA_OPERATOR_KEY[_FILE] are both set; a node takes its operator key from one place");
    if (!wallet.files.operator) fail(`wallet ${wallet.dir} has no operator key`);
    process.env.FOGA_OPERATOR_KEY_FILE = wallet.files.operator;
  }

  if (cmd === "preflight") {
    const { preflight, printPreflight } = await import("./node/preflight.js");
    const { writeJson } = await import("./util/fs.js");
    const node = await Node.open({ configPath, rpc: str(flags, "rpc"), keys: {}, log });
    try {
      const report = await preflight(node, { executors: !flags["no-executors"], network: !flags["no-network"] });
      printPreflight(report, (line) => console.log(line));
      if (str(flags, "out")) writeJson(resolve(str(flags, "out")!), report);
      if (flags.strict && report.summary.Fail > 0) process.exitCode = 5;
    } finally {
      node.close();
    }
    return;
  }

  if (cmd === "key") {
    if (rest[0] !== "new") fail("foga node key new --config <cfg> --id <id> [--level act] [--visibility caller]");
    const id = str(flags, "id") ?? fail("--id <id> is required");
    const { loadCellConfig } = await import("./node/config.js");
    const loaded = loadCellConfig(configPath);
    if (loaded.config.access.keys.some((k) => k.id === id)) fail(`a key with id ${id} exists; choose another id (or remove the old entry from the config first)`);
    const level = (str(flags, "level") ?? "act") as "read" | "build" | "act";
    const visibility = (str(flags, "visibility") ?? "caller") as "public" | "caller" | "operator";
    if (!["read", "build", "act"].includes(level)) fail("--level must be read, build or act");
    if (!["public", "caller", "operator"].includes(visibility)) fail("--visibility must be public, caller or operator");
    const { newApiKey } = await import("./http/server.js");
    const made = newApiKey(id);
    loaded.config.access.keys.push({ id, sha256: made.sha256, level, visibility, note: str(flags, "note") });
    saveCellConfig(loaded.path, loaded.config);
    console.error(`key ${id} (${level}, ${visibility}) recorded in ${loaded.path} as its hash; the key itself is printed once below and never again:`);
    console.log(made.key);
    return;
  }

  if (cmd === "mcp") {
    const keys = nodeKeys();
    const node = await Node.open({ configPath, rpc: str(flags, "rpc"), keys, log });
    const catalog = defaultCatalog();
    const caller = localCaller(Boolean(keys.operator));
    const { buildMcpServer } = await import("./mcp/server.js");
    const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
    const { version } = await import("./util/version.js");
    log(`foga ${version}: MCP over stdio for cell ${node.config.name}${node.cell ? ` (${node.cell.address})` : ""}; caller ${caller.id} at level ${caller.level}`);
    const handle = await serveStdio(() => buildMcpServer({ node, catalog, caller, version }), { onerror: (e) => log(`mcp: ${e.message}`) });
    const stop = () => {
      handle.close().finally(() => {
        node.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    process.stdin.on("end", stop);
    return;
  }

  if (cmd === "serve") {
    const keys = nodeKeys();
    const node = await Node.open({ configPath, rpc: str(flags, "rpc"), keys, log });
    const catalog = defaultCatalog();
    const { createHttpServer, startWatchLoop } = await import("./http/server.js");
    const { version } = await import("./util/version.js");
    const listen = str(flags, "listen") ?? node.config.runtime.http.listen;
    const running = await createHttpServer({ node, catalog, version, log }).listen(listen);
    const { documentsDir, readBuilt } = await import("./node/documents.js");
    const built = readBuilt(documentsDir(node));
    const signers = node.config.access.signers;
    log(`foga ${version}: serving cell ${node.config.name}${node.cell ? ` (${node.cell.address})` : ""} at ${running.url} — /mcp, /api/<capability>, /a2a, /.well-known/agent-card.json, /documents/*, /healthz; ${keys.operator ? "acting with the operator key" : "no operator key: reads and builds only"}; ${node.config.access.keys.length} API key(s) configured; signatures: ${signers.default} by default, ${signers.allow.length} allowed${signers.standing ? `, standing level ${signers.standing.minLevel}+ granted ${signers.standing.level}` : ""}; documents ${built ? `v${built.manifest.version}` : "not built (foga cell docs build)"}`);
    {
      // One line of advice at start-up (the full list is `foga cell advise`); nothing here is a condition of serving.
      const { adviseCell } = await import("./node/advise.js");
      const recommended = adviseCell(node).filter((a) => a.level === "recommended");
      if (recommended.length) log(`advice: ${recommended.map((a) => a.id).join(", ")} — foga cell advise --config ${configPath} explains; nothing required`);
    }
    const stopWatch = !flags["no-watch"] && keys.operator && node.cell ? startWatchLoop(new Watchers(node, catalog), node.config.runtime.pollSeconds * 1000, log) : () => {};
    const stop = () => {
      stopWatch();
      running.close().finally(() => {
        node.close();
        process.exit(0);
      });
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  if (cmd === "run") {
    const keys = nodeKeys();
    if (!keys.operator) fail("foga node run acts for the cell and needs its operator key (FOGA_OPERATOR_KEY or FOGA_OPERATOR_KEY_FILE); without a key, foga node serve offers reads and builds");
    const node = await Node.open({ configPath, rpc: str(flags, "rpc"), keys, log });
    const catalog = defaultCatalog();
    const { Runner } = await import("./node/runner.js");
    const { StubAdapter } = await import("./node/model/stub.js");
    const { AnthropicAdapter } = await import("./node/model/anthropic.js");
    const { version } = await import("./util/version.js");
    const providerName = str(flags, "model") ?? node.config.runtime.model.provider;
    if (providerName !== "stub" && providerName !== "anthropic") fail("--model must be stub or anthropic");
    let adapter;
    try {
      adapter = providerName === "stub" ? new StubAdapter() : new AnthropicAdapter(node.config.runtime.model.model ?? "");
    } catch (e) {
      node.close();
      fail((e as Error).message);
    }
    const runner = new Runner(node, catalog, adapter, { transcriptsDir: str(flags, "transcripts"), log });
    const watchers = new Watchers(node, catalog);
    let running: { url: string; close(): Promise<void> } | null = null;
    if (!flags["no-http"]) {
      const { createHttpServer } = await import("./http/server.js");
      running = await createHttpServer({ node, catalog, version, log }).listen(str(flags, "listen") ?? node.config.runtime.http.listen);
    }
    log(`foga ${version}: running cell ${node.config.name} (${node.body.address}) with model ${adapter.provider}/${adapter.model}${running ? ` at ${running.url}` : ", no HTTP"}; ${node.config.runtime.model.dailyCalls} model calls a day, ${node.config.runtime.model.maxActsPerTick} act(s) and ${node.config.runtime.model.maxToolCallsPerTick} tool call(s) a tick`);
    const interval = Number(str(flags, "interval") ?? node.config.runtime.pollSeconds) * 1000;
    const ticks = flags.once ? 1 : str(flags, "ticks") ? Number(str(flags, "ticks")) : Infinity;
    let stop = false;
    const shutdown = () => {
      stop = true;
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    let done = 0;
    try {
      while (!stop && done < ticks) {
        try {
          const w = await watchers.tick();
          log(`${w.at} block ${w.block}: anchor ${w.anchor}, heartbeat ${w.heartbeat.sent ? "sent" : "not sent"} (${w.heartbeat.reason}); ${w.discovered.length} new tender(s); ${w.settled.filter((x) => x.outcome === "settled").length} settled${w.settled.some((x) => x.outcome !== "settled") ? ` (${w.settled.filter((x) => x.outcome !== "settled").map((x) => `${x.tokenId}: ${x.outcome}`).join("; ")})` : ""}, ${w.withdrawn.length} withdrawn; safety ${w.safety.verdict}${w.safety.changed ? " (changed)" : ""}`);
        } catch (e) {
          log(`watch: ${(e as Error).message}`);
        }
        try {
          const r = await runner.tick();
          if (r.skipped) log(`runner: ${r.skipped}`);
        } catch (e) {
          log(`runner: ${(e as Error).message}`);
        }
        done++;
        if (stop || done >= ticks) break;
        await new Promise((r) => setTimeout(r, interval));
      }
    } finally {
      if (running) await running.close();
      node.close();
    }
    return;
  }

  if (cmd !== "tick" && cmd !== "watch") fail(`unknown node command ${cmd}; tick, watch, mcp, serve, run, preflight or key`);
  // a node environment: the operator key alone, nothing that derives another role
  const operator = keysFor("operator", true);
  const node = await Node.open({ configPath, rpc: str(flags, "rpc"), keys: { operator }, log });
  const watchers = new Watchers(node, defaultCatalog());
  try {
    if (cmd === "tick") {
      print(await watchers.tick());
      return;
    }
    const interval = Number(str(flags, "interval") ?? node.config.runtime.pollSeconds) * 1000;
    let stop = false;
    process.on("SIGINT", () => (stop = true));
    process.on("SIGTERM", () => (stop = true));
    console.error(`watching cell ${node.config.name} (${node.body.address}) every ${interval / 1000} s; Ctrl-C to stop`);
    while (!stop) {
      try {
        const r = await watchers.tick();
        console.error(`${r.at} block ${r.block}: anchor ${r.anchor}, heartbeat ${r.heartbeat.sent ? "sent" : "not sent"} (${r.heartbeat.reason}); ${r.discovered.length} new tender(s); ${r.settled.filter((x) => x.outcome === "settled").length} settled${r.settled.some((x) => x.outcome !== "settled") ? ` (${r.settled.filter((x) => x.outcome !== "settled").map((x) => `${x.tokenId}: ${x.outcome}`).join("; ")})` : ""}, ${r.withdrawn.length} withdrawn; safety ${r.safety.verdict}${r.safety.changed ? " (changed)" : ""}`);
      } catch (e) {
        console.error(`tick failed: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  } finally {
    node.close();
  }
}

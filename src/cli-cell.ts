import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { newCellConfig, saveCellConfig } from "./node/config.js";
import { cellInit } from "./node/init.js";
import { KeyIsolationError, loadOperatorKey, loadRoleKey } from "./node/keys.js";
import { cellMigrate } from "./node/migrate.js";
import { Node, type NodeKeys } from "./node/node.js";
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
  foga cell new --name <cell> --world <world.json> --store <ops.sqlite> --owner <addr> --operator <addr> --guardian <addr> --out <cell.config.json> [--rpc <url>] [--skills <dir>] [--input-dir <dir>]
  foga cell init --config <cell.config.json> [--rpc <url>] [--capital-wei <n>]
                                                 the cell's birth (the owner's key: FOGA_OWNER_KEY[_FILE]); writes the account, agent id, binding, record and unit into the config
  foga cell migrate --config <cell.config.json> --to <new.config.json> [--store <new ops.sqlite>] [--operator <addr>] [--capital-wei <n>] [--no-sweep]
                                                 move the cell to a new revision-2 account (the owner's key); the new config and store are written beside
  foga cell status --config <cell.config.json>   cell_status as the operator
  foga cell <capability> --config <cell.config.json> [--mode simulate|build|act] [--json '<input json>' | --json-file <f>] [--<field> <value> ...]
                                                 any capability; an act loads FOGA_OPERATOR_KEY[_FILE], an admin capability FOGA_OWNER_KEY[_FILE] or FOGA_GUARDIAN_KEY[_FILE]
                                                 [--caller <id> --level read|build|act] call as another caller (what the public or an API-key holder would get)
  foga cell owner <capability> … | foga cell guardian <capability> …   the same, said explicitly
  foga node tick --config <cell.config.json>     run the watchers once (heartbeat, discovery, settlement, safety) in a node environment (operator key alone)
  foga node watch --config <cell.config.json> [--interval <s>]   run the watchers on the poll interval until stopped
`;

type Flags = Record<string, string | boolean>;
const str = (flags: Flags, key: string): string | undefined => (typeof flags[key] === "string" ? (flags[key] as string) : undefined);

const RESERVED = new Set(["config", "mode", "json", "json-file", "caller", "level", "rpc", "public", "help"]);

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

function keysFor(role: "operator" | "owner" | "guardian", strict = false): string {
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
    const need = (k: string) => str(flags, k) ?? fail(`--${k} is required`);
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
  const rpc = str(flags, "rpc");
  const log = (line: string) => console.error(line);

  if (cmd === "init") {
    const owner = keysFor("owner");
    const node = await Node.open({ configPath, rpc, keys: { owner }, allowUnborn: true, log });
    try {
      const capital = str(flags, "capital-wei");
      const result = await cellInit(node, { capitalWei: capital ? BigInt(capital) : undefined, log });
      print(result);
    } finally {
      node.close();
    }
    return;
  }
  if (cmd === "migrate") {
    const owner = keysFor("owner");
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
      keys[role] = keysFor(role);
    } else keys.operator = keysFor("operator");
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

export async function nodeCommand(cmd: string | undefined, flags: Flags): Promise<void> {
  if (!cmd || cmd === "help") {
    console.log(CELL_USAGE);
    return;
  }
  const configPath = str(flags, "config") ?? fail("--config <cell.config.json> is required");
  if (cmd !== "tick" && cmd !== "watch") fail(`unknown node command ${cmd}; tick or watch`);
  // a node environment: the operator key alone, nothing that derives another role
  const operator = keysFor("operator", true);
  const node = await Node.open({ configPath, rpc: str(flags, "rpc"), keys: { operator }, log: (line) => console.error(line) });
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
        console.error(`${r.at} block ${r.block}: anchor ${r.anchor}, heartbeat ${r.heartbeat.sent ? "sent" : "not sent"} (${r.heartbeat.reason}); ${r.discovered.length} new tender(s); ${r.settled.length} settled, ${r.withdrawn.length} withdrawn; safety ${r.safety.verdict}${r.safety.changed ? " (changed)" : ""}`);
      } catch (e) {
        console.error(`tick failed: ${(e as Error).message}`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  } finally {
    node.close();
  }
}

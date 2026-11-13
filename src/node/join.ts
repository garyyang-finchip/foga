import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { JsonRpcProvider, formatEther, parseEther } from "ethers";
import { chainById, chainByName, packagedWorld, resolveRpc, CHAINS, type ChainInfo } from "../core/chains.js";
import { newApiKey } from "../http/access.js";
import { adviseCell, formatAdvice } from "./advise.js";
import { cellCard, formatCard, type CellCard } from "./card.js";
import { loadCellConfig, newCellConfig, saveCellConfig } from "./config.js";
import { marketOf } from "./flows.js";
import { birthState, cellInit } from "./init.js";
import { Node } from "./node.js";
import { ensureWallet, ensuredKey, walletDir, type EnsuredWallet } from "./wallet.js";
import { defaultCatalog, OPERATOR_CALLER } from "../tools/index.js";
import { clientConfigs, clientLauncher } from "../demo/quickstart.js";
import { cleanEnv, ownCli, waitForHttp } from "../demo/loop-d.js";
import { nextFreePort, portInUse } from "../demo/anvil.js";
import { repoRoot } from "../util/fs.js";
import { PACKAGE_NAME, version } from "../util/version.js";
import { checkWorldJson, safeSegment, sha256Of } from "../world/source.js";

/**
 * `foga join`: one command from a key to a cell that lives on a public chain — the persistent counterpart of the
 * quickstart, whose chain ends with its process. The wallet is made or reused; the chain's world comes with the
 * package; the identity's balance is watched until it can pay for a birth; then the cell is born, its skills minted
 * and offered, its documents committed, and the node served (or run with a model) — every step the kernel's, so a
 * join interrupted anywhere is resumed by the same command, and nothing is sent twice. The cell's files live in a
 * directory that is never cleared: the configuration, the store, the world's address book and the skill packages
 * copied beside it, so the cell does not depend on where the package was installed.
 *
 * One key is one address on every EVM chain: the same wallet joins any chain that has a world; a chain without one
 * gets one from `foga world deploy`, and its address book is then this command's `--world`.
 */
export interface JoinOptions {
  /** The chain by name (`sepolia`; docs/join.md). Default sepolia. */
  chain?: string;
  /** A deployed world's address book (a path), instead of the packaged one of `--chain`. */
  world?: string;
  /** The URL the address book was fetched from, when `--world` was given as one (src/world/source.ts); recorded in the configuration and join.json. */
  worldUrl?: string | null;
  rpc?: string;
  /** The cell's name (its ERC-8004 registration and documents carry it). Default `cell-<first four hex of the identity>`. */
  name?: string;
  /** Where the cell's files live. Default ~/.foga/cells/<network>/<name>. Never cleared. */
  dir?: string;
  /** The wallet directory. Default ~/.foga/wallet. */
  wallet?: string;
  /** host:port the node listens on (default 127.0.0.1:8787, the next free port when taken); null serves no node. */
  listen?: string | null;
  /** The URL the cell is reachable at from outside, when there is one; it goes into the documents and the card. */
  publicUrl?: string;
  /** Run the node with a model (autonomous: it takes the tenders it is eligible for) instead of serving it. */
  run?: "stub" | "anthropic" | null;
  /** Wait for the identity to be funded (default true); false fails at once with the funding message. */
  wait?: boolean;
  /** The balance the identity needs before the birth is attempted (default 0.03 ETH on a public chain, 0 on anvil). */
  minWei?: bigint;
  /** Working capital the owner gives the account at birth (the kernel's default when absent). */
  capitalWei?: bigint;
  /** Stop the node right after the bring-up (tests, scripts). */
  exit?: boolean;
  /** The skills to mint and offer; default the two packaged ones. */
  skills?: string[];
  log?: (line: string) => void;
  out?: (text: string) => void;
}

export interface JoinResult {
  dir: string;
  configPath: string;
  worldPath: string;
  rpc: string;
  chainId: number;
  network: string;
  account: string;
  agentId: string | null;
  resumed: boolean;
  nodeUrl: string | null;
  card: CellCard;
  stop(): Promise<void>;
  /** Resolves with the reason the node ended (its exit, or "stopped"). */
  ended: Promise<string>;
}

export const JOIN_MARKER = "join.json";
export const DEFAULT_SKILLS = ["foga-probe", "finch-extract-verify"];
/** The stub's daily call cap: free, so effectively none (one tick a block for a month). */
export const STUB_DAILY_CALLS = 1_000_000;
const PUBLIC_MIN = parseEther("0.03");
const PUBLIC_COMFORTABLE = parseEther("0.05");

export function fogaHome(): string {
  return process.env.FOGA_HOME ?? join(homedir(), ".foga");
}

/** What a person is told while the identity waits for ether. */
export function fundingMessage(p: { address: string; chain: ChainInfo | null; network: string; chainId: number; balanceWei: bigint; minWei: bigint }): string {
  const lines: string[] = [];
  const need = p.minWei - p.balanceWei;
  lines.push(`fund ${p.address} on ${p.network} (chain ${p.chainId}) with at least ${formatEther(need)} ETH more (it holds ${formatEther(p.balanceWei)}, needs ${formatEther(p.minWei)}; ${formatEther(PUBLIC_COMFORTABLE)} is comfortable).`);
  if (p.chain?.testnet && p.chain.faucets.length) lines.push(`  test ether is free: ${p.chain.faucets.join("  ·  ")}`);
  if (p.chain && !p.chain.testnet) lines.push("  this is a mainnet: the ether is real, and so is everything the cell will commit to.");
  if (p.chain?.explorer) lines.push(`  watch it arrive: ${p.chain.explorer}/address/${p.address}`);
  return lines.join("\n");
}

async function balanceOf(rpc: string, address: string): Promise<bigint> {
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  try {
    return await provider.getBalance(address);
  } catch (e) {
    const why = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message;
    throw new Error(`cannot reach the RPC ${rpc} (${why}); pass --rpc <url> for one this machine can reach`);
  } finally {
    provider.destroy();
  }
}

export async function runJoin(o: JoinOptions = {}): Promise<JoinResult> {
  const log = o.log ?? ((line: string) => console.error(line));
  const out = o.out ?? ((text: string) => console.log(text));
  const root = repoRoot();

  // --- the chain and its world: by name from the package, or a deployed address book given by path (or fetched from
  // a URL by the caller, src/world/source.ts). Whatever it came from, the file is checked the same way before any of
  // its fields names a directory: schema, worldId, chainId, network, contracts
  let chain: ChainInfo | null;
  let worldSource: string;
  if (o.world) {
    worldSource = resolve(o.world);
    if (!existsSync(worldSource)) throw new Error(`world file ${worldSource} not found`);
    const checked = checkWorldJson(readFileSync(worldSource, "utf8"), worldSource);
    chain = chainById(checked.chainId) ?? (checked.network ? chainByName(checked.network) : null);
  } else {
    const name = (o.chain ?? "sepolia").toLowerCase();
    chain = chainByName(name);
    if (!chain) throw new Error(`unknown chain "${name}"; known: ${Object.keys(CHAINS).join(", ")}. A chain not listed: deploy a world on it (foga world deploy --world worlds/<chain>.json --rpc <url>) and pass its address book with --world.`);
    const packaged = packagedWorld(chain);
    if (!packaged) throw new Error(`no world ships for ${chain.name}: deploy one (foga world deploy --world worlds/${chain.name}.json --rpc <url>) and pass its address book with --world <file>`);
    worldSource = packaged;
  }
  const worldText = readFileSync(worldSource, "utf8");
  const worldFile = JSON.parse(worldText) as { worldId: string; network?: string; chainId: number; contracts: Record<string, unknown> };
  if (!safeSegment(worldFile.network)) throw new Error(`${worldSource}: the world file's network is not a usable name (letters, digits, '.', '_' and '-' only)`);
  const network = worldFile.network;
  const local = network === "anvil";
  const rpcResolved = resolveRpc(chain, o.rpc);
  const rpc = rpcResolved.url;
  if (rpcResolved.source === "public") log(`join: no RPC given; using the public endpoint ${rpc} (shared and rate-limited — a dedicated one is advised: --rpc <url> or ${chain?.rpcEnv ?? "FOGA_RPC_URL"})`);

  // --- the wallet: one key, the identity, made once and reused on every chain
  const walletPath = resolve(o.wallet ?? walletDir());
  const wallet: EnsuredWallet = ensureWallet(walletPath, { name: "default" });
  if (wallet.ephemeral) throw new Error(`a cell that lives needs a wallet on disk, and ${walletPath} could not be written (${wallet.reason}); pass --wallet <a writable directory>`);
  const singleKey = wallet.wallet.roles.length === 1 && wallet.wallet.roles[0] === "signer";
  const identity = singleKey ? wallet.wallet.addresses.signer : wallet.wallet.addresses.owner;
  log(`join: wallet ${wallet.created ? "made" : "using"} ${wallet.wallet.dir} — ${singleKey ? `identity ${identity} (one key, every role)` : `owner ${wallet.wallet.addresses.owner}, operator ${wallet.wallet.addresses.operator}, guardian ${wallet.wallet.addresses.guardian}`}; the same address on every EVM chain`);

  // --- the cell's home: never cleared; a second join here resumes
  const name = o.name ?? `cell-${identity.slice(2, 6).toLowerCase()}`;
  if (!o.dir && !safeSegment(name)) throw new Error(`--name ${JSON.stringify(name)} cannot name the cell's directory (letters, digits, '.', '_' and '-' only); pass --dir <directory> to keep that name`);
  const dir = resolve(o.dir ?? join(fogaHome(), "cells", network, name));
  mkdirSync(dir, { recursive: true });
  const configPath = join(dir, "cell.config.json");
  const worldPath = join(dir, "world.json");
  const keysDir = join(dir, "keys");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  // a cell has one world. The copy made at the first join is what the cell reads from then on; a later join must bring
  // the same world (the same book, or a newer revision of it, which is said and not adopted — the cell's copy is the one
  // its contracts are read from, and replacing it is the operator's deliberate act, not a side effect of a resume)
  if (!existsSync(worldPath)) writeFileSync(worldPath, worldText);
  else {
    const kept = readFileSync(worldPath, "utf8");
    const keptFile = JSON.parse(kept) as { worldId?: unknown; chainId?: unknown };
    if (keptFile.worldId !== worldFile.worldId || keptFile.chainId !== worldFile.chainId) {
      throw new Error(`the cell in ${dir} lives in world ${String(keptFile.worldId)} (chain ${String(keptFile.chainId)}), and the address book given is world ${worldFile.worldId} (chain ${worldFile.chainId}). A cell has one world: pass the book of the world it lives in to resume it, or --dir <another directory> (and --name) for a new cell in this one.`);
    }
    if (kept !== worldText) log(`join: the address book given (sha256 ${sha256Of(worldText)}) differs from the cell's copy (sha256 ${sha256Of(kept)}) of the same world ${worldFile.worldId}; the cell keeps reading its copy, ${worldPath} — replace it by hand to adopt the new revision`);
  }
  // the skill packages and the fixtures travel with the cell: their hashes are what the chain holds, their files
  // must stay where the cell is, not where this version of the package happens to be installed
  for (const sub of ["skills", "fixtures"]) {
    const dst = join(dir, sub);
    if (!existsSync(dst)) cpSync(join(root, "scenarios", sub), dst, { recursive: true });
  }
  const resumed = existsSync(configPath);
  if (resumed) log(`join: resuming the cell in ${dir}`);
  else {
    const cfg = newCellConfig({
      name,
      world: "world.json",
      worldSource: o.worldUrl ?? undefined,
      store: "cell.ops.sqlite",
      owner: wallet.wallet.addresses.owner ?? identity,
      operator: wallet.wallet.addresses.operator ?? identity,
      guardian: wallet.wallet.addresses.guardian ?? identity,
      rpc: rpcResolved.source === "public" ? undefined : rpc,
      skillsDir: "skills",
      inputDir: "fixtures",
      description: `Cell ${name}: born by foga join on ${network}`,
    });
    // a day with a birth, two mints and a publish in it spends more gas than the default daily cap allows on a chain
    // that prices gas; the cap is raised to what the quickstart uses, and the operator's gas floor (a quarter of it)
    // stays under the funding gate below
    cfg.policy.budget.dailyGasWei = parseEther("0.02").toString();
    // the daily model-call cap guards a paid model; the stub is a decision table that costs nothing, and a cell run
    // with it must not fall silent after its twentieth tick of the day
    if (o.run === "stub") cfg.runtime.model = { ...cfg.runtime.model, provider: "stub", dailyCalls: STUB_DAILY_CALLS };
    cfg.runtime.http.listen = o.listen ?? "127.0.0.1:8787";
    if (o.publicUrl) cfg.runtime.http.publicUrl = o.publicUrl.replace(/\/+$/, "");
    saveCellConfig(configPath, cfg);
    log(`join: cell ${name} configured in ${dir} (world ${worldFile.worldId}, ${Object.keys(worldFile.contracts).length} contracts)`);
  }
  if (o.run === "stub") {
    const loaded = loadCellConfig(configPath);
    if (loaded.config.runtime.model.dailyCalls < STUB_DAILY_CALLS) {
      loaded.config.runtime.model = { ...loaded.config.runtime.model, provider: "stub", dailyCalls: STUB_DAILY_CALLS };
      saveCellConfig(configPath, loaded.config);
      log(`join: the stub costs nothing; the daily model-call cap is ${STUB_DAILY_CALLS}`);
    }
  }
  if (o.publicUrl) {
    const loaded = loadCellConfig(configPath);
    if (loaded.config.runtime.http.publicUrl !== o.publicUrl.replace(/\/+$/, "")) {
      loaded.config.runtime.http.publicUrl = o.publicUrl.replace(/\/+$/, "");
      saveCellConfig(configPath, loaded.config);
    }
  }
  if (o.worldUrl && resumed) {
    // where the book came from is provenance: recorded once, when the cell has none; a different URL for the same
    // world later (a mirror, a move) is said, not written over the first
    const loaded = loadCellConfig(configPath);
    if (!loaded.config.worldSource) {
      loaded.config.worldSource = o.worldUrl;
      saveCellConfig(configPath, loaded.config);
    } else if (loaded.config.worldSource !== o.worldUrl) log(`join: the cell's address book came from ${loaded.config.worldSource}; this join read the same world from ${o.worldUrl} (the configuration keeps the first)`);
  }
  const cellWorldSha = sha256Of(readFileSync(worldPath, "utf8"));

  // --- the funding gate: nothing is sent until the identity can pay for its birth
  const minWei = o.minWei ?? (local ? 0n : PUBLIC_MIN);
  let balance = await balanceOf(rpc, identity);
  if (balance < minWei) {
    const msg = fundingMessage({ address: identity, chain, network, chainId: worldFile.chainId, balanceWei: balance, minWei });
    if (o.wait === false) throw new Error(`the identity is not funded yet.\n${msg}`);
    log(`join: waiting for ether — ${msg}`);
    const started = Date.now();
    let lastSaid = started;
    while (balance < minWei) {
      if (Date.now() - started > 60 * 60_000) throw new Error(`waited an hour for ${identity} to be funded; run the same command again once it is.\n${msg}`);
      await new Promise((r) => setTimeout(r, local ? 1000 : 15_000));
      balance = await balanceOf(rpc, identity);
      if (balance < minWei && Date.now() - lastSaid > 120_000) {
        lastSaid = Date.now();
        log(`join: still waiting — ${identity} holds ${formatEther(balance)} ETH, needs ${formatEther(minWei)}`);
      }
    }
    log(`join: funded — ${identity} holds ${formatEther(balance)} ETH`);
  } else log(`join: ${identity} holds ${formatEther(balance)} ETH`);

  // --- the birth: the owner's act; resumable, never repeated. The account is saved the moment it is deployed, so an
  // account in the configuration says the birth began, not that it ended (the binding adopted, the registration, the
  // record, the unit, the enrollment, the channel come after it): the store says which, and an interrupted birth is
  // resumed from its journal, nothing sent twice. A join that took an account for a birth minted nothing: the account
  // refuses every act until its safety binding is presented (ASF LengthMismatch: one clause, no binding).
  let born = loadCellConfig(configPath).config.identity.account ?? null;
  let agentId: string | null = loadCellConfig(configPath).config.identity.agentId ?? null;
  {
    const node = await Node.open({ configPath, rpc, keys: { owner: ensuredKey(wallet, "owner") }, allowUnborn: true, log: () => {} });
    try {
      const state = birthState(node);
      if (state === "born") log(`join: cell ${name} is ${born}${agentId ? ` (agent ${agentId})` : ""}, born before`);
      else {
        if (state === "interrupted") log(`join: cell ${name} has its account ${born}, but the birth did not reach its end; resuming it from the journal (nothing is sent twice)`);
        const r = await cellInit(node, { capitalWei: o.capitalWei, log: (line) => log(`join: ${line}`) });
        born = r.account;
        agentId = r.agentId;
        log(`join: cell ${name} born as ${born} (ERC-8004 agent ${agentId}) in ${r.operations.length} operations${state === "interrupted" ? ", the birth resumed" : ""}`);
      }
    } finally {
      node.close();
    }
  }

  // --- the skills: minted by the operator and offered; the documents committed on chain
  const catalog = defaultCatalog();
  {
    const want = o.skills ?? DEFAULT_SKILLS;
    const held = loadCellConfig(configPath).config.skills.held;
    const missing = want.filter((s) => !held[s]);
    if (missing.length) {
      const node = await Node.open({ configPath, rpc, keys: { operator: ensuredKey(wallet, "operator") }, log: () => {} });
      try {
        for (const skill of missing) {
          const r = await catalog.invoke(node, "skill_mint", { skill }, OPERATOR_CALLER, { mode: "act" });
          if (!r.ok) throw new Error(`skill_mint ${skill}: ${r.gate}: ${r.reason}`);
          log(`join: skill ${skill} minted`);
        }
      } finally {
        node.close();
      }
    }
    const loaded = loadCellConfig(configPath);
    const offered = Object.keys(loaded.config.skills.held).filter((s) => want.includes(s));
    if (offered.some((s) => !loaded.config.skills.offered.includes(s))) {
      loaded.config.skills.offered = [...new Set([...loaded.config.skills.offered, ...offered])];
      saveCellConfig(configPath, loaded.config);
    }
    log(`join: skills ${offered.join(", ")} held and offered`);
  }

  // --- an act-level API key for the HTTP entrance, kept in the cell's directory
  const agentKeyPath = join(keysDir, "agent.api-key");
  let apiKey: string;
  {
    const loaded = loadCellConfig(configPath);
    const have = loaded.config.access.keys.find((k) => k.id === "agent");
    if (have && existsSync(agentKeyPath)) apiKey = readFileSync(agentKeyPath, "utf8").trim();
    else {
      const api = newApiKey("agent");
      loaded.config.access.keys = loaded.config.access.keys.filter((k) => k.id !== "agent");
      loaded.config.access.keys.push({ id: "agent", sha256: api.sha256, level: "act", visibility: "caller", note: "the join's act-level key for the HTTP entrance" });
      saveCellConfig(configPath, loaded.config);
      writeFileSync(agentKeyPath, api.key + "\n", { mode: 0o600 });
      apiKey = api.key;
    }
  }

  {
    const node = await Node.open({ configPath, rpc, keys: { operator: ensuredKey(wallet, "operator") }, log: () => {} });
    try {
      const r = await catalog.invoke(node, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
      if (!r.ok) throw new Error(`docs_publish: ${r.gate}: ${r.reason}`);
      const d = r.output as { version: number; committed: string[]; dir: string; flows?: { anchored: string | null; disclosed: boolean; note: string } };
      // the same documents make the same job: a resume is answered from the store, and the chain is not asked again
      const replayed = node.store.decisions({ limit: 1 })[0]?.gate === "idempotent";
      log(`join: documents v${d.version} in ${d.dir}; ${replayed ? "the chain holds them (nothing sent)" : d.committed.length ? `committed on chain (${d.committed.join(", ")})` : "the chain already holds them"}${d.flows && (d.flows.anchored || d.flows.disclosed) ? `; flows: ${d.flows.note}` : ""}`);
      // ERC-8489 (0.9.0): the market, when the world names one and the configuration says to join — SUBMIT and RESPOND by the
      // identity predicate; a refusal (the registry's outcome by name) is said and the join goes on, the watcher tries again
      if (node.kernel.flows.available && node.config.flows.market.join && marketOf(node)) {
        const a = await catalog.invoke(node, "flow_admit", {}, OPERATOR_CALLER, { mode: "act" });
        if (a.ok) {
          const o = a.output as { channelId: string; admitted: { role: string }[]; alreadyHeld: string[] };
          log(`join: market ${o.channelId.slice(0, 10)}…: ${o.admitted.length ? `admitted as ${o.admitted.map((x) => x.role).join(", ")}` : ""}${o.alreadyHeld.length ? `${o.admitted.length ? "; " : ""}${o.alreadyHeld.join(", ")} held already` : ""}`);
        } else if (!/holds .* already/.test(a.reason)) log(`join: market admission ${a.gate}: ${a.reason}`);
      }
    } finally {
      node.close();
    }
  }

  // --- the node: served (every entrance, the watchers, no model) or run (with a model: it takes its tenders)
  let listen = o.listen === undefined ? "127.0.0.1:8787" : o.listen;
  if (listen) {
    const lp = Number(listen.slice(listen.lastIndexOf(":") + 1));
    if (await portInUse(lp)) {
      if (o.listen !== undefined) throw new Error(`port ${lp} is in use; pass --listen <host:port> (or --no-serve)`);
      const next = await nextFreePort(lp + 1);
      if (next === null) throw new Error(`ports ${lp}-${lp + 20} are all in use; pass --listen <host:port>`);
      log(`join: port ${lp} is in use; the node listens on ${next} instead`);
      listen = `127.0.0.1:${next}`;
    }
  }
  const operatorKeyPath = wallet.wallet.files.operator ?? wallet.wallet.files.signer;
  const cli = ownCli();
  let child: ChildProcess | null = null;
  let nodeUrl: string | null = null;
  let endedWith: (why: string) => void = () => {};
  const ended = new Promise<string>((r) => (endedWith = r));
  let stopping = false;
  const stop = async () => {
    stopping = true;
    if (child) {
      const { stopChild } = await import("../demo/anvil.js");
      await stopChild(child);
      child = null;
    }
    endedWith("stopped");
  };
  // a stop signal while the node is coming up takes the node with it (the cell stays)
  const onSignal = () => {
    log("join: stopping the node; the cell stays");
    void stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  if (listen) {
    const i = listen.lastIndexOf(":");
    const host = listen.slice(0, i) || "127.0.0.1";
    nodeUrl = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${listen.slice(i + 1)}`;
    const args = o.run ? ["node", "run", "--config", configPath, "--rpc", rpc, "--model", o.run, "--listen", listen] : ["node", "serve", "--config", configPath, "--rpc", rpc, "--listen", listen];
    child = spawn(cli.command, [...cli.args, ...args], { env: cleanEnv({ FOGA_OPERATOR_KEY_FILE: operatorKeyPath }), stdio: ["ignore", "ignore", "pipe"] });
    const idleTick = /: anchor ACTIVE, heartbeat not sent \([^)]*\); 0 new tender\(s\); 0 settled, 0 withdrawn; safety Satisfied$/;
    child.stderr!.on("data", (d) => {
      for (const line of String(d).split("\n")) if (line.trim() && !idleTick.test(line.trim())) log(`  node| ${line}`);
    });
    child.on("exit", (code, signal) => {
      if (!stopping) endedWith(`the node stopped (${code !== null ? `exit code ${code}` : `signal ${signal}`})`);
    });
    await waitForHttp(`${nodeUrl}/healthz`, 120);
    const health = (await (await fetch(`${nodeUrl}/healthz`)).json()) as { ok: boolean; version?: string };
    if (!health.ok) throw new Error("the node's /healthz is not ok");
  } else endedWith("no node");

  // --- the card and the configurations: what the cell is, and how anyone connects
  const reader = await Node.open({ configPath, rpc, keys: {}, allowUnborn: true, log: () => {} });
  let card: CellCard;
  let next = "";
  try {
    card = cellCard(reader, { version });
    next = formatAdvice(adviseCell(reader), { brief: true, config: configPath });
  } finally {
    reader.close();
  }
  const launcher = clientLauncher();
  const configs = clientConfigs({ launcher, configPath, operatorKeyPath, nodeUrl, apiKey });
  const mcpDir = join(dir, "mcp");
  mkdirSync(mcpDir, { recursive: true });
  for (const [file, text] of Object.entries(configs)) writeFileSync(join(mcpDir, file), text);

  const lines: string[] = [];
  lines.push(`foga join: cell ${name} lives on ${network}${resumed ? " (resumed)" : ""}`);
  lines.push("");
  lines.push(formatCard(card));
  lines.push("");
  lines.push(`  files     ${dir} — cell.config.json, cell.ops.sqlite (the store), world.json, skills/, documents/, keys/ (0600), mcp/*.json, connect.md`);
  lines.push(`  wallet    ${wallet.wallet.dir} — the identity; back it up, it is the cell`);
  if (nodeUrl) lines.push(`  node      ${nodeUrl} (${o.run ? `running with model ${o.run}: it takes the tenders it is eligible for` : "served: every entrance and the watchers, no model"}) — /mcp, /api/<capability>, /a2a, /.well-known/foga-cell.json, /.well-known/agent-card.json, /healthz`);
  lines.push("");
  lines.push("Connect an MCP client over stdio (the client starts the server on this machine; with the operator key it acts for the cell):");
  lines.push(configs["claude_desktop_config.json"].trimEnd().split("\n").map((l) => `  ${l}`).join("\n"));
  if (nodeUrl) {
    lines.push("");
    lines.push(`Or over HTTP: MCP ${nodeUrl}/mcp and ${nodeUrl}/api/<capability> with   Authorization: Bearer ${apiKey}   (${join(mcpDir, "http-mcp.json")}); A2A at ${nodeUrl}/a2a.`);
    lines.push(`Reachable from other machines only if ${listen!.split(":")[0]} is not the loopback (--listen 0.0.0.0:<port>) and the port is open; then --public-url https://<host> puts the address in the documents and the card.`);
  }
  lines.push("");
  lines.push("Work comes over the chain: a demander mints an ERC-8414 tender for an offered skill; the watchers find it; an agent at the entrance (or the model, with --run) pre-checks, runs the skill and submits; the hashlock verifier accepts a right answer; the watchers settle and withdraw.");
  if (next) lines.push("", next);
  lines.push("");
  lines.push(o.exit ? "Started with --exit: stopping the node." : `Ctrl-C stops the node; the cell stays. Start it again with the same command, or:  ${launcher.command} ${launcher.args.join(" ")} node serve --config ${configPath} --wallet ${wallet.wallet.dir}`);
  const summary = lines.join("\n");
  writeFileSync(join(dir, "connect.md"), `# foga join\n\n\`\`\`\n${summary}\n\`\`\`\n`);
  // `world` is the book the cell reads — its own copy, by id, chain and content — and `worldSource` where this join's
  // book came from; the two can differ in content when a newer revision was offered to a resumed cell and said no to
  writeFileSync(join(dir, JOIN_MARKER), JSON.stringify({ schema: "foga.join/1", joinedAt: new Date().toISOString(), package: PACKAGE_NAME, version, network, chainId: worldFile.chainId, worldId: worldFile.worldId, world: { worldId: worldFile.worldId, chainId: worldFile.chainId, sha256: cellWorldSha, file: worldPath }, rpc: rpcResolved.source === "public" ? null : rpc, worldSource: o.worldUrl ?? null, cell: name, account: born, agentId, wallet: wallet.wallet.dir, listen, publicUrl: o.publicUrl ?? null, run: o.run ?? null }, null, 2) + "\n");
  out(summary);

  return { dir, configPath, worldPath, rpc, chainId: worldFile.chainId, network, account: born!, agentId, resumed, nodeUrl, card, stop, ended };
}

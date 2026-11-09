import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { formatEther, parseEther } from "ethers";
import { anvilKeys } from "../genesis/roles.js";
import { Kernel } from "../kernel/kernel.js";
import { newApiKey } from "../http/server.js";
import { loadCellConfig, saveCellConfig } from "../node/config.js";
import { Node } from "../node/node.js";
import { defaultCatalog, OPERATOR_CALLER } from "../tools/index.js";
import { ensureWallet, ensuredKey, walletDir, type EnsuredWallet } from "../node/wallet.js";
import { repoRoot } from "../util/fs.js";
import { deployWorld } from "../world/deploy.js";
import { ANVIL_INSTALL_HINT, anvilBinary, anvilVersion, launchAnvil, nextFreePort, portInUse, portProblem, stopChild } from "./anvil.js";
import { birthCell, type BornCell } from "./birth.js";
import { mintCases, type DemandCase } from "./demander.js";
import { cleanEnv, ownCli, waitForHttp } from "./loop-d.js";

/**
 * `foga quickstart`: one command from nothing to a cell an MCP client can connect to (design memo, Phase 3, section 4,
 * "a standard MCP download link"; 3d). It starts anvil, deploys the local world, births a cell with keys nobody held
 * before — the default wallet's, made on the first run and kept (the wallet is the first step) — gives it standing and
 * its two skills, mints two tenders for it to find, serves the node (watchers, HTTP,
 * MCP over Streamable HTTP), checks the entrance answers, and prints — and writes — the client configurations with
 * every path filled in: the stdio form (`npx -y @finchip.ai/foga mcp --config …`) for Claude Desktop, Claude Code and
 * Cursor, and the HTTP form (URL and Bearer key) for a client or agent runtime anywhere. The chain lives as long as
 * this process: Ctrl-C ends it, and the next quickstart starts over in the same directory.
 */
export interface QuickstartOptions {
  /** Where the world, the cell and the client configurations are written (default ~/.foga/quickstart). */
  dir?: string;
  /** The wallet whose keys the cell is born with (default ~/.foga/wallet; made when there is none, reused when there is). */
  wallet?: string;
  /** anvil's port (default 8545). */
  port?: number;
  /** host:port the node listens on (default 127.0.0.1:8787); null runs no node — the stdio server alone serves the clients. */
  listen?: string | null;
  /** The cell's name (default "quick"). */
  name?: string;
  /** Mint two tenders for the cell to find (default true). */
  tenders?: boolean;
  /** Stop everything once the summary is printed (a check, not a session). */
  exit?: boolean;
  /** Progress lines (default: stderr). */
  log?: (line: string) => void;
  /** The summary (default: stdout). */
  out?: (text: string) => void;
}

export interface QuickstartResult {
  dir: string;
  rpc: string;
  chainId: number;
  worldId: string;
  worldPath: string;
  configPath: string;
  account: string;
  agentId: string | null;
  /** The wallet the cell's roles came from. */
  wallet: { dir: string; created: boolean; ephemeral: boolean; addresses: Record<string, string> };
  keys: { owner: string; operator: string; guardian: string; agentApiKey: string };
  apiKey: string;
  nodeUrl: string | null;
  tenders: { id: string; tokenId: string; skill: string; rewardWei: string }[];
  clientConfigs: Record<string, string>;
  summary: string;
  /** Ends the session: stops the node and anvil. */
  stop: () => Promise<void>;
  /** Resolves when the chain or the node stops on its own. */
  ended: Promise<string>;
}

export const MARKER = "quickstart.json";
export { PACKAGE_NAME } from "../util/version.js";
import { PACKAGE_NAME } from "../util/version.js";

/** How a client should start this very CLI: the published package through npx, or this checkout's compiled launcher. */
export function clientLauncher(): { command: string; args: string[]; fromCheckout: boolean } {
  const root = repoRoot();
  if (/[\\/]node_modules[\\/]/.test(root)) return { command: "npx", args: ["-y", PACKAGE_NAME], fromCheckout: false };
  if (existsSync(join(root, "dist", "cli.js"))) return { command: "node", args: [join(root, "bin", "foga.js")], fromCheckout: true };
  return { command: "npx", args: ["tsx", join(root, "src", "cli.ts")], fromCheckout: true };
}

export function defaultQuickstartDir(): string {
  return join(homedir(), ".foga", "quickstart");
}

/** The MCP client configurations for one cell: the same server definition in each client's file. */
export function clientConfigs(p: { launcher: { command: string; args: string[] }; configPath: string; operatorKeyPath: string; nodeUrl: string | null; apiKey: string }): Record<string, string> {
  const stdio = { command: p.launcher.command, args: [...p.launcher.args, "mcp", "--config", p.configPath], env: { FOGA_OPERATOR_KEY_FILE: p.operatorKeyPath } };
  const out: Record<string, string> = {
    "claude_desktop_config.json": JSON.stringify({ mcpServers: { foga: stdio } }, null, 2) + "\n",
    "claude-code.mcp.json": JSON.stringify({ mcpServers: { foga: { type: "stdio", ...stdio } } }, null, 2) + "\n",
    "cursor-mcp.json": JSON.stringify({ mcpServers: { foga: stdio } }, null, 2) + "\n",
  };
  if (p.nodeUrl) out["http-mcp.json"] = JSON.stringify({ mcpServers: { "foga-http": { type: "http", url: `${p.nodeUrl}/mcp`, headers: { Authorization: `Bearer ${p.apiKey}` } } } }, null, 2) + "\n";
  return out;
}

const q = (s: string) => (/[\s"]/.test(s) ? JSON.stringify(s) : s);

export async function runQuickstart(o: QuickstartOptions = {}): Promise<QuickstartResult> {
  const log = o.log ?? ((line: string) => console.error(line));
  const out = o.out ?? ((text: string) => console.log(text));
  const root = repoRoot();
  const dir = resolve(o.dir ?? defaultQuickstartDir());
  const name = o.name ?? "quick";
  const walletPath = resolve(o.wallet ?? walletDir());

  // --- say what is wrong before touching anything
  const anvilBin = anvilBinary();
  const version = anvilVersion(anvilBin.path);
  if (!version) throw new Error(ANVIL_INSTALL_HINT);
  // The default ports give way when something else holds them — a served cell on 8787 (the reference cell's own box,
  // or a node of yours), another chain on 8545 — so the bare command works on any machine; the next free port up is
  // taken and said so. A port asked for by name (--port, --listen) is not moved: that one is refused as before.
  let port = o.port ?? 8545;
  if (o.port === undefined && (await portInUse(port))) {
    const next = await nextFreePort(port + 1);
    if (next === null) throw new Error(`ports ${port}-${port + 20} are all in use; pass --port <n> for the chain`);
    log(`quickstart: port ${port} is in use (another chain or node); anvil takes ${next} instead`);
    port = next;
  } else {
    const problem = await portProblem(port);
    if (problem) throw new Error(problem);
  }
  let listen = o.listen === undefined ? "127.0.0.1:8787" : o.listen;
  if (listen) {
    const lp = Number(listen.slice(listen.lastIndexOf(":") + 1));
    if (await portInUse(lp)) {
      if (o.listen !== undefined) throw new Error(`port ${lp} is in use; pass --listen <host:port> for the node (or --no-serve to run no node)`);
      const next = await nextFreePort(lp + 1);
      if (next === null) throw new Error(`ports ${lp}-${lp + 20} are all in use; pass --listen <host:port> for the node (or --no-serve)`);
      log(`quickstart: port ${lp} is in use (a served cell, perhaps); the node listens on ${next} instead`);
      listen = `127.0.0.1:${next}`;
    }
  }
  const rpc = `http://127.0.0.1:${port}`;
  const nodeUrlPlanned = listen ? (() => {
    const i = listen.lastIndexOf(":");
    const host = listen.slice(0, i) || "127.0.0.1";
    return `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${listen.slice(i + 1)}`;
  })() : null;
  if (walletPath === dir || walletPath.startsWith(dir + sep)) throw new Error(`the wallet (${walletPath}) must live outside the quickstart directory (${dir}), which is cleared on every run`);
  if (existsSync(dir)) {
    const entries = readdirSync(dir);
    if (entries.length && !entries.includes(MARKER)) throw new Error(`${dir} exists and is not a quickstart directory (no ${MARKER}); choose another --dir`);
    if (entries.length) {
      log(`quickstart: replacing the previous quickstart in ${dir} (its chain ended with its process)`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  mkdirSync(dir, { recursive: true });
  const keysDir = join(dir, "keys");
  mkdirSync(keysDir, { recursive: true, mode: 0o700 });

  // --- the wallet: the first step; made now when there is none, reused when there is; never a reason to stop
  const wallet: EnsuredWallet = ensureWallet(walletPath, { name: "default" });
  const singleKey = wallet.wallet.roles.length === 1 && wallet.wallet.roles[0] === "signer";
  const walletAddrs = singleKey ? `identity ${wallet.wallet.addresses.signer}` : `owner ${wallet.wallet.addresses.owner}, operator ${wallet.wallet.addresses.operator}, guardian ${wallet.wallet.addresses.guardian}`;
  if (wallet.ephemeral) log(`quickstart: wallet: could not write ${walletPath} (${wallet.reason}); using keys made in memory for this run — they are not kept`);
  else log(`quickstart: wallet: ${wallet.created ? "made" : "using"} ${wallet.wallet.dir} — ${walletAddrs}`);

  // --- the chain and the world
  log(`quickstart: starting ${version} on ${rpc} (log ${join(dir, "anvil.log")})`);
  const anvil = await launchAnvil({ port, logPath: join(dir, "anvil.log") });
  let node: ChildProcess | null = null;
  let endedWith: ((why: string) => void) | null = null;
  const ended = new Promise<string>((r) => (endedWith = r));
  // a stop asked for (Ctrl-C, --exit, SIGTERM) ends the children in order; their exits are then expected and do not end the run
  // early — otherwise the node's exit would resolve `ended` while anvil is still being stopped and leave the chain running
  let stopping = false;
  anvil.on("exit", (code, signal) => {
    if (!stopping) endedWith?.(`anvil stopped (${code !== null ? `exit code ${code}` : `signal ${signal}`})`);
  });
  const stop = async () => {
    stopping = true;
    if (node) await stopChild(node);
    node = null;
    await stopChild(anvil);
    endedWith?.("stopped");
  };
  // A stop signal during the bring-up — before the caller has installed its own handlers — must still take the
  // children with it: anvil runs in its own process group and would otherwise outlive a quickstart killed mid-way,
  // holding its port against the next one.
  const onSignal = () => {
    log("quickstart: stopping the node and the chain");
    void stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const offSignals = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  try {
    const worldPath = join(dir, "world.json");
    log("quickstart: deploying the local world (the ten reference implementations and the FOGA contracts)");
    const { world } = await deployWorld({ worldConfigPath: join(root, "worlds", "local.json"), rpc, outPath: worldPath, quiet: true });
    log(`quickstart: world ${world.worldId} deployed (${Object.keys(world.contracts).length} contracts)`);

    // --- the cell: born with fresh keys, funded and attested by W (anvil's first account), its two skills minted
    const funder = anvilKeys().W;
    const k = await Kernel.open({ worldPath, rpc, storePath: join(dir, "quickstart.sqlite"), keys: { W: funder } });
    const W = k.address("W");
    let cell: BornCell;
    try {
      cell = await birthCell({
        kernel: k,
        worldPath,
        rpc,
        name,
        configPath: join(dir, "cell.config.json"),
        storePath: join(dir, "cell.ops.sqlite"),
        description: `Cell ${name}: born by foga quickstart on a local anvil chain`,
        keys: { owner: ensuredKey(wallet, "owner"), operator: ensuredKey(wallet, "operator"), guardian: ensuredKey(wallet, "guardian") },
        log: (line) => log(`quickstart: ${line}`),
        configure: (cfg) => {
          cfg.policy.budget = { dailyValueWei: parseEther("0.002").toString(), perOperationValueWei: parseEther("0.001").toString(), dailyGasWei: parseEther("0.05").toString(), maxConcurrentCommitments: 2 };
          cfg.policy.tenders = { minRewardWei: parseEther("0.0005").toString(), minSubmitWindowSeconds: 600, minSettleWindowSeconds: 600, acceptance: ["hashlock"], counterpartyMinLevel: 0, lookbackBlocks: 9000, requireCounterpartyFlowRole: false };
          cfg.runtime.pollSeconds = 2;
          cfg.runtime.http.listen = listen ?? "127.0.0.1:8787";
          cfg.runtime.http.rateLimitPerMinute = 600;
          if (nodeUrlPlanned) cfg.runtime.http.publicUrl = nodeUrlPlanned;
        },
      });
    } finally {
      k.close();
      k.world.provider.destroy();
    }
    const configPath = cell.configPath;

    // --- the key files the configurations name: the wallet's own; an in-memory wallet is written beside the cell so the run still works
    const keyFile = (file: string, value: string) => {
      const path = join(keysDir, file);
      writeFileSync(path, value + "\n", { mode: 0o600 });
      return path;
    };
    const keyPaths = wallet.ephemeral
      ? { owner: keyFile("owner.key", cell.owner.privateKey), operator: keyFile("operator.key", cell.operator.privateKey), guardian: keyFile("guardian.key", cell.guardian.privateKey) }
      : { owner: wallet.wallet.files.owner, operator: wallet.wallet.files.operator, guardian: wallet.wallet.files.guardian };
    // an act-level API key for the HTTP entrance
    const api = newApiKey("agent");
    {
      const loaded = loadCellConfig(configPath);
      loaded.config.access.keys.push({ id: "agent", sha256: api.sha256, level: "act", visibility: "caller", note: "the quickstart's act-level key for the HTTP entrance" });
      saveCellConfig(configPath, loaded.config);
    }
    const agentKeyPath = keyFile("agent.api-key", api.key);

    // --- the cell says what it is: both skills offered, the documents built and committed on chain (the operator's act, in this process)
    {
      const loaded = loadCellConfig(configPath);
      loaded.config.skills.offered = Object.keys(loaded.config.skills.held);
      saveCellConfig(configPath, loaded.config);
      const publisher = await Node.open({ configPath, rpc, keys: { operator: ensuredKey(wallet, "operator") }, log: () => {} });
      try {
        const r = await defaultCatalog().invoke(publisher, "docs_publish", {}, OPERATOR_CALLER, { mode: "act" });
        if (!r.ok) throw new Error(`docs_publish: ${r.gate}: ${r.reason}`);
        const out = r.output as { version: number; committed: string[]; dir: string };
        log(`quickstart: documents v${out.version} built in ${out.dir} and committed on chain (${out.committed.join(", ")})`);
      } finally {
        publisher.close();
      }
    }

    // --- two tenders for the cell to find: a probe of the cell itself and an extraction over the fixture
    let minted: DemandCase[] = [];
    if (o.tenders ?? true) {
      const r = await mintCases({ worldPath, rpc, storePath: join(dir, "demander.sqlite"), key: funder, cell: cell.account, schemeId: cell.schemeId, issuers: [W], packages: cell.packages, cases: ["a", "b"], seed: 1, log: (line) => log(`quickstart: ${line}`) });
      minted = r.cases;
    }

    // --- the node: watchers, HTTP API, MCP over Streamable HTTP; the operator key alone, from its file
    const cli = ownCli();
    let nodeUrl: string | null = null;
    if (listen) {
      const i = listen.lastIndexOf(":");
      const host = listen.slice(0, i) || "127.0.0.1";
      nodeUrl = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${listen.slice(i + 1)}`;
      node = spawn(cli.command, [...cli.args, "node", "serve", "--config", configPath, "--rpc", rpc, "--listen", listen], { env: cleanEnv({ FOGA_OPERATOR_KEY_FILE: keyPaths.operator }), stdio: ["ignore", "ignore", "pipe"] });
      // the node's lines are relayed, except a watcher tick in which nothing happened (every two seconds, forever)
      const idleTick = /: anchor ACTIVE, heartbeat not sent \([^)]*\); 0 new tender\(s\); 0 settled, 0 withdrawn; safety Satisfied$/;
      node.stderr!.on("data", (d) => {
        for (const line of String(d).split("\n")) if (line.trim() && !idleTick.test(line.trim())) log(`  node| ${line}`);
      });
      node.on("exit", (code, signal) => {
        if (!stopping) endedWith?.(`the node stopped (${code !== null ? `exit code ${code}` : `signal ${signal}`})`);
      });
      await waitForHttp(`${nodeUrl}/healthz`);

      // --- the entrance answers: health, a public read, the agent key's pre-check of the first tender, the MCP handshake and tool list
      const health = (await (await fetch(`${nodeUrl}/healthz`)).json()) as { ok: boolean };
      if (!health.ok) throw new Error("the node's /healthz is not ok");
      const status = (await (await fetch(`${nodeUrl}/api/cell_status`)).json()) as { ok: boolean; output?: { account?: string } };
      if (!status.ok || status.output?.account?.toLowerCase() !== cell.account.toLowerCase()) throw new Error(`cell_status through HTTP did not name the cell: ${JSON.stringify(status).slice(0, 200)}`);
      if (minted.length) {
        const pre = (await (await fetch(`${nodeUrl}/api/tender_precheck`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${api.key}` }, body: JSON.stringify({ tokenId: minted[0].tokenId }) })).json()) as { ok: boolean; gate?: string; reason?: string };
        if (!pre.ok) throw new Error(`the pre-check of tender ${minted[0].tokenId} was refused at ${pre.gate}: ${pre.reason}`);
      }
      const mcpHeaders = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${api.key}` };
      const init = await fetch(`${nodeUrl}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "foga-quickstart", version: "0" } } }) });
      if (init.status !== 200) throw new Error(`the MCP entrance answered ${init.status} to initialize`);
      const tools = await fetch(`${nodeUrl}/mcp`, { method: "POST", headers: mcpHeaders, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) });
      const toolsText = await tools.text();
      const toolCount = (toolsText.match(/"name":"/g) ?? []).length;
      if (toolCount < 20) throw new Error(`the MCP entrance listed ${toolCount} tool(s) for the agent key; expected the act-level set`);
      const cardRes = await fetch(`${nodeUrl}/.well-known/agent-card.json`);
      const cardDoc = (await cardRes.json()) as { supportedInterfaces?: { url: string }[]; skills?: unknown[] };
      if (!cardRes.ok || cardDoc.supportedInterfaces?.[0]?.url !== `${nodeUrl}/a2a`) throw new Error(`the agent card at /.well-known/agent-card.json does not name ${nodeUrl}/a2a`);
      const quoteRes = await fetch(`${nodeUrl}/a2a`, { method: "POST", headers: { "content-type": "application/json", "a2a-version": "1.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "SendMessage", params: { message: { messageId: "quickstart-quote", role: "ROLE_USER", parts: [{ text: "What can you do?" }] } } }) });
      const quoteBody = (await quoteRes.json()) as { result?: { task?: { status?: { state?: string } } } };
      if (quoteBody.result?.task?.status?.state !== "TASK_STATE_COMPLETED") throw new Error(`the A2A entrance did not answer a quote: ${JSON.stringify(quoteBody).slice(0, 200)}`);
      log(`quickstart: the entrance answers — /healthz ok, cell_status names ${cell.account}, tender ${minted[0]?.tokenId ?? "-"} eligible for the agent key, MCP initialize ok, ${toolCount} tools; the agent card names ${nodeUrl}/a2a and a quote came back`);
    }

    // --- the stdio server the client configurations name, started as a client would start it: the operator's tool set over stdio
    const stdioTools = await stdioToolCount(cli, configPath, rpc, cleanEnv({ FOGA_OPERATOR_KEY_FILE: keyPaths.operator }));
    if (stdioTools < 30) throw new Error(`the stdio MCP server listed ${stdioTools} tool(s) with the operator key; expected the operator's set`);
    log(`quickstart: the stdio MCP server answers with the operator key — ${stdioTools} tools`);

    // --- the client configurations, written and printed
    const launcher = clientLauncher();
    const configs = clientConfigs({ launcher, configPath, operatorKeyPath: keyPaths.operator, nodeUrl, apiKey: api.key });
    const mcpDir = join(dir, "mcp");
    mkdirSync(mcpDir, { recursive: true });
    for (const [file, text] of Object.entries(configs)) writeFileSync(join(mcpDir, file), text);
    const demanderCmd = `${q(launcher.command)} ${launcher.args.map(q).join(" ")} demo demander --world ${q(worldPath)} --rpc ${rpc} --store ${q(join(dir, "demander.sqlite"))} --cell ${cell.account} --scheme ${cell.schemeId} --issuer ${W} --probe-hash ${cell.packages["foga-probe"]} --extract-hash ${cell.packages["finch-extract-verify"]} --cases a,b --seed <n>`;
    const claudeCodeAdd = `claude mcp add foga -e FOGA_OPERATOR_KEY_FILE=${q(keyPaths.operator)} -- ${q(launcher.command)} ${launcher.args.map(q).join(" ")} mcp --config ${q(configPath)}`;
    const lines: string[] = [];
    lines.push(`foga quickstart: a FOGA cell is live on a local chain`);
    lines.push("");
    lines.push(`  chain     anvil on ${rpc} (chain ${world.chainId}), world ${world.worldId} — the chain lives as long as this process`);
    lines.push(`  cell      ${name} = ${cell.account}${cell.agentId ? ` (ERC-8004 agent ${cell.agentId})` : ""}`);
    const walletRoles = singleKey ? `identity ${cell.owner.address} (one key, every role)` : `owner ${cell.owner.address}, operator ${cell.operator.address}, guardian ${cell.guardian.address}`;
    lines.push(`  wallet    ${wallet.ephemeral ? `keys made in memory for this run, written to ${keysDir} (${walletPath} was not writable)` : `${wallet.wallet.dir} (${wallet.created ? "made now" : "reused"}) — ${walletRoles}; the same wallet on every run`}`);
    lines.push(`  skills    ${Object.keys(cell.held).join(", ")} (held and offered)`);
    if (minted.length) lines.push(`  tenders   ${minted.map((c) => `#${c.tokenId} ${c.skill} (${formatEther(c.rewardWei)} ETH)`).join(", ")} — open, waiting for the cell to take them`);
    if (nodeUrl) lines.push(`  node      ${nodeUrl} — /mcp (Streamable HTTP), /api/<capability>, /a2a (A2A 1.0, JSON-RPC), /.well-known/agent-card.json, /documents/*, /healthz; its watchers settle and withdraw`);
    lines.push(`  documents ${join(dir, "documents")} — registration, AID document, ARD descriptor, AUF unit, agent card, server.json; committed on chain${nodeUrl ? ` as URLs under ${nodeUrl}` : ""}`);
    lines.push(`  files     ${configPath} (the cell), ${join(dir, "connect.md")} (this text), ${mcpDir}${process.platform === "win32" ? "\\" : "/"}*.json (the client configurations)`);
    lines.push("");
    lines.push("Connect an MCP client over stdio (the client starts the server on this machine; with the operator key it acts for the cell):");
    lines.push(`  Claude Desktop   claude_desktop_config.json, the mcpServers block:        ${join(mcpDir, "claude_desktop_config.json")}`);
    lines.push(`  Claude Code      .mcp.json in a project:                                 ${join(mcpDir, "claude-code.mcp.json")}`);
    lines.push(`                   or one command:  ${claudeCodeAdd}`);
    lines.push(`  Cursor           .cursor/mcp.json:                                       ${join(mcpDir, "cursor-mcp.json")}`);
    lines.push("");
    lines.push(configs["claude_desktop_config.json"].trimEnd().split("\n").map((l) => `  ${l}`).join("\n"));
    if (nodeUrl) {
      lines.push("");
      lines.push("Or over HTTP (a client on another machine, or any agent runtime that speaks HTTP):");
      lines.push(`  MCP      ${nodeUrl}/mcp   with the header   Authorization: Bearer ${api.key}   (${join(mcpDir, "http-mcp.json")})`);
      lines.push(`  API      ${nodeUrl}/api/<capability>, POST a JSON body (reads also GET); the same header for acts. GET ${nodeUrl}/api/capabilities lists them.`);
      lines.push(`  A2A      POST ${nodeUrl}/a2a with A2A-Version: 1.0 — SendMessage for a quote (anyone) or a tender ({"foga":{"mode":"tender","tokenId":"…"}}, the header above); the card is at ${nodeUrl}/.well-known/agent-card.json`);
      lines.push(`  wallet   a credential of your own instead of the key: Authorization: FOGA-EIP712 <envelope> signed by any wallet (foga wallet sign --url ${nodeUrl} prints one; docs/wallet.md)`);
      lines.push(`           curl -s ${nodeUrl}/api/cell_status`);
      if (minted.length) lines.push(`           curl -s -X POST ${nodeUrl}/api/tender_precheck -H "content-type: application/json" -H "authorization: Bearer ${api.key}" -d "{\\"tokenId\\":\\"${minted[0].tokenId}\\"}"`);
    }
    lines.push("");
    lines.push("What a connected agent does with a tender: tender_list, tender_inspect, tender_precheck (eligible: false is the cell's verdict), skill_run with the");
    lines.push("task's skill and input, tender_submit with the run's resultHash and runReceipt; the node settles and withdraws. More tenders for the cell:");
    lines.push(`  FOGA_DEMANDER_KEY=<a funded key, anvil's first account by default> ${demanderCmd}`);
    if (launcher.fromCheckout) lines.push(`(This is a checkout: the configurations start ${launcher.command} ${launcher.args.join(" ")}; a published install would start npx -y ${PACKAGE_NAME}.)`);
    // Next: what a cell should do once it runs — advice, kept out of the first run on purpose (docs/node.md, "Advice").
    try {
      const { adviseCell, formatAdvice } = await import("../node/advise.js");
      const reader = await Node.open({ configPath, rpc, keys: {}, allowUnborn: true, log: () => {} });
      try {
        const next = formatAdvice(adviseCell(reader), { brief: true, config: configPath });
        if (next) lines.push("", next);
      } finally {
        reader.close();
      }
    } catch {
      // advice is never a reason for a quickstart to fail
    }
    lines.push("");
    lines.push(o.exit ? "Started with --exit: stopping the node and the chain." : "Ctrl-C stops the node and the chain; the next quickstart starts over in the same directory.");
    const summary = lines.join("\n");
    writeFileSync(join(dir, "connect.md"), `# foga quickstart\n\n\`\`\`\n${summary}\n\`\`\`\n`);
    writeFileSync(join(dir, MARKER), JSON.stringify({ schema: "foga.quickstart/1", createdAt: new Date().toISOString(), rpc, chainId: world.chainId, worldId: world.worldId, cell: name, account: cell.account, agentId: cell.agentId, wallet: wallet.ephemeral ? null : wallet.wallet.dir, nodeUrl, tenders: minted.map((c) => c.tokenId), anvil: version }, null, 2) + "\n");
    out(summary);

    return {
      dir,
      rpc,
      chainId: world.chainId,
      worldId: world.worldId,
      worldPath,
      configPath,
      account: cell.account,
      agentId: cell.agentId,
      wallet: { dir: wallet.wallet.dir, created: wallet.created, ephemeral: wallet.ephemeral, addresses: wallet.wallet.addresses },
      keys: { ...keyPaths, agentApiKey: agentKeyPath },
      apiKey: api.key,
      nodeUrl,
      tenders: minted.map((c) => ({ id: c.id, tokenId: c.tokenId, skill: c.skill, rewardWei: c.rewardWei })),
      clientConfigs: configs,
      summary,
      stop,
      ended,
    };
  } catch (e) {
    await stop();
    throw e;
  } finally {
    offSignals();
  }
}

/** Start `foga mcp --config …` as a client would and count the tools it lists; a raw 2025-era JSON-RPC exchange over stdio. */
async function stdioToolCount(cli: { command: string; args: string[] }, configPath: string, rpc: string, env: Record<string, string>): Promise<number> {
  const child = spawn(cli.command, [...cli.args, "mcp", "--config", configPath, "--rpc", rpc], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const pending = new Map<number, (msg: { result?: unknown; error?: unknown }) => void>();
  let buffer = "";
  child.stdout!.on("data", (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* not a protocol message: the check below fails on the count */
      }
    }
  });
  let nextId = 1;
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolveReq, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => reject(new Error(`stdio MCP: ${method} timed out; the server said:\n${stderr.slice(-2000)}`)), 60_000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(`stdio MCP: ${method}: ${JSON.stringify(msg.error)}`));
        else resolveReq(msg.result);
      });
      child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    const init = await request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "foga-quickstart", version: "0" } });
    if (init?.serverInfo?.name !== "foga") throw new Error(`stdio MCP: initialize answered ${JSON.stringify(init).slice(0, 200)}`);
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await request("tools/list", {});
    return Array.isArray(tools?.tools) ? tools.tools.length : 0;
  } finally {
    child.stdin!.end();
    await stopChild(child, 3000);
  }
}

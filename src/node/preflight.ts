import { existsSync, readdirSync, statSync } from "node:fs";
import { FOGA_CELL_SPEC_VERSION } from "../core/asf.js";
import { FOGA_COVENANTS } from "./propagation.js";
import { join } from "node:path";
import { formatEther, getAddress } from "ethers";
import { accountSubject } from "../core/kya.js";
import { mergeScope, operatorScope, ownerExecuteScope } from "../genesis/operator-scope.js";
import { runExtractIsolated, runProbeIsolated } from "../genesis/skill-runner.js";
import { documentsDir, readBack, readBuilt } from "./documents.js";
import { NODE_SCOPE_GROUPS } from "./init.js";
import { KeyIsolationError, loadOperatorKey } from "./keys.js";
import type { Node } from "./node.js";

/**
 * `foga node preflight` (design memo, Phase 3, section 9, v0.2 "running-readiness reconciliation"): before a cell is
 * served to the public, the chain from what the account is and permits, through what the operator key can do,
 * which skill versions the cell holds and whether their full packages are here and run, to what the cell declares
 * about itself — every link read and compared, nothing assumed. Advisory by default: the table says what is wrong
 * and the operator decides; `--strict` makes a Fail an exit code for a deployment script.
 */
export type PreflightVerdict = "Pass" | "Warn" | "Fail" | "NotTested";

export interface PreflightRow {
  area: string;
  check: string;
  verdict: PreflightVerdict;
  detail: string;
}

export interface PreflightReport {
  schema: "foga.preflight/1";
  cell: string;
  account: string | null;
  chainId: number;
  at: string;
  rows: PreflightRow[];
  summary: Record<PreflightVerdict, number>;
}

export interface PreflightOptions {
  /** Run the executors (a probe of the cell at the current block, the extraction over the fixture); default true. */
  executors?: boolean;
  /** Fetch the public URL's health and documents from here; default true. */
  network?: boolean;
  env?: NodeJS.ProcessEnv;
}

export async function preflight(node: Node, o: PreflightOptions = {}): Promise<PreflightReport> {
  const rows: PreflightRow[] = [];
  const row = (area: string, check: string, verdict: PreflightVerdict, detail: string) => rows.push({ area, check, verdict, detail });
  const cfg = node.config;
  const k = node.kernel;
  const env = o.env ?? process.env;

  // --- the world and the chain
  try {
    const net = await k.world.provider.getNetwork();
    const same = Number(net.chainId) === node.world.file.chainId;
    row("world", "the RPC serves the world's chain", same ? "Pass" : "Fail", `RPC chain ${net.chainId}, world ${node.world.file.worldId} on chain ${node.world.file.chainId}`);
  } catch (e) {
    row("world", "the RPC serves the world's chain", "Fail", `the RPC did not answer: ${(e as Error).message}`);
  }
  const storeWorld = node.store.getMeta("worldId");
  row("world", "the store belongs to this world and this account", storeWorld && storeWorld !== node.world.file.worldId ? "Fail" : "Pass", `store ${node.storePath}: world ${storeWorld ?? "(new)"}, account ${node.store.getMeta("cellAccount") ?? "(none yet)"}`);

  // --- the account and its permissions
  if (!cfg.identity.account || !node.cell) {
    row("account", "the cell is born", "Fail", "the configuration names no account (foga cell init)");
    return finish(node, rows);
  }
  const cell = node.body;
  let version = 1;
  try {
    version = Number(await cell.contract().ACCOUNT_VERSION());
  } catch {
    version = 1;
  }
  row("account", "a revision-2 account (operator allow-list)", version >= 2 ? "Pass" : "Fail", `${cell.address} is revision ${version}${version < 2 ? ": no allow-list; foga cell migrate moves the cell to a revision-2 account" : ""}`);
  const [owner, operator] = await Promise.all([cell.owner(), cell.operator()]);
  const rolesOk = getAddress(owner) === getAddress(cfg.identity.owner) && getAddress(operator) === getAddress(cfg.identity.operator);
  row("account", "the account names the configuration's owner and operator", rolesOk ? "Pass" : "Fail", `owner ${owner}, operator ${operator}`);
  try {
    const [anchor, status] = await Promise.all([k.aid.stateName(cell.address), cell.status()]);
    row("account", "anchor ACTIVE and binding Satisfied", anchor === "ACTIVE" && status.verdictName === "Satisfied" ? "Pass" : anchor === "STALE" ? "Warn" : "Fail", `anchor ${anchor}, binding ${status.verdictName}${status.reasonNames.length ? ` [${status.reasonNames.join(", ")}]` : ""}${anchor === "STALE" ? " (the next heartbeat restores it)" : ""}`);
  } catch (e) {
    row("account", "anchor ACTIVE and binding Satisfied", "Fail", (e as Error).message);
  }
  // the specification the cell operates under (1.0.0): version 2 enforced by the account (born under 1.0.0) or adopted by the runtime
  {
    const accountVersion = cfg.identity.safety.version;
    const adopted = cfg.identity.adopted?.version ?? 0;
    const under = Math.max(accountVersion, adopted);
    const missingBase = FOGA_COVENANTS.filter((c) => !node.world.covenants().includes(c));
    row("account", `the cell operates under FOGA-Cell-v${FOGA_CELL_SPEC_VERSION}`, under >= FOGA_CELL_SPEC_VERSION ? "Pass" : "Warn", under >= FOGA_CELL_SPEC_VERSION ? (accountVersion >= FOGA_CELL_SPEC_VERSION ? `the account's binding is to version ${accountVersion}` : `the account enforces version ${accountVersion} (fixed at its deployment); version ${adopted} is adopted as a runtime-enforced binding ${cfg.identity.adopted!.bindingId.slice(0, 10)}…`) : `bound to version ${accountVersion}; this program is version ${FOGA_CELL_SPEC_VERSION} — foga cell adopt adopts it (a second, runtime-enforced binding; nothing stops)`);
    row("world", "the world carries the program's base set (twelve covenants and ERC-8004)", missingBase.length ? "Warn" : "Pass", missingBase.length ? `missing ${missingBase.join(", ")}: foga cell extend --covenants ${missingBase.map((c) => c.slice(4)).join(",")} adds what the chain has` : `${node.world.covenants().length} covenants in the world file`);
  }
  if (version >= 2) {
    try {
      // a one-key cell's owner is its operator and is scope-checked: its allow-list also carries the owner's pairs through
      // `execute` (operator-scope.ts); a separated cell's must not
      const oneKey = getAddress(cfg.identity.owner) === getAddress(cfg.identity.operator);
      const ownerPairs = ownerExecuteScope(k);
      const scope = oneKey ? mergeScope(operatorScope(k, NODE_SCOPE_GROUPS), ownerPairs) : operatorScope(k, NODE_SCOPE_GROUPS);
      const missing: string[] = [];
      for (let i = 0; i < scope.targets.length; i++) if (!(await cell.contract().operatorAllowed(scope.targets[i], scope.selectors[i]))) missing.push(scope.names[i]);
      row("account", "the operator allow-list covers the node's capabilities", missing.length ? "Fail" : "Pass", missing.length ? `${missing.length} of ${scope.names.length} missing: ${missing.join(", ")} (the owner adds them with scope_complete; a cell born before they were part of the scope)` : `${scope.names.length} (target, selector) pairs allowed`);
      if (!oneKey && ownerPairs.targets.length) {
        const open: string[] = [];
        for (let i = 0; i < ownerPairs.targets.length; i++) if (await cell.contract().operatorAllowed(ownerPairs.targets[i], ownerPairs.selectors[i])) open.push(ownerPairs.names[i]);
        if (open.length) row("account", "the owner's pairs stay closed to a separate operator", "Warn", `${open.join(", ")} allowed to the operator ${cfg.identity.operator} (opened while the cell had one key; the owner closes them with setOperatorAllowedBatch(…, false), as operator_rotate does)`);
      }
    } catch (e) {
      row("account", "the operator allow-list covers the node's capabilities", "NotTested", (e as Error).message);
    }
  }
  try {
    const [valueCap, balance] = await Promise.all([cell.contract().operatorDailyValueCap?.().catch(() => null), k.balance(cell.address)]);
    const budget = BigInt(cfg.policy.budget.dailyValueWei);
    const perOp = BigInt(cfg.policy.budget.perOperationValueWei);
    row("budget", "the policy's caps are consistent", perOp <= budget && BigInt(cfg.policy.budget.dailyGasWei) > 0n ? "Pass" : "Fail", `per operation ${formatEther(perOp)} ETH <= daily ${formatEther(budget)} ETH; gas ${formatEther(BigInt(cfg.policy.budget.dailyGasWei))} ETH a day`);
    row("budget", "the account holds working capital", balance > 0n ? "Pass" : "Warn", `${formatEther(balance)} ETH on the account${valueCap !== null && valueCap !== undefined ? `; the account's own daily value cap ${formatEther(BigInt(valueCap))} ETH` : ""}`);
  } catch (e) {
    row("budget", "the policy's caps are consistent", "NotTested", (e as Error).message);
  }

  // --- maintenance (ERC-8490), on a world that has the registry: enrolled, documents in step with the chain, nothing overdue
  if (k.meditation.available) {
    try {
      const { readState } = await import("./meditation.js");
      const { currentLock, cycleFact } = await import("./meditation-cycle.js");
      const s = await k.meditation.summary(cell.address);
      if (!s.enrolled) row("maintenance", "the cell is enrolled in the maintenance registry", "Warn", `${cell.address} is not enrolled in ${s.registry} (foga cell extend --covenants 8490)`);
      else {
        row("maintenance", "the cell is enrolled in the maintenance registry", "Pass", `state version ${s.head.stateVersion}, ${s.head.recordCount} record(s), policy v${s.head.policyVersion}, controller ${s.head.controllerRights ? s.head.controller : "none"}`);
        const state = readState(node);
        row("maintenance", "the registered documents kept here are the ones on chain", !state ? "Warn" : state.root.toLowerCase() === s.head.root.toLowerCase() ? "Pass" : "Fail", !state ? "no registered state is kept here (the enrollment was made elsewhere, or the store is new)" : `local version ${state.stateVersion} root ${state.root.slice(0, 10)}…; chain root ${s.head.root.slice(0, 10)}…`);
        const overdue = (s.layers ?? []).filter((l) => l.statusName === "OVERDUE");
        const due = (s.layers ?? []).filter((l) => l.statusName === "DUE");
        row("maintenance", "no layer is overdue", overdue.length ? "Warn" : "Pass", (s.layers ?? []).map((l) => `${l.name} ${l.statusName}${l.neverCompleted ? " (never completed)" : ""}`).join(", ") + (overdue.length || due.length ? " — foga meditate run" : ""));
        const lock = currentLock(node);
        if (lock) {
          const c = cycleFact(node, lock.cycleId);
          row("maintenance", "no cycle is left half-way", "Warn", `cycle ${lock.cycleId} is ${c?.phase ?? "unknown"} (report ${node.store.get(`job:${lock.cycleId}:report`)?.status ?? "not sent"}); the next foga meditate run reconciles it`);
        }
        const m = cfg.maintenance;
        const w = node.store.getFact<{ nextCheckAt?: number; lastAction?: string }>("watch.maintenance");
        row("maintenance", "the watcher runs the cycles that fall due", m.auto ? "Pass" : "Warn", m.auto ? `on: checks every ${m.checkEverySeconds} s, cooldown ${m.cooldownSeconds} s${w?.lastAction ? `; last: ${w.lastAction}` : "; not checked yet (it checks on the node's ticks)"}` : "off (maintenance.auto false): a layer that falls due stays due until foga meditate run");
      }
    } catch (e) {
      row("maintenance", "the cell is enrolled in the maintenance registry", "NotTested", (e as Error).message);
    }
  }

  // --- flows (ERC-8489), on a world that has the registries: the paradigm registered, the channel open and the cell's SUBMIT held,
  //     the publication anchored, the market joined (or not asked for)
  if (k.flows.available) {
    try {
      const { anchorPlan, cellChannelId, cellSourceParadigmId, currentEligibility, marketOf, roleNow } = await import("./flows.js");
      const { CELL_SOURCE } = await import("../core/paradigms.js");
      const paradigmId = cellSourceParadigmId(node);
      const registered = await k.flows.paradigmExists(paradigmId);
      row("flows", "the cell-source paradigm is registered on this chain", registered ? "Pass" : "Warn", registered ? `${CELL_SOURCE} ${paradigmId.slice(0, 10)}…` : `${CELL_SOURCE} ${paradigmId.slice(0, 10)}… is not registered: the world's maintainer runs foga flow bootstrap first`);
      const channelId = cellChannelId(node);
      if (!channelId) row("flows", "the cell has its own channel", cfg.flows.auto ? "Warn" : "Pass", cfg.flows.auto ? `no channel yet (foga cell extend --covenants 8489 opens it${registered ? "" : " once the paradigm is registered"})` : "flows.auto is off: no channel by choice");
      else {
        const rec = await k.flows.channel(channelId);
        const mine = rec.authority.toLowerCase() === cell.address.toLowerCase();
        row("flows", "the cell has its own channel", mine && rec.stateName === "Active" ? "Pass" : "Warn", `${channelId.slice(0, 10)}… authority ${rec.authority}${mine ? "" : " (NOT the cell)"}, ${rec.stateName}`);
        const role = await roleNow(node, channelId, k.flows.subjectOf(cell.address), "submit");
        row("flows", "the cell holds SUBMIT in its channel", role.outcome === "SATISFIED" ? "Pass" : "Warn", role.outcome ?? `call failed: ${role.error}`);
        const plan = anchorPlan(node);
        row("flows", "the current publication is anchored", plan === null ? "Pass" : plan === "unpublished" ? "Warn" : "Warn", plan === null ? "anchored" : plan === "unpublished" ? "the documents are not built (foga cell docs publish)" : `${plan.objectRef.slice(0, 10)}… not anchored yet (the watcher anchors it on its pace; foga flow anchor now)`);
      }
      const market = marketOf(node);
      if (!market) row("flows", "the cell is admitted to the market", "Warn", "this world names no market channel and the configuration none either; a counterparty that requires the SUBMIT role finds none");
      else if (!cfg.flows.market.join) row("flows", "the cell is admitted to the market", "Pass", `flows.market.join is off: ${market.channelId.slice(0, 10)}… not joined by choice`);
      else {
        const subject = k.flows.subjectOf(cell.address);
        const missing: string[] = [];
        for (const r of cfg.flows.market.roles) {
          const o = await roleNow(node, market.channelId, subject, r);
          if (o.outcome !== "SATISFIED") missing.push(`${r} ${o.outcome ?? "unreadable"}`);
        }
        const e = await currentEligibility(node);
        row("flows", "the cell is admitted to the market", missing.length ? "Warn" : "Pass", missing.length ? `${market.channelId.slice(0, 10)}…: ${missing.join(", ")}; eligibility now: ${e.detail}${e.ok ? " (the watcher admits the cell on its pace; foga flow admit now)" : ""}` : `${market.channelId.slice(0, 10)}…: ${cfg.flows.market.roles.join(", ")} held; eligibility now: ${e.detail}`);
      }
      const w = node.store.getFact<{ lastAction?: string }>("watch.flows");
      row("flows", "the watcher anchors publications and joins the market", cfg.flows.auto ? "Pass" : "Warn", cfg.flows.auto ? `on: checks every ${cfg.flows.checkEverySeconds} s${w?.lastAction ? `; last: ${w.lastAction}` : "; not checked yet (it checks on the node's ticks)"}` : "off (flows.auto false)");
    } catch (e) {
      row("flows", "the cell has its own channel", "NotTested", (e as Error).message);
    }
  }

  // --- the operator key: this environment's, alone; the address the account names; gas for its acts
  try {
    const key = loadOperatorKey(env);
    const match = getAddress(key.address) === getAddress(cfg.identity.operator);
    row("keys", "the operator key is here, alone, and is the account's operator", match ? "Pass" : "Fail", `${key.address} from ${key.source.kind === "file" ? key.source.path : key.source.name}${match ? "" : `; the account names ${cfg.identity.operator}`}`);
    const gas = await k.balance(key.address);
    const floor = BigInt(cfg.policy.budget.dailyGasWei) / 4n;
    row("keys", "the operator holds gas (a quarter of the daily gas budget at least)", gas >= floor ? "Pass" : "Fail", `${formatEther(gas)} ETH (floor ${formatEther(floor)} ETH); the catalog refuses commitments below the floor`);
  } catch (e) {
    row("keys", "the operator key is here, alone, and is the account's operator", e instanceof KeyIsolationError ? "Fail" : "NotTested", (e as Error).message);
  }
  for (const role of ["owner", "guardian"] as const) {
    const names = { inline: `FOGA_${role.toUpperCase()}_KEY`, file: `FOGA_${role.toUpperCase()}_KEY_FILE` };
    if (env[names.inline] || env[names.file]) row("keys", `the ${role} key stays out of the node's environment`, "Fail", `${env[names.inline] ? names.inline : names.file} is set here; a node holds the operator key alone`);
  }
  if (env.FOGA_MNEMONIC || env.FOGA_MNEMONIC_FILE) row("keys", "the phrase stays out of the node's environment", "Fail", "FOGA_MNEMONIC[_FILE] is set here");

  // --- standing
  if (cfg.identity.standing) {
    try {
      const r = await k.kya.resolve(accountSubject(node.chainId, cell.address), cfg.identity.standing.schemeId, cfg.identity.standing.issuers);
      const now = await node.now();
      const live = r.level > 0 && (Number(r.expiresAt) === 0 || Number(r.expiresAt) > now);
      row("standing", "the cell's KYA standing is attested and current", live ? "Pass" : "Warn", live ? `level ${r.level}${Number(r.expiresAt) ? `, until ${new Date(Number(r.expiresAt) * 1000).toISOString()}` : ""}` : `level ${r.level}${Number(r.expiresAt) && Number(r.expiresAt) <= now ? ", expired" : ""}; an issuer attests (foga cell attest is theirs, not the cell's)`);
    } catch (e) {
      row("standing", "the cell's KYA standing is attested and current", "NotTested", (e as Error).message);
    }
  } else row("standing", "the cell's KYA standing is attested and current", "Warn", "no identity.standing in the configuration: counterparties cannot be required to a level, and the cell has none to show");

  // --- skills: held on chain, committed to the package that is here, complete, offered, and running
  let held: Awaited<ReturnType<Node["heldSkills"]>> = [];
  try {
    held = await node.heldSkills();
    row("skills", "every held skill's package is here and matches its on-chain commitment", "Pass", held.length ? held.map((h) => `${h.name} (token ${h.tokenId}, ${Object.keys(h.pkg.objects).length} objects, ${h.packageHash.slice(0, 10)}…)`).join("; ") : "no skills held");
  } catch (e) {
    row("skills", "every held skill's package is here and matches its on-chain commitment", "Fail", (e as Error).message);
  }
  const notHeld = cfg.skills.offered.filter((s) => !(s in cfg.skills.held));
  row("skills", "every offered skill is held", notHeld.length ? "Fail" : "Pass", notHeld.length ? `offered but not held: ${notHeld.join(", ")}` : `${cfg.skills.offered.length} offered of ${Object.keys(cfg.skills.held).length} held`);
  const executors = ["foga-probe", "finch-extract-verify"];
  const noExecutor = cfg.skills.offered.filter((s) => !executors.includes(s));
  if (noExecutor.length) row("skills", "every offered skill has an executor in this node", "Fail", `no executor for ${noExecutor.join(", ")} (this node runs ${executors.join(" and ")})`);
  if (o.executors !== false) {
    if (cfg.skills.offered.includes("foga-probe") && held.some((h) => h.name === "foga-probe")) {
      try {
        const started = Date.now();
        const block = await k.blockNumber();
        const run = await runProbeIsolated({ worldPath: node.worldPath, rpc: node.rpc, bundlePath: node.bundlePath, input: { subject: cell.address, block, lookback: 9000, kya: cfg.identity.standing ? { schemeId: cfg.identity.standing.schemeId, issuers: cfg.identity.standing.issuers } : undefined }, timeoutMs: 60_000 });
        row("skills", "foga-probe runs in the worker", run.answer ? "Pass" : "Fail", `probed ${cell.address} at block ${block} in ${Date.now() - started} ms`);
      } catch (e) {
        row("skills", "foga-probe runs in the worker", "Fail", (e as Error).message);
      }
    }
    if (cfg.skills.offered.includes("finch-extract-verify") && held.some((h) => h.name === "finch-extract-verify")) {
      const fixture = existsSync(node.inputDir) ? readdirSync(node.inputDir).find((f) => f.endsWith(".txt")) : undefined;
      if (!fixture) row("skills", "finch-extract-verify runs in the worker", "NotTested", `no .txt document in the input directory ${node.inputDir}`);
      else {
        try {
          const started = Date.now();
          const pkg = held.find((h) => h.name === "finch-extract-verify")!;
          const run = await runExtractIsolated({ documentPath: join(node.inputDir, fixture), fieldsPath: join(node.skillsDir, "finch-extract-verify", "fields.json"), packageHash: pkg.packageHash, inputDir: node.inputDir, skillsDir: node.skillsDir, timeoutMs: 60_000 });
          row("skills", "finch-extract-verify runs in the worker", run.resultHash ? "Pass" : "Fail", `extracted ${fixture} in ${Date.now() - started} ms`);
        } catch (e) {
          row("skills", "finch-extract-verify runs in the worker", "Fail", (e as Error).message);
        }
      }
    }
  }
  row("skills", "the input directory exists", existsSync(node.inputDir) && statSync(node.inputDir).isDirectory() ? "Pass" : "Fail", node.inputDir);

  // --- the documents: built, and what the chain holds agrees with them
  const built = readBuilt(documentsDir(node));
  if (!built) row("documents", "the documents are built", "Warn", `nothing under ${documentsDir(node)} (foga cell docs build; foga cell docs publish commits them)`);
  else {
    row("documents", "the documents are built", "Pass", `v${built.manifest.version} built ${built.manifest.builtAt}, ${Object.keys(built.manifest.documents).length} files`);
    for (const r of await readBack(node, built, { fetchUrls: o.network !== false })) row("documents", r.commitment, r.ok === true ? "Pass" : r.ok === false ? "Fail" : "Warn", r.detail);
  }

  // --- the public face
  const publicUrl = cfg.runtime.http.publicUrl;
  if (!publicUrl) row("public", "a public URL is configured", "Warn", "runtime.http.publicUrl is not set: the documents commit as data: URIs and the card declares no interface");
  else if (o.network === false) row("public", "the public URL answers", "NotTested", publicUrl);
  else {
    try {
      const r = await fetch(`${publicUrl.replace(/\/+$/, "")}/healthz`, { signal: AbortSignal.timeout(5000) });
      const body = (await r.json()) as { ok?: boolean; account?: string | null };
      const same = body.account?.toLowerCase() === cell.address.toLowerCase();
      row("public", "the public URL answers for this cell", r.ok && same ? "Pass" : "Fail", `${publicUrl}/healthz: HTTP ${r.status}, account ${body.account ?? "none"}`);
    } catch (e) {
      row("public", "the public URL answers for this cell", "Warn", `${publicUrl}/healthz not reachable from here: ${(e as Error).message}`);
    }
  }
  if (cfg.runtime.http.allowedHosts.length && publicUrl) {
    const host = new URL(publicUrl).hostname;
    row("public", "the public host is among the allowed hosts", cfg.runtime.http.allowedHosts.includes(host) ? "Pass" : "Fail", `${host} ${cfg.runtime.http.allowedHosts.includes(host) ? "is" : "is not"} in runtime.http.allowedHosts (${cfg.runtime.http.allowedHosts.join(", ")})`);
  }

  // --- the model, when the node is to run alive
  if (cfg.runtime.model.provider === "anthropic") {
    row("model", "the anthropic adapter has its key and model name", env.ANTHROPIC_API_KEY && cfg.runtime.model.model ? "Pass" : "Fail", `${env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY set" : "ANTHROPIC_API_KEY not set"}; model ${cfg.runtime.model.model ?? "(none)"}; ${cfg.runtime.model.dailyCalls} calls a day`);
  } else row("model", "the model", "Pass", `provider ${cfg.runtime.model.provider} (host mode serves without one; foga node run --model anthropic needs the key and a model name)`);

  return finish(node, rows);
}

function finish(node: Node, rows: PreflightRow[]): PreflightReport {
  const summary: Record<PreflightVerdict, number> = { Pass: 0, Warn: 0, Fail: 0, NotTested: 0 };
  for (const r of rows) summary[r.verdict]++;
  return { schema: "foga.preflight/1", cell: node.config.name, account: node.config.identity.account ?? null, chainId: node.chainId, at: new Date().toISOString(), rows, summary };
}

export function printPreflight(report: PreflightReport, print: (line: string) => void): void {
  print(`preflight: cell ${report.cell}${report.account ? ` (${report.account})` : ""} on chain ${report.chainId}, ${report.at}`);
  let area = "";
  for (const r of report.rows) {
    if (r.area !== area) {
      area = r.area;
      print(`  ${area}`);
    }
    print(`    ${r.verdict.padEnd(9)} ${r.check}`);
    print(`              ${r.detail}`);
  }
  print(`  ${report.summary.Pass} pass, ${report.summary.Warn} warn, ${report.summary.Fail} fail, ${report.summary.NotTested} not tested`);
}

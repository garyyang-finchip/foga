import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { canonicalJson, copyTree, ensureDir, exists, readJson, repoRoot, rmrf, walk, writeJson } from "../util/fs.js";
import { sha256Hex } from "../util/hash.js";
import { codeSize, runtimeIdentity, type ImmutableReferences, type LinkReferences } from "../util/bytecode.js";
import { log } from "../util/log.js";
import { loadLock, verifyVendor, type LockSource } from "./vendor.js";
import type { Bundle, BundleContract, BundleSource, CompilerSettings, ContractKind, InterfaceIdRecord } from "../bundle/types.js";

interface StageCopy {
  from: string;
  to: string;
}
interface RepoProfile {
  repo: string;
  erc: number;
  mode: "native" | "staged";
  solc: string;
  contractsRoot: string;
  stage?: {
    copy: StageCopy[];
    settings: { optimizer: boolean; runs: number; viaIr: boolean; evmVersion: string; bytecodeHash: string };
    mirrors: string;
  };
  vectors: string[];
  extras: Record<string, string>;
}
interface Profiles {
  schema: string;
  foundry: { skip: string[]; solcDirEnv: string; solcBinaryPattern: string };
  repos: RepoProfile[];
  local: { solc: string; project: string; contractsRoot: string };
}

export interface BuildOptions {
  profilesPath?: string;
  lockPath?: string;
  vendorDir?: string;
  outPath?: string;
  workDir?: string;
  solcDir?: string;
  verify?: boolean;
  only?: string[];
}

function sh(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: "1", FOUNDRY_PROFILE: "default", SEPOLIA_RPC_URL: process.env.SEPOLIA_RPC_URL ?? "http://127.0.0.1:1", ...env },
  });
}

function forgeVersion(): string {
  try {
    const out = sh("forge", ["--version"], repoRoot());
    const m = out.match(/Version:\s*([^\s]+)/) ?? out.match(/forge\s+([^\s]+)/);
    return m ? m[1] : out.split("\n")[0].trim();
  } catch {
    throw new Error("forge not found on PATH. Install Foundry (https://getfoundry.sh) or use the Docker image.");
  }
}

function solcBinary(profiles: Profiles, version: string, solcDir?: string): string | undefined {
  const dir = solcDir ?? process.env[profiles.foundry.solcDirEnv];
  if (!dir) return undefined;
  const bin = join(dir, profiles.foundry.solcBinaryPattern.replace("{version}", version));
  return exists(bin) ? bin : undefined;
}

function forgeBuild(projectDir: string, outDir: string, skip: string[], solcPath?: string, extraArgs: string[] = []): void {
  rmrf(outDir);
  ensureDir(outDir);
  const args = ["build", "--ast", "--no-cache", "--out", outDir, ...extraArgs];
  for (const s of skip) args.push("--skip", s);
  if (solcPath) args.push("--use", solcPath);
  try {
    sh("forge", args, projectDir);
  } catch (e: any) {
    const msg = (e.stderr?.toString?.() ?? "") + (e.stdout?.toString?.() ?? "");
    throw new Error(`forge build failed in ${projectDir}:\n${msg.slice(-4000)}`);
  }
}

function writeStagedProject(profile: RepoProfile, repoDir: string, stageDir: string): void {
  if (!profile.stage) throw new Error(`${profile.repo}: staged profile without stage spec`);
  rmrf(stageDir);
  ensureDir(stageDir);
  for (const c of profile.stage.copy) copyTree(join(repoDir, c.from), join(stageDir, c.to));
  const s = profile.stage.settings;
  const toml = [
    "[profile.default]",
    'src = "."',
    'out = "out"',
    "libs = []",
    'test = "__no_tests__"',
    'script = "__no_scripts__"',
    "auto_detect_remappings = false",
    "remappings = []",
    `solc_version = "${profile.solc}"`,
    `optimizer = ${s.optimizer}`,
    `optimizer_runs = ${s.runs}`,
    `via_ir = ${s.viaIr}`,
    `evm_version = "${s.evmVersion}"`,
    `bytecode_hash = "${s.bytecodeHash}"`,
    "cbor_metadata = true",
    "",
  ].join("\n");
  writeFileSync(join(stageDir, "foundry.toml"), toml);
}

function normalizeMetadata(raw: any): any {
  if (!raw) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function classifyRole(kind: ContractKind, abstract: boolean, path: string, name: string): string {
  if (kind === "interface") return "interface";
  if (kind === "library") return "library";
  if (abstract) return "abstract";
  const p = "/" + path.replace(/\\/g, "/");
  if (/\/mocks?\//i.test(p) || /^Mock/.test(name) || /Mock$/.test(name)) return "mock";
  if (p.includes("/adapters/")) return "adapter";
  if (p.includes("/modules/")) return "module";
  if (p.includes("/bridges/")) return "bridge";
  if (p.includes("/verifiers/")) return "verifier";
  if (p.includes("/examples/")) return "example";
  if (p.includes("/companions/")) return "companion";
  if (p.includes("/judgment/")) return "authority";
  if (p.includes("/account/")) return "account";
  if (/Registry$/.test(name)) return "registry";
  if (/Token$/.test(name) || /Vault$/.test(name)) return "kernel";
  return "contract";
}

function xorSelectors(node: any): string | null {
  let acc = 0n;
  let n = 0;
  for (const child of node.nodes ?? []) {
    if (child.nodeType === "FunctionDefinition" && typeof child.functionSelector === "string") {
      acc ^= BigInt("0x" + child.functionSelector);
      n++;
    }
  }
  if (n === 0) return null;
  return "0x" + acc.toString(16).padStart(8, "0");
}

interface Extracted {
  contracts: BundleContract[];
  solcVersions: Set<string>;
}

function extractArtifacts(opts: {
  outDir: string;
  repo: string;
  erc: number | "foga";
  mode: "native" | "staged" | "local";
  contractsRoot: string;
  stageCopies?: StageCopy[];
}): Extracted {
  const contracts: BundleContract[] = [];
  const solcVersions = new Set<string>();
  for (const file of walk(opts.outDir)) {
    if (!file.endsWith(".json")) continue;
    if (file.includes(`${opts.outDir}/build-info/`)) continue;
    const art = readJson<any>(file);
    const metadata = normalizeMetadata(art.metadata);
    if (!metadata?.settings?.compilationTarget) continue;
    const targetEntries = Object.entries(metadata.settings.compilationTarget) as [string, string][];
    if (targetEntries.length !== 1) continue;
    const [sourcePath, name] = targetEntries[0];
    if (name !== basename(file, ".json")) continue;
    const norm = sourcePath.replace(/\\/g, "/");
    // Scope: only the contract tree each profile declares; never tests, scripts or vendored fixtures.
    if (/^(test|script|lib)\//.test(norm) || /\/(test|script)\//.test(norm)) continue;
    let upstreamPath = norm;
    if (opts.mode === "native" || opts.mode === "local") {
      if (!norm.startsWith(opts.contractsRoot.replace(/\/$/, "") + "/")) continue;
    } else {
      const copy = (opts.stageCopies ?? []).find((c) => c.to !== "." && norm.startsWith(c.to.replace(/\/$/, "")));
      upstreamPath = copy ? join(copy.from, norm.slice(copy.to.length)).replace(/\\/g, "/") : `${opts.contractsRoot}/${norm}`;
    }

    let kind: ContractKind = "contract";
    let abstract = false;
    let baseContracts: string[] = [];
    let interfaceId: string | null = null;
    const ast = art.ast;
    if (ast?.nodes) {
      const node = ast.nodes.find((n: any) => n.nodeType === "ContractDefinition" && n.name === name);
      if (node) {
        kind = node.contractKind;
        abstract = Boolean(node.abstract);
        baseContracts = (node.baseContracts ?? []).map((b: any) => b.baseName?.name).filter(Boolean);
        interfaceId = kind === "interface" ? xorSelectors(node) : null;
      }
    } else {
      const bc = art.bytecode?.object ?? "0x";
      if (bc === "0x" && (art.abi?.length ?? 0) > 0) kind = "interface";
    }

    const bytecode: string = art.bytecode?.object ?? "0x";
    const deployedBytecode: string = art.deployedBytecode?.object ?? "0x";
    const linkReferences: LinkReferences = art.bytecode?.linkReferences ?? {};
    const deployedLinkReferences: LinkReferences = art.deployedBytecode?.linkReferences ?? {};
    const immutableReferences: ImmutableReferences = art.deployedBytecode?.immutableReferences ?? {};
    const compiler: string = metadata.compiler?.version ?? "unknown";
    solcVersions.add(compiler);
    const s = metadata.settings ?? {};
    const settings: CompilerSettings = {
      optimizer: Boolean(s.optimizer?.enabled),
      runs: typeof s.optimizer?.runs === "number" ? s.optimizer.runs : null,
      viaIr: Boolean(s.viaIR),
      evmVersion: s.evmVersion ?? null,
      bytecodeHash: s.metadata?.bytecodeHash ?? null,
      remappings: s.remappings ?? [],
    };
    const sourceKeccak: string | null = metadata.sources?.[sourcePath]?.keccak256 ?? null;
    const role = opts.mode === "local" ? "local-stub" : classifyRole(kind, abstract, upstreamPath, name);
    contracts.push({
      key: `${opts.repo}:${name}`,
      repo: opts.repo,
      erc: opts.erc,
      name,
      upstreamPath,
      kind,
      abstract,
      role,
      deployable: bytecode !== "0x" && !abstract && kind !== "interface",
      baseContracts,
      interfaceId,
      abi: art.abi ?? [],
      methodIdentifiers: art.methodIdentifiers ?? {},
      bytecode,
      deployedBytecode,
      linkReferences,
      deployedLinkReferences,
      immutableReferences,
      runtimeIdentity: deployedBytecode === "0x" ? "0x" : runtimeIdentity(deployedBytecode, deployedLinkReferences, immutableReferences),
      creationCodeSize: codeSize(bytecode),
      runtimeCodeSize: codeSize(deployedBytecode),
      compiler,
      settings,
      sourceKeccak,
    });
  }
  contracts.sort((a, b) => a.key.localeCompare(b.key));
  return { contracts, solcVersions };
}

/** Search a vectors JSON tree for `<InterfaceName>: 0x????????` pairs. */
function scanInterfaceIds(tree: any, names: Set<string>, out: Map<string, string>): void {
  if (!tree || typeof tree !== "object") return;
  for (const [k, v] of Object.entries(tree)) {
    if (typeof v === "string" && names.has(k) && /^0x[0-9a-fA-F]{8}$/.test(v)) out.set(k, v.toLowerCase());
    else if (v && typeof v === "object") scanInterfaceIds(v, names, out);
  }
}

export function bundleHash(contracts: Record<string, BundleContract>, sources: BundleSource[]): string {
  const subset: Record<string, any> = {};
  for (const [k, c] of Object.entries(contracts)) {
    subset[k] = {
      abi: c.abi,
      bytecode: c.bytecode,
      deployedBytecode: c.deployedBytecode,
      linkReferences: c.linkReferences,
      deployedLinkReferences: c.deployedLinkReferences,
      immutableReferences: c.immutableReferences,
      compiler: c.compiler,
      settings: c.settings,
      sourceKeccak: c.sourceKeccak,
      upstreamPath: c.upstreamPath,
    };
  }
  const src = sources.map((s) => ({ repo: s.repo, commit: s.commit, mode: s.mode, solc: s.solc }));
  return sha256Hex(canonicalJson({ contracts: subset, sources: src }));
}

export async function buildBundle(opts: BuildOptions = {}): Promise<{ bundle: Bundle; path: string; verified?: boolean }> {
  const root = repoRoot();
  const profiles = readJson<Profiles>(opts.profilesPath ?? join(root, "build", "profiles.json"));
  const lock = loadLock(opts.lockPath);
  const vendorDir = opts.vendorDir ?? join(root, "vendor");
  const workDir = opts.workDir ?? join(root, ".foga-build");
  const outPath = opts.outPath ?? join(root, "artifacts", "bundle.json");

  const problems = verifyVendor({ lockPath: opts.lockPath, vendorDir });
  if (problems.length) throw new Error("vendor tree does not match vendor/LOCK.json:\n  " + problems.join("\n  "));

  const forge = forgeVersion();
  log.info(`forge ${forge}`);
  const contracts: Record<string, BundleContract> = {};
  const sources: BundleSource[] = [];
  const interfaceIds: Record<string, Record<string, InterfaceIdRecord>> = {};
  const extras: Record<string, any> = {};
  const solcUsed: Record<string, string> = {};
  const known = exists(join(root, "build", "known-interface-ids.json"))
    ? readJson<Record<string, { source: string; ids: Record<string, string> }>>(join(root, "build", "known-interface-ids.json"))
    : {};

  for (const profile of profiles.repos) {
    if (opts.only && !opts.only.includes(profile.repo)) continue;
    const lockEntry: LockSource | undefined = lock.sources.find((s) => s.repo === profile.repo);
    if (!lockEntry) throw new Error(`profile ${profile.repo} has no lock entry`);
    const repoDir = join(vendorDir, profile.repo);
    const outDir = join(workDir, "out", profile.repo);
    const solcPath = solcBinary(profiles, profile.solc, opts.solcDir);
    log.info(`building ${profile.repo} (ERC-${profile.erc}, ${profile.mode}, solc ${profile.solc}${solcPath ? ", local binary" : ""})`);

    let projectDir = repoDir;
    if (profile.mode === "staged") {
      projectDir = join(workDir, "stage", profile.repo);
      writeStagedProject(profile, repoDir, projectDir);
      forgeBuild(projectDir, outDir, [], solcPath);
    } else {
      forgeBuild(projectDir, outDir, profiles.foundry.skip, solcPath);
    }
    const ex = extractArtifacts({
      outDir,
      repo: profile.repo,
      erc: profile.erc,
      mode: profile.mode,
      contractsRoot: profile.contractsRoot,
      stageCopies: profile.stage?.copy,
    });
    for (const v of ex.solcVersions) solcUsed[v.split("+")[0]] = v;
    for (const c of ex.contracts) contracts[c.key] = c;
    log.step(`${ex.contracts.length} compilation targets kept from ${relative(root, outDir)}`);

    sources.push({
      erc: profile.erc,
      repo: profile.repo,
      url: lockEntry.url,
      commit: lockEntry.commit,
      contractsRoot: profile.contractsRoot,
      mode: profile.mode,
      upstreamToolchain: lockEntry.upstreamToolchain,
      solc: profile.solc,
      mirrors: profile.stage?.mirrors,
    });

    // Interface ids: computed from the AST, cross-checked against the upstream vectors (or README-published values).
    const names = new Set(ex.contracts.filter((c) => c.kind === "interface").map((c) => c.name));
    const upstream = new Map<string, string>();
    let source: string | null = null;
    for (const v of profile.vectors) {
      const p = join(repoDir, v);
      if (!exists(p)) continue;
      scanInterfaceIds(readJson(p), names, upstream);
      source = v;
    }
    if (known[profile.repo]) {
      for (const [n, id] of Object.entries(known[profile.repo].ids)) if (!upstream.has(n)) upstream.set(n, id.toLowerCase());
      source = source ?? known[profile.repo].source;
    }
    const rec: Record<string, InterfaceIdRecord> = {};
    for (const c of ex.contracts) {
      if (c.kind !== "interface" || !c.interfaceId) continue;
      const up = upstream.get(c.name) ?? null;
      rec[c.name] = { computed: c.interfaceId, upstream: up, match: up ? up === c.interfaceId : null, source: up ? source : null };
      if (up && up !== c.interfaceId) log.warn(`${profile.repo}: ${c.name} id ${c.interfaceId} differs from upstream ${up}`);
    }
    interfaceIds[profile.repo] = rec;

    for (const [k, rel] of Object.entries(profile.extras)) {
      const p = join(repoDir, rel);
      if (exists(p)) {
        extras[profile.repo] = extras[profile.repo] ?? {};
        extras[profile.repo][k] = readJson(p);
      }
    }
  }

  // FOGA's own local-only contracts.
  if (!opts.only || opts.only.includes("foga")) {
    const projectDir = join(root, profiles.local.project);
    const outDir = join(workDir, "out", "foga");
    const solcPath = solcBinary(profiles, profiles.local.solc, opts.solcDir);
    log.info(`building local contracts (${profiles.local.project}, solc ${profiles.local.solc})`);
    forgeBuild(projectDir, outDir, ["test", "script"], solcPath);
    const ex = extractArtifacts({ outDir, repo: "foga", erc: "foga", mode: "local", contractsRoot: profiles.local.contractsRoot });
    for (const v of ex.solcVersions) solcUsed[v.split("+")[0]] = v;
    for (const c of ex.contracts) contracts[c.key] = c;
    sources.push({
      erc: "foga",
      repo: "foga",
      url: null,
      commit: null,
      contractsRoot: `${profiles.local.project}/${profiles.local.contractsRoot}`,
      mode: "local",
      upstreamToolchain: "foundry (this repository)",
      solc: profiles.local.solc,
    });
    log.step(`${ex.contracts.length} local contracts`);
  }

  const ordered: Record<string, BundleContract> = {};
  for (const k of Object.keys(contracts).sort()) ordered[k] = contracts[k];
  const bundle: Bundle = {
    schema: "foga.bundle/1",
    builtAt: new Date().toISOString(),
    builtWith: { forge, solc: solcUsed },
    sources,
    contracts: ordered,
    interfaceIds,
    extras,
    hash: bundleHash(ordered, sources),
  };

  if (opts.verify) {
    if (!exists(outPath)) throw new Error(`nothing to verify: ${outPath} does not exist`);
    const committed = readJson<Bundle>(outPath);
    const verifyPath = join(workDir, "bundle.verify.json");
    writeJson(verifyPath, bundle);
    const ok = committed.hash === bundle.hash;
    if (ok) log.info(`bundle hash verified: ${bundle.hash}`);
    else log.error(`bundle hash mismatch: committed ${committed.hash}, rebuilt ${bundle.hash} (fresh build written to ${relative(root, verifyPath)})`);
    return { bundle, path: verifyPath, verified: ok };
  }

  writeJson(outPath, bundle);
  writeFileSync(outPath.replace(/\.json$/, ".sha256"), `${bundle.hash.slice(2)}  ${basename(outPath)}\n`);
  log.info(`wrote ${relative(root, outPath)} (${Object.keys(ordered).length} contracts, hash ${bundle.hash})`);
  return { bundle, path: outPath };
}

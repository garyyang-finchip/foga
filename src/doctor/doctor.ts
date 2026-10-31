import { Interface } from "ethers";
import { relative } from "node:path";
import { loadBundle } from "../bundle/load.js";
import type { Bundle, BundleContract } from "../bundle/types.js";
import { runtimeIdentity } from "../util/bytecode.js";
import { loadGenesisEvidence, semanticVerdicts, type GenesisEvidenceFile } from "./semantic.js";
import { readJson, repoRoot, writeJson } from "../util/fs.js";
import { log } from "../util/log.js";
import type { WorldFile } from "../world/types.js";
import { READOUTS, WIRING_CHECKS } from "./checks.js";
import { buildProbePlan, executeProbeLive, type ProbePlan, type ProbeResults } from "./probe.js";

export type Verdict = "Pass" | "Fail" | "Unknown" | "NotTested" | "NotApplicable";

export interface CheckResult {
  layer: 1 | 2 | 3 | 4 | 5;
  subject: string;
  check: string;
  verdict: Verdict;
  expected?: string;
  actual?: string;
  detail?: string;
}

export interface DoctorReport {
  schema: "foga.doctor-report/1";
  at: string;
  world: { worldId: string; name: string; network: string; chainId: number; mode: string; bundleHash: string | null };
  source: { rpc: string; collectedAt: string; mode: "live" | "replay" };
  chain: { chainId: number | null; blockNumber: number | null };
  bundleHash: string;
  layers: Record<string, string>;
  results: CheckResult[];
  readouts: { subject: string; fn: string; value: string }[];
  summary: Record<Verdict, number>;
  perContract: Record<string, { address: string; layer1: Verdict; layer2: Verdict; layer3: Verdict; layer4: Verdict }>;
}

export interface DoctorOptions {
  worldPath: string;
  rpc?: string;
  outPath?: string;
  bundlePath?: string;
  /** Write the probe plan here instead of executing it. */
  exportProbePath?: string;
  /** Evaluate previously collected probe results instead of calling an RPC. */
  importResultsPath?: string;
  /** A genesis evidence file (`foga genesis run --out`): layer 5 is evaluated from it. */
  genesisPath?: string;
  /** Print only the layer-5 table and the summary (a second pass after the genesis). */
  quiet?: boolean;
}

const LAYERS: Record<string, string> = {
  "1": "chain and code: the address holds code on the expected chain",
  "2": "interfaces: ERC-165 declarations against the interfaces the contract is built from",
  "3": "version match: runtime code (metadata stripped, library/immutable slots masked) equals the locked build",
  "4": "configuration and permissions: dependency addresses and authority slots match the world",
  "5": "semantic validation: success, rejection, signature, proof and recovery cases, from the genesis evidence (foga genesis run; pass it with --genesis)",
};

function worst(a: Verdict, b: Verdict): Verdict {
  const order: Verdict[] = ["Fail", "Unknown", "Pass", "NotTested", "NotApplicable"];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

function fmt(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.map(fmt).join(", ")}]`;
  return String(v);
}

function same(expected: unknown, actual: unknown): boolean {
  return fmt(expected).toLowerCase() === fmt(actual).toLowerCase();
}

function decodeBool(hex: string | undefined): boolean {
  if (!hex || hex === "0x" || hex.length < 66) return false;
  return BigInt(hex.slice(0, 66)) === 1n;
}

export function loadWorldFile(path: string): WorldFile {
  const world = readJson<WorldFile>(path);
  if (world.schema !== "foga.world/1") throw new Error(`${path} is not a world file (schema ${String(world.schema)}); use \`foga world attach\` for a config, or --attach`);
  return world;
}

export function evaluate(world: WorldFile, bundle: Bundle, plan: ProbePlan, probe: ProbeResults, mode: "live" | "replay", genesis?: GenesisEvidenceFile): DoctorReport {
  const results: CheckResult[] = [];
  const readouts: DoctorReport["readouts"] = [];
  const perContract: DoctorReport["perContract"] = {};
  const expectations = (world.wiring?.expectations as Record<string, string> | undefined) ?? {};
  const r = (key: string) => probe.results[key];
  const hexOf = (key: string): string | undefined => {
    const o = r(key);
    return o && "result" in o ? o.result : undefined;
  };

  const chainHex = hexOf("chainId");
  const chainId = chainHex ? Number(BigInt(chainHex)) : null;
  const blockHex = hexOf("blockNumber");
  const blockNumber = blockHex ? Number(BigInt(blockHex)) : null;
  results.push({ layer: 1, subject: "world", check: "chainId", verdict: chainId === null ? "Unknown" : chainId === world.chainId ? "Pass" : "Fail", expected: String(world.chainId), actual: chainId === null ? "(no answer)" : String(chainId) });
  if (world.bundleHash && world.bundleHash !== bundle.hash) {
    results.push({ layer: 3, subject: "world", check: "bundleHash", verdict: "Unknown", expected: world.bundleHash, actual: bundle.hash, detail: "world was deployed from a different bundle build; layer-3 verdicts compare against the current bundle" });
  }
  if (plan.bundleHash !== bundle.hash) {
    results.push({ layer: 3, subject: "probe", check: "bundleHash", verdict: "Unknown", expected: bundle.hash, actual: plan.bundleHash, detail: "probe plan was built from another bundle" });
  }

  const ifacesByRepo = new Map<string, BundleContract[]>();
  for (const c of Object.values(bundle.contracts)) {
    if (c.kind === "interface" && c.interfaceId) {
      const l = ifacesByRepo.get(c.repo) ?? [];
      l.push(c);
      ifacesByRepo.set(c.repo, l);
    }
  }

  for (const [id, entry] of Object.entries(world.contracts)) {
    const address = entry.address;
    const art = entry.bundleKey ? bundle.contracts[entry.bundleKey] : undefined;
    const codeOutcome = r(`code:${id}`);
    let l1: Verdict;
    let code = "0x";
    if (!codeOutcome) l1 = "NotTested";
    else if ("error" in codeOutcome) l1 = "Unknown";
    else {
      code = codeOutcome.result;
      l1 = code !== "0x" ? "Pass" : "Fail";
    }
    results.push({ layer: 1, subject: id, check: "code", verdict: l1, actual: l1 === "Pass" ? `${(code.length - 2) / 2} bytes` : codeOutcome && "error" in codeOutcome ? codeOutcome.error : "no code at address" });
    if (l1 !== "Pass") {
      perContract[id] = { address, layer1: l1, layer2: "NotTested", layer3: "NotTested", layer4: "NotTested" };
      continue;
    }

    let l2: Verdict = "NotApplicable";
    if (!art && id === "identity8004" && r(`iface:${id}:erc165`)) {
      const erc165 = decodeBool(hexOf(`iface:${id}:erc165`));
      const erc721 = decodeBool(hexOf(`iface:${id}:ERC721`));
      l2 = erc165 && erc721 ? "Pass" : "Fail";
      results.push({ layer: 2, subject: id, check: "supportsInterface(0x01ffc9a7)", verdict: erc165 ? "Pass" : "Fail" });
      results.push({ layer: 2, subject: id, check: "supportsInterface(ERC-721 0x80ac58cd)", verdict: erc721 ? "Pass" : "Fail", detail: "the ERC-8004 Identity Registry is an ERC-721 registry; FOGA does not build it, so this is the only interface check available" });
    } else if (!art) {
      results.push({ layer: 2, subject: id, check: "supportsInterface", verdict: "Unknown", detail: "no bundle key for this address" });
      l2 = "Unknown";
    } else if (!r(`iface:${id}:erc165`)) {
      results.push({ layer: 2, subject: id, check: "supportsInterface", verdict: "NotApplicable", detail: "contract does not expose ERC-165" });
    } else {
      const erc165 = decodeBool(hexOf(`iface:${id}:erc165`));
      l2 = erc165 ? "Pass" : "Fail";
      results.push({ layer: 2, subject: id, check: "supportsInterface(0x01ffc9a7)", verdict: l2 });
      const repoIfaces = ifacesByRepo.get(art.repo) ?? [];
      const expected = new Set(art.baseContracts.filter((b) => repoIfaces.some((i) => i.name === b)));
      const declared: string[] = [];
      for (const iface of repoIfaces) {
        const ok = decodeBool(hexOf(`iface:${id}:${iface.name}`));
        if (ok) declared.push(`${iface.name}=${iface.interfaceId}`);
        if (expected.has(iface.name)) {
          const published = bundle.interfaceIds[art.repo]?.[iface.name]?.upstream != null;
          const v: Verdict = ok ? "Pass" : published ? "Fail" : "Unknown";
          l2 = worst(l2, v);
          results.push({
            layer: 2,
            subject: id,
            check: `supportsInterface(${iface.name})`,
            verdict: v,
            expected: iface.interfaceId ?? undefined,
            detail: ok
              ? undefined
              : published
                ? entry.deployedRevision
                  ? `known: deployed from ${entry.deployedRevision}; the interface id in the locked source may differ from the one that revision declares`
                  : "built from a published interface but does not declare it"
                : "built from this interface but does not declare it; upstream publishes no id for it, so this is a design choice rather than a defect",
          });
        }
      }
      if (declared.length) results.push({ layer: 2, subject: id, check: "declared", verdict: "Pass", actual: declared.join(", "), detail: "interfaces of the same repository the contract reports as supported" });
    }

    let l3: Verdict;
    if (!art && id === "identity8004") {
      l3 = "NotApplicable";
      results.push({ layer: 3, subject: id, check: "runtimeIdentity", verdict: l3, detail: "official ERC-8004 registry, not built by FOGA; no locked build to compare against" });
    } else if (!art) {
      l3 = "Unknown";
      results.push({ layer: 3, subject: id, check: "runtimeIdentity", verdict: l3, detail: "no bundle key" });
    } else {
      const onChain = runtimeIdentity(code, art.deployedLinkReferences, art.immutableReferences);
      l3 = onChain === art.runtimeIdentity ? "Pass" : "Fail";
      results.push({
        layer: 3,
        subject: id,
        check: "runtimeIdentity",
        verdict: l3,
        expected: art.runtimeIdentity,
        actual: onChain,
        detail: l3 === "Fail" ? (entry.deployedRevision ? `known: deployed from ${entry.deployedRevision}; bundle is built from the locked commit` : "runtime code differs from the locked build") : `${art.runtimeCodeSize} bytes, ${art.compiler}`,
      });
    }
    perContract[id] = { address, layer1: l1, layer2: l2, layer3: l3, layer4: "NotApplicable" };
  }

  for (const check of WIRING_CHECKS) {
    const subject = world.contracts[check.subject];
    if (!subject) continue;
    const label = check.label ?? check.fn;
    const key = `wire:${check.subject}:${label}`;
    const pc = perContract[check.subject];
    const bump = (v: Verdict) => {
      if (pc) pc.layer4 = worst(pc.layer4 === "NotApplicable" ? v : pc.layer4, v);
    };
    const art = subject.bundleKey ? bundle.contracts[subject.bundleKey] : undefined;
    if (!art || !art.abi.some((f: any) => f.type === "function" && f.name === check.fn)) {
      results.push({ layer: 4, subject: check.subject, check: label, verdict: "Unknown", detail: "getter not in the bundle ABI" });
      bump("Unknown");
      continue;
    }
    const args = check.args ? check.args(world) : [];
    if (args === null) {
      results.push({ layer: 4, subject: check.subject, check: label, verdict: "NotApplicable", detail: "arguments unavailable in this world file" });
      continue;
    }
    let expected: unknown;
    let source = "";
    const expKey = `${check.subject}.${label}`;
    if (expectations[expKey] !== undefined) {
      expected = expectations[expKey];
      source = "world expectation";
    } else if (check.expectRef) {
      const ref = world.contracts[check.expectRef];
      if (!ref) {
        results.push({ layer: 4, subject: check.subject, check: label, verdict: "NotApplicable", detail: `reference ${check.expectRef} absent from this world` });
        continue;
      }
      expected = ref.address;
      source = check.expectRef;
    } else if (check.expectParam) {
      expected = check.expectParam(world);
      source = "world params";
    }
    const outcome = r(key);
    if (!outcome) {
      results.push({ layer: 4, subject: check.subject, check: label, verdict: "NotTested", expected: fmt(expected) });
      continue;
    }
    if ("error" in outcome) {
      results.push({ layer: 4, subject: check.subject, check: label, verdict: "Fail", expected: `${fmt(expected)} (${source})`, detail: `call failed: ${outcome.error}` });
      bump("Fail");
      continue;
    }
    let actual: unknown;
    try {
      const decoded = new Interface(art.abi).decodeFunctionResult(check.fn, outcome.result);
      actual = decoded.length === 1 ? decoded[0] : decoded.toArray();
    } catch (e: any) {
      results.push({ layer: 4, subject: check.subject, check: label, verdict: "Unknown", detail: `cannot decode result: ${e.message}` });
      bump("Unknown");
      continue;
    }
    const v: Verdict = same(expected, actual) ? "Pass" : "Fail";
    results.push({ layer: 4, subject: check.subject, check: label, verdict: v, expected: `${fmt(expected)} (${source})`, actual: fmt(actual) });
    bump(v);
  }
  for (const ro of READOUTS) {
    const subject = world.contracts[ro.subject];
    const art = subject?.bundleKey ? bundle.contracts[subject.bundleKey] : undefined;
    const outcome = r(`readout:${ro.subject}:${ro.fn}`);
    if (!subject || !art || !outcome) continue;
    if ("error" in outcome) {
      readouts.push({ subject: ro.subject, fn: ro.fn, value: `(call failed: ${outcome.error})` });
      continue;
    }
    try {
      const decoded = new Interface(art.abi).decodeFunctionResult(ro.fn, outcome.result);
      readouts.push({ subject: ro.subject, fn: ro.fn, value: fmt(decoded.length === 1 ? decoded[0] : decoded.toArray()) });
    } catch {
      readouts.push({ subject: ro.subject, fn: ro.fn, value: outcome.result });
    }
  }

  const ercs = new Set(Object.keys(world.contracts).map((k) => k.split("/")[0]).filter((k) => /^\d+$/.test(k)));
  if (Object.keys(world.contracts).some((k) => k.startsWith("identity8004") || k.startsWith("8004/"))) ercs.add("8004");
  if (!genesis) {
    for (const erc of [...ercs].sort()) {
      results.push({ layer: 5, subject: `ERC-${erc}`, check: "semantic validation", verdict: "NotTested", detail: "no genesis evidence given (foga genesis run, then foga doctor --genesis <evidence.json>)" });
    }
  } else {
    const sameWorld = genesis.worldId === world.worldId && genesis.chainId === world.chainId;
    results.push({ layer: 5, subject: "genesis", check: "evidence", verdict: sameWorld ? "Pass" : "Fail", expected: `${world.worldId} (chain ${world.chainId})`, actual: `${genesis.worldId} (chain ${genesis.chainId}), until ${genesis.until}, ${genesis.summary.checks} checks, ${genesis.summary.failed} failed, ran ${genesis.ranAt}`, detail: sameWorld ? undefined : "the evidence was produced on another world; layer-5 verdicts below are not about this world" });
    for (const v of semanticVerdicts(genesis, [...ercs].sort())) {
      results.push({ layer: 5, subject: `ERC-${v.erc}`, check: "semantic validation", verdict: sameWorld ? v.verdict : "Unknown", expected: "every genesis check that exercises the standard passes", actual: `${v.passed} pass, ${v.failed} fail, ${v.skipped} skipped`, detail: v.detail });
    }
  }

  const summary: Record<Verdict, number> = { Pass: 0, Fail: 0, Unknown: 0, NotTested: 0, NotApplicable: 0 };
  for (const x of results) summary[x.verdict]++;

  return {
    schema: "foga.doctor-report/1",
    at: new Date().toISOString(),
    world: { worldId: world.worldId, name: world.name, network: world.network, chainId: world.chainId, mode: world.mode, bundleHash: world.bundleHash },
    source: { rpc: probe.rpc, collectedAt: probe.at, mode },
    chain: { chainId, blockNumber },
    bundleHash: bundle.hash,
    layers: LAYERS,
    results,
    readouts,
    summary,
    perContract,
  };
}

export async function runDoctor(opts: DoctorOptions): Promise<{ report: DoctorReport | null; path: string | null }> {
  const root = repoRoot();
  const world = loadWorldFile(opts.worldPath);
  const bundle = loadBundle(opts.bundlePath);
  const plan = buildProbePlan(world, bundle);

  if (opts.exportProbePath) {
    writeJson(opts.exportProbePath, plan);
    log.info(`probe plan with ${plan.requests.length} requests written to ${relative(root, opts.exportProbePath)}; collect results with any JSON-RPC relay, then \`foga doctor --world ... --import-results <file>\``);
    return { report: null, path: opts.exportProbePath };
  }

  let probe: ProbeResults;
  let mode: "live" | "replay";
  if (opts.importResultsPath) {
    probe = readJson<ProbeResults>(opts.importResultsPath);
    if (probe.schema !== "foga.probe-results/1") throw new Error(`${opts.importResultsPath} is not a probe-results file`);
    mode = "replay";
  } else {
    const rpc = opts.rpc ?? process.env.FOGA_RPC_URL ?? (world.network === "anvil" ? "http://127.0.0.1:8545" : undefined);
    if (!rpc) throw new Error("no RPC: pass --rpc, set FOGA_RPC_URL, or replay with --import-results");
    probe = await executeProbeLive(plan, rpc);
    mode = "live";
  }
  const genesis = opts.genesisPath ? loadGenesisEvidence(opts.genesisPath) : undefined;
  const report = evaluate(world, bundle, plan, probe, mode, genesis);
  printReport(report, opts.quiet);
  let outPath: string | null = null;
  if (opts.outPath) {
    outPath = opts.outPath;
    writeJson(outPath, report);
    log.info(`report written to ${relative(root, outPath)}`);
  }
  return { report, path: outPath };
}

function printReport(r: DoctorReport, quiet = false): void {
  const pad = (s: string, n: number) => (s.length >= n ? s + " " : s + " ".repeat(n - s.length));
  console.log(`\nfoga doctor — world ${r.world.worldId} (${r.world.network}, chain ${r.chain.chainId ?? "?"}, block ${r.chain.blockNumber ?? "?"}, ${r.source.mode} via ${r.source.rpc})`);
  console.log(`bundle ${r.bundleHash}${r.world.bundleHash && r.world.bundleHash !== r.bundleHash ? " (world built from " + r.world.bundleHash + ")" : ""}\n`);
  if (!quiet) {
    console.log(pad("contract", 34) + pad("address", 44) + pad("L1 code", 10) + pad("L2 iface", 15) + pad("L3 version", 12) + "L4 wiring");
    for (const [id, pc] of Object.entries(r.perContract)) {
      console.log(pad(id, 34) + pad(pc.address, 44) + pad(pc.layer1, 10) + pad(pc.layer2, 15) + pad(pc.layer3, 12) + pc.layer4);
    }
  }
  const fails = r.results.filter((x) => x.verdict === "Fail");
  if (fails.length) {
    console.log("\nfailures:");
    for (const f of fails) console.log(`  L${f.layer} ${f.subject} ${f.check}: expected ${f.expected ?? "-"}, actual ${f.actual ?? "-"}${f.detail ? " — " + f.detail : ""}`);
  }
  const unknowns = r.results.filter((x) => x.verdict === "Unknown");
  if (unknowns.length && !quiet) {
    console.log("\nunknown:");
    for (const u of unknowns) console.log(`  L${u.layer} ${u.subject} ${u.check}${u.detail ? " — " + u.detail : ""}`);
  }
  if (r.readouts.length && !quiet) {
    console.log("\nreadouts:");
    for (const x of r.readouts) console.log(`  ${x.subject}.${x.fn} = ${x.value}`);
  }
  const l5 = r.results.filter((x) => x.layer === 5 && x.subject.startsWith("ERC-"));
  if (l5.some((x) => x.verdict !== "NotTested")) {
    console.log("\nlayer 5 (semantic, from the genesis evidence):");
    for (const x of l5) console.log(`  ${pad(x.subject, 10)} ${pad(x.verdict, 10)} ${x.detail ?? ""}`);
  }
  console.log(`\nsummary: ${Object.entries(r.summary).map(([k, v]) => `${k} ${v}`).join(", ")}${l5.every((x) => x.verdict === "NotTested") ? "; layer 5 (semantic) needs the genesis evidence: foga genesis run, then foga doctor --genesis <evidence.json>" : ""}\n`);
}

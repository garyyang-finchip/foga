import { join } from "node:path";
import { ZeroHash, getAddress, parseEther, type Interface } from "ethers";
import { AID, type AIDDocument } from "../core/aid.js";
import { agentDescriptor, kindId, skillDescriptor, taskDescriptor } from "../core/ard.js";
import { Enforcement, Rights, accountSubjectKey, fogaCellSpecification, oneClause, requirementIdOf, scopeKeyOf } from "../core/asf.js";
import { accountRef, dataUri, dataUriJcs, keccakJcs, sha256Hex } from "../core/canonical.js";
import { accountSubject, fogaAttestedSchemeDescriptor, fogaPredicateSchemeDescriptor, fogaProvedSchemeDescriptor } from "../core/kya.js";
import { buildSkillPackage, readSkillDir, type SkillPackage } from "../core/pack/skillpack.js";
import { hashlock, nativeTerms } from "../core/tenders.js";
import { cellUnitDefinition, skillUnitDefinition } from "../core/units.js";
import { councilDescriptor, councilPolicySpec } from "../core/acdf.js";
import { escrowBindingInput, serviceDescriptor, servicePolicySpec, type ServiceTiming } from "../core/adrf.js";
import { Cell } from "../kernel/cell.js";
import { Kernel } from "../kernel/kernel.js";
import { EPOCH_GRACE, EPOCH_LENGTH, PREDICATE_VALIDITY, attestorKeyFrom, predicateAvailability, proverLibsAvailable, sourceKeyFrom, zk, zkAvailability } from "./zk.js";
import { CELLS, operatorRole, ownerRole, roleKeys, type CellName, type Role } from "./roles.js";
import { CELL_CAPITAL, fundRoles, operatorGasFloor } from "./funding.js";
import { runProbe, type ProbeInput } from "./probe.js";
import { runProbeIsolated, verifiedPackage } from "./skill-runner.js";

export const STEPS = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"] as const;
export type StepName = (typeof STEPS)[number];

/** Bumped whenever the operation keys or their inputs change; a store written by another version is refused. */
export const SCENARIO_VERSION = "4";

export type ZkMode = "auto" | "require" | "skip";

export interface GenesisConfig {
  worldPath: string;
  rpc: string;
  bundlePath?: string;
  storePath: string;
  skillsDir: string;
  fixturesDir: string;
  /** The credential-pattern ZK path: run when the prover is available (auto), insist on it (require), or leave it out (skip). */
  zk: ZkMode;
  crashBeforeBroadcast?: string;
  crashAfterBroadcast?: string;
  log: (line: string) => void;
}

/**
 * Windows and margins of the deliberations. On a local chain they are realistic and the clock is moved past them;
 * on any other chain they are short enough to wait for (about fifty minutes of waiting over T5-T7 in all), while
 * keeping the relations the registries enforce: the service policy's decision window holds the council's whole
 * procedure (2 x window + appeal), and a call's dispute period outlasts the service track plus its enactment margin.
 */
export interface Timing {
  councilWindow: number;
  appealWindow: number;
  governanceWindow: number;
  margin: number;
  judgmentWindow: number;
  noDecisionJudgmentWindow: number;
  /** The service-call dispute policy (T6): its decision window must hold the council's whole procedure. */
  service: ServiceTiming;
}

export const LOCAL_TIMING: Timing = {
  councilWindow: 86_400,
  appealWindow: 3_600,
  governanceWindow: 86_400,
  margin: 3_600,
  judgmentWindow: 7 * 86_400,
  noDecisionJudgmentWindow: 3 * 86_400,
  service: { filingWindow: 7 * 86_400, evidenceWindow: 86_400, decisionWindow: 3 * 86_400, reviewWindow: 86_400, enactmentMargin: 86_400, disputePeriod: 10 * 86_400 },
};
export const PUBLIC_TIMING: Timing = {
  councilWindow: 180,
  appealWindow: 60,
  governanceWindow: 180,
  margin: 60,
  judgmentWindow: 900,
  noDecisionJudgmentWindow: 600,
  service: { filingWindow: 1_800, evidenceWindow: 180, decisionWindow: 600, reviewWindow: 120, enactmentMargin: 120, disputePeriod: 1_800 },
};

/** The liveness window the cells shorten to in T7 so that STALE is reached by waiting, on every chain (seconds). */
export const LIVENESS_DEMO_WINDOW = 120;

export interface CheckResult {
  step: StepName;
  name: string;
  pass: boolean;
  detail: string;
}

const ZERO32 = "0x" + "00".repeat(32);
const SKILL_NAMES = ["foga-probe", "finch-extract-verify"] as const;

/**
 * The genesis scenario (design memo, section 4), T0 to T3 in this phase. Every chain write is a keyed operation,
 * every value a later step needs is a fact, every post-condition of the memo is a check that re-runs on resume.
 */
export class Genesis {
  readonly checks: CheckResult[] = [];
  readonly cells = new Map<CellName, Cell>();
  readonly timing: Timing;

  private constructor(
    readonly kernel: Kernel,
    readonly cfg: GenesisConfig,
  ) {
    this.timing = kernel.isLocalChain ? LOCAL_TIMING : PUBLIC_TIMING;
  }

  static async open(cfg: GenesisConfig): Promise<Genesis> {
    // The keys are decided by the world file, so load it first through a throw-away World handle.
    const { World } = await import("../core/world.js");
    const w = World.load(cfg.worldPath, cfg.rpc, cfg.bundlePath);
    const keys = roleKeys(w.file);
    w.provider.destroy();
    const kernel = await Kernel.open({
      worldPath: cfg.worldPath,
      rpc: cfg.rpc,
      bundlePath: cfg.bundlePath,
      storePath: cfg.storePath,
      keys,
      crashBeforeBroadcast: cfg.crashBeforeBroadcast,
      crashAfterBroadcast: cfg.crashAfterBroadcast,
      log: cfg.log,
    });
    const have = kernel.store.getMeta("scenarioVersion");
    if (have && have !== SCENARIO_VERSION) {
      kernel.close();
      throw new Error(`operation store ${cfg.storePath} was written by scenario version ${have}; this build runs version ${SCENARIO_VERSION}. Start from a fresh store (delete it or pass --store).`);
    }
    if (!have) kernel.store.setMeta("scenarioVersion", SCENARIO_VERSION);
    return new Genesis(kernel, cfg);
  }

  close(): void {
    this.kernel.close();
    this.kernel.world.provider.destroy();
  }

  get world() {
    return this.kernel.world;
  }

  get chainId(): number {
    return this.kernel.chainId;
  }

  log(line: string): void {
    this.cfg.log(line);
  }

  /**
   * Record a check. `until` names operations of later steps that change the state the check is about; when one of
   * them is already confirmed in the store (a replayed or resumed run), the check cannot be remade and is recorded
   * as skipped with the reason, never as passed or failed.
   */
  check(step: StepName, name: string, pass: boolean, detail: string, until?: string | string[]): void {
    const keys = typeof until === "string" ? [until] : (until ?? []);
    const superseded = keys.find((k) => this.kernel.store.get(k)?.status === "confirmed");
    if (superseded) return this.skipped(step, name, `replayed run: the state was changed later by ${superseded}`);
    this.checks.push({ step, name, pass, detail });
    this.log(`  ${pass ? "ok  " : "FAIL"} ${step} ${name}: ${detail}`);
  }

  /** A check that could not be made on this machine; recorded as passed with the reason, never silently dropped. */
  skipped(step: StepName, name: string, reason: string): void {
    this.checks.push({ step, name, pass: true, detail: `skipped: ${reason}` });
    this.log(`  skip ${step} ${name}: ${reason}`);
  }

  selector(iface: Interface, fn: string): string {
    const f = iface.getFunction(fn);
    if (!f) throw new Error(`no function ${fn}`);
    return f.selector;
  }

  // ------------------------------------------------------------------------------------------------ driver

  async run(until: StepName): Promise<void> {
    const stop = STEPS.indexOf(until);
    for (const step of STEPS.slice(0, stop + 1)) {
      this.log(`${step}: start`);
      await fundRoles(this.kernel, step, (line) => this.log(line));
      if (step === "T0") await this.t0();
      if (step === "T1") await this.t1();
      if (step === "T2") await this.t2();
      if (step === "T3") await this.t3();
      if (step === "T4") await (await import("./t4.js")).t4(this);
      if (step === "T5") await (await import("./t5.js")).t5(this);
      if (step === "T6") await (await import("./t6.js")).t6(this);
      if (step === "T7") await (await import("./t7.js")).t7(this);
      if (step === "T8") await (await import("./t8.js")).t8(this);
      if (step === "T9") await (await import("./t9.js")).t9(this);
      this.kernel.setFact(`step.${step}.done`, true);
      this.log(`${step}: done`);
    }
  }

  // ------------------------------------------------------------------------------------------------ T0 world

  /** T0: the world exists (deployed by `foga world deploy`); W registers what the cells will adopt. */
  async t0(): Promise<void> {
    const k = this.kernel;
    const W = "W";

    // KYA scheme S_att: attested, ordered levels 0..3, account subjects.
    const attDescriptor = fogaAttestedSchemeDescriptor();
    const attInput = k.kya.attestedSchemeInput(attDescriptor);
    const att = await k.call("T0.kya.S_att.register", W, k.kya.schemeRegistryAddress, k.kya.schemes().interface, "registerScheme", [attInput]);
    const sAtt = k.kya.schemeIdFromReceipt(att.receipt);
    k.setFact("T0.kya.S_att", { schemeId: sAtt, schemeHash: attInput.schemeHash, levelMask: attInput.levelMask.toString() });

    // The credential-pattern ZK path: FOGA's own issuer set (one attestor key held by W) and its own instance of
    // the upstream Groth16 adapter pinned to that set; S_cred admits proofs through it. Decided once per store.
    const zkMode = await k.memo<"on" | "off">("T0.zk", async () => {
      if (this.cfg.zk === "skip") return "off";
      const a = zkAvailability();
      if (a.ok) return "on";
      if (this.cfg.zk === "require") throw new Error(`the ZK path was required but is not available:\n  ${a.missing.join("\n  ")}`);
      this.log(`  zk: proving material not available, the credential-pattern path is left out of this store (${a.missing.join("; ")})`);
      return "off";
    });
    let credVerifier = this.world.address("8419/Groth16KYAVerifierAdapter");
    if (zkMode === "on") {
      const attestor = attestorKeyFrom(k.signer(W).privateKey, "W");
      const set = await k.memo("T0.kya.issuerSet", async () => {
        const r = await zk.issuerSet([attestor]);
        return { root: r.root, attestors: r.attestors };
      });
      const adapter = await k.deploy("T0.kya.adapter.deploy", W, "kya-standard:Groth16KYAVerifierAdapter", [this.world.address("8419/Groth16Verifier"), set.root, EPOCH_LENGTH, EPOCH_GRACE]);
      k.setFact("T0.kya.adapter", adapter.address);
      this.world.attach("foga/Groth16KYAVerifierAdapter", adapter.address, "kya-standard:Groth16KYAVerifierAdapter");
      credVerifier = adapter.address;
      const pinned: string = await this.world.contract("foga/Groth16KYAVerifierAdapter").requiredIssuerSetRoot();
      this.check("T0", "zk.adapter", pinned === set.root, `FOGA's Groth16 adapter ${adapter.address} pins issuer set root ${set.root.slice(0, 10)}…`);
    }
    const credDescriptor = fogaProvedSchemeDescriptor();
    const credInput = k.kya.provedSchemeInput(credDescriptor, credVerifier);
    const cred = await k.call("T0.kya.S_cred.register", W, k.kya.schemeRegistryAddress, k.kya.schemes().interface, "registerScheme", [credInput]);
    const sCred = k.kya.schemeIdFromReceipt(cred.receipt);
    k.setFact("T0.kya.S_cred", { schemeId: sCred, schemeHash: credInput.schemeHash, verifier: credInput.verifier });

    // The predicate-pattern ZK path: FOGA's own circuit (kya-predicate-count-v1), its generated Groth16 verifier
    // and its adapter, pinned to a source set holding one source key (held by W: the node that indexes task
    // completions and signs records of them). The scheme is registered on every machine; the proof (T3) needs the
    // proving material built by prover/build-predicate.mjs. Decided once per store.
    const predMode = await k.memo<"on" | "off">("T0.zk.predicate", async () => {
      if (this.cfg.zk === "skip") return "off";
      const a = predicateAvailability();
      if (a.ok) return "on";
      if (this.cfg.zk === "require") throw new Error(`the predicate ZK path was required but is not available:\n  ${a.missing.join("\n  ")}`);
      this.log(`  zk: predicate proving material not available, the predicate proof is left out of this store (${a.missing.join("; ")})`);
      return "off";
    });
    const sourceSet = await k.memo<{ root: string; sources: { pub: [string, string]; leaf: string }[]; pinned: boolean }>("T0.kya.sourceSet", async () => {
      if (!proverLibsAvailable()) {
        this.log("  zk: the proving libraries are not installed, so no source set root can be computed; the predicate adapter is deployed unpinned");
        return { root: ZeroHash, sources: [], pinned: false };
      }
      const r = await zk.sourceSet([sourceKeyFrom(k.signer(W).privateKey, "completions")]);
      return { root: r.root, sources: r.attestors, pinned: true };
    });
    const groth16Pred = await k.deploy("T0.kya.predicate.verifier.deploy", W, "foga:Groth16PredicateVerifier", []);
    this.world.attach("foga/Groth16PredicateVerifier", groth16Pred.address, "foga:Groth16PredicateVerifier");
    const predAdapter = await k.deploy("T0.kya.predicate.adapter.deploy", W, "foga:Groth16PredicateKYAVerifierAdapter", [groth16Pred.address, sourceSet.root, EPOCH_LENGTH, EPOCH_GRACE, PREDICATE_VALIDITY]);
    this.world.attach("foga/Groth16PredicateKYAVerifierAdapter", predAdapter.address, "foga:Groth16PredicateKYAVerifierAdapter");
    const predInput = k.kya.provedSchemeInput(fogaPredicateSchemeDescriptor(), predAdapter.address);
    const pred = await k.call("T0.kya.S_pred.register", W, k.kya.schemeRegistryAddress, k.kya.schemes().interface, "registerScheme", [predInput]);
    const sPred = k.kya.schemeIdFromReceipt(pred.receipt);
    k.setFact("T0.kya.S_pred", { schemeId: sPred, schemeHash: predInput.schemeHash, verifier: predAdapter.address, groth16: groth16Pred.address, sourceSetRoot: sourceSet.root, pinned: sourceSet.pinned, zk: predMode });

    // ASF specification FOGA-Cell-v1.
    const spec = fogaCellSpecification();
    const salt = keccakJcs({ spec: "FOGA-Cell-v1" });
    const commitment = k.asf.specificationCommitment(spec);
    const reg = await k.call("T0.asf.spec.register", W, k.asf.specRegistryAddress, k.asf.specs().interface, "registerSpecification", [salt, commitment.contentHash, commitment.locator, []]);
    const specId = k.asf.specIdFromReceipt(reg.receipt);
    k.setFact("T0.asf.spec", { specId, version: 1, contentHash: commitment.contentHash, salt });

    // The ACDF policy FOGA-Council (judges J1-J3, two approvals decide) and FOGA's instance of the upstream
    // ACDFTaskTenderAdapter bound to it: the judged acceptance authority of T5.
    const judges = ["J1", "J2", "J3"].map((j) => k.address(j));
    const descriptor = councilDescriptor({ judges, k: 2, window: this.timing.councilWindow, appealWindow: this.timing.appealWindow });
    const policy = councilPolicySpec({ judges, k: 2, window: this.timing.councilWindow, appealWindow: this.timing.appealWindow, updateAuthority: k.address(W), descriptor });
    const pol = await k.call("T0.acdf.policy.register", W, k.acdf.policyRegistryAddress, k.acdf.policies().interface, "registerPolicy", [policy]);
    const policyId = k.acdf.policyIdFromReceipt(pol.receipt);
    k.setFact("T0.acdf.policy", { policyId, judges, k: 2, window: this.timing.councilWindow, appealWindow: this.timing.appealWindow, maxTotalDuration: policy.maxTotalDuration, descriptorHash: policy.descriptorHash });
    const tenderAdapter = await k.deploy("T0.acdf.tenderAdapter.deploy", W, "acd-framework:ACDFTaskTenderAdapter", [k.acdf.registryAddress, k.tenders.address, policyId, this.timing.margin]);
    k.setFact("T0.acdf.tenderAdapter", tenderAdapter.address);
    this.world.attach("foga/ACDFTaskTenderAdapter", tenderAdapter.address, "acd-framework:ACDFTaskTenderAdapter");

    // The ADRF policy FOGA-Service-v1 (judgment tier = FOGA-Council through the bridge) and the world's service
    // escrow bound to it by its admin, W: the dispute path of T6 exists before any call is opened.
    const escrowAdmin: string = await k.adrf.escrow().admin();
    if (getAddress(escrowAdmin) !== getAddress(k.address(W))) throw new Error(`the world's ADRFServiceEscrow ${k.adrf.escrowAddress} is administered by ${escrowAdmin}, not by W ${k.address(W)}: the escrow must be deployed by W for the genesis to bind it (deploy the world with W's key: FOGA_MNEMONIC makes W the deployer, or set FOGA_DEPLOYER_PK to W's key)`);
    const serviceParams = { escrow: k.adrf.escrowAddress, versionVerifier: k.adrf.versionVerifierAddress, bridge: k.adrf.bridgeAddress, councilPolicyId: policyId, timing: this.timing.service };
    const servicePolicy = servicePolicySpec({ ...serviceParams, updateAuthority: k.address(W), descriptor: serviceDescriptor(serviceParams) });
    const spol = await k.call("T0.adrf.policy.register", W, k.adrf.policyRegistryAddress, k.adrf.policies().interface, "registerPolicy", [servicePolicy]);
    const servicePolicyId = k.adrf.policyIdFromReceipt(spol.receipt);
    const bindingTerms = { kind: "binding-terms", escrow: k.adrf.escrowAddress.toLowerCase(), policy: "FOGA-Service-v1", funds: "the escrow enacts a refund only out of the settlement it holds for the disputed call", thirdParties: "none" };
    const bindInput = escrowBindingInput(servicePolicyId, keccakJcs(bindingTerms));
    const bound = await k.call("T0.adrf.escrow.bind", W, k.adrf.escrowAddress, k.adrf.escrow().interface, "bindTo", [bindInput]);
    const bindingId = k.adrf.bindingIdFromReceipt(bound.receipt);
    k.setFact("T0.adrf", { policyId: servicePolicyId, bindingId, escrow: k.adrf.escrowAddress, maxTotalDuration: servicePolicy.track.maxTotalDuration, timing: this.timing.service, descriptorHash: servicePolicy.descriptorHash, bindingTermsHash: bindInput.termsHash });

    k.evidence("T0", "registrations", {
      W: k.address(W),
      schemes: { S_att: sAtt, S_cred: sCred, S_credVerifier: credVerifier, zk: zkMode, S_pred: sPred, S_predVerifier: predAdapter.address, S_predGroth16: groth16Pred.address, sourceSetRoot: sourceSet.root, zkPredicate: predMode },
      specification: { specId, version: 1, contentHash: commitment.contentHash, locatorBytes: commitment.locator.length },
      council: { policyId, judges, k: 2, window: this.timing.councilWindow, appealWindow: this.timing.appealWindow, tenderAdapter: tenderAdapter.address, margin: this.timing.margin },
      service: { policyId: servicePolicyId, bindingId, escrow: k.adrf.escrowAddress, versionVerifier: k.adrf.versionVerifierAddress, bridge: k.adrf.bridgeAddress, timing: this.timing.service, maxTotalDuration: servicePolicy.track.maxTotalDuration },
      txs: { S_att: att.txHash, S_cred: cred.txHash, S_pred: pred.txHash, spec: reg.txHash, policy: pol.txHash, servicePolicy: spol.txHash, escrowBind: bound.txHash },
    });

    // checks
    const got = await k.asf.versionOf(specId, 1);
    this.check("T0", "spec.pinned", got.contentHash === commitment.contentHash, `versionOf(${specId.slice(0, 10)}…, 1).contentHash matches keccak(JCS(spec))`);
    const schemeOk = await k.kya.schemes().schemeExists(sAtt);
    this.check("T0", "scheme.S_att", Boolean(schemeOk), `S_att ${sAtt.slice(0, 10)}… exists`);
    const credOk = await k.kya.schemes().schemeExists(sCred);
    this.check("T0", "scheme.S_cred", Boolean(credOk), `S_cred ${sCred.slice(0, 10)}… exists (verifier ${credVerifier})`);
    const predOk = await k.kya.schemes().schemeExists(sPred);
    const pinnedRoot: string = await this.world.contract("foga/Groth16PredicateKYAVerifierAdapter").requiredSourceSetRoot();
    this.check("T0", "scheme.S_pred", Boolean(predOk) && pinnedRoot === sourceSet.root, `S_pred ${sPred.slice(0, 10)}… exists; FOGA's predicate adapter ${predAdapter.address} over verifier ${groth16Pred.address} pins source set root ${sourceSet.root.slice(0, 10)}…${sourceSet.pinned ? "" : " (unpinned: no proving libraries)"}`);
    const policyOk = await k.acdf.policies().policyExists(policyId);
    this.check("T0", "council.policy", Boolean(policyOk), `FOGA-Council ${policyId.slice(0, 10)}… registered: ${judges.length} judges, k = 2, window ${this.timing.councilWindow} s`);
    const adapterPolicy: string = await this.world.contract("foga/ACDFTaskTenderAdapter").policyId();
    const judged = !(await this.world.contract("foga/ACDFTaskTenderAdapter").supportsInterface("0x9977db15"));
    this.check("T0", "council.tenderAdapter", adapterPolicy === policyId && judged, `ACDFTaskTenderAdapter ${tenderAdapter.address} bound to the policy; does not declare ITaskVerifier (judged authority)`);
    const servicePolicyOk = await k.adrf.policies().policyExists(servicePolicyId);
    const binding = await k.adrf.registry().getBinding(bindingId);
    const escrowBindingId: string = await k.adrf.escrow().bindingId();
    this.check("T0", "service.policy", Boolean(servicePolicyOk) && getAddress(binding.source) === getAddress(k.adrf.escrowAddress) && binding.policyId === servicePolicyId && escrowBindingId === bindingId, `FOGA-Service-v1 ${servicePolicyId.slice(0, 10)}… registered (decision window ${this.timing.service.decisionWindow} s holds the council's ${policy.maxTotalDuration} s); the escrow ${k.adrf.escrowAddress} is bound to it (binding ${bindingId.slice(0, 10)}…, refund authorized)`);
  }

  // ------------------------------------------------------------------------------------------------ T1 birth

  async t1(): Promise<void> {
    for (const X of CELLS) await this.t1Cell(X);
  }

  cell(X: CellName): Cell {
    const c = this.cells.get(X);
    if (c) return c;
    const address = this.kernel.fact<string>(`T1.${X}.address`);
    if (!address) throw new Error(`cell ${X} has not been born (run T1)`);
    const cell = new Cell(this.kernel, X, address, { owner: ownerRole(X), operator: operatorRole(X), guardian: this.kernel.address("G") });
    this.cells.set(X, cell);
    return cell;
  }

  private async t1Cell(X: CellName): Promise<void> {
    const k = this.kernel;
    const spec = k.requireFact<{ specId: string; version: number; contentHash: string }>("T0.asf.spec");
    const sAtt = k.requireFact<{ schemeId: string }>("T0.kya.S_att").schemeId;
    const G = k.address("G");
    const roles = { owner: ownerRole(X), operator: operatorRole(X), guardian: G };
    const chainId = this.chainId;

    // 1. the body: deployed by the owner; the requirement names the account itself
    const cell = await Cell.deploy(k, {
      key: `T1.${X}.deploy`,
      name: X,
      roles,
      requirement: (predicted) =>
        oneClause({
          specRegistry: k.asf.specRegistryAddress,
          specId: spec.specId,
          versions: [spec.version],
          adopter: predicted,
          subjectKey: accountSubjectKey(chainId, predicted),
          scopeKey: scopeKeyOf({ ref: accountRef(chainId, predicted) }),
          enforcement: Enforcement.account | Enforcement.contract,
          interveners: [{ account: G, rights: Rights.suspend | Rights.resume }],
        }),
    });
    this.cells.set(X, cell);
    k.setFact(`T1.${X}.address`, cell.address);
    this.log(`  ${X}: account ${cell.address} (owner ${cell.ownerAddress}, operator ${cell.operatorAddress})`);

    // 2. working capital: W funds the account (gas is the operator's own)
    await k.transfer(`T1.${X}.fund`, "W", cell.address, k.isLocalChain ? CELL_CAPITAL.local : CELL_CAPITAL.public);

    // 3. owner administration: operator scope, AID registry for the commitment gate, selector classes
    await cell.admin(`T1.${X}.setOperator`, "setOperator", [cell.operatorAddress, 0, parseEther("0.01")]);
    await cell.admin(`T1.${X}.setAIDRegistry`, "setAIDRegistry", [k.aid.address]);
    const tasks = k.tenders.contract().interface;
    const swarms = this.world.iface("8447/SwarmRegistry");
    const assertions = this.world.iface("8454/AUFAssertionRegistry");
    const commitment: [string, string, string][] = [
      ["8414.submitFulfillment", k.tenders.address, this.selector(tasks, "submitFulfillment")],
      ["8447.join", this.world.address("8447/SwarmRegistry"), this.selector(swarms, "join")],
      ["8447.applyToJoin", this.world.address("8447/SwarmRegistry"), this.selector(swarms, "applyToJoin")],
      ["8454.assertStatement", this.world.address("8454/AUFAssertionRegistry"), this.selector(assertions, "assertStatement")],
      ["8436.castBallot", k.acdf.registryAddress, this.selector(k.acdf.registry().interface, "castBallot")],
    ];
    for (const [name, target, sel] of commitment) await cell.admin(`T1.${X}.class.${name}`, "setCommitmentClass", [target, sel, true]);
    const derisk: [string, string, string][] = [
      ["8414.withdrawCredit", k.tenders.address, this.selector(tasks, "withdrawCredit")],
      ["8414.reclaimEscrow", k.tenders.address, this.selector(tasks, "reclaimEscrow")],
      ["8447.leave", this.world.address("8447/SwarmRegistry"), this.selector(swarms, "leave")],
      ["8471.withdrawBalance", k.adrf.escrowAddress, this.selector(k.adrf.escrow().interface, "withdrawBalance")],
    ];
    for (const [name, target, sel] of derisk) await cell.admin(`T1.${X}.derisk.${name}`, "setDeriskAllowed", [target, sel, true]);

    // 4. the safety binding: adopted by the account, presented for clause 0
    const params = { profile: "foga-cell/1", cell: X, deriskActions: derisk.map((d) => d[0]), commitmentActions: commitment.map((c) => c[0]) };
    const authority = { kind: "owner", owner: accountRef(chainId, cell.ownerAddress), guardian: accountRef(chainId, G) };
    const input = k.asf.cellBindingInput({ chainId, cell: cell.address, specId: spec.specId, version: spec.version, contentHash: spec.contentHash, guardian: G, params, authority });
    const { bindingId } = await cell.adoptBinding(`T1.${X}.adopt`, input, 0);
    k.setFact(`T1.${X}.bindingId`, bindingId);

    // 5. identity: ERC-8004 registration by the account itself
    const registration = {
      type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
      name: `FOGA cell ${X}`,
      description: `Cell ${X} of the Finch OG Agent genesis: an address acting under the ten-ERC stack`,
      services: [],
      supportedTrust: ["reputation"],
      "x-foga": { cell: X, anchor: accountRef(chainId, cell.address), binding: bindingId },
    };
    const reg = await cell.execute(`T1.${X}.8004.register`, k.identity.address, k.identity.encodeRegister(dataUri(registration)));
    const agentId = k.identity.agentIdFromReceipt(reg.receipt);
    k.setFact(`T1.${X}.agentId`, agentId.toString());

    // 6. the anchor: bind, heartbeat; the document follows the attestation so it can cite it. Where another
    //    standard's adapter reads a second ERC-8434 instance (Sepolia: the ARD agent kind is anchored to ARD's own
    //    fixture registry), the cell keeps its liveness there as well, so its records resolve as backed.
    await cell.execute(`T1.${X}.aid.bind`, k.aid.address, k.aid.encodeBind(k.identity.address, agentId));
    await cell.execute(`T1.${X}.aid.heartbeat`, k.aid.address, k.aid.encodeHeartbeat());
    if (k.aid.backing) await cell.execute(`T1.${X}.aid.backing.bind`, k.aid.backing.address, k.aid.encodeBind(k.identity.address, agentId));

    // 7. standing: W attests S_att level 2 ("bound") for the account subject
    const claim = { scheme: "S_att", level: 2, subject: accountRef(chainId, cell.address), binding: bindingId, basis: "operates under FOGA-Cell-v1 with a guardian intervener" };
    const claimDigest = keccakJcs(claim);
    const expiresAt = await k.memo(`T1.${X}.kya.expiresAt`, async () => (await this.world.blockTimestamp()) + 365 * 86400);
    const subject = accountSubject(chainId, cell.address);
    const att = await k.call(`T1.${X}.kya.attest`, "W", k.kya.registryAddress, k.kya.registry().interface, "attest", [subject, sAtt, 2, claimDigest, expiresAt, dataUriJcs(claim), claimDigest]);
    const assertionId = k.kya.assertionIdFromReceipt(att.receipt);
    k.setFact(`T1.${X}.assertionId`, assertionId);

    // 8. the AID document: identity facet (SELF) and standing facet (ATTESTED), committed by keccak(JCS)
    const doc: AIDDocument = {
      version: "aid-document/v1",
      aid: accountRef(chainId, cell.address),
      did: `did:aid:${accountRef(chainId, cell.address)}`,
      binding: { registry: k.identity.address, agentId: Number(agentId) },
      livenessWindow: Number(this.world.file.params.aid.defaultLivenessWindow),
      facets: [
        { facetType: "aid:core/identity/v1", provenance: "SELF", issuer: accountRef(chainId, cell.address), validUntil: 0, digest: keccakJcs(registration), access: { mode: "PUBLIC" }, resolver: { kind: "erc8004-identity", chainId, registry: k.identity.address, agentId: Number(agentId) } },
        { facetType: "aid:core/kya/v1", provenance: "ATTESTED", issuer: accountRef(chainId, k.address("W")), validUntil: expiresAt, digest: claimDigest, access: { mode: "PUBLIC" }, resolver: { kind: "erc8419-assertion", chainId, registry: k.kya.registryAddress, schemeId: sAtt, issuers: [k.address("W")], assertionId } },
      ],
    };
    const commitment2 = AID.documentCommitment(doc);
    await cell.execute(`T1.${X}.aid.document`, k.aid.address, k.aid.encodeSetDocumentURI(commitment2.uri, commitment2.digest));
    k.setFact(`T1.${X}.documentDigest`, commitment2.digest);

    // 9. discovery: the ARD agent record, controlled by the anchor itself
    const descriptor = agentDescriptor({
      chainId,
      anchor: cell.address,
      slug: `cell-${X.toLowerCase()}`,
      name: `FOGA cell ${X}`,
      description: registration.description,
      capabilities: ["erc8414:fulfiller", "erc8338:holder"],
      registration: { registry: `eip155:${chainId}:${k.identity.address.toLowerCase()}`, agentId: agentId.toString() },
    });
    const ard = await cell.execute(`T1.${X}.ard.register`, k.ard.address, k.ard.encodeRegister(kindId("agent"), cell.address, 0n, descriptor));
    const recordId = k.ard.recordIdFromReceipt(ard.receipt);
    k.setFact(`T1.${X}.recordId`, recordId);

    // 10. the economic boundary: the cell's unit (controller = the account)
    const unitDef = cellUnitDefinition({ chainId, cell: cell.address, name: `FOGA cell ${X}` });
    const unit = await cell.execute(`T1.${X}.auf.unit`, k.units.registryAddress, k.units.encodeRegisterUnit(cell.address, unitDef, []));
    const unitId = k.units.unitIdFromReceipt(unit.receipt);
    k.setFact(`T1.${X}.unitId`, unitId.toString());

    k.evidence("T1", X, {
      account: cell.address,
      owner: cell.ownerAddress,
      operator: cell.operatorAddress,
      guardian: G,
      requirementId: requirementIdOf(await this.requirementOf(cell)),
      bindingId,
      agentId: agentId.toString(),
      assertionId,
      documentDigest: commitment2.digest,
      recordId,
      unitId: unitId.toString(),
      capital: k.store.get(`T1.${X}.fund`)?.txHash ? (k.isLocalChain ? CELL_CAPITAL.local : CELL_CAPITAL.public).toString() : null,
      backingRegistry: k.aid.backing?.address ?? null,
      txs: { deploy: k.store.get(`T1.${X}.deploy`)?.txHash, adopt: k.store.get(`T1.${X}.adopt`)?.txHash, register8004: reg.txHash, attest: att.txHash, ard: ard.txHash, unit: unit.txHash, backingBind: k.store.get(`T1.${X}.aid.backing.bind`)?.txHash ?? null },
    });

    // checks (memo T1 "expected")
    const state = await k.aid.stateName(cell.address);
    this.check("T1", `${X}.aid.active`, state === "ACTIVE", `state(${cell.address}) = ${state}`, X === "A" ? "T9.A.aid.retire" : []);
    const passes = await k.kya.check(subject, sAtt, 2, [k.address("W")]);
    this.check("T1", `${X}.kya.level2`, passes === true, `check({account, cell}, S_att, 2, [W]) = ${passes}`);
    const status = await cell.status();
    this.check("T1", `${X}.asf.satisfied`, status.verdict === 1, `status() = ${status.verdictName} [${status.reasonNames.join(",")}]`, X === "A" ? "T7.G.suspend" : []);
    if (k.aid.backing) {
      const backingState = await k.aid.stateName(cell.address, k.aid.backing.address);
      this.check("T1", `${X}.aid.backing`, backingState === "ACTIVE", `state(${cell.address}) in the backing registry ${k.aid.backing.address} (${k.aid.backing.id}) = ${backingState}`, X === "A" ? "T9.A.aid.retire" : []);
    }
    const backed = await k.ard.backed(recordId);
    this.check("T1", `${X}.ard.backed`, backed === true, `backed(${recordId.slice(0, 10)}…) = ${backed}${k.aid.backing ? " (the ARD agent adapter reads the backing registry)" : ""}`, X === "A" ? "T9.A.aid.retire" : []);
    const controller = await k.units.controllerOf(unitId);
    this.check("T1", `${X}.auf.unit`, getAddress(controller) === getAddress(cell.address), `controllerOf(unit ${unitId}) = ${controller}`);
    const owner8004 = await k.identity.ownerOf(agentId);
    this.check("T1", `${X}.8004.owner`, getAddress(owner8004) === getAddress(cell.address), `ownerOf(agent ${agentId}) = ${owner8004}`, X === "A" ? "T9.A.8004.transfer" : []);
    if (X === "A") await (await import("./t1-zk.js")).credentialProof(this, cell);

    const reqOnchain: string = await cell.contract().requirementId();
    const reqLocal = requirementIdOf(await this.requirementOf(cell));
    this.check("T1", `${X}.requirementId`, reqOnchain === reqLocal, `account.requirementId() ${reqOnchain.slice(0, 10)}… equals keccak(abi.encode(requirement)) computed off-chain`);
    const bindingOnchain = await k.asf.computeBindingId(cell.address, input);
    this.check("T1", `${X}.bindingId`, bindingOnchain === bindingId, `computeBindingId(account, input) matches the adopted binding ${bindingId.slice(0, 10)}…`);
  }

  async requirementOf(cell: Cell) {
    const r = await cell.contract().requirement();
    return {
      combinator: Number(r.combinator),
      k: Number(r.k),
      clauses: Array.from(r.clauses, (c: any) => ({
        specRegistry: String(c.specRegistry),
        specId: String(c.specId),
        versions: Array.from(c.versions, (v: any) => Number(v)),
        adopter: String(c.adopter),
        subjectKey: String(c.subjectKey),
        scopeKey: String(c.scopeKey),
        enforcement: Number(c.enforcement),
        interveners: Array.from(c.interveners, (i: any) => ({ account: String(i.account), rights: Number(i.rights) })),
      })),
    };
  }

  // ------------------------------------------------------------------------------------------------ T2 capability

  /** T2: A packages and mints its two skills, publishes their records and units, and updates its document. */
  async t2(): Promise<void> {
    const k = this.kernel;
    const A = this.cell("A");
    const chainId = this.chainId;
    const packages: Record<string, SkillPackage> = {};
    const minted: Record<string, { tokenId: string; recordId: string; unitId: string }> = {};

    for (const name of SKILL_NAMES) {
      const dir = join(this.cfg.skillsDir, name);
      const pkg = buildSkillPackage(readSkillDir(dir));
      packages[name] = pkg;
      const packageURI = dataUriJcs({ skill: name, version: pkg.version, mdHash: pkg.mdHash, packageHash: pkg.packageHash, rootCid: pkg.rootCid, source: `scenarios/skills/${name}` });

      const mint = await A.execute(`T2.A.skill.${name}.mint`, k.skills.address, k.skills.encodeMint(A.address, A.address, pkg, packageURI));
      const tokenId = k.skills.tokenIdFromReceipt(mint.receipt);

      const descriptor = skillDescriptor({ chainId, controller: A.address, slug: name, name, description: String(pkg.manifest.summary), packageHash: pkg.packageHash, packageURI, price: { amount: name === "foga-probe" ? "0" : "0.001", currency: "ETH", asset: `eip155:${chainId}/slip44:60` } });
      const rec = await A.execute(`T2.A.skill.${name}.ard`, k.ard.address, k.ard.encodeRegister(kindId("skill"), k.skills.address, tokenId, descriptor));
      const recordId = k.ard.recordIdFromReceipt(rec.receipt);

      const unitDef = skillUnitDefinition({ chainId, skillToken: k.skills.address, tokenId, holder: A.address, name });
      const unit = await A.execute(`T2.A.skill.${name}.unit`, k.units.registryAddress, k.units.encodeRegisterUnit(A.address, unitDef, []));
      const unitId = k.units.unitIdFromReceipt(unit.receipt);

      minted[name] = { tokenId: tokenId.toString(), recordId, unitId: unitId.toString() };
      k.setFact(`T2.skill.${name}`, { tokenId: tokenId.toString(), mdHash: pkg.mdHash, packageHash: pkg.packageHash, recordId, unitId: unitId.toString() });

      const onchain = await k.skills.skillOf(tokenId);
      this.check("T2", `${name}.commitment`, onchain.packageHash === pkg.packageHash && onchain.mdHash === pkg.mdHash && onchain.version === 1n, `skillOf(${tokenId}) = {mdHash ${pkg.mdHash.slice(0, 10)}…, packageHash ${pkg.packageHash.slice(0, 10)}…, v1}`, name === "finch-extract-verify" ? "T6.A.skill.v2.update" : []);
      const owner = await k.skills.ownerOf(tokenId);
      this.check("T2", `${name}.owner`, getAddress(owner) === getAddress(A.address), `ownerOf(${tokenId}) = ${owner}`, name === "finch-extract-verify" ? "T9.A.skill.transfer" : []);
      const backed = await k.ard.backed(recordId);
      this.check("T2", `${name}.ard.backed`, backed, `backed(skill record) = ${backed}`);
    }

    // the tampered-package case: one changed byte in the primary document changes both commitments
    const tampered = { ...readSkillDir(join(this.cfg.skillsDir, "foga-probe")) };
    tampered["SKILL.md"] = new Uint8Array([...tampered["SKILL.md"], 0x0a]);
    const tp = buildSkillPackage(tampered);
    this.check("T2", "tamper.detected", tp.packageHash !== packages["foga-probe"].packageHash && tp.mdHash !== packages["foga-probe"].mdHash, `appending one byte to SKILL.md: packageHash ${tp.packageHash.slice(0, 10)}… != ${packages["foga-probe"].packageHash.slice(0, 10)}…`);

    // the document now lists the skills (facet aid:skills/erc8338/v1)
    const prior = await k.aid.documentURI(A.address);
    const expectedPrior = k.store.get("T2.A.aid.document")?.status === "confirmed" ? k.requireFact<string>("T2.A.documentDigest") : k.requireFact<string>("T1.A.documentDigest");
    this.check("T2", "A.document.prior", prior.digest === expectedPrior, `documentURI(A).digest matches the kernel's latest commitment ${expectedPrior.slice(0, 10)}…`);
    const skillsFacet = {
      facetType: "aid:skills/erc8338/v1",
      provenance: "SELF" as const,
      issuer: accountRef(chainId, A.address),
      validUntil: 0,
      digest: keccakJcs(minted),
      access: { mode: "PUBLIC" as const },
      resolver: { kind: "erc8338-skill", chainId, registry: k.skills.address, tokenIds: Object.values(minted).map((m) => m.tokenId) },
    };
    const doc = await this.documentOf(A);
    doc.facets = [...doc.facets.filter((f) => f.facetType !== "aid:skills/erc8338/v1"), skillsFacet];
    const c2 = AID.documentCommitment(doc);
    await A.execute("T2.A.aid.document", k.aid.address, k.aid.encodeSetDocumentURI(c2.uri, c2.digest));
    k.setFact("T2.A.documentDigest", c2.digest);
    const now = await k.aid.documentURI(A.address);
    this.check("T2", "A.document.updated", now.digest === c2.digest, `documentURI(A).digest = ${c2.digest.slice(0, 10)}… (skills facet added)`);

    k.evidence("T2", "skills", {
      holder: A.address,
      skills: Object.fromEntries(Object.entries(minted).map(([n, m]) => [n, { ...m, mdHash: packages[n].mdHash, packageHash: packages[n].packageHash, rootCid: packages[n].rootCid }])),
      documentDigest: c2.digest,
    });
  }

  /** Re-read a cell's AID document from the chain (data: URI) so an update builds on what is published. */
  async documentOf(cell: Cell): Promise<AIDDocument> {
    const { parseDataUri } = await import("../core/canonical.js");
    const { uri } = await this.kernel.aid.documentURI(cell.address);
    return parseDataUri(uri) as AIDDocument;
  }

  // ------------------------------------------------------------------------------------------------ T3 labour

  /**
   * T3: B tenders "the foga-probe report of C at block N" with a hashlock; A discovers it, verifies its skill
   * package against the chain, runs the probe in an isolated worker, submits, settles and is paid.
   */
  async t3(): Promise<void> {
    const k = this.kernel;
    const A = this.cell("A");
    const B = this.cell("B");
    const C = this.cell("C");
    const chainId = this.chainId;
    const sAtt = k.requireFact<{ schemeId: string }>("T0.kya.S_att").schemeId;
    const probeSkill = k.requireFact<{ tokenId: string; packageHash: string }>("T2.skill.foga-probe");
    const reward = parseEther("0.001");

    // --- B, as demander: the known answer is the probe of C at a fixed block
    const blockN = await k.memo("T3.block", () => k.blockNumber());
    // the log-based sections scan the 9 000 blocks before N (about 30 hours on a 12-second chain): public endpoints cap
    // the range of eth_getLogs, and the range is part of the committed input so both runs read the same one
    const input: ProbeInput = { subject: C.address, block: blockN, lookback: 9_000, kya: { schemeId: sAtt, issuers: [k.address("W")] } };
    const demanderRun = await runProbe(this.world, input);
    const answerHash = hashlock.answerHash(demanderRun.answer);
    k.setFact("T3.answerHash", answerHash);

    const task = {
      schema: "foga.task/1",
      skill: "foga-probe",
      packageHash: probeSkill.packageHash,
      input,
      acceptance: { mode: "verifier", profile: "x-hashlock-v1", verifier: k.tenders.hashlockAddress, answerHash },
      deliverable: "the canonical foga.probe/1 report; resultHash = sha256(report || fulfiller)",
    };
    const taskHash = sha256Hex(JSON.stringify(task));
    const taskURI = dataUri(task);
    const tdHash = keccakJcs({ td: "foga.task/1", skill: "foga-probe" });
    const settleBy = await k.memo("T3.settleBy", async () => (await this.world.blockTimestamp()) + 7 * 86400);
    const terms = nativeTerms(reward, { submitBy: BigInt(settleBy - 86400), settleBy: BigInt(settleBy) });

    const mint = await B.execute("T3.B.mint", k.tenders.address, k.tenders.encodeMint({ to: B.address, updateAuthority: B.address, acceptanceAuthority: k.tenders.hashlockAddress, tdHash, taskHash, taskURI, terms }));
    const tokenId = k.tenders.tokenIdFromReceipt(mint.receipt);
    k.setFact("T3.tokenId", tokenId.toString());
    await B.execute("T3.B.fund", k.tenders.address, k.tenders.encodeFund(tokenId, reward), { value: reward });
    await B.execute("T3.B.commit", k.tenders.hashlockAddress, k.tenders.encodeCommitAnswer(tokenId, answerHash));
    const taskDesc = taskDescriptor({
      chainId,
      demander: B.address,
      slug: `probe-c-at-${blockN}`,
      name: `foga-probe of cell C at block ${blockN}`,
      wants: "the canonical foga.probe/1 report of the subject at the stated block",
      taskHash,
      taskURI,
      bounty: { amount: "0.001", currency: "ETH", asset: `eip155:${chainId}/slip44:60` },
      acceptance: { mode: "verifier", ref: accountRef(chainId, k.tenders.hashlockAddress) },
      settleBy,
      judgmentWindow: "P7D",
    });
    const rec = await B.execute("T3.B.ard", k.ard.address, k.ard.encodeRegister(kindId("task"), k.tenders.address, tokenId, taskDesc));
    const taskRecordId = k.ard.recordIdFromReceipt(rec.receipt);
    k.setFact("T3.recordId", taskRecordId);

    // Checks on states a later operation changes are made only while that operation is still ahead of us: on a
    // resumed run the chain already shows the end state, which the end-state checks below cover.
    const submitted = k.store.get("T3.A.submit")?.status === "confirmed";
    const settled = k.store.get("T3.A.settle")?.status === "confirmed";
    if (!settled) {
      const escrow = await k.tenders.escrowBalanceOf(tokenId);
      this.check("T3", "B.escrow", escrow === reward, `escrowBalanceOf(${tokenId}) = ${escrow} wei`);
      const taskBacked = await k.ard.backed(taskRecordId);
      this.check("T3", "B.ard.backed", taskBacked, `task record backed (funded, not cancelled, before settleBy) = ${taskBacked}`);
    } else {
      this.skipped("T3", "B.escrow", "replayed run: the tender was already settled");
      this.skipped("T3", "B.ard.backed", "replayed run: the tender was already settled");
    }

    // --- A, as fulfiller: discover through ARD, pre-check, verify the package, run in isolation, submit, settle
    const found = await k.ard.recordOf(taskRecordId);
    const { parseDataUri } = await import("../core/canonical.js");
    const discovered = parseDataUri(found.descriptorURI) as any;
    const specURI: string = discovered.data.specURI;
    const spec = parseDataUri(specURI) as typeof task;
    this.check("T3", "A.discovery", spec.skill === "foga-probe" && spec.input.subject.toLowerCase() === C.address.toLowerCase(), `ARD record ${taskRecordId.slice(0, 10)}… -> task ${tokenId}: skill ${spec.skill}, subject ${spec.input.subject}, block ${spec.input.block}`);

    if (!submitted) {
      const pre = await this.precheck(A, tokenId);
      this.check("T3", "A.precheck", pre.ok, pre.detail);
      if (!pre.ok) throw new Error(`A refuses the task: ${pre.detail}`);
    } else this.skipped("T3", "A.precheck", "replayed run: the submission was already made");

    const pkg = await verifiedPackage(k, join(this.cfg.skillsDir, "foga-probe"), BigInt(probeSkill.tokenId));
    this.check("T3", "A.skill.verified", pkg.packageHash === spec.packageHash, `local package ${pkg.packageHash.slice(0, 10)}… matches token ${probeSkill.tokenId} and the task's packageHash`);

    const started = Date.now();
    const run = await runProbeIsolated({ worldPath: this.cfg.worldPath, rpc: this.cfg.rpc, bundlePath: this.cfg.bundlePath, input: spec.input });
    const resultHash = hashlock.resultHash(run.answer, A.address);
    this.check("T3", "A.answer", hashlock.answerHash(run.answer) === spec.acceptance.answerHash, `isolated run (${Date.now() - started} ms): sha256(answer) matches the committed answerHash`);
    const receiptDoc = { schema: "foga.run-receipt/1", skill: "foga-probe", packageHash: pkg.packageHash, tokenId: probeSkill.tokenId, input: spec.input, answerHash: hashlock.answerHash(run.answer), fulfiller: accountRef(chainId, A.address), worker: "isolated child process, view calls only" };
    k.setFact("T3.A.runReceipt", receiptDoc);

    const submit = await A.execute("T3.A.submit", k.tenders.address, k.tenders.encodeSubmit(tokenId, resultHash, dataUriJcs(receiptDoc)));
    const submissionId = k.tenders.submissionIdFromReceipt(submit.receipt);
    k.setFact("T3.submissionId", submissionId.toString());

    // negatives, while the submission is still pending
    if (!settled) {
      const wrong = await this.wouldRevert(A, k.tenders.address, k.tenders.encodeSettle(tokenId, submissionId, Buffer.from(run.answer + " ", "utf8")));
      this.check("T3", "wrong.answer.refused", wrong !== null && /verification failed/.test(wrong), `settling with a wrong proof reverts: ${wrong}`);
    } else this.skipped("T3", "wrong.answer.refused", "replayed run: the tender was already settled");
    const verifier = k.tenders.hashlockVerifier();
    const asA = await verifier.verifyFulfillment(k.tenders.address, tokenId, submissionId, A.address, resultHash, Buffer.from(run.answer, "utf8"));
    const asB = await verifier.verifyFulfillment(k.tenders.address, tokenId, submissionId, B.address, resultHash, Buffer.from(run.answer, "utf8"));
    this.check("T3", "copy.refused", asA === true && asB === false, `verifyFulfillment with A's resultHash: as A ${asA}, as another fulfiller ${asB} (resultHash binds the account)`);

    const balanceBefore = await A.balance();
    const settle = await A.execute("T3.A.settle", k.tenders.address, k.tenders.encodeSettle(tokenId, submissionId, Buffer.from(run.answer, "utf8")));
    const balanceAfter = await A.balance();
    const credit = await k.tenders.creditOf(tokenId, A.address);
    let withdrawTx: string | null = null;
    if (credit > 0n) {
      const w = await A.execute("T3.A.withdraw", k.tenders.address, k.tenders.encodeWithdrawCredit(tokenId, A.address));
      withdrawTx = w.txHash;
    }
    const paid = (await A.balance()) - balanceBefore;

    k.evidence("T3", "tender", {
      tokenId: tokenId.toString(),
      demander: B.address,
      fulfiller: A.address,
      subject: C.address,
      block: blockN,
      answerHash,
      resultHash,
      submissionId: submissionId.toString(),
      reward: reward.toString(),
      paidToA: paid.toString(),
      creditPath: credit > 0n ? "settlement credited; withdrawn" : "paid at settlement (the account can receive)",
      runReceipt: receiptDoc,
      txs: { mint: mint.txHash, fund: k.store.get("T3.B.fund")?.txHash, commit: k.store.get("T3.B.commit")?.txHash, ard: rec.txHash, submit: submit.txHash, settle: settle.txHash, withdraw: withdrawTx },
    });

    // checks (memo T3 "expected")
    const sub = await k.tenders.submissionOf(tokenId, submissionId);
    this.check("T3", "submission.accepted", sub.status === 1 && sub.machineSettled === true && getAddress(sub.fulfiller) === getAddress(A.address), `submissionOf(${tokenId}, ${submissionId}) = status ${sub.status} (1 = Accepted), machineSettled ${sub.machineSettled}, fulfiller ${sub.fulfiller}`);
    if (!settled) this.check("T3", "A.paid", paid === reward && balanceAfter >= balanceBefore, `A's account balance rose by ${paid} wei (reward ${reward})`);
    else this.skipped("T3", "A.paid", "replayed run: the tender was already settled");
    const count = await k.tenders.submissionCount(tokenId);
    this.check("T3", "submissions.one", count === 1n, `submissionCountOf(${tokenId}) = ${count}`);
    const escrowAfter = await k.tenders.escrowBalanceOf(tokenId);
    this.check("T3", "escrow.spent", escrowAfter === 0n, `escrowBalanceOf(${tokenId}) = ${escrowAfter} after settlement`);
    // negative: a second settlement of the same submission must fail (maxCompletions reached, not pending)
    const again = await this.wouldRevert(A, k.tenders.address, k.tenders.encodeSettle(tokenId, submissionId, Buffer.from(run.answer, "utf8")));
    this.check("T3", "settle.twice.refused", again !== null, `second settleFulfillment reverts: ${again}`);
    // negative: a second completion beyond maxCompletions is refused at submission
    const second = await this.wouldRevert(B, k.tenders.address, k.tenders.encodeSubmit(tokenId, hashlock.resultHash(run.answer, B.address), "second"));
    this.check("T3", "second.completion.refused", second !== null, `a further submission after the single completion reverts: ${second}`);

    // the predicate-pattern proof over this completion (S_pred), see t3-zk.ts
    const settledAt = await k.memo("T3.A.settledAt", async () => (await this.world.provider.getBlock(settle.receipt.blockNumber))!.timestamp);
    await (await import("./t3-zk.js")).predicateProof(this, A, { tokenId, submissionId, settledAt });
  }

  /** The kernel's pre-commitment check: liveness, safety verdict, budget, deadline. */
  async precheck(cell: Cell, tokenId: bigint): Promise<{ ok: boolean; detail: string }> {
    const k = this.kernel;
    const problems: string[] = [];
    const state = await k.aid.stateName(cell.address);
    if (state !== "ACTIVE") problems.push(`anchor ${state}`);
    const status = await cell.status();
    if (status.verdict !== 1) problems.push(`safety ${status.verdictName} [${status.reasonNames.join(",")}]`);
    const gas = await k.balance(cell.operatorAddress);
    const gasFloor = await operatorGasFloor(k, cell.roles.operator as Role);
    if (gas < gasFloor) problems.push(`operator gas ${gas} wei below the budget floor ${gasFloor} wei`);
    const terms = await k.tenders.terms(tokenId);
    const now = await this.world.blockTimestamp();
    if (terms.submitBy !== 0n && BigInt(now) > terms.submitBy) problems.push("past submitBy");
    if (terms.settleBy !== 0n && BigInt(now) > terms.settleBy) problems.push("past settleBy");
    if (await k.tenders.isCancelled(tokenId)) problems.push("tender cancelled");
    const escrow = await k.tenders.escrowBalanceOf(tokenId);
    if (escrow < terms.rewardPerCompletion) problems.push(`escrow ${escrow} below reward ${terms.rewardPerCompletion}`);
    return problems.length ? { ok: false, detail: problems.join("; ") } : { ok: true, detail: `anchor ACTIVE, safety Satisfied, operator gas ${gas} wei, escrow ${escrow} wei, deadlines open` };
  }

  /** eth_estimateGas as the cell's operator: the decoded revert reason, or null when the call would succeed. */
  async wouldRevert(cell: Cell, target: string, data: string, by: "operator" | "owner" = "operator"): Promise<string | null> {
    return this.wouldRevertCall(by === "owner" ? cell.ownerAddress : cell.operatorAddress, cell.address, cell.iface.encodeFunctionData("execute", [target, 0n, data]));
  }

  /** eth_estimateGas of an arbitrary call: the decoded revert reason, or null when it would succeed. */
  async wouldRevertCall(from: string, to: string, data: string, value = 0n): Promise<string | null> {
    try {
      await this.world.provider.estimateGas({ from, to, data, value });
      return null;
    } catch (e: any) {
      return this.kernel.tx.decoder.explain(e);
    }
  }
}

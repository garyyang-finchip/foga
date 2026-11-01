import { getAddress, parseEther } from "ethers";
import { AID, type AIDDocument } from "../core/aid.js";
import { agentDescriptor, kindId } from "../core/ard.js";
import { Enforcement, Rights, accountSubjectKey, fogaCellSpecification, oneClause, scopeKeyOf } from "../core/asf.js";
import { accountRef, dataUri, keccakJcs } from "../core/canonical.js";
import { cellUnitDefinition } from "../core/units.js";
import { operatorScope, type ScopeGroup } from "../genesis/operator-scope.js";
import { Cell } from "../kernel/cell.js";
import type { Node } from "./node.js";
import { ROLE } from "./node.js";

/** The operator scope a standalone cell starts with: identity, standing, skills, labour on both sides, services as provider. */
export const NODE_SCOPE_GROUPS: ScopeGroup[] = ["identity", "standing", "skills-provider", "labour", "demander", "service-provider"];

export interface InitOptions {
  /** Working capital the owner gives the account at birth (default 0.05 ETH on anvil, 0.005 ETH elsewhere). */
  capitalWei?: bigint;
  log?: (line: string) => void;
}

export interface InitResult {
  account: string;
  agentId: string;
  bindingId: string;
  recordId: string;
  unitId: string;
  documentDigest: string;
  specId: string;
  operations: string[];
}

/**
 * The birth of one cell from its configuration (T1 of the genesis for a single cell, design memo Phase 3 section 5):
 * the owner deploys a revision-2 account naming the operator and guardian, funds it, opens the operator's scope,
 * sets the commitment and de-risk classes, adopts the FOGA-Cell-v1 binding, and — through the account, as owner —
 * registers the ERC-8004 identity, binds and heartbeats the anchor, publishes the AID document, the ARD agent record
 * and the AUF unit. Every step is a keyed operation in the cell's own store, so a stopped init resumes. Standing
 * (KYA) is not the cell's to give itself: an issuer attests it afterwards. The config is written back with what
 * the chain decided.
 */
export async function cellInit(node: Node, opts: InitOptions = {}): Promise<InitResult> {
  const k = node.kernel;
  const cfg = node.config;
  const log = opts.log ?? node.log;
  if (!node.hasKey("owner")) throw new Error("cell init is the owner's act: load the owner key (FOGA_OWNER_KEY or FOGA_OWNER_KEY_FILE)");
  if (cfg.identity.account && k.store.get("init.deploy")?.status !== "confirmed") throw new Error(`${node.loaded.path} already names account ${cfg.identity.account}; init runs on a config without one`);
  const chainId = node.chainId;
  const owner = cfg.identity.owner;
  const operator = cfg.identity.operator;
  const guardian = cfg.identity.guardian;
  const ownerSigner = ROLE.owner;
  const operations: string[] = [];
  const done = (key: string) => operations.push(key);

  // 0. the specification the cell adopts: published by the owner when the config names none
  let spec = cfg.identity.safety;
  if (!spec.specId || !spec.contentHash) {
    const document = fogaCellSpecification();
    const salt = keccakJcs({ spec: "FOGA-Cell-v1", publisher: owner.toLowerCase() });
    const commitment = k.asf.specificationCommitment(document);
    const reg = await k.call("init.spec.register", ownerSigner, k.asf.specRegistryAddress, k.asf.specs().interface, "registerSpecification", [salt, commitment.contentHash, commitment.locator, []]);
    done("init.spec.register");
    const specId = k.asf.specIdFromReceipt(reg.receipt);
    spec = { specId, version: 1, contentHash: commitment.contentHash };
    cfg.identity.safety = spec;
    node.saveConfig();
    log(`  spec: FOGA-Cell-v1 published by the owner as ${specId}`);
  } else {
    const v = await k.asf.versionOf(spec.specId, spec.version);
    if (v.contentHash.toLowerCase() !== spec.contentHash.toLowerCase()) throw new Error(`specification ${spec.specId} v${spec.version} on chain has contentHash ${v.contentHash}, the config says ${spec.contentHash}`);
  }
  const specId = spec.specId!;
  const contentHash = spec.contentHash!;

  // 1. the body: deployed by the owner; the requirement names the account itself
  const safety = k.asf.bindingRegistryAddress;
  const recovery = cfg.identity.recovery ?? owner;
  const requirement = (predicted: string) =>
    oneClause({ specRegistry: k.asf.specRegistryAddress, specId, versions: [spec.version], adopter: predicted, subjectKey: accountSubjectKey(chainId, predicted), scopeKey: scopeKeyOf({ ref: accountRef(chainId, predicted) }), enforcement: Enforcement.account | Enforcement.contract, interveners: [{ account: guardian, rights: Rights.suspend | Rights.resume }] });
  let predictedFor: string | null = null;
  const { address } = await k.deploy("init.deploy", ownerSigner, "foga:FogaCellAccount", [], (predicted) => {
    predictedFor = predicted;
    return [safety, owner, operator, guardian, recovery, requirement(predicted)];
  });
  done("init.deploy");
  if (predictedFor && (predictedFor as string).toLowerCase() !== address.toLowerCase()) throw new Error(`deployed at ${address} but the requirement was built for ${predictedFor}; the owner's nonce moved between prediction and inclusion`);
  const cell = new Cell(k, cfg.name, address, { owner: ROLE.owner, operator: ROLE.operator, guardian, recovery });
  cfg.identity.account = getAddress(address);
  node.saveConfig();
  k.store.setMeta("cellAccount", address);
  log(`  account: ${address} (owner ${owner}, operator ${operator}, guardian ${guardian})`);

  // 2. working capital from the owner
  const capital = opts.capitalWei ?? (k.isLocalChain ? parseEther("0.05") : parseEther("0.005"));
  if (capital > 0n) {
    await k.transfer("init.fund", ownerSigner, address, capital);
    done("init.fund");
  }

  // 3. owner administration: the operator's key, scope and daily cap, the AID registry, the selector classes
  await cell.admin("init.setOperator", "setOperator", [operator, 0, BigInt(cfg.policy.budget.dailyValueWei)]);
  done("init.setOperator");
  const scope = operatorScope(k, NODE_SCOPE_GROUPS);
  await cell.admin("init.scope", "setOperatorAllowedBatch", [scope.targets, scope.selectors, true]);
  done("init.scope");
  k.setFact("init.scope", { groups: NODE_SCOPE_GROUPS, entries: scope.names });
  await cell.admin("init.setAIDRegistry", "setAIDRegistry", [k.aid.address]);
  done("init.setAIDRegistry");
  const sel = (id: string, fn: string) => node.world.iface(id).getFunction(fn)!.selector;
  const commitment: [string, string, string][] = [
    ["8414.submitFulfillment", k.tenders.address, sel("8414/TaskToken", "submitFulfillment")],
    ["8447.join", node.world.address("8447/SwarmRegistry"), sel("8447/SwarmRegistry", "join")],
    ["8447.applyToJoin", node.world.address("8447/SwarmRegistry"), sel("8447/SwarmRegistry", "applyToJoin")],
    ["8454.assertStatement", node.world.address("8454/AUFAssertionRegistry"), sel("8454/AUFAssertionRegistry", "assertStatement")],
    ["8436.castBallot", k.acdf.registryAddress, sel("8436/ACDFRegistry", "castBallot")],
  ];
  for (const [name, target, selector] of commitment) {
    await cell.admin(`init.class.${name}`, "setCommitmentClass", [target, selector, true]);
    done(`init.class.${name}`);
  }
  const derisk: [string, string, string][] = [
    ["8414.withdrawCredit", k.tenders.address, sel("8414/TaskToken", "withdrawCredit")],
    ["8414.reclaimEscrow", k.tenders.address, sel("8414/TaskToken", "reclaimEscrow")],
    ["8447.leave", node.world.address("8447/SwarmRegistry"), sel("8447/SwarmRegistry", "leave")],
    ["8471.withdrawBalance", k.adrf.escrowAddress, sel("8471/ADRFServiceEscrow", "withdrawBalance")],
  ];
  for (const [name, target, selector] of derisk) {
    await cell.admin(`init.derisk.${name}`, "setDeriskAllowed", [target, selector, true]);
    done(`init.derisk.${name}`);
  }

  // 4. the safety binding, adopted by the account and presented for clause 0
  const params = { profile: "foga-cell/1", cell: cfg.name, operatorScope: NODE_SCOPE_GROUPS, deriskActions: derisk.map((d) => d[0]), commitmentActions: commitment.map((c) => c[0]) };
  const authority = { kind: "owner", owner: accountRef(chainId, owner), guardian: accountRef(chainId, guardian) };
  const input = k.asf.cellBindingInput({ chainId, cell: address, specId, version: spec.version, contentHash, guardian, params, authority });
  const { bindingId } = await cell.adoptBinding("init.adopt", input, 0);
  done("init.adopt");
  cfg.identity.bindingId = bindingId;
  node.saveConfig();

  // 5. identity: the ERC-8004 registration, made by the account (the owner executes; the operator's scope is for later)
  const registration = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: cfg.presence.name,
    description: cfg.presence.description,
    image: cfg.presence.image,
    services: [
      ...(cfg.presence.endpoints.mcp ? [{ name: "MCP", endpoint: cfg.presence.endpoints.mcp, version: "2026-07-28" }] : []),
      ...(cfg.presence.endpoints.a2a ? [{ name: "A2A", endpoint: cfg.presence.endpoints.a2a, version: "1.0" }] : []),
      ...(cfg.presence.endpoints.web ? [{ name: "web", endpoint: cfg.presence.endpoints.web }] : []),
    ],
    x402Support: false,
    active: true,
    supportedTrust: ["reputation"],
    "x-foga": { cell: cfg.name, anchor: accountRef(chainId, address), binding: bindingId },
  };
  const reg = await cell.execute("init.8004.register", k.identity.address, k.identity.encodeRegister(dataUri(registration)), { by: "owner" });
  done("init.8004.register");
  const agentId = k.identity.agentIdFromReceipt(reg.receipt);
  cfg.identity.agentId = agentId.toString();
  node.saveConfig();

  // 6. the anchor: bind and heartbeat in the reference registry, bind in the backing registry where there is one
  await cell.execute("init.aid.bind", k.aid.address, k.aid.encodeBind(k.identity.address, agentId), { by: "owner" });
  done("init.aid.bind");
  await cell.execute("init.aid.heartbeat", k.aid.address, k.aid.encodeHeartbeat(), { by: "owner" });
  done("init.aid.heartbeat");
  if (k.aid.backing) {
    await cell.execute("init.aid.backing.bind", k.aid.backing.address, k.aid.encodeBind(k.identity.address, agentId), { by: "owner" });
    done("init.aid.backing.bind");
  }
  if (cfg.identity.livenessWindow) {
    await cell.execute("init.aid.window", k.aid.address, k.aid.encodeSetLivenessWindow(cfg.identity.livenessWindow), { by: "owner" });
    done("init.aid.window");
  }

  // 7. the AID document: the identity facet (SELF); standing and skills facets follow when they exist
  const doc: AIDDocument = {
    version: "aid-document/v1",
    aid: accountRef(chainId, address),
    did: `did:aid:${accountRef(chainId, address)}`,
    binding: { registry: k.identity.address, agentId: Number(agentId) },
    livenessWindow: cfg.identity.livenessWindow ?? Number(node.world.file.params.aid.defaultLivenessWindow),
    facets: [{ facetType: "aid:core/identity/v1", provenance: "SELF", issuer: accountRef(chainId, address), validUntil: 0, digest: keccakJcs(registration), access: { mode: "PUBLIC" }, resolver: { kind: "erc8004-identity", chainId, registry: k.identity.address, agentId: Number(agentId) } }],
  };
  const commitment2 = AID.documentCommitment(doc);
  await cell.execute("init.aid.document", k.aid.address, k.aid.encodeSetDocumentURI(commitment2.uri, commitment2.digest), { by: "owner" });
  done("init.aid.document");
  cfg.identity.documentDigest = commitment2.digest;

  // 8. discovery: the ARD agent record, controlled by the anchor itself
  const descriptor = agentDescriptor({ chainId, anchor: address, slug: `cell-${cfg.name.toLowerCase()}`, name: cfg.presence.name, description: cfg.presence.description, url: cfg.presence.homepage, capabilities: ["erc8414:fulfiller", "erc8338:holder"], registration: { registry: `eip155:${chainId}:${k.identity.address.toLowerCase()}`, agentId: agentId.toString() } });
  const ard = await cell.execute("init.ard.register", k.ard.address, k.ard.encodeRegister(kindId("agent"), address, 0n, descriptor), { by: "owner" });
  done("init.ard.register");
  const recordId = k.ard.recordIdFromReceipt(ard.receipt);
  cfg.identity.recordId = recordId;

  // 9. the economic boundary: the cell's unit
  const unitDef = cellUnitDefinition({ chainId, cell: address, name: cfg.presence.name });
  const unit = await cell.execute("init.auf.unit", k.units.registryAddress, k.units.encodeRegisterUnit(address, unitDef, []), { by: "owner" });
  done("init.auf.unit");
  const unitId = k.units.unitIdFromReceipt(unit.receipt);
  cfg.identity.unitId = unitId.toString();
  node.saveConfig();

  k.evidence("init", cfg.name, { account: address, owner, operator, guardian, specId, bindingId, agentId: agentId.toString(), recordId, unitId: unitId.toString(), documentDigest: commitment2.digest, scope: scope.names, capital: capital.toString() });
  const state = await k.aid.stateName(address);
  const status = await cell.status();
  log(`  born: agent ${agentId}, anchor ${state}, binding ${status.verdictName}, record ${recordId.slice(0, 10)}…, unit ${unitId}`);
  if (state !== "ACTIVE" || status.verdictName !== "Satisfied") throw new Error(`the cell was born but is not ready: anchor ${state}, binding ${status.verdictName} [${status.reasonNames.join(",")}]`);
  return { account: address, agentId: agentId.toString(), bindingId, recordId, unitId: unitId.toString(), documentDigest: commitment2.digest, specId, operations };
}

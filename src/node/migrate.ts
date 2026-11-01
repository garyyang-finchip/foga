import { getAddress, parseEther } from "ethers";
import { AID, type AIDDocument } from "../core/aid.js";
import { agentDescriptor, kindId } from "../core/ard.js";
import { Enforcement, Rights, accountSubjectKey, oneClause, scopeKeyOf } from "../core/asf.js";
import { accountRef, keccakJcs } from "../core/canonical.js";
import { cellUnitDefinition } from "../core/units.js";
import { operatorScope } from "../genesis/operator-scope.js";
import { Cell } from "../kernel/cell.js";
import { saveCellConfig, type CellConfig } from "./config.js";
import { NODE_SCOPE_GROUPS } from "./init.js";
import { ROLE, type Node } from "./node.js";

export interface MigrateOptions {
  /** The operator of the new account (a fresh key is the point of a migration after a compromise; the same one otherwise). */
  operator?: string;
  /** Where the new cell's config is written; its store is a new file beside it. */
  toConfigPath: string;
  toStorePath: string;
  /** Working capital the owner gives the new account (default 0.01 ETH on anvil, 0.002 ETH elsewhere). */
  capitalWei?: bigint;
  /** Move the old account's native balance to the owner first (sweep), so nothing is left in the retired body. */
  sweep?: boolean;
  log?: (line: string) => void;
}

export interface MigrateResult {
  from: string;
  to: string;
  agentId: string;
  bindingId: string;
  recordId: string;
  unitId: string;
  skills: string[];
  operations: string[];
  configPath: string;
}

/**
 * Move a cell to a new account, the way T9 moves A to A-prime (design memo, Phase 3: the OG instance leaves its
 * revision-1 body for a revision-2 one and keeps its identity line). The owner deploys the new account, configures
 * it, adopts a binding for it, moves the ERC-8004 agent through the old account (an asset: the owner's act), binds
 * the anchor in the new account (the takeover), retires the old anchor naming its successor, publishes the new
 * record, document and unit, and moves the skill tokens, recommitting their records. Every step is a keyed
 * operation in the old cell's store; the new cell starts with a config and a fresh store of its own.
 */
export async function cellMigrate(node: Node, opts: MigrateOptions): Promise<MigrateResult> {
  const k = node.kernel;
  const cfg = node.config;
  const log = opts.log ?? node.log;
  if (!node.hasKey("owner")) throw new Error("cell migrate is the owner's act: load the owner key (FOGA_OWNER_KEY or FOGA_OWNER_KEY_FILE)");
  const old = node.body;
  const chainId = node.chainId;
  const owner = cfg.identity.owner;
  const guardian = cfg.identity.guardian;
  const operator = getAddress(opts.operator ?? cfg.identity.operator);
  const agentId = BigInt(cfg.identity.agentId ?? (() => { throw new Error("the config names no agentId"); })());
  const spec = cfg.identity.safety;
  if (!spec.specId || !spec.contentHash) throw new Error("the config names no specification (identity.safety.specId/contentHash)");
  const P = `migrate.${agentId}`;
  const operations: string[] = [];
  const op = (key: string) => operations.push(key);

  // 1. the new body
  const requirement = (predicted: string) =>
    oneClause({ specRegistry: k.asf.specRegistryAddress, specId: spec.specId!, versions: [spec.version], adopter: predicted, subjectKey: accountSubjectKey(chainId, predicted), scopeKey: scopeKeyOf({ ref: accountRef(chainId, predicted) }), enforcement: Enforcement.account | Enforcement.contract, interveners: [{ account: guardian, rights: Rights.suspend | Rights.resume }] });
  let predictedFor: string | null = null;
  const { address } = await k.deploy(`${P}.deploy`, ROLE.owner, "foga:FogaCellAccount", [], (predicted) => {
    predictedFor = predicted;
    return [k.asf.bindingRegistryAddress, owner, operator, guardian, cfg.identity.recovery ?? owner, requirement(predicted)];
  });
  op(`${P}.deploy`);
  if (predictedFor && (predictedFor as string).toLowerCase() !== address.toLowerCase()) throw new Error(`deployed at ${address} but the requirement was built for ${predictedFor}`);
  const next = new Cell(k, `${cfg.name}-next`, address, { owner: ROLE.owner, operator: ROLE.operator, guardian, recovery: cfg.identity.recovery });
  log(`  successor: account ${address} (operator ${operator})`);

  // 2. funds: sweep the old body to the owner, give the new one its capital
  if (opts.sweep ?? true) {
    const balance = await old.balance();
    if (balance > 0n || k.store.get(`${P}.sweep`)) {
      await old.admin(`${P}.sweep`, "sweep", ["0x0000000000000000000000000000000000000000", await k.memo(`${P}.sweep.amount`, () => balance.toString()).then(BigInt)]);
      op(`${P}.sweep`);
    }
  }
  const capital = opts.capitalWei ?? (k.isLocalChain ? parseEther("0.01") : parseEther("0.002"));
  if (capital > 0n) {
    await k.transfer(`${P}.fund`, ROLE.owner, address, capital);
    op(`${P}.fund`);
  }

  // 3. configuration of the new account (as init does)
  await next.admin(`${P}.setOperator`, "setOperator", [operator, 0, BigInt(cfg.policy.budget.dailyValueWei)]);
  op(`${P}.setOperator`);
  const scope = operatorScope(k, NODE_SCOPE_GROUPS);
  await next.admin(`${P}.scope`, "setOperatorAllowedBatch", [scope.targets, scope.selectors, true]);
  op(`${P}.scope`);
  await next.admin(`${P}.setAIDRegistry`, "setAIDRegistry", [k.aid.address]);
  op(`${P}.setAIDRegistry`);
  const sel = (id: string, fn: string) => node.world.iface(id).getFunction(fn)!.selector;
  const classes: [string, string, string, "setCommitmentClass" | "setDeriskAllowed"][] = [
    ["class.8414.submitFulfillment", k.tenders.address, sel("8414/TaskToken", "submitFulfillment"), "setCommitmentClass"],
    ["class.8447.join", node.world.address("8447/SwarmRegistry"), sel("8447/SwarmRegistry", "join"), "setCommitmentClass"],
    ["class.8447.applyToJoin", node.world.address("8447/SwarmRegistry"), sel("8447/SwarmRegistry", "applyToJoin"), "setCommitmentClass"],
    ["class.8454.assertStatement", node.world.address("8454/AUFAssertionRegistry"), sel("8454/AUFAssertionRegistry", "assertStatement"), "setCommitmentClass"],
    ["class.8436.castBallot", k.acdf.registryAddress, sel("8436/ACDFRegistry", "castBallot"), "setCommitmentClass"],
    ["derisk.8414.withdrawCredit", k.tenders.address, sel("8414/TaskToken", "withdrawCredit"), "setDeriskAllowed"],
    ["derisk.8414.reclaimEscrow", k.tenders.address, sel("8414/TaskToken", "reclaimEscrow"), "setDeriskAllowed"],
    ["derisk.8447.leave", node.world.address("8447/SwarmRegistry"), sel("8447/SwarmRegistry", "leave"), "setDeriskAllowed"],
    ["derisk.8471.withdrawBalance", k.adrf.escrowAddress, sel("8471/ADRFServiceEscrow", "withdrawBalance"), "setDeriskAllowed"],
  ];
  for (const [name, target, selector, fn] of classes) {
    await next.admin(`${P}.${name}`, fn, [target, selector, true]);
    op(`${P}.${name}`);
  }

  // 4. the successor's own binding
  const params = { profile: "foga-cell/1", cell: cfg.name, successorOf: accountRef(chainId, old.address), operatorScope: NODE_SCOPE_GROUPS };
  const authority = { kind: "owner", owner: accountRef(chainId, owner), guardian: accountRef(chainId, guardian) };
  const input = k.asf.cellBindingInput({ chainId, cell: address, specId: spec.specId, version: spec.version, contentHash: spec.contentHash, guardian, params, authority });
  const { bindingId } = await next.adoptBinding(`${P}.adopt`, input, 0);
  op(`${P}.adopt`);

  // 5. the identity moves through the old account: the owner's act (an asset leaves the cell)
  await old.execute(`${P}.8004.transfer`, k.identity.address, k.identity.encodeTransfer(old.address, address, agentId), { by: "owner" });
  op(`${P}.8004.transfer`);

  // 6. the takeover: the new anchor binds the agent in every registry; the old one retires naming its successor
  const bindCall = k.aid.encodeBind(k.identity.address, agentId);
  await next.execute(`${P}.aid.bind`, k.aid.address, bindCall, { by: "owner" });
  op(`${P}.aid.bind`);
  await next.execute(`${P}.aid.heartbeat`, k.aid.address, k.aid.encodeHeartbeat(), { by: "owner" });
  op(`${P}.aid.heartbeat`);
  if (k.aid.backing) {
    await next.execute(`${P}.aid.backing.bind`, k.aid.backing.address, bindCall, { by: "owner" });
    op(`${P}.aid.backing.bind`);
  }
  await old.execute(`${P}.aid.retire`, k.aid.address, k.aid.encodeRetire(address), { by: "owner" });
  op(`${P}.aid.retire`);
  if (k.aid.backing) {
    await old.execute(`${P}.aid.backing.retire`, k.aid.backing.address, k.aid.encodeRetire(address), { by: "owner" });
    op(`${P}.aid.backing.retire`);
  }

  // 7. the new record and document
  const registration = {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: cfg.presence.name,
    description: cfg.presence.description,
    services: [],
    x402Support: false,
    active: true,
    supportedTrust: ["reputation"],
    "x-foga": { cell: cfg.name, anchor: accountRef(chainId, address), predecessor: accountRef(chainId, old.address), binding: bindingId },
  };
  const descriptor = agentDescriptor({ chainId, anchor: address, slug: `cell-${cfg.name.toLowerCase()}`, name: cfg.presence.name, description: cfg.presence.description, url: cfg.presence.homepage, capabilities: ["erc8414:fulfiller", "erc8338:holder"], registration: { registry: `eip155:${chainId}:${k.identity.address.toLowerCase()}`, agentId: agentId.toString() } });
  const ard = await next.execute(`${P}.ard.register`, k.ard.address, k.ard.encodeRegister(kindId("agent"), address, 0n, descriptor), { by: "owner" });
  op(`${P}.ard.register`);
  const recordId = k.ard.recordIdFromReceipt(ard.receipt);
  const doc: AIDDocument = {
    version: "aid-document/v1",
    aid: accountRef(chainId, address),
    did: `did:aid:${accountRef(chainId, address)}`,
    binding: { registry: k.identity.address, agentId: Number(agentId) },
    livenessWindow: cfg.identity.livenessWindow ?? Number(node.world.file.params.aid.defaultLivenessWindow),
    facets: [{ facetType: "aid:core/identity/v1", provenance: "SELF", issuer: accountRef(chainId, address), validUntil: 0, digest: keccakJcs(registration), access: { mode: "PUBLIC" }, resolver: { kind: "erc8004-identity", chainId, registry: k.identity.address, agentId: Number(agentId) } }],
  };
  const commitment = AID.documentCommitment(doc);
  await next.execute(`${P}.aid.document`, k.aid.address, k.aid.encodeSetDocumentURI(commitment.uri, commitment.digest), { by: "owner" });
  op(`${P}.aid.document`);
  // the registration file stays the one the agent carries; setAgentURI to a served URL is the documents step (3d)

  // 8. the skills follow: each token moves through the old account (owner), each record is recommitted by the new controller
  const skills: string[] = [];
  for (const [name, h] of Object.entries(cfg.skills.held)) {
    const tokenId = BigInt(h.tokenId);
    const holder = await k.skills.ownerOf(tokenId);
    if (getAddress(holder) === getAddress(old.address)) {
      await old.execute(`${P}.skill.${name}.transfer`, k.skills.address, k.skills.encodeSafeTransfer(old.address, address, tokenId), { by: "owner" });
      op(`${P}.skill.${name}.transfer`);
    }
    const recordId = h.recordId ?? k.ard.recordIdOf(k.skills.address, tokenId);
    const rec = await k.ard.recordOf(recordId);
    if (rec.kind !== "0x" + "00".repeat(32)) {
      await next.execute(`${P}.skill.${name}.adopt`, k.ard.address, k.ard.encodeRecommit(recordId, { descriptorHash: rec.descriptorHash, descriptorURI: rec.descriptorURI, urn: rec.urn }), { by: "owner" });
      op(`${P}.skill.${name}.adopt`);
    }
    skills.push(name);
  }

  // 9. the successor's own unit (the old unit stays the old body's)
  const unit = await next.execute(`${P}.auf.unit`, k.units.registryAddress, k.units.encodeRegisterUnit(address, cellUnitDefinition({ chainId, cell: address, name: cfg.presence.name }), []), { by: "owner" });
  op(`${P}.auf.unit`);
  const unitId = k.units.unitIdFromReceipt(unit.receipt);

  // the new config: the same cell, a new body, a fresh store
  const nextCfg: CellConfig = JSON.parse(JSON.stringify(cfg));
  nextCfg.store = opts.toStorePath;
  nextCfg.identity = { ...cfg.identity, account: getAddress(address), operator, bindingId, recordId, unitId: unitId.toString(), documentDigest: commitment.digest };
  nextCfg.skills.held = Object.fromEntries(Object.entries(cfg.skills.held).map(([n, h]) => [n, { tokenId: h.tokenId, recordId: h.recordId, packageHash: h.packageHash }]));
  saveCellConfig(opts.toConfigPath, nextCfg);
  k.setFact(`${P}.successor`, { account: address, config: opts.toConfigPath });
  k.evidence("migrate", cfg.name, { from: old.address, to: address, agentId: agentId.toString(), operator, bindingId, recordId, unitId: unitId.toString(), skills, operations });

  const [oldState, newState, holder] = await Promise.all([k.aid.stateName(old.address), k.aid.stateName(address), k.identity.ownerOf(agentId)]);
  log(`  moved: agent ${agentId} held by ${holder}; old anchor ${oldState}, new anchor ${newState}; config ${opts.toConfigPath}`);
  if (oldState !== "RETIRED" || newState !== "ACTIVE" || getAddress(holder) !== getAddress(address)) throw new Error(`the move is incomplete: old ${oldState}, new ${newState}, agent held by ${holder}`);
  return { from: old.address, to: address, agentId: agentId.toString(), bindingId, recordId, unitId: unitId.toString(), skills, operations, configPath: opts.toConfigPath };
}

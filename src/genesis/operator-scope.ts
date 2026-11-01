import { Interface } from "ethers";
import { ERC8004_ABI } from "../core/erc8004.js";
import type { Kernel } from "../kernel/kernel.js";
import type { CellName } from "./roles.js";

/**
 * What a cell's operator may call through its account (FogaCellAccount revision 2: `operatorAllowed`, target x
 * selector). The scope is declared in groups named after what the cell does, so a cell's allow-list reads as a
 * list of roles and the policy engine of the node (Phase 3) speaks the same vocabulary. Asset-moving selectors
 * (transfers, approvals) are not in any group: the account refuses them to the operator by construction, and the
 * owner performs them (T9).
 *
 * The groups were taken from a recording of every `execute` the genesis makes through the operator (0.5.0) and
 * are kept in step with it by the genesis itself: a call outside the scope reverts with `OperatorNotAllowed`.
 */
export type ScopeGroup = "identity" | "standing" | "skills-provider" | "labour" | "demander" | "organization-member" | "organization-coordinator" | "service-provider" | "service-client";

/** A world contract id (or a bundle key for interfaces the world entry does not expose) and a function name. */
export interface ScopeEntry {
  contract: string;
  fn: string;
  /** `iface` names a bundle key whose ABI holds the function when the world entry's ABI does not (a router). */
  iface?: string;
  /** `abi` gives the ABI outright for a contract the bundle does not build (the official ERC-8004 registry on a public chain). */
  abi?: readonly string[];
}

export const SCOPE_GROUPS: Record<ScopeGroup, ScopeEntry[]> = {
  identity: [
    { contract: "identity8004", fn: "register(string)", abi: ERC8004_ABI },
    { contract: "identity8004", fn: "setAgentURI(uint256,string)", abi: ERC8004_ABI },
    { contract: "8434/AIDRegistry", fn: "bind(address,uint256)" },
    { contract: "8434/AIDRegistry", fn: "heartbeat()" },
    { contract: "8434/AIDRegistry", fn: "setDocumentURI(string,bytes32)" },
    { contract: "8434/AIDRegistry", fn: "setLivenessWindow(uint64)" },
    { contract: "8434/AIDRegistry", fn: "retire(address)" },
    { contract: "8444/ARDOnchainRegistry", fn: "register(bytes32,address,uint256,bytes32,string,string)" },
    { contract: "8444/ARDOnchainRegistry", fn: "updateDescriptor(bytes32,bytes32,string,string)" },
    { contract: "8454/AUFUnitRegistry", fn: "registerUnit(address,bytes32,string,(uint256,uint32)[])" },
    { contract: "8447/ERC8004Eligibility", fn: "declareAgent(uint256)" },
  ],
  standing: [{ contract: "8419/KYARegistry", fn: "attestWithProof((bytes32,bytes),bytes32,bytes,bytes,string)" }],
  "skills-provider": [
    { contract: "8338/SkillToken", fn: "mintSkill(address,address,bytes32,bytes32,string)" },
    { contract: "8338/SkillToken", fn: "updateSkill(uint256,bytes32,bytes32)" },
  ],
  labour: [
    { contract: "8414/TaskToken", fn: "submitFulfillment(uint256,bytes32,string)" },
    { contract: "8414/TaskToken", fn: "settleFulfillment(uint256,uint256,bytes)" },
    { contract: "8414/TaskToken", fn: "withdrawCredit" },
  ],
  demander: [
    { contract: "8414/TaskToken", fn: "mintTask" },
    { contract: "8414/TaskToken", fn: "fundTask(uint256,uint256)" },
    { contract: "8414/TaskToken", fn: "reclaimEscrow" },
    { contract: "8414/HashlockVerifier", fn: "commitAnswer(address,uint256,bytes32)" },
  ],
  "organization-member": [
    { contract: "8447/SwarmRegistry", fn: "join(bytes32,bytes32,bytes32)" },
    { contract: "8447/SwarmRegistry", fn: "applyToJoin" },
    { contract: "8447/SwarmRegistry", fn: "leave" },
    { contract: "8436/ACDFRegistry", fn: "castBallot(bytes32,uint32,uint32,bool)" },
  ],
  "organization-coordinator": [
    { contract: "8447/SwarmRegistry", fn: "form" },
    { contract: "8447/SwarmRegistry", fn: "setAccount(bytes32,address)" },
    // the swarm's account and the decision adapter are deployed in T4 and opened to the coordinator then (dynamic entries)
  ],
  "service-provider": [
    { contract: "8471/ADRFServiceEscrow", fn: "deliver(uint256,bytes32)" },
    { contract: "8471/ADRFServiceEscrow", fn: "settle(uint256)" },
    { contract: "8471/ADRFServiceEscrow", fn: "withdrawBalance(uint256)" },
  ],
  "service-client": [
    { contract: "8471/ADRFServiceEscrow", fn: "deposit()" },
    { contract: "8471/ADRFServiceEscrow", fn: "openCall(address,uint256,bytes32,bytes32,uint64)" },
    { contract: "8471/ADRFServiceEscrow", fn: "withdrawBalance(uint256)" },
    { contract: "8471/ADRFServiceEscrow", fn: "enact(bytes32,bytes32)" },
    { contract: "8471/ADRFDisputeRegistry", fn: "file", iface: "ai-dispute-resolution:IADRFDisputeRegistry" },
  ],
};

/** The groups each genesis cell plays. A-prime (T9) takes the successor's groups: identity and what it inherits by adoption. */
export const CELL_GROUPS: Record<CellName | "A-prime", ScopeGroup[]> = {
  A: ["identity", "standing", "skills-provider", "labour", "organization-member", "service-provider"],
  B: ["identity", "demander", "organization-coordinator", "organization-member"],
  C: ["identity", "organization-member", "service-client"],
  "A-prime": ["identity", "skills-provider", "labour", "service-provider"],
};

export interface ScopeList {
  targets: string[];
  selectors: string[];
  /** `<contract>.<fn>` per entry, for the record. */
  names: string[];
}

/** Resolve groups to (target, selector) pairs on this world; the backing AID registry mirrors the primary one's entries. */
export function operatorScope(k: Kernel, groups: ScopeGroup[]): ScopeList {
  const out: ScopeList = { targets: [], selectors: [], names: [] };
  const seen = new Set<string>();
  const add = (target: string, selector: string, name: string) => {
    const id = `${target.toLowerCase()}:${selector}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.targets.push(target);
    out.selectors.push(selector);
    out.names.push(name);
  };
  for (const group of groups) {
    for (const e of SCOPE_GROUPS[group]) {
      const target = k.world.address(e.contract);
      const iface: Interface = e.abi ? new Interface(e.abi as string[]) : e.iface ? k.world.ifaceOf(e.iface) : k.world.iface(e.contract);
      const f = iface.getFunction(e.fn);
      if (!f) throw new Error(`operator scope: ${e.contract} has no function ${e.fn}`);
      add(target, f.selector, `${e.contract}.${e.fn}`);
      if (e.contract === "8434/AIDRegistry" && k.aid.backing) add(k.aid.backing.address, f.selector, `${k.aid.backing.id}.${e.fn}`);
    }
  }
  return out;
}

import type { Bundle } from "../bundle/types.js";
import type { WorldConfig, WorldFile } from "./types.js";

/**
 * The deployment plan of a FOGA world: every reference registry of the ten ERCs plus the pieces a
 * world needs before any cell exists. Scenario-dependent components (policies, schemes, specifications,
 * eligibility modules that need a scheme id, adapters bound to a policy, per-cell accounts) are NOT part
 * of the world; the genesis runner creates them in T0/T1.
 *
 * Step ids are `<erc>/<ContractName>`; libraries are linked automatically by name within a repo.
 */
export interface DeployStep {
  id: string;
  bundleKey: string;
  /** Constructor arguments, computed once every previous step is known. */
  args: (ctx: PlanContext) => unknown[];
  /** Skip the step entirely (recorded as "skipped") when it returns a reason. */
  skip?: (ctx: PlanContext) => string | null;
  note?: string;
}

export interface WireStep {
  id: string;
  /** Returns a list of transactions to send, each as a contract call description. */
  calls: (ctx: PlanContext) => { stepId: string; fn: string; args: unknown[]; note?: string }[];
  skip?: (ctx: PlanContext) => string | null;
}

export interface PlanContext {
  config: WorldConfig;
  bundle: Bundle;
  world: WorldFile;
  deployer: string;
  addr: (stepId: string) => string;
}

export const DEPLOY_PLAN: DeployStep[] = [
  {
    id: "identity8004",
    bundleKey: "foga:Identity8004Stub",
    args: () => [],
    skip: (ctx) => (ctx.config.identity8004.mode === "address" ? "attached to an existing ERC-8004 Identity Registry" : null),
    note: "LOCAL stand-in for the ERC-8004 Identity Registry; public worlds attach the official registry instead",
  },

  { id: "8338/SkillToken", bundleKey: "skill-token-standard:SkillToken", args: (c) => [c.config.params.skillToken.name, c.config.params.skillToken.symbol] },

  { id: "8414/TaskToken", bundleKey: "task-token-standard:TaskToken", args: (c) => [c.config.params.taskToken.name, c.config.params.taskToken.symbol] },
  { id: "8414/HashlockVerifier", bundleKey: "task-token-standard:HashlockVerifier", args: () => [] },

  { id: "8419/KYASchemeRegistry", bundleKey: "kya-standard:KYASchemeRegistry", args: () => [] },
  { id: "8419/KYARegistry", bundleKey: "kya-standard:KYARegistry", args: (c) => [c.addr("8419/KYASchemeRegistry")] },
  { id: "8419/KYAPolicyRegistry", bundleKey: "kya-standard:KYAPolicyRegistry", args: (c) => [c.addr("8419/KYARegistry")] },
  { id: "8419/ValidationRegistry8004", bundleKey: "kya-standard:ValidationRegistry8004", args: (c) => [c.addr("identity8004")], note: "spec-conforming ERC-8004 Validation Registry companion from kya-standard, bound to the world's identity registry" },
  { id: "8419/KYABridge8004", bundleKey: "kya-standard:KYABridge8004", args: (c) => [c.addr("8419/KYARegistry"), c.addr("8419/ValidationRegistry8004"), c.deployer] },
  { id: "8419/Groth16Verifier", bundleKey: "kya-standard:Groth16Verifier", args: () => [], note: "credential-pattern ZK-KYA verifier (kya_public_v1 circuit)" },
  { id: "8419/Groth16KYAVerifierAdapter", bundleKey: "kya-standard:Groth16KYAVerifierAdapter", args: (c) => [c.addr("8419/Groth16Verifier"), c.config.params.kya.issuerSetRoot, c.config.params.kya.epochLength, c.config.params.kya.epochGrace] },

  { id: "8434/AIDRegistry", bundleKey: "aid-standard:AIDRegistry", args: (c) => [c.config.params.aid.defaultLivenessWindow, c.config.params.aid.maxLivenessWindow] },

  { id: "8436/ACDFPolicyRegistry", bundleKey: "acd-framework:ACDFPolicyRegistry", args: () => [] },
  { id: "8436/ACDFRegistry", bundleKey: "acd-framework:ACDFRegistry", args: (c) => [c.addr("8436/ACDFPolicyRegistry")] },

  { id: "8444/ARDOnchainRegistry", bundleKey: "ard-onchain-framework:ARDOnchainRegistry", args: () => [], note: "owner = deployer; the four kinds are registered by the wiring step" },
  { id: "8444/SkillAdapter", bundleKey: "ard-onchain-framework:SkillAdapter", args: () => [] },
  { id: "8444/TaskAdapter", bundleKey: "ard-onchain-framework:TaskAdapter", args: () => [] },
  { id: "8444/AgentAdapter", bundleKey: "ard-onchain-framework:AgentAdapter", args: (c) => [c.addr("8434/AIDRegistry")], note: "bound to the world's ERC-8434 AIDRegistry (on Sepolia the upstream instance is bound to ARD's own fixture registry — see worlds/sepolia.json)" },
  { id: "8444/RegistryAdapter", bundleKey: "ard-onchain-framework:RegistryAdapter", args: () => [] },

  { id: "8447/SpecValidator", bundleKey: "swarm-ai-framework:SpecValidator", args: () => [], note: "external library" },
  { id: "8447/LifecycleLib", bundleKey: "swarm-ai-framework:LifecycleLib", args: () => [], note: "external library, links SpecValidator" },
  { id: "8447/MembershipLib", bundleKey: "swarm-ai-framework:MembershipLib", args: () => [], note: "external library" },
  { id: "8447/ResourceLib", bundleKey: "swarm-ai-framework:ResourceLib", args: () => [], note: "external library" },
  { id: "8447/SwarmRegistry", bundleKey: "swarm-ai-framework:SwarmRegistry", args: () => [[], []], note: "constructed with no resource kinds, as upstream did on Sepolia" },
  { id: "8447/AllowlistEligibility", bundleKey: "swarm-ai-framework:AllowlistEligibility", args: (c) => [c.deployer] },
  { id: "8447/ERC8004Eligibility", bundleKey: "swarm-ai-framework:ERC8004Eligibility", args: (c) => [c.addr("identity8004")] },
  { id: "8447/IdentityStateEligibility", bundleKey: "swarm-ai-framework:IdentityStateEligibility", args: (c) => [c.addr("8434/AIDRegistry")] },
  { id: "8447/SwarmTenderAdapter", bundleKey: "swarm-ai-framework:SwarmTenderAdapter", args: (c) => [c.addr("8447/SwarmRegistry"), c.addr("8414/TaskToken")] },

  { id: "8454/AUFUnitRegistry", bundleKey: "aifi-unit-framework:AUFUnitRegistry", args: () => [] },
  { id: "8454/AUFAssertionRegistry", bundleKey: "aifi-unit-framework:AUFAssertionRegistry", args: (c) => [c.addr("8454/AUFUnitRegistry")] },

  { id: "8468/ASFEvaluation", bundleKey: "agent-safety-framework:ASFEvaluation", args: () => [], note: "external library" },
  { id: "8468/ASFLifecycle", bundleKey: "agent-safety-framework:ASFLifecycle", args: () => [], note: "external library, links ASFEvaluation" },
  { id: "8468/ASFSpecificationRegistry", bundleKey: "agent-safety-framework:ASFSpecificationRegistry", args: () => [] },
  { id: "8468/ASFBindingRegistry", bundleKey: "agent-safety-framework:ASFBindingRegistry", args: () => [], note: "links ASFEvaluation and ASFLifecycle" },

  { id: "8471/ADRFPolicyRegistry", bundleKey: "ai-dispute-resolution:ADRFPolicyRegistry", args: () => [] },
  { id: "8471/ADRFBindingModule", bundleKey: "ai-dispute-resolution:ADRFBindingModule", args: (c) => [c.addr("8471/ADRFPolicyRegistry")] },
  { id: "8471/ADRFFilingModule", bundleKey: "ai-dispute-resolution:ADRFFilingModule", args: (c) => [c.addr("8471/ADRFPolicyRegistry")] },
  { id: "8471/ADRFResolutionModule", bundleKey: "ai-dispute-resolution:ADRFResolutionModule", args: (c) => [c.addr("8471/ADRFPolicyRegistry")] },
  { id: "8471/ADRFDecisionModule", bundleKey: "ai-dispute-resolution:ADRFDecisionModule", args: (c) => [c.addr("8471/ADRFPolicyRegistry")] },
  { id: "8471/ADRFRecordModule", bundleKey: "ai-dispute-resolution:ADRFRecordModule", args: (c) => [c.addr("8471/ADRFPolicyRegistry")] },
  { id: "8471/ADRFOutcomeModule", bundleKey: "ai-dispute-resolution:ADRFOutcomeModule", args: (c) => [c.addr("8471/ADRFPolicyRegistry")] },
  {
    id: "8471/ADRFDisputeRegistry",
    bundleKey: "ai-dispute-resolution:ADRFDisputeRegistry",
    args: (c) => [
      c.addr("8471/ADRFPolicyRegistry"),
      c.addr("8471/ADRFBindingModule"),
      c.addr("8471/ADRFFilingModule"),
      c.addr("8471/ADRFResolutionModule"),
      c.addr("8471/ADRFDecisionModule"),
      c.addr("8471/ADRFRecordModule"),
      c.addr("8471/ADRFOutcomeModule"),
    ],
    note: "router over six delegatecall modules (each unit fits Sepolia's per-transaction gas cap)",
  },
  { id: "8471/DuplicateSettlementVerifier", bundleKey: "ai-dispute-resolution:DuplicateSettlementVerifier", args: () => [] },
  { id: "8471/DeclaredVersionVerifier", bundleKey: "ai-dispute-resolution:DeclaredVersionVerifier", args: () => [] },
  { id: "8471/AttestorQuorumRule", bundleKey: "ai-dispute-resolution:AttestorQuorumRule", args: () => [] },
  { id: "8471/ADRFACDFBridge", bundleKey: "ai-dispute-resolution:ADRFACDFBridge", args: (c) => [c.addr("8471/ADRFDisputeRegistry"), c.addr("8436/ACDFRegistry")] },
  { id: "8471/ADRFServiceEscrow", bundleKey: "ai-dispute-resolution:ADRFServiceEscrow", args: (c) => [c.addr("8471/ADRFDisputeRegistry")], note: "service escrow example (obligation source + executor); bound to a policy by the genesis runner" },
];

export const WIRE_PLAN: WireStep[] = [
  {
    id: "8444/registerKinds",
    // An attached registry was wired upstream (its owner key registered the kinds); only a registry this run deployed is wired here.
    skip: (c) => (c.world.steps.some((s) => s.id === "8444/ARDOnchainRegistry" && s.status === "attached") ? "ARD registry attached: the kinds were registered upstream" : null),
    calls: (c) => {
      const kinds = c.bundle.extras["ard-onchain-framework"]?.kindIds?.kinds as Record<string, string> | undefined;
      if (!kinds) throw new Error("bundle extras lack ARD kind ids (ard-onchain-framework/kindIds)");
      const uris = c.config.params.ard.kindURIs;
      const adapters: Record<string, string> = {
        skill: "8444/SkillAdapter",
        task: "8444/TaskAdapter",
        agent: "8444/AgentAdapter",
        registry: "8444/RegistryAdapter",
      };
      return Object.entries(adapters).map(([kind, step]) => ({
        stepId: "8444/ARDOnchainRegistry",
        fn: "registerKind",
        args: [kinds[kind], c.addr(step), uris[kind] ?? ""],
        note: `kind ${kind} -> ${step}`,
      }));
    },
  },
];

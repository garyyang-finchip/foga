import type { WorldFile } from "../world/types.js";

/**
 * Layer-4 wiring checks: a view call on `subject` whose result must equal the address of `expectRef`
 * (another world contract), a value from the world's parameters, or an explicit expectation recorded in
 * the world file under wiring.expectations["<subject>.<fn>"]. Subjects or references absent from the world
 * are reported as Not applicable, never silently skipped.
 */
export interface WiringCheck {
  subject: string;
  fn: string;
  args?: (world: WorldFile) => unknown[] | null;
  expectRef?: string;
  expectParam?: (world: WorldFile) => unknown;
  label?: string;
}

function kind(world: WorldFile, name: string): unknown[] | null {
  const kinds = (world.wiring?.["8444/kindIds"] ?? null) as Record<string, string> | null;
  return kinds?.[name] ? [kinds[name]] : null;
}

export const WIRING_CHECKS: WiringCheck[] = [
  { subject: "8419/KYARegistry", fn: "getSchemeRegistry", expectRef: "8419/KYASchemeRegistry" },
  { subject: "8419/KYAPolicyRegistry", fn: "kyaRegistry", expectRef: "8419/KYARegistry" },
  { subject: "8419/ValidationRegistry8004", fn: "getIdentityRegistry", expectRef: "identity8004" },
  { subject: "8419/KYABridge8004", fn: "kyaRegistry", expectRef: "8419/KYARegistry" },
  { subject: "8419/KYABridge8004", fn: "validationRegistry", expectRef: "8419/ValidationRegistry8004" },
  { subject: "8419/KYABridge8004", fn: "identityRegistry", expectRef: "identity8004" },
  { subject: "8419/Groth16KYAVerifierAdapter", fn: "groth16", expectRef: "8419/Groth16Verifier" },
  { subject: "8419/Groth16KYAVerifierAdapter", fn: "requiredIssuerSetRoot", expectParam: (w) => w.params.kya.issuerSetRoot },
  { subject: "8419/Groth16KYAVerifierAdapter", fn: "epochLength", expectParam: (w) => w.params.kya.epochLength },

  { subject: "8434/AIDRegistry", fn: "defaultLivenessWindow", expectParam: (w) => w.params.aid.defaultLivenessWindow },
  { subject: "8434/AIDRegistry", fn: "maxLivenessWindow", expectParam: (w) => w.params.aid.maxLivenessWindow },

  { subject: "8436/ACDFRegistry", fn: "policies", expectRef: "8436/ACDFPolicyRegistry" },

  { subject: "8444/ARDOnchainRegistry", fn: "kindAdapter", args: (w) => kind(w, "skill"), expectRef: "8444/SkillAdapter", label: "kindAdapter(skill)" },
  { subject: "8444/ARDOnchainRegistry", fn: "kindAdapter", args: (w) => kind(w, "task"), expectRef: "8444/TaskAdapter", label: "kindAdapter(task)" },
  { subject: "8444/ARDOnchainRegistry", fn: "kindAdapter", args: (w) => kind(w, "agent"), expectRef: "8444/AgentAdapter", label: "kindAdapter(agent)" },
  { subject: "8444/ARDOnchainRegistry", fn: "kindAdapter", args: (w) => kind(w, "registry"), expectRef: "8444/RegistryAdapter", label: "kindAdapter(registry)" },
  { subject: "8444/AgentAdapter", fn: "identityRegistry", expectRef: "8434/AIDRegistry" },

  { subject: "8447/SwarmTenderAdapter", fn: "swarms", expectRef: "8447/SwarmRegistry" },
  { subject: "8447/SwarmTenderAdapter", fn: "task", expectRef: "8414/TaskToken" },
  { subject: "8447/ERC8004Eligibility", fn: "identity", expectRef: "identity8004" },
  { subject: "8447/IdentityStateEligibility", fn: "identities", expectRef: "8434/AIDRegistry" },
  { subject: "8447/SwarmDecisionAdapter", fn: "swarms", expectRef: "8447/SwarmRegistry" },
  { subject: "8447/SwarmDecisionAdapter", fn: "decisions", expectRef: "8436/ACDFRegistry" },

  { subject: "8454/AUFAssertionRegistry", fn: "unitRegistry", expectRef: "8454/AUFUnitRegistry" },

  { subject: "8468/ASFTaskTenderAdapter", fn: "registry", expectRef: "8468/ASFBindingRegistry" },
  { subject: "8468/ASFTaskTenderAdapter", fn: "task", expectRef: "8414/TaskToken" },

  { subject: "8471/ADRFDisputeRegistry", fn: "policies", expectRef: "8471/ADRFPolicyRegistry" },
  { subject: "8471/ADRFDisputeRegistry", fn: "bindingModule", expectRef: "8471/ADRFBindingModule" },
  { subject: "8471/ADRFDisputeRegistry", fn: "filingModule", expectRef: "8471/ADRFFilingModule" },
  { subject: "8471/ADRFDisputeRegistry", fn: "resolutionModule", expectRef: "8471/ADRFResolutionModule" },
  { subject: "8471/ADRFDisputeRegistry", fn: "decisionModule", expectRef: "8471/ADRFDecisionModule" },
  { subject: "8471/ADRFDisputeRegistry", fn: "recordModule", expectRef: "8471/ADRFRecordModule" },
  { subject: "8471/ADRFDisputeRegistry", fn: "outcomeModule", expectRef: "8471/ADRFOutcomeModule" },
  { subject: "8471/ADRFACDFBridge", fn: "adrf", expectRef: "8471/ADRFDisputeRegistry" },
  { subject: "8471/ADRFACDFBridge", fn: "acdf", expectRef: "8436/ACDFRegistry" },
  { subject: "8471/ADRFServiceEscrow", fn: "adrf", expectRef: "8471/ADRFDisputeRegistry" },
];

/** Layer-4 readouts: authority slots worth seeing even when nothing is expected of them. */
export const READOUTS: { subject: string; fn: string }[] = [
  { subject: "8444/ARDOnchainRegistry", fn: "owner" },
  { subject: "8419/KYABridge8004", fn: "owner" },
  { subject: "8447/AllowlistEligibility", fn: "owner" },
  { subject: "8471/ADRFServiceEscrow", fn: "admin" },
  { subject: "8471/ADRFServiceEscrow", fn: "bindingId" },
  { subject: "8454/AUFUnitRegistry", fn: "unitCount" },
];

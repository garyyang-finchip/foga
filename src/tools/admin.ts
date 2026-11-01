import { getAddress } from "ethers";
import { z } from "zod";
import { BindingStateName, Restriction } from "../core/asf.js";
import { keccakJcs } from "../core/canonical.js";
import { ok, refused, type Gate } from "../node/policy.js";
import { derivedJobId, zAddress, zBytes32, zJobId, zUint } from "./common.js";
import type { ActCapability } from "./types.js";

/**
 * Admin capabilities: the owner's and the guardian's acts (design memo, Phase 3, section 3 — admin is CLI-only in
 * Phase 3). They need the owner's or the guardian's key loaded for the one run (`foga cell owner …`,
 * `foga cell guardian …`); a node process holding the operator key alone refuses them at the permission gate. Their
 * transactions are the signer's own (`route: direct`), not the cell's, except `identity_transfer`, which moves an
 * asset through the account and is therefore the owner's `execute`.
 */
export const operator_rotate: ActCapability = {
  name: "operator_rotate",
  title: "Rotate the operator",
  description: "The owner sets a new operator key (address, optional expiry and daily native-value cap) on the account; the allow-list stays, and the configuration records the new operator.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8468],
  input: z.object({ operator: zAddress, validUntil: z.coerce.number().int().min(0).default(0), dailyValueCapWei: zUint.default("10000000000000000"), jobId: zJobId }),
  output: z.object({ operator: zAddress, previous: zAddress, txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const cell = node.body;
    const previous = await cell.operator();
    const gates: Gate[] = [];
    if (getAddress(previous) === getAddress(input.operator)) gates.push(refused("input", `${input.operator} is the operator already`));
    else gates.push(ok("policy", `operator ${previous} -> ${input.operator}`));
    const jobId = input.jobId ?? derivedJobId("operator-rotate", { operator: input.operator, previous });
    return {
      job: { id: jobId, kind: "admin", input: { operator: input.operator, validUntil: input.validUntil, dailyValueCapWei: input.dailyValueCapWei } },
      gates,
      valueWei: 0n,
      steps: [{ name: "setOperator", by: "owner", route: "direct", build: () => ({ target: cell.address, value: 0n, data: cell.iface.encodeFunctionData("setOperator", [input.operator, input.validUntil, BigInt(input.dailyValueCapWei)]), label: `setOperator(${input.operator})` }) }],
      output: (confirmed) => {
        node.config.identity.operator = getAddress(input.operator);
        node.saveConfig();
        return { operator: getAddress(input.operator), previous: getAddress(previous), txHash: confirmed[0].txHash, jobId };
      },
    };
  },
};

const RESTRICTIONS = Object.keys(Restriction) as (keyof typeof Restriction)[];

export const guardian_suspend: ActCapability = {
  name: "guardian_suspend",
  title: "Suspend the cell's binding",
  description: "The guardian (the binding's intervener) suspends the cell's presented binding in the ERC-8468 Binding Registry with the given restrictions; commitment-class calls stop at the account's gate, de-risk actions stay open under deriskOnly.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "guardian",
  ercs: [8468],
  input: z.object({ restrictions: z.array(z.enum(RESTRICTIONS as [string, ...string[]])).default(["noNewRisk", "deriskOnly"]), reason: z.string().min(1).max(500), response: z.string().max(500).default("no new commitments; de-risk actions continue; wait for resume"), jobId: zJobId }),
  output: z.object({ bindingId: zBytes32, restrictions: z.number(), state: z.string(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const bindingId = node.config.identity.bindingId;
    const gates: Gate[] = [];
    if (!bindingId) gates.push(refused("input", "the configuration names no binding (identity.bindingId)"));
    const mask = (input.restrictions as string[]).reduce((m: number, r: string) => m | Restriction[r as keyof typeof Restriction], 0);
    let state = "None";
    if (bindingId) {
      const b = await k.asf.bindingOf(bindingId);
      state = BindingStateName[b.state] ?? String(b.state);
      if (state !== "Active") gates.push(refused("policy", `binding ${bindingId.slice(0, 10)}… is ${state}, not Active`));
      else gates.push(ok("policy", `binding ${bindingId.slice(0, 10)}… Active; restrictions ${input.restrictions.join("|")} (${mask})`));
    }
    const jobId = input.jobId ?? derivedJobId("guardian-suspend", { bindingId, mask, reason: input.reason, at: Math.floor(Date.now() / 1000) });
    const reasonRef = keccakJcs({ kind: "reason", summary: input.reason });
    const responseRef = keccakJcs({ kind: "response", summary: input.response });
    return {
      job: { id: jobId, kind: "admin", input: { bindingId, restrictions: input.restrictions, reason: input.reason } },
      gates,
      valueWei: 0n,
      steps: [{ name: "suspend", by: "guardian", route: "direct", build: () => ({ target: k.asf.bindingRegistryAddress, value: 0n, data: k.asf.encodeSuspend(bindingId!, mask, responseRef, reasonRef), label: `suspend(${bindingId!.slice(0, 10)}…, ${mask})` }) }],
      output: async (confirmed) => ({ bindingId: bindingId!, restrictions: mask, state: BindingStateName[(await k.asf.bindingOf(bindingId!)).state] ?? "?", txHash: confirmed[0].txHash, jobId }),
    };
  },
};

export const guardian_resume: ActCapability = {
  name: "guardian_resume",
  title: "Resume the cell's binding",
  description: "The guardian lifts the suspension of the cell's presented binding.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "guardian",
  ercs: [8468],
  input: z.object({ reason: z.string().min(1).max(500), jobId: zJobId }),
  output: z.object({ bindingId: zBytes32, state: z.string(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const bindingId = node.config.identity.bindingId;
    const gates: Gate[] = [];
    if (!bindingId) gates.push(refused("input", "the configuration names no binding (identity.bindingId)"));
    else {
      const b = await k.asf.bindingOf(bindingId);
      const state = BindingStateName[b.state] ?? String(b.state);
      if (state !== "Suspended") gates.push(refused("policy", `binding ${bindingId.slice(0, 10)}… is ${state}, not Suspended`));
      else gates.push(ok("policy", `binding ${bindingId.slice(0, 10)}… Suspended`));
    }
    const jobId = input.jobId ?? derivedJobId("guardian-resume", { bindingId, reason: input.reason, at: Math.floor(Date.now() / 1000) });
    return {
      job: { id: jobId, kind: "admin", input: { bindingId, reason: input.reason } },
      gates,
      valueWei: 0n,
      steps: [{ name: "resume", by: "guardian", route: "direct", build: () => ({ target: k.asf.bindingRegistryAddress, value: 0n, data: k.asf.encodeResume(bindingId!, keccakJcs({ kind: "reason", summary: input.reason })), label: `resume(${bindingId!.slice(0, 10)}…)` }) }],
      output: async (confirmed) => ({ bindingId: bindingId!, state: BindingStateName[(await k.asf.bindingOf(bindingId!)).state] ?? "?", txHash: confirmed[0].txHash, jobId }),
    };
  },
};

export const binding_present: ActCapability = {
  name: "binding_present",
  title: "Present bindings",
  description: "The owner re-points the account's presented bindings (presentBindings is onlyOwner); the account executes nothing until the presented set satisfies its requirement.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8468],
  input: z.object({ bindingIds: z.array(zBytes32).min(1), jobId: zJobId }),
  output: z.object({ bindingIds: z.array(zBytes32), verdict: z.string(), txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const cell = node.body;
    const jobId = input.jobId ?? derivedJobId("binding-present", { bindingIds: input.bindingIds });
    return {
      job: { id: jobId, kind: "admin", input: { bindingIds: input.bindingIds } },
      gates: [ok("policy", `${input.bindingIds.length} binding(s) to present`)],
      valueWei: 0n,
      steps: [{ name: "present", by: "owner", route: "direct", build: () => ({ target: cell.address, value: 0n, data: cell.iface.encodeFunctionData("presentBindings", [input.bindingIds]), label: "presentBindings" }) }],
      output: async (confirmed) => {
        node.config.identity.bindingId = input.bindingIds[0];
        node.saveConfig();
        return { bindingIds: input.bindingIds, verdict: (await cell.status()).verdictName, txHash: confirmed[0].txHash, jobId };
      },
    };
  },
};

export const identity_transfer: ActCapability = {
  name: "identity_transfer",
  title: "Transfer the ERC-8004 identity",
  description: "The owner moves the cell's ERC-8004 agent to another account through the cell's `execute` (an asset leaves the cell: the account refuses this to the operator). The anchor turns STALE until the successor binds; `foga cell migrate` does the whole move.",
  action: "admin",
  visibility: "operator",
  principal: "cell",
  signer: "owner",
  ercs: [8004, 8434],
  input: z.object({ to: zAddress, jobId: zJobId }),
  output: z.object({ agentId: zUint, from: zAddress, to: zAddress, txHash: z.string(), jobId: z.string() }),
  async plan({ node }, input) {
    const k = node.kernel;
    const cell = node.body;
    const agentId = node.config.identity.agentId;
    const gates: Gate[] = [];
    if (!agentId) gates.push(refused("input", "the configuration names no agentId"));
    else {
      const owner = await k.identity.ownerOf(BigInt(agentId));
      if (getAddress(owner) !== getAddress(cell.address)) gates.push(refused("policy", `agent ${agentId} is held by ${owner}, not by the cell`));
      else gates.push(ok("policy", `agent ${agentId} held by the cell; moving to ${input.to}`));
    }
    const jobId = input.jobId ?? derivedJobId("identity-transfer", { agentId, to: input.to });
    return {
      job: { id: jobId, kind: "admin", input: { agentId, to: input.to } },
      gates,
      valueWei: 0n,
      steps: [{ name: "transfer", by: "owner", route: "execute", build: () => ({ target: k.identity.address, value: 0n, data: k.identity.encodeTransfer(cell.address, input.to, BigInt(agentId!)), label: `transferFrom(cell, ${input.to}, ${agentId})` }) }],
      output: (confirmed) => ({ agentId: agentId!, from: getAddress(cell.address), to: getAddress(input.to), txHash: confirmed[0].txHash, jobId }),
    };
  },
};

export const ADMIN_CAPABILITIES: ActCapability[] = [operator_rotate, guardian_suspend, guardian_resume, binding_present, identity_transfer];

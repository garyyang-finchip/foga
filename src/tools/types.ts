import type { z } from "zod";
import type { Confirmed } from "../kernel/tx.js";
import type { Gate } from "../node/policy.js";
import type { Node } from "../node/node.js";

/**
 * The capability catalog's vocabulary (design memo, Phase 3, section 3). Every capability declares three things
 * apart from what it does: the nature of the action, how far its data may be seen, and whose act it is. The three
 * entrances (CLI, MCP, HTTP/A2A) expose the catalog; none of them adds a rule of its own or can leave one out.
 */

/** read: chain and store, no key; build: unsigned calldata; act: the node acts through its account; admin: the owner's or guardian's act. */
export type Action = "read" | "build" | "act" | "admin";

/** public: anyone; caller: the caller sees its own; operator: the node's operator alone. */
export type Visibility = "public" | "caller" | "operator";

/** none: nobody acts; as: the account the caller names (a build for whom); cell: the node's own cell. */
export type Principal = "none" | "as" | "cell";

/** How a write capability is executed: full prechecks and a dry run (a decision record, no transaction), the calldata for someone else to sign, or the act itself. */
export type Mode = "simulate" | "build" | "act";

export type Entrance = "cli" | "mcp" | "http" | "a2a" | "runner";

export const ACTION_RANK: Record<Action, number> = { read: 0, build: 1, act: 2, admin: 3 };
export const VISIBILITY_RANK: Record<Visibility, number> = { public: 0, caller: 1, operator: 2 };

/** Who is calling, as the entrance established it: the local CLI is the operator, an API key a caller, a bare HTTP request the public. */
export interface Caller {
  id: string;
  entrance: Entrance;
  /** The highest action this caller may use. */
  level: Action;
  /** The widest data scope this caller may see. */
  visibility: Visibility;
}

export const OPERATOR_CALLER: Caller = { id: "operator", entrance: "cli", level: "admin", visibility: "operator" };
export const PUBLIC_CALLER: Caller = { id: "anonymous", entrance: "http", level: "build", visibility: "public" };

/** One call the cell would make through its account. */
export interface Intent {
  target: string;
  value: bigint;
  data: string;
  /** For the record: what the call is. */
  label: string;
}

/** A step of an act: builds its call once the steps before it are confirmed (a record needs the token the mint made). */
export interface ActStep {
  /** The suffix of the operation key: `job:<jobId>:<name>`. */
  name: string;
  /** Whether the call is a commitment (counts against the anchor's ACTIVE state) or a de-risk action. */
  kind?: "commitment" | "derisk" | "plain";
  /** Who signs: the operator (default), the owner (an admin step) or the guardian. */
  by?: "operator" | "owner" | "guardian";
  /** Through the account's `execute` (the cell's act; default) or as a plain transaction from the signer (an owner's or guardian's own call). */
  route?: "execute" | "direct";
  build: (prior: Confirmed[]) => Intent | Promise<Intent>;
}

/** What an act capability proposes once it has read the world: the business checks it made and the steps it would take. */
export interface ActPlan<O = unknown> {
  /**
   * The job this act belongs to: its id (the caller's idempotency key or one derived from the semantic input) and
   * kind. `commitment` counts it against the concurrent-commitments cap; `ephemeral` acts (a precheck) leave a
   * decision record but no job, since their answer changes with the world.
   */
  job: { id: string; kind: string; input: unknown; commitment?: boolean; ephemeral?: boolean };
  /** Business checks already decided (policy, skill, verifier, safety, ...). The budget and wallet gates are the catalog's. */
  gates: Gate[];
  /** Native value the steps move out of the cell, in total (for the budget). */
  valueWei: bigint;
  steps: ActStep[];
  /** Work done off chain when the act is allowed (a skill run); its result is part of the output. */
  work?: () => Promise<unknown>;
  /** The output once the steps are confirmed (or, in simulate mode, once the plan passed). */
  output: (confirmed: Confirmed[], work: unknown) => O | Promise<O>;
  /** The calldata a third party would need to do the same from its own account (`build` mode). */
  calls?: Intent[];
}

export interface ReadContext {
  node: Node;
  caller: Caller;
}

export interface ActContext extends ReadContext {
  mode: Mode;
  /** The account a build is for (`build` mode); the cell otherwise. */
  as: string;
}

export interface ReadCapability<I = any, O = any> {
  name: string;
  title: string;
  description: string;
  action: "read";
  visibility: Visibility;
  principal: "none";
  ercs: number[];
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  handler: (ctx: ReadContext, input: I) => Promise<O>;
}

export interface ActCapability<I = any, O = any> {
  name: string;
  title: string;
  description: string;
  action: "act" | "admin";
  visibility: Visibility;
  principal: "cell" | "as";
  ercs: number[];
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  /** Admin capabilities need the owner's or the guardian's key loaded in this process. */
  signer?: "owner" | "guardian";
  plan: (ctx: ActContext, input: I) => Promise<ActPlan<O>>;
}

export type Capability = ReadCapability | ActCapability;

export interface Refusal {
  ok: false;
  gate: string;
  reason: string;
  decisionId?: number;
  jobId?: string;
}

export interface Success<O = unknown> {
  ok: true;
  output: O;
  decisionId?: number;
  jobId?: string;
  operations?: string[];
}

export type ToolResult<O = unknown> = Success<O> | Refusal;

/**
 * The model layer of the runner (design memo, Phase 3, section 8, "L4"): one interface, `propose`, and two
 * implementations — `anthropic` (the Messages API) and `stub` (a deterministic decision table). The vocabulary is
 * the Messages API's own (text, tool_use and tool_result blocks), so the Anthropic adapter is a thin wire layer and
 * the stub produces exactly what a model would. A model proposes; the catalog decides. Nothing a model returns is
 * executed outside `Catalog.invoke`, and nothing it says is recorded in the store or the evidence except by hash.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema 2020-12 of the tool's input, as the catalog publishes it. */
  inputSchema: Record<string, unknown>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ModelMessage {
  role: "user" | "assistant";
  content: ContentBlock[];
}

export interface ProposeRequest {
  system: string;
  messages: ModelMessage[];
  tools: ToolSpec[];
}

export interface ProposeResult {
  /** The assistant's turn: text and tool_use blocks. */
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface ModelAdapter {
  readonly provider: "stub" | "anthropic";
  readonly model: string;
  propose(request: ProposeRequest): Promise<ProposeResult>;
}

/** A failure of the model layer (transport, quota, a malformed answer); never carries a credential. */
export class ModelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModelError";
  }
}

/** One tender as the runner shows it to the model: the chain's facts, the task document, and what the cell has done about it so far. */
export interface SituationTender {
  tokenId: string;
  demander: string;
  rewardWei: string;
  escrowWei: string;
  submitBy: number;
  settleBy: number;
  completions: number;
  maxCompletions: number;
  acceptanceAuthority: string;
  task: { skill: string; packageHash: string; input: unknown; acceptance: unknown } | null;
  /** open: never judged; eligible: pre-checked and allowed, not submitted; refused: the last pre-check refused (gate, reason); submitted: the cell's submission is pending; settled: accepted (credit may remain); failed: a run or a submission of the cell's failed (reason) and answers with that failure — not retried. */
  status: "open" | "eligible" | "refused" | "submitted" | "settled" | "failed";
  gate?: string;
  reason?: string;
  /** The cell's own submission, when it made one; `answer` is what the skill run that produced it returned (what a settlement reveals). */
  submission: { submissionId: string; status: number; resultHash: string; answer: string | null } | null;
  creditWei: string;
}

/** The situation a tick starts from: what the runner perceived through the read capabilities, as the model sees it. */
export interface Situation {
  at: string;
  block: number;
  chainId: number;
  cell: { name: string; account: string; operator: string; anchor: string; safety: { verdict: string; reasons: string[] } };
  budget: {
    dailyValueWei: string;
    perOperationValueWei: string;
    dailyGasWei: string;
    maxConcurrentCommitments: number;
    valueWei: string;
    gasWei: string;
    reservedValueWei: string;
    reservedFeeWei: string;
    runningCommitments: number;
    model: { callsToday: number; dailyCalls: number };
  };
  policy: { minRewardWei: string; minSubmitWindowSeconds: number; minSettleWindowSeconds: number; acceptance: string[]; counterpartyMinLevel: number; lookbackBlocks: number };
  skills: { held: { name: string; packageHash: string }[]; offered: string[] };
  tenders: SituationTender[];
  /** Journal entries since the last tick the runner saw: tender-discovered, safety-changed, … */
  events: { seq: number; at: string; event: string; detail: unknown }[];
  /** The latest decision records (every caller's; the operator's view). */
  recentDecisions: { id: number; at: string; caller: string; capability: string; mode: string; verdict: string; gate: string; reason: string; jobId: string | null }[];
  /** Limits of this tick: how many tool calls and acts the runner will carry out. */
  limits: { toolCalls: number; acts: number };
}

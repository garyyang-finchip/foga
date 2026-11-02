import type { DecisionRecord, JobRecord, JournalEntry } from "../kernel/store.js";
import type { DemandCase } from "./demander.js";

/**
 * `foga.loop-d-evidence/1`: what one Loop D run leaves behind (design memo, Phase 3, section 8), written by
 * `foga demo --loop-d` / `foga loop-d run` and judged by `foga doctor --loop-d`. It carries the decision records and
 * the operations of the cell's store, the tenders the demander minted with what each expected of the cell, the
 * runner's ticks with the hashes of their transcripts (never the text), the recovery drill, what the other entrances
 * did while the runner ran, the four budget books, and a scan of every transaction the operator key signed.
 */
export interface CaseOutcome {
  /** What happened: taken (submitted, settled, paid), refused (the gate), refused-then-taken (f), pending (the run ended before a verdict), other. */
  status: "taken" | "refused" | "refused-then-taken" | "pending" | "other";
  gates: string[];
  /** Decision records about this tender, by id, oldest first. */
  decisions: number[];
  submissions: { id: string; fulfiller: string; status: number; byCell: boolean }[];
  settled: boolean;
  paidWei: string;
  creditWei: string;
  withdrawnWei: string;
}

export interface OperatorTx {
  hash: string;
  block: number;
  nonce: number;
  to: string | null;
  toIsAccount: boolean;
  valueWei: string;
  /** The inner call when the transaction is the account's execute(target, value, data). */
  inner: { target: string; selector: string; valueWei: string; allowed: boolean | null } | null;
  status: number | null;
}

export interface OperationOutput {
  key: string;
  kind: string;
  signer: string;
  status: string;
  txHash: string | null;
  block: number | null;
  nonce: number | null;
  attempts: number;
  replacements: number;
  error: string | null;
  capability: string | null;
  caller: string | null;
  valueWei: string;
  gasCostWei: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LoopDEvidence {
  schema: "foga.loop-d-evidence/1";
  worldId: string;
  chainId: number;
  network: string;
  ranAt: string;
  finishedAt: string;
  seed: number;
  model: { provider: string; model: string };
  cell: { name: string; account: string; agentId: string | null; owner: string; operator: string; guardian: string; bornAtBlock: number; specId: string | null };
  demander: string;
  cases: (DemandCase & { outcome: CaseOutcome })[];
  /** Case g: a proposal above the budget. The stub makes it on purpose; a model may or may not. */
  budgetProbe: { attempted: boolean; decisionId: number | null; gate: string | null; capability: string | null };
  runner: { ticks: number; skipped: number; errors: number; modelCalls: number; toolCalls: number; acts: number; trajectoryHashes: string[] };
  recovery: { performed: boolean; killedAfterOperation: string | null; killedAt: string | null; restartedAt: string | null; tokenId: string | null };
  entrances: {
    idempotent: { decisionId: number | null; gate: string | null; sameTxHash: boolean | null } | null;
    conflict: { decisionId: number | null; gate: string | null } | null;
    concurrent: { requested: number; allowed: number; refused: { gate: string; reason: string }[] } | null;
  };
  budget: {
    dailyValueWei: string;
    perOperationValueWei: string;
    dailyGasWei: string;
    maxConcurrentCommitments: number;
    dailyModelCalls: number;
    used: { valueWei: string; gasWei: string; modelCalls: number; skillRuns: number; commitmentsMade: number };
  };
  chain: {
    fromBlock: number;
    toBlock: number;
    account: string;
    operator: string;
    operatorTxs: OperatorTx[];
    ownerTxs: number;
    guardianTxs: number;
    accountBalanceWei: { start: string; end: string };
  };
  decisions: DecisionRecord[];
  jobs: JobRecord[];
  operations: OperationOutput[];
  journal: JournalEntry[];
  summary: { cases: number; taken: number; refused: number; pending: number; decisions: { allowed: number; refused: number }; operations: number };
}

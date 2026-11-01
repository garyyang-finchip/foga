import { createRequire } from "node:module";
import { dirname } from "node:path";
import { ensureDir } from "../util/fs.js";

/**
 * The operation store: every transaction the kernel intends to send is written here before it is broadcast,
 * keyed by an idempotency key the scenario chooses ("T3.A.submit"). A restart reads the store first, so an
 * operation that was already sent is recovered from the chain (by hash) rather than sent twice, and one that was
 * already confirmed is answered from the store without touching the chain's state.
 *
 * Backed by node:sqlite (WAL, synchronous=FULL) so that a row written before a crash is on disk after it.
 */
export type OpStatus = "prepared" | "sent" | "confirmed" | "failed";

/**
 * What an operation is bound to when it is claimed (Phase 3): the canonical hash of the request that produced it,
 * and who asked for what. A later claim of the same key with another request hash is a conflict, never a
 * silent reuse of the first result; a claim without a hash (the genesis driver) binds nothing.
 */
export interface OpBinding {
  requestHash?: string;
  capability?: string;
  caller?: string;
  cell?: string;
  /** Native value the operation will move (reserved against the cell's budget from the claim on). */
  valueWei?: bigint;
  /** The most the operation may cost in fees (gas limit x fee cap), reserved alongside. */
  feeCapWei?: bigint;
}

export interface OpRecord {
  key: string;
  kind: string;
  signer: string;
  status: OpStatus;
  nonce: number | null;
  txHash: string | null;
  block: number | null;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  /** Fee replacements made so far (persisted: a restart continues the count). */
  replacements: number;
  requestHash: string | null;
  capability: string | null;
  caller: string | null;
  cell: string | null;
  valueWei: bigint;
  feeCapWei: bigint;
  /** What the operation actually cost in fees once mined (confirmed or reverted on chain). */
  gasCostWei: bigint | null;
  createdAt: string;
  updatedAt: string;
}

export type JobStatus = "accepted" | "running" | "done" | "failed" | "rejected" | "cancelled";

/** A unit of business work (a tender taken, a skill run, a document published): its input, state, result and operations. */
export interface JobRecord {
  id: string;
  kind: string;
  status: JobStatus;
  caller: string | null;
  cell: string | null;
  inputHash: string;
  input: unknown;
  result: unknown;
  error: string | null;
  operations: string[];
  createdAt: string;
  updatedAt: string;
}

/** Thrown when a key is claimed again with a different request than the one it was claimed with. */
export class OperationConflict extends Error {
  constructor(
    readonly key: string,
    readonly storedHash: string,
    readonly requestHash: string,
  ) {
    super(`operation ${key} was claimed with request ${storedHash} and is now asked for with request ${requestHash}: the same key must carry the same request (use another key for another request)`);
    this.name = "OperationConflict";
  }
}

export interface JournalEntry {
  seq: number;
  at: string;
  opKey: string | null;
  event: string;
  detail: Record<string, unknown> | null;
}

type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; get(...args: unknown[]): any; all(...args: unknown[]): any[] };
  close(): void;
};

/**
 * node:sqlite is unflagged since Node 22.13 but Node 22 still tags it experimental and prints a one-line notice
 * on first load. The notice is silenced for that one load only; every other warning is left alone.
 */
function loadSqlite(): { DatabaseSync: new (path: string) => Db } {
  const original = process.emitWarning;
  (process as any).emitWarning = function (warning: unknown, ...args: unknown[]) {
    const text = typeof warning === "string" ? warning : (warning as Error)?.message ?? "";
    const type = typeof args[0] === "string" ? args[0] : (args[0] as any)?.type;
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as any).call(process, warning, ...args);
  };
  try {
    return createRequire(import.meta.url)("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ops (
  key        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  signer     TEXT NOT NULL,
  status     TEXT NOT NULL,
  nonce      INTEGER,
  tx_hash    TEXT,
  block      INTEGER,
  result     TEXT,
  error      TEXT,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facts (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS journal (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  op_key TEXT,
  event  TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  status     TEXT NOT NULL,
  caller     TEXT,
  cell       TEXT,
  input_hash TEXT NOT NULL,
  input      TEXT NOT NULL,
  result     TEXT,
  error      TEXT,
  operations TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** Columns added after 0.5.0; an older store gains them on open (SQLite's ADD COLUMN is cheap and keeps the rows). */
const OPS_COLUMNS: [string, string][] = [
  ["replacements", "INTEGER NOT NULL DEFAULT 0"],
  ["request_hash", "TEXT"],
  ["capability", "TEXT"],
  ["caller", "TEXT"],
  ["cell", "TEXT"],
  ["value_wei", "TEXT NOT NULL DEFAULT '0'"],
  ["fee_cap_wei", "TEXT NOT NULL DEFAULT '0'"],
  ["gas_cost_wei", "TEXT"],
];

function now(): string {
  return new Date().toISOString();
}

/** JSON with bigints as decimal strings, so facts and results round-trip through SQLite text. */
export function toJson(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export class OperationStore {
  private constructor(
    private readonly db: Db,
    readonly path: string,
  ) {}

  static open(path: string): OperationStore {
    if (path !== ":memory:") ensureDir(dirname(path));
    const { DatabaseSync } = loadSqlite();
    const db = new DatabaseSync(path);
    if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    db.exec(SCHEMA);
    const have = new Set(db.prepare("PRAGMA table_info(ops)").all().map((r: any) => String(r.name)));
    for (const [name, decl] of OPS_COLUMNS) if (!have.has(name)) db.exec(`ALTER TABLE ops ADD COLUMN ${name} ${decl}`);
    return new OperationStore(db, path);
  }

  private depth = 0;

  /** Run `fn` inside one SQLite transaction (a claim and its reservation land together or not at all); nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    } finally {
      this.depth--;
    }
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------- meta

  getMeta(key: string): string | undefined {
    return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  // ---------------------------------------------------------------------------- operations

  get(key: string): OpRecord | undefined {
    const row = this.db.prepare("SELECT * FROM ops WHERE key = ?").get(key);
    return row ? rowToOp(row) : undefined;
  }

  all(): OpRecord[] {
    return this.db.prepare("SELECT * FROM ops ORDER BY created_at, key").all().map(rowToOp);
  }

  /**
   * Claim a key: record the intent to send, bound to the request when the caller binds it. Idempotent for the same
   * request: an existing row is returned unchanged (and gains the binding if it had none). Another request under
   * the same key is refused with OperationConflict. The claim and its reservation are one transaction.
   */
  prepare(key: string, kind: string, signer: string, binding: OpBinding = {}): OpRecord {
    return this.transaction(() => {
      const existing = this.get(key);
      if (existing) {
        if (binding.requestHash && existing.requestHash && existing.requestHash !== binding.requestHash) {
          throw new OperationConflict(key, existing.requestHash, binding.requestHash);
        }
        if (binding.requestHash && !existing.requestHash) {
          this.db
            .prepare("UPDATE ops SET request_hash = ?, capability = COALESCE(capability, ?), caller = COALESCE(caller, ?), cell = COALESCE(cell, ?), updated_at = ? WHERE key = ?")
            .run(binding.requestHash, binding.capability ?? null, binding.caller ?? null, binding.cell ?? null, now(), key);
          return this.get(key)!;
        }
        return existing;
      }
      const t = now();
      this.db
        .prepare("INSERT INTO ops (key, kind, signer, status, attempts, replacements, request_hash, capability, caller, cell, value_wei, fee_cap_wei, created_at, updated_at) VALUES (?, ?, ?, 'prepared', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(key, kind, signer, binding.requestHash ?? null, binding.capability ?? null, binding.caller ?? null, binding.cell ?? null, (binding.valueWei ?? 0n).toString(), (binding.feeCapWei ?? 0n).toString(), t, t);
      return this.get(key)!;
    });
  }

  /**
   * The transaction is signed and its hash known: written before the broadcast. The value it carries replaces the
   * reservation made at the claim (the reservation was an upper bound; from here on the row says what will move).
   */
  markSent(key: string, txHash: string, nonce: number, valueWei?: bigint): void {
    this.db
      .prepare("UPDATE ops SET status = 'sent', tx_hash = ?, nonce = ?, error = NULL, attempts = attempts + 1, value_wei = COALESCE(?, value_wei), updated_at = ? WHERE key = ?")
      .run(txHash, nonce, valueWei === undefined ? null : valueWei.toString(), now(), key);
  }

  /** A fee replacement was signed for the operation: its new hash, and one more replacement on the count. */
  markReplaced(key: string, txHash: string, nonce: number): void {
    this.db.prepare("UPDATE ops SET status = 'sent', tx_hash = ?, nonce = ?, error = NULL, replacements = replacements + 1, updated_at = ? WHERE key = ?").run(txHash, nonce, now(), key);
  }

  /** Fees are cumulative over the operation's attempts: a retried operation's reverted first attempt was paid for too. */
  private addedGasCost(key: string, gasCostWei: bigint | undefined): string | null {
    if (gasCostWei === undefined) return null;
    return ((this.get(key)?.gasCostWei ?? 0n) + gasCostWei).toString();
  }

  markConfirmed(key: string, txHash: string, block: number, result: Record<string, unknown>, gasCostWei?: bigint): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE ops SET status = 'confirmed', tx_hash = ?, block = ?, result = ?, error = NULL, gas_cost_wei = COALESCE(?, gas_cost_wei), updated_at = ? WHERE key = ?")
        .run(txHash, block, toJson(result), this.addedGasCost(key, gasCostWei), now(), key);
    });
  }

  markFailed(key: string, error: string, gasCostWei?: bigint): void {
    this.transaction(() => {
      this.db
        .prepare("UPDATE ops SET status = 'failed', error = ?, gas_cost_wei = COALESCE(?, gas_cost_wei), updated_at = ? WHERE key = ?")
        .run(error, this.addedGasCost(key, gasCostWei), now(), key);
    });
  }

  /** A failed operation the caller explicitly retries: back to prepared, the failure kept in the journal. */
  markRetry(key: string): void {
    this.db.prepare("UPDATE ops SET status = 'prepared', tx_hash = NULL, nonce = NULL, block = NULL, error = NULL, updated_at = ? WHERE key = ?").run(now(), key);
  }

  /** Operations of a signer that are claimed or in flight (their reservations are still open). */
  openOps(signer: string): OpRecord[] {
    return this.db.prepare("SELECT * FROM ops WHERE signer = ? AND status IN ('prepared', 'sent') ORDER BY created_at, key").all(signer).map(rowToOp);
  }

  /**
   * What a signer's operations spent since `sinceIso` (value moved plus fees paid, confirmed and reverted alike) and
   * what its open operations still reserve: the two numbers a budget is checked against.
   */
  budgetUse(signer: string, sinceIso: string): { spentWei: bigint; reservedWei: bigint } {
    let spent = 0n;
    for (const r of this.db.prepare("SELECT value_wei, gas_cost_wei, status FROM ops WHERE signer = ? AND updated_at >= ? AND status IN ('confirmed', 'failed')").all(signer, sinceIso)) {
      if (r.status === "confirmed") spent += BigInt(r.value_wei ?? "0");
      spent += BigInt(r.gas_cost_wei ?? "0");
    }
    let reserved = 0n;
    for (const r of this.db.prepare("SELECT value_wei, fee_cap_wei FROM ops WHERE signer = ? AND status IN ('prepared', 'sent')").all(signer)) {
      reserved += BigInt(r.value_wei ?? "0") + BigInt(r.fee_cap_wei ?? "0");
    }
    return { spentWei: spent, reservedWei: reserved };
  }

  // ---------------------------------------------------------------------------- jobs

  /** Create a job, or return the existing one for the id; the same id with another input is a conflict. */
  createJob(p: { id: string; kind: string; caller?: string; cell?: string; inputHash: string; input: unknown }): JobRecord {
    return this.transaction(() => {
      const existing = this.getJob(p.id);
      if (existing) {
        if (existing.inputHash !== p.inputHash) throw new OperationConflict(p.id, existing.inputHash, p.inputHash);
        return existing;
      }
      const t = now();
      this.db
        .prepare("INSERT INTO jobs (id, kind, status, caller, cell, input_hash, input, operations, created_at, updated_at) VALUES (?, ?, 'accepted', ?, ?, ?, ?, '[]', ?, ?)")
        .run(p.id, p.kind, p.caller ?? null, p.cell ?? null, p.inputHash, toJson(p.input), t, t);
      return this.getJob(p.id)!;
    });
  }

  getJob(id: string): JobRecord | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id);
    return row ? rowToJob(row) : undefined;
  }

  updateJob(id: string, patch: { status?: JobStatus; result?: unknown; error?: string | null; addOperation?: string }): JobRecord {
    return this.transaction(() => {
      const job = this.getJob(id);
      if (!job) throw new Error(`no job ${id}`);
      const operations = patch.addOperation && !job.operations.includes(patch.addOperation) ? [...job.operations, patch.addOperation] : job.operations;
      this.db
        .prepare("UPDATE jobs SET status = ?, result = ?, error = ?, operations = ?, updated_at = ? WHERE id = ?")
        .run(patch.status ?? job.status, patch.result === undefined ? (job.result === null ? null : toJson(job.result)) : toJson(patch.result), patch.error === undefined ? job.error : patch.error, JSON.stringify(operations), now(), id);
      return this.getJob(id)!;
    });
  }

  /** Jobs visible to a caller (its own), newest first; `caller` null lists every job (the operator's view). */
  jobs(caller: string | null, limit = 50): JobRecord[] {
    const rows = caller === null
      ? this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").all(limit)
      : this.db.prepare("SELECT * FROM jobs WHERE caller = ? ORDER BY created_at DESC LIMIT ?").all(caller, limit);
    return rows.map(rowToJob);
  }

  // ---------------------------------------------------------------------------- facts

  /** Scenario-level values (ids, addresses, hashes) that later steps and a resumed run read back. */
  setFact(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO facts (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run(key, toJson(value), now());
  }

  getFact<T = unknown>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM facts WHERE key = ?").get(key);
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  requireFact<T = unknown>(key: string): T {
    const v = this.getFact<T>(key);
    if (v === undefined) throw new Error(`operation store has no fact ${key}`);
    return v;
  }

  facts(prefix = ""): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const row of this.db.prepare("SELECT key, value FROM facts WHERE key LIKE ? ORDER BY key").all(prefix + "%")) out[row.key] = JSON.parse(row.value);
    return out;
  }

  // ---------------------------------------------------------------------------- journal

  journal(event: string, detail?: Record<string, unknown>, opKey?: string): number {
    this.db.prepare("INSERT INTO journal (at, op_key, event, detail) VALUES (?, ?, ?, ?)").run(now(), opKey ?? null, event, detail ? toJson(detail) : null);
    return Number(this.db.prepare("SELECT seq FROM journal ORDER BY seq DESC LIMIT 1").get().seq);
  }

  journalEntries(): JournalEntry[] {
    return this.db.prepare("SELECT * FROM journal ORDER BY seq").all().map((r) => ({ seq: Number(r.seq), at: r.at, opKey: r.op_key ?? null, event: r.event, detail: r.detail ? JSON.parse(r.detail) : null }));
  }

  // ---------------------------------------------------------------------------- summary

  summary(): { ops: Record<OpStatus, number>; facts: number; journal: number } {
    const ops: Record<OpStatus, number> = { prepared: 0, sent: 0, confirmed: 0, failed: 0 };
    for (const r of this.db.prepare("SELECT status, COUNT(*) AS n FROM ops GROUP BY status").all()) ops[r.status as OpStatus] = Number(r.n);
    const facts = Number(this.db.prepare("SELECT COUNT(*) AS n FROM facts").get().n);
    const journal = Number(this.db.prepare("SELECT COUNT(*) AS n FROM journal").get().n);
    return { ops, facts, journal };
  }
}

function rowToOp(row: any): OpRecord {
  return {
    key: row.key,
    kind: row.kind,
    signer: row.signer,
    status: row.status,
    nonce: row.nonce === null || row.nonce === undefined ? null : Number(row.nonce),
    txHash: row.tx_hash ?? null,
    block: row.block === null || row.block === undefined ? null : Number(row.block),
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error ?? null,
    attempts: Number(row.attempts ?? 0),
    replacements: Number(row.replacements ?? 0),
    requestHash: row.request_hash ?? null,
    capability: row.capability ?? null,
    caller: row.caller ?? null,
    cell: row.cell ?? null,
    valueWei: BigInt(row.value_wei ?? "0"),
    feeCapWei: BigInt(row.fee_cap_wei ?? "0"),
    gasCostWei: row.gas_cost_wei === null || row.gas_cost_wei === undefined ? null : BigInt(row.gas_cost_wei),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToJob(row: any): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    caller: row.caller ?? null,
    cell: row.cell ?? null,
    inputHash: row.input_hash,
    input: row.input ? JSON.parse(row.input) : null,
    result: row.result ? JSON.parse(row.result) : null,
    error: row.error ?? null,
    operations: row.operations ? JSON.parse(row.operations) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

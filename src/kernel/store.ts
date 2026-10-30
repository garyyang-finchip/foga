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
  createdAt: string;
  updatedAt: string;
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
`;

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
    return new OperationStore(db, path);
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

  /** Record the intent to send. Idempotent: an existing row is returned unchanged. */
  prepare(key: string, kind: string, signer: string): OpRecord {
    const existing = this.get(key);
    if (existing) return existing;
    const t = now();
    this.db.prepare("INSERT INTO ops (key, kind, signer, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'prepared', 0, ?, ?)").run(key, kind, signer, t, t);
    return this.get(key)!;
  }

  /** The transaction is signed and its hash known: written before the broadcast. */
  markSent(key: string, txHash: string, nonce: number): void {
    this.db.prepare("UPDATE ops SET status = 'sent', tx_hash = ?, nonce = ?, error = NULL, attempts = attempts + 1, updated_at = ? WHERE key = ?").run(txHash, nonce, now(), key);
  }

  markConfirmed(key: string, txHash: string, block: number, result: Record<string, unknown>): void {
    this.db.prepare("UPDATE ops SET status = 'confirmed', tx_hash = ?, block = ?, result = ?, error = NULL, updated_at = ? WHERE key = ?").run(txHash, block, toJson(result), now(), key);
  }

  markFailed(key: string, error: string): void {
    this.db.prepare("UPDATE ops SET status = 'failed', error = ?, updated_at = ? WHERE key = ?").run(error, now(), key);
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

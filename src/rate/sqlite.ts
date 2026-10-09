import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, StatementSync } from "node:sqlite";

import { ConfigError } from "../config.js";
import type { RateDecision, RateStore } from "./index.js";
import { IDLE_EVICT_MS, stepBucket } from "./index.js";

/**
 * SQLite-backed token buckets, shared by every gateway process that opens the same file.
 *
 * Why SQLite (WAL) rather than Redis for v1: the gateway runs on one VPS. A file on a mounted
 * volume needs no extra service to run, secure, back up or monitor; it survives restarts and
 * container replacement; and WAL plus `BEGIN IMMEDIATE` serialises concurrent writers across
 * processes on that host, so two gateway processes (or a blue/green pair during an upgrade)
 * share one set of limits. It does not work across hosts: a second VPS needs a network store,
 * which is a new `RateStore` implementation (Redis) behind the same interface, not a rewrite.
 *
 * Uses Node's built-in `node:sqlite` (Node 22.13+), so there is no native module to compile in
 * the container. Each take() is one short synchronous transaction (a read and an upsert on a
 * primary key); with `busy_timeout` a writer waits for the lock rather than failing.
 */
export class SqliteRateStore implements RateStore {
  readonly kind = "sqlite";
  private readonly db: DatabaseSync;
  private readonly select: StatementSync;
  private readonly upsert: StatementSync;
  private readonly evict: StatementSync;
  private readonly now: () => number;
  private lastSweep = 0;

  constructor(path: string, options: { now?: () => number; busyTimeoutMs?: number } = {}) {
    this.now = options.now ?? (() => Date.now());
    const sqlite = process.getBuiltinModule("node:sqlite");
    if (!sqlite) throw new ConfigError("rate: store sqlite needs Node 22.13 or newer (node:sqlite is unavailable)");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    try {
      this.db = new sqlite.DatabaseSync(path);
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5_000))}`);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS rate_buckets (key TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL, capacity INTEGER NOT NULL) WITHOUT ROWID",
      );
    } catch (error) {
      throw new ConfigError(`rate: cannot open SQLite store at ${path}: ${(error as Error).message}`);
    }
    this.select = this.db.prepare("SELECT tokens, updated_at, capacity FROM rate_buckets WHERE key = ?");
    this.upsert = this.db.prepare(
      "INSERT INTO rate_buckets (key, tokens, updated_at, capacity) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET tokens = excluded.tokens, updated_at = excluded.updated_at, capacity = excluded.capacity",
    );
    this.evict = this.db.prepare("DELETE FROM rate_buckets WHERE updated_at < ?");
  }

  /** Journal mode actually in effect (WAL unless the filesystem refused it). */
  journalMode(): string {
    const row = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | undefined;
    return String(row?.journal_mode ?? "unknown");
  }

  take(key: string, rpm: number): RateDecision {
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.select.get(key) as { tokens: number; updated_at: number; capacity: number } | undefined;
      const previous = row ? { tokens: row.tokens, updatedAt: row.updated_at, capacity: row.capacity } : undefined;
      const { next, decision } = stepBucket(previous, now, rpm);
      this.upsert.run(key, next.tokens, next.updatedAt, next.capacity);
      if (now - this.lastSweep >= 60_000) {
        this.lastSweep = now;
        this.evict.run(now - IDLE_EVICT_MS);
      }
      this.db.exec("COMMIT");
      return decision;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back.
      }
      throw error;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

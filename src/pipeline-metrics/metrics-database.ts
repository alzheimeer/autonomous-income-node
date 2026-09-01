/**
 * Pipeline Metrics - Database Adapter
 *
 * Dedicated SQLite database for pipeline event recording and backtest results.
 * Uses `data/metrics.db`, completely isolated from `data/agent.db`.
 *
 * Follows the same `node:sqlite` DatabaseSync pattern as TradingDatabase.
 *
 * Features:
 *   - 5 tables: pipeline_events, rejection_reasons, near_misses, backtest_runs, backtest_trades
 *   - Degraded mode: if DB inaccessible, logs error and all operations become no-ops
 *   - BigInt monetary values stored as TEXT to prevent floating-point loss
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */

import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';

const log = createLogger('pipeline-metrics-db');

// Use createRequire to load node:sqlite — avoids Vite module resolution issues
const require = createRequire(import.meta.url);
const { DatabaseSync: NativeDatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => NativeDatabase;
};

/** Minimal type for the native DatabaseSync instance */
interface NativeDatabase {
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
}

interface NativeStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type PipelineEventType =
  | 'evaluation_started' | 'evaluation_skipped_mutex'
  | 'evaluation_skipped_not_running' | 'evaluation_skipped_cannot_evaluate'
  | 'indicators_unavailable' | 'indicators_computed'
  | 'strategy_no_signal' | 'strategy_signal_generated'
  | 'daily_loss_limit_hit'
  | 'position_sizing_rejected' | 'position_sized'
  | 'bankroll_insufficient' | 'bankroll_approved'
  | 'aave_funds_unavailable' | 'aave_funds_secured'
  | 'gate_rejected' | 'gate_passed'
  | 'trade_executed';

export interface PipelineEvent {
  id: number;
  timestamp: number;
  event_type: PipelineEventType;
  details: Record<string, unknown>;
  session_id: string;
}

export interface RejectionRecord {
  id: number;
  event_id: number;
  reason_key: string;
  detail_value: string | null;
}

export interface NearMissRecord {
  id: number;
  event_id: number;
  indicator_name: string;
  actual_value: number;
  threshold_value: number;
  distance: number;
}

export interface BacktestTradeRecord {
  id: number;
  run_id: number;
  entry_time: number;
  exit_time: number;
  entry_price: number;
  exit_price: number;
  size_usdc: string;
  pnl_usdc: string;
  strategy: string;
  regime: string;
  exit_reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema SQL
// ═══════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = `
-- Core events table
CREATE TABLE IF NOT EXISTS pipeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '{}',
  session_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_timestamp ON pipeline_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_type ON pipeline_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_session ON pipeline_events(session_id);

-- Normalized rejection reasons
CREATE TABLE IF NOT EXISTS rejection_reasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES pipeline_events(id),
  reason_key TEXT NOT NULL,
  detail_value TEXT
);

CREATE INDEX IF NOT EXISTS idx_rejections_event ON rejection_reasons(event_id);
CREATE INDEX IF NOT EXISTS idx_rejections_key ON rejection_reasons(reason_key);

-- Near-miss detection
CREATE TABLE IF NOT EXISTS near_misses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES pipeline_events(id),
  indicator_name TEXT NOT NULL,
  actual_value REAL NOT NULL,
  threshold_value REAL NOT NULL,
  distance REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_nearmiss_event ON near_misses(event_id);
CREATE INDEX IF NOT EXISTS idx_nearmiss_indicator ON near_misses(indicator_name);

-- Backtest run summaries
CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_timestamp INTEGER NOT NULL,
  days_simulated INTEGER NOT NULL,
  total_trades INTEGER NOT NULL,
  win_rate REAL NOT NULL,
  profit_factor REAL NOT NULL,
  max_drawdown_pct REAL NOT NULL,
  total_pnl_usdc TEXT NOT NULL,
  verdict TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);

-- Backtest individual trades
CREATE TABLE IF NOT EXISTS backtest_trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES backtest_runs(id),
  entry_time INTEGER NOT NULL,
  exit_time INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  size_usdc TEXT NOT NULL,
  pnl_usdc TEXT NOT NULL,
  strategy TEXT NOT NULL,
  regime TEXT NOT NULL,
  exit_reason TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bt_trades_run ON backtest_trades(run_id);
`;

// ═══════════════════════════════════════════════════════════════════════════
// MetricsDatabase
// ═══════════════════════════════════════════════════════════════════════════

/**
 * MetricsDatabase provides storage for pipeline events, rejection reasons,
 * near-misses, and backtest results in `data/metrics.db`.
 *
 * Operates in degraded mode if the database file is inaccessible —
 * all write/read methods become no-ops returning empty arrays or -1.
 */
export class MetricsDatabase {
  private db: NativeDatabase | null = null;
  private degraded = false;

  constructor(path: string) {
    try {
      this.db = new NativeDatabaseSync(path);
      this.db.exec(SCHEMA_SQL);
      log.info('MetricsDatabase initialized', { path });
    } catch (err) {
      this.degraded = true;
      this.db = null;
      log.error('MetricsDatabase failed to initialize — operating in degraded mode', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Whether the database is operating in degraded (no-op) mode */
  get isDegraded(): boolean {
    return this.degraded;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Insert operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert a pipeline event. Returns the inserted row ID, or -1 in degraded mode.
   */
  insertEvent(
    timestamp: number,
    eventType: PipelineEventType,
    details: Record<string, unknown>,
    sessionId: string,
  ): number {
    if (!this.db) return -1;
    try {
      const stmt = this.db.prepare(
        'INSERT INTO pipeline_events (timestamp, event_type, details, session_id) VALUES (?, ?, ?, ?)',
      );
      const result = stmt.run(timestamp, eventType, JSON.stringify(details), sessionId);
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error('insertEvent failed', { error: err instanceof Error ? err.message : String(err) });
      return -1;
    }
  }

  /**
   * Insert a rejection reason linked to a pipeline event.
   * Returns the inserted row ID, or -1 in degraded mode.
   */
  insertRejection(eventId: number, reasonKey: string, detailValue: string | null): number {
    if (!this.db) return -1;
    try {
      const stmt = this.db.prepare(
        'INSERT INTO rejection_reasons (event_id, reason_key, detail_value) VALUES (?, ?, ?)',
      );
      const result = stmt.run(eventId, reasonKey, detailValue);
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error('insertRejection failed', { error: err instanceof Error ? err.message : String(err) });
      return -1;
    }
  }

  /**
   * Insert a near-miss record linked to a pipeline event.
   * Returns the inserted row ID, or -1 in degraded mode.
   */
  insertNearMiss(
    eventId: number,
    indicatorName: string,
    actualValue: number,
    thresholdValue: number,
    distance: number,
  ): number {
    if (!this.db) return -1;
    try {
      const stmt = this.db.prepare(
        'INSERT INTO near_misses (event_id, indicator_name, actual_value, threshold_value, distance) VALUES (?, ?, ?, ?, ?)',
      );
      const result = stmt.run(eventId, indicatorName, actualValue, thresholdValue, distance);
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error('insertNearMiss failed', { error: err instanceof Error ? err.message : String(err) });
      return -1;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Query pipeline events within a time range.
   * Returns events ordered by timestamp descending.
   */
  queryEvents(opts: {
    since?: number;
    until?: number;
    eventType?: PipelineEventType;
    limit?: number;
  } = {}): PipelineEvent[] {
    if (!this.db) return [];
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts.since !== undefined) {
        conditions.push('timestamp >= ?');
        params.push(opts.since);
      }
      if (opts.until !== undefined) {
        conditions.push('timestamp <= ?');
        params.push(opts.until);
      }
      if (opts.eventType !== undefined) {
        conditions.push('event_type = ?');
        params.push(opts.eventType);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = opts.limit ?? 100;

      const stmt = this.db.prepare(
        `SELECT id, timestamp, event_type, details, session_id FROM pipeline_events ${where} ORDER BY timestamp DESC LIMIT ?`,
      );
      params.push(limit);

      const rows = stmt.all(...params) as Array<{
        id: number;
        timestamp: number;
        event_type: string;
        details: string;
        session_id: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        timestamp: row.timestamp,
        event_type: row.event_type as PipelineEventType,
        details: JSON.parse(row.details) as Record<string, unknown>,
        session_id: row.session_id,
      }));
    } catch (err) {
      log.error('queryEvents failed', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Query rejection reasons, optionally filtered by event_id or reason_key.
   */
  queryRejections(opts: {
    eventId?: number;
    reasonKey?: string;
    limit?: number;
  } = {}): RejectionRecord[] {
    if (!this.db) return [];
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts.eventId !== undefined) {
        conditions.push('event_id = ?');
        params.push(opts.eventId);
      }
      if (opts.reasonKey !== undefined) {
        conditions.push('reason_key = ?');
        params.push(opts.reasonKey);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = opts.limit ?? 100;

      const stmt = this.db.prepare(
        `SELECT id, event_id, reason_key, detail_value FROM rejection_reasons ${where} ORDER BY id DESC LIMIT ?`,
      );
      params.push(limit);

      const rows = stmt.all(...params) as Array<{
        id: number;
        event_id: number;
        reason_key: string;
        detail_value: string | null;
      }>;

      return rows.map((row) => ({
        id: row.id,
        event_id: row.event_id,
        reason_key: row.reason_key,
        detail_value: row.detail_value,
      }));
    } catch (err) {
      log.error('queryRejections failed', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  /**
   * Query near-miss records, optionally filtered by event_id or indicator_name.
   */
  queryNearMisses(opts: {
    eventId?: number;
    indicatorName?: string;
    limit?: number;
  } = {}): NearMissRecord[] {
    if (!this.db) return [];
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts.eventId !== undefined) {
        conditions.push('event_id = ?');
        params.push(opts.eventId);
      }
      if (opts.indicatorName !== undefined) {
        conditions.push('indicator_name = ?');
        params.push(opts.indicatorName);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = opts.limit ?? 100;

      const stmt = this.db.prepare(
        `SELECT id, event_id, indicator_name, actual_value, threshold_value, distance FROM near_misses ${where} ORDER BY id DESC LIMIT ?`,
      );
      params.push(limit);

      const rows = stmt.all(...params) as Array<{
        id: number;
        event_id: number;
        indicator_name: string;
        actual_value: number;
        threshold_value: number;
        distance: number;
      }>;

      return rows.map((row) => ({
        id: row.id,
        event_id: row.event_id,
        indicator_name: row.indicator_name,
        actual_value: row.actual_value,
        threshold_value: row.threshold_value,
        distance: row.distance,
      }));
    } catch (err) {
      log.error('queryNearMisses failed', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Backtest persistence
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert a backtest run summary.
   * Monetary values stored as TEXT (BigInt string representation).
   * Returns the inserted row ID, or -1 in degraded mode.
   */
  insertBacktestRun(
    runTimestamp: number,
    daysSimulated: number,
    totalTrades: number,
    winRate: number,
    profitFactor: number,
    maxDrawdownPct: number,
    totalPnlUsdc: string,
    verdict: string,
    configHash: string,
    durationMs: number,
  ): number {
    if (!this.db) return -1;
    try {
      const stmt = this.db.prepare(
        `INSERT INTO backtest_runs (run_timestamp, days_simulated, total_trades, win_rate, profit_factor, max_drawdown_pct, total_pnl_usdc, verdict, config_hash, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const result = stmt.run(
        runTimestamp, daysSimulated, totalTrades, winRate,
        profitFactor, maxDrawdownPct, totalPnlUsdc, verdict, configHash, durationMs,
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error('insertBacktestRun failed', { error: err instanceof Error ? err.message : String(err) });
      return -1;
    }
  }

  /**
   * Insert a backtest trade linked to a run.
   * Monetary values (size_usdc, pnl_usdc) stored as TEXT (BigInt string representation).
   * Returns the inserted row ID, or -1 in degraded mode.
   */
  insertBacktestTrade(
    runId: number,
    entryTime: number,
    exitTime: number,
    entryPrice: number,
    exitPrice: number,
    sizeUsdc: string,
    pnlUsdc: string,
    strategy: string,
    regime: string,
    exitReason: string,
  ): number {
    if (!this.db) return -1;
    try {
      const stmt = this.db.prepare(
        `INSERT INTO backtest_trades (run_id, entry_time, exit_time, entry_price, exit_price, size_usdc, pnl_usdc, strategy, regime, exit_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const result = stmt.run(
        runId, entryTime, exitTime, entryPrice, exitPrice,
        sizeUsdc, pnlUsdc, strategy, regime, exitReason,
      );
      return Number(result.lastInsertRowid);
    } catch (err) {
      log.error('insertBacktestTrade failed', { error: err instanceof Error ? err.message : String(err) });
      return -1;
    }
  }

  /**
   * Query backtest trades, optionally filtered by run_id.
   * Returns trades ordered by id descending.
   */
  queryBacktestTrades(opts: {
    runId?: number;
    limit?: number;
  } = {}): BacktestTradeRecord[] {
    if (!this.db) return [];
    try {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (opts.runId !== undefined) {
        conditions.push('run_id = ?');
        params.push(opts.runId);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = opts.limit ?? 100;

      const stmt = this.db.prepare(
        `SELECT id, run_id, entry_time, exit_time, entry_price, exit_price, size_usdc, pnl_usdc, strategy, regime, exit_reason FROM backtest_trades ${where} ORDER BY id DESC LIMIT ?`,
      );
      params.push(limit);

      const rows = stmt.all(...params) as Array<{
        id: number;
        run_id: number;
        entry_time: number;
        exit_time: number;
        entry_price: number;
        exit_price: number;
        size_usdc: string;
        pnl_usdc: string;
        strategy: string;
        regime: string;
        exit_reason: string;
      }>;

      return rows.map((row) => ({
        id: row.id,
        run_id: row.run_id,
        entry_time: row.entry_time,
        exit_time: row.exit_time,
        entry_price: row.entry_price,
        exit_price: row.exit_price,
        size_usdc: row.size_usdc,
        pnl_usdc: row.pnl_usdc,
        strategy: row.strategy,
        regime: row.regime,
        exit_reason: row.exit_reason,
      }));
    } catch (err) {
      log.error('queryBacktestTrades failed', { error: err instanceof Error ? err.message : String(err) });
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // Ignore close errors
      }
      this.db = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════

/** Default metrics database path */
export const METRICS_DB_PATH = 'data/metrics.db';

/**
 * Create a MetricsDatabase instance.
 *
 * @param path - Path to the SQLite file, or ':memory:' for in-memory DB.
 *              Defaults to `data/metrics.db`.
 */
export function createMetricsDatabase(path: string = METRICS_DB_PATH): MetricsDatabase {
  return new MetricsDatabase(path);
}

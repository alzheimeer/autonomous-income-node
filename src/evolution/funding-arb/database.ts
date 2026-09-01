/**
 * Funding Arbitrage Backtest — Database Adapter
 *
 * SQLite database for funding rate history and backtest results.
 * Uses `data/funding.db`.
 *
 * Follows the same `node:sqlite` DatabaseSync pattern as EvolutionDatabase.
 *
 * Features:
 *   - 2 tables: funding_rates, backtest_results
 *   - Degraded mode: if DB inaccessible, logs error and all operations become no-ops
 *   - BigInt values stored as TEXT in SQLite and converted back on read
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

import { createRequire } from 'node:module';
import { createLogger } from '../../logger.js';

const log = createLogger('funding-db');

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
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface FundingRateRow {
  coin: string;
  timestamp: number;
  funding_rate: string;
}

export interface BacktestResultRow {
  run_id: string;
  created_at: string;
  coin: string;
  capital_usdc: bigint;
  net_pnl: bigint;
  gross_funding: bigint;
  total_costs: bigint;
  alpha: bigint;
  max_drawdown_bps: number;
  liquidation_count: number;
  stress_events: number;
  hours_simulated: number;
  verdict: 'VIABLE' | 'UNVIABLE';
  cost_scenario: 'optimistic' | 'pessimistic';
  evidence: string; // JSON
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema SQL
// ═══════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = `
-- Funding rates table (historical hourly funding rates from Hyperliquid)
CREATE TABLE IF NOT EXISTS funding_rates (
  coin TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  funding_rate TEXT NOT NULL,
  PRIMARY KEY (coin, timestamp)
);

CREATE INDEX IF NOT EXISTS idx_funding_rates_coin_time
  ON funding_rates(coin, timestamp);

-- Backtest results table
CREATE TABLE IF NOT EXISTS backtest_results (
  run_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  coin TEXT NOT NULL,
  capital_usdc TEXT NOT NULL,
  net_pnl TEXT NOT NULL,
  gross_funding TEXT NOT NULL,
  total_costs TEXT NOT NULL,
  alpha TEXT NOT NULL,
  max_drawdown_bps INTEGER NOT NULL,
  liquidation_count INTEGER NOT NULL,
  stress_events INTEGER NOT NULL,
  hours_simulated INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK(verdict IN ('VIABLE', 'UNVIABLE')),
  cost_scenario TEXT NOT NULL CHECK(cost_scenario IN ('optimistic', 'pessimistic')),
  evidence TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, coin, cost_scenario, capital_usdc)
);

CREATE INDEX IF NOT EXISTS idx_backtest_results_run
  ON backtest_results(run_id);
CREATE INDEX IF NOT EXISTS idx_backtest_results_coin
  ON backtest_results(coin);
CREATE INDEX IF NOT EXISTS idx_backtest_results_created
  ON backtest_results(created_at);
`;

// ═══════════════════════════════════════════════════════════════════════════
// Raw row types (before deserialization)
// ═══════════════════════════════════════════════════════════════════════════

interface RawFundingRateRow {
  coin: string;
  timestamp: number;
  funding_rate: string;
}

interface RawBacktestResultRow {
  run_id: string;
  created_at: string;
  coin: string;
  capital_usdc: string;
  net_pnl: string;
  gross_funding: string;
  total_costs: string;
  alpha: string;
  max_drawdown_bps: number;
  liquidation_count: number;
  stress_events: number;
  hours_simulated: number;
  verdict: string;
  cost_scenario: string;
  evidence: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// FundingDatabase
// ═══════════════════════════════════════════════════════════════════════════

/**
 * FundingDatabase provides storage for funding rate history and backtest results.
 *
 * Operates in degraded mode if the database file is inaccessible —
 * all write/read methods become no-ops returning empty arrays or false.
 */
export class FundingDatabase {
  private db: NativeDatabase | null = null;
  private degraded = false;

  constructor(path: string = 'data/funding.db') {
    try {
      this.db = new NativeDatabaseSync(path);
      this.db.exec(SCHEMA_SQL);
      log.info('FundingDatabase initialized', { path });
    } catch (err) {
      this.degraded = true;
      this.db = null;
      log.error('FundingDatabase failed to initialize — operating in degraded mode', {
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
  // Funding Rates
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Upsert a single funding rate record.
   * Uses INSERT OR REPLACE keyed on (coin, timestamp).
   */
  upsertFundingRate(coin: string, timestamp: number, fundingRate: string): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO funding_rates (coin, timestamp, funding_rate)
        VALUES (?, ?, ?)
      `);
      stmt.run(coin, timestamp, fundingRate);
    } catch (err) {
      log.error('upsertFundingRate failed', {
        coin,
        timestamp,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get all funding rates for a coin within a time range (inclusive).
   * Returns records ordered by timestamp ASC.
   */
  getFundingRates(coin: string, startTime: number, endTime: number): FundingRateRow[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(`
        SELECT coin, timestamp, funding_rate
        FROM funding_rates
        WHERE coin = ? AND timestamp >= ? AND timestamp <= ?
        ORDER BY timestamp ASC
      `);
      const rows = stmt.all(coin, startTime, endTime) as RawFundingRateRow[];
      return rows.map((r) => ({
        coin: r.coin,
        timestamp: r.timestamp,
        funding_rate: r.funding_rate,
      }));
    } catch (err) {
      log.error('getFundingRates failed', {
        coin,
        startTime,
        endTime,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Check if the database has funding rate coverage for a coin within a time range.
   * Returns true if there is at least one record at or before startTime and
   * at least one record at or after endTime for the given coin.
   */
  hasCoverage(coin: string, startTime: number, endTime: number): boolean {
    if (!this.db) return false;
    try {
      // Check if we have data covering the start of the range
      const startStmt = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM funding_rates
        WHERE coin = ? AND timestamp <= ?
      `);
      const startRow = startStmt.get(coin, startTime) as { cnt: number } | undefined;
      if (!startRow || startRow.cnt === 0) return false;

      // Check if we have data covering the end of the range
      const endStmt = this.db.prepare(`
        SELECT COUNT(*) as cnt FROM funding_rates
        WHERE coin = ? AND timestamp >= ?
      `);
      const endRow = endStmt.get(coin, endTime) as { cnt: number } | undefined;
      if (!endRow || endRow.cnt === 0) return false;

      return true;
    } catch (err) {
      log.error('hasCoverage failed', {
        coin,
        startTime,
        endTime,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Backtest Results
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert a backtest result row.
   * BigInt fields are stored as TEXT strings in SQLite.
   */
  insertBacktestResult(result: BacktestResultRow): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO backtest_results (
          run_id, created_at, coin, capital_usdc, net_pnl, gross_funding,
          total_costs, alpha, max_drawdown_bps, liquidation_count,
          stress_events, hours_simulated, verdict, cost_scenario, evidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        result.run_id,
        result.created_at,
        result.coin,
        result.capital_usdc.toString(),
        result.net_pnl.toString(),
        result.gross_funding.toString(),
        result.total_costs.toString(),
        result.alpha.toString(),
        result.max_drawdown_bps,
        result.liquidation_count,
        result.stress_events,
        result.hours_simulated,
        result.verdict,
        result.cost_scenario,
        result.evidence,
      );
    } catch (err) {
      log.error('insertBacktestResult failed', {
        run_id: result.run_id,
        coin: result.coin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get the latest backtest results (most recent run_id).
   * Returns all rows from the most recent run.
   */
  getLatestResults(): BacktestResultRow[] {
    if (!this.db) return [];
    try {
      // Find the most recent run_id
      const latestStmt = this.db.prepare(`
        SELECT run_id FROM backtest_results
        ORDER BY created_at DESC
        LIMIT 1
      `);
      const latestRow = latestStmt.get() as { run_id: string } | undefined;
      if (!latestRow) return [];

      // Get all results for that run
      const stmt = this.db.prepare(`
        SELECT * FROM backtest_results WHERE run_id = ?
        ORDER BY coin ASC, cost_scenario ASC, capital_usdc ASC
      `);
      const rows = stmt.all(latestRow.run_id) as RawBacktestResultRow[];
      return rows.map((r) => this.deserializeBacktestResult(r));
    } catch (err) {
      log.error('getLatestResults failed', {
        error: err instanceof Error ? err.message : String(err),
      });
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
    if (!this.db) return;
    try {
      this.db.close();
      this.db = null;
      log.info('FundingDatabase closed');
    } catch (err) {
      log.error('FundingDatabase close failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private deserializeBacktestResult(row: RawBacktestResultRow): BacktestResultRow {
    return {
      run_id: row.run_id,
      created_at: row.created_at,
      coin: row.coin,
      capital_usdc: BigInt(row.capital_usdc),
      net_pnl: BigInt(row.net_pnl),
      gross_funding: BigInt(row.gross_funding),
      total_costs: BigInt(row.total_costs),
      alpha: BigInt(row.alpha),
      max_drawdown_bps: row.max_drawdown_bps,
      liquidation_count: row.liquidation_count,
      stress_events: row.stress_events,
      hours_simulated: row.hours_simulated,
      verdict: row.verdict as 'VIABLE' | 'UNVIABLE',
      cost_scenario: row.cost_scenario as 'optimistic' | 'pessimistic',
      evidence: row.evidence,
    };
  }
}

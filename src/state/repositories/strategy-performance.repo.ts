/**
 * Repository for the `strategy_performance` and `strategy_events` tables.
 * Tracks per-strategy revenue, costs, and execution outcomes.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface StrategyPerformanceRow {
  source: string;
  total_revenue_usdc: string;
  total_costs_usdc: string;
  net_pnl_usdc: string;
  execution_count: number;
  success_count: number;
  last_executed_at: number | null;
  enabled: number;
  disabled_at: number | null;
  disabled_reason: string | null;
  trial_mode: number;
  consecutive_loss_days: number;
  created_at: number;
  updated_at: number;
}

export interface StrategyEventRow {
  id: string;
  source: string;
  event_type: string;
  amount_usdc: string | null;
  success: number | null;
  reference_id: string | null;
  recorded_at: number;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface UpsertStrategyPerformanceInput {
  source: string;
  total_revenue_usdc?: string;
  total_costs_usdc?: string;
  net_pnl_usdc?: string;
  execution_count?: number;
  success_count?: number;
  last_executed_at?: number | null;
  enabled?: number;
  disabled_at?: number | null;
  disabled_reason?: string | null;
  trial_mode?: number;
  consecutive_loss_days?: number;
}

export interface InsertStrategyEventInput {
  id: string;
  source: string;
  event_type: 'revenue' | 'cost' | 'execution';
  amount_usdc?: string | null;
  success?: number | null;
  reference_id?: string | null;
  recorded_at?: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class StrategyPerformanceRepository {
  constructor(private readonly db: Database) {}

  upsert(source: string, data: Partial<UpsertStrategyPerformanceInput>): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT INTO strategy_performance
          (source, total_revenue_usdc, total_costs_usdc, net_pnl_usdc,
           execution_count, success_count, last_executed_at, enabled,
           disabled_at, disabled_reason, trial_mode, consecutive_loss_days,
           created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source) DO UPDATE SET
          total_revenue_usdc = ?,
          total_costs_usdc = ?,
          net_pnl_usdc = ?,
          execution_count = ?,
          success_count = ?,
          last_executed_at = ?,
          enabled = ?,
          disabled_at = ?,
          disabled_reason = ?,
          trial_mode = ?,
          consecutive_loss_days = ?,
          updated_at = ?
      `)
      .run(
        source,
        data.total_revenue_usdc ?? '0',
        data.total_costs_usdc ?? '0',
        data.net_pnl_usdc ?? '0',
        data.execution_count ?? 0,
        data.success_count ?? 0,
        data.last_executed_at ?? null,
        data.enabled ?? 1,
        data.disabled_at ?? null,
        data.disabled_reason ?? null,
        data.trial_mode ?? 0,
        data.consecutive_loss_days ?? 0,
        now,
        now,
        // ON CONFLICT UPDATE values
        data.total_revenue_usdc ?? '0',
        data.total_costs_usdc ?? '0',
        data.net_pnl_usdc ?? '0',
        data.execution_count ?? 0,
        data.success_count ?? 0,
        data.last_executed_at ?? null,
        data.enabled ?? 1,
        data.disabled_at ?? null,
        data.disabled_reason ?? null,
        data.trial_mode ?? 0,
        data.consecutive_loss_days ?? 0,
        now,
      );
  }

  getBySource(source: string): StrategyPerformanceRow | null {
    const row = this.db
      .prepare<[string], StrategyPerformanceRow>(
        'SELECT * FROM strategy_performance WHERE source = ?'
      )
      .get(source) as StrategyPerformanceRow | undefined;
    return row ?? null;
  }

  getAll(): StrategyPerformanceRow[] {
    return this.db
      .prepare<[], StrategyPerformanceRow>('SELECT * FROM strategy_performance')
      .all() as StrategyPerformanceRow[];
  }

  insertEvent(event: InsertStrategyEventInput): void {
    this.db
      .prepare<
        [string, string, string, string | null, number | null, string | null, number]
      >(`
        INSERT INTO strategy_events
          (id, source, event_type, amount_usdc, success, reference_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.id,
        event.source,
        event.event_type,
        event.amount_usdc ?? null,
        event.success ?? null,
        event.reference_id ?? null,
        event.recorded_at ?? Date.now(),
      );
  }

  getEventsBySource(source: string, sinceTimestamp: number): StrategyEventRow[] {
    return this.db
      .prepare<[string, number], StrategyEventRow>(
        'SELECT * FROM strategy_events WHERE source = ? AND recorded_at >= ? ORDER BY recorded_at ASC'
      )
      .all(source, sinceTimestamp) as StrategyEventRow[];
  }

  getDailyPnl(source: string, days: number): { date: string; pnl: string }[] {
    const sinceTimestamp = Date.now() - days * 24 * 60 * 60 * 1000;
    return this.db
      .prepare<[string, number], { date: string; pnl: string }>(`
        SELECT
          date(recorded_at / 1000, 'unixepoch') AS date,
          CAST(
            SUM(CASE WHEN event_type = 'revenue' THEN CAST(amount_usdc AS REAL) ELSE 0 END) -
            SUM(CASE WHEN event_type = 'cost' THEN CAST(amount_usdc AS REAL) ELSE 0 END)
          AS TEXT) AS pnl
        FROM strategy_events
        WHERE source = ? AND recorded_at >= ?
        GROUP BY date(recorded_at / 1000, 'unixepoch')
        ORDER BY date ASC
      `)
      .all(source, sinceTimestamp) as { date: string; pnl: string }[];
  }
}

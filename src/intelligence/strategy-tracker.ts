/**
 * Strategy Performance Tracker
 *
 * Tracks revenue, costs, and execution outcomes for each income strategy.
 * Provides rankings for the ReAct loop context and auto-disables
 * strategies that underperform over consecutive days.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { randomUUID } from 'node:crypto';
import type {
  StrategyPerformanceRepository,
  StrategyPerformanceRow,
} from '../state/repositories/strategy-performance.repo.js';
import type { StrategyTrackerConfig } from '../config/income-sustainability.config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type StrategySource =
  | 'trading_uniswap'
  | 'aave_lending'
  | 'lp_stablecoin'
  | 'hyperliquid_perps'
  | 'marketplace'
  | 'services_x402';

export interface StrategyPerformance {
  source: StrategySource;
  totalRevenueUsdc: bigint;
  totalCostsUsdc: bigint;
  netPnlUsdc: bigint;
  executionCount: number;
  successCount: number;
  successRate: number;
  pnlPerDayUsdc: bigint;
  lastExecutedAt: number;
  enabled: boolean;
  disabledAt: number | null;
  disabledReason: string | null;
  trialMode: boolean;
  consecutiveLossDays: number;
}

export interface StrategyRanking {
  top: StrategyPerformance[];
  bottom: StrategyPerformance[];
}

export interface IStrategyTracker {
  recordRevenue(source: StrategySource, amountUsdc: bigint, referenceId?: string): void;
  recordCost(source: StrategySource, amountUsdc: bigint, referenceId?: string): void;
  recordExecution(source: StrategySource, success: boolean): void;
  getPerformance(source: StrategySource): StrategyPerformance;
  getRankings(): StrategyRanking;
  evaluateAndDisable(): { disabled: StrategySource[]; reasons: string[] };
  reenableInTrialMode(source: StrategySource): void;
  isEnabled(source: StrategySource): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// All known strategy sources
// ═══════════════════════════════════════════════════════════════════════════════

const ALL_SOURCES: StrategySource[] = [
  'trading_uniswap',
  'aave_lending',
  'lp_stablecoin',
  'hyperliquid_perps',
  'marketplace',
  'services_x402',
];

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class StrategyTracker implements IStrategyTracker {
  constructor(
    private readonly repo: StrategyPerformanceRepository,
    private readonly config: StrategyTrackerConfig,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Record revenue event and update aggregates (Req 8.1)
  // ─────────────────────────────────────────────────────────────────────────

  recordRevenue(source: StrategySource, amountUsdc: bigint, referenceId?: string): void {
    // Insert the revenue event
    this.repo.insertEvent({
      id: randomUUID(),
      source,
      event_type: 'revenue',
      amount_usdc: amountUsdc.toString(),
      reference_id: referenceId ?? null,
    });

    // Update the aggregate
    const existing = this.repo.getBySource(source);
    const totalRevenue = BigInt(existing?.total_revenue_usdc ?? '0') + amountUsdc;
    const totalCosts = BigInt(existing?.total_costs_usdc ?? '0');
    const netPnl = totalRevenue - totalCosts;

    this.repo.upsert(source, {
      total_revenue_usdc: totalRevenue.toString(),
      total_costs_usdc: totalCosts.toString(),
      net_pnl_usdc: netPnl.toString(),
      execution_count: existing?.execution_count ?? 0,
      success_count: existing?.success_count ?? 0,
      last_executed_at: existing?.last_executed_at ?? null,
      enabled: existing?.enabled ?? 1,
      disabled_at: existing?.disabled_at ?? null,
      disabled_reason: existing?.disabled_reason ?? null,
      trial_mode: existing?.trial_mode ?? 0,
      consecutive_loss_days: existing?.consecutive_loss_days ?? 0,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Record cost event and update aggregates (Req 8.1)
  // ─────────────────────────────────────────────────────────────────────────

  recordCost(source: StrategySource, amountUsdc: bigint, referenceId?: string): void {
    // Insert the cost event
    this.repo.insertEvent({
      id: randomUUID(),
      source,
      event_type: 'cost',
      amount_usdc: amountUsdc.toString(),
      reference_id: referenceId ?? null,
    });

    // Update the aggregate
    const existing = this.repo.getBySource(source);
    const totalRevenue = BigInt(existing?.total_revenue_usdc ?? '0');
    const totalCosts = BigInt(existing?.total_costs_usdc ?? '0') + amountUsdc;
    const netPnl = totalRevenue - totalCosts;

    this.repo.upsert(source, {
      total_revenue_usdc: totalRevenue.toString(),
      total_costs_usdc: totalCosts.toString(),
      net_pnl_usdc: netPnl.toString(),
      execution_count: existing?.execution_count ?? 0,
      success_count: existing?.success_count ?? 0,
      last_executed_at: existing?.last_executed_at ?? null,
      enabled: existing?.enabled ?? 1,
      disabled_at: existing?.disabled_at ?? null,
      disabled_reason: existing?.disabled_reason ?? null,
      trial_mode: existing?.trial_mode ?? 0,
      consecutive_loss_days: existing?.consecutive_loss_days ?? 0,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Record execution outcome (Req 8.1)
  // ─────────────────────────────────────────────────────────────────────────

  recordExecution(source: StrategySource, success: boolean): void {
    const now = Date.now();

    // Insert the execution event
    this.repo.insertEvent({
      id: randomUUID(),
      source,
      event_type: 'execution',
      success: success ? 1 : 0,
    });

    // Update counters
    const existing = this.repo.getBySource(source);
    const executionCount = (existing?.execution_count ?? 0) + 1;
    const successCount = (existing?.success_count ?? 0) + (success ? 1 : 0);

    this.repo.upsert(source, {
      total_revenue_usdc: existing?.total_revenue_usdc ?? '0',
      total_costs_usdc: existing?.total_costs_usdc ?? '0',
      net_pnl_usdc: existing?.net_pnl_usdc ?? '0',
      execution_count: executionCount,
      success_count: successCount,
      last_executed_at: now,
      enabled: existing?.enabled ?? 1,
      disabled_at: existing?.disabled_at ?? null,
      disabled_reason: existing?.disabled_reason ?? null,
      trial_mode: existing?.trial_mode ?? 0,
      consecutive_loss_days: existing?.consecutive_loss_days ?? 0,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Get performance for a single strategy
  // ─────────────────────────────────────────────────────────────────────────

  getPerformance(source: StrategySource): StrategyPerformance {
    const row = this.repo.getBySource(source);
    return this.rowToPerformance(source, row);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Get rankings — top 5 and bottom 2 by pnlPerDayUsdc (Req 8.4, 8.5)
  // ─────────────────────────────────────────────────────────────────────────

  getRankings(): StrategyRanking {
    const allRows = this.repo.getAll();
    const performances = ALL_SOURCES.map((source) => {
      const row = allRows.find((r) => r.source === source) ?? null;
      return this.rowToPerformance(source, row);
    });

    // Sort by pnlPerDayUsdc descending
    const sorted = [...performances].sort((a, b) => {
      if (a.pnlPerDayUsdc > b.pnlPerDayUsdc) return -1;
      if (a.pnlPerDayUsdc < b.pnlPerDayUsdc) return 1;
      return 0;
    });

    return {
      top: sorted.slice(0, 5),
      bottom: sorted.slice(-2),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Evaluate and disable underperforming strategies (Req 8.2)
  // ─────────────────────────────────────────────────────────────────────────

  evaluateAndDisable(): { disabled: StrategySource[]; reasons: string[] } {
    const disabled: StrategySource[] = [];
    const reasons: string[] = [];
    const threshold = this.config.disableAfterDays;

    for (const source of ALL_SOURCES) {
      const existing = this.repo.getBySource(source);
      // Skip already disabled strategies
      if (existing && existing.enabled === 0) continue;

      // Get daily PnL for the last `disableAfterDays` days
      const dailyPnl = this.repo.getDailyPnl(source, threshold);

      // Count consecutive negative days from most recent
      const consecutiveLossDays = this.countConsecutiveLossDays(dailyPnl);

      // Update the consecutive_loss_days field
      if (existing) {
        this.repo.upsert(source, {
          total_revenue_usdc: existing.total_revenue_usdc,
          total_costs_usdc: existing.total_costs_usdc,
          net_pnl_usdc: existing.net_pnl_usdc,
          execution_count: existing.execution_count,
          success_count: existing.success_count,
          last_executed_at: existing.last_executed_at,
          enabled: existing.enabled,
          disabled_at: existing.disabled_at,
          disabled_reason: existing.disabled_reason,
          trial_mode: existing.trial_mode,
          consecutive_loss_days: consecutiveLossDays,
        });
      }

      // Disable if exceeds threshold
      if (consecutiveLossDays >= threshold) {
        const now = Date.now();
        const reason = `Disabled: ${consecutiveLossDays} consecutive loss days (threshold: ${threshold})`;

        this.repo.upsert(source, {
          total_revenue_usdc: existing?.total_revenue_usdc ?? '0',
          total_costs_usdc: existing?.total_costs_usdc ?? '0',
          net_pnl_usdc: existing?.net_pnl_usdc ?? '0',
          execution_count: existing?.execution_count ?? 0,
          success_count: existing?.success_count ?? 0,
          last_executed_at: existing?.last_executed_at ?? null,
          enabled: 0,
          disabled_at: now,
          disabled_reason: reason,
          trial_mode: 0,
          consecutive_loss_days: consecutiveLossDays,
        });

        disabled.push(source);
        reasons.push(reason);
      }
    }

    return { disabled, reasons };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Re-enable in trial mode after cooldown (Req 8.3)
  // ─────────────────────────────────────────────────────────────────────────

  reenableInTrialMode(source: StrategySource): void {
    const existing = this.repo.getBySource(source);

    // Only re-enable if currently disabled and cooldown has passed
    if (!existing || existing.enabled === 1) return;

    const cooldownMs = this.config.cooldownDays * 24 * 60 * 60 * 1000;
    const disabledAt = existing.disabled_at ?? 0;
    const now = Date.now();

    if (now - disabledAt < cooldownMs) return;

    this.repo.upsert(source, {
      total_revenue_usdc: existing.total_revenue_usdc,
      total_costs_usdc: existing.total_costs_usdc,
      net_pnl_usdc: existing.net_pnl_usdc,
      execution_count: existing.execution_count,
      success_count: existing.success_count,
      last_executed_at: existing.last_executed_at,
      enabled: 1,
      disabled_at: null,
      disabled_reason: null,
      trial_mode: 1,
      consecutive_loss_days: 0,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check if a strategy is currently enabled
  // ─────────────────────────────────────────────────────────────────────────

  isEnabled(source: StrategySource): boolean {
    const existing = this.repo.getBySource(source);
    // Default to enabled if no record exists yet
    if (!existing) return true;
    return existing.enabled === 1;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Convert a database row to a StrategyPerformance object.
   * Returns sensible defaults for a source with no recorded data.
   */
  private rowToPerformance(
    source: StrategySource,
    row: StrategyPerformanceRow | null,
  ): StrategyPerformance {
    if (!row) {
      return {
        source,
        totalRevenueUsdc: 0n,
        totalCostsUsdc: 0n,
        netPnlUsdc: 0n,
        executionCount: 0,
        successCount: 0,
        successRate: 0,
        pnlPerDayUsdc: 0n,
        lastExecutedAt: 0,
        enabled: true,
        disabledAt: null,
        disabledReason: null,
        trialMode: false,
        consecutiveLossDays: 0,
      };
    }

    const totalRevenue = BigInt(row.total_revenue_usdc);
    const totalCosts = BigInt(row.total_costs_usdc);
    const netPnl = BigInt(row.net_pnl_usdc);
    const executionCount = row.execution_count;
    const successCount = row.success_count;
    const successRate = executionCount > 0 ? successCount / executionCount : 0;

    // Calculate average PnL per day based on time since first event
    const pnlPerDayUsdc = this.calculatePnlPerDay(netPnl, row.created_at);

    return {
      source,
      totalRevenueUsdc: totalRevenue,
      totalCostsUsdc: totalCosts,
      netPnlUsdc: netPnl,
      executionCount,
      successCount,
      successRate,
      pnlPerDayUsdc,
      lastExecutedAt: row.last_executed_at ?? 0,
      enabled: row.enabled === 1,
      disabledAt: row.disabled_at,
      disabledReason: row.disabled_reason,
      trialMode: row.trial_mode === 1,
      consecutiveLossDays: row.consecutive_loss_days,
    };
  }

  /**
   * Calculate average P&L per day since tracking began.
   */
  private calculatePnlPerDay(netPnl: bigint, createdAt: number): bigint {
    const now = Date.now();
    const elapsedMs = now - createdAt;
    const elapsedDays = elapsedMs / (24 * 60 * 60 * 1000);

    if (elapsedDays < 1) return netPnl;
    return netPnl / BigInt(Math.floor(elapsedDays));
  }

  /**
   * Count consecutive loss days from most recent date backwards.
   */
  private countConsecutiveLossDays(
    dailyPnl: { date: string; pnl: string }[],
  ): number {
    if (dailyPnl.length === 0) return 0;

    let count = 0;
    // Iterate from most recent day backwards
    for (let i = dailyPnl.length - 1; i >= 0; i--) {
      const pnl = parseFloat(dailyPnl[i]!.pnl);
      if (pnl < 0) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }
}

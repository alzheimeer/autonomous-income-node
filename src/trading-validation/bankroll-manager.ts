/**
 * Trading Validation Phase - BankrollManager
 *
 * Implements IBankrollManager with SQLite persistence.
 * Logical split: $25 active / $74.63 reserve in the same wallet.
 * All USDC amounts are BigInt with 6 decimal precision (1_000000n = $1.00).
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, E9
 */

import type { TradingDatabase } from './db.js';
import type { BankrollState, UsdcAmount } from './types.js';
import type { BankrollManagerConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interface
// ═══════════════════════════════════════════════════════════════════════════

export interface IBankrollManager {
  getState(): BankrollState;
  canTrade(size: UsdcAmount): boolean;
  allocateLoss(amount: UsdcAmount): void;
  allocateProfit(amount: UsdcAmount): void;
  recordGas(gasUsd: UsdcAmount): void;
  checkSweep(): void;
  promoteReserve(amount: UsdcAmount): void;
  getAvailableForTrading(): UsdcAmount;
  resetDaily(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns the current UTC date as 'YYYY-MM-DD'.
 */
function getUtcDay(): string {
  const now = new Date();
  return now.toISOString().slice(0, 10);
}

/**
 * BankrollManager manages the logical active/reserve split within the same wallet.
 *
 * - Active capital is used for trading; losses deducted from active first.
 * - Reserve is never touched unless explicitly promoted by operator.
 * - Sweep condition: active grows > 20% AND excess > $5 → move excess to reserve.
 * - Low-total formula: if total < $80 → active = min($20, 25% of total).
 * - Daily reset at UTC midnight for daily_realized_pnl and daily_gas_spent.
 */
export class BankrollManager implements IBankrollManager {
  private readonly db: TradingDatabase;
  private readonly config: BankrollManagerConfig;

  constructor(db: TradingDatabase, config: BankrollManagerConfig) {
    this.db = db;
    this.config = config;
    this.ensureInitialized();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Ensures a bankroll row exists in the database. If not, seeds with config defaults.
   */
  private ensureInitialized(): void {
    const row = this.db.prepare('SELECT id FROM bankroll WHERE id = 1').get();
    if (!row) {
      const now = Date.now();
      const dayUtc = getUtcDay();
      this.db.prepare(`
        INSERT INTO bankroll (id, total_usdc, active_usdc, reserve_usdc, daily_realized_pnl, daily_gas_spent, experiment_total_pnl, day_start_bankroll, day_utc, updated_at)
        VALUES (1, ?, ?, ?, '0', '0', '0', ?, ?, ?)
      `).run(
        this.config.initialTotal.toString(),
        this.config.initialActive.toString(),
        this.config.initialReserve.toString(),
        this.config.initialTotal.toString(),
        dayUtc,
        now,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State Access
  // ─────────────────────────────────────────────────────────────────────────

  getState(): BankrollState {
    this.checkDayRollover();
    const row = this.db.prepare('SELECT * FROM bankroll WHERE id = 1').get() as BankrollRow;
    return this.rowToState(row);
  }

  getAvailableForTrading(): UsdcAmount {
    const state = this.getState();
    if (state.activeUsdc < this.config.minActive) {
      return 0n;
    }
    return state.activeUsdc;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Trading Eligibility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reject if size > available active or if active < min_active ($5).
   * Requirement 2.4, 2.5
   */
  canTrade(size: UsdcAmount): boolean {
    const state = this.getState();
    if (state.activeUsdc < this.config.minActive) {
      return false;
    }
    if (size > state.activeUsdc) {
      return false;
    }
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Loss / Profit Allocation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deduct loss from active first, never touch reserve.
   * Requirement 2.3
   */
  allocateLoss(amount: UsdcAmount): void {
    if (amount <= 0n) return;

    this.checkDayRollover();
    const row = this.db.prepare('SELECT * FROM bankroll WHERE id = 1').get() as BankrollRow;
    let active = BigInt(row.active_usdc);
    const reserve = BigInt(row.reserve_usdc);
    const dailyPnl = BigInt(row.daily_realized_pnl);
    const experimentPnl = BigInt(row.experiment_total_pnl);

    // Deduct from active; clamp at 0 (never go negative, never touch reserve)
    active = active > amount ? active - amount : 0n;
    const total = active + reserve;

    // Apply low-total formula if needed
    const adjustedActive = this.applyLowTotalFormula(active, total);
    const adjustedReserve = total - adjustedActive;

    const now = Date.now();
    this.db.prepare(`
      UPDATE bankroll SET
        total_usdc = ?,
        active_usdc = ?,
        reserve_usdc = ?,
        daily_realized_pnl = ?,
        experiment_total_pnl = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      total.toString(),
      adjustedActive.toString(),
      adjustedReserve.toString(),
      (dailyPnl - amount).toString(),
      (experimentPnl - amount).toString(),
      now,
    );
  }

  /**
   * Add profit to active, then check sweep condition.
   * Requirement 2.8
   */
  allocateProfit(amount: UsdcAmount): void {
    if (amount <= 0n) return;

    this.checkDayRollover();
    const row = this.db.prepare('SELECT * FROM bankroll WHERE id = 1').get() as BankrollRow;
    let active = BigInt(row.active_usdc) + amount;
    const reserve = BigInt(row.reserve_usdc);
    const dailyPnl = BigInt(row.daily_realized_pnl);
    const experimentPnl = BigInt(row.experiment_total_pnl);
    const total = active + reserve;

    const now = Date.now();
    this.db.prepare(`
      UPDATE bankroll SET
        total_usdc = ?,
        active_usdc = ?,
        reserve_usdc = ?,
        daily_realized_pnl = ?,
        experiment_total_pnl = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      total.toString(),
      active.toString(),
      reserve.toString(),
      (dailyPnl + amount).toString(),
      (experimentPnl + amount).toString(),
      now,
    );

    // Check sweep after profit
    this.checkSweep();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Gas Recording
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record gas spending in USDC equivalent. Deducted from active.
   */
  recordGas(gasUsd: UsdcAmount): void {
    if (gasUsd <= 0n) return;

    this.checkDayRollover();
    const row = this.db.prepare('SELECT * FROM bankroll WHERE id = 1').get() as BankrollRow;
    let active = BigInt(row.active_usdc);
    const reserve = BigInt(row.reserve_usdc);
    const dailyGas = BigInt(row.daily_gas_spent);

    // Deduct gas from active
    active = active > gasUsd ? active - gasUsd : 0n;
    const total = active + reserve;

    const adjustedActive = this.applyLowTotalFormula(active, total);
    const adjustedReserve = total - adjustedActive;

    const now = Date.now();
    this.db.prepare(`
      UPDATE bankroll SET
        total_usdc = ?,
        active_usdc = ?,
        reserve_usdc = ?,
        daily_gas_spent = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      total.toString(),
      adjustedActive.toString(),
      adjustedReserve.toString(),
      (dailyGas + gasUsd).toString(),
      now,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Sweep Logic
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * If active grows > 20% above initial AND excess > $5, sweep excess to reserve.
   * Requirement 2.8
   */
  checkSweep(): void {
    const row = this.db.prepare('SELECT * FROM bankroll WHERE id = 1').get() as BankrollRow;
    let active = BigInt(row.active_usdc);
    let reserve = BigInt(row.reserve_usdc);

    const initialActive = this.config.initialActive;
    const threshold = initialActive + BigInt(Math.floor(Number(initialActive) * this.config.sweepThresholdPct));
    const excess = active - threshold;

    if (active > threshold && excess > this.config.sweepMinExcess) {
      // Sweep excess to reserve
      active = active - excess;
      reserve = reserve + excess;

      const total = active + reserve;
      const now = Date.now();
      this.db.prepare(`
        UPDATE bankroll SET
          total_usdc = ?,
          active_usdc = ?,
          reserve_usdc = ?,
          updated_at = ?
        WHERE id = 1
      `).run(
        total.toString(),
        active.toString(),
        reserve.toString(),
        now,
      );

      this.logEvent('sweep_to_reserve', {
        amount: excess.toString(),
        newActive: active.toString(),
        newReserve: reserve.toString(),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Promote Reserve (Privileged)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Privileged operation: move funds from reserve to active.
   * Requirement 2.7
   */
  promoteReserve(amount: UsdcAmount): void {
    if (amount <= 0n) return;

    const row = this.db.prepare('SELECT * FROM bankroll WHERE id = 1').get() as BankrollRow;
    let active = BigInt(row.active_usdc);
    let reserve = BigInt(row.reserve_usdc);

    if (amount > reserve) {
      throw new Error(`Cannot promote ${amount} from reserve: only ${reserve} available`);
    }

    reserve = reserve - amount;
    active = active + amount;
    const total = active + reserve;

    const now = Date.now();
    this.db.prepare(`
      UPDATE bankroll SET
        total_usdc = ?,
        active_usdc = ?,
        reserve_usdc = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      total.toString(),
      active.toString(),
      reserve.toString(),
      now,
    );

    this.logEvent('promote_reserve', {
      amount: amount.toString(),
      newActive: active.toString(),
      newReserve: reserve.toString(),
      timestamp: new Date().toISOString(),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Daily Reset
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Reset daily_realized_pnl and daily_gas_spent at UTC midnight.
   * Called automatically when the day changes.
   */
  resetDaily(): void {
    const row = this.db.prepare('SELECT * FROM bankroll WHERE id = 1').get() as BankrollRow;
    const total = BigInt(row.total_usdc);
    const dayUtc = getUtcDay();
    const now = Date.now();

    this.db.prepare(`
      UPDATE bankroll SET
        daily_realized_pnl = '0',
        daily_gas_spent = '0',
        day_start_bankroll = ?,
        day_utc = ?,
        updated_at = ?
      WHERE id = 1
    `).run(
      total.toString(),
      dayUtc,
      now,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Checks if the current UTC day differs from the stored day. If so, resets daily counters.
   */
  private checkDayRollover(): void {
    const row = this.db.prepare('SELECT day_utc FROM bankroll WHERE id = 1').get() as { day_utc: string } | undefined;
    if (!row) return;

    const today = getUtcDay();
    if (row.day_utc !== today) {
      this.resetDaily();
    }
  }

  /**
   * Low-total formula: if total < $80, active = min($20, 25% of total).
   * Requirement 2.6
   */
  private applyLowTotalFormula(currentActive: UsdcAmount, total: UsdcAmount): UsdcAmount {
    if (total < this.config.lowTotalThreshold) {
      const twentyDollars = 20_000000n;
      const quarterOfTotal = total / 4n; // 25% of total
      const maxActive = twentyDollars < quarterOfTotal ? twentyDollars : quarterOfTotal;
      // Don't increase active beyond what's available; only reduce
      return currentActive < maxActive ? currentActive : maxActive;
    }
    return currentActive;
  }

  /**
   * Log an event to the event_log table.
   */
  private logEvent(eventType: string, details: Record<string, string>): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO event_log (event_type, details, timestamp)
      VALUES (?, ?, ?)
    `).run(eventType, JSON.stringify(details), now);
  }

  /**
   * Convert a database row to BankrollState.
   */
  private rowToState(row: BankrollRow): BankrollState {
    return {
      totalUsdc: BigInt(row.total_usdc),
      activeUsdc: BigInt(row.active_usdc),
      reserveUsdc: BigInt(row.reserve_usdc),
      unrealizedPnl: 0n, // Managed externally by position tracking
      dailyRealizedPnl: BigInt(row.daily_realized_pnl),
      dailyGasSpent: BigInt(row.daily_gas_spent),
      experimentTotalPnl: BigInt(row.experiment_total_pnl),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal Types
// ═══════════════════════════════════════════════════════════════════════════

interface BankrollRow {
  id: number;
  total_usdc: string;
  active_usdc: string;
  reserve_usdc: string;
  daily_realized_pnl: string;
  daily_gas_spent: string;
  experiment_total_pnl: string;
  day_start_bankroll: string;
  day_utc: string;
  updated_at: number;
}

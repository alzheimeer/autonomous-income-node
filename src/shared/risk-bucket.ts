/**
 * Shared — RiskBucket
 *
 * Manages the logical $15 USDC budget and the Circuit Breaker mechanism.
 *
 * Pure module — no external dependencies (no ethers, no SQLite, no axios).
 *
 * Features:
 *   - Trade budget: floor(riskBudgetUsdc / tradeSizeUsdc)
 *   - Circuit Breaker: activated after `maxLossStreak` consecutive SL_HITs
 *   - Auto-reset: CB deactivates automatically when blockedUntil expires
 *   - _overrideNow(ts): test-only hook to advance mock clock
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7
 *
 * @module shared/risk-bucket
 */

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface CircuitBreakerState {
  /** true while now() < blockedUntil */
  active: boolean;
  /** Timestamp (ms) when CB expires, or null if not active */
  blockedUntil: number | null;
  /** Number of consecutive SL_HIT results since last reset */
  consecutiveLosses: number;
}

export interface IRiskBucket {
  /** Returns number of available trades. Returns 0 when CB is active.
   *  @param openPositions - number of currently open positions to deduct from the budget
   */
  availableTrades(openPositions?: number): number;
  /** Must be called by ShadowExecutor when a position is closed */
  onPositionClosed(result: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP' | 'RUG_PULL'): void;
  /** Returns a snapshot of the current CircuitBreaker state */
  getState(): CircuitBreakerState;
  /** Resets consecutiveLosses and deactivates CB (for testing / manual reset) */
  reset(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// RiskBucket
// ═══════════════════════════════════════════════════════════════════════════

/**
 * RiskBucket manages the logical trading budget and Circuit Breaker.
 *
 * Config is read from environment variables at construction time:
 *   - SNIPER_RISK_BUDGET_USDC  (default: 15)
 *   - SNIPER_TRADE_SIZE_USDC   (default: 5)
 *   - SNIPER_MAX_LOSS_STREAK   (default: 2)
 */
export class RiskBucket implements IRiskBucket {
  private readonly riskBudgetUsdc: number;
  private readonly tradeSizeUsdc: number;
  private readonly maxLossStreak: number;

  private consecutiveLosses: number = 0;
  private blockedUntil: number | null = null;

  /**
   * Internal clock function. Replaced by `_overrideNow` in tests only.
   * In production this is always `Date.now`.
   */
  private nowFn: () => number = Date.now.bind(Date);

  constructor(env: Record<string, string | undefined> = {}) {
    const budget = parseFloat(env['SNIPER_RISK_BUDGET_USDC'] ?? '');
    const tradeSize = parseFloat(env['SNIPER_TRADE_SIZE_USDC'] ?? '');
    const maxStreak = parseInt(env['SNIPER_MAX_LOSS_STREAK'] ?? '', 10);

    this.riskBudgetUsdc = isFinite(budget) && budget > 0 ? budget : 15;
    this.tradeSizeUsdc = isFinite(tradeSize) && tradeSize > 0 ? tradeSize : 5;
    this.maxLossStreak = isFinite(maxStreak) && maxStreak > 0 ? maxStreak : 2;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // IRiskBucket implementation
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the number of available trades.
   *
   * - If CB is active (now < blockedUntil): returns 0.
   * - If CB has expired (now >= blockedUntil): auto-resets state, then returns
   *   floor(riskBudgetUsdc / tradeSizeUsdc) - openPositions.
   * - If CB was never activated: returns floor(riskBudgetUsdc / tradeSizeUsdc) - openPositions.
   *
   * @param openPositions - Number of currently open positions to deduct from budget.
   *
   * Requirement 6.1, 6.5, 6.6
   */
  availableTrades(openPositions: number = 0): number {
    const now = this.nowFn();

    if (this.blockedUntil !== null) {
      if (now < this.blockedUntil) {
        // CB still active — block all trades
        return 0;
      } else {
        // CB expired — auto-reset
        this.blockedUntil = null;
        this.consecutiveLosses = 0;
      }
    }

    const maxTrades = Math.floor(this.riskBudgetUsdc / this.tradeSizeUsdc);
    return Math.max(0, maxTrades - openPositions);
  }

  /**
   * Called by ShadowExecutor when a position closes.
   *
   * - SL_HIT or RUG_PULL → consecutiveLosses++; if >= maxLossStreak → activate CB for 24h
   * - TP_HIT | TIME_STOP → reset consecutiveLosses to 0
   *
   * FIX: Added RUG_PULL handling - counts as a loss for circuit breaker purposes.
   *
   * Requirements 6.2, 6.3, 6.4
   */
  onPositionClosed(result: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP' | 'RUG_PULL'): void {
    if (result === 'SL_HIT' || result === 'RUG_PULL') {
      this.consecutiveLosses += 1;
      if (this.consecutiveLosses >= this.maxLossStreak) {
        this.blockedUntil = this.nowFn() + 86_400_000; // 24 hours in ms
      }
    } else {
      // TP_HIT or TIME_STOP — reset streak
      this.consecutiveLosses = 0;
    }
  }

  /**
   * Returns a snapshot of the current CircuitBreaker state.
   *
   * `active` reflects whether the CB is currently blocking trades,
   * i.e., blockedUntil is set AND the timestamp is still in the future.
   *
   * Requirement 6.4, 6.5
   */
  getState(): CircuitBreakerState {
    const now = this.nowFn();
    return {
      active: this.blockedUntil !== null && now < this.blockedUntil,
      blockedUntil: this.blockedUntil,
      consecutiveLosses: this.consecutiveLosses,
    };
  }

  /**
   * Resets the Circuit Breaker state and loss counter.
   * Useful for testing or manual operator intervention.
   *
   * Requirement 6.6 (manual reset path)
   */
  reset(): void {
    this.consecutiveLosses = 0;
    this.blockedUntil = null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Test-only hook
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Overrides the internal clock with a fixed timestamp.
   *
   * FOR TESTS ONLY — never called in production.
   * Allows tests to simulate time advancing past `blockedUntil`.
   *
   * @param ts - The timestamp (ms) to use as "now" from this point forward.
   */
  _overrideNow(ts: number): void {
    this.nowFn = () => ts;
  }
}

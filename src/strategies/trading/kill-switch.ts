/**
 * TradingKillSwitch — Emergency stop mechanism for trading.
 *
 * Enforces hard loss limits to prevent catastrophic drawdown:
 *   - Daily loss limit: max $5 USDC per day
 *   - Total drawdown limit: max $15 USDC cumulative loss
 *
 * NEVER throws — returns triggered status for safe integration.
 * Uses BigInt for precise USDC math (6 decimals).
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface KillSwitchConfig {
  /** Maximum daily loss in USDC (6 decimals). Default: 5_000000n ($5/day) */
  maxDailyLossUsdc: bigint;
  /** Maximum total drawdown in USDC (6 decimals). Default: 15_000000n ($15 total) */
  maxTotalDrawdownUsdc: bigint;
  /** Whether the kill-switch is enabled. Default: true */
  enabled: boolean;
}

export const DEFAULT_KILL_SWITCH_CONFIG: KillSwitchConfig = {
  maxDailyLossUsdc: 5_000000n,       // $5/day max loss
  maxTotalDrawdownUsdc: 15_000000n,   // $15 total max loss
  enabled: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface KillSwitchStatus {
  triggered: boolean;
  reason?: string;
}

export interface KillSwitchState {
  dailyLoss: bigint;
  totalDrawdown: bigint;
  dailyGain: bigint;
  totalGain: bigint;
  lastResetDate: string;
  triggerCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TradingKillSwitch
// ═══════════════════════════════════════════════════════════════════════════════

export class TradingKillSwitch {
  private readonly config: KillSwitchConfig;
  private dailyLoss: bigint = 0n;
  private totalDrawdown: bigint = 0n;
  private dailyGain: bigint = 0n;
  private totalGain: bigint = 0n;
  private lastResetDate: string = '';
  private triggerCount = 0;

  constructor(config: Partial<KillSwitchConfig> = {}) {
    this.config = {
      ...DEFAULT_KILL_SWITCH_CONFIG,
      ...config,
    };
    this.lastResetDate = this.today();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record a trading loss. Amount is in USDC (6 decimals).
   * Never throws.
   */
  recordLoss(amount: bigint): void {
    if (amount <= 0n) return;

    this.resetDailyIfNeeded();
    this.dailyLoss += amount;
    this.totalDrawdown += amount;
  }

  /**
   * Record a trading gain. Used to track net P&L.
   * Gains do NOT reduce totalDrawdown (drawdown is max-loss metric).
   * Never throws.
   */
  recordGain(amount: bigint): void {
    if (amount <= 0n) return;

    this.resetDailyIfNeeded();
    this.dailyGain += amount;
    this.totalGain += amount;
  }

  /**
   * Check if the kill-switch is triggered.
   * Returns { triggered: false } if trading can continue.
   * Returns { triggered: true, reason: "..." } if trading must stop.
   * Never throws.
   */
  isTriggered(): KillSwitchStatus {
    if (!this.config.enabled) {
      return { triggered: false };
    }

    this.resetDailyIfNeeded();

    // Check daily loss limit
    if (this.dailyLoss >= this.config.maxDailyLossUsdc) {
      this.triggerCount++;
      const dailyLossFormatted = (Number(this.dailyLoss) / 1_000_000).toFixed(2);
      const maxFormatted = (Number(this.config.maxDailyLossUsdc) / 1_000_000).toFixed(2);
      return {
        triggered: true,
        reason: `Daily loss limit reached: $${dailyLossFormatted} >= $${maxFormatted}`,
      };
    }

    // Check total drawdown limit
    if (this.totalDrawdown >= this.config.maxTotalDrawdownUsdc) {
      this.triggerCount++;
      const totalFormatted = (Number(this.totalDrawdown) / 1_000_000).toFixed(2);
      const maxFormatted = (Number(this.config.maxTotalDrawdownUsdc) / 1_000_000).toFixed(2);
      return {
        triggered: true,
        reason: `Total drawdown limit reached: $${totalFormatted} >= $${maxFormatted}`,
      };
    }

    return { triggered: false };
  }

  /**
   * Reset daily counters. Called automatically at midnight,
   * but can be called manually for testing.
   */
  resetDaily(): void {
    this.dailyLoss = 0n;
    this.dailyGain = 0n;
    this.lastResetDate = this.today();
  }

  /**
   * Reset all state (use for testing or manual override).
   */
  resetAll(): void {
    this.dailyLoss = 0n;
    this.totalDrawdown = 0n;
    this.dailyGain = 0n;
    this.totalGain = 0n;
    this.triggerCount = 0;
    this.lastResetDate = this.today();
  }

  /**
   * Get current internal state (for diagnostics / daily report).
   */
  getState(): KillSwitchState {
    this.resetDailyIfNeeded();
    return {
      dailyLoss: this.dailyLoss,
      totalDrawdown: this.totalDrawdown,
      dailyGain: this.dailyGain,
      totalGain: this.totalGain,
      lastResetDate: this.lastResetDate,
      triggerCount: this.triggerCount,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private resetDailyIfNeeded(): void {
    const today = this.today();
    if (today !== this.lastResetDate) {
      this.dailyLoss = 0n;
      this.dailyGain = 0n;
      this.lastResetDate = today;
    }
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

/**
 * Trading Validation Phase - Exit Manager
 *
 * Deterministic position exit monitoring without LLM.
 * Monitors open positions via lightweight price events, independent from entry.
 * Exits triggered by: stop loss, take profit, time stop, regime exit, KillSwitch, operator, Safe_Mode.
 *
 * Exit priority (highest to lowest):
 *   KillSwitch > Safe_Mode > operator > stop_loss > time_stop > regime_exit > take_profit
 *
 * Tracks MFE (Max Favorable Excursion) and MAE (Max Adverse Excursion) during position lifetime.
 * Uses callbacks for quote/simulate/execute to avoid direct module dependencies.
 *
 * Requirements: 19.1, 19.2, 19.3, 19.4, 19.5, 19.6, 19.7, 19.8
 */

import type { Position, ExitReason, RegimeType, StrategyType, UsdcAmount } from './types.js';
import type { ExitManagerConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Position lifecycle states */
export type PositionState = 'open' | 'monitoring' | 'exit_pending' | 'closed';

/** Internal position tracking with MFE/MAE and state */
export interface TrackedPosition {
  position: Position;
  state: PositionState;
  highPrice: number;   // highest price seen (for MFE and Trailing Stop)
  lowPrice: number;    // lowest price seen (for MAE)
  mfe: number;         // max favorable excursion %
  mae: number;         // max adverse excursion %
  trailingStopPrice?: number; // Dynamic trailing stop level once +0.5% PnL is reached
}

/** Exit signal emitted when exit condition is met */
export interface ExitSignal {
  positionId: string;
  reason: ExitReason;
  currentPrice: number;
  timestamp: number;
}

/** Result of an exit attempt */
export interface ExitResult {
  success: boolean;
  reason?: string;
  txHash?: string;
}

/** Callback to get a fresh quote for exit */
export type GetQuoteCallback = (positionId: string, sizeWeth: bigint) => Promise<{ priceUsd: number; gasUsd: number }>;

/** Callback to simulate exit transaction */
export type SimulateExitCallback = (positionId: string) => Promise<{ success: boolean; reason?: string }>;

/** Callback to execute exit transaction */
export type ExecuteExitCallback = (positionId: string, reason: ExitReason) => Promise<ExitResult>;

/** Logger for exit events */
export type ExitLogger = (entry: {
  event: string;
  positionId: string;
  reason?: ExitReason;
  price?: number;
  pnlPct?: number;
  holdingDurationMs?: number;
  mfe?: number;
  mae?: number;
  details?: string;
}) => void;

/** External state checks (KillSwitch, SafeMode, operator) */
export interface ExternalStateProvider {
  isKillSwitchTriggered(): boolean;
  isSafeModeActive(): boolean;
  isOperatorExitRequested(): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exit manager interface.
 * Monitors positions and determines when to exit based on deterministic rules.
 */
export interface IExitManager {
  /** Register a new position for monitoring (Req 19.1) */
  registerPosition(position: Position): void;

  /** Check all exit conditions for the open position (Req 19.2, 19.3, 19.4, 19.5) */
  checkExits(currentPrice: number, currentRegime: RegimeType, timestamp: number): ExitSignal | null;

  /** Update MFE/MAE tracking on price update */
  onPriceUpdate(currentPrice: number): void;

  /** Get the currently open (monitored) position, or null */
  getOpenPosition(): Position | null;

  /** Whether an exit is currently pending execution */
  isExitPending(): boolean;

  /** Execute exit with retry logic (Req 19.6, 19.7) */
  executeExit(reason: ExitReason, currentPrice: number, timestamp: number): Promise<ExitResult>;

  /** Mark position as closed after successful exit */
  closePosition(exitPrice: number, exitTimestamp: number, reason: ExitReason, grossPnl: UsdcAmount, netPnl: UsdcAmount): void;

  /** Get current tracked position state (for testing/monitoring) */
  getTrackedPosition(): TrackedPosition | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exit priority order (highest priority first).
 * KillSwitch > Safe_Mode > operator > stop_loss > time_stop > regime_exit > take_profit
 */
const EXIT_PRIORITY: ExitReason[] = [
  'kill_switch',
  'safe_mode',
  'operator',
  'stop_loss',
  'time_stop',
  'regime_exit',
  'take_profit',
];

/**
 * Regime-exit rules per strategy type.
 * Trend Pullback: exits on TRENDING_DOWN, VOLATILE, UNCERTAIN (NOT RANGING)
 * Mean Reversion: exits on VOLATILE, UNCERTAIN, TRENDING_DOWN
 * Momentum Breakout: exits on TRENDING_DOWN, RANGING (momentum needs trend)
 * Dip Buying: exits on VOLATILE only (it's designed for uncertain conditions)
 */
const REGIME_EXIT_TRIGGERS: Record<StrategyType, RegimeType[]> = {
  trend_pullback: ['TRENDING_DOWN', 'VOLATILE', 'UNCERTAIN'],
  mean_reversion: ['VOLATILE', 'UNCERTAIN', 'TRENDING_DOWN'],
  momentum_breakout: ['TRENDING_DOWN', 'RANGING'],
  dip_buying: ['VOLATILE'], // Dip buying can work in most regimes except extreme volatility
};

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class ExitManager implements IExitManager {
  private readonly config: ExitManagerConfig;
  private readonly externalState: ExternalStateProvider;
  private readonly logger?: ExitLogger;
  private readonly getQuote?: GetQuoteCallback;
  private readonly simulateExit?: SimulateExitCallback;
  private readonly executeExitCb?: ExecuteExitCallback;

  private tracked: TrackedPosition | null = null;

  constructor(
    config: ExitManagerConfig,
    externalState: ExternalStateProvider,
    options?: {
      logger?: ExitLogger;
      getQuote?: GetQuoteCallback;
      simulateExit?: SimulateExitCallback;
      executeExit?: ExecuteExitCallback;
    },
  ) {
    this.config = config;
    this.externalState = externalState;
    this.logger = options?.logger;
    this.getQuote = options?.getQuote;
    this.simulateExit = options?.simulateExit;
    this.executeExitCb = options?.executeExit;
  }

  /**
   * Register a new position for monitoring.
   * Creates position record with SL, TP, max holding time, entry regime.
   *
   * Req 19.1: On entry confirmation, create position record.
   */
  registerPosition(position: Position): void {
    if (this.tracked !== null && this.tracked.state !== 'closed') {
      throw new Error(`Cannot register position: existing position ${this.tracked.position.id} is still active`);
    }

    this.tracked = {
      position: { ...position },
      state: 'monitoring',
      highPrice: position.entryPrice,
      lowPrice: position.entryPrice,
      mfe: 0,
      mae: 0,
    };

    this.log({
      event: 'position_registered',
      positionId: position.id,
      price: position.entryPrice,
      details: `SL=${position.stopLoss.toFixed(2)} TP=${position.takeProfit.toFixed(2)} maxHold=${position.maxHoldingMs}ms strategy=${position.strategy} regime=${position.entryRegime}`,
    });
  }

  /**
   * Check all exit conditions in priority order.
   * Returns the highest-priority exit signal, or null if no exit triggered.
   *
   * Priority: KillSwitch > Safe_Mode > operator > stop_loss > time_stop > regime_exit > take_profit
   *
   * Req 19.2: Monitor via lightweight price events (independent from entry).
   * Req 19.3: SL (1.5 ATR), TP (2.0 ATR), time-stop (8h), KillSwitch.
   * Req 19.4: Regime-exit for Trend Pullback.
   * Req 19.5: Regime-exit for Mean Reversion.
   */
  checkExits(currentPrice: number, currentRegime: RegimeType, timestamp: number): ExitSignal | null {
    if (!this.tracked || this.tracked.state === 'closed' || this.tracked.state === 'exit_pending') {
      return null;
    }

    // Update MFE/MAE with current price
    this.updateMfeMaeInternal(currentPrice);

    const position = this.tracked.position;

    // Check each exit condition in priority order
    for (const reason of EXIT_PRIORITY) {
      if (this.isExitTriggered(reason, currentPrice, currentRegime, timestamp)) {
        this.tracked.state = 'exit_pending';

        const signal: ExitSignal = {
          positionId: position.id,
          reason,
          currentPrice,
          timestamp,
        };

        const holdingDurationMs = timestamp - position.entryTimestamp;
        const pnlPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;

        this.log({
          event: 'exit_triggered',
          positionId: position.id,
          reason,
          price: currentPrice,
          pnlPct,
          holdingDurationMs,
          mfe: this.tracked.mfe,
          mae: this.tracked.mae,
        });

        return signal;
      }
    }

    return null;
  }

  /**
   * Update MFE/MAE on each price update.
   * MFE: highest % profit seen during position life.
   * MAE: deepest % drawdown seen during position life.
   */
  onPriceUpdate(currentPrice: number): void {
    if (!this.tracked || this.tracked.state === 'closed') {
      return;
    }
    this.updateMfeMaeInternal(currentPrice);
    
    // Calculate dynamic trailing stop: activates once PnL reaches +0.5% (0.005)
    const position = this.tracked.position;
    const pnlFraction = (this.tracked.highPrice - position.entryPrice) / position.entryPrice;
    
    if (pnlFraction >= 0.005) {
      // Trail 0.4% (0.004) below the highest price reached
      const dynamicTrailing = this.tracked.highPrice * (1 - 0.004);
      const currentStop = this.tracked.trailingStopPrice ?? position.stopLoss;
      
      // Only ratchet trailing stop UP, never down
      if (dynamicTrailing > currentStop) {
        this.tracked.trailingStopPrice = dynamicTrailing;
        this.log({
          event: 'trailing_stop_updated',
          positionId: position.id,
          price: currentPrice,
          details: `highPrice=${this.tracked.highPrice.toFixed(2)} trailingStop=${dynamicTrailing.toFixed(2)} (+${(pnlFraction * 100).toFixed(2)}% PnL)`,
        });
      }
    }
  }

  /**
   * Get the currently open position, or null if none.
   */
  getOpenPosition(): Position | null {
    if (!this.tracked || this.tracked.state === 'closed') {
      return null;
    }
    // Return position with current MFE/MAE
    return {
      ...this.tracked.position,
      mfe: this.tracked.mfe,
      mae: this.tracked.mae,
    };
  }

  /**
   * Whether an exit is currently pending execution.
   */
  isExitPending(): boolean {
    return this.tracked?.state === 'exit_pending';
  }

  /**
   * Execute exit with retry logic.
   * Get fresh quote + simulate before exit. Safety exit gas max: $0.10.
   * Retry 2x with fresh quote on failure, then Safe_Mode.
   *
   * Req 19.6: No LLM. Get fresh quote + simulate before exit.
   * Req 19.7: IF exit tx fails: retry 2x with fresh quote before Safe_Mode.
   */
  async executeExit(reason: ExitReason, currentPrice: number, timestamp: number): Promise<ExitResult> {
    if (!this.tracked || this.tracked.state === 'closed') {
      return { success: false, reason: 'no_active_position' };
    }

    const maxRetries = this.config.maxExitRetries;
    let lastError = '';

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Get fresh quote
      if (this.getQuote) {
        try {
          const quote = await this.getQuote(this.tracked.position.id, this.tracked.position.sizeWeth);
          // Check gas budget
          if (quote.gasUsd > Number(this.config.safetyExitMaxGas) / 1_000_000) {
            lastError = `exit_gas_exceeds_safety_max: $${quote.gasUsd.toFixed(4)} > $${(Number(this.config.safetyExitMaxGas) / 1_000_000).toFixed(2)}`;
            this.log({
              event: 'exit_gas_too_high',
              positionId: this.tracked.position.id,
              reason,
              details: lastError,
            });
            continue;
          }
        } catch (err) {
          lastError = `quote_failed: ${err instanceof Error ? err.message : String(err)}`;
          this.log({
            event: 'exit_quote_failed',
            positionId: this.tracked.position.id,
            reason,
            details: lastError,
          });
          continue;
        }
      }

      // Simulate before exit
      if (this.simulateExit) {
        try {
          const simResult = await this.simulateExit(this.tracked.position.id);
          if (!simResult.success) {
            lastError = `simulation_failed: ${simResult.reason ?? 'unknown'}`;
            this.log({
              event: 'exit_simulation_failed',
              positionId: this.tracked.position.id,
              reason,
              details: lastError,
            });
            continue;
          }
        } catch (err) {
          lastError = `simulation_error: ${err instanceof Error ? err.message : String(err)}`;
          continue;
        }
      }

      // Execute exit
      if (this.executeExitCb) {
        try {
          const result = await this.executeExitCb(this.tracked.position.id, reason);
          if (result.success) {
            this.log({
              event: 'exit_executed',
              positionId: this.tracked.position.id,
              reason,
              price: currentPrice,
              holdingDurationMs: timestamp - this.tracked.position.entryTimestamp,
              mfe: this.tracked.mfe,
              mae: this.tracked.mae,
            });
            return result;
          }
          lastError = `execution_failed: ${result.reason ?? 'unknown'}`;
          this.log({
            event: 'exit_execution_failed',
            positionId: this.tracked.position.id,
            reason,
            details: `attempt=${attempt + 1}/${maxRetries + 1} ${lastError}`,
          });
        } catch (err) {
          lastError = `execution_error: ${err instanceof Error ? err.message : String(err)}`;
          this.log({
            event: 'exit_execution_error',
            positionId: this.tracked.position.id,
            reason,
            details: `attempt=${attempt + 1}/${maxRetries + 1} ${lastError}`,
          });
        }
      } else {
        // No execute callback - signal only mode (e.g. shadow trading)
        return { success: true, reason: 'signal_only' };
      }
    }

    // All retries exhausted → trigger Safe_Mode
    this.log({
      event: 'exit_retries_exhausted',
      positionId: this.tracked.position.id,
      reason,
      details: `All ${maxRetries + 1} attempts failed. Last error: ${lastError}. Recommending Safe_Mode.`,
    });

    return { success: false, reason: `retries_exhausted: ${lastError}` };
  }

  /**
   * Mark position as closed after successful exit.
   * Records exit details and logs final P&L.
   *
   * Req 19.8: Log exit reason, price, P&L, holding duration.
   */
  closePosition(
    exitPrice: number,
    exitTimestamp: number,
    reason: ExitReason,
    grossPnl: UsdcAmount,
    netPnl: UsdcAmount,
  ): void {
    if (!this.tracked) {
      return;
    }

    const position = this.tracked.position;
    const holdingDurationMs = exitTimestamp - position.entryTimestamp;
    const pnlPct = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;

    // Update position fields
    this.tracked.position.exitReason = reason;
    this.tracked.position.exitPrice = exitPrice;
    this.tracked.position.exitTimestamp = exitTimestamp;
    this.tracked.position.grossPnl = grossPnl;
    this.tracked.position.netPnl = netPnl;
    this.tracked.position.mfe = this.tracked.mfe;
    this.tracked.position.mae = this.tracked.mae;
    this.tracked.state = 'closed';

    this.log({
      event: 'position_closed',
      positionId: position.id,
      reason,
      price: exitPrice,
      pnlPct,
      holdingDurationMs,
      mfe: this.tracked.mfe,
      mae: this.tracked.mae,
      details: `grossPnl=${grossPnl.toString()} netPnl=${netPnl.toString()}`,
    });
  }

  /**
   * Get tracked position state (for testing/monitoring).
   */
  getTrackedPosition(): TrackedPosition | null {
    return this.tracked ? { ...this.tracked, position: { ...this.tracked.position } } : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if a specific exit reason is triggered.
   */
  private isExitTriggered(
    reason: ExitReason,
    currentPrice: number,
    currentRegime: RegimeType,
    timestamp: number,
  ): boolean {
    if (!this.tracked) return false;

    const position = this.tracked.position;

    switch (reason) {
      case 'kill_switch':
        return this.externalState.isKillSwitchTriggered();

      case 'safe_mode':
        return this.externalState.isSafeModeActive();

      case 'operator':
        return this.externalState.isOperatorExitRequested();

      case 'stop_loss':
        // Exit when price <= stop loss level OR price <= dynamic trailing stop level
        const effectiveStopLoss = Math.max(
          position.stopLoss, 
          this.tracked.trailingStopPrice ?? 0
        );
        return currentPrice <= effectiveStopLoss;

      case 'time_stop':
        // Exit when holding time exceeds max (8h default)
        return (timestamp - position.entryTimestamp) >= position.maxHoldingMs;

      case 'regime_exit':
        return this.isRegimeExitTriggered(position.strategy, position.entryRegime, currentRegime);

      case 'take_profit':
        // Exit when price >= take profit level
        return currentPrice >= position.takeProfit;

      default:
        return false;
    }
  }

  /**
   * Check regime-exit rules per strategy type.
   *
   * Req 19.4: Trend Pullback exits on TRENDING_DOWN, VOLATILE, UNCERTAIN (not RANGING).
   * Req 19.5: Mean Reversion exits on VOLATILE, UNCERTAIN, TRENDING_DOWN.
   */
  private isRegimeExitTriggered(
    strategy: StrategyType,
    _entryRegime: RegimeType,
    currentRegime: RegimeType,
  ): boolean {
    const triggers = REGIME_EXIT_TRIGGERS[strategy];
    if (!triggers) return false;
    return triggers.includes(currentRegime);
  }

  /**
   * Internal MFE/MAE tracking update.
   * MFE: highest % above entry price.
   * MAE: deepest % below entry price.
   */
  private updateMfeMaeInternal(currentPrice: number): void {
    if (!this.tracked) return;

    const entryPrice = this.tracked.position.entryPrice;

    // Update high/low watermarks
    if (currentPrice > this.tracked.highPrice) {
      this.tracked.highPrice = currentPrice;
    }
    if (currentPrice < this.tracked.lowPrice) {
      this.tracked.lowPrice = currentPrice;
    }

    // MFE: maximum favorable excursion (highest % profit seen)
    const favorableExcursion = ((this.tracked.highPrice - entryPrice) / entryPrice) * 100;
    if (favorableExcursion > this.tracked.mfe) {
      this.tracked.mfe = favorableExcursion;
    }

    // MAE: maximum adverse excursion (deepest % drawdown seen)
    const adverseExcursion = ((entryPrice - this.tracked.lowPrice) / entryPrice) * 100;
    if (adverseExcursion > this.tracked.mae) {
      this.tracked.mae = adverseExcursion;
    }
  }

  /**
   * Log helper.
   */
  private log(entry: {
    event: string;
    positionId: string;
    reason?: ExitReason;
    price?: number;
    pnlPct?: number;
    holdingDurationMs?: number;
    mfe?: number;
    mae?: number;
    details?: string;
  }): void {
    if (this.logger) {
      this.logger(entry);
    }
  }
}

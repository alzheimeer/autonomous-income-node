/**
 * BacktestSimulator — Trade simulation engine with risk limits enforcement.
 *
 * Simulates trade execution with realistic risk management:
 * - Max 1 open position at a time
 * - 5 trades per day maximum
 * - $3 max daily loss
 * - 60min cooldown between entries
 * - $25 starting bankroll
 * - Trade sizes between $5 and $10 USDC
 *
 * Tracks equity curve, daily state, trade history, MFE/MAE.
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import type { CandleData, TradeCandidate } from '../trading-validation/types.js';
import type { BacktestCostModel } from './backtest-cost-model.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface RiskLimits {
  maxOpenPositions: number;     // 1
  minSizeUsdc: bigint;          // 5_000_000n ($5)
  maxSizeUsdc: bigint;          // 10_000_000n ($10)
  maxTradesPerDay: number;      // 5
  maxDailyLossUsdc: bigint;     // 3_000_000n ($3)
  cooldownMs: number;           // 3_600_000 (60 min)
  startingBankroll: bigint;     // 25_000_000n ($25)
}

export const DEFAULT_RISK_LIMITS: RiskLimits = {
  maxOpenPositions: 1,
  minSizeUsdc: 5_000_000n,
  maxSizeUsdc: 10_000_000n,
  maxTradesPerDay: 5,
  maxDailyLossUsdc: 3_000_000n,
  cooldownMs: 3_600_000,
  startingBankroll: 25_000_000n,
};

export interface SimulatedTrade {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  sizeUsdc: bigint;
  pnlUsdc: bigint;
  pnlBps: number;
  strategy: string;
  regime: string;
  exitReason: string;
  holdingMs: number;
  mfeUsdc: bigint;   // max favorable excursion
  maeUsdc: bigint;   // max adverse excursion
}

export interface EquityPoint {
  timestamp: number;
  bankrollUsdc: bigint;
}

/** Internal position tracking */
interface SimulatedPosition {
  entryTime: number;
  entryPrice: number;
  sizeUsdc: bigint;
  strategy: string;
  regime: string;
  stopDistanceFraction: number;
  takeProfitFraction: number;
  mfeUsdc: bigint;   // max favorable excursion tracked per candle
  maeUsdc: bigint;   // max adverse excursion tracked per candle
}

/** Daily state for per-day risk limit tracking */
interface DayState {
  tradeCount: number;
  realizedLoss: bigint;  // cumulative absolute loss (positive value) for the day
}

/** Time-stop duration: 8 hours */
const TIME_STOP_MS = 8 * 3_600_000;

// ═══════════════════════════════════════════════════════════════════════════
// BacktestSimulator
// ═══════════════════════════════════════════════════════════════════════════

export class BacktestSimulator {
  private position: SimulatedPosition | null = null;
  private trades: SimulatedTrade[] = [];
  private equityCurve: EquityPoint[] = [];
  private dailyState: Map<string, DayState> = new Map();
  private bankroll: bigint;
  private lastEntryTime: number = 0;
  private readonly limits: RiskLimits;

  constructor(limits: RiskLimits = DEFAULT_RISK_LIMITS) {
    this.limits = limits;
    this.bankroll = limits.startingBankroll;
    // Record initial equity point
    this.equityCurve.push({ timestamp: 0, bankrollUsdc: this.bankroll });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Process a trade signal through all risk checks.
   * Opens a position if all limits pass.
   */
  processSignal(candidate: TradeCandidate, candle: CandleData, costModel: BacktestCostModel): void {
    // Enforce: max 1 open position
    if (this.position) return;

    // Enforce: cooldown between entries
    if (candle.timestamp - this.lastEntryTime < this.limits.cooldownMs) return;

    // Enforce: daily trade limit
    const dayKey = this.getDayKey(candle.timestamp);
    const dayState = this.getOrCreateDayState(dayKey);
    if (dayState.tradeCount >= this.limits.maxTradesPerDay) return;

    // Enforce: daily loss limit
    if (dayState.realizedLoss >= this.limits.maxDailyLossUsdc) return;

    // Enforce: bankroll sufficient for minimum trade
    if (this.bankroll < this.limits.minSizeUsdc) return;

    // Size: clamp bankroll-aware size to [min, max]
    const size = this.computeTradeSize();
    if (size < this.limits.minSizeUsdc) return;

    // Open position at candle.close
    this.position = {
      entryTime: candle.timestamp,
      entryPrice: candle.close,
      sizeUsdc: size,
      strategy: candidate.strategy,
      regime: candidate.regime,
      stopDistanceFraction: candidate.stopDistanceFraction,
      takeProfitFraction: candidate.takeProfitFraction,
      mfeUsdc: 0n,
      maeUsdc: 0n,
    };
    this.lastEntryTime = candle.timestamp;
    dayState.tradeCount++;
  }

  /**
   * Evaluate exit conditions for current open position.
   * Checks: stop-loss, take-profit, time-stop (8h).
   * If both SL and TP hit in same candle, assume SL first (conservative).
   */
  checkExits(candle: CandleData, costModel: BacktestCostModel): void {
    if (!this.position) return;

    const { entryPrice, stopDistanceFraction, takeProfitFraction, sizeUsdc } = this.position;
    const stopPrice = entryPrice * (1 - stopDistanceFraction);
    const tpPrice = entryPrice * (1 + takeProfitFraction);

    // Track MFE/MAE for this candle
    this.updateExcursions(candle);

    let exitReason: string | null = null;
    let exitPrice = candle.close;

    // Conservative: if BOTH SL and TP hit in same candle, assume SL first
    const slHit = candle.low <= stopPrice;
    const tpHit = candle.high >= tpPrice;

    if (slHit && tpHit) {
      // Both triggered — assume stop loss (conservative)
      exitReason = 'stop_loss';
      exitPrice = stopPrice;
    } else if (slHit) {
      exitReason = 'stop_loss';
      exitPrice = stopPrice;
    } else if (tpHit) {
      exitReason = 'take_profit';
      exitPrice = tpPrice;
    }

    // Time stop: 8 hours
    if (!exitReason && (candle.timestamp - this.position.entryTime >= TIME_STOP_MS)) {
      exitReason = 'time_stop';
      exitPrice = candle.close;
    }

    if (exitReason) {
      this.closePosition(candle.timestamp, exitPrice, exitReason, costModel);
    }
  }

  /** Get all completed trades */
  getTrades(): SimulatedTrade[] {
    return [...this.trades];
  }

  /** Get equity curve */
  getEquityCurve(): EquityPoint[] {
    return [...this.equityCurve];
  }

  /** Get current bankroll */
  getBankroll(): bigint {
    return this.bankroll;
  }

  /** Check if there is an open position */
  hasOpenPosition(): boolean {
    return this.position !== null;
  }

  /** Get current position (for testing) */
  getPosition(): SimulatedPosition | null {
    return this.position ? { ...this.position } : null;
  }

  /** Get daily state for a given day key (for testing) */
  getDayStateForKey(dayKey: string): DayState | undefined {
    return this.dailyState.get(dayKey);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════

  /** Close position and record trade */
  private closePosition(
    exitTime: number,
    exitPrice: number,
    exitReason: string,
    costModel: BacktestCostModel,
  ): void {
    if (!this.position) return;

    const { entryTime, entryPrice, sizeUsdc, strategy, regime, mfeUsdc, maeUsdc } = this.position;

    // Compute net P&L using cost model
    const pnlUsdc = costModel.computeNetPnl(entryPrice, exitPrice, sizeUsdc);

    // Compute P&L in basis points
    const pnlBps = entryPrice !== 0
      ? Math.round(((exitPrice - entryPrice) / entryPrice) * 10_000)
      : 0;

    const holdingMs = exitTime - entryTime;

    const trade: SimulatedTrade = {
      entryTime,
      exitTime,
      entryPrice,
      exitPrice,
      sizeUsdc,
      pnlUsdc,
      pnlBps,
      strategy,
      regime,
      exitReason,
      holdingMs,
      mfeUsdc,
      maeUsdc,
    };

    this.trades.push(trade);

    // Update bankroll
    this.bankroll += pnlUsdc;

    // Update daily state with loss tracking
    if (pnlUsdc < 0n) {
      const dayKey = this.getDayKey(exitTime);
      const dayState = this.getOrCreateDayState(dayKey);
      // realizedLoss tracks absolute loss (positive value)
      dayState.realizedLoss += -pnlUsdc;
    }

    // Record equity curve point
    this.equityCurve.push({ timestamp: exitTime, bankrollUsdc: this.bankroll });

    // Clear position
    this.position = null;
  }

  /** Update MFE/MAE based on current candle high/low */
  private updateExcursions(candle: CandleData): void {
    if (!this.position) return;

    const { entryPrice, sizeUsdc } = this.position;
    if (entryPrice === 0) return;

    // MFE: max favorable movement (using candle high for long positions)
    const favorablePrice = candle.high;
    if (favorablePrice > entryPrice) {
      const favorableMove = BigInt(Math.round(
        ((favorablePrice - entryPrice) / entryPrice) * Number(sizeUsdc),
      ));
      if (favorableMove > this.position.mfeUsdc) {
        this.position.mfeUsdc = favorableMove;
      }
    }

    // MAE: max adverse movement (using candle low for long positions)
    const adversePrice = candle.low;
    if (adversePrice < entryPrice) {
      const adverseMove = BigInt(Math.round(
        ((entryPrice - adversePrice) / entryPrice) * Number(sizeUsdc),
      ));
      if (adverseMove > this.position.maeUsdc) {
        this.position.maeUsdc = adverseMove;
      }
    }
  }

  /** Compute trade size clamped to [minSizeUsdc, maxSizeUsdc] and limited by bankroll */
  private computeTradeSize(): bigint {
    // Use maxSizeUsdc as target, but clamp by available bankroll
    let size = this.limits.maxSizeUsdc;
    if (size > this.bankroll) {
      size = this.bankroll;
    }
    // Ensure at least minSizeUsdc
    if (size < this.limits.minSizeUsdc) {
      return 0n; // Can't afford minimum trade
    }
    // Clamp to max
    if (size > this.limits.maxSizeUsdc) {
      size = this.limits.maxSizeUsdc;
    }
    return size;
  }

  /** Get UTC day key (YYYY-MM-DD) for daily state tracking */
  private getDayKey(timestampMs: number): string {
    const date = new Date(timestampMs);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  /** Get or create daily state for a given day */
  private getOrCreateDayState(dayKey: string): DayState {
    let state = this.dailyState.get(dayKey);
    if (!state) {
      state = { tradeCount: 0, realizedLoss: 0n };
      this.dailyState.set(dayKey, state);
    }
    return state;
  }
}

/**
 * Momentum/Breakout Strategy — Entry signal generation for backtesting.
 *
 * Buys when price breaks above the 20-period high in TRENDING_UP regime
 * with above-average volume confirmation.
 *
 * Conditions for entry:
 * 1. Regime is TRENDING_UP
 * 2. Price closes above the highest high of the last 20 candles
 * 3. Volume Z-score > threshold (default 1.5)
 * 4. RSI > 50 (momentum confirmation, not overbought)
 * 5. RSI < 75 (not extremely overbought)
 * 6. Price > EMA50 (trend confirmation)
 *
 * This strategy complements Trend Pullback (which buys dips) and Mean Reversion
 * (which buys oversold). Momentum buys STRENGTH — new highs with volume.
 *
 * NOT integrated into live TradingOrchestrator — backtester/evolution only.
 */

import { randomUUID } from 'node:crypto';
import type { Indicators } from '../trading-validation/strategy-engine.js';
import type { RegimeType, TradeCandidate } from '../trading-validation/types.js';
import type { CandleData } from '../trading-validation/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface MomentumStrategyConfig {
  /** Lookback period for breakout detection (default: 20) */
  breakoutPeriod: number;
  /** Minimum volume Z-score (default: 1.5) */
  volumeZMin: number;
  /** RSI minimum (momentum confirmation, default: 50) */
  rsiMin: number;
  /** RSI maximum (avoid extreme overbought, default: 75) */
  rsiMax: number;
  /** Stop loss in ATR multiples (default: 2.0) */
  stopAtr: number;
  /** Take profit in ATR multiples (default: 3.0) */
  tpAtr: number;
  /** Cooldown between entries in ms (default: 3_600_000 = 60min) */
  cooldownMs: number;
}

export const DEFAULT_MOMENTUM_CONFIG: MomentumStrategyConfig = {
  breakoutPeriod: 20,
  volumeZMin: 1.5,
  rsiMin: 50,
  rsiMax: 75,
  stopAtr: 2.0,
  tpAtr: 3.0,
  cooldownMs: 3_600_000,
};

// ═══════════════════════════════════════════════════════════════════════════
// MomentumStrategy
// ═══════════════════════════════════════════════════════════════════════════

export class MomentumStrategy {
  private readonly config: MomentumStrategyConfig;
  private lastSignalTime: number = 0;
  private positionOpen: boolean = false;
  private recentHighs: number[] = [];

  constructor(config: Partial<MomentumStrategyConfig> = {}) {
    this.config = { ...DEFAULT_MOMENTUM_CONFIG, ...config };
  }

  /**
   * Feed a closed candle to track the rolling high for breakout detection.
   * Call this for every candle BEFORE calling evaluate().
   */
  addCandle(candle: CandleData): void {
    this.recentHighs.push(candle.high);
    // Keep only last N highs
    if (this.recentHighs.length > this.config.breakoutPeriod + 5) {
      this.recentHighs = this.recentHighs.slice(-this.config.breakoutPeriod - 1);
    }
  }

  /**
   * Evaluate momentum breakout conditions.
   * Returns TradeCandidate if all conditions met, null otherwise.
   */
  evaluate(
    indicators: Indicators,
    regime: RegimeType,
    now: number,
  ): TradeCandidate | null {
    // Guard: position open
    if (this.positionOpen) return null;

    // Guard: cooldown
    if (now - this.lastSignalTime < this.config.cooldownMs) return null;

    // Guard: regime must be TRENDING_UP
    if (regime !== 'TRENDING_UP') return null;

    // Guard: need enough history for breakout detection
    if (this.recentHighs.length < this.config.breakoutPeriod) return null;

    const { lastPrice, rsi14, volumeZScore, ema50, atr14 } = indicators;

    // Condition 1: Price breaks above 20-period high
    const lookbackHighs = this.recentHighs.slice(-(this.config.breakoutPeriod + 1), -1);
    const breakoutLevel = Math.max(...lookbackHighs);
    if (lastPrice <= breakoutLevel) return null;

    // Condition 2: Volume confirmation
    if (volumeZScore < this.config.volumeZMin) return null;

    // Condition 3: RSI in momentum zone (not oversold, not extreme overbought)
    if (rsi14 < this.config.rsiMin || rsi14 > this.config.rsiMax) return null;

    // Condition 4: Price above EMA50 (trend confirmation)
    if (lastPrice <= ema50) return null;

    // All conditions met — generate signal
    this.lastSignalTime = now;

    const stopDistanceFraction = (this.config.stopAtr * atr14) / lastPrice;
    const takeProfitFraction = (this.config.tpAtr * atr14) / lastPrice;

    // Confidence based on breakout strength and volume
    const breakoutStrength = (lastPrice - breakoutLevel) / breakoutLevel;
    const volumeStrength = Math.min(1, (volumeZScore - this.config.volumeZMin) / 2);
    const confidence = Math.min(1, 0.4 + breakoutStrength * 10 + volumeStrength * 0.3);

    return {
      id: randomUUID(),
      strategy: 'trend_pullback' as any, // Type hack: live system only has 2 types
      pair: 'WETH/USDC',
      direction: 'long',
      confidence,
      stopDistanceFraction,
      takeProfitFraction,
      regime,
      createdAt: now,
      expiresAt: now + 60_000,
    };
  }

  setPositionOpen(open: boolean): void {
    this.positionOpen = open;
  }

  hasOpenPosition(): boolean {
    return this.positionOpen;
  }

  reset(): void {
    this.lastSignalTime = 0;
    this.positionOpen = false;
    this.recentHighs = [];
  }
}

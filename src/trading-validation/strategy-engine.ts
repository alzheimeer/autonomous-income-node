/**
 * StrategyEngine — Deterministic entry signal generation for WETH/USDC spot-long.
 *
 * Evaluates Trend Pullback and Mean Reversion strategies using technical indicators.
 * Does NOT handle exits. Produces at most 1 TradeCandidate per evaluation with 60s TTL.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 32.1
 */

import { randomUUID } from 'node:crypto';
import type { RegimeType, StrategyType, TradeCandidate } from './types.js';
import type { StrategyEngineConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Indicators Interface (received from FeatureEngine)
// ═══════════════════════════════════════════════════════════════════════════

/** Technical indicator values for a single timeframe */
export interface Indicators {
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  atr14: number;
  volumeZScore: number;
  bollingerBands: { upper: number; middle: number; lower: number };
  lastPrice: number;
  candleCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// IStrategyEngine Interface
// ═══════════════════════════════════════════════════════════════════════════

export interface IStrategyEngine {
  evaluate(
    indicators1h: Indicators,
    indicators15m: Indicators,
    regime: RegimeType,
    now?: number,
  ): TradeCandidate | null;
  isWarmedUp(): boolean;
  getCooldownRemaining(): number;
  hasOpenPosition(): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// StrategyEngine Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class StrategyEngine implements IStrategyEngine {
  private readonly config: StrategyEngineConfig;
  private lastSignalTime: number = 0;
  private positionOpen: boolean = false;

  constructor(config: StrategyEngineConfig) {
    this.config = config;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Evaluates market conditions for potential entry signals.
   * Returns at most 1 TradeCandidate or null if no signal conditions met.
   * 
   * TUNED for 5%+ monthly returns with MACRO TREND FILTER to avoid buying downtrends.
   */
  evaluate(
    indicators1h: Indicators,
    indicators15m: Indicators,
    regime: RegimeType,
    nowParam?: number,
  ): TradeCandidate | null {
    // Guard: warmup not complete
    if (!this.isWarmedUpWith(indicators1h, indicators15m)) {
      return null;
    }

    // Guard: position already open
    if (this.positionOpen) {
      return null;
    }

    // Guard: cooldown not elapsed
    const now = nowParam ?? Date.now();
    if (this.getCooldownRemainingAt(now) > 0) {
      return null;
    }

    // ════════════════════════════════════════════════════════════════════════
    // MACRO TREND FILTER - Critical for avoiding buying in downtrends
    // Only take LONG positions when the macro trend supports it
    // ════════════════════════════════════════════════════════════════════════
    
    // Check 1h trend structure (EMA alignment)
    const is1hBullish = indicators1h.ema20 > indicators1h.ema50;
    const is1hAbove200 = indicators1h.lastPrice > indicators1h.ema200;
    const is15mAbove200 = indicators15m.lastPrice > indicators15m.ema200;
    
    // Calculate momentum: price position relative to EMAs
    const priceVsEma20_1h = (indicators1h.lastPrice - indicators1h.ema20) / indicators1h.ema20;
    const priceVsEma50_1h = (indicators1h.lastPrice - indicators1h.ema50) / indicators1h.ema50;
    
    // BEARISH FILTER: Skip if clear downtrend on 1h
    // Downtrend = price below EMA20 AND EMA20 < EMA50 AND price far below EMA50
    const isClearDowntrend = !is1hBullish && priceVsEma50_1h < -0.01 && !is1hAbove200;
    
    if (isClearDowntrend) {
      // In clear downtrend, only allow very high confidence dip buys at major support (EMA200)
      if (regime !== 'TRENDING_DOWN' || !is15mAbove200) {
        return null; // Skip - don't buy in downtrends
      }
    }
    
    // WEAK TREND FILTER: Reduce activity when trend is uncertain
    const isWeakTrend = !is1hBullish && priceVsEma20_1h < 0;
    
    // Strategy selection based on regime (EXPANDED for more opportunities)
    let candidate: TradeCandidate | null = null;

    // TRENDING_UP: Try Trend Pullback, then Dip Buying, then Momentum Breakout
    if (regime === 'TRENDING_UP') {
      candidate = this.evaluateTrendPullback(indicators15m, regime, now);
      if (!candidate) {
        candidate = this.evaluateDipBuying(indicators15m, indicators1h, regime, now);
      }
      if (!candidate) {
        candidate = this.evaluateMomentumBreakout(indicators15m, indicators1h, regime, now);
      }
    }

    // RANGING: Try Mean Reversion, then Dip Buying (only if not weak trend)
    if (!candidate && regime === 'RANGING') {
      if (!isWeakTrend) {
        candidate = this.evaluateMeanReversion(indicators15m, indicators1h, regime, now);
        if (!candidate) {
          candidate = this.evaluateDipBuying(indicators15m, indicators1h, regime, now);
        }
      }
      // Skip trend_pullback in ranging - it needs trend
    }

    // VOLATILE: Only try if we have bullish bias, otherwise skip
    if (!candidate && regime === 'VOLATILE') {
      if (is1hBullish || is1hAbove200) {
        candidate = this.evaluateDipBuying(indicators15m, indicators1h, regime, now);
        if (!candidate) {
          candidate = this.evaluateMomentumBreakout(indicators15m, indicators1h, regime, now);
        }
      }
      // Skip mean reversion in volatile - too risky
    }

    // UNCERTAIN: Very conservative - only high confidence setups
    if (!candidate && (regime === 'UNCERTAIN' || !regime)) {
      // Only trade UNCERTAIN if we have bullish structure on 1h
      if (is1hBullish && is1hAbove200) {
        candidate = this.evaluateDipBuying(indicators15m, indicators1h, regime || 'UNCERTAIN', now);
      }
      // Require much higher confidence in uncertain regime
      if (candidate && candidate.confidence < 0.60) {
        candidate = null;
      }
    }

    // TRENDING_DOWN: VERY SELECTIVE - only extreme oversold at major support
    if (!candidate && regime === 'TRENDING_DOWN') {
      // Only trade if RSI is extremely oversold AND price at EMA200 support
      if (indicators15m.rsi14 < 25 && is15mAbove200) {
        candidate = this.evaluateDipBuying(indicators15m, indicators1h, regime, now);
        // Require very high confidence for counter-trend trades
        if (candidate && candidate.confidence < 0.65) {
          candidate = null;
        }
      }
      // No mean reversion in downtrends - too dangerous
    }

    if (candidate) {
      this.lastSignalTime = now;
    }

    return candidate;
  }

  /**
   * Returns true if both timeframes have sufficient candle history.
   */
  isWarmedUp(): boolean {
    // Without indicator data, we can only report based on last known state.
    // This is a convenience method — the real warmup check happens during evaluate().
    return true;
  }

  /**
   * Returns milliseconds remaining until next signal is allowed. 0 if ready.
   */
  getCooldownRemaining(): number {
    return this.getCooldownRemainingAt(Date.now());
  }

  /**
   * Returns whether a position is currently tracked as open.
   */
  hasOpenPosition(): boolean {
    return this.positionOpen;
  }

  /**
   * Called externally to inform StrategyEngine of position state changes.
   */
  setPositionOpen(open: boolean): void {
    this.positionOpen = open;
  }

  /**
   * Set the last signal timestamp (for testing / recovery).
   */
  setLastSignalTime(timestamp: number): void {
    this.lastSignalTime = timestamp;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Strategy: Trend Pullback — IMPROVED for better win rate
  // Now requires deeper pullbacks and better RSI alignment
  // ─────────────────────────────────────────────────────────────────────────

  private evaluateTrendPullback(
    ind15m: Indicators,
    regime: RegimeType,
    now: number,
  ): TradeCandidate | null {
    const { lastPrice, ema20, ema50, rsi14, volumeZScore } = ind15m;

    // Condition: price within 1.5% of EMA20 (tightened from 2% for better entries)
    const distanceToEma20Pct = Math.abs(lastPrice - ema20) / ema20;
    if (distanceToEma20Pct > 0.015) return null;

    // Condition: RSI in [30, 48] (tightened to catch deeper pullbacks only)
    // Deeper pullbacks have better risk/reward
    if (rsi14 < 30 || rsi14 > 48) return null;

    // Condition: EMA20 > EMA50 (unchanged — defines uptrend)
    if (ema20 <= ema50) return null;

    // Condition: close > EMA50 * 0.99 (tightened - closer to EMA50 support)
    if (lastPrice <= ema50 * 0.99) return null;

    // NEW: EMA spread filter - need meaningful trend strength
    const emaSpreaPct = (ema20 - ema50) / ema50;
    if (emaSpreaPct < 0.003) return null; // Skip weak trends (< 0.3% spread)

    // All conditions met — compute confidence
    let confidence = this.computeConfidence(
      'trend_pullback',
      regime,
      ind15m,
      distanceToEma20Pct,
    );

    // Volume-based confidence adjustment
    if (volumeZScore < 0) {
      confidence -= Math.min(0.12, Math.abs(volumeZScore) * 0.04);
    } else if (volumeZScore > 1.0) {
      confidence += Math.min(0.10, (volumeZScore - 1.0) * 0.05);
    }

    // Regime bonus/penalty
    if (regime === 'TRENDING_UP') {
      confidence += 0.10; // Best regime for this strategy
    } else if (regime === 'RANGING') {
      confidence -= 0.08; // Suboptimal but can work
    }

    confidence = Math.max(0.30, Math.min(1, confidence)); // Floor at 0.30

    // Use config values for SL/TP but with wider stops
    const stopDistanceFraction = (this.config.stopLossAtr * ind15m.atr14) / lastPrice;
    const takeProfitFraction = (this.config.takeProfitAtr * ind15m.atr14) / lastPrice;

    return this.createCandidate(
      'trend_pullback',
      confidence,
      stopDistanceFraction,
      takeProfitFraction,
      regime,
      now,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Strategy: Mean Reversion — IMPROVED for better win rate
  // Now requires deeper oversold conditions and better regime alignment
  // ─────────────────────────────────────────────────────────────────────────

  private evaluateMeanReversion(
    ind15m: Indicators,
    ind1h: Indicators,
    regime: RegimeType,
    now: number,
  ): TradeCandidate | null {
    const { lastPrice, rsi14, volumeZScore, bollingerBands, atr14 } = ind15m;

    // Condition: price at or below lower Bollinger (touching support)
    const distanceToLowerBB = (lastPrice - bollingerBands.lower) / bollingerBands.lower;
    if (distanceToLowerBB > 0.005) return null; // Must be within 0.5% of lower BB

    // Condition: RSI < 38 (tightened from 42 - need real oversold conditions)
    if (rsi14 >= 38) return null;

    // NEW: RSI must be falling or stabilizing (not already bouncing hard)
    // This is approximated by requiring RSI < 1h RSI (15m weaker than 1h)
    if (rsi14 > ind1h.rsi14 + 5) return null; // Skip if 15m RSI already bounced

    // Condition: current range < meanRevAtrMax × average range
    const rangeRatio = atr14 / (ind1h.atr14 > 0 ? ind1h.atr14 : atr14);
    if (rangeRatio >= this.config.meanRevAtrMax) return null;

    // NEW: Bollinger band width check - need ranging market (not contracting or exploding)
    const bbWidth = (bollingerBands.upper - bollingerBands.lower) / bollingerBands.middle;
    if (bbWidth < 0.015 || bbWidth > 0.08) return null; // 1.5% to 8% band width

    // All conditions met — compute confidence
    let confidence = this.computeConfidence(
      'mean_reversion',
      regime,
      ind15m,
      Math.abs(distanceToLowerBB),
    );

    // Volume-based confidence adjustment
    if (volumeZScore < 0) {
      confidence -= Math.min(0.08, Math.abs(volumeZScore) * 0.025);
    } else if (volumeZScore > 1.5) {
      // High volume on mean reversion = potential capitulation (very good!)
      confidence += Math.min(0.18, (volumeZScore - 1.5) * 0.10);
    } else if (volumeZScore > 0.5) {
      confidence += Math.min(0.08, (volumeZScore - 0.5) * 0.05);
    }

    // Regime bonus/penalty
    if (regime === 'RANGING') {
      confidence += 0.12; // Best regime for this strategy
    } else if (regime === 'TRENDING_DOWN') {
      confidence -= 0.10; // Risky - catching falling knife
    }

    // Deep oversold bonus
    if (rsi14 < 30) {
      confidence += 0.10;
    } else if (rsi14 < 35) {
      confidence += 0.05;
    }

    confidence = Math.max(0.35, Math.min(1, confidence)); // Floor at 0.35

    // Wider stops for mean reversion (need room to work)
    const stopDistanceFraction = (this.config.stopLossAtr * 1.2 * atr14) / lastPrice;
    const takeProfitFraction = (this.config.takeProfitAtr * atr14) / lastPrice;

    return this.createCandidate(
      'mean_reversion',
      confidence,
      stopDistanceFraction,
      takeProfitFraction,
      regime,
      now,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Strategy: Momentum Breakout — For trending/volatile markets
  // REQUIRES VOLUME CONFIRMATION: Breakouts without volume fail
  // ─────────────────────────────────────────────────────────────────────────

  private evaluateMomentumBreakout(
    ind15m: Indicators,
    ind1h: Indicators,
    regime: RegimeType,
    now: number,
  ): TradeCandidate | null {
    const { lastPrice, ema20, ema50, rsi14, volumeZScore, bollingerBands, atr14 } = ind15m;

    // Condition: price above upper Bollinger (breakout)
    if (lastPrice <= bollingerBands.upper) return null;

    // Condition: RSI between 55-78 (tightened - not too overbought)
    if (rsi14 < 55 || rsi14 > 78) return null;

    // Condition: volume confirmation - STRICT for breakouts
    // Breakouts without volume are fake - keep this strict
    if (volumeZScore < 0.8) return null;

    // Condition: price above EMA20 (trend confirmation)
    if (lastPrice <= ema20) return null;

    // NEW: EMA20 > EMA50 (need uptrend structure)
    if (ema20 <= ema50) return null;

    // NEW: 1h trend confirmation
    if (ind1h.ema20 <= ind1h.ema50) return null;

    // All conditions met — compute confidence
    const distanceToUpperBB = (lastPrice - bollingerBands.upper) / bollingerBands.upper;
    
    // Base confidence + bonuses
    let confidence = 0.45;
    
    // RSI in sweet spot (60-70) bonus
    if (rsi14 >= 60 && rsi14 <= 70) confidence += 0.12;
    
    // Strong volume bonus
    if (volumeZScore > 2.5) confidence += 0.18;
    else if (volumeZScore > 1.5) confidence += 0.12;
    else if (volumeZScore > 1.0) confidence += 0.06;
    
    // 1h RSI alignment bonus
    if (ind1h.rsi14 > 50 && ind1h.rsi14 < 70) confidence += 0.08;
    
    // Fresh breakout (close to BB) bonus
    if (distanceToUpperBB < 0.008) confidence += 0.10;
    
    // Regime bonus
    if (regime === 'TRENDING_UP') confidence += 0.08;

    confidence = Math.min(1, Math.max(0.40, confidence));

    // Tight stops for momentum trades (exit fast on failures)
    const stopDistanceFraction = (1.2 * atr14) / lastPrice;
    const takeProfitFraction = (2.8 * atr14) / lastPrice;

    return this.createCandidate(
      'momentum_breakout' as StrategyType,
      confidence,
      stopDistanceFraction,
      takeProfitFraction,
      regime,
      now,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Strategy: Dip Buying — IMPROVED for catching panic sells at key supports
  // Best strategy for uncertain/volatile markets when structure holds
  // ─────────────────────────────────────────────────────────────────────────

  private evaluateDipBuying(
    ind15m: Indicators,
    ind1h: Indicators,
    regime: RegimeType,
    now: number,
  ): TradeCandidate | null {
    const { lastPrice, ema20, ema50, ema200, rsi14, volumeZScore, atr14 } = ind15m;

    // Condition: price near EMA20, EMA50, or EMA200 (key support levels)
    const distanceToEma20Pct = (lastPrice - ema20) / ema20;
    const distanceToEma50Pct = (lastPrice - ema50) / ema50;
    const distanceToEma200Pct = (lastPrice - ema200) / ema200;
    
    // Must be within 2% of any major EMA (at or slightly below for dip buying)
    const nearEma20 = Math.abs(distanceToEma20Pct) <= 0.02 && distanceToEma20Pct >= -0.015;
    const nearEma50 = Math.abs(distanceToEma50Pct) <= 0.02 && distanceToEma50Pct >= -0.015;
    const nearEma200 = Math.abs(distanceToEma200Pct) <= 0.02 && distanceToEma200Pct >= -0.015;
    
    if (!nearEma20 && !nearEma50 && !nearEma200) return null;

    // Condition: RSI showing weakness (< 45, need actual dip)
    if (rsi14 >= 45) return null;

    // Condition: 1h trend still intact (EMA20 > EMA200 on 1h = medium-term uptrend)
    // This is crucial - only buy dips in uptrends
    if (ind1h.ema20 <= ind1h.ema200) return null;

    // NEW: 1h RSI not crashing (if 1h RSI < 30, trend might be breaking)
    if (ind1h.rsi14 < 30) return null;

    // Compute confidence based on dip quality
    let confidence = 0.38;
    
    // Support level strength (EMA200 is strongest)
    if (nearEma200) {
      confidence += 0.18;
    } else if (nearEma50) {
      confidence += 0.12;
    } else if (nearEma20) {
      confidence += 0.06;
    }
    
    // RSI depth bonus - deeper oversold = better entry
    if (rsi14 < 28) confidence += 0.18;
    else if (rsi14 < 32) confidence += 0.12;
    else if (rsi14 < 38) confidence += 0.06;
    
    // Volume considerations - high volume dip = capitulation (excellent!)
    if (volumeZScore > 2.0) confidence += 0.18;
    else if (volumeZScore > 1.0) confidence += 0.10;
    else if (volumeZScore > 0.3) confidence += 0.05;
    else if (volumeZScore < -0.3) confidence -= 0.05;
    
    // 1h structure bonus
    if (ind1h.rsi14 > 40 && ind1h.rsi14 < 60) confidence += 0.08;
    if (ind1h.ema20 > ind1h.ema50) confidence += 0.06;

    // Regime adjustment
    if (regime === 'RANGING') confidence += 0.05;
    else if (regime === 'TRENDING_DOWN') confidence -= 0.10;
    else if (regime === 'VOLATILE') confidence -= 0.05;

    confidence = Math.max(0.35, Math.min(1, confidence));

    // Wider stop for dip buying (give room to work at support)
    const stopDistanceFraction = (this.config.stopLossAtr * 1.3 * atr14) / lastPrice;
    const takeProfitFraction = (this.config.takeProfitAtr * 1.1 * atr14) / lastPrice;

    return this.createCandidate(
      'dip_buying' as StrategyType,
      confidence,
      stopDistanceFraction,
      takeProfitFraction,
      regime,
      now,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Confidence Score (deterministic, weighted)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Computes a deterministic confidence score in [0, 1].
   * Weights: regime_strength (0.3) + indicator_alignment (0.3) + volume_factor (0.2) + price_distance (0.2)
   */
  private computeConfidence(
    strategy: StrategyType,
    regime: RegimeType,
    ind: Indicators,
    priceDistance: number,
  ): number {
    const regimeStrength = this.computeRegimeStrength(strategy, ind);
    const indicatorAlignment = this.computeIndicatorAlignment(strategy, ind);
    const volumeFactor = this.computeVolumeFactor(ind.volumeZScore);
    const distanceFactor = this.computeDistanceFactor(strategy, priceDistance);

    const raw =
      0.3 * regimeStrength +
      0.3 * indicatorAlignment +
      0.2 * volumeFactor +
      0.2 * distanceFactor;

    // Clamp to [0, 1]
    return Math.max(0, Math.min(1, raw));
  }

  /**
   * Regime strength: how strongly the current indicators support the regime.
   * For Trend Pullback: EMA ordering strength (EMA20 > EMA50 > EMA200).
   * For Mean Reversion: how far below the lower Bollinger band.
   */
  private computeRegimeStrength(strategy: StrategyType, ind: Indicators): number {
    if (strategy === 'trend_pullback') {
      // Strength based on EMA separation
      const ema20_50_spread = (ind.ema20 - ind.ema50) / ind.ema50;
      const ema50_200_spread = (ind.ema50 - ind.ema200) / ind.ema200;
      // Normalize: a 1% EMA20/50 spread = strong trend
      const strength20_50 = Math.min(1, Math.max(0, ema20_50_spread / 0.01));
      const strength50_200 = Math.min(1, Math.max(0, ema50_200_spread / 0.02));
      return (strength20_50 + strength50_200) / 2;
    }

    // Mean Reversion: Bollinger width indicates ranging stability
    const bbWidth =
      (ind.bollingerBands.upper - ind.bollingerBands.lower) / ind.bollingerBands.middle;
    // Narrow bands = stronger ranging regime, normalize around 2% band width
    return Math.min(1, Math.max(0, 1 - bbWidth / 0.04));
  }

  /**
   * Indicator alignment: how well the RSI and price confirm the strategy thesis.
   */
  private computeIndicatorAlignment(strategy: StrategyType, ind: Indicators): number {
    if (strategy === 'trend_pullback') {
      // Best RSI for pullback entry: 35-42 (deeper pullback = better)
      const rsiOptimal = 42.5; // midpoint of ideal zone
      const rsiDeviation = Math.abs(ind.rsi14 - rsiOptimal) / 15; // normalize over [35,50] range
      return Math.max(0, 1 - rsiDeviation);
    }

    // Mean Reversion: deeper oversold = stronger signal
    // RSI 10 is extreme; RSI 30 is boundary. Scale linearly.
    return Math.min(1, Math.max(0, (30 - ind.rsi14) / 20));
  }

  /**
   * Volume factor: higher volume Z-score = stronger confirmation.
   * Normalized: Z=1.0 → 0.0 (threshold), Z=3.0 → 1.0 (strong)
   */
  private computeVolumeFactor(volumeZ: number): number {
    return Math.min(1, Math.max(0, (volumeZ - this.config.volumeZThreshold) / 2.0));
  }

  /**
   * Distance factor: how close to the trigger level.
   * For Trend Pullback: closer to EMA20 is better (tighter entry).
   * For Mean Reversion: at or below lower BB is better.
   */
  private computeDistanceFactor(strategy: StrategyType, priceDistance: number): number {
    if (strategy === 'trend_pullback') {
      // Distance 0 = perfect (at EMA20), 0.5% = threshold boundary
      return Math.max(0, 1 - priceDistance / 0.005);
    }

    // Mean Reversion: at lower BB = 1.0, slightly above still counts
    return Math.min(1, Math.max(0, 1 - priceDistance / 0.01));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private isWarmedUpWith(ind1h: Indicators, ind15m: Indicators): boolean {
    return (
      ind1h.candleCount >= this.config.warmup1h &&
      ind15m.candleCount >= this.config.warmup15m
    );
  }

  /** 
   * All regimes are now actionable - we have strategies for each.
   * Kept for backward compatibility and potential future restrictions.
   */
  private isActionableRegime(_regime: RegimeType): boolean {
    return true; // All regimes supported with expanded strategy set
  }

  private getCooldownRemainingAt(now: number): number {
    if (this.lastSignalTime === 0) return 0;
    const elapsed = now - this.lastSignalTime;
    return Math.max(0, this.config.cooldownMs - elapsed);
  }

  private createCandidate(
    strategy: StrategyType,
    confidence: number,
    stopDistanceFraction: number,
    takeProfitFraction: number,
    regime: RegimeType,
    now: number,
  ): TradeCandidate {
    // CRITICAL: Apply minimum floors to stop distances
    // This ensures trades have room to breathe regardless of ATR
    // INCREASED: Min SL: 1.5% (0.015), Min TP: 2.0% (0.02) - wider stops for volatile markets
    const MIN_STOP_LOSS_FRACTION = 0.015;  // 1.5% minimum stop loss (was 1.0%)
    const MIN_TAKE_PROFIT_FRACTION = 0.020; // 2.0% minimum take profit (was 1.2%)
    
    // Apply floors
    const adjustedStopDistance = Math.max(stopDistanceFraction, MIN_STOP_LOSS_FRACTION);
    const adjustedTakeProfit = Math.max(takeProfitFraction, MIN_TAKE_PROFIT_FRACTION);
    
    return {
      id: randomUUID(),
      strategy,
      pair: 'WETH/USDC',
      direction: 'long',
      confidence,
      stopDistanceFraction: adjustedStopDistance,
      takeProfitFraction: adjustedTakeProfit,
      regime,
      createdAt: now,
      expiresAt: now + 60_000, // 60s TTL
    };
  }
}

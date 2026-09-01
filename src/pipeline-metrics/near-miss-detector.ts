/**
 * Near-Miss Detector
 *
 * Detects when indicator values are within threshold proximity of triggering
 * a signal condition. Used by the PipelineMetricsRecorder to identify
 * evaluations that nearly produced a trade candidate.
 *
 * Thresholds:
 *   - RSI: ±2 of boundary
 *   - Price vs EMA20: actual distance within ±0.1% of the 0.5% threshold
 *   - Volume Z-score: actual within ±0.2 of the required threshold
 *   - Net profit: actual within ±20% of minimum required (gate near-miss)
 *   - Slippage/impact: actual within ±10 bps of max allowed (gate near-miss)
 *
 * Requirements: 4.1, 4.2, 4.3
 */

import type { Indicators } from '../trading-validation/strategy-engine.js';
import type { StrategyEngineConfig } from '../trading-validation/config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface NearMiss {
  indicator: string;
  actual: number;
  threshold: number;
  distance: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Near-Miss Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detects near-miss conditions for a given set of indicators and strategy type.
 *
 * A near-miss occurs when an indicator value is close to — but does not satisfy —
 * a threshold condition required for signal generation.
 *
 * Multiple near-misses may be detected per evaluation.
 *
 * @param indicators - Technical indicator values from the current evaluation
 * @param strategyType - The strategy being evaluated
 * @param config - Strategy engine configuration (provides volumeZThreshold)
 * @returns Array of detected near-miss records (may be empty)
 */
export function detectNearMisses(
  indicators: Indicators,
  strategyType: 'trend_pullback' | 'mean_reversion',
  config: StrategyEngineConfig,
): NearMiss[] {
  const nearMisses: NearMiss[] = [];

  if (strategyType === 'trend_pullback') {
    detectTrendPullbackNearMisses(indicators, config, nearMisses);
  } else {
    detectMeanReversionNearMisses(indicators, config, nearMisses);
  }

  return nearMisses;
}

// ═══════════════════════════════════════════════════════════════════════════
// Trend Pullback Near-Miss Checks
// ═══════════════════════════════════════════════════════════════════════════

function detectTrendPullbackNearMisses(
  indicators: Indicators,
  config: StrategyEngineConfig,
  nearMisses: NearMiss[],
): void {
  const { rsi14, lastPrice, ema20, ema50, volumeZScore } = indicators;

  // RSI lower boundary: signal requires rsi14 >= 35
  // Near-miss: rsi14 < 35 && rsi14 >= 33 (within ±2 below boundary)
  if (rsi14 < 35 && rsi14 >= 33) {
    nearMisses.push({
      indicator: 'rsi14',
      actual: rsi14,
      threshold: 35,
      distance: 35 - rsi14,
    });
  }

  // RSI upper boundary: signal requires rsi14 <= 50
  // Near-miss: rsi14 > 50 && rsi14 <= 52 (within ±2 above boundary)
  if (rsi14 > 50 && rsi14 <= 52) {
    nearMisses.push({
      indicator: 'rsi14',
      actual: rsi14,
      threshold: 50,
      distance: rsi14 - 50,
    });
  }

  // Price vs EMA20: signal requires distance <= 0.5% (0.005)
  // Near-miss: distance > 0.005 && distance <= 0.006 (within ±0.1% of threshold)
  const distToEma20 = Math.abs(lastPrice - ema20) / ema20;
  if (distToEma20 > 0.005 && distToEma20 <= 0.006) {
    nearMisses.push({
      indicator: 'price_vs_ema20',
      actual: distToEma20,
      threshold: 0.005,
      distance: distToEma20 - 0.005,
    });
  }

  // Volume Z-score: signal requires volumeZScore > threshold
  // Near-miss: volumeZScore <= threshold && volumeZScore >= threshold - 0.2
  const volThreshold = config.volumeZThreshold;
  if (volumeZScore <= volThreshold && volumeZScore >= volThreshold - 0.2) {
    nearMisses.push({
      indicator: 'volume_z',
      actual: volumeZScore,
      threshold: volThreshold,
      distance: volThreshold - volumeZScore,
    });
  }

  // EMA order: signal requires ema20 > ema50
  // Near-miss: ema20 <= ema50 && ema20 >= ema50 * 0.999 (within 0.1%)
  if (ema20 <= ema50 && ema20 >= ema50 * 0.999) {
    nearMisses.push({
      indicator: 'ema_order',
      actual: ema20,
      threshold: ema50,
      distance: ema50 - ema20,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Mean Reversion Near-Miss Checks
// ═══════════════════════════════════════════════════════════════════════════

function detectMeanReversionNearMisses(
  indicators: Indicators,
  config: StrategyEngineConfig,
  nearMisses: NearMiss[],
): void {
  const { rsi14, lastPrice, bollingerBands, volumeZScore } = indicators;

  // RSI boundary: signal requires rsi14 < 30
  // Near-miss: rsi14 >= 30 && rsi14 <= 32 (within ±2 above boundary)
  if (rsi14 >= 30 && rsi14 <= 32) {
    nearMisses.push({
      indicator: 'rsi14',
      actual: rsi14,
      threshold: 30,
      distance: rsi14 - 30,
    });
  }

  // Price vs lower Bollinger Band: signal requires price <= lowerBB
  // Near-miss: price > lowerBB && price <= lowerBB * 1.001 (within 0.1%)
  const lowerBB = bollingerBands.lower;
  if (lastPrice > lowerBB && lastPrice <= lowerBB * 1.001) {
    nearMisses.push({
      indicator: 'price_vs_lower_bb',
      actual: lastPrice,
      threshold: lowerBB,
      distance: lastPrice - lowerBB,
    });
  }

  // Volume Z-score: same check as trend_pullback
  const volThreshold = config.volumeZThreshold;
  if (volumeZScore <= volThreshold && volumeZScore >= volThreshold - 0.2) {
    nearMisses.push({
      indicator: 'volume_z',
      actual: volumeZScore,
      threshold: volThreshold,
      distance: volThreshold - volumeZScore,
    });
  }
}

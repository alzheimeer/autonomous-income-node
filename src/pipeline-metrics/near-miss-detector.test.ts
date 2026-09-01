/**
 * Tests for near-miss-detector.ts
 *
 * Validates threshold proximity detection for trend_pullback and mean_reversion strategies.
 * Requirements: 4.1, 4.2, 4.3
 */

import { describe, it, expect } from 'vitest';
import { detectNearMisses } from './near-miss-detector.js';
import type { Indicators } from '../trading-validation/strategy-engine.js';
import type { StrategyEngineConfig } from '../trading-validation/config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════

function makeIndicators(overrides: Partial<Indicators> = {}): Indicators {
  return {
    ema20: 2000,
    ema50: 1980,
    ema200: 1900,
    rsi14: 42,
    atr14: 30,
    volumeZScore: 1.5,
    bollingerBands: { upper: 2100, middle: 2000, lower: 1900 },
    lastPrice: 2000,
    candleCount: 500,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<StrategyEngineConfig> = {}): StrategyEngineConfig {
  return {
    pair: 'WETH/USDC',
    regimeTimeframe: '1h',
    entryTimeframe: '15m',
    stopLossAtr: 1.5,
    takeProfitAtr: 2.0,
    cooldownMs: 3600000,
    warmup1h: 300,
    warmup15m: 500,
    meanRevAtrMax: 2.5,
    minLiquidity: 50000,
    volumeZThreshold: 1.0,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Trend Pullback Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('detectNearMisses - trend_pullback', () => {
  const config = makeConfig();

  it('returns empty array when no indicators are near thresholds', () => {
    // All indicators safely within bounds (RSI 42, vol 1.5, ema order correct, price close to ema20)
    const indicators = makeIndicators();
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    expect(result).toEqual([]);
  });

  it('detects RSI near lower boundary (rsi14 = 34)', () => {
    const indicators = makeIndicators({ rsi14: 34 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      indicator: 'rsi14',
      actual: 34,
      threshold: 35,
      distance: 1,
    });
  });

  it('detects RSI near lower boundary at exact boundary (rsi14 = 33)', () => {
    const indicators = makeIndicators({ rsi14: 33 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      indicator: 'rsi14',
      actual: 33,
      threshold: 35,
      distance: 2,
    });
  });

  it('does NOT detect RSI near-miss when rsi14 < 33', () => {
    const indicators = makeIndicators({ rsi14: 32.9 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const rsiNearMisses = result.filter(nm => nm.indicator === 'rsi14');
    expect(rsiNearMisses).toHaveLength(0);
  });

  it('detects RSI near upper boundary (rsi14 = 51)', () => {
    const indicators = makeIndicators({ rsi14: 51 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      indicator: 'rsi14',
      actual: 51,
      threshold: 50,
      distance: 1,
    });
  });

  it('detects RSI near upper boundary at edge (rsi14 = 52)', () => {
    const indicators = makeIndicators({ rsi14: 52 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      indicator: 'rsi14',
      actual: 52,
      threshold: 50,
      distance: 2,
    });
  });

  it('does NOT detect RSI near upper boundary when rsi14 > 52', () => {
    const indicators = makeIndicators({ rsi14: 52.1 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const rsiNearMisses = result.filter(nm => nm.indicator === 'rsi14');
    expect(rsiNearMisses).toHaveLength(0);
  });

  it('detects price vs EMA20 near-miss (distance = 0.55%)', () => {
    // ema20 = 2000, price at 2011 → dist = 11/2000 = 0.0055 (between 0.005 and 0.006)
    const indicators = makeIndicators({ lastPrice: 2011, ema20: 2000 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const priceNm = result.filter(nm => nm.indicator === 'price_vs_ema20');
    expect(priceNm).toHaveLength(1);
    expect(priceNm[0].threshold).toBe(0.005);
    expect(priceNm[0].actual).toBeCloseTo(0.0055, 5);
    expect(priceNm[0].distance).toBeCloseTo(0.0005, 5);
  });

  it('does NOT detect price vs EMA20 near-miss when distance > 0.6%', () => {
    // ema20 = 2000, price at 2013 → dist = 13/2000 = 0.0065 (> 0.006)
    const indicators = makeIndicators({ lastPrice: 2013, ema20: 2000 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const priceNm = result.filter(nm => nm.indicator === 'price_vs_ema20');
    expect(priceNm).toHaveLength(0);
  });

  it('detects volume Z-score near-miss (volumeZ = 0.9 with threshold 1.0)', () => {
    const indicators = makeIndicators({ volumeZScore: 0.9 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const volNm = result.filter(nm => nm.indicator === 'volume_z');
    expect(volNm).toHaveLength(1);
    expect(volNm[0]).toEqual({
      indicator: 'volume_z',
      actual: 0.9,
      threshold: 1.0,
      distance: expect.closeTo(0.1, 5),
    });
  });

  it('detects volume Z-score near-miss at boundary (volumeZ = 1.0)', () => {
    // volumeZ = threshold → signal requires > threshold, so this is a near-miss
    const indicators = makeIndicators({ volumeZScore: 1.0 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const volNm = result.filter(nm => nm.indicator === 'volume_z');
    expect(volNm).toHaveLength(1);
    expect(volNm[0].distance).toBeCloseTo(0, 5);
  });

  it('does NOT detect volume Z-score near-miss when below threshold - 0.2', () => {
    const indicators = makeIndicators({ volumeZScore: 0.79 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const volNm = result.filter(nm => nm.indicator === 'volume_z');
    expect(volNm).toHaveLength(0);
  });

  it('detects EMA order near-miss (ema20 slightly below ema50)', () => {
    // ema20 = 1999, ema50 = 2000 → ema20 <= ema50 && ema20 >= 2000 * 0.999 = 1998
    const indicators = makeIndicators({ ema20: 1999, ema50: 2000 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const emaNm = result.filter(nm => nm.indicator === 'ema_order');
    expect(emaNm).toHaveLength(1);
    expect(emaNm[0]).toEqual({
      indicator: 'ema_order',
      actual: 1999,
      threshold: 2000,
      distance: 1,
    });
  });

  it('does NOT detect EMA order near-miss when ema20 > ema50', () => {
    const indicators = makeIndicators({ ema20: 2001, ema50: 2000 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const emaNm = result.filter(nm => nm.indicator === 'ema_order');
    expect(emaNm).toHaveLength(0);
  });

  it('detects multiple near-misses simultaneously', () => {
    // RSI near lower boundary + volume Z near threshold + EMA order near-miss
    const indicators = makeIndicators({
      rsi14: 34,
      volumeZScore: 0.9,
      ema20: 1999,
      ema50: 2000,
    });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    expect(result.length).toBeGreaterThanOrEqual(3);
    const indicatorNames = result.map(nm => nm.indicator);
    expect(indicatorNames).toContain('rsi14');
    expect(indicatorNames).toContain('volume_z');
    expect(indicatorNames).toContain('ema_order');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Mean Reversion Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('detectNearMisses - mean_reversion', () => {
  const config = makeConfig();

  it('returns empty array when no indicators are near thresholds', () => {
    // RSI = 25 (well below 30), price = 1850 (below lowerBB 1900), vol = 1.5 (above threshold)
    const indicators = makeIndicators({
      rsi14: 25,
      lastPrice: 1850,
      volumeZScore: 1.5,
    });
    const result = detectNearMisses(indicators, 'mean_reversion', config);
    expect(result).toEqual([]);
  });

  it('detects RSI near boundary (rsi14 = 31)', () => {
    const indicators = makeIndicators({ rsi14: 31 });
    const result = detectNearMisses(indicators, 'mean_reversion', config);
    const rsiNm = result.filter(nm => nm.indicator === 'rsi14');
    expect(rsiNm).toHaveLength(1);
    expect(rsiNm[0]).toEqual({
      indicator: 'rsi14',
      actual: 31,
      threshold: 30,
      distance: 1,
    });
  });

  it('detects RSI at exact boundary (rsi14 = 30)', () => {
    const indicators = makeIndicators({ rsi14: 30 });
    const result = detectNearMisses(indicators, 'mean_reversion', config);
    const rsiNm = result.filter(nm => nm.indicator === 'rsi14');
    expect(rsiNm).toHaveLength(1);
    expect(rsiNm[0].distance).toBe(0);
  });

  it('does NOT detect RSI near-miss when rsi14 > 32', () => {
    const indicators = makeIndicators({ rsi14: 32.1 });
    const result = detectNearMisses(indicators, 'mean_reversion', config);
    const rsiNm = result.filter(nm => nm.indicator === 'rsi14');
    expect(rsiNm).toHaveLength(0);
  });

  it('detects price vs lower Bollinger Band near-miss', () => {
    // lowerBB = 1900, price = 1901 → price > lowerBB && price <= 1900 * 1.001 = 1901.9
    const indicators = makeIndicators({
      lastPrice: 1901,
      bollingerBands: { upper: 2100, middle: 2000, lower: 1900 },
    });
    const result = detectNearMisses(indicators, 'mean_reversion', config);
    const bbNm = result.filter(nm => nm.indicator === 'price_vs_lower_bb');
    expect(bbNm).toHaveLength(1);
    expect(bbNm[0]).toEqual({
      indicator: 'price_vs_lower_bb',
      actual: 1901,
      threshold: 1900,
      distance: 1,
    });
  });

  it('does NOT detect price vs lower BB near-miss when price > lowerBB * 1.001', () => {
    // lowerBB = 1900, price = 1902 → 1902 > 1901.9, not within range
    const indicators = makeIndicators({
      lastPrice: 1902,
      bollingerBands: { upper: 2100, middle: 2000, lower: 1900 },
    });
    const result = detectNearMisses(indicators, 'mean_reversion', config);
    const bbNm = result.filter(nm => nm.indicator === 'price_vs_lower_bb');
    expect(bbNm).toHaveLength(0);
  });

  it('detects volume Z-score near-miss (same logic as trend_pullback)', () => {
    const indicators = makeIndicators({ volumeZScore: 0.85 });
    const result = detectNearMisses(indicators, 'mean_reversion', config);
    const volNm = result.filter(nm => nm.indicator === 'volume_z');
    expect(volNm).toHaveLength(1);
    expect(volNm[0].threshold).toBe(1.0);
    expect(volNm[0].distance).toBeCloseTo(0.15, 5);
  });

  it('detects multiple near-misses simultaneously', () => {
    // RSI = 31 (near 30 boundary) + volume = 0.9 (near threshold)
    const indicators = makeIndicators({
      rsi14: 31,
      volumeZScore: 0.9,
      lastPrice: 1901,
      bollingerBands: { upper: 2100, middle: 2000, lower: 1900 },
    });
    const result = detectNearMisses(indicators, 'mean_reversion', config);
    expect(result.length).toBeGreaterThanOrEqual(3);
    const indicatorNames = result.map(nm => nm.indicator);
    expect(indicatorNames).toContain('rsi14');
    expect(indicatorNames).toContain('volume_z');
    expect(indicatorNames).toContain('price_vs_lower_bb');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Distance Computation
// ═══════════════════════════════════════════════════════════════════════════

describe('detectNearMisses - distance computation', () => {
  const config = makeConfig();

  it('computes distance as |actual - threshold| for RSI lower boundary', () => {
    const indicators = makeIndicators({ rsi14: 33.5 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const rsiNm = result.find(nm => nm.indicator === 'rsi14');
    expect(rsiNm).toBeDefined();
    expect(rsiNm!.distance).toBeCloseTo(1.5, 5);
  });

  it('computes distance as |actual - threshold| for volume Z', () => {
    const indicators = makeIndicators({ volumeZScore: 0.85 });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    const volNm = result.find(nm => nm.indicator === 'volume_z');
    expect(volNm).toBeDefined();
    expect(volNm!.distance).toBeCloseTo(0.15, 5);
  });

  it('distance is always non-negative', () => {
    const indicators = makeIndicators({
      rsi14: 34,
      volumeZScore: 0.9,
      ema20: 1999,
      ema50: 2000,
    });
    const result = detectNearMisses(indicators, 'trend_pullback', config);
    for (const nm of result) {
      expect(nm.distance).toBeGreaterThanOrEqual(0);
    }
  });
});

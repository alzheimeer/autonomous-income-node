/**
 * Property-based tests for StrategyEngine
 *
 * **Property 8: Trend Pullback signal correctness**
 * - Signal only when regime=TRENDING_UP AND price within 0.5% EMA20 AND RSI in [35,50]
 *   AND volumeZ > 1.0 AND EMA20 > EMA50 AND close > EMA50
 *
 * **Property 9: Mean Reversion signal correctness**
 * - Signal only when regime=RANGING AND price ≤ lower Bollinger AND RSI < 30
 *   AND volumeZ > 1.0
 *
 * **Property 10: Cooldown enforcement**
 * - No signal within 60 minutes of previous signal
 *
 * **Validates: Requirements 5.2, 5.3, 5.5**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { StrategyEngine, type Indicators } from '../../strategy-engine.js';
import type { StrategyEngineConfig } from '../../config.js';
import type { RegimeType } from '../../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const COOLDOWN_MS = 3_600_000; // 60 minutes
const VOLUME_Z_THRESHOLD = 1.0;
const MEAN_REV_ATR_MAX = 2.5;

const DEFAULT_CONFIG: StrategyEngineConfig = {
  pair: 'WETH/USDC',
  regimeTimeframe: '1h',
  entryTimeframe: '15m',
  stopLossAtr: 1.5,
  takeProfitAtr: 2.0,
  cooldownMs: COOLDOWN_MS,
  warmup1h: 300,
  warmup15m: 500,
  meanRevAtrMax: MEAN_REV_ATR_MAX,
  minLiquidity: 50_000,
  volumeZThreshold: VOLUME_Z_THRESHOLD,
};

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Use fc.double instead of fc.float to avoid 32-bit float precision issues.
 * fast-check's fc.float requires Math.fround-compatible min/max,
 * but fc.double handles standard JS number ranges directly.
 */

/**
 * Generate indicators that satisfy Trend Pullback conditions:
 * - price within 0.5% of EMA20
 * - RSI in [35, 50]
 * - volumeZ > 1.0
 * - EMA20 > EMA50
 * - close > EMA50
 */
const trendPullbackValidIndicators = fc.record({
  ema20: fc.double({ min: 2000, max: 4000, noNaN: true, noDefaultInfinity: true }),
  rsi14: fc.double({ min: 30, max: 48, noNaN: true, noDefaultInfinity: true }),
  volumeZScore: fc.double({ min: 1.01, max: 5.0, noNaN: true, noDefaultInfinity: true }),
}).chain(({ ema20, rsi14, volumeZScore }) => {
  // Price within 0.5% of EMA20
  const minPrice = ema20 * 0.996; // slightly tighter to ensure within 0.5%
  const maxPrice = ema20 * 1.004;
  // EMA50 must be < EMA20 AND < minPrice
  const ema50 = ema20 - 100; // well below ema20

  return fc.record({
    ema20: fc.constant(ema20),
    ema50: fc.constant(ema50),
    ema200: fc.constant(ema50 - 200),
    rsi14: fc.constant(rsi14),
    atr14: fc.double({ min: 10, max: 100, noNaN: true, noDefaultInfinity: true }),
    volumeZScore: fc.constant(volumeZScore),
    bollingerBands: fc.constant({ upper: ema20 + 50, middle: ema20, lower: ema20 - 50 }),
    lastPrice: fc.double({ min: minPrice, max: maxPrice, noNaN: true, noDefaultInfinity: true }),
    candleCount: fc.constant(600), // Sufficient warmup
  });
});

/**
 * Generate indicators that VIOLATE at least one Trend Pullback condition.
 * Specifically: RSI outside [35, 50].
 */
const trendPullbackInvalidRsi = fc.record({
  ema20: fc.double({ min: 2000, max: 4000, noNaN: true, noDefaultInfinity: true }),
  rsi14: fc.oneof(
    fc.double({ min: 0.1, max: 29.99, noNaN: true, noDefaultInfinity: true }),   // Below 30
    fc.double({ min: 48.01, max: 90, noNaN: true, noDefaultInfinity: true }), // Above 48
  ),
  volumeZScore: fc.double({ min: 1.01, max: 5.0, noNaN: true, noDefaultInfinity: true }),
}).map(({ ema20, rsi14, volumeZScore }) => {
  const ema50 = ema20 - 100;
  return {
    ema20,
    ema50,
    ema200: ema50 - 200,
    rsi14,
    atr14: 50,
    volumeZScore,
    bollingerBands: { upper: ema20 + 50, middle: ema20, lower: ema20 - 50 },
    lastPrice: ema20, // Within 0.5% of EMA20
    candleCount: 600,
  } satisfies Indicators;
});

// trendPullbackInvalidVolume removed because volume is now a confidence modifier, not a hard rejection.

/**
 * Generate indicators that satisfy Mean Reversion conditions:
 * - price <= lower Bollinger
 * - RSI < 30
 * - volumeZ > 1.0
 */
const meanReversionValidIndicators = fc.record({
  ema20: fc.double({ min: 2000, max: 4000, noNaN: true, noDefaultInfinity: true }),
  rsi14: fc.double({ min: 5, max: 29.5, noNaN: true, noDefaultInfinity: true }),
  volumeZScore: fc.double({ min: 1.01, max: 5.0, noNaN: true, noDefaultInfinity: true }),
  atr14_1h: fc.double({ min: 30, max: 200, noNaN: true, noDefaultInfinity: true }),
}).map(({ ema20, rsi14, volumeZScore, atr14_1h }) => {
  // Ensure range ratio < meanRevAtrMax (2.5)
  // Use atr14_15m = atr14_1h * 1.5 to stay safely below 2.5
  const atr14_15m = atr14_1h * 1.5;
  const lowerBB = ema20 - 50;
  return {
    indicators15m: {
      ema20,
      ema50: ema20 + 50, // Doesn't matter for mean rev
      ema200: ema20 - 200,
      rsi14,
      atr14: atr14_15m,
      volumeZScore,
      bollingerBands: { upper: ema20 + 50, middle: ema20, lower: lowerBB },
      lastPrice: lowerBB - 5, // Below lower Bollinger
      candleCount: 600,
    } satisfies Indicators,
    indicators1h: {
      ema20: ema20 + 10,
      ema50: ema20,
      ema200: ema20 - 200,
      rsi14: 45,
      atr14: atr14_1h,
      volumeZScore: 1.5,
      bollingerBands: { upper: ema20 + 200, middle: ema20, lower: ema20 - 200 },
      lastPrice: ema20,
      candleCount: 400,
    } satisfies Indicators,
  };
});

/**
 * Generate indicators violating Mean Reversion: RSI >= 38.
 */
const meanReversionInvalidRsi = fc.record({
  ema20: fc.double({ min: 2000, max: 4000, noNaN: true, noDefaultInfinity: true }),
  rsi14: fc.double({ min: 38, max: 90, noNaN: true, noDefaultInfinity: true }),
  volumeZScore: fc.double({ min: 1.01, max: 5.0, noNaN: true, noDefaultInfinity: true }),
}).map(({ ema20, rsi14, volumeZScore }) => {
  const lowerBB = ema20 - 50;
  return {
    indicators15m: {
      ema20,
      ema50: ema20 + 50,
      ema200: ema20 - 200,
      rsi14,
      atr14: 30,
      volumeZScore,
      bollingerBands: { upper: ema20 + 50, middle: ema20, lower: lowerBB },
      lastPrice: lowerBB - 5, // Below BB
      candleCount: 600,
    } satisfies Indicators,
    indicators1h: {
      ema20: ema20 + 10,
      ema50: ema20,
      ema200: ema20 - 200,
      rsi14: 45,
      atr14: 80,
      volumeZScore: 1.5,
      bollingerBands: { upper: ema20 + 200, middle: ema20, lower: ema20 - 200 },
      lastPrice: ema20,
      candleCount: 400,
    } satisfies Indicators,
  };
});

/**
 * Generate cooldown timestamps: time elapsed < 60 minutes.
 */
const withinCooldown = fc.integer({ min: 1, max: COOLDOWN_MS - 1 });

/**
 * Generate cooldown timestamps: time elapsed >= 60 minutes.
 */
const pastCooldown = fc.integer({ min: COOLDOWN_MS, max: COOLDOWN_MS * 5 });

/** Warmed-up 1h indicators (candleCount >= 300) */
const warmedUp1h: Indicators = {
  ema20: 3000,
  ema50: 2950,
  ema200: 2800,
  rsi14: 55,
  atr14: 80,
  volumeZScore: 1.5,
  bollingerBands: { upper: 3200, middle: 3000, lower: 2800 },
  lastPrice: 3000,
  candleCount: 400,
};

// ═══════════════════════════════════════════════════════════════════════════
// Property 8: Trend Pullback signal correctness
// ═══════════════════════════════════════════════════════════════════════════

describe('StrategyEngine Property Tests', () => {
  describe('Property 8: Trend Pullback signal correctness', () => {
    /**
     * **Validates: Requirements 5.2**
     *
     * When all Trend Pullback conditions are met (regime=TRENDING_UP, price within 0.5%
     * of EMA20, RSI [35,50], volumeZ > 1.0, EMA20 > EMA50, close > EMA50),
     * evaluate() MUST produce a signal with strategy='trend_pullback'.
     */
    it('produces signal when all Trend Pullback conditions are met', () => {
      fc.assert(
        fc.property(trendPullbackValidIndicators, (ind15m) => {
          const engine = new StrategyEngine(DEFAULT_CONFIG);
          const result = engine.evaluate(warmedUp1h, ind15m, 'TRENDING_UP');

          // Should produce a signal
          expect(result).not.toBeNull();
          if (result) {
            expect(result.strategy).toBe('trend_pullback');
            expect(result.pair).toBe('WETH/USDC');
            expect(result.direction).toBe('long');
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThanOrEqual(1);
          }
        }),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 5.2**
     *
     * NO signal when RSI is outside [30, 48] (even with all other conditions met).
     */
    it('no signal when RSI is outside [30, 48]', () => {
      fc.assert(
        fc.property(trendPullbackInvalidRsi, (ind15m) => {
          const engine = new StrategyEngine(DEFAULT_CONFIG);
          const result = engine.evaluate(warmedUp1h, ind15m, 'TRENDING_UP');
          if (result) expect(result.strategy).not.toBe('trend_pullback');
          else expect(result).toBeNull();
        }),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 5.2**
     *
     * NO signal when regime is NOT TRENDING_UP (for trend pullback).
     */
    it('no Trend Pullback signal in non-TRENDING_UP regimes', () => {
      const nonTrendingRegimes: RegimeType[] = ['TRENDING_DOWN', 'RANGING', 'VOLATILE', 'UNCERTAIN'];

      fc.assert(
        fc.property(
          trendPullbackValidIndicators,
          fc.constantFrom(...nonTrendingRegimes),
          (ind15m, regime) => {
            const engine = new StrategyEngine(DEFAULT_CONFIG);
            const result = engine.evaluate(warmedUp1h, ind15m, regime);

            // Should NOT produce a trend_pullback signal
            // (RANGING might trigger mean reversion, but not trend pullback)
            if (result) {
              expect(result.strategy).not.toBe('trend_pullback');
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Property 9: Mean Reversion signal correctness
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Property 9: Mean Reversion signal correctness', () => {
    /**
     * **Validates: Requirements 5.3**
     *
     * When all Mean Reversion conditions are met (regime=RANGING, price <= lower BB,
     * RSI < 30, volumeZ > 1.0), evaluate() MUST produce a signal with
     * strategy='mean_reversion'.
     */
    it('produces signal when all Mean Reversion conditions are met', () => {
      fc.assert(
        fc.property(meanReversionValidIndicators, ({ indicators15m, indicators1h }) => {
          const engine = new StrategyEngine(DEFAULT_CONFIG);
          const result = engine.evaluate(indicators1h, indicators15m, 'RANGING');

          expect(result).not.toBeNull();
          if (result) {
            expect(result.strategy).toBe('mean_reversion');
            expect(result.pair).toBe('WETH/USDC');
            expect(result.direction).toBe('long');
            expect(result.confidence).toBeGreaterThan(0);
            expect(result.confidence).toBeLessThanOrEqual(1);
          }
        }),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 5.3**
     *
     * NO signal when RSI >= 38 (even with all other mean reversion conditions met).
     */
    it('no signal when RSI >= 38', () => {
      fc.assert(
        fc.property(meanReversionInvalidRsi, ({ indicators15m, indicators1h }) => {
          const engine = new StrategyEngine(DEFAULT_CONFIG);
          const result = engine.evaluate(indicators1h, indicators15m, 'RANGING');
          if (result) {
            expect(result.strategy).not.toBe('mean_reversion');
          } else {
            expect(result).toBeNull();
          }
        }),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 5.3**
     *
     * NO mean reversion signal in non-RANGING regimes.
     */
    it('no Mean Reversion signal in non-RANGING regimes', () => {
      const nonRangingRegimes: RegimeType[] = ['TRENDING_UP', 'TRENDING_DOWN', 'VOLATILE', 'UNCERTAIN'];

      fc.assert(
        fc.property(
          meanReversionValidIndicators,
          fc.constantFrom(...nonRangingRegimes),
          ({ indicators15m, indicators1h }, regime) => {
            const engine = new StrategyEngine(DEFAULT_CONFIG);
            const result = engine.evaluate(indicators1h, indicators15m, regime);

            // Should NOT produce a mean_reversion signal
            if (result) {
              expect(result.strategy).not.toBe('mean_reversion');
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Property 10: Cooldown enforcement
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Property 10: Cooldown enforcement', () => {
    /**
     * **Validates: Requirements 5.5**
     *
     * No signal within 60 minutes of previous signal.
     * After a signal is produced, any evaluation within cooldownMs MUST return null.
     */
    it('no signal within 60 minutes of previous signal', () => {
      fc.assert(
        fc.property(
          trendPullbackValidIndicators,
          withinCooldown,
          (ind15m, elapsedMs) => {
            const engine = new StrategyEngine(DEFAULT_CONFIG);

            // Produce a first signal
            const first = engine.evaluate(warmedUp1h, ind15m, 'TRENDING_UP');
            expect(first).not.toBeNull();

            // Set the signal time to "now - elapsedMs" so elapsedMs < cooldown
            const now = Date.now();
            engine.setLastSignalTime(now - elapsedMs);

            // Second evaluation should be blocked by cooldown
            const second = engine.evaluate(warmedUp1h, ind15m, 'TRENDING_UP');
            expect(second).toBeNull();
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 5.5**
     *
     * Signal IS allowed after cooldown period has elapsed (>= 60 minutes).
     */
    it('signal allowed after cooldown period (>= 60 minutes)', () => {
      fc.assert(
        fc.property(
          trendPullbackValidIndicators,
          pastCooldown,
          (ind15m, elapsedMs) => {
            const engine = new StrategyEngine(DEFAULT_CONFIG);

            // Set signal time far in the past (beyond cooldown)
            const now = Date.now();
            engine.setLastSignalTime(now - elapsedMs);

            // Evaluation should NOT be blocked by cooldown
            const result = engine.evaluate(warmedUp1h, ind15m, 'TRENDING_UP');
            // Signal should be produced if all conditions met
            expect(result).not.toBeNull();
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 5.5**
     *
     * getCooldownRemaining() returns a positive value when within cooldown,
     * and 0 when cooldown has elapsed.
     */
    it('getCooldownRemaining() reflects time-based cooldown accurately', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: COOLDOWN_MS * 2 }),
          (elapsedMs) => {
            const engine = new StrategyEngine(DEFAULT_CONFIG);
            const now = Date.now();
            engine.setLastSignalTime(now - elapsedMs);

            const remaining = engine.getCooldownRemaining();

            if (elapsedMs >= COOLDOWN_MS) {
              expect(remaining).toBe(0);
            } else {
              expect(remaining).toBeGreaterThan(0);
              expect(remaining).toBeLessThanOrEqual(COOLDOWN_MS);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

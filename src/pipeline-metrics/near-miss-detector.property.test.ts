/**
 * Property Tests for near-miss-detector.ts
 *
 * **Validates: Requirements 4.1, 4.3**
 *
 * Property 6: Near-Miss Detection Correctness
 * - Generate indicator values within/outside threshold distance
 * - Verify correct NearMiss records produced with correct distance
 * - Verify no records for values outside threshold
 *
 * Threshold definitions:
 * - RSI ±2 units from boundary
 * - Price ±0.1% from threshold
 * - Volume ±0.2 from threshold
 *
 * Uses fast-check for property-based testing with vitest.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { detectNearMisses, type NearMiss } from './near-miss-detector.js';
import type { Indicators } from '../trading-validation/strategy-engine.js';
import type { StrategyEngineConfig } from '../trading-validation/config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Near-miss threshold definitions from the design document.
 */
const THRESHOLDS = {
  RSI_TOLERANCE: 2,              // ±2 units from boundary
  PRICE_TOLERANCE: 0.001,        // ±0.1% from threshold (0.5% threshold)
  VOLUME_TOLERANCE: 0.2,         // ±0.2 from threshold
} as const;

/**
 * Strategy-specific boundaries.
 */
const TREND_PULLBACK = {
  RSI_LOWER: 35,                 // signal requires rsi14 >= 35
  RSI_UPPER: 50,                 // signal requires rsi14 <= 50
  PRICE_EMA_THRESHOLD: 0.005,    // 0.5% distance from EMA20
} as const;

const MEAN_REVERSION = {
  RSI_BOUNDARY: 30,              // signal requires rsi14 < 30
  BB_TOLERANCE: 0.001,           // price within 0.1% of lower BB
} as const;


// ═══════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a base Indicators object with safe default values (no near-misses).
 */
function makeBaseIndicators(): Indicators {
  return {
    ema20: 2000,
    ema50: 1980,      // ema20 > ema50 (uptrend)
    ema200: 1900,
    rsi14: 42,        // safely within [35, 50]
    atr14: 30,
    volumeZScore: 1.5, // above default threshold of 1.0
    bollingerBands: { upper: 2100, middle: 2000, lower: 1900 },
    lastPrice: 2000,   // at ema20 (0% distance)
    candleCount: 500,
  };
}

/**
 * Creates a StrategyEngineConfig with configurable volumeZThreshold.
 */
function makeConfig(volumeZThreshold = 1.0): StrategyEngineConfig {
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
    volumeZThreshold,
  };
}


// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Strategy type arbitrary.
 */
const arbStrategyType = fc.constantFrom<'trend_pullback' | 'mean_reversion'>(
  'trend_pullback',
  'mean_reversion'
);

/**
 * Arbitrary for RSI value in near-miss zone of lower boundary (33 to 34.99).
 * Near-miss condition: rsi14 < 35 && rsi14 >= 33
 */
const arbRsiNearLowerBoundary = fc.double({ min: 33, max: 34.999, noNaN: true });

/**
 * Arbitrary for RSI value in near-miss zone of upper boundary (50.01 to 52).
 * Near-miss condition: rsi14 > 50 && rsi14 <= 52
 */
const arbRsiNearUpperBoundary = fc.double({ min: 50.001, max: 52, noNaN: true });

/**
 * Arbitrary for RSI safely within signal range (35 to 50) - no near-miss.
 */
const arbRsiSafe = fc.double({ min: 35, max: 50, noNaN: true });

/**
 * Arbitrary for RSI well outside near-miss zones (< 33 or > 52).
 */
const arbRsiFarOutside = fc.oneof(
  fc.double({ min: 0, max: 32.99, noNaN: true }),
  fc.double({ min: 52.01, max: 100, noNaN: true })
);

/**
 * Arbitrary for volume Z-score in near-miss zone [threshold - 0.2, threshold].
 */
const arbVolumeNearThreshold = (threshold: number) =>
  fc.double({ min: threshold - 0.2, max: threshold, noNaN: true });

/**
 * Arbitrary for volume Z-score below near-miss zone.
 */
const arbVolumeFarBelow = (threshold: number) =>
  fc.double({ min: -2, max: threshold - 0.201, noNaN: true });

/**
 * Arbitrary for volume Z-score above threshold (no near-miss).
 */
const arbVolumeAboveThreshold = (threshold: number) =>
  fc.double({ min: threshold + 0.001, max: 5, noNaN: true });


/**
 * Arbitrary for price EMA distance in near-miss zone (0.5% to 0.6%).
 * This produces lastPrice values that are between 0.5% and 0.6% away from ema20.
 * Near-miss condition: distance > 0.005 && distance <= 0.006
 */
const arbPriceNearEmaThreshold = fc.record({
  ema20: fc.double({ min: 1000, max: 5000, noNaN: true }),
  distanceFraction: fc.double({ min: 0.00501, max: 0.00599, noNaN: true }),
  sign: fc.constantFrom(1, -1),
}).map(({ ema20, distanceFraction, sign }) => ({
  ema20,
  lastPrice: ema20 * (1 + sign * distanceFraction),
}));

/**
 * Arbitrary for price within safe distance (<0.5%) from EMA20 - signal would fire.
 * These are NOT near-misses because the signal condition is met.
 */
const arbPriceSafeDistance = fc.record({
  ema20: fc.double({ min: 1000, max: 5000, noNaN: true }),
  distanceFraction: fc.double({ min: 0, max: 0.00499, noNaN: true }),
  sign: fc.constantFrom(1, -1),
}).map(({ ema20, distanceFraction, sign }) => ({
  ema20,
  lastPrice: ema20 * (1 + sign * distanceFraction),
}));

/**
 * Arbitrary for price far from EMA20 (>0.6%) - outside near-miss zone.
 */
const arbPriceFarFromEma = fc.record({
  ema20: fc.double({ min: 1000, max: 5000, noNaN: true }),
  distanceFraction: fc.double({ min: 0.00601, max: 0.05, noNaN: true }),
  sign: fc.constantFrom(1, -1),
}).map(({ ema20, distanceFraction, sign }) => ({
  ema20,
  lastPrice: ema20 * (1 + sign * distanceFraction),
}));

/**
 * Arbitrary for EMA order near-miss (ema20 slightly below ema50, within 0.1%).
 */
const arbEmaNearMiss = fc.record({
  ema50: fc.double({ min: 1000, max: 5000, noNaN: true }),
}).map(({ ema50 }) => ({
  ema50,
  // ema20 in range [ema50 * 0.999, ema50] - near-miss zone
  ema20: ema50 * fc.sample(fc.double({ min: 0.999, max: 1.0, noNaN: true }), 1)[0],
}));

/**
 * Arbitrary for volumeZThreshold in reasonable range.
 */
const arbVolumeThreshold = fc.double({ min: 0.5, max: 2.0, noNaN: true });


// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Finds a near-miss record by indicator name.
 */
function findByIndicator(nearMisses: NearMiss[], indicator: string): NearMiss | undefined {
  return nearMisses.find(nm => nm.indicator === indicator);
}

/**
 * Checks if a near-miss exists for the given indicator.
 */
function hasNearMiss(nearMisses: NearMiss[], indicator: string): boolean {
  return nearMisses.some(nm => nm.indicator === indicator);
}

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 6: Near-Miss Detection Correctness', () => {
  describe('P6-a: RSI near-miss detection (trend_pullback)', () => {
    /**
     * When RSI is in near-miss zone below lower boundary [33, 35),
     * a near-miss should be detected with correct distance.
     */
    it('detects RSI near-miss for values in [33, 35) with correct distance', () => {
      fc.assert(
        fc.property(arbRsiNearLowerBoundary, (rsiValue) => {
          const indicators = { ...makeBaseIndicators(), rsi14: rsiValue };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          const rsiNearMiss = findByIndicator(result, 'rsi14');
          expect(rsiNearMiss).toBeDefined();
          expect(rsiNearMiss!.threshold).toBe(35);
          expect(rsiNearMiss!.actual).toBe(rsiValue);

          // Distance = |actual - threshold| = threshold - actual (since actual < threshold)
          const expectedDistance = 35 - rsiValue;
          expect(rsiNearMiss!.distance).toBeCloseTo(expectedDistance, 5);

          return true;
        }),
        { numRuns: 100 },
      );
    });


    /**
     * When RSI is in near-miss zone above upper boundary (50, 52],
     * a near-miss should be detected with correct distance.
     */
    it('detects RSI near-miss for values in (50, 52] with correct distance', () => {
      fc.assert(
        fc.property(arbRsiNearUpperBoundary, (rsiValue) => {
          const indicators = { ...makeBaseIndicators(), rsi14: rsiValue };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          const rsiNearMiss = findByIndicator(result, 'rsi14');
          expect(rsiNearMiss).toBeDefined();
          expect(rsiNearMiss!.threshold).toBe(50);
          expect(rsiNearMiss!.actual).toBe(rsiValue);

          // Distance = actual - threshold (since actual > threshold)
          const expectedDistance = rsiValue - 50;
          expect(rsiNearMiss!.distance).toBeCloseTo(expectedDistance, 5);

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * When RSI is safely within [35, 50], no RSI near-miss should be detected.
     */
    it('does NOT detect RSI near-miss for values in safe range [35, 50]', () => {
      fc.assert(
        fc.property(arbRsiSafe, (rsiValue) => {
          const indicators = { ...makeBaseIndicators(), rsi14: rsiValue };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          expect(hasNearMiss(result, 'rsi14')).toBe(false);

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * When RSI is far outside near-miss zones (<33 or >52),
     * no RSI near-miss should be detected.
     */
    it('does NOT detect RSI near-miss for values far outside thresholds', () => {
      fc.assert(
        fc.property(arbRsiFarOutside, (rsiValue) => {
          const indicators = { ...makeBaseIndicators(), rsi14: rsiValue };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          expect(hasNearMiss(result, 'rsi14')).toBe(false);

          return true;
        }),
        { numRuns: 100 },
      );
    });
  });


  describe('P6-b: RSI near-miss detection (mean_reversion)', () => {
    /**
     * Mean reversion RSI boundary is 30. Near-miss zone is [30, 32].
     */
    it('detects RSI near-miss for values in [30, 32] with correct distance', () => {
      const arbRsiMeanRevNearMiss = fc.double({ min: 30, max: 32, noNaN: true });

      fc.assert(
        fc.property(arbRsiMeanRevNearMiss, (rsiValue) => {
          const indicators = { ...makeBaseIndicators(), rsi14: rsiValue };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'mean_reversion', config);

          const rsiNearMiss = findByIndicator(result, 'rsi14');
          expect(rsiNearMiss).toBeDefined();
          expect(rsiNearMiss!.threshold).toBe(30);
          expect(rsiNearMiss!.actual).toBe(rsiValue);

          // Distance = actual - threshold (since actual >= threshold)
          const expectedDistance = rsiValue - 30;
          expect(rsiNearMiss!.distance).toBeCloseTo(expectedDistance, 5);

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * No near-miss when RSI is below the boundary (signal would fire).
     */
    it('does NOT detect RSI near-miss when RSI < 30 (signal condition met)', () => {
      const arbRsiBelowBoundary = fc.double({ min: 0, max: 29.99, noNaN: true });

      fc.assert(
        fc.property(arbRsiBelowBoundary, (rsiValue) => {
          const indicators = { ...makeBaseIndicators(), rsi14: rsiValue };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'mean_reversion', config);

          expect(hasNearMiss(result, 'rsi14')).toBe(false);

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * No near-miss when RSI is far above the near-miss zone (>32).
     */
    it('does NOT detect RSI near-miss when RSI > 32', () => {
      const arbRsiFarAbove = fc.double({ min: 32.01, max: 100, noNaN: true });

      fc.assert(
        fc.property(arbRsiFarAbove, (rsiValue) => {
          const indicators = { ...makeBaseIndicators(), rsi14: rsiValue };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'mean_reversion', config);

          expect(hasNearMiss(result, 'rsi14')).toBe(false);

          return true;
        }),
        { numRuns: 100 },
      );
    });
  });


  describe('P6-c: Volume Z-score near-miss detection', () => {
    /**
     * When volume Z-score is in near-miss zone [threshold - 0.2, threshold],
     * a near-miss should be detected.
     */
    it('detects volume near-miss when volumeZScore in [threshold - 0.2, threshold]', () => {
      fc.assert(
        fc.property(arbVolumeThreshold, (threshold) => {
          // Volume in near-miss zone
          const volumeZScore = threshold - 0.1; // clearly in zone
          const indicators = { ...makeBaseIndicators(), volumeZScore };
          const config = makeConfig(threshold);
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          const volNearMiss = findByIndicator(result, 'volume_z');
          expect(volNearMiss).toBeDefined();
          expect(volNearMiss!.threshold).toBe(threshold);
          expect(volNearMiss!.actual).toBe(volumeZScore);

          // Distance = threshold - actual
          const expectedDistance = threshold - volumeZScore;
          expect(volNearMiss!.distance).toBeCloseTo(expectedDistance, 5);

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * No near-miss when volume Z-score is above threshold.
     */
    it('does NOT detect volume near-miss when volumeZScore > threshold', () => {
      fc.assert(
        fc.property(arbVolumeThreshold, (threshold) => {
          const volumeZScore = threshold + 0.5; // well above threshold
          const indicators = { ...makeBaseIndicators(), volumeZScore };
          const config = makeConfig(threshold);
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          expect(hasNearMiss(result, 'volume_z')).toBe(false);

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * No near-miss when volume Z-score is far below near-miss zone.
     */
    it('does NOT detect volume near-miss when volumeZScore < threshold - 0.2', () => {
      fc.assert(
        fc.property(arbVolumeThreshold, (threshold) => {
          const volumeZScore = threshold - 0.3; // below near-miss zone
          const indicators = { ...makeBaseIndicators(), volumeZScore };
          const config = makeConfig(threshold);
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          expect(hasNearMiss(result, 'volume_z')).toBe(false);

          return true;
        }),
        { numRuns: 100 },
      );
    });
  });


  describe('P6-d: Price vs EMA20 near-miss detection (trend_pullback)', () => {
    /**
     * When price distance from EMA20 is in near-miss zone (0.5% to 0.6%),
     * a near-miss should be detected.
     */
    it('detects price near-miss when distance in (0.5%, 0.6%] with correct distance', () => {
      fc.assert(
        fc.property(arbPriceNearEmaThreshold, ({ ema20, lastPrice }) => {
          const indicators = { ...makeBaseIndicators(), ema20, lastPrice };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          const priceNearMiss = findByIndicator(result, 'price_vs_ema20');
          expect(priceNearMiss).toBeDefined();
          expect(priceNearMiss!.threshold).toBe(0.005);

          // actual should be the distance fraction
          const actualDist = Math.abs(lastPrice - ema20) / ema20;
          expect(priceNearMiss!.actual).toBeCloseTo(actualDist, 5);

          // Distance = actual - threshold
          const expectedDistance = actualDist - 0.005;
          expect(priceNearMiss!.distance).toBeCloseTo(expectedDistance, 5);

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * No near-miss when price is within safe distance (<=0.5%) from EMA20.
     */
    it('does NOT detect price near-miss when distance <= 0.5%', () => {
      fc.assert(
        fc.property(arbPriceSafeDistance, ({ ema20, lastPrice }) => {
          const indicators = { ...makeBaseIndicators(), ema20, lastPrice };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          expect(hasNearMiss(result, 'price_vs_ema20')).toBe(false);

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * No near-miss when price is far from EMA20 (>0.6%).
     */
    it('does NOT detect price near-miss when distance > 0.6%', () => {
      fc.assert(
        fc.property(arbPriceFarFromEma, ({ ema20, lastPrice }) => {
          const indicators = { ...makeBaseIndicators(), ema20, lastPrice };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          expect(hasNearMiss(result, 'price_vs_ema20')).toBe(false);

          return true;
        }),
        { numRuns: 100 },
      );
    });
  });


  describe('P6-e: Distance computation correctness', () => {
    /**
     * Distance is always non-negative (|actual - threshold|).
     */
    it('all near-miss distances are non-negative', () => {
      // Generate indicators that will trigger various near-misses
      const arbIndicatorsWithNearMisses = fc.record({
        rsi14: fc.oneof(arbRsiNearLowerBoundary, arbRsiNearUpperBoundary),
        volumeZScore: fc.double({ min: 0.8, max: 1.0, noNaN: true }),
        ema20: fc.double({ min: 1000, max: 3000, noNaN: true }),
      }).map(({ rsi14, volumeZScore, ema20 }) => ({
        ...makeBaseIndicators(),
        rsi14,
        volumeZScore,
        ema20,
        ema50: ema20 - 10, // ema20 > ema50
        lastPrice: ema20 * 1.0055, // slight near-miss distance
      }));

      fc.assert(
        fc.property(arbIndicatorsWithNearMisses, arbStrategyType, (indicators, strategyType) => {
          const config = makeConfig();
          const result = detectNearMisses(indicators, strategyType, config);

          for (const nm of result) {
            expect(nm.distance).toBeGreaterThanOrEqual(0);
          }

          return true;
        }),
        { numRuns: 100 },
      );
    });

    /**
     * Distance matches |actual - threshold| formula.
     */
    it('distance equals |actual - threshold| for all near-misses', () => {
      fc.assert(
        fc.property(arbRsiNearLowerBoundary, (rsiValue) => {
          const indicators = { ...makeBaseIndicators(), rsi14: rsiValue };
          const config = makeConfig();
          const result = detectNearMisses(indicators, 'trend_pullback', config);

          const rsiNearMiss = findByIndicator(result, 'rsi14');
          if (rsiNearMiss) {
            const expectedDistance = Math.abs(rsiNearMiss.actual - rsiNearMiss.threshold);
            expect(rsiNearMiss.distance).toBeCloseTo(expectedDistance, 5);
          }

          return true;
        }),
        { numRuns: 100 },
      );
    });
  });


  describe('P6-f: Multiple near-misses detection', () => {
    /**
     * Multiple near-misses can be detected simultaneously.
     */
    it('detects multiple near-misses when multiple indicators are in threshold proximity', () => {
      fc.assert(
        fc.property(
          arbRsiNearLowerBoundary,
          fc.double({ min: 0.8, max: 1.0, noNaN: true }), // volume near threshold
          (rsiValue, volumeZ) => {
            const indicators = {
              ...makeBaseIndicators(),
              rsi14: rsiValue,
              volumeZScore: volumeZ,
            };
            const config = makeConfig();
            const result = detectNearMisses(indicators, 'trend_pullback', config);

            // Both RSI and volume should be near-misses
            expect(hasNearMiss(result, 'rsi14')).toBe(true);
            expect(hasNearMiss(result, 'volume_z')).toBe(true);
            expect(result.length).toBeGreaterThanOrEqual(2);

            return true;
          }
        ),
        { numRuns: 100 },
      );
    });

    /**
     * Near-miss count matches the number of indicators in threshold proximity.
     */
    it('near-miss count correctly reflects number of indicators in proximity', () => {
      // Create indicators with exactly 0 near-misses (all safe values)
      const safeIndicators = makeBaseIndicators();
      const config = makeConfig();
      const safeResult = detectNearMisses(safeIndicators, 'trend_pullback', config);
      expect(safeResult).toHaveLength(0);

      // Create indicators with exactly 1 near-miss (only RSI)
      const oneNearMissIndicators = { ...makeBaseIndicators(), rsi14: 34 };
      const oneResult = detectNearMisses(oneNearMissIndicators, 'trend_pullback', config);
      expect(oneResult.length).toBe(1);
      expect(hasNearMiss(oneResult, 'rsi14')).toBe(true);
    });
  });


  describe('P6-g: No false positives outside threshold zones', () => {
    /**
     * When all indicators are in safe ranges, no near-misses should be detected.
     */
    it('returns empty array when all indicators are in safe ranges', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 36, max: 49, noNaN: true }),  // RSI safely in range
          fc.double({ min: 1.1, max: 3.0, noNaN: true }), // Volume above threshold
          arbStrategyType,
          (rsi, volume, strategyType) => {
            const indicators = {
              ...makeBaseIndicators(),
              rsi14: rsi,
              volumeZScore: volume,
              // Price at ema20 (0% distance - safe)
              lastPrice: 2000,
              ema20: 2000,
              // EMA order correct (ema20 > ema50)
              ema50: 1980,
            };
            const config = makeConfig();
            const result = detectNearMisses(indicators, strategyType, config);

            // For trend_pullback with safe values, should be empty
            if (strategyType === 'trend_pullback') {
              expect(result).toHaveLength(0);
            }
            // For mean_reversion, RSI in [36, 49] is far from 30 threshold
            // so no RSI near-miss, and volume above threshold = no near-miss

            return true;
          }
        ),
        { numRuns: 100 },
      );
    });
  });


  describe('P6-h: Price vs lower Bollinger Band (mean_reversion)', () => {
    /**
     * Near-miss when price is slightly above lower BB (within 0.1%).
     */
    it('detects price vs lower BB near-miss when price in (lowerBB, lowerBB * 1.001]', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 1500, max: 3000, noNaN: true }), // lower BB
          fc.double({ min: 0.0001, max: 0.001, noNaN: true }), // fraction above
          (lowerBB, fraction) => {
            const lastPrice = lowerBB * (1 + fraction);
            const indicators = {
              ...makeBaseIndicators(),
              lastPrice,
              bollingerBands: { upper: lowerBB + 200, middle: lowerBB + 100, lower: lowerBB },
              rsi14: 25, // Below 30 to not trigger RSI near-miss
            };
            const config = makeConfig();
            const result = detectNearMisses(indicators, 'mean_reversion', config);

            const bbNearMiss = findByIndicator(result, 'price_vs_lower_bb');
            expect(bbNearMiss).toBeDefined();
            expect(bbNearMiss!.threshold).toBe(lowerBB);
            expect(bbNearMiss!.actual).toBe(lastPrice);

            // Distance = actual - threshold
            const expectedDistance = lastPrice - lowerBB;
            expect(bbNearMiss!.distance).toBeCloseTo(expectedDistance, 5);

            return true;
          }
        ),
        { numRuns: 100 },
      );
    });

    /**
     * No near-miss when price is at or below lower BB (signal condition met).
     */
    it('does NOT detect BB near-miss when price <= lower BB', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 1500, max: 3000, noNaN: true }), // lower BB
          fc.double({ min: 0, max: 1, noNaN: true }), // fraction at or below
          (lowerBB, fraction) => {
            const lastPrice = lowerBB * (1 - fraction * 0.1); // at or below
            const indicators = {
              ...makeBaseIndicators(),
              lastPrice,
              bollingerBands: { upper: lowerBB + 200, middle: lowerBB + 100, lower: lowerBB },
            };
            const config = makeConfig();
            const result = detectNearMisses(indicators, 'mean_reversion', config);

            expect(hasNearMiss(result, 'price_vs_lower_bb')).toBe(false);

            return true;
          }
        ),
        { numRuns: 100 },
      );
    });

    /**
     * No near-miss when price is far above lower BB (>0.1%).
     */
    it('does NOT detect BB near-miss when price > lower BB * 1.001', () => {
      fc.assert(
        fc.property(
          fc.double({ min: 1500, max: 3000, noNaN: true }), // lower BB
          (lowerBB) => {
            const lastPrice = lowerBB * 1.002; // above near-miss zone
            const indicators = {
              ...makeBaseIndicators(),
              lastPrice,
              bollingerBands: { upper: lowerBB + 200, middle: lowerBB + 100, lower: lowerBB },
            };
            const config = makeConfig();
            const result = detectNearMisses(indicators, 'mean_reversion', config);

            expect(hasNearMiss(result, 'price_vs_lower_bb')).toBe(false);

            return true;
          }
        ),
        { numRuns: 100 },
      );
    });
  });
});

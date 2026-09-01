/**
 * Property Tests for Strategy Sub-Reason Normalization
 *
 * **Validates: Requirements 3.3**
 *
 * Property 5: Strategy Sub-Reason Normalization
 * - Generate arbitrary indicator values, regime, position state, cooldown
 * - Verify exactly one normalized sub-reason is returned when no signal produced
 * - Verify the 15 sub-reason keys are correctly detected
 *
 * Uses fast-check for property-based testing with vitest.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  detectStrategySubReason,
  getStrategySubReasonKeys,
  type StrategySubReasonKey,
} from './rejection-normalizer.js';
import type { Indicators } from '../trading-validation/strategy-engine.js';
import type { RegimeType } from '../trading-validation/types.js';
import type { StrategyEngineConfig } from '../trading-validation/config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * All 13 known strategy sub-reason keys from the implementation.
 * Note: The design doc mentions 15 keys but implementation has 13.
 */
const ALL_STRATEGY_SUB_REASON_KEYS: readonly StrategySubReasonKey[] = [
  // General (checked first in priority order)
  'warmup_incomplete',
  'position_open',
  'regime_not_actionable',
  'cooldown_active',
  // Trend Pullback specific
  'trend_ema_distance',
  'trend_rsi_out_of_range',
  'trend_volume_low',
  'trend_ema_order',
  'trend_price_below_ema50',
  // Mean Reversion specific
  'mean_rev_above_bb',
  'mean_rev_rsi_high',
  'mean_rev_volume_low',
  'mean_rev_atr_ratio',
] as const;

/**
 * Regimes that are "actionable" (allow trading).
 */
const ACTIONABLE_REGIMES: readonly RegimeType[] = ['TRENDING_UP', 'RANGING'] as const;

/**
 * Regimes that are "not actionable" (no trading).
 */
const NON_ACTIONABLE_REGIMES: readonly RegimeType[] = [
  'TRENDING_DOWN',
  'VOLATILE',
  'UNCERTAIN',
] as const;

/**
 * All possible regime types.
 */
const ALL_REGIMES: readonly RegimeType[] = [
  'TRENDING_UP',
  'TRENDING_DOWN',
  'RANGING',
  'VOLATILE',
  'UNCERTAIN',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Test Config Factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a minimal StrategyEngineConfig with required fields for testing.
 */
function createTestConfig(volumeZThreshold: number = 0.5): StrategyEngineConfig {
  return {
    pair: 'WETH/USDC',
    regimeTimeframe: '1h',
    entryTimeframe: '15m',
    stopLossAtr: 1.8,
    takeProfitAtr: 2.5,
    cooldownMs: 1800000,
    warmup1h: 100,
    warmup15m: 200,
    meanRevAtrMax: 2.0,
    minLiquidity: 30000,
    volumeZThreshold,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arbitrary for a single regime type.
 */
const arbRegime = fc.constantFrom<RegimeType>(...ALL_REGIMES);

/**
 * Arbitrary for actionable regimes only.
 */
const arbActionableRegime = fc.constantFrom<RegimeType>(...ACTIONABLE_REGIMES);

/**
 * Arbitrary for non-actionable regimes only.
 */
const arbNonActionableRegime = fc.constantFrom<RegimeType>(...NON_ACTIONABLE_REGIMES);

/**
 * Arbitrary for boolean (position open state).
 */
const arbPositionOpen = fc.boolean();

/**
 * Arbitrary for cooldown remaining (0 to 3600000ms).
 */
const arbCooldownRemaining = fc.integer({ min: 0, max: 3600000 });

/**
 * Arbitrary for positive cooldown (> 0).
 */
const arbPositiveCooldown = fc.integer({ min: 1, max: 3600000 });

/**
 * Arbitrary for zero cooldown.
 */
const arbZeroCooldown = fc.constant(0);

/**
 * Arbitrary for volumeZThreshold in config.
 */
const arbVolumeZThreshold = fc.double({ min: 0.1, max: 2.0, noNaN: true });

/**
 * Arbitrary for Bollinger Bands (lower < middle < upper).
 */
const arbBollingerBands = fc
  .tuple(
    fc.double({ min: 100, max: 5000, noNaN: true }),
    fc.double({ min: 0.01, max: 0.1, noNaN: true }),
  )
  .map(([middle, spread]) => ({
    lower: middle * (1 - spread),
    middle,
    upper: middle * (1 + spread),
  }));

/**
 * Arbitrary for valid Indicators with all required fields.
 */
const arbIndicators = fc
  .record({
    ema20: fc.double({ min: 100, max: 5000, noNaN: true }),
    ema50: fc.double({ min: 100, max: 5000, noNaN: true }),
    ema200: fc.double({ min: 100, max: 5000, noNaN: true }),
    rsi14: fc.double({ min: 0, max: 100, noNaN: true }),
    atr14: fc.double({ min: 0.1, max: 100, noNaN: true }),
    volumeZScore: fc.double({ min: -3, max: 5, noNaN: true }),
    lastPrice: fc.double({ min: 100, max: 5000, noNaN: true }),
    candleCount: fc.integer({ min: 26, max: 1000 }),
  })
  .chain((base) =>
    arbBollingerBands.map((bollingerBands) => ({
      ...base,
      bollingerBands,
    })),
  ) as fc.Arbitrary<Indicators>;

/**
 * Arbitrary for null indicators (warmup incomplete).
 */
const arbNullIndicators = fc.constant(null);

/**
 * Arbitrary for indicators or null.
 */
const arbIndicatorsOrNull = fc.oneof(arbIndicators, arbNullIndicators);

// ═══════════════════════════════════════════════════════════════════════════
// Specialized Arbitraries for Specific Sub-Reasons
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arbitrary for indicators that will trigger trend_ema_distance.
 * Price distance from EMA20 > 0.5%
 */
const arbIndicatorsTrendEmaDistance = fc
  .record({
    ema20: fc.double({ min: 1000, max: 3000, noNaN: true }),
    ema50: fc.double({ min: 100, max: 5000, noNaN: true }),
    ema200: fc.double({ min: 100, max: 5000, noNaN: true }),
    rsi14: fc.double({ min: 35, max: 50, noNaN: true }), // RSI in range
    atr14: fc.double({ min: 0.1, max: 100, noNaN: true }),
    volumeZScore: fc.double({ min: 1.0, max: 5, noNaN: true }), // Volume OK
    candleCount: fc.integer({ min: 26, max: 1000 }),
  })
  .chain((base) =>
    fc
      .tuple(
        // Price far from EMA20 (> 0.5%)
        fc.double({ min: 0.006, max: 0.1, noNaN: true }),
        arbBollingerBands,
      )
      .map(([pctDistance, bollingerBands]) => ({
        ...base,
        lastPrice: base.ema20 * (1 + pctDistance),
        bollingerBands,
      })),
  ) as fc.Arbitrary<Indicators>;

/**
 * Arbitrary for indicators that will trigger trend_rsi_out_of_range.
 * Price within 0.5% of EMA20, but RSI < 35 or RSI > 50
 */
const arbIndicatorsTrendRsiOutOfRange = fc
  .record({
    ema20: fc.double({ min: 1000, max: 3000, noNaN: true }),
    ema50: fc.double({ min: 100, max: 5000, noNaN: true }),
    ema200: fc.double({ min: 100, max: 5000, noNaN: true }),
    atr14: fc.double({ min: 0.1, max: 100, noNaN: true }),
    volumeZScore: fc.double({ min: 1.0, max: 5, noNaN: true }),
    candleCount: fc.integer({ min: 26, max: 1000 }),
  })
  .chain((base) =>
    fc
      .tuple(
        // Price within 0.5% of EMA20
        fc.double({ min: -0.004, max: 0.004, noNaN: true }),
        // RSI out of range
        fc.oneof(
          fc.double({ min: 0, max: 34.9, noNaN: true }),
          fc.double({ min: 50.1, max: 100, noNaN: true }),
        ),
        arbBollingerBands,
      )
      .map(([pctDistance, rsi14, bollingerBands]) => ({
        ...base,
        lastPrice: base.ema20 * (1 + pctDistance),
        rsi14,
        bollingerBands,
      })),
  ) as fc.Arbitrary<Indicators>;

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 5: Strategy Sub-Reason Normalization', () => {
  /**
   * P5-a: detectStrategySubReason always returns exactly one sub-reason key.
   */
  it('P5-a: always returns exactly one sub-reason key', () => {
    fc.assert(
      fc.property(
        arbIndicatorsOrNull,
        arbRegime,
        arbVolumeZThreshold,
        arbPositionOpen,
        arbCooldownRemaining,
        (indicators, regime, volumeZThreshold, positionOpen, cooldownRemaining) => {
          const config = createTestConfig(volumeZThreshold);
          const result = detectStrategySubReason(
            indicators,
            regime,
            config,
            positionOpen,
            cooldownRemaining,
          );

          // Must return a string
          expect(typeof result).toBe('string');

          // Must be one of the known sub-reason keys
          expect(ALL_STRATEGY_SUB_REASON_KEYS).toContain(result);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * P5-b: detectStrategySubReason is deterministic (same inputs → same output).
   */
  it('P5-b: is deterministic (same inputs produce same output)', () => {
    fc.assert(
      fc.property(
        arbIndicatorsOrNull,
        arbRegime,
        arbVolumeZThreshold,
        arbPositionOpen,
        arbCooldownRemaining,
        (indicators, regime, volumeZThreshold, positionOpen, cooldownRemaining) => {
          const config = createTestConfig(volumeZThreshold);

          const first = detectStrategySubReason(
            indicators,
            regime,
            config,
            positionOpen,
            cooldownRemaining,
          );

          const second = detectStrategySubReason(
            indicators,
            regime,
            config,
            positionOpen,
            cooldownRemaining,
          );

          expect(first).toBe(second);

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P5-c: null indicators always return 'warmup_incomplete'.
   */
  it('P5-c: null indicators always return warmup_incomplete', () => {
    fc.assert(
      fc.property(
        arbRegime,
        arbVolumeZThreshold,
        arbPositionOpen,
        arbCooldownRemaining,
        (regime, volumeZThreshold, positionOpen, cooldownRemaining) => {
          const config = createTestConfig(volumeZThreshold);
          const result = detectStrategySubReason(
            null,
            regime,
            config,
            positionOpen,
            cooldownRemaining,
          );

          expect(result).toBe('warmup_incomplete');

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P5-d: positionOpen=true with valid indicators returns 'position_open'.
   */
  it('P5-d: position open returns position_open (priority 2)', () => {
    fc.assert(
      fc.property(
        arbIndicators,
        arbRegime,
        arbVolumeZThreshold,
        arbCooldownRemaining,
        (indicators, regime, volumeZThreshold, cooldownRemaining) => {
          const config = createTestConfig(volumeZThreshold);
          const result = detectStrategySubReason(
            indicators,
            regime,
            config,
            true, // positionOpen = true
            cooldownRemaining,
          );

          expect(result).toBe('position_open');

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P5-e: non-actionable regime with no position returns 'regime_not_actionable'.
   */
  it('P5-e: non-actionable regime returns regime_not_actionable (priority 3)', () => {
    fc.assert(
      fc.property(
        arbIndicators,
        arbNonActionableRegime,
        arbVolumeZThreshold,
        arbCooldownRemaining,
        (indicators, regime, volumeZThreshold, cooldownRemaining) => {
          const config = createTestConfig(volumeZThreshold);
          const result = detectStrategySubReason(
            indicators,
            regime,
            config,
            false, // positionOpen = false
            cooldownRemaining,
          );

          expect(result).toBe('regime_not_actionable');

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P5-f: positive cooldown with actionable regime and no position returns 'cooldown_active'.
   */
  it('P5-f: active cooldown returns cooldown_active (priority 4)', () => {
    fc.assert(
      fc.property(
        arbIndicators,
        arbActionableRegime,
        arbVolumeZThreshold,
        arbPositiveCooldown,
        (indicators, regime, volumeZThreshold, cooldownRemaining) => {
          const config = createTestConfig(volumeZThreshold);
          const result = detectStrategySubReason(
            indicators,
            regime,
            config,
            false, // positionOpen = false
            cooldownRemaining, // > 0
          );

          expect(result).toBe('cooldown_active');

          return true;
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P5-g: TRENDING_UP regime with no early conditions returns a trend-specific sub-reason.
   */
  it('P5-g: TRENDING_UP with no early conditions returns trend-specific sub-reason', () => {
    const TREND_SUBREASONS: StrategySubReasonKey[] = [
      'trend_ema_distance',
      'trend_rsi_out_of_range',
      'trend_volume_low',
      'trend_ema_order',
      'trend_price_below_ema50',
    ];

    fc.assert(
      fc.property(arbIndicators, arbVolumeZThreshold, (indicators, volumeZThreshold) => {
        const config = createTestConfig(volumeZThreshold);
        const result = detectStrategySubReason(
          indicators,
          'TRENDING_UP',
          config,
          false, // positionOpen = false
          0, // cooldownRemaining = 0
        );

        // Must be one of the trend-specific sub-reasons
        expect(TREND_SUBREASONS).toContain(result);

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P5-h: RANGING regime with no early conditions returns a mean-reversion-specific sub-reason.
   */
  it('P5-h: RANGING with no early conditions returns mean-reversion-specific sub-reason', () => {
    const MEAN_REV_SUBREASONS: StrategySubReasonKey[] = [
      'mean_rev_above_bb',
      'mean_rev_rsi_high',
      'mean_rev_volume_low',
      'mean_rev_atr_ratio',
    ];

    fc.assert(
      fc.property(arbIndicators, arbVolumeZThreshold, (indicators, volumeZThreshold) => {
        const config = createTestConfig(volumeZThreshold);
        const result = detectStrategySubReason(
          indicators,
          'RANGING',
          config,
          false, // positionOpen = false
          0, // cooldownRemaining = 0
        );

        // Must be one of the mean-reversion-specific sub-reasons
        expect(MEAN_REV_SUBREASONS).toContain(result);

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P5-i: getStrategySubReasonKeys returns all expected keys.
   */
  it('P5-i: getStrategySubReasonKeys returns all 13 known keys', () => {
    const keys = getStrategySubReasonKeys();

    // Should have exactly 13 keys
    expect(keys).toHaveLength(13);

    // All expected keys should be present
    for (const expectedKey of ALL_STRATEGY_SUB_REASON_KEYS) {
      expect(keys).toContain(expectedKey);
    }

    // No extra keys beyond the expected
    for (const key of keys) {
      expect(ALL_STRATEGY_SUB_REASON_KEYS).toContain(key);
    }
  });

  /**
   * P5-j: Priority order is respected (warmup > position > regime > cooldown).
   */
  it('P5-j: priority order is respected for general conditions', () => {
    const config = createTestConfig(0.5);

    // Test: null indicators always wins regardless of other conditions
    expect(
      detectStrategySubReason(
        null,
        'RANGING',
        config,
        true, // position open
        1000, // cooldown active
      ),
    ).toBe('warmup_incomplete');

    // Test: position_open wins over regime and cooldown when indicators present
    fc.assert(
      fc.property(
        arbIndicators,
        arbNonActionableRegime,
        arbPositiveCooldown,
        (indicators, regime, cooldown) => {
          const result = detectStrategySubReason(indicators, regime, config, true, cooldown);
          expect(result).toBe('position_open');
          return true;
        },
      ),
      { numRuns: 50 },
    );

    // Test: regime_not_actionable wins over cooldown when position not open
    fc.assert(
      fc.property(
        arbIndicators,
        arbNonActionableRegime,
        arbPositiveCooldown,
        (indicators, regime, cooldown) => {
          const result = detectStrategySubReason(indicators, regime, config, false, cooldown);
          expect(result).toBe('regime_not_actionable');
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * P5-k: Specific trend condition - EMA distance check.
   * When price is > 0.5% from EMA20, should return trend_ema_distance.
   */
  it('P5-k: trend_ema_distance when price far from EMA20', () => {
    fc.assert(
      fc.property(arbIndicatorsTrendEmaDistance, (indicators) => {
        const config = createTestConfig(0.5);
        const result = detectStrategySubReason(
          indicators,
          'TRENDING_UP',
          config,
          false,
          0,
        );

        expect(result).toBe('trend_ema_distance');

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P5-l: Specific trend condition - RSI out of range.
   * When price is near EMA20 but RSI is outside [35, 50], should return trend_rsi_out_of_range.
   */
  it('P5-l: trend_rsi_out_of_range when RSI outside valid range', () => {
    fc.assert(
      fc.property(arbIndicatorsTrendRsiOutOfRange, (indicators) => {
        const config = createTestConfig(0.5);
        const result = detectStrategySubReason(
          indicators,
          'TRENDING_UP',
          config,
          false,
          0,
        );

        expect(result).toBe('trend_rsi_out_of_range');

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P5-m: Verify no unknown sub-reasons are ever returned.
   */
  it('P5-m: never returns unknown or undefined sub-reason', () => {
    fc.assert(
      fc.property(
        arbIndicatorsOrNull,
        arbRegime,
        arbVolumeZThreshold,
        arbPositionOpen,
        arbCooldownRemaining,
        (indicators, regime, volumeZThreshold, positionOpen, cooldownRemaining) => {
          const config = createTestConfig(volumeZThreshold);
          const result = detectStrategySubReason(
            indicators,
            regime,
            config,
            positionOpen,
            cooldownRemaining,
          );

          // Must not be undefined or null
          expect(result).toBeDefined();
          expect(result).not.toBeNull();

          // Must be a non-empty string
          expect(result.length).toBeGreaterThan(0);

          // Must be one of the known keys
          expect(ALL_STRATEGY_SUB_REASON_KEYS).toContain(result);

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });
});

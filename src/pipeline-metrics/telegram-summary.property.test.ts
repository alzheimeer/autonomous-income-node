/**
 * Property Test: Telegram Summary Length Bound
 *
 * **Property 7: Telegram Summary Length Bound**
 * Generate arbitrary `AggregateMetrics` (including extremes: zero events, max counts, long names)
 * Verify output ≤ 500 characters
 *
 * **Validates: Requirements 7.2**
 *
 * The Telegram summary formatter must produce a Telegram-compatible markdown string
 * that never exceeds 500 characters, regardless of the input metrics. This ensures
 * compatibility with Telegram message limits.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { formatTelegramSummary } from './telegram-summary.js';
import type { AggregateMetrics } from './aggregate-metrics.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum allowed length for Telegram summary (per Requirement 7.2) */
const MAX_TELEGRAM_LENGTH = 500;

/** All valid regime types from the design document */
const REGIME_TYPES = [
  'TRENDING_UP',
  'TRENDING_DOWN',
  'RANGING',
  'VOLATILE',
  'UNCERTAIN',
] as const;

/** Normalized rejection reason keys from Requirements 3.1, 3.2, 3.3 */
const REJECTION_REASON_KEYS = [
  // Gate rejection reasons (Req 3.1)
  'profit_below_min_usd',
  'profit_below_min_bps',
  'entry_quote_stale',
  'exit_quote_stale',
  'entry_impact_high',
  'exit_impact_high',
  'gas_exceeds_budget',
  'profit_sanity_fail',
  // Position sizing rejection reasons (Req 3.2)
  'size_below_minimum',
  'size_exceeds_max',
  'kelly_zero',
  'bankroll_too_low',
  // Strategy sub-reasons (Req 3.3)
  'warmup_incomplete',
  'position_open',
  'regime_not_actionable',
  'cooldown_active',
  'trend_ema_distance',
  'trend_rsi_out_of_range',
  'trend_volume_low',
  'trend_ema_order',
  'trend_price_below_ema50',
  'mean_rev_above_bb',
  'mean_rev_rsi_high',
  'mean_rev_volume_low',
  'mean_rev_atr_ratio',
] as const;

/** Near-miss indicator names from Requirement 4.1 */
const NEAR_MISS_INDICATORS = [
  'rsi14',
  'price_vs_ema20',
  'price_vs_ema50',
  'volume_z',
  'net_profit',
  'slippage_impact',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries (fast-check generators)
// ═══════════════════════════════════════════════════════════════════════════

/** Arbitrary for RegimeType */
const arbRegimeType: fc.Arbitrary<string> = fc.constantFrom(...REGIME_TYPES);

/** Arbitrary for very long regime names (edge case) */
const arbLongRegimeName: fc.Arbitrary<string> = fc.oneof(
  arbRegimeType,
  fc.stringOf(fc.constantFrom('A', 'B', 'C', '_'), { minLength: 50, maxLength: 100 }),
);

/** Arbitrary for normalized rejection reason keys */
const arbRejectionKey: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...REJECTION_REASON_KEYS),
  // Include very long custom keys as edge case
  fc.stringOf(fc.constantFrom('a', 'b', 'c', '_'), { minLength: 30, maxLength: 80 }),
);

/** Arbitrary for near-miss indicator names */
const arbNearMissIndicator: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...NEAR_MISS_INDICATORS),
  fc.stringOf(fc.constantFrom('a', 'b', 'c', '_'), { minLength: 20, maxLength: 50 }),
);

/** Arbitrary for hourly rate (signals or evaluations per hour) */
const arbHourlyRate: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),                               // Zero events
  fc.double({ min: 0.001, max: 1 }),           // Very low rate
  fc.double({ min: 1, max: 100 }),             // Normal rate
  fc.double({ min: 100, max: 10000 }),         // High rate
  fc.double({ min: 10000, max: 1_000_000 }),   // Extreme rate (edge case)
  fc.constant(Number.MAX_SAFE_INTEGER / 24),   // Maximum safe value
);

/** Arbitrary for pass-through rate (0.0 to 1.0) */
const arbPassThroughRate: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),                               // Zero pass-through
  fc.constant(1),                               // 100% pass-through
  fc.double({ min: 0, max: 1, noNaN: true }),  // Normal range
);

/** Arbitrary for percentage in regime distribution */
const arbPercentage: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.constant(100),
  fc.double({ min: 0, max: 100, noNaN: true }),
);

/** Arbitrary for rejection count */
const arbRejectionCount: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: 100 }),
  fc.integer({ min: 100, max: 10_000 }),
  fc.integer({ min: 10_000, max: 1_000_000 }),
  fc.constant(Number.MAX_SAFE_INTEGER),
);

/** Arbitrary for near-miss frequency count */
const arbNearMissCount: fc.Arbitrary<number> = fc.oneof(
  fc.constant(0),
  fc.integer({ min: 1, max: 100 }),
  fc.integer({ min: 100, max: 10_000 }),
  fc.integer({ min: 10_000, max: 1_000_000 }),
);

/** Arbitrary regime distribution (map of regime → percentage) */
const arbRegimeDistribution: fc.Arbitrary<Record<string, number>> = fc.oneof(
  // Empty distribution
  fc.constant({}),
  // Single regime
  fc.record({ regime: arbRegimeType, pct: arbPercentage }).map(({ regime, pct }) => ({ [regime]: pct })),
  // All regimes with percentages
  fc.record({
    TRENDING_UP: arbPercentage,
    TRENDING_DOWN: arbPercentage,
    RANGING: arbPercentage,
    VOLATILE: arbPercentage,
    UNCERTAIN: arbPercentage,
  }),
  // Many entries with long names
  fc.array(
    fc.record({ key: arbLongRegimeName, value: arbPercentage }),
    { minLength: 0, maxLength: 10 },
  ).map((entries) => Object.fromEntries(entries.map((e) => [e.key, e.value]))),
);

/** Arbitrary rejection distribution (map of reason_key → { count, percentage }) */
const arbRejectionDistribution: fc.Arbitrary<Record<string, { count: number; percentage: number }>> = fc.oneof(
  // Empty distribution
  fc.constant({}),
  // Few rejections
  fc.array(
    fc.record({
      key: arbRejectionKey,
      count: arbRejectionCount,
      percentage: arbPercentage,
    }),
    { minLength: 1, maxLength: 5 },
  ).map((entries) =>
    Object.fromEntries(entries.map((e) => [e.key, { count: e.count, percentage: e.percentage }])),
  ),
  // Many rejections (stress test for top 3 sorting)
  fc.array(
    fc.record({
      key: arbRejectionKey,
      count: arbRejectionCount,
      percentage: arbPercentage,
    }),
    { minLength: 10, maxLength: 30 },
  ).map((entries) =>
    Object.fromEntries(entries.map((e) => [e.key, { count: e.count, percentage: e.percentage }])),
  ),
);

/** Arbitrary near-miss frequency (map of indicator_name → count) */
const arbNearMissFrequency: fc.Arbitrary<Record<string, number>> = fc.oneof(
  // Empty
  fc.constant({}),
  // Few indicators
  fc.array(
    fc.record({ key: arbNearMissIndicator, count: arbNearMissCount }),
    { minLength: 1, maxLength: 6 },
  ).map((entries) => Object.fromEntries(entries.map((e) => [e.key, e.count]))),
  // Many indicators with long names
  fc.array(
    fc.record({ key: arbNearMissIndicator, count: arbNearMissCount }),
    { minLength: 10, maxLength: 20 },
  ).map((entries) => Object.fromEntries(entries.map((e) => [e.key, e.count]))),
);

/** Full arbitrary AggregateMetrics */
const arbAggregateMetrics: fc.Arbitrary<AggregateMetrics> = fc.record({
  signalsPerHour: arbHourlyRate,
  evaluationsPerHour: arbHourlyRate,
  regimeDistribution: arbRegimeDistribution,
  rejectionDistribution: arbRejectionDistribution,
  nearMissFrequency: arbNearMissFrequency,
  passThroughRate: arbPassThroughRate,
  dataIncomplete: fc.boolean(),
});

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 7: Telegram Summary Length Bound', () => {
  it('output is always ≤ 500 characters for arbitrary AggregateMetrics', () => {
    fc.assert(
      fc.property(arbAggregateMetrics, arbRegimeType, (metrics, regime) => {
        const result = formatTelegramSummary(metrics, regime);

        // Core property: output must never exceed 500 characters
        expect(result.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
      }),
      { numRuns: 500 },
    );
  });

  it('output is always ≤ 500 characters with extreme regime names', () => {
    fc.assert(
      fc.property(arbAggregateMetrics, arbLongRegimeName, (metrics, regime) => {
        const result = formatTelegramSummary(metrics, regime);

        expect(result.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
      }),
      { numRuns: 200 },
    );
  });

  it('output is always ≤ 500 characters with zero events scenario', () => {
    fc.assert(
      fc.property(arbRegimeType, (regime) => {
        const emptyMetrics: AggregateMetrics = {
          signalsPerHour: 0,
          evaluationsPerHour: 0,
          regimeDistribution: {},
          rejectionDistribution: {},
          nearMissFrequency: {},
          passThroughRate: 0,
          dataIncomplete: true,
        };

        const result = formatTelegramSummary(emptyMetrics, regime);

        expect(result.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
      }),
      { numRuns: 50 },
    );
  });

  it('output is always ≤ 500 characters with maximum count values', () => {
    fc.assert(
      fc.property(arbRegimeType, (regime) => {
        const maxMetrics: AggregateMetrics = {
          signalsPerHour: Number.MAX_SAFE_INTEGER / 24,
          evaluationsPerHour: Number.MAX_SAFE_INTEGER / 24,
          regimeDistribution: {
            TRENDING_UP: 100,
            TRENDING_DOWN: 100,
            RANGING: 100,
            VOLATILE: 100,
            UNCERTAIN: 100,
          },
          rejectionDistribution: {
            profit_below_min_usd: { count: Number.MAX_SAFE_INTEGER, percentage: 100 },
            entry_impact_high: { count: Number.MAX_SAFE_INTEGER, percentage: 100 },
            gas_exceeds_budget: { count: Number.MAX_SAFE_INTEGER, percentage: 100 },
          },
          nearMissFrequency: {
            rsi14: Number.MAX_SAFE_INTEGER,
            volume_z: Number.MAX_SAFE_INTEGER,
            price_vs_ema20: Number.MAX_SAFE_INTEGER,
          },
          passThroughRate: 1,
          dataIncomplete: false,
        };

        const result = formatTelegramSummary(maxMetrics, regime);

        expect(result.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
      }),
      { numRuns: 50 },
    );
  });

  it('output is always ≤ 500 characters with very long rejection reason names', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom('a', 'b', 'c', 'd', 'e', '_'), { minLength: 50, maxLength: 100 }),
        fc.stringOf(fc.constantFrom('f', 'g', 'h', 'i', 'j', '_'), { minLength: 50, maxLength: 100 }),
        fc.stringOf(fc.constantFrom('k', 'l', 'm', 'n', 'o', '_'), { minLength: 50, maxLength: 100 }),
        arbRegimeType,
        (key1, key2, key3, regime) => {
          const metrics: AggregateMetrics = {
            signalsPerHour: 100,
            evaluationsPerHour: 1000,
            regimeDistribution: { TRENDING_UP: 100 },
            rejectionDistribution: {
              [key1]: { count: 1000, percentage: 50 },
              [key2]: { count: 500, percentage: 25 },
              [key3]: { count: 250, percentage: 12.5 },
            },
            nearMissFrequency: { rsi14: 10 },
            passThroughRate: 0.5,
            dataIncomplete: false,
          };

          const result = formatTelegramSummary(metrics, regime);

          expect(result.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('output is valid Telegram-compatible markdown', () => {
    fc.assert(
      fc.property(arbAggregateMetrics, arbRegimeType, (metrics, regime) => {
        const result = formatTelegramSummary(metrics, regime);

        // Output is a non-empty string
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);

        // Contains expected structure markers
        expect(result).toContain('📊');
        expect(result).toContain('Pipeline');
      }),
      { numRuns: 200 },
    );
  });

  it('output handles edge case numbers correctly', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.constant(0),
          fc.constant(0.0001),
          fc.constant(0.9999),
          fc.constant(1),
          fc.constant(100.123456789),
          fc.constant(999999999),
        ),
        arbRegimeType,
        (rate, regime) => {
          const metrics: AggregateMetrics = {
            signalsPerHour: rate,
            evaluationsPerHour: rate,
            regimeDistribution: {},
            rejectionDistribution: {},
            nearMissFrequency: {},
            passThroughRate: Math.min(1, rate),
            dataIncomplete: false,
          };

          const result = formatTelegramSummary(metrics, regime);

          expect(result.length).toBeLessThanOrEqual(MAX_TELEGRAM_LENGTH);
          // Should not contain NaN or Infinity
          expect(result).not.toContain('NaN');
          expect(result).not.toContain('Infinity');
        },
      ),
      { numRuns: 100 },
    );
  });
});

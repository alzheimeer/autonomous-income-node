/**
 * Property-based tests for PositionSizer
 *
 * **Property 11: Position sizing formula and clamping**
 * trade_size = risk_budget / stop_distance_fraction, clamped to [$5, $10].
 * For any valid stop distance, size is within bounds.
 *
 * **Property 12: Confidence does not affect size**
 * For same bankroll and stop distance, varying confidence produces identical sizes.
 *
 * **Validates: Requirements 26.1, 26.2, 26.3, 26.4**
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { PositionSizer } from '../../position-sizer.js';
import type { PositionSizerConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants & Config
// ═══════════════════════════════════════════════════════════════════════════

const MIN_TRADE_SIZE = 5_000_000n;   // $5
const MAX_TRADE_SIZE = 10_000_000n;  // $10
const MAX_RISK_PER_TRADE = 500_000n; // $0.50
const MAX_RISK_PCT = 0.005;          // 0.5%
const MIN_STOP_FRACTION = 0.001;

const DEFAULT_CONFIG: PositionSizerConfig = {
  maxRiskPerTrade: MAX_RISK_PER_TRADE,
  maxRiskPctBankroll: MAX_RISK_PCT,
  minTradeSize: MIN_TRADE_SIZE,
  maxTradeSize: MAX_TRADE_SIZE,
  minStopFraction: MIN_STOP_FRACTION,
};

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate valid active bankroll amounts.
 * Range: $5 to $200 (6 decimals USDC).
 */
const validBankroll = fc.bigInt({ min: 5_000_000n, max: 200_000_000n });

/**
 * Generate valid stop distance fractions.
 * Range: minStopFraction (0.001) to 0.5 (50% — extreme but valid).
 */
const validStopFraction = fc.double({
  min: MIN_STOP_FRACTION,
  max: 0.5,
  noNaN: true,
  noDefaultInfinity: true,
}).filter((v) => v >= MIN_STOP_FRACTION); // Ensure min is respected

/**
 * Generate confidence values [0, 1].
 */
const validConfidence = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/**
 * Generate invalid stop distances (0, negative, too small, NaN-adjacent).
 */
const invalidStopFraction = fc.oneof(
  fc.constant(0),
  fc.constant(-0.01),
  fc.double({ min: -100, max: 0, noNaN: true, noDefaultInfinity: true }),
  fc.double({ min: 0, max: MIN_STOP_FRACTION, noNaN: true, noDefaultInfinity: true })
    .filter((v) => v < MIN_STOP_FRACTION),
);

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('PositionSizer - Property Tests', () => {
  const sizer = new PositionSizer(DEFAULT_CONFIG);

  // ═══════════════════════════════════════════════════════════════════════
  // Property 11: Position sizing formula and clamping
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 11: Position sizing formula and clamping', () => {
    /**
     * **Validates: Requirements 26.1, 26.2, 26.3**
     *
     * For any valid stop distance, if the calculated size >= $5 (min),
     * the final clamped size MUST be within [$5, $10].
     */
    it('valid sizing is always clamped within [$5, $10]', () => {
      fc.assert(
        fc.property(
          validBankroll,
          validStopFraction,
          (bankroll, stopFraction) => {
            const result = sizer.calculateSize(bankroll, stopFraction);

            if (result.valid) {
              expect(result.sizeUsdc).toBeGreaterThanOrEqual(MIN_TRADE_SIZE);
              expect(result.sizeUsdc).toBeLessThanOrEqual(MAX_TRADE_SIZE);
            }
          },
        ),
        { numRuns: 500 },
      );
    });

    /**
     * **Validates: Requirements 26.1, 26.2**
     *
     * The risk budget is always min(maxRiskPerTrade, bankroll * maxRiskPctBankroll).
     * The raw size = riskBudget / stopDistanceFraction.
     */
    it('raw size follows the formula: risk_budget / stop_distance_fraction', () => {
      fc.assert(
        fc.property(
          validBankroll,
          validStopFraction,
          (bankroll, stopFraction) => {
            const result = sizer.calculateSize(bankroll, stopFraction);

            // Compute expected risk budget
            const PRECISION = 1_000_000n;
            const pctMultiplier = BigInt(Math.round(MAX_RISK_PCT * Number(PRECISION)));
            const pctRisk = (bankroll * pctMultiplier) / PRECISION;
            const expectedRiskBudget = pctRisk < MAX_RISK_PER_TRADE ? pctRisk : MAX_RISK_PER_TRADE;

            expect(result.riskBudget).toBe(expectedRiskBudget);

            // Compute expected raw size
            const fractionBigInt = BigInt(Math.round(stopFraction * Number(PRECISION)));
            const expectedRawSize = (expectedRiskBudget * PRECISION) / fractionBigInt;

            expect(result.rawSize).toBe(expectedRawSize);
          },
        ),
        { numRuns: 300 },
      );
    });

    /**
     * **Validates: Requirements 26.3**
     *
     * If raw size < $5 (min trade), the result MUST be invalid.
     * This happens with large stop distances (risk budget spread thin).
     */
    it('rejects when raw size falls below $5 minimum', () => {
      // Use a large stop distance to produce small sizes
      fc.assert(
        fc.property(
          // Small bankroll produces small risk budget
          fc.bigInt({ min: 5_000_000n, max: 20_000_000n }),
          // Large stop distance (20% to 50%) makes size small
          fc.double({ min: 0.2, max: 0.5, noNaN: true, noDefaultInfinity: true }),
          (bankroll, stopFraction) => {
            const result = sizer.calculateSize(bankroll, stopFraction);

            // If raw size < min, result must be invalid
            if (result.rawSize < MIN_TRADE_SIZE) {
              expect(result.valid).toBe(false);
              expect(result.reason).toBe('below_minimum_trade_size');
            }
          },
        ),
        { numRuns: 300 },
      );
    });

    /**
     * **Validates: Requirements 26.3**
     *
     * If raw size > $10 (max trade), the clamped size MUST be exactly $10.
     */
    it('caps size at $10 when raw calculation exceeds maximum', () => {
      fc.assert(
        fc.property(
          // Large bankroll to produce large risk budget
          fc.bigInt({ min: 100_000_000n, max: 200_000_000n }),
          // Small stop distance produces large raw size
          fc.double({ min: 0.001, max: 0.01, noNaN: true, noDefaultInfinity: true })
            .filter((v) => v >= MIN_STOP_FRACTION),
          (bankroll, stopFraction) => {
            const result = sizer.calculateSize(bankroll, stopFraction);

            if (result.valid && result.rawSize > MAX_TRADE_SIZE) {
              expect(result.sizeUsdc).toBe(MAX_TRADE_SIZE);
            }
          },
        ),
        { numRuns: 300 },
      );
    });

    /**
     * **Validates: Requirements 26.1**
     *
     * Invalid stop fractions (0, negative, < minStopFraction) are always rejected.
     */
    it('rejects invalid stop distances (0, negative, below minimum)', () => {
      fc.assert(
        fc.property(
          validBankroll,
          invalidStopFraction,
          (bankroll, badStop) => {
            const result = sizer.calculateSize(bankroll, badStop);
            expect(result.valid).toBe(false);
            expect(result.reason).toBe('invalid_stop_distance');
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 12: Confidence does not affect size
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 12: Confidence does not affect size', () => {
    /**
     * **Validates: Requirements 26.4**
     *
     * For the same bankroll and stop distance, varying the confidence parameter
     * between [0, 1] produces IDENTICAL sizing results (size, riskBudget, validity).
     */
    it('confidence parameter has zero effect on sizing output', () => {
      fc.assert(
        fc.property(
          validBankroll,
          validStopFraction,
          validConfidence,
          validConfidence,
          (bankroll, stopFraction, confidence1, confidence2) => {
            const result1 = sizer.calculateSize(bankroll, stopFraction, confidence1);
            const result2 = sizer.calculateSize(bankroll, stopFraction, confidence2);

            // All fields must be identical regardless of confidence
            expect(result1.valid).toBe(result2.valid);
            expect(result1.sizeUsdc).toBe(result2.sizeUsdc);
            expect(result1.riskBudget).toBe(result2.riskBudget);
            expect(result1.rawSize).toBe(result2.rawSize);
            expect(result1.reason).toBe(result2.reason);
          },
        ),
        { numRuns: 300 },
      );
    });

    /**
     * **Validates: Requirements 26.4**
     *
     * Calling without confidence parameter produces same result as with any confidence.
     */
    it('omitting confidence produces same result as providing one', () => {
      fc.assert(
        fc.property(
          validBankroll,
          validStopFraction,
          validConfidence,
          (bankroll, stopFraction, confidence) => {
            const withoutConfidence = sizer.calculateSize(bankroll, stopFraction);
            const withConfidence = sizer.calculateSize(bankroll, stopFraction, confidence);

            expect(withoutConfidence.valid).toBe(withConfidence.valid);
            expect(withoutConfidence.sizeUsdc).toBe(withConfidence.sizeUsdc);
            expect(withoutConfidence.riskBudget).toBe(withConfidence.riskBudget);
            expect(withoutConfidence.rawSize).toBe(withConfidence.rawSize);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

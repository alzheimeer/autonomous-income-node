/**
 * Property Tests for VerdictEngine
 *
 * **Validates: Requirements 14.1, 14.3**
 *
 * Property 16: Verdict Ordered Rule Assignment
 * - Generate arbitrary metrics combinations (totalTrades, avgPnlPerTrade, profitFactor, maxDrawdownPct)
 * - Verify exactly one verdict is returned
 * - Rules are evaluated in order: INSUFFICIENT_DATA → NEGATIVE_EXPECTANCY → BREAKEVEN → POSITIVE_EXPECTANCY → PROMISING_BUT_NEEDS_SHADOW
 * - First matching rule wins
 *
 * Uses fast-check for property-based testing with vitest.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  computeVerdict,
  type Verdict,
  type VerdictMetricsInput,
} from '../verdict-engine.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** All possible verdicts in evaluation order */
const ALL_VERDICTS: Verdict[] = [
  'INSUFFICIENT_DATA',
  'NEGATIVE_EXPECTANCY',
  'BREAKEVEN',
  'POSITIVE_EXPECTANCY',
  'PROMISING_BUT_NEEDS_SHADOW',
];

/** Thresholds from requirements */
const THRESHOLDS = {
  minTrades: 10,
  minProfitFactor: 1.2,
  maxDrawdownForPositive: 30,
};

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arbitrary for totalTrades: 0 to 1000
 */
const arbTotalTrades = fc.integer({ min: 0, max: 1000 });

/**
 * Arbitrary for avgPnlPerTrade as BigInt (can be negative to positive)
 * Range: -1_000_000n to 1_000_000n ($-1 to $1 with 6 decimals)
 */
const arbAvgPnlPerTrade = fc.integer({ min: -1_000_000, max: 1_000_000 }).map(BigInt);

/**
 * Arbitrary for profitFactor: 0 to 10
 */
const arbProfitFactor = fc.double({ min: 0, max: 10, noNaN: true, noDefaultInfinity: true });

/**
 * Arbitrary for maxDrawdownPct: 0 to 100
 */
const arbMaxDrawdownPct = fc.double({ min: 0, max: 100, noNaN: true, noDefaultInfinity: true });

/**
 * Arbitrary for winRate: 0 to 1
 */
const arbWinRate = fc.double({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true });

/**
 * Arbitrary for full VerdictMetricsInput
 */
const arbMetrics: fc.Arbitrary<VerdictMetricsInput> = fc.record({
  totalTrades: arbTotalTrades,
  avgPnlPerTrade: arbAvgPnlPerTrade,
  profitFactor: arbProfitFactor,
  maxDrawdownPct: arbMaxDrawdownPct,
});

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determine expected verdict based on ordered rules.
 * This mirrors the implementation logic for verification.
 */
function expectedVerdict(metrics: VerdictMetricsInput): Verdict {
  // Rule 1: Insufficient data (< 10 trades)
  if (metrics.totalTrades < THRESHOLDS.minTrades) {
    return 'INSUFFICIENT_DATA';
  }

  // Rule 2: Negative expectancy (avg P&L per trade < 0)
  if (metrics.avgPnlPerTrade < 0n) {
    return 'NEGATIVE_EXPECTANCY';
  }

  // Rule 3: Breakeven (profit factor < 1.2)
  if (metrics.profitFactor < THRESHOLDS.minProfitFactor) {
    return 'BREAKEVEN';
  }

  // Rule 4: Positive expectancy (PF >= 1.2 AND max DD <= 30%)
  if (metrics.maxDrawdownPct <= THRESHOLDS.maxDrawdownForPositive) {
    return 'POSITIVE_EXPECTANCY';
  }

  // Rule 5: Promising but needs shadow (PF >= 1.2, DD > 30%)
  return 'PROMISING_BUT_NEEDS_SHADOW';
}

/**
 * Check if a verdict is valid (one of the allowed values).
 */
function isValidVerdict(verdict: unknown): verdict is Verdict {
  return ALL_VERDICTS.includes(verdict as Verdict);
}

// ═══════════════════════════════════════════════════════════════════════════
// Property 16: Verdict Ordered Rule Assignment
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 16: Verdict Ordered Rule Assignment', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // P16-a: Exactly One Verdict Returned
  // ─────────────────────────────────────────────────────────────────────────

  describe('P16-a: Exactly One Verdict Returned', () => {
    /**
     * P16-a-1: Every input produces exactly one verdict.
     * **Validates: Requirements 14.1**
     */
    it('every input produces exactly one verdict', () => {
      fc.assert(
        fc.property(arbMetrics, (metrics) => {
          const result = computeVerdict(metrics);

          // Result has a verdict property
          expect(result).toHaveProperty('verdict');

          // Verdict is one of the allowed values
          expect(isValidVerdict(result.verdict)).toBe(true);
        }),
        { numRuns: 200 },
      );
    });

    /**
     * P16-a-2: Result always has rationale string.
     * **Validates: Requirements 14.2**
     */
    it('result always has rationale string', () => {
      fc.assert(
        fc.property(arbMetrics, (metrics) => {
          const result = computeVerdict(metrics);

          expect(result).toHaveProperty('rationale');
          expect(typeof result.rationale).toBe('string');
          expect(result.rationale.length).toBeGreaterThan(0);
        }),
        { numRuns: 200 },
      );
    });

    /**
     * P16-a-3: computeVerdict is deterministic (same inputs → same output).
     * **Validates: Requirements 14.1**
     */
    it('computeVerdict is deterministic', () => {
      fc.assert(
        fc.property(arbMetrics, (metrics) => {
          const result1 = computeVerdict(metrics);
          const result2 = computeVerdict(metrics);

          expect(result1.verdict).toBe(result2.verdict);
          expect(result1.rationale).toBe(result2.rationale);
        }),
        { numRuns: 100 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P16-b: Rules Evaluated in Order
  // ─────────────────────────────────────────────────────────────────────────

  describe('P16-b: Rules Evaluated in Order', () => {
    /**
     * P16-b-1: Verdict matches expected based on ordered rule evaluation.
     * **Validates: Requirements 14.3**
     */
    it('verdict matches expected based on ordered rule evaluation', () => {
      fc.assert(
        fc.property(arbMetrics, (metrics) => {
          const result = computeVerdict(metrics);
          const expected = expectedVerdict(metrics);

          expect(result.verdict).toBe(expected);
        }),
        { numRuns: 200 },
      );
    });

    /**
     * P16-b-2: INSUFFICIENT_DATA takes precedence over all other conditions.
     * **Validates: Requirements 14.3**
     */
    it('INSUFFICIENT_DATA takes precedence over all other conditions', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: THRESHOLDS.minTrades - 1 }), // < 10 trades
          arbAvgPnlPerTrade,
          arbProfitFactor,
          arbMaxDrawdownPct,
          (totalTrades, avgPnlPerTrade, profitFactor, maxDrawdownPct) => {
            const metrics: VerdictMetricsInput = {
              totalTrades,
              avgPnlPerTrade,
              profitFactor,
              maxDrawdownPct,
            };

            const result = computeVerdict(metrics);
            expect(result.verdict).toBe('INSUFFICIENT_DATA');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * P16-b-3: NEGATIVE_EXPECTANCY takes precedence when trades >= 10 and avgPnl < 0.
     * **Validates: Requirements 14.3**
     */
    it('NEGATIVE_EXPECTANCY takes precedence when trades >= 10 and avgPnl < 0', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: THRESHOLDS.minTrades, max: 1000 }), // >= 10 trades
          fc.integer({ min: -1_000_000, max: -1 }).map(BigInt), // negative P&L
          arbProfitFactor,
          arbMaxDrawdownPct,
          (totalTrades, avgPnlPerTrade, profitFactor, maxDrawdownPct) => {
            const metrics: VerdictMetricsInput = {
              totalTrades,
              avgPnlPerTrade,
              profitFactor,
              maxDrawdownPct,
            };

            const result = computeVerdict(metrics);
            expect(result.verdict).toBe('NEGATIVE_EXPECTANCY');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * P16-b-4: BREAKEVEN when trades >= 10, avgPnl >= 0, and profitFactor < 1.2.
     * **Validates: Requirements 14.3**
     */
    it('BREAKEVEN when trades >= 10, avgPnl >= 0, and profitFactor < 1.2', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: THRESHOLDS.minTrades, max: 1000 }), // >= 10 trades
          fc.integer({ min: 0, max: 1_000_000 }).map(BigInt), // non-negative P&L
          fc.double({ min: 0, max: THRESHOLDS.minProfitFactor - 0.01, noNaN: true, noDefaultInfinity: true }), // PF < 1.2
          arbMaxDrawdownPct,
          (totalTrades, avgPnlPerTrade, profitFactor, maxDrawdownPct) => {
            const metrics: VerdictMetricsInput = {
              totalTrades,
              avgPnlPerTrade,
              profitFactor,
              maxDrawdownPct,
            };

            const result = computeVerdict(metrics);
            expect(result.verdict).toBe('BREAKEVEN');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * P16-b-5: POSITIVE_EXPECTANCY when trades >= 10, avgPnl >= 0, profitFactor >= 1.2, maxDD <= 30%.
     * **Validates: Requirements 14.3**
     */
    it('POSITIVE_EXPECTANCY when trades >= 10, avgPnl >= 0, profitFactor >= 1.2, maxDD <= 30%', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: THRESHOLDS.minTrades, max: 1000 }), // >= 10 trades
          fc.integer({ min: 0, max: 1_000_000 }).map(BigInt), // non-negative P&L
          fc.double({ min: THRESHOLDS.minProfitFactor, max: 10, noNaN: true, noDefaultInfinity: true }), // PF >= 1.2
          fc.double({ min: 0, max: THRESHOLDS.maxDrawdownForPositive, noNaN: true, noDefaultInfinity: true }), // DD <= 30%
          (totalTrades, avgPnlPerTrade, profitFactor, maxDrawdownPct) => {
            const metrics: VerdictMetricsInput = {
              totalTrades,
              avgPnlPerTrade,
              profitFactor,
              maxDrawdownPct,
            };

            const result = computeVerdict(metrics);
            expect(result.verdict).toBe('POSITIVE_EXPECTANCY');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * P16-b-6: PROMISING_BUT_NEEDS_SHADOW when trades >= 10, avgPnl >= 0, profitFactor >= 1.2, maxDD > 30%.
     * **Validates: Requirements 14.3**
     */
    it('PROMISING_BUT_NEEDS_SHADOW when trades >= 10, avgPnl >= 0, profitFactor >= 1.2, maxDD > 30%', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: THRESHOLDS.minTrades, max: 1000 }), // >= 10 trades
          fc.integer({ min: 0, max: 1_000_000 }).map(BigInt), // non-negative P&L
          fc.double({ min: THRESHOLDS.minProfitFactor, max: 10, noNaN: true, noDefaultInfinity: true }), // PF >= 1.2
          fc.double({ min: THRESHOLDS.maxDrawdownForPositive + 0.01, max: 100, noNaN: true, noDefaultInfinity: true }), // DD > 30%
          (totalTrades, avgPnlPerTrade, profitFactor, maxDrawdownPct) => {
            const metrics: VerdictMetricsInput = {
              totalTrades,
              avgPnlPerTrade,
              profitFactor,
              maxDrawdownPct,
            };

            const result = computeVerdict(metrics);
            expect(result.verdict).toBe('PROMISING_BUT_NEEDS_SHADOW');
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P16-c: First Matching Rule Wins
  // ─────────────────────────────────────────────────────────────────────────

  describe('P16-c: First Matching Rule Wins', () => {
    /**
     * P16-c-1: With 0 trades, always INSUFFICIENT_DATA regardless of other metrics.
     * **Validates: Requirements 14.3**
     */
    it('0 trades always returns INSUFFICIENT_DATA', () => {
      fc.assert(
        fc.property(
          arbAvgPnlPerTrade,
          arbProfitFactor,
          arbMaxDrawdownPct,
          (avgPnlPerTrade, profitFactor, maxDrawdownPct) => {
            const metrics: VerdictMetricsInput = {
              totalTrades: 0,
              avgPnlPerTrade,
              profitFactor,
              maxDrawdownPct,
            };

            const result = computeVerdict(metrics);
            expect(result.verdict).toBe('INSUFFICIENT_DATA');
          },
        ),
        { numRuns: 50 },
      );
    });

    /**
     * P16-c-2: With exactly 10 trades, passes to next rule (not INSUFFICIENT_DATA).
     * **Validates: Requirements 14.3**
     */
    it('exactly 10 trades passes to next rule', () => {
      // Non-negative P&L, high profit factor, low drawdown → should be POSITIVE_EXPECTANCY
      const metrics: VerdictMetricsInput = {
        totalTrades: 10,
        avgPnlPerTrade: 100_000n, // positive
        profitFactor: 2.0, // >= 1.2
        maxDrawdownPct: 10, // <= 30%
      };

      const result = computeVerdict(metrics);
      expect(result.verdict).toBe('POSITIVE_EXPECTANCY');
    });

    /**
     * P16-c-3: Exactly 9 trades always returns INSUFFICIENT_DATA.
     * **Validates: Requirements 14.3**
     */
    it('exactly 9 trades always returns INSUFFICIENT_DATA', () => {
      fc.assert(
        fc.property(
          arbAvgPnlPerTrade,
          arbProfitFactor,
          arbMaxDrawdownPct,
          (avgPnlPerTrade, profitFactor, maxDrawdownPct) => {
            const metrics: VerdictMetricsInput = {
              totalTrades: 9,
              avgPnlPerTrade,
              profitFactor,
              maxDrawdownPct,
            };

            const result = computeVerdict(metrics);
            expect(result.verdict).toBe('INSUFFICIENT_DATA');
          },
        ),
        { numRuns: 50 },
      );
    });

    /**
     * P16-c-4: avgPnlPerTrade = 0 is not negative expectancy.
     * **Validates: Requirements 14.3**
     */
    it('avgPnlPerTrade = 0 is not NEGATIVE_EXPECTANCY', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 0n, // exactly zero
        profitFactor: 1.0, // < 1.2
        maxDrawdownPct: 20,
      };

      const result = computeVerdict(metrics);
      // Should be BREAKEVEN (not NEGATIVE_EXPECTANCY)
      expect(result.verdict).toBe('BREAKEVEN');
    });

    /**
     * P16-c-5: profitFactor = 1.2 exactly is not BREAKEVEN.
     * **Validates: Requirements 14.3**
     */
    it('profitFactor = 1.2 exactly is not BREAKEVEN', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 50_000n, // positive
        profitFactor: 1.2, // exactly 1.2
        maxDrawdownPct: 20, // <= 30%
      };

      const result = computeVerdict(metrics);
      // Should be POSITIVE_EXPECTANCY (not BREAKEVEN)
      expect(result.verdict).toBe('POSITIVE_EXPECTANCY');
    });

    /**
     * P16-c-6: maxDrawdownPct = 30 exactly is POSITIVE_EXPECTANCY.
     * **Validates: Requirements 14.3**
     */
    it('maxDrawdownPct = 30 exactly is POSITIVE_EXPECTANCY', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 50_000n, // positive
        profitFactor: 1.5, // >= 1.2
        maxDrawdownPct: 30, // exactly 30%
      };

      const result = computeVerdict(metrics);
      // Should be POSITIVE_EXPECTANCY (DD <= 30%)
      expect(result.verdict).toBe('POSITIVE_EXPECTANCY');
    });

    /**
     * P16-c-7: maxDrawdownPct = 30.01 is PROMISING_BUT_NEEDS_SHADOW.
     * **Validates: Requirements 14.3**
     */
    it('maxDrawdownPct = 30.01 is PROMISING_BUT_NEEDS_SHADOW', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 50_000n, // positive
        profitFactor: 1.5, // >= 1.2
        maxDrawdownPct: 30.01, // just over 30%
      };

      const result = computeVerdict(metrics);
      // Should be PROMISING_BUT_NEEDS_SHADOW (DD > 30%)
      expect(result.verdict).toBe('PROMISING_BUT_NEEDS_SHADOW');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P16-d: Edge Cases and Boundary Values
  // ─────────────────────────────────────────────────────────────────────────

  describe('P16-d: Edge Cases and Boundary Values', () => {
    /**
     * P16-d-1: Very large numbers don't break the engine.
     * **Validates: Requirements 14.1**
     */
    it('handles very large numbers', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 1000,
        avgPnlPerTrade: 999_999_999_999n, // very large positive
        profitFactor: 9.99,
        maxDrawdownPct: 0.01,
      };

      const result = computeVerdict(metrics);
      expect(result.verdict).toBe('POSITIVE_EXPECTANCY');
    });

    /**
     * P16-d-2: Very negative avgPnlPerTrade is handled.
     * **Validates: Requirements 14.1**
     */
    it('handles very negative avgPnlPerTrade', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 100,
        avgPnlPerTrade: -999_999_999_999n, // very large negative
        profitFactor: 0.1,
        maxDrawdownPct: 99,
      };

      const result = computeVerdict(metrics);
      expect(result.verdict).toBe('NEGATIVE_EXPECTANCY');
    });

    /**
     * P16-d-3: profitFactor of 0 is BREAKEVEN (not negative expectancy).
     * **Validates: Requirements 14.1, 14.3**
     */
    it('profitFactor of 0 is BREAKEVEN', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 0n,
        profitFactor: 0,
        maxDrawdownPct: 10,
      };

      const result = computeVerdict(metrics);
      expect(result.verdict).toBe('BREAKEVEN');
    });

    /**
     * P16-d-4: maxDrawdownPct of 0 is valid.
     * **Validates: Requirements 14.1**
     */
    it('maxDrawdownPct of 0 is valid', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 100_000n,
        profitFactor: 2.0,
        maxDrawdownPct: 0,
      };

      const result = computeVerdict(metrics);
      expect(result.verdict).toBe('POSITIVE_EXPECTANCY');
    });

    /**
     * P16-d-5: maxDrawdownPct of 100 is handled.
     * **Validates: Requirements 14.1**
     */
    it('maxDrawdownPct of 100 is handled', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 100_000n,
        profitFactor: 2.0,
        maxDrawdownPct: 100, // max drawdown
      };

      const result = computeVerdict(metrics);
      expect(result.verdict).toBe('PROMISING_BUT_NEEDS_SHADOW');
    });

    /**
     * P16-d-6: avgPnlPerTrade = -1n is negative expectancy.
     * **Validates: Requirements 14.3**
     */
    it('avgPnlPerTrade = -1n is NEGATIVE_EXPECTANCY', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: -1n, // barely negative
        profitFactor: 5.0,
        maxDrawdownPct: 5,
      };

      const result = computeVerdict(metrics);
      expect(result.verdict).toBe('NEGATIVE_EXPECTANCY');
    });

    /**
     * P16-d-7: All verdicts can be reached.
     * **Validates: Requirements 14.1**
     */
    it('all verdicts can be reached', () => {
      const testCases: Array<[VerdictMetricsInput, Verdict]> = [
        // INSUFFICIENT_DATA: < 10 trades
        [{ totalTrades: 5, avgPnlPerTrade: 100_000n, profitFactor: 2.0, maxDrawdownPct: 10 }, 'INSUFFICIENT_DATA'],
        // NEGATIVE_EXPECTANCY: >= 10 trades, negative P&L
        [{ totalTrades: 50, avgPnlPerTrade: -50_000n, profitFactor: 0.8, maxDrawdownPct: 20 }, 'NEGATIVE_EXPECTANCY'],
        // BREAKEVEN: >= 10 trades, non-negative P&L, PF < 1.2
        [{ totalTrades: 50, avgPnlPerTrade: 10_000n, profitFactor: 1.1, maxDrawdownPct: 20 }, 'BREAKEVEN'],
        // POSITIVE_EXPECTANCY: >= 10 trades, non-negative P&L, PF >= 1.2, DD <= 30%
        [{ totalTrades: 50, avgPnlPerTrade: 100_000n, profitFactor: 1.5, maxDrawdownPct: 25 }, 'POSITIVE_EXPECTANCY'],
        // PROMISING_BUT_NEEDS_SHADOW: >= 10 trades, non-negative P&L, PF >= 1.2, DD > 30%
        [{ totalTrades: 50, avgPnlPerTrade: 100_000n, profitFactor: 1.5, maxDrawdownPct: 40 }, 'PROMISING_BUT_NEEDS_SHADOW'],
      ];

      for (const [metrics, expectedVerdict] of testCases) {
        const result = computeVerdict(metrics);
        expect(result.verdict).toBe(expectedVerdict);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P16-e: Rationale Correctness
  // ─────────────────────────────────────────────────────────────────────────

  describe('P16-e: Rationale Correctness', () => {
    /**
     * P16-e-1: INSUFFICIENT_DATA rationale mentions trade count.
     * **Validates: Requirements 14.2**
     */
    it('INSUFFICIENT_DATA rationale mentions trade count', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: THRESHOLDS.minTrades - 1 }),
          (totalTrades) => {
            const metrics: VerdictMetricsInput = {
              totalTrades,
              avgPnlPerTrade: 0n,
              profitFactor: 1.0,
              maxDrawdownPct: 20,
            };

            const result = computeVerdict(metrics);
            expect(result.rationale).toContain(String(totalTrades));
            expect(result.rationale.toLowerCase()).toContain('trade');
          },
        ),
        { numRuns: 20 },
      );
    });

    /**
     * P16-e-2: BREAKEVEN rationale mentions profit factor.
     * **Validates: Requirements 14.2**
     */
    it('BREAKEVEN rationale mentions profit factor', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 10_000n,
        profitFactor: 1.0,
        maxDrawdownPct: 20,
      };

      const result = computeVerdict(metrics);
      expect(result.rationale.toLowerCase()).toContain('profit factor');
    });

    /**
     * P16-e-3: POSITIVE_EXPECTANCY rationale mentions both PF and drawdown.
     * **Validates: Requirements 14.2**
     */
    it('POSITIVE_EXPECTANCY rationale mentions both PF and drawdown', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 100_000n,
        profitFactor: 1.5,
        maxDrawdownPct: 20,
      };

      const result = computeVerdict(metrics);
      expect(result.rationale.toLowerCase()).toContain('pf');
      expect(result.rationale.toLowerCase()).toContain('drawdown');
    });

    /**
     * P16-e-4: PROMISING_BUT_NEEDS_SHADOW rationale mentions drawdown exceeding limit.
     * **Validates: Requirements 14.2**
     */
    it('PROMISING_BUT_NEEDS_SHADOW rationale mentions drawdown exceeding limit', () => {
      const metrics: VerdictMetricsInput = {
        totalTrades: 50,
        avgPnlPerTrade: 100_000n,
        profitFactor: 1.5,
        maxDrawdownPct: 40,
      };

      const result = computeVerdict(metrics);
      expect(result.rationale.toLowerCase()).toContain('drawdown');
      expect(result.rationale.toLowerCase()).toContain('30%');
    });
  });
});

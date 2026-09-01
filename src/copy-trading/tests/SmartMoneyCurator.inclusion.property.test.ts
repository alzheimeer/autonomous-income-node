/**
 * SmartMoneyCurator — Property-Based Tests for Wallet Inclusion Criteria
 *
 * **Property 1: Wallet Inclusion Criteria Enforcement**
 * For any wallet submitted for evaluation, SmartMoneyCurator SHALL accept
 * the wallet if and only if ALL conditions are met:
 * - win_rate ≥ 70%
 * - total_pnl_usdc ≥ $50,000
 * - trade_count ≥ 100
 * - 900s ≤ avg_holding_time_sec ≤ 604,800s (15 min to 7 days)
 * - volume_usdc ≥ $500,000
 *
 * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6**
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  SmartMoneyCurator,
  DEFAULT_INCLUSION_CRITERIA,
  WalletMetrics,
} from '../modules/SmartMoneyCurator.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS - Threshold Values from Requirements
// ═══════════════════════════════════════════════════════════════════════════

/** Minimum win rate: 70% (Req 1.2) */
const MIN_WIN_RATE = 0.70;

/** Minimum historical PnL: $50,000 USDC (Req 1.3) */
const MIN_PNL_USDC = 50_000;

/** Minimum trade count: 100 trades (Req 1.4) */
const MIN_TRADE_COUNT = 100;

/** Minimum average holding time: 15 minutes = 900 seconds (Req 1.5) */
const MIN_HOLDING_TIME_SEC = 900;

/** Maximum average holding time: 7 days = 604,800 seconds (Req 1.5) */
const MAX_HOLDING_TIME_SEC = 604_800;

/** Minimum historical volume: $500,000 USDC (Req 1.6) */
const MIN_VOLUME_USDC = 500_000;

// ═══════════════════════════════════════════════════════════════════════════
// GENERATORS - Random Wallet Metrics
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a win rate value that meets the minimum threshold (≥70%)
 * Using integer percentages to avoid floating point precision issues
 */
const validWinRate = fc.integer({ min: 70, max: 100 }).map(n => n / 100);

/**
 * Generate a win rate value that does NOT meet the minimum threshold (<70%)
 */
const invalidWinRate = fc.integer({ min: 0, max: 69 }).map(n => n / 100);

/**
 * Generate a PnL value that meets the minimum threshold (≥$50,000)
 */
const validPnlUsdc = fc.integer({ min: MIN_PNL_USDC, max: 10_000_000 });

/**
 * Generate a PnL value that does NOT meet the minimum threshold (<$50,000)
 */
const invalidPnlUsdc = fc.integer({ min: -100_000, max: MIN_PNL_USDC - 1 });

/**
 * Generate a trade count that meets the minimum threshold (≥100)
 */
const validTradeCount = fc.integer({ min: MIN_TRADE_COUNT, max: 10_000 });

/**
 * Generate a trade count that does NOT meet the minimum threshold (<100)
 */
const invalidTradeCount = fc.integer({ min: 0, max: MIN_TRADE_COUNT - 1 });

/**
 * Generate a holding time that meets the constraints (900s to 604,800s)
 */
const validHoldingTime = fc.integer({ min: MIN_HOLDING_TIME_SEC, max: MAX_HOLDING_TIME_SEC });

/**
 * Generate a holding time that is too short (<900s = <15 minutes)
 */
const tooShortHoldingTime = fc.integer({ min: 0, max: MIN_HOLDING_TIME_SEC - 1 });

/**
 * Generate a holding time that is too long (>604,800s = >7 days)
 */
const tooLongHoldingTime = fc.integer({ min: MAX_HOLDING_TIME_SEC + 1, max: 31_536_000 }); // up to 1 year

/**
 * Generate a volume that meets the minimum threshold (≥$500,000)
 */
const validVolumeUsdc = fc.integer({ min: MIN_VOLUME_USDC, max: 100_000_000 });

/**
 * Generate a volume that does NOT meet the minimum threshold (<$500,000)
 */
const invalidVolumeUsdc = fc.integer({ min: 0, max: MIN_VOLUME_USDC - 1 });

/**
 * Generate complete wallet metrics where ALL criteria are met
 */
const allValidMetrics: fc.Arbitrary<WalletMetrics> = fc.record({
  winRate: validWinRate,
  totalPnlUsdc: validPnlUsdc,
  tradeCount: validTradeCount,
  avgHoldingTimeSec: validHoldingTime,
  volumeUsdc: validVolumeUsdc,
});

/**
 * Generate wallet metrics with an invalid win rate (other criteria valid)
 */
const metricsWithInvalidWinRate: fc.Arbitrary<WalletMetrics> = fc.record({
  winRate: invalidWinRate,
  totalPnlUsdc: validPnlUsdc,
  tradeCount: validTradeCount,
  avgHoldingTimeSec: validHoldingTime,
  volumeUsdc: validVolumeUsdc,
});

/**
 * Generate wallet metrics with an invalid PnL (other criteria valid)
 */
const metricsWithInvalidPnl: fc.Arbitrary<WalletMetrics> = fc.record({
  winRate: validWinRate,
  totalPnlUsdc: invalidPnlUsdc,
  tradeCount: validTradeCount,
  avgHoldingTimeSec: validHoldingTime,
  volumeUsdc: validVolumeUsdc,
});

/**
 * Generate wallet metrics with an invalid trade count (other criteria valid)
 */
const metricsWithInvalidTradeCount: fc.Arbitrary<WalletMetrics> = fc.record({
  winRate: validWinRate,
  totalPnlUsdc: validPnlUsdc,
  tradeCount: invalidTradeCount,
  avgHoldingTimeSec: validHoldingTime,
  volumeUsdc: validVolumeUsdc,
});

/**
 * Generate wallet metrics with a holding time too short (other criteria valid)
 */
const metricsWithTooShortHoldingTime: fc.Arbitrary<WalletMetrics> = fc.record({
  winRate: validWinRate,
  totalPnlUsdc: validPnlUsdc,
  tradeCount: validTradeCount,
  avgHoldingTimeSec: tooShortHoldingTime,
  volumeUsdc: validVolumeUsdc,
});

/**
 * Generate wallet metrics with a holding time too long (other criteria valid)
 */
const metricsWithTooLongHoldingTime: fc.Arbitrary<WalletMetrics> = fc.record({
  winRate: validWinRate,
  totalPnlUsdc: validPnlUsdc,
  tradeCount: validTradeCount,
  avgHoldingTimeSec: tooLongHoldingTime,
  volumeUsdc: validVolumeUsdc,
});

/**
 * Generate wallet metrics with an invalid volume (other criteria valid)
 */
const metricsWithInvalidVolume: fc.Arbitrary<WalletMetrics> = fc.record({
  winRate: validWinRate,
  totalPnlUsdc: validPnlUsdc,
  tradeCount: validTradeCount,
  avgHoldingTimeSec: validHoldingTime,
  volumeUsdc: invalidVolumeUsdc,
});

/**
 * Generate completely random wallet metrics (may or may not pass)
 */
const anyMetrics: fc.Arbitrary<WalletMetrics> = fc.record({
  winRate: fc.double({ min: 0, max: 1, noNaN: true }),
  totalPnlUsdc: fc.integer({ min: -1_000_000, max: 50_000_000 }),
  tradeCount: fc.integer({ min: 0, max: 50_000 }),
  avgHoldingTimeSec: fc.integer({ min: 0, max: 31_536_000 }), // 0 to 1 year
  volumeUsdc: fc.integer({ min: 0, max: 500_000_000 }),
});

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pure function that determines if metrics should pass all inclusion criteria.
 * This serves as the oracle for our property tests.
 */
function shouldPassInclusionCriteria(metrics: WalletMetrics): boolean {
  return (
    metrics.winRate >= MIN_WIN_RATE &&
    metrics.totalPnlUsdc >= MIN_PNL_USDC &&
    metrics.tradeCount >= MIN_TRADE_COUNT &&
    metrics.avgHoldingTimeSec >= MIN_HOLDING_TIME_SEC &&
    metrics.avgHoldingTimeSec <= MAX_HOLDING_TIME_SEC &&
    metrics.volumeUsdc >= MIN_VOLUME_USDC
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PROPERTY TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('SmartMoneyCurator - Property 1: Wallet Inclusion Criteria Enforcement', () => {
  let curator: SmartMoneyCurator;

  beforeEach(() => {
    curator = new SmartMoneyCurator();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.1: Valid metrics always pass
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.1: Valid metrics always pass', () => {
    /**
     * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6**
     *
     * For any wallet where ALL criteria are met, evaluateInclusionCriteria
     * SHALL return true.
     */
    it('accepts wallets meeting all inclusion criteria', () => {
      fc.assert(
        fc.property(allValidMetrics, (metrics) => {
          const result = curator.evaluateInclusionCriteria(metrics);
          
          // Property: If all criteria are valid, the result MUST be true
          expect(result).toBe(true);

          // Verify detailed result also passes
          const detailedResult = curator.evaluateInclusionCriteriaDetailed(metrics);
          expect(detailedResult.passed).toBe(true);
          expect(detailedResult.failedCriteria).toHaveLength(0);
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.2: Invalid win rate causes rejection
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.2: Invalid win rate causes rejection', () => {
    /**
     * **Validates: Requirement 1.2**
     *
     * For any wallet where win_rate < 70%, evaluateInclusionCriteria
     * SHALL return false, even if all other criteria are met.
     */
    it('rejects wallets with win_rate below 70%', () => {
      fc.assert(
        fc.property(metricsWithInvalidWinRate, (metrics) => {
          const result = curator.evaluateInclusionCriteria(metrics);

          // Property: If win rate is invalid, the result MUST be false
          expect(result).toBe(false);

          // Verify the specific failure reason
          const detailedResult = curator.evaluateInclusionCriteriaDetailed(metrics);
          expect(detailedResult.passed).toBe(false);
          expect(detailedResult.failedCriteria).toContain('winRate');
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.3: Invalid PnL causes rejection
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.3: Invalid PnL causes rejection', () => {
    /**
     * **Validates: Requirement 1.3**
     *
     * For any wallet where total_pnl_usdc < $50,000, evaluateInclusionCriteria
     * SHALL return false, even if all other criteria are met.
     */
    it('rejects wallets with PnL below $50,000', () => {
      fc.assert(
        fc.property(metricsWithInvalidPnl, (metrics) => {
          const result = curator.evaluateInclusionCriteria(metrics);

          // Property: If PnL is invalid, the result MUST be false
          expect(result).toBe(false);

          // Verify the specific failure reason
          const detailedResult = curator.evaluateInclusionCriteriaDetailed(metrics);
          expect(detailedResult.passed).toBe(false);
          expect(detailedResult.failedCriteria).toContain('historicalPnl');
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.4: Invalid trade count causes rejection
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.4: Invalid trade count causes rejection', () => {
    /**
     * **Validates: Requirement 1.4**
     *
     * For any wallet where trade_count < 100, evaluateInclusionCriteria
     * SHALL return false, even if all other criteria are met.
     */
    it('rejects wallets with trade count below 100', () => {
      fc.assert(
        fc.property(metricsWithInvalidTradeCount, (metrics) => {
          const result = curator.evaluateInclusionCriteria(metrics);

          // Property: If trade count is invalid, the result MUST be false
          expect(result).toBe(false);

          // Verify the specific failure reason
          const detailedResult = curator.evaluateInclusionCriteriaDetailed(metrics);
          expect(detailedResult.passed).toBe(false);
          expect(detailedResult.failedCriteria).toContain('tradeCount');
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.5a: Holding time too short causes rejection
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.5a: Holding time too short causes rejection', () => {
    /**
     * **Validates: Requirement 1.5**
     *
     * For any wallet where avg_holding_time_sec < 900s (15 min),
     * evaluateInclusionCriteria SHALL return false.
     */
    it('rejects wallets with holding time below 15 minutes', () => {
      fc.assert(
        fc.property(metricsWithTooShortHoldingTime, (metrics) => {
          const result = curator.evaluateInclusionCriteria(metrics);

          // Property: If holding time is too short, the result MUST be false
          expect(result).toBe(false);

          // Verify the specific failure reason
          const detailedResult = curator.evaluateInclusionCriteriaDetailed(metrics);
          expect(detailedResult.passed).toBe(false);
          expect(detailedResult.failedCriteria).toContain('minHoldingTime');
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.5b: Holding time too long causes rejection
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.5b: Holding time too long causes rejection', () => {
    /**
     * **Validates: Requirement 1.5**
     *
     * For any wallet where avg_holding_time_sec > 604,800s (7 days),
     * evaluateInclusionCriteria SHALL return false.
     */
    it('rejects wallets with holding time above 7 days', () => {
      fc.assert(
        fc.property(metricsWithTooLongHoldingTime, (metrics) => {
          const result = curator.evaluateInclusionCriteria(metrics);

          // Property: If holding time is too long, the result MUST be false
          expect(result).toBe(false);

          // Verify the specific failure reason
          const detailedResult = curator.evaluateInclusionCriteriaDetailed(metrics);
          expect(detailedResult.passed).toBe(false);
          expect(detailedResult.failedCriteria).toContain('maxHoldingTime');
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.6: Invalid volume causes rejection
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.6: Invalid volume causes rejection', () => {
    /**
     * **Validates: Requirement 1.6**
     *
     * For any wallet where volume_usdc < $500,000, evaluateInclusionCriteria
     * SHALL return false, even if all other criteria are met.
     */
    it('rejects wallets with volume below $500,000', () => {
      fc.assert(
        fc.property(metricsWithInvalidVolume, (metrics) => {
          const result = curator.evaluateInclusionCriteria(metrics);

          // Property: If volume is invalid, the result MUST be false
          expect(result).toBe(false);

          // Verify the specific failure reason
          const detailedResult = curator.evaluateInclusionCriteriaDetailed(metrics);
          expect(detailedResult.passed).toBe(false);
          expect(detailedResult.failedCriteria).toContain('historicalVolume');
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.7: Equivalence with oracle function
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.7: Equivalence with oracle function', () => {
    /**
     * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6**
     *
     * For any randomly generated wallet metrics, the result of
     * evaluateInclusionCriteria SHALL match the oracle function
     * shouldPassInclusionCriteria.
     */
    it('matches oracle function for any random metrics', () => {
      fc.assert(
        fc.property(anyMetrics, (metrics) => {
          const systemResult = curator.evaluateInclusionCriteria(metrics);
          const oracleResult = shouldPassInclusionCriteria(metrics);

          // Property: System result MUST match oracle result
          expect(systemResult).toBe(oracleResult);
        }),
        { numRuns: 500 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.8: Boundary conditions at threshold values
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.8: Boundary conditions at threshold values', () => {
    /**
     * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6**
     *
     * Wallets exactly at threshold values SHALL pass.
     * Wallets just below threshold values SHALL fail.
     */
    it('correctly handles exact threshold values', () => {
      const exactThresholdMetrics: WalletMetrics = {
        winRate: MIN_WIN_RATE,           // Exactly 70%
        totalPnlUsdc: MIN_PNL_USDC,       // Exactly $50,000
        tradeCount: MIN_TRADE_COUNT,      // Exactly 100
        avgHoldingTimeSec: MIN_HOLDING_TIME_SEC, // Exactly 900s (15 min)
        volumeUsdc: MIN_VOLUME_USDC,      // Exactly $500,000
      };

      const result = curator.evaluateInclusionCriteria(exactThresholdMetrics);
      expect(result).toBe(true);

      const detailedResult = curator.evaluateInclusionCriteriaDetailed(exactThresholdMetrics);
      expect(detailedResult.passed).toBe(true);
      expect(detailedResult.failedCriteria).toHaveLength(0);
    });

    it('correctly handles values just below thresholds', () => {
      // Test each threshold individually
      const justBelowWinRate: WalletMetrics = {
        winRate: MIN_WIN_RATE - 0.01,
        totalPnlUsdc: MIN_PNL_USDC,
        tradeCount: MIN_TRADE_COUNT,
        avgHoldingTimeSec: MIN_HOLDING_TIME_SEC,
        volumeUsdc: MIN_VOLUME_USDC,
      };
      expect(curator.evaluateInclusionCriteria(justBelowWinRate)).toBe(false);

      const justBelowPnl: WalletMetrics = {
        winRate: MIN_WIN_RATE,
        totalPnlUsdc: MIN_PNL_USDC - 1,
        tradeCount: MIN_TRADE_COUNT,
        avgHoldingTimeSec: MIN_HOLDING_TIME_SEC,
        volumeUsdc: MIN_VOLUME_USDC,
      };
      expect(curator.evaluateInclusionCriteria(justBelowPnl)).toBe(false);

      const justBelowTradeCount: WalletMetrics = {
        winRate: MIN_WIN_RATE,
        totalPnlUsdc: MIN_PNL_USDC,
        tradeCount: MIN_TRADE_COUNT - 1,
        avgHoldingTimeSec: MIN_HOLDING_TIME_SEC,
        volumeUsdc: MIN_VOLUME_USDC,
      };
      expect(curator.evaluateInclusionCriteria(justBelowTradeCount)).toBe(false);

      const justBelowMinHoldingTime: WalletMetrics = {
        winRate: MIN_WIN_RATE,
        totalPnlUsdc: MIN_PNL_USDC,
        tradeCount: MIN_TRADE_COUNT,
        avgHoldingTimeSec: MIN_HOLDING_TIME_SEC - 1,
        volumeUsdc: MIN_VOLUME_USDC,
      };
      expect(curator.evaluateInclusionCriteria(justBelowMinHoldingTime)).toBe(false);

      const justAboveMaxHoldingTime: WalletMetrics = {
        winRate: MIN_WIN_RATE,
        totalPnlUsdc: MIN_PNL_USDC,
        tradeCount: MIN_TRADE_COUNT,
        avgHoldingTimeSec: MAX_HOLDING_TIME_SEC + 1,
        volumeUsdc: MIN_VOLUME_USDC,
      };
      expect(curator.evaluateInclusionCriteria(justAboveMaxHoldingTime)).toBe(false);

      const justBelowVolume: WalletMetrics = {
        winRate: MIN_WIN_RATE,
        totalPnlUsdc: MIN_PNL_USDC,
        tradeCount: MIN_TRADE_COUNT,
        avgHoldingTimeSec: MIN_HOLDING_TIME_SEC,
        volumeUsdc: MIN_VOLUME_USDC - 1,
      };
      expect(curator.evaluateInclusionCriteria(justBelowVolume)).toBe(false);
    });

    it('accepts wallets at maximum holding time threshold', () => {
      const maxHoldingTimeMetrics: WalletMetrics = {
        winRate: MIN_WIN_RATE,
        totalPnlUsdc: MIN_PNL_USDC,
        tradeCount: MIN_TRADE_COUNT,
        avgHoldingTimeSec: MAX_HOLDING_TIME_SEC, // Exactly 604,800s (7 days)
        volumeUsdc: MIN_VOLUME_USDC,
      };

      const result = curator.evaluateInclusionCriteria(maxHoldingTimeMetrics);
      expect(result).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.9: Idempotence
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.9: Idempotence', () => {
    /**
     * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6**
     *
     * Evaluating the same metrics multiple times SHALL produce
     * the same result (deterministic evaluation).
     */
    it('produces consistent results for repeated evaluations', () => {
      fc.assert(
        fc.property(anyMetrics, (metrics) => {
          const result1 = curator.evaluateInclusionCriteria(metrics);
          const result2 = curator.evaluateInclusionCriteria(metrics);
          const result3 = curator.evaluateInclusionCriteria(metrics);

          // Property: All evaluations MUST produce the same result
          expect(result1).toBe(result2);
          expect(result2).toBe(result3);
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 1.10: Multiple failures are reported
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 1.10: Multiple failures are reported', () => {
    /**
     * **Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6**
     *
     * When multiple criteria fail, the detailed result SHALL report
     * all failed criteria, not just the first one.
     */
    it('reports all failed criteria in detailed result', () => {
      const allInvalidMetrics: WalletMetrics = {
        winRate: 0.50,           // Below 70%
        totalPnlUsdc: 10_000,    // Below $50,000
        tradeCount: 50,          // Below 100
        avgHoldingTimeSec: 100,  // Below 900s
        volumeUsdc: 100_000,     // Below $500,000
      };

      const detailedResult = curator.evaluateInclusionCriteriaDetailed(allInvalidMetrics);

      expect(detailedResult.passed).toBe(false);
      expect(detailedResult.failedCriteria).toContain('winRate');
      expect(detailedResult.failedCriteria).toContain('historicalPnl');
      expect(detailedResult.failedCriteria).toContain('tradeCount');
      expect(detailedResult.failedCriteria).toContain('minHoldingTime');
      expect(detailedResult.failedCriteria).toContain('historicalVolume');
      expect(detailedResult.failedCriteria).toHaveLength(5);
    });

    it('reports multiple failures with property-based testing', () => {
      // Generate metrics with exactly 2 invalid criteria
      const twoInvalidCriteria = fc.tuple(
        invalidWinRate,
        invalidPnlUsdc,
        validTradeCount,
        validHoldingTime,
        validVolumeUsdc
      ).map(([winRate, totalPnlUsdc, tradeCount, avgHoldingTimeSec, volumeUsdc]) => ({
        winRate,
        totalPnlUsdc,
        tradeCount,
        avgHoldingTimeSec,
        volumeUsdc,
      }));

      fc.assert(
        fc.property(twoInvalidCriteria, (metrics) => {
          const detailedResult = curator.evaluateInclusionCriteriaDetailed(metrics);

          expect(detailedResult.passed).toBe(false);
          expect(detailedResult.failedCriteria).toContain('winRate');
          expect(detailedResult.failedCriteria).toContain('historicalPnl');
          expect(detailedResult.failedCriteria.length).toBeGreaterThanOrEqual(2);
        }),
        { numRuns: 50 }
      );
    });
  });
});

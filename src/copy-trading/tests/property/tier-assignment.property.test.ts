/**
 * Property-Based Tests for Tier Assignment Determinism
 *
 * **Property 4: Tier Assignment Determinism**
 * For any wallet with valid metrics, the tier assignment SHALL be deterministic:
 * - S_TIER: top 5 wallets by combined score (win_rate × profit_factor × sharpe_ratio)
 * - A_TIER: wallets 6-15 by score
 * - B_TIER: wallets 16-50 by score
 *
 * And tier assignment SHALL be idempotent: assigning tier twice with same metrics
 * produces same result.
 *
 * **Validates: Requirements 1.12**
 *
 * @module copy-trading/tests/property/tier-assignment.property.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  SmartMoneyCurator,
  type ExtendedWalletMetrics,
  type TierAssignmentResult,
} from '../../modules/SmartMoneyCurator.js';
import type { WalletTier } from '../../interfaces/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** S_TIER: Top 5 wallets (ranks 1-5) */
const S_TIER_MAX_RANK = 5;

/** A_TIER: Wallets 6-15 (ranks 6-15) */
const A_TIER_MIN_RANK = 6;
const A_TIER_MAX_RANK = 15;

/** B_TIER: Wallets 16-50 (ranks 16-50) */
const B_TIER_MIN_RANK = 16;
const B_TIER_MAX_RANK = 50;

/** Valid tier values */
const VALID_TIERS: WalletTier[] = ['S_TIER', 'A_TIER', 'B_TIER'];


// ═══════════════════════════════════════════════════════════════════════════
// ARBITRARIES - Generators for property-based testing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates valid Ethereum addresses in checksummed format
 */
const addressArbitrary = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((hex) => `0x${hex}`);

/**
 * Generates unique Ethereum addresses array
 */
const uniqueAddressesArbitrary = (count: number) =>
  fc.array(fc.integer({ min: 0, max: 999999 }), { minLength: count, maxLength: count })
    .map((indices) => [...new Set(indices)])
    .filter((arr) => arr.length === count)
    .map((indices) => indices.map((i) => `0x${i.toString(16).padStart(40, '0')}`));

/**
 * Generates ExtendedWalletMetrics with positive values for valid scoring.
 * Score formula: winRate × profitFactor × sharpeRatio
 */
const extendedMetricsArbitrary: fc.Arbitrary<ExtendedWalletMetrics> = fc.record({
  winRate: fc.double({ min: 0.01, max: 1.0, noNaN: true }),
  totalPnlUsdc: fc.double({ min: 50000, max: 10000000, noNaN: true }),
  tradeCount: fc.integer({ min: 100, max: 10000 }),
  avgHoldingTimeSec: fc.integer({ min: 900, max: 604800 }),
  volumeUsdc: fc.double({ min: 500000, max: 100000000, noNaN: true }),
  sharpeRatio: fc.double({ min: 0.1, max: 20, noNaN: true }),
  profitFactor: fc.double({ min: 0.1, max: 100, noNaN: true }),
});


/**
 * Generates a wallet object with address and metrics
 */
const walletWithMetricsArbitrary = fc
  .tuple(addressArbitrary, extendedMetricsArbitrary)
  .map(([address, metrics]) => ({ address, metrics }));

/**
 * Generates arrays of wallets with unique addresses
 */
const walletsArrayArbitrary = (minLen: number, maxLen: number) =>
  fc
    .array(walletWithMetricsArbitrary, { minLength: minLen, maxLength: maxLen })
    .map((wallets) => {
      // Ensure unique addresses by using index-based addresses
      return wallets.map((w, i) => ({
        ...w,
        address: `0x${i.toString(16).padStart(40, '0')}`,
      }));
    });

/**
 * Generates valid rank values (1-50)
 */
const validRankArbitrary = fc.integer({ min: 1, max: 50 });

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculates expected score using the documented formula
 */
function calculateExpectedScore(metrics: ExtendedWalletMetrics): number {
  return metrics.winRate * metrics.profitFactor * metrics.sharpeRatio;
}

/**
 * Determines expected tier based on rank
 */
function getExpectedTier(rank: number): WalletTier {
  if (rank >= 1 && rank <= S_TIER_MAX_RANK) return 'S_TIER';
  if (rank >= A_TIER_MIN_RANK && rank <= A_TIER_MAX_RANK) return 'A_TIER';
  return 'B_TIER';
}


// ═══════════════════════════════════════════════════════════════════════════
// PROPERTY TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 4: Tier Assignment Determinism', () => {
  let curator: SmartMoneyCurator;

  beforeEach(() => {
    curator = new SmartMoneyCurator();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Score Calculation Properties
  // Formula: combined_score = win_rate × profit_factor × sharpe_ratio
  // ═══════════════════════════════════════════════════════════════════════

  describe('Score Calculation (win_rate × profit_factor × sharpe_ratio)', () => {
    /**
     * **Validates: Requirements 1.12**
     * Score calculation follows the documented formula exactly.
     */
    it('PROP: Score equals winRate × profitFactor × sharpeRatio', () => {
      fc.assert(
        fc.property(extendedMetricsArbitrary, (metrics) => {
          const calculatedScore = curator.calculateWalletScore(metrics);
          const expectedScore = calculateExpectedScore(metrics);
          
          // Use tolerance for floating point comparison
          return Math.abs(calculatedScore - expectedScore) < 1e-10;
        }),
        { numRuns: 500 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * Score calculation is deterministic - same input always produces same output.
     */
    it('PROP: Score is deterministic (same metrics → same score)', () => {
      fc.assert(
        fc.property(extendedMetricsArbitrary, (metrics) => {
          const score1 = curator.calculateWalletScore(metrics);
          const score2 = curator.calculateWalletScore(metrics);
          const score3 = curator.calculateWalletScore({ ...metrics });
          
          return score1 === score2 && score2 === score3;
        }),
        { numRuns: 500 }
      );
    });


    /**
     * **Validates: Requirements 1.12**
     * Score is non-NaN for valid positive metrics.
     */
    it('PROP: Score is a valid number (not NaN)', () => {
      fc.assert(
        fc.property(extendedMetricsArbitrary, (metrics) => {
          const score = curator.calculateWalletScore(metrics);
          return !Number.isNaN(score) && Number.isFinite(score);
        }),
        { numRuns: 500 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * Score monotonically increases with each factor.
     */
    it('PROP: Higher winRate (other factors constant) → higher or equal score', () => {
      fc.assert(
        fc.property(
          extendedMetricsArbitrary,
          fc.double({ min: 0, max: 0.3, noNaN: true }),
          (baseMetrics, delta) => {
            if (baseMetrics.winRate + delta > 1) return true;
            
            const scoreLow = curator.calculateWalletScore(baseMetrics);
            const scoreHigh = curator.calculateWalletScore({
              ...baseMetrics,
              winRate: baseMetrics.winRate + delta,
            });
            
            return scoreHigh >= scoreLow;
          }
        ),
        { numRuns: 300 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════
  // S_TIER Assignment Properties (Top 5)
  // ═══════════════════════════════════════════════════════════════════════

  describe('S_TIER Assignment (top 5)', () => {
    /**
     * **Validates: Requirements 1.12**
     * Ranks 1-5 always map to S_TIER.
     */
    it('PROP: Ranks 1-5 always result in S_TIER', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 5 }), (rank) => {
          const tier = curator.assignTier(rank);
          return tier === 'S_TIER';
        }),
        { numRuns: 50 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * In a list of wallets, top 5 by score get S_TIER.
     */
    it('PROP: Top 5 wallets by score get S_TIER', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(10, 50), (wallets) => {
          const results = curator.assignTiers(wallets);
          
          // First 5 results (highest scores) should be S_TIER
          const sTierResults = results.slice(0, 5);
          return sTierResults.every((r) => r.tier === 'S_TIER');
        }),
        { numRuns: 100 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════
  // A_TIER Assignment Properties (6-15)
  // ═══════════════════════════════════════════════════════════════════════

  describe('A_TIER Assignment (6-15)', () => {
    /**
     * **Validates: Requirements 1.12**
     * Ranks 6-15 always map to A_TIER.
     */
    it('PROP: Ranks 6-15 always result in A_TIER', () => {
      fc.assert(
        fc.property(fc.integer({ min: 6, max: 15 }), (rank) => {
          const tier = curator.assignTier(rank);
          return tier === 'A_TIER';
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * In a list of wallets, positions 6-15 by score get A_TIER.
     */
    it('PROP: Wallets ranked 6-15 by score get A_TIER', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(20, 50), (wallets) => {
          const results = curator.assignTiers(wallets);
          
          // Results 6-15 (index 5-14) should be A_TIER
          const aTierResults = results.slice(5, 15);
          return aTierResults.every((r) => r.tier === 'A_TIER');
        }),
        { numRuns: 100 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════
  // B_TIER Assignment Properties (16-50)
  // ═══════════════════════════════════════════════════════════════════════

  describe('B_TIER Assignment (16-50)', () => {
    /**
     * **Validates: Requirements 1.12**
     * Ranks 16-50 always map to B_TIER.
     */
    it('PROP: Ranks 16-50 always result in B_TIER', () => {
      fc.assert(
        fc.property(fc.integer({ min: 16, max: 50 }), (rank) => {
          const tier = curator.assignTier(rank);
          return tier === 'B_TIER';
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * In a list of wallets, positions 16-50 by score get B_TIER.
     */
    it('PROP: Wallets ranked 16-50 by score get B_TIER', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(30, 50), (wallets) => {
          const results = curator.assignTiers(wallets);
          
          // Results 16+ (index 15+) should be B_TIER
          const bTierResults = results.slice(15);
          return bTierResults.every((r) => r.tier === 'B_TIER');
        }),
        { numRuns: 100 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════
  // Determinism Properties
  // ═══════════════════════════════════════════════════════════════════════

  describe('Determinism of Tier Assignment', () => {
    /**
     * **Validates: Requirements 1.12**
     * Same rank always produces same tier.
     */
    it('PROP: assignTier is deterministic (same rank → same tier)', () => {
      fc.assert(
        fc.property(validRankArbitrary, (rank) => {
          const tier1 = curator.assignTier(rank);
          const tier2 = curator.assignTier(rank);
          const tier3 = curator.assignTier(rank);
          
          return tier1 === tier2 && tier2 === tier3;
        }),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * Same wallet list always produces same tier assignments.
     */
    it('PROP: assignTiers is deterministic (same wallets → same results)', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(5, 40), (wallets) => {
          const result1 = curator.assignTiers(wallets);
          const result2 = curator.assignTiers(wallets);
          
          if (result1.length !== result2.length) return false;
          
          return result1.every((r1, i) => 
            r1.address === result2[i].address &&
            r1.tier === result2[i].tier &&
            Math.abs(r1.score - result2[i].score) < 1e-10
          );
        }),
        { numRuns: 100 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════
  // Idempotence Properties
  // ═══════════════════════════════════════════════════════════════════════

  describe('Idempotence of Assignment', () => {
    /**
     * **Validates: Requirements 1.12**
     * Calling assignTiers multiple times produces identical results.
     */
    it('PROP: assignTiers is idempotent (f(f(x)) = f(x))', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(5, 30), (wallets) => {
          // First assignment
          const result1 = curator.assignTiers(wallets);
          
          // Create new wallets from result (simulating re-input)
          const walletsFromResult = result1.map((r) => ({
            address: r.address,
            metrics: wallets.find((w) => w.address === r.address)!.metrics,
          }));
          
          // Second assignment
          const result2 = curator.assignTiers(walletsFromResult);
          
          // Results should be identical
          return result1.every((r1, i) =>
            r1.address === result2[i].address &&
            r1.tier === result2[i].tier &&
            Math.abs(r1.score - result2[i].score) < 1e-10
          );
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * Multiple consecutive calls don't change the result.
     */
    it('PROP: Multiple calls produce identical results', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(10, 25), (wallets) => {
          const results: TierAssignmentResult[][] = [];
          
          // Call 5 times
          for (let i = 0; i < 5; i++) {
            results.push(curator.assignTiers(wallets));
          }
          
          // All results should be identical
          const first = results[0];
          return results.every((result) =>
            result.every((r, i) =>
              r.address === first[i].address &&
              r.tier === first[i].tier &&
              Math.abs(r.score - first[i].score) < 1e-10
            )
          );
        }),
        { numRuns: 50 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════
  // Sorting and Ranking Properties
  // ═══════════════════════════════════════════════════════════════════════

  describe('Sorting and Ranking', () => {
    /**
     * **Validates: Requirements 1.12**
     * Results are sorted by score in descending order.
     */
    it('PROP: Results are sorted by score descending', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(2, 50), (wallets) => {
          const results = curator.assignTiers(wallets);
          
          // Verify descending order
          for (let i = 1; i < results.length; i++) {
            if (results[i].score > results[i - 1].score) {
              return false;
            }
          }
          return true;
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * Lower rank implies same or better tier.
     */
    it('PROP: Lower rank → same or better tier', () => {
      const tierOrder: Record<WalletTier, number> = {
        S_TIER: 0,
        A_TIER: 1,
        B_TIER: 2,
      };
      
      fc.assert(
        fc.property(validRankArbitrary, validRankArbitrary, (rank1, rank2) => {
          const tier1 = curator.assignTier(rank1);
          const tier2 = curator.assignTier(rank2);
          
          if (rank1 < rank2) {
            return tierOrder[tier1] <= tierOrder[tier2];
          } else if (rank1 > rank2) {
            return tierOrder[tier1] >= tierOrder[tier2];
          }
          return tier1 === tier2;
        }),
        { numRuns: 200 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════
  // Tier Distribution Properties
  // ═══════════════════════════════════════════════════════════════════════

  describe('Tier Distribution', () => {
    /**
     * **Validates: Requirements 1.12**
     * With exactly 50 wallets, distribution is 5 S_TIER, 10 A_TIER, 35 B_TIER.
     */
    it('PROP: With 50 wallets: 5 S_TIER, 10 A_TIER, 35 B_TIER', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(50, 50), (wallets) => {
          const results = curator.assignTiers(wallets);
          
          const sTierCount = results.filter((r) => r.tier === 'S_TIER').length;
          const aTierCount = results.filter((r) => r.tier === 'A_TIER').length;
          const bTierCount = results.filter((r) => r.tier === 'B_TIER').length;
          
          return sTierCount === 5 && aTierCount === 10 && bTierCount === 35;
        }),
        { numRuns: 30 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * All assigned tiers are valid values.
     */
    it('PROP: All assigned tiers are valid (S_TIER, A_TIER, B_TIER)', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(1, 50), (wallets) => {
          const results = curator.assignTiers(wallets);
          return results.every((r) => VALID_TIERS.includes(r.tier));
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * Number of results equals number of input wallets.
     */
    it('PROP: Output count equals input count', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(0, 50), (wallets) => {
          const results = curator.assignTiers(wallets);
          return results.length === wallets.length;
        }),
        { numRuns: 100 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════
  // Boundary Tests
  // ═══════════════════════════════════════════════════════════════════════

  describe('Boundary Tests', () => {
    /**
     * **Validates: Requirements 1.12**
     * Boundary ranks are correctly assigned.
     */
    it('PROP: Tier boundaries are correctly defined', () => {
      // S_TIER boundaries
      expect(curator.assignTier(1)).toBe('S_TIER');
      expect(curator.assignTier(5)).toBe('S_TIER');
      
      // A_TIER boundaries
      expect(curator.assignTier(6)).toBe('A_TIER');
      expect(curator.assignTier(15)).toBe('A_TIER');
      
      // B_TIER boundaries
      expect(curator.assignTier(16)).toBe('B_TIER');
      expect(curator.assignTier(50)).toBe('B_TIER');
    });

    /**
     * **Validates: Requirements 1.12**
     * Invalid ranks (< 1 or > 50) throw errors.
     */
    it('PROP: Invalid ranks throw errors', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.integer({ min: -1000, max: 0 }),
            fc.integer({ min: 51, max: 1000 })
          ),
          (invalidRank) => {
            try {
              curator.assignTier(invalidRank);
              return false; // Should have thrown
            } catch (e) {
              return e instanceof Error && e.message.includes('out of bounds');
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * Single wallet always gets S_TIER (rank 1).
     */
    it('PROP: Single wallet gets S_TIER', () => {
      fc.assert(
        fc.property(walletWithMetricsArbitrary, (wallet) => {
          const results = curator.assignTiers([wallet]);
          return results.length === 1 && results[0].tier === 'S_TIER';
        }),
        { numRuns: 50 }
      );
    });

    /**
     * **Validates: Requirements 1.12**
     * Empty wallet list returns empty results.
     */
    it('PROP: Empty list returns empty results', () => {
      const results = curator.assignTiers([]);
      expect(results).toEqual([]);
    });

    /**
     * **Validates: Requirements 1.1, 1.12**
     * More than 50 wallets throws error.
     */
    it('PROP: More than 50 wallets throws error', () => {
      fc.assert(
        fc.property(walletsArrayArbitrary(51, 60), (wallets) => {
          try {
            curator.assignTiers(wallets);
            return false;
          } catch (e) {
            return e instanceof Error && e.message.includes('Maximum is 50');
          }
        }),
        { numRuns: 20 }
      );
    });
  });
});

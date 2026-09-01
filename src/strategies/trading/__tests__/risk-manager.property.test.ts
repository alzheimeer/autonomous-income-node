/**
 * Property 9 — RiskManager: validates rejection logic across arbitrary inputs
 *
 * Validates: Requirements 6.2, 6.5, 6.6, 6.8
 *
 * Properties verified:
 *  P9-a: Tier 1/2 trades above $5 USDC are always rejected.
 *  P9-b: Tier 3/4 trades of any positive amount within 20% exposure pass size check.
 *  P9-c: Exposure > 20% is always rejected.
 *  P9-d: Exposure <= 20% passes (given amount and balance are positive).
 *  P9-e: Slippage exceeding tolerance is always rejected.
 *  P9-f: Zero or negative trade amount is always rejected for size/exposure.
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { RiskManagerImpl } from '../risk-manager.js';
import { SurvivalTier } from '../../../survival/tier-evaluator.js';

// ---------------------------------------------------------------------------
// Constants (must match risk-manager.ts)
// ---------------------------------------------------------------------------

const TIER_LOW_MAX_TRADE = 5_000_000n; // $5 USDC in 6-decimal units

describe('Property 9 — RiskManager rejection invariants', () => {
  const riskManager = new RiskManagerImpl({ minProfitThreshold: 500_000n });

  // Arbitrary generators
  // fc.float requires 32-bit float boundaries (Math.fround)
  const arbPositiveBalance = fc.bigInt({ min: 1n, max: 1_000_000_000_000n });
  const arbPositiveAmount = fc.bigInt({ min: 1n, max: 1_000_000_000_000n });
  // Use fc.double for tolerance as a standard JS number in [0.01, 10]
  const arbTolerance = fc.double({ min: 0.01, max: 10.0, noNaN: true });
  const arbLowTier = fc.constantFrom(SurvivalTier.TIER_1, SurvivalTier.TIER_2);
  const arbHighTier = fc.constantFrom(SurvivalTier.TIER_3, SurvivalTier.TIER_4);
  const arbTier = fc.constantFrom(
    SurvivalTier.EMERGENCY,
    SurvivalTier.TIER_1,
    SurvivalTier.TIER_2,
    SurvivalTier.TIER_3,
    SurvivalTier.TIER_4
  );

  /**
   * P9-a: For Tier 1 and Tier 2, any amount > $5 USDC is ALWAYS rejected.
   * Validates: Requirement 6.8
   */
  it('P9-a: Tier1/Tier2 trades > $5 USDC are always rejected', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: TIER_LOW_MAX_TRADE + 1n, max: 1_000_000_000_000n }),
        arbPositiveBalance,
        arbLowTier,
        (amount, balance, tier) => {
          const result = riskManager.validateTradeSize(amount, balance, tier);
          return result.valid === false && result.reason !== undefined;
        }
      ),
      { numRuns: 300 }
    );
  });

  /**
   * P9-b: For Tier 1 and Tier 2, any amount <= $5 USDC passes size check.
   * Validates: Requirement 6.8
   */
  it('P9-b: Tier1/Tier2 trades <= $5 USDC pass size check', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: TIER_LOW_MAX_TRADE }),
        arbPositiveBalance,
        arbLowTier,
        (amount, balance, tier) => {
          const result = riskManager.validateTradeSize(amount, balance, tier);
          return result.valid === true;
        }
      ),
      { numRuns: 300 }
    );
  });

  /**
   * P9-c: Tier 3/4 size check accepts any positive amount.
   * Validates: Requirement 6.8
   */
  it('P9-c: Tier3/Tier4 trades pass size check regardless of amount', () => {
    fc.assert(
      fc.property(
        arbPositiveAmount,
        arbPositiveBalance,
        arbHighTier,
        (amount, balance, tier) => {
          const result = riskManager.validateTradeSize(amount, balance, tier);
          return result.valid === true;
        }
      ),
      { numRuns: 300 }
    );
  });

  /**
   * P9-d: Exposure > 20% is always rejected.
   * Validates: Requirement 6.5
   */
  it('P9-d: exposure > 20% is always rejected', () => {
    // amount * 100 > balance * 20  ⟺  amount > balance * 20 / 100
    fc.assert(
      fc.property(
        arbPositiveBalance,
        // Generate amount that is strictly more than 20% of balance
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        (balance, extra) => {
          // amount = floor(balance * 21 / 100) + extra  => always > 20%
          const amount = (balance * 21n) / 100n + extra;
          const result = riskManager.validateExposure(amount, balance);
          return result.valid === false;
        }
      ),
      { numRuns: 300 }
    );
  });

  /**
   * P9-e: Exposure <= 20% passes.
   * Validates: Requirement 6.5
   */
  it('P9-e: exposure <= 20% always passes', () => {
    fc.assert(
      fc.property(
        // Use larger balances to avoid bigint rounding edge-cases
        fc.bigInt({ min: 100n, max: 1_000_000_000_000n }),
        fc.bigInt({ min: 1n, max: 20n }), // percentage 1–20
        (balance, pct) => {
          // amount = balance * pct / 100  (rounded down) — guaranteed <= 20%
          const amount = (balance * pct) / 100n;
          if (amount === 0n) return true; // skip rounding-to-zero cases
          const result = riskManager.validateExposure(amount, balance);
          return result.valid === true;
        }
      ),
      { numRuns: 300 }
    );
  });

  /**
   * P9-f: Slippage above tolerance is always rejected.
   * Validates: Requirement 6.6
   */
  it('P9-f: slippage exceeding tolerance is always rejected', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1_000_000n, max: 1_000_000_000n }), // expected output
        fc.double({ min: 0.01, max: 5.0, noNaN: true }), // tolerance pct
        (expected, tolerance) => {
          // Build an actual output with slippage strictly > tolerance%
          // actual = expected * (1 - (tolerance + delta) / 100)
          const delta = 0.1;
          const excessSlippage = tolerance + delta;
          const actualFloat = Number(expected) * (1 - excessSlippage / 100);
          if (actualFloat <= 0) return true; // skip extreme edge cases

          const actual = BigInt(Math.floor(actualFloat));
          if (actual <= 0n || actual >= expected) return true; // skip numeric noise

          const result = riskManager.validateSlippage(expected, actual, tolerance);
          return result.valid === false;
        }
      ),
      { numRuns: 300 }
    );
  });

  /**
   * P9-g: Zero or negative trade amount is always rejected for size check.
   * Validates: Requirement 6.2
   */
  it('P9-g: zero or negative trade amount is always rejected', () => {
    fc.assert(
      fc.property(arbPositiveBalance, arbTier, (balance, tier) => {
        const result = riskManager.validateTradeSize(0n, balance, tier);
        return result.valid === false;
      }),
      { numRuns: 200 }
    );
  });
});

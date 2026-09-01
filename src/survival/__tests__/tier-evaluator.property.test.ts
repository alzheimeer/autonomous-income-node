/**
 * Property 5 — Tier Evaluator invariants with arbitrary balances
 *
 * Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7
 *
 * Properties verified:
 *  P5-a: evaluateTier is total and deterministic (no balance produces an error)
 *  P5-b: capability gate for selfModEnabled is false for tiers < TIER_3
 *  P5-c: capability gate for replicationEnabled is false for tiers < TIER_4
 *  P5-d: tier assignment is monotonic (higher balance → tier >= lower balance)
 *  P5-e: llmBudgetMultiplier grows monotonically with tier
 *  P5-f: maxTradeSize is 0n in EMERGENCY, positive for Tier 1+
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import {
  evaluateTier,
  getCapabilityGates,
  SurvivalTier,
  TIER_THRESHOLDS,
} from '../tier-evaluator.js';

describe('Property 5 — Tier Evaluator capability gate invariants', () => {
  // Arbitrary balance generator: 0n to $10,000 USDC in 6-decimal units
  const arbBalance = fc.bigInt({ min: 0n, max: 10_000_000_000n });

  /**
   * P5-a: evaluateTier is total — any valid balance produces a SurvivalTier
   * without throwing.
   * Validates: Requirements 5.1
   */
  it('P5-a: evaluateTier is defined for all balances in [0, $10,000]', () => {
    fc.assert(
      fc.property(arbBalance, (balance) => {
        const tier = evaluateTier(balance);
        return Object.values(SurvivalTier).includes(tier);
      }),
      { numRuns: 500 }
    );
  });

  /**
   * P5-b: selfModEnabled is ONLY true for TIER_3 and TIER_4.
   * Validates: Requirements 5.5
   */
  it('P5-b: selfModEnabled is false for EMERGENCY, TIER_1, TIER_2 and true for TIER_3+', () => {
    fc.assert(
      fc.property(arbBalance, (balance) => {
        const tier = evaluateTier(balance);
        const gates = getCapabilityGates(tier);

        if (tier === SurvivalTier.TIER_3 || tier === SurvivalTier.TIER_4) {
          return gates.selfModEnabled === true;
        }
        return gates.selfModEnabled === false;
      }),
      { numRuns: 500 }
    );
  });

  /**
   * P5-c: replicationEnabled is ONLY true for TIER_4.
   * Validates: Requirements 5.6
   */
  it('P5-c: replicationEnabled is only true for TIER_4', () => {
    fc.assert(
      fc.property(arbBalance, (balance) => {
        const tier = evaluateTier(balance);
        const gates = getCapabilityGates(tier);

        if (tier === SurvivalTier.TIER_4) {
          return gates.replicationEnabled === true;
        }
        return gates.replicationEnabled === false;
      }),
      { numRuns: 500 }
    );
  });

  /**
   * P5-d: tier assignment is monotonic — if balance A >= balance B,
   * then evaluateTier(A) >= evaluateTier(B).
   * Validates: Requirements 5.3
   */
  it('P5-d: tier assignment is monotonic with balance', () => {
    fc.assert(
      fc.property(arbBalance, arbBalance, (a, b) => {
        const higher = a >= b ? a : b;
        const lower = a >= b ? b : a;
        const tierHigher = evaluateTier(higher);
        const tierLower = evaluateTier(lower);
        return tierHigher >= tierLower;
      }),
      { numRuns: 500 }
    );
  });

  /**
   * P5-e: llmBudgetMultiplier is non-decreasing with tier.
   * Validates: Requirements 5.4
   */
  it('P5-e: llmBudgetMultiplier grows non-decreasingly with tier level', () => {
    const tiers = [
      SurvivalTier.EMERGENCY,
      SurvivalTier.TIER_1,
      SurvivalTier.TIER_2,
      SurvivalTier.TIER_3,
      SurvivalTier.TIER_4,
    ];

    for (let i = 0; i < tiers.length - 1; i++) {
      const lower = getCapabilityGates(tiers[i]!).llmBudgetMultiplier;
      const higher = getCapabilityGates(tiers[i + 1]!).llmBudgetMultiplier;
      if (higher < lower) {
        throw new Error(
          `llmBudgetMultiplier decreased from tier ${tiers[i]} (${lower}) to tier ${tiers[i + 1]} (${higher})`
        );
      }
    }
  });

  /**
   * P5-f: maxTradeSize is 0n in EMERGENCY, positive in all other tiers.
   * Validates: Requirements 5.7
   */
  it('P5-f: maxTradeSize is 0n in EMERGENCY and positive in other tiers', () => {
    fc.assert(
      fc.property(arbBalance, (balance) => {
        const tier = evaluateTier(balance);
        const gates = getCapabilityGates(tier);

        if (tier === SurvivalTier.EMERGENCY) {
          return gates.maxTradeSize === 0n;
        }
        return gates.maxTradeSize > 0n;
      }),
      { numRuns: 500 }
    );
  });

  /**
   * P5-g: Tier boundary correctness — specific threshold values map to correct tiers.
   * Validates: Requirements 5.1, 5.3
   */
  it('P5-g: known threshold values map to the correct tiers', () => {
    const cases: Array<[bigint, SurvivalTier]> = [
      [0n, SurvivalTier.EMERGENCY],
      [1n, SurvivalTier.TIER_1],
      [TIER_THRESHOLDS.TIER_2_MIN, SurvivalTier.TIER_2],
      [TIER_THRESHOLDS.TIER_3_MIN, SurvivalTier.TIER_3],
      [TIER_THRESHOLDS.TIER_4_MIN, SurvivalTier.TIER_4],
    ];

    for (const [balance, expectedTier] of cases) {
      const actualTier = evaluateTier(balance);
      if (actualTier !== expectedTier) {
        throw new Error(
          `Expected balance ${balance} to be ${expectedTier}, got ${actualTier}`
        );
      }
    }
  });
});

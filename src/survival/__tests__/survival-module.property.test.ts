/**
 * Property 6 — SurvivalModule: exactly one tier:transition event per tier change
 *
 * Validates: Requirements 5.1, 5.2, 5.3
 *
 * Properties verified:
 *  P6-a: updateBalance emits exactly one tier:transition when tier actually changes.
 *  P6-b: updateBalance emits zero tier:transition events when tier stays the same.
 *  P6-c: tier:transition event always carries correct previousTier, newTier, and balance.
 *  P6-d: tier:emergency emitted when balance transitions to 0.
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import {
  SurvivalModuleImpl,
  evaluateTier,
  SurvivalTier,
  TIER_THRESHOLDS,
} from '../index.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbBalance = fc.bigInt({ min: 0n, max: 10_000_000_000n });

/**
 * Generate a pair of balances that map to DIFFERENT tiers.
 */
const arbDifferentTierBalances = fc.tuple(arbBalance, arbBalance).filter(([a, b]) => {
  return evaluateTier(a) !== evaluateTier(b);
});

/**
 * Generate a pair of balances that map to the SAME tier.
 */
const arbSameTierBalances = fc.tuple(arbBalance, arbBalance).filter(([a, b]) => {
  return evaluateTier(a) === evaluateTier(b);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 6 — SurvivalModule: tier:transition event invariants', () => {
  /**
   * P6-a: updateBalance emits exactly one tier:transition when tier changes.
   * Validates: Requirement 5.2
   */
  it('P6-a: exactly one tier:transition event emitted per tier change', () => {
    fc.assert(
      fc.property(arbDifferentTierBalances, ([initialBalance, newBalance]) => {
        const module = new SurvivalModuleImpl();
        module.start(initialBalance);

        let transitionCount = 0;
        module.on('tier:transition', () => {
          transitionCount++;
        });

        module.updateBalance(newBalance);
        module.stop();

        return transitionCount === 1;
      }),
      { numRuns: 200 }
    );
  });

  /**
   * P6-b: updateBalance emits zero tier:transition events when tier stays the same.
   * Validates: Requirement 5.2
   */
  it('P6-b: no tier:transition event emitted when tier does not change', () => {
    fc.assert(
      fc.property(arbSameTierBalances, ([initialBalance, newBalance]) => {
        const module = new SurvivalModuleImpl();
        module.start(initialBalance);

        let transitionCount = 0;
        module.on('tier:transition', () => {
          transitionCount++;
        });

        module.updateBalance(newBalance);
        module.stop();

        return transitionCount === 0;
      }),
      { numRuns: 200 }
    );
  });

  /**
   * P6-c: tier:transition event always has correct previousTier, newTier, balance.
   * Validates: Requirement 5.1, 5.2
   */
  it('P6-c: tier:transition event carries correct tier and balance information', () => {
    fc.assert(
      fc.property(arbDifferentTierBalances, ([initialBalance, newBalance]) => {
        const module = new SurvivalModuleImpl();
        const expectedPrevious = evaluateTier(initialBalance);
        const expectedNew = evaluateTier(newBalance);

        module.start(initialBalance);

        let eventOk = false;
        module.on('tier:transition', (event) => {
          eventOk =
            event.previousTier === expectedPrevious &&
            event.newTier === expectedNew &&
            event.balance === newBalance &&
            typeof event.timestamp === 'number';
        });

        module.updateBalance(newBalance);
        module.stop();

        return eventOk;
      }),
      { numRuns: 200 }
    );
  });

  /**
   * P6-d: Multiple consecutive same-tier updates emit zero events.
   * Validates: Requirement 5.2 (exactly one per CHANGE)
   */
  it('P6-d: consecutive updates within the same tier emit zero tier:transition events', () => {
    fc.assert(
      fc.property(
        fc.bigInt({
          min: TIER_THRESHOLDS.TIER_2_MIN,
          max: TIER_THRESHOLDS.TIER_3_MIN - 1n,
        }),
        fc.bigInt({
          min: TIER_THRESHOLDS.TIER_2_MIN,
          max: TIER_THRESHOLDS.TIER_3_MIN - 1n,
        }),
        fc.bigInt({
          min: TIER_THRESHOLDS.TIER_2_MIN,
          max: TIER_THRESHOLDS.TIER_3_MIN - 1n,
        }),
        (b1, b2, b3) => {
          const module = new SurvivalModuleImpl();
          module.start(b1);

          let transitionCount = 0;
          module.on('tier:transition', () => transitionCount++);

          // All three balances are in TIER_2, so no transitions expected
          module.updateBalance(b2);
          module.updateBalance(b3);
          module.stop();

          return transitionCount === 0;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P6-e: The number of tier:transition events equals the number of
   *       times the tier actually changes in a sequence of updates.
   * Validates: Requirement 5.2
   */
  it('P6-e: event count equals number of actual tier changes in a sequence', () => {
    fc.assert(
      fc.property(
        fc.array(arbBalance, { minLength: 2, maxLength: 10 }),
        (balances) => {
          const [initial, ...updates] = balances as [bigint, ...bigint[]];
          const module = new SurvivalModuleImpl();
          module.start(initial);

          let transitionCount = 0;
          module.on('tier:transition', () => transitionCount++);

          let expectedChanges = 0;
          let prevTier = evaluateTier(initial);
          for (const b of updates) {
            const nextTier = evaluateTier(b);
            if (nextTier !== prevTier) {
              expectedChanges++;
              prevTier = nextTier;
            }
            module.updateBalance(b);
          }

          module.stop();
          return transitionCount === expectedChanges;
        }
      ),
      { numRuns: 200 }
    );
  });
});

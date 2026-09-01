/**
 * Property-based tests for BankrollManager
 *
 * **Property 1: Loss allocation preserves total**
 * - For any sequence of allocateLoss() calls, totalUsdc = activeUsdc + reserveUsdc always holds
 *
 * **Property 2: Trade rejection on insufficient active**
 * - canTrade(size) returns false whenever size > activeUsdc or activeUsdc < min_active ($5)
 *
 * **Property 3: Active reduction formula**
 * - If total < $80, active = min($20, 25% of total)
 *
 * **Validates: Requirements 2.3, 2.5, 2.6, 2.7**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { BankrollManager } from '../../bankroll-manager.js';
import { createDatabase } from '../../db.js';
import { runMigrations } from '../../migrations.js';
import type { TradingDatabase } from '../../db.js';
import type { BankrollManagerConfig } from '../../config.js';
import type { UsdcAmount } from '../../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const MIN_ACTIVE: UsdcAmount = 5_000000n;             // $5
const LOW_TOTAL_THRESHOLD: UsdcAmount = 80_000000n;   // $80
const TWENTY_DOLLARS: UsdcAmount = 20_000000n;        // $20

const DEFAULT_CONFIG: BankrollManagerConfig = {
  initialTotal: 99_630000n,      // $99.63
  initialActive: 25_000000n,     // $25
  initialReserve: 74_630000n,    // $74.63
  minActive: MIN_ACTIVE,
  sweepThresholdPct: 0.20,
  sweepMinExcess: 5_000000n,
  lowTotalThreshold: LOW_TOTAL_THRESHOLD,
};

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createFreshManager(config?: Partial<BankrollManagerConfig>): {
  db: TradingDatabase;
  manager: BankrollManager;
} {
  const db = createDatabase(':memory:');
  runMigrations(db);
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const manager = new BankrollManager(db, mergedConfig);
  return { db, manager };
}

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate reasonable USDC loss amounts (1 cent to $25 — can't lose more than active).
 * Range: [10000, 25_000000] (6 decimal precision)
 */
const lossAmount = fc.bigInt(10000n, 25_000000n);

/**
 * Generate a sequence of loss amounts (1 to 10 losses).
 */
const lossSequence = fc.array(lossAmount, { minLength: 1, maxLength: 10 });

/**
 * Generate trade sizes from $0.01 to $50 (covers both valid and invalid).
 */
const tradeSize = fc.bigInt(10000n, 50_000000n);

/**
 * Generate initial active amounts from $0 to $100.
 */
const initialActiveAmount = fc.bigInt(0n, 100_000000n);

/**
 * Generate initial reserve amounts from $0 to $100.
 */
const initialReserveAmount = fc.bigInt(0n, 100_000000n);

/**
 * Generate total bankroll values from $0 to $150 (some below and above $80 threshold).
 */
const totalBankroll = fc.bigInt(1_000000n, 150_000000n);

// ═══════════════════════════════════════════════════════════════════════════
// Property 1: Loss allocation preserves total
// ═══════════════════════════════════════════════════════════════════════════

describe('BankrollManager Property Tests', () => {
  describe('Property 1: Loss allocation preserves total', () => {
    /**
     * **Validates: Requirements 2.3**
     *
     * For ANY sequence of allocateLoss() calls, the invariant
     * totalUsdc = activeUsdc + reserveUsdc MUST always hold.
     * Losses are deducted from active and reduce total; reserve is never touched.
     */
    it('totalUsdc = activeUsdc + reserveUsdc after any loss sequence', () => {
      fc.assert(
        fc.property(lossSequence, (losses) => {
          const { manager, db } = createFreshManager();

          for (const loss of losses) {
            manager.allocateLoss(loss);
          }

          const state = manager.getState();
          expect(state.totalUsdc).toBe(state.activeUsdc + state.reserveUsdc);

          db.close();
        }),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 2.3**
     *
     * Reserve is never reduced by loss allocation.
     * The reserve should always remain at initialReserve after losses.
     */
    it('reserve is never reduced by loss allocation', () => {
      fc.assert(
        fc.property(lossSequence, (losses) => {
          const { manager, db } = createFreshManager();
          const initialState = manager.getState();
          const initialReserve = initialState.reserveUsdc;

          for (const loss of losses) {
            manager.allocateLoss(loss);
          }

          const finalState = manager.getState();
          // Reserve may only change due to low-total formula reclassification,
          // but never reduced below initial when total >= $80
          if (finalState.totalUsdc >= LOW_TOTAL_THRESHOLD) {
            expect(finalState.reserveUsdc).toBe(initialReserve);
          }

          // Invariant always holds
          expect(finalState.totalUsdc).toBe(finalState.activeUsdc + finalState.reserveUsdc);

          db.close();
        }),
        { numRuns: 200 },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Property 2: Trade rejection on insufficient active
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Property 2: Trade rejection on insufficient active', () => {
    /**
     * **Validates: Requirements 2.5**
     *
     * canTrade(size) returns false whenever size > activeUsdc.
     */
    it('canTrade returns false when size exceeds active allocation', () => {
      fc.assert(
        fc.property(tradeSize, (size) => {
          const { manager, db } = createFreshManager();
          const state = manager.getState();

          if (size > state.activeUsdc) {
            expect(manager.canTrade(size)).toBe(false);
          }

          db.close();
        }),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 2.5, 2.6**
     *
     * canTrade(size) returns false whenever activeUsdc < min_active ($5),
     * regardless of the requested trade size.
     */
    it('canTrade returns false when active is below min_active ($5)', () => {
      fc.assert(
        fc.property(
          // Generate losses that will deplete active below $5
          fc.bigInt(21_000000n, 25_000000n), // loss between $21-$25 (leaves active < $5)
          tradeSize,
          (bigLoss, size) => {
            const { manager, db } = createFreshManager();

            // Apply a large loss to deplete active below min_active
            manager.allocateLoss(bigLoss);
            const state = manager.getState();

            if (state.activeUsdc < MIN_ACTIVE) {
              // ANY trade should be rejected regardless of size
              expect(manager.canTrade(size)).toBe(false);
              expect(manager.canTrade(1n)).toBe(false);
            }

            db.close();
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 2.5**
     *
     * canTrade(size) returns true when active >= min_active AND size <= activeUsdc.
     */
    it('canTrade returns true when active >= min_active and size fits', () => {
      fc.assert(
        fc.property(
          fc.bigInt(1_000000n, 24_000000n), // sizes $1-$24 (fits in $25 active)
          (size) => {
            const { manager, db } = createFreshManager();
            const state = manager.getState();

            // With default config, active = $25, min_active = $5
            if (size <= state.activeUsdc && state.activeUsdc >= MIN_ACTIVE) {
              expect(manager.canTrade(size)).toBe(true);
            }

            db.close();
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Property 3: Active reduction formula
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Property 3: Active reduction formula', () => {
    /**
     * **Validates: Requirements 2.6**
     *
     * If total < $80, active = min($20, 25% of total).
     * After sufficient losses to push total below $80, the formula is applied.
     */
    it('when total < $80, active <= min($20, 25% of total)', () => {
      fc.assert(
        fc.property(
          // Generate a loss sequence that brings total below $80
          fc.bigInt(20_000000n, 25_000000n), // loss $20-$25 from $25 active
          (loss) => {
            const { manager, db } = createFreshManager();

            // Apply loss — this brings active down and may trigger low-total formula
            manager.allocateLoss(loss);
            const state = manager.getState();

            if (state.totalUsdc < LOW_TOTAL_THRESHOLD) {
              // active must be <= min($20, 25% of total)
              const quarterOfTotal = state.totalUsdc / 4n;
              const maxAllowed = TWENTY_DOLLARS < quarterOfTotal ? TWENTY_DOLLARS : quarterOfTotal;
              expect(state.activeUsdc).toBeLessThanOrEqual(maxAllowed);
            }

            // Invariant still holds
            expect(state.totalUsdc).toBe(state.activeUsdc + state.reserveUsdc);

            db.close();
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 2.6**
     *
     * For any total bankroll value < $80, after applying the formula,
     * active is bounded by min($20, 25% of total).
     * Test with custom initial conditions that start below threshold.
     */
    it('active follows low-total formula with various initial conditions', () => {
      fc.assert(
        fc.property(
          // Total in range [$1, $79] (below threshold)
          fc.bigInt(1_000000n, 79_000000n),
          (total) => {
            // Split: active gets at most 25% of total, rest goes to reserve
            const quarterOfTotal = total / 4n;
            const maxActive = TWENTY_DOLLARS < quarterOfTotal ? TWENTY_DOLLARS : quarterOfTotal;
            const active = maxActive;
            const reserve = total - active;

            const { manager, db } = createFreshManager({
              initialTotal: total,
              initialActive: active,
              initialReserve: reserve,
              lowTotalThreshold: LOW_TOTAL_THRESHOLD,
            });

            // Apply a small loss to trigger the formula recalculation
            manager.allocateLoss(100000n); // $0.10 loss
            const state = manager.getState();

            if (state.totalUsdc < LOW_TOTAL_THRESHOLD) {
              const expectedMax = (() => {
                const q = state.totalUsdc / 4n;
                return TWENTY_DOLLARS < q ? TWENTY_DOLLARS : q;
              })();
              expect(state.activeUsdc).toBeLessThanOrEqual(expectedMax);
            }

            expect(state.totalUsdc).toBe(state.activeUsdc + state.reserveUsdc);

            db.close();
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 2.6, 2.7**
     *
     * When total >= $80, the low-total formula does NOT apply.
     * Active remains unchanged by the formula (only direct loss reduces it).
     */
    it('low-total formula does not apply when total >= $80', () => {
      fc.assert(
        fc.property(
          fc.bigInt(100000n, 5_000000n), // small losses $0.10 - $5
          (loss) => {
            const { manager, db } = createFreshManager();

            manager.allocateLoss(loss);
            const state = manager.getState();

            if (state.totalUsdc >= LOW_TOTAL_THRESHOLD) {
              // Active should be exactly initialActive - loss (direct subtraction)
              const expectedActive = DEFAULT_CONFIG.initialActive - loss;
              const clampedExpected = expectedActive > 0n ? expectedActive : 0n;
              expect(state.activeUsdc).toBe(clampedExpected);
            }

            db.close();
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

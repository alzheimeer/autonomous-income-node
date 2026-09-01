/**
 * SmartMoneyCurator — Property-Based Tests for Wallet Count Bounds
 *
 * **Property 3: Wallet Count Bounds Invariant**
 * For any sequence of wallet additions and removals, the count of monitored
 * wallets SHALL always satisfy: 10 ≤ count ≤ 50
 *
 * **Validates: Requirements 1.1**
 *
 * Test coverage:
 * - Minimum wallet count: 10
 * - Maximum wallet count: 50
 * - addWallet respects upper bound
 * - removeWallet respects lower bound
 * - Invariant: 10 ≤ wallet count ≤ 50
 *
 * @module copy-trading/tests/property/wallet-count
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  SmartMoneyCurator,
  MIN_WALLET_COUNT,
  MAX_WALLET_COUNT,
  type FullWalletMetrics,
  type WalletExclusionMetrics,
} from '../../modules/SmartMoneyCurator.js';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/** Expected minimum wallet count: 10 (Req 1.1) */
const EXPECTED_MIN = 10;

/** Expected maximum wallet count: 50 (Req 1.1) */
const EXPECTED_MAX = 50;

// ═══════════════════════════════════════════════════════════════════════════
// GENERATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates a valid Ethereum address (checksummed format)
 */
const genAddress = (index: number): string => {
  const hex = index.toString(16).padStart(40, '0');
  return `0x${hex}`;
};

/**
 * Generates wallet metrics that meet all inclusion criteria
 */
const genValidMetrics = (): FullWalletMetrics => ({
  winRate: 0.72 + Math.random() * 0.23,           // 72%-95%
  totalPnlUsdc: 55_000 + Math.random() * 100_000, // $55k-$155k
  tradeCount: 110 + Math.floor(Math.random() * 400), // 110-510
  avgHoldingTimeSec: 1000 + Math.floor(Math.random() * 80_000), // ~16min to ~22h
  volumeUsdc: 550_000 + Math.random() * 500_000,  // $550k-$1.05M
  sharpeRatio: 1.2 + Math.random() * 1.5,         // 1.2-2.7
  profitFactor: 1.5 + Math.random() * 1.5,        // 1.5-3.0
  maxDrawdownPct: 0.08 + Math.random() * 0.12,    // 8%-20%
  profitableWeeksPct: 0.55 + Math.random() * 0.35, // 55%-90%
});

/**
 * Generates exclusion metrics that pass all filters
 */
const genValidExclusionMetrics = (): WalletExclusionMetrics => ({
  sameBlockTradePct: 0.05 + Math.random() * 0.35,    // 5%-40% (< 50%)
  hasDeployedTokensRecently: false,
  honeypotExposurePct: 0.02 + Math.random() * 0.15,  // 2%-17% (< 20%)
  receivedDeployerAirdrop: false,
  sameCounterpartyPct: 0.05 + Math.random() * 0.20,  // 5%-25% (< 30%)
});

/**
 * Operation type for state machine testing
 */
type WalletOp =
  | { kind: 'add'; idx: number }
  | { kind: 'remove'; idx: number };

/**
 * Generates a random wallet operation
 */
const genOperation = fc.oneof(
  fc.nat({ max: 999 }).map((idx): WalletOp => ({ kind: 'add', idx })),
  fc.nat({ max: 999 }).map((idx): WalletOp => ({ kind: 'remove', idx }))
);

/**
 * Generates a sequence of operations
 */
const genOperationSeq = fc.array(genOperation, { minLength: 1, maxLength: 80 });

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Seeds a curator with n valid wallets
 */
function seed(curator: SmartMoneyCurator, n: number): string[] {
  const added: string[] = [];
  for (let i = 0; i < n; i++) {
    const addr = genAddress(i);
    const res = curator.addWalletWithMetrics(addr, genValidMetrics(), genValidExclusionMetrics());
    if (res) added.push(addr);
  }
  return added;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROPERTY TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 3: Wallet Count Bounds Invariant', () => {
  let curator: SmartMoneyCurator;

  beforeEach(() => {
    curator = new SmartMoneyCurator();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Constants verification
  // ─────────────────────────────────────────────────────────────────────────

  describe('Constants', () => {
    /**
     * **Validates: Requirements 1.1**
     */
    it('MIN_WALLET_COUNT equals 10', () => {
      expect(MIN_WALLET_COUNT).toBe(EXPECTED_MIN);
    });

    it('MAX_WALLET_COUNT equals 50', () => {
      expect(MAX_WALLET_COUNT).toBe(EXPECTED_MAX);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Maximum bound: addWallet respects upper bound
  // ─────────────────────────────────────────────────────────────────────────

  describe('addWallet respects upper bound', () => {
    /**
     * **Validates: Requirements 1.1**
     *
     * When count = 50, addWallet MUST fail and count MUST stay at 50.
     */
    it('rejects addition when count is at maximum (50)', () => {
      const added = seed(curator, MAX_WALLET_COUNT);
      expect(curator.getWalletCount()).toBe(EXPECTED_MAX);
      expect(added.length).toBe(EXPECTED_MAX);

      // Attempt to add one more
      const extra = genAddress(9999);
      const result = curator.addWalletWithMetrics(extra, genValidMetrics(), genValidExclusionMetrics());

      expect(result).toBeNull();
      expect(curator.getWalletCount()).toBe(EXPECTED_MAX);
      expect(curator.isMonitored(extra)).toBe(false);
    });

    /**
     * Property: For any number of add attempts beyond 50, count never exceeds 50.
     */
    it('never exceeds maximum (property)', () => {
      seed(curator, MAX_WALLET_COUNT);

      fc.assert(
        fc.property(fc.nat({ max: 30 }), (attempts) => {
          for (let i = 0; i < attempts; i++) {
            const addr = genAddress(MAX_WALLET_COUNT + i + 2000);
            curator.addWalletWithMetrics(addr, genValidMetrics(), genValidExclusionMetrics());
          }
          expect(curator.getWalletCount()).toBeLessThanOrEqual(EXPECTED_MAX);
        }),
        { numRuns: 25 }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Minimum bound: removeWallet respects lower bound
  // ─────────────────────────────────────────────────────────────────────────

  describe('removeWallet respects lower bound', () => {
    /**
     * **Validates: Requirements 1.1**
     *
     * When count = 10, removeWallet MUST fail and count MUST stay at 10.
     */
    it('rejects removal when count is at minimum (10)', () => {
      const added = seed(curator, MIN_WALLET_COUNT);
      expect(curator.getWalletCount()).toBe(EXPECTED_MIN);
      expect(added.length).toBe(EXPECTED_MIN);

      // Attempt to remove
      const result = curator.removeWallet(added[0]);

      expect(result).toBe(false);
      expect(curator.getWalletCount()).toBe(EXPECTED_MIN);
      expect(curator.isMonitored(added[0])).toBe(true);
    });

    /**
     * Property: For any number of remove attempts at minimum, count never drops below 10.
     */
    it('never goes below minimum (property)', () => {
      const added = seed(curator, MIN_WALLET_COUNT);

      fc.assert(
        fc.property(fc.nat({ max: 15 }), (attempts) => {
          for (let i = 0; i < attempts; i++) {
            const idx = i % added.length;
            curator.removeWallet(added[idx]);
          }
          expect(curator.getWalletCount()).toBeGreaterThanOrEqual(EXPECTED_MIN);
        }),
        { numRuns: 25 }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Invariant: 10 ≤ wallet count ≤ 50 for any operation sequence
  // ─────────────────────────────────────────────────────────────────────────

  describe('Invariant: 10 ≤ wallet count ≤ 50', () => {
    /**
     * **Validates: Requirements 1.1**
     *
     * For ANY sequence of add/remove operations, the count MUST remain
     * within bounds [10, 50].
     */
    it('maintains bounds for arbitrary operation sequences (property)', () => {
      // Start with mid-range count
      const initial = 25;
      const addedSet = new Set(seed(curator, initial));
      let nextIdx = initial;

      fc.assert(
        fc.property(genOperationSeq, (ops) => {
          for (const op of ops) {
            if (op.kind === 'add') {
              const addr = genAddress(nextIdx + op.idx);
              if (!addedSet.has(addr)) {
                const res = curator.addWalletWithMetrics(addr, genValidMetrics(), genValidExclusionMetrics());
                if (res) {
                  addedSet.add(addr);
                  nextIdx++;
                }
              }
            } else {
              const arr = Array.from(addedSet);
              if (arr.length > 0) {
                const idx = op.idx % arr.length;
                const toRemove = arr[idx];
                if (curator.removeWallet(toRemove)) {
                  addedSet.delete(toRemove);
                }
              }
            }

            // INVARIANT CHECK after every operation
            const count = curator.getWalletCount();
            expect(count).toBeGreaterThanOrEqual(EXPECTED_MIN);
            expect(count).toBeLessThanOrEqual(EXPECTED_MAX);
          }
        }),
        { numRuns: 40 }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // canAddWallet / canRemoveWallet consistency
  // ─────────────────────────────────────────────────────────────────────────

  describe('Helper method consistency', () => {
    it('canAddWallet returns false at maximum', () => {
      seed(curator, MAX_WALLET_COUNT);
      expect(curator.canAddWallet()).toBe(false);
    });

    it('canRemoveWallet returns false at minimum', () => {
      seed(curator, MIN_WALLET_COUNT);
      expect(curator.canRemoveWallet()).toBe(false);
    });

    /**
     * Property: canAddWallet/canRemoveWallet are consistent with current count.
     */
    it('helpers are consistent with count (property)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: EXPECTED_MIN, max: EXPECTED_MAX }),
          (targetCount) => {
            const testCurator = new SmartMoneyCurator();
            seed(testCurator, targetCount);
            const count = testCurator.getWalletCount();

            expect(testCurator.canAddWallet()).toBe(count < EXPECTED_MAX);
            expect(testCurator.canRemoveWallet()).toBe(count > EXPECTED_MIN);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Successful operation effects
  // ─────────────────────────────────────────────────────────────────────────

  describe('Successful operation effects', () => {
    /**
     * Successful addWallet increments count by 1.
     */
    it('successful add increments count by 1 (property)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: EXPECTED_MIN, max: EXPECTED_MAX - 1 }),
          (startCount) => {
            const testCurator = new SmartMoneyCurator();
            seed(testCurator, startCount);

            const before = testCurator.getWalletCount();
            const addr = genAddress(startCount + 5000);
            const res = testCurator.addWalletWithMetrics(addr, genValidMetrics(), genValidExclusionMetrics());

            if (res !== null) {
              expect(testCurator.getWalletCount()).toBe(before + 1);
            }
          }
        ),
        { numRuns: 20 }
      );
    });

    /**
     * Successful removeWallet decrements count by 1.
     */
    it('successful remove decrements count by 1 (property)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: EXPECTED_MIN + 1, max: EXPECTED_MAX }),
          (startCount) => {
            const testCurator = new SmartMoneyCurator();
            const added = seed(testCurator, startCount);

            const before = testCurator.getWalletCount();
            const res = testCurator.removeWallet(added[0]);

            if (res) {
              expect(testCurator.getWalletCount()).toBe(before - 1);
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // getWallets length consistency
  // ─────────────────────────────────────────────────────────────────────────

  describe('getWallets length consistency', () => {
    /**
     * getWallets().length MUST equal getWalletCount().
     */
    it('getWallets length equals getWalletCount (property)', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: EXPECTED_MIN, max: EXPECTED_MAX }),
          (count) => {
            const testCurator = new SmartMoneyCurator();
            seed(testCurator, count);
            expect(testCurator.getWallets().length).toBe(testCurator.getWalletCount());
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Boundary value tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Boundary values', () => {
    it('removal succeeds at 11, fails at 10', () => {
      const curator11 = new SmartMoneyCurator();
      const addrs = seed(curator11, 11);
      expect(curator11.getWalletCount()).toBe(11);

      // At 11: removal succeeds
      expect(curator11.removeWallet(addrs[0])).toBe(true);
      expect(curator11.getWalletCount()).toBe(10);

      // At 10: removal fails
      expect(curator11.removeWallet(addrs[1])).toBe(false);
      expect(curator11.getWalletCount()).toBe(10);
    });

    it('addition succeeds at 49, fails at 50', () => {
      const curator49 = new SmartMoneyCurator();
      seed(curator49, 49);
      expect(curator49.getWalletCount()).toBe(49);

      // At 49: addition succeeds
      const addr50 = genAddress(8000);
      expect(curator49.addWalletWithMetrics(addr50, genValidMetrics(), genValidExclusionMetrics())).not.toBeNull();
      expect(curator49.getWalletCount()).toBe(50);

      // At 50: addition fails
      const addr51 = genAddress(8001);
      expect(curator49.addWalletWithMetrics(addr51, genValidMetrics(), genValidExclusionMetrics())).toBeNull();
      expect(curator49.getWalletCount()).toBe(50);
    });
  });
});

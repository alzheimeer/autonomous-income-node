/**
 * Property-based tests for ReconciliationEngine
 *
 * **Property 17: Reconciliation threshold calculation**
 * threshold = max(1% of operation size, $0.05 USDC). For any operation size, this formula holds.
 *
 * **Property 18: Three consecutive deviations trigger Safe_Mode**
 * For any sequence of reconciliation results, if 3 consecutive have
 * deviation > threshold, Safe_Mode is triggered.
 *
 * **Validates: Requirements 13.5, 8.7, E6**
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { createDatabase, type TradingDatabase } from '../../db.js';
import { runMigrations } from '../../migrations.js';
import {
  ReconciliationEngine,
  type IReconciliationProvider,
  type IReconciliationSafeModeController,
  type IReconciliationLogger,
  type ExpectedState,
} from '../../reconciliation-engine.js';
import type { ReconciliationConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const WALLET_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const MIN_THRESHOLD_USDC = 50_000n; // $0.05 (6 decimals)

const DEFAULT_CONFIG: ReconciliationConfig = {
  confirmationBlocks: 0, // Skip confirmation wait in tests
  maxRetries: 1,
  retryBackoffMs: 10,
  mismatchesForKillSwitch: 3,
};

// ═══════════════════════════════════════════════════════════════════════════
// Mocks
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a mock provider that returns controlled balances.
 * actualUsdc and actualWeth are the "on-chain" values after reconciliation.
 */
function createMockProvider(
  actualUsdc: bigint,
  actualWeth: bigint,
): IReconciliationProvider {
  return {
    async getUsdcBalance() {
      return actualUsdc;
    },
    async getWethBalance() {
      return actualWeth;
    },
    async getAllowance() {
      return 0n;
    },
    async getBlockNumber() {
      return 99999;
    },
    async getTransactionBlockNumber() {
      return 99998;
    },
    async getWethUsdcPrice() {
      return 2500; // $2500 per WETH
    },
  };
}

function createMockLogger(): IReconciliationLogger {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

function createTrackingSafeModeController(): IReconciliationSafeModeController & {
  safeModeTriggered: boolean;
  killSwitchTriggered: boolean;
  triggerCount: number;
} {
  const tracker = {
    safeModeTriggered: false,
    killSwitchTriggered: false,
    triggerCount: 0,
    trigger(_reason: 'recon_mismatch', _details: string) {
      tracker.safeModeTriggered = true;
      tracker.triggerCount++;
    },
    triggerKillSwitch(_reason: string) {
      tracker.killSwitchTriggered = true;
    },
  };
  return tracker;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function setupDb(): TradingDatabase {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return db;
}

/**
 * Calculate expected threshold per the formula: max(1% of operation, $0.05)
 */
function expectedThreshold(operationSizeUsdc: bigint): bigint {
  const onePercent = operationSizeUsdc / 100n;
  return onePercent > MIN_THRESHOLD_USDC ? onePercent : MIN_THRESHOLD_USDC;
}

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate operation sizes in USDC (6 decimals).
 * Range: $0.01 to $1000 (10_000n to 1_000_000_000n)
 */
const operationSizeArb = fc.bigInt(10_000n, 1_000_000_000n);

/**
 * Generate USDC balances (6 decimals).
 * Range: $0 to $10000
 */
const usdcBalanceArb = fc.bigInt(0n, 10_000_000_000n);

/**
 * Generate small deviations below threshold.
 * Used to create "matching" reconciliation results.
 */
const smallDeviationArb = fc.bigInt(0n, MIN_THRESHOLD_USDC - 1n);

// ═══════════════════════════════════════════════════════════════════════════
// Property 17: Reconciliation threshold calculation
// ═══════════════════════════════════════════════════════════════════════════

describe('ReconciliationEngine Property Tests', () => {
  describe('Property 17: Reconciliation threshold calculation', () => {
    /**
     * **Validates: Requirements 13.5**
     *
     * For ANY operation size, the threshold = max(1% of operation, $0.05 USDC).
     * When actual balances match expected exactly, reconciliation passes.
     */
    it('exact match always passes regardless of operation size', async () => {
      await fc.assert(
        fc.asyncProperty(
          operationSizeArb,
          usdcBalanceArb,
          async (operationSize, balance) => {
            const db = setupDb();
            const provider = createMockProvider(balance, 0n);
            const safeMode = createTrackingSafeModeController();
            const logger = createMockLogger();

            const engine = new ReconciliationEngine(
              db,
              DEFAULT_CONFIG,
              provider,
              safeMode,
              logger,
              WALLET_ADDRESS,
            );

            const expected: ExpectedState = {
              expectedUsdc: balance,
              expectedWeth: 0n,
              txHash: '0x' + 'aa'.repeat(32),
              operationSizeUsdc: operationSize,
              gasEthSpent: 0n,
            };

            const result = await engine.reconcile(expected, 'entry');
            expect(result.matched).toBe(true);
            expect(result.deviationUsdc).toBe(0n);

            db.close();
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 13.5**
     *
     * For ANY operation size, a deviation strictly above the threshold
     * max(1% of operation, $0.05) causes a mismatch.
     */
    it('deviation above threshold causes mismatch', async () => {
      await fc.assert(
        fc.asyncProperty(
          operationSizeArb,
          usdcBalanceArb,
          async (operationSize, expectedBalance) => {
            const threshold = expectedThreshold(operationSize);
            // Actual balance deviates by threshold + 1 (just over)
            const actualBalance = expectedBalance + threshold + 1n;

            const db = setupDb();
            const provider = createMockProvider(actualBalance, 0n);
            const safeMode = createTrackingSafeModeController();
            const logger = createMockLogger();

            const engine = new ReconciliationEngine(
              db,
              DEFAULT_CONFIG,
              provider,
              safeMode,
              logger,
              WALLET_ADDRESS,
            );

            const expected: ExpectedState = {
              expectedUsdc: expectedBalance,
              expectedWeth: 0n,
              txHash: '0x' + 'bb'.repeat(32),
              operationSizeUsdc: operationSize,
              gasEthSpent: 0n,
            };

            const result = await engine.reconcile(expected, 'entry');
            expect(result.matched).toBe(false);
            expect(safeMode.safeModeTriggered).toBe(true);

            db.close();
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 13.5**
     *
     * For ANY operation size, a deviation at or below threshold passes.
     * Threshold = max(1% of operation, $0.05).
     */
    it('deviation at threshold boundary passes', async () => {
      await fc.assert(
        fc.asyncProperty(
          operationSizeArb,
          usdcBalanceArb,
          async (operationSize, expectedBalance) => {
            const threshold = expectedThreshold(operationSize);
            // Actual balance deviates by exactly the threshold
            const actualBalance = expectedBalance + threshold;

            const db = setupDb();
            const provider = createMockProvider(actualBalance, 0n);
            const safeMode = createTrackingSafeModeController();
            const logger = createMockLogger();

            const engine = new ReconciliationEngine(
              db,
              DEFAULT_CONFIG,
              provider,
              safeMode,
              logger,
              WALLET_ADDRESS,
            );

            const expected: ExpectedState = {
              expectedUsdc: expectedBalance,
              expectedWeth: 0n,
              txHash: '0x' + 'cc'.repeat(32),
              operationSizeUsdc: operationSize,
              gasEthSpent: 0n,
            };

            const result = await engine.reconcile(expected, 'entry');
            expect(result.matched).toBe(true);

            db.close();
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 13.5**
     *
     * Verify the threshold formula itself:
     * For small operations (< $5), threshold = $0.05
     * For large operations (>= $5), threshold = 1% of operation
     */
    it('threshold formula: max(1% of operation, $0.05)', () => {
      fc.assert(
        fc.property(
          operationSizeArb,
          (operationSize) => {
            const threshold = expectedThreshold(operationSize);
            const onePercent = operationSize / 100n;

            if (onePercent > MIN_THRESHOLD_USDC) {
              expect(threshold).toBe(onePercent);
            } else {
              expect(threshold).toBe(MIN_THRESHOLD_USDC);
            }
            // Threshold is always >= $0.05
            expect(threshold >= MIN_THRESHOLD_USDC).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Property 18: Three consecutive deviations trigger Safe_Mode
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Property 18: Three consecutive deviations trigger Safe_Mode', () => {
    /**
     * **Validates: Requirements 8.7, E6**
     *
     * For ANY sequence where 3 consecutive reconciliations have
     * deviation > threshold, KillSwitch is triggered (escalation from Safe_Mode).
     */
    it('3 consecutive mismatches in 24h trigger KillSwitch', async () => {
      await fc.assert(
        fc.asyncProperty(
          operationSizeArb,
          usdcBalanceArb,
          async (operationSize, expectedBalance) => {
            const threshold = expectedThreshold(operationSize);
            // Create deviation that exceeds threshold
            const deviationOverThreshold = threshold + 10_000n;
            const actualBalance = expectedBalance + deviationOverThreshold;

            const db = setupDb();
            const provider = createMockProvider(actualBalance, 0n);
            const safeMode = createTrackingSafeModeController();
            const logger = createMockLogger();

            const engine = new ReconciliationEngine(
              db,
              DEFAULT_CONFIG,
              provider,
              safeMode,
              logger,
              WALLET_ADDRESS,
            );

            // Submit 3 consecutive mismatches
            for (let i = 0; i < 3; i++) {
              const expected: ExpectedState = {
                expectedUsdc: expectedBalance,
                expectedWeth: 0n,
                txHash: '0x' + `${i}`.padStart(2, '0').repeat(32),
                operationSizeUsdc: operationSize,
                gasEthSpent: 0n,
              };

              const result = await engine.reconcile(expected, 'entry');
              expect(result.matched).toBe(false);
            }

            // After 3 mismatches, KillSwitch should be triggered
            expect(safeMode.killSwitchTriggered).toBe(true);
            expect(safeMode.triggerCount).toBe(3);

            db.close();
          },
        ),
        { numRuns: 50 },
      );
    });

    /**
     * **Validates: Requirements 8.7, E6**
     *
     * Fewer than 3 mismatches in 24h does NOT trigger KillSwitch.
     * Safe_Mode is triggered per-mismatch, but KillSwitch requires 3.
     */
    it('fewer than 3 mismatches does not trigger KillSwitch', async () => {
      await fc.assert(
        fc.asyncProperty(
          operationSizeArb,
          usdcBalanceArb,
          fc.integer({ min: 1, max: 2 }),
          async (operationSize, expectedBalance, mismatchCount) => {
            const threshold = expectedThreshold(operationSize);
            const actualBalance = expectedBalance + threshold + 10_000n;

            const db = setupDb();
            const provider = createMockProvider(actualBalance, 0n);
            const safeMode = createTrackingSafeModeController();
            const logger = createMockLogger();

            const engine = new ReconciliationEngine(
              db,
              DEFAULT_CONFIG,
              provider,
              safeMode,
              logger,
              WALLET_ADDRESS,
            );

            for (let i = 0; i < mismatchCount; i++) {
              const expected: ExpectedState = {
                expectedUsdc: expectedBalance,
                expectedWeth: 0n,
                txHash: '0x' + `${i}`.padStart(2, '0').repeat(32),
                operationSizeUsdc: operationSize,
                gasEthSpent: 0n,
              };

              await engine.reconcile(expected, 'entry');
            }

            // Safe_Mode triggered for each mismatch
            expect(safeMode.triggerCount).toBe(mismatchCount);
            // But KillSwitch NOT triggered (fewer than 3)
            expect(safeMode.killSwitchTriggered).toBe(false);

            db.close();
          },
        ),
        { numRuns: 50 },
      );
    });

    /**
     * **Validates: Requirements 13.5, 8.7**
     *
     * A passing reconciliation interleaved with mismatches does not
     * affect the total mismatch count for KillSwitch (it's 3 in 24h total,
     * not necessarily consecutive).
     */
    it('interleaved pass does not reset mismatch counter (cumulative in 24h)', async () => {
      await fc.assert(
        fc.asyncProperty(
          operationSizeArb,
          usdcBalanceArb,
          async (operationSize, expectedBalance) => {
            const threshold = expectedThreshold(operationSize);

            const db = setupDb();
            const safeMode = createTrackingSafeModeController();
            const logger = createMockLogger();

            // 2 mismatches, then 1 pass, then 1 mismatch = 3 total mismatches
            const sequences: Array<{ actual: bigint; expectMatch: boolean }> = [
              { actual: expectedBalance + threshold + 10_000n, expectMatch: false },
              { actual: expectedBalance + threshold + 10_000n, expectMatch: false },
              { actual: expectedBalance, expectMatch: true }, // exact match
              { actual: expectedBalance + threshold + 10_000n, expectMatch: false },
            ];

            for (let i = 0; i < sequences.length; i++) {
              const seq = sequences[i]!;
              const provider = createMockProvider(seq.actual, 0n);

              const engine = new ReconciliationEngine(
                db,
                DEFAULT_CONFIG,
                provider,
                safeMode,
                logger,
                WALLET_ADDRESS,
              );

              const expected: ExpectedState = {
                expectedUsdc: expectedBalance,
                expectedWeth: 0n,
                txHash: '0x' + `${i + 10}`.repeat(32).slice(0, 64),
                operationSizeUsdc: operationSize,
                gasEthSpent: 0n,
              };

              const result = await engine.reconcile(expected, 'entry');
              expect(result.matched).toBe(seq.expectMatch);
            }

            // 3 total mismatches → KillSwitch
            expect(safeMode.killSwitchTriggered).toBe(true);

            db.close();
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

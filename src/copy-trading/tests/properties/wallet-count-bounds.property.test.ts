/**
 * SmartMoneyCurator — Property-Based Tests for Wallet Count Bounds
 *
 * **Property 3: Wallet Count Bounds Invariant**
 * For any sequence of wallet additions and removals, the count of monitored
 * wallets SHALL always satisfy: 10 ≤ count ≤ 50
 *
 * - addWallet fails if count would exceed 50
 * - removeWallet fails if count would go below minimum
 *
 * **Validates: Requirements 1.1**
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

/** Minimum wallet count bound: 10 (Req 1.1) */
const EXPECTED_MIN_WALLET_COUNT = 10;

/** Maximum wallet count bound: 50 (Req 1.1) */
const EXPECTED_MAX_WALLET_COUNT = 50;

// ═══════════════════════════════════════════════════════════════════════════
// GENERATORS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates a valid Ethereum address (checksummed format)
 * Uses a deterministic pattern based on index to ensure uniqueness
 */
const validAddress = (index: number): string => {
  const hexIndex = index.toString(16).padStart(40, '0');
  return `0x${hexIndex}`;
};

/**
 * Generates wallet metrics that meet all inclusion criteria
 */
const validWalletMetrics = (): FullWalletMetrics => ({
  winRate: 0.75 + Math.random() * 0.20,     // 75%-95%
  totalPnlUsdc: 60_000 + Math.random() * 100_000,  // $60k-$160k
  tradeCount: 150 + Math.floor(Math.random() * 500), // 150-650 trades
  avgHoldingTimeSec: 3600 + Math.floor(Math.random() * 86400), // 1h to 1 day
  volumeUsdc: 600_000 + Math.random() * 500_000, // $600k-$1.1M
  sharpeRatio: 1.5 + Math.random(),   // 1.5-2.5
  profitFactor: 1.8 + Math.random(),  // 1.8-2.8
  maxDrawdownPct: 0.10 + Math.random() * 0.10, // 10%-20%
  profitableWeeksPct: 0.60 + Math.random() * 0.30, // 60%-90%
});

/**
 * Generates wallet exclusion metrics that pass all filters (not excluded)
 */
const validExclusionMetrics = (): WalletExclusionMetrics => ({
  sameBlockTradePct: 0.10 + Math.random() * 0.30,  // 10%-40% (below 50% threshold)
  hasDeployedTokensRecently: false,
  honeypotExposurePct: 0.05 + Math.random() * 0.10, // 5%-15% (below 20% threshold)
  receivedDeployerAirdrop: false,
  sameCounterpartyPct: 0.10 + Math.random() * 0.15, // 10%-25% (below 30% threshold)
});

/**
 * Generates a random operation: add wallet or remove wallet
 */
type WalletOperation = 
  | { type: 'add'; addressIndex: number }
  | { type: 'remove'; addressIndex: number };

const walletOperation = fc.oneof(
  fc.integer({ min: 0, max: 999 }).map((idx): WalletOperation => ({ type: 'add', addressIndex: idx })),
  fc.integer({ min: 0, max: 999 }).map((idx): WalletOperation => ({ type: 'remove', addressIndex: idx }))
);

/**
 * Generates a sequence of wallet operations for testing state machine behavior
 */
const operationSequence = fc.array(walletOperation, { minLength: 1, maxLength: 100 });

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Seeds a curator with a specified number of valid wallets
 * @param curator - The SmartMoneyCurator instance
 * @param count - Number of wallets to add
 * @returns Array of added wallet addresses
 */
function seedWallets(curator: SmartMoneyCurator, count: number): string[] {
  const addedAddresses: string[] = [];
  
  for (let i = 0; i < count; i++) {
    const address = validAddress(i);
    const metrics = validWalletMetrics();
    const exclusionMetrics = validExclusionMetrics();
    
    const result = curator.addWalletWithMetrics(address, metrics, exclusionMetrics);
    if (result !== null) {
      addedAddresses.push(address);
    }
  }
  
  return addedAddresses;
}

// ═══════════════════════════════════════════════════════════════════════════
// PROPERTY TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe('SmartMoneyCurator - Property 3: Wallet Count Bounds Invariant', () => {
  let curator: SmartMoneyCurator;

  beforeEach(() => {
    curator = new SmartMoneyCurator();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Constants Verification
  // ═══════════════════════════════════════════════════════════════════════

  describe('Constants Verification', () => {
    /**
     * Verifies that the exported constants match the expected bounds
     */
    it('exports correct bound constants', () => {
      expect(MIN_WALLET_COUNT).toBe(EXPECTED_MIN_WALLET_COUNT);
      expect(MAX_WALLET_COUNT).toBe(EXPECTED_MAX_WALLET_COUNT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.1: Maximum bound enforcement (addWallet fails at 50)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.1: Maximum bound enforcement', () => {
    /**
     * **Validates: Requirement 1.1**
     *
     * When the wallet count reaches 50, any subsequent addWallet call
     * SHALL return null (failure) and the count SHALL remain at 50.
     */
    it('rejects addWallet when count would exceed 50', () => {
      // Seed curator with exactly MAX_WALLET_COUNT wallets
      const addedAddresses = seedWallets(curator, MAX_WALLET_COUNT);
      
      expect(curator.getWalletCount()).toBe(MAX_WALLET_COUNT);
      expect(addedAddresses.length).toBe(MAX_WALLET_COUNT);

      // Attempt to add one more wallet
      const extraAddress = validAddress(9999);
      const extraMetrics = validWalletMetrics();
      const extraExclusionMetrics = validExclusionMetrics();

      const result = curator.addWalletWithMetrics(extraAddress, extraMetrics, extraExclusionMetrics);

      // Property: addWallet MUST fail when count is at maximum
      expect(result).toBeNull();
      expect(curator.getWalletCount()).toBe(MAX_WALLET_COUNT);
      expect(curator.isMonitored(extraAddress)).toBe(false);
    });

    /**
     * Property test: For any number of add attempts beyond 50, 
     * count never exceeds 50
     */
    it('never exceeds maximum bound regardless of add attempts', () => {
      // Seed to maximum
      seedWallets(curator, MAX_WALLET_COUNT);

      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 50 }), // Number of extra add attempts
          (extraAttempts) => {
            const startCount = curator.getWalletCount();
            
            // Try to add more wallets
            for (let i = 0; i < extraAttempts; i++) {
              const address = validAddress(MAX_WALLET_COUNT + i + 1000);
              const metrics = validWalletMetrics();
              const exclusionMetrics = validExclusionMetrics();
              curator.addWalletWithMetrics(address, metrics, exclusionMetrics);
            }

            // Property: Count MUST never exceed MAX_WALLET_COUNT
            expect(curator.getWalletCount()).toBeLessThanOrEqual(MAX_WALLET_COUNT);
            expect(curator.getWalletCount()).toBe(startCount); // Should remain unchanged
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.2: Minimum bound enforcement (removeWallet fails at 10)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.2: Minimum bound enforcement', () => {
    /**
     * **Validates: Requirement 1.1**
     *
     * When the wallet count is at 10, any removeWallet call
     * SHALL return false (failure) and the count SHALL remain at 10.
     */
    it('rejects removeWallet when count would go below 10', () => {
      // Seed curator with exactly MIN_WALLET_COUNT wallets
      const addedAddresses = seedWallets(curator, MIN_WALLET_COUNT);
      
      expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT);
      expect(addedAddresses.length).toBe(MIN_WALLET_COUNT);

      // Attempt to remove a wallet
      const addressToRemove = addedAddresses[0];
      const result = curator.removeWallet(addressToRemove);

      // Property: removeWallet MUST fail when count is at minimum
      expect(result).toBe(false);
      expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT);
      expect(curator.isMonitored(addressToRemove)).toBe(true);
    });

    /**
     * Property test: For any number of remove attempts at minimum count, 
     * count never goes below 10
     */
    it('never goes below minimum bound regardless of remove attempts', () => {
      // Seed to minimum
      const addedAddresses = seedWallets(curator, MIN_WALLET_COUNT);

      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: MIN_WALLET_COUNT }), // Number of remove attempts
          (removeAttempts) => {
            const startCount = curator.getWalletCount();
            
            // Try to remove wallets
            for (let i = 0; i < removeAttempts; i++) {
              const idx = i % addedAddresses.length;
              curator.removeWallet(addedAddresses[idx]);
            }

            // Property: Count MUST never go below MIN_WALLET_COUNT
            expect(curator.getWalletCount()).toBeGreaterThanOrEqual(MIN_WALLET_COUNT);
            expect(curator.getWalletCount()).toBe(startCount); // Should remain unchanged
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.3: Bounds maintained through arbitrary operation sequences
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.3: Bounds maintained through arbitrary sequences', () => {
    /**
     * **Validates: Requirement 1.1**
     *
     * For ANY sequence of add/remove operations, the wallet count
     * SHALL always satisfy: 10 ≤ count ≤ 50
     */
    it('maintains bounds invariant for any operation sequence', () => {
      // Start with a mid-range count to allow both adds and removes
      const initialCount = 25;
      const addedAddresses = seedWallets(curator, initialCount);
      const addressSet = new Set(addedAddresses);
      let nextAddIndex = initialCount;

      fc.assert(
        fc.property(operationSequence, (operations) => {
          // Execute each operation
          for (const op of operations) {
            if (op.type === 'add') {
              const address = validAddress(nextAddIndex + op.addressIndex);
              if (!addressSet.has(address)) {
                const metrics = validWalletMetrics();
                const exclusionMetrics = validExclusionMetrics();
                const result = curator.addWalletWithMetrics(address, metrics, exclusionMetrics);
                if (result !== null) {
                  addressSet.add(address);
                  nextAddIndex++;
                }
              }
            } else {
              // Remove operation
              const addressesToRemove = Array.from(addressSet);
              if (addressesToRemove.length > 0) {
                const idx = op.addressIndex % addressesToRemove.length;
                const addressToRemove = addressesToRemove[idx];
                const result = curator.removeWallet(addressToRemove);
                if (result) {
                  addressSet.delete(addressToRemove);
                }
              }
            }

            // INVARIANT CHECK: After every operation, count MUST be within bounds
            const currentCount = curator.getWalletCount();
            expect(currentCount).toBeGreaterThanOrEqual(MIN_WALLET_COUNT);
            expect(currentCount).toBeLessThanOrEqual(MAX_WALLET_COUNT);
          }

          // Final check
          const finalCount = curator.getWalletCount();
          expect(finalCount).toBeGreaterThanOrEqual(MIN_WALLET_COUNT);
          expect(finalCount).toBeLessThanOrEqual(MAX_WALLET_COUNT);
        }),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.4: Helper methods consistency
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.4: Helper methods consistency', () => {
    /**
     * canAddWallet() MUST return false when count >= MAX_WALLET_COUNT
     * canRemoveWallet() MUST return false when count <= MIN_WALLET_COUNT
     */
    it('canAddWallet returns false at maximum', () => {
      seedWallets(curator, MAX_WALLET_COUNT);
      
      expect(curator.canAddWallet()).toBe(false);
      expect(curator.getWalletCount()).toBe(MAX_WALLET_COUNT);
    });

    it('canRemoveWallet returns false at minimum', () => {
      seedWallets(curator, MIN_WALLET_COUNT);
      
      expect(curator.canRemoveWallet()).toBe(false);
      expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT);
    });

    /**
     * Property test: canAddWallet/canRemoveWallet are consistent with bounds
     */
    it('helper methods are consistent with current count', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: MIN_WALLET_COUNT, max: MAX_WALLET_COUNT }),
          (targetCount) => {
            // Fresh curator for each test
            const testCurator = new SmartMoneyCurator();
            seedWallets(testCurator, targetCount);

            const count = testCurator.getWalletCount();
            
            // canAddWallet should be true only if count < MAX
            expect(testCurator.canAddWallet()).toBe(count < MAX_WALLET_COUNT);
            
            // canRemoveWallet should be true only if count > MIN
            expect(testCurator.canRemoveWallet()).toBe(count > MIN_WALLET_COUNT);
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.5: Successful operations change count correctly
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.5: Successful operations change count correctly', () => {
    /**
     * Successful addWallet increments count by exactly 1
     */
    it('successful addWallet increments count by 1', () => {
      // Start below maximum to allow additions
      const initialCount = 30;
      seedWallets(curator, initialCount);

      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: MAX_WALLET_COUNT - initialCount }),
          (addCount) => {
            const testCurator = new SmartMoneyCurator();
            seedWallets(testCurator, initialCount);
            
            for (let i = 0; i < addCount; i++) {
              const beforeCount = testCurator.getWalletCount();
              
              if (testCurator.canAddWallet()) {
                const address = validAddress(initialCount + i + 5000);
                const metrics = validWalletMetrics();
                const exclusionMetrics = validExclusionMetrics();
                
                const result = testCurator.addWalletWithMetrics(address, metrics, exclusionMetrics);
                
                if (result !== null) {
                  // Successful add MUST increment count by exactly 1
                  expect(testCurator.getWalletCount()).toBe(beforeCount + 1);
                }
              }
            }
          }
        ),
        { numRuns: 20 }
      );
    });

    /**
     * Successful removeWallet decrements count by exactly 1
     */
    it('successful removeWallet decrements count by 1', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: MIN_WALLET_COUNT + 1, max: MAX_WALLET_COUNT }),
          (initialCount) => {
            const testCurator = new SmartMoneyCurator();
            const addedAddresses = seedWallets(testCurator, initialCount);
            
            // Remove one wallet
            const beforeCount = testCurator.getWalletCount();
            const addressToRemove = addedAddresses[0];
            
            if (testCurator.canRemoveWallet()) {
              const result = testCurator.removeWallet(addressToRemove);
              
              if (result) {
                // Successful remove MUST decrement count by exactly 1
                expect(testCurator.getWalletCount()).toBe(beforeCount - 1);
              }
            }
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.6: getWallets length consistency
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.6: getWallets length consistency', () => {
    /**
     * getWallets().length MUST equal getWalletCount()
     */
    it('getWallets length matches getWalletCount', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: MIN_WALLET_COUNT, max: MAX_WALLET_COUNT }),
          (targetCount) => {
            const testCurator = new SmartMoneyCurator();
            seedWallets(testCurator, targetCount);
            
            // Property: getWallets().length MUST equal getWalletCount()
            expect(testCurator.getWallets().length).toBe(testCurator.getWalletCount());
          }
        ),
        { numRuns: 20 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.7: Boundary value tests
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.7: Boundary value tests', () => {
    /**
     * At count = 10, removal fails; at count = 11, removal succeeds
     */
    it('removal succeeds at 11, fails at 10', () => {
      // Test at count = 11
      const curator11 = new SmartMoneyCurator();
      const addresses11 = seedWallets(curator11, 11);
      expect(curator11.getWalletCount()).toBe(11);
      
      const removeResult11 = curator11.removeWallet(addresses11[0]);
      expect(removeResult11).toBe(true);
      expect(curator11.getWalletCount()).toBe(10);

      // Now at count = 10, removal should fail
      const removeResult10 = curator11.removeWallet(addresses11[1]);
      expect(removeResult10).toBe(false);
      expect(curator11.getWalletCount()).toBe(10);
    });

    /**
     * At count = 50, addition fails; at count = 49, addition succeeds
     */
    it('addition succeeds at 49, fails at 50', () => {
      // Test at count = 49
      const curator49 = new SmartMoneyCurator();
      seedWallets(curator49, 49);
      expect(curator49.getWalletCount()).toBe(49);

      // Addition should succeed
      const address50 = validAddress(9000);
      const result49 = curator49.addWalletWithMetrics(
        address50,
        validWalletMetrics(),
        validExclusionMetrics()
      );
      expect(result49).not.toBeNull();
      expect(curator49.getWalletCount()).toBe(50);

      // Now at count = 50, addition should fail
      const address51 = validAddress(9001);
      const result50 = curator49.addWalletWithMetrics(
        address51,
        validWalletMetrics(),
        validExclusionMetrics()
      );
      expect(result50).toBeNull();
      expect(curator49.getWalletCount()).toBe(50);
    });
  });
});

/**
 * Property-based tests for GasReserveManager
 *
 * **Property 16: Gas reserve entry blocking**
 * - canEnterTrade() returns false for any ETH balance < 0.005 ETH (5000000000000000 wei)
 * - isCritical() returns true for any balance < 0.002 ETH (2000000000000000 wei)
 *
 * **Validates: Requirements 21.2, 21.3**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  GasReserveManager,
  type IEthBalanceProvider,
} from '../../gas-reserve-manager.js';
import type { GasReserveConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const MIN_RESERVE_ETH = 5_000_000_000_000_000n;      // 0.005 ETH
const CRITICAL_RESERVE_ETH = 2_000_000_000_000_000n;  // 0.002 ETH

const DEFAULT_CONFIG: GasReserveConfig = {
  minReserveEth: MIN_RESERVE_ETH,
  criticalReserveEth: CRITICAL_RESERVE_ETH,
  cyclesRequired: 2,
};

const WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createProvider(balance: bigint): IEthBalanceProvider {
  return { getBalance: async () => balance };
}

async function createManagerWithBalance(balance: bigint): Promise<GasReserveManager> {
  const manager = new GasReserveManager(
    DEFAULT_CONFIG,
    createProvider(balance),
    WALLET_ADDRESS,
  );
  await manager.getEthBalance(); // Cache the balance
  return manager;
}

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate ETH balances strictly below minReserveEth (0.005 ETH).
 * Range: [0, 4_999_999_999_999_999] wei
 */
const belowMinReserveBalance = fc.bigInt(0n, MIN_RESERVE_ETH - 1n);

/**
 * Generate ETH balances at or above minReserveEth (0.005 ETH).
 * Range: [5_000_000_000_000_000, 1 ETH] - reasonable upper bound
 */
const atOrAboveMinReserveBalance = fc.bigInt(MIN_RESERVE_ETH, 1_000_000_000_000_000_000n);

/**
 * Generate ETH balances strictly below criticalReserveEth (0.002 ETH).
 * Range: [0, 1_999_999_999_999_999] wei
 */
const belowCriticalBalance = fc.bigInt(0n, CRITICAL_RESERVE_ETH - 1n);

/**
 * Generate ETH balances at or above criticalReserveEth (0.002 ETH).
 * Range: [2_000_000_000_000_000, 1 ETH]
 */
const atOrAboveCriticalBalance = fc.bigInt(CRITICAL_RESERVE_ETH, 1_000_000_000_000_000_000n);

/**
 * Generate reasonable gas estimates (0 to balance, kept small for realism).
 * Range: [0, 0.001 ETH] — typical trade gas costs on Base
 */
const reasonableGasEstimate = fc.bigInt(0n, 1_000_000_000_000_000n);

// ═══════════════════════════════════════════════════════════════════════════
// Property 16: Gas reserve entry blocking
// ═══════════════════════════════════════════════════════════════════════════

describe('GasReserveManager Property Tests', () => {
  describe('Property 16: Gas reserve entry blocking', () => {
    /**
     * **Validates: Requirements 21.2, 21.3**
     *
     * For ANY ETH balance < 0.005 ETH (5000000000000000 wei),
     * canEnterTrade() MUST return false regardless of gas estimate.
     */
    it('canEnterTrade() returns false for any balance below 0.005 ETH', async () => {
      await fc.assert(
        fc.asyncProperty(
          belowMinReserveBalance,
          reasonableGasEstimate,
          async (balance, gasEstimate) => {
            const manager = await createManagerWithBalance(balance);
            const canEnter = manager.canEnterTrade(gasEstimate);
            expect(canEnter).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 21.2**
     *
     * For ANY ETH balance >= 0.005 ETH AND gas estimate <= balance,
     * canEnterTrade() MUST return true.
     */
    it('canEnterTrade() returns true for balance >= 0.005 ETH when gas fits', async () => {
      await fc.assert(
        fc.asyncProperty(
          atOrAboveMinReserveBalance,
          async (balance) => {
            // Gas estimate that fits within the balance
            const gasEstimate = balance / 2n; // Always <= balance
            const manager = await createManagerWithBalance(balance);
            const canEnter = manager.canEnterTrade(gasEstimate);
            expect(canEnter).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 21.3**
     *
     * For ANY ETH balance < 0.002 ETH (2000000000000000 wei),
     * isCritical() MUST return true.
     */
    it('isCritical() returns true for any balance below 0.002 ETH', async () => {
      await fc.assert(
        fc.asyncProperty(
          belowCriticalBalance,
          async (balance) => {
            const manager = await createManagerWithBalance(balance);
            expect(manager.isCritical()).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 21.3**
     *
     * For ANY ETH balance >= 0.002 ETH,
     * isCritical() MUST return false.
     */
    it('isCritical() returns false for any balance >= 0.002 ETH', async () => {
      await fc.assert(
        fc.asyncProperty(
          atOrAboveCriticalBalance,
          async (balance) => {
            const manager = await createManagerWithBalance(balance);
            expect(manager.isCritical()).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 21.2, 21.3**
     *
     * Relationship property: any balance that is critical (< 0.002 ETH)
     * must also block trade entry (< 0.005 ETH), since critical < min reserve.
     */
    it('critical balance always implies trade entry is blocked', async () => {
      await fc.assert(
        fc.asyncProperty(
          belowCriticalBalance,
          reasonableGasEstimate,
          async (balance, gasEstimate) => {
            const manager = await createManagerWithBalance(balance);
            // If critical, then canEnterTrade must be false
            if (manager.isCritical()) {
              expect(manager.canEnterTrade(gasEstimate)).toBe(false);
            }
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

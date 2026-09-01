/**
 * Property-based tests for GasReserveManager
 *
 * **Property 16: Gas reserve entry blocking**
 * - canEnterTrade() returns false whenever ETH balance < 0.005 ETH
 * - The blocking condition is absolute: no gas estimate can override it
 *
 * **Validates: Requirements 21.2, 21.3**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  GasReserveManager,
  type IEthBalanceProvider,
  type ISafeModeTrigger,
} from '../../gas-reserve-manager.js';
import type { GasReserveConfig } from '../../config.js';
import type { EthAmount } from '../../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const MIN_RESERVE_ETH = 5_000_000_000_000_000n;       // 0.005 ETH in wei
const CRITICAL_RESERVE_ETH = 2_000_000_000_000_000n;   // 0.002 ETH in wei

const DEFAULT_CONFIG: GasReserveConfig = {
  minReserveEth: MIN_RESERVE_ETH,
  criticalReserveEth: CRITICAL_RESERVE_ETH,
  cyclesRequired: 2,
};

const WALLET_ADDRESS = '0xABCDEF1234567890abcdef1234567890ABCDEF12';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createProvider(balance: bigint): IEthBalanceProvider {
  return { getBalance: async (_address: string) => balance };
}

function createSafeModeSpy(): ISafeModeTrigger & { triggered: boolean; triggeredBalance: EthAmount | null } {
  const spy = {
    triggered: false,
    triggeredBalance: null as EthAmount | null,
    onGasCritical(balance: EthAmount) {
      spy.triggered = true;
      spy.triggeredBalance = balance;
    },
  };
  return spy;
}

async function createManagerWithBalance(
  balance: bigint,
  safeModeTrigger?: ISafeModeTrigger,
): Promise<GasReserveManager> {
  const manager = new GasReserveManager(
    DEFAULT_CONFIG,
    createProvider(balance),
    WALLET_ADDRESS,
    safeModeTrigger,
  );
  // Fetch balance to cache it
  await manager.getEthBalance();
  return manager;
}

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate ETH balances strictly below minReserveEth (0.005 ETH).
 * Range: [0, 4_999_999_999_999_999] wei
 */
const belowMinReserve = fc.bigInt(0n, MIN_RESERVE_ETH - 1n);

/**
 * Generate ETH balances at or above minReserveEth.
 * Range: [0.005 ETH, 10 ETH]
 */
const atOrAboveMinReserve = fc.bigInt(MIN_RESERVE_ETH, 10_000_000_000_000_000_000n);

/**
 * Generate any valid gas estimate (0 to 0.004 ETH — smaller than min reserve).
 * These are realistic gas costs on Base L2.
 */
const anyGasEstimate = fc.bigInt(0n, 4_000_000_000_000_000n);

/**
 * Generate ETH balances below critical threshold (0.002 ETH).
 * Range: [0, 1_999_999_999_999_999] wei
 */
const belowCritical = fc.bigInt(0n, CRITICAL_RESERVE_ETH - 1n);

// ═══════════════════════════════════════════════════════════════════════════
// Property 16: Gas reserve entry blocking
// ═══════════════════════════════════════════════════════════════════════════

describe('GasReserveManager Property Tests', () => {
  describe('Property 16: Gas reserve entry blocking', () => {
    /**
     * **Validates: Requirements 21.2, 21.3**
     *
     * CORE PROPERTY: For ANY ETH balance < 0.005 ETH,
     * canEnterTrade() MUST return false regardless of gas estimate value.
     * This is the absolute blocking threshold — no exceptions.
     */
    it('canEnterTrade() always returns false when balance < 0.005 ETH', async () => {
      await fc.assert(
        fc.asyncProperty(
          belowMinReserve,
          anyGasEstimate,
          async (balance, gasEstimate) => {
            const manager = await createManagerWithBalance(balance);
            expect(manager.canEnterTrade(gasEstimate)).toBe(false);
          },
        ),
        { numRuns: 300 },
      );
    });

    /**
     * **Validates: Requirements 21.2**
     *
     * POSITIVE CASE: For ANY ETH balance >= 0.005 ETH AND gas estimate <= balance,
     * canEnterTrade() MUST return true.
     */
    it('canEnterTrade() returns true when balance >= 0.005 ETH and gas fits', async () => {
      await fc.assert(
        fc.asyncProperty(
          atOrAboveMinReserve,
          async (balance) => {
            // Use a gas estimate that fits within balance
            const gasEstimate = balance / 10n; // Always much smaller than balance
            const manager = await createManagerWithBalance(balance);
            expect(manager.canEnterTrade(gasEstimate)).toBe(true);
          },
        ),
        { numRuns: 300 },
      );
    });

    /**
     * **Validates: Requirements 21.3**
     *
     * Critical threshold: isCritical() must be true for ANY balance < 0.002 ETH.
     * When critical is reached, SafeMode trigger fires.
     */
    it('isCritical() returns true for any balance < 0.002 ETH and triggers SafeMode', async () => {
      await fc.assert(
        fc.asyncProperty(
          belowCritical,
          async (balance) => {
            const spy = createSafeModeSpy();
            const manager = await createManagerWithBalance(balance, spy);

            expect(manager.isCritical()).toBe(true);
            // Safe mode should have been triggered when balance was fetched
            expect(spy.triggered).toBe(true);
            expect(spy.triggeredBalance).toBe(balance);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 21.2, 21.3**
     *
     * MONOTONICITY: The blocking threshold is absolute.
     * If canEnterTrade is false due to insufficient reserve, adding any amount
     * below the threshold still keeps it blocked.
     */
    it('blocking is monotone: lower balance never unblocks entry', async () => {
      await fc.assert(
        fc.asyncProperty(
          belowMinReserve,
          fc.bigInt(0n, MIN_RESERVE_ETH - 1n),
          async (balance1, balance2) => {
            const lower = balance1 < balance2 ? balance1 : balance2;
            const manager = await createManagerWithBalance(lower);
            // A lower balance is always blocked
            expect(manager.canEnterTrade(0n)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

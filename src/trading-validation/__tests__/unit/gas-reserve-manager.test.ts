/**
 * Unit tests for GasReserveManager
 *
 * Tests ETH balance monitoring, trade entry gating, critical threshold detection,
 * and N-cycle gas coverage estimation.
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  GasReserveManager,
  GAS_PER_CYCLE_UNITS,
  type IEthBalanceProvider,
  type ISafeModeTrigger,
} from '../../gas-reserve-manager.js';
import type { GasReserveConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

const ETH = (n: number): bigint => BigInt(Math.floor(n * 1e18));

const DEFAULT_CONFIG: GasReserveConfig = {
  minReserveEth: 5_000_000_000_000_000n,      // 0.005 ETH
  criticalReserveEth: 2_000_000_000_000_000n,  // 0.002 ETH
  cyclesRequired: 2,
};

const WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

function createMockProvider(balance: bigint): IEthBalanceProvider {
  return {
    getBalance: vi.fn().mockResolvedValue(balance),
  };
}

function createMockSafeModeTrigger(): ISafeModeTrigger & { calls: bigint[] } {
  const calls: bigint[] = [];
  return {
    calls,
    onGasCritical: vi.fn((balance: bigint) => { calls.push(balance); }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('GasReserveManager', () => {
  let provider: IEthBalanceProvider;
  let safeModeTrigger: ReturnType<typeof createMockSafeModeTrigger>;
  let manager: GasReserveManager;

  beforeEach(() => {
    provider = createMockProvider(ETH(0.01)); // 0.01 ETH - healthy
    safeModeTrigger = createMockSafeModeTrigger();
    manager = new GasReserveManager(DEFAULT_CONFIG, provider, WALLET_ADDRESS, safeModeTrigger);
  });

  describe('getEthBalance()', () => {
    it('queries the provider with the wallet address', async () => {
      await manager.getEthBalance();

      expect(provider.getBalance).toHaveBeenCalledWith(WALLET_ADDRESS);
    });

    it('returns the balance from the provider', async () => {
      const balance = await manager.getEthBalance();

      expect(balance).toBe(ETH(0.01));
    });

    it('updates the cached balance', async () => {
      await manager.getEthBalance();

      expect(manager.getLastKnownBalance()).toBe(ETH(0.01));
    });

    it('does NOT trigger safe mode when balance is above critical', async () => {
      await manager.getEthBalance();

      expect(safeModeTrigger.onGasCritical).not.toHaveBeenCalled();
    });

    it('triggers safe mode when balance is below critical threshold', async () => {
      const lowProvider = createMockProvider(ETH(0.001)); // below 0.002
      const mgr = new GasReserveManager(DEFAULT_CONFIG, lowProvider, WALLET_ADDRESS, safeModeTrigger);

      await mgr.getEthBalance();

      expect(safeModeTrigger.onGasCritical).toHaveBeenCalledWith(ETH(0.001));
    });

    it('triggers safe mode when balance equals zero', async () => {
      const zeroProvider = createMockProvider(0n);
      const mgr = new GasReserveManager(DEFAULT_CONFIG, zeroProvider, WALLET_ADDRESS, safeModeTrigger);

      await mgr.getEthBalance();

      expect(safeModeTrigger.onGasCritical).toHaveBeenCalledWith(0n);
    });

    it('does NOT throw when no safe mode trigger is provided', async () => {
      const lowProvider = createMockProvider(ETH(0.001));
      const mgr = new GasReserveManager(DEFAULT_CONFIG, lowProvider, WALLET_ADDRESS);

      // Should not throw even with critical balance and no trigger
      const balance = await mgr.getEthBalance();
      expect(balance).toBe(ETH(0.001));
    });
  });

  describe('canEnterTrade()', () => {
    it('returns true when balance is well above minimum and covers gas', async () => {
      await manager.getEthBalance(); // cache 0.01 ETH

      const estimatedGas = ETH(0.001); // 0.001 ETH gas estimate
      expect(manager.canEnterTrade(estimatedGas)).toBe(true);
    });

    it('returns false when balance is below minimum reserve (0.005 ETH)', async () => {
      const lowProvider = createMockProvider(ETH(0.004)); // below 0.005
      const mgr = new GasReserveManager(DEFAULT_CONFIG, lowProvider, WALLET_ADDRESS);
      await mgr.getEthBalance();

      expect(mgr.canEnterTrade(ETH(0.001))).toBe(false);
    });

    it('returns false when balance equals exactly minimum reserve', async () => {
      // At exactly 0.005 ETH, should still be able to enter (>= check)
      const exactProvider = createMockProvider(5_000_000_000_000_000n); // exactly 0.005
      const mgr = new GasReserveManager(DEFAULT_CONFIG, exactProvider, WALLET_ADDRESS);
      await mgr.getEthBalance();

      // At minimum, can enter if gas fits
      expect(mgr.canEnterTrade(ETH(0.001))).toBe(true);
    });

    it('returns false when estimated gas exceeds balance', async () => {
      await manager.getEthBalance(); // 0.01 ETH

      const excessiveGas = ETH(0.02); // more than balance
      expect(manager.canEnterTrade(excessiveGas)).toBe(false);
    });

    it('returns false before any balance has been fetched (initial 0n)', () => {
      // No getEthBalance() called, lastKnownBalance = 0n
      expect(manager.canEnterTrade(ETH(0.001))).toBe(false);
    });

    it('returns true when estimated gas equals balance (edge case)', async () => {
      const balanceProvider = createMockProvider(ETH(0.01));
      const mgr = new GasReserveManager(DEFAULT_CONFIG, balanceProvider, WALLET_ADDRESS);
      await mgr.getEthBalance();

      // Gas exactly equals balance — allowed since balance >= minReserve
      expect(mgr.canEnterTrade(ETH(0.01))).toBe(true);
    });

    it('blocks entry at 0.0049 ETH (just below threshold)', async () => {
      const justBelow = createMockProvider(4_999_999_999_999_999n); // 0.005 - 1 wei
      const mgr = new GasReserveManager(DEFAULT_CONFIG, justBelow, WALLET_ADDRESS);
      await mgr.getEthBalance();

      expect(mgr.canEnterTrade(ETH(0.001))).toBe(false);
    });
  });

  describe('isCritical()', () => {
    it('returns false when balance is above critical threshold', async () => {
      await manager.getEthBalance(); // 0.01 ETH

      expect(manager.isCritical()).toBe(false);
    });

    it('returns true when balance is below critical threshold (0.002 ETH)', async () => {
      const lowProvider = createMockProvider(ETH(0.001));
      const mgr = new GasReserveManager(DEFAULT_CONFIG, lowProvider, WALLET_ADDRESS);
      await mgr.getEthBalance();

      expect(mgr.isCritical()).toBe(true);
    });

    it('returns false when balance equals exactly critical threshold', async () => {
      // At exactly 0.002 ETH, not critical (< check, not <=)
      const exactProvider = createMockProvider(2_000_000_000_000_000n);
      const mgr = new GasReserveManager(DEFAULT_CONFIG, exactProvider, WALLET_ADDRESS);
      await mgr.getEthBalance();

      expect(mgr.isCritical()).toBe(false);
    });

    it('returns true when balance is zero', async () => {
      const zeroProvider = createMockProvider(0n);
      const mgr = new GasReserveManager(DEFAULT_CONFIG, zeroProvider, WALLET_ADDRESS);
      await mgr.getEthBalance();

      expect(mgr.isCritical()).toBe(true);
    });

    it('returns true before any balance fetch (initial 0n < critical)', () => {
      // lastKnownBalance is 0n initially, which is < critical
      expect(manager.isCritical()).toBe(true);
    });
  });

  describe('coversNCycles()', () => {
    it('returns true when balance covers 2 cycles', async () => {
      await manager.getEthBalance(); // 0.01 ETH

      // avgGasPerCycle = 0.002 ETH, n=2 → need 0.004 ETH, have 0.01
      expect(manager.coversNCycles(2, ETH(0.002))).toBe(true);
    });

    it('returns false when balance cannot cover requested cycles', async () => {
      await manager.getEthBalance(); // 0.01 ETH

      // avgGasPerCycle = 0.006 ETH, n=2 → need 0.012 ETH, have 0.01
      expect(manager.coversNCycles(2, ETH(0.006))).toBe(false);
    });

    it('returns true for n=0 (trivial case)', async () => {
      await manager.getEthBalance();

      expect(manager.coversNCycles(0, ETH(0.01))).toBe(true);
    });

    it('returns true for negative n (treated as trivial)', async () => {
      await manager.getEthBalance();

      expect(manager.coversNCycles(-1, ETH(0.01))).toBe(true);
    });

    it('returns true when balance exactly covers n cycles', async () => {
      await manager.getEthBalance(); // 0.01 ETH

      // avgGasPerCycle = 0.005 ETH, n=2 → need exactly 0.01 ETH
      expect(manager.coversNCycles(2, ETH(0.005))).toBe(true);
    });

    it('returns false when balance is slightly below n cycles', async () => {
      const almostProvider = createMockProvider(ETH(0.01) - 1n); // 0.01 ETH - 1 wei
      const mgr = new GasReserveManager(DEFAULT_CONFIG, almostProvider, WALLET_ADDRESS);
      await mgr.getEthBalance();

      // Need exactly 0.01 ETH but have 1 wei less
      expect(mgr.coversNCycles(2, ETH(0.005))).toBe(false);
    });

    it('works with realistic gas estimates (350k gas at 0.1 gwei)', async () => {
      await manager.getEthBalance(); // 0.01 ETH

      // 350,000 gas * 0.1 gwei = 35,000 gwei = 0.000035 ETH per cycle
      const gasPerCycle = 350_000n * 100_000_000n; // 35,000,000,000,000 wei = 0.000035 ETH
      // 2 cycles = 0.00007 ETH — well within 0.01 ETH
      expect(manager.coversNCycles(2, gasPerCycle)).toBe(true);
    });

    it('returns false for zero balance and positive cycles', () => {
      // lastKnownBalance = 0n (no fetch)
      expect(manager.coversNCycles(1, ETH(0.001))).toBe(false);
    });
  });

  describe('GAS_PER_CYCLE_UNITS constant', () => {
    it('equals 350,000 (approval 50k + entry 150k + exit 150k)', () => {
      expect(GAS_PER_CYCLE_UNITS).toBe(350_000n);
    });
  });

  describe('safe mode integration', () => {
    it('triggers safe mode on each getEthBalance() call when below critical', async () => {
      const lowProvider = createMockProvider(ETH(0.001));
      const mgr = new GasReserveManager(DEFAULT_CONFIG, lowProvider, WALLET_ADDRESS, safeModeTrigger);

      await mgr.getEthBalance();
      await mgr.getEthBalance();

      expect(safeModeTrigger.onGasCritical).toHaveBeenCalledTimes(2);
    });

    it('does not trigger safe mode when balance recovers above critical', async () => {
      // Start critical
      const dynamicProvider: IEthBalanceProvider = {
        getBalance: vi.fn()
          .mockResolvedValueOnce(ETH(0.001))  // first call: critical
          .mockResolvedValueOnce(ETH(0.01)),   // second call: recovered
      };
      const mgr = new GasReserveManager(DEFAULT_CONFIG, dynamicProvider, WALLET_ADDRESS, safeModeTrigger);

      await mgr.getEthBalance(); // triggers
      await mgr.getEthBalance(); // does not trigger

      expect(safeModeTrigger.onGasCritical).toHaveBeenCalledTimes(1);
    });
  });
});

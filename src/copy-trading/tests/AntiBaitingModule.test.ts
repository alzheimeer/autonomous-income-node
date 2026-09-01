/**
 * @fileoverview Unit tests for AntiBaitingModule
 *
 * Tests cover:
 * - Holder concentration detection (Req 7.3)
 * - Integration with check() method
 * - Cache management for holder data
 * - Configuration handling
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ethers } from 'ethers';
import {
  AntiBaitingModule,
  createAntiBaitingModule,
  DEFAULT_MAX_MONITORED_HOLDERS_PCT,
} from '../modules/AntiBaitingModule.js';
import type { EnrichedSignal } from '../interfaces/types.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock EnrichedSignal for testing
 */
function createMockSignal(overrides: Partial<EnrichedSignal> = {}): EnrichedSignal {
  return {
    id: 'test-signal-' + Math.random().toString(36).slice(2),
    sourceWallet: '0x1234567890123456789012345678901234567890',
    walletTier: 'A_TIER',
    tokenAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    poolAddress: '0x9876543210987654321098765432109876543210',
    action: 'BUY',
    tradeAmountUsdc: 100,
    entryPrice: BigInt('1000000000000000000'),
    blockNumber: 12345678,
    txHash: '0x' + 'a'.repeat(64),
    detectedAt: Date.now(),
    detectionLatencyMs: 100,
    approved: true,
    enrichment: {
      liquidityUsdc: 50000,
      liquidityWeth: 10,
      estimatedSlippagePct: 1,
      transferTaxPct: 0,
      lpLockedPct: 80,
      deployerStatus: 'clean',
      tokenAgeHours: 48,
    },
    enrichedAt: Date.now(),
    enrichmentLatencyMs: 50,
    ...overrides,
  };
}

// =============================================================================
// HOLDER CONCENTRATION TESTS
// =============================================================================

describe('AntiBaitingModule - Holder Concentration', () => {
  let module: AntiBaitingModule;

  beforeEach(() => {
    module = new AntiBaitingModule();
  });

  describe('checkHolderConcentration', () => {
    it('should return low concentration when no holders data available', async () => {
      const result = await module.checkHolderConcentration(
        '0x1234567890123456789012345678901234567890'
      );

      expect(result.isHigh).toBe(false);
      expect(result.concentrationPct).toBe(0);
      expect(result.topHoldersCount).toBe(0);
      expect(result.monitoredHoldersCount).toBe(0);
    });

    it('should return low concentration when no monitored wallets are set', async () => {
      // Set up some holder data
      module.setHolderCache('0xtoken123', [
        { address: '0xholder1', balance: '1000000' },
        { address: '0xholder2', balance: '500000' },
      ]);

      const result = await module.checkHolderConcentration('0xtoken123');

      expect(result.isHigh).toBe(false);
      expect(result.monitoredHoldersCount).toBe(0);
    });

    it('should detect high concentration when >30% of holders are monitored', async () => {
      const holders = [
        { address: '0xmonitored1', balance: '1000000' },
        { address: '0xmonitored2', balance: '500000' },
        { address: '0xrandom1', balance: '300000' },
        { address: '0xrandom2', balance: '200000' },
      ];

      // Set up monitored wallets (2 out of 4 = 50%)
      module.setMonitoredWallets(['0xmonitored1', '0xmonitored2']);
      module.setHolderCache('0xtoken123', holders);

      const result = await module.checkHolderConcentration('0xtoken123');

      expect(result.isHigh).toBe(true);
      expect(result.concentrationPct).toBe(50);
      expect(result.topHoldersCount).toBe(4);
      expect(result.monitoredHoldersCount).toBe(2);
    });

    it('should allow when concentration is exactly at threshold (30%)', async () => {
      const holders = [
        { address: '0xmonitored1', balance: '1000000' },
        { address: '0xmonitored2', balance: '500000' },
        { address: '0xmonitored3', balance: '400000' },
        { address: '0xrandom1', balance: '300000' },
        { address: '0xrandom2', balance: '200000' },
        { address: '0xrandom3', balance: '150000' },
        { address: '0xrandom4', balance: '100000' },
        { address: '0xrandom5', balance: '80000' },
        { address: '0xrandom6', balance: '60000' },
        { address: '0xrandom7', balance: '40000' },
      ];

      // Set up monitored wallets (3 out of 10 = 30%)
      module.setMonitoredWallets(['0xmonitored1', '0xmonitored2', '0xmonitored3']);
      module.setHolderCache('0xtoken123', holders);

      const result = await module.checkHolderConcentration('0xtoken123');

      // 30% is exactly at threshold, should NOT be flagged as high
      expect(result.isHigh).toBe(false);
      expect(result.concentrationPct).toBe(30);
    });

    it('should flag when concentration exceeds threshold (31%)', async () => {
      const holders = [
        { address: '0xmonitored1', balance: '1000000' },
        { address: '0xrandom1', balance: '500000' },
        { address: '0xrandom2', balance: '400000' },
      ];

      // Set up monitored wallets (1 out of 3 = 33.33%)
      module.setMonitoredWallets(['0xmonitored1']);
      module.setHolderCache('0xtoken123', holders);

      const result = await module.checkHolderConcentration('0xtoken123');

      expect(result.isHigh).toBe(true);
      expect(result.concentrationPct).toBeCloseTo(33.33, 1);
    });

    it('should handle case-insensitive wallet address matching', async () => {
      const holders = [
        { address: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12', balance: '1000000' },
        { address: '0x1234567890123456789012345678901234567890', balance: '500000' },
      ];

      // Set up monitored wallets with different case
      module.setMonitoredWallets(['0xabcdef1234567890abcdef1234567890abcdef12']);
      module.setHolderCache('0xtoken123', holders);

      const result = await module.checkHolderConcentration('0xtoken123');

      expect(result.monitoredHoldersCount).toBe(1);
      expect(result.concentrationPct).toBe(50);
    });
  });

  describe('setMonitoredWallets', () => {
    it('should set and normalize wallet addresses', () => {
      module.setMonitoredWallets([
        '0xABCD1234567890ABCDEF1234567890ABCDEF1234',
        '0x1234567890123456789012345678901234567890',
      ]);

      const wallets = module.getMonitoredWallets();
      expect(wallets).toHaveLength(2);
      expect(wallets).toContain('0xabcd1234567890abcdef1234567890abcdef1234');
      expect(wallets).toContain('0x1234567890123456789012345678901234567890');
    });

    it('should replace existing wallets', () => {
      module.setMonitoredWallets(['0xwallet1', '0xwallet2']);
      expect(module.getMonitoredWallets()).toHaveLength(2);

      module.setMonitoredWallets(['0xwallet3']);
      expect(module.getMonitoredWallets()).toHaveLength(1);
      expect(module.getMonitoredWallets()).toContain('0xwallet3');
    });
  });

  describe('holder cache management', () => {
    it('should use cached holder data', async () => {
      const holders = [
        { address: '0xholder1', balance: '1000000' },
        { address: '0xholder2', balance: '500000' },
      ];

      module.setHolderCache('0xtoken123', holders);
      module.setMonitoredWallets(['0xholder1']);

      const result = await module.checkHolderConcentration('0xtoken123');

      expect(result.topHoldersCount).toBe(2);
      expect(result.monitoredHoldersCount).toBe(1);
    });

    it('should clear holder cache', async () => {
      module.setHolderCache('0xtoken123', [{ address: '0xholder1', balance: '1000000' }]);

      module.clearHolderCache();

      // After clearing, should return empty result
      const result = await module.checkHolderConcentration('0xtoken123');
      expect(result.topHoldersCount).toBe(0);
    });
  });
});

// =============================================================================
// INTEGRATION WITH CHECK() METHOD
// =============================================================================

describe('AntiBaitingModule - check() integration', () => {
  let module: AntiBaitingModule;

  beforeEach(() => {
    module = new AntiBaitingModule({
      maxMonitoredHoldersPct: 0.30, // 30%
      maxVolumeFootprintPct: 0.05, // 5%
    });
  });

  it('should reject signal when holder concentration is high', async () => {
    const signal = createMockSignal({
      tokenAddress: '0xtoken123',
      tradeAmountUsdc: 10, // Small enough to pass volume check
    });

    // Set up holders with high concentration
    const holders = [
      { address: '0xmonitored1', balance: '1000000' },
      { address: '0xmonitored2', balance: '500000' },
      { address: '0xrandom1', balance: '300000' },
    ];

    module.setMonitoredWallets(['0xmonitored1', '0xmonitored2']);
    module.setHolderCache('0xtoken123', holders);
    // Set volume cache to allow the trade to pass volume check
    module.setVolumeCache('0xtoken123', 100000);

    const result = await module.check(signal);

    expect(result.approved).toBe(false);
    expect(result.rejectReason).toBe('HIGH_MONITORED_HOLDERS');
    expect(result.flags.highMonitoredHolders).toBe(true);
  });

  it('should approve signal when holder concentration is low', async () => {
    const signal = createMockSignal({
      tokenAddress: '0xtoken456',
      tradeAmountUsdc: 10,
    });

    // Set up holders with low concentration
    const holders = [
      { address: '0xmonitored1', balance: '1000000' },
      { address: '0xrandom1', balance: '500000' },
      { address: '0xrandom2', balance: '300000' },
      { address: '0xrandom3', balance: '200000' },
    ];

    module.setMonitoredWallets(['0xmonitored1']);
    module.setHolderCache('0xtoken456', holders);
    // Set volume cache to allow the trade
    module.setVolumeCache('0xtoken456', 100000);

    const result = await module.check(signal);

    expect(result.approved).toBe(true);
    expect(result.flags.highMonitoredHolders).toBe(false);
  });

  it('should skip holder concentration check when no monitored wallets', async () => {
    const signal = createMockSignal({
      tokenAddress: '0xtoken789',
      tradeAmountUsdc: 10,
    });

    // Don't set any monitored wallets
    // Set volume cache to allow the trade
    module.setVolumeCache('0xtoken789', 100000);

    const result = await module.check(signal);

    expect(result.approved).toBe(true);
    expect(result.flags.highMonitoredHolders).toBe(false);
  });

  it('should add bait flag when rejecting for high concentration', async () => {
    const signal = createMockSignal({
      tokenAddress: '0xtoken123',
      sourceWallet: '0xsource1',
      tradeAmountUsdc: 10,
    });

    const holders = [
      { address: '0xmonitored1', balance: '1000000' },
      { address: '0xmonitored2', balance: '500000' },
    ];

    module.setMonitoredWallets(['0xmonitored1', '0xmonitored2']);
    module.setHolderCache('0xtoken123', holders);
    module.setVolumeCache('0xtoken123', 100000);

    await module.check(signal);

    const flags = module.getFlags('0xsource1');
    expect(flags).toHaveLength(1);
    expect(flags[0].reason).toBe('HIGH_MONITORED_HOLDERS');
  });
});

// =============================================================================
// CONFIGURATION TESTS
// =============================================================================

describe('AntiBaitingModule - Configuration', () => {
  it('should use default max monitored holders pct', () => {
    const module = new AntiBaitingModule();
    const config = module.getConfig();

    expect(config.maxMonitoredHoldersPct).toBe(DEFAULT_MAX_MONITORED_HOLDERS_PCT);
    expect(config.maxMonitoredHoldersPct).toBe(0.30);
  });

  it('should allow custom max monitored holders pct', () => {
    const module = new AntiBaitingModule({
      maxMonitoredHoldersPct: 0.20, // 20%
    });

    const config = module.getConfig();
    expect(config.maxMonitoredHoldersPct).toBe(0.20);
  });

  it('should initialize with monitored wallets from config', () => {
    const module = new AntiBaitingModule({
      monitoredWallets: ['0xwallet1', '0xwallet2'],
    });

    const wallets = module.getMonitoredWallets();
    expect(wallets).toHaveLength(2);
  });
});

// =============================================================================
// FACTORY FUNCTION TESTS
// =============================================================================

describe('createAntiBaitingModule', () => {
  it('should create module with provider', () => {
    const mockProvider = {} as ethers.Provider;
    const module = createAntiBaitingModule(mockProvider);

    expect(module).toBeInstanceOf(AntiBaitingModule);
  });

  it('should create module with config overrides', () => {
    const module = createAntiBaitingModule(undefined, {
      maxMonitoredHoldersPct: 0.25,
      monitoredWallets: ['0xtest1'],
    });

    expect(module.getConfig().maxMonitoredHoldersPct).toBe(0.25);
    expect(module.getMonitoredWallets()).toHaveLength(1);
  });
});

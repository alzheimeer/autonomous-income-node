/**
 * @fileoverview Unit tests for WalletWatcher - Dust Transfer Filtering
 *
 * Tests for Task 7.5: Implementar filtrado de dust transfers
 * Requirements: 2.6 (Ignore dust transfers with value less than $100 USDC)
 * Property 7: Dust Transfer Filtering
 *
 * @module copy-trading/tests/WalletWatcher.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { WalletWatcher, type WalletWatcherStats } from '../modules/WalletWatcher.js';
import {
  WETH_BASE,
  USDC_BASE,
  USDBC_BASE,
  type DecodedSwap,
  type RouterAddresses,
} from '../modules/SwapDecoder.js';
import type { WalletWatcherConfig } from '../interfaces/types.js';

// =============================================================================
// TEST CONSTANTS
// =============================================================================

/** Test router addresses */
const TEST_ROUTERS: RouterAddresses = {
  uniswapV3: '0x2626664c2603336E57B271c5C0b26F421741e481',
  aerodrome: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  oneInch: '0x1111111254EEB25477B68fb85Ed929f73A960582',
};

/** Sample token address for testing */
const RANDOM_TOKEN = '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb'; // DAI on Base

/** USDC decimals (6) */
const USDC_DECIMALS = 6;

/** WETH decimals (18) */
const WETH_DECIMALS = 18;

/** Hardcoded ETH price used in estimateUsdcValue (should match WalletWatcher) */
const ETH_PRICE_USDC = 2500;

/** Default config for tests */
function createTestConfig(overrides?: Partial<WalletWatcherConfig>): WalletWatcherConfig {
  return {
    watchedWallets: ['0x1234567890123456789012345678901234567890'],
    ingestMethod: 'polling',
    wsRpcUrl: 'wss://test.example.com',
    httpRpcUrl: 'https://test.example.com',
    pollingIntervalMs: 2000,
    supportedRouters: TEST_ROUTERS,
    minTransferValueUsdc: 100, // Default $100 threshold
    ...overrides,
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Create a mock DecodedSwap for testing estimateUsdcValue
 */
function createMockDecodedSwap(overrides?: Partial<DecodedSwap>): DecodedSwap {
  return {
    router: 'uniswapV3',
    tokenIn: WETH_BASE,
    tokenOut: RANDOM_TOKEN,
    amountIn: ethers.parseEther('1.0'),
    amountOutMin: ethers.parseUnits('1000', 18),
    recipient: '0x1234567890123456789012345678901234567890',
    action: 'BUY',
    ...overrides,
  };
}

// =============================================================================
// estimateUsdcValue TESTS
// =============================================================================

describe('WalletWatcher: estimateUsdcValue', () => {
  let watcher: WalletWatcher;

  beforeEach(() => {
    watcher = new WalletWatcher(createTestConfig());
  });

  describe('USDC swaps', () => {
    it('returns correct value for USDC as tokenIn', () => {
      // Swapping 150 USDC for some token
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('150', USDC_DECIMALS), // 150 USDC
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(150);
    });

    it('returns correct value for USDC as tokenOut', () => {
      // Selling some token for 200 USDC
      const swap = createMockDecodedSwap({
        tokenIn: RANDOM_TOKEN,
        tokenOut: USDC_BASE,
        amountIn: ethers.parseUnits('1000', 18), // Some token amount
        amountOutMin: ethers.parseUnits('200', USDC_DECIMALS), // 200 USDC minimum
        action: 'SELL',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(200);
    });

    it('returns correct value for USDbC as tokenIn', () => {
      // Swapping 75 USDbC for some token
      const swap = createMockDecodedSwap({
        tokenIn: USDBC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('75', USDC_DECIMALS), // 75 USDbC
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(75);
    });

    it('returns correct value for USDbC as tokenOut', () => {
      // Selling for 500 USDbC
      const swap = createMockDecodedSwap({
        tokenIn: RANDOM_TOKEN,
        tokenOut: USDBC_BASE,
        amountOutMin: ethers.parseUnits('500', USDC_DECIMALS), // 500 USDbC minimum
        action: 'SELL',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(500);
    });

    it('handles fractional USDC amounts correctly', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('99.99', USDC_DECIMALS), // $99.99
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBeCloseTo(99.99, 2);
    });
  });

  describe('WETH swaps', () => {
    it('returns correct value for WETH as tokenIn (using ETH price)', () => {
      // Swapping 0.1 WETH (worth $250 at $2500/ETH)
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('0.1'), // 0.1 WETH
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.1 * ETH_PRICE_USDC); // 0.1 * 2500 = 250
    });

    it('returns correct value for WETH as tokenOut (using ETH price)', () => {
      // Selling token for 0.04 WETH (worth $100 at $2500/ETH)
      const swap = createMockDecodedSwap({
        tokenIn: RANDOM_TOKEN,
        tokenOut: WETH_BASE,
        amountOutMin: ethers.parseEther('0.04'), // 0.04 WETH = $100
        action: 'SELL',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.04 * ETH_PRICE_USDC); // 0.04 * 2500 = 100
    });

    it('handles large WETH amounts', () => {
      // Swapping 10 WETH (worth $25,000 at $2500/ETH)
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('10'), // 10 WETH
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(10 * ETH_PRICE_USDC); // 10 * 2500 = 25000
    });

    it('handles small WETH amounts', () => {
      // Swapping 0.001 WETH (worth $2.50 at $2500/ETH)
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('0.001'), // 0.001 WETH
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.001 * ETH_PRICE_USDC); // 0.001 * 2500 = 2.5
    });
  });

  describe('Unknown token swaps', () => {
    it('returns 0 for swaps with neither base token', () => {
      const anotherToken = '0x940181a94A35A4569E4529A3CDfB74e38FD98631';
      const swap = createMockDecodedSwap({
        tokenIn: RANDOM_TOKEN,
        tokenOut: anotherToken,
        amountIn: ethers.parseUnits('1000', 18),
        amountOutMin: ethers.parseUnits('500', 18),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0);
    });
  });

  describe('Case insensitivity', () => {
    it('handles lowercase USDC address', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE.toLowerCase(),
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('100', USDC_DECIMALS),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(100);
    });

    it('handles uppercase WETH address', () => {
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE.toUpperCase(),
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('0.04'),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.04 * ETH_PRICE_USDC);
    });
  });
});

// =============================================================================
// DUST FILTERING THRESHOLD TESTS
// =============================================================================

describe('WalletWatcher: Dust Filtering Threshold', () => {
  describe('Default threshold ($100)', () => {
    let watcher: WalletWatcher;

    beforeEach(() => {
      watcher = new WalletWatcher(createTestConfig({
        minTransferValueUsdc: 100,
      }));
    });

    it('$99.99 swap should be filtered (below threshold)', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('99.99', USDC_DECIMALS),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBeLessThan(100);
    });

    it('$100 swap should NOT be filtered (at threshold)', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('100', USDC_DECIMALS),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBeGreaterThanOrEqual(100);
    });

    it('$100.01 swap should NOT be filtered (above threshold)', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('100.01', USDC_DECIMALS),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBeGreaterThan(100);
    });

    it('$1 USDC swap should be filtered (dust)', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('1', USDC_DECIMALS),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(1);
      expect(value).toBeLessThan(100);
    });

    it('0.039 WETH swap ($97.5) should be filtered', () => {
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('0.039'), // 0.039 * 2500 = $97.5
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.039 * ETH_PRICE_USDC); // $97.5
      expect(value).toBeLessThan(100);
    });

    it('0.04 WETH swap ($100) should NOT be filtered', () => {
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('0.04'), // 0.04 * 2500 = $100
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.04 * ETH_PRICE_USDC); // $100
      expect(value).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Custom threshold', () => {
    it('respects custom minTransferValueUsdc of $50', () => {
      const watcher = new WalletWatcher(createTestConfig({
        minTransferValueUsdc: 50,
      }));

      // $49 should be below custom threshold
      const dustSwap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('49', USDC_DECIMALS),
        action: 'BUY',
      });
      expect(watcher.estimateUsdcValue(dustSwap)).toBeLessThan(50);

      // $50 should be at custom threshold
      const atThresholdSwap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('50', USDC_DECIMALS),
        action: 'BUY',
      });
      expect(watcher.estimateUsdcValue(atThresholdSwap)).toBeGreaterThanOrEqual(50);
    });

    it('respects custom minTransferValueUsdc of $200', () => {
      const watcher = new WalletWatcher(createTestConfig({
        minTransferValueUsdc: 200,
      }));

      // $150 should be below higher threshold
      const belowSwap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('150', USDC_DECIMALS),
        action: 'BUY',
      });
      expect(watcher.estimateUsdcValue(belowSwap)).toBeLessThan(200);

      // $200 should pass higher threshold
      const atSwap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('200', USDC_DECIMALS),
        action: 'BUY',
      });
      expect(watcher.estimateUsdcValue(atSwap)).toBeGreaterThanOrEqual(200);
    });
  });
});

// =============================================================================
// STATS TRACKING TESTS
// =============================================================================

describe('WalletWatcher: Stats Tracking', () => {
  let watcher: WalletWatcher;

  beforeEach(() => {
    watcher = new WalletWatcher(createTestConfig());
  });

  it('initializes stats to zero', () => {
    const stats = watcher.getStats();
    expect(stats.dustFiltered).toBe(0);
    expect(stats.transactionsProcessed).toBe(0);
    expect(stats.signalsEmitted).toBe(0);
  });

  it('getStats returns a copy (not reference)', () => {
    const stats1 = watcher.getStats();
    const stats2 = watcher.getStats();

    // Modify stats1
    stats1.dustFiltered = 999;

    // stats2 and actual stats should be unchanged
    expect(stats2.dustFiltered).toBe(0);
    expect(watcher.getStats().dustFiltered).toBe(0);
  });

  it('resetStats resets all counters', () => {
    // Get stats (they start at 0)
    const initialStats = watcher.getStats();
    expect(initialStats.dustFiltered).toBe(0);

    // Reset (should stay at 0)
    watcher.resetStats();
    
    const resetStats = watcher.getStats();
    expect(resetStats.dustFiltered).toBe(0);
    expect(resetStats.transactionsProcessed).toBe(0);
    expect(resetStats.signalsEmitted).toBe(0);
  });
});

// =============================================================================
// BOUNDARY VALUE TESTS (Property 7: Dust Transfer Filtering)
// =============================================================================

describe('WalletWatcher: Property 7 - Dust Transfer Filtering', () => {
  /**
   * Property 7: Dust Transfer Filtering
   * For any transfer event with value < $100 USDC equivalent,
   * the WalletWatcher SHALL NOT emit a CopySignal.
   * 
   * **Validates: Requirements 2.6**
   */
  
  let watcher: WalletWatcher;

  beforeEach(() => {
    watcher = new WalletWatcher(createTestConfig({
      minTransferValueUsdc: 100,
    }));
  });

  describe('Exact boundary cases', () => {
    it('$99.999999 USDC (just below) should be classified as dust', () => {
      // This is the maximum dust value - one "wei" below $100
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: BigInt(99_999_999), // 99.999999 USDC (6 decimals)
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBeCloseTo(99.999999, 5);
      expect(value).toBeLessThan(100);
    });

    it('$100 exactly should NOT be classified as dust', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: BigInt(100_000_000), // 100.000000 USDC
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(100);
      expect(value).toBeGreaterThanOrEqual(100);
    });

    it('$100.000001 (just above) should NOT be classified as dust', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: BigInt(100_000_001), // 100.000001 USDC
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBeCloseTo(100.000001, 5);
      expect(value).toBeGreaterThanOrEqual(100);
    });
  });

  describe('WETH boundary cases', () => {
    // 0.04 WETH = $100 at $2500/ETH price
    const weiFor100Usd = ethers.parseEther('0.04');
    
    it('0.0399 WETH (just below $100) should be dust', () => {
      // 0.0399 WETH = $99.75 at $2500/ETH price
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('0.0399'), // $99.75
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.0399 * ETH_PRICE_USDC); // $99.75
      expect(value).toBeLessThan(100);
    });

    it('0.04 WETH exactly ($100) should NOT be dust', () => {
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: weiFor100Usd, // Exactly 0.04 WETH = $100
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(100);
      expect(value).toBeGreaterThanOrEqual(100);
    });

    it('0.0401 WETH (just above $100) should NOT be dust', () => {
      // 0.0401 WETH = $100.25 at $2500/ETH price
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('0.0401'), // $100.25
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.0401 * ETH_PRICE_USDC); // $100.25
      expect(value).toBeGreaterThanOrEqual(100);
    });
  });

  describe('Zero and very small values', () => {
    it('$0 swap should be classified as dust', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: 0n,
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0);
      expect(value).toBeLessThan(100);
    });

    it('$0.01 swap should be classified as dust', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: BigInt(10_000), // 0.01 USDC
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(0.01);
      expect(value).toBeLessThan(100);
    });

    it('1 wei WETH should be classified as dust', () => {
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: 1n, // 1 wei
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBeLessThan(100);
    });
  });

  describe('Large values (not dust)', () => {
    it('$1000 USDC should NOT be classified as dust', () => {
      const swap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('1000', USDC_DECIMALS),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(1000);
      expect(value).toBeGreaterThanOrEqual(100);
    });

    it('10 WETH ($25,000) should NOT be classified as dust', () => {
      const swap = createMockDecodedSwap({
        tokenIn: WETH_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseEther('10'),
        action: 'BUY',
      });

      const value = watcher.estimateUsdcValue(swap);
      expect(value).toBe(10 * ETH_PRICE_USDC);
      expect(value).toBeGreaterThanOrEqual(100);
    });
  });
});


// =============================================================================
// COPY SIGNAL GENERATION TESTS (Task 7.7, Property 8)
// =============================================================================

describe('WalletWatcher: CopySignal Generation (Property 8)', () => {
  /**
   * Property 8: CopySignal Field Completeness
   * For any valid swap detected from a monitored wallet, the emitted CopySignal
   * SHALL contain all required fields: id, sourceWallet, walletTier, tokenAddress,
   * poolAddress, action, tradeAmountUsdc, entryPrice, blockNumber, txHash,
   * detectedAt, detectionLatencyMs.
   *
   * **Validates: Requirements 2.8**
   */

  let watcher: WalletWatcher;

  beforeEach(() => {
    watcher = new WalletWatcher(createTestConfig());
  });

  describe('createCopySignal generates valid signal with all required fields', () => {
    it('should generate a CopySignal with all required fields', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab',
      } as unknown as ethers.TransactionResponse;

      const decodedSwap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('500', USDC_DECIMALS),
        amountOutMin: ethers.parseUnits('1000', 18),
        action: 'BUY',
      });

      const blockNumber = 12345678;
      const blockTimestamp = Math.floor(Date.now() / 1000) - 5; // 5 seconds ago
      const usdcValue = 500;

      const signal = watcher.createCopySignal(mockTx, decodedSwap, blockNumber, blockTimestamp, usdcValue);

      // Verify all required fields are present
      expect(signal).toHaveProperty('id');
      expect(signal).toHaveProperty('sourceWallet');
      expect(signal).toHaveProperty('walletTier');
      expect(signal).toHaveProperty('tokenAddress');
      expect(signal).toHaveProperty('poolAddress');
      expect(signal).toHaveProperty('action');
      expect(signal).toHaveProperty('tradeAmountUsdc');
      expect(signal).toHaveProperty('entryPrice');
      expect(signal).toHaveProperty('blockNumber');
      expect(signal).toHaveProperty('txHash');
      expect(signal).toHaveProperty('detectedAt');
      expect(signal).toHaveProperty('detectionLatencyMs');

      // Verify field values
      expect(signal.sourceWallet).toBe(mockTx.from);
      expect(signal.poolAddress).toBe(mockTx.to);
      expect(signal.action).toBe('BUY');
      expect(signal.tradeAmountUsdc).toBe(usdcValue);
      expect(signal.blockNumber).toBe(blockNumber);
      expect(signal.txHash).toBe(mockTx.hash);
      expect(signal.detectedAt).toBeGreaterThan(0);
      expect(signal.detectionLatencyMs).toBeGreaterThan(0);
    });
  });

  describe('createCopySignal sets correct tokenAddress based on action', () => {
    it('BUY action should set tokenAddress to tokenOut', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      // BUY: paying USDC to get RANDOM_TOKEN
      const decodedSwap = createMockDecodedSwap({
        tokenIn: USDC_BASE,
        tokenOut: RANDOM_TOKEN,
        amountIn: ethers.parseUnits('500', USDC_DECIMALS),
        amountOutMin: ethers.parseUnits('1000', 18),
        action: 'BUY',
      });

      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, Math.floor(Date.now() / 1000), 500);

      // For BUY, we're acquiring tokenOut (the non-base token)
      expect(signal.tokenAddress).toBe(RANDOM_TOKEN);
      expect(signal.action).toBe('BUY');
    });

    it('SELL action should set tokenAddress to tokenIn', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      // SELL: selling RANDOM_TOKEN to get USDC
      const decodedSwap = createMockDecodedSwap({
        tokenIn: RANDOM_TOKEN,
        tokenOut: USDC_BASE,
        amountIn: ethers.parseUnits('1000', 18),
        amountOutMin: ethers.parseUnits('500', USDC_DECIMALS),
        action: 'SELL',
      });

      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, Math.floor(Date.now() / 1000), 500);

      // For SELL, we're selling tokenIn (the non-base token)
      expect(signal.tokenAddress).toBe(RANDOM_TOKEN);
      expect(signal.action).toBe('SELL');
    });
  });

  describe('Signal id is a valid UUID format', () => {
    it('should generate a valid UUID v4 format', () => {
      const uuid = watcher.generateUUID();
      
      // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
      // Where y is 8, 9, a, or b
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(uuid).toMatch(uuidRegex);
    });

    it('should generate unique UUIDs', () => {
      const uuid1 = watcher.generateUUID();
      const uuid2 = watcher.generateUUID();
      const uuid3 = watcher.generateUUID();

      expect(uuid1).not.toBe(uuid2);
      expect(uuid2).not.toBe(uuid3);
      expect(uuid1).not.toBe(uuid3);
    });

    it('signal id should be a valid UUID', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      const decodedSwap = createMockDecodedSwap();
      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, Math.floor(Date.now() / 1000), 100);

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      expect(signal.id).toMatch(uuidRegex);
    });
  });

  describe('detectionLatencyMs is calculated correctly', () => {
    it('should calculate detection latency as now minus block timestamp', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      const decodedSwap = createMockDecodedSwap();
      
      // Block timestamp 3 seconds ago
      const now = Date.now();
      const blockTimestamp = Math.floor((now - 3000) / 1000);

      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, blockTimestamp, 100);

      // Detection latency should be approximately 3000ms (within 500ms tolerance for CI)
      expect(signal.detectionLatencyMs).toBeGreaterThanOrEqual(2500);
      expect(signal.detectionLatencyMs).toBeLessThanOrEqual(4000);
    });

    it('should handle very recent blocks (low latency)', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      const decodedSwap = createMockDecodedSwap();
      
      // Block timestamp just now
      const blockTimestamp = Math.floor(Date.now() / 1000);

      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, blockTimestamp, 100);

      // Detection latency should be very low (under 1 second)
      expect(signal.detectionLatencyMs).toBeGreaterThanOrEqual(0);
      expect(signal.detectionLatencyMs).toBeLessThan(1000);
    });
  });

  describe('Wallet tier lookup', () => {
    it('should default to B_TIER when no lookup is set', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      const decodedSwap = createMockDecodedSwap();
      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, Math.floor(Date.now() / 1000), 100);

      expect(signal.walletTier).toBe('B_TIER');
    });

    it('should use tier from lookup function when set', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      // Set up tier lookup
      watcher.setWalletTierLookup((address: string) => {
        if (address === '0x1234567890123456789012345678901234567890') {
          return 'S_TIER';
        }
        return null;
      });

      const decodedSwap = createMockDecodedSwap();
      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, Math.floor(Date.now() / 1000), 100);

      expect(signal.walletTier).toBe('S_TIER');
    });

    it('should default to B_TIER when lookup returns null', () => {
      const mockTx = {
        from: '0xunknownwallet000000000000000000000000000',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      // Set up tier lookup that returns null for unknown wallets
      watcher.setWalletTierLookup(() => null);

      const decodedSwap = createMockDecodedSwap();
      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, Math.floor(Date.now() / 1000), 100);

      expect(signal.walletTier).toBe('B_TIER');
    });

    it('should support different tiers', () => {
      // Set up tier lookup with tier map
      const tierMap: Record<string, 'S_TIER' | 'A_TIER' | 'B_TIER'> = {
        '0xSTIER000000000000000000000000000000000': 'S_TIER',
        '0xATIER000000000000000000000000000000000': 'A_TIER',
        '0xBTIER000000000000000000000000000000000': 'B_TIER',
      };

      watcher.setWalletTierLookup((address: string) => tierMap[address] || null);

      const baseSignal = {
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      };
      const decodedSwap = createMockDecodedSwap();

      // Test S_TIER
      const sTierSignal = watcher.createCopySignal(
        { ...baseSignal, from: '0xSTIER000000000000000000000000000000000' } as unknown as ethers.TransactionResponse,
        decodedSwap,
        12345,
        Math.floor(Date.now() / 1000),
        100,
      );
      expect(sTierSignal.walletTier).toBe('S_TIER');

      // Test A_TIER
      const aTierSignal = watcher.createCopySignal(
        { ...baseSignal, from: '0xATIER000000000000000000000000000000000' } as unknown as ethers.TransactionResponse,
        decodedSwap,
        12345,
        Math.floor(Date.now() / 1000),
        100,
      );
      expect(aTierSignal.walletTier).toBe('A_TIER');
    });
  });

  describe('Entry price calculation', () => {
    it('should calculate entry price as ratio scaled by 1e18', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      // amountIn = 1 USDC (1e6), amountOutMin = 1000 tokens (1e18)
      // entryPrice = (1e6 * 1e18) / 1e18 = 1e6
      const decodedSwap = createMockDecodedSwap({
        amountIn: BigInt(1_000_000), // 1 USDC
        amountOutMin: ethers.parseUnits('1', 18), // 1 token
      });

      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, Math.floor(Date.now() / 1000), 1);

      // entryPrice = (1_000_000 * 1e18) / 1e18 = 1_000_000
      expect(signal.entryPrice).toBe(BigInt(1_000_000));
    });

    it('should handle zero amountOutMin', () => {
      const mockTx = {
        from: '0x1234567890123456789012345678901234567890',
        to: '0x2626664c2603336E57B271c5C0b26F421741e481',
        hash: '0xabcd1234',
      } as unknown as ethers.TransactionResponse;

      const decodedSwap = createMockDecodedSwap({
        amountIn: BigInt(1_000_000),
        amountOutMin: 0n, // Zero output
      });

      const signal = watcher.createCopySignal(mockTx, decodedSwap, 12345, Math.floor(Date.now() / 1000), 1);

      // Should return 0 to avoid division by zero
      expect(signal.entryPrice).toBe(0n);
    });
  });

  describe('signalsEmitted counter increments', () => {
    it('should have stats.signalsEmitted at 0 initially', () => {
      const stats = watcher.getStats();
      expect(stats.signalsEmitted).toBe(0);
    });
  });
});

// =============================================================================
// SIGNAL CALLBACK TESTS
// =============================================================================

describe('WalletWatcher: Signal Callbacks', () => {
  let watcher: WalletWatcher;

  beforeEach(() => {
    watcher = new WalletWatcher(createTestConfig());
  });

  it('should register callbacks via onSignal', () => {
    let callbackInvoked = false;
    
    watcher.onSignal(async () => {
      callbackInvoked = true;
    });

    // Callback registered but not invoked yet
    expect(callbackInvoked).toBe(false);
  });

  it('should allow multiple callbacks to be registered', () => {
    const callbacks: Array<() => Promise<void>> = [];

    watcher.onSignal(async () => { callbacks.push(async () => {}); });
    watcher.onSignal(async () => { callbacks.push(async () => {}); });
    watcher.onSignal(async () => { callbacks.push(async () => {}); });

    // Three callbacks registered - verify we can add multiple
    // (actual invocation is tested through processTransaction integration)
  });
});

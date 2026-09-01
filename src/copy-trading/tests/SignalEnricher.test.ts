/**
 * SignalEnricher Unit Tests
 *
 * Tests for slippage estimation and signal enrichment.
 *
 * Requirements: 3.7, 3.8
 * - 3.7: THE Signal_Enricher SHALL estimate slippage for the planned position size
 * - 3.8: IF estimated slippage exceeds 5%, THEN THE Signal_Enricher SHALL reject the signal as HIGH_SLIPPAGE
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SignalEnricher, type SlippageEstimationResult } from '../modules/SignalEnricher.js';
import type { CopyTradingConfig } from '../config/CopyTradingConfig.js';
import type { IDexQuoter, QuoteParams } from '../../shared/dex-quoter.js';
import type { CopySignal } from '../interfaces/types.js';

// =============================================================================
// MOCK SETUP
// =============================================================================

/** Mock DexQuoter for testing */
class MockDexQuoter implements IDexQuoter {
  private quoteResponses: Map<string, bigint> = new Map();

  /** Set a quote response for a specific amount */
  setQuoteResponse(amountIn: bigint, amountOut: bigint): void {
    this.quoteResponses.set(amountIn.toString(), amountOut);
  }

  /** Clear all mocked responses */
  clearResponses(): void {
    this.quoteResponses.clear();
  }

  async detectPoolType(): Promise<'uniswap_v3' | 'aerodrome'> {
    return 'uniswap_v3';
  }

  async quote(params: QuoteParams): Promise<bigint> {
    const response = this.quoteResponses.get(params.amountIn.toString());
    if (response !== undefined) {
      return response;
    }
    // Default: return proportional amount (no slippage)
    // For testing, assume 1 USDC = 1000 tokens at spot
    return params.amountIn * 1000n;
  }
}

/** Create a mock provider */
function createMockProvider() {
  return {
    getNetwork: vi.fn().mockResolvedValue({ chainId: 8453n }),
  } as any;
}

/** Create test config with defaults */
function createTestConfig(overrides: Partial<CopyTradingConfig> = {}): CopyTradingConfig {
  return {
    initialCapitalUsdc: 500,
    maxPositionUsdc: 100,
    copyRatio: 0.1,
    takeProfitPct: 50,
    stopLossPct: 20,
    trailActivationPct: 10,
    trailDistancePct: 10,
    timeStopHours: 48,
    maxLossStreak: 3,
    maxGasGwei: 50,
    maxConcurrentPositions: 3,
    maxDailyCapitalPct: 20,
    circuitBreakerHours: 24,
    maxDrawdownPct: 25,
    minReservePct: 20,
    wsRpcUrl: 'wss://test.example.com',
    httpRpcUrl: null,
    pollingIntervalMs: 2000,
    heartbeatIntervalMs: 30000,
    reconnectTimeoutMs: 10000,
    minLiquidityUsdc: 10000,
    minLiquidityWeth: 2.0,
    maxSlippagePct: 5, // Default threshold: 5%
    maxTaxPct: 5,
    minLpLockPct: 50,
    maxVolumeFootprintPct: 5,
    executionDelayMinMs: 5000,
    executionDelayMaxMs: 30000,
    maxBaitFlags: 3,
    baitFlagWindowDays: 7,
    ...overrides,
  };
}

/** Create a test CopySignal */
function createTestSignal(overrides: Partial<CopySignal> = {}): CopySignal {
  return {
    id: 'test-signal-001',
    sourceWallet: '0x1234567890123456789012345678901234567890',
    walletTier: 'S_TIER',
    tokenAddress: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    poolAddress: '0x9876543210987654321098765432109876543210',
    action: 'BUY',
    tradeAmountUsdc: 50, // $50 USDC
    entryPrice: 1000n,
    blockNumber: 12345678,
    txHash: '0xhash',
    detectedAt: Date.now(),
    detectionLatencyMs: 100,
    ...overrides,
  };
}

// =============================================================================
// SLIPPAGE ESTIMATION TESTS
// =============================================================================

describe('SignalEnricher - Slippage Estimation', () => {
  let enricher: SignalEnricher;
  let mockQuoter: MockDexQuoter;
  let config: CopyTradingConfig;

  beforeEach(() => {
    mockQuoter = new MockDexQuoter();
    config = createTestConfig({ maxSlippagePct: 5 });
    enricher = new SignalEnricher(config, createMockProvider(), mockQuoter);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test: Low slippage passes (<5%)
  // ─────────────────────────────────────────────────────────────────────────
  describe('Low slippage (<5%)', () => {
    it('should PASS when slippage is 0% (no price impact)', async () => {
      // Spot price: $100 USDC -> 100,000 tokens (1000 tokens per USDC)
      // Actual trade: $50 USDC -> 50,000 tokens (same rate = 0% slippage)
      mockQuoter.setQuoteResponse(100_000_000n, 100_000_000_000n); // $100 -> 100B tokens
      mockQuoter.setQuoteResponse(50_000_000n, 50_000_000_000n);   // $50 -> 50B tokens (perfect scaling)

      const result = await enricher.estimateSlippage(
        '0xtoken',
        '0xpool',
        50, // $50 USDC
      );

      expect(result.passed).toBe(true);
      expect(result.estimatedSlippagePct).toBe(0);
    });

    it('should PASS when slippage is 2% (well below threshold)', async () => {
      // Spot price: $100 USDC -> 100,000 tokens
      // Expected at spot: $50 USDC -> 50,000 tokens
      // Actual trade: $50 USDC -> 49,000 tokens (2% slippage)
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n); // $100 -> 100,000 tokens
      mockQuoter.setQuoteResponse(50_000_000n, 49_000n);   // $50 -> 49,000 tokens

      const result = await enricher.estimateSlippage(
        '0xtoken',
        '0xpool',
        50,
      );

      expect(result.passed).toBe(true);
      expect(result.estimatedSlippagePct).toBeCloseTo(2, 1);
    });

    it('should PASS when slippage is 4.99% (just below threshold)', async () => {
      // Spot price: $100 USDC -> 100,000 tokens
      // Expected at spot: $50 USDC -> 50,000 tokens
      // Actual trade: $50 USDC -> 47,505 tokens (4.99% slippage)
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
      mockQuoter.setQuoteResponse(50_000_000n, 47_505n);

      const result = await enricher.estimateSlippage(
        '0xtoken',
        '0xpool',
        50,
      );

      expect(result.passed).toBe(true);
      expect(result.estimatedSlippagePct).toBeLessThan(5);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test: Boundary - Exactly 5% slippage
  // ─────────────────────────────────────────────────────────────────────────
  describe('Boundary - Exactly 5% slippage', () => {
    it('should PASS when slippage is exactly 5% (at threshold)', async () => {
      // Spot price: $100 USDC -> 100,000 tokens
      // Expected at spot: $50 USDC -> 50,000 tokens
      // Actual trade: $50 USDC -> 47,500 tokens (5% slippage)
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
      mockQuoter.setQuoteResponse(50_000_000n, 47_500n);

      const result = await enricher.estimateSlippage(
        '0xtoken',
        '0xpool',
        50,
      );

      expect(result.passed).toBe(true);
      expect(result.estimatedSlippagePct).toBeCloseTo(5, 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test: High slippage fails (>5%)
  // ─────────────────────────────────────────────────────────────────────────
  describe('High slippage (>5%)', () => {
    it('should FAIL when slippage is 5.01% (just above threshold)', async () => {
      // Spot price: $100 USDC -> 100,000 tokens
      // Expected at spot: $50 USDC -> 50,000 tokens
      // Actual trade: $50 USDC -> 47,495 tokens (5.01% slippage)
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
      mockQuoter.setQuoteResponse(50_000_000n, 47_495n);

      const result = await enricher.estimateSlippage(
        '0xtoken',
        '0xpool',
        50,
      );

      expect(result.passed).toBe(false);
      expect(result.estimatedSlippagePct).toBeGreaterThan(5);
    });

    it('should FAIL when slippage is 10%', async () => {
      // Spot price: $100 USDC -> 100,000 tokens
      // Expected at spot: $50 USDC -> 50,000 tokens
      // Actual trade: $50 USDC -> 45,000 tokens (10% slippage)
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
      mockQuoter.setQuoteResponse(50_000_000n, 45_000n);

      const result = await enricher.estimateSlippage(
        '0xtoken',
        '0xpool',
        50,
      );

      expect(result.passed).toBe(false);
      expect(result.estimatedSlippagePct).toBeCloseTo(10, 1);
    });

    it('should FAIL when slippage is 50% (major price impact)', async () => {
      // Spot price: $100 USDC -> 100,000 tokens
      // Expected at spot: $50 USDC -> 50,000 tokens
      // Actual trade: $50 USDC -> 25,000 tokens (50% slippage)
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
      mockQuoter.setQuoteResponse(50_000_000n, 25_000n);

      const result = await enricher.estimateSlippage(
        '0xtoken',
        '0xpool',
        50,
      );

      expect(result.passed).toBe(false);
      expect(result.estimatedSlippagePct).toBeCloseTo(50, 1);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test: Slippage scales with trade size
  // ─────────────────────────────────────────────────────────────────────────
  describe('Slippage scales with trade size', () => {
    it('should have lower slippage for smaller trades', async () => {
      // Small trade: $10 USDC -> 9,800 tokens (2% slippage)
      // Large trade: $100 USDC -> 90,000 tokens (10% slippage)
      const smallConfig = createTestConfig({ maxSlippagePct: 5 });
      const smallEnricher = new SignalEnricher(smallConfig, createMockProvider(), mockQuoter);

      // Setup: spot price gives 1000 tokens per USDC
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n); // $100 -> 100,000 tokens

      // Small trade: $10 with 2% slippage
      mockQuoter.setQuoteResponse(10_000_000n, 9_800n); // $10 -> 9,800 tokens
      const smallResult = await smallEnricher.estimateSlippage('0xtoken', '0xpool', 10);

      // Clear and setup for large trade
      mockQuoter.clearResponses();
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n);

      // Large trade: $100 with 10% slippage
      mockQuoter.setQuoteResponse(100_000_000n, 90_000n);
      const largeResult = await smallEnricher.estimateSlippage('0xtoken', '0xpool', 100);

      expect(smallResult.estimatedSlippagePct).toBeLessThan(largeResult.estimatedSlippagePct);
      expect(smallResult.passed).toBe(true);  // 2% < 5%
      expect(largeResult.passed).toBe(false); // 10% > 5%
    });

    it('should show increasing slippage for progressively larger trades', async () => {
      const results: SlippageEstimationResult[] = [];
      const amounts = [10, 50, 100, 500];

      // Spot price: constant at 1000 tokens per USDC
      // But larger trades get worse rates (simulating liquidity impact)
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n); // Spot: $100 -> 100,000 tokens

      for (const amount of amounts) {
        // Simulate increasing slippage with trade size
        // Small trades get near-spot, large trades suffer
        const amountBigInt = BigInt(amount * 1_000_000); // Convert to USDC decimals
        const expectedAtSpot = BigInt(amount * 1000);    // What we'd get at spot
        const slippageRate = Math.min(amount / 1000, 0.5); // 0.1% per $10, max 50%
        const actualTokens = BigInt(Math.floor(Number(expectedAtSpot) * (1 - slippageRate)));
        mockQuoter.setQuoteResponse(amountBigInt, actualTokens);

        const result = await enricher.estimateSlippage('0xtoken', '0xpool', amount);
        results.push(result);
      }

      // Verify slippage increases with trade size
      for (let i = 1; i < results.length; i++) {
        expect(results[i].estimatedSlippagePct).toBeGreaterThanOrEqual(
          results[i - 1].estimatedSlippagePct,
        );
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test: Edge cases
  // ─────────────────────────────────────────────────────────────────────────
  describe('Edge cases', () => {
    it('should handle zero amount gracefully', async () => {
      const result = await enricher.estimateSlippage('0xtoken', '0xpool', 0);

      expect(result.passed).toBe(true);
      expect(result.estimatedSlippagePct).toBe(0);
      expect(result.quotedOutput).toBe(0n);
    });

    it('should handle very small amounts', async () => {
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n); // Spot price
      mockQuoter.setQuoteResponse(1_000_000n, 1_000n);     // $1 -> 1000 tokens (0% slip)

      const result = await enricher.estimateSlippage('0xtoken', '0xpool', 1); // $1

      expect(result.passed).toBe(true);
      expect(result.estimatedSlippagePct).toBe(0);
    });

    it('should return 100% slippage when quote fails', async () => {
      // Create a quoter that throws errors
      const failingQuoter: IDexQuoter = {
        detectPoolType: async () => 'uniswap_v3',
        quote: async () => {
          throw new Error('Quote failed: no liquidity');
        },
      };

      const failEnricher = new SignalEnricher(config, createMockProvider(), failingQuoter);

      const result = await failEnricher.estimateSlippage('0xtoken', '0xpool', 50);

      expect(result.passed).toBe(false);
      expect(result.estimatedSlippagePct).toBe(100);
    });

    it('should handle when spot quote returns 0', async () => {
      mockQuoter.setQuoteResponse(100_000_000n, 0n); // Spot returns 0
      mockQuoter.setQuoteResponse(50_000_000n, 0n);  // Trade also returns 0

      const result = await enricher.estimateSlippage('0xtoken', '0xpool', 50);

      expect(result.passed).toBe(false);
      expect(result.estimatedSlippagePct).toBe(100);
    });

    it('should handle negative slippage (better price than spot)', async () => {
      // This can happen in rare cases like arbitrage opportunities
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n); // Spot: $100 -> 100,000
      mockQuoter.setQuoteResponse(50_000_000n, 51_000n);   // Trade: $50 -> 51,000 (better!)

      const result = await enricher.estimateSlippage('0xtoken', '0xpool', 50);

      expect(result.passed).toBe(true);
      expect(result.estimatedSlippagePct).toBe(0); // Negative slippage treated as 0
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Test: Custom threshold configuration
  // ─────────────────────────────────────────────────────────────────────────
  describe('Custom threshold configuration', () => {
    it('should respect custom maxSlippagePct threshold', async () => {
      // Create enricher with 3% threshold
      const strictConfig = createTestConfig({ maxSlippagePct: 3 });
      const strictEnricher = new SignalEnricher(strictConfig, createMockProvider(), mockQuoter);

      // 4% slippage - would pass 5% but fail 3%
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
      mockQuoter.setQuoteResponse(50_000_000n, 48_000n); // 4% slippage

      const result = await strictEnricher.estimateSlippage('0xtoken', '0xpool', 50);

      expect(result.passed).toBe(false);
      expect(result.estimatedSlippagePct).toBeCloseTo(4, 1);
    });

    it('should allow higher slippage with relaxed threshold', async () => {
      // Create enricher with 10% threshold
      const relaxedConfig = createTestConfig({ maxSlippagePct: 10 });
      const relaxedEnricher = new SignalEnricher(relaxedConfig, createMockProvider(), mockQuoter);

      // 8% slippage - would fail 5% but pass 10%
      mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
      mockQuoter.setQuoteResponse(50_000_000n, 46_000n); // 8% slippage

      const result = await relaxedEnricher.estimateSlippage('0xtoken', '0xpool', 50);

      expect(result.passed).toBe(true);
      expect(result.estimatedSlippagePct).toBeCloseTo(8, 1);
    });
  });
});

// =============================================================================
// SIGNAL ENRICHMENT INTEGRATION TESTS
// =============================================================================

describe('SignalEnricher - enrich() Integration', () => {
  let enricher: SignalEnricher;
  let mockQuoter: MockDexQuoter;
  let config: CopyTradingConfig;

  beforeEach(() => {
    mockQuoter = new MockDexQuoter();
    config = createTestConfig({ maxSlippagePct: 5 });
    enricher = new SignalEnricher(config, createMockProvider(), mockQuoter);
  });

  it('should reject signal with HIGH_SLIPPAGE when slippage exceeds threshold', async () => {
    // Setup high slippage scenario (15%)
    mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
    mockQuoter.setQuoteResponse(50_000_000n, 42_500n); // 15% slippage

    const signal = createTestSignal({ tradeAmountUsdc: 50 });
    const result = await enricher.enrich(signal);

    expect(result.approved).toBe(false);
    expect(result.rejectReason).toBe('HIGH_SLIPPAGE');
    expect(result.enrichment.estimatedSlippagePct).toBeCloseTo(15, 1);
  });

  it('should approve signal when slippage is within threshold', async () => {
    // Setup low slippage scenario (2%)
    mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
    mockQuoter.setQuoteResponse(50_000_000n, 49_000n); // 2% slippage

    const signal = createTestSignal({ tradeAmountUsdc: 50 });
    const result = await enricher.enrich(signal);

    expect(result.approved).toBe(true);
    expect(result.rejectReason).toBeUndefined();
    expect(result.enrichment.estimatedSlippagePct).toBeCloseTo(2, 1);
  });

  it('should track statistics correctly', async () => {
    // First signal: passes (2% slippage)
    mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
    mockQuoter.setQuoteResponse(50_000_000n, 49_000n);
    await enricher.enrich(createTestSignal());

    // Second signal: fails (15% slippage)
    mockQuoter.clearResponses();
    mockQuoter.setQuoteResponse(100_000_000n, 100_000n);
    mockQuoter.setQuoteResponse(50_000_000n, 42_500n);
    await enricher.enrich(createTestSignal());

    const stats = enricher.getStats();

    expect(stats.totalProcessed).toBe(2);
    expect(stats.totalApproved).toBe(1);
    expect(stats.rejectionsByReason['HIGH_SLIPPAGE']).toBe(1);
  });
});

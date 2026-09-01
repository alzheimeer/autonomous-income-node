/**
 * CopyTradingRiskManager Unit Tests
 *
 * Tests for daily capital limit:
 * - Req 5.2: THE Risk_Bucket SHALL limit maximum daily capital deployment to 20% of total capital
 * - Req 5.7: THE Risk_Bucket SHALL reset daily limits at 00:00 UTC each day
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CopyTradingRiskManager,
  createCopyTradingRiskManager,
  MAX_DAILY_CAPITAL_PCT,
  MIN_CAPITAL_RESERVE_PCT,
} from '../modules/CopyTradingRiskManager.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a test risk manager with total capital set
 */
function createTestRiskManager(
  totalCapitalUsdc: number = 1000,
  config: { maxDailyCapitalPct?: number } = {},
): CopyTradingRiskManager {
  const riskManager = createCopyTradingRiskManager(config);
  riskManager.setTotalCapital(totalCapitalUsdc);
  return riskManager;
}

/**
 * Get a specific UTC date's start timestamp (00:00 UTC)
 */
function getUTCDateStart(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0);
}

// =============================================================================
// DAILY CAPITAL LIMIT TESTS (Req 5.2)
// =============================================================================

describe('CopyTradingRiskManager - Daily Capital Limit (Req 5.2)', () => {
  describe('MAX_DAILY_CAPITAL_PCT constant', () => {
    it('should be 20% (0.20)', () => {
      expect(MAX_DAILY_CAPITAL_PCT).toBe(0.20);
    });
  });

  describe('getMaxDailyCapital()', () => {
    it('should return 20% of total capital', () => {
      const riskManager = createTestRiskManager(1000);
      expect(riskManager.getMaxDailyCapital()).toBe(200); // 1000 * 0.20
    });

    it('should return 0 when total capital is 0', () => {
      const riskManager = createTestRiskManager(0);
      expect(riskManager.getMaxDailyCapital()).toBe(0);
    });

    it('should respect custom maxDailyCapitalPct', () => {
      const riskManager = createTestRiskManager(1000, { maxDailyCapitalPct: 0.30 });
      expect(riskManager.getMaxDailyCapital()).toBe(300); // 1000 * 0.30
    });

    it('should calculate correctly for various capital amounts', () => {
      expect(createTestRiskManager(500).getMaxDailyCapital()).toBe(100);
      expect(createTestRiskManager(2000).getMaxDailyCapital()).toBe(400);
      expect(createTestRiskManager(10000).getMaxDailyCapital()).toBe(2000);
    });
  });

  describe('getDailyCapitalDeployed()', () => {
    it('should return 0 initially', () => {
      const riskManager = createTestRiskManager(1000);
      expect(riskManager.getDailyCapitalDeployed()).toBe(0);
    });

    it('should track registered capital deployment', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(50);
      expect(riskManager.getDailyCapitalDeployed()).toBe(50);

      riskManager.registerCapitalDeployment(30);
      expect(riskManager.getDailyCapitalDeployed()).toBe(80);
    });
  });

  describe('getRemainingDailyCapital()', () => {
    it('should return full max daily when nothing deployed', () => {
      const riskManager = createTestRiskManager(1000);
      expect(riskManager.getRemainingDailyCapital()).toBe(200);
    });

    it('should decrease as capital is deployed', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(50);
      expect(riskManager.getRemainingDailyCapital()).toBe(150);

      riskManager.registerCapitalDeployment(100);
      expect(riskManager.getRemainingDailyCapital()).toBe(50);
    });

    it('should return 0 when limit is reached', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(200);
      expect(riskManager.getRemainingDailyCapital()).toBe(0);
    });

    it('should return 0 when over limit (not negative)', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(250);
      expect(riskManager.getRemainingDailyCapital()).toBe(0);
    });
  });

  describe('wouldExceedDailyCapital()', () => {
    it('should return false when under limit', () => {
      const riskManager = createTestRiskManager(1000);

      expect(riskManager.wouldExceedDailyCapital(50)).toBe(false);
      expect(riskManager.wouldExceedDailyCapital(100)).toBe(false);
      expect(riskManager.wouldExceedDailyCapital(200)).toBe(false);
    });

    it('should return true when would exceed limit', () => {
      const riskManager = createTestRiskManager(1000);

      expect(riskManager.wouldExceedDailyCapital(201)).toBe(true);
      expect(riskManager.wouldExceedDailyCapital(300)).toBe(true);
    });

    it('should consider already deployed capital', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(150);

      // Remaining is 50
      expect(riskManager.wouldExceedDailyCapital(50)).toBe(false);
      expect(riskManager.wouldExceedDailyCapital(51)).toBe(true);
    });

    it('should return false when total capital is 0 (no limit enforcement)', () => {
      const riskManager = createTestRiskManager(0);
      expect(riskManager.wouldExceedDailyCapital(1000)).toBe(false);
    });

    it('should handle edge case at exact limit', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(100);

      // Remaining is 100, deploying exactly 100 should be allowed
      expect(riskManager.wouldExceedDailyCapital(100)).toBe(false);
      expect(riskManager.wouldExceedDailyCapital(100.01)).toBe(true);
    });
  });

  describe('registerCapitalDeployment()', () => {
    it('should accumulate deployments', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(25);
      riskManager.registerCapitalDeployment(25);
      riskManager.registerCapitalDeployment(50);

      expect(riskManager.getDailyCapitalDeployed()).toBe(100);
    });

    it('should allow deployment even when over limit (tracking only)', () => {
      const riskManager = createTestRiskManager(1000);

      // Deploy more than 20% limit - this should still work
      // (it's the caller's responsibility to check before deploying)
      riskManager.registerCapitalDeployment(300);
      expect(riskManager.getDailyCapitalDeployed()).toBe(300);
    });
  });

  describe('canOpenPositionWithCapital()', () => {
    it('should allow trade when under daily limit', () => {
      const riskManager = createTestRiskManager(1000);

      const result = riskManager.canOpenPositionWithCapital(50);

      expect(result.allowed).toBe(true);
      expect(result.dailyCapital).toBeDefined();
      expect(result.dailyCapital?.deployed).toBe(0);
      expect(result.dailyCapital?.maxAllowed).toBe(200);
      expect(result.dailyCapital?.remaining).toBe(200);
    });

    it('should reject trade when would exceed daily limit', () => {
      const riskManager = createTestRiskManager(1000);

      const result = riskManager.canOpenPositionWithCapital(250);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('DAILY_CAPITAL_EXCEEDED');
    });

    it('should reject trade when cumulative would exceed limit', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(150);

      // Try to deploy another 100 (total would be 250, limit is 200)
      const result = riskManager.canOpenPositionWithCapital(100);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('DAILY_CAPITAL_EXCEEDED');
      expect(result.dailyCapital?.deployed).toBe(150);
      expect(result.dailyCapital?.remaining).toBe(50);
    });

    it('should allow trade at exact remaining limit', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.registerCapitalDeployment(100);

      // Remaining is 100
      const result = riskManager.canOpenPositionWithCapital(100);

      expect(result.allowed).toBe(true);
    });

    it('should still check circuit breaker', () => {
      const riskManager = createTestRiskManager(1000);

      // Activate circuit breaker
      riskManager._setConsecutiveLosses(3);
      riskManager.onPositionClosed('SL_HIT', -50);

      const result = riskManager.canOpenPositionWithCapital(50);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
      expect(result.circuitBreakerActive).toBe(true);
    });

    it('should still check max positions', () => {
      const riskManager = createTestRiskManager(1000);

      // Mock position tracker with 3 open positions
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 3,
        getOpenPositions: () => [],
      });

      const result = riskManager.canOpenPositionWithCapital(50);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('MAX_POSITIONS_REACHED');
    });

    it('should not enforce daily limit when total capital is 0', () => {
      const riskManager = createTestRiskManager(0);

      const result = riskManager.canOpenPositionWithCapital(1000);

      // Should pass daily capital check (other checks may still fail/pass)
      expect(result.rejectReason).not.toBe('DAILY_CAPITAL_EXCEEDED');
    });
  });
});

// =============================================================================
// DAILY RESET TESTS (Req 5.7)
// =============================================================================

describe('CopyTradingRiskManager - Daily Reset at 00:00 UTC (Req 5.7)', () => {
  describe('Daily capital reset', () => {
    it('should reset daily capital at midnight UTC', () => {
      const riskManager = createTestRiskManager(1000);

      // Set time to Jan 15, 2024, 10:00 UTC
      const jan15_10am = getUTCDateStart(2024, 1, 15) + 10 * 60 * 60 * 1000;
      riskManager._overrideNow(jan15_10am);

      // Deploy some capital
      riskManager.registerCapitalDeployment(150);
      expect(riskManager.getDailyCapitalDeployed()).toBe(150);

      // Move to Jan 16, 2024, 00:01 UTC (next day)
      const jan16_00_01 = getUTCDateStart(2024, 1, 16) + 60 * 1000;
      riskManager._overrideNow(jan16_00_01);

      // Daily capital should be reset
      expect(riskManager.getDailyCapitalDeployed()).toBe(0);
      expect(riskManager.getRemainingDailyCapital()).toBe(200);
    });

    it('should not reset if still same day', () => {
      const riskManager = createTestRiskManager(1000);

      // Set time to Jan 15, 2024, 10:00 UTC
      const jan15_10am = getUTCDateStart(2024, 1, 15) + 10 * 60 * 60 * 1000;
      riskManager._overrideNow(jan15_10am);

      riskManager.registerCapitalDeployment(150);

      // Move to Jan 15, 2024, 23:59 UTC (same day)
      const jan15_2359 = getUTCDateStart(2024, 1, 15) + 23 * 60 * 60 * 1000 + 59 * 60 * 1000;
      riskManager._overrideNow(jan15_2359);

      expect(riskManager.getDailyCapitalDeployed()).toBe(150);
    });

    it('should reset exactly at midnight UTC', () => {
      const riskManager = createTestRiskManager(1000);

      // Set time to Jan 15, 2024, 23:59:59.999 UTC
      const jan15_235959 = getUTCDateStart(2024, 1, 16) - 1;
      riskManager._overrideNow(jan15_235959);

      riskManager.registerCapitalDeployment(150);
      expect(riskManager.getDailyCapitalDeployed()).toBe(150);

      // Move to exactly Jan 16, 2024, 00:00:00.000 UTC
      const jan16_000000 = getUTCDateStart(2024, 1, 16);
      riskManager._overrideNow(jan16_000000);

      expect(riskManager.getDailyCapitalDeployed()).toBe(0);
    });
  });

  describe('Daily PnL reset', () => {
    it('should reset daily PnL at midnight UTC', () => {
      const riskManager = createTestRiskManager(1000);

      // Set time to Jan 15, 2024
      const jan15 = getUTCDateStart(2024, 1, 15) + 10 * 60 * 60 * 1000;
      riskManager._overrideNow(jan15);

      // Record some PnL
      riskManager.onPositionClosed('TP_HIT', 100);
      expect(riskManager.getDailyPnl()).toBe(100);

      // Move to next day
      const jan16 = getUTCDateStart(2024, 1, 16) + 1 * 60 * 60 * 1000;
      riskManager._overrideNow(jan16);

      expect(riskManager.getDailyPnl()).toBe(0);
    });
  });

  describe('Multiple day transitions', () => {
    it('should handle skipping multiple days', () => {
      const riskManager = createTestRiskManager(1000);

      // Set time to Jan 15, 2024
      const jan15 = getUTCDateStart(2024, 1, 15) + 12 * 60 * 60 * 1000;
      riskManager._overrideNow(jan15);

      riskManager.registerCapitalDeployment(150);
      expect(riskManager.getDailyCapitalDeployed()).toBe(150);

      // Jump to Jan 20, 2024 (5 days later)
      const jan20 = getUTCDateStart(2024, 1, 20) + 12 * 60 * 60 * 1000;
      riskManager._overrideNow(jan20);

      expect(riskManager.getDailyCapitalDeployed()).toBe(0);
    });

    it('should track new deployments after reset', () => {
      const riskManager = createTestRiskManager(1000);

      // Day 1
      const day1 = getUTCDateStart(2024, 1, 15) + 12 * 60 * 60 * 1000;
      riskManager._overrideNow(day1);
      riskManager.registerCapitalDeployment(150);

      // Day 2
      const day2 = getUTCDateStart(2024, 1, 16) + 12 * 60 * 60 * 1000;
      riskManager._overrideNow(day2);

      expect(riskManager.getDailyCapitalDeployed()).toBe(0);

      // Deploy on day 2
      riskManager.registerCapitalDeployment(80);
      expect(riskManager.getDailyCapitalDeployed()).toBe(80);
      expect(riskManager.getRemainingDailyCapital()).toBe(120);
    });
  });

  describe('Timezone handling', () => {
    it('should use UTC for date comparison, not local time', () => {
      const riskManager = createTestRiskManager(1000);

      // Set to Dec 31, 2023, 23:00 UTC (could be Jan 1 in some timezones)
      const dec31_23 = getUTCDateStart(2023, 12, 31) + 23 * 60 * 60 * 1000;
      riskManager._overrideNow(dec31_23);

      riskManager.registerCapitalDeployment(100);
      expect(riskManager.getDailyCapitalDeployed()).toBe(100);

      // Still Dec 31 in UTC
      expect(riskManager.getDailyCapitalDeployed()).toBe(100);

      // Move to Jan 1, 2024, 00:00 UTC
      const jan1_00 = getUTCDateStart(2024, 1, 1);
      riskManager._overrideNow(jan1_00);

      expect(riskManager.getDailyCapitalDeployed()).toBe(0);
    });
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('CopyTradingRiskManager - Daily Capital Integration', () => {
  it('should work end-to-end with multiple trades in a day', () => {
    const riskManager = createTestRiskManager(1000);

    // Trade 1: Deploy $50
    let result = riskManager.canOpenPositionWithCapital(50);
    expect(result.allowed).toBe(true);
    riskManager.registerCapitalDeployment(50);

    // Trade 2: Deploy $100
    result = riskManager.canOpenPositionWithCapital(100);
    expect(result.allowed).toBe(true);
    riskManager.registerCapitalDeployment(100);

    // Trade 3: Deploy $75 - should fail (total would be 150 + 75 = 225 > 200)
    result = riskManager.canOpenPositionWithCapital(75);
    expect(result.allowed).toBe(false);
    expect(result.rejectReason).toBe('DAILY_CAPITAL_EXCEEDED');

    // Trade 4: Deploy exactly remaining $50 (deployed 150, max 200)
    result = riskManager.canOpenPositionWithCapital(50);
    expect(result.allowed).toBe(true);
    expect(result.dailyCapital?.remaining).toBe(50);
  });

  it('should properly integrate with position tracking', () => {
    const riskManager = createTestRiskManager(1000);

    // Set up position tracker with 2 positions
    riskManager.setPositionTracker({
      getOpenPositionsCount: () => 2,
      getOpenPositions: () => [],
    });

    // Deploy some capital
    riskManager.registerCapitalDeployment(100);

    // Should pass both position limit and daily capital checks
    const result = riskManager.canOpenPositionWithCapital(50);

    expect(result.allowed).toBe(true);
    expect(result.currentPositions).toBe(2);
    expect(result.dailyCapital?.deployed).toBe(100);
    expect(result.dailyCapital?.remaining).toBe(100);
  });

  it('should respect all limits together', () => {
    const riskManager = createTestRiskManager(1000);

    // Set up position tracker at max positions
    riskManager.setPositionTracker({
      getOpenPositionsCount: () => 3,
      getOpenPositions: () => [],
    });

    // Even though we have daily capital, position limit should reject
    const result = riskManager.canOpenPositionWithCapital(50);

    expect(result.allowed).toBe(false);
    expect(result.rejectReason).toBe('MAX_POSITIONS_REACHED');
    // Daily capital info should still be present
    expect(result.dailyCapital).toBeDefined();
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('CopyTradingRiskManager - Edge Cases', () => {
  it('should handle very small capital amounts', () => {
    const riskManager = createTestRiskManager(100);

    // Max daily is 20, deploy 19
    riskManager.registerCapitalDeployment(19);

    // Should allow 1 more
    expect(riskManager.canOpenPositionWithCapital(1).allowed).toBe(true);
    expect(riskManager.canOpenPositionWithCapital(1.01).allowed).toBe(false);
  });

  it('should handle very large capital amounts', () => {
    const riskManager = createTestRiskManager(1000000);

    expect(riskManager.getMaxDailyCapital()).toBe(200000);

    const result = riskManager.canOpenPositionWithCapital(100000);
    expect(result.allowed).toBe(true);
  });

  it('should handle fractional amounts correctly', () => {
    const riskManager = createTestRiskManager(1000);

    riskManager.registerCapitalDeployment(199.99);

    // Remaining should be ~0.01
    expect(riskManager.getRemainingDailyCapital()).toBeCloseTo(0.01, 2);
    expect(riskManager.wouldExceedDailyCapital(0.01)).toBe(false);
    expect(riskManager.wouldExceedDailyCapital(0.02)).toBe(true);
  });

  it('should handle capital changes mid-day', () => {
    const riskManager = createTestRiskManager(1000);

    // Deploy based on 1000 capital (max 200)
    riskManager.registerCapitalDeployment(150);

    // Capital increases mid-day
    riskManager.setTotalCapital(2000);

    // New max daily is 400, but we already deployed 150
    expect(riskManager.getMaxDailyCapital()).toBe(400);
    expect(riskManager.getRemainingDailyCapital()).toBe(250);
    expect(riskManager.canOpenPositionWithCapital(200).allowed).toBe(true);
  });
});


// =============================================================================
// POSITION DRAWDOWN TESTS (Req 5.8)
// =============================================================================

describe('CopyTradingRiskManager - Position Drawdown (Req 5.8)', () => {
  /**
   * Helper function to create a mock CopyPosition for testing
   */
  function createMockPosition(entryPrice: bigint): {
    id: string;
    signalId: string;
    sourceWallet: string;
    tokenAddress: string;
    poolAddress: string;
    entryPrice: bigint;
    positionSizeUsdc: number;
    tokenAmount: bigint;
    takeProfit: bigint;
    stopLoss: bigint;
    trailingStopTrigger: bigint;
    trailingStopLevel: bigint | null;
    timeStop: number;
    status: 'OPEN';
    openedAt: number;
    closedAt: null;
    exitPrice: null;
    pnlUsdc: null;
    exitReason: null;
  } {
    return {
      id: 'test-position-1',
      signalId: 'test-signal-1',
      sourceWallet: '0x1234567890123456789012345678901234567890',
      tokenAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      poolAddress: '0x0987654321098765432109876543210987654321',
      entryPrice,
      positionSizeUsdc: 100,
      tokenAmount: 1000000000000000000n, // 1 token
      takeProfit: (entryPrice * 150n) / 100n, // +50%
      stopLoss: (entryPrice * 80n) / 100n, // -20%
      trailingStopTrigger: (entryPrice * 110n) / 100n, // +10%
      trailingStopLevel: null,
      timeStop: Date.now() + 48 * 60 * 60 * 1000,
      status: 'OPEN',
      openedAt: Date.now(),
      closedAt: null,
      exitPrice: null,
      pnlUsdc: null,
      exitReason: null,
    };
  }

  describe('checkPositionDrawdown()', () => {
    describe('Drawdown calculation', () => {
      it('should calculate 0% drawdown when price equals entry', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n); // 1 USDC = 1e8

        const result = riskManager.checkPositionDrawdown(position, 100000000n);

        expect(result.shouldForceClose).toBe(false);
        expect(result.drawdownPct).toBeCloseTo(0, 2);
      });

      it('should calculate positive drawdown when price drops', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n); // Entry at 100

        // Price dropped 10%
        const currentPrice = 90000000n; // 90
        const result = riskManager.checkPositionDrawdown(position, currentPrice);

        expect(result.shouldForceClose).toBe(false);
        expect(result.drawdownPct).toBeCloseTo(10, 2);
      });

      it('should calculate negative drawdown (profit) when price rises', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n); // Entry at 100

        // Price rose 20%
        const currentPrice = 120000000n; // 120
        const result = riskManager.checkPositionDrawdown(position, currentPrice);

        expect(result.shouldForceClose).toBe(false);
        expect(result.drawdownPct).toBeCloseTo(-20, 2);
      });

      it('should calculate exactly 25% drawdown correctly', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n); // Entry at 100

        // Price dropped exactly 25%
        const currentPrice = 75000000n; // 75
        const result = riskManager.checkPositionDrawdown(position, currentPrice);

        expect(result.shouldForceClose).toBe(false); // 25% is NOT > 25%
        expect(result.drawdownPct).toBeCloseTo(25, 2);
      });
    });

    describe('Force close trigger (>25%)', () => {
      it('should NOT trigger force close at exactly 25% drawdown', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n);

        // Exactly 25% drawdown
        const currentPrice = 75000000n;
        const result = riskManager.checkPositionDrawdown(position, currentPrice);

        expect(result.shouldForceClose).toBe(false);
        expect(result.drawdownPct).toBeCloseTo(25, 2);
      });

      it('should trigger force close when drawdown exceeds 25%', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n);

        // 25.1% drawdown
        const currentPrice = 74900000n;
        const result = riskManager.checkPositionDrawdown(position, currentPrice);

        expect(result.shouldForceClose).toBe(true);
        expect(result.drawdownPct).toBeGreaterThan(25);
      });

      it('should trigger force close at 30% drawdown', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n);

        // 30% drawdown
        const currentPrice = 70000000n;
        const result = riskManager.checkPositionDrawdown(position, currentPrice);

        expect(result.shouldForceClose).toBe(true);
        expect(result.drawdownPct).toBeCloseTo(30, 2);
      });

      it('should trigger force close at 50% drawdown', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n);

        // 50% drawdown
        const currentPrice = 50000000n;
        const result = riskManager.checkPositionDrawdown(position, currentPrice);

        expect(result.shouldForceClose).toBe(true);
        expect(result.drawdownPct).toBeCloseTo(50, 2);
      });

      it('should NOT trigger force close below 25% threshold', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n);

        // Test various drawdowns below 25%
        const testCases = [
          { price: 99000000n, expectedDrawdown: 1 },
          { price: 95000000n, expectedDrawdown: 5 },
          { price: 90000000n, expectedDrawdown: 10 },
          { price: 85000000n, expectedDrawdown: 15 },
          { price: 80000000n, expectedDrawdown: 20 },
          { price: 76000000n, expectedDrawdown: 24 },
        ];

        for (const { price, expectedDrawdown } of testCases) {
          const result = riskManager.checkPositionDrawdown(position, price);
          expect(result.shouldForceClose).toBe(false);
          expect(result.drawdownPct).toBeCloseTo(expectedDrawdown, 1);
        }
      });
    });

    describe('Custom drawdown threshold', () => {
      it('should respect custom maxPositionDrawdownPct', () => {
        const riskManager = createCopyTradingRiskManager({
          maxPositionDrawdownPct: 0.15, // 15% threshold
        });
        const position = createMockPosition(100000000n);

        // 16% drawdown - should trigger with 15% threshold
        const result = riskManager.checkPositionDrawdown(position, 84000000n);

        expect(result.shouldForceClose).toBe(true);
        expect(result.drawdownPct).toBeCloseTo(16, 2);
      });

      it('should allow higher drawdown with custom 50% threshold', () => {
        const riskManager = createCopyTradingRiskManager({
          maxPositionDrawdownPct: 0.50, // 50% threshold
        });
        const position = createMockPosition(100000000n);

        // 40% drawdown - should NOT trigger with 50% threshold
        const result = riskManager.checkPositionDrawdown(position, 60000000n);

        expect(result.shouldForceClose).toBe(false);
        expect(result.drawdownPct).toBeCloseTo(40, 2);
      });
    });

    describe('Edge cases', () => {
      it('should handle very small price values', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(1000n);

        // 90% drawdown
        const result = riskManager.checkPositionDrawdown(position, 100n);

        expect(result.shouldForceClose).toBe(true);
        expect(result.drawdownPct).toBeCloseTo(90, 2);
      });

      it('should handle very large price values', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(1000000000000000000n);

        // 26% drawdown
        const currentPrice = 740000000000000000n;
        const result = riskManager.checkPositionDrawdown(position, currentPrice);

        expect(result.shouldForceClose).toBe(true);
        expect(result.drawdownPct).toBeCloseTo(26, 2);
      });

      it('should handle zero current price as 100% drawdown (rug)', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n);

        const result = riskManager.checkPositionDrawdown(position, 0n);

        expect(result.shouldForceClose).toBe(true);
        expect(result.drawdownPct).toBe(100);
      });

      it('should handle negative current price as rug scenario', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(100000000n);

        // Negative price (invalid) should trigger force close
        const result = riskManager.checkPositionDrawdown(position, -1n);

        expect(result.shouldForceClose).toBe(true);
      });

      it('should handle zero entry price gracefully', () => {
        const riskManager = createTestRiskManager(1000);
        const position = createMockPosition(0n);

        const result = riskManager.checkPositionDrawdown(position, 100000000n);

        // Should not force close due to invalid data
        expect(result.shouldForceClose).toBe(false);
        expect(result.drawdownPct).toBe(0);
      });
    });

    describe('getMaxPositionDrawdownPct()', () => {
      it('should return default 25% threshold', () => {
        const riskManager = createTestRiskManager(1000);
        expect(riskManager.getMaxPositionDrawdownPct()).toBe(0.25);
      });

      it('should return custom threshold', () => {
        const riskManager = createCopyTradingRiskManager({
          maxPositionDrawdownPct: 0.35,
        });
        expect(riskManager.getMaxPositionDrawdownPct()).toBe(0.35);
      });
    });
  });
});


// =============================================================================
// REQUIREMENT 5.4: CIRCUIT BREAKER TRADE BLOCKING TESTS
// =============================================================================

describe('Requirement 5.4: Circuit Breaker Trade Blocking', () => {
  /**
   * Requirement 5.4: WHILE the circuit breaker is active, THE Copy_Trading_System
   * SHALL reject all new trade signals
   */

  it('should reject trades when circuit breaker is active', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    // Activate circuit breaker by simulating 3 consecutive losses
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50); // 3rd loss triggers CB

    const result = riskManager.canOpenPosition(0);

    expect(result.allowed).toBe(false);
    expect(result.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
    expect(result.circuitBreakerActive).toBe(true);
  });

  it('should reject ALL trade signals while circuit breaker is active', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Try multiple trade attempts with varying position counts - all should be rejected
    const attempts = [0, 1, 2, 3, 5, 10].map((openPositions) =>
      riskManager.canOpenPosition(openPositions)
    );

    attempts.forEach((result) => {
      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
      expect(result.circuitBreakerActive).toBe(true);
    });
  });

  it('should reject trades regardless of position count when CB is active', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Even with 0 open positions, should reject
    const resultWithZeroPositions = riskManager.canOpenPosition(0);
    expect(resultWithZeroPositions.allowed).toBe(false);
    expect(resultWithZeroPositions.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');

    // And with 1 position
    const resultWithOnePosition = riskManager.canOpenPosition(1);
    expect(resultWithOnePosition.allowed).toBe(false);
    expect(resultWithOnePosition.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
  });

  it('should return available slots as 0 when circuit breaker is active', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    const availableSlots = riskManager.availablePositionSlots(0);

    expect(availableSlots).toBe(0);
  });
});

// =============================================================================
// CIRCUIT BREAKER EXPIRATION AFTER 24 HOURS
// =============================================================================

describe('Circuit Breaker Expiration After 24 Hours', () => {
  const CIRCUIT_BREAKER_DURATION_MS = 24 * 60 * 60 * 1000; // 24 hours

  it('should allow trades after circuit breaker expires (24h)', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
      circuitBreakerDurationMs: CIRCUIT_BREAKER_DURATION_MS,
    });

    const now = Date.now();
    riskManager._overrideNow(now);

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Verify CB is active
    expect(riskManager.canOpenPosition(0).allowed).toBe(false);
    expect(riskManager.getCircuitBreakerState().active).toBe(true);

    // Advance time by 24 hours + 1 second
    const after24Hours = now + CIRCUIT_BREAKER_DURATION_MS + 1000;
    riskManager._overrideNow(after24Hours);

    // CB should have expired, trade should be allowed
    const result = riskManager.canOpenPosition(0);

    expect(result.allowed).toBe(true);
    expect(result.circuitBreakerActive).toBe(false);
    expect(result.rejectReason).toBeUndefined();
  });

  it('should NOT allow trades before circuit breaker expires', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
      circuitBreakerDurationMs: CIRCUIT_BREAKER_DURATION_MS,
    });

    const now = Date.now();
    riskManager._overrideNow(now);

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Advance time by 23 hours (still within CB period)
    const before24Hours = now + 23 * 60 * 60 * 1000;
    riskManager._overrideNow(before24Hours);

    const result = riskManager.canOpenPosition(0);

    expect(result.allowed).toBe(false);
    expect(result.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
    expect(result.circuitBreakerActive).toBe(true);
  });

  it('should reset consecutive losses when circuit breaker expires', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
      circuitBreakerDurationMs: CIRCUIT_BREAKER_DURATION_MS,
    });

    const now = Date.now();
    riskManager._overrideNow(now);

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Verify CB state
    const cbState = riskManager.getCircuitBreakerState();
    expect(cbState.consecutiveLosses).toBe(3);

    // Advance time past expiration
    riskManager._overrideNow(now + CIRCUIT_BREAKER_DURATION_MS + 1000);

    // After auto-reset, consecutive losses should be 0
    const newState = riskManager.getCircuitBreakerState();
    expect(newState.active).toBe(false);
    expect(newState.consecutiveLosses).toBe(0);
  });
});

// =============================================================================
// CIRCUIT BREAKER ACTIVATION SCENARIOS
// =============================================================================

describe('Circuit Breaker Activation Scenarios', () => {
  it('should NOT activate circuit breaker with fewer than 3 consecutive losses', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    // 1 loss
    riskManager.onPositionClosed('SL_HIT', -50);
    expect(riskManager.getCircuitBreakerState().active).toBe(false);

    // 2 losses
    riskManager.onPositionClosed('SL_HIT', -50);
    expect(riskManager.getCircuitBreakerState().active).toBe(false);

    // Trades should still be allowed
    expect(riskManager.canOpenPosition(0).allowed).toBe(true);
  });

  it('should activate circuit breaker on exactly 3 consecutive losses', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    riskManager.onPositionClosed('SL_HIT', -50);
    riskManager.onPositionClosed('SL_HIT', -50);
    riskManager.onPositionClosed('SL_HIT', -50);

    const cbState = riskManager.getCircuitBreakerState();

    expect(cbState.active).toBe(true);
    expect(cbState.consecutiveLosses).toBe(3);
    expect(cbState.activationReason).toBe('LOSS_STREAK');
  });

  it('should activate circuit breaker on RUG_PULL as well as SL_HIT', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    riskManager.onPositionClosed('RUG_PULL', -100);
    riskManager.onPositionClosed('RUG_PULL', -100);
    riskManager.onPositionClosed('RUG_PULL', -100);

    expect(riskManager.getCircuitBreakerState().active).toBe(true);
  });

  it('should reset consecutive losses on profitable close (TP_HIT)', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    riskManager.onPositionClosed('SL_HIT', -50);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Now a profitable close resets the streak
    riskManager.onPositionClosed('TP_HIT', 100);

    expect(riskManager.getCircuitBreakerState().consecutiveLosses).toBe(0);

    // Next 2 losses should not trigger CB
    riskManager.onPositionClosed('SL_HIT', -50);
    riskManager.onPositionClosed('SL_HIT', -50);

    expect(riskManager.getCircuitBreakerState().active).toBe(false);
  });

  it('should reset consecutive losses on trailing stop close', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    riskManager.onPositionClosed('SL_HIT', -50);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Trailing stop is considered a win (mapped to TP_HIT)
    riskManager.onPositionClosed('TRAILING_STOP', 50);

    expect(riskManager.getCircuitBreakerState().consecutiveLosses).toBe(0);
  });
});

// =============================================================================
// MANUAL CIRCUIT BREAKER RESET
// =============================================================================

describe('Manual Circuit Breaker Reset', () => {
  it('should allow trades after manual reset of circuit breaker', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    expect(riskManager.canOpenPosition(0).allowed).toBe(false);

    // Manual reset
    riskManager.resetCircuitBreaker();

    // Trades should be allowed again
    const result = riskManager.canOpenPosition(0);

    expect(result.allowed).toBe(true);
    expect(result.circuitBreakerActive).toBe(false);
  });

  it('should reset consecutive losses on manual reset', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    expect(riskManager.getCircuitBreakerState().consecutiveLosses).toBe(3);

    riskManager.resetCircuitBreaker();

    expect(riskManager.getCircuitBreakerState().consecutiveLosses).toBe(0);
  });
});

// =============================================================================
// INTEGRATION: Circuit Breaker with Position Tracking
// =============================================================================

describe('Circuit Breaker Integration with Position Tracking', () => {
  it('should check circuit breaker BEFORE position limit', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    // Set up position tracker mock
    riskManager.setPositionTracker({
      getOpenPositionsCount: () => 0,
      getOpenPositions: () => [],
    });

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Even with 0 positions, should reject due to CB
    const result = riskManager.canOpenPosition();

    expect(result.allowed).toBe(false);
    expect(result.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
    // This confirms CB is checked first, not position limit
  });

  it('should check position limit when CB is not active', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    // Set up position tracker at max capacity
    riskManager.setPositionTracker({
      getOpenPositionsCount: () => 3,
      getOpenPositions: () => [],
    });

    // No CB active, but at max positions
    const result = riskManager.canOpenPosition();

    expect(result.allowed).toBe(false);
    expect(result.rejectReason).toBe('MAX_POSITIONS_REACHED');
    expect(result.circuitBreakerActive).toBe(false);
  });
});

// =============================================================================
// CIRCUIT BREAKER EDGE CASES
// =============================================================================

describe('Circuit Breaker Edge Cases', () => {
  it('should handle circuit breaker state at exactly the expiration time', () => {
    const CIRCUIT_BREAKER_DURATION_MS = 24 * 60 * 60 * 1000;
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
      circuitBreakerDurationMs: CIRCUIT_BREAKER_DURATION_MS,
    });

    const now = Date.now();
    riskManager._overrideNow(now);

    // Activate circuit breaker
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);

    // FIRST: Verify state BEFORE expiration (1ms before blockedUntil)
    // Circuit breaker should still be active
    riskManager._overrideNow(now + CIRCUIT_BREAKER_DURATION_MS - 1);
    const resultBefore = riskManager.canOpenPosition(0);
    expect(resultBefore.allowed).toBe(false);
    expect(resultBefore.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');

    // THEN: At exactly the expiration time (blockedUntil), CB auto-resets
    // Implementation uses (now < blockedUntil), so at exact time it's expired
    riskManager._overrideNow(now + CIRCUIT_BREAKER_DURATION_MS);
    const result = riskManager.canOpenPosition(0);
    // At exact expiration time, CB has expired and trade is allowed
    expect(result.allowed).toBe(true);
  });

  it('should handle multiple circuit breaker activations', () => {
    const CIRCUIT_BREAKER_DURATION_MS = 24 * 60 * 60 * 1000;
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
      circuitBreakerDurationMs: CIRCUIT_BREAKER_DURATION_MS,
    });

    const now = Date.now();
    riskManager._overrideNow(now);

    // First activation
    riskManager._setConsecutiveLosses(2);
    riskManager.onPositionClosed('SL_HIT', -50);
    expect(riskManager.getCircuitBreakerState().active).toBe(true);

    // Wait for expiration
    riskManager._overrideNow(now + CIRCUIT_BREAKER_DURATION_MS + 1000);
    expect(riskManager.getCircuitBreakerState().active).toBe(false);

    // Trade and lose again
    const newNow = now + CIRCUIT_BREAKER_DURATION_MS + 1000;
    riskManager._overrideNow(newNow);

    riskManager.onPositionClosed('SL_HIT', -50);
    riskManager.onPositionClosed('SL_HIT', -50);
    riskManager.onPositionClosed('SL_HIT', -50);

    // Second activation
    expect(riskManager.getCircuitBreakerState().active).toBe(true);

    // Should block until newNow + 24h
    const expectedExpiration = newNow + CIRCUIT_BREAKER_DURATION_MS;
    expect(riskManager.getCircuitBreakerState().blockedUntil).toBeGreaterThanOrEqual(
      expectedExpiration
    );
  });

  it('should return correct state when no trades have occurred', () => {
    const riskManager = createCopyTradingRiskManager({
      maxConcurrentPositions: 3,
    });

    const result = riskManager.canOpenPosition(0);

    expect(result.allowed).toBe(true);
    expect(result.circuitBreakerActive).toBe(false);
    expect(result.rejectReason).toBeUndefined();
    expect(result.currentPositions).toBe(0);
  });
});


// =============================================================================
// CIRCUIT BREAKER - LOSS STREAK TESTS (Req 5.3, 5.10)
// =============================================================================

describe('CopyTradingRiskManager - Circuit Breaker Loss Streak (Req 5.3)', () => {
  let riskManager: CopyTradingRiskManager;

  beforeEach(() => {
    riskManager = createCopyTradingRiskManager();
  });

  describe('Consecutive Losses Tracking', () => {
    it('should NOT activate circuit breaker after 1 SL_HIT', () => {
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(1);
    });

    it('should NOT activate circuit breaker after 2 consecutive SL_HIT', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(2);
    });

    it('should activate circuit breaker after 3 consecutive SL_HIT', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(true);
      expect(state.consecutiveLosses).toBe(3);
      expect(state.activationReason).toBe('LOSS_STREAK');
    });

    it('should count RUG_PULL as a loss toward the 3-loss streak', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('RUG_PULL', -100);
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(true);
      expect(state.consecutiveLosses).toBe(3);
    });

    it('should activate circuit breaker with 3 consecutive RUG_PULLs', () => {
      riskManager.onPositionClosed('RUG_PULL', -100);
      riskManager.onPositionClosed('RUG_PULL', -100);
      riskManager.onPositionClosed('RUG_PULL', -100);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(true);
      expect(state.activationReason).toBe('LOSS_STREAK');
    });

    it('should activate with mixed SL_HIT and RUG_PULL', () => {
      riskManager.onPositionClosed('RUG_PULL', -100);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('RUG_PULL', -100);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(true);
      expect(state.consecutiveLosses).toBe(3);
    });
  });

  describe('Loss Counter Reset', () => {
    it('should reset consecutive loss counter on TP_HIT', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      // 2 losses accumulated

      riskManager.onPositionClosed('TP_HIT', 100); // Win resets counter

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(0);
    });

    it('should reset consecutive loss counter on TRAILING_STOP (treated as win)', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      riskManager.onPositionClosed('TRAILING_STOP', 75);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(0);
    });

    it('should reset consecutive loss counter on FOLLOW_INSIDER (treated as win)', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('RUG_PULL', -100);

      riskManager.onPositionClosed('FOLLOW_INSIDER', 50);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(0);
    });

    it('should reset consecutive loss counter on TIME_STOP (neutral)', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      riskManager.onPositionClosed('TIME_STOP', 0);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(0);
    });

    it('should reset consecutive loss counter on FORCED_CLOSE (neutral)', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      riskManager.onPositionClosed('FORCED_CLOSE', -25);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(0);
    });

    it('should not activate circuit breaker if win interrupts loss streak', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('TP_HIT', 100); // Win interrupts
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(1); // Only 1 after win
    });
  });

  describe('Circuit Breaker Duration (24 hours)', () => {
    it('should set blockedUntil to 24 hours in the future when activated', () => {
      const now = Date.now();
      riskManager._overrideNow(now);

      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      expect(state.blockedUntil).toBe(now + twentyFourHoursMs);
    });

    it('should remain active just before 24 hours expire', () => {
      const activationTime = Date.now();
      riskManager._overrideNow(activationTime);

      // Activate circuit breaker
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      // Move time forward to just before expiration (1ms before 24 hours)
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      riskManager._overrideNow(activationTime + twentyFourHoursMs - 1);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(true);
    });

    it('should auto-expire after 24 hours', () => {
      const activationTime = Date.now();
      riskManager._overrideNow(activationTime);

      // Activate circuit breaker
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      // Move time forward past expiration
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      riskManager._overrideNow(activationTime + twentyFourHoursMs + 1);

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(0); // Should be reset
    });
  });

  describe('Trade Blocking During Circuit Breaker', () => {
    it('should block trades when circuit breaker IS active', () => {
      // Activate circuit breaker
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      const result = riskManager.canOpenPosition(0);
      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
      expect(result.circuitBreakerActive).toBe(true);
    });

    it('should report 0 available slots when circuit breaker is active', () => {
      // Activate circuit breaker
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      const slots = riskManager.availablePositionSlots(0);
      expect(slots).toBe(0);
    });
  });

  describe('Manual Circuit Breaker Reset', () => {
    it('should allow manual reset of circuit breaker', () => {
      // Activate circuit breaker
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      expect(riskManager.getCircuitBreakerState().active).toBe(true);

      // Reset manually
      riskManager.resetCircuitBreaker();

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(false);
      expect(state.consecutiveLosses).toBe(0);
      expect(state.blockedUntil).toBeNull();
    });
  });

  describe('Circuit Breaker State Details (Req 5.10)', () => {
    it('should include activation reason in circuit breaker state', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();
      expect(state.activationReason).toBe('LOSS_STREAK');
    });

    it('should include blockedUntil timestamp in circuit breaker state', () => {
      const now = Date.now();
      riskManager._overrideNow(now);

      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();
      expect(state.blockedUntil).toBeTypeOf('number');
      expect(state.blockedUntil).toBeGreaterThan(now);
    });

    it('should have blockedUntil as null when not active', () => {
      const state = riskManager.getCircuitBreakerState();
      expect(state.blockedUntil).toBeNull();
    });

    it('should log activation with reason and timestamp (verified by structure)', () => {
      // This test verifies the circuit breaker state has proper structure
      // for logging. Actual log verification would require log spy.
      const now = Date.now();
      riskManager._overrideNow(now);

      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);

      const state = riskManager.getCircuitBreakerState();

      // Verify all logging-required fields are present
      expect(state.activationReason).toBeDefined();
      expect(state.blockedUntil).toBeDefined();
      expect(state.consecutiveLosses).toBeDefined();
    });
  });

  describe('More than 3 consecutive losses', () => {
    it('should remain active with more than 3 losses', () => {
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('SL_HIT', -50); // 4th loss

      const state = riskManager.getCircuitBreakerState();
      expect(state.active).toBe(true);
      expect(state.consecutiveLosses).toBe(4);
    });
  });
});


// =============================================================================
// DAILY PNL CIRCUIT BREAKER TESTS (Req 5.5, 5.6)
// =============================================================================

describe('CopyTradingRiskManager - Daily PnL Circuit Breaker (Req 5.5, 5.6)', () => {
  describe('Req 5.5: Daily PnL Tracking', () => {
    it('should track cumulative daily PnL', () => {
      const riskManager = createTestRiskManager(1000);

      expect(riskManager.getDailyPnl()).toBe(0);

      // First position closes with +$50 profit
      riskManager.onPositionClosed('TP_HIT', 50);
      expect(riskManager.getDailyPnl()).toBe(50);

      // Second position closes with -$30 loss
      riskManager.onPositionClosed('SL_HIT', -30);
      expect(riskManager.getDailyPnl()).toBe(20); // 50 - 30 = 20

      // Third position closes with +$10 profit
      riskManager.onPositionClosed('TRAILING_STOP', 10);
      expect(riskManager.getDailyPnl()).toBe(30); // 20 + 10 = 30
    });

    it('should accumulate negative PnL correctly', () => {
      const riskManager = createTestRiskManager(1000);

      expect(riskManager.getDailyPnl()).toBe(0);

      riskManager.onPositionClosed('SL_HIT', -50);
      expect(riskManager.getDailyPnl()).toBe(-50);

      riskManager.onPositionClosed('RUG_PULL', -40);
      expect(riskManager.getDailyPnl()).toBe(-90);

      riskManager.onPositionClosed('SL_HIT', -20);
      expect(riskManager.getDailyPnl()).toBe(-110);
    });

    it('should track PnL across different close types', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.onPositionClosed('TP_HIT', 100);
      riskManager.onPositionClosed('SL_HIT', -50);
      riskManager.onPositionClosed('TRAILING_STOP', 30);
      riskManager.onPositionClosed('FOLLOW_INSIDER', 20);
      riskManager.onPositionClosed('TIME_STOP', -10);
      riskManager.onPositionClosed('FORCED_CLOSE', 0);
      riskManager.onPositionClosed('RUG_PULL', -25);

      // 100 - 50 + 30 + 20 - 10 + 0 - 25 = 65
      expect(riskManager.getDailyPnl()).toBe(65);
    });
  });

  describe('Req 5.6: Circuit Breaker Activation on -15% Daily PnL', () => {
    it('should activate circuit breaker when daily PnL reaches -15% of capital', () => {
      const riskManager = createTestRiskManager(1000);

      // Total capital = $1,000
      // Threshold = -15% = -$150

      // Close positions with losses totaling -$150
      // Use non-consecutive losses (intercalate with TP_HIT) to avoid triggering loss streak CB first
      riskManager.onPositionClosed('SL_HIT', -100);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      // Intercalate with a small win to reset loss streak counter
      riskManager.onPositionClosed('TP_HIT', 1);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      riskManager.onPositionClosed('SL_HIT', -49);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      // This loss of -$2 brings total to exactly -$150 (threshold): -100 +1 -49 -2 = -150
      riskManager.onPositionClosed('SL_HIT', -2);
      expect(riskManager.getDailyPnl()).toBe(-150);
      expect(riskManager.getCircuitBreakerState().active).toBe(true);
      expect(riskManager.getCircuitBreakerState().activationReason).toBe('DAILY_PNL_LIMIT');
    });

    it('should activate circuit breaker when daily PnL exceeds -15% of capital', () => {
      const riskManager = createTestRiskManager(1000);

      // Single large loss exceeding threshold
      riskManager.onPositionClosed('RUG_PULL', -200);
      expect(riskManager.getDailyPnl()).toBe(-200);
      expect(riskManager.getCircuitBreakerState().active).toBe(true);
      expect(riskManager.getCircuitBreakerState().activationReason).toBe('DAILY_PNL_LIMIT');
    });

    it('should NOT activate circuit breaker for smaller losses', () => {
      const riskManager = createTestRiskManager(1000);

      // Losses below threshold
      // Use non-consecutive losses to avoid triggering loss streak CB
      riskManager.onPositionClosed('SL_HIT', -50);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      // Intercalate with a tiny win to reset loss streak counter
      riskManager.onPositionClosed('TP_HIT', 1);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      riskManager.onPositionClosed('SL_HIT', -50);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      // Intercalate again
      riskManager.onPositionClosed('TP_HIT', 1);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      // Total loss = -$50 +1 -$50 +1 -$51 = -$149, still above threshold (-$150)
      riskManager.onPositionClosed('SL_HIT', -51);
      expect(riskManager.getDailyPnl()).toBe(-149);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);
    });

    it('should NOT activate circuit breaker if total capital is not set', () => {
      const riskManager = createCopyTradingRiskManager();
      // No setTotalCapital called, totalCapitalUsdc = 0

      riskManager.onPositionClosed('SL_HIT', -500);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);
    });

    it('should account for profits reducing the daily PnL', () => {
      const riskManager = createTestRiskManager(1000);

      // Start with profit
      riskManager.onPositionClosed('TP_HIT', 100);
      expect(riskManager.getDailyPnl()).toBe(100);

      // Loss that doesn't exceed threshold when offset by profit
      riskManager.onPositionClosed('SL_HIT', -200);
      expect(riskManager.getDailyPnl()).toBe(-100); // Still above -150 threshold
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      // Another loss that pushes below threshold
      riskManager.onPositionClosed('SL_HIT', -60);
      expect(riskManager.getDailyPnl()).toBe(-160); // Below -150 threshold
      expect(riskManager.getCircuitBreakerState().active).toBe(true);
    });

    it('should set circuit breaker duration to 24 hours', () => {
      const riskManager = createTestRiskManager(1000);
      const now = Date.now();
      riskManager._overrideNow(now);

      riskManager.onPositionClosed('RUG_PULL', -200);

      const cbState = riskManager.getCircuitBreakerState();
      expect(cbState.active).toBe(true);
      expect(cbState.blockedUntil).toBe(now + 24 * 60 * 60 * 1000);
    });

    it('should block new trades when circuit breaker is active due to PnL', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.onPositionClosed('SL_HIT', -200);
      expect(riskManager.getCircuitBreakerState().active).toBe(true);

      const result = riskManager.canOpenPosition(0);
      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
      expect(result.circuitBreakerActive).toBe(true);
    });

    it('should auto-reset circuit breaker after 24 hours', () => {
      const riskManager = createTestRiskManager(1000);
      const now = Date.now();
      riskManager._overrideNow(now);

      // Activate circuit breaker
      riskManager.onPositionClosed('SL_HIT', -200);
      expect(riskManager.getCircuitBreakerState().active).toBe(true);

      // Move time forward by 24 hours + 1ms
      riskManager._overrideNow(now + 24 * 60 * 60 * 1000 + 1);

      // Circuit breaker should auto-reset
      expect(riskManager.getCircuitBreakerState().active).toBe(false);
    });
  });

  describe('Interaction between Loss Streak and Daily PnL Circuit Breakers', () => {
    it('should not reactivate if already active from loss streak', () => {
      const riskManager = createTestRiskManager(1000);

      // Trigger loss streak circuit breaker first (3 consecutive losses)
      riskManager.onPositionClosed('SL_HIT', -10);
      riskManager.onPositionClosed('SL_HIT', -10);
      riskManager.onPositionClosed('SL_HIT', -10);

      expect(riskManager.getCircuitBreakerState().active).toBe(true);
      expect(riskManager.getCircuitBreakerState().activationReason).toBe('LOSS_STREAK');

      // Further losses shouldn't change the reason
      riskManager.onPositionClosed('SL_HIT', -200);
      expect(riskManager.getCircuitBreakerState().activationReason).toBe('LOSS_STREAK');
    });

    it('should activate on PnL before loss streak if threshold exceeded first', () => {
      const riskManager = createTestRiskManager(1000);

      // Single large loss exceeds PnL threshold before 3 consecutive losses
      riskManager.onPositionClosed('SL_HIT', -200);

      expect(riskManager.getCircuitBreakerState().active).toBe(true);
      expect(riskManager.getCircuitBreakerState().activationReason).toBe('DAILY_PNL_LIMIT');
    });

    it('should activate on loss streak if 3 losses before PnL threshold', () => {
      const riskManager = createTestRiskManager(1000);

      // 3 small consecutive losses (don't exceed PnL threshold)
      riskManager.onPositionClosed('SL_HIT', -10);
      riskManager.onPositionClosed('SL_HIT', -10);
      riskManager.onPositionClosed('SL_HIT', -10);

      // Daily PnL = -$30, above threshold (-$150)
      expect(riskManager.getDailyPnl()).toBe(-30);

      // But circuit breaker should be active due to loss streak
      expect(riskManager.getCircuitBreakerState().active).toBe(true);
      expect(riskManager.getCircuitBreakerState().activationReason).toBe('LOSS_STREAK');
    });
  });

  describe('Edge Cases for Daily PnL Circuit Breaker', () => {
    it('should handle exactly -15% threshold (boundary)', () => {
      const riskManager = createTestRiskManager(1000);

      // Exactly -15% = -$150
      riskManager.onPositionClosed('SL_HIT', -150);
      expect(riskManager.getDailyPnl()).toBe(-150);
      expect(riskManager.getCircuitBreakerState().active).toBe(true);
    });

    it('should handle just above -15% threshold (no activation)', () => {
      const riskManager = createTestRiskManager(1000);

      // Just above -15% = -$149.99
      riskManager.onPositionClosed('SL_HIT', -149.99);
      expect(riskManager.getDailyPnl()).toBe(-149.99);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);
    });

    it('should handle very small capital', () => {
      const riskManager = createTestRiskManager(100); // $100 capital

      // Threshold = -$15
      riskManager.onPositionClosed('SL_HIT', -15);
      expect(riskManager.getCircuitBreakerState().active).toBe(true);
    });

    it('should handle very large capital', () => {
      const riskManager = createTestRiskManager(1000000); // $1M capital

      // Threshold = -$150,000
      riskManager.onPositionClosed('SL_HIT', -149000);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);

      riskManager.onPositionClosed('SL_HIT', -2000);
      expect(riskManager.getDailyPnl()).toBe(-151000);
      expect(riskManager.getCircuitBreakerState().active).toBe(true);
    });

    it('should handle zero PnL close', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.onPositionClosed('FORCED_CLOSE', 0);
      expect(riskManager.getDailyPnl()).toBe(0);
      expect(riskManager.getCircuitBreakerState().active).toBe(false);
    });

    it('should allow manual circuit breaker reset', () => {
      const riskManager = createTestRiskManager(1000);

      riskManager.onPositionClosed('SL_HIT', -200);
      expect(riskManager.getCircuitBreakerState().active).toBe(true);

      riskManager.resetCircuitBreaker();
      expect(riskManager.getCircuitBreakerState().active).toBe(false);
    });
  });
});


// =============================================================================
// CAPITAL RESERVE TESTS (Req 5.9)
// =============================================================================

describe('CopyTradingRiskManager - Capital Reserve (Req 5.9)', () => {
  /**
   * Helper to create mock positions for position tracker
   */
  function createMockPositionWithSize(positionSizeUsdc: number): {
    id: string;
    signalId: string;
    sourceWallet: string;
    tokenAddress: string;
    poolAddress: string;
    entryPrice: bigint;
    positionSizeUsdc: number;
    tokenAmount: bigint;
    takeProfit: bigint;
    stopLoss: bigint;
    trailingStopTrigger: bigint;
    trailingStopLevel: bigint | null;
    timeStop: number;
    status: 'OPEN';
    openedAt: number;
    closedAt: null;
    exitPrice: null;
    pnlUsdc: null;
    exitReason: null;
  } {
    return {
      id: `pos-${Math.random().toString(36).substr(2, 9)}`,
      signalId: 'test-signal-1',
      sourceWallet: '0x1234567890123456789012345678901234567890',
      tokenAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      poolAddress: '0x0987654321098765432109876543210987654321',
      entryPrice: 100000000n,
      positionSizeUsdc,
      tokenAmount: 1000000000000000000n,
      takeProfit: 150000000n,
      stopLoss: 80000000n,
      trailingStopTrigger: 110000000n,
      trailingStopLevel: null,
      timeStop: Date.now() + 48 * 60 * 60 * 1000,
      status: 'OPEN',
      openedAt: Date.now(),
      closedAt: null,
      exitPrice: null,
      pnlUsdc: null,
      exitReason: null,
    };
  }

  describe('MIN_CAPITAL_RESERVE_PCT constant', () => {
    it('should be 20% (0.20)', () => {
      expect(MIN_CAPITAL_RESERVE_PCT).toBe(0.20);
    });
  });

  describe('getMaxDeployableCapital()', () => {
    it('should return 80% of total capital', () => {
      const riskManager = createTestRiskManager(1000);
      expect(riskManager.getMaxDeployableCapital()).toBe(800); // 1000 * 0.80
    });

    it('should return 0 when total capital is 0', () => {
      const riskManager = createTestRiskManager(0);
      expect(riskManager.getMaxDeployableCapital()).toBe(0);
    });

    it('should calculate correctly for various capital amounts', () => {
      expect(createTestRiskManager(500).getMaxDeployableCapital()).toBe(400);
      expect(createTestRiskManager(2000).getMaxDeployableCapital()).toBe(1600);
      expect(createTestRiskManager(10000).getMaxDeployableCapital()).toBe(8000);
    });

    it('should respect custom minCapitalReservePct', () => {
      const riskManager = createCopyTradingRiskManager({
        minCapitalReservePct: 0.30, // 30% reserve
      });
      riskManager.setTotalCapital(1000);
      expect(riskManager.getMaxDeployableCapital()).toBe(700); // 1000 * 0.70
    });
  });

  describe('getMinimumCapitalReserve()', () => {
    it('should return 20% of total capital', () => {
      const riskManager = createTestRiskManager(1000);
      expect(riskManager.getMinimumCapitalReserve()).toBe(200); // 1000 * 0.20
    });

    it('should return 0 when total capital is 0', () => {
      const riskManager = createTestRiskManager(0);
      expect(riskManager.getMinimumCapitalReserve()).toBe(0);
    });
  });

  describe('getMinCapitalReservePct()', () => {
    it('should return default 20%', () => {
      const riskManager = createTestRiskManager(1000);
      expect(riskManager.getMinCapitalReservePct()).toBe(0.20);
    });

    it('should return custom value', () => {
      const riskManager = createCopyTradingRiskManager({
        minCapitalReservePct: 0.25,
      });
      expect(riskManager.getMinCapitalReservePct()).toBe(0.25);
    });
  });

  describe('getCurrentDeployedCapitalInPositions()', () => {
    it('should return 0 when no position tracker is set', () => {
      const riskManager = createTestRiskManager(1000);
      expect(riskManager.getCurrentDeployedCapitalInPositions()).toBe(0);
    });

    it('should return 0 when no open positions', () => {
      const riskManager = createTestRiskManager(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });
      expect(riskManager.getCurrentDeployedCapitalInPositions()).toBe(0);
    });

    it('should sum positionSizeUsdc from all open positions', () => {
      const riskManager = createTestRiskManager(1000);
      
      const positions = [
        createMockPositionWithSize(100),
        createMockPositionWithSize(150),
        createMockPositionWithSize(50),
      ];
      
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      expect(riskManager.getCurrentDeployedCapitalInPositions()).toBe(300);
    });
  });

  describe('getRemainingDeployableCapital()', () => {
    it('should return full max deployable when no positions open', () => {
      const riskManager = createTestRiskManager(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      expect(riskManager.getRemainingDeployableCapital()).toBe(800); // 80% of 1000
    });

    it('should decrease as positions are opened', () => {
      const riskManager = createTestRiskManager(1000);
      
      const positions = [createMockPositionWithSize(300)];
      
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      expect(riskManager.getRemainingDeployableCapital()).toBe(500); // 800 - 300
    });

    it('should return 0 when at max deployable', () => {
      const riskManager = createTestRiskManager(1000);
      
      const positions = [createMockPositionWithSize(800)];
      
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      expect(riskManager.getRemainingDeployableCapital()).toBe(0);
    });

    it('should return 0 (not negative) when over max deployable', () => {
      const riskManager = createTestRiskManager(1000);
      
      // Positions that somehow exceed 80% (shouldn't happen normally)
      const positions = [createMockPositionWithSize(900)];
      
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      expect(riskManager.getRemainingDeployableCapital()).toBe(0);
    });
  });

  describe('wouldViolateCapitalReserve()', () => {
    it('should return false when under limit', () => {
      const riskManager = createTestRiskManager(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      // Can deploy up to 800
      expect(riskManager.wouldViolateCapitalReserve(100)).toBe(false);
      expect(riskManager.wouldViolateCapitalReserve(500)).toBe(false);
      expect(riskManager.wouldViolateCapitalReserve(800)).toBe(false);
    });

    it('should return true when would exceed max deployable', () => {
      const riskManager = createTestRiskManager(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      expect(riskManager.wouldViolateCapitalReserve(801)).toBe(true);
      expect(riskManager.wouldViolateCapitalReserve(900)).toBe(true);
      expect(riskManager.wouldViolateCapitalReserve(1000)).toBe(true);
    });

    it('should consider already deployed capital in positions', () => {
      const riskManager = createTestRiskManager(1000);
      
      // Already deployed 500
      const positions = [createMockPositionWithSize(500)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Remaining deployable is 300 (800 - 500)
      expect(riskManager.wouldViolateCapitalReserve(200)).toBe(false);
      expect(riskManager.wouldViolateCapitalReserve(300)).toBe(false);
      expect(riskManager.wouldViolateCapitalReserve(301)).toBe(true);
    });

    it('should return false when total capital is 0 (no limit enforcement)', () => {
      const riskManager = createTestRiskManager(0);
      expect(riskManager.wouldViolateCapitalReserve(1000)).toBe(false);
    });

    it('should handle edge case at exact limit', () => {
      const riskManager = createTestRiskManager(1000);
      
      const positions = [createMockPositionWithSize(500)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Exactly 300 remaining
      expect(riskManager.wouldViolateCapitalReserve(300)).toBe(false);
      expect(riskManager.wouldViolateCapitalReserve(300.01)).toBe(true);
    });
  });

  describe('getCapitalReserveInfo()', () => {
    it('should return complete capital reserve info', () => {
      const riskManager = createTestRiskManager(1000);
      
      const positions = [
        createMockPositionWithSize(200),
        createMockPositionWithSize(100),
      ];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      const info = riskManager.getCapitalReserveInfo();

      expect(info.totalCapital).toBe(1000);
      expect(info.maxDeployable).toBe(800);
      expect(info.currentlyDeployed).toBe(300);
      expect(info.remainingDeployable).toBe(500);
      expect(info.minimumReserve).toBe(200);
    });
  });

  describe('canOpenPositionWithCapital() - Capital Reserve Integration', () => {
    it('should allow trade when under capital reserve limit', () => {
      const riskManager = createTestRiskManager(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      const result = riskManager.canOpenPositionWithCapital(100);

      expect(result.allowed).toBe(true);
      expect(result.capitalReserve).toBeDefined();
      expect(result.capitalReserve?.totalCapital).toBe(1000);
      expect(result.capitalReserve?.maxDeployable).toBe(800);
      expect(result.capitalReserve?.currentlyDeployed).toBe(0);
      expect(result.capitalReserve?.remainingDeployable).toBe(800);
      expect(result.capitalReserve?.minimumReserve).toBe(200);
    });

    it('should reject trade when would violate capital reserve', () => {
      const riskManager = createTestRiskManager(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      // Try to deploy 850, but max is 800
      const result = riskManager.canOpenPositionWithCapital(850);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CAPITAL_RESERVE_VIOLATED');
      expect(result.capitalReserve?.currentlyDeployed).toBe(0);
      expect(result.capitalReserve?.remainingDeployable).toBe(800);
    });

    it('should reject trade when cumulative would violate reserve', () => {
      const riskManager = createTestRiskManager(1000);
      
      // Already deployed 600
      const positions = [createMockPositionWithSize(600)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Try to deploy 300, but only 200 remaining (800 - 600)
      const result = riskManager.canOpenPositionWithCapital(300);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CAPITAL_RESERVE_VIOLATED');
      expect(result.capitalReserve?.currentlyDeployed).toBe(600);
      expect(result.capitalReserve?.remainingDeployable).toBe(200);
    });

    it('should allow trade at exact remaining deployable', () => {
      // Use higher daily capital limit so reserve is the limiting factor
      const riskManager = createCopyTradingRiskManager({ maxDailyCapitalPct: 0.90 });
      riskManager.setTotalCapital(1000);
      
      const positions = [createMockPositionWithSize(500)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Max deployable is 800, already have 500, so 300 remaining
      const result = riskManager.canOpenPositionWithCapital(300);

      expect(result.allowed).toBe(true);
    });

    it('should check capital reserve before daily capital limit', () => {
      const riskManager = createTestRiskManager(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      // Max deployable is 800, daily limit is 200
      // Deploying 500 would pass daily limit but violate capital reserve? No, 500 < 800
      // Actually, 500 < 800 so it passes reserve check but 500 > 200 daily
      // Let's test reserve specifically - deploy 850
      const result = riskManager.canOpenPositionWithCapital(850);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CAPITAL_RESERVE_VIOLATED');
    });

    it('should still check circuit breaker first', () => {
      const riskManager = createTestRiskManager(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      // Activate circuit breaker
      riskManager._setConsecutiveLosses(3);
      riskManager.onPositionClosed('SL_HIT', -50);

      const result = riskManager.canOpenPositionWithCapital(100);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CIRCUIT_BREAKER_ACTIVE');
      expect(result.circuitBreakerActive).toBe(true);
      // Capital reserve info should still be present
      expect(result.capitalReserve).toBeDefined();
    });

    it('should still check max positions', () => {
      const riskManager = createTestRiskManager(1000);

      // 3 positions totaling 300
      const positions = [
        createMockPositionWithSize(100),
        createMockPositionWithSize(100),
        createMockPositionWithSize(100),
      ];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 3, // At max
        getOpenPositions: () => positions,
      });

      const result = riskManager.canOpenPositionWithCapital(100);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('MAX_POSITIONS_REACHED');
      expect(result.capitalReserve).toBeDefined();
    });

    it('should not enforce capital reserve when total capital is 0', () => {
      const riskManager = createTestRiskManager(0);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      const result = riskManager.canOpenPositionWithCapital(1000);

      // Should not be rejected for capital reserve
      expect(result.rejectReason).not.toBe('CAPITAL_RESERVE_VIOLATED');
    });
  });

  describe('Capital Reserve - Never Deploy More Than 80%', () => {
    it('should never allow deploying more than 80% of total capital', () => {
      // Use higher daily capital limit (90%) so capital reserve is the limiting factor
      const riskManager = createCopyTradingRiskManager({ maxDailyCapitalPct: 0.90 });
      riskManager.setTotalCapital(1000);
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });

      // Test boundary: 80% should be allowed
      expect(riskManager.canOpenPositionWithCapital(800).allowed).toBe(true);

      // Test boundary: >80% should be rejected
      expect(riskManager.canOpenPositionWithCapital(801).allowed).toBe(false);
      expect(riskManager.canOpenPositionWithCapital(801).rejectReason).toBe('CAPITAL_RESERVE_VIOLATED');
    });

    it('should maintain 20% reserve with multiple positions', () => {
      // Use higher daily capital limit (90%) so capital reserve is the limiting factor
      const riskManager = createCopyTradingRiskManager({ maxDailyCapitalPct: 0.90 });
      riskManager.setTotalCapital(1000);

      // First position: 300
      let positions = [createMockPositionWithSize(300)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Should have 500 remaining deployable (800 - 300)
      expect(riskManager.getRemainingDeployableCapital()).toBe(500);
      expect(riskManager.canOpenPositionWithCapital(500).allowed).toBe(true);
      expect(riskManager.canOpenPositionWithCapital(501).allowed).toBe(false);

      // Second position: 300 more (total 600)
      positions = [createMockPositionWithSize(300), createMockPositionWithSize(300)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Should have 200 remaining deployable (800 - 600)
      expect(riskManager.getRemainingDeployableCapital()).toBe(200);
      expect(riskManager.canOpenPositionWithCapital(200).allowed).toBe(true);
      expect(riskManager.canOpenPositionWithCapital(201).allowed).toBe(false);

      // At max deployable: 800
      positions = [createMockPositionWithSize(800)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Should have 0 remaining
      expect(riskManager.getRemainingDeployableCapital()).toBe(0);
      expect(riskManager.canOpenPositionWithCapital(1).allowed).toBe(false);
      expect(riskManager.canOpenPositionWithCapital(1).rejectReason).toBe('CAPITAL_RESERVE_VIOLATED');
    });

    it('should work correctly with various capital amounts', () => {
      // Test with $500 capital - use high daily limit so reserve is limiting factor
      const rm500 = createCopyTradingRiskManager({ maxDailyCapitalPct: 0.90 });
      rm500.setTotalCapital(500);
      rm500.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });
      expect(rm500.getMaxDeployableCapital()).toBe(400);
      expect(rm500.canOpenPositionWithCapital(400).allowed).toBe(true);
      expect(rm500.canOpenPositionWithCapital(401).allowed).toBe(false);

      // Test with $2000 capital
      const rm2000 = createCopyTradingRiskManager({ maxDailyCapitalPct: 0.90 });
      rm2000.setTotalCapital(2000);
      rm2000.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });
      expect(rm2000.getMaxDeployableCapital()).toBe(1600);
      expect(rm2000.canOpenPositionWithCapital(1600).allowed).toBe(true);
      expect(rm2000.canOpenPositionWithCapital(1601).allowed).toBe(false);
    });
  });

  describe('Capital Reserve vs Daily Capital Limit Interaction', () => {
    it('should reject by capital reserve when it is the more restrictive limit', () => {
      const riskManager = createTestRiskManager(1000);
      
      // Already deployed 750 in positions
      const positions = [createMockPositionWithSize(750)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Remaining deployable: 50 (800 - 750)
      // But daily capital limit: 200 (not yet deployed today)
      // Try to deploy 100 - should fail due to reserve
      const result = riskManager.canOpenPositionWithCapital(100);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('CAPITAL_RESERVE_VIOLATED');
    });

    it('should reject by daily capital when it is the more restrictive limit', () => {
      const riskManager = createTestRiskManager(1000);
      
      // No positions, but already deployed 150 today
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => 0,
        getOpenPositions: () => [],
      });
      riskManager.registerCapitalDeployment(150);

      // Remaining daily: 50 (200 - 150)
      // Remaining reserve: 800 (nothing in positions)
      // Try to deploy 100 - should fail due to daily limit
      const result = riskManager.canOpenPositionWithCapital(100);

      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('DAILY_CAPITAL_EXCEEDED');
    });

    it('should both limits be enforced independently', () => {
      const riskManager = createTestRiskManager(1000);
      
      // Positions using 700
      const positions = [createMockPositionWithSize(700)];
      riskManager.setPositionTracker({
        getOpenPositionsCount: () => positions.length,
        getOpenPositions: () => positions,
      });

      // Daily capital at 180 (some resets today)
      riskManager.registerCapitalDeployment(180);

      // Remaining reserve: 100 (800 - 700)
      // Remaining daily: 20 (200 - 180)

      // Try 50: fails reserve (100 remaining) - NO! 50 < 100 so passes
      // Actually 50 > 20 daily, so fails daily
      // Let's try 15: passes both
      let result = riskManager.canOpenPositionWithCapital(15);
      expect(result.allowed).toBe(true);

      // Try 25: passes reserve (100) but fails daily (20)
      result = riskManager.canOpenPositionWithCapital(25);
      expect(result.allowed).toBe(false);
      expect(result.rejectReason).toBe('DAILY_CAPITAL_EXCEEDED');
    });
  });
});

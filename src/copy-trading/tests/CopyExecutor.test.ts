/**
 * CopyExecutor Unit Tests
 *
 * Tests for position sizing calculation:
 * - Req 4.1: Position size = min(insider × 10%, $100, capital × 5%)
 * - Req 4.2: Tier multipliers (S=1.5x, A=1.0x, B=0.5x)
 * - Req 4.3: Reject positions <$10 USDC
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CopyExecutor,
  createCopyExecutor,
  DEFAULT_TIER_MULTIPLIERS,
  MIN_POSITION_USDC,
  DEFAULT_COPY_RATIO,
  DEFAULT_MAX_POSITION_USDC,
  DEFAULT_MAX_CAPITAL_PCT,
  type CopyExecutorConfig,
  type PositionSizeResult,
} from '../modules/CopyExecutor.js';
import type { EnrichedSignal, WalletTier } from '../interfaces/types.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a mock EnrichedSignal for testing
 */
function createMockSignal(overrides: Partial<EnrichedSignal> = {}): EnrichedSignal {
  return {
    id: 'test-signal-1',
    sourceWallet: '0x1234567890123456789012345678901234567890',
    walletTier: 'A_TIER' as WalletTier,
    tokenAddress: '0xABCDEF1234567890123456789012345678901234',
    poolAddress: '0x9876543210987654321098765432109876543210',
    action: 'BUY',
    tradeAmountUsdc: 1000, // $1,000 USDC insider trade
    entryPrice: BigInt(1000000), // 1 USDC per token
    blockNumber: 12345678,
    txHash: '0x' + 'a'.repeat(64),
    detectedAt: Date.now(),
    detectionLatencyMs: 100,
    approved: true,
    enrichment: {
      liquidityUsdc: 50000,
      liquidityWeth: 20,
      estimatedSlippagePct: 1,
      transferTaxPct: 0,
      lpLockedPct: 100,
      deployerStatus: 'clean',
      tokenAgeHours: 72,
    },
    enrichedAt: Date.now(),
    enrichmentLatencyMs: 50,
    ...overrides,
  };
}

/**
 * Create a CopyExecutor with specific configuration
 */
function createTestExecutor(
  availableCapitalUsdc: number = 500,
  overrides: Partial<CopyExecutorConfig> = {},
): CopyExecutor {
  return createCopyExecutor({
    availableCapitalUsdc,
    ...overrides,
  });
}

// =============================================================================
// POSITION SIZING TESTS
// =============================================================================

describe('CopyExecutor - Position Sizing', () => {
  describe('Req 4.1: Base Position Size Calculation', () => {
    it('should calculate position as min of three values', () => {
      // Given: insider trade = $1,000, max position = $100, capital = $500
      // copyRatio = 10%, maxCapitalPct = 5%
      // fromInsider = 1000 × 0.10 = $100
      // fromCapital = 500 × 0.05 = $25
      // maxPosition = $100
      // min(100, 100, 25) = $25
      // A_TIER multiplier = 1.0
      // Final = $25 × 1.0 = $25
      
      const executor = createTestExecutor(500);
      const signal = createMockSignal({ 
        tradeAmountUsdc: 1000,
        walletTier: 'A_TIER',
      });

      const result = executor.calculatePositionSize(signal, 500);

      expect(result.approved).toBe(true);
      expect(result.positionSizeUsdc).toBe(25);
      expect(result.breakdown.fromInsiderTrade).toBe(100); // 1000 × 0.10
      expect(result.breakdown.maxPosition).toBe(100);
      expect(result.breakdown.fromCapital).toBe(25); // 500 × 0.05
      expect(result.breakdown.basePosition).toBe(25); // min of the three
    });

    it('should cap at max position when insider trade is large', () => {
      // Given: insider trade = $10,000, capital = $5,000
      // fromInsider = 10000 × 0.10 = $1,000
      // fromCapital = 5000 × 0.05 = $250
      // maxPosition = $100 (default)
      // min(1000, 100, 250) = $100
      // A_TIER multiplier = 1.0
      // Final = $100 × 1.0 = $100

      const executor = createTestExecutor(5000);
      const signal = createMockSignal({
        tradeAmountUsdc: 10000,
        walletTier: 'A_TIER',
      });

      const result = executor.calculatePositionSize(signal, 5000);

      expect(result.approved).toBe(true);
      expect(result.positionSizeUsdc).toBe(100);
      expect(result.breakdown.fromInsiderTrade).toBe(1000);
      expect(result.breakdown.basePosition).toBe(100);
    });

    it('should use insider trade ratio when it is the smallest', () => {
      // Given: insider trade = $50 (small trade), capital = $10,000
      // fromInsider = 50 × 0.10 = $5
      // fromCapital = 10000 × 0.05 = $500
      // maxPosition = $100
      // min(5, 100, 500) = $5
      // S_TIER multiplier = 1.5
      // Final = $5 × 1.5 = $7.5 (still below $10 minimum)

      const executor = createTestExecutor(10000);
      const signal = createMockSignal({
        tradeAmountUsdc: 50,
        walletTier: 'S_TIER',
      });

      const result = executor.calculatePositionSize(signal, 10000);

      // $7.5 is below minimum $10, should be rejected
      expect(result.approved).toBe(false);
      expect(result.positionSizeUsdc).toBe(7.5);
      expect(result.breakdown.fromInsiderTrade).toBe(5);
      expect(result.breakdown.basePosition).toBe(5);
    });
  });

  describe('Req 4.2: Tier Multipliers', () => {
    it('should apply S_TIER multiplier of 1.5x', () => {
      // Base position = $25 (from capital constraint)
      // S_TIER = 1.5x
      // Final = $25 × 1.5 = $37.5

      const executor = createTestExecutor(500);
      const signal = createMockSignal({
        tradeAmountUsdc: 1000,
        walletTier: 'S_TIER',
      });

      const result = executor.calculatePositionSize(signal, 500);

      expect(result.approved).toBe(true);
      expect(result.positionSizeUsdc).toBe(37.5);
      expect(result.breakdown.tierMultiplier).toBe(1.5);
      expect(result.breakdown.walletTier).toBe('S_TIER');
    });

    it('should apply A_TIER multiplier of 1.0x', () => {
      const executor = createTestExecutor(500);
      const signal = createMockSignal({
        tradeAmountUsdc: 1000,
        walletTier: 'A_TIER',
      });

      const result = executor.calculatePositionSize(signal, 500);

      expect(result.approved).toBe(true);
      expect(result.positionSizeUsdc).toBe(25);
      expect(result.breakdown.tierMultiplier).toBe(1.0);
    });

    it('should apply B_TIER multiplier of 0.5x', () => {
      // Base position = $25
      // B_TIER = 0.5x
      // Final = $25 × 0.5 = $12.5

      const executor = createTestExecutor(500);
      const signal = createMockSignal({
        tradeAmountUsdc: 1000,
        walletTier: 'B_TIER',
      });

      const result = executor.calculatePositionSize(signal, 500);

      expect(result.approved).toBe(true);
      expect(result.positionSizeUsdc).toBe(12.5);
      expect(result.breakdown.tierMultiplier).toBe(0.5);
    });

    it('should verify default tier multipliers match spec', () => {
      expect(DEFAULT_TIER_MULTIPLIERS.S_TIER).toBe(1.5);
      expect(DEFAULT_TIER_MULTIPLIERS.A_TIER).toBe(1.0);
      expect(DEFAULT_TIER_MULTIPLIERS.B_TIER).toBe(0.5);
    });
  });

  describe('Req 4.3: Minimum Position Threshold', () => {
    it('should reject positions below $10 USDC', () => {
      // Given: Very small insider trade
      // fromInsider = 50 × 0.10 = $5
      // B_TIER = 0.5x
      // Final = $5 × 0.5 = $2.5 (below $10)

      const executor = createTestExecutor(10000);
      const signal = createMockSignal({
        tradeAmountUsdc: 50,
        walletTier: 'B_TIER',
      });

      const result = executor.calculatePositionSize(signal, 10000);

      expect(result.approved).toBe(false);
      expect(result.positionSizeUsdc).toBe(2.5);
      expect(result.rejectReason).toBe('POSITION_TOO_SMALL');
    });

    it('should approve positions at exactly $10 USDC', () => {
      // We need to engineer a position that equals exactly $10
      // Base = $20, B_TIER = 0.5x → Final = $10
      // fromCapital = capital × 0.05 = $20 → capital = $400
      
      const executor = createTestExecutor(400);
      const signal = createMockSignal({
        tradeAmountUsdc: 1000, // fromInsider = 100
        walletTier: 'B_TIER', // 0.5x
      });

      const result = executor.calculatePositionSize(signal, 400);
      
      // fromCapital = 400 × 0.05 = $20
      // min(100, 100, 20) = $20
      // Final = 20 × 0.5 = $10
      expect(result.approved).toBe(true);
      expect(result.positionSizeUsdc).toBe(10);
    });

    it('should reject positions at $9.99 USDC', () => {
      // Base = $19.98, B_TIER = 0.5x → Final = $9.99
      // fromCapital = 19.98 = capital × 0.05 → capital = $399.6
      
      const executor = createTestExecutor(398);
      const signal = createMockSignal({
        tradeAmountUsdc: 1000,
        walletTier: 'B_TIER',
      });

      const result = executor.calculatePositionSize(signal, 398);
      
      // fromCapital = 398 × 0.05 = $19.9
      // Final = 19.9 × 0.5 = $9.95
      expect(result.approved).toBe(false);
      expect(result.rejectReason).toBe('POSITION_TOO_SMALL');
    });

    it('should verify minimum position constant matches spec', () => {
      expect(MIN_POSITION_USDC).toBe(10);
    });
  });
});

// =============================================================================
// EXECUTOR INTEGRATION TESTS
// =============================================================================

describe('CopyExecutor - Execute Method', () => {
  let executor: CopyExecutor;

  beforeEach(() => {
    executor = createTestExecutor(1000);
  });

  it('should execute trade and create position', async () => {
    const signal = createMockSignal({
      tradeAmountUsdc: 500,
      walletTier: 'S_TIER',
    });

    const result = await executor.execute(signal);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.positionId).toBeDefined();
      expect(typeof result.executedPrice).toBe('bigint');
    }
  });

  it('should reject trade with position too small', async () => {
    const signal = createMockSignal({
      tradeAmountUsdc: 20, // Very small trade
      walletTier: 'B_TIER',
    });

    const result = await executor.execute(signal);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('POSITION_TOO_SMALL');
    }
  });

  it('should track open positions after execution', async () => {
    const signal = createMockSignal({
      tradeAmountUsdc: 500,
      walletTier: 'A_TIER',
    });

    expect(executor.getOpenPositions()).toHaveLength(0);

    const result = await executor.execute(signal);
    expect(result.success).toBe(true);

    expect(executor.getOpenPositions()).toHaveLength(1);
  });

  it('should reduce available capital after execution', async () => {
    const initialCapital = executor.getAvailableCapital();
    const signal = createMockSignal({
      tradeAmountUsdc: 500,
      walletTier: 'A_TIER',
    });

    await executor.execute(signal);

    expect(executor.getAvailableCapital()).toBeLessThan(initialCapital);
  });

  it('should update execution stats', async () => {
    const signal = createMockSignal({
      tradeAmountUsdc: 500,
      walletTier: 'A_TIER',
    });

    const statsBefore = executor.getStats();
    expect(statsBefore.totalExecuted).toBe(0);

    await executor.execute(signal);

    const statsAfter = executor.getStats();
    expect(statsAfter.totalExecuted).toBe(1);
  });
});

// =============================================================================
// POSITION MANAGEMENT TESTS
// =============================================================================

describe('CopyExecutor - Position Management', () => {
  let executor: CopyExecutor;

  beforeEach(() => {
    executor = createTestExecutor(1000);
  });

  it('should get position by ID', async () => {
    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    const result = await executor.execute(signal);

    expect(result.success).toBe(true);
    if (result.success) {
      const position = executor.getPosition(result.positionId);
      expect(position).not.toBeNull();
      expect(position?.id).toBe(result.positionId);
    }
  });

  it('should return null for non-existent position', () => {
    const position = executor.getPosition('non-existent-id');
    expect(position).toBeNull();
  });

  it('should force close position', async () => {
    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    const result = await executor.execute(signal);

    expect(result.success).toBe(true);
    if (result.success) {
      const closed = await executor.forceClose(result.positionId);
      expect(closed).toBe(true);

      // Position should be removed from open positions
      expect(executor.getOpenPositions()).toHaveLength(0);
    }
  });

  it('should return false when force closing non-existent position', async () => {
    const closed = await executor.forceClose('non-existent-id');
    expect(closed).toBe(false);
  });

  it('should return capital after force close', async () => {
    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    const capitalBefore = executor.getAvailableCapital();

    const result = await executor.execute(signal);
    expect(result.success).toBe(true);

    const capitalAfterExecute = executor.getAvailableCapital();
    expect(capitalAfterExecute).toBeLessThan(capitalBefore);

    if (result.success) {
      await executor.forceClose(result.positionId);
      const capitalAfterClose = executor.getAvailableCapital();
      expect(capitalAfterClose).toBe(capitalBefore);
    }
  });
});

// =============================================================================
// FACTORY FUNCTION TESTS
// =============================================================================

describe('CopyExecutor - Factory Function', () => {
  it('should create executor with default config', () => {
    const executor = createCopyExecutor();

    const positionConfig = executor.getPositionSizingConfig();
    expect(positionConfig.copyRatio).toBe(DEFAULT_COPY_RATIO);
    expect(positionConfig.maxPositionUsdc).toBe(DEFAULT_MAX_POSITION_USDC);
    expect(positionConfig.minPositionUsdc).toBe(MIN_POSITION_USDC);
    expect(positionConfig.maxCapitalPct).toBe(DEFAULT_MAX_CAPITAL_PCT);
  });

  it('should create executor with custom config', () => {
    const executor = createCopyExecutor({
      availableCapitalUsdc: 2000,
      positionSizing: {
        copyRatio: 0.15,
        maxPositionUsdc: 200,
        minPositionUsdc: 20,
        maxCapitalPct: 0.10,
        tierMultipliers: {
          S_TIER: 2.0,
          A_TIER: 1.5,
          B_TIER: 1.0,
        },
      },
    });

    const positionConfig = executor.getPositionSizingConfig();
    expect(positionConfig.copyRatio).toBe(0.15);
    expect(positionConfig.maxPositionUsdc).toBe(200);
    expect(positionConfig.minPositionUsdc).toBe(20);
    expect(positionConfig.maxCapitalPct).toBe(0.10);
    expect(executor.getAvailableCapital()).toBe(2000);
  });
});

// =============================================================================
// EDGE CASES
// =============================================================================

describe('CopyExecutor - Edge Cases', () => {
  it('should handle zero capital gracefully', () => {
    const executor = createTestExecutor(0);
    const signal = createMockSignal({ tradeAmountUsdc: 1000 });

    const result = executor.calculatePositionSize(signal, 0);

    // fromCapital = 0 × 0.05 = $0
    // min(100, 100, 0) = $0
    // Final = $0 × 1.0 = $0 (below minimum)
    expect(result.approved).toBe(false);
    expect(result.rejectReason).toBe('POSITION_TOO_SMALL');
  });

  it('should handle very large insider trade', () => {
    const executor = createTestExecutor(1000);
    const signal = createMockSignal({
      tradeAmountUsdc: 1000000, // $1M insider trade
      walletTier: 'S_TIER',
    });

    const result = executor.calculatePositionSize(signal, 1000);

    // fromInsider = 1000000 × 0.10 = $100,000
    // fromCapital = 1000 × 0.05 = $50
    // maxPosition = $100
    // min(100000, 100, 50) = $50
    // S_TIER = 1.5x
    // Final = $50 × 1.5 = $75
    expect(result.approved).toBe(true);
    expect(result.positionSizeUsdc).toBe(75);
  });

  it('should round position to 2 decimal places', () => {
    // Create a scenario that produces a fractional result
    const executor = createCopyExecutor({
      availableCapitalUsdc: 333,
      positionSizing: {
        copyRatio: 0.10,
        maxPositionUsdc: 100,
        minPositionUsdc: 10,
        maxCapitalPct: 0.05,
        tierMultipliers: {
          S_TIER: 1.5,
          A_TIER: 1.0,
          B_TIER: 0.5,
        },
      },
    });
    const signal = createMockSignal({ tradeAmountUsdc: 1000 });

    const result = executor.calculatePositionSize(signal, 333);

    // fromCapital = 333 × 0.05 = 16.65
    // A_TIER = 1.0x
    // Final should be rounded to 2 decimals
    expect(result.positionSizeUsdc).toBe(16.65);
    expect(result.positionSizeUsdc.toString()).toMatch(/^\d+(\.\d{1,2})?$/);
  });
});


// =============================================================================
// POSITION LIMIT TESTS (Req 5.1)
// =============================================================================

describe('CopyExecutor - Position Limits (Req 5.1)', () => {
  it('should reject trade when max positions (3) reached', async () => {
    const { CopyTradingRiskManager } = await import('../modules/CopyTradingRiskManager.js');
    
    const riskManager = new CopyTradingRiskManager({ maxConcurrentPositions: 3 });
    const executor = createCopyExecutor({
      availableCapitalUsdc: 5000,
      riskManager,
    });

    // Execute 3 trades successfully
    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    
    const result1 = await executor.execute(signal);
    expect(result1.success).toBe(true);
    
    const result2 = await executor.execute({ ...signal, id: 'signal-2' });
    expect(result2.success).toBe(true);
    
    const result3 = await executor.execute({ ...signal, id: 'signal-3' });
    expect(result3.success).toBe(true);

    // 4th trade should be rejected with MAX_POSITIONS_REACHED
    const result4 = await executor.execute({ ...signal, id: 'signal-4' });
    expect(result4.success).toBe(false);
    if (!result4.success) {
      expect(result4.reason).toBe('MAX_POSITIONS_REACHED');
    }
  });

  it('should allow new trade after closing a position', async () => {
    const { CopyTradingRiskManager } = await import('../modules/CopyTradingRiskManager.js');
    
    const riskManager = new CopyTradingRiskManager({ maxConcurrentPositions: 3 });
    const executor = createCopyExecutor({
      availableCapitalUsdc: 5000,
      riskManager,
    });

    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    
    // Fill up all 3 positions
    const result1 = await executor.execute(signal);
    const result2 = await executor.execute({ ...signal, id: 'signal-2' });
    const result3 = await executor.execute({ ...signal, id: 'signal-3' });
    
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result3.success).toBe(true);

    // Close one position
    if (result1.success) {
      await executor.forceClose(result1.positionId);
    }

    // Now should be able to open a new position
    const result4 = await executor.execute({ ...signal, id: 'signal-4' });
    expect(result4.success).toBe(true);
  });

  it('should track position count correctly', async () => {
    const { CopyTradingRiskManager } = await import('../modules/CopyTradingRiskManager.js');
    
    const riskManager = new CopyTradingRiskManager({ maxConcurrentPositions: 3 });
    const executor = createCopyExecutor({
      availableCapitalUsdc: 5000,
      riskManager,
    });

    expect(executor.getOpenPositionsCount()).toBe(0);

    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    
    await executor.execute(signal);
    expect(executor.getOpenPositionsCount()).toBe(1);

    await executor.execute({ ...signal, id: 'signal-2' });
    expect(executor.getOpenPositionsCount()).toBe(2);

    // Force close one
    const positions = executor.getOpenPositions();
    await executor.forceClose(positions[0].id);
    expect(executor.getOpenPositionsCount()).toBe(1);
  });

  it('should reject trade when circuit breaker is active', async () => {
    const { CopyTradingRiskManager } = await import('../modules/CopyTradingRiskManager.js');
    
    const riskManager = new CopyTradingRiskManager({ maxConcurrentPositions: 3 });
    // Simulate 3 consecutive losses to activate circuit breaker
    riskManager._setConsecutiveLosses(3);
    riskManager.onPositionClosed('SL_HIT', -50); // This should trigger CB

    const executor = createCopyExecutor({
      availableCapitalUsdc: 5000,
      riskManager,
    });

    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    const result = await executor.execute(signal);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBe('CIRCUIT_BREAKER_ACTIVE');
    }
  });

  it('should work without risk manager (backward compatibility)', async () => {
    // Create executor without risk manager
    const executor = createCopyExecutor({ availableCapitalUsdc: 5000 });

    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    
    // Should execute multiple trades without position limit check
    const result1 = await executor.execute(signal);
    const result2 = await executor.execute({ ...signal, id: 'signal-2' });
    const result3 = await executor.execute({ ...signal, id: 'signal-3' });
    const result4 = await executor.execute({ ...signal, id: 'signal-4' });

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result3.success).toBe(true);
    expect(result4.success).toBe(true);
  });
});

// =============================================================================
// RISK MANAGER INTEGRATION TESTS
// =============================================================================

describe('CopyExecutor - Risk Manager Integration', () => {
  it('should connect risk manager via setRiskManager', async () => {
    const { CopyTradingRiskManager } = await import('../modules/CopyTradingRiskManager.js');
    
    const executor = createCopyExecutor({ availableCapitalUsdc: 5000 });
    const riskManager = new CopyTradingRiskManager({ maxConcurrentPositions: 2 });

    // Connect risk manager after construction
    executor.setRiskManager(riskManager);

    const signal = createMockSignal({ tradeAmountUsdc: 500 });
    
    // Fill up 2 positions (the limit)
    await executor.execute(signal);
    await executor.execute({ ...signal, id: 'signal-2' });

    // 3rd trade should be rejected
    const result3 = await executor.execute({ ...signal, id: 'signal-3' });
    expect(result3.success).toBe(false);
    if (!result3.success) {
      expect(result3.reason).toBe('MAX_POSITIONS_REACHED');
    }
  });

  it('should get risk manager after setting it', async () => {
    const { CopyTradingRiskManager } = await import('../modules/CopyTradingRiskManager.js');
    
    const executor = createCopyExecutor({ availableCapitalUsdc: 5000 });
    expect(executor.getRiskManager()).toBeNull();

    const riskManager = new CopyTradingRiskManager();
    executor.setRiskManager(riskManager);

    expect(executor.getRiskManager()).toBe(riskManager);
  });

  it('should use createCopyExecutorWithRiskManager factory', async () => {
    const { createCopyExecutorWithRiskManager } = await import('../modules/CopyExecutor.js');

    const executor = createCopyExecutorWithRiskManager(
      { availableCapitalUsdc: 5000 },
      { maxConcurrentPositions: 2 },
    );

    expect(executor.getRiskManager()).not.toBeNull();
    expect(executor.getRiskManager()?.getMaxConcurrentPositions()).toBe(2);
  });
});

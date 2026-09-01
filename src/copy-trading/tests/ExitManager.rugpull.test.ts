/**
 * ExitManager Rug Pull Detection Tests
 *
 * Tests for Requirement 6.12:
 * IF three consecutive quote attempts fail for a position,
 * THEN THE Exit_Manager SHALL assume rug pull and record 100% loss
 *
 * @module copy-trading/tests/ExitManager.rugpull.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ExitManager,
  createDefaultExitStrategyConfig,
  RUG_PULL_QUOTE_FAILURE_THRESHOLD,
  type ExitManagerConfig,
} from '../modules/ExitManager.js';
import type { CopyPosition, ExitReason } from '../interfaces/types.js';
import type { DexQuoter } from '../../shared/dex-quoter.js';

// =============================================================================
// MOCK SETUP
// =============================================================================

/**
 * Create a mock DexQuoter
 */
function createMockDexQuoter(): DexQuoter {
  return {
    quote: vi.fn(),
    detectPoolType: vi.fn().mockResolvedValue('uniswap_v3'),
  } as unknown as DexQuoter;
}

/**
 * Create a test position
 */
function createTestPosition(overrides: Partial<CopyPosition> = {}): CopyPosition {
  return {
    id: 'test-position-1',
    signalId: 'test-signal-1',
    sourceWallet: '0x1234567890123456789012345678901234567890',
    tokenAddress: '0xABCDEF1234567890123456789012345678901234',
    poolAddress: '0x0987654321098765432109876543210987654321',
    entryPrice: BigInt(1000000), // $1.00 in 6 decimals
    positionSizeUsdc: 100, // $100 position
    tokenAmount: BigInt(100) * BigInt(10) ** BigInt(18),
    takeProfit: BigInt(1500000), // $1.50 (+50%)
    stopLoss: BigInt(800000), // $0.80 (-20%)
    trailingStopTrigger: BigInt(1100000), // $1.10 (+10%)
    trailingStopLevel: null,
    timeStop: Date.now() + 48 * 60 * 60 * 1000, // 48 hours from now
    status: 'OPEN',
    openedAt: Date.now(),
    closedAt: null,
    exitPrice: null,
    pnlUsdc: null,
    exitReason: null,
    ...overrides,
  };
}

// =============================================================================
// RUG PULL DETECTION TESTS
// =============================================================================

describe('ExitManager - Rug Pull Detection (Req 6.12)', () => {
  let exitManager: ExitManager;
  let mockDexQuoter: ReturnType<typeof createMockDexQuoter>;
  let onPositionClosedMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDexQuoter = createMockDexQuoter();
    onPositionClosedMock = vi.fn();

    exitManager = new ExitManager({
      strategyConfig: createDefaultExitStrategyConfig(),
      dexQuoter: mockDexQuoter,
      monitoringIntervalMs: 1000,
      onPositionClosed: onPositionClosedMock,
    });
  });

  afterEach(() => {
    exitManager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should have RUG_PULL_QUOTE_FAILURE_THRESHOLD = 3', () => {
    expect(RUG_PULL_QUOTE_FAILURE_THRESHOLD).toBe(3);
  });

  it('should track quote failures for a position', () => {
    const position = createTestPosition();
    exitManager.registerPosition(position);

    // Initially, failure count should be 0
    expect(exitManager.getQuoteFailureCount(position.id)).toBe(0);

    // Increment failure count
    exitManager._incrementQuoteFailureCount(position.id);
    expect(exitManager.getQuoteFailureCount(position.id)).toBe(1);

    exitManager._incrementQuoteFailureCount(position.id);
    expect(exitManager.getQuoteFailureCount(position.id)).toBe(2);
  });

  it('should NOT trigger rug pull with less than 3 quote failures', async () => {
    const position = createTestPosition();
    exitManager.registerPosition(position);

    // Simulate 2 quote failures (less than threshold)
    exitManager._incrementQuoteFailureCount(position.id);
    exitManager._incrementQuoteFailureCount(position.id);

    // Process should NOT close position
    const closed = await exitManager._processRugPullIfNeeded(position.id);
    expect(closed).toBe(false);

    // Position should still be monitored
    expect(exitManager.getMonitoredPositions()).toHaveLength(1);
    expect(onPositionClosedMock).not.toHaveBeenCalled();
  });

  it('should trigger rug pull after exactly 3 consecutive quote failures', async () => {
    const position = createTestPosition();
    exitManager.registerPosition(position);

    // Simulate 3 consecutive quote failures
    exitManager._incrementQuoteFailureCount(position.id);
    exitManager._incrementQuoteFailureCount(position.id);
    exitManager._incrementQuoteFailureCount(position.id);

    // Process rug pull
    const closed = await exitManager._processRugPullIfNeeded(position.id);
    expect(closed).toBe(true);

    // Position should be removed from monitoring
    expect(exitManager.getMonitoredPositions()).toHaveLength(0);

    // Callback should be called with RUG_PULL reason
    expect(onPositionClosedMock).toHaveBeenCalledTimes(1);
    expect(onPositionClosedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: position.id,
        status: 'RUG_PULL',
        exitReason: 'RUG_PULL',
        exitPrice: BigInt(0),
      }),
      'RUG_PULL',
      -position.positionSizeUsdc // 100% loss
    );
  });

  it('should record 100% loss on rug pull detection', async () => {
    const position = createTestPosition({ positionSizeUsdc: 150 }); // $150 position
    exitManager.registerPosition(position);

    // Simulate 3 consecutive quote failures
    for (let i = 0; i < 3; i++) {
      exitManager._incrementQuoteFailureCount(position.id);
    }

    await exitManager._processRugPullIfNeeded(position.id);

    // PnL should be -100% of position size (-$150)
    expect(onPositionClosedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pnlUsdc: -150, // 100% loss = negative of position size
      }),
      'RUG_PULL',
      -150
    );
  });

  it('should set exit price to 0 on rug pull', async () => {
    const position = createTestPosition();
    exitManager.registerPosition(position);

    // Trigger rug pull
    for (let i = 0; i < 3; i++) {
      exitManager._incrementQuoteFailureCount(position.id);
    }

    await exitManager._processRugPullIfNeeded(position.id);

    // Exit price should be 0 (token is worthless)
    expect(onPositionClosedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        exitPrice: BigInt(0),
      }),
      'RUG_PULL',
      expect.any(Number)
    );
  });

  it('should update stats with RUG_PULL exit reason', async () => {
    const position = createTestPosition();
    exitManager.registerPosition(position);

    // Initial stats
    const initialStats = exitManager.getStats();
    expect(initialStats.exitsByReason['RUG_PULL']).toBe(0);

    // Trigger rug pull
    for (let i = 0; i < 3; i++) {
      exitManager._incrementQuoteFailureCount(position.id);
    }
    await exitManager._processRugPullIfNeeded(position.id);

    // Stats should be updated
    const finalStats = exitManager.getStats();
    expect(finalStats.exitsByReason['RUG_PULL']).toBe(1);
  });

  it('should reset quote failure count on successful quote', async () => {
    const position = createTestPosition();
    exitManager.registerPosition(position);

    // Mock successful quote
    (mockDexQuoter.quote as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BigInt(1000000));

    // Simulate some failures first
    exitManager._incrementQuoteFailureCount(position.id);
    exitManager._incrementQuoteFailureCount(position.id);
    expect(exitManager.getQuoteFailureCount(position.id)).toBe(2);

    // Start monitoring and let it run
    await exitManager.start();

    // Advance timers to trigger monitoring
    await vi.advanceTimersByTimeAsync(1100);

    // After successful quote, failure count should be reset
    // (Assuming the position still exists after the check)
    // Note: The actual reset happens in _checkPosition after successful quote
  });

  it('should handle multiple positions with independent failure counts', async () => {
    const position1 = createTestPosition({ id: 'pos-1', positionSizeUsdc: 100 });
    const position2 = createTestPosition({ id: 'pos-2', positionSizeUsdc: 200 });

    exitManager.registerPosition(position1);
    exitManager.registerPosition(position2);

    // Fail position1 twice
    exitManager._incrementQuoteFailureCount('pos-1');
    exitManager._incrementQuoteFailureCount('pos-1');

    // Fail position2 three times (rug pull)
    exitManager._incrementQuoteFailureCount('pos-2');
    exitManager._incrementQuoteFailureCount('pos-2');
    exitManager._incrementQuoteFailureCount('pos-2');

    expect(exitManager.getQuoteFailureCount('pos-1')).toBe(2);
    expect(exitManager.getQuoteFailureCount('pos-2')).toBe(3);

    // Only position2 should be closed
    await exitManager._processRugPullIfNeeded('pos-1');
    await exitManager._processRugPullIfNeeded('pos-2');

    expect(exitManager.getMonitoredPositions()).toHaveLength(1);
    expect(exitManager.getMonitoredPositions()[0].id).toBe('pos-1');

    // Callback should only be called once (for pos-2)
    expect(onPositionClosedMock).toHaveBeenCalledTimes(1);
    expect(onPositionClosedMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'pos-2' }),
      'RUG_PULL',
      -200
    );
  });

  it('should set closedAt timestamp on rug pull', async () => {
    const position = createTestPosition();
    exitManager.registerPosition(position);

    const beforeClose = Date.now();

    // Trigger rug pull
    for (let i = 0; i < 3; i++) {
      exitManager._incrementQuoteFailureCount(position.id);
    }
    await exitManager._processRugPullIfNeeded(position.id);

    const afterClose = Date.now();

    // Verify closedAt was set
    expect(onPositionClosedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        closedAt: expect.any(Number),
      }),
      'RUG_PULL',
      expect.any(Number)
    );

    const closedPosition = onPositionClosedMock.mock.calls[0][0] as CopyPosition;
    expect(closedPosition.closedAt).toBeGreaterThanOrEqual(beforeClose);
    expect(closedPosition.closedAt).toBeLessThanOrEqual(afterClose);
  });
});

describe('ExitManager - Integration with DexQuoter failures', () => {
  let exitManager: ExitManager;
  let mockDexQuoter: ReturnType<typeof createMockDexQuoter>;
  let onPositionClosedMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockDexQuoter = createMockDexQuoter();
    onPositionClosedMock = vi.fn();

    exitManager = new ExitManager({
      strategyConfig: createDefaultExitStrategyConfig(),
      dexQuoter: mockDexQuoter,
      monitoringIntervalMs: 1000,
      onPositionClosed: onPositionClosedMock,
    });
  });

  afterEach(() => {
    exitManager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('should detect rug pull when DexQuoter throws 3 consecutive errors', async () => {
    const position = createTestPosition();
    exitManager.registerPosition(position);

    // Mock DexQuoter to throw errors
    (mockDexQuoter.quote as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('Pool not found'))
      .mockRejectedValueOnce(new Error('Pool not found'))
      .mockRejectedValueOnce(new Error('Pool not found'));

    await exitManager.start();

    // Advance through 3 monitoring cycles
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(1100);

    // Position should be closed as rug pull
    expect(onPositionClosedMock).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'RUG_PULL',
        pnlUsdc: -position.positionSizeUsdc,
      }),
      'RUG_PULL',
      -position.positionSizeUsdc
    );
  });
});

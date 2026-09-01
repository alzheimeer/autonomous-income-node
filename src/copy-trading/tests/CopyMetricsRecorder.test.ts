/**
 * CopyMetricsRecorder Unit Tests - Task 19.3
 *
 * Tests for position persistence (Requirement 8.2):
 * - THE CopyMetricsRecorder SHALL persist all position entries and exits 
 *   with entry_price, exit_price, PnL, duration, and exit_reason
 *
 * Uses mocked pg pool to avoid database dependency in unit tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import type { CopyPosition, CopySignal, WalletTier } from '../interfaces/types.js';

// =============================================================================
// MOCK SETUP
// =============================================================================

const mockQuery = vi.fn();
const mockConnect = vi.fn();
const mockRelease = vi.fn();

vi.mock('../../trading-validation/postgres.js', () => ({
  pgPool: {
    query: (...args: unknown[]) => mockQuery(...args),
    connect: (...args: unknown[]) => mockConnect(...args),
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// =============================================================================
// TEST HELPERS
// =============================================================================

function createMockSignal(overrides: Partial<CopySignal> = {}): CopySignal {
  return {
    id: 'sig-test-1',
    sourceWallet: '0x1234567890123456789012345678901234567890',
    walletTier: 'A_TIER' as WalletTier,
    tokenAddress: '0xABCDEF1234567890123456789012345678901234',
    poolAddress: '0x9876543210987654321098765432109876543210',
    action: 'BUY',
    tradeAmountUsdc: 1000,
    entryPrice: BigInt('1000000000000000000'),
    blockNumber: 12345678,
    txHash: '0x' + 'a'.repeat(64),
    detectedAt: Date.now(),
    detectionLatencyMs: 100,
    ...overrides,
  };
}

function createMockPosition(overrides: Partial<CopyPosition> = {}): CopyPosition {
  return {
    id: 'pos-test-1',
    signalId: 'sig-test-1',
    sourceWallet: '0x1234567890123456789012345678901234567890',
    tokenAddress: '0xABCDEF1234567890123456789012345678901234',
    poolAddress: '0x9876543210987654321098765432109876543210',
    entryPrice: BigInt('1000000000000000000'),
    positionSizeUsdc: 50,
    tokenAmount: BigInt('50000000000000000000'),
    takeProfit: BigInt('1500000000000000000'),
    stopLoss: BigInt('800000000000000000'),
    trailingStopTrigger: BigInt('1100000000000000000'),
    trailingStopLevel: null,
    timeStop: Date.now() + 48 * 60 * 60 * 1000,
    status: 'OPEN',
    openedAt: Date.now(),
    closedAt: null,
    exitPrice: null,
    pnlUsdc: null,
    exitReason: null,
    ...overrides,
  };
}

function createMockSignalRow(signal: CopySignal): Record<string, unknown> {
  return {
    id: signal.id,
    source_wallet: signal.sourceWallet,
    wallet_tier: signal.walletTier,
    token_address: signal.tokenAddress,
    pool_address: signal.poolAddress,
    action: signal.action,
    trade_amount_usdc: signal.tradeAmountUsdc.toString(),
    entry_price: signal.entryPrice.toString(),
    block_number: signal.blockNumber.toString(),
    tx_hash: signal.txHash,
    detected_at: signal.detectedAt.toString(),
    detection_latency_ms: signal.detectionLatencyMs.toString(),
    enrichment_result: null,
    enrichment_reject_reason: null,
    baiting_result: null,
    baiting_reject_reason: null,
    execution_result: null,
    execution_reject_reason: null,
    position_id: null,
    created_at: new Date(),
  };
}

function createMockPositionRow(position: CopyPosition): Record<string, unknown> {
  return {
    id: position.id,
    signal_id: position.signalId,
    source_wallet: position.sourceWallet,
    token_address: position.tokenAddress,
    pool_address: position.poolAddress,
    entry_price: position.entryPrice.toString(),
    position_size_usdc: position.positionSizeUsdc.toString(),
    token_amount: position.tokenAmount.toString(),
    take_profit: position.takeProfit.toString(),
    stop_loss: position.stopLoss.toString(),
    trailing_stop_trigger: position.trailingStopTrigger.toString(),
    trailing_stop_level: position.trailingStopLevel?.toString() ?? null,
    time_stop: position.timeStop.toString(),
    status: position.status,
    opened_at: position.openedAt.toString(),
    closed_at: position.closedAt?.toString() ?? null,
    exit_price: position.exitPrice?.toString() ?? null,
    pnl_usdc: position.pnlUsdc?.toString() ?? null,
    exit_reason: position.exitReason,
  };
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('CopyMetricsRecorder - Task 19.3', () => {
  let recorder: InstanceType<typeof import('../modules/CopyMetricsRecorder.js').CopyMetricsRecorder>;
  let CopyMetricsRecorder: typeof import('../modules/CopyMetricsRecorder.js').CopyMetricsRecorder;
  let createCopyMetricsRecorder: typeof import('../modules/CopyMetricsRecorder.js').createCopyMetricsRecorder;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockQuery.mockReset();
    mockConnect.mockReset();
    mockRelease.mockReset();
    
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    mockConnect.mockResolvedValue({
      query: mockQuery,
      release: mockRelease,
    });
    
    // Import the module after mocks are set up
    const module = await import('../modules/CopyMetricsRecorder.js');
    CopyMetricsRecorder = module.CopyMetricsRecorder;
    createCopyMetricsRecorder = module.createCopyMetricsRecorder;
    recorder = createCopyMetricsRecorder();
  });

  afterEach(async () => {
    if (recorder) {
      await recorder.close();
    }
  });

  // ===========================================================================
  // Task 19.3: Position Persistence Tests (Requirement 8.2)
  // ===========================================================================

  describe('recordPositionOpen - Requirement 8.2', () => {
    it('should persist position with entry_price to copy_positions table', async () => {
      const position = createMockPosition();
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordPositionOpen(position);

      expect(mockQuery).toHaveBeenCalled();
      const [query, values] = mockQuery.mock.calls[0];
      
      expect(query).toContain('INSERT INTO copy_positions');
      expect(values).toContain(position.id);
      expect(values).toContain(position.signalId);
      expect(values).toContain(position.entryPrice.toString());
      expect(values).toContain(position.positionSizeUsdc);
    });

    it('should persist take_profit and stop_loss', async () => {
      const position = createMockPosition();
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordPositionOpen(position);

      const [, values] = mockQuery.mock.calls[0];
      expect(values).toContain(position.takeProfit.toString());
      expect(values).toContain(position.stopLoss.toString());
    });

    it('should persist time_stop timestamp', async () => {
      const position = createMockPosition();
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordPositionOpen(position);

      const [, values] = mockQuery.mock.calls[0];
      expect(values).toContain(position.timeStop);
    });

    it('should handle database errors', async () => {
      const position = createMockPosition();
      mockQuery.mockRejectedValueOnce(new Error('Database error'));

      await expect(recorder.recordPositionOpen(position)).rejects.toThrow('Database error');
    });
  });

  describe('recordPositionClose - Requirement 8.2', () => {
    it('should update position with exit_price', async () => {
      const position = createMockPosition({
        status: 'TP_HIT',
        closedAt: Date.now(),
        exitPrice: BigInt('1500000000000000000'),
        pnlUsdc: 25,
        exitReason: 'TP_HIT',
      });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordPositionClose(position);

      const [query, values] = mockQuery.mock.calls[0];
      expect(query).toContain('UPDATE copy_positions');
      expect(values).toContain(position.exitPrice!.toString());
    });

    it('should persist pnl_usdc (PnL)', async () => {
      const position = createMockPosition({
        status: 'TP_HIT',
        closedAt: Date.now(),
        exitPrice: BigInt('1500000000000000000'),
        pnlUsdc: 25,
        exitReason: 'TP_HIT',
      });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordPositionClose(position);

      const [, values] = mockQuery.mock.calls[0];
      expect(values).toContain(position.pnlUsdc);
    });

    it('should persist exit_reason', async () => {
      const position = createMockPosition({
        status: 'SL_HIT',
        closedAt: Date.now(),
        exitPrice: BigInt('800000000000000000'),
        pnlUsdc: -10,
        exitReason: 'SL_HIT',
      });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordPositionClose(position);

      const [, values] = mockQuery.mock.calls[0];
      expect(values).toContain('SL_HIT');
    });

    it('should persist closed_at timestamp for duration calculation', async () => {
      const position = createMockPosition({
        status: 'TIME_STOP',
        closedAt: Date.now(),
        exitPrice: BigInt('900000000000000000'),
        pnlUsdc: -5,
        exitReason: 'TIME_STOP',
      });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordPositionClose(position);

      const [, values] = mockQuery.mock.calls[0];
      expect(values).toContain(position.closedAt);
    });

    it('should warn when position not found', async () => {
      const position = createMockPosition({
        status: 'TP_HIT',
        closedAt: Date.now(),
        exitPrice: BigInt('1500000000000000000'),
        pnlUsdc: 25,
        exitReason: 'TP_HIT',
      });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      // Should not throw, just warn
      await expect(recorder.recordPositionClose(position)).resolves.not.toThrow();
    });
  });

  describe('getPositionById - Requirement 8.2', () => {
    it('should retrieve position by ID', async () => {
      const position = createMockPosition();
      const mockRow = createMockPositionRow(position);
      mockQuery.mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await recorder.getPositionById(position.id);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(position.id);
      expect(result!.entryPrice).toBe(position.entryPrice);
    });

    it('should return null when position not found', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await recorder.getPositionById('non-existent');

      expect(result).toBeNull();
    });

    it('should correctly map all position fields', async () => {
      const position = createMockPosition({
        status: 'TP_HIT',
        closedAt: Date.now(),
        exitPrice: BigInt('1500000000000000000'),
        pnlUsdc: 25,
        exitReason: 'TP_HIT',
      });
      const mockRow = createMockPositionRow(position);
      mockQuery.mockResolvedValueOnce({ rows: [mockRow], rowCount: 1 });

      const result = await recorder.getPositionById(position.id);

      expect(result!.status).toBe('TP_HIT');
      expect(result!.exitReason).toBe('TP_HIT');
      expect(result!.pnlUsdc).toBe(25);
    });
  });

  describe('getOpenPositions - Requirement 8.2', () => {
    it('should retrieve all open positions', async () => {
      const position = createMockPosition();
      mockQuery.mockResolvedValueOnce({
        rows: [createMockPositionRow(position)],
        rowCount: 1,
      });

      const result = await recorder.getOpenPositions();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(position.id);
      expect(result[0].status).toBe('OPEN');
    });

    it('should filter by OPEN status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await recorder.getOpenPositions();

      const [query] = mockQuery.mock.calls[0];
      expect(query).toContain("status='OPEN'");
    });

    it('should order by opened_at ASC', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await recorder.getOpenPositions();

      const [query] = mockQuery.mock.calls[0];
      expect(query).toContain('ORDER BY opened_at ASC');
    });
  });

  describe('getPositionsByWallet - Requirement 8.2', () => {
    it('should retrieve positions for specific source wallet', async () => {
      const walletAddress = '0x1234567890123456789012345678901234567890';
      const position = createMockPosition({ sourceWallet: walletAddress });
      mockQuery.mockResolvedValueOnce({
        rows: [createMockPositionRow(position)],
        rowCount: 1,
      });

      const result = await recorder.getPositionsByWallet(walletAddress);

      expect(result).toHaveLength(1);
      expect(result[0].sourceWallet).toBe(walletAddress);
    });

    it('should filter by source_wallet', async () => {
      const walletAddress = '0xABCD';
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await recorder.getPositionsByWallet(walletAddress);

      const [query, values] = mockQuery.mock.calls[0];
      expect(query).toContain('source_wallet = $1');
      expect(values[0]).toBe(walletAddress);
    });

    it('should order by opened_at DESC', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await recorder.getPositionsByWallet('0x1234');

      const [query] = mockQuery.mock.calls[0];
      expect(query).toContain('ORDER BY opened_at DESC');
    });
  });

  // ===========================================================================
  // Signal Persistence Tests (Task 19.1 - supporting tests)
  // ===========================================================================

  describe('recordSignal - Requirement 8.1', () => {
    it('should persist CopySignal to copy_signals table', async () => {
      const signal = createMockSignal();
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordSignal(signal);

      expect(mockQuery).toHaveBeenCalled();
      const [query, values] = mockQuery.mock.calls[0];
      
      expect(query).toContain('INSERT INTO copy_signals');
      expect(values).toContain(signal.id);
      expect(values).toContain(signal.sourceWallet);
    });

    it('should use ON CONFLICT to update existing signals', async () => {
      const signal = createMockSignal();
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordSignal(signal);

      const [query] = mockQuery.mock.calls[0];
      expect(query).toContain('ON CONFLICT (id) DO UPDATE');
    });
  });

  describe('getRecentSignals', () => {
    it('should retrieve recent signals with limit', async () => {
      const signal = createMockSignal();
      mockQuery.mockResolvedValueOnce({
        rows: [createMockSignalRow(signal)],
        rowCount: 1,
      });

      const result = await recorder.getRecentSignals(10);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(signal.id);
    });
  });

  describe('recordPosition (alias)', () => {
    it('should call recordPositionOpen', async () => {
      const position = createMockPosition();
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.recordPosition(position);

      const [query] = mockQuery.mock.calls[0];
      expect(query).toContain('INSERT INTO copy_positions');
    });
  });

  describe('updatePosition', () => {
    it('should update position in database', async () => {
      const position = createMockPosition({
        status: 'TP_HIT',
        closedAt: Date.now(),
        exitPrice: BigInt('1500000000000000000'),
        pnlUsdc: 25,
        exitReason: 'TP_HIT',
      });
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      await recorder.updatePosition(position);

      const [query, values] = mockQuery.mock.calls[0];
      expect(query).toContain('UPDATE copy_positions');
      expect(values).toContain(position.status);
    });

    it('should only perform UPDATE (no upsert)', async () => {
      const position = createMockPosition();
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE returns 0

      await recorder.updatePosition(position);

      // Should only call UPDATE once, not INSERT afterwards
      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [query] = mockQuery.mock.calls[0];
      expect(query).toContain('UPDATE copy_positions');
    });
  });

  describe('getClosedPositions', () => {
    it('should retrieve closed positions with date filtering', async () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await recorder.getClosedPositions(startDate, endDate, 50);

      const [query, values] = mockQuery.mock.calls[0];
      expect(query).toContain('closed_at>=$');
      expect(query).toContain('closed_at<=$');
      expect(values).toContain(startDate.getTime());
      expect(values).toContain(endDate.getTime());
      expect(values).toContain(50);
    });

    it('should exclude OPEN status', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      await recorder.getClosedPositions();

      const [query] = mockQuery.mock.calls[0];
      expect(query).toContain("status!='OPEN'");
    });
  });

  describe('Lifecycle', () => {
    it('should close gracefully', async () => {
      await expect(recorder.close()).resolves.not.toThrow();
    });

    it('should clear daily report timer on close', async () => {
      // Schedule a daily report (which sets a timer)
      recorder.scheduleDailyReport(12);

      // Close should clear the timer without throwing
      await expect(recorder.close()).resolves.not.toThrow();
    });

    it('should allow bufferSignal and flushSignalBatch', async () => {
      // Buffer a signal
      const signal = createMockSignal();
      recorder.bufferSignal(signal);

      // Mock the query for flush
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

      // Flush should record the signal
      await recorder.flushSignalBatch();

      // Should have called query to record the signal
      expect(mockQuery).toHaveBeenCalled();
    });
  });
});

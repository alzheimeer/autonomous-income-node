/**
 * @fileoverview Tests for Copy Trading API position endpoints (Task 21.3)
 * 
 * Tests the following endpoints:
 * - GET /copy/positions - List open positions with unrealized PnL (Req 9.5)
 * - POST /copy/positions/:id/close - Manually close a position (Req 9.6)
 * 
 * @module copy-trading/tests/CopyTradingAPI.positions.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
  CopyTradingAPI, 
  type CopyTradingRouteDeps, 
  type PositionsListResponse,
  type PositionCloseResponse,
} from '../routes/copy.js';
import type { ICopyExecutor, CopyPosition } from '../interfaces/types.js';
import type { IDexQuoter } from '../../shared/dex-quoter.js';

// =============================================================================
// MOCK HELPERS
// =============================================================================

/**
 * Create a mock CopyPosition for testing
 */
function createMockPosition(overrides: Partial<CopyPosition> = {}): CopyPosition {
  const now = Date.now();
  const entryPrice = overrides.entryPrice ?? BigInt('1000000000000000000'); // 1e18
  
  return {
    id: overrides.id ?? 'pos-123',
    signalId: overrides.signalId ?? 'signal-456',
    sourceWallet: overrides.sourceWallet ?? '0x1234567890123456789012345678901234567890',
    tokenAddress: overrides.tokenAddress ?? '0xabcdef1234567890abcdef1234567890abcdef12',
    poolAddress: overrides.poolAddress ?? '0xpool1234567890123456789012345678901234',
    entryPrice,
    positionSizeUsdc: overrides.positionSizeUsdc ?? 100,
    tokenAmount: overrides.tokenAmount ?? BigInt('50000000000000000000'), // 50e18
    takeProfit: overrides.takeProfit ?? (entryPrice * 150n / 100n),
    stopLoss: overrides.stopLoss ?? (entryPrice * 80n / 100n),
    trailingStopTrigger: overrides.trailingStopTrigger ?? (entryPrice * 110n / 100n),
    trailingStopLevel: overrides.trailingStopLevel ?? null,
    timeStop: overrides.timeStop ?? (now + 48 * 60 * 60 * 1000),
    status: overrides.status ?? 'OPEN',
    openedAt: overrides.openedAt ?? now,
    closedAt: overrides.closedAt ?? null,
    exitPrice: overrides.exitPrice ?? null,
    pnlUsdc: overrides.pnlUsdc ?? null,
    exitReason: overrides.exitReason ?? null,
  };
}

/**
 * Create a mock executor for testing
 */
function createMockExecutor(positions: CopyPosition[] = []): ICopyExecutor {
  const positionsMap = new Map<string, CopyPosition>();
  positions.forEach(p => positionsMap.set(p.id, p));

  return {
    execute: vi.fn(),
    getOpenPositions: vi.fn(() => 
      Array.from(positionsMap.values()).filter(p => p.status === 'OPEN')
    ),
    getPosition: vi.fn((id: string) => positionsMap.get(id) ?? null),
    forceClose: vi.fn(async (id: string) => {
      const position = positionsMap.get(id);
      if (!position || position.status !== 'OPEN') {
        return false;
      }
      position.status = 'FORCED_CLOSE';
      position.closedAt = Date.now();
      return true;
    }),
    getStats: vi.fn(() => ({
      totalExecuted: 0,
      totalRejected: 0,
      rejectionsByReason: {} as Record<string, number>,
      avgExecutionMs: 0,
    })),
  };
}

/**
 * Create a mock DexQuoter for testing
 */
function createMockDexQuoter(priceMultiplier: number = 1.0): IDexQuoter {
  return {
    detectPoolType: vi.fn(async () => 'uniswap_v3' as const),
    quote: vi.fn(async (params: { amountIn: bigint }) => {
      // Return price based on multiplier (simulates price change)
      return BigInt(Math.floor(Number(params.amountIn) * priceMultiplier));
    }),
  };
}

/**
 * Make a test HTTP request using fetch
 */
async function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: object,
  headers: Record<string, string> = {}
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      ...headers,
    },
  };

  // Only set Content-Type and body if there's a body to send
  if (body !== undefined) {
    (options.headers as Record<string, string>)['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  return fetch(url, options);
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('CopyTradingAPI - Position Endpoints (Task 21.3)', () => {
  let api: CopyTradingAPI;
  let mockExecutor: ICopyExecutor;
  let mockDexQuoter: IDexQuoter;
  let baseUrl: string;
  const testPort = 3098;

  beforeEach(async () => {
    mockExecutor = createMockExecutor();
    mockDexQuoter = createMockDexQuoter(1.0);
    const deps: CopyTradingRouteDeps = {
      executor: mockExecutor,
      dexQuoter: mockDexQuoter,
    };
    api = new CopyTradingAPI(deps, testPort);
    await api.start();
    baseUrl = `http://127.0.0.1:${testPort}`;
  });

  afterEach(async () => {
    await api.stop();
  });

  // ===========================================================================
  // GET /copy/positions - Requirement 9.5
  // ===========================================================================

  describe('GET /copy/positions (Req 9.5)', () => {
    it('should return empty list when no positions exist', async () => {
      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      
      expect(response.status).toBe(200);
      const data = await response.json() as PositionsListResponse;
      expect(data.positions).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('should return list of open positions with unrealized PnL', async () => {
      const position1 = createMockPosition({
        id: 'pos-1',
        tokenAddress: '0x1111111111111111111111111111111111111111',
        entryPrice: BigInt('1000000000000000000'), // 1e18
        positionSizeUsdc: 100,
      });
      const position2 = createMockPosition({
        id: 'pos-2',
        tokenAddress: '0x2222222222222222222222222222222222222222',
        entryPrice: BigInt('2000000000000000000'), // 2e18
        positionSizeUsdc: 50,
      });

      mockExecutor = createMockExecutor([position1, position2]);
      // Price increased by 10%
      mockDexQuoter = createMockDexQuoter(1.1);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      
      expect(response.status).toBe(200);
      const data = await response.json() as PositionsListResponse;
      expect(data.total).toBe(2);
      expect(data.positions).toHaveLength(2);

      // Verify first position structure
      const p1 = data.positions.find(p => p.id === 'pos-1');
      expect(p1).toBeDefined();
      expect(p1?.tokenAddress).toBe('0x1111111111111111111111111111111111111111');
      expect(p1?.entryPrice).toBeDefined();
      expect(p1?.currentPrice).toBeDefined();
      expect(typeof p1?.unrealizedPnlUsdc).toBe('number');
      expect(typeof p1?.unrealizedPnlPct).toBe('number');
      expect(p1?.sourceWallet).toBeDefined();
      expect(p1?.entryTimestamp).toBeGreaterThan(0);
    });

    it('should calculate positive unrealized PnL when price increases', async () => {
      const position = createMockPosition({
        id: 'pos-profit',
        entryPrice: BigInt('1000000000000000000'), // 1e18
        positionSizeUsdc: 100,
      });

      mockExecutor = createMockExecutor([position]);
      // Price increased by 20%
      mockDexQuoter = createMockDexQuoter(1.2);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      const data = await response.json() as PositionsListResponse;

      const pos = data.positions[0];
      expect(pos.unrealizedPnlPct).toBeCloseTo(20, 0);
      expect(pos.unrealizedPnlUsdc).toBeCloseTo(20, 0); // 100 * 20% = 20
    });

    it('should calculate negative unrealized PnL when price decreases', async () => {
      const position = createMockPosition({
        id: 'pos-loss',
        entryPrice: BigInt('1000000000000000000'), // 1e18
        positionSizeUsdc: 100,
      });

      mockExecutor = createMockExecutor([position]);
      // Price decreased by 15%
      mockDexQuoter = createMockDexQuoter(0.85);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      const data = await response.json() as PositionsListResponse;

      const pos = data.positions[0];
      expect(pos.unrealizedPnlPct).toBeCloseTo(-15, 0);
      expect(pos.unrealizedPnlUsdc).toBeCloseTo(-15, 0); // 100 * -15% = -15
    });

    it('should return all required fields in response', async () => {
      const position = createMockPosition({
        id: 'pos-fields',
        tokenAddress: '0xabcdef1234567890abcdef1234567890abcdef12',
        poolAddress: '0xpool1234567890123456789012345678901234',
        sourceWallet: '0xwallet12345678901234567890123456789012',
        positionSizeUsdc: 75,
      });

      mockExecutor = createMockExecutor([position]);
      mockDexQuoter = createMockDexQuoter(1.0);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      const data = await response.json() as PositionsListResponse;

      const pos = data.positions[0];
      
      // Verify all required fields per Req 9.5
      expect(pos).toHaveProperty('id');
      expect(pos).toHaveProperty('tokenAddress');
      expect(pos).toHaveProperty('entryPrice');
      expect(pos).toHaveProperty('currentPrice');
      expect(pos).toHaveProperty('unrealizedPnlUsdc');
      expect(pos).toHaveProperty('unrealizedPnlPct');
      expect(pos).toHaveProperty('entryTimestamp');
      expect(pos).toHaveProperty('sourceWallet');
      expect(pos).toHaveProperty('positionSizeUsdc');
      expect(pos).toHaveProperty('poolAddress');
      expect(pos).toHaveProperty('status');
    });

    it('should use entry price as fallback when quote fails', async () => {
      const entryPrice = BigInt('1000000000000000000');
      const position = createMockPosition({
        id: 'pos-quote-fail',
        entryPrice,
        positionSizeUsdc: 100,
      });

      mockExecutor = createMockExecutor([position]);
      // DexQuoter that throws
      mockDexQuoter = {
        detectPoolType: vi.fn(),
        quote: vi.fn().mockRejectedValue(new Error('Quote failed')),
      };
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      const data = await response.json() as PositionsListResponse;

      const pos = data.positions[0];
      // Should use entry price as fallback
      expect(pos.currentPrice).toBe(entryPrice.toString());
      expect(pos.unrealizedPnlUsdc).toBe(0);
      expect(pos.unrealizedPnlPct).toBe(0);
    });

    it('should only return OPEN positions', async () => {
      const openPosition = createMockPosition({
        id: 'pos-open',
        status: 'OPEN',
      });
      const closedPosition = createMockPosition({
        id: 'pos-closed',
        status: 'TP_HIT',
      });

      mockExecutor = createMockExecutor([openPosition, closedPosition]);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      const data = await response.json() as PositionsListResponse;

      // Should only include open position
      expect(data.total).toBe(1);
      expect(data.positions[0].id).toBe('pos-open');
    });
  });

  // ===========================================================================
  // POST /copy/positions/:id/close - Requirement 9.6
  // ===========================================================================

  describe('POST /copy/positions/:id/close (Req 9.6)', () => {
    it('should close an open position and return exit details', async () => {
      const position = createMockPosition({
        id: 'pos-to-close',
        entryPrice: BigInt('1000000000000000000'),
        positionSizeUsdc: 100,
        status: 'OPEN',
      });

      mockExecutor = createMockExecutor([position]);
      // Price increased by 25%
      mockDexQuoter = createMockDexQuoter(1.25);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'POST', '/copy/positions/pos-to-close/close');

      expect(response.status).toBe(200);
      const data = await response.json() as PositionCloseResponse;
      
      expect(data.message).toBe('Position closed successfully');
      expect(data.positionId).toBe('pos-to-close');
      expect(data.exitPrice).toBeDefined();
      expect(typeof data.realizedPnlUsdc).toBe('number');
      expect(data.realizedPnlUsdc).toBeCloseTo(25, 0); // 100 * 25% = 25
      expect(data.closedAt).toBeGreaterThan(0);

      // Verify executor was called
      expect(mockExecutor.forceClose).toHaveBeenCalledWith('pos-to-close');
    });

    it('should return 404 when position not found', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/positions/non-existent/close');

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Not Found');
      expect(data.message).toContain('Position not found');
    });

    it('should return 400 when position is not open', async () => {
      const closedPosition = createMockPosition({
        id: 'pos-already-closed',
        status: 'TP_HIT',
      });

      mockExecutor = createMockExecutor([closedPosition]);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'POST', '/copy/positions/pos-already-closed/close');

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Bad Request');
      expect(data.message).toContain('Position is not open');
    });

    it('should return 500 when force close fails', async () => {
      const position = createMockPosition({
        id: 'pos-fail-close',
        status: 'OPEN',
      });

      mockExecutor = createMockExecutor([position]);
      // Make forceClose return false
      (mockExecutor.forceClose as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'POST', '/copy/positions/pos-fail-close/close');

      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data.error).toBe('Internal Server Error');
      expect(data.message).toContain('Failed to close position');
    });

    it('should accept optional reason in request body', async () => {
      const position = createMockPosition({
        id: 'pos-with-reason',
        status: 'OPEN',
      });

      mockExecutor = createMockExecutor([position]);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(
        baseUrl, 
        'POST', 
        '/copy/positions/pos-with-reason/close',
        { reason: 'Manual exit due to market conditions' }
      );

      expect(response.status).toBe(200);
      // Just verify the close succeeded - reason is logged but not returned
      const data = await response.json() as PositionCloseResponse;
      expect(data.positionId).toBe('pos-with-reason');
    });

    it('should calculate negative realized PnL for losing position', async () => {
      const position = createMockPosition({
        id: 'pos-loss-close',
        entryPrice: BigInt('1000000000000000000'),
        positionSizeUsdc: 100,
        status: 'OPEN',
      });

      mockExecutor = createMockExecutor([position]);
      // Price decreased by 10%
      mockDexQuoter = createMockDexQuoter(0.9);
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'POST', '/copy/positions/pos-loss-close/close');
      const data = await response.json() as PositionCloseResponse;

      expect(data.realizedPnlUsdc).toBeCloseTo(-10, 0); // 100 * -10% = -10
    });

    it('should use entry price as exit price when quote fails', async () => {
      const entryPrice = BigInt('1000000000000000000');
      const position = createMockPosition({
        id: 'pos-quote-fail-close',
        entryPrice,
        positionSizeUsdc: 100,
        status: 'OPEN',
      });

      mockExecutor = createMockExecutor([position]);
      // DexQuoter that throws
      mockDexQuoter = {
        detectPoolType: vi.fn(),
        quote: vi.fn().mockRejectedValue(new Error('Quote failed')),
      };
      
      await api.stop();
      api = new CopyTradingAPI({ executor: mockExecutor, dexQuoter: mockDexQuoter }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'POST', '/copy/positions/pos-quote-fail-close/close');
      const data = await response.json() as PositionCloseResponse;

      // Should use entry price as fallback, resulting in 0 PnL
      expect(data.exitPrice).toBe(entryPrice.toString());
      expect(data.realizedPnlUsdc).toBe(0);
    });
  });

  // ===========================================================================
  // API Key Authentication for position close - Requirement 9.10
  // ===========================================================================

  describe('API Key Authentication for position close (Req 9.10)', () => {
    const testApiKey = 'test-api-key-positions';

    beforeEach(async () => {
      await api.stop();
      const position = createMockPosition({
        id: 'pos-auth-test',
        status: 'OPEN',
      });
      mockExecutor = createMockExecutor([position]);
      api = new CopyTradingAPI({ 
        executor: mockExecutor, 
        dexQuoter: mockDexQuoter, 
        apiKey: testApiKey 
      }, testPort);
      await api.start();
    });

    it('GET /copy/positions should not require API key', async () => {
      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      expect(response.status).toBe(200);
    });

    it('POST /copy/positions/:id/close should return 401 without API key', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/positions/pos-auth-test/close');

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
    });

    it('POST /copy/positions/:id/close should succeed with valid API key', async () => {
      const response = await makeRequest(
        baseUrl, 
        'POST', 
        '/copy/positions/pos-auth-test/close',
        undefined,
        { 'Authorization': `Bearer ${testApiKey}` }
      );

      expect(response.status).toBe(200);
    });

    it('should accept API key in X-API-Key header', async () => {
      const response = await makeRequest(
        baseUrl, 
        'POST', 
        '/copy/positions/pos-auth-test/close',
        undefined,
        { 'X-API-Key': testApiKey }
      );

      expect(response.status).toBe(200);
    });
  });

  // ===========================================================================
  // Service Unavailable when executor not initialized
  // ===========================================================================

  describe('Service Unavailable scenarios', () => {
    beforeEach(async () => {
      await api.stop();
      api = new CopyTradingAPI({ dexQuoter: mockDexQuoter }, testPort); // No executor
      await api.start();
    });

    it('GET /copy/positions should return empty list when executor not initialized', async () => {
      const response = await makeRequest(baseUrl, 'GET', '/copy/positions');
      
      expect(response.status).toBe(200);
      const data = await response.json() as PositionsListResponse;
      expect(data.positions).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('POST /copy/positions/:id/close should return 503 when executor not initialized', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/positions/any-id/close');

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toBe('Service Unavailable');
      expect(data.message).toContain('Executor not initialized');
    });
  });
});

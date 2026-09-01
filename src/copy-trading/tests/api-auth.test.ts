/**
 * API Key Authentication Tests - Task 21.5
 * 
 * Tests for Requirement 9.10:
 * THE Copy_Trading_System SHALL require API key authentication for all mutating endpoints (POST, DELETE)
 * 
 * Test scenarios:
 * - Test 401 when no API key
 * - Test 401 when invalid API key
 * - Test 200 when valid API key (both X-API-Key and Authorization: Bearer)
 * - Test GET routes work without API key
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CopyTradingAPI, CopyTradingRouteDeps } from '../routes/copy.js';
import type { FastifyInstance } from 'fastify';

// Test API key
const TEST_API_KEY = 'test-secret-api-key-12345';

// Mock curator for testing wallet endpoints
const createMockCurator = () => ({
  getWallets: () => [],
  getWalletsByTier: () => [],
  addWallet: async (address: string) => ({
    address,
    tier: 'B_TIER' as const,
    metrics: {
      winRate: 0.75,
      totalPnlUsdc: 60000,
      tradeCount: 150,
      avgHoldingTimeSec: 3600,
      volumeUsdc: 600000,
      sharpeRatio: 1.5,
      maxDrawdownPct: 10,
      profitFactor: 2,
      profitableWeeksPct: 70,
    },
    flags: {
      isMevBot: false,
      isTokenDeployer: false,
      hasHoneypotExposure: false,
      isWashTrader: false,
    },
    addedAt: Date.now(),
    lastEvaluatedAt: Date.now(),
    isActive: true,
  }),
  removeWallet: () => {},
  reEvaluateAll: async () => {},
  isMonitored: (address: string) => address === '0x1234567890123456789012345678901234567890',
});

// Mock executor for testing position endpoints
const createMockExecutor = () => ({
  execute: async () => ({ success: true, positionId: 'test-pos', executedPrice: BigInt(1000), gasUsed: BigInt(21000) }),
  getOpenPositions: () => [],
  getPosition: (id: string) => id === 'test-pos' ? {
    id: 'test-pos',
    signalId: 'sig-1',
    sourceWallet: '0x1234567890123456789012345678901234567890',
    tokenAddress: '0xabcdef1234567890123456789012345678901234',
    poolAddress: '0xfedcba0987654321098765432109876543210987',
    entryPrice: BigInt(1000),
    positionSizeUsdc: 50,
    tokenAmount: BigInt(1000000),
    takeProfit: BigInt(1500),
    stopLoss: BigInt(800),
    trailingStopTrigger: BigInt(1100),
    trailingStopLevel: null,
    timeStop: Date.now() + 48 * 60 * 60 * 1000,
    status: 'OPEN' as const,
    openedAt: Date.now(),
    closedAt: null,
    exitPrice: null,
    pnlUsdc: null,
    exitReason: null,
  } : null,
  forceClose: async () => true,
  getStats: () => ({
    totalExecuted: 0,
    totalRejected: 0,
    rejectionsByReason: {},
    avgExecutionMs: 0,
  }),
});

// Mock risk manager for circuit breaker endpoints
const createMockRiskManager = (active: boolean = false) => ({
  getCircuitBreakerState: () => ({
    active,
    blockedUntil: active ? Date.now() + 24 * 60 * 60 * 1000 : null,
    consecutiveLosses: active ? 3 : 0,
    activationReason: active ? 'LOSS_STREAK' : undefined,
  }),
  resetCircuitBreaker: () => {},
  canOpenPosition: () => ({ allowed: true }),
  recordPositionResult: () => {},
  getDeploymentStats: () => ({
    dailyDeployedUsdc: 0,
    maxDailyUsdc: 100,
    currentPositions: 0,
    maxPositions: 3,
  }),
});

describe('API Key Authentication - Requirement 9.10', () => {
  let api: CopyTradingAPI;
  let server: FastifyInstance;

  beforeAll(async () => {
    const deps: CopyTradingRouteDeps = {
      apiKey: TEST_API_KEY,
      curator: createMockCurator(),
      executor: createMockExecutor(),
      riskManager: createMockRiskManager() as any,
    };

    api = new CopyTradingAPI(deps, 0); // Port 0 = random available port
    await api.start();
    server = api.getServer()!;
  });

  afterAll(async () => {
    await api.stop();
  });

  // =========================================================================
  // GET routes should NOT require authentication
  // =========================================================================

  describe('GET endpoints - No authentication required', () => {
    it('GET /copy/status should work without API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/copy/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('health'); // API uses 'health', not 'status'
      expect(body).toHaveProperty('openPositionsCount');
      expect(body).toHaveProperty('circuitBreakerActive');
    });

    it('GET /copy/wallets should work without API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/copy/wallets',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('wallets');
      expect(body).toHaveProperty('total');
    });

    it('GET /copy/positions should work without API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/copy/positions',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('positions');
      expect(body).toHaveProperty('total');
    });

    it('GET /copy/metrics should work without API key', async () => {
      const response = await server.inject({
        method: 'GET',
        url: '/copy/metrics',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // API uses 'totalPnl' not 'totalPnlUsdc'
      expect(body).toHaveProperty('totalPnl');
      expect(body).toHaveProperty('winRate');
    });
  });

  // =========================================================================
  // POST endpoints REQUIRE authentication
  // =========================================================================

  describe('POST /copy/wallets - Authentication required', () => {
    const validAddress = '0xABCDEF1234567890123456789012345678901234';

    it('should return 401 when no API key provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/wallets',
        payload: { address: validAddress },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toBe('Invalid or missing API key');
    });

    it('should return 401 when invalid API key provided via X-API-Key', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/wallets',
        headers: {
          'x-api-key': 'wrong-api-key',
        },
        payload: { address: validAddress },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 when invalid API key provided via Authorization Bearer', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/wallets',
        headers: {
          'authorization': 'Bearer wrong-api-key',
        },
        payload: { address: validAddress },
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 201 when valid API key provided via X-API-Key', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/wallets',
        headers: {
          'x-api-key': TEST_API_KEY,
        },
        payload: { address: validAddress },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.message).toBe('Wallet added successfully');
    });

    it('should return 201 when valid API key provided via Authorization Bearer', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/wallets',
        headers: {
          'authorization': `Bearer ${TEST_API_KEY}`,
        },
        payload: { address: validAddress },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.message).toBe('Wallet added successfully');
    });
  });

  describe('DELETE /copy/wallets/:address - Authentication required', () => {
    const monitoredAddress = '0x1234567890123456789012345678901234567890';

    it('should return 401 when no API key provided', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: `/copy/wallets/${monitoredAddress}`,
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 when invalid API key provided', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: `/copy/wallets/${monitoredAddress}`,
        headers: {
          'x-api-key': 'invalid-key',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 200 when valid API key provided via X-API-Key', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: `/copy/wallets/${monitoredAddress}`,
        headers: {
          'x-api-key': TEST_API_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.message).toBe('Wallet removed successfully');
    });

    it('should return 200 when valid API key provided via Authorization Bearer', async () => {
      const response = await server.inject({
        method: 'DELETE',
        url: `/copy/wallets/${monitoredAddress}`,
        headers: {
          'authorization': `Bearer ${TEST_API_KEY}`,
        },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('POST /copy/positions/:id/close - Authentication required', () => {
    it('should return 401 when no API key provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/positions/test-pos/close',
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 when invalid API key provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/positions/test-pos/close',
        headers: {
          'x-api-key': 'bad-key',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 200 when valid API key provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/positions/test-pos/close',
        headers: {
          'x-api-key': TEST_API_KEY,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.message).toBe('Position closed successfully');
    });
  });

  describe('POST /copy/circuit-breaker/reset - Authentication required', () => {
    it('should return 401 when no API key provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/circuit-breaker/reset',
      });

      expect(response.statusCode).toBe(401);
      const body = response.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('should return 401 when invalid API key provided', async () => {
      const response = await server.inject({
        method: 'POST',
        url: '/copy/circuit-breaker/reset',
        headers: {
          'authorization': 'Bearer wrong-key',
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 400 when circuit breaker is not active (even with valid API key)', async () => {
      // The main test server has CB inactive by default
      const response = await server.inject({
        method: 'POST',
        url: '/copy/circuit-breaker/reset',
        headers: {
          'x-api-key': TEST_API_KEY,
        },
      });

      // Returns 400 because CB is not active (nothing to reset)
      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('Bad Request');
      expect(body.message).toBe('Circuit breaker is not active');
    });
  });
});

// =========================================================================
// Test when NO API key is configured (authentication disabled)
// =========================================================================

describe('API without authentication configured', () => {
  let api: CopyTradingAPI;
  let server: FastifyInstance;

  beforeAll(async () => {
    const deps: CopyTradingRouteDeps = {
      apiKey: null, // No API key configured - auth disabled
      curator: createMockCurator(),
      executor: createMockExecutor(),
      riskManager: createMockRiskManager(false) as any,
    };

    api = new CopyTradingAPI(deps, 0);
    await api.start();
    server = api.getServer()!;
  });

  afterAll(async () => {
    await api.stop();
  });

  it('POST /copy/wallets should work without API key when not configured', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/copy/wallets',
      payload: { address: '0xABCDEF1234567890123456789012345678901234' },
    });

    expect(response.statusCode).toBe(201);
  });

  it('DELETE /copy/wallets/:address should work without API key when not configured', async () => {
    const response = await server.inject({
      method: 'DELETE',
      url: '/copy/wallets/0x1234567890123456789012345678901234567890',
    });

    expect(response.statusCode).toBe(200);
  });

  it('POST /copy/circuit-breaker/reset returns 400 when CB not active (auth bypassed but CB inactive)', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
    });

    // Auth is bypassed but CB is not active - returns 400
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.message).toBe('Circuit breaker is not active');
  });
});

// =========================================================================
// Test with empty string API key (should be treated as disabled)
// =========================================================================

describe('API with empty string API key (treated as disabled)', () => {
  let api: CopyTradingAPI;
  let server: FastifyInstance;

  beforeAll(async () => {
    const deps: CopyTradingRouteDeps = {
      apiKey: '', // Empty string - should disable auth
      curator: createMockCurator(),
      executor: createMockExecutor(),
      riskManager: createMockRiskManager(false) as any,
    };

    api = new CopyTradingAPI(deps, 0);
    await api.start();
    server = api.getServer()!;
  });

  afterAll(async () => {
    await api.stop();
  });

  it('POST /copy/wallets should work without API key when apiKey is empty string', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/copy/wallets',
      payload: { address: '0xABCDEF1234567890123456789012345678901234' },
    });

    expect(response.statusCode).toBe(201);
  });
});

// =========================================================================
// Test circuit breaker reset with CB actually active
// =========================================================================

describe('Circuit breaker reset with CB active', () => {
  let api: CopyTradingAPI;
  let server: FastifyInstance;

  beforeAll(async () => {
    const deps: CopyTradingRouteDeps = {
      apiKey: TEST_API_KEY,
      curator: createMockCurator(),
      executor: createMockExecutor(),
      riskManager: createMockRiskManager(true) as any, // CB is active
    };

    api = new CopyTradingAPI(deps, 0);
    await api.start();
    server = api.getServer()!;
  });

  afterAll(async () => {
    await api.stop();
  });

  it('should return 401 when no API key provided', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 200 and reset CB when valid API key provided and CB is active', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
      headers: {
        'x-api-key': TEST_API_KEY,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.success).toBe(true);
    expect(body.message).toBe('Circuit breaker reset successfully');
    expect(body).toHaveProperty('previousState');
    expect(body.previousState.active).toBe(true);
    expect(body).toHaveProperty('resetAt');
  });
});

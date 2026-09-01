/**
 * Tests for Copy Trading API Endpoints - Task 21.4
 * 
 * Tests for control endpoints:
 * - POST /copy/circuit-breaker/reset (Req 9.7)
 * - GET /copy/metrics (Req 9.8)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CopyTradingAPI, CopyTradingRouteDeps } from '../routes/copy.js';
import type { CopyTradingRiskManager, CopyTradingCircuitBreakerState } from '../modules/CopyTradingRiskManager.js';
import type { ICopyMetricsRecorder, TierMetrics, AggregateMetrics } from '../modules/CopyMetricsRecorder.js';
import type { WalletTier } from '../interfaces/types.js';

// =============================================================================
// MOCK IMPLEMENTATIONS
// =============================================================================

function createMockRiskManager(circuitBreakerActive: boolean = false): CopyTradingRiskManager {
  const state: CopyTradingCircuitBreakerState = {
    active: circuitBreakerActive,
    blockedUntil: circuitBreakerActive ? Date.now() + 86400000 : null,
    consecutiveLosses: circuitBreakerActive ? 3 : 0,
    activationReason: circuitBreakerActive ? 'LOSS_STREAK' : undefined,
  };

  return {
    getCircuitBreakerState: vi.fn(() => ({ ...state })),
    resetCircuitBreaker: vi.fn(() => {
      state.active = false;
      state.blockedUntil = null;
      state.consecutiveLosses = 0;
      state.activationReason = undefined;
    }),
    canOpenPosition: vi.fn(() => ({
      allowed: !state.active,
      currentPositions: 0,
      maxPositions: 3,
      circuitBreakerActive: state.active,
    })),
    getMaxConcurrentPositions: vi.fn(() => 3),
  } as unknown as CopyTradingRiskManager;
}

function createMockMetricsRecorder(hasData: boolean = true): ICopyMetricsRecorder {
  const mockTierMetrics: Record<WalletTier, TierMetrics | null> = {
    S_TIER: hasData ? {
      tier: 'S_TIER' as WalletTier,
      tradesCount: 50,
      winsCount: 35,
      winRate: 70,
      totalPnl: 5000,
      avgPnl: 100,
      sharpeRatio: 1.5,
    } : null,
    A_TIER: hasData ? {
      tier: 'A_TIER' as WalletTier,
      tradesCount: 30,
      winsCount: 18,
      winRate: 60,
      totalPnl: 2000,
      avgPnl: 66.67,
      sharpeRatio: 1.2,
    } : null,
    B_TIER: hasData ? {
      tier: 'B_TIER' as WalletTier,
      tradesCount: 20,
      winsCount: 10,
      winRate: 50,
      totalPnl: 500,
      avgPnl: 25,
      sharpeRatio: 0.8,
    } : null,
  };

  const mockDailyMetrics = (date: Date): AggregateMetrics | null => {
    if (!hasData) return null;
    const dayOfMonth = date.getDate();
    return {
      date,
      walletAddress: null,
      tier: null,
      periodType: 'DAILY',
      totalTrades: 10 + dayOfMonth % 5,
      winningTrades: 5 + dayOfMonth % 3,
      losingTrades: 5 + dayOfMonth % 2,
      winRate: 50 + (dayOfMonth % 20),
      totalPnlUsdc: 100 * (dayOfMonth % 10),
      avgPnlUsdc: 10 + dayOfMonth % 5,
      sharpeRatio: 1.0 + (dayOfMonth % 10) / 10,
    };
  };

  return {
    calculateTierMetrics: vi.fn((tier: WalletTier) => Promise.resolve(mockTierMetrics[tier])),
    calculateDailyMetrics: vi.fn((date: Date) => Promise.resolve(mockDailyMetrics(date))),
    recordSignal: vi.fn(),
    recordSignalBatch: vi.fn(),
    getSignalById: vi.fn(),
    getSignalsByWallet: vi.fn(),
    getRecentSignals: vi.fn(),
    recordPosition: vi.fn(),
    recordPositionOpen: vi.fn(),
    recordPositionClose: vi.fn(),
    updatePosition: vi.fn(),
    getOpenPositions: vi.fn(() => Promise.resolve([])),
    getClosedPositions: vi.fn(() => Promise.resolve([])),
    getPositionById: vi.fn(),
    getPositionsByWallet: vi.fn(),
    bufferSignal: vi.fn(),
    flushSignalBatch: vi.fn(),
    loadOpenPositions: vi.fn(() => Promise.resolve([])),
    restorePositions: vi.fn(),
    restoreOpenPositions: vi.fn(() => Promise.resolve([])),
    getRestoredPositionCount: vi.fn(() => 0),
    calculateWalletMetrics: vi.fn(),
    getAggregatedMetrics: vi.fn(() => Promise.resolve([])),
    generateDailyReport: vi.fn(),
    formatReportForLog: vi.fn(() => ''),
    scheduleDailyReport: vi.fn(),
    close: vi.fn(),
  } as unknown as ICopyMetricsRecorder;
}

// =============================================================================
// TESTS FOR POST /copy/circuit-breaker/reset (Req 9.7)
// =============================================================================

describe('POST /copy/circuit-breaker/reset', () => {
  let api: CopyTradingAPI;
  let deps: CopyTradingRouteDeps;

  afterEach(async () => {
    if (api) {
      await api.stop();
    }
  });

  it('should return 200 with success when circuit breaker is active', async () => {
    // Setup with active circuit breaker
    deps = {
      riskManager: createMockRiskManager(true),
      apiKey: 'test-api-key',
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
    expect(body.message).toBe('Circuit breaker reset successfully');
    expect(body.previousState.active).toBe(true);
    expect(body.previousState.consecutiveLosses).toBe(3);
    expect(body.resetAt).toBeDefined();
    expect(deps.riskManager!.resetCircuitBreaker).toHaveBeenCalled();
  });

  it('should return 400 when circuit breaker is not active (Req 9.7)', async () => {
    // Setup with inactive circuit breaker
    deps = {
      riskManager: createMockRiskManager(false),
      apiKey: 'test-api-key',
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
      headers: {
        'x-api-key': 'test-api-key',
      },
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Bad Request');
    expect(body.message).toBe('Circuit breaker is not active');
    expect(body.success).toBe(false);
    expect(body.currentState.active).toBe(false);
    // resetCircuitBreaker should NOT be called when CB is not active
    expect(deps.riskManager!.resetCircuitBreaker).not.toHaveBeenCalled();
  });

  it('should return 401 when API key is invalid', async () => {
    deps = {
      riskManager: createMockRiskManager(true),
      apiKey: 'test-api-key',
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
      headers: {
        'x-api-key': 'wrong-key',
      },
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Unauthorized');
  });

  it('should return 401 when API key is missing', async () => {
    deps = {
      riskManager: createMockRiskManager(true),
      apiKey: 'test-api-key',
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should allow reset without API key when none is configured', async () => {
    deps = {
      riskManager: createMockRiskManager(true),
      // No API key configured
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.success).toBe(true);
  });

  it('should return 503 when risk manager is not initialized', async () => {
    deps = {
      // No risk manager
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.error).toBe('Service Unavailable');
    expect(body.message).toBe('Risk manager not initialized');
  });
});

// =============================================================================
// TESTS FOR GET /copy/metrics (Req 9.8)
// =============================================================================

describe('GET /copy/metrics', () => {
  let api: CopyTradingAPI;
  let deps: CopyTradingRouteDeps;

  afterEach(async () => {
    if (api) {
      await api.stop();
    }
  });

  it('should return aggregate metrics with tier data (Req 9.8)', async () => {
    deps = {
      metricsRecorder: createMockMetricsRecorder(true),
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'GET',
      url: '/copy/metrics',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Check aggregate fields
    expect(body.totalPnl).toBe(7500); // 5000 + 2000 + 500
    expect(body.totalTrades).toBe(100); // 50 + 30 + 20
    expect(body.winRate).toBeCloseTo(63, 0); // (35+18+10) / 100 * 100 = 63
    expect(body.avgPnlPerTrade).toBe(75); // 7500 / 100
    expect(body.sharpeRatio).not.toBeNull();

    // Check tier breakdown
    expect(body.byTier).toBeDefined();
    expect(body.byTier.S_TIER.pnl).toBe(5000);
    expect(body.byTier.S_TIER.trades).toBe(50);
    expect(body.byTier.S_TIER.winRate).toBe(70);
    expect(body.byTier.S_TIER.sharpeRatio).toBe(1.5);

    expect(body.byTier.A_TIER.pnl).toBe(2000);
    expect(body.byTier.A_TIER.trades).toBe(30);
    expect(body.byTier.A_TIER.winRate).toBe(60);
    expect(body.byTier.A_TIER.sharpeRatio).toBe(1.2);

    expect(body.byTier.B_TIER.pnl).toBe(500);
    expect(body.byTier.B_TIER.trades).toBe(20);
    expect(body.byTier.B_TIER.winRate).toBe(50);
    expect(body.byTier.B_TIER.sharpeRatio).toBe(0.8);
  });

  it('should return last 7 days of daily metrics', async () => {
    deps = {
      metricsRecorder: createMockMetricsRecorder(true),
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'GET',
      url: '/copy/metrics',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // Check daily array
    expect(body.daily).toBeDefined();
    expect(body.daily.length).toBe(7);

    // Each day should have the expected structure
    for (const day of body.daily) {
      expect(day.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof day.pnl).toBe('number');
      expect(typeof day.trades).toBe('number');
      expect(typeof day.winRate).toBe('number');
    }

    // Verify calculateDailyMetrics was called 7 times
    expect(deps.metricsRecorder!.calculateDailyMetrics).toHaveBeenCalledTimes(7);
  });

  it('should return default values when no data available', async () => {
    deps = {
      metricsRecorder: createMockMetricsRecorder(false),
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'GET',
      url: '/copy/metrics',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.totalPnl).toBe(0);
    expect(body.totalTrades).toBe(0);
    expect(body.winRate).toBe(0);
    expect(body.avgPnlPerTrade).toBe(0);
    expect(body.sharpeRatio).toBeNull();

    // Tier data should have defaults
    expect(body.byTier.S_TIER.pnl).toBe(0);
    expect(body.byTier.S_TIER.trades).toBe(0);
    expect(body.byTier.S_TIER.winRate).toBe(0);
    expect(body.byTier.S_TIER.sharpeRatio).toBeNull();
  });

  it('should return default values when metricsRecorder is not initialized', async () => {
    deps = {
      // No metricsRecorder
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'GET',
      url: '/copy/metrics',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.totalPnl).toBe(0);
    expect(body.totalTrades).toBe(0);
    expect(body.daily).toEqual([]);
  });

  it('should handle errors gracefully and return default values', async () => {
    const errorRecorder = createMockMetricsRecorder(true);
    (errorRecorder.calculateTierMetrics as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB connection failed'));

    deps = {
      metricsRecorder: errorRecorder,
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'GET',
      url: '/copy/metrics',
    });

    // Should still return 200 with default values
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.totalPnl).toBe(0);
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('Control Endpoints Integration', () => {
  let api: CopyTradingAPI;
  let deps: CopyTradingRouteDeps;

  afterEach(async () => {
    if (api) {
      await api.stop();
    }
  });

  it('should work with all dependencies provided', async () => {
    deps = {
      riskManager: createMockRiskManager(true),
      metricsRecorder: createMockMetricsRecorder(true),
      apiKey: 'test-key',
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    // Test circuit breaker reset
    const resetResponse = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
      headers: { 'x-api-key': 'test-key' },
    });
    expect(resetResponse.statusCode).toBe(200);

    // Test metrics
    const metricsResponse = await server.inject({
      method: 'GET',
      url: '/copy/metrics',
    });
    expect(metricsResponse.statusCode).toBe(200);
    const metricsBody = JSON.parse(metricsResponse.body);
    expect(metricsBody.totalPnl).toBeGreaterThan(0);
  });

  it('should support Authorization Bearer header for API key', async () => {
    deps = {
      riskManager: createMockRiskManager(true),
      apiKey: 'bearer-test-key',
    };
    api = new CopyTradingAPI(deps, 0);
    await api.start();
    const server = api.getServer()!;

    const response = await server.inject({
      method: 'POST',
      url: '/copy/circuit-breaker/reset',
      headers: {
        'Authorization': 'Bearer bearer-test-key',
      },
    });

    expect(response.statusCode).toBe(200);
  });
});

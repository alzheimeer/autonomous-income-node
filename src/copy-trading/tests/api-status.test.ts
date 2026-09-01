/**
 * GET /copy/status Endpoint Tests - Task 21.1
 * 
 * Tests for Requirement 9.1:
 * THE Copy_Trading_System SHALL expose a GET /copy/status endpoint returning
 * system health, open positions count, and circuit breaker state
 * 
 * Response fields per task specification:
 * - health: "ok" | "degraded" | "error"
 * - openPositionsCount: number
 * - circuitBreakerActive: boolean
 * - circuitBreakerReason: string | null
 * - timestamp: ISO timestamp
 */

import { describe, it, expect } from 'vitest';
import { CopyTradingAPI, CopyTradingRouteDeps, SystemStatusResponse } from '../routes/copy.js';
import type { FastifyInstance } from 'fastify';
import type { CopyPosition } from '../interfaces/types.js';

// =============================================================================
// Mock Factories
// =============================================================================

const createMockPosition = (overrides: Partial<CopyPosition> = {}): CopyPosition => ({
  id: 'pos-1',
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
  status: 'OPEN',
  openedAt: Date.now(),
  closedAt: null,
  exitPrice: null,
  pnlUsdc: null,
  exitReason: null,
  ...overrides,
});

const createMockCurator = () => ({
  getWallets: () => [],
  getWalletsByTier: () => [],
  addWallet: async () => null,
  removeWallet: () => {},
  reEvaluateAll: async () => {},
  isMonitored: () => false,
});

const createMockExecutor = (positions: CopyPosition[] = []) => ({
  execute: async () => ({ success: true, positionId: 'test-pos', executedPrice: BigInt(1000), gasUsed: BigInt(21000) }),
  getOpenPositions: () => positions,
  getPosition: (id: string) => positions.find(p => p.id === id) ?? null,
  forceClose: async () => true,
  getStats: () => ({
    totalExecuted: 0,
    totalRejected: 0,
    rejectionsByReason: {},
    avgExecutionMs: 0,
  }),
});

interface MockCircuitBreakerState {
  active: boolean;
  blockedUntil: number | null;
  consecutiveLosses: number;
  activationReason?: 'LOSS_STREAK' | 'DAILY_PNL_LIMIT';
}

const createMockRiskManager = (cbState: MockCircuitBreakerState) => ({
  getCircuitBreakerState: () => cbState,
  resetCircuitBreaker: () => {},
  canOpenPosition: () => ({ allowed: !cbState.active }),
  recordPositionResult: () => {},
  getDeploymentStats: () => ({
    dailyDeployedUsdc: 0,
    maxDailyUsdc: 100,
    currentPositions: 0,
    maxPositions: 3,
  }),
});

// Helper to create API and get server
const createAPI = async (deps: CopyTradingRouteDeps): Promise<{ api: CopyTradingAPI; server: FastifyInstance }> => {
  const api = new CopyTradingAPI(deps, 0);
  await api.start();
  const server = api.getServer()!;
  return { api, server };
};

// =============================================================================
// Tests
// =============================================================================

describe('GET /copy/status - Task 21.1 (Requirement 9.1)', () => {
  describe('Response Structure Validation', () => {
    it('should return all required fields per task 21.1 specification', async () => {
      const { api, server } = await createAPI({
        curator: createMockCurator(),
        executor: createMockExecutor([]),
        riskManager: createMockRiskManager({
          active: false,
          blockedUntil: null,
          consecutiveLosses: 0,
        }) as any,
      });

      try {
        const response = await server.inject({
          method: 'GET',
          url: '/copy/status',
        });

        expect(response.statusCode).toBe(200);
        const body: SystemStatusResponse = response.json();

        // Primary fields per task 21.1
        expect(body).toHaveProperty('health');
        expect(body).toHaveProperty('openPositionsCount');
        expect(body).toHaveProperty('circuitBreakerActive');
        expect(body).toHaveProperty('circuitBreakerReason');
        expect(body).toHaveProperty('timestamp');

        // Additional diagnostic fields
        expect(body).toHaveProperty('circuitBreaker');
        expect(body).toHaveProperty('uptime');
      } finally {
        await api.stop();
      }
    });

    it('health field should be valid enum value', async () => {
      const { api, server } = await createAPI({
        curator: createMockCurator(),
        executor: createMockExecutor([]),
        riskManager: createMockRiskManager({
          active: false,
          blockedUntil: null,
          consecutiveLosses: 0,
        }) as any,
      });

      try {
        const response = await server.inject({
          method: 'GET',
          url: '/copy/status',
        });

        const body: SystemStatusResponse = response.json();
        expect(['ok', 'degraded', 'error']).toContain(body.health);
      } finally {
        await api.stop();
      }
    });

    it('timestamp should be valid ISO format', async () => {
      const { api, server } = await createAPI({
        curator: createMockCurator(),
        executor: createMockExecutor([]),
        riskManager: createMockRiskManager({
          active: false,
          blockedUntil: null,
          consecutiveLosses: 0,
        }) as any,
      });

      try {
        const response = await server.inject({
          method: 'GET',
          url: '/copy/status',
        });

        const body: SystemStatusResponse = response.json();
        expect(() => new Date(body.timestamp)).not.toThrow();
        expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      } finally {
        await api.stop();
      }
    });
  });

  describe('Health Status - "ok" state', () => {
    it('should return health="ok" when system is healthy', async () => {
      const { api, server } = await createAPI({
        curator: createMockCurator(),
        executor: createMockExecutor([]),
        riskManager: createMockRiskManager({
          active: false,
          blockedUntil: null,
          consecutiveLosses: 0,
        }) as any,
      });

      try {
        const response = await server.inject({
          method: 'GET',
          url: '/copy/status',
        });

        const body: SystemStatusResponse = response.json();
        expect(body.health).toBe('ok');
        expect(body.circuitBreakerActive).toBe(false);
        expect(body.circuitBreakerReason).toBeNull();
      } finally {
        await api.stop();
      }
    });
  });

  describe('Health Status - "degraded" state', () => {
    it('should return health="degraded" when circuit breaker is active', async () => {
      const blockedUntil = Date.now() + 24 * 60 * 60 * 1000;
      
      const { api, server } = await createAPI({
        curator: createMockCurator(),
        executor: createMockExecutor([]),
        riskManager: createMockRiskManager({
          active: true,
          blockedUntil,
          consecutiveLosses: 3,
          activationReason: 'LOSS_STREAK',
        }) as any,
      });

      try {
        const response = await server.inject({
          method: 'GET',
          url: '/copy/status',
        });

        const body: SystemStatusResponse = response.json();
        expect(body.health).toBe('degraded');
        expect(body.circuitBreakerActive).toBe(true);
        expect(body.circuitBreakerReason).toBe('LOSS_STREAK');
      } finally {
        await api.stop();
      }
    });
  });

  describe('Health Status - "error" state', () => {
    it('should return health="error" when critical components missing', async () => {
      const { api, server } = await createAPI({
        riskManager: createMockRiskManager({
          active: false,
          blockedUntil: null,
          consecutiveLosses: 0,
        }) as any,
      });

      try {
        const response = await server.inject({
          method: 'GET',
          url: '/copy/status',
        });

        const body: SystemStatusResponse = response.json();
        expect(body.health).toBe('error');
      } finally {
        await api.stop();
      }
    });
  });

  describe('Open Positions Count', () => {
    it('should return correct openPositionsCount', async () => {
      const positions = [
        createMockPosition({ id: 'pos-1' }),
        createMockPosition({ id: 'pos-2' }),
        createMockPosition({ id: 'pos-3' }),
      ];

      const { api, server } = await createAPI({
        curator: createMockCurator(),
        executor: createMockExecutor(positions),
        riskManager: createMockRiskManager({
          active: false,
          blockedUntil: null,
          consecutiveLosses: 0,
        }) as any,
      });

      try {
        const response = await server.inject({
          method: 'GET',
          url: '/copy/status',
        });

        const body: SystemStatusResponse = response.json();
        expect(body.openPositionsCount).toBe(3);
      } finally {
        await api.stop();
      }
    });
  });
});

/**
 * Integration tests for GET /trading/pipeline-metrics
 *
 * Tests the complete flow with real in-memory SQLite database,
 * verifying authentication, query parameters, and response structure.
 *
 * **Validates: Requirements 16.1, 6.1, 6.5**
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerPipelineMetricsRoute } from './api-route.js';
import { MetricsDatabase } from './metrics-database.js';
import type { OperatorAuth, IOperatorAuthenticator } from '../trading-validation/operator-authenticator.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Setup
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a mock authenticator that supports both API key and Telegram auth
 */
function createTestAuthenticator(options?: {
  alwaysVerified?: boolean;
  rateLimited?: boolean;
}): IOperatorAuthenticator {
  const alwaysVerified = options?.alwaysVerified ?? false;
  const rateLimited = options?.rateLimited ?? false;

  return {
    verifyApiKey: vi.fn((key: string): OperatorAuth => ({
      source: 'api_key' as const,
      timestamp: Date.now(),
      verified: alwaysVerified || key === 'test-valid-api-key',
    })),
    verifyTelegram: vi.fn((chatId: string, secret: string): OperatorAuth => ({
      source: 'telegram' as const,
      chatId,
      timestamp: Date.now(),
      verified: alwaysVerified || (chatId === 'test-chat-id' && secret === 'test-secret'),
    })),
    isPrivilegedCommand: vi.fn(() => false),
    authorizeCommand: vi.fn((_cmd: string, auth: OperatorAuth) => auth.verified),
    checkRateLimit: vi.fn(() => !rateLimited),
  };
}

/**
 * Pre-populate database with test events and related data
 */
function seedTestData(db: MetricsDatabase): void {
  const now = Date.now();
  const hourMs = 60 * 60 * 1000;
  const sessionId = 'integration-test-session';

  // Insert evaluation_started events (10 events over last 2 hours)
  for (let i = 0; i < 10; i++) {
    db.insertEvent(
      now - (i * 12 * 60 * 1000), // every 12 minutes
      'evaluation_started',
      { pair: 'ETHUSDC', iteration: i },
      sessionId,
    );
  }

  // Insert indicators_computed events with regime info
  const regimes = ['TRENDING_UP', 'TRENDING_UP', 'RANGING', 'VOLATILE', 'UNCERTAIN'];
  for (let i = 0; i < 5; i++) {
    db.insertEvent(
      now - (i * 24 * 60 * 1000),
      'indicators_computed',
      { regime: regimes[i], ema20: 2000 + i * 10 },
      sessionId,
    );
  }

  // Insert strategy_signal_generated events (3 signals)
  for (let i = 0; i < 3; i++) {
    db.insertEvent(
      now - (i * 40 * 60 * 1000),
      'strategy_signal_generated',
      { strategy: 'trend_pullback', regime: 'TRENDING_UP' },
      sessionId,
    );
  }

  // Insert strategy_no_signal events with near-misses
  const noSignalEventId = db.insertEvent(
    now - 30 * 60 * 1000,
    'strategy_no_signal',
    { subReason: 'trend_rsi_out_of_range', regime: 'TRENDING_UP' },
    sessionId,
  );

  // Insert near-miss for the no_signal event
  if (noSignalEventId > 0) {
    db.insertNearMiss(noSignalEventId, 'rsi14', 34.2, 35, 0.8);
    db.insertNearMiss(noSignalEventId, 'volume_z', 0.95, 1.0, 0.05);
  }

  // Insert gate_passed events (2)
  for (let i = 0; i < 2; i++) {
    db.insertEvent(
      now - (i * 50 * 60 * 1000),
      'gate_passed',
      { netProfit: 0.0015 },
      sessionId,
    );
  }

  // Insert gate_rejected event with rejection reasons
  const rejectedEventId = db.insertEvent(
    now - 15 * 60 * 1000,
    'gate_rejected',
    { rejectReasons: ['profit_below_min_usd', 'entry_impact_high'] },
    sessionId,
  );

  if (rejectedEventId > 0) {
    db.insertRejection(rejectedEventId, 'profit_below_min_usd', '0.004');
    db.insertRejection(rejectedEventId, 'entry_impact_high', '35');
  }

  // Insert trade_executed event
  db.insertEvent(
    now - 60 * 60 * 1000,
    'trade_executed',
    { mode: 'shadow', candidateId: 'test-candidate-1' },
    sessionId,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Integration Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Integration: GET /trading/pipeline-metrics', () => {
  let fastify: FastifyInstance;
  let db: MetricsDatabase;

  beforeEach(async () => {
    fastify = Fastify();
    // Use in-memory SQLite for isolation
    db = new MetricsDatabase(':memory:');
  });

  afterEach(async () => {
    await fastify.close();
    db.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication Tests (Requirement 6.1, 6.2)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('should return 401 Unauthorized when no credentials provided', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Unauthorized');
      expect(body.message).toContain('API key or Telegram credentials');
    });

    it('should return 401 when invalid API key provided', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer invalid-key' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return 200 with valid API key authentication', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      expect(authenticator.verifyApiKey).toHaveBeenCalledWith('test-valid-api-key');
    });

    it('should return 200 with valid Telegram authentication', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: {
          'x-telegram-chat-id': 'test-chat-id',
          'x-telegram-secret': 'test-secret',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(authenticator.verifyTelegram).toHaveBeenCalledWith('test-chat-id', 'test-secret');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Query Parameter Tests (Requirement 6.3)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Query Parameters', () => {
    it('should use default window of 24 hours when not specified', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.window).toBe(24);
    });

    it('should accept custom window parameter', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?window=48',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.window).toBe(48);
    });

    it('should clamp window to maximum of 168 hours', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?window=500',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.window).toBe(168);
    });

    it('should clamp window to minimum of 1 hour', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?window=0',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.window).toBe(1);
    });

    it('should handle invalid window parameter gracefully (use default)', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?window=abc',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.window).toBe(24); // default when NaN
    });

    it('should NOT include events by default', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.events).toBeUndefined();
    });

    it('should include last 10 events when include_events=true', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?include_events=true',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.events).toBeDefined();
      expect(Array.isArray(body.events)).toBe(true);
      expect(body.events.length).toBeLessThanOrEqual(10);
      // Verify event structure
      if (body.events.length > 0) {
        const event = body.events[0];
        expect(event).toHaveProperty('id');
        expect(event).toHaveProperty('timestamp');
        expect(event).toHaveProperty('event_type');
        expect(event).toHaveProperty('session_id');
      }
    });

    it('should accept include_events=1 as truthy', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?include_events=1',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.events).toBeDefined();
    });

    it('should accept include_events=yes as truthy', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?include_events=yes',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.events).toBeDefined();
    });

    it('should NOT include near_misses by default', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.near_misses).toBeUndefined();
    });

    it('should include last 10 near_misses when include_near_misses=true', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?include_near_misses=true',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.near_misses).toBeDefined();
      expect(Array.isArray(body.near_misses)).toBe(true);
      // Verify near-miss structure
      if (body.near_misses.length > 0) {
        const nearMiss = body.near_misses[0];
        expect(nearMiss).toHaveProperty('id');
        expect(nearMiss).toHaveProperty('event_id');
        expect(nearMiss).toHaveProperty('indicator_name');
        expect(nearMiss).toHaveProperty('actual_value');
        expect(nearMiss).toHaveProperty('threshold_value');
        expect(nearMiss).toHaveProperty('distance');
      }
    });

    it('should include both events and near_misses when both params are true', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?include_events=true&include_near_misses=true',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      expect(body.events).toBeDefined();
      expect(body.near_misses).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Response Structure Tests (Requirement 6.4)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Response Structure', () => {
    it('should return aggregate metrics in correct structure', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      // Verify top-level structure
      expect(body).toHaveProperty('metrics');
      expect(body).toHaveProperty('window');
      expect(body).toHaveProperty('timestamp');
      expect(typeof body.timestamp).toBe('number');

      // Verify metrics structure
      const { metrics } = body;
      expect(metrics).toHaveProperty('signalsPerHour');
      expect(metrics).toHaveProperty('evaluationsPerHour');
      expect(metrics).toHaveProperty('regimeDistribution');
      expect(metrics).toHaveProperty('rejectionDistribution');
      expect(metrics).toHaveProperty('nearMissFrequency');
      expect(metrics).toHaveProperty('passThroughRate');
      expect(metrics).toHaveProperty('dataIncomplete');

      // Verify types
      expect(typeof metrics.signalsPerHour).toBe('number');
      expect(typeof metrics.evaluationsPerHour).toBe('number');
      expect(typeof metrics.regimeDistribution).toBe('object');
      expect(typeof metrics.rejectionDistribution).toBe('object');
      expect(typeof metrics.nearMissFrequency).toBe('object');
      expect(typeof metrics.passThroughRate).toBe('number');
      expect(typeof metrics.dataIncomplete).toBe('boolean');
    });

    it('should return metrics computed from pre-populated test data', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const { metrics } = body;

      // We seeded 10 evaluation_started events
      expect(metrics.evaluationsPerHour).toBeGreaterThan(0);

      // We seeded 3 strategy_signal_generated events
      expect(metrics.signalsPerHour).toBeGreaterThan(0);

      // We seeded 2 gate_passed and 1 gate_rejected
      // passThroughRate = 2 / (2 + 1) = 0.666...
      expect(metrics.passThroughRate).toBeGreaterThan(0);
      expect(metrics.passThroughRate).toBeLessThanOrEqual(1);

      // We seeded rejections
      expect(Object.keys(metrics.rejectionDistribution).length).toBeGreaterThan(0);

      // We seeded near-misses
      expect(Object.keys(metrics.nearMissFrequency).length).toBeGreaterThan(0);
    });

    it('should return empty metrics when database has no events', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      // Don't seed any data

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);
      const { metrics } = body;

      expect(metrics.signalsPerHour).toBe(0);
      expect(metrics.evaluationsPerHour).toBe(0);
      expect(metrics.passThroughRate).toBe(0);
      expect(metrics.dataIncomplete).toBe(true); // No data = incomplete
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Database Unavailable Tests (Requirement 6.5)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Database Unavailable (503)', () => {
    it('should return 503 when MetricsDatabase is in degraded mode', async () => {
      const authenticator = createTestAuthenticator();
      
      // Create a degraded database by using an invalid path
      // Note: We need to simulate degraded mode
      const degradedDb = new MetricsDatabase('/nonexistent/path/that/cannot/exist/metrics.db');
      
      registerPipelineMetricsRoute(fastify, { db: degradedDb, authenticator });

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(503);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Service Unavailable');
      expect(body.message).toContain('Metrics database is unavailable');

      degradedDb.close();
    });

    it('should indicate isDegraded property correctly', async () => {
      // In-memory DB should not be degraded
      expect(db.isDegraded).toBe(false);

      // Invalid path should be degraded
      const degradedDb = new MetricsDatabase('/nonexistent/path/metrics.db');
      expect(degradedDb.isDegraded).toBe(true);
      degradedDb.close();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Rate Limiting Tests
  // ─────────────────────────────────────────────────────────────────────────

  describe('Rate Limiting', () => {
    it('should return 429 when rate limited', async () => {
      const authenticator = createTestAuthenticator({ rateLimited: true });
      registerPipelineMetricsRoute(fastify, { db, authenticator });

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(429);
      const body = JSON.parse(response.payload);
      expect(body.error).toBe('Rate limit exceeded');
    });

    it('should extract client IP from CF-Connecting-IP header', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: {
          authorization: 'Bearer test-valid-api-key',
          'cf-connecting-ip': '203.0.113.50',
        },
      });

      expect(authenticator.checkRateLimit).toHaveBeenCalledWith('203.0.113.50');
    });

    it('should extract client IP from X-Forwarded-For header', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics',
        headers: {
          authorization: 'Bearer test-valid-api-key',
          'x-forwarded-for': '198.51.100.1, 192.0.2.1',
        },
      });

      // Should use the first IP in the chain
      expect(authenticator.checkRateLimit).toHaveBeenCalledWith('198.51.100.1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Combined Scenarios
  // ─────────────────────────────────────────────────────────────────────────

  describe('Combined Scenarios', () => {
    it('should handle full request with all parameters', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const response = await fastify.inject({
        method: 'GET',
        url: '/trading/pipeline-metrics?window=72&include_events=true&include_near_misses=true',
        headers: { authorization: 'Bearer test-valid-api-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.payload);

      expect(body.window).toBe(72);
      expect(body.metrics).toBeDefined();
      expect(body.events).toBeDefined();
      expect(body.near_misses).toBeDefined();
      expect(body.timestamp).toBeDefined();
    });

    it('should process multiple concurrent requests correctly', async () => {
      const authenticator = createTestAuthenticator();
      registerPipelineMetricsRoute(fastify, { db, authenticator });
      seedTestData(db);

      const requests = Array.from({ length: 5 }, (_, i) => 
        fastify.inject({
          method: 'GET',
          url: `/trading/pipeline-metrics?window=${24 + i}`,
          headers: { authorization: 'Bearer test-valid-api-key' },
        })
      );

      const responses = await Promise.all(requests);

      for (let i = 0; i < responses.length; i++) {
        expect(responses[i].statusCode).toBe(200);
        const body = JSON.parse(responses[i].payload);
        expect(body.window).toBe(24 + i);
      }
    });
  });
});

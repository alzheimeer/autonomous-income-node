/**
 * Unit tests for pipeline-metrics API route.
 *
 * Tests: authentication, rate limiting, query parameter parsing,
 * aggregate metrics response, optional events/near-misses, 503 on degraded DB.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerPipelineMetricsRoute } from './api-route.js';
import type { OperatorAuth } from '../trading-validation/operator-authenticator.js';
import type { PipelineEvent, NearMissRecord } from './metrics-database.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mocks
// ═══════════════════════════════════════════════════════════════════════════

function createMockAuthenticator(options?: { verified?: boolean; rateLimited?: boolean }) {
  const verified = options?.verified ?? true;
  const rateLimited = options?.rateLimited ?? false;

  return {
    verifyApiKey: vi.fn((key: string): OperatorAuth => ({
      source: 'api_key' as const,
      timestamp: Date.now(),
      verified: verified && key === 'valid-key',
    })),
    verifyTelegram: vi.fn((chatId: string, secret: string): OperatorAuth => ({
      source: 'telegram' as const,
      chatId,
      timestamp: Date.now(),
      verified: verified && chatId === '12345' && secret === 'valid-secret',
    })),
    isPrivilegedCommand: vi.fn(() => false),
    authorizeCommand: vi.fn((_cmd: string, auth: OperatorAuth) => auth.verified),
    checkRateLimit: vi.fn(() => !rateLimited),
  };
}

function createMockMetricsDb(options?: { degraded?: boolean }) {
  const degraded = options?.degraded ?? false;

  const mockEvents: PipelineEvent[] = [
    {
      id: 1,
      timestamp: Date.now() - 1000,
      event_type: 'evaluation_started',
      details: { pair: 'ETHUSDC' },
      session_id: 'test-session-1',
    },
    {
      id: 2,
      timestamp: Date.now() - 500,
      event_type: 'strategy_signal_generated',
      details: { strategy: 'trend_pullback' },
      session_id: 'test-session-1',
    },
  ];

  const mockNearMisses: NearMissRecord[] = [
    {
      id: 1,
      event_id: 3,
      indicator_name: 'rsi14',
      actual_value: 34.5,
      threshold_value: 35,
      distance: 0.5,
    },
  ];

  return {
    get isDegraded() { return degraded; },
    queryEvents: vi.fn(() => mockEvents),
    queryNearMisses: vi.fn(() => mockNearMisses),
    queryRejections: vi.fn(() => []),
    insertEvent: vi.fn(() => 1),
    insertRejection: vi.fn(() => 1),
    insertNearMiss: vi.fn(() => 1),
    close: vi.fn(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('GET /trading/pipeline-metrics', () => {
  let fastify: FastifyInstance;

  beforeEach(async () => {
    fastify = Fastify();
  });

  it('returns 401 when no auth credentials provided', async () => {
    const authenticator = createMockAuthenticator({ verified: false });
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics',
    });

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('Unauthorized');
  });

  it('returns 429 when rate limited', async () => {
    const authenticator = createMockAuthenticator({ rateLimited: true });
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics',
      headers: { authorization: 'Bearer valid-key' },
    });

    expect(response.statusCode).toBe(429);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('Rate limit exceeded');
  });

  it('returns 503 when database is degraded', async () => {
    const authenticator = createMockAuthenticator();
    const db = createMockMetricsDb({ degraded: true });

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics',
      headers: { authorization: 'Bearer valid-key' },
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.payload);
    expect(body.error).toBe('Service Unavailable');
  });

  it('returns aggregate metrics with default window (24h)', async () => {
    const authenticator = createMockAuthenticator();
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics',
      headers: { authorization: 'Bearer valid-key' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.metrics).toBeDefined();
    expect(body.window).toBe(24);
    expect(body.timestamp).toBeTypeOf('number');
    // Should not include events or near_misses by default
    expect(body.events).toBeUndefined();
    expect(body.near_misses).toBeUndefined();
  });

  it('accepts window query param and clamps to max 168', async () => {
    const authenticator = createMockAuthenticator();
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics?window=200',
      headers: { authorization: 'Bearer valid-key' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.window).toBe(168); // clamped to max
  });

  it('includes last 10 events when include_events=true', async () => {
    const authenticator = createMockAuthenticator();
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics?include_events=true',
      headers: { authorization: 'Bearer valid-key' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.events).toBeDefined();
    expect(Array.isArray(body.events)).toBe(true);
    expect(db.queryEvents).toHaveBeenCalledWith({ limit: 10 });
  });

  it('includes last 10 near-misses when include_near_misses=true', async () => {
    const authenticator = createMockAuthenticator();
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics?include_near_misses=true',
      headers: { authorization: 'Bearer valid-key' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.near_misses).toBeDefined();
    expect(Array.isArray(body.near_misses)).toBe(true);
    expect(db.queryNearMisses).toHaveBeenCalledWith({ limit: 10 });
  });

  it('supports Telegram authentication', async () => {
    const authenticator = createMockAuthenticator();
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics',
      headers: {
        'x-telegram-chat-id': '12345',
        'x-telegram-secret': 'valid-secret',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(authenticator.verifyTelegram).toHaveBeenCalledWith('12345', 'valid-secret');
  });

  it('uses CF-Connecting-IP for rate limiting', async () => {
    const authenticator = createMockAuthenticator();
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics',
      headers: {
        authorization: 'Bearer valid-key',
        'cf-connecting-ip': '1.2.3.4',
      },
    });

    expect(authenticator.checkRateLimit).toHaveBeenCalledWith('1.2.3.4');
  });

  it('clamps window minimum to 1', async () => {
    const authenticator = createMockAuthenticator();
    const db = createMockMetricsDb();

    registerPipelineMetricsRoute(fastify, { db: db as never, authenticator });

    const response = await fastify.inject({
      method: 'GET',
      url: '/trading/pipeline-metrics?window=0',
      headers: { authorization: 'Bearer valid-key' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.window).toBe(1); // clamped to min
  });
});

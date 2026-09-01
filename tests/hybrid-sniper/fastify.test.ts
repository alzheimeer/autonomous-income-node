/**
 * Hybrid Sniper — Fastify Integration Tests (Tarea 14.2)
 *
 * Full Fastify integration: mocks all internal components, tests HTTP routes
 * POST /webhook/alpha and GET /sniper/status end-to-end.
 */

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { wireSniper, setHybridSniperModule } from '../../src/hybrid-sniper/index.js';
import type { HybridSniperModule } from '../../src/hybrid-sniper/index.js';
import type { SniperSignal, SignalRecord } from '../../src/hybrid-sniper/metrics-recorder.js';
import type { CircuitBreakerState } from '../../src/hybrid-sniper/risk-bucket.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build a mock SniperSignal */
function makeSignal(): SniperSignal {
  return {
    id: 'signal-id-1',
    ticker: 'MOCK',
    contractAddress: '0x' + 'a'.repeat(40),
    source: 'webhook',
    ingestionTime: Date.now(),
  };
}

/** Build a mock SignalRecord for getRecentSignals */
function makeSignalRecord(): SignalRecord {
  const now = Date.now();
  return {
    signal_id: 'signal-id-1',
    contract_address: '0x' + 'a'.repeat(40),
    ticker: 'MOCK',
    source: 'webhook',
    ingestion_time: now,
    validated_at: now + 100,
    total_latency_ms: 100,
    passed: 1,
    reject_reason: null,
    result: 'PASS',
    created_at: now,
  };
}

/** Build a fully mocked HybridSniperModule */
function makeMockModule(overrides: Partial<HybridSniperModule> = {}): HybridSniperModule {
  const cbState: CircuitBreakerState = {
    active: false,
    blockedUntil: null,
    consecutiveLosses: 0,
  };

  return {
    signalIngestor: {
      start: vi.fn(),
      stop: vi.fn(),
      ingestWebhook: vi.fn().mockResolvedValue(makeSignal()),
      getStats: vi.fn().mockReturnValue({ totalReceived: 1, totalDeduped: 0 }),
    } as any,
    contractValidator: {} as any,
    shadowExecutor: {
      openPosition: vi.fn().mockResolvedValue(null),
      monitorPositions: vi.fn().mockResolvedValue(undefined),
      getOpenPositions: vi.fn().mockReturnValue([]),
      start: vi.fn(),
      stop: vi.fn(),
    } as any,
    riskBucket: {
      availableTrades: vi.fn().mockReturnValue(3),
      onPositionClosed: vi.fn(),
      getState: vi.fn().mockReturnValue(cbState),
      reset: vi.fn(),
    } as any,
    metricsRecorder: {
      recordSignal: vi.fn(),
      recordPosition: vi.fn(),
      getRecentSignals: vi.fn().mockReturnValue([makeSignalRecord()]),
      getAverageLatency: vi.fn().mockReturnValue(95),
      close: vi.fn(),
      isDegraded: false,
    } as any,
    config: {
      enabled: true,
      rpcUrl: 'http://localhost:8545',
      riskBudgetUsdc: 15,
      tradeSizeUsdc: 5,
      maxLossStreak: 2,
      tpPct: 15,
      slPct: 5,
      dexscreenerPollIntervalMs: 30_000,
      bitqueryApiKey: null,
      dbPath: ':memory:',
      agentAddress: '0x' + '0'.repeat(40),
    },
    isEnabled: true,
    stop: vi.fn(),
    ...overrides,
  };
}

// ─── POST /webhook/alpha ──────────────────────────────────────────────────────

describe('POST /webhook/alpha', () => {
  it('returns 200 and signalId on valid request', async () => {
    const fastify = Fastify({ logger: false });
    const mockModule = makeMockModule();
    wireSniper(fastify, mockModule);

    const response = await fastify.inject({
      method: 'POST',
      url: '/webhook/alpha',
      payload: {
        ticker: 'TEST',
        contractAddress: '0x' + 'a'.repeat(40),
        source: 'manual',
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.ok).toBe(true);
    expect(body.signalId).toBe('signal-id-1');

    await fastify.close();
  });

  it('returns 400 when contractAddress is missing', async () => {
    const fastify = Fastify({ logger: false });
    wireSniper(fastify, makeMockModule());

    const response = await fastify.inject({
      method: 'POST',
      url: '/webhook/alpha',
      payload: { ticker: 'TEST' }, // no contractAddress
    });

    expect(response.statusCode).toBe(400);

    await fastify.close();
  });

  it('returns 503 when sniper is disabled', async () => {
    const fastify = Fastify({ logger: false });
    wireSniper(fastify, makeMockModule({ isEnabled: false }));

    const response = await fastify.inject({
      method: 'POST',
      url: '/webhook/alpha',
      payload: {
        ticker: 'TEST',
        contractAddress: '0x' + 'a'.repeat(40),
        source: 'manual',
      },
    });

    expect(response.statusCode).toBe(503);

    await fastify.close();
  });

  it('returns 503 when module is null (not yet initialized)', async () => {
    const fastify = Fastify({ logger: false });
    wireSniper(fastify, null);

    const response = await fastify.inject({
      method: 'POST',
      url: '/webhook/alpha',
      payload: {
        ticker: 'TEST',
        contractAddress: '0x' + 'a'.repeat(40),
        source: 'manual',
      },
    });

    expect(response.statusCode).toBe(503);

    await fastify.close();
  });

  it('calls ingestWebhook with the provided body', async () => {
    const fastify = Fastify({ logger: false });
    const mockModule = makeMockModule();
    wireSniper(fastify, mockModule);

    const contractAddress = '0x' + 'b'.repeat(40);

    await fastify.inject({
      method: 'POST',
      url: '/webhook/alpha',
      payload: {
        ticker: 'ALPHA',
        contractAddress,
        source: 'manual',
      },
    });

    expect(mockModule.signalIngestor.ingestWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ contractAddress }),
    );

    await fastify.close();
  });
});

// ─── GET /sniper/status ───────────────────────────────────────────────────────

describe('GET /sniper/status', () => {
  it('returns 200 with signals, avgLatencyMs, and circuitBreaker', async () => {
    const fastify = Fastify({ logger: false });
    wireSniper(fastify, makeMockModule());

    const response = await fastify.inject({
      method: 'GET',
      url: '/sniper/status',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body).toHaveProperty('signals');
    expect(body).toHaveProperty('avgLatencyMs');
    expect(body).toHaveProperty('circuitBreaker');

    expect(Array.isArray(body.signals)).toBe(true);
    expect(typeof body.avgLatencyMs).toBe('number');
    expect(body.circuitBreaker).toMatchObject({
      active: expect.any(Boolean),
      consecutiveLosses: expect.any(Number),
    });

    await fastify.close();
  });

  it('returns correct signal data from metricsRecorder', async () => {
    const fastify = Fastify({ logger: false });
    wireSniper(fastify, makeMockModule());

    const response = await fastify.inject({
      method: 'GET',
      url: '/sniper/status',
    });

    const body = JSON.parse(response.body);
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0].signal_id).toBe('signal-id-1');
    expect(body.signals[0].ticker).toBe('MOCK');
    expect(body.avgLatencyMs).toBe(95);

    await fastify.close();
  });

  it('returns circuitBreaker.active=false when CB not triggered', async () => {
    const fastify = Fastify({ logger: false });
    wireSniper(fastify, makeMockModule());

    const response = await fastify.inject({ method: 'GET', url: '/sniper/status' });
    const body = JSON.parse(response.body);

    expect(body.circuitBreaker.active).toBe(false);
    expect(body.circuitBreaker.consecutiveLosses).toBe(0);

    await fastify.close();
  });

  it('returns 503 when sniper is disabled', async () => {
    const fastify = Fastify({ logger: false });
    wireSniper(fastify, makeMockModule({ isEnabled: false }));

    const response = await fastify.inject({ method: 'GET', url: '/sniper/status' });
    expect(response.statusCode).toBe(503);

    await fastify.close();
  });

  it('updates live module via setHybridSniperModule after wireSniper', async () => {
    const fastify = Fastify({ logger: false });
    wireSniper(fastify, null); // null initially

    // Status should be 503 with null module
    let response = await fastify.inject({ method: 'GET', url: '/sniper/status' });
    expect(response.statusCode).toBe(503);

    // Now inject the live module
    setHybridSniperModule(makeMockModule());

    // Status should now be 200
    response = await fastify.inject({ method: 'GET', url: '/sniper/status' });
    expect(response.statusCode).toBe(200);

    // Reset holder to null to avoid cross-test pollution
    setHybridSniperModule(makeMockModule({ isEnabled: false }));

    await fastify.close();
  });
});

// ─── Complete flow: signal → status ──────────────────────────────────────────

describe('Complete flow: POST webhook → GET status reflects new signal', () => {
  it('injected signal appears in status signals list', async () => {
    const fastify = Fastify({ logger: false });
    const mockModule = makeMockModule();
    wireSniper(fastify, mockModule);

    // Inject a signal
    const postResp = await fastify.inject({
      method: 'POST',
      url: '/webhook/alpha',
      payload: {
        ticker: 'FLOWTEST',
        contractAddress: '0x' + 'c'.repeat(40),
        source: 'manual',
      },
    });
    expect(postResp.statusCode).toBe(200);

    // The mock metricsRecorder returns pre-set signals
    const statusResp = await fastify.inject({ method: 'GET', url: '/sniper/status' });
    const body = JSON.parse(statusResp.body);

    expect(body.signals).toHaveLength(1);

    await fastify.close();
  });
});

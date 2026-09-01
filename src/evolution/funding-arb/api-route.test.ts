/**
 * Funding Arb API Route — Unit Tests
 *
 * Validates: Requirements 10.1, 10.2, 10.3
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerFundingArbRoutes, type FundingArbApiResponse } from './api-route.js';
import type { BacktestResultRow } from './database.js';

// ─── Mocks ───────────────────────────────────────────────────────────────────

/** Minimal Fastify mock for testing route registration */
function createFastifyMock() {
  const routes = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();

  return {
    get: vi.fn((path: string, handler: (request: unknown, reply: unknown) => Promise<unknown>) => {
      routes.set(path, handler);
    }),
    getHandler: (path: string) => routes.get(path),
  };
}

/** Minimal reply mock */
function createReplyMock() {
  const mock = {
    statusCode: 200,
    body: null as unknown,
    status: vi.fn((code: number) => {
      mock.statusCode = code;
      return mock;
    }),
    send: vi.fn((body: unknown) => {
      mock.body = body;
      return mock;
    }),
  };
  return mock;
}

/** Create a mock FundingDatabase with configurable getLatestResults */
function createDbMock(results: BacktestResultRow[]) {
  return {
    getLatestResults: vi.fn(() => results),
    isDegraded: false,
  } as unknown as Parameters<typeof registerFundingArbRoutes>[1];
}

/** Helper to build a BacktestResultRow */
function makeResult(overrides: Partial<BacktestResultRow> = {}): BacktestResultRow {
  return {
    run_id: 'run-001',
    created_at: '2026-07-24T12:00:00.000Z',
    coin: 'ETH',
    capital_usdc: 1000_000_000n,
    net_pnl: 50_000_000n,
    gross_funding: 100_000_000n,
    total_costs: 50_000_000n,
    alpha: 30_000_000n,
    max_drawdown_bps: 800,
    liquidation_count: 0,
    stress_events: 1,
    hours_simulated: 2160,
    verdict: 'VIABLE',
    cost_scenario: 'optimistic',
    evidence: '{}',
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('registerFundingArbRoutes', () => {
  it('registers a GET route at /evolution/funding-arb', () => {
    const fastify = createFastifyMock();
    const db = createDbMock([]);
    registerFundingArbRoutes(fastify as unknown as Parameters<typeof registerFundingArbRoutes>[0], db);

    expect(fastify.get).toHaveBeenCalledWith('/evolution/funding-arb', expect.any(Function));
  });
});

describe('GET /evolution/funding-arb', () => {
  let fastify: ReturnType<typeof createFastifyMock>;

  beforeEach(() => {
    fastify = createFastifyMock();
  });

  it('returns no_data status when no results exist', async () => {
    const db = createDbMock([]);
    registerFundingArbRoutes(fastify as unknown as Parameters<typeof registerFundingArbRoutes>[0], db);

    const handler = fastify.getHandler('/evolution/funding-arb')!;
    const reply = createReplyMock();
    await handler({}, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    const response = reply.body as FundingArbApiResponse;
    expect(response.status).toBe('no_data');
    expect(response.message).toBe('No backtest results found');
    expect(response.results).toBeUndefined();
  });

  it('returns ok status with results when data exists', async () => {
    const results = [
      makeResult({ coin: 'ETH', verdict: 'VIABLE', alpha: 30_000_000n }),
      makeResult({ coin: 'BTC', verdict: 'UNVIABLE', alpha: -5_000_000n }),
    ];
    const db = createDbMock(results);
    registerFundingArbRoutes(fastify as unknown as Parameters<typeof registerFundingArbRoutes>[0], db);

    const handler = fastify.getHandler('/evolution/funding-arb')!;
    const reply = createReplyMock();
    await handler({}, reply);

    expect(reply.status).toHaveBeenCalledWith(200);
    const response = reply.body as FundingArbApiResponse;
    expect(response.status).toBe('ok');
    expect(response.results).toBeDefined();
    expect(response.results!.runId).toBe('run-001');
    expect(response.results!.timestamp).toBe('2026-07-24T12:00:00.000Z');
    expect(response.results!.coins).toHaveLength(2);
    expect(response.results!.overallVerdict).toBe('VIABLE');
    expect(response.results!.costScenario).toBe('optimistic');
  });

  it('serializes BigInt values as strings', async () => {
    const results = [makeResult({ net_pnl: 123_456_789n, alpha: 99_000_000n })];
    const db = createDbMock(results);
    registerFundingArbRoutes(fastify as unknown as Parameters<typeof registerFundingArbRoutes>[0], db);

    const handler = fastify.getHandler('/evolution/funding-arb')!;
    const reply = createReplyMock();
    await handler({}, reply);

    const response = reply.body as FundingArbApiResponse;
    const ethCoin = response.results!.coins.find((c) => c.coin === 'ETH')!;
    expect(ethCoin.netPnl).toBe('123456789');
    expect(ethCoin.alpha).toBe('99000000');
  });

  it('finds optimal capital as smallest viable capital', async () => {
    const results = [
      makeResult({ capital_usdc: 2000_000_000n, verdict: 'VIABLE' }),
      makeResult({ capital_usdc: 500_000_000n, verdict: 'VIABLE' }),
      makeResult({ capital_usdc: 100_000_000n, verdict: 'UNVIABLE' }),
    ];
    const db = createDbMock(results);
    registerFundingArbRoutes(fastify as unknown as Parameters<typeof registerFundingArbRoutes>[0], db);

    const handler = fastify.getHandler('/evolution/funding-arb')!;
    const reply = createReplyMock();
    await handler({}, reply);

    const response = reply.body as FundingArbApiResponse;
    expect(response.results!.optimalCapital).toBe('500000000');
  });

  it('returns null optimalCapital when no viable results', async () => {
    const results = [
      makeResult({ verdict: 'UNVIABLE', alpha: -10_000_000n }),
    ];
    const db = createDbMock(results);
    registerFundingArbRoutes(fastify as unknown as Parameters<typeof registerFundingArbRoutes>[0], db);

    const handler = fastify.getHandler('/evolution/funding-arb')!;
    const reply = createReplyMock();
    await handler({}, reply);

    const response = reply.body as FundingArbApiResponse;
    expect(response.results!.optimalCapital).toBeNull();
    expect(response.results!.overallVerdict).toBe('UNVIABLE');
  });

  it('groups by coin and picks best result per coin', async () => {
    const results = [
      makeResult({ coin: 'ETH', verdict: 'VIABLE', alpha: 10_000_000n }),
      makeResult({ coin: 'ETH', verdict: 'VIABLE', alpha: 50_000_000n }),
      makeResult({ coin: 'ETH', verdict: 'UNVIABLE', alpha: -5_000_000n }),
    ];
    const db = createDbMock(results);
    registerFundingArbRoutes(fastify as unknown as Parameters<typeof registerFundingArbRoutes>[0], db);

    const handler = fastify.getHandler('/evolution/funding-arb')!;
    const reply = createReplyMock();
    await handler({}, reply);

    const response = reply.body as FundingArbApiResponse;
    // Should group into 1 coin (ETH) with the best alpha (50M)
    expect(response.results!.coins).toHaveLength(1);
    expect(response.results!.coins[0].alpha).toBe('50000000');
  });

  it('prefers VIABLE over UNVIABLE when grouping coins', async () => {
    const results = [
      makeResult({ coin: 'ETH', verdict: 'UNVIABLE', alpha: 100_000_000n }),
      makeResult({ coin: 'ETH', verdict: 'VIABLE', alpha: 5_000_000n }),
    ];
    const db = createDbMock(results);
    registerFundingArbRoutes(fastify as unknown as Parameters<typeof registerFundingArbRoutes>[0], db);

    const handler = fastify.getHandler('/evolution/funding-arb')!;
    const reply = createReplyMock();
    await handler({}, reply);

    const response = reply.body as FundingArbApiResponse;
    expect(response.results!.coins[0].verdict).toBe('VIABLE');
    expect(response.results!.coins[0].alpha).toBe('5000000');
  });
});

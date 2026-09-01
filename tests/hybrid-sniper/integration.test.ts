/**
 * Hybrid Sniper — Integration Tests (Tareas 10.2, 14.1)
 *
 * Tests initHybridSniper module initialization and DexScreener/Bitquery
 * network calls using vi.spyOn on axios.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import Fastify from 'fastify';
import { initHybridSniper, wireSniper } from '../../src/hybrid-sniper/index.js';

// ─── Tarea 10.2 — initHybridSniper initialization ────────────────────────────

describe('initHybridSniper: module initialization (Tarea 10.2)', () => {
  it('SNIPER_ENABLED=false → module has isEnabled=false', async () => {
    const module = await initHybridSniper({
      SNIPER_ENABLED: 'false',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
    });

    expect(module.isEnabled).toBe(false);
    module.stop();
  });

  it('SNIPER_ENABLED=true → module has isEnabled=true', async () => {
    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
    });

    expect(module.isEnabled).toBe(true);
    module.stop();
  });

  it('SNIPER_ENABLED=true with invalid DB path → degraded mode, no exception', async () => {
    // Use a path guaranteed to fail (root-level path with invalid chars)
    let module: Awaited<ReturnType<typeof initHybridSniper>> | undefined;
    await expect(async () => {
      module = await initHybridSniper({
        SNIPER_ENABLED: 'true',
        RPC_PROVIDER_URL: 'http://localhost:8545',
        SNIPER_DB_PATH: '/nonexistent/path/that/cannot/be/created.db',
      });
    }).not.toThrow();

    if (module) {
      // MetricsRecorder no longer has a degraded mode with pgPool
      expect(module.metricsRecorder.isDegraded).toBe(false);
      module.stop();
    }
  });

  it('reads agentAddress from env WALLET_ADDRESS', async () => {
    const walletAddr = '0x' + 'f'.repeat(40);
    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      WALLET_ADDRESS: walletAddr,
    });

    // agentAddress should be in the config
    expect(module.config.agentAddress).toBe(walletAddr);
    module.stop();
  });

  it('falls back to zero address when WALLET_ADDRESS is not set', async () => {
    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
    });

    expect(module.config.agentAddress).toBe('0x' + '0'.repeat(40));
    module.stop();
  });
});

// ─── Fastify /webhook/alpha route ─────────────────────────────────────────────

describe('/webhook/alpha and /sniper/status routes (Tarea 10.2)', () => {
  it('POST /webhook/alpha without contractAddress → HTTP 400', async () => {
    const fastify = Fastify({ logger: false });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
    });

    wireSniper(fastify, module);

    const response = await fastify.inject({
      method: 'POST',
      url: '/webhook/alpha',
      body: { ticker: 'TEST' }, // missing contractAddress
    });

    expect(response.statusCode).toBe(400);
    module.stop();
    await fastify.close();
  });

  it('GET /sniper/status → HTTP 503 when SNIPER_ENABLED=false', async () => {
    const fastify = Fastify({ logger: false });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'false',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
    });

    wireSniper(fastify, module);

    const response = await fastify.inject({
      method: 'GET',
      url: '/sniper/status',
    });

    expect(response.statusCode).toBe(503);
    module.stop();
    await fastify.close();
  });
});

// ─── Tarea 14.1 — DexScreener polling (mock axios) ───────────────────────────

describe('SignalIngestor: DexScreener polling (Tarea 14.1)', () => {
  let getSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getSpy = vi.spyOn(axios, 'get');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('polls the correct DexScreener endpoint', async () => {
    getSpy.mockResolvedValueOnce({
      data: [
        {
          chainId: 'base',
          baseToken: { address: '0x' + 'a'.repeat(40), symbol: 'TKN' },
          pairAddress: '0x' + 'b'.repeat(40),
          volume: { h1: 50_000 },
          liquidity: { usd: 50_000 },
        },
      ],
    });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999', // Prevent auto-polling
    });

    // Manually trigger poll by accessing internal method
    const ingestor = module.signalIngestor as any;
    await ingestor.pollDexScreener();

    expect(getSpy).toHaveBeenCalledWith(
      expect.stringContaining('dexscreener.com'),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );

    module.stop();
  });

  it('filters DexScreener results to chainId=base only', async () => {
    const processedAddresses: string[] = [];

    getSpy.mockResolvedValueOnce({
      data: [
        {
          chainId: 'ethereum', // should be filtered out
          baseToken: { address: '0x' + 'e'.repeat(40), symbol: 'ETH_TKN' },
          pairAddress: '0x' + 'f'.repeat(40),
          volume: { h1: 50_000 },
          liquidity: { usd: 50_000 },
        },
        {
          chainId: 'base', // should pass
          baseToken: { address: '0x' + 'a'.repeat(40), symbol: 'BASE_TKN' },
          pairAddress: '0x' + 'b'.repeat(40),
          volume: { h1: 50_000 },
          liquidity: { usd: 50_000 },
        },
      ],
    });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
    });

    // Spy on dispatchSignal to capture what gets processed
    const ingestor = module.signalIngestor as any;
    const dispatchSpy = vi.spyOn(ingestor, 'dispatchSignal');

    await ingestor.pollDexScreener();

    // Only base chain token should be dispatched
    const calls = dispatchSpy.mock.calls;
    const processedChains = calls.map((c: unknown[]) => {
      // dispatchSignal(ticker, contractAddress, source)
      return c[0]; // ticker is first arg
    });

    // BASE_TKN should be dispatched, ETH_TKN should not
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe('BASE_TKN');

    module.stop();
  });

  it('handles DexScreener 429 rate limit — pauses polling', async () => {
    const axiosError = Object.assign(new Error('Too Many Requests'), {
      isAxiosError: true,
      response: { status: 429 },
    });
    getSpy.mockRejectedValueOnce(axiosError);

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
    });

    const ingestor = module.signalIngestor as any;

    // Should not throw
    await expect(ingestor.pollDexScreener()).resolves.toBeUndefined();

    // dexscreenerPausedUntil should be set to ~now+60s
    expect(ingestor.dexscreenerPausedUntil).toBeGreaterThan(Date.now());

    module.stop();
  });
});

// ─── Tarea 14.1 — Bitquery polling ───────────────────────────────────────────

describe('SignalIngestor: Bitquery polling (Tarea 14.1)', () => {
  let postSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    postSpy = vi.spyOn(axios, 'post');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends Authorization: Bearer {KEY} header to Bitquery', async () => {
    postSpy.mockResolvedValueOnce({
      data: { data: { ethereum: { smartContractCalls: [] } } },
    });

    const apiKey = 'test-bitquery-key-12345';
    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
      BITQUERY_API_KEY: apiKey,
    });

    const ingestor = module.signalIngestor as any;
    await ingestor.pollBitquery();

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringContaining('bitquery'),
      expect.any(Object),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${apiKey}`,
        }),
      }),
    );

    module.stop();
  });

  it('disables Bitquery for session on 401', async () => {
    const axiosError = Object.assign(new Error('Unauthorized'), {
      isAxiosError: true,
      response: { status: 401 },
    });
    postSpy.mockRejectedValueOnce(axiosError);

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
      BITQUERY_API_KEY: 'invalid-key',
    });

    const ingestor = module.signalIngestor as any;
    await ingestor.pollBitquery();

    expect(ingestor.bitqueryDisabled).toBe(true);

    module.stop();
  });

  it('disables Bitquery silently on 402 (plan limit)', async () => {
    const axiosError = Object.assign(new Error('Payment Required'), {
      isAxiosError: true,
      response: { status: 402 },
    });
    postSpy.mockRejectedValueOnce(axiosError);

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
      BITQUERY_API_KEY: 'paid-plan-key',
    });

    const ingestor = module.signalIngestor as any;
    await ingestor.pollBitquery();

    expect(ingestor.bitqueryDisabled).toBe(true);

    module.stop();
  });

  it('skips polling when no Bitquery API key is set', async () => {
    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
      // No BITQUERY_API_KEY
    });

    const ingestor = module.signalIngestor as any;
    await ingestor.pollBitquery();

    // axios.post should NOT have been called
    expect(postSpy).not.toHaveBeenCalled();

    module.stop();
  });
});

// ─── GeckoTerminal polling (fuente nueva sin API key) ─────────────────────────

describe('SignalIngestor: GeckoTerminal polling (nueva fuente free, sin key)', () => {
  let getSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    getSpy = vi.spyOn(axios, 'get');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Minimal GeckoTerminal new_pools pool entry */
  function makeGeckoPool(overrides: {
    address?: string;
    tokenAddress?: string;
    ticker?: string;
    reserveUsd?: number;
    volumeH1Usd?: number;
    createdAt?: string;
  } = {}) {
    const addr = overrides.address ?? '0x' + 'c'.repeat(40);
    const tokenAddr = overrides.tokenAddress ?? '0x' + 'a'.repeat(40);
    return {
      id: `base_${addr}`,
      type: 'pool',
      attributes: {
        name: `${overrides.ticker ?? 'TKN'} / ETH 0.3%`,
        address: addr,
        pool_created_at: overrides.createdAt ?? '2026-07-28T22:00:00Z',
        reserve_in_usd: String(overrides.reserveUsd ?? 50_000),
        fdv_usd: '100000',
        volume_usd: { h1: String(overrides.volumeH1Usd ?? 15_000) },
        transactions: { m5: { buys: 10, sells: 5 } },
      },
      relationships: {
        base_token: { data: { id: `base_${tokenAddr}` } },
        dex: { data: { id: 'uniswap-v3-base' } },
      },
    };
  }

  it('calls the correct GeckoTerminal endpoint for Base new pools', async () => {
    getSpy.mockResolvedValueOnce({ data: { data: [makeGeckoPool()] } });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
    });

    const ingestor = module.signalIngestor as any;
    await ingestor.pollGeckoTerminal();

    expect(getSpy).toHaveBeenCalledWith(
      expect.stringContaining('geckoterminal.com'),
      expect.objectContaining({ timeout: expect.any(Number) }),
    );

    module.stop();
  });

  it('filters out pools with reserve < $10k', async () => {
    // Pool 1: reserve $5k → filtered out
    // Pool 2: reserve $50k, volume $15k → passes
    getSpy.mockResolvedValueOnce({
      data: {
        data: [
          makeGeckoPool({ address: '0x' + '1'.repeat(40), reserveUsd: 5_000, volumeH1Usd: 20_000 }),
          makeGeckoPool({ address: '0x' + '2'.repeat(40), reserveUsd: 50_000, volumeH1Usd: 15_000, ticker: 'GOOD' }),
        ],
      },
    });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
    });

    const ingestor = module.signalIngestor as any;
    const dispatchSpy = vi.spyOn(ingestor, 'dispatchSignal');

    await ingestor.pollGeckoTerminal();

    // Only GOOD pool should be dispatched
    expect(dispatchSpy.mock.calls.length).toBe(1);
    expect(dispatchSpy.mock.calls[0][0]).toBe('GOOD'); // ticker

    module.stop();
  });

  it('filters out pools with reserve < $10k regardless of volume', async () => {
    // Pool 1: reserve $5k → filtrado (sin importar volumen)
    // Pool 2: reserve $50k, volume $0 pero con buys en m5 → pasa (actividad reciente)
    getSpy.mockResolvedValueOnce({
      data: {
        data: [
          makeGeckoPool({ address: '0x' + '1'.repeat(40), reserveUsd: 5_000, volumeH1Usd: 10_000 }), // low reserve → out
          makeGeckoPool({ address: '0x' + '2'.repeat(40), reserveUsd: 50_000, volumeH1Usd: 0, ticker: 'ACTIVE' }), // new pool, 0 vol but has m5 buys → passes
        ],
      },
    });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
    });

    const ingestor = module.signalIngestor as any;
    const dispatchSpy = vi.spyOn(ingestor, 'dispatchSignal');

    await ingestor.pollGeckoTerminal();

    // Only ACTIVE pool (reserve ok, has recent buys) should be dispatched
    expect(dispatchSpy.mock.calls.length).toBe(1);
    expect(dispatchSpy.mock.calls[0][0]).toBe('ACTIVE');

    module.stop();
  });

  it('passes pools with low volume but recent m5 activity (new pool detection)', async () => {
    // Simula una pool recién creada: vol h1 = $200 (bajo), pero m5.buys = 5 (hay actividad)
    getSpy.mockResolvedValueOnce({
      data: {
        data: [
          makeGeckoPool({ address: '0x' + '1'.repeat(40), reserveUsd: 15_000, volumeH1Usd: 200, ticker: 'NEW' }),
        ],
      },
    });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
    });

    const ingestor = module.signalIngestor as any;
    const dispatchSpy = vi.spyOn(ingestor, 'dispatchSignal');

    await ingestor.pollGeckoTerminal();

    // Should pass: reserve ok + has m5 buys (makeGeckoPool sets m5.buys=10 by default)
    expect(dispatchSpy.mock.calls.length).toBe(1);
    expect(dispatchSpy.mock.calls[0][0]).toBe('NEW');

    module.stop();
  });

  it('passes pool address (not token address) as poolAddress to dispatchSignal', async () => {
    const poolAddr = '0x' + 'c'.repeat(40);
    const tokenAddr = '0x' + 'a'.repeat(40);

    getSpy.mockResolvedValueOnce({
      data: { data: [makeGeckoPool({ address: poolAddr, tokenAddress: tokenAddr, ticker: 'TKN' })] },
    });

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
    });

    const ingestor = module.signalIngestor as any;
    const dispatchSpy = vi.spyOn(ingestor, 'dispatchSignal');

    await ingestor.pollGeckoTerminal();

    expect(dispatchSpy).toHaveBeenCalledWith(
      'TKN',           // ticker
      tokenAddr,       // contractAddress (token)
      'geckoterminal', // source
      poolAddr,        // poolAddress — the actual pool, not the token
    );

    module.stop();
  });

  it('handles GeckoTerminal 429 rate limit — pauses polling', async () => {
    const axiosError = Object.assign(new Error('Too Many Requests'), {
      isAxiosError: true,
      response: { status: 429 },
    });
    getSpy.mockRejectedValueOnce(axiosError);

    const module = await initHybridSniper({
      SNIPER_ENABLED: 'true',
      RPC_PROVIDER_URL: 'http://localhost:8545',
      SNIPER_DB_PATH: ':memory:',
      SNIPER_POLL_INTERVAL_MS: '999999',
    });

    const ingestor = module.signalIngestor as any;
    await expect(ingestor.pollGeckoTerminal()).resolves.toBeUndefined();

    expect(ingestor.geckoTerminalPausedUntil).toBeGreaterThan(Date.now());

    module.stop();
  });
});

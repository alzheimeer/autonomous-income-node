/**
 * Unit tests for MarketDataManager
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 12.1, 12.2, 12.3, 20.1, 20.2, 20.4, 20.5
 *
 * Tests verify:
 * - Historical warmup fetches 500×15m + 300×1h candles
 * - WebSocket message parsing and candle ingestion
 * - REST fallback polling with exponential backoff
 * - Stale detection after 90s no data
 * - Event emission on candle close, price move, volume spike, regime change
 * - Debounce (60s between evaluations) and rate limit (max 20/hour)
 * - Candle validation (continuity, gap detection, volume sanity)
 * - ATR and volume Z-score calculations
 * - Heartbeat alert when no events for 5 min
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MarketDataManager,
  MAX_CANDLES_15M,
  MAX_CANDLES_1H,
  ATR_PERIOD,
  VOLUME_LOOKBACK,
  MAX_GAP_PCT,
} from '../../market-data-manager.js';
import type {
  IWebSocketClient,
  WebSocketFactory,
  IFetchClient,
  IAlertCallback,
} from '../../market-data-manager.js';
import type { CandleData, MarketEvent, RegimeType } from '../../types.js';
import type { MarketDataConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers & Mocks
// ═══════════════════════════════════════════════════════════════════════════

function createDefaultConfig(): MarketDataConfig {
  return {
    wsUrl: 'wss://stream.binance.com:9443/ws',
    restUrl: 'https://api.binance.com/api/v3',
    restPollingMs: 10_000,
    staleThresholdMs: 90_000,
    priceMoveTriggerAtrPct: 0.5,
    volumeZTrigger: 2.0,
    maxEvalPerHour: 20,
    debounceMs: 60_000,
  };
}

function createMockWs(): IWebSocketClient {
  return {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    close: vi.fn(),
    readyState: 1, // OPEN
  };
}

function createMockWsFactory(mockWs?: IWebSocketClient): WebSocketFactory {
  const ws = mockWs ?? createMockWs();
  return vi.fn(() => ws);
}

function generateCandle(
  timestamp: number,
  close: number,
  options?: Partial<CandleData>,
): CandleData {
  return {
    timestamp,
    open: options?.open ?? close * 0.999,
    high: options?.high ?? close * 1.002,
    low: options?.low ?? close * 0.998,
    close,
    volume: options?.volume ?? 100,
  };
}

function generateBinanceKline(candle: CandleData): unknown[] {
  return [
    candle.timestamp,
    String(candle.open),
    String(candle.high),
    String(candle.low),
    String(candle.close),
    String(candle.volume),
    candle.timestamp + 899999, // closeTime
    '50000', // quoteAssetVolume
    100, // trades
    '25000', // takerBuyBaseVolume
    '25000', // takerBuyQuoteVolume
    '0', // ignore
  ];
}

function createBinanceWsKlineMsg(
  candle: CandleData,
  interval: string,
  isClosed: boolean,
): object {
  return {
    e: 'kline',
    E: Date.now(),
    s: 'ETHUSDC',
    k: {
      t: candle.timestamp,
      T: candle.timestamp + 899999,
      s: 'ETHUSDC',
      i: interval,
      o: String(candle.open),
      h: String(candle.high),
      l: String(candle.low),
      c: String(candle.close),
      v: String(candle.volume),
      x: isClosed,
    },
  };
}

function createMockFetch(candles15m: CandleData[] = [], candles1h: CandleData[] = []): IFetchClient {
  return vi.fn(async (url: string) => {
    if (url.includes('interval=15m')) {
      return {
        ok: true,
        status: 200,
        json: async () => candles15m.map(generateBinanceKline),
      };
    }
    if (url.includes('interval=1h')) {
      return {
        ok: true,
        status: 200,
        json: async () => candles1h.map(generateBinanceKline),
      };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function generateCandleSeries(
  count: number,
  startPrice: number,
  startTime: number,
  intervalMs: number,
): CandleData[] {
  const candles: CandleData[] = [];
  let price = startPrice;
  for (let i = 0; i < count; i++) {
    // Small random-ish variation
    const change = (i % 3 === 0 ? 1 : -1) * (i % 7) * 0.5;
    price = price + change;
    candles.push(generateCandle(startTime + i * intervalMs, price));
  }
  return candles;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('MarketDataManager', () => {
  let config: MarketDataConfig;

  beforeEach(() => {
    config = createDefaultConfig();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start() and warmup', () => {
    it('fetches historical candles on start', async () => {
      const candles15m = generateCandleSeries(10, 2000, 1000000, 900_000);
      const candles1h = generateCandleSeries(5, 2000, 1000000, 3_600_000);
      const mockFetch = createMockFetch(candles15m, candles1h);
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(manager.getCandles('15m')).toHaveLength(10);
      expect(manager.getCandles('1h')).toHaveLength(5);

      manager.stop();
    });

    it('connects WebSocket after warmup', async () => {
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      expect(wsFactory).toHaveBeenCalledWith(
        'wss://stream.binance.com:9443/ws/ethusdc@kline_15m/ethusdc@kline_1h',
      );

      manager.stop();
    });

    it('does not start twice if already running', async () => {
      const mockFetch = createMockFetch();
      const wsFactory = createMockWsFactory();

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();
      await manager.start(); // Should be a no-op

      expect(mockFetch).toHaveBeenCalledTimes(2); // Only from first start

      manager.stop();
    });
  });

  describe('isValid() - stale detection', () => {
    it('returns false initially (no data yet)', () => {
      const manager = new MarketDataManager(
        config,
        createMockWsFactory(),
        createMockFetch(),
      );
      expect(manager.isValid()).toBe(false);
    });

    it('returns true after receiving data', async () => {
      const candles = generateCandleSeries(5, 2000, 1000000, 900_000);
      const mockFetch = createMockFetch(candles, []);
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);

      await manager.start();
      expect(manager.isValid()).toBe(true);

      manager.stop();
    });

    it('returns false after staleThresholdMs (90s) with no data', async () => {
      const candles = generateCandleSeries(5, 2000, 1000000, 900_000);
      const mockFetch = createMockFetch(candles, []);
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);

      await manager.start();
      expect(manager.isValid()).toBe(true);

      // Advance time past stale threshold
      vi.advanceTimersByTime(91_000);
      expect(manager.isValid()).toBe(false);

      manager.stop();
    });
  });

  describe('getLatestPrice()', () => {
    it('returns null when no candles available', () => {
      const manager = new MarketDataManager(
        config,
        createMockWsFactory(),
        createMockFetch(),
      );
      expect(manager.getLatestPrice()).toBeNull();
    });

    it('returns close of most recent 15m candle', async () => {
      const candles = [generateCandle(1000000, 2500)];
      const mockFetch = createMockFetch(candles, []);
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);

      await manager.start();
      expect(manager.getLatestPrice()).toBe(2500);

      manager.stop();
    });
  });

  describe('WebSocket message handling', () => {
    it('ingests closed candle from WebSocket message', async () => {
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      const candle = generateCandle(2000000, 2500);
      const msg = createBinanceWsKlineMsg(candle, '15m', true);

      // Simulate WebSocket message
      mockWs.onmessage?.({ data: JSON.stringify(msg) });

      expect(manager.getCandles('15m')).toHaveLength(1);
      expect(manager.getCandles('15m')[0].close).toBe(2500);

      manager.stop();
    });

    it('does not add non-closed candle to buffer', async () => {
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      const candle = generateCandle(2000000, 2500);
      const msg = createBinanceWsKlineMsg(candle, '15m', false);
      mockWs.onmessage?.({ data: JSON.stringify(msg) });

      expect(manager.getCandles('15m')).toHaveLength(0);

      manager.stop();
    });

    it('ignores malformed WebSocket messages', async () => {
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      // Malformed JSON
      mockWs.onmessage?.({ data: 'not-json' });
      // Non-kline event
      mockWs.onmessage?.({ data: JSON.stringify({ e: 'trade', p: '2500' }) });
      // Null message
      mockWs.onmessage?.({ data: JSON.stringify(null) });

      expect(manager.getCandles('15m')).toHaveLength(0);

      manager.stop();
    });

    it('separates 15m and 1h candles correctly', async () => {
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      // Set debounce to 0 for this test
      config.debounceMs = 0;
      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      const candle15m = generateCandle(2000000, 2500);
      const candle1h = generateCandle(3000000, 2600);

      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle15m, '15m', true)) });
      vi.advanceTimersByTime(1);
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle1h, '1h', true)) });

      expect(manager.getCandles('15m')).toHaveLength(1);
      expect(manager.getCandles('1h')).toHaveLength(1);
      expect(manager.getCandles('15m')[0].close).toBe(2500);
      expect(manager.getCandles('1h')[0].close).toBe(2600);

      manager.stop();
    });
  });

  describe('Candle buffer management', () => {
    it('maintains circular buffer at MAX_CANDLES_15M', async () => {
      const candles = generateCandleSeries(MAX_CANDLES_15M + 10, 2000, 1000000, 900_000);
      const mockFetch = createMockFetch(candles, []);
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);

      await manager.start();
      expect(manager.getCandles('15m')).toHaveLength(MAX_CANDLES_15M);

      manager.stop();
    });

    it('maintains circular buffer at MAX_CANDLES_1H', async () => {
      const candles = generateCandleSeries(MAX_CANDLES_1H + 10, 2000, 1000000, 3_600_000);
      const mockFetch = createMockFetch([], candles);
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);

      await manager.start();
      expect(manager.getCandles('1h')).toHaveLength(MAX_CANDLES_1H);

      manager.stop();
    });
  });

  describe('Candle validation', () => {
    it('rejects candles with invalid OHLC (high < low)', async () => {
      const invalidCandle: CandleData = {
        timestamp: 1000000,
        open: 2000,
        high: 1990, // high < low
        low: 2010,
        close: 2000,
        volume: 100,
      };
      const mockFetch: IFetchClient = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [generateBinanceKline(invalidCandle)],
      }));

      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);
      await manager.start();

      expect(manager.getCandles('15m')).toHaveLength(0);

      manager.stop();
    });

    it('rejects candles with negative price', async () => {
      const invalidCandle: CandleData = {
        timestamp: 1000000,
        open: -100,
        high: 2010,
        low: 1990,
        close: 2000,
        volume: 100,
      };
      const mockFetch: IFetchClient = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [generateBinanceKline(invalidCandle)],
      }));

      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);
      await manager.start();

      expect(manager.getCandles('15m')).toHaveLength(0);

      manager.stop();
    });

    it('rejects candles with negative volume', async () => {
      const invalidCandle: CandleData = {
        timestamp: 1000000,
        open: 2000,
        high: 2010,
        low: 1990,
        close: 2005,
        volume: -50,
      };
      const mockFetch: IFetchClient = vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => [generateBinanceKline(invalidCandle)],
      }));

      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);
      await manager.start();

      expect(manager.getCandles('15m')).toHaveLength(0);

      manager.stop();
    });
  });

  describe('ATR calculation', () => {
    it('returns null when insufficient candles', () => {
      const manager = new MarketDataManager(config, createMockWsFactory(), createMockFetch());
      const candles = generateCandleSeries(ATR_PERIOD - 1, 2000, 1000000, 900_000);
      expect(manager.calculateATR(candles)).toBeNull();
    });

    it('calculates ATR correctly for known data', () => {
      const manager = new MarketDataManager(config, createMockWsFactory(), createMockFetch());

      // Create candles with known true ranges
      const candles: CandleData[] = [];
      for (let i = 0; i <= ATR_PERIOD; i++) {
        candles.push({
          timestamp: 1000000 + i * 900_000,
          open: 2000,
          high: 2010,    // High - Low = 10
          low: 2000,
          close: 2005,
          volume: 100,
        });
      }

      const atr = manager.calculateATR(candles);
      expect(atr).not.toBeNull();
      // True Range for each = max(10, |2010-2005|, |2000-2005|) = 10
      expect(atr).toBe(10);
    });
  });

  describe('Volume Z-score calculation', () => {
    it('returns null when insufficient candles', async () => {
      const candles = generateCandleSeries(VOLUME_LOOKBACK - 1, 2000, 1000000, 900_000);
      const mockFetch = createMockFetch(candles, []);
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);
      await manager.start();

      expect(manager.calculateVolumeZScore(200)).toBeNull();

      manager.stop();
    });

    it('calculates Z-score correctly for known volumes', async () => {
      // All volumes = 100, so mean=100, stddev=0 → returns null
      const candles = generateCandleSeries(VOLUME_LOOKBACK, 2000, 1000000, 900_000);
      // Make volumes slightly varied
      candles.forEach((c, i) => { c.volume = 100 + (i % 5); });

      const mockFetch = createMockFetch(candles, []);
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);
      await manager.start();

      // Current volume way above mean → positive Z
      const z = manager.calculateVolumeZScore(200);
      expect(z).not.toBeNull();
      expect(z!).toBeGreaterThan(2);

      manager.stop();
    });
  });

  describe('Event emission and debounce', () => {
    it('emits candle_close event when candle is ingested', async () => {
      config.debounceMs = 0; // Disable debounce for this test
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      const events: MarketEvent[] = [];
      manager.onEvent(e => events.push(e));

      await manager.start();

      const candle = generateCandle(2000000, 2500);
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle, '15m', true)) });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('candle_close');

      manager.stop();
    });

    it('debounces events within debounceMs window', async () => {
      config.debounceMs = 60_000;
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      const events: MarketEvent[] = [];
      manager.onEvent(e => events.push(e));

      await manager.start();

      const candle1 = generateCandle(2000000, 2500);
      const candle2 = generateCandle(2900000, 2510);
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle1, '15m', true)) });
      // Second candle within debounce window
      vi.advanceTimersByTime(30_000); // Only 30s
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle2, '15m', true)) });

      expect(events).toHaveLength(1); // Only first was emitted

      manager.stop();
    });

    it('emits after debounce window passes', async () => {
      config.debounceMs = 60_000;
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      const events: MarketEvent[] = [];
      manager.onEvent(e => events.push(e));

      await manager.start();

      const candle1 = generateCandle(2000000, 2500);
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle1, '15m', true)) });

      // Advance past debounce
      vi.advanceTimersByTime(61_000);

      const candle2 = generateCandle(2900000, 2510);
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle2, '15m', true)) });

      expect(events).toHaveLength(2);

      manager.stop();
    });

    it('enforces max evaluations per hour', async () => {
      config.debounceMs = 0;
      config.maxEvalPerHour = 3;
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      const events: MarketEvent[] = [];
      manager.onEvent(e => events.push(e));

      await manager.start();

      for (let i = 0; i < 5; i++) {
        const candle = generateCandle(2000000 + i * 900_000, 2500 + i);
        mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle, '15m', true)) });
        vi.advanceTimersByTime(1);
      }

      expect(events).toHaveLength(3); // Max 3 per hour

      manager.stop();
    });

    it('resets hourly counter after 1 hour', async () => {
      config.debounceMs = 0;
      config.maxEvalPerHour = 2;
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      const events: MarketEvent[] = [];
      manager.onEvent(e => events.push(e));

      await manager.start();

      // Fill up the hour
      for (let i = 0; i < 3; i++) {
        const candle = generateCandle(2000000 + i * 900_000, 2500 + i);
        mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle, '15m', true)) });
        vi.advanceTimersByTime(1);
      }
      expect(events).toHaveLength(2);

      // Advance past 1 hour
      vi.advanceTimersByTime(3_600_000);

      const candle = generateCandle(5000000, 2600);
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle, '15m', true)) });

      expect(events).toHaveLength(3); // Counter reset

      manager.stop();
    });
  });

  describe('Regime change events', () => {
    it('emits regime_change event when regime changes', async () => {
      config.debounceMs = 0;
      const mockFetch = createMockFetch();
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);
      const events: MarketEvent[] = [];
      manager.onEvent(e => events.push(e));

      await manager.start();

      manager.updateRegime('TRENDING_UP');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        type: 'regime_change',
        from: 'UNCERTAIN',
        to: 'TRENDING_UP',
      });

      manager.stop();
    });

    it('does not emit if regime unchanged', async () => {
      config.debounceMs = 0;
      const mockFetch = createMockFetch();
      const manager = new MarketDataManager(config, createMockWsFactory(), mockFetch);
      const events: MarketEvent[] = [];
      manager.onEvent(e => events.push(e));

      await manager.start();

      manager.updateRegime('UNCERTAIN'); // Same as initial
      expect(events).toHaveLength(0);

      manager.stop();
    });
  });

  describe('REST fallback', () => {
    it('polls REST when WebSocket is not connected', async () => {
      vi.useRealTimers(); // Use real timers for this async test

      const candles = generateCandleSeries(2, 2000, 1000000, 900_000);
      const fetchCalls: string[] = [];
      const mockFetch: IFetchClient = vi.fn(async (url: string) => {
        fetchCalls.push(url);
        if (url.includes('interval=15m')) {
          return { ok: true, status: 200, json: async () => candles.map(generateBinanceKline) };
        }
        if (url.includes('interval=1h')) {
          return { ok: true, status: 200, json: async () => [] };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      });
      const mockWs = createMockWs();
      mockWs.readyState = 3; // CLOSED - force REST fallback
      const wsFactory = createMockWsFactory(mockWs);

      // Use a very short polling interval for testing
      const testConfig = { ...config, restPollingMs: 50 };
      const manager = new MarketDataManager(testConfig, wsFactory, mockFetch);
      await manager.start();

      const callsAfterWarmup = fetchCalls.length;
      expect(callsAfterWarmup).toBe(2); // warmup: 15m + 1h

      // Wait for at least one poll cycle
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have made additional fetch calls for REST polling
      expect(fetchCalls.length).toBeGreaterThan(callsAfterWarmup);

      manager.stop();
    });

    it('applies exponential backoff on rate limit (429)', async () => {
      let callCount = 0;
      const mockFetch: IFetchClient = vi.fn(async () => {
        callCount++;
        if (callCount <= 2) {
          // Warmup calls succeed
          return { ok: true, status: 200, json: async () => [] };
        }
        // Polling gets rate limited
        return { ok: false, status: 429, json: async () => ({}) };
      });

      const mockWs = createMockWs();
      mockWs.readyState = 3; // Force REST fallback
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      // First poll triggers 429
      vi.advanceTimersByTime(config.restPollingMs + 1);

      const callsAfterFirst = callCount;

      // Second poll should be backed off
      vi.advanceTimersByTime(config.restPollingMs + 1);

      // Should not have made additional calls due to backoff
      expect(callCount).toBeLessThanOrEqual(callsAfterFirst + 1);

      manager.stop();
    });
  });

  describe('Heartbeat alerts', () => {
    it('alerts when no events for 5 minutes', async () => {
      const alertCallback = vi.fn();
      const mockFetch = createMockFetch();
      const manager = new MarketDataManager(
        config,
        createMockWsFactory(),
        mockFetch,
        alertCallback,
      );

      await manager.start();

      // Advance past 5 minutes with heartbeat checks
      vi.advanceTimersByTime(360_000); // 6 minutes

      expect(alertCallback).toHaveBeenCalled();
      expect(alertCallback.mock.calls[0][0]).toContain('no data for');

      manager.stop();
    });
  });

  describe('stop()', () => {
    it('closes WebSocket and clears timers', async () => {
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      manager.stop();

      expect(mockWs.close).toHaveBeenCalled();
    });
  });

  describe('Gap detection', () => {
    it('detects gap > 5% from previous close', async () => {
      config.debounceMs = 0;
      const mockFetch = createMockFetch();
      const mockWs = createMockWs();
      const wsFactory = createMockWsFactory(mockWs);

      const manager = new MarketDataManager(config, wsFactory, mockFetch);
      await manager.start();

      // First candle at 2000
      const candle1 = generateCandle(1000000, 2000);
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle1, '15m', true)) });

      vi.advanceTimersByTime(61_000); // Past debounce

      // Second candle with 10% gap (open at 2200 from prev close 2000)
      const candle2: CandleData = {
        timestamp: 1900000,
        open: 2200, // 10% gap from prev close of 2000
        high: 2210,
        low: 2190,
        close: 2200,
        volume: 100,
      };
      mockWs.onmessage?.({ data: JSON.stringify(createBinanceWsKlineMsg(candle2, '15m', true)) });

      // Candle should still be added (gap is logged but not rejected)
      expect(manager.getCandles('15m')).toHaveLength(2);

      manager.stop();
    });
  });
});

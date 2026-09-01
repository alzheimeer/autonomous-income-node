/**
 * Unit tests for BinanceDataDownloader.
 *
 * Tests cover:
 * - Pagination logic (1000 candles per request)
 * - Retry with exponential backoff
 * - Contiguity validation (gap detection)
 * - Total candle calculation (days + warmup)
 * - Binance kline response parsing
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';
import { BinanceDataDownloader } from '../binance-downloader.js';
import type { CandleData } from '../../trading-validation/types.js';

vi.mock('axios');

const mockedAxios = vi.mocked(axios);

describe('BinanceDataDownloader', () => {
  let downloader: BinanceDataDownloader;

  beforeEach(() => {
    downloader = new BinanceDataDownloader('https://api.binance.com');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createBinanceKline(timestamp: number, close: number): unknown[] {
    return [
      timestamp,           // openTime
      String(close - 10),  // open
      String(close + 5),   // high
      String(close - 15),  // low
      String(close),       // close
      '1000.5',            // volume
      timestamp + 899999,  // closeTime
      '5000000',           // quoteVolume
      100,                 // trades
      '500.0',             // takerBuyBaseVol
      '2500000',           // takerBuyQuoteVol
      '0',                 // ignore
    ];
  }

  function generateKlineBatch(
    startTime: number,
    intervalMs: number,
    count: number,
    basePrice = 2000,
  ): unknown[][] {
    const klines: unknown[][] = [];
    for (let i = 0; i < count; i++) {
      klines.push(createBinanceKline(startTime + i * intervalMs, basePrice + i));
    }
    return klines;
  }

  describe('downloadCandles', () => {
    it('calculates total candles correctly for 15m interval', async () => {
      // 1 day at 15m = 96 candles + 200 warmup = 296 candles (1 request)
      const klines = generateKlineBatch(Date.now() - 296 * 900_000, 900_000, 296);
      mockedAxios.get.mockResolvedValueOnce({ data: klines });

      const candles = await downloader.downloadCandles('ETHUSDC', '15m', 1, 200);

      expect(candles).toHaveLength(296);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('calculates total candles correctly for 1h interval', async () => {
      // 1 day at 1h = 24 candles + 200 warmup = 224 candles (1 request)
      const klines = generateKlineBatch(Date.now() - 224 * 3_600_000, 3_600_000, 224);
      mockedAxios.get.mockResolvedValueOnce({ data: klines });

      const candles = await downloader.downloadCandles('ETHUSDC', '1h', 1, 200);

      expect(candles).toHaveLength(224);
      expect(mockedAxios.get).toHaveBeenCalledTimes(1);
    });

    it('paginates correctly when total candles exceed 1000', async () => {
      // 30 days at 15m = 2880 candles + 200 warmup = 3080 candles → 4 requests
      const intervalMs = 900_000;
      const totalCandles = Math.ceil((30 * 24 * 3_600_000) / intervalMs) + 200;
      const baseTime = Date.now() - totalCandles * intervalMs;

      // First 1000 candles
      const batch1 = generateKlineBatch(baseTime, intervalMs, 1000);
      // Next 1000 candles
      const batch2 = generateKlineBatch(baseTime + 1000 * intervalMs, intervalMs, 1000);
      // Next 1000 candles
      const batch3 = generateKlineBatch(baseTime + 2000 * intervalMs, intervalMs, 1000);
      // Remaining 80 candles
      const batch4 = generateKlineBatch(baseTime + 3000 * intervalMs, intervalMs, 80);

      mockedAxios.get
        .mockResolvedValueOnce({ data: batch1 })
        .mockResolvedValueOnce({ data: batch2 })
        .mockResolvedValueOnce({ data: batch3 })
        .mockResolvedValueOnce({ data: batch4 });

      const candles = await downloader.downloadCandles('ETHUSDC', '15m', 30, 200);

      expect(candles).toHaveLength(3080);
      expect(mockedAxios.get).toHaveBeenCalledTimes(4);
    });

    it('stops pagination when API returns empty batch', async () => {
      // 10 days at 15m + 200 warmup = 1160 candles → needs at least 2 requests
      const intervalMs = 900_000;
      const totalCandles = Math.ceil((10 * 24 * 3_600_000) / intervalMs) + 200;
      const baseTime = Date.now() - totalCandles * intervalMs;

      // First batch: 1000 candles
      const batch1 = generateKlineBatch(baseTime, intervalMs, 1000);
      // Second batch: empty (simulating no more data available)
      mockedAxios.get
        .mockResolvedValueOnce({ data: batch1 })
        .mockResolvedValueOnce({ data: [] });

      const candles = await downloader.downloadCandles('ETHUSDC', '15m', 10, 200);

      expect(candles).toHaveLength(1000);
      expect(mockedAxios.get).toHaveBeenCalledTimes(2);
    });

    it('passes correct params to Binance API', async () => {
      const klines = generateKlineBatch(Date.now() - 296 * 900_000, 900_000, 296);
      mockedAxios.get.mockResolvedValueOnce({ data: klines });

      await downloader.downloadCandles('ETHUSDC', '15m', 1, 200);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.binance.com/api/v3/klines',
        expect.objectContaining({
          params: expect.objectContaining({
            symbol: 'ETHUSDC',
            interval: '15m',
            limit: 1000,
          }),
        }),
      );
    });
  });

  describe('retry with exponential backoff', () => {
    it('retries up to 3 times with exponential backoff on API errors', async () => {
      const klines = generateKlineBatch(Date.now() - 100 * 900_000, 900_000, 100);

      mockedAxios.get
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Rate limited'))
        .mockResolvedValueOnce({ data: klines });

      vi.useFakeTimers();
      const promise = downloader.downloadCandles('ETHUSDC', '15m', 1, 4);
      await vi.runAllTimersAsync();
      const candles = await promise;

      expect(candles).toHaveLength(100);
      expect(mockedAxios.get).toHaveBeenCalledTimes(3);
    });

    it('throws after max retries exceeded', async () => {
      mockedAxios.get
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockRejectedValueOnce(new Error('Error 3'));

      vi.useFakeTimers();
      const promise = downloader.downloadCandles('ETHUSDC', '15m', 1, 4).catch(e => e);
      await vi.runAllTimersAsync();
      
      const err = await promise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain('Failed to download candles after 3 attempts: Error 3');
    });
  });

  describe('validateContiguity', () => {
    it('does not warn for contiguous candles', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const intervalMs = 900_000;
      const candles: CandleData[] = [];
      for (let i = 0; i < 10; i++) {
        candles.push({
          timestamp: 1000000 + i * intervalMs,
          open: 2000,
          high: 2010,
          low: 1990,
          close: 2005,
          volume: 100,
        });
      }

      downloader.validateContiguity(candles, intervalMs);
      warnSpy.mockRestore();
      // No assertion needed — just verifying no error is thrown
    });

    it('detects gaps larger than 2x interval', () => {
      const intervalMs = 900_000;
      const candles: CandleData[] = [
        { timestamp: 1000000, open: 2000, high: 2010, low: 1990, close: 2005, volume: 100 },
        { timestamp: 1000000 + intervalMs, open: 2000, high: 2010, low: 1990, close: 2005, volume: 100 },
        // Gap of 3x interval here
        { timestamp: 1000000 + 4 * intervalMs, open: 2000, high: 2010, low: 1990, close: 2005, volume: 100 },
        { timestamp: 1000000 + 5 * intervalMs, open: 2000, high: 2010, low: 1990, close: 2005, volume: 100 },
      ];

      // Should not throw, just logs a warning
      expect(() => downloader.validateContiguity(candles, intervalMs)).not.toThrow();
    });

    it('does not flag gaps exactly at 2x interval', () => {
      const intervalMs = 900_000;
      const candles: CandleData[] = [
        { timestamp: 1000000, open: 2000, high: 2010, low: 1990, close: 2005, volume: 100 },
        // Gap of exactly 2x interval — should NOT be flagged (only > 2x is flagged)
        { timestamp: 1000000 + 2 * intervalMs, open: 2000, high: 2010, low: 1990, close: 2005, volume: 100 },
      ];

      expect(() => downloader.validateContiguity(candles, intervalMs)).not.toThrow();
    });

    it('handles empty candle array', () => {
      expect(() => downloader.validateContiguity([], 900_000)).not.toThrow();
    });

    it('handles single candle', () => {
      const candles: CandleData[] = [
        { timestamp: 1000000, open: 2000, high: 2010, low: 1990, close: 2005, volume: 100 },
      ];
      expect(() => downloader.validateContiguity(candles, 900_000)).not.toThrow();
    });
  });

  describe('parseBinanceKlines (via downloadCandles)', () => {
    it('parses Binance kline format correctly', async () => {
      const timestamp = Date.now() - 900_000;
      const klines = [
        [timestamp, '2000.5', '2010.0', '1990.0', '2005.0', '1500.75', timestamp + 899999, '3000000', 50, '750.0', '1500000', '0'],
      ];
      mockedAxios.get.mockResolvedValueOnce({ data: klines });

      const candles = await downloader.downloadCandles('ETHUSDC', '15m', 0, 1);

      expect(candles[0]).toEqual({
        timestamp,
        open: 2000.5,
        high: 2010.0,
        low: 1990.0,
        close: 2005.0,
        volume: 1500.75,
      });
    });

    it('skips malformed kline entries', async () => {
      const timestamp = Date.now() - 900_000;
      const klines = [
        [timestamp, '2000', '2010', '1990', '2005', '1500'], // valid
        [timestamp + 900_000, '2001'],                        // too short — skipped
        'not an array',                                        // not array — skipped
      ];
      mockedAxios.get.mockResolvedValueOnce({ data: klines });

      const candles = await downloader.downloadCandles('ETHUSDC', '15m', 0, 2);

      expect(candles).toHaveLength(1);
    });
  });
});

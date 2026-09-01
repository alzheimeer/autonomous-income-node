/**
 * CandleCache — Unit Tests
 *
 * Tests cache-first lookup, filename encoding, invalidation, and
 * hasCachedData check. Network download is tested via mock.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CandleCache } from './candle-cache.js';
import type { CandleData } from './types.js';

const TEST_CACHE_DIR = 'data/test-candle-cache';

describe('CandleCache', () => {
  let cache: CandleCache;

  beforeEach(() => {
    // Clean test directory
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    cache = new CandleCache({ cacheDir: TEST_CACHE_DIR });
  });

  afterEach(() => {
    if (existsSync(TEST_CACHE_DIR)) {
      rmSync(TEST_CACHE_DIR, { recursive: true });
    }
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('creates the cache directory if it does not exist', () => {
      const dir = 'data/test-candle-cache-constructor';
      if (existsSync(dir)) rmSync(dir, { recursive: true });

      new CandleCache({ cacheDir: dir });
      expect(existsSync(dir)).toBe(true);

      rmSync(dir, { recursive: true });
    });

    it('uses default cacheDir when no options provided', () => {
      // Just check it doesn't throw
      const defaultCache = new CandleCache();
      expect(defaultCache).toBeDefined();
    });
  });

  describe('getCacheFilePath', () => {
    it('generates correct filename format: {symbol}_{timeframe}_{startDate}_{endDate}.json', () => {
      const path = cache.getCacheFilePath('ETHUSDC', '15m', '2026-06-23', '2026-07-23');
      expect(path).toBe(join(TEST_CACHE_DIR, 'ETHUSDC_15m_2026-06-23_2026-07-23.json'));
    });

    it('handles different symbols and timeframes', () => {
      const path = cache.getCacheFilePath('BTCUSDT', '1h', '2026-01-01', '2026-02-01');
      expect(path).toBe(join(TEST_CACHE_DIR, 'BTCUSDT_1h_2026-01-01_2026-02-01.json'));
    });
  });

  describe('hasCachedData', () => {
    it('returns false when no cache file exists', () => {
      expect(cache.hasCachedData('ETHUSDC', '15m', '2026-06-23', '2026-07-23')).toBe(false);
    });

    it('returns true when cache file exists', () => {
      const filePath = cache.getCacheFilePath('ETHUSDC', '15m', '2026-06-23', '2026-07-23');
      const { writeFileSync } = require('node:fs');
      writeFileSync(filePath, '[]', 'utf-8');

      expect(cache.hasCachedData('ETHUSDC', '15m', '2026-06-23', '2026-07-23')).toBe(true);
    });
  });

  describe('invalidate', () => {
    it('deletes all cached files for a given symbol+timeframe', () => {
      const { writeFileSync } = require('node:fs');

      // Create multiple cache files for same symbol+timeframe
      const file1 = join(TEST_CACHE_DIR, 'ETHUSDC_15m_2026-06-01_2026-06-30.json');
      const file2 = join(TEST_CACHE_DIR, 'ETHUSDC_15m_2026-07-01_2026-07-31.json');
      const file3 = join(TEST_CACHE_DIR, 'ETHUSDC_1h_2026-06-01_2026-06-30.json');

      writeFileSync(file1, '[]', 'utf-8');
      writeFileSync(file2, '[]', 'utf-8');
      writeFileSync(file3, '[]', 'utf-8');

      // Invalidate only 15m files
      cache.invalidate('ETHUSDC', '15m');

      expect(existsSync(file1)).toBe(false);
      expect(existsSync(file2)).toBe(false);
      // 1h file should remain
      expect(existsSync(file3)).toBe(true);
    });

    it('does nothing when cache directory does not exist', () => {
      const emptyCache = new CandleCache({ cacheDir: 'data/nonexistent-cache-test' });
      rmSync('data/nonexistent-cache-test', { recursive: true });
      // Should not throw
      expect(() => emptyCache.invalidate('ETHUSDC', '15m')).not.toThrow();
    });
  });

  describe('getCandles', () => {
    it('serves from cache when file exists (no network request)', async () => {
      const sampleCandles: CandleData[] = [
        { timestamp: 1719100800000, open: 3500, high: 3550, low: 3480, close: 3520, volume: 100 },
        { timestamp: 1719101700000, open: 3520, high: 3560, low: 3500, close: 3540, volume: 150 },
      ];

      // Pre-populate cache — we need to mock computeDateRange or write to the exact path
      // Instead, let's mock fetch to ensure it's NOT called
      const fetchSpy = vi.spyOn(globalThis, 'fetch');

      // Write a file at the expected path
      // We need to know the computed dates, so let's call getCacheFilePath
      // with known dates and then manually write the file
      const now = new Date();
      const endDate = now.toISOString().slice(0, 10);
      const warmupMs = 200 * 15 * 60 * 1000; // 200 candles * 15 min
      const daysMs = 30 * 24 * 60 * 60 * 1000;
      const startMs = now.getTime() - daysMs - warmupMs;
      const startDate = new Date(startMs).toISOString().slice(0, 10);

      const filePath = cache.getCacheFilePath('ETHUSDC', '15m', startDate, endDate);
      const { writeFileSync } = require('node:fs');
      writeFileSync(filePath, JSON.stringify(sampleCandles), 'utf-8');

      const result = await cache.getCandles('ETHUSDC', '15m', 30, 200);

      expect(result).toEqual(sampleCandles);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('downloads and caches when no local file exists', async () => {
      const mockKlines = [
        [1719100800000, '3500.00', '3550.00', '3480.00', '3520.00', '100.5', 1719101699999],
        [1719101700000, '3520.00', '3560.00', '3500.00', '3540.00', '150.2', 1719102599999],
      ];

      // Mock fetch to return Binance-like data then empty (to end pagination)
      const fetchMock = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockKlines,
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => [],
        } as Response);

      const result = await cache.getCandles('ETHUSDC', '15m', 30, 200);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        timestamp: 1719100800000,
        open: 3500,
        high: 3550,
        low: 3480,
        close: 3520,
        volume: 100.5,
      });
      expect(fetchMock).toHaveBeenCalled();

      // Verify file was written to cache
      const now = new Date();
      const endDate = now.toISOString().slice(0, 10);
      const warmupMs = 200 * 15 * 60 * 1000;
      const daysMs = 30 * 24 * 60 * 60 * 1000;
      const startMs = now.getTime() - daysMs - warmupMs;
      const startDate = new Date(startMs).toISOString().slice(0, 10);
      const filePath = cache.getCacheFilePath('ETHUSDC', '15m', startDate, endDate);

      expect(existsSync(filePath)).toBe(true);
      const cached = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(cached).toEqual(result);
    });

    it('throws a descriptive error on network failure after retries', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network unavailable'));

      await expect(
        cache.getCandles('ETHUSDC', '15m', 1, 4),
      ).rejects.toThrow('Failed to download candles from Binance after 3 attempts');
    }, 15000); // Allow time for retries with exponential backoff

    it('throws on non-ok HTTP response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({}),
      } as Response);

      await expect(
        cache.getCandles('ETHUSDC', '15m', 1, 4),
      ).rejects.toThrow('Binance API error: 429 Too Many Requests');
    }, 15000);
  });

  describe('deterministic replay', () => {
    it('produces identical results from cache across multiple reads', async () => {
      const sampleCandles: CandleData[] = [
        { timestamp: 1719100800000, open: 3500, high: 3550, low: 3480, close: 3520, volume: 100 },
        { timestamp: 1719101700000, open: 3520, high: 3560, low: 3500, close: 3540, volume: 150 },
        { timestamp: 1719102600000, open: 3540, high: 3580, low: 3510, close: 3570, volume: 200 },
      ];

      // Pre-write cache file
      const now = new Date();
      const endDate = now.toISOString().slice(0, 10);
      const warmupMs = 200 * 15 * 60 * 1000;
      const daysMs = 30 * 24 * 60 * 60 * 1000;
      const startMs = now.getTime() - daysMs - warmupMs;
      const startDate = new Date(startMs).toISOString().slice(0, 10);

      const filePath = cache.getCacheFilePath('ETHUSDC', '15m', startDate, endDate);
      const { writeFileSync } = require('node:fs');
      writeFileSync(filePath, JSON.stringify(sampleCandles), 'utf-8');

      // Read multiple times — should be identical
      const result1 = await cache.getCandles('ETHUSDC', '15m', 30, 200);
      const result2 = await cache.getCandles('ETHUSDC', '15m', 30, 200);
      const result3 = await cache.getCandles('ETHUSDC', '15m', 30, 200);

      expect(result1).toEqual(result2);
      expect(result2).toEqual(result3);
      expect(result1).toEqual(sampleCandles);
    });
  });
});

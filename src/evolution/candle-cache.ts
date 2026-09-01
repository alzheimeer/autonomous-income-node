/**
 * CandleCache — Local file-based candle storage for deterministic backtest replay.
 *
 * Downloads OHLCV candle data from Binance public API and caches locally so that:
 * - Backtests are deterministic (same cache → same results)
 * - No network dependency after first download
 * - Fast batch replay without rate-limit concerns
 *
 * File format: {symbol}_{timeframe}_{startDate}_{endDate}.json
 * Storage dir: data/candle-cache/
 *
 * Requirements validated: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLogger } from '../logger.js';
import type { CandleData } from './types.js';

const log = createLogger('candle-cache');

export interface CandleCacheOptions {
  cacheDir: string;
}

const BINANCE_BASE_URL = 'https://api.binance.com';
const MAX_CANDLES_PER_REQUEST = 1000;
const MAX_RETRIES = 3;

export class CandleCache {
  private cacheDir: string;

  constructor(options?: CandleCacheOptions) {
    this.cacheDir = options?.cacheDir ?? 'data/candle-cache';
    mkdirSync(this.cacheDir, { recursive: true });
  }

  /**
   * Get candles for a symbol/timeframe/period. Serves from cache if available,
   * downloads and caches if not.
   *
   * Date range computation:
   * - endDate = today
   * - startDate = endDate - days - (warmupCandles * interval_minutes)
   */
  async getCandles(
    symbol: string,
    timeframe: '15m' | '1h',
    days: number,
    warmupCandles: number = 200,
  ): Promise<CandleData[]> {
    const { startDate, endDate } = this.computeDateRange(timeframe, days, warmupCandles);
    const filePath = this.getCacheFilePath(symbol, timeframe, startDate, endDate);

    // Cache-first: check local file before network request
    if (existsSync(filePath)) {
      log.info('Serving candles from cache', { symbol, timeframe, startDate, endDate });
      const raw = readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as CandleData[];
    }

    // Cache miss: download from Binance API
    log.info('Cache miss — downloading from Binance', { symbol, timeframe, days, warmupCandles });
    const candles = await this.downloadFromBinance(symbol, timeframe, startDate, endDate);

    // Store in cache
    writeFileSync(filePath, JSON.stringify(candles), 'utf-8');
    log.info('Candles cached', { filePath, count: candles.length });

    return candles;
  }

  /**
   * Check if cache has data for a given request.
   * Checks if a file exists that covers the requested period.
   */
  hasCachedData(symbol: string, timeframe: string, startDate: string, endDate: string): boolean {
    const filePath = this.getCacheFilePath(symbol, timeframe, startDate, endDate);
    return existsSync(filePath);
  }

  /**
   * Force re-download and replace cache for a given request.
   * Finds and deletes any cached files matching the symbol+timeframe pattern.
   */
  invalidate(symbol: string, timeframe: string): void {
    if (!existsSync(this.cacheDir)) return;

    const prefix = `${symbol}_${timeframe}_`;
    const files = readdirSync(this.cacheDir);

    for (const file of files) {
      if (file.startsWith(prefix) && file.endsWith('.json')) {
        const fullPath = join(this.cacheDir, file);
        unlinkSync(fullPath);
        log.info('Invalidated cache file', { file });
      }
    }
  }

  /**
   * Generate the cache file path for given parameters.
   * Format: {symbol}_{timeframe}_{startDate}_{endDate}.json
   */
  getCacheFilePath(symbol: string, timeframe: string, startDate: string, endDate: string): string {
    const filename = `${symbol}_${timeframe}_${startDate}_${endDate}.json`;
    return join(this.cacheDir, filename);
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Compute the start and end date strings (YYYY-MM-DD) for a given request.
   *
   * endDate = today
   * startDate = endDate - days - (warmupCandles × interval_minutes)
   */
  private computeDateRange(
    timeframe: '15m' | '1h',
    days: number,
    warmupCandles: number,
  ): { startDate: string; endDate: string } {
    const now = new Date();
    const endDate = this.formatDate(now);

    const intervalMinutes = timeframe === '1h' ? 60 : 15;
    const warmupMs = warmupCandles * intervalMinutes * 60 * 1000;
    const daysMs = days * 24 * 60 * 60 * 1000;

    const startMs = now.getTime() - daysMs - warmupMs;
    const startDate = this.formatDate(new Date(startMs));

    return { startDate, endDate };
  }

  /**
   * Download candles from Binance API with pagination.
   * Binance returns max 1000 candles per request, so we loop until all data is fetched.
   */
  private async downloadFromBinance(
    symbol: string,
    timeframe: string,
    startDate: string,
    endDate: string,
  ): Promise<CandleData[]> {
    const intervalMs = timeframe === '1h' ? 3_600_000 : 900_000;
    const startTime = new Date(startDate).getTime();
    const endTime = new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1; // end of day

    const allCandles: CandleData[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const batch = await this.fetchBatchWithRetry(symbol, timeframe, currentStart, endTime);
      if (batch.length === 0) break;

      allCandles.push(...batch);
      currentStart = batch[batch.length - 1]!.timestamp + intervalMs;

      log.info(`Downloaded ${allCandles.length} candles so far for ${symbol} ${timeframe}`);
    }

    log.info('Download complete', { symbol, timeframe, totalCandles: allCandles.length });
    return allCandles;
  }

  /**
   * Fetch a single batch with retry and exponential backoff (1s, 2s, 4s).
   */
  private async fetchBatchWithRetry(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
  ): Promise<CandleData[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.fetchBatch(symbol, interval, startTime, endTime);
      } catch (err) {
        if (attempt === MAX_RETRIES - 1) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to download candles from Binance after ${MAX_RETRIES} attempts: ${message}`,
          );
        }
        const delayMs = 1000 * Math.pow(2, attempt);
        log.warn(`Retry ${attempt + 1}/${MAX_RETRIES} after ${delayMs}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(delayMs);
      }
    }
    // Unreachable
    throw new Error('Unreachable');
  }

  /**
   * Fetch a single batch of up to 1000 candles from Binance /api/v3/klines.
   * Uses native fetch (Node.js 24).
   *
   * Binance kline response: [openTime, open, high, low, close, volume, closeTime, ...]
   */
  private async fetchBatch(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
  ): Promise<CandleData[]> {
    const params = new URLSearchParams({
      symbol,
      interval,
      startTime: String(startTime),
      endTime: String(endTime),
      limit: String(MAX_CANDLES_PER_REQUEST),
    });

    const url = `${BINANCE_BASE_URL}/api/v3/klines?${params.toString()}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Binance API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as unknown[][];

    if (!Array.isArray(data)) {
      throw new Error('Unexpected Binance response format: expected array');
    }

    return this.parseBinanceKlines(data);
  }

  /**
   * Parse raw Binance kline arrays into CandleData objects.
   *
   * Binance format: [openTime, open, high, low, close, volume, closeTime, ...]
   * Values at indices 1-5 are strings that need parseFloat.
   */
  private parseBinanceKlines(data: unknown[][]): CandleData[] {
    const candles: CandleData[] = [];

    for (const item of data) {
      if (!Array.isArray(item) || item.length < 6) continue;

      candles.push({
        timestamp: item[0] as number,
        open: parseFloat(item[1] as string),
        high: parseFloat(item[2] as string),
        low: parseFloat(item[3] as string),
        close: parseFloat(item[4] as string),
        volume: parseFloat(item[5] as string),
      });
    }

    return candles;
  }

  /**
   * Format a Date as YYYY-MM-DD string.
   */
  private formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
  }

  /**
   * Sleep utility for exponential backoff.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

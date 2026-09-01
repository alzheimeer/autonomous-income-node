/**
 * BinanceDataDownloader — Historical OHLCV candle download from Binance REST API.
 *
 * Downloads candle data for ETHUSDC at 15m and 1h timeframes with:
 * - Pagination at 1000 candles per request (Binance limit)
 * - Retry with exponential backoff (1s, 2s, 4s), max 3 retries
 * - Contiguity validation (gap > 2× interval → log warning)
 * - Warmup buffer of 200 candles beyond the requested --days
 *
 * No API key needed — Binance public endpoints.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import axios from 'axios';
import type { CandleData } from '../trading-validation/types.js';
import { createLogger } from '../logger.js';

const log = createLogger('binance-downloader');

export class BinanceDataDownloader {
  private readonly baseUrl: string;
  private readonly maxCandlesPerRequest = 1000;
  private readonly maxRetries = 3;

  constructor(baseUrl = 'https://api.binance.com') {
    this.baseUrl = baseUrl;
  }

  /**
   * Download OHLCV candles for a symbol at the given interval.
   *
   * Calculates total candles needed as:
   *   ceil((days * 24 * 3600000) / intervalMs) + warmupCandles
   *
   * Paginates at 1000 candles per request and validates contiguity.
   */
  async downloadCandles(
    symbol: string,
    interval: '15m' | '1h',
    days: number,
    warmupCandles: number,
  ): Promise<CandleData[]> {
    const intervalMs = interval === '1h' ? 3_600_000 : 900_000;
    const totalCandles = Math.ceil((days * 24 * 3_600_000) / intervalMs) + warmupCandles;
    const endTime = Date.now();
    const startTime = endTime - totalCandles * intervalMs;

    log.info('Starting candle download', {
      symbol,
      interval,
      days,
      warmupCandles,
      totalCandles,
    });

    const allCandles: CandleData[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const batch = await this.fetchWithRetry(symbol, interval, currentStart, endTime);
      if (batch.length === 0) break;

      allCandles.push(...batch);
      currentStart = batch[batch.length - 1]!.timestamp + intervalMs;

      log.info(`Downloaded ${allCandles.length}/${totalCandles} candles for ${symbol} ${interval}`);
    }

    this.validateContiguity(allCandles, intervalMs);

    log.info('Download complete', {
      symbol,
      interval,
      candlesDownloaded: allCandles.length,
      totalRequested: totalCandles,
    });

    return allCandles;
  }

  /**
   * Fetch a batch with retry (exponential backoff: 1s, 2s, 4s).
   * Max 3 retries before aborting with a descriptive error.
   */
  private async fetchWithRetry(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
  ): Promise<CandleData[]> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        return await this.fetchBatch(symbol, interval, startTime, endTime);
      } catch (err) {
        if (attempt === this.maxRetries - 1) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(
            `Failed to download candles after ${this.maxRetries} attempts: ${message}`,
          );
        }
        const delayMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        log.warn(`Retry ${attempt + 1}/${this.maxRetries} after ${delayMs}ms`, {
          error: err instanceof Error ? err.message : String(err),
        });
        await this.sleep(delayMs);
      }
    }
    // Unreachable — loop always throws or returns
    throw new Error('Unreachable');
  }

  /**
   * Fetch a single batch of up to 1000 candles from Binance /api/v3/klines.
   *
   * Binance kline response format:
   * [openTime, open, high, low, close, volume, closeTime, ...]
   */
  private async fetchBatch(
    symbol: string,
    interval: string,
    startTime: number,
    endTime: number,
  ): Promise<CandleData[]> {
    const url = `${this.baseUrl}/api/v3/klines`;
    const response = await axios.get<unknown[][]>(url, {
      params: {
        symbol,
        interval,
        startTime,
        endTime,
        limit: this.maxCandlesPerRequest,
      },
    });

    if (!Array.isArray(response.data)) {
      throw new Error(`Unexpected Binance response format: expected array`);
    }

    return this.parseBinanceKlines(response.data);
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

      const candle: CandleData = {
        timestamp: item[0] as number,
        open: parseFloat(item[1] as string),
        high: parseFloat(item[2] as string),
        low: parseFloat(item[3] as string),
        close: parseFloat(item[4] as string),
        volume: parseFloat(item[5] as string),
      };

      candles.push(candle);
    }

    return candles;
  }

  /**
   * Validate contiguity of downloaded candles.
   * Logs a warning for any gap > 2× the expected interval.
   *
   * Requirements: 8.5
   */
  validateContiguity(candles: CandleData[], expectedIntervalMs: number): void {
    for (let i = 1; i < candles.length; i++) {
      const gap = candles[i]!.timestamp - candles[i - 1]!.timestamp;
      if (gap > expectedIntervalMs * 2) {
        log.warn(
          `[Downloader] Gap detected: ${gap}ms between candles at index ${i - 1} ` +
            `(timestamp ${candles[i - 1]!.timestamp})`,
          {
            gapMs: gap,
            expectedMs: expectedIntervalMs,
            index: i - 1,
            timestamp: candles[i - 1]!.timestamp,
          },
        );
      }
    }
  }

  /**
   * Sleep utility for exponential backoff.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

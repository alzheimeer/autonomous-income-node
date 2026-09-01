/**
 * Funding Arbitrage Backtest — Data Fetcher
 *
 * Retrieves historical funding rates from the Hyperliquid public API
 * and caches them in the FundingDatabase.
 *
 * Features:
 *   - POST to https://api.hyperliquid.xyz/info (fundingHistory)
 *   - Pagination: 500 records per page, uses last timestamp as next startTime
 *   - Retry logic: 3 attempts, exponential backoff (1s, 2s, 4s)
 *   - Cache-first: checks hasCoverage before making API calls
 *   - Supports up to 365 days of hourly history
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5
 */

import axios from 'axios';
import { createLogger } from '../../logger.js';
import type { FundingDatabase } from './database.js';

const log = createLogger('funding-data-fetcher');

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface FundingRateRecord {
  coin: string;
  timestamp: number;       // Unix ms
  fundingRate: string;     // Decimal string e.g., "0.000125"
}

export interface FetchOptions {
  coin: string;
  startTime: number;       // Unix ms
  endTime: number;         // Unix ms
}

// ═══════════════════════════════════════════════════════════════════════════
// Hyperliquid API response type
// ═══════════════════════════════════════════════════════════════════════════

interface HyperliquidFundingResponse {
  coin: string;
  fundingRate: string;
  time: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const HYPERLIQUID_API_URL = 'https://api.hyperliquid.xyz/info';
const MAX_RECORDS_PER_PAGE = 500;
const MAX_RETRIES = 3;
const MAX_DAYS = 365;
const MS_PER_DAY = 86_400_000;

// ═══════════════════════════════════════════════════════════════════════════
// FundingDataFetcher
// ═══════════════════════════════════════════════════════════════════════════

/**
 * FundingDataFetcher retrieves historical funding rates from Hyperliquid
 * and caches them in the FundingDatabase.
 *
 * Usage:
 * ```ts
 * const fetcher = new FundingDataFetcher(db);
 * const rates = await fetcher.fetchFundingRates({ coin: 'ETH', startTime, endTime });
 * ```
 */
export class FundingDataFetcher {
  private readonly db: FundingDatabase;
  private readonly apiUrl: string;

  constructor(db: FundingDatabase, apiUrl: string = HYPERLIQUID_API_URL) {
    this.db = db;
    this.apiUrl = apiUrl;
  }

  /**
   * Fetch and cache funding rates for a coin within the given time range.
   * Returns all rates in range (from cache or freshly fetched).
   *
   * If the database already covers the requested range, the API call is skipped.
   * Otherwise, fetches from Hyperliquid with pagination and upserts into the DB.
   */
  async fetchFundingRates(options: FetchOptions): Promise<FundingRateRecord[]> {
    const { coin, startTime, endTime } = options;

    // Validate time range (max 365 days)
    const rangeMs = endTime - startTime;
    if (rangeMs > MAX_DAYS * MS_PER_DAY) {
      log.warn('Requested range exceeds 365 days, clamping startTime', {
        coin,
        requestedDays: Math.ceil(rangeMs / MS_PER_DAY),
      });
    }

    const effectiveStart = Math.max(startTime, endTime - MAX_DAYS * MS_PER_DAY);

    // Check cache first
    if (this.hasCachedData(coin, effectiveStart, endTime)) {
      log.info('Cache hit — skipping API call', { coin, startTime: effectiveStart, endTime });
      return this.getFromDatabase(coin, effectiveStart, endTime);
    }

    // Fetch from Hyperliquid API with pagination
    log.info('Fetching funding rates from Hyperliquid', {
      coin,
      startTime: effectiveStart,
      endTime,
    });

    const records = await this.fetchAllPages(coin, effectiveStart, endTime);

    // Upsert all fetched records into the database
    for (const record of records) {
      this.db.upsertFundingRate(record.coin, record.timestamp, record.fundingRate);
    }

    log.info('Funding rates fetched and cached', {
      coin,
      recordCount: records.length,
    });

    // Return from DB to ensure consistent ordering and deduplication
    return this.getFromDatabase(coin, effectiveStart, endTime);
  }

  /**
   * Check if the database already has data covering the requested range.
   * Delegates to FundingDatabase.hasCoverage.
   */
  hasCachedData(coin: string, startTime: number, endTime: number): boolean {
    return this.db.hasCoverage(coin, startTime, endTime);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch all pages of funding history from Hyperliquid.
   * Paginates by using the last record's timestamp + 1ms as the next startTime.
   */
  private async fetchAllPages(
    coin: string,
    startTime: number,
    endTime: number,
  ): Promise<FundingRateRecord[]> {
    const allRecords: FundingRateRecord[] = [];
    let currentStart = startTime;

    while (currentStart < endTime) {
      const batch = await this.fetchPageWithRetry(coin, currentStart);

      if (batch.length === 0) break;

      // Filter records within our endTime boundary
      const validRecords = batch.filter((r) => r.timestamp <= endTime);
      allRecords.push(...validRecords);

      // If we got fewer than max records, we've reached the end
      if (batch.length < MAX_RECORDS_PER_PAGE) break;

      // Use last timestamp + 1 as next page start to avoid duplicates
      const lastTimestamp = batch[batch.length - 1]!.timestamp;

      // Safety: if last timestamp hasn't advanced, break to avoid infinite loop
      if (lastTimestamp <= currentStart) break;

      currentStart = lastTimestamp + 1;

      log.debug('Pagination progress', {
        coin,
        fetched: allRecords.length,
        nextStart: currentStart,
      });
    }

    return allRecords;
  }

  /**
   * Fetch a single page with retry logic (3 attempts, exponential backoff).
   */
  private async fetchPageWithRetry(
    coin: string,
    startTime: number,
  ): Promise<FundingRateRecord[]> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.fetchPage(coin, startTime);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (attempt === MAX_RETRIES - 1) {
          log.error('Failed to fetch funding rates after all retries', {
            coin,
            startTime,
            attempts: MAX_RETRIES,
            error: message,
          });
          // Return empty on final failure — don't crash the process
          return [];
        }

        const delayMs = 1000 * Math.pow(2, attempt); // 1s, 2s, 4s
        log.warn(`Retry ${attempt + 1}/${MAX_RETRIES} after ${delayMs}ms`, {
          coin,
          error: message,
        });
        await this.sleep(delayMs);
      }
    }

    // Unreachable
    return [];
  }

  /**
   * Fetch a single page from Hyperliquid fundingHistory endpoint.
   *
   * POST https://api.hyperliquid.xyz/info
   * Body: { "type": "fundingHistory", "coin": "<COIN>", "startTime": <unix_ms> }
   * Response: [{ "coin": "ETH", "fundingRate": "0.000125", "time": 1700000000000 }, ...]
   */
  private async fetchPage(coin: string, startTime: number): Promise<FundingRateRecord[]> {
    const response = await axios.post<HyperliquidFundingResponse[]>(
      this.apiUrl,
      {
        type: 'fundingHistory',
        coin,
        startTime,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30_000,
      },
    );

    if (!Array.isArray(response.data)) {
      throw new Error(`Unexpected response format: expected array, got ${typeof response.data}`);
    }

    return response.data.map((item) => ({
      coin: item.coin,
      timestamp: item.time,
      fundingRate: item.fundingRate,
    }));
  }

  /**
   * Get funding rates from the database for a given range.
   */
  private getFromDatabase(coin: string, startTime: number, endTime: number): FundingRateRecord[] {
    const rows = this.db.getFundingRates(coin, startTime, endTime);
    return rows.map((row) => ({
      coin: row.coin,
      timestamp: row.timestamp,
      fundingRate: row.funding_rate,
    }));
  }

  /**
   * Sleep helper for retry backoff.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

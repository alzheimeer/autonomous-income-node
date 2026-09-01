/**
 * Funding Arbitrage Backtest — Price Data Fetcher
 *
 * Retrieves hourly spot price data from Binance via the existing CandleCache
 * infrastructure. Maps coin symbols to Binance trading pairs (e.g., ETH → ETHUSDC).
 *
 * If Binance data is unavailable for a coin, logs a warning and returns null
 * so the caller can exclude the coin from simulation.
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import { CandleCache } from '../candle-cache.js';
import { createLogger } from '../../logger.js';
import type { CandleData } from '../types.js';

const log = createLogger('price-fetcher');

/**
 * PriceDataFetcher retrieves hourly spot price data for funding-arb simulation.
 *
 * Reuses the existing CandleCache to download from Binance and cache locally,
 * avoiding repeated network calls for the same data.
 */
export class PriceDataFetcher {
  private candleCache: CandleCache;

  constructor(candleCache?: CandleCache) {
    this.candleCache = candleCache ?? new CandleCache();
  }

  /**
   * Get hourly spot price data for a coin.
   *
   * Uses the existing CandleCache infrastructure to download from Binance
   * and cache results locally. Returns null if data is unavailable.
   *
   * @param coin - Coin symbol (e.g., "ETH", "BTC")
   * @param days - Number of days of history to fetch
   * @returns Array of hourly CandleData, or null if unavailable
   */
  async getHourlyPrices(coin: string, days: number): Promise<CandleData[] | null> {
    const symbol = this.toBinanceSymbol(coin);

    try {
      log.info('Fetching hourly prices', { coin, symbol, days });

      // Use CandleCache with 1h timeframe and 0 warmup candles
      // (the simulator doesn't need extra warmup for price data)
      const candles = await this.candleCache.getCandles(symbol, '1h', days, 0);

      if (!candles || candles.length === 0) {
        log.warn('No price data returned from Binance', { coin, symbol, days });
        return null;
      }

      log.info('Hourly prices fetched successfully', {
        coin,
        symbol,
        days,
        candleCount: candles.length,
      });

      return candles;
    } catch (err) {
      log.warn('Failed to fetch hourly prices — excluding coin from simulation', {
        coin,
        symbol,
        days,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Map a coin symbol to a Binance trading pair.
   *
   * Convention: coin + "USDC" (e.g., ETH → ETHUSDC, BTC → BTCUSDC).
   * Handles common special cases where Binance uses a different ticker.
   *
   * @param coin - Coin symbol (e.g., "ETH", "BTC", "SOL")
   * @returns Binance trading pair string (e.g., "ETHUSDC")
   */
  toBinanceSymbol(coin: string): string {
    // Normalize to uppercase and trim whitespace
    const normalized = coin.trim().toUpperCase();

    // Special case mappings for coins with non-standard Binance tickers
    const specialMappings: Record<string, string> = {
      WBTC: 'BTCUSDC',
      WETH: 'ETHUSDC',
    };

    if (specialMappings[normalized]) {
      return specialMappings[normalized];
    }

    return `${normalized}USDC`;
  }
}

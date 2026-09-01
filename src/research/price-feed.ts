/**
 * PriceFeedService — Simple price polling via CoinGecko API.
 *
 * Free, no API key needed.
 * Polls every 60s. Cache in memory.
 */

import axios from 'axios';

export interface PriceData {
  symbol: string;
  price: number;
  timestamp: number;
}

const POLL_INTERVAL_MS = 60_000;
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price';
const COIN_IDS = 'ethereum,bitcoin';

export class PriceFeedService {
  private prices: Map<string, PriceData> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;

  start(): void {
    if (this.timer) return;
    console.log('[PriceFeedService] Starting price polling (60s interval).');
    this.timer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
    // Immediate first poll
    this.poll();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getPrice(symbol: string): PriceData | null {
    return this.prices.get(symbol.toLowerCase()) ?? null;
  }

  getAllPrices(): PriceData[] {
    return Array.from(this.prices.values());
  }

  private async poll(): Promise<void> {
    try {
      const response = await axios.get(COINGECKO_URL, {
        params: {
          ids: COIN_IDS,
          vs_currencies: 'usd',
        },
        timeout: 15_000,
      });

      const data = response.data;
      const now = Date.now();

      if (data.ethereum?.usd) {
        this.prices.set('eth', { symbol: 'ETH', price: data.ethereum.usd, timestamp: now });
      }
      if (data.bitcoin?.usd) {
        this.prices.set('btc', { symbol: 'BTC', price: data.bitcoin.usd, timestamp: now });
      }
    } catch (err) {
      console.warn('[PriceFeedService] Poll failed:', (err as Error).message);
    }
  }
}

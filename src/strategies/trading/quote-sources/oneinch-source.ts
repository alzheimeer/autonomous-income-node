/**
 * OneInchSource — 1inch API v6.0 quote adapter for Base (chainId 8453)
 *
 * Fetches swap quotes from the 1inch aggregator.
 * Requires ONEINCH_API_KEY environment variable.
 *
 * Revenue Optimization Engine — Task 3.2
 */

import type { QuoteSource, PriceQuote } from './types.js';
import { normalizeToE18 } from './types.js';

const BASE_URL = 'https://api.1inch.dev/swap/v6.0/8453/quote';
const TIMEOUT_MS = 10_000;

export class OneInchSource implements QuoteSource {
  readonly name = 'oneinch';
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['ONEINCH_API_KEY'] ?? '';
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<PriceQuote | null> {
    if (!this.apiKey) {
      return null;
    }

    try {
      const url = new URL(BASE_URL);
      url.searchParams.set('src', tokenIn);
      url.searchParams.set('dst', tokenOut);
      url.searchParams.set('amount', amountIn.toString());

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as { dstAmount?: string };
      const expectedOut = BigInt(data.dstAmount ?? '0');

      if (expectedOut === 0n) {
        return null;
      }

      const normalizedPriceE18 = normalizeToE18(expectedOut, amountIn, 18);

      return {
        source: this.name,
        tokenIn,
        tokenOut,
        amountIn,
        expectedOut,
        normalizedPriceE18,
        timestamp: Date.now(),
      };
    } catch {
      // Never throw — return null on any failure
      return null;
    }
  }
}

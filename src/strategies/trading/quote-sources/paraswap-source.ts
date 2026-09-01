/**
 * ParaswapSource — Paraswap API v5 quote adapter for Base (chainId 8453)
 *
 * Fetches swap quotes from the Paraswap aggregator.
 * No API key required (rate-limited).
 *
 * Revenue Optimization Engine — Task 3.3
 */

import type { QuoteSource, PriceQuote } from './types.js';
import { normalizeToE18 } from './types.js';

const BASE_URL = 'https://apiv5.paraswap.io/prices';
const TIMEOUT_MS = 10_000;

export class ParaswapSource implements QuoteSource {
  readonly name = 'paraswap';

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    tokenInDecimals = 6,
    tokenOutDecimals = 18,
  ): Promise<PriceQuote | null> {
    try {
      const url = new URL(BASE_URL);
      url.searchParams.set('srcToken', tokenIn);
      url.searchParams.set('destToken', tokenOut);
      url.searchParams.set('amount', amountIn.toString());
      url.searchParams.set('srcDecimals', tokenInDecimals.toString());
      url.searchParams.set('destDecimals', tokenOutDecimals.toString());
      url.searchParams.set('network', '8453'); // Base
      url.searchParams.set('side', 'SELL');

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url.toString(), {
        headers: {
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        // Rate limited or other error
        return null;
      }

      const data = await response.json() as {
        priceRoute?: { destAmount?: string };
      };

      const destAmount = data.priceRoute?.destAmount;
      if (!destAmount) {
        return null;
      }

      const expectedOut = BigInt(destAmount);
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

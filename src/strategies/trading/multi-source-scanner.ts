/**
 * MultiSourceScanner — Multi-DEX arbitrage detection
 *
 * Queries multiple price sources in parallel for each token pair,
 * compares normalized prices, and identifies profitable spread
 * opportunities.
 *
 * Revenue Optimization Engine — Task 3.5
 */

import type {
  QuoteSource,
  PriceQuote,
  TokenPair,
  ArbitrageOpportunity,
} from './quote-sources/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface MultiSourceScannerConfig {
  /** Minimum net profit to report an opportunity (6 decimals). Default: 500_000n ($0.50) */
  minProfitUsdc: bigint;
  /** Maximum trade size in USDC (6 decimals). Default: 50_000000n ($50) */
  maxTradeUsdc: bigint;
  /** Estimated gas cost per swap in USDC (6 decimals). Default: 200_000n ($0.20) */
  gasCostUsdc: bigint;
}

export const DEFAULT_SCANNER_CONFIG: MultiSourceScannerConfig = {
  minProfitUsdc: 500_000n,
  maxTradeUsdc: 50_000000n,
  gasCostUsdc: 200_000n,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class MultiSourceScanner {
  private readonly sources: QuoteSource[];
  private readonly config: MultiSourceScannerConfig;

  constructor(sources: QuoteSource[], config?: Partial<MultiSourceScannerConfig>) {
    this.sources = sources;
    this.config = { ...DEFAULT_SCANNER_CONFIG, ...config };
  }

  /**
   * Scans all configured token pairs across all sources for arbitrage.
   *
   * For each pair:
   * 1. Query all sources in parallel
   * 2. Filter null results (failed sources)
   * 3. If < 2 valid quotes: skip pair
   * 4. Find best buy (lowest price) and best sell (highest price)
   * 5. Calculate spread and estimated profit
   * 6. Only include if net profit > minProfitUsdc
   *
   * @param pairs - Token pairs to scan
   * @param balance - Current wallet balance (limits trade size)
   * @returns Opportunities sorted by net profit descending
   */
  async scan(pairs: TokenPair[], balance: bigint): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    // Cap trade size to balance or maxTradeUsdc, whichever is smaller
    const maxTrade = balance < this.config.maxTradeUsdc ? balance : this.config.maxTradeUsdc;

    for (const pair of pairs) {
      try {
        const pairOpportunity = await this.scanPair(pair, maxTrade);
        if (pairOpportunity) {
          opportunities.push(pairOpportunity);
        }
      } catch (err) {
        // Individual pair failures don't crash the scan
        console.warn(`[MultiSourceScanner] Error scanning pair ${pair.tokenIn}/${pair.tokenOut}:`, err);
      }
    }

    // Sort by net profit descending
    return opportunities.sort((a, b) => {
      if (b.netProfitUsdc > a.netProfitUsdc) return 1;
      if (b.netProfitUsdc < a.netProfitUsdc) return -1;
      return 0;
    });
  }

  /**
   * Scan a single pair across all sources.
   */
  private async scanPair(
    pair: TokenPair,
    maxTrade: bigint,
  ): Promise<ArbitrageOpportunity | null> {
    // Use the pair's amountIn or cap to maxTrade
    const amountIn = pair.amountIn < maxTrade ? pair.amountIn : maxTrade;

    // Query all sources in parallel
    const results = await Promise.allSettled(
      this.sources.map((source) =>
        source.getQuote(pair.tokenIn, pair.tokenOut, amountIn),
      ),
    );

    // Filter to valid (non-null) quotes
    const validQuotes: PriceQuote[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        validQuotes.push(result.value);
      }
    }

    // Need at least 2 sources to compare
    if (validQuotes.length < 2) {
      return null;
    }

    // Find best buy (lowest normalized price) and best sell (highest)
    let bestBuy = validQuotes[0]!;
    let bestSell = validQuotes[0]!;

    for (const quote of validQuotes) {
      if (quote.normalizedPriceE18 < bestBuy.normalizedPriceE18) {
        bestBuy = quote;
      }
      if (quote.normalizedPriceE18 > bestSell.normalizedPriceE18) {
        bestSell = quote;
      }
    }

    // No spread if buy and sell are the same source
    if (bestBuy.source === bestSell.source) {
      return null;
    }

    // Calculate spread in basis points
    if (bestBuy.normalizedPriceE18 === 0n) {
      return null;
    }

    const spreadBps =
      ((bestSell.normalizedPriceE18 - bestBuy.normalizedPriceE18) * 10000n) /
      bestBuy.normalizedPriceE18;

    // No profit if sell price <= buy price
    if (spreadBps <= 0n) {
      return null;
    }

    // Estimate profit: (spreadBps * amountIn) / 10000 - gasCost
    const grossProfit = (spreadBps * amountIn) / 10000n;
    const netProfit = grossProfit - this.config.gasCostUsdc;

    // Only report if net profit exceeds minimum
    if (netProfit <= this.config.minProfitUsdc) {
      return null;
    }

    return {
      pair,
      buySource: bestBuy,
      sellSource: bestSell,
      spreadBps,
      estimatedProfitUsdc: grossProfit,
      gasCostUsdc: this.config.gasCostUsdc,
      netProfitUsdc: netProfit,
    };
  }
}

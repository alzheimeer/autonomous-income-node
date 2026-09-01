/**
 * QuoteSource interface and shared types for multi-source price comparison.
 *
 * Revenue Optimization Engine — Task 3.1
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** A normalized price quote from a single DEX/aggregator source */
export interface PriceQuote {
  /** Source identifier (e.g. 'oneinch', 'paraswap', 'uniswap_quoter') */
  source: string;
  /** Input token address */
  tokenIn: string;
  /** Output token address */
  tokenOut: string;
  /** Input amount in token's native decimals */
  amountIn: bigint;
  /** Expected output amount in token's native decimals */
  expectedOut: bigint;
  /**
   * Normalized price in 18 decimals: how much tokenOut per unit of tokenIn.
   * Formula: (expectedOut * 10^18) / amountIn
   * Adjusted for decimal differences between tokens.
   */
  normalizedPriceE18: bigint;
  /** Timestamp when quote was obtained (ms) */
  timestamp: number;
}

/** Interface that all quote source adapters must implement */
export interface QuoteSource {
  /** Human-readable source name */
  name: string;

  /**
   * Get a price quote for a token swap.
   * Returns null on any failure (network, rate limit, invalid pair).
   * Must NEVER throw.
   */
  getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<PriceQuote | null>;
}

/** A token pair to scan for arbitrage */
export interface TokenPair {
  tokenIn: string;
  tokenOut: string;
  /** Decimals of tokenIn */
  tokenInDecimals: number;
  /** Decimals of tokenOut */
  tokenOutDecimals: number;
  /** Amount to quote in tokenIn's native decimals */
  amountIn: bigint;
}

/** Detected arbitrage opportunity between two sources */
export interface ArbitrageOpportunity {
  pair: TokenPair;
  buySource: PriceQuote;
  sellSource: PriceQuote;
  spreadBps: bigint;
  estimatedProfitUsdc: bigint;
  gasCostUsdc: bigint;
  netProfitUsdc: bigint;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Normalizes a quote to 18-decimal price representation.
 * This allows comparing quotes across sources with different token decimals.
 *
 * @param expectedOut - Output amount in tokenOut's native decimals
 * @param amountIn - Input amount in tokenIn's native decimals
 * @param tokenOutDecimals - Decimals of the output token
 * @returns Price normalized to 18 decimals
 */
export function normalizeToE18(
  expectedOut: bigint,
  amountIn: bigint,
  tokenOutDecimals: number,
): bigint {
  if (amountIn === 0n) return 0n;
  // Normalize: (expectedOut * 10^18) / amountIn
  // We adjust for tokenOut decimals to get a comparable unit price
  const e18 = 10n ** 18n;
  return (expectedOut * e18) / amountIn;
}

/**
 * Executable Quote Engine - Fresh quotes from QuoterV2 with optional aggregator comparison
 *
 * Obtains executable quotes from Uniswap V3 QuoterV2 on Base for WETH/USDC trades.
 * Optionally compares against a configured aggregator router (if allowlisted).
 * Enforces TTL (10s), calculates price impact, and performs basis guard checks
 * against Binance reference prices.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 20.3
 */

import type { UsdcAmount, WethAmount, ExecutableQuote } from './types.js';
import type { QuoteEngineConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Provider interface for making QuoterV2 eth_call.
 * Compatible with ethers v6 Contract.staticCall pattern.
 */
export interface IQuoterV2Provider {
  quoteExactInputSingle(params: QuoteExactInputSingleParams): Promise<QuoterV2Result>;
}

/** QuoterV2.quoteExactInputSingle input parameters */
export interface QuoteExactInputSingleParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  fee: number;
  sqrtPriceLimitX96: bigint;
}

/** QuoterV2.quoteExactInputSingle return values */
export interface QuoterV2Result {
  amountOut: bigint;
  sqrtPriceX96After: bigint;
  initializedTicksCrossed: number;
  gasEstimate: bigint;
}

/**
 * Optional aggregator quote provider.
 * Used only if configured AND router is allowlisted.
 */
export interface IAggregatorProvider {
  getQuote(tokenIn: string, tokenOut: string, amountIn: bigint): Promise<AggregatorQuoteResult>;
}

/** Aggregator quote result */
export interface AggregatorQuoteResult {
  amountOut: bigint;
  gasEstimate: bigint;
  externalFees: bigint;
}

/**
 * Binance reference price provider for basis guard.
 * Returns the current WETH/USDC mid price from Binance or null if unavailable.
 */
export interface IBinancePriceProvider {
  getPrice(): number | null;
}

/**
 * Gas price provider for converting gas units to USD.
 */
export interface IGasPriceProvider {
  /** Returns current gas price in wei */
  getGasPrice(): Promise<bigint>;
  /** Returns current ETH/USD price for gas cost conversion */
  getEthUsdPrice(): number;
}

/**
 * Callback for logging quotes to the quotes_log table.
 * Decouples this module from direct DB dependency.
 */
export interface IQuoteLogger {
  logQuote(entry: QuoteLogEntry): void;
}

/** Quote log entry matching the quotes_log table schema */
export interface QuoteLogEntry {
  source: 'quoter_v2' | 'aggregator';
  direction: 'entry' | 'exit';
  amountIn: string;  // BigInt as string
  amountOut: string; // BigInt as string
  priceImpactBps: number;
  gasEstimate: string; // BigInt as string
  gasUsd: number;
  timestamp: number;
  selected: boolean;
  rejectReason?: string;
}

/**
 * ExecutableQuoteEngine public interface.
 * Provides fresh executable quotes for entry/exit trades.
 */
export interface IExecutableQuoteEngine {
  /** Get an entry quote (USDC → WETH) */
  getEntryQuote(amountInUsdc: UsdcAmount): Promise<ExecutableQuote>;
  /** Get an exit quote (WETH → USDC) */
  getExitQuote(amountInWeth: WethAmount): Promise<ExecutableQuote>;
  /** Get the current Binance reference price (WETH/USDC) or null if unavailable */
  getBinanceReference(): number | null;
  /** Check if basis between on-chain and Binance exceeds threshold (100 bps) */
  checkBasis(onChainPrice: number, binancePrice: number): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** USDC decimals */
const USDC_DECIMALS = 6;

/** WETH decimals */
const WETH_DECIMALS = 18;

/** Basis points per unit (10_000 = 100%) */
const BPS_BASE = 10_000;

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class ExecutableQuoteEngine implements IExecutableQuoteEngine {
  private readonly config: QuoteEngineConfig;
  private readonly quoterV2: IQuoterV2Provider;
  private readonly binancePriceProvider: IBinancePriceProvider;
  private readonly gasPriceProvider: IGasPriceProvider;
  private readonly logger: IQuoteLogger;
  private readonly aggregator: IAggregatorProvider | null;
  private readonly allowlist: Set<string>;

  constructor(
    config: QuoteEngineConfig,
    quoterV2: IQuoterV2Provider,
    binancePriceProvider: IBinancePriceProvider,
    gasPriceProvider: IGasPriceProvider,
    logger: IQuoteLogger,
    aggregator?: IAggregatorProvider,
    allowlist?: string[],
  ) {
    this.config = config;
    this.quoterV2 = quoterV2;
    this.binancePriceProvider = binancePriceProvider;
    this.gasPriceProvider = gasPriceProvider;
    this.logger = logger;
    this.aggregator = aggregator ?? null;
    this.allowlist = new Set((allowlist ?? []).map((a) => a.toLowerCase()));
  }

  /**
   * Get an entry quote: USDC → WETH via QuoterV2.
   * Optionally compares against aggregator if configured + allowlisted.
   * Enforces TTL and calculates price impact.
   *
   * Requirements: 15.1, 15.2, 15.5
   */
  async getEntryQuote(amountInUsdc: UsdcAmount): Promise<ExecutableQuote> {
    const timestamp = Date.now();

    // Get QuoterV2 quote
    const quoterResult = await this.quoterV2.quoteExactInputSingle({
      tokenIn: this.config.usdcAddress,
      tokenOut: this.config.wethAddress,
      amountIn: amountInUsdc,
      fee: this.config.feeTier,
      sqrtPriceLimitX96: 0n, // no price limit
    });

    const gasPrice = await this.gasPriceProvider.getGasPrice();
    const ethUsdPrice = this.gasPriceProvider.getEthUsdPrice();
    const gasUsd = this.calculateGasUsd(quoterResult.gasEstimate, gasPrice, ethUsdPrice);

    // Calculate price impact using Binance reference
    const priceImpactBps = this.calculatePriceImpact(
      amountInUsdc,
      quoterResult.amountOut,
      'entry',
    );

    const quoterQuote: ExecutableQuote = {
      source: 'quoter_v2',
      amountIn: amountInUsdc,
      amountOut: quoterResult.amountOut,
      priceImpactBps,
      gasEstimate: quoterResult.gasEstimate,
      gasUsd,
      timestamp,
      poolFeeIncluded: true, // QuoterV2 amounts already include pool fee
      externalFees: 0n,
      ttl: this.config.quoteTtlMs,
    };

    // Optional aggregator comparison
    if (this.shouldUseAggregator()) {
      try {
        const aggResult = await this.aggregator!.getQuote(
          this.config.usdcAddress,
          this.config.wethAddress,
          amountInUsdc,
        );

        const aggGasUsd = this.calculateGasUsd(aggResult.gasEstimate, gasPrice, ethUsdPrice);
        const aggImpactBps = this.calculatePriceImpact(
          amountInUsdc,
          aggResult.amountOut,
          'entry',
        );

        const aggQuote: ExecutableQuote = {
          source: 'aggregator',
          amountIn: amountInUsdc,
          amountOut: aggResult.amountOut,
          priceImpactBps: aggImpactBps,
          gasEstimate: aggResult.gasEstimate,
          gasUsd: aggGasUsd,
          timestamp,
          poolFeeIncluded: false,
          externalFees: aggResult.externalFees,
          ttl: this.config.quoteTtlMs,
        };

        // Select the better quote (higher output after fees)
        const quoterNet = quoterResult.amountOut;
        const aggNet = aggResult.amountOut;

        if (aggNet > quoterNet) {
          // Aggregator is better — log aggregator as selected, QuoterV2 as rejected
          this.logger.logQuote({
            source: 'aggregator',
            direction: 'entry',
            amountIn: amountInUsdc.toString(),
            amountOut: aggResult.amountOut.toString(),
            priceImpactBps: aggImpactBps,
            gasEstimate: aggResult.gasEstimate.toString(),
            gasUsd: aggGasUsd,
            timestamp,
            selected: true,
          });

          this.logger.logQuote({
            source: 'quoter_v2',
            direction: 'entry',
            amountIn: amountInUsdc.toString(),
            amountOut: quoterResult.amountOut.toString(),
            priceImpactBps,
            gasEstimate: quoterResult.gasEstimate.toString(),
            gasUsd,
            timestamp,
            selected: false,
            rejectReason: 'aggregator_better',
          });

          return aggQuote;
        }

        // QuoterV2 is better — log QuoterV2 as selected, aggregator as rejected
        this.logger.logQuote({
          source: 'quoter_v2',
          direction: 'entry',
          amountIn: amountInUsdc.toString(),
          amountOut: quoterResult.amountOut.toString(),
          priceImpactBps,
          gasEstimate: quoterResult.gasEstimate.toString(),
          gasUsd,
          timestamp,
          selected: true,
        });

        this.logger.logQuote({
          source: 'aggregator',
          direction: 'entry',
          amountIn: amountInUsdc.toString(),
          amountOut: aggResult.amountOut.toString(),
          priceImpactBps: aggImpactBps,
          gasEstimate: aggResult.gasEstimate.toString(),
          gasUsd: aggGasUsd,
          timestamp,
          selected: false,
          rejectReason: 'quoter_v2_better',
        });

        return quoterQuote;
      } catch {
        // Aggregator failure is non-fatal — fall through to log QuoterV2 as selected
      }
    }

    // Log the QuoterV2 quote as selected (no aggregator or aggregator failed)
    this.logger.logQuote({
      source: 'quoter_v2',
      direction: 'entry',
      amountIn: amountInUsdc.toString(),
      amountOut: quoterResult.amountOut.toString(),
      priceImpactBps,
      gasEstimate: quoterResult.gasEstimate.toString(),
      gasUsd,
      timestamp,
      selected: true,
    });

    return quoterQuote;
  }

  /**
   * Get an exit quote: WETH → USDC via QuoterV2.
   * Optionally compares against aggregator if configured + allowlisted.
   *
   * Requirements: 15.1, 15.2, 15.5
   */
  async getExitQuote(amountInWeth: WethAmount): Promise<ExecutableQuote> {
    const timestamp = Date.now();

    // Get QuoterV2 quote
    const quoterResult = await this.quoterV2.quoteExactInputSingle({
      tokenIn: this.config.wethAddress,
      tokenOut: this.config.usdcAddress,
      amountIn: amountInWeth,
      fee: this.config.feeTier,
      sqrtPriceLimitX96: 0n,
    });

    const gasPrice = await this.gasPriceProvider.getGasPrice();
    const ethUsdPrice = this.gasPriceProvider.getEthUsdPrice();
    const gasUsd = this.calculateGasUsd(quoterResult.gasEstimate, gasPrice, ethUsdPrice);

    // Calculate price impact
    const priceImpactBps = this.calculatePriceImpact(
      amountInWeth,
      quoterResult.amountOut,
      'exit',
    );

    const quoterQuote: ExecutableQuote = {
      source: 'quoter_v2',
      amountIn: amountInWeth,
      amountOut: quoterResult.amountOut,
      priceImpactBps,
      gasEstimate: quoterResult.gasEstimate,
      gasUsd,
      timestamp,
      poolFeeIncluded: true,
      externalFees: 0n,
      ttl: this.config.quoteTtlMs,
    };

    // Optional aggregator comparison
    if (this.shouldUseAggregator()) {
      try {
        const aggResult = await this.aggregator!.getQuote(
          this.config.wethAddress,
          this.config.usdcAddress,
          amountInWeth,
        );

        const aggGasUsd = this.calculateGasUsd(aggResult.gasEstimate, gasPrice, ethUsdPrice);
        const aggImpactBps = this.calculatePriceImpact(
          amountInWeth,
          aggResult.amountOut,
          'exit',
        );

        const aggQuote: ExecutableQuote = {
          source: 'aggregator',
          amountIn: amountInWeth,
          amountOut: aggResult.amountOut,
          priceImpactBps: aggImpactBps,
          gasEstimate: aggResult.gasEstimate,
          gasUsd: aggGasUsd,
          timestamp,
          poolFeeIncluded: false,
          externalFees: aggResult.externalFees,
          ttl: this.config.quoteTtlMs,
        };

        const quoterNet = quoterResult.amountOut;
        const aggNet = aggResult.amountOut;

        if (aggNet > quoterNet) {
          this.logger.logQuote({
            source: 'aggregator',
            direction: 'exit',
            amountIn: amountInWeth.toString(),
            amountOut: aggResult.amountOut.toString(),
            priceImpactBps: aggImpactBps,
            gasEstimate: aggResult.gasEstimate.toString(),
            gasUsd: aggGasUsd,
            timestamp,
            selected: true,
          });

          this.logger.logQuote({
            source: 'quoter_v2',
            direction: 'exit',
            amountIn: amountInWeth.toString(),
            amountOut: quoterResult.amountOut.toString(),
            priceImpactBps,
            gasEstimate: quoterResult.gasEstimate.toString(),
            gasUsd,
            timestamp,
            selected: false,
            rejectReason: 'aggregator_better',
          });

          return aggQuote;
        }

        // QuoterV2 is better — log both
        this.logger.logQuote({
          source: 'quoter_v2',
          direction: 'exit',
          amountIn: amountInWeth.toString(),
          amountOut: quoterResult.amountOut.toString(),
          priceImpactBps,
          gasEstimate: quoterResult.gasEstimate.toString(),
          gasUsd,
          timestamp,
          selected: true,
        });

        this.logger.logQuote({
          source: 'aggregator',
          direction: 'exit',
          amountIn: amountInWeth.toString(),
          amountOut: aggResult.amountOut.toString(),
          priceImpactBps: aggImpactBps,
          gasEstimate: aggResult.gasEstimate.toString(),
          gasUsd: aggGasUsd,
          timestamp,
          selected: false,
          rejectReason: 'quoter_v2_better',
        });

        return quoterQuote;
      } catch {
        // Aggregator failure is non-fatal — fall through
      }
    }

    // Log the QuoterV2 quote as selected (no aggregator or aggregator failed)
    this.logger.logQuote({
      source: 'quoter_v2',
      direction: 'exit',
      amountIn: amountInWeth.toString(),
      amountOut: quoterResult.amountOut.toString(),
      priceImpactBps,
      gasEstimate: quoterResult.gasEstimate.toString(),
      gasUsd,
      timestamp,
      selected: true,
    });

    return quoterQuote;
  }

  /**
   * Get the current Binance reference price (WETH/USDC).
   * Returns null if unavailable.
   *
   * Requirements: 15.4
   */
  getBinanceReference(): number | null {
    return this.binancePriceProvider.getPrice();
  }

  /**
   * Check if the basis between on-chain price and Binance reference exceeds
   * the configured threshold (default 100 bps).
   * Returns true if basis exceeds threshold (trade should be flagged/blocked).
   *
   * Requirements: 15.4, 20.3
   */
  checkBasis(onChainPrice: number, binancePrice: number): boolean {
    if (binancePrice <= 0 || onChainPrice <= 0) {
      return true; // Flag as invalid if either price is non-positive
    }

    const basisBps = Math.abs(onChainPrice - binancePrice) / binancePrice * BPS_BASE;
    return basisBps > this.config.basisAlertBps;
  }

  /**
   * Validates that a quote is still within its TTL.
   * Returns true if the quote is expired (older than quoteTtlMs).
   */
  isQuoteExpired(quote: ExecutableQuote): boolean {
    const age = Date.now() - quote.timestamp;
    return age > quote.ttl;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check if aggregator should be used:
   * - aggregator provider is available
   * - aggregator router is configured
   * - aggregator router is in the allowlist
   */
  private shouldUseAggregator(): boolean {
    if (!this.aggregator) return false;
    if (!this.config.aggregatorRouter) return false;
    return this.allowlist.has(this.config.aggregatorRouter.toLowerCase());
  }

  /**
   * Calculate gas cost in USD.
   * gasUsd = (gasUnits * gasPrice * ethUsdPrice) / 1e18
   */
  private calculateGasUsd(gasUnits: bigint, gasPrice: bigint, ethUsdPrice: number): number {
    // gasWei = gasUnits * gasPrice
    const gasWei = gasUnits * gasPrice;
    // Convert to ETH (18 decimals) then multiply by USD price
    const gasEth = Number(gasWei) / 1e18;
    return gasEth * ethUsdPrice;
  }

  /**
   * Calculate price impact in basis points.
   * Compares the effective execution price vs Binance reference mid price.
   *
   * For entry (USDC→WETH): impact = (reference_output - actual_output) / reference_output * 10000
   * For exit (WETH→USDC): impact = (reference_output - actual_output) / reference_output * 10000
   *
   * Requirements: 15.3
   */
  private calculatePriceImpact(
    amountIn: bigint,
    amountOut: bigint,
    direction: 'entry' | 'exit',
  ): number {
    const binancePrice = this.binancePriceProvider.getPrice();
    if (!binancePrice || binancePrice <= 0) {
      return 0; // Cannot calculate without reference price
    }

    let theoreticalOutput: number;

    if (direction === 'entry') {
      // USDC → WETH: theoretical WETH output at Binance price
      // amountIn is USDC (6 decimals), binancePrice is WETH/USDC
      const usdcFloat = Number(amountIn) / 10 ** USDC_DECIMALS;
      theoreticalOutput = usdcFloat / binancePrice; // In WETH units
      const actualOutput = Number(amountOut) / 10 ** WETH_DECIMALS;

      if (theoreticalOutput <= 0) return 0;
      const impact = (theoreticalOutput - actualOutput) / theoreticalOutput * BPS_BASE;
      return Math.max(0, Math.round(impact));
    } else {
      // WETH → USDC: theoretical USDC output at Binance price
      const wethFloat = Number(amountIn) / 10 ** WETH_DECIMALS;
      theoreticalOutput = wethFloat * binancePrice; // In USDC units
      const actualOutput = Number(amountOut) / 10 ** USDC_DECIMALS;

      if (theoreticalOutput <= 0) return 0;
      const impact = (theoreticalOutput - actualOutput) / theoreticalOutput * BPS_BASE;
      return Math.max(0, Math.round(impact));
    }
  }
}

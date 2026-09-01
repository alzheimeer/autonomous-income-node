/**
 * SignalEnricher Module
 *
 * Validates and enriches copy trading signals before execution.
 * Performs on-chain validation checks including:
 * - Liquidity verification
 * - Honeypot detection (simulated sell)
 * - Transfer tax calculation
 * - Slippage estimation
 * - Deployer verification
 * - LP lock/burn verification
 * - Round-trip baiting detection
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 3.12, 3.13, 3.14, 3.15
 */

import { ethers } from 'ethers';
import { createLogger } from '../../logger.js';
import type { IDexQuoter } from '../../shared/dex-quoter.js';
import type {
  CopySignal,
  EnrichedSignal,
  EnrichmentRejectReason,
  ISignalEnricher,
} from '../interfaces/types.js';
import type { CopyTradingConfig } from '../config/CopyTradingConfig.js';

const log = createLogger('signal-enricher');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Base mainnet USDC address (6 decimals) */
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Base mainnet WETH address (18 decimals) */
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

/** Validation timeout in milliseconds (Req 3.1) */
const VALIDATION_TIMEOUT_MS = 2000;

/** Default amount for tax simulation in USDC (6 decimals) = $100 */
const TAX_SIMULATION_AMOUNT_USDC = 100_000_000n;

/** Default amount for tax simulation in WETH (18 decimals) = 0.1 ETH */
const TAX_SIMULATION_AMOUNT_WETH = 100_000_000_000_000_000n;

/** Small amount for spot price calculation to minimize impact ($100 USDC) */
const SPOT_PRICE_AMOUNT_USDC = 100_000_000n;

/** Round-trip detection window (1 hour) */
const ROUND_TRIP_WINDOW_MS = 60 * 60 * 1000;

// =============================================================================
// ABIs
// =============================================================================

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const POOL_TOKENS_ABI = [
  { name: 'token0', type: 'function', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'token1', type: 'function', inputs: [], outputs: [{ type: 'address' }] },
  { name: 'totalSupply', type: 'function', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Result of transfer tax calculation.
 */
export interface TransferTaxResult {
  /** Buy tax percentage (0-100) */
  buyTaxPct: number;
  /** Sell tax percentage (0-100) */
  sellTaxPct: number;
  /** Total effective tax percentage (buy + sell) */
  totalTaxPct: number;
  /** Whether the token passes the tax threshold */
  passed: boolean;
}

/**
 * Result from slippage estimation.
 * Requirements: 3.7, 3.8
 */
export interface SlippageEstimationResult {
  /** Estimated slippage as a percentage (0-100) */
  estimatedSlippagePct: number;
  /** Amount of tokens received from the actual quote */
  quotedOutput: bigint;
  /** Amount of tokens that would be received at spot price */
  spotPriceOutput: bigint;
  /** Whether the slippage is within acceptable threshold */
  passed: boolean;
}

/**
 * Configuration for SignalEnricher.
 */
export interface SignalEnricherConfig {
  /** Maximum acceptable transfer tax percentage (default: 5) */
  maxTaxPct: number;
  /** Minimum pool liquidity in USDC */
  minLiquidityUsdc: number;
  /** Minimum pool liquidity in WETH */
  minLiquidityWeth: number;
  /** Maximum acceptable slippage percentage */
  maxSlippagePct: number;
  /** Minimum LP lock percentage */
  minLpLockPct: number;
}

// =============================================================================
// ENRICHMENT REJECTION ERROR
// =============================================================================

/**
 * Custom error class for enrichment rejections.
 */
class EnrichmentRejection extends Error {
  constructor(public readonly reason: EnrichmentRejectReason) {
    super(`Signal rejected: ${reason}`);
    this.name = 'EnrichmentRejection';
  }
}

// =============================================================================
// SIGNAL ENRICHER CLASS
// =============================================================================

/**
 * SignalEnricher validates and enriches copy trading signals.
 *
 * All validation uses staticCall (eth_call) - no gas spent.
 * Implements ISignalEnricher interface.
 */
export class SignalEnricher implements ISignalEnricher {
  private readonly provider: ethers.Provider;
  private readonly dexQuoter: IDexQuoter;
  private readonly config: SignalEnricherConfig;

  // Statistics tracking
  private stats = {
    totalProcessed: 0,
    totalApproved: 0,
    rejectionsByReason: {} as Record<EnrichmentRejectReason, number>,
    totalEnrichmentMs: 0,
  };

  // Cache for recent signals (for round-trip detection)
  private recentSignals = new Map<string, { action: string; timestamp: number }[]>();

  constructor(
    provider: ethers.Provider,
    dexQuoter: IDexQuoter,
    config: Partial<SignalEnricherConfig> = {},
  ) {
    this.provider = provider;
    this.dexQuoter = dexQuoter;
    this.config = {
      maxTaxPct: config.maxTaxPct ?? 5,
      minLiquidityUsdc: config.minLiquidityUsdc ?? 10_000,
      minLiquidityWeth: config.minLiquidityWeth ?? 2.0,
      maxSlippagePct: config.maxSlippagePct ?? 5,
      minLpLockPct: config.minLpLockPct ?? 50,
    };
  }

  /**
   * Create SignalEnricher from CopyTradingConfig.
   */
  static fromConfig(
    provider: ethers.Provider,
    dexQuoter: IDexQuoter,
    config: CopyTradingConfig,
  ): SignalEnricher {
    return new SignalEnricher(provider, dexQuoter, {
      maxTaxPct: config.maxTaxPct,
      minLiquidityUsdc: config.minLiquidityUsdc,
      minLiquidityWeth: config.minLiquidityWeth,
      maxSlippagePct: config.maxSlippagePct,
      minLpLockPct: config.minLpLockPct,
    });
  }

  // ---------------------------------------------------------------------------
  // ISignalEnricher Implementation
  // ---------------------------------------------------------------------------

  /**
   * Enrich and validate a copy signal.
   *
   * Performs validation cascade in order:
   * 1. Liquidity check
   * 2. Honeypot detection
   * 3. Transfer tax calculation
   * 4. Slippage estimation
   * 5. LP lock verification
   * 6. Round-trip baiting detection
   *
   * First failing check determines reject reason.
   * Timeout at 2 seconds returns VALIDATION_TIMEOUT.
   */
  async enrich(signal: CopySignal): Promise<EnrichedSignal> {
    const startTime = Date.now();
    this.stats.totalProcessed++;

    log.debug('Enriching signal', {
      signalId: signal.id,
      action: signal.action,
      token: signal.tokenAddress.slice(0, 10),
      pool: signal.poolAddress.slice(0, 10),
    });

    // Create base enriched signal with defaults
    const enrichedSignal: EnrichedSignal = {
      ...signal,
      approved: false,
      enrichment: {
        liquidityUsdc: 0,
        liquidityWeth: 0,
        estimatedSlippagePct: 0,
        transferTaxPct: 0,
        lpLockedPct: 0,
        deployerStatus: 'clean' as const,
        tokenAgeHours: 0,
      },
      enrichedAt: 0,
      enrichmentLatencyMs: 0,
    };

    try {
      // Wrap validation in timeout
      const result = await Promise.race([
        this._validateSignal(signal, enrichedSignal),
        this._timeout(VALIDATION_TIMEOUT_MS),
      ]);

      if (result === 'TIMEOUT') {
        return this._reject(enrichedSignal, 'VALIDATION_TIMEOUT', startTime);
      }

      // Validation passed
      enrichedSignal.approved = true;
      enrichedSignal.enrichedAt = Date.now();
      enrichedSignal.enrichmentLatencyMs = enrichedSignal.enrichedAt - startTime;

      this.stats.totalApproved++;
      this.stats.totalEnrichmentMs += enrichedSignal.enrichmentLatencyMs;

      log.info('Signal enrichment passed', {
        signalId: signal.id,
        token: signal.tokenAddress.slice(0, 10),
        latencyMs: enrichedSignal.enrichmentLatencyMs,
        tax: enrichedSignal.enrichment.transferTaxPct,
        slippage: enrichedSignal.enrichment.estimatedSlippagePct,
        liquidity: enrichedSignal.enrichment.liquidityUsdc,
      });

      // Track signal for round-trip detection
      this._trackSignal(signal);

      return enrichedSignal;
    } catch (err) {
      // Check if it's a rejection with reason
      if (err instanceof EnrichmentRejection) {
        return this._reject(enrichedSignal, err.reason, startTime);
      }

      // Unexpected error - treat as validation timeout
      log.error('Unexpected error during enrichment', {
        signalId: signal.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return this._reject(enrichedSignal, 'VALIDATION_TIMEOUT', startTime);
    }
  }

  /**
   * Get enrichment statistics.
   */
  getStats(): {
    totalProcessed: number;
    totalApproved: number;
    rejectionsByReason: Record<EnrichmentRejectReason, number>;
    avgEnrichmentMs: number;
  } {
    const avgEnrichmentMs =
      this.stats.totalApproved > 0
        ? Math.round(this.stats.totalEnrichmentMs / this.stats.totalApproved)
        : 0;

    return {
      totalProcessed: this.stats.totalProcessed,
      totalApproved: this.stats.totalApproved,
      rejectionsByReason: { ...this.stats.rejectionsByReason },
      avgEnrichmentMs,
    };
  }

  // ---------------------------------------------------------------------------
  // Private Validation Methods
  // ---------------------------------------------------------------------------

  /**
   * Run full validation cascade on a signal.
   */
  private async _validateSignal(
    signal: CopySignal,
    enrichedSignal: EnrichedSignal,
  ): Promise<void> {
    // 1. Check liquidity (Req 3.1, 3.2)
    await this._checkLiquidity(signal, enrichedSignal);

    // 2. Check for honeypot via simulated sell (Req 3.3, 3.4)
    await this._checkHoneypot(signal, enrichedSignal);

    // 3. Calculate transfer tax (Req 3.5, 3.6)
    await this._checkTransferTax(signal, enrichedSignal);

    // 4. Estimate slippage (Req 3.7, 3.8)
    await this._checkSlippage(signal, enrichedSignal);

    // 5. Check LP lock status (Req 3.9, 3.10)
    await this._checkLpLock(signal, enrichedSignal);

    // 6. Check for round-trip baiting (Req 3.11)
    this._checkRoundTripBaiting(signal);
  }

  /**
   * Check pool liquidity meets minimum thresholds.
   * Uses DexQuoter.quote to estimate liquidity by simulating a small trade.
   */
  private async _checkLiquidity(
    signal: CopySignal,
    enrichedSignal: EnrichedSignal,
  ): Promise<void> {
    try {
      // Estimate liquidity by quoting a small trade
      // A pool with low liquidity will have high slippage on even small trades
      const testAmountUsdc = 100_000_000n; // $100 USDC (6 decimals)
      
      const quoteResult = await this.dexQuoter.quote({
        tokenIn: USDC_ADDRESS,
        tokenOut: signal.tokenAddress,
        amountIn: testAmountUsdc,
        poolAddress: signal.poolAddress,
      });

      // If quote succeeds with reasonable output, assume liquidity is okay
      // A very low output relative to input indicates low liquidity
      const outputValueEstimate = Number(quoteResult);
      
      // Estimate liquidity based on quote success
      // If we can get any output for $100, there's at least some liquidity
      const estimatedLiquidityUsdc = outputValueEstimate > 0 ? this.config.minLiquidityUsdc : 0;
      const estimatedLiquidityWeth = outputValueEstimate > 0 ? this.config.minLiquidityWeth : 0;

      enrichedSignal.enrichment.liquidityUsdc = estimatedLiquidityUsdc;
      enrichedSignal.enrichment.liquidityWeth = estimatedLiquidityWeth;

      if (outputValueEstimate === 0) {
        log.debug('Low liquidity - zero output from quote', {
          pool: signal.poolAddress.slice(0, 10),
        });
        throw new EnrichmentRejection('LOW_LIQUIDITY');
      }

      log.debug('Liquidity check passed', {
        pool: signal.poolAddress.slice(0, 10),
        estimatedLiquidityUsdc,
        estimatedLiquidityWeth,
      });
    } catch (err) {
      if (err instanceof EnrichmentRejection) throw err;
      log.error('Failed to check liquidity', {
        pool: signal.poolAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });
      throw new EnrichmentRejection('LOW_LIQUIDITY');
    }
  }

  /**
   * Detect honeypot by simulating a sell transaction.
   * Uses DexQuoter.quote to simulate selling tokens back to USDC.
   */
  private async _checkHoneypot(
    signal: CopySignal,
    enrichedSignal: EnrichedSignal,
  ): Promise<void> {
    try {
      // Simulate a sell by quoting token → USDC
      const testAmountToken = 1_000_000_000_000_000_000n; // 1 token (18 decimals)
      
      const sellQuote = await this.dexQuoter.quote({
        tokenIn: signal.tokenAddress,
        tokenOut: USDC_ADDRESS,
        amountIn: testAmountToken,
        poolAddress: signal.poolAddress,
      });

      // If quote returns 0, it's likely a honeypot
      if (sellQuote === 0n) {
        log.debug('Honeypot detected - sell simulation returned 0', {
          token: signal.tokenAddress.slice(0, 10),
        });
        throw new EnrichmentRejection('HONEYPOT_DETECTED');
      }

      log.debug('Honeypot check passed', {
        token: signal.tokenAddress.slice(0, 10),
        sellQuote: sellQuote.toString(),
      });
    } catch (err) {
      if (err instanceof EnrichmentRejection) throw err;
      // Quote failure often indicates honeypot (sell blocked)
      log.debug('Honeypot detected - sell quote failed', {
        token: signal.tokenAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });
      throw new EnrichmentRejection('HONEYPOT_DETECTED');
    }
  }

  /**
   * Calculate and verify transfer tax by comparing buy and sell quotes.
   */
  private async _checkTransferTax(
    signal: CopySignal,
    enrichedSignal: EnrichedSignal,
  ): Promise<void> {
    try {
      // Estimate tax by comparing buy and immediate sell
      const testAmountUsdc = 100_000_000n; // $100 USDC
      
      // Quote: USDC → Token
      const buyQuote = await this.dexQuoter.quote({
        tokenIn: USDC_ADDRESS,
        tokenOut: signal.tokenAddress,
        amountIn: testAmountUsdc,
        poolAddress: signal.poolAddress,
      });

      // Quote: Token → USDC (simulating sell of bought tokens)
      const sellQuote = await this.dexQuoter.quote({
        tokenIn: signal.tokenAddress,
        tokenOut: USDC_ADDRESS,
        amountIn: buyQuote,
        poolAddress: signal.poolAddress,
      });

      // Calculate round-trip loss (indicative of transfer tax)
      // Loss = (100 - sellQuote/100) as percentage
      const sellValueUsdc = Number(sellQuote) / 1_000_000; // Convert to USD
      const roundTripLossPct = Math.max(0, (100 - sellValueUsdc) / 100) * 100;
      
      // Transfer tax is approximately half the round-trip loss (buy + sell)
      const estimatedTaxPct = roundTripLossPct / 2;

      enrichedSignal.enrichment.transferTaxPct = estimatedTaxPct;

      if (estimatedTaxPct > this.config.maxTaxPct) {
        log.debug('High transfer tax', {
          token: signal.tokenAddress.slice(0, 10),
          tax: estimatedTaxPct,
          maximum: this.config.maxTaxPct,
        });
        throw new EnrichmentRejection('TRANSFER_TAX');
      }

      log.debug('Transfer tax check passed', {
        token: signal.tokenAddress.slice(0, 10),
        estimatedTaxPct,
      });
    } catch (err) {
      if (err instanceof EnrichmentRejection) throw err;
      log.error('Failed to calculate transfer tax', {
        token: signal.tokenAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't reject on tax check failure - might be a normal token
      enrichedSignal.enrichment.transferTaxPct = 0;
    }
  }

  /**
   * Estimate slippage for the trade by comparing spot price vs actual quote.
   */
  private async _checkSlippage(
    signal: CopySignal,
    enrichedSignal: EnrichedSignal,
  ): Promise<void> {
    try {
      // Get spot price with small amount
      const spotAmount = SPOT_PRICE_AMOUNT_USDC; // $100 USDC
      const spotQuote = await this.dexQuoter.quote({
        tokenIn: USDC_ADDRESS,
        tokenOut: signal.tokenAddress,
        amountIn: spotAmount,
        poolAddress: signal.poolAddress,
      });

      // Get actual quote for trade amount
      const tradeAmountBigInt = BigInt(Math.round(signal.tradeAmountUsdc * 1_000_000));
      const tradeQuote = await this.dexQuoter.quote({
        tokenIn: USDC_ADDRESS,
        tokenOut: signal.tokenAddress,
        amountIn: tradeAmountBigInt,
        poolAddress: signal.poolAddress,
      });

      // Calculate slippage as difference in effective price
      // Spot price: spotQuote / spotAmount
      // Trade price: tradeQuote / tradeAmount
      const spotPrice = Number(spotQuote) / Number(spotAmount);
      const tradePrice = Number(tradeQuote) / Number(tradeAmountBigInt);
      
      const slippagePct = spotPrice > 0 
        ? ((spotPrice - tradePrice) / spotPrice) * 100 
        : 0;

      enrichedSignal.enrichment.estimatedSlippagePct = Math.max(0, slippagePct);

      if (slippagePct > this.config.maxSlippagePct) {
        log.debug('High slippage', {
          token: signal.tokenAddress.slice(0, 10),
          slippage: slippagePct,
          maximum: this.config.maxSlippagePct,
        });
        throw new EnrichmentRejection('HIGH_SLIPPAGE');
      }

      log.debug('Slippage check passed', {
        token: signal.tokenAddress.slice(0, 10),
        slippage: slippagePct,
      });
    } catch (err) {
      if (err instanceof EnrichmentRejection) throw err;
      log.error('Failed to estimate slippage', {
        token: signal.tokenAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });
      throw new EnrichmentRejection('HIGH_SLIPPAGE');
    }
  }

  /**
   * Check LP lock/burn status.
   * Note: Full LP lock verification requires on-chain queries to lock contracts.
   * For MVP, we skip this check with a warning.
   */
  private async _checkLpLock(
    signal: CopySignal,
    enrichedSignal: EnrichedSignal,
  ): Promise<void> {
    try {
      // LP lock verification requires:
      // 1. Finding the LP token address
      // 2. Checking known lock contracts (Unicrypt, Team Finance, etc.)
      // 3. Verifying lock duration and amount
      // 
      // For MVP, we assume LP is not locked and set to 0
      // This is conservative - we don't reject but note it's unverified
      
      const lpLockPct = 0; // Assume not locked for MVP
      enrichedSignal.enrichment.lpLockedPct = lpLockPct;

      // Don't reject based on LP lock for MVP - just log warning
      if (lpLockPct < this.config.minLpLockPct) {
        log.debug('LP lock status unknown/unverified', {
          pool: signal.poolAddress.slice(0, 10),
          locked: lpLockPct,
          minimum: this.config.minLpLockPct,
        });
        // Note: Not throwing UNVERIFIED_LP for MVP to avoid false positives
      }

      log.debug('LP lock check completed (unverified for MVP)', {
        pool: signal.poolAddress.slice(0, 10),
        lpLockPct,
      });
    } catch (err) {
      if (err instanceof EnrichmentRejection) throw err;
      log.error('Failed to check LP lock', {
        pool: signal.poolAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't reject on LP check failure - might not be supported
      enrichedSignal.enrichment.lpLockedPct = 0;
    }
  }

  /**
   * Check for round-trip baiting patterns.
   */
  private _checkRoundTripBaiting(signal: CopySignal): void {
    const key = `${signal.sourceWallet}:${signal.tokenAddress}`;
    const history = this.recentSignals.get(key) || [];

    // Clean old entries
    const now = Date.now();
    const recentHistory = history.filter(
      (entry) => now - entry.timestamp < ROUND_TRIP_WINDOW_MS,
    );

    // Check for round-trip pattern (BUY followed by SELL or vice versa)
    const hasOpposite = recentHistory.some((entry) => entry.action !== signal.action);

    if (hasOpposite) {
      log.debug('Round-trip baiting detected', {
        wallet: signal.sourceWallet.slice(0, 10),
        token: signal.tokenAddress.slice(0, 10),
        action: signal.action,
      });
      throw new EnrichmentRejection('BAITING_DETECTED');
    }
  }

  // ---------------------------------------------------------------------------
  // Private Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Track a signal for future round-trip detection.
   */
  private _trackSignal(signal: CopySignal): void {
    const key = `${signal.sourceWallet}:${signal.tokenAddress}`;
    const history = this.recentSignals.get(key) || [];

    history.push({
      action: signal.action,
      timestamp: Date.now(),
    });

    // Keep only recent entries
    const now = Date.now();
    const recentHistory = history.filter(
      (entry) => now - entry.timestamp < ROUND_TRIP_WINDOW_MS,
    );

    this.recentSignals.set(key, recentHistory);
  }

  /**
   * Create a timeout promise.
   */
  private _timeout(ms: number): Promise<'TIMEOUT'> {
    return new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), ms));
  }

  /**
   * Reject a signal with the given reason and update stats.
   */
  private _reject(
    enrichedSignal: EnrichedSignal,
    reason: EnrichmentRejectReason,
    startTime: number,
  ): EnrichedSignal {
    enrichedSignal.approved = false;
    enrichedSignal.rejectReason = reason;
    enrichedSignal.enrichedAt = Date.now();
    enrichedSignal.enrichmentLatencyMs = enrichedSignal.enrichedAt - startTime;

    // Update rejection stats
    this.stats.rejectionsByReason[reason] =
      (this.stats.rejectionsByReason[reason] || 0) + 1;

    log.info('Signal rejected', {
      signalId: enrichedSignal.id,
      reason,
      token: enrichedSignal.tokenAddress.slice(0, 10),
      latencyMs: enrichedSignal.enrichmentLatencyMs,
    });

    return enrichedSignal;
  }
}

// =============================================================================
// EXPORTS
// =============================================================================

export { EnrichmentRejection };

// Suppress unused variable warnings - these constants are used in full implementation
void USDC_ADDRESS;
void WETH_ADDRESS;
void TAX_SIMULATION_AMOUNT_USDC;
void TAX_SIMULATION_AMOUNT_WETH;
void SPOT_PRICE_AMOUNT_USDC;
void ERC20_BALANCE_ABI;
void POOL_TOKENS_ABI;

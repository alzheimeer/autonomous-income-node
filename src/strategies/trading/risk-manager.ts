/**
 * RiskManager — Composite trade validation
 *
 * Enforces all risk constraints before any swap is submitted:
 *   1. Trade-size limit: Tier 1 or 2 → max $5 USDC per trade
 *   2. Exposure limit: a single trade must not exceed 20 % of total balance
 *   3. Slippage limit: configurable tolerance, default 0.5 %
 *   4. Minimum profit threshold: configurable via MIN_PROFIT_THRESHOLD_USDC, default $0.50
 *
 * Requirements: 6.2, 6.5, 6.6, 6.8
 */

import { SurvivalTier } from '../../survival/tier-evaluator.js';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  /** Human-readable reason when `valid === false`. */
  reason?: string;
}

export interface RiskManager {
  /**
   * Validate that `amount` respects the trade-size limit for the given tier.
   * Tier 1 or 2 → max $5 USDC (5_000000n).
   * Tier 3+ → no cap.
   *
   * Requirements: 6.8
   */
  validateTradeSize(
    amount: bigint,
    balance: bigint,
    tier: SurvivalTier
  ): ValidationResult;

  /**
   * Validate that the actual slippage does not exceed `tolerancePct`.
   *
   * Slippage = (expected - actual) / expected × 100
   * Rejects if actualSlippage > tolerancePct.
   *
   * Requirements: 6.6
   */
  validateSlippage(
    expected: bigint,
    actual: bigint,
    tolerancePct: number
  ): ValidationResult;

  /**
   * Validate that `amount` does not exceed 20 % of `totalBalance`.
   *
   * Requirements: 6.5
   */
  validateExposure(amount: bigint, totalBalance: bigint): ValidationResult;

  /**
   * Validate that `netProfitUsdc` meets the minimum profit threshold.
   *
   * Threshold is read from `MIN_PROFIT_THRESHOLD_USDC` env var (raw 6-decimal
   * bigint as a string), defaulting to 500000n ($0.50 USDC).
   *
   * Requirements: 6.3
   */
  validateMinProfit(netProfitUsdc: bigint): ValidationResult;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum trade size for Tier 1 / Tier 2 in USDC 6-decimal units ($5.00) */
const TIER_LOW_MAX_TRADE_SIZE = 5_000000n;

/** 20 % exposure cap (numerator out of 100) */
const MAX_EXPOSURE_PCT = 20n;

/** Default minimum profit threshold: $0.50 USDC in 6-decimal units */
const DEFAULT_MIN_PROFIT_THRESHOLD = 500_000n; // 0.5 USDC

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Concrete implementation of {@link RiskManager}.
 *
 * All thresholds can be overridden at construction time for testing.
 */
export class RiskManagerImpl implements RiskManager {
  private readonly minProfitThreshold: bigint;
  /**
   * Default slippage tolerance in percent used when callers do not provide one.
   * Set via env var `DEFAULT_SLIPPAGE_PCT` (float string), default 0.5.
   */
  private readonly defaultSlippagePct: number;

  constructor(options?: {
    /** Override the minimum profit threshold (6-decimal USDC bigint). */
    minProfitThreshold?: bigint;
    /** Override the default slippage tolerance percent (e.g. 0.5). */
    defaultSlippagePct?: number;
  }) {
    // Minimum profit: env override → constructor arg → hard default
    const envThreshold = process.env['MIN_PROFIT_THRESHOLD_USDC'];
    this.minProfitThreshold =
      options?.minProfitThreshold ??
      (envThreshold ? BigInt(envThreshold) : DEFAULT_MIN_PROFIT_THRESHOLD);

    const envSlippage = process.env['DEFAULT_SLIPPAGE_PCT'];
    this.defaultSlippagePct =
      options?.defaultSlippagePct ??
      (envSlippage ? parseFloat(envSlippage) : 0.5);
  }

  // ---------------------------------------------------------------------------
  // validateTradeSize — Requirement 6.8
  // ---------------------------------------------------------------------------

  validateTradeSize(
    amount: bigint,
    _balance: bigint,
    tier: SurvivalTier
  ): ValidationResult {
    if (amount <= 0n) {
      return { valid: false, reason: 'Trade amount must be greater than zero.' };
    }

    const isLowTier = tier === SurvivalTier.TIER_1 || tier === SurvivalTier.TIER_2;

    if (isLowTier && amount > TIER_LOW_MAX_TRADE_SIZE) {
      return {
        valid: false,
        reason:
          `Trade size ${amount} exceeds the $5 USDC cap (${TIER_LOW_MAX_TRADE_SIZE}) ` +
          `enforced for Tier 1 and Tier 2.`,
      };
    }

    return { valid: true };
  }

  // ---------------------------------------------------------------------------
  // validateSlippage — Requirement 6.6
  // ---------------------------------------------------------------------------

  validateSlippage(
    expected: bigint,
    actual: bigint,
    tolerancePct: number
  ): ValidationResult {
    if (expected <= 0n) {
      return { valid: false, reason: 'Expected output must be greater than zero.' };
    }

    if (actual <= 0n) {
      return { valid: false, reason: 'Actual output must be greater than zero.' };
    }

    const usedTolerance =
      typeof tolerancePct === 'number' && isFinite(tolerancePct) && tolerancePct >= 0
        ? tolerancePct
        : this.defaultSlippagePct;

    // actualSlippage = (expected - actual) / expected * 100
    // We work in integer arithmetic to avoid bigint/float mixing.
    // Scale by 10_000 to preserve 2 decimal places of precision.
    const SCALE = 10_000n;
    const scaledTolerance = BigInt(Math.round(usedTolerance * Number(SCALE)));

    let actualSlippageScaled: bigint;
    if (actual >= expected) {
      // Positive price impact (better than expected) → zero slippage
      actualSlippageScaled = 0n;
    } else {
      actualSlippageScaled = ((expected - actual) * 100n * SCALE) / expected;
    }

    if (actualSlippageScaled > scaledTolerance) {
      const slippagePct = (Number(actualSlippageScaled) / Number(SCALE)).toFixed(4);
      return {
        valid: false,
        reason:
          `Actual slippage ${slippagePct}% exceeds tolerance ${usedTolerance}%.`,
      };
    }

    return { valid: true };
  }

  // ---------------------------------------------------------------------------
  // validateExposure — Requirement 6.5
  // ---------------------------------------------------------------------------

  validateExposure(amount: bigint, totalBalance: bigint): ValidationResult {
    if (totalBalance <= 0n) {
      return {
        valid: false,
        reason: 'Total balance must be greater than zero to evaluate exposure.',
      };
    }

    if (amount <= 0n) {
      return { valid: false, reason: 'Trade amount must be greater than zero.' };
    }

    // exposure% = amount / totalBalance * 100
    // Reject if exposure > 20 %
    // To avoid float: check amount * 100 > totalBalance * 20
    if (amount * 100n > totalBalance * MAX_EXPOSURE_PCT) {
      const exposurePct = (
        (Number(amount) / Number(totalBalance)) *
        100
      ).toFixed(2);
      return {
        valid: false,
        reason:
          `Trade exposure ${exposurePct}% exceeds the 20% maximum ` +
          `(amount: ${amount}, balance: ${totalBalance}).`,
      };
    }

    return { valid: true };
  }

  // ---------------------------------------------------------------------------
  // validateMinProfit — Requirement 6.3
  // ---------------------------------------------------------------------------

  validateMinProfit(netProfitUsdc: bigint): ValidationResult {
    if (netProfitUsdc < this.minProfitThreshold) {
      return {
        valid: false,
        reason:
          `Net profit ${netProfitUsdc} is below the minimum threshold of ` +
          `${this.minProfitThreshold} (${Number(this.minProfitThreshold) / 1_000_000} USDC).`,
      };
    }

    return { valid: true };
  }

  // ---------------------------------------------------------------------------
  // Accessors (for testing / introspection)
  // ---------------------------------------------------------------------------

  getMinProfitThreshold(): bigint {
    return this.minProfitThreshold;
  }

  getDefaultSlippagePct(): number {
    return this.defaultSlippagePct;
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton factory
// ---------------------------------------------------------------------------

/**
 * Create a production {@link RiskManagerImpl} instance.
 * Reads threshold overrides from environment variables.
 */
export function createRiskManager(): RiskManagerImpl {
  return new RiskManagerImpl();
}

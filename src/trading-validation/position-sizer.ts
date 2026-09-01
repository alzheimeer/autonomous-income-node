/**
 * Trading Validation Phase - Position Sizer
 *
 * Calculates trade size from risk budget and stop distance.
 * Formula: trade_size = risk_budget / stop_distance_fraction
 * risk_budget = min(maxRiskPerTrade, bankroll * maxRiskPctBankroll)
 *
 * Clamp: skip if < $5, cap at $10.
 * Invalid stop guard: reject if fraction is 0, negative, NaN, or < 0.001.
 * Confidence does NOT affect size during validation phase.
 *
 * Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, E10
 */

import type { UsdcAmount } from './types.js';
import type { PositionSizerConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Result of a position sizing calculation.
 */
export interface SizingResult {
  /** Whether the sizing is valid (trade should proceed) */
  valid: boolean;
  /** The final trade size in USDC (clamped) */
  sizeUsdc: UsdcAmount;
  /** The calculated risk budget */
  riskBudget: UsdcAmount;
  /** The raw (unclamped) trade size */
  rawSize: UsdcAmount;
  /** Reason for rejection if invalid */
  reason?: string;
}

/**
 * Logger callback for recording sizing decisions.
 */
export type SizingLogger = (entry: {
  stopDistanceFraction: number;
  riskBudget: string;
  rawSize: string;
  clampedSize: string;
  valid: boolean;
  reason?: string;
}) => void;

// ═══════════════════════════════════════════════════════════════════════════
// Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Position sizer interface.
 * Calculates trade size from risk budget and stop distance fraction.
 */
export interface IPositionSizer {
  calculateSize(
    bankrollActive: UsdcAmount,
    stopDistanceFraction: number,
    confidence?: number,
  ): SizingResult;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Precision multiplier for BigInt division (to avoid losing precision) */
const PRECISION = 1_000_000n;

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class PositionSizer implements IPositionSizer {
  private readonly config: PositionSizerConfig;
  private readonly logger?: SizingLogger;

  constructor(config: PositionSizerConfig, logger?: SizingLogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Calculate position size from bankroll and stop distance.
   *
   * Formula: trade_size = risk_budget / stop_distance_fraction
   * risk_budget = min(config.maxRiskPerTrade, bankrollActive * config.maxRiskPctBankroll)
   *
   * Confidence parameter is IGNORED during validation phase (Req 26.4).
   *
   * @param bankrollActive - Current active bankroll in USDC (6 decimals BigInt)
   * @param stopDistanceFraction - Stop distance as a fraction (e.g., 0.02 = 2%)
   * @param _confidence - Ignored during validation phase (reserved for future use)
   */
  calculateSize(
    bankrollActive: UsdcAmount,
    stopDistanceFraction: number,
    _confidence?: number,
  ): SizingResult {
    // ─── Invalid stop guard (E10) ───────────────────────────────────────
    if (
      !Number.isFinite(stopDistanceFraction) ||
      stopDistanceFraction <= 0 ||
      stopDistanceFraction < this.config.minStopFraction
    ) {
      const result: SizingResult = {
        valid: false,
        sizeUsdc: 0n,
        riskBudget: 0n,
        rawSize: 0n,
        reason: 'invalid_stop_distance',
      };
      this.log(stopDistanceFraction, result);
      return result;
    }

    // ─── Calculate risk budget (Req 26.2) ───────────────────────────────
    // risk_budget = min(maxRiskPerTrade, bankrollActive * maxRiskPctBankroll)
    // For BigInt percentage: multiply bankroll by pct*PRECISION then divide by PRECISION
    const pctMultiplier = BigInt(Math.round(this.config.maxRiskPctBankroll * Number(PRECISION)));
    const pctRisk = (bankrollActive * pctMultiplier) / PRECISION;
    const riskBudget = pctRisk < this.config.maxRiskPerTrade ? pctRisk : this.config.maxRiskPerTrade;

    // ─── Calculate raw trade size (Req 26.1) ────────────────────────────
    // trade_size = risk_budget / stop_distance_fraction
    // Convert fraction to BigInt: multiply risk by PRECISION, divide by fraction*PRECISION
    const fractionBigInt = BigInt(Math.round(stopDistanceFraction * Number(PRECISION)));
    const rawSize = (riskBudget * PRECISION) / fractionBigInt;

    // ─── Clamp (Req 26.3) ───────────────────────────────────────────────
    // Skip if < $5 (minTradeSize), cap at $10 (maxTradeSize)
    if (rawSize < this.config.minTradeSize) {
      const result: SizingResult = {
        valid: false,
        sizeUsdc: 0n,
        riskBudget,
        rawSize,
        reason: 'below_minimum_trade_size',
      };
      this.log(stopDistanceFraction, result);
      return result;
    }

    const clampedSize = rawSize > this.config.maxTradeSize ? this.config.maxTradeSize : rawSize;

    const result: SizingResult = {
      valid: true,
      sizeUsdc: clampedSize,
      riskBudget,
      rawSize,
    };
    this.log(stopDistanceFraction, result);
    return result;
  }

  /**
   * Log sizing decision (Req 26.5).
   */
  private log(stopDistanceFraction: number, result: SizingResult): void {
    if (this.logger) {
      this.logger({
        stopDistanceFraction,
        riskBudget: result.riskBudget.toString(),
        rawSize: result.rawSize.toString(),
        clampedSize: result.sizeUsdc.toString(),
        valid: result.valid,
        reason: result.reason,
      });
    }
  }
}

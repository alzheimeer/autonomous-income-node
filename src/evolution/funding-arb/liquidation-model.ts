/**
 * Funding Arbitrage Backtest — Liquidation Model
 *
 * Tracks maintenance margin, detects stress events and forced closures,
 * computes maximum adverse moves and liquidation penalties.
 *
 * All arithmetic is BigInt (6-decimal USDC precision).
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

const BPS_DIVISOR = 10_000n;

/** Margin state snapshot for a position */
export interface MarginState {
  equity: bigint;          // Current account equity (6 decimals)
  positionValue: bigint;   // abs(position_size * current_price)
  marginRatio: bigint;     // equity * 10_000n / positionValue (bps)
  isStressed: boolean;     // marginRatio < 1000 (10%)
  isLiquidated: boolean;   // marginRatio < 600 (6%)
}

/** Record of a forced liquidation event */
export interface LiquidationEvent {
  timestamp: number;
  equityBefore: bigint;
  equityAfter: bigint;
  penalty: bigint;
  priceAtLiquidation: bigint;
}

/**
 * Liquidation risk model for the funding-arb strategy.
 *
 * Tracks the perp-side maintenance margin and detects:
 *   - Stress events (margin ratio < 10%)
 *   - Liquidation events (margin ratio < 6%)
 *
 * Computes maximum tolerable adverse price moves and liquidation penalties.
 */
export class LiquidationModel {
  private readonly maintenanceMarginBps = 600n;    // 6%
  private readonly stressThresholdBps = 1000n;     // 10%
  private readonly liquidationPenaltyBps = 50n;    // 0.5% penalty

  /**
   * Compute margin state for current position.
   *
   * If positionValue === 0n, returns safe defaults (100% margin, no stress/liquidation).
   */
  computeMarginState(equity: bigint, positionValue: bigint): MarginState {
    // Guard division by zero
    if (positionValue === 0n) {
      return {
        equity,
        positionValue,
        marginRatio: BPS_DIVISOR, // 10_000 bps = 100% collateralized
        isStressed: false,
        isLiquidated: false,
      };
    }

    const marginRatio = equity * BPS_DIVISOR / positionValue;

    return {
      equity,
      positionValue,
      marginRatio,
      isStressed: marginRatio < this.stressThresholdBps,
      isLiquidated: marginRatio < this.maintenanceMarginBps,
    };
  }

  /**
   * Check if a given adverse price move would trigger liquidation.
   *
   * The adverse move reduces equity by: move_bps * positionValue / BPS_DIVISOR.
   * After the loss, if margin ratio < maintenance margin → liquidation.
   */
  wouldLiquidate(
    equity: bigint,
    positionValue: bigint,
    priceMoveRatioBps: bigint,
  ): boolean {
    // Guard division by zero
    if (positionValue === 0n) {
      return false;
    }

    // Compute equity after adverse move
    const loss = priceMoveRatioBps * positionValue / BPS_DIVISOR;
    const newEquity = equity - loss;

    // If equity goes non-positive, definitely liquidated
    if (newEquity <= 0n) {
      return true;
    }

    // Check margin ratio after the move
    const newMarginRatio = newEquity * BPS_DIVISOR / positionValue;
    return newMarginRatio < this.maintenanceMarginBps;
  }

  /**
   * Compute maximum adverse price move (in bps) before liquidation.
   *
   * Formula: max_adverse_bps = margin_ratio_bps - maintenanceMarginBps
   *
   * If margin ratio is already at or below maintenance, returns 0n.
   * If positionValue === 0n, returns BPS_DIVISOR (safe maximum).
   */
  maxAdverseMoveBps(equity: bigint, positionValue: bigint): bigint {
    // Guard division by zero
    if (positionValue === 0n) {
      return BPS_DIVISOR; // 10_000 bps — fully collateralized, max room
    }

    const marginRatio = equity * BPS_DIVISOR / positionValue;

    // Already below or at maintenance threshold
    if (marginRatio <= this.maintenanceMarginBps) {
      return 0n;
    }

    return marginRatio - this.maintenanceMarginBps;
  }

  /**
   * Compute liquidation penalty.
   *
   * penalty = positionValue * 50 / 10_000 (0.5% of position)
   *
   * If positionValue === 0n, returns 0n.
   */
  computePenalty(positionValue: bigint): bigint {
    if (positionValue === 0n) {
      return 0n;
    }
    return positionValue * this.liquidationPenaltyBps / BPS_DIVISOR;
  }
}

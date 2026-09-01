/**
 * Funding Arbitrage Backtest — Simulator
 *
 * Hour-by-hour simulation engine for the delta-neutral funding rate arbitrage strategy.
 * Processes funding payments, costs, liquidation, and rebalance triggers sequentially
 * with strict no-lookahead constraint: each hour uses only current and past data.
 *
 * All monetary arithmetic uses BigInt (6-decimal USDC precision).
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1, 7.2, 7.3, 7.4
 */

import type { CostScenario, FundingArbCostModel } from './cost-model.js';
import type { LiquidationModel } from './liquidation-model.js';
import type { FundingRateRecord } from './data-fetcher.js';
import type { CandleData } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** 12 decimal places for funding rate precision */
export const RATE_PRECISION = 1_000_000_000_000n;

/** 1 basis point = 1/10_000 */
export const BPS_DIVISOR = 10_000n;

/** $1.00 in 6-decimal USDC representation */
export const ONE_USDC = 1_000_000n;

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface SimulatorConfig {
  capitalUsdc: bigint;                    // Starting capital (6 decimals)
  positionSizeFraction: bigint;           // % of capital as position (e.g., 80n = 80%)
  costScenario: CostScenario;
  rebalanceTriggerMarginBps: bigint;      // 1250n (margin util > 80%)
  rebalanceTriggerDivergeBps: bigint;     // 500n (5% basis drift)
  aaveApyBps: bigint;                     // e.g., 500n = 5% APY
  holguraBps: bigint;                     // Safety margin for edge
}

export interface SimulationStep {
  hour: number;
  timestamp: number;
  fundingRate: bigint;          // Scaled for BigInt precision
  spotPrice: bigint;            // 6 decimals
  fundingPnl: bigint;           // + or - funding payment
  cumulativePnl: bigint;
  equity: bigint;
  peakEquity: bigint;
  drawdownBps: bigint;          // Current drawdown in bps
  marginRatioBps: bigint;
  rebalanced: boolean;
  liquidated: boolean;
}

export interface SimulationResult {
  coin: string;
  capitalUsdc: bigint;
  hoursSimulated: number;
  grossFunding: bigint;         // Total positive funding collected
  totalCosts: bigint;           // All costs (open + close + rebalances + penalties)
  netPnl: bigint;               // final equity - initial capital
  maxDrawdownBps: bigint;
  liquidationCount: number;
  stressEventCount: number;
  benchmarkReturn: bigint;      // Aave USDC yield for same period
  alpha: bigint;                // netPnl - benchmarkReturn
  verdict: 'VIABLE' | 'UNVIABLE';
  costScenario: string;
  steps: SimulationStep[];      // Full hourly trace
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert a decimal string funding rate (e.g., "0.000125") to a BigInt
 * scaled by RATE_PRECISION (1_000_000_000_000n, 12 decimals).
 *
 * Handles negative rates by preserving the sign.
 * Uses string parsing to avoid floating-point intermediate values.
 */
export function rateToBigInt(rateStr: string): bigint {
  const trimmed = rateStr.trim();

  // Handle sign
  const isNegative = trimmed.startsWith('-');
  const abs = isNegative ? trimmed.slice(1) : trimmed;

  // Split on decimal point
  const parts = abs.split('.');
  const intPart = parts[0] || '0';
  const fracPart = parts[1] || '';

  // Pad or truncate fractional part to 12 digits (RATE_PRECISION scale)
  const padded = fracPart.padEnd(12, '0').slice(0, 12);

  // Combine integer and fractional parts
  const combined = intPart + padded;

  // Parse as BigInt (remove leading zeros that would confuse BigInt)
  const value = BigInt(combined);

  return isNegative ? -value : value;
}

/**
 * Convert a spot price (number, e.g., 3500.25) to a BigInt with 6 decimal precision.
 */
export function priceToBigInt(price: number): bigint {
  // Multiply by 1_000_000 and truncate to avoid floating-point artifacts
  return BigInt(Math.round(price * 1_000_000));
}

/**
 * Compute position value based on price change from entry.
 *
 * For a delta-neutral strategy, the position value for margin calculation
 * represents the notional exposure of the perp side.
 *
 * Since position is opened at a certain price and we track USDC-denominated size,
 * the position value adjusts based on price movement:
 *   positionValue = positionSizeUsdc * currentPrice / entryPrice
 *
 * If entryPrice is 0 (shouldn't happen), returns positionSize as-is.
 */
export function computePositionValue(
  positionSizeUsdc: bigint,
  currentPrice: bigint,
  entryPrice: bigint,
): bigint {
  if (entryPrice === 0n) {
    return positionSizeUsdc;
  }
  return positionSizeUsdc * currentPrice / entryPrice;
}

// ═══════════════════════════════════════════════════════════════════════════
// FundingArbSimulator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * FundingArbSimulator runs an hour-by-hour backtest of the delta-neutral
 * funding rate arbitrage strategy.
 *
 * The simulation loop:
 * 1. Deduct position open costs
 * 2. For each hour: apply funding → update position value → check liquidation → check rebalance → track metrics
 * 3. Deduct position close costs
 * 4. Compute benchmark (Aave yield) and alpha
 *
 * Strict no-lookahead: each hour uses only current and past data.
 */
export class FundingArbSimulator {
  private readonly config: SimulatorConfig;
  private readonly costModel: FundingArbCostModel;
  private readonly liquidationModel: LiquidationModel;

  constructor(
    config: SimulatorConfig,
    costModel: FundingArbCostModel,
    liquidationModel: LiquidationModel,
  ) {
    this.config = config;
    this.costModel = costModel;
    this.liquidationModel = liquidationModel;
  }

  /**
   * Run full simulation for a coin given funding rates and prices.
   *
   * @param coin - Coin symbol (e.g., "ETH")
   * @param fundingRates - Hourly funding rate records
   * @param prices - Hourly candle data (close price used)
   * @returns Complete simulation result with hourly trace
   */
  simulate(
    coin: string,
    fundingRates: FundingRateRecord[],
    prices: CandleData[],
  ): SimulationResult {
    const { config } = this;

    // ─── Initialize state ────────────────────────────────────────────────
    let equity = config.capitalUsdc;
    let positionSize = equity * config.positionSizeFraction / 100n;
    let cumulativePnl = 0n;
    let peakEquity = equity;
    let maxDrawdownBps = 0n;
    let totalCosts = 0n;
    let grossFunding = 0n;
    let liquidationCount = 0;
    let stressEventCount = 0;

    const steps: SimulationStep[] = [];

    // Use the first available price as entry price for position value tracking
    const entryPrice = prices.length > 0 ? priceToBigInt(prices[0]!.close) : ONE_USDC;

    // ─── Deduct position open costs ──────────────────────────────────────
    const openCosts = this.costModel.computeOpenCosts(positionSize);
    equity -= openCosts.total;
    totalCosts += openCosts.total;

    // ─── Hour-by-hour loop ───────────────────────────────────────────────
    const hoursToSimulate = Math.min(fundingRates.length, prices.length);

    for (let h = 0; h < hoursToSimulate; h++) {
      const rate = fundingRates[h]!;
      const price = prices[h]!;
      let rebalanced = false;
      let liquidated = false;

      // 1. Apply funding payment (BigInt, no floating-point)
      const fundingRateBigInt = rateToBigInt(rate.fundingRate);
      const fundingPnl = positionSize * fundingRateBigInt / RATE_PRECISION;

      equity += fundingPnl;
      cumulativePnl += fundingPnl;

      // Track gross positive funding
      if (fundingPnl > 0n) {
        grossFunding += fundingPnl;
      }

      // 2. Update position value based on current price (for margin calc)
      const currentPrice = priceToBigInt(price.close);
      const positionValue = computePositionValue(positionSize, currentPrice, entryPrice);

      // 3. Check liquidation
      const marginState = this.liquidationModel.computeMarginState(equity, positionValue);

      if (marginState.isLiquidated && positionSize > 0n) {
        const penalty = this.liquidationModel.computePenalty(positionValue);
        equity -= penalty;
        totalCosts += penalty;
        positionSize = 0n;
        liquidationCount++;
        liquidated = true;
      }

      // Track stress events (marginRatio < 10% but not liquidated)
      if (marginState.isStressed && !marginState.isLiquidated) {
        stressEventCount++;
      }

      // 4. Check rebalance triggers (only current state, no lookahead)
      if (!liquidated && positionSize > 0n) {
        if (this.shouldRebalance(marginState, currentPrice, entryPrice)) {
          const rebalanceCost = this.costModel.computeRebalanceCost(positionSize);
          equity -= rebalanceCost.cost;
          totalCosts += rebalanceCost.cost;
          rebalanced = true;
        }
      }

      // 5. Track metrics
      peakEquity = equity > peakEquity ? equity : peakEquity;
      const drawdownBps = peakEquity > 0n
        ? (peakEquity - equity) * BPS_DIVISOR / peakEquity
        : 0n;

      if (drawdownBps > maxDrawdownBps) {
        maxDrawdownBps = drawdownBps;
      }

      // Record step
      steps.push({
        hour: h,
        timestamp: rate.timestamp,
        fundingRate: fundingRateBigInt,
        spotPrice: currentPrice,
        fundingPnl,
        cumulativePnl,
        equity,
        peakEquity,
        drawdownBps,
        marginRatioBps: marginState.marginRatio,
        rebalanced,
        liquidated,
      });
    }

    // ─── Close position ──────────────────────────────────────────────────
    const closeCosts = this.costModel.computeCloseCosts(positionSize);
    equity -= closeCosts.total;
    totalCosts += closeCosts.total;

    // ─── Compute benchmark & alpha ───────────────────────────────────────
    const days = BigInt(Math.floor(hoursToSimulate / 24));
    const benchmarkReturn = config.capitalUsdc * config.aaveApyBps * days
      / (365n * BPS_DIVISOR);
    const netPnl = equity - config.capitalUsdc;
    const alpha = netPnl - benchmarkReturn;

    // Verdict: viable if alpha > 0 and no liquidations
    const verdict: 'VIABLE' | 'UNVIABLE' = (alpha > 0n && liquidationCount === 0)
      ? 'VIABLE'
      : 'UNVIABLE';

    return {
      coin,
      capitalUsdc: config.capitalUsdc,
      hoursSimulated: hoursToSimulate,
      grossFunding,
      totalCosts,
      netPnl,
      maxDrawdownBps,
      liquidationCount,
      stressEventCount,
      benchmarkReturn,
      alpha,
      verdict,
      costScenario: config.costScenario.name,
      steps,
    };
  }

  /**
   * Determine if a rebalance should be triggered at the current step.
   *
   * Triggers:
   * 1. Margin utilization > 80% → marginRatio < rebalanceTriggerMarginBps (1250 bps)
   * 2. Spot/perp diverge > rebalanceTriggerDivergeBps (500 bps = 5%)
   *    Measured as: |currentPrice - entryPrice| * BPS_DIVISOR / entryPrice > threshold
   */
  private shouldRebalance(
    marginState: { marginRatio: bigint },
    currentPrice: bigint,
    entryPrice: bigint,
  ): boolean {
    // Trigger 1: Margin utilization too high (margin ratio dropped below threshold)
    if (marginState.marginRatio < this.config.rebalanceTriggerMarginBps) {
      return true;
    }

    // Trigger 2: Spot/perp price divergence from entry exceeds threshold
    if (entryPrice > 0n) {
      const priceDiff = currentPrice > entryPrice
        ? currentPrice - entryPrice
        : entryPrice - currentPrice;
      const divergenceBps = priceDiff * BPS_DIVISOR / entryPrice;

      if (divergenceBps > this.config.rebalanceTriggerDivergeBps) {
        return true;
      }
    }

    return false;
  }
}

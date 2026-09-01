/**
 * Funding Arbitrage Backtest — Bankroll Optimizer
 *
 * Determines the minimum viable capital for the funding arbitrage strategy
 * by evaluating multiple capital levels against three criteria:
 *   1. Edge positive: alpha > capital * holguraBps / BPS_DIVISOR
 *   2. No liquidations: liquidationCount === 0
 *   3. Drawdown acceptable: maxDrawdownBps < maxDrawdownThreshold (default 1500n = 15%)
 *
 * Reports the smallest capital T that passes all three criteria, or null if none viable.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6
 */

import { FundingArbSimulator, BPS_DIVISOR } from './simulator.js';
import type { SimulatorConfig } from './simulator.js';
import type { FundingArbCostModel } from './cost-model.js';
import type { LiquidationModel } from './liquidation-model.js';
import type { FundingRateRecord } from './data-fetcher.js';
import type { CandleData } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface CapitalEvaluation {
  capitalUsdc: bigint;
  netPnl: bigint;
  alpha: bigint;
  maxDrawdownBps: bigint;
  liquidationCount: number;
  edgePositive: boolean;          // alpha > capital * holguraBps / BPS_DIVISOR
  noLiquidations: boolean;        // liquidationCount === 0
  drawdownAcceptable: boolean;    // maxDrawdownBps < maxDrawdownThreshold
  viable: boolean;                // all three true
}

export interface OptimizationResult {
  evaluations: CapitalEvaluation[];
  minimumViableCapital: bigint | null;   // Smallest T passing all criteria, or null
  overallVerdict: 'VIABLE' | 'UNVIABLE';
}

// ═══════════════════════════════════════════════════════════════════════════
// BankrollOptimizer
// ═══════════════════════════════════════════════════════════════════════════

/**
 * BankrollOptimizer evaluates multiple capital levels for a given coin
 * and determines the minimum viable capital that satisfies all viability criteria.
 *
 * For each capital level, it creates a new simulator config with that capital,
 * runs the simulation, and checks:
 * 1. Edge is positive with safety margin (holgura)
 * 2. Zero liquidation events occurred
 * 3. Maximum drawdown stays below the threshold (15%)
 */
export class BankrollOptimizer {
  private readonly baseConfig: SimulatorConfig;
  private readonly costModel: FundingArbCostModel;
  private readonly liquidationModel: LiquidationModel;
  private readonly holguraBps: bigint;
  private readonly maxDrawdownBps: bigint;

  constructor(
    baseConfig: SimulatorConfig,
    costModel: FundingArbCostModel,
    liquidationModel: LiquidationModel,
    holguraBps: bigint,           // Safety margin in bps
    maxDrawdownBps: bigint,       // 1500n = 15%
  ) {
    this.baseConfig = baseConfig;
    this.costModel = costModel;
    this.liquidationModel = liquidationModel;
    this.holguraBps = holguraBps;
    this.maxDrawdownBps = maxDrawdownBps;
  }

  /**
   * Evaluate all capital levels for a coin.
   *
   * For each capital in the provided array:
   * 1. Create a new SimulatorConfig with that capital (keeping all other settings)
   * 2. Create a new FundingArbSimulator with the updated config
   * 3. Run the simulation
   * 4. Evaluate the three viability criteria
   * 5. Record the evaluation
   *
   * Then determine the minimum viable capital (smallest passing all 3 criteria)
   * and the overall verdict.
   *
   * @param coin - Coin symbol (e.g., "ETH")
   * @param capitals - Array of capital levels to evaluate (bigint, 6-decimal USDC)
   * @param fundingRates - Hourly funding rate records
   * @param prices - Hourly candle data
   * @returns OptimizationResult with all evaluations and verdict
   */
  evaluate(
    coin: string,
    capitals: bigint[],
    fundingRates: FundingRateRecord[],
    prices: CandleData[],
  ): OptimizationResult {
    const evaluations: CapitalEvaluation[] = [];

    for (const capitalUsdc of capitals) {
      // Create a new config with this capital level (keep everything else the same)
      const config: SimulatorConfig = {
        ...this.baseConfig,
        capitalUsdc,
      };

      // Create a new simulator for this capital level
      const simulator = new FundingArbSimulator(config, this.costModel, this.liquidationModel);

      // Run the simulation
      const result = simulator.simulate(coin, fundingRates, prices);

      // Extract metrics from simulation result
      const { netPnl, alpha, maxDrawdownBps, liquidationCount } = result;

      // Evaluate the three viability criteria
      const edgePositive = alpha > (capitalUsdc * this.holguraBps / BPS_DIVISOR);
      const noLiquidations = liquidationCount === 0;
      const drawdownAcceptable = maxDrawdownBps < this.maxDrawdownBps;

      // All three must pass for viability
      const viable = edgePositive && noLiquidations && drawdownAcceptable;

      evaluations.push({
        capitalUsdc,
        netPnl,
        alpha,
        maxDrawdownBps,
        liquidationCount,
        edgePositive,
        noLiquidations,
        drawdownAcceptable,
        viable,
      });
    }

    // Find minimum viable capital (smallest capital that passes all criteria)
    const viableEvaluations = evaluations.filter(e => e.viable);
    let minimumViableCapital: bigint | null = null;

    if (viableEvaluations.length > 0) {
      minimumViableCapital = viableEvaluations.reduce(
        (min, e) => e.capitalUsdc < min ? e.capitalUsdc : min,
        viableEvaluations[0]!.capitalUsdc,
      );
    }

    // Overall verdict: VIABLE if any capital passes, UNVIABLE otherwise
    const overallVerdict: 'VIABLE' | 'UNVIABLE' = minimumViableCapital !== null
      ? 'VIABLE'
      : 'UNVIABLE';

    return {
      evaluations,
      minimumViableCapital,
      overallVerdict,
    };
  }
}

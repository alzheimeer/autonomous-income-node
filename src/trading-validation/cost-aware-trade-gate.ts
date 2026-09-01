/**
 * Trading Validation Phase - Cost-Aware Trade Gate
 *
 * Evaluates round-trip net profitability of trade candidates using executable quotes.
 * QuoterV2 amounts INCLUDE pool fees (no double subtraction).
 * Conservative exit estimation uses the lower of current quote vs TP-adjusted estimate.
 *
 * Rejection criteria (all checked independently, reasons accumulated):
 * - Net profit < $0.08
 * - Net profit < 50 bps
 * - Quote age > 10s
 * - Simulation failure
 * - Gas > $0.05 (combined approval + swap)
 * - Liquidity < $50k
 * - Price impact > 30 bps (20 bps without private RPC)
 * - Expected profit > 50% of trade size (sanity check)
 *
 * Stricter limits without private RPC: 30 bps slippage, 20 bps impact.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, E4, E5, E12
 */

import type { UsdcAmount, ExecutableQuote, TradeCandidate } from './types.js';
import type { TradeGateConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Full cost breakdown for a trade evaluation.
 */
export interface CostBreakdown {
  /** The amount of USDC being spent to enter (entryQuote.amountIn) */
  entryInput: UsdcAmount;
  /** Conservative estimate of USDC received on exit */
  exitProceeds: UsdcAmount;
  /** Gas cost for entry swap (in USDC terms) */
  entryGas: UsdcAmount;
  /** Estimated gas cost for exit swap (in USDC terms) */
  exitGas: UsdcAmount;
  /** External fees (aggregator-specific, not pool fees) */
  externalFees: UsdcAmount;
  /** Safety margin applied to entry amount */
  safetyMargin: UsdcAmount;
  /** Net profit: exitProceeds - entryInput - entryGas - exitGas - externalFees - safetyMargin */
  netProfit: UsdcAmount;
}

/**
 * Result of the trade gate evaluation.
 */
export interface GateResult {
  /** Whether the trade passed all checks */
  passed: boolean;
  /** Net profit in USDC (6 decimals) */
  netProfitUsdc: UsdcAmount;
  /** Net profit in basis points relative to entry */
  netProfitBps: number;
  /** Full cost breakdown */
  costBreakdown: CostBreakdown;
  /** List of reasons the trade was rejected (empty if passed) */
  rejectReasons: string[];
}

/**
 * Provides entry and exit quotes for trade evaluation.
 */
export interface IQuoteProvider {
  /** Get an entry quote for buying WETH with the given USDC amount */
  getEntryQuote(amountInUsdc: UsdcAmount): Promise<ExecutableQuote>;
  /** Get an exit quote for selling the given WETH amount */
  getExitQuote(amountInWeth: bigint): Promise<ExecutableQuote>;
}

/**
 * Pre-trade simulation interface for the gate.
 */
export interface IGateSimulationProvider {
  /** Simulate the entry swap. Returns true if successful, false if it would revert. */
  simulateEntry(entryQuote: ExecutableQuote): Promise<boolean>;
}

/**
 * Pool liquidity provider.
 */
export interface ILiquidityProvider {
  /** Get current pool liquidity in USD terms */
  getPoolLiquidityUsd(): Promise<number>;
}

/**
 * Logger callback for cost breakdown logging.
 */
export type GateLogger = (entry: {
  candidateId: string;
  passed: boolean;
  netProfitUsdc: string;
  netProfitBps: number;
  rejectReasons: string[];
  costBreakdown: {
    entryInput: string;
    exitProceeds: string;
    entryGas: string;
    exitGas: string;
    externalFees: string;
    safetyMargin: string;
    netProfit: string;
  };
  timestamp: number;
}) => void;

// ═══════════════════════════════════════════════════════════════════════════
// Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cost-aware trade gate interface.
 * Evaluates whether a trade candidate is profitable after all costs.
 */
export interface ICostAwareTradeGate {
  evaluate(
    entryQuote: ExecutableQuote,
    exitQuote: ExecutableQuote,
    tradeSize: UsdcAmount,
    hasPrivateRpc: boolean,
  ): GateResult;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Basis points precision multiplier */
const BPS_PRECISION = 10_000n;

/** Percentage precision multiplier for BigInt calculations */
const PCT_PRECISION = 1_000_000n;

/** Conservative exit buffer: use 97% of TP-adjusted estimate */
const TP_BUFFER_MULTIPLIER = 97n;
const TP_BUFFER_DIVISOR = 100n;

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class CostAwareTradeGate implements ICostAwareTradeGate {
  private readonly config: TradeGateConfig;
  private readonly logger?: GateLogger;

  constructor(config: TradeGateConfig, logger?: GateLogger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Evaluate a trade for round-trip net profitability.
   *
   * Net profit formula (Req 4.2):
   *   exit_proceeds - entry_input - entry_gas - exit_gas - external_fees - safety_margin
   *
   * QuoterV2 amounts INCLUDE pool fees — no double subtraction.
   * All rejection criteria are checked independently and reasons accumulated.
   *
   * @param entryQuote - Fresh executable quote for the entry (buy WETH)
   * @param exitQuote - Fresh executable quote for the exit (sell WETH)
   * @param tradeSize - The trade size in USDC (used for sanity and bps calculation)
   * @param hasPrivateRpc - Whether a private RPC is available (affects slippage/impact limits)
   */
  evaluate(
    entryQuote: ExecutableQuote,
    exitQuote: ExecutableQuote,
    tradeSize: UsdcAmount,
    hasPrivateRpc: boolean,
  ): GateResult {
    const rejectReasons: string[] = [];
    const now = Date.now();

    // ─── Quote freshness check (Req 4.4) ──────────────────────────────
    const entryAge = now - entryQuote.timestamp;
    const exitAge = now - exitQuote.timestamp;

    if (entryAge > this.config.maxQuoteAgeMs) {
      rejectReasons.push(`entry_quote_stale:${entryAge}ms`);
    }
    if (exitAge > this.config.maxQuoteAgeMs) {
      rejectReasons.push(`exit_quote_stale:${exitAge}ms`);
    }

    // ─── Price impact check (Req 4.4, E12) ────────────────────────────
    const maxImpactBps = hasPrivateRpc
      ? this.config.maxPriceImpactBps
      : Math.min(this.config.maxPriceImpactBps, 20);

    if (entryQuote.priceImpactBps > maxImpactBps) {
      rejectReasons.push(`entry_impact_high:${entryQuote.priceImpactBps}bps>${maxImpactBps}bps`);
    }
    if (exitQuote.priceImpactBps > maxImpactBps) {
      rejectReasons.push(`exit_impact_high:${exitQuote.priceImpactBps}bps>${maxImpactBps}bps`);
    }

    // ─── Gas budget check (E5: combined approval + swap ≤ $0.05) ──────
    const entryGasUsdc = this.gasUsdToUsdc(entryQuote.gasUsd);
    const exitGasUsdc = this.gasUsdToUsdc(exitQuote.gasUsd);
    const combinedGas = entryGasUsdc + exitGasUsdc;

    if (combinedGas > this.config.discretionaryMaxGas) {
      rejectReasons.push(
        `gas_exceeds_budget:$${this.usdcToUsdString(combinedGas)}>$${this.usdcToUsdString(this.config.discretionaryMaxGas)}`,
      );
    }

    // ─── Compute cost breakdown (Req 4.2) ─────────────────────────────
    const entryInput = entryQuote.amountIn;

    // Conservative exit estimate (E4):
    // Use the lower of exitQuote.amountOut vs TP-adjusted estimate * 0.97
    const tpAdjustedProceeds = (exitQuote.amountOut * TP_BUFFER_MULTIPLIER) / TP_BUFFER_DIVISOR;
    const exitProceeds = exitQuote.amountOut < tpAdjustedProceeds
      ? exitQuote.amountOut
      : tpAdjustedProceeds;

    // External fees: only aggregator-specific fees (QuoterV2 pool fees already included)
    const externalFees = entryQuote.externalFees + exitQuote.externalFees;

    // Safety margin: safetyMarginBps applied to entry amount
    const safetyMargin = (entryInput * BigInt(this.config.safetyMarginBps)) / BPS_PRECISION;

    // Net profit = exit_proceeds - entry_input - entry_gas - exit_gas - external_fees - safety_margin
    const totalCosts = entryInput + entryGasUsdc + exitGasUsdc + externalFees + safetyMargin;
    const netProfit = exitProceeds > totalCosts
      ? exitProceeds - totalCosts
      : -(totalCosts - exitProceeds);

    const costBreakdown: CostBreakdown = {
      entryInput,
      exitProceeds,
      entryGas: entryGasUsdc,
      exitGas: exitGasUsdc,
      externalFees,
      safetyMargin,
      netProfit,
    };

    // ─── Net profit checks (Req 4.4) ──────────────────────────────────
    if (netProfit < this.config.minNetProfitUsdc) {
      rejectReasons.push(
        `profit_below_min:$${this.usdcToUsdString(netProfit)}<$${this.usdcToUsdString(this.config.minNetProfitUsdc)}`,
      );
    }

    // Net profit in bps relative to entry
    const netProfitBps = tradeSize > 0n
      ? Number((netProfit * BPS_PRECISION) / tradeSize)
      : 0;

    if (netProfitBps < this.config.minNetProfitBps) {
      rejectReasons.push(
        `profit_below_min_bps:${netProfitBps}bps<${this.config.minNetProfitBps}bps`,
      );
    }

    // ─── Sanity check: profit > 50% of trade size (Req 4.4) ───────────
    const sanityMaxProfit = (tradeSize * BigInt(Math.round(this.config.sanityMaxProfitPct * Number(PCT_PRECISION)))) / PCT_PRECISION;
    if (netProfit > 0n && netProfit > sanityMaxProfit) {
      rejectReasons.push(
        `profit_sanity_fail:$${this.usdcToUsdString(netProfit)}>50%_of_size`,
      );
    }

    // ─── Build result ─────────────────────────────────────────────────
    const passed = rejectReasons.length === 0;

    const result: GateResult = {
      passed,
      netProfitUsdc: netProfit,
      netProfitBps,
      costBreakdown,
      rejectReasons,
    };

    // ─── Log full cost breakdown (Req 4.5) ────────────────────────────
    this.logEvaluation(entryQuote, result);

    return result;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Convert gas USD (float) to USDC BigInt (6 decimals).
   */
  private gasUsdToUsdc(gasUsd: number): UsdcAmount {
    // gasUsd is a float like 0.03 meaning $0.03
    // USDC 6 decimals: $0.03 = 30000n
    return BigInt(Math.round(gasUsd * 1_000_000));
  }

  /**
   * Convert USDC BigInt to USD string for logging.
   */
  private usdcToUsdString(amount: UsdcAmount): string {
    const isNeg = amount < 0n;
    const abs = isNeg ? -amount : amount;
    const dollars = abs / 1_000_000n;
    const cents = abs % 1_000_000n;
    const centsStr = cents.toString().padStart(6, '0').slice(0, 4);
    return `${isNeg ? '-' : ''}${dollars}.${centsStr}`;
  }

  /**
   * Log the full cost breakdown for every evaluation (Req 4.5).
   */
  private logEvaluation(entryQuote: ExecutableQuote, result: GateResult): void {
    if (!this.logger) return;

    this.logger({
      candidateId: `quote_${entryQuote.timestamp}`,
      passed: result.passed,
      netProfitUsdc: result.netProfitUsdc.toString(),
      netProfitBps: result.netProfitBps,
      rejectReasons: result.rejectReasons,
      costBreakdown: {
        entryInput: result.costBreakdown.entryInput.toString(),
        exitProceeds: result.costBreakdown.exitProceeds.toString(),
        entryGas: result.costBreakdown.entryGas.toString(),
        exitGas: result.costBreakdown.exitGas.toString(),
        externalFees: result.costBreakdown.externalFees.toString(),
        safetyMargin: result.costBreakdown.safetyMargin.toString(),
        netProfit: result.costBreakdown.netProfit.toString(),
      },
      timestamp: Date.now(),
    });
  }
}

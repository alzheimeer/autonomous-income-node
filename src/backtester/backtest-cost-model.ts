/**
 * BacktestCostModel — Deterministic transaction cost model for backtesting.
 *
 * All arithmetic uses BigInt (6-decimal USDC precision) to avoid floating-point errors.
 * Same inputs always produce same outputs (no randomness).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CostParams {
  gasPerTxUsdc: bigint;      // $0.01 = 10_000n (6 decimals)
  slippageBps: bigint;       // 30n
  dexFeeBps: bigint;         // 5n
  safetyMarginBps: bigint;   // 20n
}

export interface BacktestCostBreakdown {
  entrySlippage: bigint;
  exitSlippage: bigint;
  entryDexFee: bigint;
  exitDexFee: bigint;
  safetyMargin: bigint;
  entryGas: bigint;
  exitGas: bigint;
  totalCost: bigint;
}

export const DEFAULT_COST_PARAMS: CostParams = {
  gasPerTxUsdc: 10_000n,      // $0.01
  slippageBps: 30n,
  dexFeeBps: 5n,
  safetyMarginBps: 20n,
};

// ═══════════════════════════════════════════════════════════════════════════
// BacktestCostModel
// ═══════════════════════════════════════════════════════════════════════════

export class BacktestCostModel {
  private readonly params: CostParams;

  constructor(params: CostParams = DEFAULT_COST_PARAMS) {
    this.params = params;
  }

  /** Compute total round-trip cost for a trade. All BigInt arithmetic. */
  computeRoundTripCost(sizeUsdc: bigint): BacktestCostBreakdown {
    const BPS = 10_000n;

    const entrySlippage = sizeUsdc * this.params.slippageBps / BPS;
    const exitSlippage = sizeUsdc * this.params.slippageBps / BPS;
    const entryDexFee = sizeUsdc * this.params.dexFeeBps / BPS;
    const exitDexFee = sizeUsdc * this.params.dexFeeBps / BPS;
    const safetyMargin = sizeUsdc * this.params.safetyMarginBps / BPS;
    const entryGas = this.params.gasPerTxUsdc;
    const exitGas = this.params.gasPerTxUsdc;

    const totalCost = entrySlippage + exitSlippage + entryDexFee + exitDexFee
                    + safetyMargin + entryGas + exitGas;

    return {
      entrySlippage, exitSlippage, entryDexFee, exitDexFee,
      safetyMargin, entryGas, exitGas, totalCost,
    };
  }

  /** Compute net P&L for a completed trade */
  computeNetPnl(entryPrice: number, exitPrice: number, sizeUsdc: bigint): bigint {
    // Convert prices to 6-decimal BigInt
    const entryPriceBig = BigInt(Math.round(entryPrice * 1_000_000));
    const exitPriceBig = BigInt(Math.round(exitPrice * 1_000_000));

    // Avoid division by zero
    if (entryPriceBig === 0n) return 0n;

    // exit_value = size * exit_price / entry_price
    const exitValue = sizeUsdc * exitPriceBig / entryPriceBig;

    const costs = this.computeRoundTripCost(sizeUsdc);
    return exitValue - sizeUsdc - costs.totalCost;
  }

  getParams(): CostParams {
    return { ...this.params };
  }
}

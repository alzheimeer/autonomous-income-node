/**
 * Funding Arbitrage Cost Model
 *
 * Computes all transaction costs for the delta-neutral funding rate arbitrage strategy.
 * All arithmetic uses BigInt (6-decimal USDC precision: 1_000_000n = $1.00).
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

/** BPS_DIVISOR: 1 basis point = 1/10_000 */
const BPS_DIVISOR = 10_000n;

// ─── Interfaces ────────────────────────────────────────────────────────────────

export interface CostScenario {
  name: 'optimistic' | 'pessimistic';
  bridgeCostUsdc: bigint;       // Fixed bridge cost in 6-decimal USDC
  dexFeeBps: bigint;            // DEX swap fee in basis points
  slippageBps: bigint;          // DEX slippage in basis points
  perpTakerFeeBps: bigint;      // Perp taker fee numerator (divide by 100_000 for 0.035%)
  gasPerTxUsdc: bigint;         // Gas cost per transaction in 6-decimal USDC
  rebalanceFraction: bigint;    // Fraction of round-trip cost for rebalance (out of 100)
}

export interface OpenPositionCosts {
  bridgeFee: bigint;
  dexFee: bigint;
  slippage: bigint;
  perpFee: bigint;
  gas: bigint;
  total: bigint;
}

export interface ClosePositionCosts {
  dexFee: bigint;
  slippage: bigint;
  perpFee: bigint;
  gas: bigint;
  total: bigint;
}

export interface RebalanceCosts {
  cost: bigint;
}

// ─── Cost Scenario Presets ─────────────────────────────────────────────────────

export const OPTIMISTIC_SCENARIO: CostScenario = {
  name: 'optimistic',
  bridgeCostUsdc: 1_000_000n,    // $1
  dexFeeBps: 5n,
  slippageBps: 20n,
  perpTakerFeeBps: 35n,
  gasPerTxUsdc: 10_000n,         // $0.01
  rebalanceFraction: 25n,
};

export const PESSIMISTIC_SCENARIO: CostScenario = {
  name: 'pessimistic',
  bridgeCostUsdc: 5_000_000n,    // $5
  dexFeeBps: 5n,
  slippageBps: 30n,
  perpTakerFeeBps: 35n,
  gasPerTxUsdc: 10_000n,         // $0.01
  rebalanceFraction: 25n,
};

// ─── Cost Model Class ──────────────────────────────────────────────────────────

export class FundingArbCostModel {
  private readonly scenario: CostScenario;

  constructor(scenario: CostScenario) {
    this.scenario = scenario;
  }

  /**
   * Compute all costs for opening a delta-neutral position.
   * Components: bridge + dex_fee + slippage + perp_fee + gas (2 txs)
   */
  computeOpenCosts(positionSizeUsdc: bigint): OpenPositionCosts {
    const bridgeFee = this.scenario.bridgeCostUsdc;
    const dexFee = positionSizeUsdc * this.scenario.dexFeeBps / BPS_DIVISOR;
    const slippage = positionSizeUsdc * this.scenario.slippageBps / BPS_DIVISOR;
    const perpFee = positionSizeUsdc * this.scenario.perpTakerFeeBps / 100_000n;
    const gas = this.scenario.gasPerTxUsdc * 2n;

    const total = bridgeFee + dexFee + slippage + perpFee + gas;

    return { bridgeFee, dexFee, slippage, perpFee, gas, total };
  }

  /**
   * Compute all costs for closing a delta-neutral position.
   * Components: dex_fee + slippage + perp_fee + gas (2 txs)
   * No bridge fee on close.
   */
  computeCloseCosts(positionSizeUsdc: bigint): ClosePositionCosts {
    const dexFee = positionSizeUsdc * this.scenario.dexFeeBps / BPS_DIVISOR;
    const slippage = positionSizeUsdc * this.scenario.slippageBps / BPS_DIVISOR;
    const perpFee = positionSizeUsdc * this.scenario.perpTakerFeeBps / 100_000n;
    const gas = this.scenario.gasPerTxUsdc * 2n;

    const total = dexFee + slippage + perpFee + gas;

    return { dexFee, slippage, perpFee, gas, total };
  }

  /**
   * Compute rebalance cost as a fraction of the round-trip cost.
   * rebalance = roundTripCost * rebalanceFraction / 100n
   */
  computeRebalanceCost(positionSizeUsdc: bigint): RebalanceCosts {
    const roundTrip = this.computeRoundTripCost(positionSizeUsdc);
    const cost = roundTrip * this.scenario.rebalanceFraction / 100n;

    return { cost };
  }

  /**
   * Total round-trip cost (open + close).
   */
  computeRoundTripCost(positionSizeUsdc: bigint): bigint {
    const openCosts = this.computeOpenCosts(positionSizeUsdc);
    const closeCosts = this.computeCloseCosts(positionSizeUsdc);

    return openCosts.total + closeCosts.total;
  }
}

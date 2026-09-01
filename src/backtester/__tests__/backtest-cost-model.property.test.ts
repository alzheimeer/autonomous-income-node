/**
 * Property Tests for BacktestCostModel
 *
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4**
 *
 * Property 11: Cost Model Determinism and Arithmetic Correctness
 * - Generate trade sizes in [5_000_000n, 10_000_000n] (USDC with 6 decimals)
 * - Verify totalCost formula: `2*(size*30/10000) + 2*(size*5/10000) + (size*20/10000) + 2*10000n`
 * - Verify computeNetPnl arithmetic
 * - Verify determinism: same inputs → same outputs
 *
 * Uses fast-check for property-based testing with vitest.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  BacktestCostModel,
  DEFAULT_COST_PARAMS,
  type CostParams,
} from '../backtest-cost-model.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Minimum trade size: $5 = 5_000_000n (6 decimals) */
const MIN_SIZE_USDC = 5_000_000n;

/** Maximum trade size: $10 = 10_000_000n (6 decimals) */
const MAX_SIZE_USDC = 10_000_000n;

/** BPS denominator for percentage calculations */
const BPS = 10_000n;

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arbitrary for trade sizes in the valid range [5_000_000n, 10_000_000n].
 * Uses integer arbitrary and converts to BigInt.
 */
const arbTradeSizeUsdc = fc.integer({ min: 5_000_000, max: 10_000_000 }).map(BigInt);

/**
 * Arbitrary for realistic ETH prices in USD (1000-5000 range).
 */
const arbEthPrice = fc.double({ min: 1000, max: 5000, noNaN: true, noDefaultInfinity: true });

/**
 * Arbitrary for price pairs (entry and exit) where both are valid ETH prices.
 */
const arbPricePair = fc.record({
  entryPrice: arbEthPrice,
  exitPrice: arbEthPrice,
}).filter(({ entryPrice }) => entryPrice > 0); // Filter out zero entry price (division by zero)

/**
 * Arbitrary for a complete trade scenario with size and prices.
 */
const arbTradeScenario = fc.record({
  sizeUsdc: arbTradeSizeUsdc,
  entryPrice: arbEthPrice.filter(p => p > 0),
  exitPrice: arbEthPrice,
});

/**
 * Arbitrary for custom cost params with reasonable ranges.
 */
const arbCostParams = fc.record({
  gasPerTxUsdc: fc.integer({ min: 1000, max: 100_000 }).map(BigInt),
  slippageBps: fc.integer({ min: 1, max: 100 }).map(BigInt),
  dexFeeBps: fc.integer({ min: 1, max: 50 }).map(BigInt),
  safetyMarginBps: fc.integer({ min: 1, max: 50 }).map(BigInt),
});

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute expected total cost using the exact formula from requirements.
 * Formula: 2*(size*30/10000) + 2*(size*5/10000) + (size*20/10000) + 2*10000n
 *
 * With DEFAULT_COST_PARAMS:
 * - slippageBps = 30n
 * - dexFeeBps = 5n
 * - safetyMarginBps = 20n
 * - gasPerTxUsdc = 10_000n
 */
function computeExpectedTotalCost(sizeUsdc: bigint, params: CostParams = DEFAULT_COST_PARAMS): bigint {
  const slippage = 2n * (sizeUsdc * params.slippageBps / BPS);
  const dexFee = 2n * (sizeUsdc * params.dexFeeBps / BPS);
  const safetyMargin = sizeUsdc * params.safetyMarginBps / BPS;
  const gas = 2n * params.gasPerTxUsdc;

  return slippage + dexFee + safetyMargin + gas;
}

/**
 * Compute expected net PnL using the formula from requirements.
 * Formula: exit_value - entry_value - totalCost
 * Where exit_value = sizeUsdc * exitPrice / entryPrice
 */
function computeExpectedNetPnl(
  entryPrice: number,
  exitPrice: number,
  sizeUsdc: bigint,
  params: CostParams = DEFAULT_COST_PARAMS,
): bigint {
  // Convert prices to 6-decimal BigInt (same as implementation)
  const entryPriceBig = BigInt(Math.round(entryPrice * 1_000_000));
  const exitPriceBig = BigInt(Math.round(exitPrice * 1_000_000));

  // Avoid division by zero
  if (entryPriceBig === 0n) return 0n;

  // exit_value = size * exit_price / entry_price
  const exitValue = sizeUsdc * exitPriceBig / entryPriceBig;

  // Total cost
  const totalCost = computeExpectedTotalCost(sizeUsdc, params);

  // Net PnL = exit_value - entry_value - costs
  return exitValue - sizeUsdc - totalCost;
}

// ═══════════════════════════════════════════════════════════════════════════
// Property 11: Cost Model Determinism and Arithmetic Correctness
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 11: Cost Model Determinism and Arithmetic Correctness', () => {
  const model = new BacktestCostModel(DEFAULT_COST_PARAMS);

  // ─────────────────────────────────────────────────────────────────────────
  // P11-a: Total Cost Formula Correctness
  // ─────────────────────────────────────────────────────────────────────────

  describe('P11-a: Total Cost Formula Correctness', () => {
    /**
     * P11-a-1: totalCost matches expected formula for all valid trade sizes.
     * **Validates: Requirements 10.1, 10.2, 10.3**
     */
    it('totalCost matches formula: 2*(size*30/10000) + 2*(size*5/10000) + (size*20/10000) + 2*10000n', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, (sizeUsdc) => {
          const result = model.computeRoundTripCost(sizeUsdc);
          const expectedTotal = computeExpectedTotalCost(sizeUsdc);

          expect(result.totalCost).toBe(expectedTotal);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-a-2: Individual cost components match their formulas.
     * **Validates: Requirements 10.1**
     */
    it('individual cost components match their formulas', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, (sizeUsdc) => {
          const result = model.computeRoundTripCost(sizeUsdc);

          // Slippage: size * 30 / 10000 per side
          const expectedSlippage = sizeUsdc * 30n / BPS;
          expect(result.entrySlippage).toBe(expectedSlippage);
          expect(result.exitSlippage).toBe(expectedSlippage);

          // DEX fee: size * 5 / 10000 per side
          const expectedDexFee = sizeUsdc * 5n / BPS;
          expect(result.entryDexFee).toBe(expectedDexFee);
          expect(result.exitDexFee).toBe(expectedDexFee);

          // Safety margin: size * 20 / 10000
          const expectedSafetyMargin = sizeUsdc * 20n / BPS;
          expect(result.safetyMargin).toBe(expectedSafetyMargin);

          // Gas: fixed $0.01 per tx
          expect(result.entryGas).toBe(10_000n);
          expect(result.exitGas).toBe(10_000n);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-a-3: totalCost equals sum of all individual components.
     * **Validates: Requirements 10.1**
     */
    it('totalCost equals sum of all individual components', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, (sizeUsdc) => {
          const result = model.computeRoundTripCost(sizeUsdc);

          const sumOfComponents =
            result.entrySlippage +
            result.exitSlippage +
            result.entryDexFee +
            result.exitDexFee +
            result.safetyMargin +
            result.entryGas +
            result.exitGas;

          expect(result.totalCost).toBe(sumOfComponents);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-a-4: Cost formula works with custom params.
     * **Validates: Requirements 10.1**
     */
    it('cost formula works correctly with custom params', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, arbCostParams, (sizeUsdc, params) => {
          const customModel = new BacktestCostModel(params);
          const result = customModel.computeRoundTripCost(sizeUsdc);
          const expectedTotal = computeExpectedTotalCost(sizeUsdc, params);

          expect(result.totalCost).toBe(expectedTotal);
        }),
        { numRuns: 50 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P11-b: computeNetPnl Arithmetic Correctness
  // ─────────────────────────────────────────────────────────────────────────

  describe('P11-b: computeNetPnl Arithmetic Correctness', () => {
    /**
     * P11-b-1: Net PnL matches expected formula for all trade scenarios.
     * **Validates: Requirements 10.3**
     */
    it('net PnL matches formula: exitValue - entryValue - totalCost', () => {
      fc.assert(
        fc.property(arbTradeScenario, ({ sizeUsdc, entryPrice, exitPrice }) => {
          const actualPnl = model.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
          const expectedPnl = computeExpectedNetPnl(entryPrice, exitPrice, sizeUsdc);

          expect(actualPnl).toBe(expectedPnl);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-b-2: Breakeven trade (same price) results in negative PnL equal to costs.
     * **Validates: Requirements 10.3**
     */
    it('breakeven trade (same price) results in PnL equal to negative total cost', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, arbEthPrice.filter(p => p > 0), (sizeUsdc, price) => {
          const pnl = model.computeNetPnl(price, price, sizeUsdc);
          const costs = model.computeRoundTripCost(sizeUsdc);

          // When entry price equals exit price, net PnL should be exactly -totalCost
          expect(pnl).toBe(-costs.totalCost);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-b-3: Profitable trade (price up) results in higher PnL than breakeven.
     * **Validates: Requirements 10.3**
     */
    it('profitable trade (price up) results in higher PnL than breakeven', () => {
      fc.assert(
        fc.property(
          arbTradeSizeUsdc,
          fc.double({ min: 1000, max: 4000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0.01, max: 0.20, noNaN: true }), // 1% to 20% gain
          (sizeUsdc, entryPrice, gainPct) => {
            const exitPrice = entryPrice * (1 + gainPct);
            const pnl = model.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
            const breakevenPnl = model.computeNetPnl(entryPrice, entryPrice, sizeUsdc);

            // Profitable trade should have higher PnL than breakeven
            expect(pnl > breakevenPnl).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * P11-b-4: Losing trade (price down) results in lower PnL than breakeven.
     * **Validates: Requirements 10.3**
     */
    it('losing trade (price down) results in lower PnL than breakeven', () => {
      fc.assert(
        fc.property(
          arbTradeSizeUsdc,
          fc.double({ min: 1000, max: 4000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0.01, max: 0.20, noNaN: true }), // 1% to 20% loss
          (sizeUsdc, entryPrice, lossPct) => {
            const exitPrice = entryPrice * (1 - lossPct);
            const pnl = model.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
            const breakevenPnl = model.computeNetPnl(entryPrice, entryPrice, sizeUsdc);

            // Losing trade should have lower PnL than breakeven
            expect(pnl < breakevenPnl).toBe(true);
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * P11-b-5: PnL is monotonic with exit price (higher exit → higher PnL).
     * **Validates: Requirements 10.3**
     */
    it('PnL is monotonic with exit price (higher exit → higher PnL)', () => {
      fc.assert(
        fc.property(
          arbTradeSizeUsdc,
          fc.double({ min: 1000, max: 4000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 1000, max: 4000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 1000, max: 4000, noNaN: true, noDefaultInfinity: true }),
          (sizeUsdc, entryPrice, exitPrice1, exitPrice2) => {
            const pnl1 = model.computeNetPnl(entryPrice, exitPrice1, sizeUsdc);
            const pnl2 = model.computeNetPnl(entryPrice, exitPrice2, sizeUsdc);

            if (exitPrice1 < exitPrice2) {
              expect(pnl1 <= pnl2).toBe(true);
            } else if (exitPrice1 > exitPrice2) {
              expect(pnl1 >= pnl2).toBe(true);
            } else {
              expect(pnl1).toBe(pnl2);
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P11-c: Determinism (Same Inputs → Same Outputs)
  // ─────────────────────────────────────────────────────────────────────────

  describe('P11-c: Determinism (Same Inputs → Same Outputs)', () => {
    /**
     * P11-c-1: computeRoundTripCost is deterministic.
     * **Validates: Requirements 10.2**
     */
    it('computeRoundTripCost is deterministic', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, (sizeUsdc) => {
          const result1 = model.computeRoundTripCost(sizeUsdc);
          const result2 = model.computeRoundTripCost(sizeUsdc);

          expect(result1).toEqual(result2);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-c-2: computeNetPnl is deterministic.
     * **Validates: Requirements 10.2**
     */
    it('computeNetPnl is deterministic', () => {
      fc.assert(
        fc.property(arbTradeScenario, ({ sizeUsdc, entryPrice, exitPrice }) => {
          const pnl1 = model.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
          const pnl2 = model.computeNetPnl(entryPrice, exitPrice, sizeUsdc);

          expect(pnl1).toBe(pnl2);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-c-3: Different model instances with same params produce same results.
     * **Validates: Requirements 10.2**
     */
    it('different model instances with same params produce same results', () => {
      fc.assert(
        fc.property(arbTradeScenario, ({ sizeUsdc, entryPrice, exitPrice }) => {
          const model1 = new BacktestCostModel(DEFAULT_COST_PARAMS);
          const model2 = new BacktestCostModel(DEFAULT_COST_PARAMS);

          const cost1 = model1.computeRoundTripCost(sizeUsdc);
          const cost2 = model2.computeRoundTripCost(sizeUsdc);
          expect(cost1).toEqual(cost2);

          const pnl1 = model1.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
          const pnl2 = model2.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
          expect(pnl1).toBe(pnl2);
        }),
        { numRuns: 50 },
      );
    });

    /**
     * P11-c-4: Multiple sequential calls produce identical results.
     * **Validates: Requirements 10.2**
     */
    it('multiple sequential calls produce identical results', () => {
      fc.assert(
        fc.property(
          arbTradeSizeUsdc,
          fc.integer({ min: 2, max: 10 }),
          (sizeUsdc, numCalls) => {
            const results = Array.from({ length: numCalls }, () =>
              model.computeRoundTripCost(sizeUsdc),
            );

            // All results should be identical
            const first = results[0];
            for (const result of results) {
              expect(result).toEqual(first);
            }
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P11-d: BigInt Arithmetic Correctness
  // ─────────────────────────────────────────────────────────────────────────

  describe('P11-d: BigInt Arithmetic Correctness', () => {
    /**
     * P11-d-1: All return values are BigInt.
     * **Validates: Requirements 10.4**
     */
    it('all cost values are BigInt', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, (sizeUsdc) => {
          const result = model.computeRoundTripCost(sizeUsdc);

          expect(typeof result.entrySlippage).toBe('bigint');
          expect(typeof result.exitSlippage).toBe('bigint');
          expect(typeof result.entryDexFee).toBe('bigint');
          expect(typeof result.exitDexFee).toBe('bigint');
          expect(typeof result.safetyMargin).toBe('bigint');
          expect(typeof result.entryGas).toBe('bigint');
          expect(typeof result.exitGas).toBe('bigint');
          expect(typeof result.totalCost).toBe('bigint');
        }),
        { numRuns: 50 },
      );
    });

    /**
     * P11-d-2: Net PnL is always BigInt.
     * **Validates: Requirements 10.4**
     */
    it('net PnL is always BigInt', () => {
      fc.assert(
        fc.property(arbTradeScenario, ({ sizeUsdc, entryPrice, exitPrice }) => {
          const pnl = model.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
          expect(typeof pnl).toBe('bigint');
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-d-3: Cost values are non-negative.
     * **Validates: Requirements 10.4**
     */
    it('cost values are non-negative', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, (sizeUsdc) => {
          const result = model.computeRoundTripCost(sizeUsdc);

          expect(result.entrySlippage >= 0n).toBe(true);
          expect(result.exitSlippage >= 0n).toBe(true);
          expect(result.entryDexFee >= 0n).toBe(true);
          expect(result.exitDexFee >= 0n).toBe(true);
          expect(result.safetyMargin >= 0n).toBe(true);
          expect(result.entryGas >= 0n).toBe(true);
          expect(result.exitGas >= 0n).toBe(true);
          expect(result.totalCost >= 0n).toBe(true);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-d-4: Gas cost is fixed regardless of trade size.
     * **Validates: Requirements 10.1**
     */
    it('gas cost is fixed regardless of trade size', () => {
      fc.assert(
        fc.property(arbTradeSizeUsdc, (sizeUsdc) => {
          const result = model.computeRoundTripCost(sizeUsdc);

          expect(result.entryGas).toBe(DEFAULT_COST_PARAMS.gasPerTxUsdc);
          expect(result.exitGas).toBe(DEFAULT_COST_PARAMS.gasPerTxUsdc);
        }),
        { numRuns: 100 },
      );
    });

    /**
     * P11-d-5: Proportional costs scale linearly with trade size.
     * **Validates: Requirements 10.2**
     */
    it('proportional costs scale linearly with trade size', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 5_000_000, max: 9_000_000 }).map(BigInt),
          fc.integer({ min: 1, max: 2 }).map(BigInt),
          (baseSize, multiplier) => {
            const scaledSize = baseSize * multiplier;
            // Ensure scaledSize stays within valid range
            if (scaledSize > MAX_SIZE_USDC) return;

            const baseResult = model.computeRoundTripCost(baseSize);
            const scaledResult = model.computeRoundTripCost(scaledSize);

            // Proportional costs should scale with multiplier
            expect(scaledResult.entrySlippage).toBe(baseResult.entrySlippage * multiplier);
            expect(scaledResult.exitSlippage).toBe(baseResult.exitSlippage * multiplier);
            expect(scaledResult.entryDexFee).toBe(baseResult.entryDexFee * multiplier);
            expect(scaledResult.exitDexFee).toBe(baseResult.exitDexFee * multiplier);
            expect(scaledResult.safetyMargin).toBe(baseResult.safetyMargin * multiplier);

            // Gas remains constant
            expect(scaledResult.entryGas).toBe(baseResult.entryGas);
            expect(scaledResult.exitGas).toBe(baseResult.exitGas);
          },
        ),
        { numRuns: 50 },
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // P11-e: Edge Cases
  // ─────────────────────────────────────────────────────────────────────────

  describe('P11-e: Edge Cases', () => {
    /**
     * P11-e-1: Minimum trade size ($5) produces correct costs.
     */
    it('minimum trade size ($5) produces correct costs', () => {
      const result = model.computeRoundTripCost(MIN_SIZE_USDC);
      const expected = computeExpectedTotalCost(MIN_SIZE_USDC);

      expect(result.totalCost).toBe(expected);
      // Manual verification: 2*(5M*30/10k) + 2*(5M*5/10k) + (5M*20/10k) + 2*10k
      // = 2*15000 + 2*2500 + 10000 + 20000 = 30000 + 5000 + 10000 + 20000 = 65000
      expect(result.totalCost).toBe(65_000n);
    });

    /**
     * P11-e-2: Maximum trade size ($10) produces correct costs.
     */
    it('maximum trade size ($10) produces correct costs', () => {
      const result = model.computeRoundTripCost(MAX_SIZE_USDC);
      const expected = computeExpectedTotalCost(MAX_SIZE_USDC);

      expect(result.totalCost).toBe(expected);
      // Manual verification: 2*(10M*30/10k) + 2*(10M*5/10k) + (10M*20/10k) + 2*10k
      // = 2*30000 + 2*5000 + 20000 + 20000 = 60000 + 10000 + 20000 + 20000 = 110000
      expect(result.totalCost).toBe(110_000n);
    });

    /**
     * P11-e-3: Zero entry price returns zero PnL (avoids division by zero).
     */
    it('zero entry price returns zero PnL', () => {
      const pnl = model.computeNetPnl(0, 2000, 10_000_000n);
      expect(pnl).toBe(0n);
    });

    /**
     * P11-e-4: Very small price movements result in net loss (costs dominate).
     */
    it('very small price movements result in net loss (costs dominate)', () => {
      fc.assert(
        fc.property(
          arbTradeSizeUsdc,
          fc.double({ min: 1000, max: 4000, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: 0.00001, max: 0.001, noNaN: true }), // 0.001% to 0.1% change
          (sizeUsdc, entryPrice, changePct) => {
            const exitPriceUp = entryPrice * (1 + changePct);
            const exitPriceDown = entryPrice * (1 - changePct);

            const pnlUp = model.computeNetPnl(entryPrice, exitPriceUp, sizeUsdc);
            const pnlDown = model.computeNetPnl(entryPrice, exitPriceDown, sizeUsdc);

            // For very small price movements, costs should dominate → negative PnL
            // (This depends on the cost model, but with typical params, small moves are losses)
            expect(pnlDown < 0n).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

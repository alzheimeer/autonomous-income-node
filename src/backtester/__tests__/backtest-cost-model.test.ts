/**
 * Unit tests for BacktestCostModel.
 *
 * Covers:
 * - Round-trip cost formula correctness
 * - Net PnL calculation (positive and negative trades)
 * - Determinism (same inputs → same outputs)
 * - BigInt precision (no floating point)
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4
 */

import { describe, it, expect } from 'vitest';
import {
  BacktestCostModel,
  DEFAULT_COST_PARAMS,
  type CostParams,
  type BacktestCostBreakdown,
} from '../backtest-cost-model.js';

describe('BacktestCostModel', () => {
  const model = new BacktestCostModel(DEFAULT_COST_PARAMS);

  describe('computeRoundTripCost', () => {
    it('computes correct breakdown for $10 trade', () => {
      // $10 = 10_000_000n (6 decimals)
      const sizeUsdc = 10_000_000n;
      const result = model.computeRoundTripCost(sizeUsdc);

      // Slippage: 10_000_000 * 30 / 10_000 = 30_000n per side
      expect(result.entrySlippage).toBe(30_000n);
      expect(result.exitSlippage).toBe(30_000n);

      // DEX fee: 10_000_000 * 5 / 10_000 = 5_000n per side
      expect(result.entryDexFee).toBe(5_000n);
      expect(result.exitDexFee).toBe(5_000n);

      // Safety margin: 10_000_000 * 20 / 10_000 = 20_000n
      expect(result.safetyMargin).toBe(20_000n);

      // Gas: 10_000n per tx
      expect(result.entryGas).toBe(10_000n);
      expect(result.exitGas).toBe(10_000n);

      // Total: 30000 + 30000 + 5000 + 5000 + 20000 + 10000 + 10000 = 110_000n
      expect(result.totalCost).toBe(110_000n);
    });

    it('computes correct breakdown for $5 trade (minimum size)', () => {
      const sizeUsdc = 5_000_000n;
      const result = model.computeRoundTripCost(sizeUsdc);

      // Slippage: 5_000_000 * 30 / 10_000 = 15_000n per side
      expect(result.entrySlippage).toBe(15_000n);
      expect(result.exitSlippage).toBe(15_000n);

      // DEX fee: 5_000_000 * 5 / 10_000 = 2_500n per side
      expect(result.entryDexFee).toBe(2_500n);
      expect(result.exitDexFee).toBe(2_500n);

      // Safety margin: 5_000_000 * 20 / 10_000 = 10_000n
      expect(result.safetyMargin).toBe(10_000n);

      // Gas: 10_000n per tx
      expect(result.entryGas).toBe(10_000n);
      expect(result.exitGas).toBe(10_000n);

      // Total: 15000 + 15000 + 2500 + 2500 + 10000 + 10000 + 10000 = 65_000n
      expect(result.totalCost).toBe(65_000n);
    });

    it('totalCost matches sum of all components', () => {
      const sizeUsdc = 7_500_000n;
      const result = model.computeRoundTripCost(sizeUsdc);

      const expectedTotal =
        result.entrySlippage +
        result.exitSlippage +
        result.entryDexFee +
        result.exitDexFee +
        result.safetyMargin +
        result.entryGas +
        result.exitGas;

      expect(result.totalCost).toBe(expectedTotal);
    });

    it('matches the expected formula: 2*(size*30/10000) + 2*(size*5/10000) + (size*20/10000) + 2*10000n', () => {
      const sizeUsdc = 8_000_000n;
      const result = model.computeRoundTripCost(sizeUsdc);

      const expected =
        2n * (sizeUsdc * 30n / 10_000n) +   // slippage (entry + exit)
        2n * (sizeUsdc * 5n / 10_000n) +     // dex fee (entry + exit)
        sizeUsdc * 20n / 10_000n +           // safety margin
        2n * 10_000n;                         // gas (entry + exit)

      expect(result.totalCost).toBe(expected);
    });

    it('handles zero size gracefully', () => {
      const result = model.computeRoundTripCost(0n);

      expect(result.entrySlippage).toBe(0n);
      expect(result.exitSlippage).toBe(0n);
      expect(result.entryDexFee).toBe(0n);
      expect(result.exitDexFee).toBe(0n);
      expect(result.safetyMargin).toBe(0n);
      // Gas is still charged (fixed cost)
      expect(result.entryGas).toBe(10_000n);
      expect(result.exitGas).toBe(10_000n);
      expect(result.totalCost).toBe(20_000n);
    });
  });

  describe('computeNetPnl', () => {
    it('computes positive P&L for profitable trade (price goes up)', () => {
      // Entry at $2000, exit at $2100 (5% gain)
      // Size: $10 = 10_000_000n
      const sizeUsdc = 10_000_000n;
      const pnl = model.computeNetPnl(2000, 2100, sizeUsdc);

      // exitValue = 10_000_000 * 2100_000_000 / 2000_000_000 = 10_500_000n
      // gross pnl = 10_500_000 - 10_000_000 = 500_000n ($0.50)
      // costs = 110_000n (as computed above for $10 trade)
      // net pnl = 500_000 - 110_000 = 390_000n ($0.39)
      expect(pnl).toBe(390_000n);
    });

    it('computes negative P&L for losing trade (price goes down)', () => {
      // Entry at $2000, exit at $1900 (5% loss)
      // Size: $10 = 10_000_000n
      const sizeUsdc = 10_000_000n;
      const pnl = model.computeNetPnl(2000, 1900, sizeUsdc);

      // exitValue = 10_000_000 * 1900_000_000 / 2000_000_000 = 9_500_000n
      // gross pnl = 9_500_000 - 10_000_000 = -500_000n
      // costs = 110_000n
      // net pnl = -500_000 - 110_000 = -610_000n (-$0.61)
      expect(pnl).toBe(-610_000n);
    });

    it('computes near-zero P&L when exit equals entry (only costs)', () => {
      // Same entry and exit price → gross P&L is 0, net is negative (cost only)
      const sizeUsdc = 10_000_000n;
      const pnl = model.computeNetPnl(2000, 2000, sizeUsdc);

      // exitValue = sizeUsdc (same price), net = 0 - costs
      const costs = model.computeRoundTripCost(sizeUsdc);
      expect(pnl).toBe(-costs.totalCost);
    });

    it('handles fractional prices with BigInt precision', () => {
      // Entry at $1523.45, exit at $1530.12
      const sizeUsdc = 7_000_000n; // $7
      const pnl = model.computeNetPnl(1523.45, 1530.12, sizeUsdc);

      // Manual verification:
      const entryPriceBig = BigInt(Math.round(1523.45 * 1_000_000)); // 1_523_450_000n
      const exitPriceBig = BigInt(Math.round(1530.12 * 1_000_000));  // 1_530_120_000n
      const exitValue = sizeUsdc * exitPriceBig / entryPriceBig;
      const costs = model.computeRoundTripCost(sizeUsdc);
      const expectedPnl = exitValue - sizeUsdc - costs.totalCost;

      expect(pnl).toBe(expectedPnl);
    });

    it('handles very small price movements', () => {
      // Entry at $2500.00, exit at $2500.01 (tiny gain)
      const sizeUsdc = 10_000_000n;
      const pnl = model.computeNetPnl(2500.00, 2500.01, sizeUsdc);

      // The gain is negligible, costs dominate → should be negative
      expect(pnl < 0n).toBe(true);
    });
  });

  describe('determinism', () => {
    it('produces identical results for identical inputs (round-trip cost)', () => {
      const sizeUsdc = 10_000_000n;

      const result1 = model.computeRoundTripCost(sizeUsdc);
      const result2 = model.computeRoundTripCost(sizeUsdc);

      expect(result1).toEqual(result2);
    });

    it('produces identical results for identical inputs (net P&L)', () => {
      const entryPrice = 2345.67;
      const exitPrice = 2400.89;
      const sizeUsdc = 8_000_000n;

      const pnl1 = model.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
      const pnl2 = model.computeNetPnl(entryPrice, exitPrice, sizeUsdc);

      expect(pnl1).toBe(pnl2);
    });

    it('two separate model instances with same params produce same results', () => {
      const model1 = new BacktestCostModel(DEFAULT_COST_PARAMS);
      const model2 = new BacktestCostModel(DEFAULT_COST_PARAMS);

      const sizeUsdc = 10_000_000n;
      const cost1 = model1.computeRoundTripCost(sizeUsdc);
      const cost2 = model2.computeRoundTripCost(sizeUsdc);
      expect(cost1).toEqual(cost2);

      const pnl1 = model1.computeNetPnl(2000, 2100, sizeUsdc);
      const pnl2 = model2.computeNetPnl(2000, 2100, sizeUsdc);
      expect(pnl1).toBe(pnl2);
    });
  });

  describe('BigInt precision (no floating point)', () => {
    it('all cost breakdown values are BigInt', () => {
      const result = model.computeRoundTripCost(10_000_000n);

      expect(typeof result.entrySlippage).toBe('bigint');
      expect(typeof result.exitSlippage).toBe('bigint');
      expect(typeof result.entryDexFee).toBe('bigint');
      expect(typeof result.exitDexFee).toBe('bigint');
      expect(typeof result.safetyMargin).toBe('bigint');
      expect(typeof result.entryGas).toBe('bigint');
      expect(typeof result.exitGas).toBe('bigint');
      expect(typeof result.totalCost).toBe('bigint');
    });

    it('net P&L returns BigInt', () => {
      const pnl = model.computeNetPnl(2000, 2100, 10_000_000n);
      expect(typeof pnl).toBe('bigint');
    });

    it('no precision loss for typical trade sizes', () => {
      // Verify that BigInt division doesn't introduce unexpected rounding
      // For $10 trade with 30bps slippage:
      // 10_000_000 * 30 / 10_000 should be exactly 30_000 (no remainder)
      const sizeUsdc = 10_000_000n;
      const slippage = sizeUsdc * 30n / 10_000n;
      expect(slippage).toBe(30_000n);
      expect(slippage * 10_000n / 30n).toBe(sizeUsdc); // Reversible
    });
  });

  describe('custom cost params', () => {
    it('respects custom gas cost', () => {
      const customParams: CostParams = {
        ...DEFAULT_COST_PARAMS,
        gasPerTxUsdc: 50_000n, // $0.05
      };
      const customModel = new BacktestCostModel(customParams);
      const result = customModel.computeRoundTripCost(10_000_000n);

      expect(result.entryGas).toBe(50_000n);
      expect(result.exitGas).toBe(50_000n);
    });

    it('respects custom slippage bps', () => {
      const customParams: CostParams = {
        ...DEFAULT_COST_PARAMS,
        slippageBps: 50n, // 50 bps instead of 30
      };
      const customModel = new BacktestCostModel(customParams);
      const result = customModel.computeRoundTripCost(10_000_000n);

      // 10_000_000 * 50 / 10_000 = 50_000n per side
      expect(result.entrySlippage).toBe(50_000n);
      expect(result.exitSlippage).toBe(50_000n);
    });

    it('uses DEFAULT_COST_PARAMS when no params provided', () => {
      const defaultModel = new BacktestCostModel();
      const result = defaultModel.computeRoundTripCost(10_000_000n);

      // Should match the model constructed with DEFAULT_COST_PARAMS explicitly
      const explicitModel = new BacktestCostModel(DEFAULT_COST_PARAMS);
      const explicitResult = explicitModel.computeRoundTripCost(10_000_000n);

      expect(result).toEqual(explicitResult);
    });
  });
});

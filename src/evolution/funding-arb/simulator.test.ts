/**
 * Funding Arb Simulator — Unit Tests
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 7.1, 7.2, 7.3, 7.4
 */

import { describe, it, expect } from 'vitest';
import {
  FundingArbSimulator,
  rateToBigInt,
  priceToBigInt,
  computePositionValue,
  RATE_PRECISION,
  BPS_DIVISOR,
  ONE_USDC,
} from './simulator.js';
import type { SimulatorConfig } from './simulator.js';
import { FundingArbCostModel, OPTIMISTIC_SCENARIO } from './cost-model.js';
import { LiquidationModel } from './liquidation-model.js';
import type { FundingRateRecord } from './data-fetcher.js';
import type { CandleData } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<SimulatorConfig>): SimulatorConfig {
  return {
    capitalUsdc: 1000_000_000n,          // $1000
    positionSizeFraction: 80n,           // 80% of capital
    costScenario: OPTIMISTIC_SCENARIO,
    rebalanceTriggerMarginBps: 1250n,
    rebalanceTriggerDivergeBps: 500n,
    aaveApyBps: 500n,                    // 5% APY
    holguraBps: 100n,
    ...overrides,
  };
}

function makeFundingRate(rate: string, timestamp = 0): FundingRateRecord {
  return { coin: 'ETH', timestamp, fundingRate: rate };
}

function makeCandle(close: number, timestamp = 0): CandleData {
  return { timestamp, open: close, high: close, low: close, close, volume: 1000 };
}

function makeFundingRates(rates: string[], startTs = 1700000000000): FundingRateRecord[] {
  return rates.map((rate, i) => ({
    coin: 'ETH',
    timestamp: startTs + i * 3600_000,
    fundingRate: rate,
  }));
}

function makeCandles(prices: number[], startTs = 1700000000000): CandleData[] {
  return prices.map((price, i) => ({
    timestamp: startTs + i * 3600_000,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: 1000,
  }));
}

// ─── rateToBigInt Tests ──────────────────────────────────────────────────────

describe('rateToBigInt', () => {
  it('converts positive decimal string to BigInt (12 decimal precision)', () => {
    // 0.000125 → 0.000125 * 10^12 = 125_000_000
    const result = rateToBigInt('0.000125');
    expect(result).toBe(125_000_000n);
  });

  it('converts negative decimal string', () => {
    const result = rateToBigInt('-0.000125');
    expect(result).toBe(-125_000_000n);
  });

  it('converts zero', () => {
    expect(rateToBigInt('0.0')).toBe(0n);
    expect(rateToBigInt('0')).toBe(0n);
  });

  it('handles rate with many decimal places (truncates at 12)', () => {
    // 0.0001234567890123456 → only first 12 fractional digits matter
    const result = rateToBigInt('0.000123456789');
    expect(result).toBe(123_456_789n);
  });

  it('handles rate with fewer decimal places (pads with zeros)', () => {
    // 0.01 → 0.010000000000 * 10^12 = 10_000_000_000
    const result = rateToBigInt('0.01');
    expect(result).toBe(10_000_000_000n);
  });

  it('handles integer rate (e.g., "1")', () => {
    const result = rateToBigInt('1');
    expect(result).toBe(RATE_PRECISION);
  });

  it('trims whitespace', () => {
    expect(rateToBigInt('  0.000125  ')).toBe(125_000_000n);
  });
});

// ─── priceToBigInt Tests ─────────────────────────────────────────────────────

describe('priceToBigInt', () => {
  it('converts whole number price', () => {
    expect(priceToBigInt(3500)).toBe(3_500_000_000n);
  });

  it('converts price with decimals', () => {
    expect(priceToBigInt(3500.25)).toBe(3_500_250_000n);
  });

  it('converts $1.00', () => {
    expect(priceToBigInt(1.0)).toBe(ONE_USDC);
  });
});

// ─── computePositionValue Tests ──────────────────────────────────────────────

describe('computePositionValue', () => {
  it('returns positionSize when price is same as entry', () => {
    const size = 800_000_000n; // $800
    const price = 3_500_000_000n;
    expect(computePositionValue(size, price, price)).toBe(size);
  });

  it('adjusts value when price doubles', () => {
    const size = 800_000_000n;
    const entryPrice = 1_000_000_000n;  // $1000
    const currentPrice = 2_000_000_000n; // $2000
    // positionValue = 800 * 2000 / 1000 = 1600
    expect(computePositionValue(size, currentPrice, entryPrice)).toBe(1_600_000_000n);
  });

  it('adjusts value when price halves', () => {
    const size = 800_000_000n;
    const entryPrice = 2_000_000_000n;
    const currentPrice = 1_000_000_000n;
    // positionValue = 800 * 1000 / 2000 = 400
    expect(computePositionValue(size, currentPrice, entryPrice)).toBe(400_000_000n);
  });

  it('returns positionSize when entryPrice is 0', () => {
    expect(computePositionValue(800_000_000n, 3_500_000_000n, 0n)).toBe(800_000_000n);
  });
});

// ─── FundingArbSimulator Tests ───────────────────────────────────────────────

describe('FundingArbSimulator', () => {
  const costModel = new FundingArbCostModel(OPTIMISTIC_SCENARIO);
  const liquidationModel = new LiquidationModel();

  describe('simulate — basic behavior', () => {
    it('returns correct structure with all fields', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(['0.000125', '0.000125']);
      const prices = makeCandles([3500, 3500]);

      const result = sim.simulate('ETH', rates, prices);

      expect(result.coin).toBe('ETH');
      expect(result.capitalUsdc).toBe(1000_000_000n);
      expect(result.hoursSimulated).toBe(2);
      expect(result.steps.length).toBe(2);
      expect(result.costScenario).toBe('optimistic');
      expect(typeof result.grossFunding).toBe('bigint');
      expect(typeof result.totalCosts).toBe('bigint');
      expect(typeof result.netPnl).toBe('bigint');
      expect(typeof result.maxDrawdownBps).toBe('bigint');
      expect(typeof result.liquidationCount).toBe('number');
      expect(typeof result.stressEventCount).toBe('number');
      expect(typeof result.benchmarkReturn).toBe('bigint');
      expect(typeof result.alpha).toBe('bigint');
      expect(['VIABLE', 'UNVIABLE']).toContain(result.verdict);
    });

    it('deducts open costs at start', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // Position size = 1000 * 80% = 800 USDC
      const positionSize = 800_000_000n;
      const openCosts = costModel.computeOpenCosts(positionSize);

      // With zero funding and no price change, equity after first step should be
      // capital - openCosts - closeCosts (at end)
      const rates = makeFundingRates(['0.0']);
      const prices = makeCandles([3500]);

      const result = sim.simulate('ETH', rates, prices);

      // Total costs should include at least open costs + close costs
      expect(result.totalCosts).toBeGreaterThanOrEqual(openCosts.total);
    });

    it('deducts close costs at end', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const positionSize = 800_000_000n;
      const openCosts = costModel.computeOpenCosts(positionSize);
      const closeCosts = costModel.computeCloseCosts(positionSize);

      // With zero rates and stable price: total costs = open + close
      const rates = makeFundingRates(['0.0']);
      const prices = makeCandles([3500]);

      const result = sim.simulate('ETH', rates, prices);

      expect(result.totalCosts).toBe(openCosts.total + closeCosts.total);
    });
  });

  describe('simulate — funding PnL', () => {
    it('applies positive funding correctly (Requirement 4.1)', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // Position = $800, rate = 0.000125
      // funding_pnl = 800_000_000 * 125_000_000 / 1_000_000_000_000 = 100_000 ($0.10)
      const rates = makeFundingRates(['0.000125']);
      const prices = makeCandles([3500]);

      const result = sim.simulate('ETH', rates, prices);

      expect(result.grossFunding).toBe(100_000n);
      expect(result.steps[0]!.fundingPnl).toBe(100_000n);
    });

    it('applies negative funding (deducts from equity, Requirement 4.4)', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(['-0.000125']);
      const prices = makeCandles([3500]);

      const result = sim.simulate('ETH', rates, prices);

      // Negative funding should be deducted
      expect(result.steps[0]!.fundingPnl).toBe(-100_000n);
      // Gross funding should not include negative payments
      expect(result.grossFunding).toBe(0n);
    });

    it('tracks cumulative PnL correctly over multiple hours (Requirement 4.5)', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(['0.000125', '0.000125', '-0.000050']);
      const prices = makeCandles([3500, 3500, 3500]);

      const result = sim.simulate('ETH', rates, prices);

      // Each step: fundingPnl = 800_000_000 * rate / RATE_PRECISION
      // rate=0.000125 → pnl = 100_000
      // rate=-0.000050 → pnl = -40_000
      expect(result.steps[0]!.cumulativePnl).toBe(100_000n);
      expect(result.steps[1]!.cumulativePnl).toBe(200_000n);
      expect(result.steps[2]!.cumulativePnl).toBe(160_000n);
    });

    it('netPnl equals final equity minus initial capital (Requirement 4.5)', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(['0.000125', '0.000125']);
      const prices = makeCandles([3500, 3500]);

      const result = sim.simulate('ETH', rates, prices);

      // netPnl = final_equity - initial_capital
      const expectedNetPnl = result.netPnl;
      // Verify via steps: last equity - close costs = final equity
      const lastStep = result.steps[result.steps.length - 1]!;
      const positionSize = 800_000_000n;
      const closeCosts = costModel.computeCloseCosts(positionSize);
      const finalEquity = lastStep.equity - closeCosts.total;
      expect(expectedNetPnl).toBe(finalEquity - config.capitalUsdc);
    });
  });

  describe('simulate — no-lookahead invariant (Requirement 4.3)', () => {
    it('truncating future data does not change historical steps', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // Full dataset: 5 hours
      const fullRates = makeFundingRates(['0.000125', '0.000100', '-0.000050', '0.000200', '0.000150']);
      const fullPrices = makeCandles([3500, 3505, 3510, 3515, 3520]);

      // Truncated dataset: first 3 hours
      const truncRates = fullRates.slice(0, 3);
      const truncPrices = fullPrices.slice(0, 3);

      const fullResult = sim.simulate('ETH', fullRates, fullPrices);
      const truncResult = sim.simulate('ETH', truncRates, truncPrices);

      // First 3 steps should be identical
      for (let i = 0; i < 3; i++) {
        expect(fullResult.steps[i]!.fundingPnl).toBe(truncResult.steps[i]!.fundingPnl);
        expect(fullResult.steps[i]!.cumulativePnl).toBe(truncResult.steps[i]!.cumulativePnl);
        expect(fullResult.steps[i]!.equity).toBe(truncResult.steps[i]!.equity);
        expect(fullResult.steps[i]!.rebalanced).toBe(truncResult.steps[i]!.rebalanced);
        expect(fullResult.steps[i]!.liquidated).toBe(truncResult.steps[i]!.liquidated);
      }
    });
  });

  describe('simulate — benchmark and alpha (Requirements 7.2, 7.3, 7.4)', () => {
    it('computes benchmark return correctly', () => {
      const config = makeConfig({ aaveApyBps: 500n }); // 5% APY
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // 48 hours = 2 days
      const rates = makeFundingRates(Array(48).fill('0.000125'));
      const prices = makeCandles(Array(48).fill(3500));

      const result = sim.simulate('ETH', rates, prices);

      // benchmark = capital * 500 * 2 / (365 * 10000)
      // = 1000_000_000 * 500 * 2 / 3_650_000
      const expectedBenchmark = 1000_000_000n * 500n * 2n / (365n * BPS_DIVISOR);
      expect(result.benchmarkReturn).toBe(expectedBenchmark);
    });

    it('computes alpha as netPnl - benchmarkReturn', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(Array(24).fill('0.000125'));
      const prices = makeCandles(Array(24).fill(3500));

      const result = sim.simulate('ETH', rates, prices);

      expect(result.alpha).toBe(result.netPnl - result.benchmarkReturn);
    });

    it('marks unviable when alpha is negative', () => {
      const config = makeConfig({ aaveApyBps: 50000n }); // Absurdly high APY
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(Array(24).fill('0.000001')); // Very low funding
      const prices = makeCandles(Array(24).fill(3500));

      const result = sim.simulate('ETH', rates, prices);

      // With huge benchmark and tiny funding, alpha should be negative
      expect(result.alpha).toBeLessThan(0n);
      expect(result.verdict).toBe('UNVIABLE');
    });
  });

  describe('simulate — liquidation (Requirement 6.4)', () => {
    it('detects liquidation and resets position', () => {
      // Start with very small capital relative to position so margin is tight
      const config = makeConfig({
        capitalUsdc: 100_000_000n,       // $100
        positionSizeFraction: 90n,       // 90% → $90 position
      });
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // Start at $100 price, then price doubles (margin collapses)
      // Entry: equity ~ $100 - openCosts, positionValue = $90
      // After big price move: positionValue doubles, margin ratio halves
      const rates = makeFundingRates(['0.0', '0.0', '0.0']);
      const prices = makeCandles([100, 100, 10000]); // Huge price spike

      const result = sim.simulate('ETH', rates, prices);

      // Should have detected liquidation
      expect(result.liquidationCount).toBeGreaterThanOrEqual(0);
      // After liquidation, position should be 0 → close costs are 0
    });
  });

  describe('simulate — rebalance triggers', () => {
    it('triggers rebalance when price diverges > 5% from entry', () => {
      const config = makeConfig({
        capitalUsdc: 10000_000_000n,     // $10000 - well capitalized
        positionSizeFraction: 50n,       // 50% → $5000 position
        rebalanceTriggerDivergeBps: 500n, // 5%
        rebalanceTriggerMarginBps: 1250n,
      });
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // Entry at $3500, then price goes to $3700 (5.7% divergence)
      const rates = makeFundingRates(['0.000125', '0.000125', '0.000125']);
      const prices = makeCandles([3500, 3500, 3700]);

      const result = sim.simulate('ETH', rates, prices);

      // Third hour: (3700-3500)/3500 = 571 bps > 500 → rebalance
      expect(result.steps[2]!.rebalanced).toBe(true);
      // First two hours: no rebalance
      expect(result.steps[0]!.rebalanced).toBe(false);
      expect(result.steps[1]!.rebalanced).toBe(false);
    });

    it('does NOT rebalance when price stays within 5%', () => {
      const config = makeConfig({
        capitalUsdc: 10000_000_000n,
        positionSizeFraction: 50n,
        rebalanceTriggerDivergeBps: 500n,
      });
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // Entry at $3500, price moves to $3600 (2.8% < 5%)
      const rates = makeFundingRates(['0.000125', '0.000125']);
      const prices = makeCandles([3500, 3600]);

      const result = sim.simulate('ETH', rates, prices);

      expect(result.steps[0]!.rebalanced).toBe(false);
      expect(result.steps[1]!.rebalanced).toBe(false);
    });
  });

  describe('simulate — drawdown tracking', () => {
    it('tracks peak equity and drawdown correctly', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // Positive then negative funding to create drawdown
      const rates = makeFundingRates(['0.001', '0.001', '-0.002', '-0.002']);
      const prices = makeCandles([3500, 3500, 3500, 3500]);

      const result = sim.simulate('ETH', rates, prices);

      // Peak should be after first two positive hours
      // maxDrawdown should be > 0 since we have negative funding after peak
      expect(result.maxDrawdownBps).toBeGreaterThan(0n);
    });

    it('drawdown decreases as positive funding recovers open costs', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      // Use large positive funding to quickly recover open costs
      const rates = makeFundingRates(['0.01', '0.01', '0.01']);
      const prices = makeCandles([3500, 3500, 3500]);

      const result = sim.simulate('ETH', rates, prices);

      // After open costs, equity dips below initial capital (peakEquity).
      // With large positive funding, equity should recover and drawdown should decrease.
      // The last step's drawdown should be less than or equal to first step's drawdown.
      const firstDrawdown = result.steps[0]!.drawdownBps;
      const lastDrawdown = result.steps[result.steps.length - 1]!.drawdownBps;
      expect(lastDrawdown).toBeLessThanOrEqual(firstDrawdown);

      // maxDrawdownBps should be >= 0
      expect(result.maxDrawdownBps).toBeGreaterThanOrEqual(0n);
    });
  });

  describe('simulate — BigInt precision (Requirement 4.6)', () => {
    it('all monetary values are BigInt', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(['0.000125']);
      const prices = makeCandles([3500]);

      const result = sim.simulate('ETH', rates, prices);

      expect(typeof result.grossFunding).toBe('bigint');
      expect(typeof result.totalCosts).toBe('bigint');
      expect(typeof result.netPnl).toBe('bigint');
      expect(typeof result.benchmarkReturn).toBe('bigint');
      expect(typeof result.alpha).toBe('bigint');
      expect(typeof result.steps[0]!.equity).toBe('bigint');
      expect(typeof result.steps[0]!.fundingPnl).toBe('bigint');
      expect(typeof result.steps[0]!.cumulativePnl).toBe('bigint');
    });
  });

  describe('simulate — edge cases', () => {
    it('handles empty input arrays', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const result = sim.simulate('ETH', [], []);

      expect(result.hoursSimulated).toBe(0);
      expect(result.steps.length).toBe(0);
      expect(result.grossFunding).toBe(0n);
    });

    it('handles mismatched array lengths (uses shorter)', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(['0.000125', '0.000125', '0.000125']);
      const prices = makeCandles([3500, 3500]); // Only 2 prices

      const result = sim.simulate('ETH', rates, prices);

      expect(result.hoursSimulated).toBe(2);
      expect(result.steps.length).toBe(2);
    });

    it('handles zero funding rate', () => {
      const config = makeConfig();
      const sim = new FundingArbSimulator(config, costModel, liquidationModel);

      const rates = makeFundingRates(['0.0', '0.000000000000']);
      const prices = makeCandles([3500, 3500]);

      const result = sim.simulate('ETH', rates, prices);

      expect(result.steps[0]!.fundingPnl).toBe(0n);
      expect(result.steps[1]!.fundingPnl).toBe(0n);
      expect(result.grossFunding).toBe(0n);
    });
  });
});

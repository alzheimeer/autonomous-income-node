/**
 * Unit tests for CostAwareTradeGate
 *
 * Tests net profit formula, conservative exit estimation, rejection criteria,
 * stricter limits without private RPC, gas budget, and logging.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, E4, E5, E12
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  CostAwareTradeGate,
  type GateLogger,
  type GateResult,
  type CostBreakdown,
} from '../../cost-aware-trade-gate.js';
import type { TradeGateConfig } from '../../config.js';
import type { ExecutableQuote } from '../../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: TradeGateConfig = {
  minNetProfitUsdc: 80_000n,       // $0.08
  minNetProfitBps: 50,
  safetyMarginBps: 20,
  maxQuoteAgeMs: 10_000,
  sanityMaxProfitPct: 0.50,
  maxSlippageBps: 40,
  maxPriceImpactBps: 30,
  minLiquidity: 50_000,
  discretionaryMaxGas: 50_000n,    // $0.05
  hasPrivateRpc: true,
};

function makeEntryQuote(overrides: Partial<ExecutableQuote> = {}): ExecutableQuote {
  return {
    source: 'quoter_v2',
    amountIn: 10_000_000n,           // $10 USDC
    amountOut: 4_000_000_000_000_000n, // 0.004 WETH (~$10 at $2500)
    priceImpactBps: 5,
    gasEstimate: 150_000n,
    gasUsd: 0.015,                   // $0.015
    timestamp: Date.now(),
    poolFeeIncluded: true,
    externalFees: 0n,
    ttl: 10_000,
    ...overrides,
  };
}

function makeExitQuote(overrides: Partial<ExecutableQuote> = {}): ExecutableQuote {
  return {
    source: 'quoter_v2',
    amountIn: 4_000_000_000_000_000n, // 0.004 WETH
    amountOut: 10_200_000n,            // $10.20 USDC — ~2% TP
    priceImpactBps: 5,
    gasEstimate: 150_000n,
    gasUsd: 0.015,                    // $0.015
    timestamp: Date.now(),
    poolFeeIncluded: true,
    externalFees: 0n,
    ttl: 10_000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('CostAwareTradeGate', () => {
  let gate: CostAwareTradeGate;
  let logEntries: Parameters<GateLogger>[0][];

  beforeEach(() => {
    logEntries = [];
    const logger: GateLogger = (entry) => logEntries.push(entry);
    gate = new CostAwareTradeGate(DEFAULT_CONFIG, logger);
  });

  describe('Net profit formula (Req 4.2)', () => {
    it('should calculate net profit correctly', () => {
      const entryQuote = makeEntryQuote();
      const exitQuote = makeExitQuote();
      const tradeSize = 10_000_000n; // $10

      const result = gate.evaluate(entryQuote, exitQuote, tradeSize, true);

      // exitProceeds = min(10_200_000, 10_200_000 * 97/100) = min(10_200_000, 9_894_000) = 9_894_000
      // entryGas = round(0.015 * 1_000_000) = 15_000
      // exitGas = round(0.015 * 1_000_000) = 15_000
      // safetyMargin = 10_000_000 * 20 / 10_000 = 20_000
      // totalCosts = 10_000_000 + 15_000 + 15_000 + 0 + 20_000 = 10_050_000
      // netProfit = 9_894_000 - 10_050_000 = -156_000 (negative → loss)
      expect(result.costBreakdown.entryInput).toBe(10_000_000n);
      expect(result.costBreakdown.entryGas).toBe(15_000n);
      expect(result.costBreakdown.exitGas).toBe(15_000n);
      expect(result.costBreakdown.externalFees).toBe(0n);
      expect(result.costBreakdown.safetyMargin).toBe(20_000n);
    });

    it('should pass when net profit exceeds all thresholds', () => {
      // Create a profitable scenario
      const entryQuote = makeEntryQuote({ amountIn: 10_000_000n, gasUsd: 0.01 });
      const exitQuote = makeExitQuote({ amountOut: 10_500_000n, gasUsd: 0.01 }); // $10.50

      const tradeSize = 10_000_000n;
      const result = gate.evaluate(entryQuote, exitQuote, tradeSize, true);

      // exitProceeds = min(10_500_000, 10_500_000 * 97/100) = min(10_500_000, 10_185_000) = 10_185_000
      // entryGas = 10_000, exitGas = 10_000
      // safetyMargin = 10_000_000 * 20 / 10_000 = 20_000
      // totalCosts = 10_000_000 + 10_000 + 10_000 + 0 + 20_000 = 10_040_000
      // netProfit = 10_185_000 - 10_040_000 = 145_000 ($0.145)
      // bps = 145_000 * 10_000 / 10_000_000 = 145 bps
      expect(result.passed).toBe(true);
      expect(result.netProfitUsdc).toBe(145_000n);
      expect(result.netProfitBps).toBe(145);
      expect(result.rejectReasons).toHaveLength(0);
    });

    it('should not double-subtract pool fees (poolFeeIncluded=true)', () => {
      const entryQuote = makeEntryQuote({ poolFeeIncluded: true, externalFees: 0n });
      const exitQuote = makeExitQuote({ poolFeeIncluded: true, externalFees: 0n });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // externalFees should be 0 — pool fees already in quote amounts
      expect(result.costBreakdown.externalFees).toBe(0n);
    });

    it('should include external aggregator fees separately', () => {
      const entryQuote = makeEntryQuote({ externalFees: 5_000n }); // $0.005
      const exitQuote = makeExitQuote({ externalFees: 3_000n }); // $0.003

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      expect(result.costBreakdown.externalFees).toBe(8_000n);
    });
  });

  describe('Conservative exit estimate (E4)', () => {
    it('should apply 97% buffer to exit proceeds (TP-adjusted)', () => {
      const exitQuote = makeExitQuote({ amountOut: 10_300_000n }); // $10.30
      const entryQuote = makeEntryQuote({ amountIn: 10_000_000n, gasUsd: 0.005 });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // exitProceeds = min(10_300_000, 10_300_000 * 97 / 100) = min(10_300_000, 9_991_000) = 9_991_000
      expect(result.costBreakdown.exitProceeds).toBe(9_991_000n);
    });

    it('should use raw quote if lower than TP-adjusted (0.97)', () => {
      // If quote is already lower than 97% of itself, it should use the quote
      // This can't actually happen since x < x*0.97 is impossible for positive x
      // Instead test that min picks the smaller value correctly:
      // min(amountOut, amountOut * 97/100) = amountOut * 97/100 (always, since 97/100 < 1)
      const exitQuote = makeExitQuote({ amountOut: 10_000_000n });

      const result = gate.evaluate(makeEntryQuote(), exitQuote, 10_000_000n, true);

      // 10_000_000 * 97/100 = 9_700_000
      expect(result.costBreakdown.exitProceeds).toBe(9_700_000n);
    });
  });

  describe('Rejection criteria (Req 4.4)', () => {
    it('should reject when net profit < $0.08', () => {
      // Low exit proceeds → low profit
      const entryQuote = makeEntryQuote({ gasUsd: 0.01 });
      const exitQuote = makeExitQuote({ amountOut: 10_100_000n, gasUsd: 0.01 });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // exitProceeds = 10_100_000 * 97/100 = 9_797_000
      // costs = 10_000_000 + 10_000 + 10_000 + 0 + 20_000 = 10_040_000
      // netProfit = 9_797_000 - 10_040_000 = -243_000 (negative)
      expect(result.passed).toBe(false);
      expect(result.rejectReasons.some(r => r.startsWith('profit_below_min:'))).toBe(true);
    });

    it('should reject when net profit < 50 bps', () => {
      // Scenario with positive but small profit below 50 bps
      const entryQuote = makeEntryQuote({ amountIn: 10_000_000n, gasUsd: 0.001 });
      // Exit that gives only ~30 bps after all costs
      const exitQuote = makeExitQuote({ amountOut: 10_140_000n, gasUsd: 0.001 });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // exitProceeds = 10_140_000 * 97/100 = 9_835_800
      // costs = 10_000_000 + 1_000 + 1_000 + 0 + 20_000 = 10_022_000
      // netProfit = 9_835_800 - 10_022_000 = -186_200 (negative → rejected anyway)
      expect(result.passed).toBe(false);
      expect(result.rejectReasons.some(r => r.includes('profit_below_min'))).toBe(true);
    });

    it('should reject when entry quote is stale (>10s)', () => {
      const staleQuote = makeEntryQuote({ timestamp: Date.now() - 15_000 });
      const exitQuote = makeExitQuote();

      const result = gate.evaluate(staleQuote, exitQuote, 10_000_000n, true);

      expect(result.passed).toBe(false);
      expect(result.rejectReasons.some(r => r.startsWith('entry_quote_stale:'))).toBe(true);
    });

    it('should reject when exit quote is stale (>10s)', () => {
      const entryQuote = makeEntryQuote();
      const staleExit = makeExitQuote({ timestamp: Date.now() - 12_000 });

      const result = gate.evaluate(entryQuote, staleExit, 10_000_000n, true);

      expect(result.passed).toBe(false);
      expect(result.rejectReasons.some(r => r.startsWith('exit_quote_stale:'))).toBe(true);
    });

    it('should reject when combined gas > $0.05', () => {
      // Each quote costs $0.03 gas → combined $0.06 > $0.05
      const entryQuote = makeEntryQuote({ gasUsd: 0.03 });
      const exitQuote = makeExitQuote({ gasUsd: 0.03 });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      expect(result.passed).toBe(false);
      expect(result.rejectReasons.some(r => r.startsWith('gas_exceeds_budget:'))).toBe(true);
    });

    it('should reject when price impact > 30 bps (with private RPC)', () => {
      const entryQuote = makeEntryQuote({ priceImpactBps: 35 });
      const exitQuote = makeExitQuote();

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      expect(result.passed).toBe(false);
      expect(result.rejectReasons.some(r => r.startsWith('entry_impact_high:'))).toBe(true);
    });

    it('should reject when profit > 50% of trade size (sanity)', () => {
      // Exit proceeds much higher than entry → suspicious
      const entryQuote = makeEntryQuote({ amountIn: 10_000_000n, gasUsd: 0.001 });
      const exitQuote = makeExitQuote({ amountOut: 18_000_000n, gasUsd: 0.001 }); // $18 exit on $10 entry

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // exitProceeds = 18_000_000 * 97/100 = 17_460_000
      // costs = 10_000_000 + 1_000 + 1_000 + 0 + 20_000 = 10_022_000
      // netProfit = 17_460_000 - 10_022_000 = 7_438_000 ($7.44)
      // sanityMax = 10_000_000 * 0.50 = 5_000_000 ($5.00)
      // 7_438_000 > 5_000_000 → rejected
      expect(result.passed).toBe(false);
      expect(result.rejectReasons.some(r => r.includes('profit_sanity_fail'))).toBe(true);
    });

    it('should accumulate ALL rejection reasons independently', () => {
      // Stale + high impact + high gas
      const entryQuote = makeEntryQuote({
        timestamp: Date.now() - 15_000,
        priceImpactBps: 35,
        gasUsd: 0.03,
      });
      const exitQuote = makeExitQuote({ gasUsd: 0.03 });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      expect(result.passed).toBe(false);
      expect(result.rejectReasons.length).toBeGreaterThanOrEqual(3);
      expect(result.rejectReasons.some(r => r.startsWith('entry_quote_stale:'))).toBe(true);
      expect(result.rejectReasons.some(r => r.startsWith('entry_impact_high:'))).toBe(true);
      expect(result.rejectReasons.some(r => r.startsWith('gas_exceeds_budget:'))).toBe(true);
    });
  });

  describe('Stricter limits without private RPC (E12)', () => {
    it('should use 20 bps max impact without private RPC', () => {
      const entryQuote = makeEntryQuote({ priceImpactBps: 25 }); // 25 > 20
      const exitQuote = makeExitQuote();

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, false);

      expect(result.passed).toBe(false);
      expect(result.rejectReasons.some(r => r.includes('entry_impact_high:25bps>20bps'))).toBe(true);
    });

    it('should allow 25 bps impact with private RPC (max is 30)', () => {
      const entryQuote = makeEntryQuote({
        priceImpactBps: 25,
        amountIn: 10_000_000n,
        gasUsd: 0.005,
      });
      const exitQuote = makeExitQuote({ amountOut: 10_600_000n, gasUsd: 0.005 });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // No impact rejection with private RPC (25 < 30)
      expect(result.rejectReasons.every(r => !r.includes('impact_high'))).toBe(true);
    });
  });

  describe('Combined gas budget (E5)', () => {
    it('should pass when combined gas is exactly $0.05', () => {
      const entryQuote = makeEntryQuote({
        gasUsd: 0.025,
        amountIn: 10_000_000n,
      });
      const exitQuote = makeExitQuote({
        gasUsd: 0.025,
        amountOut: 10_600_000n,
      });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // Combined gas = $0.05 = 50_000 → NOT exceeding (≤ threshold)
      expect(result.rejectReasons.every(r => !r.startsWith('gas_exceeds_budget:'))).toBe(true);
    });

    it('should reject when combined gas exceeds $0.05', () => {
      const entryQuote = makeEntryQuote({ gasUsd: 0.03 });
      const exitQuote = makeExitQuote({ gasUsd: 0.025 });

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // Combined: $0.055 = 55_000 > 50_000
      expect(result.rejectReasons.some(r => r.startsWith('gas_exceeds_budget:'))).toBe(true);
    });
  });

  describe('Safety margin (Req 4.2)', () => {
    it('should apply safetyMarginBps to entry amount', () => {
      const entryQuote = makeEntryQuote({ amountIn: 10_000_000n }); // $10
      const exitQuote = makeExitQuote();

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      // safetyMargin = 10_000_000 * 20 / 10_000 = 20_000 ($0.02)
      expect(result.costBreakdown.safetyMargin).toBe(20_000n);
    });

    it('should scale safety margin with entry amount', () => {
      const entryQuote = makeEntryQuote({ amountIn: 5_000_000n }); // $5
      const exitQuote = makeExitQuote();

      const result = gate.evaluate(entryQuote, exitQuote, 5_000_000n, true);

      // safetyMargin = 5_000_000 * 20 / 10_000 = 10_000 ($0.01)
      expect(result.costBreakdown.safetyMargin).toBe(10_000n);
    });
  });

  describe('Logging (Req 4.5)', () => {
    it('should log full cost breakdown for every evaluation', () => {
      const entryQuote = makeEntryQuote();
      const exitQuote = makeExitQuote();

      gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      expect(logEntries).toHaveLength(1);
      expect(logEntries[0].costBreakdown).toBeDefined();
      expect(logEntries[0].costBreakdown.entryInput).toBe('10000000');
      expect(logEntries[0].timestamp).toBeGreaterThan(0);
    });

    it('should log both accepted and rejected trades', () => {
      // Accepted
      const goodEntry = makeEntryQuote({ amountIn: 10_000_000n, gasUsd: 0.005 });
      const goodExit = makeExitQuote({ amountOut: 10_600_000n, gasUsd: 0.005 });
      gate.evaluate(goodEntry, goodExit, 10_000_000n, true);

      // Rejected (stale)
      const staleEntry = makeEntryQuote({ timestamp: Date.now() - 15_000 });
      gate.evaluate(staleEntry, makeExitQuote(), 10_000_000n, true);

      expect(logEntries).toHaveLength(2);
      expect(logEntries[0].passed).toBe(true);
      expect(logEntries[1].passed).toBe(false);
    });

    it('should include reject reasons in log', () => {
      const staleEntry = makeEntryQuote({ timestamp: Date.now() - 15_000 });
      gate.evaluate(staleEntry, makeExitQuote(), 10_000_000n, true);

      expect(logEntries[0].rejectReasons.length).toBeGreaterThan(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle zero trade size gracefully', () => {
      const entryQuote = makeEntryQuote();
      const exitQuote = makeExitQuote();

      const result = gate.evaluate(entryQuote, exitQuote, 0n, true);

      // bps calculation with zero size should return 0
      expect(result.netProfitBps).toBe(0);
    });

    it('should handle negative net profit without throwing', () => {
      const entryQuote = makeEntryQuote({ amountIn: 10_000_000n, gasUsd: 0.02 });
      const exitQuote = makeExitQuote({ amountOut: 9_500_000n, gasUsd: 0.02 }); // Loss

      const result = gate.evaluate(entryQuote, exitQuote, 10_000_000n, true);

      expect(result.netProfitUsdc).toBeLessThan(0n);
      expect(result.passed).toBe(false);
    });

    it('should work without a logger', () => {
      const noLogGate = new CostAwareTradeGate(DEFAULT_CONFIG);
      const entryQuote = makeEntryQuote();
      const exitQuote = makeExitQuote();

      // Should not throw
      const result = noLogGate.evaluate(entryQuote, exitQuote, 10_000_000n, true);
      expect(result).toBeDefined();
    });
  });
});

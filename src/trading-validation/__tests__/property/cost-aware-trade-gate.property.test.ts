/**
 * Property-based tests for CostAwareTradeGate
 *
 * **Property 5: Net profit formula correctness**
 * net_profit = exit_proceeds - entry_input - entry_gas - exit_gas - external_fees - safety_margin
 * For any valid inputs, this identity holds.
 *
 * **Property 6: Conservative exit estimate bound**
 * exit estimate is always ≤ current quote (conservative)
 *
 * **Property 7: Multi-criteria gate rejection**
 * If ANY single criterion fails (net profit < $0.08, < 50 bps, quote > 10s,
 * gas > $0.05, impact > 30 bps, profit > 50% size), the gate rejects.
 *
 * **Validates: Requirements 4.2, 4.3, 4.4**
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  CostAwareTradeGate,
  type CostBreakdown,
} from '../../cost-aware-trade-gate.js';
import type { ExecutableQuote } from '../../types.js';
import type { TradeGateConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants & Config
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_GATE_CONFIG: TradeGateConfig = {
  minNetProfitUsdc: 80_000n,          // $0.08
  minNetProfitBps: 50,
  safetyMarginBps: 20,
  maxQuoteAgeMs: 10_000,
  sanityMaxProfitPct: 0.50,
  maxSlippageBps: 40,
  maxPriceImpactBps: 30,
  minLiquidity: 50_000,
  discretionaryMaxGas: 50_000n,       // $0.05
  hasPrivateRpc: true,
};

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a valid USDC amount for trades ($5 to $10 range, 6 decimals).
 */
const validTradeSizeUsdc = fc.bigInt({ min: 5_000_000n, max: 10_000_000n });

/**
 * Generate a gas USD value ($0.001 to $0.04 — within budget).
 */
const validGasUsd = fc.double({ min: 0.001, max: 0.04, noNaN: true, noDefaultInfinity: true });

/**
 * Generate low price impact (0 to 25 bps — within limits).
 */
const validImpactBps = fc.integer({ min: 0, max: 25 });

/**
 * Generate external fees (0 to small amounts, 6 decimals USDC).
 */
const validExternalFees = fc.bigInt({ min: 0n, max: 5_000n });

/**
 * Generate an entry quote with controlled parameters.
 */
function genEntryQuote(opts: {
  amountIn: bigint;
  gasUsd?: number;
  impactBps?: number;
  externalFees?: bigint;
  timestamp?: number;
}): ExecutableQuote {
  return {
    source: 'quoter_v2',
    amountIn: opts.amountIn,
    amountOut: 4_000_000_000_000_000n, // ~0.004 WETH
    priceImpactBps: opts.impactBps ?? 5,
    gasEstimate: 150_000n,
    gasUsd: opts.gasUsd ?? 0.02,
    timestamp: opts.timestamp ?? Date.now(),
    poolFeeIncluded: true,
    externalFees: opts.externalFees ?? 0n,
    ttl: 10_000,
  };
}

/**
 * Generate an exit quote with controlled parameters.
 * exitProceeds (amountOut) must be larger than entry to possibly profit.
 */
function genExitQuote(opts: {
  amountOut: bigint;
  gasUsd?: number;
  impactBps?: number;
  externalFees?: bigint;
  timestamp?: number;
}): ExecutableQuote {
  return {
    source: 'quoter_v2',
    amountIn: 4_000_000_000_000_000n, // WETH being sold
    amountOut: opts.amountOut,
    priceImpactBps: opts.impactBps ?? 5,
    gasEstimate: 150_000n,
    gasUsd: opts.gasUsd ?? 0.02,
    timestamp: opts.timestamp ?? Date.now(),
    poolFeeIncluded: true,
    externalFees: opts.externalFees ?? 0n,
    ttl: 10_000,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('CostAwareTradeGate - Property Tests', () => {
  let gate: CostAwareTradeGate;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    gate = new CostAwareTradeGate(DEFAULT_GATE_CONFIG);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 5: Net profit formula correctness
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 5: Net profit formula correctness', () => {
    /**
     * **Validates: Requirements 4.2**
     *
     * For any valid entry/exit quotes, the net profit in the cost breakdown
     * MUST equal: exit_proceeds - entry_input - entry_gas - exit_gas - external_fees - safety_margin
     */
    it('net_profit identity holds for all valid inputs', () => {
      const now = 1_700_000_000_000;

      fc.assert(
        fc.property(
          // Entry amount (USDC 6 decimals, $5-$10)
          fc.bigInt({ min: 5_000_000n, max: 10_000_000n }),
          // Exit amount (slightly more than entry for profit)
          fc.bigInt({ min: 5_050_000n, max: 12_000_000n }),
          // Entry gas USD
          fc.double({ min: 0.001, max: 0.025, noNaN: true, noDefaultInfinity: true }),
          // Exit gas USD
          fc.double({ min: 0.001, max: 0.025, noNaN: true, noDefaultInfinity: true }),
          // Entry external fees
          fc.bigInt({ min: 0n, max: 5_000n }),
          // Exit external fees
          fc.bigInt({ min: 0n, max: 5_000n }),
          (entryAmount, exitAmount, entryGasUsd, exitGasUsd, entryExtFees, exitExtFees) => {
            const entryQuote = genEntryQuote({
              amountIn: entryAmount,
              gasUsd: entryGasUsd,
              impactBps: 5,
              externalFees: entryExtFees,
              timestamp: now,
            });

            const exitQuote = genExitQuote({
              amountOut: exitAmount,
              gasUsd: exitGasUsd,
              impactBps: 5,
              externalFees: exitExtFees,
              timestamp: now,
            });

            vi.setSystemTime(now);
            const result = gate.evaluate(entryQuote, exitQuote, entryAmount, true);
            const bd = result.costBreakdown;

            // Manually compute expected net profit per formula
            const entryGasUsdc = BigInt(Math.round(entryGasUsd * 1_000_000));
            const exitGasUsdc = BigInt(Math.round(exitGasUsd * 1_000_000));
            const totalExternalFees = entryExtFees + exitExtFees;
            const safetyMargin = (entryAmount * BigInt(DEFAULT_GATE_CONFIG.safetyMarginBps)) / 10_000n;

            // The gate applies conservative exit: min(exitAmount, exitAmount * 97 / 100)
            // Since exitAmount * 97/100 < exitAmount, conservativeExit = exitAmount * 97n / 100n
            const conservativeExit = (exitAmount * 97n) / 100n;

            const totalCosts = entryAmount + entryGasUsdc + exitGasUsdc + totalExternalFees + safetyMargin;
            const expectedNetProfit = conservativeExit > totalCosts
              ? conservativeExit - totalCosts
              : -(totalCosts - conservativeExit);

            // Verify the formula identity holds
            expect(bd.netProfit).toBe(expectedNetProfit);

            // Also verify breakdown components
            expect(bd.entryInput).toBe(entryAmount);
            expect(bd.exitProceeds).toBe(conservativeExit);
            expect(bd.entryGas).toBe(entryGasUsdc);
            expect(bd.exitGas).toBe(exitGasUsdc);
            expect(bd.externalFees).toBe(totalExternalFees);
            expect(bd.safetyMargin).toBe(safetyMargin);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 6: Conservative exit estimate bound
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 6: Conservative exit estimate bound', () => {
    /**
     * **Validates: Requirements 4.3**
     *
     * The exit estimate used in cost breakdown is ALWAYS ≤ the raw exit quote amountOut.
     * The gate applies a conservative buffer (97%) to ensure safety.
     */
    it('exit proceeds in cost breakdown are always ≤ raw exit quote amountOut', () => {
      const now = 1_700_000_000_000;

      fc.assert(
        fc.property(
          // Entry amount
          fc.bigInt({ min: 5_000_000n, max: 10_000_000n }),
          // Exit amount (any positive value)
          fc.bigInt({ min: 1_000n, max: 20_000_000n }),
          (entryAmount, exitAmount) => {
            const entryQuote = genEntryQuote({
              amountIn: entryAmount,
              gasUsd: 0.02,
              timestamp: now,
            });
            const exitQuote = genExitQuote({
              amountOut: exitAmount,
              gasUsd: 0.02,
              timestamp: now,
            });

            vi.setSystemTime(now);
            const result = gate.evaluate(entryQuote, exitQuote, entryAmount, true);

            // Conservative exit proceeds MUST be ≤ raw exit quote output
            expect(result.costBreakdown.exitProceeds).toBeLessThanOrEqual(exitAmount);
          },
        ),
        { numRuns: 300 },
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 7: Multi-criteria gate rejection
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 7: Multi-criteria gate rejection', () => {
    /**
     * **Validates: Requirements 4.4**
     *
     * If the quote age exceeds 10s, the gate MUST reject regardless of other criteria.
     */
    it('rejects when entry quote is stale (> 10s old)', () => {
      fc.assert(
        fc.property(
          // Random stale age (10001ms to 60000ms)
          fc.integer({ min: 10_001, max: 60_000 }),
          fc.bigInt({ min: 5_000_000n, max: 10_000_000n }),
          (staleAge, tradeSize) => {
            const now = 1_700_000_000_000;
            const staleTimestamp = now - staleAge;

            vi.setSystemTime(now);

            const entryQuote = genEntryQuote({
              amountIn: tradeSize,
              gasUsd: 0.01,
              impactBps: 5,
              timestamp: staleTimestamp, // STALE
            });
            const exitQuote = genExitQuote({
              amountOut: tradeSize + 500_000n, // Profitable
              gasUsd: 0.01,
              timestamp: now, // Fresh
            });

            const result = gate.evaluate(entryQuote, exitQuote, tradeSize, true);
            expect(result.passed).toBe(false);
            expect(result.rejectReasons.some((r) => r.includes('stale'))).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * If combined gas exceeds $0.05, the gate MUST reject.
     */
    it('rejects when combined gas exceeds $0.05', () => {
      fc.assert(
        fc.property(
          // Entry gas above $0.025 so combined exceeds $0.05
          fc.double({ min: 0.026, max: 0.10, noNaN: true, noDefaultInfinity: true }),
          // Exit gas above $0.025
          fc.double({ min: 0.026, max: 0.10, noNaN: true, noDefaultInfinity: true }),
          fc.bigInt({ min: 5_000_000n, max: 10_000_000n }),
          (entryGas, exitGas, tradeSize) => {
            const now = 1_700_000_000_000;
            vi.setSystemTime(now);

            const entryQuote = genEntryQuote({
              amountIn: tradeSize,
              gasUsd: entryGas,
              impactBps: 5,
              timestamp: now,
            });
            const exitQuote = genExitQuote({
              amountOut: tradeSize + 1_000_000n,
              gasUsd: exitGas,
              impactBps: 5,
              timestamp: now,
            });

            const result = gate.evaluate(entryQuote, exitQuote, tradeSize, true);
            expect(result.passed).toBe(false);
            expect(result.rejectReasons.some((r) => r.includes('gas_exceeds'))).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * If price impact > 30 bps (with private RPC), the gate MUST reject.
     */
    it('rejects when entry price impact exceeds 30 bps', () => {
      fc.assert(
        fc.property(
          // Impact above 30 bps
          fc.integer({ min: 31, max: 500 }),
          fc.bigInt({ min: 5_000_000n, max: 10_000_000n }),
          (impactBps, tradeSize) => {
            const now = 1_700_000_000_000;
            vi.setSystemTime(now);

            const entryQuote = genEntryQuote({
              amountIn: tradeSize,
              gasUsd: 0.01,
              impactBps, // HIGH IMPACT
              timestamp: now,
            });
            const exitQuote = genExitQuote({
              amountOut: tradeSize + 500_000n,
              gasUsd: 0.01,
              impactBps: 5,
              timestamp: now,
            });

            const result = gate.evaluate(entryQuote, exitQuote, tradeSize, true);
            expect(result.passed).toBe(false);
            expect(result.rejectReasons.some((r) => r.includes('impact_high'))).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * If net profit < $0.08, the gate MUST reject.
     * We engineer inputs where exit proceeds barely cover costs (tiny/negative profit).
     */
    it('rejects when net profit < $0.08', () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 5_000_000n, max: 10_000_000n }),
          (tradeSize) => {
            const now = 1_700_000_000_000;
            vi.setSystemTime(now);

            // Exit amount = entry amount (zero profit before costs)
            // After subtracting gas+margin, net will be negative
            const entryQuote = genEntryQuote({
              amountIn: tradeSize,
              gasUsd: 0.02,
              impactBps: 5,
              timestamp: now,
            });
            const exitQuote = genExitQuote({
              amountOut: tradeSize, // No margin, so net profit < 0 after costs
              gasUsd: 0.02,
              impactBps: 5,
              timestamp: now,
            });

            const result = gate.evaluate(entryQuote, exitQuote, tradeSize, true);
            expect(result.passed).toBe(false);
            expect(result.rejectReasons.some((r) => r.includes('profit_below_min'))).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements 4.4**
     *
     * If expected profit > 50% of trade size (sanity check), gate MUST reject.
     */
    it('rejects when profit > 50% of trade size (sanity)', () => {
      fc.assert(
        fc.property(
          fc.bigInt({ min: 5_000_000n, max: 10_000_000n }),
          (tradeSize) => {
            const now = 1_700_000_000_000;
            vi.setSystemTime(now);

            // Exit amount is 3x the entry — clearly > 50% profit
            const exitAmount = tradeSize * 3n;

            const entryQuote = genEntryQuote({
              amountIn: tradeSize,
              gasUsd: 0.001,
              impactBps: 1,
              timestamp: now,
            });
            const exitQuote = genExitQuote({
              amountOut: exitAmount,
              gasUsd: 0.001,
              impactBps: 1,
              timestamp: now,
            });

            const result = gate.evaluate(entryQuote, exitQuote, tradeSize, true);
            expect(result.passed).toBe(false);
            expect(result.rejectReasons.some((r) => r.includes('sanity'))).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });
  });
});

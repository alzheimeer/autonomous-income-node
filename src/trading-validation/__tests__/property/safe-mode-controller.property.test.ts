/**
 * Property-based tests for SafeModeController
 *
 * **Property 19: Stricter limits without private RPC**
 * When hasPrivateRpc=false, maxSlippageBps=30 and maxPriceImpactBps=20
 * (vs 40/30 with private RPC). Tests via the MevProtectionEngine config
 * since SafeMode doesn't directly enforce slippage — this property validates
 * the MevProtection integration with SafeMode triggers.
 *
 * **Validates: Requirements E12**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  MevProtectionEngine,
  createDefaultMevConfig,
  type MevProtectionConfig,
  type ISafeModeCallback,
} from '../../mev-protection.js';
import type { ExecutableQuote } from '../../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createTrackingSafeModeCallback(): ISafeModeCallback & { triggered: boolean; details: string } {
  const tracker = {
    triggered: false,
    details: '',
    trigger(_reason: 'deviation_alerts', details: string) {
      tracker.triggered = true;
      tracker.details = details;
    },
  };
  return tracker;
}

function createQuote(overrides?: Partial<ExecutableQuote>): ExecutableQuote {
  return {
    source: 'quoter_v2',
    amountIn: 5_000_000n,         // $5 USDC
    amountOut: 2_000_000_000_000_000n, // 0.002 WETH
    priceImpactBps: 10,
    gasEstimate: 150_000n,
    gasUsd: 0.03,
    timestamp: Date.now(),
    poolFeeIncluded: true,
    externalFees: 0n,
    ttl: 10_000,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate quote amounts (WETH in wei, reasonable range for micro-trades).
 */
const quoteAmountArb = fc.bigInt(1_000_000_000_000n, 100_000_000_000_000_000n);

/**
 * Generate price impact values in bps (0-100).
 */
const priceImpactBpsArb = fc.integer({ min: 0, max: 100 });

/**
 * Generate whether private RPC is available.
 */
const hasPrivateRpcArb = fc.boolean();

// ═══════════════════════════════════════════════════════════════════════════
// Property 19: Stricter limits without private RPC
// ═══════════════════════════════════════════════════════════════════════════

describe('SafeModeController / MevProtection Property Tests', () => {
  describe('Property 19: Stricter limits without private RPC', () => {
    /**
     * **Validates: Requirements E12**
     *
     * When hasPrivateRpc=false, the effective limits are ALWAYS:
     *   maxSlippageBps = 30
     *   maxPriceImpactBps = 20
     *
     * When hasPrivateRpc=true, the effective limits are ALWAYS:
     *   maxSlippageBps = 40
     *   maxPriceImpactBps = 30
     */
    it('createDefaultMevConfig enforces correct limits based on RPC availability', () => {
      fc.assert(
        fc.property(
          hasPrivateRpcArb,
          (hasPrivateRpc) => {
            const config = createDefaultMevConfig(hasPrivateRpc);

            if (hasPrivateRpc) {
              expect(config.maxSlippageBps).toBe(40);
              expect(config.maxPriceImpactBps).toBe(30);
            } else {
              expect(config.maxSlippageBps).toBe(30);
              expect(config.maxPriceImpactBps).toBe(20);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements E12**
     *
     * Without private RPC, any quote with price impact > 20 bps is rejected.
     * With private RPC, quotes with impact <= 30 bps are accepted.
     */
    it('price impact rejection threshold is stricter without private RPC', () => {
      fc.assert(
        fc.property(
          priceImpactBpsArb,
          quoteAmountArb,
          hasPrivateRpcArb,
          (priceImpactBps, amountOut, hasPrivateRpc) => {
            const config = createDefaultMevConfig(hasPrivateRpc);
            const engine = new MevProtectionEngine(config);

            const quote = createQuote({
              amountOut,
              priceImpactBps,
            });

            const result = engine.validateQuote(quote);
            const maxImpact = hasPrivateRpc ? 30 : 20;

            if (priceImpactBps > maxImpact) {
              // Should be rejected
              expect(result.approved).toBe(false);
              expect(result.reason).toContain('Price impact');
            } else {
              // Should be approved (assuming amountOut > 0 which it is)
              expect(result.approved).toBe(true);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements E12**
     *
     * Without private RPC, minAmountOut = quote * (10000 - 30) / 10000.
     * With private RPC, minAmountOut = quote * (10000 - 40) / 10000.
     * The stricter (smaller deduction) applies without private RPC.
     */
    it('minAmountOut deduction is stricter (smaller) without private RPC', () => {
      fc.assert(
        fc.property(
          quoteAmountArb,
          (amountOut) => {
            const configWithRpc = createDefaultMevConfig(true);
            const configWithoutRpc = createDefaultMevConfig(false);

            const engineWithRpc = new MevProtectionEngine(configWithRpc);
            const engineWithoutRpc = new MevProtectionEngine(configWithoutRpc);

            const quote = createQuote({ amountOut, priceImpactBps: 5 }); // Low impact, passes both

            const resultWithRpc = engineWithRpc.validateQuote(quote);
            const resultWithoutRpc = engineWithoutRpc.validateQuote(quote);

            expect(resultWithRpc.approved).toBe(true);
            expect(resultWithoutRpc.approved).toBe(true);

            // Without private RPC: smaller slippage tolerance → HIGHER minAmountOut
            // minAmountOut(noRpc) = amount * (10000 - 30) / 10000 = amount * 9970 / 10000
            // minAmountOut(rpc)   = amount * (10000 - 40) / 10000 = amount * 9960 / 10000
            const expectedMinNoRpc = (amountOut * 9970n) / 10000n;
            const expectedMinWithRpc = (amountOut * 9960n) / 10000n;

            expect(resultWithoutRpc.minAmountOut).toBe(expectedMinNoRpc);
            expect(resultWithRpc.minAmountOut).toBe(expectedMinWithRpc);

            // Stricter = higher min (less slippage allowed)
            expect(resultWithoutRpc.minAmountOut).toBeGreaterThanOrEqual(resultWithRpc.minAmountOut);
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements E12**
     *
     * The MevProtectionEngine correctly reports its effective limits
     * matching the hasPrivateRpc configuration.
     */
    it('getEffectiveLimits always matches hasPrivateRpc config', () => {
      fc.assert(
        fc.property(
          hasPrivateRpcArb,
          (hasPrivateRpc) => {
            const config = createDefaultMevConfig(hasPrivateRpc);
            const engine = new MevProtectionEngine(config);

            const limits = engine.getEffectiveLimits();

            if (hasPrivateRpc) {
              expect(limits.maxSlippageBps).toBe(40);
              expect(limits.maxPriceImpactBps).toBe(30);
            } else {
              expect(limits.maxSlippageBps).toBe(30);
              expect(limits.maxPriceImpactBps).toBe(20);
            }
          },
        ),
        { numRuns: 200 },
      );
    });

    /**
     * **Validates: Requirements E12**
     *
     * 3 consecutive excessive slippage trades trigger Safe_Mode via callback.
     * This validates the integration between MevProtection and SafeMode triggers.
     */
    it('3 consecutive excessive slippage triggers Safe_Mode callback', () => {
      fc.assert(
        fc.property(
          quoteAmountArb,
          hasPrivateRpcArb,
          (amountOut, hasPrivateRpc) => {
            const config = createDefaultMevConfig(hasPrivateRpc);
            const safeMode = createTrackingSafeModeCallback();
            const engine = new MevProtectionEngine(config, safeMode);

            const maxSlippageBps = hasPrivateRpc ? 40 : 30;
            // Create executed amount with slippage > 1.5x estimated
            // realizedSlippage > maxSlippageBps * 1.5
            const targetSlippageBps = BigInt(Math.ceil(maxSlippageBps * 2)); // 2x estimated
            const executedAmountOut = amountOut - (amountOut * targetSlippageBps) / 10000n;

            // Ensure we have meaningful amounts (executed > 0)
            if (executedAmountOut <= 0n) return;

            // Log 3 consecutive excessive slippage trades
            for (let i = 0; i < 3; i++) {
              engine.logTradeSlippage(
                `trade-${i}`,
                amountOut,
                executedAmountOut,
                maxSlippageBps,
                5, // low price impact
              );
            }

            // Safe_Mode should have been triggered
            expect(safeMode.triggered).toBe(true);
          },
        ),
        { numRuns: 50 },
      );
    });

    /**
     * **Validates: Requirements E12**
     *
     * Fewer than 3 consecutive excessive slippage does NOT trigger Safe_Mode.
     */
    it('fewer than 3 consecutive excessive slippage does NOT trigger Safe_Mode', () => {
      fc.assert(
        fc.property(
          quoteAmountArb,
          hasPrivateRpcArb,
          fc.integer({ min: 1, max: 2 }),
          (amountOut, hasPrivateRpc, count) => {
            const config = createDefaultMevConfig(hasPrivateRpc);
            const safeMode = createTrackingSafeModeCallback();
            const engine = new MevProtectionEngine(config, safeMode);

            const maxSlippageBps = hasPrivateRpc ? 40 : 30;
            const targetSlippageBps = BigInt(Math.ceil(maxSlippageBps * 2));
            const executedAmountOut = amountOut - (amountOut * targetSlippageBps) / 10000n;

            if (executedAmountOut <= 0n) return;

            for (let i = 0; i < count; i++) {
              engine.logTradeSlippage(
                `trade-${i}`,
                amountOut,
                executedAmountOut,
                maxSlippageBps,
                5,
              );
            }

            expect(safeMode.triggered).toBe(false);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

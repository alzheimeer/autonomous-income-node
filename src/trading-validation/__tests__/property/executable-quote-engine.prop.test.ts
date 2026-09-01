/**
 * Property-based tests for ExecutableQuoteEngine
 *
 * Property 13: Quote staleness rejection — Any quote with
 * (now - quote.timestamp) > TTL (10000ms) must be rejected.
 * For any quote within TTL, it may be accepted (not guaranteed
 * due to other criteria).
 *
 * **Validates: Requirements 8.1, 15.1, 32.1**
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import {
  ExecutableQuoteEngine,
  type IQuoterV2Provider,
  type QuoterV2Result,
  type IBinancePriceProvider,
  type IGasPriceProvider,
  type IQuoteLogger,
} from '../../executable-quote-engine.js';
import type { ExecutableQuote } from '../../types.js';
import type { QuoteEngineConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Fixtures
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: QuoteEngineConfig = {
  quoterV2Address: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  swapRouterAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  wethAddress: '0x4200000000000000000000000000000000000006',
  feeTier: 500,
  quoteTtlMs: 10_000,
  basisAlertBps: 100,
};

function createMockQuoterV2(): IQuoterV2Provider {
  return {
    quoteExactInputSingle: vi.fn().mockResolvedValue({
      amountOut: 4_000_000_000_000_000n,
      sqrtPriceX96After: 1234567890n,
      initializedTicksCrossed: 1,
      gasEstimate: 150_000n,
    } as QuoterV2Result),
  };
}

function createMockBinanceProvider(): IBinancePriceProvider {
  return { getPrice: vi.fn().mockReturnValue(2500) };
}

function createMockGasPriceProvider(): IGasPriceProvider {
  return {
    getGasPrice: vi.fn().mockResolvedValue(100_000_000n),
    getEthUsdPrice: vi.fn().mockReturnValue(2500),
  };
}

function createMockLogger(): IQuoteLogger {
  return { logQuote: vi.fn() };
}

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ExecutableQuoteEngine - Property Tests', () => {
  let engine: ExecutableQuoteEngine;

  beforeEach(() => {
    vi.useFakeTimers();
    engine = new ExecutableQuoteEngine(
      DEFAULT_CONFIG,
      createMockQuoterV2(),
      createMockBinanceProvider(),
      createMockGasPriceProvider(),
      createMockLogger(),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Property 13: Quote staleness rejection
   *
   * For any quote whose age (now - quote.timestamp) exceeds its TTL (10000ms),
   * isQuoteExpired MUST return true (quote is rejected/stale).
   *
   * **Validates: Requirements 8.1, 15.1, 32.1**
   */
  describe('Property 13: Quote staleness rejection', () => {
    it('any quote with age > TTL must be expired (rejected)', () => {
      fc.assert(
        fc.property(
          // Generate a TTL between 1ms and 60_000ms (realistic range)
          fc.integer({ min: 1, max: 60_000 }),
          // Generate an age that exceeds the TTL (age > ttl)
          fc.integer({ min: 1, max: 120_000 }),
          // Generate a base timestamp
          fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
          (ttl, excessMs, baseTimestamp) => {
            // age = ttl + excessMs, always > ttl
            const age = ttl + excessMs;
            const now = baseTimestamp + age;

            // Set the current time
            vi.setSystemTime(now);

            const quote: ExecutableQuote = {
              source: 'quoter_v2',
              amountIn: 10_000000n,
              amountOut: 4_000_000_000_000_000n,
              priceImpactBps: 5,
              gasEstimate: 150_000n,
              gasUsd: 0.04,
              timestamp: baseTimestamp,
              poolFeeIncluded: true,
              externalFees: 0n,
              ttl,
            };

            // Quote with age > TTL MUST be expired
            expect(engine.isQuoteExpired(quote)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('any quote with age <= TTL is not expired (may be accepted)', () => {
      fc.assert(
        fc.property(
          // Generate a TTL between 1ms and 60_000ms
          fc.integer({ min: 1, max: 60_000 }),
          // Generate a fraction of TTL used (0 to 1.0) — age will be <= TTL
          fc.double({ min: 0, max: 1, noNaN: true }),
          // Generate a base timestamp
          fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
          (ttl, fraction, baseTimestamp) => {
            // age = floor(fraction * ttl), always <= ttl
            const age = Math.floor(fraction * ttl);
            const now = baseTimestamp + age;

            // Set the current time
            vi.setSystemTime(now);

            const quote: ExecutableQuote = {
              source: 'quoter_v2',
              amountIn: 10_000000n,
              amountOut: 4_000_000_000_000_000n,
              priceImpactBps: 5,
              gasEstimate: 150_000n,
              gasUsd: 0.04,
              timestamp: baseTimestamp,
              poolFeeIncluded: true,
              externalFees: 0n,
              ttl,
            };

            // Quote with age <= TTL is NOT expired
            expect(engine.isQuoteExpired(quote)).toBe(false);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('the default TTL of 10000ms is enforced for standard quotes', () => {
      fc.assert(
        fc.property(
          // Generate ages just above the 10s TTL boundary (10001ms to 30000ms)
          fc.integer({ min: 10_001, max: 30_000 }),
          // Generate a base timestamp
          fc.integer({ min: 1_700_000_000_000, max: 1_800_000_000_000 }),
          (age, baseTimestamp) => {
            const now = baseTimestamp + age;
            vi.setSystemTime(now);

            const quote: ExecutableQuote = {
              source: 'quoter_v2',
              amountIn: 5_000000n,
              amountOut: 2_000_000_000_000_000n,
              priceImpactBps: 10,
              gasEstimate: 150_000n,
              gasUsd: 0.04,
              timestamp: baseTimestamp,
              poolFeeIncluded: true,
              externalFees: 0n,
              ttl: 10_000, // default TTL
            };

            // Any age > 10000ms MUST be expired
            expect(engine.isQuoteExpired(quote)).toBe(true);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('quotes produced by getEntryQuote carry the configured TTL and are fresh', async () => {
      await fc.assert(
        fc.asyncProperty(
          // Generate arbitrary USDC amounts (valid trade range: $5 to $10)
          fc.bigInt({ min: 5_000000n, max: 10_000000n }),
          async (amountUsdc) => {
            const now = Date.now();
            vi.setSystemTime(now);

            const quote = await engine.getEntryQuote(amountUsdc);

            // Quotes obtained from the engine carry the configured TTL
            expect(quote.ttl).toBe(DEFAULT_CONFIG.quoteTtlMs);
            // Freshly obtained quotes are never expired
            expect(engine.isQuoteExpired(quote)).toBe(false);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

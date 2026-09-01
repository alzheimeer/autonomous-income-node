/**
 * Property-based tests for ExecutableQuoteEngine
 *
 * **Property 13: Quote staleness rejection**
 * Any quote with age > TTL (10s) is rejected. Generate random timestamps and verify.
 *
 * **Validates: Requirements 8.1, 15.1, 32.1**
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

const QUOTE_TTL_MS = 10_000;

const DEFAULT_CONFIG: QuoteEngineConfig = {
  quoterV2Address: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  swapRouterAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  wethAddress: '0x4200000000000000000000000000000000000006',
  feeTier: 500,
  quoteTtlMs: QUOTE_TTL_MS,
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
// Property 13: Quote staleness rejection
// ═══════════════════════════════════════════════════════════════════════════

describe('ExecutableQuoteEngine - Property 13: Quote staleness rejection', () => {
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
   * **Validates: Requirements 8.1, 15.1, 32.1**
   *
   * For ANY random timestamp where (now - timestamp) > 10000ms,
   * the quote MUST be identified as expired/stale.
   */
  it('rejects any quote whose age exceeds 10s TTL regardless of timestamp', () => {
    fc.assert(
      fc.property(
        // Random base timestamp (realistic Unix ms range)
        fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 }),
        // Random excess beyond TTL (1ms to 5 minutes)
        fc.integer({ min: 1, max: 300_000 }),
        (quoteTimestamp, excessMs) => {
          const quoteAge = QUOTE_TTL_MS + excessMs; // Always > TTL
          const now = quoteTimestamp + quoteAge;

          vi.setSystemTime(now);

          const quote: ExecutableQuote = {
            source: 'quoter_v2',
            amountIn: 10_000000n,
            amountOut: 4_000_000_000_000_000n,
            priceImpactBps: 5,
            gasEstimate: 150_000n,
            gasUsd: 0.03,
            timestamp: quoteTimestamp,
            poolFeeIncluded: true,
            externalFees: 0n,
            ttl: QUOTE_TTL_MS,
          };

          expect(engine.isQuoteExpired(quote)).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * **Validates: Requirements 8.1, 15.1, 32.1**
   *
   * For ANY random timestamp where (now - timestamp) <= 10000ms,
   * the quote MUST NOT be identified as expired.
   */
  it('accepts any quote whose age is within 10s TTL', () => {
    fc.assert(
      fc.property(
        // Random base timestamp
        fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 }),
        // Random age within TTL [0, 10000]
        fc.integer({ min: 0, max: QUOTE_TTL_MS }),
        (quoteTimestamp, age) => {
          const now = quoteTimestamp + age;
          vi.setSystemTime(now);

          const quote: ExecutableQuote = {
            source: 'quoter_v2',
            amountIn: 10_000000n,
            amountOut: 4_000_000_000_000_000n,
            priceImpactBps: 5,
            gasEstimate: 150_000n,
            gasUsd: 0.03,
            timestamp: quoteTimestamp,
            poolFeeIncluded: true,
            externalFees: 0n,
            ttl: QUOTE_TTL_MS,
          };

          expect(engine.isQuoteExpired(quote)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });

  /**
   * **Validates: Requirements 8.1, 15.1, 32.1**
   *
   * Boundary property: at exactly TTL+1ms the quote is stale,
   * at exactly TTL ms the quote is not stale.
   */
  it('boundary: age=TTL is valid, age=TTL+1 is stale', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 }),
        (quoteTimestamp) => {
          const quote: ExecutableQuote = {
            source: 'quoter_v2',
            amountIn: 7_500000n,
            amountOut: 3_000_000_000_000_000n,
            priceImpactBps: 8,
            gasEstimate: 150_000n,
            gasUsd: 0.04,
            timestamp: quoteTimestamp,
            poolFeeIncluded: true,
            externalFees: 0n,
            ttl: QUOTE_TTL_MS,
          };

          // Exactly at TTL boundary — NOT expired
          vi.setSystemTime(quoteTimestamp + QUOTE_TTL_MS);
          expect(engine.isQuoteExpired(quote)).toBe(false);

          // One millisecond beyond TTL — expired
          vi.setSystemTime(quoteTimestamp + QUOTE_TTL_MS + 1);
          expect(engine.isQuoteExpired(quote)).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

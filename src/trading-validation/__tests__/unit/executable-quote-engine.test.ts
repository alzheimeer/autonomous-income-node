/**
 * Unit tests for ExecutableQuoteEngine
 *
 * Tests QuoterV2 quoting, aggregator comparison, TTL enforcement,
 * price impact calculation, basis guard, and quote logging.
 *
 * Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 20.3
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ExecutableQuoteEngine,
  type IQuoterV2Provider,
  type QuoterV2Result,
  type IAggregatorProvider,
  type IBinancePriceProvider,
  type IGasPriceProvider,
  type IQuoteLogger,
  type QuoteLogEntry,
} from '../../executable-quote-engine.js';
import type { QuoteEngineConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
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

const AGGREGATOR_ROUTER = '0xAggregator0000000000000000000000000001';
const ALLOWLIST = [
  DEFAULT_CONFIG.usdcAddress,
  DEFAULT_CONFIG.wethAddress,
  DEFAULT_CONFIG.swapRouterAddress,
  DEFAULT_CONFIG.quoterV2Address,
  AGGREGATOR_ROUTER,
];

// ~$2500 WETH/USDC price
const BINANCE_PRICE = 2500;

// 10 USDC = 10_000000 (6 decimals)
const TEN_USDC = 10_000000n;

// Expected WETH for 10 USDC at ~$2500: 0.004 WETH = 4_000_000_000_000_000
const EXPECTED_WETH = 4_000_000_000_000_000n; // 0.004 WETH (18 decimals)

// 0.004 WETH
const SMALL_WETH = 4_000_000_000_000_000n;

// Expected USDC for 0.004 WETH: ~10 USDC
const EXPECTED_USDC_OUT = 9_975_000n; // ~$9.975 (slight impact)

function createMockQuoterV2(amountOut: bigint = EXPECTED_WETH): IQuoterV2Provider {
  return {
    quoteExactInputSingle: vi.fn().mockResolvedValue({
      amountOut,
      sqrtPriceX96After: 1234567890n,
      initializedTicksCrossed: 1,
      gasEstimate: 150_000n,
    } as QuoterV2Result),
  };
}

function createMockBinanceProvider(price: number | null = BINANCE_PRICE): IBinancePriceProvider {
  return {
    getPrice: vi.fn().mockReturnValue(price),
  };
}

function createMockGasPriceProvider(): IGasPriceProvider {
  return {
    getGasPrice: vi.fn().mockResolvedValue(100_000_000n), // 0.1 gwei
    getEthUsdPrice: vi.fn().mockReturnValue(2500),
  };
}

function createMockLogger(): IQuoteLogger & { entries: QuoteLogEntry[] } {
  const entries: QuoteLogEntry[] = [];
  return {
    entries,
    logQuote: vi.fn((entry: QuoteLogEntry) => { entries.push(entry); }),
  };
}

function createMockAggregator(amountOut: bigint): IAggregatorProvider {
  return {
    getQuote: vi.fn().mockResolvedValue({
      amountOut,
      gasEstimate: 200_000n,
      externalFees: 1000n,
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ExecutableQuoteEngine', () => {
  let quoterV2: IQuoterV2Provider;
  let binanceProvider: IBinancePriceProvider;
  let gasPriceProvider: IGasPriceProvider;
  let logger: ReturnType<typeof createMockLogger>;
  let engine: ExecutableQuoteEngine;

  beforeEach(() => {
    quoterV2 = createMockQuoterV2();
    binanceProvider = createMockBinanceProvider();
    gasPriceProvider = createMockGasPriceProvider();
    logger = createMockLogger();
    engine = new ExecutableQuoteEngine(
      DEFAULT_CONFIG,
      quoterV2,
      binanceProvider,
      gasPriceProvider,
      logger,
    );
  });

  describe('getEntryQuote()', () => {
    it('calls QuoterV2 with correct parameters for USDC→WETH', async () => {
      await engine.getEntryQuote(TEN_USDC);

      expect(quoterV2.quoteExactInputSingle).toHaveBeenCalledWith({
        tokenIn: DEFAULT_CONFIG.usdcAddress,
        tokenOut: DEFAULT_CONFIG.wethAddress,
        amountIn: TEN_USDC,
        fee: 500,
        sqrtPriceLimitX96: 0n,
      });
    });

    it('returns an ExecutableQuote with correct fields', async () => {
      const quote = await engine.getEntryQuote(TEN_USDC);

      expect(quote.source).toBe('quoter_v2');
      expect(quote.amountIn).toBe(TEN_USDC);
      expect(quote.amountOut).toBe(EXPECTED_WETH);
      expect(quote.gasEstimate).toBe(150_000n);
      expect(quote.poolFeeIncluded).toBe(true);
      expect(quote.externalFees).toBe(0n);
      expect(quote.ttl).toBe(10_000);
      expect(typeof quote.timestamp).toBe('number');
      expect(typeof quote.gasUsd).toBe('number');
      expect(typeof quote.priceImpactBps).toBe('number');
    });

    it('calculates gasUsd correctly', async () => {
      // gasUnits=150,000, gasPrice=0.1 gwei (100_000_000 wei), ethUsd=$2500
      // gasWei = 150,000 * 100,000,000 = 15,000,000,000,000 wei = 0.000015 ETH
      // gasUsd = 0.000015 * 2500 = $0.0375
      const quote = await engine.getEntryQuote(TEN_USDC);

      expect(quote.gasUsd).toBeCloseTo(0.0375, 4);
    });

    it('logs the quote to the logger', async () => {
      await engine.getEntryQuote(TEN_USDC);

      expect(logger.logQuote).toHaveBeenCalled();
      expect(logger.entries.length).toBe(1);
      expect(logger.entries[0].source).toBe('quoter_v2');
      expect(logger.entries[0].direction).toBe('entry');
      expect(logger.entries[0].amountIn).toBe(TEN_USDC.toString());
      expect(logger.entries[0].amountOut).toBe(EXPECTED_WETH.toString());
      expect(logger.entries[0].selected).toBe(true);
    });

    it('sets poolFeeIncluded = true for QuoterV2', async () => {
      const quote = await engine.getEntryQuote(TEN_USDC);

      expect(quote.poolFeeIncluded).toBe(true);
    });

    it('includes price impact in the quote', async () => {
      const quote = await engine.getEntryQuote(TEN_USDC);

      // The mock returns exactly the theoretical output, so impact should be 0
      expect(quote.priceImpactBps).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getExitQuote()', () => {
    it('calls QuoterV2 with correct parameters for WETH→USDC', async () => {
      const exitQuoter = createMockQuoterV2(EXPECTED_USDC_OUT);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        exitQuoter,
        binanceProvider,
        gasPriceProvider,
        logger,
      );

      await eng.getExitQuote(SMALL_WETH);

      expect(exitQuoter.quoteExactInputSingle).toHaveBeenCalledWith({
        tokenIn: DEFAULT_CONFIG.wethAddress,
        tokenOut: DEFAULT_CONFIG.usdcAddress,
        amountIn: SMALL_WETH,
        fee: 500,
        sqrtPriceLimitX96: 0n,
      });
    });

    it('returns an ExecutableQuote for exit direction', async () => {
      const exitQuoter = createMockQuoterV2(EXPECTED_USDC_OUT);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        exitQuoter,
        binanceProvider,
        gasPriceProvider,
        logger,
      );

      const quote = await eng.getExitQuote(SMALL_WETH);

      expect(quote.source).toBe('quoter_v2');
      expect(quote.amountIn).toBe(SMALL_WETH);
      expect(quote.amountOut).toBe(EXPECTED_USDC_OUT);
      expect(quote.poolFeeIncluded).toBe(true);
    });

    it('logs the exit quote', async () => {
      const exitQuoter = createMockQuoterV2(EXPECTED_USDC_OUT);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        exitQuoter,
        binanceProvider,
        gasPriceProvider,
        logger,
      );

      await eng.getExitQuote(SMALL_WETH);

      expect(logger.entries.length).toBe(1);
      expect(logger.entries[0].direction).toBe('exit');
    });
  });

  describe('Aggregator comparison', () => {
    it('does NOT use aggregator when not configured', async () => {
      const aggProvider = createMockAggregator(EXPECTED_WETH + 1000n);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG, // no aggregatorRouter
        quoterV2,
        binanceProvider,
        gasPriceProvider,
        logger,
        aggProvider,
        ALLOWLIST,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(quote.source).toBe('quoter_v2');
      expect(aggProvider.getQuote).not.toHaveBeenCalled();
    });

    it('does NOT use aggregator when router is not in allowlist', async () => {
      const aggProvider = createMockAggregator(EXPECTED_WETH + 1000n);
      const configWithAgg = { ...DEFAULT_CONFIG, aggregatorRouter: AGGREGATOR_ROUTER };
      const eng = new ExecutableQuoteEngine(
        configWithAgg,
        quoterV2,
        binanceProvider,
        gasPriceProvider,
        logger,
        aggProvider,
        [], // empty allowlist
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(quote.source).toBe('quoter_v2');
      expect(aggProvider.getQuote).not.toHaveBeenCalled();
    });

    it('uses aggregator when configured AND allowlisted', async () => {
      const betterAmount = EXPECTED_WETH + 100_000_000_000n; // slightly more
      const aggProvider = createMockAggregator(betterAmount);
      const configWithAgg = { ...DEFAULT_CONFIG, aggregatorRouter: AGGREGATOR_ROUTER };
      const eng = new ExecutableQuoteEngine(
        configWithAgg,
        quoterV2,
        binanceProvider,
        gasPriceProvider,
        logger,
        aggProvider,
        ALLOWLIST,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(aggProvider.getQuote).toHaveBeenCalled();
      expect(quote.source).toBe('aggregator');
      expect(quote.amountOut).toBe(betterAmount);
    });

    it('selects QuoterV2 when it returns more than aggregator', async () => {
      const worseAmount = EXPECTED_WETH - 100_000_000_000n; // less than quoterV2
      const aggProvider = createMockAggregator(worseAmount);
      const configWithAgg = { ...DEFAULT_CONFIG, aggregatorRouter: AGGREGATOR_ROUTER };
      const eng = new ExecutableQuoteEngine(
        configWithAgg,
        quoterV2,
        binanceProvider,
        gasPriceProvider,
        logger,
        aggProvider,
        ALLOWLIST,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(quote.source).toBe('quoter_v2');
      expect(quote.amountOut).toBe(EXPECTED_WETH);
    });

    it('logs both quotes when aggregator is compared', async () => {
      const betterAmount = EXPECTED_WETH + 100_000_000_000n;
      const aggProvider = createMockAggregator(betterAmount);
      const configWithAgg = { ...DEFAULT_CONFIG, aggregatorRouter: AGGREGATOR_ROUTER };
      const eng = new ExecutableQuoteEngine(
        configWithAgg,
        quoterV2,
        binanceProvider,
        gasPriceProvider,
        logger,
        aggProvider,
        ALLOWLIST,
      );

      await eng.getEntryQuote(TEN_USDC);

      // Should have logged the aggregator (selected) and quoterV2 (rejected)
      const selectedEntries = logger.entries.filter((e) => e.selected);
      const rejectedEntries = logger.entries.filter((e) => !e.selected);
      expect(selectedEntries.length).toBe(1);
      expect(selectedEntries[0].source).toBe('aggregator');
      expect(rejectedEntries.length).toBe(1);
      expect(rejectedEntries[0].source).toBe('quoter_v2');
    });

    it('falls back to QuoterV2 when aggregator throws', async () => {
      const aggProvider: IAggregatorProvider = {
        getQuote: vi.fn().mockRejectedValue(new Error('Aggregator timeout')),
      };
      const configWithAgg = { ...DEFAULT_CONFIG, aggregatorRouter: AGGREGATOR_ROUTER };
      const eng = new ExecutableQuoteEngine(
        configWithAgg,
        quoterV2,
        binanceProvider,
        gasPriceProvider,
        logger,
        aggProvider,
        ALLOWLIST,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(quote.source).toBe('quoter_v2');
      expect(quote.amountOut).toBe(EXPECTED_WETH);
    });

    it('sets poolFeeIncluded = false for aggregator quotes', async () => {
      const betterAmount = EXPECTED_WETH + 100_000_000_000n;
      const aggProvider = createMockAggregator(betterAmount);
      const configWithAgg = { ...DEFAULT_CONFIG, aggregatorRouter: AGGREGATOR_ROUTER };
      const eng = new ExecutableQuoteEngine(
        configWithAgg,
        quoterV2,
        binanceProvider,
        gasPriceProvider,
        logger,
        aggProvider,
        ALLOWLIST,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(quote.poolFeeIncluded).toBe(false);
      expect(quote.externalFees).toBe(1000n);
    });
  });

  describe('TTL enforcement', () => {
    it('quote has configured TTL', async () => {
      const quote = await engine.getEntryQuote(TEN_USDC);

      expect(quote.ttl).toBe(10_000);
    });

    it('isQuoteExpired returns false for fresh quote', async () => {
      const quote = await engine.getEntryQuote(TEN_USDC);

      expect(engine.isQuoteExpired(quote)).toBe(false);
    });

    it('isQuoteExpired returns true for old quote', async () => {
      const quote = await engine.getEntryQuote(TEN_USDC);
      // Manually backdate timestamp
      quote.timestamp = Date.now() - 11_000; // 11 seconds ago

      expect(engine.isQuoteExpired(quote)).toBe(true);
    });

    it('isQuoteExpired returns false at exactly TTL boundary', async () => {
      const quote = await engine.getEntryQuote(TEN_USDC);
      // Exactly at TTL boundary
      quote.timestamp = Date.now() - 10_000;

      // At exactly TTL, age === ttl, which is NOT > ttl
      expect(engine.isQuoteExpired(quote)).toBe(false);
    });
  });

  describe('Price impact calculation', () => {
    it('calculates zero impact when output matches Binance reference', async () => {
      // 10 USDC at $2500/WETH = 0.004 WETH = 4_000_000_000_000_000
      const perfectQuoter = createMockQuoterV2(4_000_000_000_000_000n);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        perfectQuoter,
        binanceProvider,
        gasPriceProvider,
        logger,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(quote.priceImpactBps).toBe(0);
    });

    it('calculates positive impact when output is less than theoretical', async () => {
      // Output 1% less than theoretical: 0.00396 WETH
      const lessQuoter = createMockQuoterV2(3_960_000_000_000_000n);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        lessQuoter,
        binanceProvider,
        gasPriceProvider,
        logger,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      // 1% impact = 100 bps
      expect(quote.priceImpactBps).toBe(100);
    });

    it('returns 0 impact when Binance price is null', async () => {
      const nullBinance = createMockBinanceProvider(null);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        quoterV2,
        nullBinance,
        gasPriceProvider,
        logger,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(quote.priceImpactBps).toBe(0);
    });

    it('impact is always non-negative', async () => {
      // Output MORE than theoretical (shouldn't happen normally, but defensive)
      const moreQuoter = createMockQuoterV2(4_100_000_000_000_000n);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        moreQuoter,
        binanceProvider,
        gasPriceProvider,
        logger,
      );

      const quote = await eng.getEntryQuote(TEN_USDC);

      expect(quote.priceImpactBps).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getBinanceReference()', () => {
    it('returns the Binance reference price', () => {
      expect(engine.getBinanceReference()).toBe(BINANCE_PRICE);
    });

    it('returns null when provider returns null', () => {
      const nullBinance = createMockBinanceProvider(null);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        quoterV2,
        nullBinance,
        gasPriceProvider,
        logger,
      );

      expect(eng.getBinanceReference()).toBeNull();
    });
  });

  describe('checkBasis()', () => {
    it('returns false when basis is within threshold (< 100 bps)', () => {
      // 0.5% difference = 50 bps
      const onChain = 2500;
      const binance = 2512.5; // 0.5% above

      expect(engine.checkBasis(onChain, binance)).toBe(false);
    });

    it('returns true when basis exceeds threshold (> 100 bps)', () => {
      // 2% difference = 200 bps
      const onChain = 2500;
      const binance = 2550; // 2% above

      expect(engine.checkBasis(onChain, binance)).toBe(true);
    });

    it('returns false when basis exactly equals threshold (100 bps)', () => {
      // Exactly 1% difference = 100 bps
      const binance = 2500;
      const onChain = 2525; // exactly 1% above

      // |2525 - 2500| / 2500 * 10000 = 100 bps — NOT > 100, so false
      expect(engine.checkBasis(onChain, binance)).toBe(false);
    });

    it('returns true when Binance price is zero (invalid)', () => {
      expect(engine.checkBasis(2500, 0)).toBe(true);
    });

    it('returns true when on-chain price is zero (invalid)', () => {
      expect(engine.checkBasis(0, 2500)).toBe(true);
    });

    it('returns true when on-chain price is negative', () => {
      expect(engine.checkBasis(-1, 2500)).toBe(true);
    });

    it('handles basis calculation symmetrically', () => {
      // Whether on-chain is above or below Binance, uses absolute value
      const result1 = engine.checkBasis(2600, 2500); // on-chain higher
      const result2 = engine.checkBasis(2400, 2500); // on-chain lower

      // Both have 4% basis = 400 bps > 100 bps threshold
      expect(result1).toBe(true);
      expect(result2).toBe(true);
    });
  });

  describe('quote timestamp', () => {
    it('uses current time as timestamp', async () => {
      const before = Date.now();
      const quote = await engine.getEntryQuote(TEN_USDC);
      const after = Date.now();

      expect(quote.timestamp).toBeGreaterThanOrEqual(before);
      expect(quote.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('exit quote logging', () => {
    it('logs exit quotes with correct direction', async () => {
      const exitQuoter = createMockQuoterV2(EXPECTED_USDC_OUT);
      const eng = new ExecutableQuoteEngine(
        DEFAULT_CONFIG,
        exitQuoter,
        binanceProvider,
        gasPriceProvider,
        logger,
      );

      await eng.getExitQuote(SMALL_WETH);

      expect(logger.entries[0].direction).toBe('exit');
      expect(logger.entries[0].amountIn).toBe(SMALL_WETH.toString());
    });
  });
});

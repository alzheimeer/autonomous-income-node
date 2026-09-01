/**
 * PriceDataFetcher — Unit Tests
 *
 * Tests symbol mapping, hourly price fetching, null return on failure,
 * and proper CandleCache integration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PriceDataFetcher } from './price-fetcher.js';
import type { CandleData } from '../types.js';

// Mock CandleCache to avoid real network calls
const mockGetCandles = vi.fn();
const mockCandleCache = {
  getCandles: mockGetCandles,
  hasCachedData: vi.fn(),
  invalidate: vi.fn(),
  getCacheFilePath: vi.fn(),
} as any;

describe('PriceDataFetcher', () => {
  let fetcher: PriceDataFetcher;

  beforeEach(() => {
    vi.clearAllMocks();
    fetcher = new PriceDataFetcher(mockCandleCache);
  });

  describe('toBinanceSymbol', () => {
    it('maps ETH to ETHUSDC', () => {
      expect(fetcher.toBinanceSymbol('ETH')).toBe('ETHUSDC');
    });

    it('maps BTC to BTCUSDC', () => {
      expect(fetcher.toBinanceSymbol('BTC')).toBe('BTCUSDC');
    });

    it('maps SOL to SOLUSDC', () => {
      expect(fetcher.toBinanceSymbol('SOL')).toBe('SOLUSDC');
    });

    it('maps ARB to ARBUSDC', () => {
      expect(fetcher.toBinanceSymbol('ARB')).toBe('ARBUSDC');
    });

    it('handles lowercase input by normalizing to uppercase', () => {
      expect(fetcher.toBinanceSymbol('eth')).toBe('ETHUSDC');
      expect(fetcher.toBinanceSymbol('btc')).toBe('BTCUSDC');
    });

    it('handles mixed case input', () => {
      expect(fetcher.toBinanceSymbol('Eth')).toBe('ETHUSDC');
    });

    it('trims whitespace from input', () => {
      expect(fetcher.toBinanceSymbol('  ETH  ')).toBe('ETHUSDC');
    });

    it('maps WBTC to BTCUSDC (special case)', () => {
      expect(fetcher.toBinanceSymbol('WBTC')).toBe('BTCUSDC');
    });

    it('maps WETH to ETHUSDC (special case)', () => {
      expect(fetcher.toBinanceSymbol('WETH')).toBe('ETHUSDC');
    });
  });

  describe('getHourlyPrices', () => {
    const sampleCandles: CandleData[] = [
      { timestamp: 1700000000000, open: 2000, high: 2050, low: 1990, close: 2020, volume: 5000 },
      { timestamp: 1700003600000, open: 2020, high: 2060, low: 2010, close: 2040, volume: 4800 },
      { timestamp: 1700007200000, open: 2040, high: 2080, low: 2030, close: 2070, volume: 5200 },
    ];

    it('returns candle data when available', async () => {
      mockGetCandles.mockResolvedValue(sampleCandles);

      const result = await fetcher.getHourlyPrices('ETH', 90);

      expect(result).toEqual(sampleCandles);
      expect(mockGetCandles).toHaveBeenCalledWith('ETHUSDC', '1h', 90, 0);
    });

    it('calls CandleCache with correct Binance symbol', async () => {
      mockGetCandles.mockResolvedValue(sampleCandles);

      await fetcher.getHourlyPrices('BTC', 30);

      expect(mockGetCandles).toHaveBeenCalledWith('BTCUSDC', '1h', 30, 0);
    });

    it('uses 1h timeframe and 0 warmup candles', async () => {
      mockGetCandles.mockResolvedValue(sampleCandles);

      await fetcher.getHourlyPrices('SOL', 60);

      expect(mockGetCandles).toHaveBeenCalledWith('SOLUSDC', '1h', 60, 0);
    });

    it('returns null when CandleCache throws an error', async () => {
      mockGetCandles.mockRejectedValue(new Error('Binance API error: 400 Bad Request'));

      const result = await fetcher.getHourlyPrices('UNKNOWNCOIN', 90);

      expect(result).toBeNull();
    });

    it('returns null when CandleCache returns empty array', async () => {
      mockGetCandles.mockResolvedValue([]);

      const result = await fetcher.getHourlyPrices('ETH', 90);

      expect(result).toBeNull();
    });

    it('returns null when CandleCache returns null/undefined', async () => {
      mockGetCandles.mockResolvedValue(null);

      const result = await fetcher.getHourlyPrices('ETH', 90);

      expect(result).toBeNull();
    });

    it('handles lowercase coin input correctly', async () => {
      mockGetCandles.mockResolvedValue(sampleCandles);

      const result = await fetcher.getHourlyPrices('eth', 90);

      expect(result).toEqual(sampleCandles);
      expect(mockGetCandles).toHaveBeenCalledWith('ETHUSDC', '1h', 90, 0);
    });

    it('does not throw on network failure — returns null instead', async () => {
      mockGetCandles.mockRejectedValue(new Error('Network timeout'));

      const result = await fetcher.getHourlyPrices('ETH', 90);

      expect(result).toBeNull();
    });
  });

  describe('constructor', () => {
    it('creates a default CandleCache when none is provided', () => {
      // Should not throw — uses the default constructor
      const defaultFetcher = new PriceDataFetcher();
      expect(defaultFetcher).toBeDefined();
    });

    it('uses the provided CandleCache instance', async () => {
      const customCache = { getCandles: vi.fn().mockResolvedValue([]) } as any;
      const customFetcher = new PriceDataFetcher(customCache);

      await customFetcher.getHourlyPrices('ETH', 30);

      expect(customCache.getCandles).toHaveBeenCalled();
    });
  });
});

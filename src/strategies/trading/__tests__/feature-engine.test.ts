/**
 * Unit tests for FeatureEngine — validates technical indicator calculations
 * against known values from well-documented formulas.
 */

import { describe, it, expect } from 'vitest';
import { FeatureEngine, type CandleData } from '../feature-engine.js';

// Helper: generate synthetic candle data with known properties
function generateCandles(prices: number[], baseVolume = 1000): CandleData[] {
  return prices.map((close, i) => ({
    timestamp: Date.now() - (prices.length - i) * 3600_000,
    open: close - 1,
    high: close + 2,
    low: close - 2,
    close,
    volume: baseVolume + Math.random() * 100,
  }));
}

// Strong uptrend: 100 to 200 over 200 candles (enough for EMA200)
const uptrendPrices = Array.from({ length: 200 }, (_, i) => 100 + i * 0.5);
// Strong downtrend: 200 to 100 over 200 candles
const downtrendPrices = Array.from({ length: 200 }, (_, i) => 200 - i * 0.5);
// Flat/ranging: all around 100 ± small noise
const rangingPrices = Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i * 0.3) * 0.2);

describe('FeatureEngine', () => {
  const engine = new FeatureEngine({ enabled: true });

  describe('EMA calculation', () => {
    it('EMA of constant series equals the constant', () => {
      const data = Array(50).fill(100);
      expect(engine.calcEMA(data, 20)).toBeCloseTo(100, 5);
    });

    it('EMA20 responds faster than EMA50 to price changes', () => {
      // Prices jump from 100 to 200 at midpoint
      const data = [...Array(25).fill(100), ...Array(25).fill(200)];
      const ema20 = engine.calcEMA(data, 20);
      const ema50 = engine.calcEMA(data, 50);
      // EMA20 should be closer to 200 (recent value)
      expect(ema20).toBeGreaterThan(ema50);
      expect(ema20).toBeGreaterThan(150);
    });

    it('returns last value if data length < period', () => {
      const data = [50, 60, 70];
      expect(engine.calcEMA(data, 20)).toBe(70);
    });
  });

  describe('RSI calculation', () => {
    it('RSI of pure uptrend is close to 100', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
      const rsi = engine.calcRSI(prices, 14);
      expect(rsi).toBeGreaterThan(90);
    });

    it('RSI of pure downtrend is close to 0', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 130 - i);
      const rsi = engine.calcRSI(prices, 14);
      expect(rsi).toBeLessThan(10);
    });

    it('RSI of flat market returns 100 (no losses)', () => {
      // When all changes are 0, avgLoss = 0, RSI formula gives 100
      const prices = Array(30).fill(100);
      const rsi = engine.calcRSI(prices, 14);
      expect(rsi).toBe(100);
    });

    it('RSI is bounded between 0 and 100', () => {
      const randomPrices = Array.from({ length: 50 }, () => 100 + Math.random() * 20 - 10);
      const rsi = engine.calcRSI(randomPrices, 14);
      expect(rsi).toBeGreaterThanOrEqual(0);
      expect(rsi).toBeLessThanOrEqual(100);
    });
  });

  describe('MACD calculation', () => {
    it('MACD is positive in uptrend', () => {
      const prices = Array.from({ length: 50 }, (_, i) => 100 + i * 2);
      const macd = engine.calcMACD(prices);
      expect(macd.value).toBeGreaterThan(0);
    });

    it('MACD is negative in downtrend', () => {
      const prices = Array.from({ length: 50 }, (_, i) => 200 - i * 2);
      const macd = engine.calcMACD(prices);
      expect(macd.value).toBeLessThan(0);
    });

    it('returns zeros if insufficient data', () => {
      const prices = Array.from({ length: 20 }, (_, i) => 100 + i);
      const macd = engine.calcMACD(prices);
      expect(macd.value).toBe(0);
      expect(macd.signal).toBe(0);
      expect(macd.histogram).toBe(0);
    });
  });

  describe('ATR calculation', () => {
    it('ATR is positive for non-flat data', () => {
      const candles = generateCandles(uptrendPrices);
      const highs = candles.map(c => c.high);
      const lows = candles.map(c => c.low);
      const closes = candles.map(c => c.close);
      const atr = engine.calcATR(highs, lows, closes, 14);
      expect(atr).toBeGreaterThan(0);
    });

    it('ATR of zero-range candles is zero', () => {
      const flat = Array(30).fill(null).map(() => ({
        timestamp: 0, open: 100, high: 100, low: 100, close: 100, volume: 1000,
      }));
      const atr = engine.calcATR(
        flat.map(c => c.high),
        flat.map(c => c.low),
        flat.map(c => c.close),
        14,
      );
      expect(atr).toBe(0);
    });
  });

  describe('Bollinger Bands calculation', () => {
    it('middle band equals SMA', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
      const bb = engine.calcBollingerBands(prices, 20, 2);
      // SMA of last 20: (11..30) with values 110..129
      const last20 = prices.slice(-20);
      const expectedMiddle = last20.reduce((a, b) => a + b, 0) / 20;
      expect(bb.middle).toBeCloseTo(expectedMiddle, 5);
    });

    it('upper > middle > lower', () => {
      const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
      const bb = engine.calcBollingerBands(prices, 20, 2);
      expect(bb.upper).toBeGreaterThan(bb.middle);
      expect(bb.middle).toBeGreaterThan(bb.lower);
    });

    it('bands are equal for constant prices', () => {
      const prices = Array(30).fill(100);
      const bb = engine.calcBollingerBands(prices, 20, 2);
      expect(bb.upper).toBe(100);
      expect(bb.middle).toBe(100);
      expect(bb.lower).toBe(100);
    });
  });

  describe('Volume Z-score', () => {
    it('returns 0 for uniform volume', () => {
      const volumes = Array(30).fill(1000);
      const z = engine.calcVolumeZScore(volumes, 20);
      expect(z).toBe(0);
    });

    it('returns positive Z for anomalously high volume', () => {
      // Need varying volumes so stddev > 0
      const volumes = Array.from({ length: 30 }, (_, i) => 1000 + (i % 3) * 50);
      volumes[29] = 5000; // last candle has much higher volume
      const z = engine.calcVolumeZScore(volumes, 20);
      expect(z).toBeGreaterThan(2);
    });

    it('returns negative Z for anomalously low volume', () => {
      const volumes = Array.from({ length: 30 }, (_, i) => 1000 + (i % 3) * 50);
      volumes[29] = 10; // last candle has very low volume
      const z = engine.calcVolumeZScore(volumes, 20);
      expect(z).toBeLessThan(-2);
    });
  });

  describe('Regime Detection', () => {
    it('detects TRENDING_UP in uptrend', () => {
      const candles = generateCandles(uptrendPrices);
      const features = engine.calculateFeatures(candles, 'ETHUSDC', '1h');
      expect(features.regime).toBe('TRENDING_UP');
    });

    it('detects TRENDING_DOWN in downtrend', () => {
      const candles = generateCandles(downtrendPrices);
      const features = engine.calculateFeatures(candles, 'ETHUSDC', '1h');
      expect(features.regime).toBe('TRENDING_DOWN');
    });

    it('detects RANGING or UNCERTAIN in flat market', () => {
      const candles = generateCandles(rangingPrices);
      const features = engine.calculateFeatures(candles, 'ETHUSDC', '1h');
      expect(['RANGING', 'UNCERTAIN']).toContain(features.regime);
    });
  });

  describe('formatForContext', () => {
    it('produces readable multi-line string', () => {
      const candles = generateCandles(uptrendPrices);
      const features = engine.calculateFeatures(candles, 'ETHUSDC', '1h');
      const text = engine.formatForContext(features);
      expect(text).toContain('## Technical Indicators');
      expect(text).toContain('ETHUSDC');
      expect(text).toContain('RSI14');
      expect(text).toContain('MACD');
      expect(text).toContain('Regime');
    });
  });

  describe('Cache behavior', () => {
    it('getCachedFeatures returns null when no cache', () => {
      const freshEngine = new FeatureEngine({ enabled: true });
      expect(freshEngine.getCachedFeatures('UNKNOWN')).toBeNull();
    });

    it('clearCache empties the cache', () => {
      const testEngine = new FeatureEngine({ enabled: true });
      // Manually populate cache by calculating
      const candles = generateCandles(uptrendPrices);
      testEngine.calculateFeatures(candles, 'TEST', '1h');
      // We can't directly test cache without the async flow, but clearCache should not throw
      testEngine.clearCache();
      expect(testEngine.getCachedFeatures('TEST')).toBeNull();
    });
  });
});

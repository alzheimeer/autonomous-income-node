/**
 * Unit tests for IncrementalFeatureEngine.
 *
 * Validates incremental candle feeding, indicator computation,
 * regime detection, and state reset for backtesting.
 *
 * Requirements: 9.1, 9.2, 9.5
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { IncrementalFeatureEngine } from '../incremental-feature-engine.js';
import type { CandleData } from '../../trading-validation/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function makeCandle(index: number, basePrice = 2000): CandleData {
  const price = basePrice + index * 10;
  return {
    timestamp: 1_700_000_000_000 + index * 900_000, // 15m intervals
    open: price - 5,
    high: price + 15,
    low: price - 10,
    close: price,
    volume: 100 + index * 5,
  };
}

function makeCandles(count: number, basePrice = 2000): CandleData[] {
  return Array.from({ length: count }, (_, i) => makeCandle(i, basePrice));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('IncrementalFeatureEngine', () => {
  let engine: IncrementalFeatureEngine;

  beforeEach(() => {
    engine = new IncrementalFeatureEngine();
  });

  // ─── addCandle ──────────────────────────────────────────────────────────

  describe('addCandle', () => {
    it('appends candles to the 15m buffer', () => {
      const candle = makeCandle(0);
      engine.addCandle('15m', candle);
      // Verify by checking computeIndicators returns null (only 1 candle)
      expect(engine.computeIndicators('15m')).toBeNull();
    });

    it('appends candles to the 1h buffer', () => {
      const candle = makeCandle(0);
      engine.addCandle('1h', candle);
      expect(engine.computeIndicators('1h')).toBeNull();
    });

    it('keeps 15m and 1h buffers separate', () => {
      const candles15m = makeCandles(30);
      const candles1h = makeCandles(10);
      for (const c of candles15m) engine.addCandle('15m', c);
      for (const c of candles1h) engine.addCandle('1h', c);

      // 15m has 30 candles (>= 26) → should compute
      expect(engine.computeIndicators('15m')).not.toBeNull();
      // 1h has 10 candles (< 26) → null
      expect(engine.computeIndicators('1h')).toBeNull();
    });
  });

  // ─── computeIndicators ──────────────────────────────────────────────────

  describe('computeIndicators', () => {
    it('returns null when fewer than 26 candles available', () => {
      const candles = makeCandles(25);
      for (const c of candles) engine.addCandle('15m', c);
      expect(engine.computeIndicators('15m')).toBeNull();
    });

    it('returns Indicators when exactly 26 candles are available', () => {
      const candles = makeCandles(26);
      for (const c of candles) engine.addCandle('15m', c);
      const result = engine.computeIndicators('15m');
      expect(result).not.toBeNull();
    });

    it('returns correct shape with all indicator fields', () => {
      const candles = makeCandles(50);
      for (const c of candles) engine.addCandle('15m', c);
      const result = engine.computeIndicators('15m')!;

      expect(result).toHaveProperty('ema20');
      expect(result).toHaveProperty('ema50');
      expect(result).toHaveProperty('ema200');
      expect(result).toHaveProperty('rsi14');
      expect(result).toHaveProperty('atr14');
      expect(result).toHaveProperty('volumeZScore');
      expect(result).toHaveProperty('bollingerBands');
      expect(result).toHaveProperty('lastPrice');
      expect(result).toHaveProperty('candleCount');
      expect(result.candleCount).toBe(50);
    });

    it('lastPrice equals the close of the most recent candle', () => {
      const candles = makeCandles(30);
      for (const c of candles) engine.addCandle('15m', c);
      const result = engine.computeIndicators('15m')!;
      expect(result.lastPrice).toBe(candles[candles.length - 1].close);
    });

    it('uses ema50 as fallback for ema200 when fewer than 200 candles', () => {
      const candles = makeCandles(50);
      for (const c of candles) engine.addCandle('15m', c);
      const result = engine.computeIndicators('15m')!;
      // With < 200 candles, ema200 should equal ema50
      expect(result.ema200).toBe(result.ema50);
    });

    it('computes ema200 properly when >= 200 candles', () => {
      const candles = makeCandles(210);
      for (const c of candles) engine.addCandle('15m', c);
      const result = engine.computeIndicators('15m')!;
      // With >= 200 candles, ema200 should differ from ema50
      expect(result.ema200).not.toBe(result.ema50);
    });

    it('RSI is between 0 and 100', () => {
      const candles = makeCandles(50);
      for (const c of candles) engine.addCandle('15m', c);
      const result = engine.computeIndicators('15m')!;
      expect(result.rsi14).toBeGreaterThanOrEqual(0);
      expect(result.rsi14).toBeLessThanOrEqual(100);
    });

    it('bollinger bands upper >= middle >= lower', () => {
      const candles = makeCandles(50);
      for (const c of candles) engine.addCandle('15m', c);
      const result = engine.computeIndicators('15m')!;
      expect(result.bollingerBands.upper).toBeGreaterThanOrEqual(result.bollingerBands.middle);
      expect(result.bollingerBands.middle).toBeGreaterThanOrEqual(result.bollingerBands.lower);
    });
  });

  // ─── getRegime ──────────────────────────────────────────────────────────

  describe('getRegime', () => {
    it('returns UNCERTAIN when fewer than 26 1h candles', () => {
      const candles = makeCandles(20);
      for (const c of candles) engine.addCandle('1h', c);
      expect(engine.getRegime()).toBe('UNCERTAIN');
    });

    it('returns a valid RegimeType when sufficient data', () => {
      // Create uptrending candles (prices increasing)
      const candles = makeCandles(60);
      for (const c of candles) engine.addCandle('1h', c);
      const regime = engine.getRegime();
      expect(['TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE', 'UNCERTAIN']).toContain(regime);
    });

    it('detects TRENDING_UP with consistently rising prices', () => {
      // Large sample of consistently rising prices
      const candles = makeCandles(210, 1000);
      for (const c of candles) engine.addCandle('1h', c);
      const regime = engine.getRegime();
      // With steadily increasing prices, price > ema50 > ema200
      expect(regime).toBe('TRENDING_UP');
    });

    it('detects TRENDING_DOWN with consistently falling prices', () => {
      // Create falling price candles
      const candles = Array.from({ length: 210 }, (_, i) => ({
        timestamp: 1_700_000_000_000 + i * 3_600_000,
        open: 5000 - i * 10 + 5,
        high: 5000 - i * 10 + 15,
        low: 5000 - i * 10 - 10,
        close: 5000 - i * 10,
        volume: 100 + i * 2,
      }));
      for (const c of candles) engine.addCandle('1h', c);
      const regime = engine.getRegime();
      expect(regime).toBe('TRENDING_DOWN');
    });

    it('uses only 1h candles for regime detection', () => {
      // Feed only 15m candles — regime should be UNCERTAIN
      const candles = makeCandles(100);
      for (const c of candles) engine.addCandle('15m', c);
      expect(engine.getRegime()).toBe('UNCERTAIN');
    });
  });

  // ─── reset ──────────────────────────────────────────────────────────────

  describe('reset', () => {
    it('clears both 15m and 1h buffers', () => {
      const candles = makeCandles(30);
      for (const c of candles) engine.addCandle('15m', c);
      for (const c of candles) engine.addCandle('1h', c);

      // Verify data exists before reset
      expect(engine.computeIndicators('15m')).not.toBeNull();
      expect(engine.computeIndicators('1h')).not.toBeNull();

      // Reset and verify cleared
      engine.reset();
      expect(engine.computeIndicators('15m')).toBeNull();
      expect(engine.computeIndicators('1h')).toBeNull();
    });

    it('regime returns UNCERTAIN after reset', () => {
      const candles = makeCandles(60);
      for (const c of candles) engine.addCandle('1h', c);
      expect(engine.getRegime()).not.toBe('UNCERTAIN');

      engine.reset();
      expect(engine.getRegime()).toBe('UNCERTAIN');
    });

    it('allows feeding new candles after reset (Req 9.5)', () => {
      const candles = makeCandles(30);
      for (const c of candles) engine.addCandle('15m', c);
      engine.reset();

      // Feed new data
      const newCandles = makeCandles(30, 3000);
      for (const c of newCandles) engine.addCandle('15m', c);
      const result = engine.computeIndicators('15m')!;

      expect(result).not.toBeNull();
      // lastPrice should be from the new candles
      expect(result.lastPrice).toBe(newCandles[newCandles.length - 1].close);
    });
  });

  // ─── No-lookahead (Req 9.1, 9.2) ───────────────────────────────────────

  describe('no-lookahead guarantee', () => {
    it('indicators only reflect candles fed so far', () => {
      const candles = makeCandles(50);

      // Feed first 30 candles
      for (let i = 0; i < 30; i++) engine.addCandle('15m', candles[i]);
      const result30 = engine.computeIndicators('15m')!;

      // Feed remaining 20 candles
      for (let i = 30; i < 50; i++) engine.addCandle('15m', candles[i]);
      const result50 = engine.computeIndicators('15m')!;

      // Results should differ — more data changes EMAs, RSI, etc.
      expect(result50.ema20).not.toBe(result30.ema20);
      expect(result50.lastPrice).not.toBe(result30.lastPrice);
      expect(result50.candleCount).toBe(50);
      expect(result30.candleCount).toBe(30);
    });
  });
});

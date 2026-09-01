/**
 * Unit tests for StrategyEngine
 *
 * Tests cover: Trend Pullback conditions, Mean Reversion conditions,
 * cooldown enforcement, warmup checks, regime filtering, confidence scoring,
 * TTL, and position-open blocking.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StrategyEngine } from '../../strategy-engine.js';
import type { Indicators } from '../../strategy-engine.js';
import type { StrategyEngineConfig } from '../../config.js';
import type { RegimeType } from '../../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function defaultConfig(): StrategyEngineConfig {
  return {
    pair: 'WETH/USDC',
    regimeTimeframe: '1h',
    entryTimeframe: '15m',
    stopLossAtr: 1.5,
    takeProfitAtr: 2.0,
    cooldownMs: 3_600_000, // 60 min
    warmup1h: 300,
    warmup15m: 500,
    meanRevAtrMax: 2.5,
    minLiquidity: 50_000,
    volumeZThreshold: 1.0,
  };
}

/** Indicators that satisfy Trend Pullback conditions (15m) */
function trendPullbackIndicators15m(): Indicators {
  return {
    ema20: 3000,
    ema50: 2950,
    ema200: 2800,
    rsi14: 42, // in [35, 50]
    atr14: 30, // $30 ATR
    volumeZScore: 1.5, // > 1.0
    bollingerBands: { upper: 3100, middle: 3000, lower: 2900 },
    lastPrice: 3005, // within 0.5% of EMA20 (3000): 0.17%
    candleCount: 600,
  };
}

/** 1h indicators for warmup */
function warmedUp1hIndicators(): Indicators {
  return {
    ema20: 3000,
    ema50: 2950,
    ema200: 2800,
    rsi14: 55,
    atr14: 50,
    volumeZScore: 1.2,
    bollingerBands: { upper: 3200, middle: 3000, lower: 2800 },
    lastPrice: 3000,
    candleCount: 350, // >= 300
  };
}

/** Indicators that satisfy Mean Reversion conditions (15m) */
function meanReversionIndicators15m(): Indicators {
  return {
    ema20: 3000,
    ema50: 3010,
    ema200: 3050,
    rsi14: 25, // < 30
    atr14: 30,
    volumeZScore: 1.5, // > 1.0
    bollingerBands: { upper: 3100, middle: 3000, lower: 2900 },
    lastPrice: 2895, // <= lower Bollinger (2900)
    candleCount: 600,
  };
}

/** 1h indicators for mean reversion (ATR large enough so ratio < 2.5) */
function meanReversion1hIndicators(): Indicators {
  return {
    ema20: 3000,
    ema50: 3010,
    ema200: 3050,
    rsi14: 45,
    atr14: 50, // 15m ATR (30) / 1h ATR (50) = 0.6 < 2.5
    volumeZScore: 1.0,
    bollingerBands: { upper: 3200, middle: 3000, lower: 2800 },
    lastPrice: 3000,
    candleCount: 350,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('StrategyEngine', () => {
  let engine: StrategyEngine;

  beforeEach(() => {
    engine = new StrategyEngine(defaultConfig());
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-15T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Warmup', () => {
    it('returns null when 1h candle count is below warmup threshold', () => {
      const ind1h = { ...warmedUp1hIndicators(), candleCount: 200 }; // < 300
      const ind15m = trendPullbackIndicators15m();
      const result = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');
      expect(result).toBeNull();
    });

    it('returns null when 15m candle count is below warmup threshold', () => {
      const ind1h = warmedUp1hIndicators();
      const ind15m = { ...trendPullbackIndicators15m(), candleCount: 400 }; // < 500
      const result = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');
      expect(result).toBeNull();
    });

    it('allows evaluation when both timeframes are warmed up', () => {
      const ind1h = warmedUp1hIndicators();
      const ind15m = trendPullbackIndicators15m();
      const result = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');
      expect(result).not.toBeNull();
    });
  });

  describe('Regime Filtering', () => {
    it('returns null for TRENDING_DOWN regime', () => {
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_DOWN',
      );
      expect(result).toBeNull();
    });

    it('evaluates dip_buying for VOLATILE regime', () => {
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'VOLATILE',
      );
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('dip_buying');
    });

    it('evaluates dip_buying for UNCERTAIN regime', () => {
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'UNCERTAIN',
      );
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('dip_buying');
    });

    it('allows TRENDING_UP regime', () => {
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );
      expect(result).not.toBeNull();
    });

    it('allows RANGING regime for mean reversion', () => {
      const result = engine.evaluate(
        meanReversion1hIndicators(),
        meanReversionIndicators15m(),
        'RANGING',
      );
      expect(result).not.toBeNull();
    });
  });

  describe('Position Open Blocking', () => {
    it('returns null when position is open', () => {
      engine.setPositionOpen(true);
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );
      expect(result).toBeNull();
    });

    it('allows signal after position closed', () => {
      engine.setPositionOpen(true);
      engine.setPositionOpen(false);
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );
      expect(result).not.toBeNull();
    });
  });

  describe('Cooldown Enforcement', () => {
    it('enforces 60-minute cooldown between signals', () => {
      const ind1h = warmedUp1hIndicators();
      const ind15m = trendPullbackIndicators15m();

      // First signal succeeds
      const first = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');
      expect(first).not.toBeNull();

      // Immediate second attempt blocked
      const blocked = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');
      expect(blocked).toBeNull();

      // After 30 min — still blocked
      vi.advanceTimersByTime(30 * 60_000);
      const stillBlocked = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');
      expect(stillBlocked).toBeNull();

      // After full 60 min — allowed
      vi.advanceTimersByTime(30 * 60_000 + 1);
      const allowed = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');
      expect(allowed).not.toBeNull();
    });

    it('getCooldownRemaining returns correct value', () => {
      engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );

      expect(engine.getCooldownRemaining()).toBe(3_600_000);

      vi.advanceTimersByTime(1_000_000);
      expect(engine.getCooldownRemaining()).toBe(2_600_000);

      vi.advanceTimersByTime(2_600_001);
      expect(engine.getCooldownRemaining()).toBe(0);
    });
  });

  describe('Trend Pullback Strategy', () => {
    it('generates signal when all conditions met', () => {
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('trend_pullback');
      expect(result!.pair).toBe('WETH/USDC');
      expect(result!.direction).toBe('long');
      expect(result!.regime).toBe('TRENDING_UP');
    });

    it('rejects when price is too far from EMA20 (> 2.0%)', () => {
      const ind = { ...trendPullbackIndicators15m(), lastPrice: 3070 }; // > 2.0% away from 3000
      const result = engine.evaluate(warmedUp1hIndicators(), ind, 'TRENDING_UP');
      expect(result).toBeNull();
    });

    it('rejects when RSI is below 30', () => {
      const ind = { ...trendPullbackIndicators15m(), rsi14: 29 };
      const result = engine.evaluate(warmedUp1hIndicators(), ind, 'TRENDING_UP');
      if (result) expect(result.strategy).not.toBe('trend_pullback');
      else expect(result).toBeNull();
    });

    it('rejects when RSI is above 48', () => {
      const ind = { ...trendPullbackIndicators15m(), rsi14: 49 };
      const result = engine.evaluate(warmedUp1hIndicators(), ind, 'TRENDING_UP');
      if (result) expect(result.strategy).not.toBe('trend_pullback');
      else expect(result).toBeNull();
    });



    it('rejects when EMA20 <= EMA50', () => {
      const ind = { ...trendPullbackIndicators15m(), ema20: 2940 }; // < ema50 (2950)
      const result = engine.evaluate(warmedUp1hIndicators(), ind, 'TRENDING_UP');
      if (result) expect(result.strategy).not.toBe('trend_pullback');
      else expect(result).toBeNull();
    });

    it('rejects when close <= EMA50', () => {
      const ind = { ...trendPullbackIndicators15m(), lastPrice: 2950, ema20: 2955 };
      // lastPrice 2950 == ema50 2950 → rejected (must be strictly >)
      const result = engine.evaluate(warmedUp1hIndicators(), ind, 'TRENDING_UP');
      if (result) expect(result.strategy).not.toBe('trend_pullback');
      else expect(result).toBeNull();
    });
  });

  describe('Mean Reversion Strategy', () => {
    it('generates signal when all conditions met', () => {
      const result = engine.evaluate(
        meanReversion1hIndicators(),
        meanReversionIndicators15m(),
        'RANGING',
      );
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('mean_reversion');
      expect(result!.pair).toBe('WETH/USDC');
      expect(result!.direction).toBe('long');
      expect(result!.regime).toBe('RANGING');
    });

    it('rejects when price is above lower Bollinger by > 0.5%', () => {
      const ind = { ...meanReversionIndicators15m(), lastPrice: 2920 }; // > 0.5% above 2900
      const result = engine.evaluate(meanReversion1hIndicators(), ind, 'RANGING');
      expect(result).toBeNull();
    });

    it('rejects when RSI >= 38', () => {
      const ind = { ...meanReversionIndicators15m(), rsi14: 38 };
      const result = engine.evaluate(meanReversion1hIndicators(), ind, 'RANGING');
      if (result) expect(result.strategy).not.toBe('mean_reversion');
      else expect(result).toBeNull();
    });

    it('rejects when range ratio >= meanRevAtrMax', () => {
      // 15m ATR = 130, 1h ATR = 50 → ratio = 2.6 >= 2.5
      const ind15m = { ...meanReversionIndicators15m(), atr14: 130 };
      const ind1h = { ...meanReversion1hIndicators(), atr14: 50 };
      const result = engine.evaluate(ind1h, ind15m, 'RANGING');
      expect(result).toBeNull();
    });
  });

  describe('TradeCandidate Output', () => {
    it('has correct TTL of 60 seconds', () => {
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );
      expect(result).not.toBeNull();
      expect(result!.expiresAt - result!.createdAt).toBe(60_000);
    });

    it('has a unique ID', () => {
      const r1 = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );

      vi.advanceTimersByTime(3_600_001); // past cooldown

      const r2 = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );

      expect(r1).not.toBeNull();
      expect(r2).not.toBeNull();
      expect(r1!.id).not.toBe(r2!.id);
    });

    it('confidence is between 0 and 1', () => {
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );
      expect(result).not.toBeNull();
      expect(result!.confidence).toBeGreaterThanOrEqual(0);
      expect(result!.confidence).toBeLessThanOrEqual(1);
    });

    it('stopDistanceFraction uses ATR formula', () => {
      const config = defaultConfig();
      const ind15m = { ...trendPullbackIndicators15m(), atr14: 60 }; // Make ATR large enough to surpass minimum SL threshold
      const expectedStop = Math.max(0.015, (config.stopLossAtr * ind15m.atr14) / ind15m.lastPrice);

      const result = engine.evaluate(
        warmedUp1hIndicators(),
        ind15m,
        'TRENDING_UP',
      );
      expect(result).not.toBeNull();
      expect(result!.stopDistanceFraction).toBeCloseTo(expectedStop, 8);
    });

    it('takeProfitFraction uses ATR formula', () => {
      const config = defaultConfig();
      const ind15m = { ...trendPullbackIndicators15m(), atr14: 60 };
      const expectedTP = Math.max(0.020, (config.takeProfitAtr * ind15m.atr14) / ind15m.lastPrice);

      const result = engine.evaluate(
        warmedUp1hIndicators(),
        ind15m,
        'TRENDING_UP',
      );
      expect(result).not.toBeNull();
      expect(result!.takeProfitFraction).toBeCloseTo(expectedTP, 8);
    });
  });

  describe('Confidence Score Determinism', () => {
    it('same inputs produce same confidence', () => {
      const ind1h = warmedUp1hIndicators();
      const ind15m = trendPullbackIndicators15m();

      const r1 = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');
      vi.advanceTimersByTime(3_600_001);
      const r2 = engine.evaluate(ind1h, ind15m, 'TRENDING_UP');

      expect(r1!.confidence).toBe(r2!.confidence);
    });
  });

  describe('Max 1 Signal Per Evaluation', () => {
    it('returns at most one candidate even if both strategies could fire', () => {
      // TRENDING_UP only triggers trend_pullback, RANGING only triggers mean_reversion
      // So by design max 1 per evaluation (regime determines which strategy is checked)
      const result = engine.evaluate(
        warmedUp1hIndicators(),
        trendPullbackIndicators15m(),
        'TRENDING_UP',
      );
      expect(result).not.toBeNull();
      expect(result!.strategy).toBe('trend_pullback');
    });
  });

  describe('hasOpenPosition', () => {
    it('returns false initially', () => {
      expect(engine.hasOpenPosition()).toBe(false);
    });

    it('returns true after setPositionOpen(true)', () => {
      engine.setPositionOpen(true);
      expect(engine.hasOpenPosition()).toBe(true);
    });
  });
});

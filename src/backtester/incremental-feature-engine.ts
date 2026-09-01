/**
 * IncrementalFeatureEngine — Candle-by-candle feature computation for backtesting.
 *
 * Wraps the existing FeatureEngine's calculation methods to compute indicators
 * incrementally as candles are fed one at a time. Ensures no-lookahead by only
 * computing from data available at or before the current timestamp.
 *
 * Requirements: 9.1, 9.2, 9.5
 */

import type { Indicators } from '../trading-validation/strategy-engine.js';
import type { RegimeType } from '../trading-validation/types.js';
import type { CandleData } from '../trading-validation/types.js';

// ═══════════════════════════════════════════════════════════════════════════════
// IncrementalFeatureEngine
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimum candles required to compute indicators (MACD needs 26).
 */
const MIN_CANDLES = 26;

export class IncrementalFeatureEngine {
  private candles15m: CandleData[] = [];
  private candles1h: CandleData[] = [];

  /**
   * Append a candle to the internal buffer for the given timeframe.
   * Candles should be fed in chronological order.
   */
  addCandle(timeframe: '15m' | '1h', candle: CandleData): void {
    if (timeframe === '15m') {
      this.candles15m.push(candle);
    } else {
      this.candles1h.push(candle);
    }
  }

  /**
   * Compute indicators from the accumulated candles for the given timeframe.
   * Returns null if fewer than 26 candles are available (minimum for MACD).
   */
  computeIndicators(timeframe: '15m' | '1h'): Indicators | null {
    const candles = timeframe === '15m' ? this.candles15m : this.candles1h;
    if (candles.length < MIN_CANDLES) return null;

    const closes = candles.map(c => c.close);
    const lastPrice = closes[closes.length - 1];

    return {
      ema20: this.ema(closes, 20),
      ema50: this.ema(closes, 50),
      ema200: candles.length >= 200 ? this.ema(closes, 200) : this.ema(closes, 50),
      rsi14: this.rsi(closes, 14),
      atr14: this.atr(candles, 14),
      volumeZScore: this.volumeZ(candles),
      bollingerBands: this.bollinger(closes, 20),
      lastPrice,
      candleCount: candles.length,
    };
  }

  /**
   * Determine market regime from the 1h candle buffer.
   * Returns 'UNCERTAIN' if insufficient data (< 26 candles).
   */
  getRegime(): RegimeType {
    if (this.candles1h.length < MIN_CANDLES) return 'UNCERTAIN';

    const closes = this.candles1h.map(c => c.close);
    const ema50 = this.ema(closes, 50);
    const ema200 = this.candles1h.length >= 200
      ? this.ema(closes, 200)
      : this.ema(closes, 50);
    const lastPrice = closes[closes.length - 1];

    // Simple regime classification (same as ShadowFeatureEngineAdapter)
    if (lastPrice > ema50 && ema50 > ema200) return 'TRENDING_UP';
    if (lastPrice < ema50 && ema50 < ema200) return 'TRENDING_DOWN';

    // Check volatility via ATR/price ratio
    const atr = this.atr(this.candles1h, 14);
    const atrPct = atr / lastPrice;
    if (atrPct > 0.04) return 'VOLATILE';

    return 'RANGING';
  }

  /**
   * Clear all internal candle buffers. Call between backtest runs to
   * prevent state leakage (Requirement 9.5).
   */
  reset(): void {
    this.candles15m = [];
    this.candles1h = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Technical Indicator Calculations (pure math, no external dependencies)
  // ═══════════════════════════════════════════════════════════════════════════

  private ema(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] ?? 0;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  private rsi(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;

    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    // Initial average gain/loss (Wilder's smoothing)
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
      if (changes[i] > 0) avgGain += changes[i];
      else avgLoss += Math.abs(changes[i]);
    }
    avgGain /= period;
    avgLoss /= period;

    // Wilder's smoothing for remaining values
    for (let i = period; i < changes.length; i++) {
      const change = changes[i];
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? Math.abs(change) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }

    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private atr(candles: CandleData[], period: number): number {
    if (candles.length < period + 1) return 0;
    const recent = candles.slice(-(period + 1));
    let sumTR = 0;
    for (let i = 1; i <= period; i++) {
      const cur = recent[i];
      const prev = recent[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      sumTR += tr;
    }
    return sumTR / period;
  }

  private volumeZ(candles: CandleData[]): number {
    if (candles.length < 20) return 0;
    const volumes = candles.slice(-20).map(c => c.volume);
    const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const variance = volumes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / volumes.length;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return (volumes[volumes.length - 1] - mean) / std;
  }

  private bollinger(closes: number[], period: number): { upper: number; middle: number; lower: number } {
    if (closes.length < period) {
      const last = closes[closes.length - 1] ?? 0;
      return { upper: last, middle: last, lower: last };
    }
    const recent = closes.slice(-period);
    const mean = recent.reduce((a, b) => a + b, 0) / period;
    const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    return {
      upper: mean + 2 * std,
      middle: mean,
      lower: mean - 2 * std,
    };
  }
}

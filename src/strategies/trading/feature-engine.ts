/**
 * FeatureEngine — Technical indicators for informed trading decisions.
 *
 * Calculates standard technical indicators from candle (OHLCV) data
 * and provides them to the LLM via context injection.
 *
 * Indicators: EMA 20/50/200, RSI 14, MACD (12,26,9), ATR 14,
 * Bollinger Bands (20,2), Volume Z-score (20), Regime Detection.
 *
 * Data source: Binance public API (free, no key required, 1200 req/min).
 * Fallback: CoinGecko OHLC endpoint.
 *
 * All calculations are pure math — zero external dependencies beyond axios.
 */

import axios from 'axios';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface FeatureEngineConfig {
  /** Binance API base URL. Default: 'https://api.binance.com' */
  binanceBaseUrl: string;
  /** CoinGecko API base URL (fallback). Default: 'https://api.coingecko.com' */
  coingeckoBaseUrl: string;
  /** Default trading pair for Binance. Default: 'ETHUSDC' */
  defaultPair: string;
  /** All pairs to monitor. Default: ['ETHUSDC', 'BTCUSDC', 'SOLUSDC'] */
  pairs: string[];
  /** Default candle interval. Default: '1h' */
  defaultInterval: string;
  /** Number of candles to fetch. Default: 200 (enough for EMA200) */
  candleLimit: number;
  /** Cache TTL in milliseconds. Default: 300_000 (5 minutes) */
  cacheTtlMs: number;
  /** Whether feature engine is enabled. Default: true */
  enabled: boolean;
}

export const DEFAULT_FEATURE_ENGINE_CONFIG: FeatureEngineConfig = {
  binanceBaseUrl: 'https://api.binance.com',
  coingeckoBaseUrl: 'https://api.coingecko.com',
  defaultPair: 'ETHUSDC',
  pairs: ['ETHUSDC', 'BTCUSDC', 'SOLUSDC'],
  defaultInterval: '1h',
  candleLimit: 200,
  cacheTtlMs: 300_000,
  enabled: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type MarketRegime =
  | 'TRENDING_UP'
  | 'TRENDING_DOWN'
  | 'RANGING'
  | 'VOLATILE'
  | 'UNCERTAIN';

export interface MACDValues {
  value: number;
  signal: number;
  histogram: number;
}

export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
}

export interface VolumeProfile {
  poc: number;  // Point of Control (highest volume price level)
  vah: number;  // Value Area High (70% volume upper bound)
  val: number;  // Value Area Low (70% volume lower bound)
}

export interface TechnicalFeatures {
  pair: string;
  interval: string;
  ema20: number;
  ema50: number;
  ema200: number;
  rsi14: number;
  macd: MACDValues;
  atr14: number;
  volumeZScore: number;
  bollingerBands: BollingerBands;
  hurstExponent: number;
  volumeProfile: VolumeProfile;
  regime: MarketRegime;
  lastPrice: number;
  updatedAt: number;
}

interface CacheEntry {
  features: TechnicalFeatures;
  expiresAt: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FeatureEngine
// ═══════════════════════════════════════════════════════════════════════════════

export class FeatureEngine {
  private readonly config: FeatureEngineConfig;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(config: Partial<FeatureEngineConfig> = {}) {
    this.config = { ...DEFAULT_FEATURE_ENGINE_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Get latest technical features for a pair.
   * Returns cached if fresh, otherwise fetches + calculates.
   */
  async getFeatures(
    pair?: string,
    interval?: string,
  ): Promise<TechnicalFeatures | null> {
    if (!this.config.enabled) return null;

    const p = pair ?? this.config.defaultPair;
    const i = interval ?? this.config.defaultInterval;
    const cacheKey = `${p}_${i}`;

    // Check cache
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.features;
    }

    // Fetch and calculate
    try {
      const candles = await this.fetchCandles(p, i, this.config.candleLimit);
      if (candles.length < 200) {
        console.warn(`[FeatureEngine] Only ${candles.length} candles for ${p} (need 200 for EMA200)`);
        if (candles.length < 26) {
          console.error('[FeatureEngine] Not enough candles for basic indicators');
          return null;
        }
      }

      const features = this.calculateFeatures(candles, p, i);

      // Cache result
      this.cache.set(cacheKey, {
        features,
        expiresAt: Date.now() + this.config.cacheTtlMs,
      });

      return features;
    } catch (err) {
      console.error('[FeatureEngine] Failed to compute features:', err);
      // Return stale cache if available
      if (cached) return cached.features;
      return null;
    }
  }

  /**
   * Get cached features without triggering a fetch.
   */
  getCachedFeatures(pair?: string, interval?: string): TechnicalFeatures | null {
    const p = pair ?? this.config.defaultPair;
    const i = interval ?? this.config.defaultInterval;
    const cached = this.cache.get(`${p}_${i}`);
    return cached?.features ?? null;
  }

  /**
   * Format features as a concise string for LLM context injection.
   */
  formatForContext(features: TechnicalFeatures): string {
    const { pair, interval, ema20, ema50, ema200, rsi14, macd, atr14, volumeZScore, bollingerBands, hurstExponent, volumeProfile, regime, lastPrice } = features;

    const rsiLabel = rsi14 > 70 ? 'overbought' : rsi14 < 30 ? 'oversold' : 'neutral';
    const macdLabel = macd.histogram > 0 ? 'bullish' : 'bearish';
    const volLabel = Math.abs(volumeZScore) > 2 ? 'anomalous' : Math.abs(volumeZScore) > 1 ? 'elevated' : 'normal';
    const hurstLabel = hurstExponent > 0.55 ? 'Trending' : hurstExponent < 0.45 ? 'Mean-Reverting' : 'Random-Walk';

    return [
      `## Technical Indicators (${pair} - ${interval})`,
      `Last Price: $${lastPrice.toFixed(2)}`,
      `EMA20: $${ema20.toFixed(2)} | EMA50: $${ema50.toFixed(2)} | EMA200: $${ema200.toFixed(2)}`,
      `RSI14: ${rsi14.toFixed(1)} (${rsiLabel})`,
      `MACD: ${macd.value > 0 ? '+' : ''}${macd.value.toFixed(2)} (${macdLabel}, signal: ${macd.signal > 0 ? '+' : ''}${macd.signal.toFixed(2)})`,
      `ATR14: $${atr14.toFixed(2)}`,
      `Volume Z-score: ${volumeZScore.toFixed(2)} (${volLabel})`,
      `Hurst Exponent: ${hurstExponent.toFixed(2)} (${hurstLabel})`,
      `Volume Profile: POC $${volumeProfile.poc.toFixed(2)} | VAL $${volumeProfile.val.toFixed(2)} | VAH $${volumeProfile.vah.toFixed(2)}`,
      `Bollinger: Lower $${bollingerBands.lower.toFixed(2)} | Mid $${bollingerBands.middle.toFixed(2)} | Upper $${bollingerBands.upper.toFixed(2)}`,
      `Regime: ${regime}`,
    ].join('\n');
  }

  /**
   * Whether the engine is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get features for ALL configured pairs (parallel fetch).
   * Returns a map of pair → TechnicalFeatures.
   */
  async getAllFeatures(): Promise<Map<string, TechnicalFeatures>> {
    if (!this.config.enabled) return new Map();

    const results = await Promise.allSettled(
      this.config.pairs.map(async (pair) => {
        const features = await this.getFeatures(pair);
        return { pair, features };
      }),
    );

    const map = new Map<string, TechnicalFeatures>();
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value.features) {
        map.set(result.value.pair, result.value.features);
      }
    }
    return map;
  }

  /**
   * Format ALL pairs for LLM context (concise multi-pair summary).
   */
  formatAllForContext(featuresMap: Map<string, TechnicalFeatures>): string {
    if (featuresMap.size === 0) return '';

    const lines: string[] = ['## Technical Indicators'];
    for (const [, features] of featuresMap) {
      const { pair, ema20, ema50, rsi14, macd, regime, lastPrice } = features;
      const macdSign = macd.histogram > 0 ? '↑' : '↓';
      lines.push(
        `${pair}: $${lastPrice.toFixed(2)} | EMA20:$${ema20.toFixed(0)} EMA50:$${ema50.toFixed(0)} | RSI:${rsi14.toFixed(0)} | MACD${macdSign} | ${regime}`,
      );
    }
    return lines.join('\n');
  }

  /**
   * Clear all cached data.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetch OHLCV candles from Binance. Falls back to CoinGecko on failure.
   */
  async fetchCandles(pair: string, interval: string, limit: number): Promise<CandleData[]> {
    try {
      return await this.fetchBinanceCandles(pair, interval, limit);
    } catch (err) {
      console.warn('[FeatureEngine] Binance failed, trying CoinGecko fallback:', (err as Error).message);
      return await this.fetchCoinGeckoCandles(pair, limit);
    }
  }

  private async fetchBinanceCandles(pair: string, interval: string, limit: number): Promise<CandleData[]> {
    const url = `${this.config.binanceBaseUrl}/api/v3/klines`;
    const response = await axios.get(url, {
      params: { symbol: pair, interval, limit },
      timeout: 10_000,
    });

    // Binance returns arrays: [openTime, open, high, low, close, volume, closeTime, ...]
    return (response.data as unknown[][]).map((k) => ({
      timestamp: k[0] as number,
      open: parseFloat(k[1] as string),
      high: parseFloat(k[2] as string),
      low: parseFloat(k[3] as string),
      close: parseFloat(k[4] as string),
      volume: parseFloat(k[5] as string),
    }));
  }

  private async fetchCoinGeckoCandles(pair: string, limit: number): Promise<CandleData[]> {
    // Map pair to CoinGecko coin ID (basic mapping)
    const coinId = pair.toLowerCase().includes('eth') ? 'ethereum' : 'bitcoin';
    const days = Math.min(Math.ceil(limit / 6), 30); // 6 candles per day (4h candles)

    const url = `${this.config.coingeckoBaseUrl}/api/v3/coins/${coinId}/ohlc`;
    const response = await axios.get(url, {
      params: { vs_currency: 'usd', days },
      timeout: 10_000,
    });

    // CoinGecko returns [timestamp, open, high, low, close]
    return (response.data as number[][]).map((k) => ({
      timestamp: k[0],
      open: k[1],
      high: k[2],
      low: k[3],
      close: k[4],
      volume: 0, // CoinGecko OHLC doesn't include volume
    }));
  }

  // ---------------------------------------------------------------------------
  // Indicator calculations — all pure math
  // ---------------------------------------------------------------------------

  /**
   * Calculate all technical features from candle data.
   */
  calculateFeatures(candles: CandleData[], pair: string, interval: string): TechnicalFeatures {
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const ema20 = this.calcEMA(closes, 20);
    const ema50 = this.calcEMA(closes, 50);
    const ema200 = candles.length >= 200 ? this.calcEMA(closes, 200) : ema50; // fallback if not enough data
    const rsi14 = this.calcRSI(closes, 14);
    const macd = this.calcMACD(closes);
    const atr14 = this.calcATR(highs, lows, closes, 14);
    const volumeZScore = this.calcVolumeZScore(volumes, 20);
    const bollingerBands = this.calcBollingerBands(closes, 20, 2);
    const hurstExponent = this.calcHurstExponent(closes);
    const volumeProfile = this.calcVolumeProfile(candles);
    const lastPrice = closes[closes.length - 1];

    const features: TechnicalFeatures = {
      pair,
      interval,
      ema20,
      ema50,
      ema200,
      rsi14,
      macd,
      atr14,
      volumeZScore,
      bollingerBands,
      hurstExponent,
      volumeProfile,
      lastPrice,
      regime: 'UNCERTAIN',
      updatedAt: Date.now(),
    };

    features.regime = this.detectRegime(features);
    return features;
  }

  /**
   * EMA (Exponential Moving Average)
   * Formula: EMA_today = close * k + EMA_yesterday * (1 - k)
   * where k = 2 / (period + 1)
   */
  calcEMA(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] ?? 0;

    const k = 2 / (period + 1);
    // Seed with SMA of first `period` values
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  /**
   * RSI (Relative Strength Index) using Wilder's smoothing
   * Formula: RSI = 100 - (100 / (1 + avgGain / avgLoss))
   */
  calcRSI(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50; // neutral default

    const changes: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i - 1]);
    }

    // Initial average gain/loss (simple average of first `period` changes)
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

  /**
   * MACD (Moving Average Convergence Divergence)
   * MACD Line = EMA12 - EMA26
   * Signal Line = EMA9 of MACD Line
   * Histogram = MACD Line - Signal Line
   */
  calcMACD(closes: number[]): MACDValues {
    if (closes.length < 26) {
      return { value: 0, signal: 0, histogram: 0 };
    }

    // Calculate MACD line for each point after index 25
    const macdLine: number[] = [];
    const k12 = 2 / 13;
    const k26 = 2 / 27;

    // Seed EMAs with SMA
    let ema12 = closes.slice(0, 12).reduce((a, b) => a + b, 0) / 12;
    let ema26 = closes.slice(0, 26).reduce((a, b) => a + b, 0) / 26;

    // Calculate EMA12 up to index 25
    for (let i = 12; i < 26; i++) {
      ema12 = closes[i] * k12 + ema12 * (1 - k12);
    }

    // Now calculate both EMAs from index 26 onwards
    for (let i = 26; i < closes.length; i++) {
      ema12 = closes[i] * k12 + ema12 * (1 - k12);
      ema26 = closes[i] * k26 + ema26 * (1 - k26);
      macdLine.push(ema12 - ema26);
    }

    if (macdLine.length === 0) {
      return { value: 0, signal: 0, histogram: 0 };
    }

    // Signal = EMA9 of MACD line
    const signal = this.calcEMA(macdLine, 9);
    const value = macdLine[macdLine.length - 1];
    const histogram = value - signal;

    return { value, signal, histogram };
  }

  /**
   * ATR (Average True Range)
   * TR = max(H-L, |H-prevClose|, |L-prevClose|)
   * ATR = SMA(TR, period)
   */
  calcATR(highs: number[], lows: number[], closes: number[], period: number): number {
    if (highs.length < period + 1) return 0;

    const trueRanges: number[] = [];
    for (let i = 1; i < highs.length; i++) {
      const hl = highs[i] - lows[i];
      const hc = Math.abs(highs[i] - closes[i - 1]);
      const lc = Math.abs(lows[i] - closes[i - 1]);
      trueRanges.push(Math.max(hl, hc, lc));
    }

    // Use Wilder's smoothing (similar to EMA with k = 1/period)
    let atr = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < trueRanges.length; i++) {
      atr = (atr * (period - 1) + trueRanges[i]) / period;
    }

    return atr;
  }

  /**
   * Volume Z-score
   * Z = (currentVolume - mean) / stddev
   * Lookback: last N candles
   */
  calcVolumeZScore(volumes: number[], lookback: number): number {
    if (volumes.length < lookback + 1) return 0;

    const recentVolumes = volumes.slice(-lookback - 1, -1); // exclude current
    const currentVolume = volumes[volumes.length - 1];

    const mean = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const variance = recentVolumes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / recentVolumes.length;
    const stddev = Math.sqrt(variance);

    if (stddev === 0) return 0;
    return (currentVolume - mean) / stddev;
  }

  /**
   * Bollinger Bands
   * Middle = SMA(close, period)
   * Upper = Middle + (stddev * multiplier)
   * Lower = Middle - (stddev * multiplier)
   */
  calcBollingerBands(closes: number[], period: number, multiplier: number): BollingerBands {
    if (closes.length < period) {
      const last = closes[closes.length - 1] ?? 0;
      return { upper: last, middle: last, lower: last };
    }

    const recent = closes.slice(-period);
    const middle = recent.reduce((a, b) => a + b, 0) / period;
    const variance = recent.reduce((sum, v) => sum + (v - middle) ** 2, 0) / period;
    const stddev = Math.sqrt(variance);

    return {
      upper: middle + stddev * multiplier,
      middle,
      lower: middle - stddev * multiplier,
    };
  }

  /**
   * Hurst Exponent (H)
   * Rescaled Range (R/S) analysis for regime classification.
   * H > 0.55 → Trending (Persistent)
   * H < 0.45 → Mean Reverting (Anti-persistent)
   * ~0.50   → Random Walk (Noise)
   */
  calcHurstExponent(closes: number[]): number {
    if (closes.length < 50) return 0.5;

    const N = Math.min(closes.length, 200);
    const subset = closes.slice(-N);

    // Returns
    const returns: number[] = [];
    for (let i = 1; i < subset.length; i++) {
      returns.push(Math.log(subset[i] / subset[i - 1]));
    }

    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;

    // Cumulative deviations from mean
    let cumDev = 0;
    const cumDevs: number[] = [];
    for (const r of returns) {
      cumDev += r - meanReturn;
      cumDevs.push(cumDev);
    }

    // Range (R) = max(cumDevs) - min(cumDevs)
    const maxDev = Math.max(...cumDevs);
    const minDev = Math.min(...cumDevs);
    const R = maxDev - minDev;

    // Standard deviation (S)
    const variance = returns.reduce((sum, r) => sum + (r - meanReturn) ** 2, 0) / returns.length;
    const S = Math.sqrt(variance);

    if (S === 0 || R === 0) return 0.5;

    // R/S ratio -> Hurst = log(R/S) / log(N)
    const RS = R / S;
    const hurst = Math.log(RS) / Math.log(returns.length);

    // Bound between 0 and 1
    return Math.max(0.01, Math.min(0.99, hurst));
  }

  /**
   * Volume Profile & Point of Control (POC)
   * Groups volume into 20 price bins across the recent candle range.
   * POC is the price level with maximum volume.
   * VAH/VAL bound ~70% of total volume.
   */
  calcVolumeProfile(candles: CandleData[], bins = 20): VolumeProfile {
    if (candles.length === 0) {
      return { poc: 0, vah: 0, val: 0 };
    }

    const recent = candles.slice(-100); // 100 most recent candles
    let minPrice = Infinity;
    let maxPrice = -Infinity;

    for (const c of recent) {
      if (c.low < minPrice) minPrice = c.low;
      if (c.high > maxPrice) maxPrice = c.high;
    }

    if (minPrice === maxPrice || !isFinite(minPrice)) {
      const last = recent[recent.length - 1]?.close ?? 0;
      return { poc: last, vah: last, val: last };
    }

    const binSize = (maxPrice - minPrice) / bins;
    const binVolumes = new Array<number>(bins).fill(0);

    for (const c of recent) {
      const mid = (c.high + c.low) / 2;
      const binIdx = Math.min(bins - 1, Math.max(0, Math.floor((mid - minPrice) / binSize)));
      binVolumes[binIdx] += c.volume;
    }

    // Find POC (bin with max volume)
    let maxVolIdx = 0;
    let maxVol = 0;
    let totalVol = 0;

    for (let i = 0; i < bins; i++) {
      totalVol += binVolumes[i];
      if (binVolumes[i] > maxVol) {
        maxVol = binVolumes[i];
        maxVolIdx = i;
      }
    }

    const poc = minPrice + (maxVolIdx + 0.5) * binSize;

    // Calculate VAH/VAL (70% Volume Area)
    const targetVol = totalVol * 0.7;
    let accumulatedVol = binVolumes[maxVolIdx];
    let lowerIdx = maxVolIdx;
    let upperIdx = maxVolIdx;

    while (accumulatedVol < targetVol && (lowerIdx > 0 || upperIdx < bins - 1)) {
      const nextLowerVol = lowerIdx > 0 ? binVolumes[lowerIdx - 1] : -1;
      const nextUpperVol = upperIdx < bins - 1 ? binVolumes[upperIdx + 1] : -1;

      if (nextUpperVol >= nextLowerVol && upperIdx < bins - 1) {
        upperIdx++;
        accumulatedVol += binVolumes[upperIdx];
      } else if (lowerIdx > 0) {
        lowerIdx--;
        accumulatedVol += binVolumes[lowerIdx];
      } else if (upperIdx < bins - 1) {
        upperIdx++;
        accumulatedVol += binVolumes[upperIdx];
      }
    }

    const val = minPrice + lowerIdx * binSize;
    const vah = minPrice + (upperIdx + 1) * binSize;

    return { poc, vah, val };
  }

  // ---------------------------------------------------------------------------
  // Regime Detection
  // ---------------------------------------------------------------------------

  /**
   * Detect market regime based on indicator combination.
   *
   * | Regime        | Conditions                                            |
   * |---------------|-------------------------------------------------------|
   * | TRENDING_UP   | EMA20 > EMA50 > EMA200, RSI > 50, MACD positive      |
   * | TRENDING_DOWN | EMA20 < EMA50 < EMA200, RSI < 50, MACD negative      |
   * | RANGING       | EMAs convergent, RSI 40-60, BB squeeze                |
   * | VOLATILE      | ATR > 2x normal, Volume Z-score > 2                  |
   * | UNCERTAIN     | Contradictory signals                                 |
   */
  detectRegime(features: TechnicalFeatures): MarketRegime {
    const { ema20, ema50, ema200, rsi14, macd, atr14, volumeZScore, bollingerBands, hurstExponent } = features;

    // Volatile: high ATR or anomalous volume
    const bbWidth = (bollingerBands.upper - bollingerBands.lower) / bollingerBands.middle;
    if (bbWidth > 0.06 && volumeZScore > 2) {
      return 'VOLATILE';
    }

    // Hurst Exponent regime confirmation
    // H > 0.55 strongly favors Trending; H < 0.45 strongly favors Ranging
    const isHurstTrending = hurstExponent > 0.55;
    const isHurstRanging = hurstExponent < 0.45;

    // Trending up: EMAs aligned bullish + RSI confirms + MACD positive
    const emasAlignedUp = ema20 > ema50 && ema50 > ema200;
    const emasAlignedDown = ema20 < ema50 && ema50 < ema200;

    if (emasAlignedUp && rsi14 > 50 && macd.value > 0 && isHurstTrending) {
      return 'TRENDING_UP';
    }

    if (emasAlignedDown && rsi14 < 50 && macd.value < 0 && isHurstTrending) {
      return 'TRENDING_DOWN';
    }

    // Ranging: EMAs convergent or Hurst < 0.45
    const emaSpread = Math.abs(ema20 - ema50) / ema50;
    const isBBSqueeze = bbWidth < 0.03;
    if ((emaSpread < 0.005 && rsi14 >= 40 && rsi14 <= 60 && isBBSqueeze) || isHurstRanging) {
      return 'RANGING';
    }

    // Partial trend (some signals align but not all)
    if (emasAlignedUp && rsi14 > 45) return 'TRENDING_UP';
    if (emasAlignedDown && rsi14 < 55) return 'TRENDING_DOWN';

    return 'UNCERTAIN';
  }
}

/**
 * Chart Routes — Live candlestick chart with indicators
 *
 * Registers two endpoints on the HeartbeatModule Fastify server (port 3000):
 *   GET /chart      — HTML page with TradingView Lightweight Charts
 *   GET /chart/data — JSON API with candles + indicators + regime + signals
 *
 * Data sources:
 *   - MarketDataManager: real-time 15m and 1h candles from Binance
 *   - FeatureEngine: EMA, RSI, MACD, ATR, Bollinger Bands, regime detection
 *
 * No authentication required (same as /health endpoint).
 */

import type { FastifyInstance } from 'fastify';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces for data providers (injected from AgentCore)
// ═══════════════════════════════════════════════════════════════════════════

export interface ChartDataProvider {
  /** Get candles from MarketDataManager (returns [] if unavailable) */
  getCandles(timeframe: '15m' | '1h'): Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  /** Get technical features from FeatureEngine (returns null if unavailable) */
  getFeatures(): {
    ema20: number;
    ema50: number;
    ema200: number;
    rsi14: number;
    macd: { value: number; signal: number; histogram: number };
    atr14: number;
    volumeZScore: number;
    bollingerBands: { upper: number; middle: number; lower: number };
    regime: string;
    lastPrice: number;
    updatedAt: number;
    pair?: string;
  } | null;
  /** Get latest price */
  getLatestPrice(): number | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Route Registration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register chart routes on the given Fastify instance.
 * Call this after the HeartbeatModule Fastify server is built.
 */
export function registerChartRoutes(
  fastify: FastifyInstance,
  getProvider: () => ChartDataProvider | null,
): void {

  // GET /chart/data — JSON API
  fastify.get('/chart/data', async (req, reply) => {
    const provider = getProvider();
    if (!provider) {
      return reply.status(503).send({
        error: 'Trading system not yet initialized',
        message: 'MarketDataManager has not started. Wait for bootstrap.',
      });
    }

    const query = req.query as { timeframe?: string };
    const timeframe = (query.timeframe === '1h' ? '1h' : '15m') as '15m' | '1h';

    const candles = provider.getCandles(timeframe);
    const features = provider.getFeatures();
    const latestPrice = provider.getLatestPrice();

    // Compute EMA series for overlay (last N candles with EMA values)
    const closes = candles.map(c => c.close);
    const ema20Series = computeEmaSeries(closes, 20, candles.map(c => c.timestamp));
    const ema50Series = computeEmaSeries(closes, 50, candles.map(c => c.timestamp));
    const ema200Series = computeEmaSeries(closes, 200, candles.map(c => c.timestamp));

    // Bollinger Bands series
    const bbSeries = computeBollingerSeries(closes, 20, 2, candles.map(c => c.timestamp));

    // RSI series
    const rsiSeries = computeRsiSeries(closes, 14, candles.map(c => c.timestamp));

    return reply.status(200).send({
      timeframe,
      candleCount: candles.length,
      latestPrice,
      regime: features?.regime ?? 'UNKNOWN',
      updatedAt: features?.updatedAt ?? null,
      indicators: features ? {
        ema20: features.ema20,
        ema50: features.ema50,
        ema200: features.ema200,
        rsi14: features.rsi14,
        macd: features.macd,
        atr14: features.atr14,
        volumeZScore: features.volumeZScore,
        bollingerBands: features.bollingerBands,
      } : null,
      // Time-series data for charting
      candles: candles.map(c => ({
        time: Math.floor(c.timestamp / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      })),
      overlays: {
        ema20: ema20Series,
        ema50: ema50Series,
        ema200: ema200Series,
        bollingerUpper: bbSeries.map(b => ({ time: b.time, value: b.upper })),
        bollingerLower: bbSeries.map(b => ({ time: b.time, value: b.lower })),
      },
      oscillators: {
        rsi: rsiSeries,
      },
    });
  });

  // GET /chart — HTML page
  fastify.get('/chart', async (_req, reply) => {
    reply.header('Content-Type', 'text/html; charset=utf-8');
    return reply.send(CHART_HTML);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Indicator Series Computation
// ═══════════════════════════════════════════════════════════════════════════

function computeEmaSeries(
  closes: number[],
  period: number,
  timestamps: number[],
): Array<{ time: number; value: number }> {
  if (closes.length < period) return [];

  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const result: Array<{ time: number; value: number }> = [];

  // Start outputting from the period-th candle
  result.push({ time: Math.floor(timestamps[period - 1]! / 1000), value: ema });

  for (let i = period; i < closes.length; i++) {
    ema = closes[i]! * k + ema * (1 - k);
    result.push({ time: Math.floor(timestamps[i]! / 1000), value: ema });
  }

  return result;
}

function computeBollingerSeries(
  closes: number[],
  period: number,
  stdDev: number,
  timestamps: number[],
): Array<{ time: number; upper: number; middle: number; lower: number }> {
  if (closes.length < period) return [];

  const result: Array<{ time: number; upper: number; middle: number; lower: number }> = [];

  for (let i = period - 1; i < closes.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    result.push({
      time: Math.floor(timestamps[i]! / 1000),
      upper: mean + stdDev * std,
      middle: mean,
      lower: mean - stdDev * std,
    });
  }

  return result;
}

function computeRsiSeries(
  closes: number[],
  period: number,
  timestamps: number[],
): Array<{ time: number; value: number }> {
  if (closes.length < period + 1) return [];

  const result: Array<{ time: number; value: number }> = [];

  // Use Wilder's smoothing (exponential)
  let avgGain = 0;
  let avgLoss = 0;

  // Initial SMA for first period
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff > 0) avgGain += diff;
    else avgLoss += -diff;
  }
  avgGain /= period;
  avgLoss /= period;

  const firstRsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  result.push({ time: Math.floor(timestamps[period]! / 1000), value: firstRsi });

  // Subsequent values with Wilder's smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    result.push({ time: Math.floor(timestamps[i]! / 1000), value: rsi });
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// HTML Template
// ═══════════════════════════════════════════════════════════════════════════

const CHART_HTML = `<!DOCTYPE html>
<html lang="en" translate="no">
<head>
  <meta charset="UTF-8">
  <meta name="google" content="notranslate">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AIN — Live Trading Chart</title>
  <script src="https://unpkg.com/lightweight-charts@4.1.3/dist/lightweight-charts.standalone.production.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #0a0a0f; color: #e0e0e0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .header { padding: 12px 20px; display: flex; align-items: center; gap: 16px; border-bottom: 1px solid #1a1a2e; }
    .header h1 { font-size: 16px; font-weight: 600; color: #fff; }
    .badge { padding: 3px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .badge-regime { background: #1a1a2e; color: #888; }
    .badge-regime.TRENDING_UP { background: #0d3320; color: #4ade80; }
    .badge-regime.TRENDING_DOWN { background: #3b1111; color: #f87171; }
    .badge-regime.RANGING { background: #1a1a2e; color: #60a5fa; }
    .badge-regime.VOLATILE { background: #3d2800; color: #fbbf24; }
    .stats { display: flex; gap: 20px; margin-left: auto; font-size: 12px; }
    .stat { display: flex; flex-direction: column; align-items: flex-end; }
    .stat-label { color: #666; font-size: 10px; text-transform: uppercase; }
    .stat-value { color: #fff; font-weight: 500; }
    .controls { padding: 8px 20px; display: flex; gap: 8px; border-bottom: 1px solid #1a1a2e; }
    .btn { padding: 4px 12px; border: 1px solid #333; border-radius: 4px; background: transparent; color: #888; cursor: pointer; font-size: 12px; }
    .btn.active { border-color: #4f8ff7; color: #4f8ff7; background: #4f8ff710; }
    .btn:hover { border-color: #555; color: #ccc; }
    #main-chart { width: 100%; height: calc(65vh - 90px); }
    #rsi-chart { width: 100%; height: 20vh; border-top: 1px solid #1a1a2e; }
    .volume-legend { position: absolute; bottom: 4px; left: 4px; font-size: 10px; color: #444; }
    .footer { padding: 8px 20px; border-top: 1px solid #1a1a2e; font-size: 11px; color: #555; display: flex; justify-content: space-between; }
    .indicators-panel { padding: 8px 20px; display: flex; gap: 16px; flex-wrap: wrap; font-size: 11px; border-bottom: 1px solid #1a1a2e; }
    .ind { display: flex; gap: 4px; }
    .ind-label { color: #666; }
    .ind-value { color: #ccc; font-weight: 500; }
    .ind-value.positive { color: #4ade80; }
    .ind-value.negative { color: #f87171; }
  </style>
</head>
<body>
  <div class="header">
    <h1>🤖 AIN Trading Chart</h1>
    <span id="regime-badge" class="badge badge-regime">—</span>
    <div class="stats">
      <div class="stat"><span class="stat-label">Price</span><span id="price" class="stat-value">—</span></div>
      <div class="stat"><span class="stat-label">RSI</span><span id="rsi" class="stat-value">—</span></div>
      <div class="stat"><span class="stat-label">ATR</span><span id="atr" class="stat-value">—</span></div>
      <div class="stat"><span class="stat-label">Candles</span><span id="count" class="stat-value">—</span></div>
    </div>
  </div>
  <div class="controls">
    <button class="btn active" data-tf="15m">15m</button>
    <button class="btn" data-tf="1h">1h</button>
    <button class="btn" id="btn-ema">EMA</button>
    <button class="btn" id="btn-bb">Bollinger</button>
  </div>
  <div class="indicators-panel" id="indicators-panel"></div>
  <div id="main-chart"></div>
  <div id="rsi-chart"></div>
  <div class="footer">
    <span id="updated">Last update: —</span>
    <span>WETH/USDC • Binance • Auto-refresh 30s</span>
  </div>

  <script>
    const { createChart } = LightweightCharts;
    let currentTf = '15m';
    let showEma = true;
    let showBb = false;

    // Main chart
    const mainEl = document.getElementById('main-chart');
    const mainChart = createChart(mainEl, {
      layout: { background: { color: '#0a0a0f' }, textColor: '#888' },
      grid: { vertLines: { color: '#111' }, horzLines: { color: '#111' } },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: '#222' },
      timeScale: { borderColor: '#222', timeVisible: true, secondsVisible: false },
    });

    const candleSeries = mainChart.addCandlestickSeries({
      upColor: '#4ade80', downColor: '#f87171',
      borderUpColor: '#4ade80', borderDownColor: '#f87171',
      wickUpColor: '#4ade80', wickDownColor: '#f87171',
    });

    const volumeSeries = mainChart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'volume',
    });
    mainChart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });

    const ema20Line = mainChart.addLineSeries({ color: '#fbbf24', lineWidth: 1, title: 'EMA20' });
    const ema50Line = mainChart.addLineSeries({ color: '#60a5fa', lineWidth: 1, title: 'EMA50' });
    const ema200Line = mainChart.addLineSeries({ color: '#a78bfa', lineWidth: 1, title: 'EMA200' });
    const bbUpper = mainChart.addLineSeries({ color: '#ffffff20', lineWidth: 1, lineStyle: 2 });
    const bbLower = mainChart.addLineSeries({ color: '#ffffff20', lineWidth: 1, lineStyle: 2 });

    // RSI chart
    const rsiEl = document.getElementById('rsi-chart');
    const rsiChart = createChart(rsiEl, {
      layout: { background: { color: '#0a0a0f' }, textColor: '#666' },
      grid: { vertLines: { color: '#111' }, horzLines: { color: '#111' } },
      rightPriceScale: { borderColor: '#222' },
      timeScale: { borderColor: '#222', timeVisible: true, secondsVisible: false, visible: false },
    });
    const rsiLine = rsiChart.addLineSeries({ color: '#a78bfa', lineWidth: 1.5, title: 'RSI 14' });
    const rsi70 = rsiChart.addLineSeries({ color: '#f8717140', lineWidth: 1, lineStyle: 2 });
    const rsi30 = rsiChart.addLineSeries({ color: '#4ade8040', lineWidth: 1, lineStyle: 2 });

    // Sync time scales
    mainChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (range) rsiChart.timeScale().setVisibleLogicalRange(range);
    });

    async function loadData() {
      try {
        const resp = await fetch('/chart/data?timeframe=' + currentTf);
        if (!resp.ok) { console.error('Chart data error:', resp.status); return; }
        const data = await resp.json();

        // Candles
        candleSeries.setData(data.candles);

        // Volume
        volumeSeries.setData(data.candles.map(c => ({
          time: c.time,
          value: c.volume,
          color: c.close >= c.open ? '#4ade8030' : '#f8717130',
        })));

        // EMA overlays
        if (showEma) {
          ema20Line.setData(data.overlays.ema20);
          ema50Line.setData(data.overlays.ema50);
          ema200Line.setData(data.overlays.ema200);
        } else {
          ema20Line.setData([]);
          ema50Line.setData([]);
          ema200Line.setData([]);
        }

        // Bollinger Bands
        if (showBb) {
          bbUpper.setData(data.overlays.bollingerUpper);
          bbLower.setData(data.overlays.bollingerLower);
        } else {
          bbUpper.setData([]);
          bbLower.setData([]);
        }

        // RSI
        const rsiData = data.oscillators.rsi;
        rsiLine.setData(rsiData);
        if (rsiData.length > 1) {
          const first = rsiData[0].time;
          const last = rsiData[rsiData.length - 1].time;
          rsi70.setData([{ time: first, value: 70 }, { time: last, value: 70 }]);
          rsi30.setData([{ time: first, value: 30 }, { time: last, value: 30 }]);
        }

        // Header stats
        document.getElementById('price').textContent = data.latestPrice ? '$' + data.latestPrice.toFixed(2) : '—';
        document.getElementById('rsi').textContent = data.indicators?.rsi14?.toFixed(1) ?? '—';
        document.getElementById('atr').textContent = data.indicators?.atr14 ? '$' + data.indicators.atr14.toFixed(2) : '—';
        document.getElementById('count').textContent = data.candleCount;

        // Regime badge
        const badge = document.getElementById('regime-badge');
        badge.textContent = data.regime;
        badge.className = 'badge badge-regime ' + data.regime;

        // Indicators panel
        if (data.indicators) {
          const ind = data.indicators;
          const macdClass = ind.macd.histogram > 0 ? 'positive' : 'negative';
          const volClass = Math.abs(ind.volumeZScore) > 2 ? 'negative' : '';
          document.getElementById('indicators-panel').innerHTML =
            '<div class="ind"><span class="ind-label">EMA20</span><span class="ind-value">$' + ind.ema20.toFixed(2) + '</span></div>' +
            '<div class="ind"><span class="ind-label">EMA50</span><span class="ind-value">$' + ind.ema50.toFixed(2) + '</span></div>' +
            '<div class="ind"><span class="ind-label">EMA200</span><span class="ind-value">$' + ind.ema200.toFixed(2) + '</span></div>' +
            '<div class="ind"><span class="ind-label">MACD</span><span class="ind-value ' + macdClass + '">' + ind.macd.value.toFixed(2) + '</span></div>' +
            '<div class="ind"><span class="ind-label">Bollinger</span><span class="ind-value">$' + ind.bollingerBands.lower.toFixed(0) + ' – $' + ind.bollingerBands.upper.toFixed(0) + '</span></div>' +
            '<div class="ind"><span class="ind-label">Vol Z</span><span class="ind-value ' + volClass + '">' + ind.volumeZScore.toFixed(2) + '</span></div>';
        }

        // Updated timestamp
        const updAt = data.updatedAt ? new Date(data.updatedAt).toLocaleTimeString() : 'live';
        document.getElementById('updated').textContent = 'Last update: ' + updAt;

      } catch (err) {
        console.error('Failed to load chart data:', err);
      }
    }

    // Timeframe buttons
    document.querySelectorAll('[data-tf]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-tf]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentTf = btn.dataset.tf;
        loadData();
      });
    });

    // Toggle buttons
    document.getElementById('btn-ema').addEventListener('click', function() {
      showEma = !showEma;
      this.classList.toggle('active', showEma);
      loadData();
    });
    document.getElementById('btn-bb').addEventListener('click', function() {
      showBb = !showBb;
      this.classList.toggle('active', showBb);
      loadData();
    });

    // Initial state
    document.getElementById('btn-ema').classList.add('active');

    // Resize
    const ro = new ResizeObserver(() => {
      mainChart.applyOptions({ width: mainEl.clientWidth, height: mainEl.clientHeight });
      rsiChart.applyOptions({ width: rsiEl.clientWidth, height: rsiEl.clientHeight });
    });
    ro.observe(mainEl);
    ro.observe(rsiEl);

    // Load + auto-refresh
    loadData();
    setInterval(loadData, 30000);
  </script>
</body>
</html>`;

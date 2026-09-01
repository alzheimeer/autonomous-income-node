/**
 * Test New Paradigms — Backtest 3 strategies that haven't been tested yet:
 * 1. Short-selling in TRENDING_DOWN
 * 2. Grid/DCA in ranging market
 * 3. Funding rate arbitrage estimation (Hyperliquid API check)
 *
 * Usage: npx tsx scripts/test-new-paradigms.ts [--days 365]
 */

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import axios from 'axios';
import { BinanceDataDownloader } from '../src/backtester/binance-downloader.js';
import { BacktestCostModel, DEFAULT_COST_PARAMS } from '../src/backtester/backtest-cost-model.js';
import type { CandleData } from '../src/trading-validation/types.js';

const { values } = parseArgs({
  options: { days: { type: 'string', short: 'd', default: '365' } },
  strict: true,
});
const DAYS = parseInt(values.days!, 10);

// ═══════════════════════════════════════════════════════════════════════════
// Shared Types
// ═══════════════════════════════════════════════════════════════════════════

interface TradeResult {
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  direction: 'long' | 'short';
  sizeUsdc: bigint;
  pnlUsdc: bigint;
  exitReason: string;
}

interface StrategyResult {
  name: string;
  trades: number;
  winRate: number;
  netPnl: string;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgHoldHours: number;
  verdict: string;
}

const BPS = 10_000n;
const costModel = new BacktestCostModel(DEFAULT_COST_PARAMS);

function fmtUsdc(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  return `${neg ? '-' : ''}$${(Number(abs) / 1_000_000).toFixed(2)}`;
}

function computeMetrics(trades: TradeResult[], bankroll: bigint): StrategyResult & { trades_list: TradeResult[] } {
  if (trades.length === 0) {
    return { name: '', trades: 0, winRate: 0, netPnl: '$0.00', profitFactor: 0, maxDrawdownPct: 0, sharpeRatio: 0, avgHoldHours: 0, verdict: 'NO_TRADES', trades_list: [] };
  }

  let totalPnl = 0n, grossProfit = 0n, grossLoss = 0n, winCount = 0;
  let peak = bankroll, equity = bankroll, maxDd = 0n;
  let totalHoldMs = 0;

  for (const t of trades) {
    totalPnl += t.pnlUsdc;
    equity += t.pnlUsdc;
    totalHoldMs += (t.exitTime - t.entryTime);
    if (t.pnlUsdc > 0n) { grossProfit += t.pnlUsdc; winCount++; }
    else grossLoss += -t.pnlUsdc;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }

  const winRate = (winCount / trades.length) * 100;
  const pf = grossLoss === 0n ? (grossProfit > 0n ? 999 : 0) : Number(grossProfit) / Number(grossLoss);
  const maxDdPct = peak > 0n ? (Number(maxDd) / Number(peak)) * 100 : 0;
  const returns = trades.map(t => Number(t.pnlUsdc) / 1_000_000);
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1 || 1);
  const sharpe = variance > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(365) : 0;

  let verdict: string;
  if (trades.length < 10) verdict = 'INSUFFICIENT_DATA';
  else if (totalPnl <= 0n) verdict = 'NEGATIVE_EXPECTANCY';
  else if (pf < 1.2) verdict = 'BREAKEVEN';
  else if (pf >= 1.5 && maxDdPct < 20) verdict = '✅ STRONG_POSITIVE';
  else verdict = '✅ POSITIVE_EXPECTANCY';

  return {
    name: '',
    trades: trades.length,
    winRate: Math.round(winRate * 10) / 10,
    netPnl: fmtUsdc(totalPnl),
    profitFactor: Math.round(pf * 100) / 100,
    maxDrawdownPct: Math.round(maxDdPct * 10) / 10,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    avgHoldHours: Math.round(totalHoldMs / trades.length / 3_600_000 * 10) / 10,
    verdict,
    trades_list: trades,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PARADIGM 1: SHORT-SELLING
// ═══════════════════════════════════════════════════════════════════════════

function backtestShort(candles1h: CandleData[], sizeUsdc: bigint): TradeResult[] {
  const trades: TradeResult[] = [];
  let position: { entryTime: number; entryPrice: number; stopPrice: number; tpPrice: number } | null = null;
  let lastEntryTime = 0;

  // Simple indicators
  const ema = (data: number[], period: number): number => {
    if (data.length < period) return data[data.length - 1] ?? 0;
    const k = 2 / (period + 1);
    let e = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) e = data[i]! * k + e * (1 - k);
    return e;
  };

  const closes: number[] = [];

  for (const candle of candles1h) {
    closes.push(candle.close);
    if (closes.length < 50) continue;

    const ema20 = ema(closes, 20);
    const ema50 = ema(closes, 50);
    const price = candle.close;

    // Check exit for open short position
    if (position) {
      // Stop loss (price goes UP above stop)
      if (candle.high >= position.stopPrice) {
        const pnl = computeShortPnl(position.entryPrice, position.stopPrice, sizeUsdc);
        trades.push({ entryTime: position.entryTime, exitTime: candle.timestamp, entryPrice: position.entryPrice, exitPrice: position.stopPrice, direction: 'short', sizeUsdc, pnlUsdc: pnl, exitReason: 'stop_loss' });
        position = null;
        continue;
      }
      // Take profit (price goes DOWN below TP)
      if (candle.low <= position.tpPrice) {
        const pnl = computeShortPnl(position.entryPrice, position.tpPrice, sizeUsdc);
        trades.push({ entryTime: position.entryTime, exitTime: candle.timestamp, entryPrice: position.entryPrice, exitPrice: position.tpPrice, direction: 'short', sizeUsdc, pnlUsdc: pnl, exitReason: 'take_profit' });
        position = null;
        continue;
      }
      // Time stop (24h for shorts)
      if (candle.timestamp - position.entryTime >= 24 * 3_600_000) {
        const pnl = computeShortPnl(position.entryPrice, candle.close, sizeUsdc);
        trades.push({ entryTime: position.entryTime, exitTime: candle.timestamp, entryPrice: position.entryPrice, exitPrice: candle.close, direction: 'short', sizeUsdc, pnlUsdc: pnl, exitReason: 'time_stop' });
        position = null;
        continue;
      }
    }

    // Entry conditions for SHORT:
    // 1. Price below EMA20 and EMA50 (TRENDING_DOWN)
    // 2. EMA20 < EMA50 (confirmed downtrend)
    // 3. No position open
    // 4. Cooldown 4h between entries
    if (!position && price < ema20 && price < ema50 && ema20 < ema50 && candle.timestamp - lastEntryTime >= 4 * 3_600_000) {
      // Compute ATR for stop/TP
      const recentCandles = candles1h.slice(Math.max(0, candles1h.indexOf(candle) - 14), candles1h.indexOf(candle) + 1);
      let atrSum = 0;
      for (let i = 1; i < recentCandles.length; i++) {
        const tr = Math.max(recentCandles[i]!.high - recentCandles[i]!.low, Math.abs(recentCandles[i]!.high - recentCandles[i-1]!.close), Math.abs(recentCandles[i]!.low - recentCandles[i-1]!.close));
        atrSum += tr;
      }
      const atr = atrSum / (recentCandles.length - 1 || 1);

      // Short: SL above entry, TP below entry
      const stopPrice = price + 2.0 * atr; // 2 ATR stop
      const tpPrice = price - 3.0 * atr;   // 3 ATR TP

      position = { entryTime: candle.timestamp, entryPrice: price, stopPrice, tpPrice };
      lastEntryTime = candle.timestamp;
    }
  }

  return trades;
}

function computeShortPnl(entryPrice: number, exitPrice: number, sizeUsdc: bigint): bigint {
  // Short: profit when price goes DOWN
  // PnL = size * (entry - exit) / entry - costs
  const entryBig = BigInt(Math.round(entryPrice * 1_000_000));
  const exitBig = BigInt(Math.round(exitPrice * 1_000_000));
  if (entryBig === 0n) return 0n;
  const grossPnl = sizeUsdc * (entryBig - exitBig) / entryBig;
  const costs = costModel.computeRoundTripCost(sizeUsdc);
  return grossPnl - costs.totalCost;
}

// ═══════════════════════════════════════════════════════════════════════════
// PARADIGM 2: GRID/DCA
// ═══════════════════════════════════════════════════════════════════════════

function backtestGrid(candles1h: CandleData[], sizeUsdc: bigint): TradeResult[] {
  const trades: TradeResult[] = [];

  // Grid strategy: buy every time price drops 3% from last buy, sell when price rises 3% from entry
  // Maximum 5 open grid levels
  const GRID_PCT = 0.03; // 3% between levels
  const MAX_LEVELS = 5;

  interface GridLevel { entryTime: number; entryPrice: number }
  const openLevels: GridLevel[] = [];
  let lastBuyPrice = candles1h[200]?.close ?? 0; // Start after warmup

  for (let i = 200; i < candles1h.length; i++) {
    const candle = candles1h[i]!;
    const price = candle.close;

    // Check exits: sell any level that's 3% above its entry
    for (let j = openLevels.length - 1; j >= 0; j--) {
      const level = openLevels[j]!;
      if (price >= level.entryPrice * (1 + GRID_PCT)) {
        const pnl = costModel.computeNetPnl(level.entryPrice, price, sizeUsdc);
        trades.push({ entryTime: level.entryTime, exitTime: candle.timestamp, entryPrice: level.entryPrice, exitPrice: price, direction: 'long', sizeUsdc, pnlUsdc: pnl, exitReason: 'grid_tp' });
        openLevels.splice(j, 1);
      }
    }

    // Check entry: buy if price dropped 3% from last buy AND we have room
    if (openLevels.length < MAX_LEVELS && price <= lastBuyPrice * (1 - GRID_PCT)) {
      openLevels.push({ entryTime: candle.timestamp, entryPrice: price });
      lastBuyPrice = price;
    }

    // Time stop: close any level open > 7 days
    for (let j = openLevels.length - 1; j >= 0; j--) {
      const level = openLevels[j]!;
      if (candle.timestamp - level.entryTime >= 7 * 24 * 3_600_000) {
        const pnl = costModel.computeNetPnl(level.entryPrice, price, sizeUsdc);
        trades.push({ entryTime: level.entryTime, exitTime: candle.timestamp, entryPrice: level.entryPrice, exitPrice: price, direction: 'long', sizeUsdc, pnlUsdc: pnl, exitReason: 'time_stop' });
        openLevels.splice(j, 1);
      }
    }
  }

  return trades;
}

// ═══════════════════════════════════════════════════════════════════════════
// PARADIGM 3: FUNDING RATE CHECK (Hyperliquid)
// ═══════════════════════════════════════════════════════════════════════════

async function checkFundingRates(): Promise<{ eth: number; sol: number; btc: number; viable: boolean }> {
  try {
    // Hyperliquid public API — no key needed
    const response = await axios.post('https://api.hyperliquid.xyz/info', {
      type: 'metaAndAssetCtxs',
    }, { timeout: 10000 });

    const data = response.data as [unknown, Array<{ funding: string; coin?: string }>];
    const assets = data[1] ?? [];

    // Find funding rates for ETH, SOL, BTC
    // Hyperliquid returns funding as hourly rate
    const ethCtx = assets.find((_a, i) => {
      const meta = (data[0] as any)?.universe?.[i];
      return meta?.name === 'ETH';
    });
    const solCtx = assets.find((_a, i) => {
      const meta = (data[0] as any)?.universe?.[i];
      return meta?.name === 'SOL';
    });
    const btcCtx = assets.find((_a, i) => {
      const meta = (data[0] as any)?.universe?.[i];
      return meta?.name === 'BTC';
    });

    const ethRate = ethCtx ? parseFloat(ethCtx.funding) * 100 * 24 * 365 : 0; // annualized %
    const solRate = solCtx ? parseFloat(solCtx.funding) * 100 * 24 * 365 : 0;
    const btcRate = btcCtx ? parseFloat(btcCtx.funding) * 100 * 24 * 365 : 0;

    return {
      eth: Math.round(ethRate * 100) / 100,
      sol: Math.round(solRate * 100) / 100,
      btc: Math.round(btcRate * 100) / 100,
      viable: Math.abs(ethRate) > 5 || Math.abs(solRate) > 5 || Math.abs(btcRate) > 5,
    };
  } catch (err) {
    console.log(`  ⚠ Hyperliquid API error: ${(err as Error).message}`);
    return { eth: 0, sol: 0, btc: 0, viable: false };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n╔══════════════════════════════════════════════════════╗`);
  console.log(`║  New Paradigms Backtest — ${DAYS} days                  ║`);
  console.log(`╚══════════════════════════════════════════════════════╝\n`);

  // Download data
  console.log('Downloading ETHUSDC 1h candles...');
  const downloader = new BinanceDataDownloader();
  const candles1h = await downloader.downloadCandles('ETHUSDC', '1h', DAYS, 50);
  console.log(`  ${candles1h.length} candles loaded\n`);

  const BANKROLL = 25_000_000n; // $25
  const SIZE_25 = 25_000_000n;  // $25 per trade
  const SIZE_50 = 50_000_000n;  // $50 per trade

  // ── PARADIGM 1: SHORT-SELLING ──────────────────────────────────────────
  console.log('═══ PARADIGM 1: SHORT-SELLING (TRENDING_DOWN) ═══\n');

  const shortTrades25 = backtestShort(candles1h, SIZE_25);
  const shortResult25 = computeMetrics(shortTrades25, BANKROLL);
  shortResult25.name = 'Short $25, 1h, SL2ATR, TP3ATR';

  const shortTrades50 = backtestShort(candles1h, SIZE_50);
  const shortResult50 = computeMetrics(shortTrades50, BANKROLL * 2n);
  shortResult50.name = 'Short $50, 1h, SL2ATR, TP3ATR';

  console.log(`  ${shortResult25.name}: ${shortResult25.trades} trades | Win ${shortResult25.winRate}% | PF ${shortResult25.profitFactor} | Net ${shortResult25.netPnl} | DD ${shortResult25.maxDrawdownPct}% | ${shortResult25.verdict}`);
  console.log(`  ${shortResult50.name}: ${shortResult50.trades} trades | Win ${shortResult50.winRate}% | PF ${shortResult50.profitFactor} | Net ${shortResult50.netPnl} | DD ${shortResult50.maxDrawdownPct}% | ${shortResult50.verdict}\n`);

  // ── PARADIGM 2: GRID/DCA ───────────────────────────────────────────────
  console.log('═══ PARADIGM 2: GRID/DCA (3% levels, max 5 open) ═══\n');

  const gridTrades10 = backtestGrid(candles1h, 10_000_000n);
  const gridResult10 = computeMetrics(gridTrades10, BANKROLL);
  gridResult10.name = 'Grid $10, 3% levels';

  const gridTrades25 = backtestGrid(candles1h, SIZE_25);
  const gridResult25 = computeMetrics(gridTrades25, BANKROLL * 3n);
  gridResult25.name = 'Grid $25, 3% levels';

  console.log(`  ${gridResult10.name}: ${gridResult10.trades} trades | Win ${gridResult10.winRate}% | PF ${gridResult10.profitFactor} | Net ${gridResult10.netPnl} | DD ${gridResult10.maxDrawdownPct}% | ${gridResult10.verdict}`);
  console.log(`  ${gridResult25.name}: ${gridResult25.trades} trades | Win ${gridResult25.winRate}% | PF ${gridResult25.profitFactor} | Net ${gridResult25.netPnl} | DD ${gridResult25.maxDrawdownPct}% | ${gridResult25.verdict}\n`);

  // ── PARADIGM 3: FUNDING RATE ───────────────────────────────────────────
  console.log('═══ PARADIGM 3: FUNDING RATE ARBITRAGE (Hyperliquid) ═══\n');

  const funding = await checkFundingRates();
  console.log(`  ETH funding rate (annualized): ${funding.eth}%`);
  console.log(`  SOL funding rate (annualized): ${funding.sol}%`);
  console.log(`  BTC funding rate (annualized): ${funding.btc}%`);
  console.log(`  Viable for arb (>5% annualized): ${funding.viable ? '✅ YES' : '❌ NO'}`);
  console.log(`  Strategy: Long spot + short perp (delta-neutral), collect funding\n`);

  // ── SUMMARY ────────────────────────────────────────────────────────────
  console.log(`${'═'.repeat(80)}`);
  console.log(`  FINAL COMPARISON — ALL PARADIGMS (${DAYS} days, ETHUSDC)`);
  console.log(`${'═'.repeat(80)}`);
  console.log(`${'Paradigm'.padEnd(35)} ${'Trades'.padStart(6)} ${'WinR%'.padStart(6)} ${'PF'.padStart(5)} ${'Net PnL'.padStart(9)} ${'DD%'.padStart(5)} ${'Verdict'.padStart(22)}`);
  console.log(`${'-'.repeat(80)}`);

  const allResults = [shortResult25, shortResult50, gridResult10, gridResult25];
  for (const r of allResults) {
    console.log(`${r.name.padEnd(35)} ${String(r.trades).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${r.profitFactor.toFixed(2).padStart(5)} ${r.netPnl.padStart(9)} ${r.maxDrawdownPct.toFixed(1).padStart(5)} ${r.verdict.padStart(22)}`);
  }
  console.log(`${'Funding Rate Arb'.padEnd(35)} ${'N/A'.padStart(6)} ${'N/A'.padStart(6)} ${'N/A'.padStart(5)} ${(funding.eth > 5 ? '~$5-15/yr' : '<$5/yr').padStart(9)} ${'~0%'.padStart(5)} ${(funding.viable ? '✅ VIABLE' : '❌ LOW RATE').padStart(22)}`);
  console.log(`${'═'.repeat(80)}\n`);

  // Save report
  mkdirSync('reports/evolution', { recursive: true });
  const report = {
    days: DAYS,
    timestamp: new Date().toISOString(),
    paradigms: {
      short_25: shortResult25,
      short_50: shortResult50,
      grid_10: gridResult10,
      grid_25: gridResult25,
      funding_rate: funding,
    },
  };
  writeFileSync(`reports/evolution/new-paradigms-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(report, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  console.log(`Report saved: reports/evolution/new-paradigms-${new Date().toISOString().slice(0, 10)}.json\n`);
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});

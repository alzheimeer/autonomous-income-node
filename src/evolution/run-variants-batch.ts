/**
 * Run Variants Batch — Execute multiple strategy variants side-by-side.
 *
 * Runs: Baseline + V1-V5 with different trade sizes, timeframes, and strategies.
 * Outputs comparative results to stdout and saves JSON report.
 *
 * Usage: npx tsx src/evolution/run-variants-batch.ts [--days 60]
 */

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BinanceDataDownloader } from '../backtester/binance-downloader.js';
import { IncrementalFeatureEngine } from '../backtester/incremental-feature-engine.js';
import { StrategyEngine } from '../trading-validation/strategy-engine.js';
import { BacktestSimulator, DEFAULT_RISK_LIMITS } from '../backtester/backtest-simulator.js';
import { BacktestCostModel, DEFAULT_COST_PARAMS } from '../backtester/backtest-cost-model.js';
import { MomentumStrategy, DEFAULT_MOMENTUM_CONFIG } from './momentum-strategy.js';
import type { StrategyEngineConfig } from '../trading-validation/config.js';
import type { CandleData } from '../trading-validation/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// CLI Args
// ═══════════════════════════════════════════════════════════════════════════

const { values } = parseArgs({
  options: {
    days: { type: 'string', short: 'd', default: '60' },
  },
  strict: true,
});

const DAYS = parseInt(values.days!, 10);

// ═══════════════════════════════════════════════════════════════════════════
// Variant Definitions
// ═══════════════════════════════════════════════════════════════════════════

interface VariantDef {
  name: string;
  tradeSize: bigint;
  entryTf: '15m' | '1h';
  stopAtr: number;
  tpAtr: number;
  useMomentum: boolean;
  description: string;
}

const VARIANTS: VariantDef[] = [
  {
    name: 'Baseline ($10, 15m, SL1.5, TP2.0)',
    tradeSize: 10_000_000n,
    entryTf: '15m',
    stopAtr: 1.5,
    tpAtr: 2.0,
    useMomentum: false,
    description: 'Control — current production params',
  },
  {
    name: 'V1 ($25, 1h, SL2.0, TP3.0)',
    tradeSize: 25_000_000n,
    entryTf: '1h',
    stopAtr: 2.0,
    tpAtr: 3.0,
    useMomentum: false,
    description: 'Primer candidato realista — mayor tamaño + menos ruido',
  },
  {
    name: 'V2 ($50, 1h, SL2.0, TP3.0)',
    tradeSize: 50_000_000n,
    entryTf: '1h',
    stopAtr: 2.0,
    tpAtr: 3.0,
    useMomentum: false,
    description: 'Candidato agresivo simulado — máximo tamaño para costos mínimos relativos',
  },
  {
    name: 'V3 ($25, 1h momentum, SL2.0, TP3.0)',
    tradeSize: 25_000_000n,
    entryTf: '1h',
    stopAtr: 2.0,
    tpAtr: 3.0,
    useMomentum: true,
    description: 'Momentum breakout — compra fuerza, no debilidad',
  },
  {
    name: 'V4 ($50, 1h momentum, SL2.0, TP3.0)',
    tradeSize: 50_000_000n,
    entryTf: '1h',
    stopAtr: 2.0,
    tpAtr: 3.0,
    useMomentum: true,
    description: 'Momentum agresivo — máximo tamaño + máxima fuerza',
  },
  {
    name: 'V5 ($25, 1h, SL2.5, TP4.0)',
    tradeSize: 25_000_000n,
    entryTf: '1h',
    stopAtr: 2.5,
    tpAtr: 4.0,
    useMomentum: false,
    description: 'Wider stops + bigger TP — máximo espacio para respirar',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Backtest Runner for a Single Variant
// ═══════════════════════════════════════════════════════════════════════════

interface VariantResult {
  name: string;
  description: string;
  trades: number;
  winRate: number;
  netPnl: string;
  grossPnl: string;
  totalCosts: string;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  avgHoldingHours: number;
  bestTrade: string;
  worstTrade: string;
  costPerTrade: string;
  verdict: string;
}

async function runVariant(
  variant: VariantDef,
  candles15m: CandleData[],
  candles1h: CandleData[],
): Promise<VariantResult> {
  const featureEngine = new IncrementalFeatureEngine();
  const costModel = new BacktestCostModel(DEFAULT_COST_PARAMS);

  const riskLimits = {
    ...DEFAULT_RISK_LIMITS,
    maxSizeUsdc: variant.tradeSize,
    minSizeUsdc: variant.tradeSize > 5_000_000n ? 5_000_000n : variant.tradeSize,
    startingBankroll: variant.tradeSize * 3n, // 3x trade size as bankroll
  };

  const simulator = new BacktestSimulator(riskLimits);

  // Strategy setup
  const strategyConfig: StrategyEngineConfig = {
    pair: 'WETH/USDC',
    regimeTimeframe: '1h',
    entryTimeframe: variant.entryTf as '15m',
    stopLossAtr: variant.stopAtr,
    takeProfitAtr: variant.tpAtr,
    cooldownMs: 3_600_000,
    warmup1h: 200,
    warmup15m: 200,
    meanRevAtrMax: 2.5,
    minLiquidity: 50000,
    volumeZThreshold: 1.0,
  };

  const strategyEngine = new StrategyEngine(strategyConfig);
  const momentumStrategy = variant.useMomentum ? new MomentumStrategy({
    stopAtr: variant.stopAtr,
    tpAtr: variant.tpAtr,
  }) : null;

  // Determine which candles to use for entry signals
  const entryCandles = variant.entryTf === '1h' ? candles1h : candles15m;

  // Build 1h map for regime
  const candles1hMap = new Map<number, CandleData>();
  for (const c of candles1h) candles1hMap.set(c.timestamp, c);

  // Replay
  for (const candle of entryCandles) {
    featureEngine.addCandle(variant.entryTf, candle);

    // Also feed 1h for regime if entry is 15m
    if (variant.entryTf === '15m') {
      const aligned1h = candles1hMap.get(candle.timestamp);
      if (aligned1h) featureEngine.addCandle('1h', aligned1h);
    } else {
      // Entry is 1h — feed directly as both
      featureEngine.addCandle('1h', candle);
    }

    const ind = featureEngine.computeIndicators(variant.entryTf);
    const ind1h = featureEngine.computeIndicators('1h');
    const regime = featureEngine.getRegime();

    // Check exits first
    simulator.checkExits(candle, costModel);

    if (!ind || !ind1h || simulator.hasOpenPosition()) continue;

    let candidate = null;

    if (variant.useMomentum && momentumStrategy) {
      momentumStrategy.addCandle(candle);
      candidate = momentumStrategy.evaluate(ind, regime, candle.timestamp);
      if (candidate && simulator.hasOpenPosition()) {
        momentumStrategy.setPositionOpen(true);
      }
    } else {
      candidate = strategyEngine.evaluate(ind1h, ind, regime, candle.timestamp);
    }

    if (candidate && !simulator.hasOpenPosition()) {
      simulator.processSignal(candidate, candle, costModel);
      if (simulator.hasOpenPosition()) {
        strategyEngine.setPositionOpen(true);
        if (momentumStrategy) momentumStrategy.setPositionOpen(true);
      }
    }

    if (!simulator.hasOpenPosition()) {
      strategyEngine.setPositionOpen(false);
      if (momentumStrategy) momentumStrategy.setPositionOpen(false);
    }
  }

  // Compute metrics
  const trades = simulator.getTrades();
  const totalTrades = trades.length;

  if (totalTrades === 0) {
    return {
      name: variant.name,
      description: variant.description,
      trades: 0, winRate: 0, netPnl: '$0.00', grossPnl: '$0.00',
      totalCosts: '$0.00', profitFactor: 0, maxDrawdownPct: 0,
      sharpeRatio: 0, avgHoldingHours: 0, bestTrade: '$0.00',
      worstTrade: '$0.00', costPerTrade: '$0.00',
      verdict: 'NO_TRADES',
    };
  }

  let totalPnl = 0n;
  let grossProfit = 0n;
  let grossLoss = 0n;
  let winCount = 0;
  let peak = riskLimits.startingBankroll;
  let equity = riskLimits.startingBankroll;
  let maxDd = 0n;
  let bestTrade = trades[0]!.pnlUsdc;
  let worstTrade = trades[0]!.pnlUsdc;
  let totalHoldingMs = 0;

  for (const t of trades) {
    totalPnl += t.pnlUsdc;
    equity += t.pnlUsdc;
    totalHoldingMs += t.holdingMs;
    if (t.pnlUsdc > 0n) { grossProfit += t.pnlUsdc; winCount++; }
    else grossLoss += -t.pnlUsdc;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
    if (t.pnlUsdc > bestTrade) bestTrade = t.pnlUsdc;
    if (t.pnlUsdc < worstTrade) worstTrade = t.pnlUsdc;
  }

  const totalCosts = trades.reduce((sum, t) => {
    const c = costModel.computeRoundTripCost(t.sizeUsdc);
    return sum + c.totalCost;
  }, 0n);

  const winRate = (winCount / totalTrades) * 100;
  const pf = grossLoss === 0n ? (grossProfit > 0n ? 999 : 0) : Number(grossProfit) / Number(grossLoss);
  const maxDdPct = peak > 0n ? (Number(maxDd) / Number(peak)) * 100 : 0;

  const returns = trades.map(t => Number(t.pnlUsdc) / 1_000_000);
  const meanR = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / (returns.length - 1 || 1);
  const sharpe = variance > 0 ? (meanR / Math.sqrt(variance)) * Math.sqrt(365) : 0;

  // Determine verdict
  let verdict: string;
  if (totalTrades < 10) verdict = 'INSUFFICIENT_DATA';
  else if (totalPnl < 0n && pf < 0.8) verdict = 'NEGATIVE_EXPECTANCY';
  else if (totalPnl < 0n) verdict = 'MARGINAL_NEGATIVE';
  else if (pf < 1.2) verdict = 'BREAKEVEN';
  else if (pf >= 1.5) verdict = 'STRONG_POSITIVE';
  else verdict = 'POSITIVE_EXPECTANCY';

  const fmtUsdc = (v: bigint) => {
    const neg = v < 0n;
    const abs = neg ? -v : v;
    const d = abs / 1_000_000n;
    const c = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, 2);
    return `${neg ? '-' : ''}$${d}.${c}`;
  };

  return {
    name: variant.name,
    description: variant.description,
    trades: totalTrades,
    winRate: Math.round(winRate * 10) / 10,
    netPnl: fmtUsdc(totalPnl),
    grossPnl: fmtUsdc(totalPnl + totalCosts),
    totalCosts: fmtUsdc(totalCosts),
    profitFactor: Math.round(pf * 100) / 100,
    maxDrawdownPct: Math.round(maxDdPct * 10) / 10,
    sharpeRatio: Math.round(sharpe * 100) / 100,
    avgHoldingHours: Math.round((totalHoldingMs / totalTrades) / 3_600_000 * 10) / 10,
    bestTrade: fmtUsdc(bestTrade),
    worstTrade: fmtUsdc(worstTrade),
    costPerTrade: fmtUsdc(totalCosts / BigInt(totalTrades)),
    verdict,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  Strategy Variants Comparison — ${DAYS} days     ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);

  // Download data
  console.log(`Downloading ${DAYS} days of ETHUSDC candles...`);
  const downloader = new BinanceDataDownloader();
  const candles15m = await downloader.downloadCandles('ETHUSDC', '15m', DAYS, 200);
  const candles1h = await downloader.downloadCandles('ETHUSDC', '1h', DAYS, 200);
  console.log(`  15m: ${candles15m.length} candles | 1h: ${candles1h.length} candles\n`);

  // Run all variants
  const results: VariantResult[] = [];
  for (const variant of VARIANTS) {
    process.stdout.write(`  Running: ${variant.name}...`);
    const result = await runVariant(variant, candles15m, candles1h);
    results.push(result);
    console.log(` ${result.trades} trades → ${result.verdict}`);
  }

  // Print comparison table
  console.log(`\n${'═'.repeat(100)}`);
  console.log(`  COMPARISON TABLE (${DAYS} days, ETHUSDC)`);
  console.log(`${'═'.repeat(100)}`);
  console.log(
    `${'Variant'.padEnd(38)} ${'Trades'.padStart(6)} ${'WinR%'.padStart(6)} ${'NetPnL'.padStart(8)} ${'Costs'.padStart(8)} ${'PF'.padStart(5)} ${'DD%'.padStart(5)} ${'Verdict'.padStart(20)}`,
  );
  console.log(`${'-'.repeat(100)}`);

  for (const r of results) {
    console.log(
      `${r.name.padEnd(38)} ${String(r.trades).padStart(6)} ${r.winRate.toFixed(1).padStart(6)} ${r.netPnl.padStart(8)} ${r.totalCosts.padStart(8)} ${r.profitFactor.toFixed(2).padStart(5)} ${r.maxDrawdownPct.toFixed(1).padStart(5)} ${r.verdict.padStart(20)}`,
    );
  }

  console.log(`${'═'.repeat(100)}\n`);

  // Detail per variant
  for (const r of results) {
    console.log(`── ${r.name} ──`);
    console.log(`   ${r.description}`);
    console.log(`   Trades: ${r.trades} | Win: ${r.winRate}% | PF: ${r.profitFactor} | Sharpe: ${r.sharpeRatio}`);
    console.log(`   Net: ${r.netPnl} | Costs: ${r.totalCosts} (${r.costPerTrade}/trade) | DD: ${r.maxDrawdownPct}%`);
    console.log(`   Best: ${r.bestTrade} | Worst: ${r.worstTrade} | Avg Hold: ${r.avgHoldingHours}h`);
    console.log('');
  }

  // Save report
  mkdirSync('reports/evolution', { recursive: true });
  const reportPath = `reports/evolution/variants-comparison-${new Date().toISOString().slice(0, 10)}.json`;
  writeFileSync(reportPath, JSON.stringify({ days: DAYS, timestamp: new Date().toISOString(), results }, null, 2));
  console.log(`Report saved: ${reportPath}\n`);
}

main().catch((err) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

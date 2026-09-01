/**
 * BacktestRunner — Main orchestration for offline backtesting.
 *
 * Pipeline:
 * 1. Download 15m and 1h candles via BinanceDataDownloader
 * 2. Initialize fresh IncrementalFeatureEngine + StrategyEngine
 * 3. Create BacktestSimulator with risk limits
 * 4. Create BacktestCostModel with cost params
 * 5. Chronological replay: feed candle → compute indicators → check exits → evaluate strategy
 * 6. Compute BacktestMetrics from completed trades
 * 7. Compute verdict
 * 8. Generate reports
 * 9. Return results
 *
 * Requirements: 9.1, 9.2, 9.3, 15.1, 15.2, 15.3
 */

import { createHash } from 'node:crypto';
import type { CandleData } from '../trading-validation/types.js';
import type { StrategyEngineConfig } from '../trading-validation/config.js';
import { StrategyEngine } from '../trading-validation/strategy-engine.js';
import { BinanceDataDownloader } from './binance-downloader.js';
import { IncrementalFeatureEngine } from './incremental-feature-engine.js';
import { BacktestCostModel, DEFAULT_COST_PARAMS } from './backtest-cost-model.js';
import type { CostParams } from './backtest-cost-model.js';
import { BacktestSimulator, DEFAULT_RISK_LIMITS } from './backtest-simulator.js';
import type { RiskLimits, SimulatedTrade, EquityPoint } from './backtest-simulator.js';
import { computeVerdict } from './verdict-engine.js';
import type { VerdictResult } from './verdict-engine.js';
import { generateReports } from './report-generator.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface BacktestConfig {
  days: number;
  outputDir: string;
  strategyConfig: StrategyEngineConfig;
  costParams: CostParams;
  riskLimits: RiskLimits;
  warmupCandles: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownPct: number;
  maxDrawdownUsdc: bigint;
  sharpeRatio: number;
  avgTradeDurationMs: number;
  avgPnlPerTrade: bigint;
  totalPnlUsdc: bigint;
  totalCostsUsdc: bigint;
  buyAndHoldPnlUsdc: bigint;
  tradesPerDay: number;
  bestTrade: bigint;
  worstTrade: bigint;
}

export interface BacktestMetadata {
  startDate: string;
  endDate: string;
  daysSimulated: number;
  candlesProcessed: number;
  costModelParams: CostParams;
  riskLimits: RiskLimits;
  strategyConfigHash: string;
}

export interface BacktestResult {
  trades: SimulatedTrade[];
  metrics: BacktestMetrics;
  verdict: VerdictResult;
  metadata: BacktestMetadata;
  equityCurve: EquityPoint[];
}

export interface ProgressCallback {
  (stage: string, detail: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// BacktestRunner
// ═══════════════════════════════════════════════════════════════════════════

export async function runBacktest(
  config: BacktestConfig,
  onProgress?: ProgressCallback,
): Promise<BacktestResult> {
  const progress = onProgress ?? (() => {});

  // Phase 1: Download historical data
  progress('download', 'Downloading 15m candles...');
  const downloader = new BinanceDataDownloader();
  const candles15m = await downloader.downloadCandles(
    'ETHUSDC', '15m', config.days, config.warmupCandles,
  );
  progress('download', `Downloaded ${candles15m.length} 15m candles`);

  progress('download', 'Downloading 1h candles...');
  const candles1h = await downloader.downloadCandles(
    'ETHUSDC', '1h', config.days, config.warmupCandles,
  );
  progress('download', `Downloaded ${candles1h.length} 1h candles`);

  // Phase 2: Initialize fresh engines
  progress('init', 'Initializing engines...');
  const featureEngine = new IncrementalFeatureEngine();
  const strategyEngine = new StrategyEngine(config.strategyConfig);
  const costModel = new BacktestCostModel(config.costParams);
  const simulator = new BacktestSimulator(config.riskLimits);

  // Build a lookup map for 1h candles by timestamp for alignment
  const candles1hMap = new Map<number, CandleData>();
  for (const c of candles1h) {
    candles1hMap.set(c.timestamp, c);
  }

  // Phase 3: Chronological replay (no-lookahead)
  progress('simulation', 'Starting chronological replay...');
  const totalCandles = candles15m.length;
  let lastProgressPct = 0;

  for (let i = 0; i < totalCandles; i++) {
    const candle = candles15m[i]!;

    // Feed 15m candle to feature engine
    featureEngine.addCandle('15m', candle);

    // Feed aligned 1h candle if one closes at this timestamp
    const aligned1h = candles1hMap.get(candle.timestamp);
    if (aligned1h) {
      featureEngine.addCandle('1h', aligned1h);
    }

    // Compute indicators
    const ind15m = featureEngine.computeIndicators('15m');
    const ind1h = featureEngine.computeIndicators('1h');
    const regime = featureEngine.getRegime();

    // Check exits for open position FIRST (before processing new signals)
    simulator.checkExits(candle, costModel);

    // If indicators available and no open position, evaluate strategy
    if (ind15m && ind1h && !simulator.hasOpenPosition()) {
      const candidate = strategyEngine.evaluate(ind1h, ind15m, regime, candle.timestamp);
      if (candidate) {
        simulator.processSignal(candidate, candle, costModel);
        // Update strategy engine position state
        if (simulator.hasOpenPosition()) {
          strategyEngine.setPositionOpen(true);
        }
      }
    }

    // Update position state if position was closed
    if (!simulator.hasOpenPosition()) {
      strategyEngine.setPositionOpen(false);
    }

    // Progress reporting (every 10%)
    const pct = Math.floor((i / totalCandles) * 100);
    if (pct >= lastProgressPct + 10) {
      progress('simulation', `${pct}% complete (${i}/${totalCandles} candles)`);
      lastProgressPct = pct;
    }
  }

  progress('simulation', '100% complete');

  // Phase 4: Compute metrics
  progress('metrics', 'Computing metrics...');
  const trades = simulator.getTrades();
  const equityCurve = simulator.getEquityCurve();
  const metrics = computeMetrics(trades, candles15m, config);

  // Phase 5: Compute verdict
  progress('verdict', 'Computing verdict...');
  const verdict = computeVerdict(metrics);

  // Phase 6: Build metadata
  const metadata: BacktestMetadata = {
    startDate: candles15m.length > 0 ? new Date(candles15m[0]!.timestamp).toISOString() : '',
    endDate: candles15m.length > 0 ? new Date(candles15m[candles15m.length - 1]!.timestamp).toISOString() : '',
    daysSimulated: config.days,
    candlesProcessed: totalCandles,
    costModelParams: config.costParams,
    riskLimits: config.riskLimits,
    strategyConfigHash: computeStrategyConfigHash(config.strategyConfig),
  };

  // Phase 7: Generate reports
  progress('reports', 'Generating reports...');
  generateReports(trades, metrics, verdict, metadata, equityCurve, config.outputDir);

  progress('done', `Verdict: ${verdict.verdict} — ${verdict.rationale}`);

  return { trades, metrics, verdict, metadata, equityCurve };
}

// ═══════════════════════════════════════════════════════════════════════════
// Metrics Computation
// ═══════════════════════════════════════════════════════════════════════════

export function computeMetrics(
  trades: SimulatedTrade[],
  candles15m: CandleData[],
  config: BacktestConfig,
): BacktestMetrics {
  const totalTrades = trades.length;

  if (totalTrades === 0) {
    return {
      totalTrades: 0,
      winRate: 0,
      profitFactor: 0,
      maxDrawdownPct: 0,
      maxDrawdownUsdc: 0n,
      sharpeRatio: 0,
      avgTradeDurationMs: 0,
      avgPnlPerTrade: 0n,
      totalPnlUsdc: 0n,
      totalCostsUsdc: 0n,
      buyAndHoldPnlUsdc: computeBuyAndHold(candles15m, config.riskLimits.startingBankroll),
      tradesPerDay: 0,
      bestTrade: 0n,
      worstTrade: 0n,
    };
  }

  // Win rate
  const wins = trades.filter(t => t.pnlUsdc > 0n).length;
  const winRate = (wins / totalTrades) * 100;

  // Profit factor
  let grossProfit = 0n;
  let grossLoss = 0n;
  for (const t of trades) {
    if (t.pnlUsdc > 0n) grossProfit += t.pnlUsdc;
    else grossLoss += -t.pnlUsdc;
  }
  const profitFactor = grossLoss === 0n
    ? (grossProfit > 0n ? Infinity : 0)
    : Number(grossProfit) / Number(grossLoss);

  // Total P&L
  let totalPnlUsdc = 0n;
  for (const t of trades) {
    totalPnlUsdc += t.pnlUsdc;
  }

  // Average P&L per trade
  const avgPnlPerTrade = totalPnlUsdc / BigInt(totalTrades);

  // Total costs (estimated from cost model)
  const costModel = new BacktestCostModel(config.costParams);
  let totalCostsUsdc = 0n;
  for (const t of trades) {
    const breakdown = costModel.computeRoundTripCost(t.sizeUsdc);
    totalCostsUsdc += breakdown.totalCost;
  }

  // Max drawdown
  const { maxDrawdownPct, maxDrawdownUsdc } = computeDrawdown(trades, config.riskLimits.startingBankroll);

  // Sharpe ratio (daily returns, annualized)
  const sharpeRatio = computeSharpe(trades, config.days);

  // Average trade duration
  let totalDurationMs = 0;
  for (const t of trades) {
    totalDurationMs += t.holdingMs;
  }
  const avgTradeDurationMs = totalDurationMs / totalTrades;

  // Best/worst trade
  let bestTrade = trades[0]!.pnlUsdc;
  let worstTrade = trades[0]!.pnlUsdc;
  for (const t of trades) {
    if (t.pnlUsdc > bestTrade) bestTrade = t.pnlUsdc;
    if (t.pnlUsdc < worstTrade) worstTrade = t.pnlUsdc;
  }

  // Trades per day
  const tradesPerDay = totalTrades / config.days;

  // Buy-and-hold benchmark
  const buyAndHoldPnlUsdc = computeBuyAndHold(candles15m, config.riskLimits.startingBankroll);

  return {
    totalTrades,
    winRate,
    profitFactor,
    maxDrawdownPct,
    maxDrawdownUsdc,
    sharpeRatio,
    avgTradeDurationMs,
    avgPnlPerTrade,
    totalPnlUsdc,
    totalCostsUsdc,
    buyAndHoldPnlUsdc,
    tradesPerDay,
    bestTrade,
    worstTrade,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function computeDrawdown(
  trades: SimulatedTrade[],
  startingBankroll: bigint,
): { maxDrawdownPct: number; maxDrawdownUsdc: bigint } {
  let equity = startingBankroll;
  let peak = equity;
  let maxDrawdownUsdc = 0n;
  let maxDrawdownPct = 0;

  for (const t of trades) {
    equity += t.pnlUsdc;
    if (equity > peak) {
      peak = equity;
    }
    const drawdown = peak - equity;
    if (drawdown > maxDrawdownUsdc) {
      maxDrawdownUsdc = drawdown;
      maxDrawdownPct = peak > 0n ? (Number(drawdown) / Number(peak)) * 100 : 0;
    }
  }

  return { maxDrawdownPct, maxDrawdownUsdc };
}

function computeSharpe(trades: SimulatedTrade[], days: number): number {
  if (trades.length < 2) return 0;

  // Group trades by day and compute daily returns
  const dailyReturns: number[] = [];
  const dayMap = new Map<string, bigint>();

  for (const t of trades) {
    const dayKey = new Date(t.exitTime).toISOString().slice(0, 10);
    const existing = dayMap.get(dayKey) ?? 0n;
    dayMap.set(dayKey, existing + t.pnlUsdc);
  }

  for (const [, pnl] of dayMap) {
    dailyReturns.push(Number(pnl) / 1_000_000); // Convert to dollars
  }

  if (dailyReturns.length < 2) return 0;

  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (dailyReturns.length - 1);
  const std = Math.sqrt(variance);

  if (std === 0) return 0;

  // Annualized: multiply by sqrt(365)
  return (mean / std) * Math.sqrt(365);
}

function computeBuyAndHold(candles15m: CandleData[], bankroll: bigint): bigint {
  if (candles15m.length < 2) return 0n;

  const firstPrice = candles15m[0]!.close;
  const lastPrice = candles15m[candles15m.length - 1]!.close;

  if (firstPrice === 0) return 0n;

  // P&L from holding WETH bought with full bankroll
  const returnFraction = (lastPrice - firstPrice) / firstPrice;
  return BigInt(Math.round(Number(bankroll) * returnFraction));
}

function computeStrategyConfigHash(config: StrategyEngineConfig): string {
  const serialized = JSON.stringify(config, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v,
  );
  return createHash('sha256').update(serialized).digest('hex');
}

/**
 * Backtester Module — Public API
 *
 * Re-exports all backtester components and provides persistence utilities
 * for storing backtest results in the MetricsDatabase.
 *
 * Requirements: 15.1, 15.2, 15.3
 */

// ═══════════════════════════════════════════════════════════════════════════
// Re-exports
// ═══════════════════════════════════════════════════════════════════════════

export { BinanceDataDownloader } from './binance-downloader.js';
export { IncrementalFeatureEngine } from './incremental-feature-engine.js';
export { BacktestCostModel, DEFAULT_COST_PARAMS } from './backtest-cost-model.js';
export type { CostParams, BacktestCostBreakdown } from './backtest-cost-model.js';
export { BacktestSimulator, DEFAULT_RISK_LIMITS } from './backtest-simulator.js';
export type { RiskLimits, SimulatedTrade, EquityPoint } from './backtest-simulator.js';
export { computeVerdict } from './verdict-engine.js';
export type { Verdict, VerdictResult, VerdictMetricsInput } from './verdict-engine.js';
export { generateReports } from './report-generator.js';
export { runBacktest, computeMetrics } from './backtest-runner.js';
export type { BacktestConfig, BacktestMetrics, BacktestMetadata, BacktestResult, ProgressCallback } from './backtest-runner.js';

// ═══════════════════════════════════════════════════════════════════════════
// Persistence
// ═══════════════════════════════════════════════════════════════════════════

import type { MetricsDatabase } from '../pipeline-metrics/metrics-database.js';
import type { BacktestResult } from './backtest-runner.js';
import { createLogger } from '../logger.js';

const log = createLogger('backtester-persist');

/**
 * Persist backtest results to the MetricsDatabase.
 *
 * Inserts a summary row into `backtest_runs` and each trade into `backtest_trades`.
 * Monetary values are stored as TEXT (BigInt string representation) to prevent
 * floating-point loss.
 *
 * @param db - MetricsDatabase instance
 * @param result - BacktestResult from runBacktest()
 * @param durationMs - Wall-clock duration of the backtest run in milliseconds
 */
export function persistBacktestResults(
  db: MetricsDatabase,
  result: BacktestResult,
  durationMs: number,
): void {
  const { metrics, verdict, metadata, trades } = result;

  // Insert summary row into backtest_runs
  const runId = db.insertBacktestRun(
    Date.now(),
    metadata.daysSimulated,
    metrics.totalTrades,
    metrics.winRate,
    metrics.profitFactor === Infinity ? 999999 : metrics.profitFactor,
    metrics.maxDrawdownPct,
    metrics.totalPnlUsdc.toString(),
    verdict.verdict,
    metadata.strategyConfigHash,
    Math.round(durationMs),
  );

  if (runId === -1) {
    log.error('Failed to insert backtest run summary');
    return;
  }

  // Insert each trade into backtest_trades
  for (const trade of trades) {
    db.insertBacktestTrade(
      runId,
      trade.entryTime,
      trade.exitTime,
      trade.entryPrice,
      trade.exitPrice,
      trade.sizeUsdc.toString(),
      trade.pnlUsdc.toString(),
      trade.strategy,
      trade.regime,
      trade.exitReason,
    );
  }

  log.info('Persisted backtest results', {
    runId,
    trades: trades.length,
    verdict: verdict.verdict,
  });
}

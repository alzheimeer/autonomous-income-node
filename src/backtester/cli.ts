/**
 * Backtester CLI — Entry point for running offline backtests.
 *
 * Usage:
 *   pnpm backtest [--days 30] [--output data/backtest-results/]
 *
 * Arguments:
 *   --days, -d     Number of days to simulate (default: 30)
 *   --output, -o   Output directory for report files (default: data/backtest-results/)
 *
 * Exit codes:
 *   0 — Success
 *   1 — Failure (error printed to stderr)
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5
 */

import { parseArgs } from 'node:util';
import { loadConfig } from '../trading-validation/config.js';
import { DEFAULT_COST_PARAMS } from './backtest-cost-model.js';
import { DEFAULT_RISK_LIMITS } from './backtest-simulator.js';
import { runBacktest } from './backtest-runner.js';
import type { BacktestConfig } from './backtest-runner.js';
import { persistBacktestResults } from './index.js';
import { createMetricsDatabase } from '../pipeline-metrics/metrics-database.js';

// ═══════════════════════════════════════════════════════════════════════════
// CLI Argument Parsing
// ═══════════════════════════════════════════════════════════════════════════

const { values } = parseArgs({
  options: {
    days: { type: 'string', short: 'd', default: '30' },
    output: { type: 'string', short: 'o', default: 'data/backtest-results/' },
  },
  strict: true,
});

const days = parseInt(values.days!, 10);
const outputDir = values.output!;

if (isNaN(days) || days < 1) {
  process.stderr.write(`Error: --days must be a positive integer (got "${values.days}")\n`);
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Execution
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  process.stdout.write(`\n╔══════════════════════════════════════════╗\n`);
  process.stdout.write(`║     Signal Pipeline Backtester v0.1       ║\n`);
  process.stdout.write(`╚══════════════════════════════════════════╝\n\n`);
  process.stdout.write(`Configuration:\n`);
  process.stdout.write(`  Days: ${days}\n`);
  process.stdout.write(`  Output: ${outputDir}\n\n`);

  // Load strategy config from environment/defaults
  const tradingConfig = loadConfig();

  const config: BacktestConfig = {
    days,
    outputDir,
    strategyConfig: tradingConfig.strategy,
    costParams: DEFAULT_COST_PARAMS,
    riskLimits: DEFAULT_RISK_LIMITS,
    warmupCandles: 200,
  };

  const startTime = Date.now();

  const result = await runBacktest(config, (stage, detail) => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(`[${elapsed}s] [${stage}] ${detail}\n`);
  });

  // Print final summary
  const durationMs = Date.now() - startTime;
  const durationSec = (durationMs / 1000).toFixed(1);
  process.stdout.write(`\n`);
  process.stdout.write(`═══════════════════════════════════════════\n`);
  process.stdout.write(`  RESULT: ${result.verdict.verdict}\n`);
  process.stdout.write(`  ${result.verdict.rationale}\n`);
  process.stdout.write(`═══════════════════════════════════════════\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  Trades: ${result.metrics.totalTrades}\n`);
  process.stdout.write(`  Win Rate: ${result.metrics.winRate.toFixed(1)}%\n`);
  process.stdout.write(`  Profit Factor: ${result.metrics.profitFactor === Infinity ? '∞' : result.metrics.profitFactor.toFixed(2)}\n`);
  process.stdout.write(`  Total P&L: ${formatUsdc(result.metrics.totalPnlUsdc)}\n`);
  process.stdout.write(`  Max Drawdown: ${result.metrics.maxDrawdownPct.toFixed(1)}%\n`);
  process.stdout.write(`  Sharpe Ratio: ${result.metrics.sharpeRatio.toFixed(2)}\n`);
  process.stdout.write(`  Duration: ${durationSec}s\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`  Reports written to: ${outputDir}\n\n`);

  // Persist results to MetricsDatabase (best-effort: failure does not affect exit code)
  try {
    const db = createMetricsDatabase();
    persistBacktestResults(db, result, durationMs);
    db.close();
    process.stdout.write(`  Results persisted to metrics.db\n\n`);
  } catch {
    process.stderr.write(`  Warning: Failed to persist results to metrics.db (non-fatal)\n\n`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function formatUsdc(amount: bigint): string {
  const isNegative = amount < 0n;
  const abs = isNegative ? -amount : amount;
  const dollars = abs / 1_000_000n;
  const cents = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, 2);
  const sign = isNegative ? '-' : '';
  return `${sign}$${dollars}.${cents}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Entry Point
// ═══════════════════════════════════════════════════════════════════════════

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\nError: ${message}\n`);
  process.exit(1);
});

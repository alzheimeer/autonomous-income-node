#!/usr/bin/env tsx
/**
 * Evolution Scheduler — Standalone script invoked by Windows Task Scheduler.
 *
 * Zero dependency on AgentCore or TradingOrchestrator.
 * Opens data/evolution.db directly, performs operations, then exits.
 *
 * Usage: tsx src/evolution/evolution-scheduler.ts --mode daily|weekly|monthly
 *
 * Schedules:
 *   daily:   Diagnosis on ACTIVE + recent BACKTEST_FAIL strategies
 *   weekly:  Backtest top 5 priority CANDIDATE variants
 *   monthly: Evaluate DORMANT strategies for revival
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
 */

import { EvolutionDatabase } from './evolution-database.js';
import { DiagnosisEngine, type PerformanceData } from './diagnosis-engine.js';
import { CandleCache } from './candle-cache.js';
import { BacktestLab } from './backtest-lab.js';
import { DormancyRevival } from './dormancy-revival.js';
import { initializeBaseline } from './baseline.js';
import { main as runFundingArbBacktest } from './funding-arb/index.js';
import type { StrategyRecord, RegimeType } from './types.js';

const DB_PATH = 'data/evolution.db';

type ScheduleMode = 'daily' | 'weekly' | 'monthly';

// ═══════════════════════════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf('--mode');
  const mode = modeIdx >= 0 ? args[modeIdx + 1] as ScheduleMode : null;

  if (!mode || !['daily', 'weekly', 'monthly'].includes(mode)) {
    console.error('Usage: tsx src/evolution/evolution-scheduler.ts --mode daily|weekly|monthly');
    process.exit(1);
  }

  const db = new EvolutionDatabase(DB_PATH);

  if (db.isDegraded) {
    console.error('[Scheduler] Database failed to open — cannot proceed');
    process.exit(1);
  }

  initializeBaseline(db);

  try {
    console.log(`[Scheduler] Running ${mode} mode at ${new Date().toISOString()}`);

    switch (mode) {
      case 'daily': await runDaily(db); break;
      case 'weekly': await runWeekly(db); break;
      case 'monthly': await runMonthly(db); break;
    }

    console.log(`[Scheduler] ${mode} mode completed successfully`);
  } catch (err) {
    console.error(`[Scheduler] ${mode} mode failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  } finally {
    db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Daily Mode: Diagnose ACTIVE + recent BACKTEST_FAIL strategies
// ═══════════════════════════════════════════════════════════════════════════

async function runDaily(db: EvolutionDatabase): Promise<void> {
  const engine = new DiagnosisEngine();
  const active = db.getStrategiesByStatus('ACTIVE');
  const failed = db.getStrategiesByStatus('BACKTEST_FAIL');
  const strategies = [...active, ...failed];

  console.log(`[Daily] Diagnosing ${active.length} ACTIVE + ${failed.length} BACKTEST_FAIL strategies`);

  if (strategies.length === 0) {
    console.log('[Daily] No strategies to diagnose');
    return;
  }

  let totalDiagnoses = 0;

  for (const strategy of strategies) {
    const perfData = buildPerformanceData(strategy);
    const diagnoses = engine.diagnose(perfData);

    if (diagnoses.length > 0) {
      totalDiagnoses += diagnoses.length;
      console.log(`[Daily] Strategy ${strategy.strategy_id} (${strategy.status}):`);
      for (const d of diagnoses) {
        console.log(`  - ${d.code} (confidence: ${d.confidence.toFixed(2)}): ${d.description}`);
      }
    }
  }

  console.log(`[Daily] Diagnosis complete. Evaluated: ${strategies.length}, Findings: ${totalDiagnoses}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Weekly Mode: Backtest top 5 priority CANDIDATE variants
// ═══════════════════════════════════════════════════════════════════════════

async function runWeekly(db: EvolutionDatabase): Promise<void> {
  // ─── Part 1: Backtest CANDIDATE strategy variants ──────────────────────
  const candidates = db.getStrategiesByStatus('CANDIDATE');

  // Sort by created_at descending to prioritize newest candidates
  const sorted = candidates.sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  const top5 = sorted.slice(0, 5);

  if (top5.length === 0) {
    console.log('[Weekly] No CANDIDATE strategies to backtest');
  } else {
    console.log(`[Weekly] Backtesting ${top5.length} CANDIDATE strategies (of ${candidates.length} total)`);

    const cache = new CandleCache();
    const lab = new BacktestLab(db, cache);
    const results = await lab.runBatch(top5.map(s => s.strategy_id));

    const passed = results.filter(r => r.verdict === 'BACKTEST_PASS').length;
    const failed = results.filter(r => r.verdict === 'BACKTEST_FAIL').length;

    console.log(`[Weekly] Backtest results: ${passed} passed, ${failed} failed`);
    for (const result of results) {
      console.log(`  - ${result.strategy_id}: ${result.verdict}${
        result.failure_reasons.length > 0 ? ` (${result.failure_reasons.join(', ')})` : ''
      }`);
    }
  }

  // ─── Part 2: Funding-Arb Backtest (re-evaluate weekly) ─────────────────
  console.log('\n[Weekly] Running funding-arb backtest (ETH, 30 days, capitals: $500,$1000,$2000,$5000)...');
  try {
    // Override process.argv for the funding-arb CLI parser
    const originalArgv = process.argv;
    process.argv = [
      process.argv[0]!,
      process.argv[1]!,
      '--coins', 'ETH',
      '--days', '30',
      '--capitals', '500,1000,2000,5000',
    ];

    await runFundingArbBacktest();

    // Restore original argv
    process.argv = originalArgv;

    console.log('[Weekly] Funding-arb backtest completed successfully');
  } catch (err) {
    console.error('[Weekly] Funding-arb backtest failed:', err instanceof Error ? err.message : String(err));
    // Non-fatal — the weekly cycle continues even if funding-arb fails
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Monthly Mode: Evaluate DORMANT strategies for revival
// ═══════════════════════════════════════════════════════════════════════════

async function runMonthly(db: EvolutionDatabase): Promise<void> {
  const revival = new DormancyRevival(db);
  const dormant = db.getStrategiesByStatus('DORMANT');

  console.log(`[Monthly] Evaluating ${dormant.length} DORMANT strategies for revival`);

  if (dormant.length === 0) {
    console.log('[Monthly] No DORMANT strategies to evaluate');
    return;
  }

  // Determine current regime from the most recent data available.
  // Since the scheduler is standalone (no live feature engine), we read
  // the latest regime from experiment market_context or default to UNCERTAIN.
  const currentRegime = detectCurrentRegime(db);
  const consecutiveDays = estimateRegimePersistence(db, currentRegime);

  console.log(`[Monthly] Current regime: ${currentRegime}, persistence: ${consecutiveDays} days`);

  const { revived } = revival.evaluate(currentRegime, consecutiveDays);

  console.log(`[Monthly] Revival evaluation complete. Revived: ${revived.length}`);
  for (const id of revived) {
    console.log(`  - ${id}: DORMANT → SHADOW (revival triggered)`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build PerformanceData from a strategy's stored evidence.
 * Uses available evidence fields; defaults to safe values when data is missing.
 */
function buildPerformanceData(strategy: StrategyRecord): PerformanceData {
  const evidence = strategy.evidence;
  const trades = evidence.trades ?? 0;
  const pnlStr = evidence.pnl ?? '0';
  const pnl = BigInt(pnlStr);
  const winRate = evidence.win_rate ?? 0;

  // Derive approximate values from available evidence
  const grossProfit = pnl > 0n ? pnl : 0n;
  const grossLoss = pnl < 0n ? -pnl : 0n;

  return {
    total_trades: trades,
    gross_profit: grossProfit,
    gross_loss: grossLoss,
    total_costs: 0n,
    avg_tp_distance_bps: 100, // Placeholder — would come from detailed trade analysis
    sl_hit_rate: winRate === 0 ? 1.0 : (1 - winRate / 100),
    avg_mae_vs_stop: 0.15,
    raw_signals: trades,
    filtered_signals: 0,
    regime_opportunities: trades > 0 ? 10 : 2,
    net_pnl_per_winner: trades > 0 && winRate > 0
      ? grossProfit / BigInt(Math.max(1, Math.round(trades * winRate / 100)))
      : 0n,
    tp_gains_positive: grossProfit > 0n,
    risk_metrics_in_bounds: true,
    period_days: evidence.period ? parseInt(evidence.period, 10) || 30 : 30,
  };
}

/**
 * Detect current regime from the most recent experiment's market context.
 * Falls back to UNCERTAIN if no experiments exist.
 */
function detectCurrentRegime(db: EvolutionDatabase): RegimeType {
  const allStrategies = db.getAllStrategies();
  let latestDate = '';
  let latestRegime: RegimeType = 'UNCERTAIN';

  for (const strategy of allStrategies) {
    const experiment = db.getLatestExperiment(strategy.strategy_id);
    if (experiment && experiment.created_at > latestDate) {
      latestDate = experiment.created_at;
      latestRegime = experiment.market_context.dominant_regime;
    }
  }

  return latestRegime;
}

/**
 * Estimate how many consecutive days the current regime has persisted.
 * Examines recent experiments to find when the regime last changed.
 * Falls back to a conservative estimate of 5 days if insufficient data.
 */
function estimateRegimePersistence(db: EvolutionDatabase, currentRegime: RegimeType): number {
  const allStrategies = db.getAllStrategies();

  // Collect all experiments with their market_context
  const experiments: { created_at: string; regime: RegimeType }[] = [];
  for (const strategy of allStrategies) {
    const exps = db.getExperimentsForStrategy(strategy.strategy_id);
    for (const exp of exps) {
      experiments.push({
        created_at: exp.created_at,
        regime: exp.market_context.dominant_regime,
      });
    }
  }

  if (experiments.length === 0) {
    return 5; // Conservative fallback
  }

  // Sort newest first
  experiments.sort((a, b) =>
    new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  // Count consecutive experiments with matching regime from newest
  let consecutiveDays = 0;
  const now = Date.now();

  for (const exp of experiments) {
    if (exp.regime === currentRegime) {
      const daysDiff = Math.floor((now - new Date(exp.created_at).getTime()) / (24 * 60 * 60 * 1000));
      consecutiveDays = Math.max(consecutiveDays, daysDiff);
    } else {
      break;
    }
  }

  return Math.max(consecutiveDays, 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Script Execution
// ═══════════════════════════════════════════════════════════════════════════

main().catch((err) => {
  console.error('[Scheduler] Fatal error:', err);
  process.exit(1);
});

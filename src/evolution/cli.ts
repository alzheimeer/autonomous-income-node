#!/usr/bin/env tsx
/**
 * Evolution Lab CLI
 * Entry: tsx src/evolution/cli.ts <command> [options]
 *
 * Provides 8 commands for operating the Strategy Evolution Lab:
 *   status, diagnose, generate-variants, backtest, backtest-all,
 *   shadow-report, run-cycle, promote
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9
 */

import { EvolutionDatabase } from './evolution-database.js';
import { StrategyRegistry } from './strategy-registry.js';
import { DiagnosisEngine, type PerformanceData, type DiagnosisResult } from './diagnosis-engine.js';
import { VariantGenerator, type DiagnosisResult as VariantDiagnosisResult } from './variant-generator.js';
import { CandleCache } from './candle-cache.js';
import { BacktestLab } from './backtest-lab.js';
import { ShadowTournament } from './shadow-tournament.js';
import { PromotionEngine } from './promotion-engine.js';
import { EvolutionReport } from './evolution-report.js';
import { initializeBaseline } from './baseline.js';
import { main as runFundingArbBacktest } from './funding-arb/index.js';
import { VALID_STATUSES } from './types.js';
import type { StrategyRecord } from './types.js';

const DB_PATH = 'data/evolution.db';

// ═══════════════════════════════════════════════════════════════════════════
// Main entry point
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    printUsage();
    process.exit(1);
  }

  const db = new EvolutionDatabase(DB_PATH);
  initializeBaseline(db); // idempotent

  try {
    switch (command) {
      case 'status': await cmdStatus(db); break;
      case 'diagnose': await cmdDiagnose(db, args[1]); break;
      case 'generate-variants': await cmdGenerateVariants(db, args[1]); break;
      case 'backtest': await cmdBacktest(db, args[1]); break;
      case 'backtest-all': await cmdBacktestAll(db); break;
      case 'funding-arb': await cmdFundingArb(db); break;
      case 'shadow-report': await cmdShadowReport(db); break;
      case 'run-cycle': await cmdRunCycle(db); break;
      case 'promote': await cmdPromote(db, args[1]); break;
      default:
        console.error(`Unknown command: ${command}`);
        printUsage();
        process.exit(1);
    }
  } finally {
    db.close();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Usage
// ═══════════════════════════════════════════════════════════════════════════

function printUsage(): void {
  console.log(`
Evolution Lab CLI

Usage: tsx src/evolution/cli.ts <command> [options]

Commands:
  status                          Show all strategies grouped by lifecycle status
  diagnose <strategy_id>          Run diagnosis on a strategy
  generate-variants <parent_id>   Generate variants from parent strategy
  backtest <strategy_id>          Backtest a single variant
  backtest-all                    Backtest all CANDIDATE strategies
  funding-arb                     Run funding-arb backtest (ETH, 30d, default capitals)
  shadow-report                   Show shadow tournament standings
  run-cycle                       Full cycle: diagnose → generate → backtest → update
  promote <strategy_id>           Advance strategy to next state
`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Command Handlers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * status: Display all strategies grouped by lifecycle status.
 * Requirement: 11.2
 */
async function cmdStatus(db: EvolutionDatabase): Promise<void> {
  const registry = new StrategyRegistry(db);
  const grouped = registry.groupByStatus();

  console.log('\n=== Strategy Evolution Lab — Status ===\n');

  let totalCount = 0;
  for (const status of VALID_STATUSES) {
    const strategies = grouped.get(status) || [];
    if (strategies.length === 0) continue;
    totalCount += strategies.length;
    console.log(`[${status}] (${strategies.length})`);
    for (const s of strategies) {
      const idShort = s.strategy_id.slice(0, 8);
      const hashShort = s.config_hash.slice(0, 12);
      const tags = s.tags.length > 0 ? s.tags.join(', ') : 'none';
      console.log(`  • ${idShort}... | hash: ${hashShort}... | tags: ${tags}`);
    }
    console.log('');
  }

  console.log(`Total strategies: ${totalCount}`);
  console.log('');
}

/**
 * diagnose <strategy_id>: Run DiagnosisEngine against a strategy.
 * Uses evidence from the strategy record to construct PerformanceData.
 * If no performance data is available, uses baseline placeholder data.
 * Requirement: 11.3
 */
async function cmdDiagnose(db: EvolutionDatabase, strategyId?: string): Promise<void> {
  if (!strategyId) {
    console.error('Error: strategy_id is required');
    console.error('Usage: tsx src/evolution/cli.ts diagnose <strategy_id>');
    process.exit(1);
  }

  const strategy = db.getStrategy(strategyId);
  if (!strategy) {
    console.error(`Error: Strategy "${strategyId}" not found`);
    process.exit(1);
  }

  const engine = new DiagnosisEngine();
  const perfData = buildPerformanceData(strategy);

  console.log(`\n=== Diagnosis: ${strategyId.slice(0, 8)}... ===\n`);
  console.log(`Status: ${strategy.status}`);
  console.log(`Config hash: ${strategy.config_hash.slice(0, 16)}...`);
  console.log('');

  const diagnoses = engine.diagnose(perfData);

  if (diagnoses.length === 0) {
    console.log('No diagnostic findings — all rules pass or insufficient data.');
  } else {
    console.log(`Found ${diagnoses.length} diagnosis(es):\n`);
    for (let i = 0; i < diagnoses.length; i++) {
      const d = diagnoses[i];
      console.log(`  ${i + 1}. [${d.code}] (confidence: ${d.confidence.toFixed(2)})`);
      console.log(`     ${d.description}`);
      if (d.suggested_adjustments.length > 0) {
        for (const adj of d.suggested_adjustments) {
          console.log(`     → ${adj.parameter}: ${adj.direction} to ${adj.suggested_values.join(' | ')}`);
        }
      }
      console.log('');
    }
  }
}

/**
 * generate-variants <parent_id>: Run VariantGenerator for the given parent.
 * Requirement: 11.4
 */
async function cmdGenerateVariants(db: EvolutionDatabase, parentId?: string): Promise<void> {
  if (!parentId) {
    console.error('Error: parent_id is required');
    console.error('Usage: tsx src/evolution/cli.ts generate-variants <parent_id>');
    process.exit(1);
  }

  const parent = db.getStrategy(parentId);
  if (!parent) {
    console.error(`Error: Parent strategy "${parentId}" not found`);
    process.exit(1);
  }

  // Run diagnosis first to inform variant generation
  const engine = new DiagnosisEngine();
  const perfData = buildPerformanceData(parent);
  const diagnoses = engine.diagnose(perfData);

  const generator = new VariantGenerator(db);
  const variantDiagnoses = toVariantDiagnoses(diagnoses);
  const variants = generator.generate(parent, variantDiagnoses);

  console.log(`\n=== Variant Generation from ${parentId.slice(0, 8)}... ===\n`);
  console.log(`Parent: ${parentId.slice(0, 8)}... [${parent.status}]`);
  console.log(`Diagnoses used: ${diagnoses.map(d => d.code).join(', ') || 'none'}`);
  console.log(`Variants generated: ${variants.length}\n`);

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const tags = v.tags.length > 0 ? v.tags.join(', ') : 'none';
    console.log(`  ${i + 1}. ${v.strategy_id.slice(0, 8)}... | tags: ${tags}`);
    console.log(`     stop_atr=${v.parameters.stop_atr}, tp_atr=${v.parameters.tp_atr}, trade_size=${v.parameters.trade_size}`);
  }
  console.log('');
}

/**
 * backtest <strategy_id>: Run a single backtest and display results.
 * Requirement: 11.5
 */
async function cmdBacktest(db: EvolutionDatabase, strategyId?: string): Promise<void> {
  if (!strategyId) {
    console.error('Error: strategy_id is required');
    console.error('Usage: tsx src/evolution/cli.ts backtest <strategy_id>');
    process.exit(1);
  }

  const strategy = db.getStrategy(strategyId);
  if (!strategy) {
    console.error(`Error: Strategy "${strategyId}" not found`);
    process.exit(1);
  }

  console.log(`\n=== Backtesting: ${strategyId.slice(0, 8)}... ===\n`);
  console.log(`Status: ${strategy.status} → BACKTESTING`);

  const cache = new CandleCache();
  const lab = new BacktestLab(db, cache);

  try {
    const result = await lab.runSingle(strategyId);

    console.log(`\nResult: ${result.verdict}`);
    console.log(`  Trades: ${result.metrics.totalTrades}`);
    console.log(`  Win rate: ${(result.metrics.winRate * 100).toFixed(1)}%`);
    console.log(`  Profit factor: ${result.metrics.profitFactor.toFixed(2)}`);
    console.log(`  Max drawdown: ${result.metrics.maxDrawdownPct.toFixed(2)}%`);
    console.log(`  Sharpe ratio: ${result.metrics.sharpeRatio.toFixed(2)}`);
    console.log(`  Total PnL: ${result.metrics.totalPnlUsdc.toString()}`);

    if (result.failure_reasons.length > 0) {
      console.log(`\n  Failure reasons:`);
      for (const reason of result.failure_reasons) {
        console.log(`    - ${reason}`);
      }
    }

    console.log(`\n  Experiment ID: ${result.experiment_id}`);
  } catch (err) {
    console.error(`Backtest failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  console.log('');
}

/**
 * backtest-all: Batch backtest all CANDIDATE strategies.
 * Requirement: 11.6
 */
async function cmdBacktestAll(db: EvolutionDatabase): Promise<void> {
  const candidates = db.getStrategiesByStatus('CANDIDATE');

  if (candidates.length === 0) {
    console.log('\nNo CANDIDATE strategies to backtest.\n');
    return;
  }

  console.log(`\n=== Batch Backtest — ${candidates.length} CANDIDATE strategies ===\n`);

  const cache = new CandleCache();
  const lab = new BacktestLab(db, cache);

  const results = await lab.runAll();

  const passed = results.filter(r => r.verdict === 'BACKTEST_PASS');
  const failed = results.filter(r => r.verdict === 'BACKTEST_FAIL');

  console.log(`\nResults:`);
  console.log(`  Passed: ${passed.length}`);
  console.log(`  Failed: ${failed.length}`);
  console.log('');

  for (const r of results) {
    const icon = r.verdict === 'BACKTEST_PASS' ? '✓' : '✗';
    console.log(`  ${icon} ${r.strategy_id.slice(0, 8)}... → ${r.verdict}`);
    if (r.failure_reasons.length > 0) {
      console.log(`    Reasons: ${r.failure_reasons.join('; ')}`);
    }
  }
  console.log('');
}

/**
 * funding-arb: Run funding-arb backtest with default parameters.
 * Uses ETH, 30 days, capitals $500,$1000,$2000,$5000.
 * Delegates to the funding-arb module's main() function.
 */
async function cmdFundingArb(_db: EvolutionDatabase): Promise<void> {
  console.log('\n=== Funding-Arb Backtest ===\n');
  console.log('Running: ETH, 30 days, capitals: $500, $1000, $2000, $5000\n');

  // Override process.argv for the funding-arb CLI parser
  const originalArgv = process.argv;
  process.argv = [
    process.argv[0]!,
    process.argv[1]!,
    '--coins', 'ETH',
    '--days', '30',
    '--capitals', '500,1000,2000,5000',
  ];

  try {
    await runFundingArbBacktest();
  } finally {
    process.argv = originalArgv;
  }
}

/**
 * shadow-report: Display current Shadow Tournament standings.
 * Requirement: 11.7
 */
async function cmdShadowReport(db: EvolutionDatabase): Promise<void> {
  const tournament = new ShadowTournament(db);

  // Check for strategies currently in SHADOW status
  const shadowStrategies = db.getStrategiesByStatus('SHADOW');

  console.log('\n=== Shadow Tournament Report ===\n');

  if (shadowStrategies.length === 0) {
    console.log('No strategies currently in SHADOW phase.');
    console.log('Run `backtest-all` to produce BACKTEST_PASS candidates for shadow testing.\n');
    return;
  }

  // Get standings from tournament (would be populated if tournament was active)
  const standings = tournament.getStandings();

  if (standings.length === 0) {
    // Show strategies in SHADOW status even if no active tournament
    console.log(`Strategies in SHADOW status (${shadowStrategies.length}):\n`);
    for (const s of shadowStrategies) {
      console.log(`  • ${s.strategy_id.slice(0, 8)}... | tags: ${s.tags.join(', ') || 'none'}`);
    }
  } else {
    console.log(`Participants: ${standings.length}\n`);
    for (const p of standings) {
      const pnlStr = p.metrics.pnl.toString();
      console.log(`  [${p.role.toUpperCase()}] ${p.strategy_id.slice(0, 8)}...`);
      console.log(`    Trades: ${p.metrics.trades} | PnL: ${pnlStr} | PF: ${p.metrics.profit_factor.toFixed(2)} | Slippage: ${p.metrics.estimated_slippage.toFixed(1)} bps`);
    }
  }

  // Also show SHADOW_PASS / SHADOW_FAIL if any
  const passed = db.getStrategiesByStatus('SHADOW_PASS');
  const failed = db.getStrategiesByStatus('SHADOW_FAIL');

  if (passed.length > 0 || failed.length > 0) {
    console.log('\n--- Completed Shadow Results ---');
    for (const s of passed) {
      console.log(`  ✓ ${s.strategy_id.slice(0, 8)}... → SHADOW_PASS`);
    }
    for (const s of failed) {
      console.log(`  ✗ ${s.strategy_id.slice(0, 8)}... → SHADOW_FAIL`);
    }
  }
  console.log('');
}

/**
 * run-cycle: Full evolution cycle — diagnose → generate-variants → backtest-all → update.
 * Requirement: 11.8
 */
async function cmdRunCycle(db: EvolutionDatabase): Promise<void> {
  console.log('\n=== Evolution Cycle: Full Run ===\n');
  const cycleStart = new Date().toISOString();

  const registry = new StrategyRegistry(db);
  const diagEngine = new DiagnosisEngine();
  const reporter = new EvolutionReport(db);

  // Step 1: Diagnose — run on all ACTIVE and ARCHIVED_BASELINE strategies
  console.log('Step 1: Diagnosis');
  const activeStrategies = [
    ...db.getStrategiesByStatus('ACTIVE'),
    ...db.getStrategiesByStatus('ARCHIVED_BASELINE'),
  ];

  const allDiagnoses: { strategy_id: string; diagnoses: ReturnType<DiagnosisEngine['diagnose']> }[] = [];

  for (const s of activeStrategies) {
    const perfData = buildPerformanceData(s);
    const diagnoses = diagEngine.diagnose(perfData);
    if (diagnoses.length > 0) {
      allDiagnoses.push({ strategy_id: s.strategy_id, diagnoses });
    }
  }

  console.log(`  Evaluated: ${activeStrategies.length} strategies`);
  console.log(`  Findings: ${allDiagnoses.reduce((acc, d) => acc + d.diagnoses.length, 0)} total diagnoses`);

  // Step 2: Generate variants from diagnosed strategies
  console.log('\nStep 2: Variant Generation');
  const generator = new VariantGenerator(db);
  let totalVariants = 0;

  for (const { strategy_id, diagnoses } of allDiagnoses) {
    const parent = db.getStrategy(strategy_id);
    if (!parent) continue;
    const variantDiagnoses = toVariantDiagnoses(diagnoses);
    const variants = generator.generate(parent, variantDiagnoses);
    totalVariants += variants.length;
  }

  console.log(`  Variants generated: ${totalVariants}`);

  // Step 3: Backtest all CANDIDATE strategies
  console.log('\nStep 3: Batch Backtest');
  const candidates = db.getStrategiesByStatus('CANDIDATE');

  let backtestPassed = 0;
  let backtestFailed = 0;

  if (candidates.length > 0) {
    const cache = new CandleCache();
    const lab = new BacktestLab(db, cache);
    const results = await lab.runAll();
    backtestPassed = results.filter(r => r.verdict === 'BACKTEST_PASS').length;
    backtestFailed = results.filter(r => r.verdict === 'BACKTEST_FAIL').length;
  }

  console.log(`  Candidates tested: ${candidates.length}`);
  console.log(`  Passed: ${backtestPassed}`);
  console.log(`  Failed: ${backtestFailed}`);

  // Step 4: Generate report
  console.log('\nStep 4: Report Generation');
  const landscape = reporter.getStrategyLandscape();
  const flatDiagnoses = allDiagnoses.flatMap(d => d.diagnoses);

  const cycleData = {
    timestamp: cycleStart,
    strategies_evaluated: activeStrategies.length,
    diagnoses_found: flatDiagnoses,
    variants_generated: totalVariants,
    backtest_results: { passed: backtestPassed, failed: backtestFailed },
    promotions: [] as string[],
    demotions: [] as string[],
    strategy_landscape: landscape,
    top_performers: [] as { strategy_id: string; score: number; metrics: import('./types.js').ExperimentMetrics }[],
    next_actions: generateNextActions(backtestPassed, totalVariants, flatDiagnoses.length),
  };

  const report = reporter.generateCycleReport(cycleData);
  const savedPath = reporter.saveReport(report);

  console.log(`  Report saved: ${savedPath}.md`);
  console.log(`  Report saved: ${savedPath}.json`);
  console.log(`\n=== Cycle Complete ===\n`);
}

/**
 * promote <strategy_id>: Advance strategy to next valid state.
 * Requests confirmation when operator approval is needed.
 * Requirement: 11.9
 */
async function cmdPromote(db: EvolutionDatabase, strategyId?: string): Promise<void> {
  if (!strategyId) {
    console.error('Error: strategy_id is required');
    console.error('Usage: tsx src/evolution/cli.ts promote <strategy_id>');
    process.exit(1);
  }

  const strategy = db.getStrategy(strategyId);
  if (!strategy) {
    console.error(`Error: Strategy "${strategyId}" not found`);
    process.exit(1);
  }

  const engine = new PromotionEngine(db);

  console.log(`\n=== Promote: ${strategyId.slice(0, 8)}... ===\n`);
  console.log(`Current status: ${strategy.status}`);

  const result = engine.promote(strategyId);

  if (result.success) {
    console.log(`Promoted: ${result.from} → ${result.to}`);
    console.log(`Reason: ${result.reason}`);
  } else if (result.requires_approval) {
    console.log(`Promotion requires operator approval:`);
    console.log(`  Transition: ${result.from} → ${result.to}`);
    console.log(`  Reason: ${result.reason}`);
    console.log(`  Pending ID: ${result.pending_id}`);
    console.log(`\n  To approve: manually resolve via API or code.`);
  } else {
    console.log(`Promotion failed: ${result.reason}`);
  }

  // Show any pending promotions
  const pending = db.getPendingPromotions();
  if (pending.length > 0) {
    console.log(`\nPending promotions (${pending.length}):`);
    for (const p of pending) {
      if (p.resolved) continue;
      console.log(`  • ${p.strategy_id.slice(0, 8)}... : ${p.from_status} → ${p.to_status} (awaiting approval)`);
    }
  }
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert DiagnosisResult from diagnosis-engine format to variant-generator format.
 * The two modules define their own DiagnosisResult interfaces:
 * - diagnosis-engine uses suggested_adjustments: ParameterAdjustment[]
 * - variant-generator uses suggested_adjustments: Partial<StrategyParameters>
 */
function toVariantDiagnoses(diagnoses: DiagnosisResult[]): VariantDiagnosisResult[] {
  return diagnoses.map((d) => ({
    code: d.code,
    confidence: d.confidence,
    description: d.description,
    suggested_adjustments: diagAdjustmentsToPartial(d.suggested_adjustments),
  }));
}

/**
 * Convert ParameterAdjustment[] to Partial<StrategyParameters>.
 * Takes the first suggested value for each adjusted parameter.
 */
function diagAdjustmentsToPartial(
  adjustments: DiagnosisResult['suggested_adjustments'],
): Partial<import('./types.js').StrategyParameters> {
  const partial: Partial<import('./types.js').StrategyParameters> = {};
  for (const adj of adjustments) {
    if (adj.suggested_values.length > 0) {
      const value = adj.suggested_values[0];
      switch (adj.parameter) {
        case 'stop_atr':
        case 'tp_atr':
        case 'rsi_reversion':
        case 'volumeZ':
          partial[adj.parameter] = value as number;
          break;
        case 'trade_size':
        case 'entry_tf':
        case 'regime_tf':
          partial[adj.parameter] = value as string;
          break;
        case 'rsi_trend':
          // rsi_trend adjustments are typically individual bounds
          break;
      }
    }
  }
  return partial;
}

/**
 * Build PerformanceData from a StrategyRecord's evidence.
 * Uses available data from evidence metadata, filling in defaults
 * where specific metrics are not available.
 */
function buildPerformanceData(strategy: StrategyRecord): PerformanceData {
  const evidence = strategy.evidence;
  const trades = evidence.trades ?? 0;
  const winRate = evidence.win_rate ?? 0;
  const pnlStr = evidence.pnl ?? '0';
  const pnl = BigInt(pnlStr);

  // Derive approximate performance data from evidence
  // These are estimates based on available data from the baseline
  const grossProfit = pnl > 0n ? pnl : 0n;
  const grossLoss = pnl < 0n ? -pnl : 0n;

  // Estimate costs based on typical Binance fees (0.1% taker)
  // For 17 trades at ~$10 = ~$0.17 estimated total costs
  const estimatedCosts = BigInt(trades) * 100000n; // ~$0.10 per trade in 6-decimal

  return {
    total_trades: trades,
    gross_profit: grossProfit,
    gross_loss: grossLoss,
    total_costs: estimatedCosts,
    avg_tp_distance_bps: strategy.parameters.tp_atr * 75, // rough: ATR mult * 75 bps
    sl_hit_rate: 1.0 - winRate, // inverse of win rate as proxy
    avg_mae_vs_stop: 0.15, // default assumption
    raw_signals: Math.max(trades * 2, 20), // assume ~50% signal-to-trade conversion
    filtered_signals: trades,
    regime_opportunities: Math.max(trades, 5),
    net_pnl_per_winner: trades > 0 && winRate > 0
      ? pnl / BigInt(Math.max(1, Math.round(trades * winRate)))
      : -100000n,
    tp_gains_positive: winRate > 0,
    risk_metrics_in_bounds: true, // assume risk is ok unless evidence says otherwise
    period_days: evidence.period === '30d' ? 30 : 30, // default to 30 days
  };
}

/**
 * Generate suggested next actions based on cycle results.
 */
function generateNextActions(backtestPassed: number, variantsGenerated: number, diagnosesCount: number): string[] {
  const actions: string[] = [];

  if (backtestPassed > 0) {
    actions.push(`Start shadow tournament for ${backtestPassed} BACKTEST_PASS variants`);
  }

  if (variantsGenerated === 0 && diagnosesCount > 0) {
    actions.push('Review diagnosis findings and manually create targeted variants');
  }

  if (variantsGenerated > 0 && backtestPassed === 0) {
    actions.push('Review backtest failures — consider relaxing robustness thresholds or adjusting variant parameters');
  }

  if (diagnosesCount === 0) {
    actions.push('All evaluated strategies pass diagnostic rules — consider expanding parameter search space');
  }

  actions.push('Schedule next cycle (weekly recommended for CANDIDATE backtest batch)');

  return actions;
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

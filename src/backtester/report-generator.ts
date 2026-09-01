/**
 * ReportGenerator — Generates structured output files from backtest results.
 *
 * Output files:
 * - report.json: complete results (trades, metrics, metadata, verdict)
 * - report.md: human-readable markdown summary
 * - trades.csv: one row per trade
 * - equity_curve.json: array of {timestamp, portfolio_value_usdc}
 *
 * Requirements: 13.1, 13.2, 13.3
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SimulatedTrade, EquityPoint } from './backtest-simulator.js';
import type { BacktestMetrics, BacktestMetadata } from './backtest-runner.js';
import type { VerdictResult } from './verdict-engine.js';

// ═══════════════════════════════════════════════════════════════════════════
// ReportGenerator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generates all report files and writes them to the output directory.
 */
export function generateReports(
  trades: SimulatedTrade[],
  metrics: BacktestMetrics,
  verdict: VerdictResult,
  metadata: BacktestMetadata,
  equityCurve: EquityPoint[],
  outputDir: string,
): void {
  // Ensure output directory exists
  mkdirSync(outputDir, { recursive: true });

  // Generate each report file
  writeReportJson(trades, metrics, verdict, metadata, outputDir);
  writeReportMarkdown(trades, metrics, verdict, metadata, outputDir);
  writeTradesCsv(trades, outputDir);
  writeEquityCurveJson(equityCurve, outputDir);
}

// ═══════════════════════════════════════════════════════════════════════════
// report.json
// ═══════════════════════════════════════════════════════════════════════════

function writeReportJson(
  trades: SimulatedTrade[],
  metrics: BacktestMetrics,
  verdict: VerdictResult,
  metadata: BacktestMetadata,
  outputDir: string,
): void {
  const report = {
    metadata: serializeMetadata(metadata),
    metrics: serializeMetrics(metrics),
    verdict,
    trades: trades.map(serializeTrade),
  };

  const content = JSON.stringify(report, null, 2);
  writeFileSync(join(outputDir, 'report.json'), content, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════
// report.md
// ═══════════════════════════════════════════════════════════════════════════

function writeReportMarkdown(
  trades: SimulatedTrade[],
  metrics: BacktestMetrics,
  verdict: VerdictResult,
  metadata: BacktestMetadata,
  outputDir: string,
): void {
  const lines: string[] = [];

  lines.push('# Backtest Report');
  lines.push('');
  lines.push(`**Verdict: ${verdict.verdict}**`);
  lines.push(`> ${verdict.rationale}`);
  lines.push('');

  // Metadata section
  lines.push('## Metadata');
  lines.push('');
  lines.push(`| Parameter | Value |`);
  lines.push(`|-----------|-------|`);
  lines.push(`| Start Date | ${metadata.startDate} |`);
  lines.push(`| End Date | ${metadata.endDate} |`);
  lines.push(`| Days Simulated | ${metadata.daysSimulated} |`);
  lines.push(`| Candles Processed | ${metadata.candlesProcessed} |`);
  lines.push(`| Strategy Config Hash | \`${metadata.strategyConfigHash.slice(0, 12)}...\` |`);
  lines.push(`| Cost: Gas/tx | ${formatUsdc(metadata.costModelParams.gasPerTxUsdc)} |`);
  lines.push(`| Cost: Slippage | ${metadata.costModelParams.slippageBps}bps |`);
  lines.push(`| Cost: DEX Fee | ${metadata.costModelParams.dexFeeBps}bps |`);
  lines.push(`| Cost: Safety Margin | ${metadata.costModelParams.safetyMarginBps}bps |`);
  lines.push(`| Risk: Starting Bankroll | ${formatUsdc(metadata.riskLimits.startingBankroll)} |`);
  lines.push(`| Risk: Max Trades/Day | ${metadata.riskLimits.maxTradesPerDay} |`);
  lines.push(`| Risk: Max Daily Loss | ${formatUsdc(metadata.riskLimits.maxDailyLossUsdc)} |`);
  lines.push(`| Risk: Cooldown | ${metadata.riskLimits.cooldownMs / 60_000}min |`);
  lines.push('');

  // Metrics section
  lines.push('## Performance Metrics');
  lines.push('');
  lines.push(`| Metric | Value |`);
  lines.push(`|--------|-------|`);
  lines.push(`| Total Trades | ${metrics.totalTrades} |`);
  lines.push(`| Win Rate | ${metrics.winRate.toFixed(1)}% |`);
  lines.push(`| Profit Factor | ${metrics.profitFactor === Infinity ? '∞' : metrics.profitFactor.toFixed(2)} |`);
  lines.push(`| Total P&L | ${formatUsdc(metrics.totalPnlUsdc)} |`);
  lines.push(`| Total Costs | ${formatUsdc(metrics.totalCostsUsdc)} |`);
  lines.push(`| Avg P&L/Trade | ${formatUsdc(metrics.avgPnlPerTrade)} |`);
  lines.push(`| Best Trade | ${formatUsdc(metrics.bestTrade)} |`);
  lines.push(`| Worst Trade | ${formatUsdc(metrics.worstTrade)} |`);
  lines.push(`| Max Drawdown | ${metrics.maxDrawdownPct.toFixed(1)}% (${formatUsdc(metrics.maxDrawdownUsdc)}) |`);
  lines.push(`| Sharpe Ratio | ${metrics.sharpeRatio.toFixed(2)} |`);
  lines.push(`| Avg Trade Duration | ${formatDuration(metrics.avgTradeDurationMs)} |`);
  lines.push(`| Trades/Day | ${metrics.tradesPerDay.toFixed(1)} |`);
  lines.push(`| Buy & Hold P&L | ${formatUsdc(metrics.buyAndHoldPnlUsdc)} |`);
  lines.push('');

  // Trade summary
  lines.push('## Trade Summary');
  lines.push('');
  if (trades.length === 0) {
    lines.push('No trades executed.');
  } else {
    lines.push(`| # | Entry | Exit | Strategy | Regime | Exit Reason | P&L |`);
    lines.push(`|---|-------|------|----------|--------|-------------|-----|`);
    const displayTrades = trades.slice(0, 50); // Limit to first 50
    for (let i = 0; i < displayTrades.length; i++) {
      const t = displayTrades[i]!;
      lines.push(
        `| ${i + 1} | ${formatTimestamp(t.entryTime)} | ${formatTimestamp(t.exitTime)} ` +
        `| ${t.strategy} | ${t.regime} | ${t.exitReason} | ${formatUsdc(t.pnlUsdc)} |`,
      );
    }
    if (trades.length > 50) {
      lines.push(`| ... | ... | ... | ... | ... | ... | ... |`);
      lines.push(`*Showing first 50 of ${trades.length} trades. Full list in trades.csv*`);
    }
  }
  lines.push('');

  const content = lines.join('\n');
  writeFileSync(join(outputDir, 'report.md'), content, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════
// trades.csv
// ═══════════════════════════════════════════════════════════════════════════

function writeTradesCsv(trades: SimulatedTrade[], outputDir: string): void {
  const header = 'entry_time,exit_time,entry_price,exit_price,size_usdc,pnl_usdc,pnl_bps,strategy,regime,exit_reason';
  const rows = trades.map(t =>
    [
      t.entryTime,
      t.exitTime,
      t.entryPrice.toFixed(6),
      t.exitPrice.toFixed(6),
      t.sizeUsdc.toString(),
      t.pnlUsdc.toString(),
      t.pnlBps,
      t.strategy,
      t.regime,
      t.exitReason,
    ].join(','),
  );

  const content = [header, ...rows].join('\n');
  writeFileSync(join(outputDir, 'trades.csv'), content, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════
// equity_curve.json
// ═══════════════════════════════════════════════════════════════════════════

function writeEquityCurveJson(equityCurve: EquityPoint[], outputDir: string): void {
  const data = equityCurve.map(p => ({
    timestamp: p.timestamp,
    portfolio_value_usdc: p.bankrollUsdc.toString(),
  }));

  const content = JSON.stringify(data, null, 2);
  writeFileSync(join(outputDir, 'equity_curve.json'), content, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════════════
// Serialization Helpers
// ═══════════════════════════════════════════════════════════════════════════

function serializeMetadata(metadata: BacktestMetadata): Record<string, unknown> {
  return {
    startDate: metadata.startDate,
    endDate: metadata.endDate,
    daysSimulated: metadata.daysSimulated,
    candlesProcessed: metadata.candlesProcessed,
    costModelParams: {
      gasPerTxUsdc: metadata.costModelParams.gasPerTxUsdc.toString(),
      slippageBps: metadata.costModelParams.slippageBps.toString(),
      dexFeeBps: metadata.costModelParams.dexFeeBps.toString(),
      safetyMarginBps: metadata.costModelParams.safetyMarginBps.toString(),
    },
    riskLimits: {
      maxOpenPositions: metadata.riskLimits.maxOpenPositions,
      minSizeUsdc: metadata.riskLimits.minSizeUsdc.toString(),
      maxSizeUsdc: metadata.riskLimits.maxSizeUsdc.toString(),
      maxTradesPerDay: metadata.riskLimits.maxTradesPerDay,
      maxDailyLossUsdc: metadata.riskLimits.maxDailyLossUsdc.toString(),
      cooldownMs: metadata.riskLimits.cooldownMs,
      startingBankroll: metadata.riskLimits.startingBankroll.toString(),
    },
    strategyConfigHash: metadata.strategyConfigHash,
  };
}

function serializeMetrics(metrics: BacktestMetrics): Record<string, unknown> {
  return {
    totalTrades: metrics.totalTrades,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor === Infinity ? 'Infinity' : metrics.profitFactor,
    maxDrawdownPct: metrics.maxDrawdownPct,
    maxDrawdownUsdc: metrics.maxDrawdownUsdc.toString(),
    sharpeRatio: metrics.sharpeRatio,
    avgTradeDurationMs: metrics.avgTradeDurationMs,
    avgPnlPerTrade: metrics.avgPnlPerTrade.toString(),
    totalPnlUsdc: metrics.totalPnlUsdc.toString(),
    totalCostsUsdc: metrics.totalCostsUsdc.toString(),
    buyAndHoldPnlUsdc: metrics.buyAndHoldPnlUsdc.toString(),
    tradesPerDay: metrics.tradesPerDay,
    bestTrade: metrics.bestTrade.toString(),
    worstTrade: metrics.worstTrade.toString(),
  };
}

function serializeTrade(t: SimulatedTrade): Record<string, unknown> {
  return {
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    sizeUsdc: t.sizeUsdc.toString(),
    pnlUsdc: t.pnlUsdc.toString(),
    pnlBps: t.pnlBps,
    strategy: t.strategy,
    regime: t.regime,
    exitReason: t.exitReason,
    holdingMs: t.holdingMs,
    mfeUsdc: t.mfeUsdc.toString(),
    maeUsdc: t.maeUsdc.toString(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Formatting Helpers
// ═══════════════════════════════════════════════════════════════════════════

function formatUsdc(amount: bigint): string {
  const isNegative = amount < 0n;
  const abs = isNegative ? -amount : amount;
  const dollars = abs / 1_000_000n;
  const cents = (abs % 1_000_000n).toString().padStart(6, '0').slice(0, 2);
  const sign = isNegative ? '-' : '';
  return `${sign}$${dollars}.${cents}`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function formatTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

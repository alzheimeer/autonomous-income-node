#!/usr/bin/env node
/**
 * Analyze Multi-Variant Exploration Metrics
 *
 * Reads from sniper-metrics.db and generates a report comparing
 * all variant configurations.
 *
 * Usage: node analyze-variant-metrics.mjs [--json]
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const DB_PATH = process.env.SNIPER_DB_PATH || 'data/sniper-metrics.db';
const OUTPUT_JSON = process.argv.includes('--json');

import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pg;

function formatUsd(amount) {
  return `$${amount.toFixed(2)}`;
}

function formatPct(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

async function main() {
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5433', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'ain_trading',
  });

  try {
    // Query variant metrics
    const { rows: variants } = await pool.query(`
    SELECT 
      variant_id,
      variant_name,
      COUNT(*) as total_trades,
      SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_positions,
      SUM(CASE WHEN status = 'TP_HIT' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN status = 'SL_HIT' THEN 1 ELSE 0 END) as losses,
      SUM(CASE WHEN status = 'TIME_STOP' THEN 1 ELSE 0 END) as time_stops,
      COALESCE(SUM(pnl_usdc), 0) as total_pnl,
      COALESCE(AVG(pnl_usdc), 0) as avg_pnl,
      COALESCE(MAX(pnl_usdc), 0) as best_trade,
      COALESCE(MIN(pnl_usdc), 0) as worst_trade,
      COALESCE(AVG(closed_at - opened_at), 0) as avg_holding_ms
    FROM shadow_positions
    WHERE variant_id IS NOT NULL
    GROUP BY variant_id, variant_name
    ORDER BY total_pnl DESC
  `);

  if (variants.length === 0) {
    console.log('No variant data found yet. Run the sniper in exploration mode to collect data.');
    return;
  }

  // Get overall stats
  const { rows: overallRows } = await pool.query(`
    SELECT 
      COUNT(*) as total_positions,
      SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status != 'OPEN' THEN 1 ELSE 0 END) as closed,
      COALESCE(SUM(pnl_usdc), 0) as total_pnl
    FROM shadow_positions
    WHERE variant_id IS NOT NULL
  `);
  const overall = overallRows[0];

  // Get signal source breakdown
  const { rows: sources } = await pool.query(`
    SELECT 
      signal_source,
      COUNT(*) as count,
      COALESCE(SUM(pnl_usdc), 0) as pnl
    FROM shadow_positions
    WHERE variant_id IS NOT NULL AND signal_source IS NOT NULL
    GROUP BY signal_source
  `);

  if (OUTPUT_JSON) {
    console.log(JSON.stringify({
      overall,
      variants,
      sources,
      generated_at: new Date().toISOString(),
    }, null, 2));
    return;
  }

  // Print report
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('       MULTI-VARIANT EXPLORATION ANALYSIS REPORT');
  console.log('════════════════════════════════════════════════════════════════\n');

  console.log('📊 OVERALL SUMMARY');
  console.log('─'.repeat(60));
  console.log(`   Total Positions: ${overall.total_positions}`);
  console.log(`   Open: ${overall.open} | Closed: ${overall.closed}`);
  console.log(`   Total PnL: ${formatUsd(overall.total_pnl)}`);
  console.log('');

  if (sources.length > 0) {
    console.log('📡 BY SIGNAL SOURCE');
    console.log('─'.repeat(60));
    for (const src of sources) {
      console.log(`   ${src.signal_source || 'unknown'}: ${src.count} trades, ${formatUsd(src.pnl)} PnL`);
    }
    console.log('');
  }

  console.log('🏆 VARIANT PERFORMANCE RANKING');
  console.log('─'.repeat(60));
  console.log('');

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    const closedTrades = v.wins + v.losses + v.time_stops;
    const winRate = closedTrades > 0 ? v.wins / closedTrades : 0;
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;

    console.log(`${medal} ${v.variant_name || v.variant_id}`);
    console.log(`   Trades: ${v.total_trades} (${v.open_positions} open)`);
    console.log(`   Results: ${v.wins}W / ${v.losses}L / ${v.time_stops}T`);
    console.log(`   Win Rate: ${formatPct(winRate)}`);
    console.log(`   Total PnL: ${formatUsd(v.total_pnl)}`);
    console.log(`   Avg PnL: ${formatUsd(v.avg_pnl)}`);
    console.log(`   Best: ${formatUsd(v.best_trade)} | Worst: ${formatUsd(v.worst_trade)}`);
    console.log(`   Avg Hold: ${formatDuration(v.avg_holding_ms)}`);
    console.log('');
  }

  // Print recommendations
  console.log('💡 RECOMMENDATIONS');
  console.log('─'.repeat(60));

  const best = variants[0];
  const worst = variants[variants.length - 1];

  if (best.total_pnl > 0) {
    const bestWinRate = best.wins / (best.wins + best.losses + best.time_stops);
    console.log(`   ✅ Best performer: "${best.variant_name}" with ${formatUsd(best.total_pnl)} PnL`);
    console.log(`      Win rate: ${formatPct(bestWinRate)} | Avg hold: ${formatDuration(best.avg_holding_ms)}`);
    console.log(`      Consider promoting this config to production.`);
  } else {
    console.log(`   ⚠️  No profitable variant yet. Need more data.`);
  }

  if (worst.total_pnl < 0 && variants.length > 1) {
    console.log(`   ❌ Worst performer: "${worst.variant_name}" with ${formatUsd(worst.total_pnl)} PnL`);
    console.log(`      Consider removing this variant from exploration.`);
  }

  // Check for variants with too few trades
  const lowTradeVariants = variants.filter(v => v.total_trades < 10);
  if (lowTradeVariants.length > 0) {
    console.log(`   ℹ️  ${lowTradeVariants.length} variants have <10 trades. Need more data for statistical significance.`);
  }

  console.log('\n════════════════════════════════════════════════════════════════\n');

  } catch (err) {
    console.error('Error in analyze-variant-metrics:', err);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);

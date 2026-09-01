/**
 * Analyze Sniper Metrics from PostgreSQL
 * 
 * CRITICAL: Separates metrics by signal_type (micro-cap vs established)
 * because established pairs (WETH/DAI) have near-zero spread and inflate stats.
 * 
 * Updated: 2026-08-11 - Added signal_type separation
 */

import pg from 'pg';
const { Client } = pg;

async function analyze() {
  console.log('='.repeat(70));
  console.log('📊 HYBRID SNIPER - ANÁLISIS DE MÉTRICAS (SEPARADO POR TIPO)');
  console.log('='.repeat(70));
  console.log(`Fecha: ${new Date().toISOString().slice(0, 19)}`);
  console.log();

  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5433', 10),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
    database: process.env.DB_NAME || 'ain_trading',
  });

  try {
    await client.connect();
  } catch (err) {
    console.log('❌ No se pudo conectar a PostgreSQL:', err.message);
    console.log('   Tip: Verificar que ain-postgres está corriendo en puerto 5433');
    return;
  }

  // --- RESUMEN GENERAL ---
  console.log('📈 RESUMEN GENERAL');
  console.log('-'.repeat(50));
  
  try {
    const summaryRes = await client.query(`
      SELECT 
        COUNT(*) as total_signals,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
        ROUND(SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END)::numeric / COUNT(*)::numeric * 100, 2) as pass_rate
      FROM sniper_signals
    `);
    const s = summaryRes.rows[0];
    console.log(`Total señales procesadas: ${s.total_signals}`);
    console.log(`Señales aprobadas: ${s.passed} (${s.pass_rate}%)`);
    console.log();
  } catch (err) {
    console.log('Error en resumen:', err.message);
  }

  // --- MÉTRICAS POR TIPO DE TOKEN (CRÍTICO) ---
  console.log('='.repeat(70));
  console.log('🎯 MÉTRICAS POR TIPO DE TOKEN (CRÍTICO PARA DECISIONES)');
  console.log('-'.repeat(50));
  console.log('⚠️  IMPORTANTE: Solo las métricas de "micro-cap" son relevantes.');
  console.log('⚠️  Los trades "established" (WETH/DAI) tienen spread ~0 y siempre ganan.');
  console.log();
  
  try {
    const byTypeRes = await client.query(`
      SELECT 
        signal_type,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open,
        SUM(CASE WHEN status = 'TP_HIT' THEN 1 ELSE 0 END) as tp_hit,
        SUM(CASE WHEN status = 'SL_HIT' THEN 1 ELSE 0 END) as sl_hit,
        SUM(CASE WHEN status = 'TIME_STOP' THEN 1 ELSE 0 END) as time_stop,
        ROUND(SUM(CASE WHEN pnl_usdc > 0 THEN 1 ELSE 0 END)::numeric / 
              NULLIF(SUM(CASE WHEN pnl_usdc IS NOT NULL THEN 1 ELSE 0 END), 0)::numeric * 100, 1) as win_rate,
        ROUND(SUM(pnl_usdc)::numeric, 2) as total_pnl,
        ROUND(AVG(pnl_usdc)::numeric, 2) as avg_pnl
      FROM shadow_positions 
      GROUP BY signal_type
      ORDER BY signal_type
    `);
    
    console.log('| Tipo        | Total | Open | TP   | SL   | TimeStop | WinRate | PnL Total | Avg PnL |');
    console.log('|-------------|-------|------|------|------|----------|---------|-----------|---------|');
    
    for (const row of byTypeRes.rows) {
      const type = (row.signal_type || 'unknown').padEnd(11);
      const total = String(row.total).padStart(5);
      const open = String(row.open).padStart(4);
      const tp = String(row.tp_hit).padStart(4);
      const sl = String(row.sl_hit).padStart(4);
      const ts = String(row.time_stop).padStart(8);
      const wr = row.win_rate !== null ? `${row.win_rate}%`.padStart(7) : 'N/A'.padStart(7);
      const pnl = row.total_pnl !== null ? `$${row.total_pnl}`.padStart(9) : 'N/A'.padStart(9);
      const avg = row.avg_pnl !== null ? `$${row.avg_pnl}`.padStart(7) : 'N/A'.padStart(7);
      console.log(`| ${type} | ${total} | ${open} | ${tp} | ${sl} | ${ts} | ${wr} | ${pnl} | ${avg} |`);
    }
    console.log();
    
    // Highlight micro-cap stats specifically
    const microCap = byTypeRes.rows.find(r => r.signal_type === 'micro-cap');
    if (microCap) {
      const closedMicroCap = parseInt(microCap.total) - parseInt(microCap.open);
      console.log('📊 ESTADO MICRO-CAP (datos reales para decisión):');
      console.log(`   Trades cerrados: ${closedMicroCap}`);
      console.log(`   Trades abiertos: ${microCap.open}`);
      console.log(`   Win Rate: ${microCap.win_rate ?? 'N/A (sin trades cerrados)'}%`);
      console.log(`   PnL Total: $${microCap.total_pnl ?? 0}`);
      
      if (closedMicroCap < 50) {
        console.log(`   ⚠️  INSUFICIENTE: Necesitamos 50+ trades cerrados (tenemos ${closedMicroCap})`);
      } else {
        console.log(`   ✅ SUFICIENTE: ${closedMicroCap} trades cerrados`);
      }
    }
    console.log();
  } catch (err) {
    console.log('Error en métricas por tipo:', err.message);
  }

  // --- RAZONES DE RECHAZO ---
  console.log('='.repeat(70));
  console.log('❌ RAZONES DE RECHAZO (Top 10)');
  console.log('-'.repeat(50));
  
  try {
    const rejectRes = await client.query(`
      SELECT reject_reason, COUNT(*) as count,
             ROUND(COUNT(*)::numeric / (SELECT COUNT(*) FROM sniper_signals)::numeric * 100, 1) as pct
      FROM sniper_signals 
      WHERE reject_reason IS NOT NULL AND reject_reason != ''
      GROUP BY reject_reason 
      ORDER BY count DESC 
      LIMIT 10
    `);
    
    for (const row of rejectRes.rows) {
      console.log(`  ${row.reject_reason.padEnd(25)} ${String(row.count).padStart(6)} (${row.pct}%)`);
    }
    console.log();
  } catch (err) {
    console.log('Error en razones de rechazo:', err.message);
  }

  // --- ACTIVIDAD POR DÍA ---
  console.log('='.repeat(70));
  console.log('📅 ACTIVIDAD POR DÍA');
  console.log('-'.repeat(50));
  
  try {
    const dailyRes = await client.query(`
      SELECT 
        DATE(to_timestamp(created_at / 1000)) as day,
        COUNT(*) as signals,
        SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END) as passed,
        ROUND(SUM(CASE WHEN passed = 1 THEN 1 ELSE 0 END)::numeric / COUNT(*)::numeric * 100, 1) as pass_rate
      FROM sniper_signals 
      GROUP BY day 
      ORDER BY day DESC 
      LIMIT 7
    `);
    
    console.log('| Día        | Señales | Aprobadas | Pass Rate |');
    console.log('|------------|---------|-----------|-----------|');
    for (const d of dailyRes.rows) {
      const dayStr = d.day instanceof Date ? d.day.toISOString().slice(0, 10) : String(d.day);
      console.log(`| ${dayStr} | ${String(d.signals).padStart(7)} | ${String(d.passed).padStart(9)} | ${String(d.pass_rate).padStart(8)}% |`);
    }
    console.log();
  } catch (err) {
    console.log('Error en actividad diaria:', err.message);
  }

  // --- POSICIONES MICRO-CAP ABIERTAS ---
  console.log('='.repeat(70));
  console.log('🔓 POSICIONES MICRO-CAP ABIERTAS');
  console.log('-'.repeat(50));
  
  try {
    const openRes = await client.query(`
      SELECT 
        contract_address,
        COUNT(*) as positions,
        to_timestamp(MIN(opened_at)/1000) as first_opened,
        to_timestamp(MAX(opened_at)/1000) as last_opened
      FROM shadow_positions 
      WHERE status = 'OPEN' AND signal_type = 'micro-cap'
      GROUP BY contract_address
    `);
    
    if (openRes.rows.length === 0) {
      console.log('  (Sin posiciones micro-cap abiertas)');
    } else {
      for (const row of openRes.rows) {
        console.log(`  ${row.contract_address.slice(0, 20)}... : ${row.positions} posiciones`);
        console.log(`    Primera: ${row.first_opened}`);
        console.log(`    Última:  ${row.last_opened}`);
      }
    }
    console.log();
  } catch (err) {
    console.log('Error en posiciones abiertas:', err.message);
  }

  // --- CRITERIOS PARA MES 2 (MICRO-LIVE) ---
  console.log('='.repeat(70));
  console.log('🎯 CRITERIOS PARA FASE "MES 2 (MICRO-LIVE)"');
  console.log('-'.repeat(50));
  
  try {
    // Obtener datos necesarios
    const microCapRes = await client.query(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN status != 'OPEN' THEN 1 ELSE 0 END) as closed,
        SUM(CASE WHEN pnl_usdc > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_usdc < 0 THEN 1 ELSE 0 END) as losses,
        SUM(pnl_usdc) as total_pnl
      FROM shadow_positions 
      WHERE signal_type = 'micro-cap'
    `);
    
    const daysRes = await client.query(`
      SELECT COUNT(DISTINCT DATE(to_timestamp(created_at/1000))) as days
      FROM sniper_signals
    `);
    
    const mc = microCapRes.rows[0];
    const closedTrades = parseInt(mc.closed) || 0;
    const wins = parseInt(mc.wins) || 0;
    const losses = parseInt(mc.losses) || 0;
    const winRate = closedTrades > 0 ? (wins / closedTrades * 100).toFixed(1) : 'N/A';
    const profitFactor = losses > 0 ? (wins / losses).toFixed(2) : (wins > 0 ? '∞' : 'N/A');
    const totalPnl = parseFloat(mc.total_pnl) || 0;
    const days = parseInt(daysRes.rows[0]?.days) || 0;
    
    console.log('| Criterio                    | Requerido | Actual      | Estado |');
    console.log('|-----------------------------|-----------|-------------|--------|');
    console.log(`| Trades micro-cap cerrados   | ≥50       | ${String(closedTrades).padStart(11)} | ${closedTrades >= 50 ? '✅' : '❌'}     |`);
    console.log(`| Win Rate micro-cap          | ≥40%      | ${String(winRate + '%').padStart(11)} | ${parseFloat(winRate) >= 40 ? '✅' : (winRate === 'N/A' ? '⏳' : '❌')}     |`);
    console.log(`| Profit Factor micro-cap     | ≥1.2      | ${String(profitFactor).padStart(11)} | ${parseFloat(profitFactor) >= 1.2 ? '✅' : (profitFactor === 'N/A' ? '⏳' : '❌')}     |`);
    console.log(`| PnL Total micro-cap         | ≥$0       | ${('$' + totalPnl.toFixed(2)).padStart(11)} | ${totalPnl >= 0 ? '✅' : '❌'}     |`);
    console.log(`| Días de datos               | ≥14       | ${String(days).padStart(11)} | ${days >= 14 ? '✅' : '❌'}     |`);
    console.log();
    
    const ready = closedTrades >= 50 && parseFloat(winRate) >= 40 && parseFloat(profitFactor) >= 1.2 && totalPnl >= 0 && days >= 14;
    
    if (ready) {
      console.log('🎉 LISTO PARA MES 2 (MICRO-LIVE)');
    } else {
      console.log('⏳ NO LISTO - Continuar en Shadow Mode');
      console.log();
      console.log('Pasos pendientes:');
      if (closedTrades < 50) console.log(`  - Esperar ${50 - closedTrades} trades micro-cap más`);
      if (days < 14) console.log(`  - Esperar ${14 - days} días más de datos`);
      if (winRate === 'N/A') console.log('  - Esperar a que cierren trades para calcular win rate');
    }
    
  } catch (err) {
    console.log('Error en criterios:', err.message);
  }

  await client.end();
  console.log();
  console.log('='.repeat(70));
}

analyze();

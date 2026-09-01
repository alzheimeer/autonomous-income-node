// Quick stats extractor - runs fast
import pg from 'pg';

const pool = new pg.Pool({
  host: 'localhost',
  port: 5433,
  user: 'postgres', 
  password: 'postgres',
  database: 'ain_trading',
  connectionTimeoutMillis: 5000,
  query_timeout: 10000
});

async function run() {
  try {
    // First, list all tables
    const tables = await pool.query(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `);
    console.log('=== TABLAS DISPONIBLES ===');
    console.log(tables.rows.map(r => r.tablename).join(', '));
    console.log('');

    // Query 1: Variant performance - use shadow_positions
    const variants = await pool.query(`
      SELECT 
        variant_id,
        variant_name,
        COUNT(*) as total,
        SUM(CASE WHEN status='TP_HIT' THEN 1 ELSE 0 END) as tp,
        SUM(CASE WHEN status='SL_HIT' THEN 1 ELSE 0 END) as sl,
        SUM(CASE WHEN status='TIME_STOP' THEN 1 ELSE 0 END) as ts,
        ROUND(COALESCE(SUM(pnl_usdc),0)::numeric,2) as pnl,
        ROUND(COALESCE(AVG(pnl_usdc),0)::numeric,2) as avg
      FROM shadow_positions 
      WHERE variant_id IS NOT NULL
      GROUP BY variant_id, variant_name
      ORDER BY pnl DESC
    `);
    
    console.log('\n=== RENDIMIENTO POR VARIANTE (TÉCNICA) ===\n');
    console.log('Variante                  | Total | TP   | SL   | Time | PnL Total  | Avg PnL | WinRate');
    console.log('--------------------------|-------|------|------|------|------------|---------|--------');
    
    for (const v of variants.rows) {
      const closed = v.tp + v.sl + v.ts;
      const wr = closed > 0 ? ((v.tp / closed) * 100).toFixed(1) + '%' : 'N/A';
      const name = (v.variant_name || v.variant_id || 'unknown').substring(0,25).padEnd(25);
      console.log(`${name} | ${String(v.total).padStart(5)} | ${String(v.tp).padStart(4)} | ${String(v.sl).padStart(4)} | ${String(v.ts).padStart(4)} | $${String(v.pnl).padStart(9)} | $${String(v.avg).padStart(6)} | ${wr.padStart(6)}`);
    }

    // Query 2: By signal type
    const byType = await pool.query(`
      SELECT 
        signal_type,
        COUNT(*) as total,
        SUM(CASE WHEN status='TP_HIT' THEN 1 ELSE 0 END) as tp,
        SUM(CASE WHEN status='SL_HIT' THEN 1 ELSE 0 END) as sl,
        SUM(CASE WHEN status='TIME_STOP' THEN 1 ELSE 0 END) as ts,
        ROUND(COALESCE(SUM(pnl_usdc),0)::numeric,2) as pnl
      FROM shadow_positions
      WHERE variant_id IS NOT NULL
      GROUP BY signal_type
    `);
    
    console.log('\n=== POR TIPO DE SEÑAL ===\n');
    for (const r of byType.rows) {
      const closed = r.tp + r.sl + r.ts;
      const wr = closed > 0 ? ((r.tp / closed) * 100).toFixed(1) : 'N/A';
      console.log(`${r.signal_type || 'unknown'}: ${r.total} trades, TP:${r.tp} SL:${r.sl} TS:${r.ts}, PnL: $${r.pnl}, WR: ${wr}%`);
    }

    // Query 3: Exit reasons totals
    const exits = await pool.query(`
      SELECT status, COUNT(*) as cnt, ROUND(COALESCE(SUM(pnl_usdc),0)::numeric,2) as pnl 
      FROM shadow_positions 
      WHERE status != 'OPEN' AND variant_id IS NOT NULL
      GROUP BY status
    `);
    
    console.log('\n=== RESUMEN POR EXIT ===\n');
    for (const e of exits.rows) {
      console.log(`${e.status}: ${e.cnt} trades, PnL: $${e.pnl}`);
    }

    // Query 4: MICRO-CAP ONLY analysis (the real test)
    const microCap = await pool.query(`
      SELECT 
        variant_id,
        variant_name,
        COUNT(*) as total,
        SUM(CASE WHEN status='TP_HIT' THEN 1 ELSE 0 END) as tp,
        SUM(CASE WHEN status='SL_HIT' THEN 1 ELSE 0 END) as sl,
        SUM(CASE WHEN status='TIME_STOP' THEN 1 ELSE 0 END) as ts,
        SUM(CASE WHEN status='OPEN' THEN 1 ELSE 0 END) as open_pos,
        ROUND(COALESCE(SUM(pnl_usdc),0)::numeric,2) as pnl,
        ROUND(COALESCE(AVG(CASE WHEN status != 'OPEN' THEN pnl_usdc END),0)::numeric,2) as avg
      FROM shadow_positions 
      WHERE variant_id IS NOT NULL AND signal_type = 'micro-cap'
      GROUP BY variant_id, variant_name
      ORDER BY pnl DESC
    `);
    
    console.log('\n=== 🎯 MICRO-CAP ONLY (DATOS REALES) ===\n');
    console.log('Variante                  | Total | Open | TP   | SL   | Time | PnL Total  | Avg PnL | WinRate');
    console.log('--------------------------|-------|------|------|------|------|------------|---------|--------');
    
    for (const v of microCap.rows) {
      const closed = parseInt(v.tp) + parseInt(v.sl) + parseInt(v.ts);
      const wr = closed > 0 ? ((parseInt(v.tp) / closed) * 100).toFixed(1) + '%' : 'N/A';
      const name = (v.variant_name || v.variant_id || 'unknown').substring(0,25).padEnd(25);
      console.log(`${name} | ${String(v.total).padStart(5)} | ${String(v.open_pos).padStart(4)} | ${String(v.tp).padStart(4)} | ${String(v.sl).padStart(4)} | ${String(v.ts).padStart(4)} | $${String(v.pnl).padStart(9)} | $${String(v.avg).padStart(6)} | ${wr.padStart(6)}`);
    }

    // Query 5: Recent MICRO-CAP activity
    const recentMicro = await pool.query(`
      SELECT variant_name, status, pnl_usdc, contract_address
      FROM shadow_positions 
      WHERE status != 'OPEN' AND variant_id IS NOT NULL AND signal_type = 'micro-cap'
      ORDER BY closed_at DESC NULLS LAST
      LIMIT 15
    `);
    
    console.log('\n=== ÚLTIMOS 15 TRADES MICRO-CAP ===\n');
    for (const t of recentMicro.rows) {
      const pnl = t.pnl_usdc !== null ? `$${Number(t.pnl_usdc).toFixed(2)}` : 'N/A';
      const addr = t.contract_address ? t.contract_address.substring(0,10) + '...' : 'unknown';
      console.log(`${(t.variant_name || 'unknown').substring(0,20).padEnd(20)} | ${t.status.padEnd(9)} | ${pnl.padStart(10)} | ${addr}`);
    }
    
    // Summary
    console.log('\n=== 📊 RESUMEN EJECUTIVO ===\n');
    const totalMicroClosed = microCap.rows.reduce((sum, v) => sum + parseInt(v.tp) + parseInt(v.sl) + parseInt(v.ts), 0);
    const totalMicroTP = microCap.rows.reduce((sum, v) => sum + parseInt(v.tp), 0);
    const totalMicroSL = microCap.rows.reduce((sum, v) => sum + parseInt(v.sl), 0);
    const totalMicroTS = microCap.rows.reduce((sum, v) => sum + parseInt(v.ts), 0);
    const totalMicroPnL = microCap.rows.reduce((sum, v) => sum + parseFloat(v.pnl), 0);
    const microWR = totalMicroClosed > 0 ? (totalMicroTP / totalMicroClosed * 100).toFixed(1) : 'N/A';
    
    console.log('MICRO-CAP (tokens nuevos reales):');
    console.log(`  Trades cerrados: ${totalMicroClosed}`);
    console.log(`  TP_HIT: ${totalMicroTP} | SL_HIT: ${totalMicroSL} | TIME_STOP: ${totalMicroTS}`);
    console.log(`  Win Rate: ${microWR}%`);
    console.log(`  PnL Total: $${totalMicroPnL.toFixed(2)}`);
    console.log('');
    console.log('VARIANTES GANADORAS (micro-cap):');
    for (const v of microCap.rows) {
      const closed = parseInt(v.tp) + parseInt(v.sl) + parseInt(v.ts);
      if (closed > 0 && parseFloat(v.pnl) > 0) {
        const wr = (parseInt(v.tp) / closed * 100).toFixed(1);
        console.log(`  ✅ ${v.variant_name}: ${wr}% WR, $${v.pnl} PnL`);
      }
    }
    console.log('');
    console.log('VARIANTES CON PROBLEMAS:');
    for (const v of microCap.rows) {
      const closed = parseInt(v.tp) + parseInt(v.sl) + parseInt(v.ts);
      if (parseInt(v.ts) > parseInt(v.tp)) {
        console.log(`  ⚠️  ${v.variant_name}: ${v.ts} TIME_STOP vs ${v.tp} TP_HIT`);
      }
    }

  } catch (err) {
    console.error('DB Error:', err.message);
  } finally {
    await pool.end();
  }
}

run();

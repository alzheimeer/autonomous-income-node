#!/usr/bin/env node
import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  host: 'localhost',
  port: 5433,
  user: 'postgres',
  password: 'postgres',
  database: 'ain_trading'
});

async function main() {
  try {
    // Últimos 5 minutos
    const recent = await pool.query(`
      SELECT signal_type, status, COUNT(*) as cnt, ROUND(SUM(pnl_usdc)::numeric, 2) as pnl
      FROM shadow_positions 
      WHERE created_at >= (EXTRACT(EPOCH FROM NOW()) - 300) * 1000
      GROUP BY 1,2 ORDER BY pnl DESC
    `);
    
    console.log('\n=== ÚLTIMOS 5 MINUTOS ===');
    console.table(recent.rows);
    
    // Última hora
    const hourly = await pool.query(`
      SELECT signal_type, status, COUNT(*) as cnt, ROUND(SUM(pnl_usdc)::numeric, 2) as pnl
      FROM shadow_positions 
      WHERE created_at >= (EXTRACT(EPOCH FROM NOW()) - 3600) * 1000
      GROUP BY 1,2 ORDER BY pnl DESC
    `);
    
    console.log('\n=== ÚLTIMA HORA ===');
    console.table(hourly.rows);
    
    // Total histórico
    const total = await pool.query(`
      SELECT signal_type, status, COUNT(*) as cnt, ROUND(SUM(pnl_usdc)::numeric, 2) as pnl
      FROM shadow_positions
      GROUP BY 1,2 ORDER BY pnl DESC
    `);
    
    console.log('\n=== TOTAL HISTÓRICO ===');
    console.table(total.rows);
    
    // Señales rechazadas última hora
    const rejections = await pool.query(`
      SELECT reject_reason, COUNT(*) as cnt
      FROM sniper_signals
      WHERE created_at >= (EXTRACT(EPOCH FROM NOW()) - 3600) * 1000 AND passed = 0
      GROUP BY 1 ORDER BY cnt DESC LIMIT 5
    `);
    
    console.log('\n=== RECHAZOS ÚLTIMA HORA ===');
    console.table(rejections.rows);
    
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

main();

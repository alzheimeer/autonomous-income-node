import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db', { open: true });

console.log('=== Current Shadow Position Analysis ===\n');

try {
  const position = db.prepare(`
    SELECT * FROM positions 
    WHERE mode = 'shadow' AND closed = 0 
    ORDER BY entry_timestamp DESC 
    LIMIT 1
  `).get();
  
  if (position) {
    const entryDate = new Date(position.entry_timestamp);
    const now = Date.now();
    const holdingMs = now - position.entry_timestamp;
    const holdingHours = (holdingMs / (1000 * 60 * 60)).toFixed(1);
    
    console.log('📊 Active Position:');
    console.log(`   Strategy: ${position.strategy}`);
    console.log(`   Entry Price: $${position.entry_price?.toFixed(2)}`);
    console.log(`   Entry Time: ${entryDate.toISOString()}`);
    console.log(`   Holding Time: ${holdingHours} hours`);
    console.log(`   Stop Loss: $${position.stop_loss?.toFixed(2)}`);
    console.log(`   Take Profit: $${position.take_profit?.toFixed(2)}`);
    console.log(`   Entry Regime: ${position.entry_regime}`);
    console.log(`   Size: ${position.size_usdc} USDC → ${position.size_weth} WETH`);
    console.log(`   Max Holding: ${position.max_holding_ms / (1000 * 60 * 60)} hours`);
    
    // Check if time stop would trigger
    const maxHoldMs = position.max_holding_ms || (48 * 60 * 60 * 1000);
    if (holdingMs >= maxHoldMs) {
      console.log('\n⚠️  TIME STOP TRIGGERED - position should close soon');
    } else {
      const remainingMs = maxHoldMs - holdingMs;
      const remainingHours = (remainingMs / (1000 * 60 * 60)).toFixed(1);
      console.log(`\n⏱️  Time until max holding: ${remainingHours} hours`);
    }
  } else {
    console.log('No active shadow positions found.');
    console.log('Strategy engine should be able to generate new signals.');
  }
} catch (e) {
  console.log('Error:', e.message);
}

console.log('\n=== Completed Shadow Trades (last 5) ===\n');
try {
  const completed = db.prepare(`
    SELECT id, strategy, entry_price, exit_price, exit_reason, net_pnl, 
           entry_timestamp, exit_timestamp
    FROM positions 
    WHERE mode = 'shadow' AND closed = 1 
    ORDER BY exit_timestamp DESC 
    LIMIT 5
  `).all();
  
  if (completed.length === 0) {
    console.log('No completed shadow trades yet.');
  } else {
    completed.forEach(t => {
      const pnlStr = t.net_pnl ? `$${(Number(t.net_pnl) / 1e6).toFixed(4)}` : 'n/a';
      console.log(`  ${t.strategy}: entry=$${t.entry_price?.toFixed(2)} → exit=$${t.exit_price?.toFixed(2)} | reason=${t.exit_reason} | PnL=${pnlStr}`);
    });
  }
} catch (e) {
  console.log('Error:', e.message);
}

console.log('\n=== Summary Stats ===\n');
try {
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN closed = 1 THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN closed = 0 THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN net_pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN net_pnl < 0 THEN 1 ELSE 0 END) as losses
    FROM positions 
    WHERE mode = 'shadow'
  `).get();
  
  console.log(`Total shadow trades: ${stats.total}`);
  console.log(`  - Completed: ${stats.completed}`);
  console.log(`  - Open: ${stats.open}`);
  console.log(`  - Wins: ${stats.wins || 0}`);
  console.log(`  - Losses: ${stats.losses || 0}`);
  
  if (stats.completed > 0) {
    const winRate = ((stats.wins || 0) / stats.completed * 100).toFixed(1);
    console.log(`  - Win Rate: ${winRate}%`);
  }
} catch (e) {
  console.log('Error:', e.message);
}

db.close();

// Comprehensive trading module status check
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db', { open: true });

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('                    📊 TRADING MODULE STATUS REPORT');
console.log('═══════════════════════════════════════════════════════════════════════\n');

// 1. Shadow positions summary
console.log('📈 SHADOW POSITIONS SUMMARY');
console.log('─'.repeat(70));

const openPositions = db.prepare(`
  SELECT * FROM positions 
  WHERE mode = 'shadow' AND closed = 0
  ORDER BY entry_timestamp DESC
`).all();

const closedPositions = db.prepare(`
  SELECT * FROM positions 
  WHERE mode = 'shadow' AND closed = 1
  ORDER BY exit_timestamp DESC
  LIMIT 10
`).all();

console.log(`  Open positions:   ${openPositions.length}`);
console.log(`  Closed (last 10): ${closedPositions.length}\n`);

// 2. P&L Analysis
console.log('💰 P&L ANALYSIS (Shadow Trades)');
console.log('─'.repeat(70));

const pnlStats = db.prepare(`
  SELECT 
    COUNT(*) as total_trades,
    SUM(CASE WHEN CAST(net_pnl AS REAL) > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN CAST(net_pnl AS REAL) < 0 THEN 1 ELSE 0 END) as losses,
    SUM(CAST(net_pnl AS REAL)) as total_pnl,
    AVG(CAST(net_pnl AS REAL)) as avg_pnl,
    MAX(CAST(net_pnl AS REAL)) as best_trade,
    MIN(CAST(net_pnl AS REAL)) as worst_trade
  FROM positions 
  WHERE mode = 'shadow' AND closed = 1
`).get();

if (pnlStats.total_trades > 0) {
  const winRate = ((pnlStats.wins / pnlStats.total_trades) * 100).toFixed(1);
  console.log(`  Total closed trades: ${pnlStats.total_trades}`);
  console.log(`  Wins: ${pnlStats.wins} | Losses: ${pnlStats.losses}`);
  console.log(`  Win Rate: ${winRate}%`);
  console.log(`  Total P&L: $${(pnlStats.total_pnl / 1_000_000).toFixed(2)}`);
  console.log(`  Avg P&L per trade: $${(pnlStats.avg_pnl / 1_000_000).toFixed(4)}`);
  console.log(`  Best trade: $${(pnlStats.best_trade / 1_000_000).toFixed(4)}`);
  console.log(`  Worst trade: $${(pnlStats.worst_trade / 1_000_000).toFixed(4)}`);
} else {
  console.log('  No closed trades yet');
}

// 3. Strategy breakdown
console.log('\n📊 STRATEGY PERFORMANCE');
console.log('─'.repeat(70));

const strategyStats = db.prepare(`
  SELECT 
    strategy,
    COUNT(*) as total,
    SUM(CASE WHEN CAST(net_pnl AS REAL) > 0 THEN 1 ELSE 0 END) as wins,
    SUM(CASE WHEN CAST(net_pnl AS REAL) < 0 THEN 1 ELSE 0 END) as losses,
    SUM(CAST(net_pnl AS REAL)) as total_pnl,
    exit_reason
  FROM positions 
  WHERE mode = 'shadow' AND closed = 1
  GROUP BY strategy, exit_reason
  ORDER BY strategy, exit_reason
`).all();

const strategyMap = new Map();
for (const row of strategyStats) {
  if (!strategyMap.has(row.strategy)) {
    strategyMap.set(row.strategy, { total: 0, wins: 0, losses: 0, pnl: 0, reasons: {} });
  }
  const s = strategyMap.get(row.strategy);
  s.total += row.total;
  s.wins += row.wins;
  s.losses += row.losses;
  s.pnl += row.total_pnl || 0;
  s.reasons[row.exit_reason] = (s.reasons[row.exit_reason] || 0) + row.total;
}

for (const [strategy, stats] of strategyMap) {
  const winRate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : '0';
  console.log(`\n  ${strategy.toUpperCase()}`);
  console.log(`    Trades: ${stats.total} | Wins: ${stats.wins} | Losses: ${stats.losses}`);
  console.log(`    Win Rate: ${winRate}%`);
  console.log(`    Total P&L: $${(stats.pnl / 1_000_000).toFixed(4)}`);
  console.log(`    Exit reasons: ${JSON.stringify(stats.reasons)}`);
}

// 4. Open positions detail
console.log('\n\n📍 OPEN POSITIONS');
console.log('─'.repeat(70));

if (openPositions.length === 0) {
  console.log('  No open positions');
} else {
  for (const pos of openPositions) {
    const entryPrice = pos.entry_price;
    const slPrice = pos.stop_loss;
    const tpPrice = pos.take_profit;
    const createdAt = new Date(pos.entry_timestamp).toLocaleString();
    
    console.log(`\n  Position: ${pos.id.slice(0, 8)}...`);
    console.log(`    Strategy: ${pos.strategy}`);
    console.log(`    Entry: $${entryPrice.toFixed(2)} | SL: $${slPrice.toFixed(2)} | TP: $${tpPrice.toFixed(2)}`);
    console.log(`    Size: ${pos.size_usdc} USDC`);
    console.log(`    Created: ${createdAt}`);
  }
}

// 5. Recent activity
console.log('\n\n🕐 RECENT TRADING ACTIVITY (last 24h)');
console.log('─'.repeat(70));

const now = Date.now();
const oneDayAgo = now - 24 * 60 * 60 * 1000;

const recentActivity = db.prepare(`
  SELECT 
    id, strategy, entry_price, net_pnl, exit_reason,
    entry_timestamp, exit_timestamp, closed
  FROM positions 
  WHERE mode = 'shadow' 
    AND entry_timestamp > ?
  ORDER BY entry_timestamp DESC
`).all(oneDayAgo);

console.log(`  Trades in last 24h: ${recentActivity.length}`);

for (const trade of recentActivity.slice(0, 8)) {
  const entry = trade.entry_price;
  const pnl = trade.net_pnl ? `$${(parseFloat(trade.net_pnl) / 1_000_000).toFixed(4)}` : 'open';
  const status = trade.closed ? `closed (${trade.exit_reason})` : '🟢 OPEN';
  console.log(`  - ${trade.strategy}: entry $${entry.toFixed(2)} | P&L: ${pnl} | ${status}`);
}

// 6. Trading mode check
console.log('\n\n⚙️  TRADING MODE');
console.log('─'.repeat(70));
console.log('  Mode: SHADOW (paper trading)');
console.log('  Validation period: 7 days');
console.log('  Target: 3+ profitable trades, win rate > 50%');

// 7. Check for FK constraint issues
console.log('\n\n🔧 SYSTEM HEALTH');
console.log('─'.repeat(70));

const duplicateNonces = db.prepare(`
  SELECT nonce, COUNT(*) as cnt 
  FROM tx_intents 
  WHERE nonce < 0 
  GROUP BY nonce 
  HAVING cnt > 1
`).all();

if (duplicateNonces.length === 0) {
  console.log('  ✅ No duplicate nonces - FK fix working');
} else {
  console.log('  ⚠️  Duplicate nonces found:', duplicateNonces);
}

const recentErrors = db.prepare(`
  SELECT COUNT(*) as cnt 
  FROM positions 
  WHERE exit_reason LIKE '%error%' 
    AND entry_timestamp > ?
`).get(oneDayAgo);

console.log(`  Errors (24h): ${recentErrors.cnt}`);

console.log('\n═══════════════════════════════════════════════════════════════════════\n');

db.close();

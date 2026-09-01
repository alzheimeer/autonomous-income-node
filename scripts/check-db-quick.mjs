import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db', { open: true });

console.log('=== Shadow Positions from positions table ===');
try {
  const positions = db.prepare(`
    SELECT id, strategy, entry_price, entry_timestamp, closed, exit_reason, net_pnl 
    FROM positions 
    WHERE mode = 'shadow' 
    ORDER BY entry_timestamp DESC 
    LIMIT 10
  `).all();
  console.log(`Found ${positions.length} shadow positions:`);
  positions.forEach(p => {
    const date = new Date(p.entry_timestamp).toISOString();
    console.log(`  - ${p.id.substring(0,8)}... | ${p.strategy} | entry=${p.entry_price?.toFixed(2)} | closed=${p.closed} | reason=${p.exit_reason || 'open'} | pnl=${p.net_pnl || 'n/a'}`);
  });
} catch (e) {
  console.log('Error:', e.message);
}

console.log('\n=== tx_intents with negative nonce (shadow) ===');
try {
  const intents = db.prepare(`
    SELECT id, nonce, state, operation_type, created_at
    FROM tx_intents 
    WHERE nonce < 0
    ORDER BY created_at DESC
    LIMIT 10
  `).all();
  console.log(`Found ${intents.length} shadow tx_intents:`);
  intents.forEach(i => {
    const date = new Date(i.created_at).toISOString();
    console.log(`  - nonce=${i.nonce} | ${i.id.substring(0,20)}... | ${i.state} | ${date}`);
  });
} catch (e) {
  console.log('Error:', e.message);
}

console.log('\n=== Recent constraint errors check (should be empty) ===');
try {
  // Check if there are duplicate nonces
  const dupes = db.prepare(`
    SELECT nonce, COUNT(*) as cnt 
    FROM tx_intents 
    WHERE nonce < 0 
    GROUP BY nonce 
    HAVING COUNT(*) > 1
  `).all();
  if (dupes.length === 0) {
    console.log('✅ No duplicate negative nonces - fix is working!');
  } else {
    console.log('❌ Duplicate nonces found:', dupes);
  }
} catch (e) {
  console.log('Error:', e.message);
}

db.close();

// Quick database check script using node:sqlite (Node 24+)
import { createRequire } from 'node:module';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const dbPath = './data/agent.db';

if (!existsSync(dbPath)) {
  console.log('Database not found at:', dbPath);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);

console.log('=== Database Tables ===');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
console.log(tables.map(t => t.name).join('\n'));

console.log('\n=== Positions Table ===');
try {
  const positions = db.prepare('SELECT * FROM positions ORDER BY rowid DESC LIMIT 20').all();
  if (positions.length === 0) {
    console.log('No positions found');
  } else {
    console.log(`Found ${positions.length} positions:`);
    positions.forEach(p => {
      console.log(`  `, JSON.stringify(p));
    });
  }
} catch (e) {
  console.log('positions table error:', e.message);
}

console.log('\n=== Trading Phase Table ===');
try {
  const phase = db.prepare('SELECT * FROM trading_phase LIMIT 5').all();
  if (phase.length === 0) {
    console.log('No trading phase data found');
  } else {
    phase.forEach(p => {
      console.log(`  `, JSON.stringify(p));
    });
  }
} catch (e) {
  console.log('trading_phase table error:', e.message);
}

console.log('\n=== Daily Metrics Table Structure ===');
try {
  const schema = db.prepare("PRAGMA table_info(daily_metrics)").all();
  console.log('Columns:', schema.map(c => c.name).join(', '));
  const metrics = db.prepare('SELECT * FROM daily_metrics ORDER BY rowid DESC LIMIT 5').all();
  if (metrics.length === 0) {
    console.log('No daily metrics found');
  } else {
    metrics.forEach(m => {
      console.log(`  `, JSON.stringify(m));
    });
  }
} catch (e) {
  console.log('daily_metrics table error:', e.message);
}

console.log('\n=== Strategy Events ===');
try {
  const events = db.prepare('SELECT * FROM strategy_events ORDER BY rowid DESC LIMIT 10').all();
  if (events.length === 0) {
    console.log('No strategy events found');
  } else {
    console.log(`Found ${events.length} strategy events:`);
    events.forEach(e => {
      console.log(`  `, JSON.stringify(e));
    });
  }
} catch (e) {
  console.log('strategy_events table error:', e.message);
}

console.log('\n=== Trades Table ===');
try {
  const trades = db.prepare('SELECT * FROM trades ORDER BY rowid DESC LIMIT 10').all();
  if (trades.length === 0) {
    console.log('No trades found');
  } else {
    console.log(`Found ${trades.length} trades:`);
    trades.forEach(t => {
      console.log(`  `, JSON.stringify(t));
    });
  }
} catch (e) {
  console.log('trades table error:', e.message);
}

console.log('\n=== TX Intents Table ===');
try {
  const intents = db.prepare('SELECT * FROM tx_intents ORDER BY rowid DESC LIMIT 5').all();
  if (intents.length === 0) {
    console.log('No tx intents found');
  } else {
    console.log(`Found ${intents.length} tx intents:`);
    intents.forEach(t => {
      console.log(`  `, JSON.stringify(t));
    });
  }
} catch (e) {
  console.log('tx_intents table error:', e.message);
}

console.log('\n=== Balance History ===');
try {
  const balance = db.prepare('SELECT * FROM balance_history ORDER BY rowid DESC LIMIT 5').all();
  if (balance.length === 0) {
    console.log('No balance history found');
  } else {
    console.log(`Found ${balance.length} balance entries:`);
    balance.forEach(b => {
      console.log(`  `, JSON.stringify(b));
    });
  }
} catch (e) {
  console.log('balance_history table error:', e.message);
}

db.close();
console.log('\nDatabase check complete.');

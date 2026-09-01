// Check rejection reasons and near misses
import { createRequire } from 'node:module';
import { existsSync } from 'fs';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const metricsDb = new DatabaseSync('./data/metrics.db');

console.log('=== Rejection Reasons (Why trades are not taken) ===');
try {
  const rejections = metricsDb.prepare('SELECT * FROM rejection_reasons ORDER BY rowid DESC LIMIT 30').all();
  if (rejections.length === 0) {
    console.log('No rejection reasons recorded');
  } else {
    console.log(`Found ${rejections.length} rejections:`);
    rejections.forEach(r => console.log(`  `, JSON.stringify(r)));
  }
} catch (e) {
  console.log('rejection_reasons error:', e.message);
}

console.log('\n=== Near Misses (Signals that almost fired) ===');
try {
  const nearMisses = metricsDb.prepare('SELECT * FROM near_misses ORDER BY rowid DESC LIMIT 30').all();
  if (nearMisses.length === 0) {
    console.log('No near misses recorded');
  } else {
    console.log(`Found ${nearMisses.length} near misses:`);
    nearMisses.forEach(n => console.log(`  `, JSON.stringify(n)));
  }
} catch (e) {
  console.log('near_misses error:', e.message);
}

console.log('\n=== Event Type Summary ===');
try {
  const summary = metricsDb.prepare(`
    SELECT event_type, COUNT(*) as count 
    FROM pipeline_events 
    GROUP BY event_type 
    ORDER BY count DESC
  `).all();
  console.log('Event counts:');
  summary.forEach(s => console.log(`  ${s.event_type}: ${s.count}`));
} catch (e) {
  console.log('Summary error:', e.message);
}

console.log('\n=== Last 5 Strategy Signals (if any) ===');
try {
  const signals = metricsDb.prepare(`
    SELECT * FROM pipeline_events 
    WHERE event_type = 'strategy_signal' 
    ORDER BY rowid DESC LIMIT 5
  `).all();
  if (signals.length === 0) {
    console.log('No strategy signals ever recorded!');
  } else {
    signals.forEach(s => console.log(`  `, JSON.stringify(s)));
  }
} catch (e) {
  console.log('Signals error:', e.message);
}

console.log('\n=== Recent Volume Z-Scores ===');
try {
  const events = metricsDb.prepare(`
    SELECT id, timestamp, details FROM pipeline_events 
    WHERE event_type = 'indicators_computed'
    ORDER BY rowid DESC LIMIT 10
  `).all();
  console.log('Volume Z-scores from recent evaluations:');
  events.forEach(e => {
    const details = JSON.parse(e.details);
    const ts = new Date(e.timestamp).toISOString();
    console.log(`  ${ts}: 15m volumeZ=${details.indicators15m?.volumeZScore?.toFixed(2)}, 1h volumeZ=${details.indicators1h?.volumeZScore?.toFixed(2)}`);
  });
} catch (e) {
  console.log('Volume check error:', e.message);
}

metricsDb.close();
console.log('\nRejection check complete.');

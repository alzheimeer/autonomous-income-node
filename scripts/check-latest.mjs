// Check the LATEST events after the container restart
import { DatabaseSync } from 'node:sqlite';

const metricsDb = new DatabaseSync('./data/metrics.db');

console.log('=== LATEST Pipeline Events (last 20) ===');
try {
  const events = metricsDb.prepare(`
    SELECT id, timestamp, event_type, details 
    FROM pipeline_events 
    ORDER BY rowid DESC 
    LIMIT 20
  `).all();
  
  console.log(`Found ${events.length} recent events:\n`);
  events.forEach(e => {
    const ts = new Date(e.timestamp).toISOString();
    const shortDetails = e.details.length > 200 ? e.details.substring(0, 200) + '...' : e.details;
    console.log(`[${ts}] ${e.event_type}`);
    if (e.event_type === 'strategy_signal_generated' || e.event_type === 'strategy_no_signal') {
      console.log(`  Details: ${shortDetails}`);
    }
  });
} catch (e) {
  console.log('Events error:', e.message);
}

console.log('\n=== Event counts SINCE container restart (17:57 UTC) ===');
try {
  const cutoff = '2026-07-30T17:57:00.000Z';
  const summary = metricsDb.prepare(`
    SELECT event_type, COUNT(*) as count 
    FROM pipeline_events 
    WHERE timestamp > ?
    GROUP BY event_type 
    ORDER BY count DESC
  `).all(cutoff);
  
  if (summary.length === 0) {
    console.log('No events since restart yet - waiting for first evaluation cycle...');
  } else {
    console.log('Event counts since restart:');
    summary.forEach(s => console.log(`  ${s.event_type}: ${s.count}`));
  }
} catch (e) {
  console.log('Summary error:', e.message);
}

console.log('\n=== Check for strategy_signal_generated events ===');
try {
  const signals = metricsDb.prepare(`
    SELECT * FROM pipeline_events 
    WHERE event_type = 'strategy_signal_generated'
    ORDER BY rowid DESC 
    LIMIT 5
  `).all();
  
  if (signals.length === 0) {
    console.log('No strategy_signal_generated events found');
  } else {
    console.log(`Found ${signals.length} signal events:`);
    signals.forEach(s => {
      console.log(`\n  Timestamp: ${s.timestamp}`);
      console.log(`  Details: ${s.details}`);
    });
  }
} catch (e) {
  console.log('Signals error:', e.message);
}

metricsDb.close();

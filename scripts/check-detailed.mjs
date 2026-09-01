// Detailed indicator analysis
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const metricsDb = new DatabaseSync('./data/metrics.db');

console.log('=== Recent Evaluation Details (last 5) ===');
try {
  const events = metricsDb.prepare(`
    SELECT id, timestamp, details FROM pipeline_events 
    WHERE event_type = 'indicators_computed'
    ORDER BY rowid DESC LIMIT 5
  `).all();
  
  events.forEach(e => {
    const details = JSON.parse(e.details);
    const ts = new Date(e.timestamp).toISOString();
    console.log(`\n--- ${ts} ---`);
    console.log(`Regime: ${details.regime}`);
    console.log(`15m Indicators:`);
    console.log(`  Price: $${details.indicators15m?.lastPrice?.toFixed(2)}`);
    console.log(`  RSI14: ${details.indicators15m?.rsi14?.toFixed(2)}`);
    console.log(`  VolumeZ: ${details.indicators15m?.volumeZScore?.toFixed(3)}`);
    console.log(`  EMA20: $${details.indicators15m?.ema20?.toFixed(2)}`);
    console.log(`  EMA50: $${details.indicators15m?.ema50?.toFixed(2)}`);
    console.log(`  EMA200: $${details.indicators15m?.ema200?.toFixed(2)}`);
    console.log(`  BB: lower=${details.indicators15m?.bollingerBands?.lower?.toFixed(2)}, upper=${details.indicators15m?.bollingerBands?.upper?.toFixed(2)}`);
    console.log(`1h Indicators:`);
    console.log(`  VolumeZ: ${details.indicators1h?.volumeZScore?.toFixed(3)}`);
    console.log(`  RSI14: ${details.indicators1h?.rsi14?.toFixed(2)}`);
    console.log(`  EMA50: $${details.indicators1h?.ema50?.toFixed(2)}`);
    console.log(`  EMA200: $${details.indicators1h?.ema200?.toFixed(2)}`);
  });
} catch (e) {
  console.log('Error:', e.message);
}

console.log('\n\n=== Strategy Condition Analysis (last evaluation) ===');
try {
  const events = metricsDb.prepare(`
    SELECT details FROM pipeline_events 
    WHERE event_type = 'indicators_computed'
    ORDER BY rowid DESC LIMIT 1
  `).all();
  
  const details = JSON.parse(events[0].details);
  const ind15m = details.indicators15m;
  const ind1h = details.indicators1h;
  const regime = details.regime;
  
  console.log(`Current Regime: ${regime}`);
  console.log(`\nTrend Pullback Requirements:`);
  const distToEma20 = Math.abs(ind15m.lastPrice - ind15m.ema20) / ind15m.ema20;
  console.log(`  Distance to EMA20: ${(distToEma20 * 100).toFixed(3)}% (need <= 1.5%) ${distToEma20 <= 0.015 ? '✓' : '✗'}`);
  console.log(`  RSI in [30, 55]: ${ind15m.rsi14?.toFixed(2)} ${ind15m.rsi14 >= 30 && ind15m.rsi14 <= 55 ? '✓' : '✗'}`);
  console.log(`  VolumeZ > 0.5: ${ind15m.volumeZScore?.toFixed(3)} ${ind15m.volumeZScore > 0.5 ? '✓' : '✗'}`);
  console.log(`  EMA20 > EMA50: ${ind15m.ema20?.toFixed(2)} > ${ind15m.ema50?.toFixed(2)} ${ind15m.ema20 > ind15m.ema50 ? '✓' : '✗'}`);
  console.log(`  Price > EMA50*0.99: ${ind15m.lastPrice?.toFixed(2)} > ${(ind15m.ema50 * 0.99)?.toFixed(2)} ${ind15m.lastPrice > ind15m.ema50 * 0.99 ? '✓' : '✗'}`);
  
  console.log(`\nMean Reversion Requirements:`);
  const distToLowerBB = (ind15m.bollingerBands.lower - ind15m.lastPrice) / ind15m.bollingerBands.lower;
  console.log(`  Near lower BB (distToLowerBB >= -0.01): ${(distToLowerBB * 100).toFixed(3)}% ${distToLowerBB >= -0.01 ? '✓' : '✗'}`);
  console.log(`  RSI < 35: ${ind15m.rsi14?.toFixed(2)} ${ind15m.rsi14 < 35 ? '✓' : '✗'}`);
  console.log(`  VolumeZ > 0.5: ${ind15m.volumeZScore?.toFixed(3)} ${ind15m.volumeZScore > 0.5 ? '✓' : '✗'}`);
  
  console.log(`\nDip Buying Requirements:`);
  const distToEma50 = Math.abs(ind15m.lastPrice - ind15m.ema50) / ind15m.ema50;
  const distToEma200 = Math.abs(ind15m.lastPrice - ind15m.ema200) / ind15m.ema200;
  const nearEma50 = ind15m.lastPrice <= ind15m.ema50 && distToEma50 <= 0.02;
  const nearEma200 = ind15m.lastPrice <= ind15m.ema200 && distToEma200 <= 0.02;
  console.log(`  Near EMA50 (price <= EMA50 && dist <= 2%): price=${ind15m.lastPrice?.toFixed(2)}, ema50=${ind15m.ema50?.toFixed(2)}, dist=${(distToEma50*100).toFixed(2)}% ${nearEma50 ? '✓' : '✗'}`);
  console.log(`  Near EMA200 (price <= EMA200 && dist <= 2%): price=${ind15m.lastPrice?.toFixed(2)}, ema200=${ind15m.ema200?.toFixed(2)}, dist=${(distToEma200*100).toFixed(2)}% ${nearEma200 ? '✓' : '✗'}`);
  console.log(`  RSI < 40: ${ind15m.rsi14?.toFixed(2)} ${ind15m.rsi14 < 40 ? '✓' : '✗'}`);
  console.log(`  VolumeZ > 0.3: ${ind15m.volumeZScore?.toFixed(3)} ${ind15m.volumeZScore > 0.3 ? '✓' : '✗'}`);
  console.log(`  1h EMA50 > EMA200: ${ind1h.ema50?.toFixed(2)} > ${ind1h.ema200?.toFixed(2)} ${ind1h.ema50 > ind1h.ema200 ? '✓' : '✗'}`);
  
  console.log(`\nMomentum Breakout Requirements:`);
  console.log(`  Price > upper BB: ${ind15m.lastPrice?.toFixed(2)} > ${ind15m.bollingerBands.upper?.toFixed(2)} ${ind15m.lastPrice > ind15m.bollingerBands.upper ? '✓' : '✗'}`);
  console.log(`  RSI in [55, 80]: ${ind15m.rsi14?.toFixed(2)} ${ind15m.rsi14 >= 55 && ind15m.rsi14 <= 80 ? '✓' : '✗'}`);
  console.log(`  VolumeZ > 1.0: ${ind15m.volumeZScore?.toFixed(3)} ${ind15m.volumeZScore > 1.0 ? '✓' : '✗'}`);
  
} catch (e) {
  console.log('Error:', e.message);
}

console.log('\n\n=== Historical Signal Details (when they DID fire) ===');
try {
  const signals = metricsDb.prepare(`
    SELECT * FROM pipeline_events 
    WHERE event_type = 'strategy_signal_generated' 
    ORDER BY rowid DESC LIMIT 5
  `).all();
  
  if (signals.length === 0) {
    console.log('No strategy_signal_generated events found');
  } else {
    signals.forEach(s => {
      console.log(`\n--- Signal at ${new Date(s.timestamp).toISOString()} ---`);
      const details = JSON.parse(s.details);
      console.log(JSON.stringify(details, null, 2));
    });
  }
} catch (e) {
  console.log('Error:', e.message);
}

metricsDb.close();
console.log('\n\nAnalysis complete.');

// Test if current market conditions would now generate a signal
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

const metricsDb = new DatabaseSync('./data/metrics.db');

console.log('=== Testing Updated Strategy Logic ===\n');

// Get latest indicators
const events = metricsDb.prepare(`
  SELECT details FROM pipeline_events 
  WHERE event_type = 'indicators_computed'
  ORDER BY rowid DESC LIMIT 1
`).all();

const details = JSON.parse(events[0].details);
const ind15m = details.indicators15m;
const ind1h = details.indicators1h;
const regime = details.regime || 'UNCERTAIN';

console.log('Current Market State:');
console.log(`  Price: $${ind15m.lastPrice?.toFixed(2)}`);
console.log(`  Regime: ${regime}`);
console.log(`  RSI 15m: ${ind15m.rsi14?.toFixed(2)}`);
console.log(`  Volume Z 15m: ${ind15m.volumeZScore?.toFixed(3)}`);
console.log(`  EMA20: $${ind15m.ema20?.toFixed(2)}, EMA50: $${ind15m.ema50?.toFixed(2)}, EMA200: $${ind15m.ema200?.toFixed(2)}`);

console.log('\n--- Testing Updated Strategies (volume no longer blocks) ---\n');

// Test Trend Pullback (updated logic)
console.log('1. TREND PULLBACK (updated):');
const distToEma20 = Math.abs(ind15m.lastPrice - ind15m.ema20) / ind15m.ema20;
const tp1 = distToEma20 <= 0.02; // Relaxed to 2%
const tp2 = ind15m.rsi14 >= 28 && ind15m.rsi14 <= 58; // Relaxed RSI
const tp3 = true; // Volume no longer blocks
const tp4 = ind15m.ema20 > ind15m.ema50;
const tp5 = ind15m.lastPrice > ind15m.ema50 * 0.98;
console.log(`  Distance to EMA20 <= 2%: ${(distToEma20*100).toFixed(3)}% ${tp1 ? '✓' : '✗'}`);
console.log(`  RSI in [28, 58]: ${ind15m.rsi14?.toFixed(2)} ${tp2 ? '✓' : '✗'}`);
console.log(`  Volume: No longer blocks (affects confidence only) ✓`);
console.log(`  EMA20 > EMA50: ${tp4 ? '✓' : '✗'}`);
console.log(`  Price > EMA50*0.98: ${tp5 ? '✓' : '✗'}`);
const tpWouldFire = tp1 && tp2 && tp4 && tp5;
console.log(`  WOULD FIRE: ${tpWouldFire ? '✓ YES!' : '✗ No'}`);

// Test Dip Buying (updated logic)
console.log('\n2. DIP BUYING (updated):');
const distToEma20Dip = Math.abs(ind15m.lastPrice - ind15m.ema20) / ind15m.ema20;
const distToEma50Dip = Math.abs(ind15m.lastPrice - ind15m.ema50) / ind15m.ema50;
const distToEma200Dip = Math.abs(ind15m.lastPrice - ind15m.ema200) / ind15m.ema200;
const nearEma20 = distToEma20Dip <= 0.025 && ind15m.lastPrice >= ind15m.ema20 * 0.98;
const nearEma50 = distToEma50Dip <= 0.025 && ind15m.lastPrice >= ind15m.ema50 * 0.98;
const nearEma200 = distToEma200Dip <= 0.025 && ind15m.lastPrice >= ind15m.ema200 * 0.98;
const db1 = nearEma20 || nearEma50 || nearEma200;
const db2 = ind15m.rsi14 < 50; // Relaxed to < 50
const db3 = true; // Volume no longer blocks
const db4 = ind1h.ema20 > ind1h.ema200;
console.log(`  Near EMA20 (dist <= 2.5%): ${(distToEma20Dip*100).toFixed(2)}% ${nearEma20 ? '✓' : '✗'}`);
console.log(`  Near EMA50 (dist <= 2.5%): ${(distToEma50Dip*100).toFixed(2)}% ${nearEma50 ? '✓' : '✗'}`);
console.log(`  Near EMA200 (dist <= 2.5%): ${(distToEma200Dip*100).toFixed(2)}% ${nearEma200 ? '✓' : '✗'}`);
console.log(`  Near any EMA: ${db1 ? '✓' : '✗'}`);
console.log(`  RSI < 50: ${ind15m.rsi14?.toFixed(2)} ${db2 ? '✓' : '✗'}`);
console.log(`  Volume: No longer blocks (affects confidence only) ✓`);
console.log(`  1h EMA20 > EMA200: ${ind1h.ema20?.toFixed(2)} > ${ind1h.ema200?.toFixed(2)} ${db4 ? '✓' : '✗'}`);
const dbWouldFire = db1 && db2 && db4;
console.log(`  WOULD FIRE: ${dbWouldFire ? '✓ YES!' : '✗ No'}`);

// Test Mean Reversion (updated logic)  
console.log('\n3. MEAN REVERSION (updated):');
const distToLowerBB = (ind15m.bollingerBands.lower - ind15m.lastPrice) / ind15m.bollingerBands.lower;
const mr1 = distToLowerBB >= -0.015; // Relaxed to 1.5%
const mr2 = ind15m.rsi14 < 42; // Relaxed to < 42
const mr3 = true; // Volume no longer blocks
console.log(`  Near lower BB (dist >= -1.5%): ${(distToLowerBB*100).toFixed(3)}% ${mr1 ? '✓' : '✗'}`);
console.log(`  RSI < 42: ${ind15m.rsi14?.toFixed(2)} ${mr2 ? '✓' : '✗'}`);
console.log(`  Volume: No longer blocks ✓`);
const mrWouldFire = mr1 && mr2;
console.log(`  WOULD FIRE: ${mrWouldFire ? '✓ YES!' : '✗ No'}`);

console.log('\n=== SUMMARY ===');
console.log(`Any strategy would fire: ${tpWouldFire || dbWouldFire || mrWouldFire ? '✓ YES' : '✗ NO'}`);
if (tpWouldFire) console.log('  -> Trend Pullback');
if (dbWouldFire) console.log('  -> Dip Buying');
if (mrWouldFire) console.log('  -> Mean Reversion');

metricsDb.close();

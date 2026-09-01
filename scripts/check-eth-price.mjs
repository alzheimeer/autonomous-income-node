// Quick script to check current ETH price and compare to position
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('./data/agent.db');

// Get active position (closed = 0 means open)
const position = db.prepare(`
  SELECT * FROM positions 
  WHERE closed = 0 
  ORDER BY entry_timestamp DESC 
  LIMIT 1
`).get();

if (!position) {
  console.log('No active position');
  process.exit(0);
}

// Fetch current price from Binance
const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDC');
const data = await response.json();
const currentPrice = parseFloat(data.price);

const entryPrice = position.entry_price;
const stopLoss = position.stop_loss;
const takeProfit = position.take_profit;

const pnlPercent = ((currentPrice - entryPrice) / entryPrice * 100).toFixed(3);
const distanceToSL = ((currentPrice - stopLoss) / currentPrice * 100).toFixed(3);
const distanceToTP = ((takeProfit - currentPrice) / currentPrice * 100).toFixed(3);

console.log('=== ETH Price Analysis ===\n');
console.log(`Current Price: $${currentPrice.toFixed(2)}`);
console.log(`Entry Price:   $${entryPrice.toFixed(2)}`);
console.log(`Stop Loss:     $${stopLoss.toFixed(2)}`);
console.log(`Take Profit:   $${takeProfit.toFixed(2)}`);
console.log('');
console.log(`📊 Current P&L: ${pnlPercent}%`);
console.log(`📉 Distance to SL: ${distanceToSL}% (below current)`);
console.log(`📈 Distance to TP: ${distanceToTP}% (above current)`);
console.log('');

if (currentPrice <= stopLoss) {
  console.log('🔴 STOP LOSS HIT - Should exit with loss');
} else if (currentPrice >= takeProfit) {
  console.log('🟢 TAKE PROFIT HIT - Should exit with profit');
} else if (parseFloat(pnlPercent) > 0) {
  console.log('🟡 Position in profit, waiting for TP or time exit');
} else {
  console.log('🟠 Position in loss, monitoring SL');
}

// Check holding time
const entryTime = new Date(position.entry_timestamp);
const now = new Date();
const holdingMs = now - entryTime;
const holdingHours = holdingMs / (1000 * 60 * 60);
const maxHoldingHours = position.max_holding_ms / (1000 * 60 * 60);

console.log(`\n⏱️  Holding: ${holdingHours.toFixed(2)} hours / ${maxHoldingHours} max`);
if (holdingMs >= position.max_holding_ms) {
  console.log('⚠️  MAX HOLDING TIME REACHED - Should exit');
}

db.close();

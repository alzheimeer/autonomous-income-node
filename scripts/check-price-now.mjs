// Quick ETH price check from Binance
const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDC');
const data = await response.json();
console.log(`ETH/USDC Price: $${parseFloat(data.price).toFixed(2)}`);

// Get 24h stats
const stats = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=ETHUSDC');
const s = await stats.json();
console.log(`24h Change: ${parseFloat(s.priceChangePercent).toFixed(2)}%`);
console.log(`24h High: $${parseFloat(s.highPrice).toFixed(2)}`);
console.log(`24h Low: $${parseFloat(s.lowPrice).toFixed(2)}`);

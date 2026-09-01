import { BinanceDataDownloader } from '../src/backtester/binance-downloader.js';

async function main() {
  const d = new BinanceDataDownloader();

  console.log('\n=== Market Analysis: Which assets had directional moves? ===\n');

  const pairs = ['ETHUSDC', 'SOLUSDC', 'BTCUSDC'];

  for (const pair of pairs) {
    try {
      // Last 30 days
      const c30 = await d.downloadCandles(pair, '1h', 30, 0);
      const first30 = c30[0]!.close;
      const last30 = c30[c30.length - 1]!.close;
      const ch30 = ((last30 - first30) / first30 * 100).toFixed(1);

      // Last 365 days
      const c365 = await d.downloadCandles(pair, '1h', 365, 0);
      const first365 = c365[0]!.close;
      const last365 = c365[c365.length - 1]!.close;
      const ch365 = ((last365 - first365) / first365 * 100).toFixed(1);

      // Volatility (ATR as % of price, last 30d)
      let atrSum = 0;
      for (let i = 1; i < Math.min(30, c30.length); i++) {
        const tr = Math.max(
          c30[i]!.high - c30[i]!.low,
          Math.abs(c30[i]!.high - c30[i-1]!.close),
          Math.abs(c30[i]!.low - c30[i-1]!.close),
        );
        atrSum += tr;
      }
      const atr = atrSum / 29;
      const atrPct = (atr / last30 * 100).toFixed(2);

      console.log(`${pair}:`);
      console.log(`  30d: $${first30.toFixed(2)} → $${last30.toFixed(2)} (${ch30}%)`);
      console.log(`  1yr: $${first365.toFixed(2)} → $${last365.toFixed(2)} (${ch365}%)`);
      console.log(`  ATR/price (1h, 30d): ${atrPct}%`);
      console.log(`  Short opportunity (if went DOWN): ${Number(ch365) < -10 ? '✅ YES' : '❌ NO'}`);
      console.log(`  Long opportunity (if went UP): ${Number(ch365) > 10 ? '✅ YES' : '❌ NO'}`);
      console.log('');
    } catch (err) {
      console.log(`${pair}: ERROR - ${(err as Error).message}\n`);
    }
  }

  // Check Aave USDC APY (Base)
  console.log('=== Aave USDC Yield ===');
  console.log('  Current APY: ~3-5% (variable rate, check on-chain)');
  console.log('  On $99 USDC: ~$3-5/year = $0.01/day');
  console.log('  Risk: Near-zero (USDC lending on Aave V3 Base)\n');
}

main().catch(console.error);

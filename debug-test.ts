import { SmartMoneyCurator } from './src/copy-trading/modules/SmartMoneyCurator';
import { WalletStats } from './src/copy-trading/interfaces/types';

const mockLogger = {
  debug: (msg: string) => console.log('[DEBUG]', msg),
  info: (msg: string) => console.log('[INFO]', msg),
  warn: (msg: string) => console.log('[WARN]', msg),
  error: (msg: string) => console.log('[ERROR]', msg),
};

const curator = new SmartMoneyCurator(mockLogger as any);

console.log('=== Config ===');
console.log(JSON.stringify(curator.getConfig().exclusionThresholds, null, 2));

// Test 1: Token deployer with tokenDeployedDaysAgo = 0
const stats1: WalletStats = {
  totalTrades: 100,
  profitableTrades: 60,
  winRate: 60,
  avgProfitPercent: 15,
  avgHoldingTimeHours: 24,
  totalVolumeUsd: 100000,
  sameBlockTradePercentage: 0,
  hasDeployedToken: true,
  tokenDeployedDaysAgo: 0,
  honeypotTradePercentage: 0,
  receivedDeployerAirdrop: false,
  sameCounterpartyPercentage: 0,
};

console.log('\n=== Test 1: Token Deployer (daysAgo=0) ===');
console.log('hasDeployedToken:', stats1.hasDeployedToken);
console.log('tokenDeployedDaysAgo:', stats1.tokenDeployedDaysAgo);
console.log('isExcluded:', curator.shouldExcludeWallet(stats1));
console.log('reasons:', curator.getExclusionReasons(stats1));

// Test 2: Honeypot 21%
const stats2: WalletStats = {
  ...stats1,
  hasDeployedToken: false,
  tokenDeployedDaysAgo: undefined,
  honeypotTradePercentage: 21,
};

console.log('\n=== Test 2: Honeypot 21% ===');
console.log('honeypotTradePercentage:', stats2.honeypotTradePercentage);
console.log('isExcluded:', curator.shouldExcludeWallet(stats2));
console.log('reasons:', curator.getExclusionReasons(stats2));

// Test 3: Honeypot 20% (boundary - should NOT be excluded)
const stats3: WalletStats = {
  ...stats1,
  hasDeployedToken: false,
  tokenDeployedDaysAgo: undefined,
  honeypotTradePercentage: 20,
};

console.log('\n=== Test 3: Honeypot 20% (boundary) ===');
console.log('honeypotTradePercentage:', stats3.honeypotTradePercentage);
console.log('isExcluded:', curator.shouldExcludeWallet(stats3));
console.log('reasons:', curator.getExclusionReasons(stats3));

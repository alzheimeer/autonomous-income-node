/**
 * Income Sustainability Engine — Configuration Module
 *
 * Defines typed configuration interfaces and default values for all
 * income-generating strategy modules. Environment variable overrides
 * are applied where applicable.
 *
 * All USDC values use BigInt with 6 decimals (1 USDC = 1_000000n).
 *
 * Requirements: 4.1, 6.1, 7.1, 8.2, 9.1, 10.1
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Sub-configuration interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/** Aave V3 lending strategy configuration (Requirement 4) */
export interface AaveLendingConfig {
  /** Minimum idle USDC before depositing (6 decimals). Default: 20_000000n ($20) */
  depositThreshold: bigint;
  /** Minimum APY to maintain position (basis points). Default: 200 (2%) */
  minApyBps: number;
  /** Aave V3 Pool address on Base */
  poolAddress: string;
  /** aUSDC token address on Base */
  aTokenAddress: string;
  /** USDC token address on Base */
  usdcAddress: string;
  /** RPC URL for Base mainnet */
  rpcUrl: string;
}

/** Hyperliquid perpetuals grid trading configuration (Requirement 6) */
export interface HyperliquidConfig {
  /** Maximum margin allocation (6 decimals). Default: 10_000000n ($10) */
  maxMarginUsdc: bigint;
  /** Maximum leverage multiplier. Default: 2 */
  maxLeverage: number;
  /** Funding rate threshold for closing (bps). Default: 10 (0.10%) */
  fundingThresholdBps: number;
  /** Stop-loss amount (6 decimals). Default: 5_000000n ($5) */
  stopLossUsdc: bigint;
  /** Cooldown after error (ms). Default: 3_600_000 (1 hour) */
  errorCooldownMs: number;
  /** Trading pairs (e.g. ['ETH-USD', 'BTC-USD']) */
  tradingPairs: string[];
  /** Grid spacing in basis points. Default: 50 */
  gridSpacingBps: number;
}

/** Stablecoin LP (Uniswap V3) configuration (Requirement 7) */
export interface LPConfig {
  /** Minimum USDC to open LP position (6 decimals). Default: 30_000000n ($30) */
  minPositionUsdc: bigint;
  /** Fee tier (100 for 0.01% stablecoin pools). Default: 100 */
  feeTier: number;
  /** Lower price bound. Default: 0.998 */
  priceLower: number;
  /** Upper price bound. Default: 1.002 */
  priceUpper: number;
  /** Max impermanent loss threshold (basis points). Default: 50 (0.5%) */
  maxILBps: number;
  /** Cooldown after IL breach (ms). Default: 86_400_000 (24 hours) */
  ilCooldownMs: number;
}

/** Strategy performance tracker configuration (Requirement 8) */
export interface StrategyTrackerConfig {
  /** Disable strategy after N consecutive loss days. Default: 7 */
  disableAfterDays: number;
  /** Cooldown before re-enabling in trial mode (days). Default: 14 */
  cooldownDays: number;
}

/** Opportunity discovery scanner configuration (Requirement 9) */
export interface OpportunityDiscoveryConfig {
  /** Scan interval (ms). Default: 1_800_000 (30 minutes) */
  intervalMs: number;
  /** Minimum viability score to mark as actionable. Default: 70 */
  minViabilityScore: number;
}

/** Knowledge acquisition loop configuration (Requirement 10) */
export interface KnowledgeAcquirerConfig {
  /** Scan interval (ms). Default: 7_200_000 (2 hours) */
  intervalMs: number;
  /** Minimum viability score for actionable status. Default: 70 */
  minActionableScore: number;
}

/** Cloudflare Tunnel manager configuration (Requirement 3) */
export interface CloudflareTunnelConfig {
  /** Cloudflare subdomain (e.g. "ain-agent.example.com") */
  subdomain: string;
  /** Local port to expose. Default: 3001 */
  localPort: number;
  /** Cloudflare tunnel token (from Zero Trust dashboard) */
  tunnelToken: string;
}

/** x402 Bazaar service registration configuration (Requirement 2) */
export interface BazaarConfig {
  /** Bazaar API base URL */
  apiUrl: string;
  /** Number of retry attempts on API failure. Default: 3 */
  retryAttempts: number;
}

/** AutoLender pre-cycle hook configuration (Revenue Optimization) */
export interface AutoLenderConfig {
  /** Minimum balance to trigger deposit (6 decimals). Default: 20_000000n ($20) */
  depositThreshold: bigint;
  /** Amount to keep liquid for gas/operations (6 decimals). Default: 15_000000n ($15) */
  operatingReserve: bigint;
  /** Balance below which emergency withdraw triggers (6 decimals). Default: 10_000000n ($10) */
  emergencyWithdrawBelow: bigint;
  /** Minimum APY to maintain position (basis points). Default: 200 (2%) */
  minApyBps: number;
}

/** CostOptimizer LLM cache configuration (Revenue Optimization) */
export interface CostOptimizerConfig {
  /** Maximum number of cached entries (LRU eviction). Default: 50 */
  cacheMaxEntries: number;
  /** Cache time-to-live in milliseconds. Default: 300_000 (5 min) */
  cacheTtlMs: number;
  /** Cycle interval when no opportunities detected (ms). Default: 300_000 */
  idleIntervalMs: number;
  /** Cycle interval when opportunities are active (ms). Default: 60_000 */
  activeIntervalMs: number;
}

/** MultiSourceScanner arbitrage detection configuration (Revenue Optimization) */
export interface MultiSourceScannerConfig {
  /** Minimum net profit to report an opportunity (6 decimals). Default: 500_000n ($0.50) */
  minProfitUsdc: bigint;
  /** Maximum trade size in USDC (6 decimals). Default: 50_000000n ($50) */
  maxTradeUsdc: bigint;
  /** Estimated gas cost per swap in USDC (6 decimals). Default: 200_000n ($0.20) */
  gasCostUsdc: bigint;
}

/** AdaptiveEvolver — bridge between KnowledgeAcquirer and SelfModModule */
export interface AdaptiveEvolverConfig {
  /** Interval between evaluations (ms). Default: 3600_000 (1 hour) */
  evaluationIntervalMs: number;
  /** Maximum implementations per cycle. Default: 1 */
  maxImplementationsPerCycle: number;
  /** Minimum viability score to attempt implementation. Default: 75 */
  minScoreForImplementation: number;
  /** If true, only generates plan but does NOT apply (dry-run). Default: true */
  dryRun: boolean;
}

/** OKX AI Marketplace integration configuration */
export interface OkxMarketplaceConfig {
  /** Agent ID on OKX marketplace (e.g. '6740') */
  agentId: string;
  /** Heartbeat interval in milliseconds. Default: 1500000 (25 min) */
  heartbeatIntervalMs: number;
  /** Whether to enable OKX heartbeat. Default: true */
  heartbeatEnabled: boolean;
  /** Whether to enable x402 middleware on service endpoints. Default: true */
  x402Enabled: boolean;
  /** Address to receive payments */
  payToAddress: string;
  /** Network identifier (e.g. 'eip155:196' for X Layer) */
  network: string;
  /** Asset contract address (e.g. USDT0 on X Layer) */
  assetAddress: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Root configuration interface
// ═══════════════════════════════════════════════════════════════════════════════

/** Complete configuration for the Income Sustainability Engine */
export interface IncomeSustainabilityConfig {
  aaveLending: AaveLendingConfig;
  hyperliquid: HyperliquidConfig;
  lp: LPConfig;
  strategyTracker: StrategyTrackerConfig;
  opportunityDiscovery: OpportunityDiscoveryConfig;
  knowledgeAcquirer: KnowledgeAcquirerConfig;
  cloudflareTunnel: CloudflareTunnelConfig;
  bazaar: BazaarConfig;
  autoLender: AutoLenderConfig;
  costOptimizer: CostOptimizerConfig;
  multiSourceScanner: MultiSourceScannerConfig;
  adaptiveEvolver: AdaptiveEvolverConfig;
  okxMarketplace: OkxMarketplaceConfig;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Environment helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Read an environment variable as a string, returning undefined if not set
 * or empty.
 */
function envStr(key: string): string | undefined {
  const val = process.env[key];
  return val && val.trim().length > 0 ? val.trim() : undefined;
}

/**
 * Read an environment variable as an integer, returning undefined if not set
 * or not a valid number.
 */
function envInt(key: string): number | undefined {
  const val = envStr(key);
  if (val === undefined) return undefined;
  const parsed = Number.parseInt(val, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Read an environment variable as a BigInt (string representation of integer),
 * returning undefined if not set.
 */
function envBigInt(key: string): bigint | undefined {
  const val = envStr(key);
  if (val === undefined) return undefined;
  try {
    return BigInt(val);
  } catch {
    return undefined;
  }
}

/**
 * Read an environment variable as a float, returning undefined if not set
 * or not a valid number.
 */
function envFloat(key: string): number | undefined {
  const val = envStr(key);
  if (val === undefined) return undefined;
  const parsed = Number.parseFloat(val);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Read an environment variable as a comma-separated string array.
 */
function envArray(key: string): string[] | undefined {
  const val = envStr(key);
  if (val === undefined) return undefined;
  return val.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Default configuration
// ═══════════════════════════════════════════════════════════════════════════════

/** Base mainnet contract addresses */
const BASE_CONTRACTS = {
  AAVE_V3_POOL: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  AUSDC_TOKEN: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
} as const;

/**
 * Default configuration with all values specified in the design document.
 * Environment variables override defaults where applicable.
 */
export const DEFAULT_CONFIG: IncomeSustainabilityConfig = {
  aaveLending: {
    depositThreshold: envBigInt('AAVE_DEPOSIT_THRESHOLD') ?? 20_000000n,
    minApyBps: envInt('AAVE_MIN_APY_BPS') ?? 200,
    poolAddress: envStr('AAVE_POOL_ADDRESS') ?? BASE_CONTRACTS.AAVE_V3_POOL,
    aTokenAddress: envStr('AAVE_ATOKEN_ADDRESS') ?? BASE_CONTRACTS.AUSDC_TOKEN,
    usdcAddress: envStr('USDC_ADDRESS') ?? BASE_CONTRACTS.USDC,
    rpcUrl: envStr('RPC_PROVIDER_URL') ?? '',
  },

  hyperliquid: {
    maxMarginUsdc: envBigInt('HL_MAX_MARGIN_USDC') ?? 10_000000n,
    maxLeverage: envInt('HL_MAX_LEVERAGE') ?? 2,
    fundingThresholdBps: envInt('HL_FUNDING_THRESHOLD_BPS') ?? 10,
    stopLossUsdc: envBigInt('HL_STOP_LOSS_USDC') ?? 5_000000n,
    errorCooldownMs: envInt('HL_ERROR_COOLDOWN_MS') ?? 3_600_000,
    tradingPairs: envArray('HL_TRADING_PAIRS') ?? ['ETH-USD', 'BTC-USD'],
    gridSpacingBps: envInt('HL_GRID_SPACING_BPS') ?? 50,
  },

  lp: {
    minPositionUsdc: envBigInt('LP_MIN_POSITION_USDC') ?? 30_000000n,
    feeTier: envInt('LP_FEE_TIER') ?? 100,
    priceLower: envFloat('LP_PRICE_LOWER') ?? 0.998,
    priceUpper: envFloat('LP_PRICE_UPPER') ?? 1.002,
    maxILBps: envInt('LP_MAX_IL_BPS') ?? 50,
    ilCooldownMs: envInt('LP_IL_COOLDOWN_MS') ?? 86_400_000,
  },

  strategyTracker: {
    disableAfterDays: envInt('STRATEGY_DISABLE_AFTER_DAYS') ?? 7,
    cooldownDays: envInt('STRATEGY_COOLDOWN_DAYS') ?? 14,
  },

  opportunityDiscovery: {
    intervalMs: envInt('OPPORTUNITY_SCAN_INTERVAL_MS') ?? 1_800_000,
    minViabilityScore: envInt('OPPORTUNITY_MIN_SCORE') ?? 70,
  },

  knowledgeAcquirer: {
    intervalMs: envInt('KNOWLEDGE_SCAN_INTERVAL_MS') ?? 7_200_000,
    minActionableScore: envInt('KNOWLEDGE_MIN_SCORE') ?? 70,
  },

  cloudflareTunnel: {
    subdomain: envStr('CF_TUNNEL_SUBDOMAIN') ?? '',
    localPort: envInt('CF_TUNNEL_LOCAL_PORT') ?? 3001,
    tunnelToken: envStr('CF_TUNNEL_TOKEN') ?? '',
  },

  bazaar: {
    apiUrl: envStr('BAZAAR_API_URL') ?? '',
    retryAttempts: envInt('BAZAAR_RETRY_ATTEMPTS') ?? 3,
  },

  autoLender: {
    depositThreshold: envBigInt('AUTO_LENDER_DEPOSIT_THRESHOLD') ?? 20_000000n,
    operatingReserve: envBigInt('AUTO_LENDER_OPERATING_RESERVE') ?? 15_000000n,
    emergencyWithdrawBelow: envBigInt('AUTO_LENDER_EMERGENCY_BELOW') ?? 10_000000n,
    minApyBps: envInt('AUTO_LENDER_MIN_APY_BPS') ?? 200,
  },

  costOptimizer: {
    cacheMaxEntries: envInt('COST_OPTIMIZER_CACHE_MAX') ?? 50,
    cacheTtlMs: envInt('COST_OPTIMIZER_CACHE_TTL_MS') ?? 300_000,
    idleIntervalMs: envInt('COST_OPTIMIZER_IDLE_INTERVAL_MS') ?? 300_000,
    activeIntervalMs: envInt('COST_OPTIMIZER_ACTIVE_INTERVAL_MS') ?? 60_000,
  },

  multiSourceScanner: {
    minProfitUsdc: envBigInt('ARBITRAGE_MIN_PROFIT_USDC') ?? 500_000n,
    maxTradeUsdc: envBigInt('ARBITRAGE_MAX_TRADE_USDC') ?? 50_000000n,
    gasCostUsdc: envBigInt('ARBITRAGE_GAS_COST_USDC') ?? 200_000n,
  },

  adaptiveEvolver: {
    evaluationIntervalMs: envInt('ADAPTIVE_EVOLVER_INTERVAL_MS') ?? 3_600_000, // 1 hour
    maxImplementationsPerCycle: envInt('ADAPTIVE_EVOLVER_MAX_PER_CYCLE') ?? 1,
    minScoreForImplementation: envInt('ADAPTIVE_EVOLVER_MIN_SCORE') ?? 75,
    dryRun: (envStr('ADAPTIVE_EVOLVER_DRY_RUN') ?? 'false') === 'true', // Active by default — agent auto-improves
  },

  okxMarketplace: {
    agentId: envStr('OKX_AGENT_ID') ?? '6740',
    heartbeatIntervalMs: envInt('OKX_HEARTBEAT_INTERVAL_MS') ?? 1_500_000, // 25 min
    heartbeatEnabled: (envStr('OKX_HEARTBEAT_ENABLED') ?? 'true') === 'true',
    x402Enabled: (envStr('OKX_X402_ENABLED') ?? 'true') === 'true',
    payToAddress: envStr('OKX_PAY_TO_ADDRESS') ?? '0x687dd10e8240908069ee760b7a41ac2c451f6031',
    network: 'eip155:196', // X Layer
    assetAddress: '0x779ded0c9e1022225f8e0630b35a9b54be713736', // USDT0 on X Layer
  },
};

/**
 * Hybrid Sniper — Exploration Configuration
 *
 * Defines parameter variants to test in shadow mode.
 * Since we're not using real money, we can explore many combinations
 * simultaneously to find the optimal configuration.
 *
 * Exploration dimensions:
 *   - TP/SL combinations (risk/reward ratios)
 *   - Time stops (holding periods)
 *   - Trade sizes (position sizing)
 *   - Additional crypto pairs (beyond micro-caps)
 *
 * Requirements: Research mode optimization
 */

// ═══════════════════════════════════════════════════════════════════════════
// Variant Configuration Types
// ═══════════════════════════════════════════════════════════════════════════

export interface TpSlVariant {
  id: string;
  name: string;
  tpPct: number;
  slPct: number;
  ratio: number; // TP/SL ratio for reference
}

export interface TimeStopVariant {
  id: string;
  name: string;
  timeStopMs: number;
  timeStopMinutes: number;
}

export interface TradeSizeVariant {
  id: string;
  name: string;
  tradeSizeUsdc: number;
}

export interface ExplorationVariant {
  id: string;
  name: string;
  tpPct: number;
  slPct: number;
  timeStopMs: number;
  tradeSizeUsdc: number;
  description: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// TP/SL Variants — Different Risk/Reward Profiles
// ═══════════════════════════════════════════════════════════════════════════

export const TP_SL_VARIANTS: TpSlVariant[] = [
  // Conservative — tight stops, small gains
  { id: 'tight', name: 'Tight (20/10)', tpPct: 20, slPct: 10, ratio: 2.0 },
  
  // Balanced — current default
  { id: 'balanced', name: 'Balanced (40/15)', tpPct: 40, slPct: 15, ratio: 2.67 },
  
  // Wide — more room to breathe
  { id: 'wide', name: 'Wide (60/20)', tpPct: 60, slPct: 20, ratio: 3.0 },
  
  // Aggressive TP — capture big moves
  { id: 'aggressive', name: 'Aggressive (80/25)', tpPct: 80, slPct: 25, ratio: 3.2 },
  
  // Moon bag — very wide for memecoins
  { id: 'moonbag', name: 'Moon Bag (150/30)', tpPct: 150, slPct: 30, ratio: 5.0 },
  
  // Scalper — quick small gains
  { id: 'scalper', name: 'Scalper (15/5)', tpPct: 15, slPct: 5, ratio: 3.0 },
];

// ═══════════════════════════════════════════════════════════════════════════
// Time Stop Variants — Different Holding Periods
// ═══════════════════════════════════════════════════════════════════════════

export const TIME_STOP_VARIANTS: TimeStopVariant[] = [
  { id: 'quick', name: '30 minutes', timeStopMs: 30 * 60 * 1000, timeStopMinutes: 30 },
  { id: 'hour', name: '1 hour', timeStopMs: 60 * 60 * 1000, timeStopMinutes: 60 },
  { id: 'default', name: '2 hours', timeStopMs: 2 * 60 * 60 * 1000, timeStopMinutes: 120 },
  { id: 'extended', name: '4 hours', timeStopMs: 4 * 60 * 60 * 1000, timeStopMinutes: 240 },
  { id: 'long', name: '8 hours', timeStopMs: 8 * 60 * 60 * 1000, timeStopMinutes: 480 },
  { id: 'daily', name: '24 hours', timeStopMs: 24 * 60 * 60 * 1000, timeStopMinutes: 1440 },
];

// ═══════════════════════════════════════════════════════════════════════════
// Trade Size Variants — Position Sizing
// ═══════════════════════════════════════════════════════════════════════════

export const TRADE_SIZE_VARIANTS: TradeSizeVariant[] = [
  { id: 'micro', name: '$2 Micro', tradeSizeUsdc: 2 },
  { id: 'small', name: '$5 Small', tradeSizeUsdc: 5 },
  { id: 'medium', name: '$10 Medium', tradeSizeUsdc: 10 },
  { id: 'standard', name: '$15 Standard', tradeSizeUsdc: 15 },
  { id: 'large', name: '$25 Large', tradeSizeUsdc: 25 },
];

// ═══════════════════════════════════════════════════════════════════════════
// Preset Exploration Variants (Combinations)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * OPTIMIZED exploration variants based on audit results.
 * 
 * Audit date: 2026-08-07
 * Results: Only 3 variants showed consistent profitability:
 *   - Balanced Large $25: 100% WR, +$85k PnL
 *   - Conservative 1h: 100% WR, +$30k PnL  
 *   - Scalp Medium 1h: 100% WR, +$11k PnL
 * 
 * REMOVED (all showed 0-31% WR and negative PnL):
 *   - Moon Bag 8h/24h (0% WR, always hit SL)
 *   - Balanced Micro $2 (0% WR, too small to capture moves)
 *   - Scalp Tight 30m (31% WR, stops too tight)
 *   - Swing variants (24-31% WR, time stops not effective)
 */
export const DEFAULT_EXPLORATION_VARIANTS: ExplorationVariant[] = [
  // === TOP PERFORMER: Balanced Large $25 ===
  // 100% WR, highest absolute PnL
  {
    id: 'balanced-large',
    name: 'Balanced Large $25',
    tpPct: 40,
    slPct: 15,
    timeStopMs: 2 * 60 * 60 * 1000,
    tradeSizeUsdc: 25,
    description: 'TOP PERFORMER: Balanced params, large size, 2h hold',
  },

  // === RUNNER UP: Conservative 1h ===
  // 100% WR, good capital preservation
  {
    id: 'conservative-1h',
    name: 'Conservative 1h',
    tpPct: 25,
    slPct: 8,
    timeStopMs: 60 * 60 * 1000,
    tradeSizeUsdc: 15,
    description: 'PROVEN: Conservative stops, 3:1 ratio, 1h hold',
  },

  // === THIRD: Scalp Medium 1h ===
  // 100% WR, good for quick captures
  {
    id: 'scalp-medium-1h',
    name: 'Scalp Medium 1h',
    tpPct: 20,
    slPct: 10,
    timeStopMs: 60 * 60 * 1000,
    tradeSizeUsdc: 10,
    description: 'PROVEN: Medium scalping, balanced stops, 1h hold',
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// Crypto Pairs to Monitor (beyond DexScreener micro-caps)
// ═══════════════════════════════════════════════════════════════════════════

export interface CryptoPair {
  id: string;
  name: string;
  baseToken: string;
  quoteToken: string;
  baseAddress: string;
  quoteAddress: string;
  poolAddress: string;
  feeTier: number;
  description: string;
  /** Decimals of quote token (USDC=6, WETH=18) */
  quoteDecimals: number;
  /** Decimals of base token */
  baseDecimals: number;
}

/**
 * Established pairs on Base to monitor alongside micro-cap discovery.
 * These have predictable liquidity and can validate strategy parameters.
 * 
 * NOTE: Only USDC-quoted pairs are enabled for now because PnL calculation
 * assumes USDC as the quote currency. WETH-quoted pairs require different
 * PnL conversion logic.
 */
export const BASE_ESTABLISHED_PAIRS: CryptoPair[] = [
  {
    id: 'weth-usdc',
    name: 'WETH/USDC',
    baseToken: 'WETH',
    quoteToken: 'USDC',
    baseAddress: '0x4200000000000000000000000000000000000006',
    quoteAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    poolAddress: '0xd0b53D9277642d899DF5C87A3966A349A798F224', // Uniswap V3 0.05%
    feeTier: 500,
    quoteDecimals: 6,
    baseDecimals: 18,
    description: 'Main ETH/USDC pair - high liquidity, lower volatility',
  },
  {
    id: 'dai-usdc',
    name: 'DAI/USDC',
    baseToken: 'DAI',
    quoteToken: 'USDC',
    baseAddress: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    quoteAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    poolAddress: '0x4e962BB3889Bf030368F56810A9c96B83CB3E778', // Uniswap V3 0.01%
    feeTier: 100,
    quoteDecimals: 6,
    baseDecimals: 18,
    description: 'Stablecoin pair - minimal volatility, test infrastructure',
  },
  // TODO: Enable WETH-quoted pairs after implementing proper PnL conversion
  // {
  //   id: 'cbeth-weth',
  //   name: 'cbETH/WETH',
  //   ...
  // },
  // {
  //   id: 'aero-weth',
  //   name: 'AERO/WETH',
  //   ...
  // },
];

// ═══════════════════════════════════════════════════════════════════════════
// Exploration Mode Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface ExplorationModeConfig {
  /** Enable multi-variant exploration */
  enabled: boolean;
  
  /** Which variants to run in parallel */
  variants: ExplorationVariant[];
  
  /** Enable established pair monitoring (alongside micro-caps) */
  monitorEstablishedPairs: boolean;
  
  /** Which established pairs to monitor */
  establishedPairs: CryptoPair[];
  
  /** Maximum open positions per variant */
  maxPositionsPerVariant: number;
  
  /** Maximum total open positions across all variants */
  maxTotalPositions: number;
  
  /** Report comparison metrics every N minutes */
  reportIntervalMinutes: number;
}

/**
 * Default exploration mode configuration for shadow/research mode.
 */
export const DEFAULT_EXPLORATION_CONFIG: ExplorationModeConfig = {
  enabled: true,
  variants: DEFAULT_EXPLORATION_VARIANTS,
  monitorEstablishedPairs: true,
  establishedPairs: BASE_ESTABLISHED_PAIRS,
  maxPositionsPerVariant: 5,
  maxTotalPositions: 50,
  reportIntervalMinutes: 60,
};

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate all possible variant combinations from the base grids.
 * Use sparingly - this can generate many variants!
 */
export function generateAllCombinations(
  tpSlVariants: TpSlVariant[] = TP_SL_VARIANTS.slice(0, 4),
  timeVariants: TimeStopVariant[] = TIME_STOP_VARIANTS.slice(0, 3),
  sizeVariants: TradeSizeVariant[] = TRADE_SIZE_VARIANTS.slice(0, 3),
): ExplorationVariant[] {
  const combinations: ExplorationVariant[] = [];
  
  for (const tpSl of tpSlVariants) {
    for (const time of timeVariants) {
      for (const size of sizeVariants) {
        combinations.push({
          id: `${tpSl.id}-${time.id}-${size.id}`,
          name: `${tpSl.name} / ${time.name} / ${size.name}`,
          tpPct: tpSl.tpPct,
          slPct: tpSl.slPct,
          timeStopMs: time.timeStopMs,
          tradeSizeUsdc: size.tradeSizeUsdc,
          description: `TP ${tpSl.tpPct}% SL ${tpSl.slPct}% | ${time.timeStopMinutes}m hold | $${size.tradeSizeUsdc}`,
        });
      }
    }
  }
  
  return combinations;
}

/**
 * Create a variant from individual parameters.
 */
export function createVariant(
  id: string,
  tpPct: number,
  slPct: number,
  timeStopMinutes: number,
  tradeSizeUsdc: number,
): ExplorationVariant {
  return {
    id,
    name: `Custom ${id}`,
    tpPct,
    slPct,
    timeStopMs: timeStopMinutes * 60 * 1000,
    tradeSizeUsdc,
    description: `TP ${tpPct}% SL ${slPct}% | ${timeStopMinutes}m hold | $${tradeSizeUsdc}`,
  };
}

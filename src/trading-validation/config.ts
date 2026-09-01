/**
 * Trading Validation Phase - Configuration Module
 *
 * Loads, validates, and hashes the complete trading system configuration.
 * All BigInt defaults stored as string constants and converted at load time.
 * Env vars override defaults; addresses validated for EIP-55 checksum.
 *
 * Requirements: 25.1 (config hash), 11.3 (parameter defaults), 35.1 (deterministic config)
 */

import { createHash } from 'node:crypto';
import { getAddress, isAddress } from 'ethers';
import type { TradingMode, UsdcAmount, EthAmount } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// String Constants for BigInt defaults (converted at load time)
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULTS = {
  // Bankroll (USDC 6 decimals)
  BANKROLL_TOTAL: '99630000',          // $99.63
  BANKROLL_ACTIVE: '25000000',         // $25.00
  BANKROLL_RESERVE: '74630000',        // $74.63
  BANKROLL_MIN_ACTIVE: '5000000',      // $5.00
  BANKROLL_SWEEP_THRESHOLD: '0.20',
  BANKROLL_SWEEP_MIN_EXCESS: '5000000', // $5.00
  BANKROLL_LOW_TOTAL: '80000000',      // $80.00

  // Risk (USDC 6 decimals) — TUNED for 5%+ monthly returns
  RISK_MAX_TRADE: '15000000',          // $15.00 (was $10) — larger trades for meaningful gains
  RISK_MAX_EXPOSURE: '35000000',       // $35.00 (was $25) — allow more capital at risk
  RISK_MAX_POSITIONS: '1',
  RISK_MAX_TRADES_DAY: '5',            // 5 trades/day (was 3) — more opportunities
  RISK_MAX_FAILED_TX_DAY: '3',
  RISK_MAX_DAILY_LOSS: '5000000',      // $5.00 (was $3) — accept higher daily loss
  RISK_MAX_EXPERIMENT_LOSS: '15000000', // $15.00 (was $10) — larger experiment budget

  // Gate
  GATE_MIN_NET_PROFIT: '80000',        // $0.08
  GATE_MIN_NET_PROFIT_BPS: '50',
  GATE_SAFETY_MARGIN_BPS: '20',
  GATE_MAX_QUOTE_AGE_MS: '10000',
  GATE_SANITY_MAX_PROFIT_PCT: '0.50',
  GATE_MAX_SLIPPAGE_BPS: '40',
  GATE_MAX_PRICE_IMPACT_BPS: '30',
  GATE_MIN_LIQUIDITY: '50000',
  GATE_DISCRETIONARY_MAX_GAS: '50000', // $0.05

  // Strategy — TUNED for 5%+ monthly returns (1.8 ATR Stop Loss with Dynamic Trailing Stop)
  STRATEGY_STOP_LOSS_ATR: '1.8',       // WIDENED to 1.8 ATR (gives volatile crypto room to breathe)
  STRATEGY_TAKE_PROFIT_ATR: '2.5',     // Wider take profit target
  STRATEGY_COOLDOWN_MS: '1800000',     // 30 min cooldown (was 20 min) — less frequent trading
  STRATEGY_WARMUP_1H: '100',           // Reduced warmup (was 300) — start trading sooner
  STRATEGY_WARMUP_15M: '200',          // Reduced warmup (was 500) — start trading sooner
  STRATEGY_MEAN_REV_ATR_MAX: '2.0',    // Reduced (was 2.5) — stricter volatility filter
  STRATEGY_MIN_LIQUIDITY: '30000',     // Lower liquidity threshold (was 50000)
  STRATEGY_VOLUME_Z_THRESHOLD: '0.5',  // Higher volume threshold (was 0.3) — need confirmation

  // Market Data — TUNED for 5%+ monthly returns (more conservative in volatile markets)
  MARKET_DATA_REST_POLLING_MS: '10000',
  MARKET_DATA_STALE_THRESHOLD_MS: '90000',
  MARKET_DATA_PRICE_MOVE_ATR_PCT: '0.35',  // Emit on 0.35 ATR moves (was 0.25) — less noise
  MARKET_DATA_VOLUME_Z_TRIGGER: '1.5',     // Higher volume threshold (was 1.2) — need real volume
  MARKET_DATA_MAX_EVAL_PER_HOUR: '30',     // 30 evals/hour (was 60) — more selective
  MARKET_DATA_DEBOUNCE_MS: '30000',        // 30s debounce (was 15s) — reduce overtrading

  // Quote Engine
  QUOTE_ENGINE_FEE_TIER: '500',        // 0.05%
  QUOTE_ENGINE_TTL_MS: '10000',
  QUOTE_ENGINE_BASIS_ALERT_BPS: '100',

  // Transaction Manager
  TX_MANAGER_TIMEOUT_MS: '300000',     // 5 min
  TX_MANAGER_MAX_FAILED_TX_DAY: '3',

  // Position Sizer (USDC 6 decimals)
  POSITION_SIZER_MAX_RISK: '500000',   // $0.50
  POSITION_SIZER_MAX_RISK_PCT: '0.005',
  POSITION_SIZER_MIN_TRADE: '5000000', // $5.00
  POSITION_SIZER_MAX_TRADE: '10000000', // $10.00
  POSITION_SIZER_MIN_STOP_FRACTION: '0.001',

  // Exit Manager
  EXIT_MAX_HOLDING_MS: '28800000',     // 8h
  EXIT_SAFETY_MAX_GAS: '100000',       // $0.10
  EXIT_MAX_RETRIES: '2',

  // Gas Reserve (ETH 18 decimals)
  GAS_MIN_RESERVE: '5000000000000000',  // 0.005 ETH
  GAS_CRITICAL_RESERVE: '2000000000000000', // 0.002 ETH
  GAS_CYCLES_REQUIRED: '2',

  // Reconciliation
  RECON_CONFIRMATION_BLOCKS: '1',
  RECON_MAX_RETRIES: '3',
  RECON_RETRY_BACKOFF_MS: '1000',
  RECON_MISMATCHES_FOR_KILL: '3',

  // Experiment
  EXPERIMENT_SHADOW_PASS_MIN: '10',
  EXPERIMENT_SHADOW_PASS_TARGET: '20',
  EXPERIMENT_SHADOW_PASS_DAYS: '7',
  EXPERIMENT_MICRO_PASS_MIN: '20',
  EXPERIMENT_MICRO_PROFIT_FACTOR: '1.2',
  EXPERIMENT_MICRO_MAX_DRAWDOWN: '10000000', // $10.00
  EXPERIMENT_MICRO_MAX_FAILED_RATE: '0.10',
  EXPERIMENT_MICRO_MAX_SLIPPAGE_DEV: '1.5',

  // AI Budget
  AI_GLOBAL_HARD_CAP: '0.20',
  AI_TRADING_BUDGET: '0.10',
  AI_SERVICES_BUDGET: '0.05',
  AI_RESEARCH_BUDGET: '0.00',
  AI_DIAGNOSTICS_BUDGET: '0.02',
  AI_SONNET_MIN_PROFIT: '150000',      // $0.15

  // Alerts
  ALERTS_NON_CRITICAL_MAX_HOUR: '10',
  ALERTS_DEVIATION_THRESHOLD_PCT: '0.50',
  ALERTS_DEVIATION_THRESHOLD_USDC: '30000', // $0.03
  ALERTS_CONSECUTIVE_DEVIATIONS: '3',

  // Contracts (Base mainnet, EIP-55 checksummed)
  CONTRACT_USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  CONTRACT_WETH: '0x4200000000000000000000000000000000000006',
  CONTRACT_SWAP_ROUTER: '0x2626664c2603336E57B271c5C0b26F421741e481',
  CONTRACT_QUOTER_V2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
  CONTRACT_AAVE_POOL: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  CONTRACT_AUSDC: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Interface
// ═══════════════════════════════════════════════════════════════════════════

export interface BankrollManagerConfig {
  initialTotal: UsdcAmount;
  initialActive: UsdcAmount;
  initialReserve: UsdcAmount;
  minActive: UsdcAmount;
  sweepThresholdPct: number;
  sweepMinExcess: UsdcAmount;
  lowTotalThreshold: UsdcAmount;
}

export interface RiskConfig {
  maxTradeUsdc: UsdcAmount;
  maxExposureUsdc: UsdcAmount;
  maxPositions: number;
  maxTradesDay: number;
  maxFailedTxDay: number;
  maxDailyLossUsdc: UsdcAmount;
  maxExperimentLoss: UsdcAmount;
}

export interface TradeGateConfig {
  minNetProfitUsdc: UsdcAmount;
  minNetProfitBps: number;
  safetyMarginBps: number;
  maxQuoteAgeMs: number;
  sanityMaxProfitPct: number;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  minLiquidity: number;
  discretionaryMaxGas: UsdcAmount;
  hasPrivateRpc: boolean;
}

export interface StrategyEngineConfig {
  pair: 'WETH/USDC';
  regimeTimeframe: '1h';
  entryTimeframe: '15m';
  stopLossAtr: number;
  takeProfitAtr: number;
  cooldownMs: number;
  warmup1h: number;
  warmup15m: number;
  meanRevAtrMax: number;
  minLiquidity: number;
  volumeZThreshold: number;
}

export interface MarketDataConfig {
  wsUrl: string;
  restUrl: string;
  restPollingMs: number;
  staleThresholdMs: number;
  priceMoveTriggerAtrPct: number;
  volumeZTrigger: number;
  maxEvalPerHour: number;
  debounceMs: number;
}

export interface QuoteEngineConfig {
  quoterV2Address: string;
  swapRouterAddress: string;
  usdcAddress: string;
  wethAddress: string;
  feeTier: number;
  quoteTtlMs: number;
  aggregatorRouter?: string;
  basisAlertBps: number;
}

export interface TransactionManagerConfig {
  walletAddress: string;
  timeoutMs: number;
  maxFailedTxDay: number;
  contractAllowlist: string[];
}

export interface PositionSizerConfig {
  maxRiskPerTrade: UsdcAmount;
  maxRiskPctBankroll: number;
  minTradeSize: UsdcAmount;
  maxTradeSize: UsdcAmount;
  minStopFraction: number;
}

export interface ExitManagerConfig {
  stopLossAtr: number;
  takeProfitAtr: number;
  maxHoldingMs: number;
  safetyExitMaxGas: UsdcAmount;
  maxExitRetries: number;
}

export interface GasReserveConfig {
  minReserveEth: EthAmount;
  criticalReserveEth: EthAmount;
  cyclesRequired: number;
}

export interface ReconciliationConfig {
  confirmationBlocks: number;
  maxRetries: number;
  retryBackoffMs: number;
  mismatchesForKillSwitch: number;
}

export interface ExperimentConfig {
  configHash: string;
  shadowPassMinTrades: number;
  shadowPassTargetTrades: number;
  shadowPassDays: number;
  microPassMinTrades: number;
  microPassProfitFactor: number;
  microPassMaxDrawdown: UsdcAmount;
  microPassMaxFailedRate: number;
  microPassMaxSlippageDev: number;
}

export interface AiBudgetConfig {
  globalHardCapDay: number;
  tradingBudgetDay: number;
  servicesBudgetDay: number;
  researchBudgetDay: number;
  diagnosticsBudgetDay: number;
  sonnetMinProfit: UsdcAmount;
}

export interface ContractsConfig {
  usdc: string;
  weth: string;
  swapRouter: string;
  quoterV2: string;
  aavePool: string;
  aUsdc: string;
  allowlist: string[];
}

export interface AlertsConfig {
  telegramChatId: string;
  nonCriticalMaxPerHour: number;
  deviationThresholdPct: number;
  deviationThresholdUsdc: UsdcAmount;
  consecutiveDeviationsForSafe: number;
}

export interface TradingValidationConfig {
  mode: TradingMode;
  configHash: string;
  bankroll: BankrollManagerConfig;
  risk: RiskConfig;
  gate: TradeGateConfig;
  strategy: StrategyEngineConfig;
  marketData: MarketDataConfig;
  quoteEngine: QuoteEngineConfig;
  txManager: TransactionManagerConfig;
  positionSizer: PositionSizerConfig;
  exitManager: ExitManagerConfig;
  gasReserve: GasReserveConfig;
  reconciliation: ReconciliationConfig;
  experiment: ExperimentConfig;
  aiBudget: AiBudgetConfig;
  contracts: ContractsConfig;
  alerts: AlertsConfig;
}

// ═══════════════════════════════════════════════════════════════════════════
// EIP-55 Checksum Validation (uses ethers keccak256)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Validates an Ethereum address against EIP-55 mixed-case checksum encoding.
 * Returns true if the address is a valid checksummed address.
 * Uses ethers.js getAddress() which throws on invalid checksum.
 */
export function isValidChecksumAddress(address: string): boolean {
  if (!isAddress(address)) {
    return false;
  }
  try {
    // getAddress returns the checksummed version — compare with input
    return getAddress(address) === address;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Loading
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Reads an env var with a fallback default.
 */
function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

/**
 * Loads the full TradingValidationConfig from environment variables with validated defaults.
 * All BigInt values are stored as string constants and converted at load time.
 */
export function loadConfig(): TradingValidationConfig {
  const contracts: ContractsConfig = {
    usdc: env('TRADING_CONTRACT_USDC', DEFAULTS.CONTRACT_USDC),
    weth: env('TRADING_CONTRACT_WETH', DEFAULTS.CONTRACT_WETH),
    swapRouter: env('TRADING_CONTRACT_SWAP_ROUTER', DEFAULTS.CONTRACT_SWAP_ROUTER),
    quoterV2: env('TRADING_CONTRACT_QUOTER_V2', DEFAULTS.CONTRACT_QUOTER_V2),
    aavePool: env('TRADING_CONTRACT_AAVE_POOL', DEFAULTS.CONTRACT_AAVE_POOL),
    aUsdc: env('TRADING_CONTRACT_AUSDC', DEFAULTS.CONTRACT_AUSDC),
    allowlist: buildAllowlist(
      env('TRADING_CONTRACT_USDC', DEFAULTS.CONTRACT_USDC),
      env('TRADING_CONTRACT_WETH', DEFAULTS.CONTRACT_WETH),
      env('TRADING_CONTRACT_SWAP_ROUTER', DEFAULTS.CONTRACT_SWAP_ROUTER),
      env('TRADING_CONTRACT_QUOTER_V2', DEFAULTS.CONTRACT_QUOTER_V2),
      env('TRADING_CONTRACT_AAVE_POOL', DEFAULTS.CONTRACT_AAVE_POOL),
      env('TRADING_CONTRACT_AUSDC', DEFAULTS.CONTRACT_AUSDC),
      env('TRADING_AGGREGATOR_ROUTER', ''),
    ),
  };

  const hasPrivateRpc = env('TRADING_HAS_PRIVATE_RPC', 'false') === 'true';

  const config: TradingValidationConfig = {
    mode: env('TRADING_MODE', 'shadow') as TradingMode,
    configHash: '', // computed after freeze

    bankroll: {
      initialTotal: BigInt(env('TRADING_BANKROLL_TOTAL', DEFAULTS.BANKROLL_TOTAL)),
      initialActive: BigInt(env('TRADING_BANKROLL_ACTIVE', DEFAULTS.BANKROLL_ACTIVE)),
      initialReserve: BigInt(env('TRADING_BANKROLL_RESERVE', DEFAULTS.BANKROLL_RESERVE)),
      minActive: BigInt(env('TRADING_BANKROLL_MIN_ACTIVE', DEFAULTS.BANKROLL_MIN_ACTIVE)),
      sweepThresholdPct: parseFloat(env('TRADING_BANKROLL_SWEEP_THRESHOLD', DEFAULTS.BANKROLL_SWEEP_THRESHOLD)),
      sweepMinExcess: BigInt(env('TRADING_BANKROLL_SWEEP_MIN_EXCESS', DEFAULTS.BANKROLL_SWEEP_MIN_EXCESS)),
      lowTotalThreshold: BigInt(env('TRADING_BANKROLL_LOW_TOTAL', DEFAULTS.BANKROLL_LOW_TOTAL)),
    },

    risk: {
      maxTradeUsdc: BigInt(env('TRADING_RISK_MAX_TRADE', DEFAULTS.RISK_MAX_TRADE)),
      maxExposureUsdc: BigInt(env('TRADING_RISK_MAX_EXPOSURE', DEFAULTS.RISK_MAX_EXPOSURE)),
      maxPositions: parseInt(env('TRADING_RISK_MAX_POSITIONS', DEFAULTS.RISK_MAX_POSITIONS), 10),
      maxTradesDay: parseInt(env('TRADING_RISK_MAX_TRADES_DAY', DEFAULTS.RISK_MAX_TRADES_DAY), 10),
      maxFailedTxDay: parseInt(env('TRADING_RISK_MAX_FAILED_TX_DAY', DEFAULTS.RISK_MAX_FAILED_TX_DAY), 10),
      maxDailyLossUsdc: BigInt(env('TRADING_RISK_MAX_DAILY_LOSS', DEFAULTS.RISK_MAX_DAILY_LOSS)),
      maxExperimentLoss: BigInt(env('TRADING_RISK_MAX_EXPERIMENT_LOSS', DEFAULTS.RISK_MAX_EXPERIMENT_LOSS)),
    },

    gate: {
      minNetProfitUsdc: BigInt(env('TRADING_GATE_MIN_NET_PROFIT', DEFAULTS.GATE_MIN_NET_PROFIT)),
      minNetProfitBps: parseInt(env('TRADING_GATE_MIN_NET_PROFIT_BPS', DEFAULTS.GATE_MIN_NET_PROFIT_BPS), 10),
      safetyMarginBps: parseInt(env('TRADING_GATE_SAFETY_MARGIN_BPS', DEFAULTS.GATE_SAFETY_MARGIN_BPS), 10),
      maxQuoteAgeMs: parseInt(env('TRADING_GATE_MAX_QUOTE_AGE_MS', DEFAULTS.GATE_MAX_QUOTE_AGE_MS), 10),
      sanityMaxProfitPct: parseFloat(env('TRADING_GATE_SANITY_MAX_PROFIT_PCT', DEFAULTS.GATE_SANITY_MAX_PROFIT_PCT)),
      maxSlippageBps: hasPrivateRpc
        ? parseInt(env('TRADING_GATE_MAX_SLIPPAGE_BPS', DEFAULTS.GATE_MAX_SLIPPAGE_BPS), 10)
        : 30,
      maxPriceImpactBps: hasPrivateRpc
        ? parseInt(env('TRADING_GATE_MAX_PRICE_IMPACT_BPS', DEFAULTS.GATE_MAX_PRICE_IMPACT_BPS), 10)
        : 20,
      minLiquidity: parseInt(env('TRADING_GATE_MIN_LIQUIDITY', DEFAULTS.GATE_MIN_LIQUIDITY), 10),
      discretionaryMaxGas: BigInt(env('TRADING_GATE_DISCRETIONARY_MAX_GAS', DEFAULTS.GATE_DISCRETIONARY_MAX_GAS)),
      hasPrivateRpc,
    },

    strategy: {
      pair: 'WETH/USDC',
      regimeTimeframe: '1h',
      entryTimeframe: '15m',
      stopLossAtr: parseFloat(env('TRADING_STRATEGY_STOP_LOSS_ATR', DEFAULTS.STRATEGY_STOP_LOSS_ATR)),
      takeProfitAtr: parseFloat(env('TRADING_STRATEGY_TAKE_PROFIT_ATR', DEFAULTS.STRATEGY_TAKE_PROFIT_ATR)),
      cooldownMs: parseInt(env('TRADING_STRATEGY_COOLDOWN_MS', DEFAULTS.STRATEGY_COOLDOWN_MS), 10),
      warmup1h: parseInt(env('TRADING_STRATEGY_WARMUP_1H', DEFAULTS.STRATEGY_WARMUP_1H), 10),
      warmup15m: parseInt(env('TRADING_STRATEGY_WARMUP_15M', DEFAULTS.STRATEGY_WARMUP_15M), 10),
      meanRevAtrMax: parseFloat(env('TRADING_STRATEGY_MEAN_REV_ATR_MAX', DEFAULTS.STRATEGY_MEAN_REV_ATR_MAX)),
      minLiquidity: parseInt(env('TRADING_STRATEGY_MIN_LIQUIDITY', DEFAULTS.STRATEGY_MIN_LIQUIDITY), 10),
      volumeZThreshold: parseFloat(env('TRADING_STRATEGY_VOLUME_Z_THRESHOLD', DEFAULTS.STRATEGY_VOLUME_Z_THRESHOLD)),
    },

    marketData: {
      wsUrl: env('TRADING_MARKET_DATA_WS_URL', 'wss://stream.binance.com:9443/ws'),
      restUrl: env('TRADING_MARKET_DATA_REST_URL', 'https://api.binance.com/api/v3'),
      restPollingMs: parseInt(env('TRADING_MARKET_DATA_REST_POLLING_MS', DEFAULTS.MARKET_DATA_REST_POLLING_MS), 10),
      staleThresholdMs: parseInt(env('TRADING_MARKET_DATA_STALE_THRESHOLD_MS', DEFAULTS.MARKET_DATA_STALE_THRESHOLD_MS), 10),
      priceMoveTriggerAtrPct: parseFloat(env('TRADING_MARKET_DATA_PRICE_MOVE_ATR_PCT', DEFAULTS.MARKET_DATA_PRICE_MOVE_ATR_PCT)),
      volumeZTrigger: parseFloat(env('TRADING_MARKET_DATA_VOLUME_Z_TRIGGER', DEFAULTS.MARKET_DATA_VOLUME_Z_TRIGGER)),
      maxEvalPerHour: parseInt(env('TRADING_MARKET_DATA_MAX_EVAL_PER_HOUR', DEFAULTS.MARKET_DATA_MAX_EVAL_PER_HOUR), 10),
      debounceMs: parseInt(env('TRADING_MARKET_DATA_DEBOUNCE_MS', DEFAULTS.MARKET_DATA_DEBOUNCE_MS), 10),
    },

    quoteEngine: {
      quoterV2Address: contracts.quoterV2,
      swapRouterAddress: contracts.swapRouter,
      usdcAddress: contracts.usdc,
      wethAddress: contracts.weth,
      feeTier: parseInt(env('TRADING_QUOTE_ENGINE_FEE_TIER', DEFAULTS.QUOTE_ENGINE_FEE_TIER), 10),
      quoteTtlMs: parseInt(env('TRADING_QUOTE_ENGINE_TTL_MS', DEFAULTS.QUOTE_ENGINE_TTL_MS), 10),
      aggregatorRouter: env('TRADING_AGGREGATOR_ROUTER', '') || undefined,
      basisAlertBps: parseInt(env('TRADING_QUOTE_ENGINE_BASIS_ALERT_BPS', DEFAULTS.QUOTE_ENGINE_BASIS_ALERT_BPS), 10),
    },

    txManager: {
      walletAddress: env('TRADING_WALLET_ADDRESS', ''),
      timeoutMs: parseInt(env('TRADING_TX_MANAGER_TIMEOUT_MS', DEFAULTS.TX_MANAGER_TIMEOUT_MS), 10),
      maxFailedTxDay: parseInt(env('TRADING_TX_MANAGER_MAX_FAILED_TX_DAY', DEFAULTS.TX_MANAGER_MAX_FAILED_TX_DAY), 10),
      contractAllowlist: contracts.allowlist,
    },

    positionSizer: {
      maxRiskPerTrade: BigInt(env('TRADING_POSITION_SIZER_MAX_RISK', DEFAULTS.POSITION_SIZER_MAX_RISK)),
      maxRiskPctBankroll: parseFloat(env('TRADING_POSITION_SIZER_MAX_RISK_PCT', DEFAULTS.POSITION_SIZER_MAX_RISK_PCT)),
      minTradeSize: BigInt(env('TRADING_POSITION_SIZER_MIN_TRADE', DEFAULTS.POSITION_SIZER_MIN_TRADE)),
      maxTradeSize: BigInt(env('TRADING_POSITION_SIZER_MAX_TRADE', DEFAULTS.POSITION_SIZER_MAX_TRADE)),
      minStopFraction: parseFloat(env('TRADING_POSITION_SIZER_MIN_STOP_FRACTION', DEFAULTS.POSITION_SIZER_MIN_STOP_FRACTION)),
    },

    exitManager: {
      stopLossAtr: parseFloat(env('TRADING_EXIT_STOP_LOSS_ATR', DEFAULTS.STRATEGY_STOP_LOSS_ATR)),
      takeProfitAtr: parseFloat(env('TRADING_EXIT_TAKE_PROFIT_ATR', DEFAULTS.STRATEGY_TAKE_PROFIT_ATR)),
      maxHoldingMs: parseInt(env('TRADING_EXIT_MAX_HOLDING_MS', DEFAULTS.EXIT_MAX_HOLDING_MS), 10),
      safetyExitMaxGas: BigInt(env('TRADING_EXIT_SAFETY_MAX_GAS', DEFAULTS.EXIT_SAFETY_MAX_GAS)),
      maxExitRetries: parseInt(env('TRADING_EXIT_MAX_RETRIES', DEFAULTS.EXIT_MAX_RETRIES), 10),
    },

    gasReserve: {
      minReserveEth: BigInt(env('TRADING_GAS_MIN_RESERVE', DEFAULTS.GAS_MIN_RESERVE)),
      criticalReserveEth: BigInt(env('TRADING_GAS_CRITICAL_RESERVE', DEFAULTS.GAS_CRITICAL_RESERVE)),
      cyclesRequired: parseInt(env('TRADING_GAS_CYCLES_REQUIRED', DEFAULTS.GAS_CYCLES_REQUIRED), 10),
    },

    reconciliation: {
      confirmationBlocks: parseInt(env('TRADING_RECON_CONFIRMATION_BLOCKS', DEFAULTS.RECON_CONFIRMATION_BLOCKS), 10),
      maxRetries: parseInt(env('TRADING_RECON_MAX_RETRIES', DEFAULTS.RECON_MAX_RETRIES), 10),
      retryBackoffMs: parseInt(env('TRADING_RECON_RETRY_BACKOFF_MS', DEFAULTS.RECON_RETRY_BACKOFF_MS), 10),
      mismatchesForKillSwitch: parseInt(env('TRADING_RECON_MISMATCHES_FOR_KILL', DEFAULTS.RECON_MISMATCHES_FOR_KILL), 10),
    },

    experiment: {
      configHash: '', // set after computation
      shadowPassMinTrades: parseInt(env('TRADING_EXPERIMENT_SHADOW_PASS_MIN', DEFAULTS.EXPERIMENT_SHADOW_PASS_MIN), 10),
      shadowPassTargetTrades: parseInt(env('TRADING_EXPERIMENT_SHADOW_PASS_TARGET', DEFAULTS.EXPERIMENT_SHADOW_PASS_TARGET), 10),
      shadowPassDays: parseInt(env('TRADING_EXPERIMENT_SHADOW_PASS_DAYS', DEFAULTS.EXPERIMENT_SHADOW_PASS_DAYS), 10),
      microPassMinTrades: parseInt(env('TRADING_EXPERIMENT_MICRO_PASS_MIN', DEFAULTS.EXPERIMENT_MICRO_PASS_MIN), 10),
      microPassProfitFactor: parseFloat(env('TRADING_EXPERIMENT_MICRO_PROFIT_FACTOR', DEFAULTS.EXPERIMENT_MICRO_PROFIT_FACTOR)),
      microPassMaxDrawdown: BigInt(env('TRADING_EXPERIMENT_MICRO_MAX_DRAWDOWN', DEFAULTS.EXPERIMENT_MICRO_MAX_DRAWDOWN)),
      microPassMaxFailedRate: parseFloat(env('TRADING_EXPERIMENT_MICRO_MAX_FAILED_RATE', DEFAULTS.EXPERIMENT_MICRO_MAX_FAILED_RATE)),
      microPassMaxSlippageDev: parseFloat(env('TRADING_EXPERIMENT_MICRO_MAX_SLIPPAGE_DEV', DEFAULTS.EXPERIMENT_MICRO_MAX_SLIPPAGE_DEV)),
    },

    aiBudget: {
      globalHardCapDay: parseFloat(env('TRADING_AI_GLOBAL_HARD_CAP', DEFAULTS.AI_GLOBAL_HARD_CAP)),
      tradingBudgetDay: parseFloat(env('TRADING_AI_TRADING_BUDGET', DEFAULTS.AI_TRADING_BUDGET)),
      servicesBudgetDay: parseFloat(env('TRADING_AI_SERVICES_BUDGET', DEFAULTS.AI_SERVICES_BUDGET)),
      researchBudgetDay: parseFloat(env('TRADING_AI_RESEARCH_BUDGET', DEFAULTS.AI_RESEARCH_BUDGET)),
      diagnosticsBudgetDay: parseFloat(env('TRADING_AI_DIAGNOSTICS_BUDGET', DEFAULTS.AI_DIAGNOSTICS_BUDGET)),
      sonnetMinProfit: BigInt(env('TRADING_AI_SONNET_MIN_PROFIT', DEFAULTS.AI_SONNET_MIN_PROFIT)),
    },

    contracts,

    alerts: {
      telegramChatId: env('TRADING_ALERTS_TELEGRAM_CHAT_ID', ''),
      nonCriticalMaxPerHour: parseInt(env('TRADING_ALERTS_NON_CRITICAL_MAX_HOUR', DEFAULTS.ALERTS_NON_CRITICAL_MAX_HOUR), 10),
      deviationThresholdPct: parseFloat(env('TRADING_ALERTS_DEVIATION_THRESHOLD_PCT', DEFAULTS.ALERTS_DEVIATION_THRESHOLD_PCT)),
      deviationThresholdUsdc: BigInt(env('TRADING_ALERTS_DEVIATION_THRESHOLD_USDC', DEFAULTS.ALERTS_DEVIATION_THRESHOLD_USDC)),
      consecutiveDeviationsForSafe: parseInt(env('TRADING_ALERTS_CONSECUTIVE_DEVIATIONS', DEFAULTS.ALERTS_CONSECUTIVE_DEVIATIONS), 10),
    },
  };

  // Compute config hash and set it
  const hash = computeConfigHash(config);
  config.configHash = hash;
  config.experiment.configHash = hash;

  return config;
}

// ═══════════════════════════════════════════════════════════════════════════
// Config Hash (SHA-256 of frozen parameter set)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Serializes a config value to a deterministic string representation.
 * BigInt values are serialized as their string form.
 */
function serializeForHash(value: unknown): string {
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (value === null || value === undefined) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return '[' + value.map(serializeForHash).join(',') + ']';
  }
  if (typeof value === 'object') {
    const sorted = Object.keys(value as Record<string, unknown>).sort();
    const entries = sorted.map(
      (k) => `${JSON.stringify(k)}:${serializeForHash((value as Record<string, unknown>)[k])}`
    );
    return '{' + entries.join(',') + '}';
  }
  return JSON.stringify(value);
}

/**
 * Computes SHA-256 hash of the frozen configuration parameter set.
 * Used for experiment reproducibility — config hash change invalidates experiments.
 *
 * Requirements: 25.1
 */
export function computeConfigHash(config: TradingValidationConfig): string {
  // Create a copy without the hash fields themselves (to avoid circular reference)
  const hashable = {
    mode: config.mode,
    bankroll: config.bankroll,
    risk: config.risk,
    gate: config.gate,
    strategy: config.strategy,
    marketData: config.marketData,
    quoteEngine: config.quoteEngine,
    txManager: config.txManager,
    positionSizer: config.positionSizer,
    exitManager: config.exitManager,
    gasReserve: config.gasReserve,
    reconciliation: config.reconciliation,
    experiment: {
      shadowPassMinTrades: config.experiment.shadowPassMinTrades,
      shadowPassTargetTrades: config.experiment.shadowPassTargetTrades,
      shadowPassDays: config.experiment.shadowPassDays,
      microPassMinTrades: config.experiment.microPassMinTrades,
      microPassProfitFactor: config.experiment.microPassProfitFactor,
      microPassMaxDrawdown: config.experiment.microPassMaxDrawdown,
      microPassMaxFailedRate: config.experiment.microPassMaxFailedRate,
      microPassMaxSlippageDev: config.experiment.microPassMaxSlippageDev,
    },
    aiBudget: config.aiBudget,
    contracts: config.contracts,
    alerts: {
      nonCriticalMaxPerHour: config.alerts.nonCriticalMaxPerHour,
      deviationThresholdPct: config.alerts.deviationThresholdPct,
      deviationThresholdUsdc: config.alerts.deviationThresholdUsdc,
      consecutiveDeviationsForSafe: config.alerts.consecutiveDeviationsForSafe,
    },
  };

  const serialized = serializeForHash(hashable);
  return createHash('sha256').update(serialized).digest('hex');
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration Validation
// ═══════════════════════════════════════════════════════════════════════════

export interface ConfigValidationError {
  field: string;
  message: string;
}

/**
 * Validates the loaded configuration at runtime.
 * Checks types, ranges, and EIP-55 checksum for all contract addresses.
 *
 * Requirements: 35.1
 */
export function validateConfig(config: TradingValidationConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  // Mode validation
  if (config.mode !== 'shadow' && config.mode !== 'micro') {
    errors.push({ field: 'mode', message: `Invalid mode: ${config.mode}. Must be 'shadow' or 'micro'.` });
  }

  // Contract address checksum validation (EIP-55)
  const addressFields: [string, string][] = [
    ['contracts.usdc', config.contracts.usdc],
    ['contracts.weth', config.contracts.weth],
    ['contracts.swapRouter', config.contracts.swapRouter],
    ['contracts.quoterV2', config.contracts.quoterV2],
    ['contracts.aavePool', config.contracts.aavePool],
    ['contracts.aUsdc', config.contracts.aUsdc],
  ];

  for (const [field, address] of addressFields) {
    if (!address) {
      errors.push({ field, message: 'Address is empty' });
    } else if (!isValidChecksumAddress(address)) {
      errors.push({ field, message: `Invalid EIP-55 checksum: ${address}` });
    }
  }

  // Allowlist address validation
  for (let i = 0; i < config.contracts.allowlist.length; i++) {
    const addr = config.contracts.allowlist[i];
    if (!isValidChecksumAddress(addr)) {
      errors.push({ field: `contracts.allowlist[${i}]`, message: `Invalid EIP-55 checksum: ${addr}` });
    }
  }

  // Bankroll validation
  if (config.bankroll.initialTotal <= 0n) {
    errors.push({ field: 'bankroll.initialTotal', message: 'Must be positive' });
  }
  if (config.bankroll.initialActive <= 0n) {
    errors.push({ field: 'bankroll.initialActive', message: 'Must be positive' });
  }
  if (config.bankroll.initialActive > config.bankroll.initialTotal) {
    errors.push({ field: 'bankroll.initialActive', message: 'Active cannot exceed total' });
  }
  if (config.bankroll.minActive <= 0n) {
    errors.push({ field: 'bankroll.minActive', message: 'Must be positive' });
  }
  if (config.bankroll.sweepThresholdPct <= 0 || config.bankroll.sweepThresholdPct >= 1) {
    errors.push({ field: 'bankroll.sweepThresholdPct', message: 'Must be between 0 and 1 exclusive' });
  }

  // Risk validation
  if (config.risk.maxTradeUsdc <= 0n) {
    errors.push({ field: 'risk.maxTradeUsdc', message: 'Must be positive' });
  }
  if (config.risk.maxPositions < 1) {
    errors.push({ field: 'risk.maxPositions', message: 'Must be at least 1' });
  }
  if (config.risk.maxTradesDay < 1) {
    errors.push({ field: 'risk.maxTradesDay', message: 'Must be at least 1' });
  }
  if (config.risk.maxDailyLossUsdc <= 0n) {
    errors.push({ field: 'risk.maxDailyLossUsdc', message: 'Must be positive' });
  }

  // Gate validation
  if (config.gate.minNetProfitBps <= 0) {
    errors.push({ field: 'gate.minNetProfitBps', message: 'Must be positive' });
  }
  if (config.gate.maxQuoteAgeMs <= 0) {
    errors.push({ field: 'gate.maxQuoteAgeMs', message: 'Must be positive' });
  }
  if (config.gate.maxSlippageBps <= 0) {
    errors.push({ field: 'gate.maxSlippageBps', message: 'Must be positive' });
  }
  if (config.gate.maxPriceImpactBps <= 0) {
    errors.push({ field: 'gate.maxPriceImpactBps', message: 'Must be positive' });
  }

  // Strategy validation
  if (config.strategy.stopLossAtr <= 0) {
    errors.push({ field: 'strategy.stopLossAtr', message: 'Must be positive' });
  }
  if (config.strategy.takeProfitAtr <= 0) {
    errors.push({ field: 'strategy.takeProfitAtr', message: 'Must be positive' });
  }
  if (config.strategy.cooldownMs < 0) {
    errors.push({ field: 'strategy.cooldownMs', message: 'Must be non-negative' });
  }

  // Position sizer validation
  if (config.positionSizer.minTradeSize >= config.positionSizer.maxTradeSize) {
    errors.push({ field: 'positionSizer.minTradeSize', message: 'Min trade size must be less than max' });
  }
  if (config.positionSizer.minStopFraction <= 0) {
    errors.push({ field: 'positionSizer.minStopFraction', message: 'Must be positive' });
  }

  // Gas reserve validation
  if (config.gasReserve.criticalReserveEth >= config.gasReserve.minReserveEth) {
    errors.push({ field: 'gasReserve.criticalReserveEth', message: 'Critical must be less than min reserve' });
  }

  // Reconciliation validation
  if (config.reconciliation.confirmationBlocks < 1) {
    errors.push({ field: 'reconciliation.confirmationBlocks', message: 'Must be at least 1' });
  }

  // Exit manager validation
  if (config.exitManager.maxHoldingMs <= 0) {
    errors.push({ field: 'exitManager.maxHoldingMs', message: 'Must be positive' });
  }

  // Transaction manager validation
  if (!config.txManager.walletAddress && config.mode === 'micro') {
    errors.push({ field: 'txManager.walletAddress', message: 'Wallet address required for micro mode' });
  }

  // AI budget validation
  if (config.aiBudget.globalHardCapDay < 0) {
    errors.push({ field: 'aiBudget.globalHardCapDay', message: 'Must be non-negative' });
  }
  if (config.aiBudget.tradingBudgetDay > config.aiBudget.globalHardCapDay) {
    errors.push({ field: 'aiBudget.tradingBudgetDay', message: 'Trading budget cannot exceed global cap' });
  }

  return errors;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds the contract allowlist from known addresses + optional aggregator.
 */
function buildAllowlist(...addresses: string[]): string[] {
  return addresses.filter((addr) => addr.length > 0);
}

/**
 * Copy-Trading Configuration Module
 *
 * Loads and validates configuration from environment variables with sensible defaults.
 * All COPY_* prefixed env vars are parsed here.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13
 */

import { createLogger } from '../../logger.js';

const log = createLogger('copy-trading-config');

// ---------------------------------------------------------------------------
// Configuration Interface
// ---------------------------------------------------------------------------

/**
 * Copy-Trading configuration interface.
 * All fields are required with validated defaults.
 */
export interface CopyTradingConfig {
  // ─── Capital & Sizing ───────────────────────────────────────────────────
  /** Initial capital in USDC (Req 10.1) */
  initialCapitalUsdc: number;
  /** Maximum position size in USDC (Req 10.2) */
  maxPositionUsdc: number;
  /** Copy ratio - percentage of insider trade to copy (Req 10.3) */
  copyRatio: number;

  // ─── Exit Parameters ────────────────────────────────────────────────────
  /** Take profit percentage (Req 10.4) */
  takeProfitPct: number;
  /** Stop loss percentage (Req 10.5) */
  stopLossPct: number;
  /** Trailing stop activation percentage (Req 10.6) */
  trailActivationPct: number;
  /** Trailing stop distance percentage (Req 10.7) */
  trailDistancePct: number;
  /** Time stop in hours (Req 10.8) */
  timeStopHours: number;

  // ─── Risk Management ────────────────────────────────────────────────────
  /** Maximum loss streak before circuit breaker (Req 10.11) */
  maxLossStreak: number;
  /** Maximum gas price in gwei (Req 10.9) */
  maxGasGwei: number;
  /** Maximum concurrent open positions */
  maxConcurrentPositions: number;
  /** Maximum daily capital deployment percentage */
  maxDailyCapitalPct: number;
  /** Circuit breaker duration in hours */
  circuitBreakerHours: number;
  /** Maximum drawdown percentage before force close */
  maxDrawdownPct: number;
  /** Minimum reserve percentage (never deploy more than 100% - this) */
  minReservePct: number;

  // ─── RPC & Connectivity ─────────────────────────────────────────────────
  /** WebSocket RPC URL (Req 10.10) */
  wsRpcUrl: string;
  /** HTTP RPC URL fallback */
  httpRpcUrl: string | null;
  /** Polling interval in milliseconds */
  pollingIntervalMs: number;
  /** Heartbeat interval in milliseconds */
  heartbeatIntervalMs: number;
  /** Reconnect timeout in milliseconds */
  reconnectTimeoutMs: number;

  // ─── Validation Thresholds ──────────────────────────────────────────────
  /** Minimum pool liquidity in USDC */
  minLiquidityUsdc: number;
  /** Minimum pool liquidity in WETH */
  minLiquidityWeth: number;
  /** Maximum acceptable slippage percentage */
  maxSlippagePct: number;
  /** Maximum acceptable transfer tax percentage */
  maxTaxPct: number;
  /** Minimum LP lock percentage */
  minLpLockPct: number;

  // ─── Anti-Baiting ───────────────────────────────────────────────────────
  /** Maximum volume footprint percentage */
  maxVolumeFootprintPct: number;
  /** Minimum execution delay in milliseconds */
  executionDelayMinMs: number;
  /** Maximum execution delay in milliseconds */
  executionDelayMaxMs: number;
  /** Maximum bait flags before wallet removal */
  maxBaitFlags: number;
  /** Bait flag window in days */
  baitFlagWindowDays: number;

  // ─── Security ───────────────────────────────────────────────────────────
  /** API key for authenticating mutating endpoints (POST, DELETE) - Req 9.10 */
  apiKey: string | null;
}

// ---------------------------------------------------------------------------
// Default Values
// ---------------------------------------------------------------------------

const DEFAULTS = {
  // Capital & Sizing
  COPY_INITIAL_CAPITAL_USDC: 500,
  COPY_MAX_POSITION_USDC: 100,
  COPY_RATIO: 0.1, // 10%

  // Exit Parameters
  COPY_TP_PCT: 50,
  COPY_SL_PCT: 20,
  COPY_TRAIL_ACTIVATION_PCT: 10,
  COPY_TRAIL_DISTANCE_PCT: 10,
  COPY_TIME_STOP_HOURS: 48,

  // Risk Management
  COPY_MAX_LOSS_STREAK: 3,
  COPY_MAX_GAS_GWEI: 50,
  COPY_MAX_CONCURRENT_POSITIONS: 3,
  COPY_MAX_DAILY_CAPITAL_PCT: 20,
  COPY_CIRCUIT_BREAKER_HOURS: 24,
  COPY_MAX_DRAWDOWN_PCT: 25,
  COPY_MIN_RESERVE_PCT: 20,

  // RPC & Connectivity
  COPY_POLLING_INTERVAL_MS: 2000,
  COPY_HEARTBEAT_INTERVAL_MS: 30000,
  COPY_RECONNECT_TIMEOUT_MS: 10000,

  // Validation Thresholds
  COPY_MIN_LIQUIDITY_USDC: 10000,
  COPY_MIN_LIQUIDITY_WETH: 2.0,
  COPY_MAX_SLIPPAGE_PCT: 5,
  COPY_MAX_TAX_PCT: 5,
  COPY_MIN_LP_LOCK_PCT: 50,

  // Anti-Baiting
  COPY_MAX_VOLUME_FOOTPRINT_PCT: 5,
  COPY_EXECUTION_DELAY_MIN_MS: 5000,
  COPY_EXECUTION_DELAY_MAX_MS: 30000,
  COPY_MAX_BAIT_FLAGS: 3,
  COPY_BAIT_FLAG_WINDOW_DAYS: 7,

  // Security
  COPY_API_KEY: null as string | null,
} as const;

// ---------------------------------------------------------------------------
// Parsing Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a numeric environment variable with default.
 * Returns default if value is undefined, empty, or not a valid number.
 */
function parseNumber(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  if (Number.isNaN(parsed)) {
    log.warn(`Invalid numeric value for ${name}: "${value}", using default ${defaultValue}`);
    return defaultValue;
  }

  return parsed;
}

/**
 * Parse a positive number, returning default if ≤ 0.
 */
function parsePositiveNumber(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const parsed = parseNumber(value, defaultValue, name);
  if (parsed <= 0) {
    log.warn(`${name} must be positive (got ${parsed}), using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a percentage (0-100), clamping to valid range.
 */
function parsePercentage(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const parsed = parseNumber(value, defaultValue, name);
  if (parsed < 0 || parsed > 100) {
    log.warn(`${name} must be 0-100 (got ${parsed}), using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a ratio (0-1), allowing values like 0.10 for 10%.
 */
function parseRatio(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const parsed = parseNumber(value, defaultValue, name);
  if (parsed < 0 || parsed > 1) {
    log.warn(`${name} must be 0-1 (got ${parsed}), using default ${defaultValue}`);
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse an integer, returning default if not a valid integer.
 */
function parseInteger(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  const parsed = parseNumber(value, defaultValue, name);
  if (!Number.isInteger(parsed)) {
    const rounded = Math.round(parsed);
    log.warn(`${name} must be an integer (got ${parsed}), rounding to ${rounded}`);
    return rounded;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Configuration Loader
// ---------------------------------------------------------------------------

/**
 * Load Copy-Trading configuration from environment variables.
 *
 * Reads COPY_* prefixed env vars and applies sensible defaults per Requirement 10.
 * For RPC URLs, falls back to RPC_PROVIDER_URL if COPY_WS_RPC_URL is not set.
 *
 * The function is pure - it receives env as parameter to facilitate testing.
 *
 * @param env - Environment variables object (defaults to process.env)
 * @returns Validated CopyTradingConfig
 * @throws Error if critical configuration is missing (wsRpcUrl)
 *
 * @example
 * ```ts
 * // Load from process.env
 * const config = loadCopyTradingConfig();
 *
 * // Load from custom env (for testing)
 * const config = loadCopyTradingConfig({ COPY_INITIAL_CAPITAL_USDC: '1000' });
 * ```
 */
export function loadCopyTradingConfig(
  env: Record<string, string | undefined> = process.env,
): CopyTradingConfig {
  // ─── RPC URLs (with fallback) ───────────────────────────────────────────
  // COPY_WS_RPC_URL falls back to RPC_PROVIDER_URL if not set
  const wsRpcUrl = env['COPY_WS_RPC_URL'] ?? env['RPC_PROVIDER_URL'];
  if (!wsRpcUrl) {
    throw new Error(
      '[CopyTradingConfig] COPY_WS_RPC_URL or RPC_PROVIDER_URL is required',
    );
  }

  const httpRpcUrl = env['COPY_HTTP_RPC_URL'] ?? null;

  // ─── Build configuration ────────────────────────────────────────────────
  const config: CopyTradingConfig = {
    // Capital & Sizing
    initialCapitalUsdc: parsePositiveNumber(
      env['COPY_INITIAL_CAPITAL_USDC'],
      DEFAULTS.COPY_INITIAL_CAPITAL_USDC,
      'COPY_INITIAL_CAPITAL_USDC',
    ),
    maxPositionUsdc: parsePositiveNumber(
      env['COPY_MAX_POSITION_USDC'],
      DEFAULTS.COPY_MAX_POSITION_USDC,
      'COPY_MAX_POSITION_USDC',
    ),
    copyRatio: parseRatio(
      env['COPY_RATIO'],
      DEFAULTS.COPY_RATIO,
      'COPY_RATIO',
    ),

    // Exit Parameters
    takeProfitPct: parsePercentage(
      env['COPY_TP_PCT'],
      DEFAULTS.COPY_TP_PCT,
      'COPY_TP_PCT',
    ),
    stopLossPct: parsePercentage(
      env['COPY_SL_PCT'],
      DEFAULTS.COPY_SL_PCT,
      'COPY_SL_PCT',
    ),
    trailActivationPct: parsePercentage(
      env['COPY_TRAIL_ACTIVATION_PCT'],
      DEFAULTS.COPY_TRAIL_ACTIVATION_PCT,
      'COPY_TRAIL_ACTIVATION_PCT',
    ),
    trailDistancePct: parsePercentage(
      env['COPY_TRAIL_DISTANCE_PCT'],
      DEFAULTS.COPY_TRAIL_DISTANCE_PCT,
      'COPY_TRAIL_DISTANCE_PCT',
    ),
    timeStopHours: parsePositiveNumber(
      env['COPY_TIME_STOP_HOURS'],
      DEFAULTS.COPY_TIME_STOP_HOURS,
      'COPY_TIME_STOP_HOURS',
    ),

    // Risk Management
    maxLossStreak: parseInteger(
      env['COPY_MAX_LOSS_STREAK'],
      DEFAULTS.COPY_MAX_LOSS_STREAK,
      'COPY_MAX_LOSS_STREAK',
    ),
    maxGasGwei: parsePositiveNumber(
      env['COPY_MAX_GAS_GWEI'],
      DEFAULTS.COPY_MAX_GAS_GWEI,
      'COPY_MAX_GAS_GWEI',
    ),
    maxConcurrentPositions: parseInteger(
      env['COPY_MAX_CONCURRENT_POSITIONS'],
      DEFAULTS.COPY_MAX_CONCURRENT_POSITIONS,
      'COPY_MAX_CONCURRENT_POSITIONS',
    ),
    maxDailyCapitalPct: parsePercentage(
      env['COPY_MAX_DAILY_CAPITAL_PCT'],
      DEFAULTS.COPY_MAX_DAILY_CAPITAL_PCT,
      'COPY_MAX_DAILY_CAPITAL_PCT',
    ),
    circuitBreakerHours: parsePositiveNumber(
      env['COPY_CIRCUIT_BREAKER_HOURS'],
      DEFAULTS.COPY_CIRCUIT_BREAKER_HOURS,
      'COPY_CIRCUIT_BREAKER_HOURS',
    ),
    maxDrawdownPct: parsePercentage(
      env['COPY_MAX_DRAWDOWN_PCT'],
      DEFAULTS.COPY_MAX_DRAWDOWN_PCT,
      'COPY_MAX_DRAWDOWN_PCT',
    ),
    minReservePct: parsePercentage(
      env['COPY_MIN_RESERVE_PCT'],
      DEFAULTS.COPY_MIN_RESERVE_PCT,
      'COPY_MIN_RESERVE_PCT',
    ),

    // RPC & Connectivity
    wsRpcUrl,
    httpRpcUrl,
    pollingIntervalMs: parsePositiveNumber(
      env['COPY_POLLING_INTERVAL_MS'],
      DEFAULTS.COPY_POLLING_INTERVAL_MS,
      'COPY_POLLING_INTERVAL_MS',
    ),
    heartbeatIntervalMs: parsePositiveNumber(
      env['COPY_HEARTBEAT_INTERVAL_MS'],
      DEFAULTS.COPY_HEARTBEAT_INTERVAL_MS,
      'COPY_HEARTBEAT_INTERVAL_MS',
    ),
    reconnectTimeoutMs: parsePositiveNumber(
      env['COPY_RECONNECT_TIMEOUT_MS'],
      DEFAULTS.COPY_RECONNECT_TIMEOUT_MS,
      'COPY_RECONNECT_TIMEOUT_MS',
    ),

    // Validation Thresholds
    minLiquidityUsdc: parsePositiveNumber(
      env['COPY_MIN_LIQUIDITY_USDC'],
      DEFAULTS.COPY_MIN_LIQUIDITY_USDC,
      'COPY_MIN_LIQUIDITY_USDC',
    ),
    minLiquidityWeth: parsePositiveNumber(
      env['COPY_MIN_LIQUIDITY_WETH'],
      DEFAULTS.COPY_MIN_LIQUIDITY_WETH,
      'COPY_MIN_LIQUIDITY_WETH',
    ),
    maxSlippagePct: parsePercentage(
      env['COPY_MAX_SLIPPAGE_PCT'],
      DEFAULTS.COPY_MAX_SLIPPAGE_PCT,
      'COPY_MAX_SLIPPAGE_PCT',
    ),
    maxTaxPct: parsePercentage(
      env['COPY_MAX_TAX_PCT'],
      DEFAULTS.COPY_MAX_TAX_PCT,
      'COPY_MAX_TAX_PCT',
    ),
    minLpLockPct: parsePercentage(
      env['COPY_MIN_LP_LOCK_PCT'],
      DEFAULTS.COPY_MIN_LP_LOCK_PCT,
      'COPY_MIN_LP_LOCK_PCT',
    ),

    // Anti-Baiting
    maxVolumeFootprintPct: parsePercentage(
      env['COPY_MAX_VOLUME_FOOTPRINT_PCT'],
      DEFAULTS.COPY_MAX_VOLUME_FOOTPRINT_PCT,
      'COPY_MAX_VOLUME_FOOTPRINT_PCT',
    ),
    executionDelayMinMs: parsePositiveNumber(
      env['COPY_EXECUTION_DELAY_MIN_MS'],
      DEFAULTS.COPY_EXECUTION_DELAY_MIN_MS,
      'COPY_EXECUTION_DELAY_MIN_MS',
    ),
    executionDelayMaxMs: parsePositiveNumber(
      env['COPY_EXECUTION_DELAY_MAX_MS'],
      DEFAULTS.COPY_EXECUTION_DELAY_MAX_MS,
      'COPY_EXECUTION_DELAY_MAX_MS',
    ),
    maxBaitFlags: parseInteger(
      env['COPY_MAX_BAIT_FLAGS'],
      DEFAULTS.COPY_MAX_BAIT_FLAGS,
      'COPY_MAX_BAIT_FLAGS',
    ),
    baitFlagWindowDays: parseInteger(
      env['COPY_BAIT_FLAG_WINDOW_DAYS'],
      DEFAULTS.COPY_BAIT_FLAG_WINDOW_DAYS,
      'COPY_BAIT_FLAG_WINDOW_DAYS',
    ),

    // Security - API key for mutating endpoints (Req 9.10)
    // If COPY_API_KEY is not set, use default for development
    // If COPY_API_KEY is set to empty string, disable authentication (null)
    apiKey: (() => {
      const envKey = env['COPY_API_KEY'];
      if (envKey === undefined) {
        // Not set - use default for development
        return DEFAULTS.COPY_API_KEY;
      }
      if (envKey.trim() === '') {
        // Explicitly empty - disable auth
        return null;
      }
      return envKey.trim();
    })(),
  };

  // ─── Additional Validation ──────────────────────────────────────────────
  // Ensure delay min < max
  if (config.executionDelayMinMs >= config.executionDelayMaxMs) {
    log.warn(
      `COPY_EXECUTION_DELAY_MIN_MS (${config.executionDelayMinMs}) >= COPY_EXECUTION_DELAY_MAX_MS (${config.executionDelayMaxMs}), adjusting`,
    );
    config.executionDelayMaxMs = config.executionDelayMinMs + 1000;
  }

  // Ensure maxPositionUsdc doesn't exceed initialCapitalUsdc
  if (config.maxPositionUsdc > config.initialCapitalUsdc) {
    log.warn(
      `COPY_MAX_POSITION_USDC (${config.maxPositionUsdc}) exceeds COPY_INITIAL_CAPITAL_USDC (${config.initialCapitalUsdc}), capping`,
    );
    config.maxPositionUsdc = config.initialCapitalUsdc;
  }

  // ─── Log loaded configuration (Req 10.13) ───────────────────────────────
  logConfiguration(config);

  return config;
}

/**
 * Log the loaded configuration at startup.
 * Masks sensitive RPC URLs for security.
 */
function logConfiguration(config: CopyTradingConfig): void {
  const maskUrl = (url: string | null): string => {
    if (!url) return '(not set)';
    // Mask everything after the protocol
    const match = url.match(/^(https?:\/\/|wss?:\/\/)/);
    if (match) {
      return `${match[1]}***`;
    }
    return '***';
  };

  log.info('Copy-Trading configuration loaded', {
    // Capital & Sizing
    initialCapitalUsdc: config.initialCapitalUsdc,
    maxPositionUsdc: config.maxPositionUsdc,
    copyRatio: config.copyRatio,

    // Exit Parameters
    takeProfitPct: config.takeProfitPct,
    stopLossPct: config.stopLossPct,
    trailActivationPct: config.trailActivationPct,
    trailDistancePct: config.trailDistancePct,
    timeStopHours: config.timeStopHours,

    // Risk Management
    maxLossStreak: config.maxLossStreak,
    maxGasGwei: config.maxGasGwei,
    maxConcurrentPositions: config.maxConcurrentPositions,
    maxDailyCapitalPct: config.maxDailyCapitalPct,
    circuitBreakerHours: config.circuitBreakerHours,
    maxDrawdownPct: config.maxDrawdownPct,
    minReservePct: config.minReservePct,

    // RPC (masked)
    wsRpcUrl: maskUrl(config.wsRpcUrl),
    httpRpcUrl: maskUrl(config.httpRpcUrl),
    pollingIntervalMs: config.pollingIntervalMs,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    reconnectTimeoutMs: config.reconnectTimeoutMs,

    // Validation Thresholds
    minLiquidityUsdc: config.minLiquidityUsdc,
    minLiquidityWeth: config.minLiquidityWeth,
    maxSlippagePct: config.maxSlippagePct,
    maxTaxPct: config.maxTaxPct,
    minLpLockPct: config.minLpLockPct,

    // Anti-Baiting
    maxVolumeFootprintPct: config.maxVolumeFootprintPct,
    executionDelayMinMs: config.executionDelayMinMs,
    executionDelayMaxMs: config.executionDelayMaxMs,
    maxBaitFlags: config.maxBaitFlags,
    baitFlagWindowDays: config.baitFlagWindowDays,

    // Security
    apiKeyConfigured: config.apiKey !== null && config.apiKey !== '',
  });
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { DEFAULTS as COPY_TRADING_DEFAULTS };

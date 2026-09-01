/**
 * CopyExecutor Module
 *
 * Ejecuta trades de copia con sizing dinámico basado en el trade del insider.
 *
 * Funcionalidades implementadas:
 * - Calcular position size: min(insider × 10%, $100, capital × 5%) (Req 4.1)
 * - Aplicar multiplicador de tier: S=1.5x, A=1.0x, B=0.5x (Req 4.2)
 * - Rechazar posiciones <$10 USDC (Req 4.3)
 * - Integración con RiskBucket para límite de 3 posiciones (Req 5.1)
 *
 * @module copy-trading/modules/CopyExecutor
 */

import { randomUUID } from 'crypto';
import { createLogger } from '../../logger.js';
import type {
  EnrichedSignal,
  ExecutionResult,
  ExecutionRejectReason,
  CopyPosition,
  ICopyExecutor,
  WalletTier,
  PositionSizingConfig,
  ExecutionConfig,
} from '../interfaces/types.js';
import type { CopyTradingConfig } from '../config/CopyTradingConfig.js';
import { CopyTradingRiskManager, type IPositionTracker } from './CopyTradingRiskManager.js';

const log = createLogger('copy-executor');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default tier multipliers for position sizing (Req 4.2) */
export const DEFAULT_TIER_MULTIPLIERS: Record<WalletTier, number> = {
  S_TIER: 1.5,
  A_TIER: 1.0,
  B_TIER: 0.5,
};

/** Minimum position size in USDC (Req 4.3) */
export const MIN_POSITION_USDC = 10;

/** Default maximum position size in USDC (Req 4.1) */
export const DEFAULT_MAX_POSITION_USDC = 100;

/** Default copy ratio (10% of insider trade) (Req 4.1) */
export const DEFAULT_COPY_RATIO = 0.10;

/** Default maximum capital percentage per trade (5%) (Req 4.1) */
export const DEFAULT_MAX_CAPITAL_PCT = 0.05;

/** Default execution delay range in ms (Req 4.4) */
export const DEFAULT_EXECUTION_DELAY_MS = { min: 5_000, max: 30_000 };

/** Default split threshold in USDC (Req 4.5) */
export const DEFAULT_SPLIT_THRESHOLD_USDC = 50;

/** Default number of splits for large orders (Req 4.5) */
export const DEFAULT_SPLIT_COUNT = 3;

/** Default delay between split orders in ms (Req 4.5) */
export const DEFAULT_SPLIT_DELAY_MS = 10_000;

/** Default base slippage percentage (Req 4.6) */
export const DEFAULT_BASE_SLIPPAGE_PCT = 1;

/** Default additional slippage per $10K missing liquidity (Req 4.6) */
export const DEFAULT_SLIPPAGE_PER_MISSING_LIQUIDITY = 0.5;

/** Default maximum slippage cap (Req 4.6) */
export const DEFAULT_MAX_SLIPPAGE_PCT = 5;

/** Default maximum gas price in gwei (Req 4.7) */
export const DEFAULT_MAX_GAS_GWEI = 50;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for CopyExecutor module
 */
export interface CopyExecutorConfig {
  /** Position sizing configuration */
  positionSizing: PositionSizingConfig;
  /** Execution configuration */
  execution: ExecutionConfig;
  /** Available capital in USDC */
  availableCapitalUsdc: number;
  /** Optional risk manager for position limits (Req 5.1) */
  riskManager?: CopyTradingRiskManager;
}

/**
 * Result of position size calculation
 */
export interface PositionSizeResult {
  /** Whether position size meets minimum threshold */
  approved: boolean;
  /** Calculated position size in USDC */
  positionSizeUsdc: number;
  /** Rejection reason if not approved */
  rejectReason?: ExecutionRejectReason;
  /** Breakdown of calculation */
  breakdown: {
    /** Insider trade amount in USDC */
    insiderTradeUsdc: number;
    /** Position from insider trade × copy ratio */
    fromInsiderTrade: number;
    /** Maximum position allowed */
    maxPosition: number;
    /** Position from available capital × max capital % */
    fromCapital: number;
    /** Base position before tier multiplier */
    basePosition: number;
    /** Tier multiplier applied */
    tierMultiplier: number;
    /** Final position after tier multiplier */
    finalPosition: number;
    /** Wallet tier used */
    walletTier: WalletTier;
  };
}

/**
 * Internal statistics for the module
 */
interface CopyExecutorStats {
  totalExecuted: number;
  totalRejected: number;
  rejectionsByReason: Record<ExecutionRejectReason, number>;
  totalExecutionMs: number;
}

// =============================================================================
// COPY EXECUTOR CLASS
// =============================================================================

/**
 * CopyExecutor - Executes copy trades with dynamic position sizing
 *
 * This class implements the core logic for:
 * - Position size calculation (Req 4.1, 4.2, 4.3)
 * - Maximum concurrent positions limit (Req 5.1) - via CopyTradingRiskManager
 * - Random execution delays (Req 4.4) - placeholder
 * - Order splitting for large positions (Req 4.5) - placeholder
 * - Dynamic slippage calculation (Req 4.6) - placeholder
 * - Pre-execution validations (Req 4.7, 4.8, 4.9, 4.10, 4.12) - placeholder
 * - Position registration (Req 4.11) - placeholder
 */
export class CopyExecutor implements ICopyExecutor, IPositionTracker {
  private readonly positionSizingConfig: PositionSizingConfig;
  private readonly executionConfig: ExecutionConfig;
  private availableCapitalUsdc: number;

  // Risk manager for position limits (Req 5.1)
  private riskManager: CopyTradingRiskManager | null = null;

  // Open positions map (positionId → CopyPosition)
  private readonly openPositions: Map<string, CopyPosition> = new Map();

  // Statistics tracking
  private stats: CopyExecutorStats = {
    totalExecuted: 0,
    totalRejected: 0,
    rejectionsByReason: {} as Record<ExecutionRejectReason, number>,
    totalExecutionMs: 0,
  };

  /**
   * Creates a new CopyExecutor instance
   * @param config - Configuration options
   */
  constructor(config: CopyExecutorConfig) {
    this.positionSizingConfig = config.positionSizing;
    this.executionConfig = config.execution;
    this.availableCapitalUsdc = config.availableCapitalUsdc;

    // Set up risk manager if provided (Req 5.1)
    if (config.riskManager) {
      this.riskManager = config.riskManager;
      // Connect this executor as the position tracker
      this.riskManager.setPositionTracker(this);
    }

    log.info('CopyExecutor initialized', {
      copyRatio: this.positionSizingConfig.copyRatio,
      maxPositionUsdc: this.positionSizingConfig.maxPositionUsdc,
      minPositionUsdc: this.positionSizingConfig.minPositionUsdc,
      maxCapitalPct: this.positionSizingConfig.maxCapitalPct,
      tierMultipliers: this.positionSizingConfig.tierMultipliers,
      availableCapitalUsdc: this.availableCapitalUsdc,
      hasRiskManager: !!config.riskManager,
    });
  }

  /**
   * Create CopyExecutor from CopyTradingConfig
   */
  static fromConfig(config: CopyTradingConfig): CopyExecutor {
    return new CopyExecutor({
      positionSizing: {
        copyRatio: config.copyRatio,
        maxPositionUsdc: config.maxPositionUsdc,
        minPositionUsdc: MIN_POSITION_USDC,
        maxCapitalPct: DEFAULT_MAX_CAPITAL_PCT,
        tierMultipliers: DEFAULT_TIER_MULTIPLIERS,
      },
      execution: {
        minDelayMs: config.executionDelayMinMs,
        maxDelayMs: config.executionDelayMaxMs,
        splitThresholdUsdc: DEFAULT_SPLIT_THRESHOLD_USDC,
        splitCount: DEFAULT_SPLIT_COUNT,
        splitDelayMs: DEFAULT_SPLIT_DELAY_MS,
        baseSlippagePct: DEFAULT_BASE_SLIPPAGE_PCT,
        slippagePerMissingLiquidity: DEFAULT_SLIPPAGE_PER_MISSING_LIQUIDITY,
        maxSlippagePct: config.maxSlippagePct,
        maxGasGwei: config.maxGasGwei,
      },
      availableCapitalUsdc: config.initialCapitalUsdc,
    });
  }

  // ===========================================================================
  // ICopyExecutor Interface Implementation
  // ===========================================================================

  /**
   * Execute a copy trade from an enriched signal.
   *
   * This implementation:
   * 1. Checks position limits via RiskManager (Req 5.1) - MAX_POSITIONS_REACHED
   * 2. Checks circuit breaker state (Req 5.4) - CIRCUIT_BREAKER_ACTIVE
   * 3. Calculates position size
   * 4. Rejects if position too small
   * 5. Creates a position record (without actual execution)
   *
   * Full implementation will include:
   * - Random delay (Req 4.4)
   * - Order splitting (Req 4.5)
   * - Dynamic slippage (Req 4.6)
   * - Gas validation (Req 4.7, 4.8)
   * - Transaction simulation (Req 4.9, 4.10)
   * - Volume footprint check (Req 4.12)
   *
   * @param signal - Enriched signal to execute
   * @returns ExecutionResult with success status
   */
  async execute(signal: EnrichedSignal): Promise<ExecutionResult> {
    const startTime = Date.now();

    log.debug('Executing copy trade', {
      signalId: signal.id,
      sourceWallet: signal.sourceWallet.slice(0, 10),
      tokenAddress: signal.tokenAddress.slice(0, 10),
      tradeAmountUsdc: signal.tradeAmountUsdc,
      walletTier: signal.walletTier,
    });

    // Step 0: Check position limits and circuit breaker (Req 5.1, 5.4)
    if (this.riskManager) {
      const riskCheck = this.riskManager.canOpenPosition();

      if (!riskCheck.allowed) {
        this._recordRejection(riskCheck.rejectReason!);
        log.info('Trade rejected by risk manager', {
          signalId: signal.id,
          reason: riskCheck.rejectReason,
          currentPositions: riskCheck.currentPositions,
          maxPositions: riskCheck.maxPositions,
          circuitBreakerActive: riskCheck.circuitBreakerActive,
        });
        return { success: false, reason: riskCheck.rejectReason! };
      }
    }

    // Step 1: Calculate position size
    const positionResult = this.calculatePositionSize(signal, this.availableCapitalUsdc);

    if (!positionResult.approved) {
      this._recordRejection(positionResult.rejectReason!);
      log.info('Trade rejected due to position sizing', {
        signalId: signal.id,
        reason: positionResult.rejectReason,
        calculatedSize: positionResult.positionSizeUsdc,
        breakdown: positionResult.breakdown,
      });
      return { success: false, reason: positionResult.rejectReason! };
    }

    // Step 2: Create position record (placeholder - no actual execution)
    const positionId = randomUUID();
    const executedPrice = signal.entryPrice;
    const gasUsed = BigInt(0); // Placeholder

    const position: CopyPosition = {
      id: positionId,
      signalId: signal.id,
      sourceWallet: signal.sourceWallet,
      tokenAddress: signal.tokenAddress,
      poolAddress: signal.poolAddress,
      entryPrice: signal.entryPrice,
      positionSizeUsdc: positionResult.positionSizeUsdc,
      tokenAmount: BigInt(0), // Placeholder - would be calculated from actual execution
      takeProfit: this._calculateTakeProfit(signal.entryPrice),
      stopLoss: this._calculateStopLoss(signal.entryPrice),
      trailingStopTrigger: this._calculateTrailingTrigger(signal.entryPrice),
      trailingStopLevel: null,
      timeStop: Date.now() + (48 * 60 * 60 * 1000), // 48 hours from now
      status: 'OPEN',
      openedAt: Date.now(),
      closedAt: null,
      exitPrice: null,
      pnlUsdc: null,
      exitReason: null,
    };

    // Store position
    this.openPositions.set(positionId, position);

    // Update capital tracking
    this.availableCapitalUsdc -= positionResult.positionSizeUsdc;

    // Record stats
    const executionMs = Date.now() - startTime;
    this.stats.totalExecuted++;
    this.stats.totalExecutionMs += executionMs;

    log.info('Trade executed successfully', {
      signalId: signal.id,
      positionId,
      positionSizeUsdc: positionResult.positionSizeUsdc,
      walletTier: signal.walletTier,
      tierMultiplier: positionResult.breakdown.tierMultiplier,
      executionMs,
      openPositionsCount: this.openPositions.size,
    });

    return {
      success: true,
      positionId,
      executedPrice,
      gasUsed,
    };
  }

  /**
   * Get all open positions.
   */
  getOpenPositions(): CopyPosition[] {
    return Array.from(this.openPositions.values());
  }

  /**
   * Get count of open positions.
   * Implements IPositionTracker interface for RiskManager.
   */
  getOpenPositionsCount(): number {
    return this.openPositions.size;
  }

  /**
   * Get position by ID.
   */
  getPosition(positionId: string): CopyPosition | null {
    return this.openPositions.get(positionId) ?? null;
  }

  /**
   * Force close a position.
   * Notifies risk manager of position close.
   */
  async forceClose(positionId: string): Promise<boolean> {
    const position = this.openPositions.get(positionId);
    if (!position) {
      log.warn('Position not found for force close', { positionId });
      return false;
    }

    // Update position status
    position.status = 'FORCED_CLOSE';
    position.closedAt = Date.now();
    position.exitReason = 'Manual force close';
    position.pnlUsdc = 0; // Assume no slippage for simplicity

    // Notify risk manager of position close (Req 5.1)
    if (this.riskManager) {
      this.riskManager.onPositionClosed('FORCED_CLOSE', position.pnlUsdc);
    }

    // Return capital (assuming no slippage for simplicity)
    this.availableCapitalUsdc += position.positionSizeUsdc;

    // Remove from open positions
    this.openPositions.delete(positionId);

    log.info('Position force closed', {
      positionId,
      positionSizeUsdc: position.positionSizeUsdc,
      openPositionsRemaining: this.openPositions.size,
    });

    return true;
  }

  /**
   * Get execution statistics.
   */
  getStats(): {
    totalExecuted: number;
    totalRejected: number;
    rejectionsByReason: Record<ExecutionRejectReason, number>;
    avgExecutionMs: number;
  } {
    const avgExecutionMs =
      this.stats.totalExecuted > 0
        ? Math.round(this.stats.totalExecutionMs / this.stats.totalExecuted)
        : 0;

    return {
      totalExecuted: this.stats.totalExecuted,
      totalRejected: this.stats.totalRejected,
      rejectionsByReason: { ...this.stats.rejectionsByReason },
      avgExecutionMs,
    };
  }

  // ===========================================================================
  // Position Sizing (Req 4.1, 4.2, 4.3)
  // ===========================================================================

  /**
   * Calculate position size for a copy trade.
   *
   * Formula (Req 4.1):
   *   basePosition = min(insiderTrade × copyRatio, maxPositionUsdc, availableCapital × maxCapitalPct)
   *
   * Tier multiplier (Req 4.2):
   *   finalPosition = basePosition × tierMultiplier
   *   - S_TIER: 1.5x
   *   - A_TIER: 1.0x
   *   - B_TIER: 0.5x
   *
   * Rejection (Req 4.3):
   *   if finalPosition < $10 USDC → reject with POSITION_TOO_SMALL
   *
   * @param signal - Enriched signal containing trade details
   * @param availableCapitalUsdc - Current available capital
   * @returns PositionSizeResult with calculated size and breakdown
   */
  calculatePositionSize(
    signal: EnrichedSignal,
    availableCapitalUsdc: number,
  ): PositionSizeResult {
    const {
      copyRatio,
      maxPositionUsdc,
      maxCapitalPct,
      minPositionUsdc,
      tierMultipliers,
    } = this.positionSizingConfig;

    // Step 1: Calculate each component
    const insiderTradeUsdc = signal.tradeAmountUsdc;
    const fromInsiderTrade = insiderTradeUsdc * copyRatio;
    const maxPosition = maxPositionUsdc;
    const fromCapital = availableCapitalUsdc * maxCapitalPct;

    // Step 2: Base position is minimum of all three (Req 4.1)
    const basePosition = Math.min(fromInsiderTrade, maxPosition, fromCapital);

    // Step 3: Apply tier multiplier (Req 4.2)
    const tierMultiplier = tierMultipliers[signal.walletTier];
    const finalPosition = basePosition * tierMultiplier;

    // Round to 2 decimal places
    const positionSizeUsdc = Math.round(finalPosition * 100) / 100;

    log.debug('Position size calculated', {
      signalId: signal.id,
      insiderTradeUsdc,
      fromInsiderTrade,
      maxPosition,
      fromCapital,
      basePosition,
      walletTier: signal.walletTier,
      tierMultiplier,
      finalPosition: positionSizeUsdc,
      minRequired: minPositionUsdc,
    });

    // Step 4: Check minimum threshold (Req 4.3)
    const approved = positionSizeUsdc >= minPositionUsdc;

    const result: PositionSizeResult = {
      approved,
      positionSizeUsdc,
      breakdown: {
        insiderTradeUsdc,
        fromInsiderTrade,
        maxPosition,
        fromCapital,
        basePosition,
        tierMultiplier,
        finalPosition: positionSizeUsdc,
        walletTier: signal.walletTier,
      },
    };

    if (!approved) {
      result.rejectReason = 'POSITION_TOO_SMALL';
      log.debug('Position too small', {
        signalId: signal.id,
        calculated: positionSizeUsdc,
        minimum: minPositionUsdc,
      });
    }

    return result;
  }

  // ===========================================================================
  // Public Methods for Testing and External Use
  // ===========================================================================

  /**
   * Update available capital.
   * Useful for testing or when capital changes externally.
   */
  setAvailableCapital(capitalUsdc: number): void {
    this.availableCapitalUsdc = capitalUsdc;
    log.debug('Available capital updated', { capitalUsdc });
  }

  /**
   * Get current available capital.
   */
  getAvailableCapital(): number {
    return this.availableCapitalUsdc;
  }

  /**
   * Set the risk manager for position limits (Req 5.1).
   * Can be called after construction to connect the risk manager.
   */
  setRiskManager(riskManager: CopyTradingRiskManager): void {
    this.riskManager = riskManager;
    // Connect this executor as the position tracker
    this.riskManager.setPositionTracker(this);
    log.debug('RiskManager connected to CopyExecutor');
  }

  /**
   * Get the connected risk manager.
   */
  getRiskManager(): CopyTradingRiskManager | null {
    return this.riskManager;
  }

  /**
   * Get position sizing configuration.
   */
  getPositionSizingConfig(): PositionSizingConfig {
    return { ...this.positionSizingConfig };
  }

  /**
   * Get execution configuration.
   */
  getExecutionConfig(): ExecutionConfig {
    return { ...this.executionConfig };
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Record a rejection in statistics.
   */
  private _recordRejection(reason: ExecutionRejectReason): void {
    this.stats.totalRejected++;
    this.stats.rejectionsByReason[reason] =
      (this.stats.rejectionsByReason[reason] || 0) + 1;
  }

  /**
   * Calculate take profit price (+50% default).
   */
  private _calculateTakeProfit(entryPrice: bigint): bigint {
    // Take profit at +50% (multiply by 1.5)
    return (entryPrice * BigInt(150)) / BigInt(100);
  }

  /**
   * Calculate stop loss price (-20% default).
   */
  private _calculateStopLoss(entryPrice: bigint): bigint {
    // Stop loss at -20% (multiply by 0.8)
    return (entryPrice * BigInt(80)) / BigInt(100);
  }

  /**
   * Calculate trailing stop trigger price (+10% to activate).
   */
  private _calculateTrailingTrigger(entryPrice: bigint): bigint {
    // Trailing activates at +10% (multiply by 1.1)
    return (entryPrice * BigInt(110)) / BigInt(100);
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a CopyExecutor instance with default configuration.
 *
 * @param options - Partial configuration options
 * @returns CopyExecutor instance
 */
export function createCopyExecutor(
  options: Partial<CopyExecutorConfig> = {},
): CopyExecutor {
  const defaultConfig: CopyExecutorConfig = {
    positionSizing: {
      copyRatio: DEFAULT_COPY_RATIO,
      maxPositionUsdc: DEFAULT_MAX_POSITION_USDC,
      minPositionUsdc: MIN_POSITION_USDC,
      maxCapitalPct: DEFAULT_MAX_CAPITAL_PCT,
      tierMultipliers: DEFAULT_TIER_MULTIPLIERS,
    },
    execution: {
      minDelayMs: DEFAULT_EXECUTION_DELAY_MS.min,
      maxDelayMs: DEFAULT_EXECUTION_DELAY_MS.max,
      splitThresholdUsdc: DEFAULT_SPLIT_THRESHOLD_USDC,
      splitCount: DEFAULT_SPLIT_COUNT,
      splitDelayMs: DEFAULT_SPLIT_DELAY_MS,
      baseSlippagePct: DEFAULT_BASE_SLIPPAGE_PCT,
      slippagePerMissingLiquidity: DEFAULT_SLIPPAGE_PER_MISSING_LIQUIDITY,
      maxSlippagePct: DEFAULT_MAX_SLIPPAGE_PCT,
      maxGasGwei: DEFAULT_MAX_GAS_GWEI,
    },
    availableCapitalUsdc: 500, // Default initial capital
    riskManager: undefined,
  };

  // Merge with provided options
  const config: CopyExecutorConfig = {
    positionSizing: {
      ...defaultConfig.positionSizing,
      ...options.positionSizing,
    },
    execution: {
      ...defaultConfig.execution,
      ...options.execution,
    },
    availableCapitalUsdc:
      options.availableCapitalUsdc ?? defaultConfig.availableCapitalUsdc,
    riskManager: options.riskManager,
  };

  return new CopyExecutor(config);
}

/**
 * Create a CopyExecutor with a connected RiskManager.
 * Convenience function for Requirement 5.1 integration.
 *
 * @param options - Partial configuration options
 * @param riskManagerConfig - Optional config for the risk manager
 * @returns CopyExecutor instance with RiskManager connected
 */
export function createCopyExecutorWithRiskManager(
  options: Partial<CopyExecutorConfig> = {},
  riskManagerConfig?: ConstructorParameters<typeof CopyTradingRiskManager>[0],
): CopyExecutor {
  const riskManager = new CopyTradingRiskManager(riskManagerConfig);
  return createCopyExecutor({ ...options, riskManager });
}

// =============================================================================
// EXPORTS
// =============================================================================

// PositionSizeResult is already exported as interface above

/**
 * CopyTradingRiskManager Module
 *
 * Integrates the shared RiskBucket with copy-trading specific risk management.
 * Handles the maximum concurrent positions limit and circuit breaker integration.
 *
 * Requirement 5.1: THE Risk_Bucket SHALL limit maximum concurrent open positions to 3
 *
 * @module copy-trading/modules/CopyTradingRiskManager
 */

import { createLogger } from '../../logger.js';
import type { RiskBucket, CircuitBreakerState } from '../../shared/risk-bucket.js';
import type { CopyPosition, ExecutionRejectReason } from '../interfaces/types.js';

const log = createLogger('copy-trading-risk-manager');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum concurrent open positions (Req 5.1) */
export const MAX_CONCURRENT_POSITIONS = 3;

/** Maximum daily capital deployment percentage (Req 5.2) */
export const MAX_DAILY_CAPITAL_PCT = 0.20;

/** Daily PnL loss threshold to trigger circuit breaker (Req 5.6) */
export const DAILY_PNL_LOSS_THRESHOLD_PCT = 0.15;

/** Maximum position drawdown before force close (Req 5.8) */
export const MAX_POSITION_DRAWDOWN_PCT = 0.25;

/** Minimum capital reserve percentage (Req 5.9) */
export const MIN_CAPITAL_RESERVE_PCT = 0.20;

/** Circuit breaker duration in milliseconds (24 hours) */
export const CIRCUIT_BREAKER_DURATION_MS = 24 * 60 * 60 * 1000;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Result of checking if a new trade can be executed
 */
export interface TradeAllowedResult {
  /** Whether the trade is allowed */
  allowed: boolean;
  /** Reason for rejection if not allowed */
  rejectReason?: ExecutionRejectReason;
  /** Current number of open positions */
  currentPositions: number;
  /** Maximum allowed positions */
  maxPositions: number;
  /** Circuit breaker state */
  circuitBreakerActive: boolean;
  /** Daily capital info */
  dailyCapital?: {
    /** Capital deployed today (USDC) */
    deployed: number;
    /** Maximum daily capital allowed (USDC) */
    maxAllowed: number;
    /** Remaining daily capital (USDC) */
    remaining: number;
  };
  /** Capital reserve info (Req 5.9) */
  capitalReserve?: {
    /** Total capital (USDC) */
    totalCapital: number;
    /** Maximum deployable capital (80% of total) (USDC) */
    maxDeployable: number;
    /** Capital currently deployed in open positions (USDC) */
    currentlyDeployed: number;
    /** Remaining deployable capital (USDC) */
    remainingDeployable: number;
    /** Minimum reserve required (20% of total) (USDC) */
    minimumReserve: number;
  };
}

/**
 * Configuration for CopyTradingRiskManager
 */
export interface CopyTradingRiskManagerConfig {
  /** Maximum concurrent positions (default: 3) */
  maxConcurrentPositions?: number;
  /** Maximum daily capital deployment percentage (default: 20%) */
  maxDailyCapitalPct?: number;
  /** Daily PnL loss threshold (default: 15%) */
  dailyPnlLossThresholdPct?: number;
  /** Maximum position drawdown (default: 25%) */
  maxPositionDrawdownPct?: number;
  /** Minimum capital reserve (default: 20%) */
  minCapitalReservePct?: number;
  /** Circuit breaker duration in ms (default: 24h) */
  circuitBreakerDurationMs?: number;
}

/**
 * Extended circuit breaker state for copy-trading
 */
export interface CopyTradingCircuitBreakerState extends CircuitBreakerState {
  /** Reason for activation */
  activationReason?: 'LOSS_STREAK' | 'DAILY_PNL_LIMIT';
  /** Daily PnL when activated (if PnL-based) */
  dailyPnlAtActivation?: number;
}

/**
 * Interface for position tracking
 */
export interface IPositionTracker {
  /** Get current number of open positions */
  getOpenPositionsCount(): number;
  /** Get all open positions */
  getOpenPositions(): CopyPosition[];
}

// =============================================================================
// COPY TRADING RISK MANAGER CLASS
// =============================================================================

/**
 * CopyTradingRiskManager - Manages risk for copy-trading system
 *
 * This class wraps the shared RiskBucket and adds copy-trading specific
 * risk management features:
 *
 * - Maximum 3 concurrent positions (Req 5.1)
 * - Maximum 20% daily capital deployment (Req 5.2)
 * - Circuit breaker on 3 consecutive losses (Req 5.3)
 * - Trade blocking during circuit breaker (Req 5.4)
 * - Circuit breaker on -15% daily PnL (Req 5.6)
 * - Daily limit reset at 00:00 UTC (Req 5.7)
 * - Force close on >25% drawdown (Req 5.8)
 * - 20% capital reserve requirement (Req 5.9)
 * - Logging of all circuit breaker activations (Req 5.10)
 */
export class CopyTradingRiskManager {
  // Configuration
  private readonly maxConcurrentPositions: number;
  private readonly maxDailyCapitalPct: number;
  private readonly dailyPnlLossThresholdPct: number;
  private readonly maxPositionDrawdownPct: number;
  private readonly minCapitalReservePct: number;
  private readonly circuitBreakerDurationMs: number;

  // Optional shared RiskBucket for circuit breaker state
  private riskBucket: RiskBucket | null = null;

  // Position tracker reference
  private positionTracker: IPositionTracker | null = null;

  // Internal circuit breaker state (when not using shared RiskBucket)
  private internalCircuitBreaker: {
    active: boolean;
    blockedUntil: number | null;
    consecutiveLosses: number;
    activationReason?: 'LOSS_STREAK' | 'DAILY_PNL_LIMIT';
  } = {
    active: false,
    blockedUntil: null,
    consecutiveLosses: 0,
  };

  // Daily tracking (resets at 00:00 UTC)
  private dailyCapitalDeployed: number = 0;
  private dailyPnl: number = 0;
  private lastDailyResetDate: string = '';

  // Total capital for percentage calculations
  private totalCapitalUsdc: number = 0;

  // Internal clock function (for testing)
  private nowFn: () => number = Date.now.bind(Date);

  /**
   * Creates a new CopyTradingRiskManager instance
   */
  constructor(config: CopyTradingRiskManagerConfig = {}) {
    this.maxConcurrentPositions = config.maxConcurrentPositions ?? MAX_CONCURRENT_POSITIONS;
    this.maxDailyCapitalPct = config.maxDailyCapitalPct ?? MAX_DAILY_CAPITAL_PCT;
    this.dailyPnlLossThresholdPct = config.dailyPnlLossThresholdPct ?? DAILY_PNL_LOSS_THRESHOLD_PCT;
    this.maxPositionDrawdownPct = config.maxPositionDrawdownPct ?? MAX_POSITION_DRAWDOWN_PCT;
    this.minCapitalReservePct = config.minCapitalReservePct ?? MIN_CAPITAL_RESERVE_PCT;
    this.circuitBreakerDurationMs = config.circuitBreakerDurationMs ?? CIRCUIT_BREAKER_DURATION_MS;

    log.info('CopyTradingRiskManager initialized', {
      maxConcurrentPositions: this.maxConcurrentPositions,
      maxDailyCapitalPct: this.maxDailyCapitalPct * 100 + '%',
      dailyPnlLossThresholdPct: this.dailyPnlLossThresholdPct * 100 + '%',
      maxPositionDrawdownPct: this.maxPositionDrawdownPct * 100 + '%',
      minCapitalReservePct: this.minCapitalReservePct * 100 + '%',
    });
  }

  // ===========================================================================
  // Configuration Methods
  // ===========================================================================

  /**
   * Set the shared RiskBucket for circuit breaker state
   */
  setRiskBucket(riskBucket: RiskBucket): void {
    this.riskBucket = riskBucket;
    log.debug('RiskBucket connected');
  }

  /**
   * Set the position tracker for position count
   */
  setPositionTracker(tracker: IPositionTracker): void {
    this.positionTracker = tracker;
    log.debug('PositionTracker connected');
  }

  /**
   * Set total capital for percentage calculations
   */
  setTotalCapital(capitalUsdc: number): void {
    this.totalCapitalUsdc = capitalUsdc;
    log.debug('Total capital set', { capitalUsdc });
  }

  // ===========================================================================
  // Trade Validation (Req 5.1)
  // ===========================================================================

  /**
   * Check if a new trade can be executed.
   *
   * Validates:
   * - Maximum concurrent positions limit (Req 5.1)
   * - Circuit breaker state (Req 5.4)
   *
   * @param openPositionsOverride - Optional override for current open positions count
   * @returns TradeAllowedResult with validation details
   */
  canOpenPosition(openPositionsOverride?: number): TradeAllowedResult {
    // Ensure daily limits are checked/reset
    this._checkDailyReset();

    // Get current open positions count
    const currentPositions = openPositionsOverride ??
      (this.positionTracker?.getOpenPositionsCount() ?? 0);

    // Check circuit breaker first (Req 5.4)
    const cbState = this.getCircuitBreakerState();
    if (cbState.active) {
      log.debug('Trade blocked by circuit breaker', {
        currentPositions,
        blockedUntil: cbState.blockedUntil,
        consecutiveLosses: cbState.consecutiveLosses,
      });

      return {
        allowed: false,
        rejectReason: 'CIRCUIT_BREAKER_ACTIVE',
        currentPositions,
        maxPositions: this.maxConcurrentPositions,
        circuitBreakerActive: true,
      };
    }

    // Check maximum concurrent positions (Req 5.1)
    if (currentPositions >= this.maxConcurrentPositions) {
      log.debug('Trade blocked by position limit', {
        currentPositions,
        maxPositions: this.maxConcurrentPositions,
      });

      return {
        allowed: false,
        rejectReason: 'MAX_POSITIONS_REACHED',
        currentPositions,
        maxPositions: this.maxConcurrentPositions,
        circuitBreakerActive: false,
      };
    }

    // All checks passed
    log.debug('Trade allowed', {
      currentPositions,
      maxPositions: this.maxConcurrentPositions,
      availableSlots: this.maxConcurrentPositions - currentPositions,
    });

    return {
      allowed: true,
      currentPositions,
      maxPositions: this.maxConcurrentPositions,
      circuitBreakerActive: false,
    };
  }

  /**
   * Get the number of available position slots.
   *
   * @param openPositionsOverride - Optional override for current open positions count
   * @returns Number of available slots (0 if circuit breaker active)
   */
  availablePositionSlots(openPositionsOverride?: number): number {
    const result = this.canOpenPosition(openPositionsOverride);
    if (result.circuitBreakerActive) {
      return 0;
    }
    return Math.max(0, this.maxConcurrentPositions - result.currentPositions);
  }

  // ===========================================================================
  // Circuit Breaker State
  // ===========================================================================

  /**
   * Get the current circuit breaker state.
   *
   * Checks both the shared RiskBucket (if connected) and internal state.
   * Auto-resets if blockedUntil has expired.
   */
  getCircuitBreakerState(): CopyTradingCircuitBreakerState {
    const now = this.nowFn();

    // Check shared RiskBucket first
    if (this.riskBucket) {
      const sharedState = this.riskBucket.getState();

      // If shared CB is active, return it
      if (sharedState.active) {
        return {
          ...sharedState,
          activationReason: 'LOSS_STREAK',
        };
      }
    }

    // Check internal circuit breaker
    if (this.internalCircuitBreaker.blockedUntil !== null) {
      if (now < this.internalCircuitBreaker.blockedUntil) {
        return {
          active: true,
          blockedUntil: this.internalCircuitBreaker.blockedUntil,
          consecutiveLosses: this.internalCircuitBreaker.consecutiveLosses,
          activationReason: this.internalCircuitBreaker.activationReason,
        };
      } else {
        // Auto-reset expired circuit breaker
        this._resetInternalCircuitBreaker();
      }
    }

    // No active circuit breaker
    return {
      active: false,
      blockedUntil: null,
      consecutiveLosses: this.internalCircuitBreaker.consecutiveLosses,
    };
  }

  /**
   * Manually reset the circuit breaker.
   *
   * Resets both internal state and shared RiskBucket (if connected).
   */
  resetCircuitBreaker(): void {
    // Reset internal state
    this._resetInternalCircuitBreaker();

    // Reset shared RiskBucket if connected
    if (this.riskBucket) {
      this.riskBucket.reset();
    }

    log.info('Circuit breaker manually reset');
  }

  // ===========================================================================
  // Position Close Handling
  // ===========================================================================

  /**
   * Called when a position is closed.
   *
   * Updates circuit breaker state based on result.
   * Delegates to shared RiskBucket if connected.
   * Also checks daily PnL threshold for circuit breaker activation (Req 5.5, 5.6).
   *
   * @param result - Close result ('TP_HIT', 'SL_HIT', 'TIME_STOP', 'RUG_PULL', etc.)
   * @param pnlUsdc - Realized PnL in USDC
   */
  onPositionClosed(
    result: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP' | 'RUG_PULL' | 'TRAILING_STOP' | 'FOLLOW_INSIDER' | 'FORCED_CLOSE',
    pnlUsdc: number,
  ): void {
    // Ensure daily limits are checked/reset first
    this._checkDailyReset();

    // Update daily PnL tracking (Req 5.5: track cumulative daily PnL)
    this.dailyPnl += pnlUsdc;

    // Map result to shared RiskBucket types
    const riskBucketResult = this._mapToRiskBucketResult(result);

    // Delegate to shared RiskBucket if connected
    if (this.riskBucket && riskBucketResult) {
      this.riskBucket.onPositionClosed(riskBucketResult);
    } else {
      // Handle internally
      if (result === 'SL_HIT' || result === 'RUG_PULL') {
        this.internalCircuitBreaker.consecutiveLosses++;

        // Check for circuit breaker activation (3 consecutive losses)
        if (this.internalCircuitBreaker.consecutiveLosses >= 3) {
          this._activateCircuitBreaker('LOSS_STREAK');
        }
      } else {
        // Reset consecutive losses on non-loss close
        this.internalCircuitBreaker.consecutiveLosses = 0;
      }
    }

    // Check daily PnL circuit breaker (Req 5.6)
    // Only check if total capital is set and circuit breaker is not already active
    if (this.totalCapitalUsdc > 0 && !this.internalCircuitBreaker.active) {
      const dailyPnlThreshold = -this.totalCapitalUsdc * this.dailyPnlLossThresholdPct;

      if (this.dailyPnl <= dailyPnlThreshold) {
        log.warn('Daily PnL threshold exceeded, activating circuit breaker', {
          dailyPnl: this.dailyPnl,
          threshold: dailyPnlThreshold,
          totalCapital: this.totalCapitalUsdc,
          thresholdPct: this.dailyPnlLossThresholdPct * 100 + '%',
        });
        this._activateCircuitBreaker('DAILY_PNL_LIMIT');
      }
    }

    log.debug('Position closed tracked', {
      result,
      pnlUsdc,
      dailyPnl: this.dailyPnl,
      consecutiveLosses: this.internalCircuitBreaker.consecutiveLosses,
      totalCapital: this.totalCapitalUsdc,
    });
  }

  // ===========================================================================
  // Getters
  // ===========================================================================

  /**
   * Get maximum concurrent positions configuration
   */
  getMaxConcurrentPositions(): number {
    return this.maxConcurrentPositions;
  }

  /**
   * Get daily PnL
   */
  getDailyPnl(): number {
    this._checkDailyReset();
    return this.dailyPnl;
  }

  /**
   * Get daily capital deployed
   */
  getDailyCapitalDeployed(): number {
    this._checkDailyReset();
    return this.dailyCapitalDeployed;
  }

  /**
   * Get the maximum daily capital allowed in USDC.
   * Calculated as totalCapital × maxDailyCapitalPct (default 20%)
   *
   * @returns Maximum daily capital in USDC
   */
  getMaxDailyCapital(): number {
    return this.totalCapitalUsdc * this.maxDailyCapitalPct;
  }

  /**
   * Get remaining daily capital that can be deployed.
   *
   * @returns Remaining capital in USDC (0 if limit reached)
   */
  getRemainingDailyCapital(): number {
    this._checkDailyReset();
    const maxDaily = this.getMaxDailyCapital();
    return Math.max(0, maxDaily - this.dailyCapitalDeployed);
  }

  // ===========================================================================
  // Capital Reserve Methods (Req 5.9)
  // ===========================================================================

  /**
   * Get the maximum deployable capital (80% of total).
   *
   * Requirement 5.9: THE Risk_Bucket SHALL maintain a minimum reserve of 20%
   * of capital (never deploy more than 80%)
   *
   * @returns Maximum deployable capital in USDC
   */
  getMaxDeployableCapital(): number {
    return this.totalCapitalUsdc * (1 - this.minCapitalReservePct);
  }

  /**
   * Get the minimum capital reserve required (20% of total).
   *
   * @returns Minimum reserve in USDC
   */
  getMinimumCapitalReserve(): number {
    return this.totalCapitalUsdc * this.minCapitalReservePct;
  }

  /**
   * Get the minimum capital reserve percentage configuration.
   *
   * @returns Minimum reserve percentage as decimal (0.20 = 20%)
   */
  getMinCapitalReservePct(): number {
    return this.minCapitalReservePct;
  }

  /**
   * Get total capital currently deployed in open positions.
   *
   * This is calculated by summing positionSizeUsdc of all open positions
   * from the position tracker.
   *
   * @returns Total capital deployed in open positions (USDC)
   */
  getCurrentDeployedCapitalInPositions(): number {
    if (!this.positionTracker) {
      return 0;
    }

    const openPositions = this.positionTracker.getOpenPositions();
    return openPositions.reduce((total, pos) => total + pos.positionSizeUsdc, 0);
  }

  /**
   * Get remaining deployable capital respecting the 20% reserve requirement.
   *
   * This is the difference between maxDeployableCapital (80%) and
   * currentlyDeployedCapitalInPositions.
   *
   * @returns Remaining deployable capital in USDC (0 if reserve would be violated)
   */
  getRemainingDeployableCapital(): number {
    const maxDeployable = this.getMaxDeployableCapital();
    const currentlyDeployed = this.getCurrentDeployedCapitalInPositions();
    return Math.max(0, maxDeployable - currentlyDeployed);
  }

  /**
   * Check if deploying a specific amount of capital would violate the reserve requirement.
   *
   * Requirement 5.9: THE Risk_Bucket SHALL maintain a minimum reserve of 20%
   * of capital (never deploy more than 80%)
   *
   * This check is different from daily capital limit:
   * - Daily capital limit tracks gross deployment per day (resets at midnight)
   * - Capital reserve checks total deployment across all open positions (net)
   *
   * @param amountUsdc - Amount to deploy in USDC
   * @returns true if the deployment would violate the reserve requirement, false otherwise
   */
  wouldViolateCapitalReserve(amountUsdc: number): boolean {
    // If no total capital set, cannot enforce limit
    if (this.totalCapitalUsdc <= 0) {
      return false;
    }

    const maxDeployable = this.getMaxDeployableCapital();
    const currentlyDeployed = this.getCurrentDeployedCapitalInPositions();
    const projectedTotal = currentlyDeployed + amountUsdc;

    return projectedTotal > maxDeployable;
  }

  /**
   * Get capital reserve info for diagnostics.
   *
   * @returns Object with capital reserve details
   */
  getCapitalReserveInfo(): {
    totalCapital: number;
    maxDeployable: number;
    currentlyDeployed: number;
    remainingDeployable: number;
    minimumReserve: number;
  } {
    return {
      totalCapital: this.totalCapitalUsdc,
      maxDeployable: this.getMaxDeployableCapital(),
      currentlyDeployed: this.getCurrentDeployedCapitalInPositions(),
      remainingDeployable: this.getRemainingDeployableCapital(),
      minimumReserve: this.getMinimumCapitalReserve(),
    };
  }

  /**
   * Check if deploying a specific amount of capital would exceed the daily limit.
   *
   * Requirements 5.2, 5.7:
   * - THE Risk_Bucket SHALL limit maximum daily capital deployment to 20% of total capital
   * - THE Risk_Bucket SHALL reset daily limits at 00:00 UTC each day
   *
   * @param amountUsdc - Amount to deploy in USDC
   * @returns true if the deployment would exceed the limit, false otherwise
   */
  wouldExceedDailyCapital(amountUsdc: number): boolean {
    this._checkDailyReset();

    // If no total capital set, cannot enforce limit
    if (this.totalCapitalUsdc <= 0) {
      return false;
    }

    const maxDaily = this.getMaxDailyCapital();
    const projectedTotal = this.dailyCapitalDeployed + amountUsdc;

    return projectedTotal > maxDaily;
  }

  /**
   * Register capital deployment for daily tracking.
   *
   * Call this when a trade is executed to track daily capital usage.
   *
   * @param amountUsdc - Amount deployed in USDC
   */
  registerCapitalDeployment(amountUsdc: number): void {
    this._checkDailyReset();
    this.dailyCapitalDeployed += amountUsdc;

    log.debug('Capital deployment registered', {
      amountUsdc,
      totalDailyDeployed: this.dailyCapitalDeployed,
      maxDaily: this.getMaxDailyCapital(),
      remainingDaily: this.getRemainingDailyCapital(),
    });
  }

  /**
   * Release capital from daily tracking (e.g., when position is closed).
   *
   * Note: This does NOT reduce dailyCapitalDeployed as per requirements.
   * The daily limit tracks gross deployment, not net. Once you deploy capital
   * for the day, it counts against your limit even if you close the position.
   * This prevents gaming the system by opening/closing positions repeatedly.
   *
   * This method is a no-op but provided for API completeness.
   *
   * @param _amountUsdc - Amount released (not used)
   */
  releaseCapitalDeployment(_amountUsdc: number): void {
    // No-op: Daily capital deployment is gross, not net
    log.debug('Capital release requested (no-op - daily limit is gross deployment)');
  }

  /**
   * Check if a trade with a specific capital amount is allowed.
   *
   * This is an extended version of canOpenPosition that also checks:
   * - Daily capital limit (Req 5.2)
   * - Capital reserve requirement (Req 5.9)
   *
   * @param capitalAmountUsdc - Capital amount for the trade
   * @param openPositionsOverride - Optional override for current open positions count
   * @returns TradeAllowedResult with validation details including daily capital and reserve info
   */
  canOpenPositionWithCapital(
    capitalAmountUsdc: number,
    openPositionsOverride?: number,
  ): TradeAllowedResult {
    // First, run the basic position checks
    const baseResult = this.canOpenPosition(openPositionsOverride);

    // Add daily capital info to result
    const maxDaily = this.getMaxDailyCapital();
    const deployed = this.getDailyCapitalDeployed();
    const remaining = this.getRemainingDailyCapital();

    // Add capital reserve info to result (Req 5.9)
    const capitalReserveInfo = this.getCapitalReserveInfo();

    const resultWithCapital: TradeAllowedResult = {
      ...baseResult,
      dailyCapital: {
        deployed,
        maxAllowed: maxDaily,
        remaining,
      },
      capitalReserve: capitalReserveInfo,
    };

    // If base checks failed, return early
    if (!baseResult.allowed) {
      return resultWithCapital;
    }

    // Check capital reserve requirement first (Req 5.9)
    // This is the more restrictive check as it considers actual open positions
    if (this.totalCapitalUsdc > 0 && this.wouldViolateCapitalReserve(capitalAmountUsdc)) {
      log.debug('Trade blocked by capital reserve requirement', {
        capitalAmountUsdc,
        totalCapital: capitalReserveInfo.totalCapital,
        maxDeployable: capitalReserveInfo.maxDeployable,
        currentlyDeployed: capitalReserveInfo.currentlyDeployed,
        remainingDeployable: capitalReserveInfo.remainingDeployable,
        minimumReserve: capitalReserveInfo.minimumReserve,
      });

      return {
        ...resultWithCapital,
        allowed: false,
        rejectReason: 'CAPITAL_RESERVE_VIOLATED',
      };
    }

    // Check daily capital limit (Req 5.2)
    if (this.totalCapitalUsdc > 0 && this.wouldExceedDailyCapital(capitalAmountUsdc)) {
      log.debug('Trade blocked by daily capital limit', {
        capitalAmountUsdc,
        dailyDeployed: deployed,
        maxDaily,
        remaining,
      });

      return {
        ...resultWithCapital,
        allowed: false,
        rejectReason: 'DAILY_CAPITAL_EXCEEDED',
      };
    }

    return resultWithCapital;
  }

  // ===========================================================================
  // Testing Helpers
  // ===========================================================================

  /**
   * Override the internal clock for testing.
   * @param ts - Timestamp in ms to use as "now"
   */
  _overrideNow(ts: number): void {
    this.nowFn = () => ts;
  }

  /**
   * Force set consecutive losses for testing.
   */
  _setConsecutiveLosses(count: number): void {
    this.internalCircuitBreaker.consecutiveLosses = count;
  }

  /**
   * Force reset daily tracking for testing.
   */
  _resetDailyTracking(): void {
    this.dailyCapitalDeployed = 0;
    this.dailyPnl = 0;
    this.lastDailyResetDate = '';
  }

  /**
   * Set daily capital deployed directly for testing.
   * @param amount - Amount in USDC
   */
  _setDailyCapitalDeployed(amount: number): void {
    this.dailyCapitalDeployed = amount;
  }

  /**
   * Get the last daily reset date for testing.
   */
  _getLastDailyResetDate(): string {
    return this.lastDailyResetDate;
  }

  // ===========================================================================
  // Position Drawdown Check (Req 5.8)
  // ===========================================================================

  /**
   * Check if a position's drawdown exceeds the maximum threshold.
   *
   * Drawdown is calculated as: (entryPrice - currentPrice) / entryPrice
   * For long positions, a lower price means positive drawdown (loss).
   *
   * Requirement 5.8: WHEN a position's drawdown exceeds 25%, THE Risk_Bucket
   * SHALL force close the position at market price.
   *
   * @param position - The position to check
   * @param currentPrice - Current market price (same units as entryPrice)
   * @returns Object with shouldForceClose flag and drawdown percentage
   */
  checkPositionDrawdown(
    position: CopyPosition,
    currentPrice: bigint,
  ): { shouldForceClose: boolean; drawdownPct: number } {
    // Validate inputs
    if (position.entryPrice <= 0n) {
      log.warn('Invalid entry price for drawdown check', {
        positionId: position.id,
        entryPrice: position.entryPrice.toString(),
      });
      return { shouldForceClose: false, drawdownPct: 0 };
    }

    if (currentPrice <= 0n) {
      log.warn('Invalid current price for drawdown check', {
        positionId: position.id,
        currentPrice: currentPrice.toString(),
      });
      // If current price is invalid/zero, this might be a rug - force close
      return { shouldForceClose: true, drawdownPct: 100 };
    }

    // Calculate drawdown percentage
    // For long positions: drawdown = (entry - current) / entry
    // If current > entry, drawdown is negative (position is in profit)
    const entryPriceNum = Number(position.entryPrice);
    const currentPriceNum = Number(currentPrice);

    // Calculate drawdown as a decimal (0.25 = 25%)
    const drawdownDecimal = (entryPriceNum - currentPriceNum) / entryPriceNum;

    // Convert to percentage for return value (25.0 = 25%)
    const drawdownPct = drawdownDecimal * 100;

    // Check against threshold (Req 5.8: >25%)
    const shouldForceClose = drawdownDecimal > this.maxPositionDrawdownPct;

    if (shouldForceClose) {
      log.warn('Position drawdown exceeds maximum threshold - force close required', {
        positionId: position.id,
        tokenAddress: position.tokenAddress,
        entryPrice: position.entryPrice.toString(),
        currentPrice: currentPrice.toString(),
        drawdownPct: drawdownPct.toFixed(2) + '%',
        threshold: (this.maxPositionDrawdownPct * 100).toFixed(2) + '%',
      });
    } else {
      log.debug('Position drawdown within limits', {
        positionId: position.id,
        drawdownPct: drawdownPct.toFixed(2) + '%',
        threshold: (this.maxPositionDrawdownPct * 100).toFixed(2) + '%',
      });
    }

    return {
      shouldForceClose,
      drawdownPct,
    };
  }

  /**
   * Get the maximum position drawdown percentage configuration.
   * @returns Maximum drawdown percentage as decimal (0.25 = 25%)
   */
  getMaxPositionDrawdownPct(): number {
    return this.maxPositionDrawdownPct;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  /**
   * Check if daily limits need to be reset (at 00:00 UTC)
   */
  private _checkDailyReset(): void {
    const now = new Date(this.nowFn());
    const currentDate = now.toISOString().split('T')[0]; // YYYY-MM-DD

    if (currentDate !== this.lastDailyResetDate) {
      this.dailyCapitalDeployed = 0;
      this.dailyPnl = 0;
      this.lastDailyResetDate = currentDate;

      log.debug('Daily limits reset', { date: currentDate });
    }
  }

  /**
   * Activate the internal circuit breaker
   */
  private _activateCircuitBreaker(reason: 'LOSS_STREAK' | 'DAILY_PNL_LIMIT'): void {
    this.internalCircuitBreaker.active = true;
    this.internalCircuitBreaker.blockedUntil = this.nowFn() + this.circuitBreakerDurationMs;
    this.internalCircuitBreaker.activationReason = reason;

    log.warn('Circuit breaker activated', {
      reason,
      blockedUntil: new Date(this.internalCircuitBreaker.blockedUntil).toISOString(),
      consecutiveLosses: this.internalCircuitBreaker.consecutiveLosses,
      dailyPnl: this.dailyPnl,
    });
  }

  /**
   * Reset the internal circuit breaker
   */
  private _resetInternalCircuitBreaker(): void {
    this.internalCircuitBreaker.active = false;
    this.internalCircuitBreaker.blockedUntil = null;
    this.internalCircuitBreaker.consecutiveLosses = 0;
    this.internalCircuitBreaker.activationReason = undefined;
  }

  /**
   * Map copy-trading result to RiskBucket result type
   */
  private _mapToRiskBucketResult(
    result: string,
  ): 'TP_HIT' | 'SL_HIT' | 'TIME_STOP' | 'RUG_PULL' | null {
    switch (result) {
      case 'TP_HIT':
      case 'SL_HIT':
      case 'TIME_STOP':
      case 'RUG_PULL':
        return result;
      case 'TRAILING_STOP':
      case 'FOLLOW_INSIDER':
        return 'TP_HIT'; // Treat as wins
      case 'FORCED_CLOSE':
        return 'TIME_STOP'; // Neutral close
      default:
        return null;
    }
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create a CopyTradingRiskManager with default configuration.
 */
export function createCopyTradingRiskManager(
  config?: CopyTradingRiskManagerConfig,
): CopyTradingRiskManager {
  return new CopyTradingRiskManager(config);
}

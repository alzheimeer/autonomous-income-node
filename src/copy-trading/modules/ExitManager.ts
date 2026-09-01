/**
 * ExitManager Module - Task 17.1, 17.10
 *
 * Gestiona las estrategias de salida de posiciones para copy-trading.
 * Soporta tres estrategias: follow insider, trailing stop, y fixed TP/SL.
 *
 * Requirements: 6.1 - THE Exit_Manager SHALL support three exit strategies
 * Requirements: 6.2 - WHEN profit exceeds 100%, switch from follow-insider to trailing-stop
 *
 * @module copy-trading/modules/ExitManager
 */

import { EventEmitter } from 'events';
import { createLogger } from '../../logger.js';
import type { IDexQuoter } from '../../shared/dex-quoter.js';
import type {
  CopyPosition,
  ExitReason,
  ExitRecord,
  ExitStrategyConfig,
  IExitManager,
} from '../interfaces/types.js';

const log = createLogger('exit-manager');

/**
 * Exit mode type - indicates current exit strategy for a position (Task 17.10)
 * - FOLLOW_INSIDER: Default mode, exits when insider sells ≥50%
 * - TRAILING_STOP: Activates when profit >100% or insider doesn't sell within 24h
 */
export type ExitMode = 'FOLLOW_INSIDER' | 'TRAILING_STOP';

/**
 * Profit threshold (100%) to switch from FOLLOW_INSIDER to TRAILING_STOP (Requirement 6.2)
 */
export const PROFIT_SWITCH_THRESHOLD_PCT = 100;

// Constants
export const DEFAULT_MONITORING_INTERVAL_MS = 5000;
export const DEFAULT_TAKE_PROFIT_PCT = 50;
export const DEFAULT_STOP_LOSS_PCT = 20;
export const DEFAULT_TRAILING_INITIAL_DISTANCE_PCT = 15;
export const DEFAULT_TRAILING_ACTIVATION_PCT = 10;
export const DEFAULT_TRAILING_DISTANCE_PCT = 10;
export const DEFAULT_TIME_STOP_HOURS = 48;
export const DEFAULT_FOLLOW_INSIDER_THRESHOLD_PCT = 50;
export const DEFAULT_FOLLOW_INSIDER_MAX_WAIT_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_FOLLOW_INSIDER_EXECUTE_WINDOW_MS = 30_000;
export const RUG_PULL_QUOTE_FAIL_THRESHOLD = 3;
// Alias for test compatibility
export const RUG_PULL_QUOTE_FAILURE_THRESHOLD = RUG_PULL_QUOTE_FAIL_THRESHOLD;

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Types
export interface ExitManagerConfig {
  strategyConfig: ExitStrategyConfig;
  dexQuoter: IDexQuoter;
  monitoringIntervalMs?: number;
  onPositionClosed?: (position: CopyPosition, reason: ExitReason, pnlUsdc: number) => void;
}

export interface PositionState {
  position: CopyPosition;
  highestPrice: bigint;
  quoteFailCount: number;
  trailingStopActive: boolean;
  lastQuoteAt: number;
  insiderSoldPct: number;
  followInsiderActive: boolean;
}

export interface ExitEvent {
  positionId: string;
  reason: ExitReason;
  exitPrice: bigint;
  pnlUsdc: number;
  exitedAt: number;
  position: CopyPosition;
}

export interface ExitManagerStats {
  positionsMonitored: number;
  exitsByReason: Record<ExitReason, number>;
  avgHoldingTimeMs: number;
  avgPnlUsdc: number;
}

// Factory function for default config
export function createDefaultExitStrategyConfig(): ExitStrategyConfig {
  return {
    followInsider: {
      enabled: true,
      sellThresholdPct: DEFAULT_FOLLOW_INSIDER_THRESHOLD_PCT,
      maxWaitMs: DEFAULT_FOLLOW_INSIDER_MAX_WAIT_MS,
      executeWindowMs: DEFAULT_FOLLOW_INSIDER_EXECUTE_WINDOW_MS,
    },
    trailingStop: {
      initialDistancePct: DEFAULT_TRAILING_INITIAL_DISTANCE_PCT,
      activationPct: DEFAULT_TRAILING_ACTIVATION_PCT,
      trailingDistancePct: DEFAULT_TRAILING_DISTANCE_PCT,
    },
    fixedExits: {
      takeProfitPct: DEFAULT_TAKE_PROFIT_PCT,
      stopLossPct: DEFAULT_STOP_LOSS_PCT,
    },
    timeStopHours: DEFAULT_TIME_STOP_HOURS,
  };
}

// Trailing Stop State Machine (Req 6.4-6.7)
export class TrailingStopStateMachine {
  private active = false;
  private highestPrice: bigint;
  private stopLevel: bigint | null = null;
  private readonly activationPct: number;
  private readonly trailingDistancePct: number;
  private readonly entryPrice: bigint;

  constructor(entryPrice: bigint, activationPct: number, trailingDistancePct: number) {
    this.entryPrice = entryPrice;
    this.highestPrice = entryPrice;
    this.activationPct = activationPct;
    this.trailingDistancePct = trailingDistancePct;
  }

  update(currentPrice: bigint): void {
    // Update highest price
    if (currentPrice > this.highestPrice) {
      this.highestPrice = currentPrice;
    }

    // Check activation condition
    const activationPrice = (this.entryPrice * BigInt(100 + this.activationPct)) / 100n;
    if (!this.active && currentPrice >= activationPrice) {
      this.active = true;
    }

    // Update stop level if active
    if (this.active) {
      const newStopLevel = (this.highestPrice * BigInt(100 - this.trailingDistancePct)) / 100n;
      if (this.stopLevel === null || newStopLevel > this.stopLevel) {
        this.stopLevel = newStopLevel;
      }
    }
  }

  shouldTrigger(currentPrice: bigint): boolean {
    return this.active && this.stopLevel !== null && currentPrice <= this.stopLevel;
  }

  isActive(): boolean {
    return this.active;
  }

  getStopLevel(): bigint | null {
    return this.stopLevel;
  }

  getHighestPrice(): bigint {
    return this.highestPrice;
  }
}

// ExitManager Class
export class ExitManager extends EventEmitter implements IExitManager {
  private readonly config: ExitManagerConfig;
  private readonly positionStates = new Map<string, PositionState>();
  private readonly trailingStops = new Map<string, TrailingStopStateMachine>();
  private readonly exitRecords: ExitRecord[] = [];
  /** 
   * Exit modes map - tracks current exit strategy for each position (Task 17.10)
   * Default mode is FOLLOW_INSIDER when position is registered
   */
  private readonly exitModes = new Map<string, ExitMode>();
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly stats = {
    exitsByReason: {
      TP_HIT: 0, SL_HIT: 0, TRAILING_STOP: 0, TIME_STOP: 0,
      FOLLOW_INSIDER: 0, FORCED_CLOSE: 0, FORCED_DRAWDOWN: 0, RUG_PULL: 0,
    } as Record<ExitReason, number>,
    totalHoldingTimeMs: 0,
    totalPnlUsdc: 0,
    totalExits: 0,
  };

  constructor(config: ExitManagerConfig) {
    super();
    this.config = config;
    log.info('ExitManager created', {
      takeProfitPct: config.strategyConfig.fixedExits.takeProfitPct,
      stopLossPct: config.strategyConfig.fixedExits.stopLossPct,
      timeStopHours: config.strategyConfig.timeStopHours,
    });
  }

  async start(): Promise<void> {
    if (this.running) {
      log.warn('ExitManager already running');
      return;
    }
    this.running = true;
    const intervalMs = this.config.monitoringIntervalMs ?? DEFAULT_MONITORING_INTERVAL_MS;
    log.info('ExitManager started', { monitoringIntervalMs: intervalMs });
    this.monitorInterval = setInterval(() => {
      this.monitorLoop().catch(err => {
        log.error('Monitor loop error', { error: err instanceof Error ? err.message : String(err) });
      });
    }, intervalMs);
  }

  stop(): void {
    if (!this.running) {
      log.warn('ExitManager not running');
      return;
    }
    this.running = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    log.info('ExitManager stopped', { positionsRemaining: this.positionStates.size });
  }

  isMonitoring(): boolean {
    return this.running;
  }

  registerPosition(position: CopyPosition): void {
    if (this.positionStates.has(position.id)) {
      log.warn('Position already registered', { positionId: position.id });
      return;
    }
    const state: PositionState = {
      position,
      highestPrice: position.entryPrice,
      quoteFailCount: 0,
      trailingStopActive: false,
      lastQuoteAt: Date.now(),
      insiderSoldPct: 0,
      followInsiderActive: this.config.strategyConfig.followInsider.enabled,
    };
    this.positionStates.set(position.id, state);
    
    // Initialize trailing stop state machine
    const { activationPct, trailingDistancePct } = this.config.strategyConfig.trailingStop;
    this.trailingStops.set(
      position.id,
      new TrailingStopStateMachine(position.entryPrice, activationPct, trailingDistancePct)
    );
    
    // Initialize exit mode as FOLLOW_INSIDER (Task 17.10)
    this.exitModes.set(position.id, 'FOLLOW_INSIDER');
    
    log.info('Position registered', { 
      positionId: position.id, 
      tokenAddress: position.tokenAddress.slice(0, 10),
      exitMode: 'FOLLOW_INSIDER',
    });
    this.emit('positionRegistered', position);
  }

  updateInsiderActivity(tokenAddress: string, sourceWallet: string, soldPct: number): void {
    const tokenLower = tokenAddress.toLowerCase();
    const walletLower = sourceWallet.toLowerCase();
    
    for (const [id, state] of this.positionStates) {
      if (
        state.position.tokenAddress.toLowerCase() === tokenLower &&
        state.position.sourceWallet.toLowerCase() === walletLower
      ) {
        state.insiderSoldPct = soldPct;
        log.info('Insider activity updated', { positionId: id, soldPct });
        
        // Check exit mode - only trigger follow insider if mode is FOLLOW_INSIDER (Task 17.10)
        const exitMode = this.exitModes.get(id);
        if (exitMode !== 'FOLLOW_INSIDER') {
          log.info('Follow insider exit skipped - position is in TRAILING_STOP mode', {
            positionId: id,
            exitMode,
            soldPct,
          });
          continue;
        }
        
        // Check if should trigger follow insider exit (Req 6.2)
        if (
          state.followInsiderActive &&
          soldPct >= this.config.strategyConfig.followInsider.sellThresholdPct
        ) {
          // Execute follow insider exit asynchronously
          this.executeFollowInsiderExit(state).catch(err => {
            log.error('Follow insider exit failed', {
              positionId: id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
    }
  }

  private async executeFollowInsiderExit(state: PositionState): Promise<void> {
    const exitPrice = await this.getCurrentPriceSafe(state);
    await this.closePosition(state, 'FOLLOW_INSIDER', exitPrice);
  }

  getStats(): ExitManagerStats {
    const avgHoldingTimeMs = this.stats.totalExits > 0 
      ? this.stats.totalHoldingTimeMs / this.stats.totalExits 
      : 0;
    const avgPnlUsdc = this.stats.totalExits > 0 
      ? this.stats.totalPnlUsdc / this.stats.totalExits 
      : 0;
    return {
      positionsMonitored: this.positionStates.size,
      exitsByReason: { ...this.stats.exitsByReason },
      avgHoldingTimeMs,
      avgPnlUsdc,
    };
  }

  /**
   * Get the current exit mode for a position (Task 17.10)
   * @param positionId - The position ID to query
   * @returns The current exit mode or null if position not found
   */
  getExitMode(positionId: string): ExitMode | null {
    return this.exitModes.get(positionId) ?? null;
  }

  /**
   * Check and switch strategy from FOLLOW_INSIDER to TRAILING_STOP when profit >100% (Task 17.10)
   * Requirement 6.2: WHEN profit exceeds 100%, switch from follow-insider to trailing-stop
   * 
   * @param positionId - The position ID to check
   * @param currentPrice - Current token price as bigint
   * @param entryPrice - Entry price as bigint
   * @returns true if strategy was switched, false otherwise
   */
  checkAndSwitchStrategy(positionId: string, currentPrice: bigint, entryPrice: bigint): boolean {
    const currentMode = this.exitModes.get(positionId);
    if (!currentMode || currentMode !== 'FOLLOW_INSIDER') {
      // Already in TRAILING_STOP mode or position not found
      return false;
    }

    // Calculate profit percentage
    if (entryPrice === 0n) return false;
    
    const profitPct = Number((currentPrice - entryPrice) * 100n / entryPrice);
    
    // Check if profit exceeds threshold (100%)
    if (profitPct > PROFIT_SWITCH_THRESHOLD_PCT) {
      // Switch to TRAILING_STOP mode
      this.exitModes.set(positionId, 'TRAILING_STOP');
      
      // Update state to disable follow insider
      const state = this.positionStates.get(positionId);
      if (state) {
        state.followInsiderActive = false;
      }
      
      // Initialize/arm the trailing stop
      const trailingStop = this.trailingStops.get(positionId);
      if (trailingStop) {
        // Update trailing stop to current price to arm it
        trailingStop.update(currentPrice);
      }
      
      log.info(
        `Position ${positionId} switched from FOLLOW_INSIDER to TRAILING_STOP at ${profitPct.toFixed(2)}% profit`,
        {
          positionId,
          profitPct: profitPct.toFixed(2),
          currentPrice: currentPrice.toString(),
          entryPrice: entryPrice.toString(),
          previousMode: 'FOLLOW_INSIDER',
          newMode: 'TRAILING_STOP',
        }
      );
      
      // Emit event for strategy switch
      this.emit('strategySwitched', {
        positionId,
        fromMode: 'FOLLOW_INSIDER' as ExitMode,
        toMode: 'TRAILING_STOP' as ExitMode,
        profitPct,
        reason: 'PROFIT_THRESHOLD_EXCEEDED',
      });
      
      return true;
    }
    
    return false;
  }

  /**
   * Update trailing stop for a position (used when manually switching modes)
   * @param positionId - The position ID
   * @param currentPrice - Current token price
   * @param entryPrice - Entry price
   */
  updateTrailingStop(positionId: string, currentPrice: bigint, entryPrice: bigint): void {
    const trailingStop = this.trailingStops.get(positionId);
    if (trailingStop) {
      trailingStop.update(currentPrice);
      log.debug('Trailing stop updated', {
        positionId,
        currentPrice: currentPrice.toString(),
        isActive: trailingStop.isActive(),
        stopLevel: trailingStop.getStopLevel()?.toString() ?? 'none',
      });
    }
  }

  getMonitoredPositions(): CopyPosition[] {
    return Array.from(this.positionStates.values()).map(s => s.position);
  }

  getPositionState(positionId: string): PositionState | null {
    return this.positionStates.get(positionId) ?? null;
  }

  /**
   * Record an exit event for a closed position (Requirement 6.11).
   * Creates an ExitRecord with all exit details and persists it.
   * Emits 'exit' event with the recorded data.
   * 
   * @param position - The closed position
   * @param exitReason - Reason for the exit
   * @param exitPrice - Exit price as bigint
   * @param txHash - Optional transaction hash
   * @returns The created ExitRecord
   */
  recordExit(
    position: CopyPosition,
    exitReason: ExitReason,
    exitPrice: bigint,
    txHash?: string
  ): ExitRecord {
    const now = Date.now();
    const entryPriceNum = Number(position.entryPrice);
    const exitPriceNum = Number(exitPrice);
    
    // Calculate PnL: (exitPrice - entryPrice) / entryPrice * positionSize
    const pnlUsdc = entryPriceNum > 0
      ? position.positionSizeUsdc * ((exitPriceNum - entryPriceNum) / entryPriceNum)
      : -position.positionSizeUsdc;
    
    // Calculate PnL percentage: (exit - entry) / entry * 100
    const pnlPct = entryPriceNum > 0
      ? ((exitPriceNum - entryPriceNum) / entryPriceNum) * 100
      : -100;
    
    // Calculate duration
    const duration = position.closedAt 
      ? position.closedAt - position.openedAt
      : now - position.openedAt;
    
    const exitRecord: ExitRecord = {
      positionId: position.id,
      exitReason,
      exitPrice: exitPriceNum,
      entryPrice: entryPriceNum,
      pnlUsdc,
      pnlPct,
      duration,
      exitTimestamp: position.closedAt ?? now,
      exitTxHash: txHash,
    };
    
    // Store the exit record
    this.exitRecords.push(exitRecord);
    
    log.info('Exit recorded', {
      positionId: position.id,
      exitReason,
      pnlUsdc: pnlUsdc.toFixed(2),
      pnlPct: pnlPct.toFixed(2),
      duration,
      hasTxHash: !!txHash,
    });
    
    // Emit 'exitRecorded' event for persistence layer
    this.emit('exitRecorded', exitRecord);
    
    return exitRecord;
  }

  /**
   * Get exit history for a specific position or all positions (Requirement 6.11).
   * 
   * @param positionId - Optional position ID to filter by
   * @returns Array of ExitRecord entries
   */
  getExitHistory(positionId?: string): ExitRecord[] {
    if (positionId) {
      return this.exitRecords.filter(record => record.positionId === positionId);
    }
    return [...this.exitRecords];
  }

  /**
   * Get exits grouped by reason (Requirement 6.11).
   * 
   * @param reason - The exit reason to filter by
   * @returns Array of ExitRecord entries matching the reason
   */
  getExitsByReason(reason: ExitReason): ExitRecord[] {
    return this.exitRecords.filter(record => record.exitReason === reason);
  }

  /**
   * Get exit records summary by reason.
   * Returns count and total PnL for each exit reason.
   */
  getExitsSummaryByReason(): Record<ExitReason, { count: number; totalPnlUsdc: number }> {
    const summary: Record<ExitReason, { count: number; totalPnlUsdc: number }> = {
      TP_HIT: { count: 0, totalPnlUsdc: 0 },
      SL_HIT: { count: 0, totalPnlUsdc: 0 },
      TRAILING_STOP: { count: 0, totalPnlUsdc: 0 },
      TIME_STOP: { count: 0, totalPnlUsdc: 0 },
      FOLLOW_INSIDER: { count: 0, totalPnlUsdc: 0 },
      FORCED_CLOSE: { count: 0, totalPnlUsdc: 0 },
      FORCED_DRAWDOWN: { count: 0, totalPnlUsdc: 0 },
      RUG_PULL: { count: 0, totalPnlUsdc: 0 },
    };
    
    for (const record of this.exitRecords) {
      summary[record.exitReason].count++;
      summary[record.exitReason].totalPnlUsdc += record.pnlUsdc;
    }
    
    return summary;
  }

  /**
   * Get comprehensive exit statistics (Requirement 6.11).
   * Returns summary statistics for all recorded exits including:
   * - Total exits count
   * - Exits breakdown by reason (count per ExitReason)
   * - Average profit/loss in USDC
   * - Win rate (percentage of exits with profit > 0)
   * - Average hold duration in milliseconds
   * 
   * @returns Exit statistics object
   */
  getExitStats(): {
    totalExits: number;
    exitsByReason: Record<ExitReason, number>;
    averagePnlUsdc: number;
    winRate: number;
    averageHoldDurationMs: number;
    totalPnlUsdc: number;
    bestExit: ExitRecord | null;
    worstExit: ExitRecord | null;
  } {
    const totalExits = this.exitRecords.length;
    
    // Initialize exits by reason counts
    const exitsByReason: Record<ExitReason, number> = {
      TP_HIT: 0,
      SL_HIT: 0,
      TRAILING_STOP: 0,
      TIME_STOP: 0,
      FOLLOW_INSIDER: 0,
      FORCED_CLOSE: 0,
      FORCED_DRAWDOWN: 0,
      RUG_PULL: 0,
    };
    
    if (totalExits === 0) {
      return {
        totalExits: 0,
        exitsByReason,
        averagePnlUsdc: 0,
        winRate: 0,
        averageHoldDurationMs: 0,
        totalPnlUsdc: 0,
        bestExit: null,
        worstExit: null,
      };
    }
    
    let totalPnlUsdc = 0;
    let totalDurationMs = 0;
    let winCount = 0;
    let bestExit: ExitRecord | null = null;
    let worstExit: ExitRecord | null = null;
    
    for (const record of this.exitRecords) {
      // Count by reason
      exitsByReason[record.exitReason]++;
      
      // Sum PnL
      totalPnlUsdc += record.pnlUsdc;
      
      // Sum duration
      totalDurationMs += record.duration;
      
      // Count wins (profit > 0)
      if (record.pnlUsdc > 0) {
        winCount++;
      }
      
      // Track best exit
      if (bestExit === null || record.pnlUsdc > bestExit.pnlUsdc) {
        bestExit = record;
      }
      
      // Track worst exit
      if (worstExit === null || record.pnlUsdc < worstExit.pnlUsdc) {
        worstExit = record;
      }
    }
    
    const averagePnlUsdc = totalPnlUsdc / totalExits;
    const winRate = (winCount / totalExits) * 100;
    const averageHoldDurationMs = totalDurationMs / totalExits;
    
    return {
      totalExits,
      exitsByReason,
      averagePnlUsdc,
      winRate,
      averageHoldDurationMs,
      totalPnlUsdc,
      bestExit,
      worstExit,
    };
  }

  /**
   * Clear all exit records (mainly for testing).
   */
  clearExitHistory(): void {
    this.exitRecords.length = 0;
    log.debug('Exit history cleared');
  }

  // Test helper methods for rug pull detection (Task 17.8)
  getQuoteFailureCount(positionId: string): number {
    const state = this.positionStates.get(positionId);
    return state?.quoteFailCount ?? 0;
  }

  _incrementQuoteFailureCount(positionId: string): void {
    const state = this.positionStates.get(positionId);
    if (state) {
      state.quoteFailCount++;
    }
  }

  _resetQuoteFailureCount(positionId: string): void {
    const state = this.positionStates.get(positionId);
    if (state) {
      state.quoteFailCount = 0;
    }
  }

  async _processRugPullIfNeeded(positionId: string): Promise<boolean> {
    const state = this.positionStates.get(positionId);
    if (!state) return false;
    
    if (state.quoteFailCount >= RUG_PULL_QUOTE_FAIL_THRESHOLD) {
      await this.closePosition(state, 'RUG_PULL', 0n);
      return true;
    }
    return false;
  }

  async forceClose(positionId: string, reason: ExitReason = 'FORCED_CLOSE'): Promise<boolean> {
    const state = this.positionStates.get(positionId);
    if (!state) {
      log.warn('Position not found for force close', { positionId });
      return false;
    }
    const exitPrice = await this.getCurrentPriceSafe(state);
    await this.closePosition(state, reason, exitPrice);
    return true;
  }

  private async monitorLoop(): Promise<void> {
    if (!this.running || this.positionStates.size === 0) return;
    const now = Date.now();
    
    for (const [id, state] of this.positionStates) {
      try {
        await this.checkPosition(state, now);
      } catch (err) {
        log.error('Error checking position', {
          positionId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async checkPosition(state: PositionState, now: number): Promise<void> {
    const position = state.position;
    
    // 0. Check for automatic switch to trailing stop if insider doesn't sell in 24h (Req 6.3)
    if (state.followInsiderActive) {
      const timeSinceOpen = now - position.openedAt;
      if (timeSinceOpen >= this.config.strategyConfig.followInsider.maxWaitMs) {
        state.followInsiderActive = false;
        // Also update the exit mode (Task 17.10)
        this.exitModes.set(position.id, 'TRAILING_STOP');
        log.info('Switched to trailing stop mode - insider did not sell within max wait time', {
          positionId: position.id,
          maxWaitMs: this.config.strategyConfig.followInsider.maxWaitMs,
          timeSinceOpenMs: timeSinceOpen,
        });
        this.emit('switchedToTrailingStop', { positionId: position.id, timeSinceOpenMs: timeSinceOpen });
        this.emit('strategySwitched', {
          positionId: position.id,
          fromMode: 'FOLLOW_INSIDER' as ExitMode,
          toMode: 'TRAILING_STOP' as ExitMode,
          reason: 'TIMEOUT_24H',
        });
      }
    }
    
    // 1. Check time stop first (highest priority after manual close)
    if (this.checkTimeStop(position, now)) {
      const exitPrice = await this.getCurrentPriceSafe(state);
      await this.closePosition(state, 'TIME_STOP', exitPrice);
      return;
    }

    // 2. Get current price
    let currentPrice: bigint;
    try {
      currentPrice = await this.getCurrentPrice(state);
      state.quoteFailCount = 0;
      state.lastQuoteAt = now;
    } catch (err) {
      state.quoteFailCount++;
      log.warn('Quote failed', { positionId: position.id, failCount: state.quoteFailCount });
      if (state.quoteFailCount >= RUG_PULL_QUOTE_FAIL_THRESHOLD) {
        await this.closePosition(state, 'RUG_PULL', 0n);
      }
      return;
    }

    // Update highest price
    if (currentPrice > state.highestPrice) {
      state.highestPrice = currentPrice;
    }

    // 2.5. Check for automatic switch to trailing stop on profit >100% (Task 17.10, Req 6.2)
    this.checkAndSwitchStrategy(position.id, currentPrice, position.entryPrice);

    // 3. Check take profit (Req 6.1)
    if (this.checkTakeProfit(position, currentPrice)) {
      await this.closePosition(state, 'TP_HIT', currentPrice);
      return;
    }

    // 4. Update and check trailing stop (Req 6.4-6.7)
    const trailingStop = this.trailingStops.get(position.id);
    if (trailingStop) {
      trailingStop.update(currentPrice);
      state.trailingStopActive = trailingStop.isActive();
      
      if (trailingStop.shouldTrigger(currentPrice)) {
        await this.closePosition(state, 'TRAILING_STOP', currentPrice);
        return;
      }
    }

    // 5. Check stop loss (only if trailing stop not active - Req 6.1)
    if (!state.trailingStopActive && this.checkStopLoss(position, currentPrice)) {
      await this.closePosition(state, 'SL_HIT', currentPrice);
      return;
    }
  }

  private checkTimeStop(position: CopyPosition, now: number): boolean {
    return now >= position.timeStop;
  }

  private checkTakeProfit(position: CopyPosition, currentPrice: bigint): boolean {
    return currentPrice >= position.takeProfit;
  }

  private checkStopLoss(position: CopyPosition, currentPrice: bigint): boolean {
    return currentPrice <= position.stopLoss;
  }

  private async getCurrentPrice(state: PositionState): Promise<bigint> {
    return await this.config.dexQuoter.quote({
      tokenIn: state.position.tokenAddress,
      tokenOut: USDC_ADDRESS,
      amountIn: 10n ** 18n,
      poolAddress: state.position.poolAddress,
    });
  }

  private async getCurrentPriceSafe(state: PositionState): Promise<bigint> {
    try {
      return await this.getCurrentPrice(state);
    } catch {
      return state.position.entryPrice;
    }
  }

  private async closePosition(
    state: PositionState,
    reason: ExitReason,
    exitPrice: bigint
  ): Promise<void> {
    const position = state.position;
    const now = Date.now();
    const holdingTimeMs = now - position.openedAt;
    const pnlUsdc = this.calculatePnl(position, exitPrice);

    // Update position - map FORCED_DRAWDOWN to FORCED_CLOSE for valid status
    const validStatus = reason === 'FORCED_DRAWDOWN' ? 'FORCED_CLOSE' as const : reason;
    position.status = validStatus as CopyPosition['status'];
    position.closedAt = now;
    position.exitPrice = exitPrice;
    position.pnlUsdc = pnlUsdc;
    position.exitReason = reason;

    // Update stats
    this.stats.exitsByReason[reason]++;
    this.stats.totalExits++;
    this.stats.totalHoldingTimeMs += holdingTimeMs;
    this.stats.totalPnlUsdc += pnlUsdc;

    // Remove from monitored
    this.positionStates.delete(position.id);
    this.trailingStops.delete(position.id);
    this.exitModes.delete(position.id); // Clean up exit mode (Task 17.10)

    log.info('Position closed', {
      positionId: position.id,
      reason,
      pnlUsdc,
      holdingTimeMs,
    });

    // Record the exit (Requirement 6.11)
    const exitRecord = this.recordExit(position, reason, exitPrice);

    // Emit event
    const exitEvent: ExitEvent = {
      positionId: position.id,
      reason,
      exitPrice,
      pnlUsdc,
      exitedAt: now,
      position,
    };
    this.emit('exit', exitEvent);

    // Call callback if provided
    if (this.config.onPositionClosed) {
      this.config.onPositionClosed(position, reason, pnlUsdc);
    }
  }

  private calculatePnl(position: CopyPosition, exitPrice: bigint): number {
    if (exitPrice === 0n) return -position.positionSizeUsdc;
    const entry = Number(position.entryPrice);
    const exit = Number(exitPrice);
    return position.positionSizeUsdc * ((exit - entry) / entry);
  }
}

// Factory function for ExitManager
export function createExitManager(
  dexQuoter: IDexQuoter,
  partialConfig?: Partial<Omit<ExitManagerConfig, 'dexQuoter' | 'strategyConfig'>> & {
    strategyConfig?: Partial<ExitStrategyConfig>;
  }
): ExitManager {
  const defaultStrategy = createDefaultExitStrategyConfig();
  
  const config: ExitManagerConfig = {
    dexQuoter,
    strategyConfig: {
      ...defaultStrategy,
      ...partialConfig?.strategyConfig,
      followInsider: {
        ...defaultStrategy.followInsider,
        ...partialConfig?.strategyConfig?.followInsider,
      },
      trailingStop: {
        ...defaultStrategy.trailingStop,
        ...partialConfig?.strategyConfig?.trailingStop,
      },
      fixedExits: {
        ...defaultStrategy.fixedExits,
        ...partialConfig?.strategyConfig?.fixedExits,
      },
    },
    monitoringIntervalMs: partialConfig?.monitoringIntervalMs ?? DEFAULT_MONITORING_INTERVAL_MS,
    onPositionClosed: partialConfig?.onPositionClosed,
  };
  
  return new ExitManager(config);
}

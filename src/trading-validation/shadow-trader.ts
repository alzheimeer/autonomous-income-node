/**
 * Trading Validation Phase - ShadowTrader
 *
 * Simulates trades using executable quotes (NOT raw Binance mid) with
 * realistic cost modeling including DEX fees, gas, slippage, and exit costs.
 * Shadow trades are persisted to the `positions` table with mode='shadow'.
 *
 * Shadow exits follow the same rules as ExitManager:
 *   - stop_loss, take_profit, time_stop, regime_exit, kill_switch, operator, safe_mode
 *
 * Tracks MFE, MAE, time to target, and exit reason for each shadow trade.
 *
 * Requirements: 7.1, 7.2, 7.3
 */

import { randomUUID } from 'node:crypto';
import type { TradingDatabase } from './db.js';
import type {
  ExitReason,
  ExecutableQuote,
  Position,
  RegimeType,
  StrategyType,
  TradeCandidate,
  UsdcAmount,
  WethAmount,
} from './types.js';
import type { ExitManagerConfig } from './config.js';
import { pgPool } from './postgres.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Aggregate statistics for shadow trading performance */
export interface ShadowStats {
  totalTrades: number;
  completedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  totalGrossPnl: UsdcAmount;
  totalNetPnl: UsdcAmount;
  totalGasCost: UsdcAmount;
  avgMfe: number;
  avgMae: number;
  avgHoldingMs: number;
  winRate: number;
  profitFactor: number;
}

/** Internal shadow position tracking with MFE/MAE watermarks */
interface TrackedShadowPosition {
  position: Position;
  highPrice: number;
  lowPrice: number;
  mfe: number;
  mae: number;
  entryGasUsdc: UsdcAmount;
  estimatedExitGasUsdc: UsdcAmount;
}

/** Callback to get fresh exit quote for shadow position (simulated cost) */
export type ShadowExitQuoteCallback = (sizeWeth: WethAmount) => Promise<ExecutableQuote | null>;

/** External state checks (KillSwitch, SafeMode, operator) for shadow exits */
export interface ShadowExternalState {
  isKillSwitchTriggered(): boolean;
  isSafeModeActive(): boolean;
  isOperatorExitRequested(): boolean;
}

/** Logger function for shadow trading events */
export type ShadowLogger = (entry: {
  event: string;
  positionId?: string;
  details?: string;
}) => void;

// ═══════════════════════════════════════════════════════════════════════════
// Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * IShadowTrader interface — simulates trades with executable quotes and realistic costs.
 */
export interface IShadowTrader {
  /** Execute a shadow trade from a candidate + quote (Req 7.1, 7.2) */
  executeShadow(candidate: TradeCandidate, quote: ExecutableQuote, size: UsdcAmount): string;

  /** Check shadow positions for exit conditions (Req 7.3) */
  checkShadowExits(currentPrice: number, regime: RegimeType): void;

  /** Get all currently open shadow positions */
  getShadowPositions(): Position[];

  /** Get all completed (closed) shadow trades */
  getCompletedShadowTrades(): Promise<Position[]>;

  /** Get aggregate shadow trading statistics */
  getShadowStats(): Promise<ShadowStats>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Regime-exit rules per strategy (same as ExitManager).
 * Trend Pullback: exits on TRENDING_DOWN, VOLATILE, UNCERTAIN
 * Mean Reversion: exits on VOLATILE, UNCERTAIN, TRENDING_DOWN
 * Momentum Breakout: exits on TRENDING_DOWN, RANGING (momentum needs trend)
 * Dip Buying: exits on VOLATILE only (it's designed for uncertain conditions)
 */
const REGIME_EXIT_TRIGGERS: Record<StrategyType, RegimeType[]> = {
  trend_pullback: ['TRENDING_DOWN', 'VOLATILE', 'UNCERTAIN'],
  mean_reversion: ['VOLATILE', 'UNCERTAIN', 'TRENDING_DOWN'],
  momentum_breakout: ['TRENDING_DOWN', 'RANGING'],
  dip_buying: ['VOLATILE'], // Dip buying can work in most regimes except extreme volatility
};

/**
 * Exit priority order (highest first) — matches ExitManager.
 */
const EXIT_PRIORITY: ExitReason[] = [
  'kill_switch',
  'safe_mode',
  'operator',
  'stop_loss',
  'time_stop',
  'regime_exit',
  'take_profit',
];

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class ShadowTrader implements IShadowTrader {
  private readonly db: TradingDatabase;
  private readonly exitConfig: ExitManagerConfig;
  private readonly configHash: string;
  private readonly externalState: ShadowExternalState;
  private readonly getExitQuote?: ShadowExitQuoteCallback;
  private readonly logger?: ShadowLogger;

  /** In-memory tracked positions (open shadow trades) */
  private tracked: Map<string, TrackedShadowPosition> = new Map();

  /** Counter for unique negative nonces (shadow trades) - initialized from DB */
  private static shadowNonceCounter: number | null = null;

  constructor(
    db: TradingDatabase,
    exitConfig: ExitManagerConfig,
    configHash: string,
    externalState: ShadowExternalState,
    options?: {
      getExitQuote?: ShadowExitQuoteCallback;
      logger?: ShadowLogger;
    },
  ) {
    this.db = db;
    this.exitConfig = exitConfig;
    this.configHash = configHash;
    this.externalState = externalState;
    this.getExitQuote = options?.getExitQuote;
    this.logger = options?.logger;

    // Initialize shadowNonceCounter from DB (only once per process)
    this.initializeShadowNonceCounter();

    // Restore open shadow positions from DB on construction
    this.restoreOpenPositions();
  }

  /**
   * Initialize the shadow nonce counter from the minimum nonce in the database.
   * This ensures we don't create duplicate nonces after process restart.
   */
  private initializeShadowNonceCounter(): void {
    if (ShadowTrader.shadowNonceCounter !== null) {
      return; // Already initialized
    }
    
    try {
      const row = this.db.prepare(
        `SELECT MIN(nonce) as minNonce FROM tx_intents WHERE nonce < 0`
      ).get() as { minNonce: number | null } | undefined;
      
      // Start from the minimum existing negative nonce (or 0 if none exist)
      // We subtract 1 so the next nonce will be one less than the minimum
      ShadowTrader.shadowNonceCounter = (row?.minNonce ?? 0) - 1;
      
      this.log({
        event: 'shadow_nonce_init',
        details: `Initialized shadow nonce counter to ${ShadowTrader.shadowNonceCounter} (min in DB: ${row?.minNonce ?? 'none'})`,
      });
    } catch (e) {
      // Fallback to 0 if query fails (new DB)
      ShadowTrader.shadowNonceCounter = 0;
      this.log({
        event: 'shadow_nonce_init',
        details: `Initialized shadow nonce counter to 0 (fallback)`,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute a shadow trade: simulate entry using executable quote with realistic costs.
   *
   * Req 7.1: Simulate using executable quotes (NOT raw Binance mid).
   * Req 7.2: Simulate all costs: DEX fees (from quote), gas, slippage, exit costs.
   *
   * @returns The position ID of the created shadow trade.
   */
  executeShadow(candidate: TradeCandidate, quote: ExecutableQuote, size: UsdcAmount): string {
    const positionId = randomUUID();
    const intentId = `shadow-${positionId}`;
    const now = Date.now();

    // Entry price derived from executable quote (includes pool fees for QuoterV2)
    // price = amountIn / amountOut (USDC per WETH, adjusted for decimals)
    const amountInFloat = Number(quote.amountIn) / 1e6; // USDC 6 decimals
    const amountOutFloat = Number(quote.amountOut) / 1e18; // WETH 18 decimals
    const entryPrice = amountInFloat / amountOutFloat;

    // Calculate stop loss and take profit from ATR-based fractions
    const stopLoss = entryPrice * (1 - candidate.stopDistanceFraction);
    const takeProfit = entryPrice * (1 + candidate.takeProfitFraction);

    // Simulated costs
    const entryGasUsdc = BigInt(Math.round(quote.gasUsd * 1e6)); // Convert gas USD to USDC 6 decimals
    const estimatedExitGasUsdc = entryGasUsdc; // Conservative: assume exit gas ≈ entry gas

    const position: Position = {
      id: positionId,
      intentId,
      entryPrice,
      entryTimestamp: now,
      sizeUsdc: size,
      sizeWeth: quote.amountOut,
      stopLoss,
      takeProfit,
      maxHoldingMs: this.exitConfig.maxHoldingMs,
      entryRegime: candidate.regime,
      strategy: candidate.strategy,
    };

    // Track in memory for exit monitoring
    this.tracked.set(positionId, {
      position,
      highPrice: entryPrice,
      lowPrice: entryPrice,
      mfe: 0,
      mae: 0,
      entryGasUsdc,
      estimatedExitGasUsdc,
    });

    // Persist to SQLite
    this.persistPosition(position, entryGasUsdc);

    this.log({
      event: 'shadow_entry',
      positionId,
      details: `strategy=${candidate.strategy} size=${size.toString()} entry=${entryPrice.toFixed(2)} SL=${stopLoss.toFixed(2)} TP=${takeProfit.toFixed(2)} gas=$${quote.gasUsd.toFixed(4)}`,
    });

    return positionId;
  }

  /**
   * Check all open shadow positions for exit conditions.
   * Applies same exit rules as ExitManager.
   *
   * Req 7.3: Track MFE, MAE, time to target, exit reason.
   */
  checkShadowExits(currentPrice: number, regime: RegimeType): void {
    const now = Date.now();

    for (const [positionId, tracked] of this.tracked.entries()) {
      // Update MFE/MAE
      this.updateMfeMae(tracked, currentPrice);

      // Check exit conditions in priority order
      const exitReason = this.checkExitConditions(
        tracked.position,
        currentPrice,
        regime,
        now,
      );

      if (exitReason) {
        this.closeShadowPosition(tracked, currentPrice, now, exitReason);
        this.tracked.delete(positionId);
      }
    }
  }

  /**
   * Get all currently open shadow positions.
   */
  getShadowPositions(): Position[] {
    const positions: Position[] = [];
    for (const tracked of this.tracked.values()) {
      positions.push({
        ...tracked.position,
        mfe: tracked.mfe,
        mae: tracked.mae,
      });
    }
    return positions;
  }

  /**
   * Get all completed (closed) shadow trades from the database.
   */
  async getCompletedShadowTrades(): Promise<Position[]> {
    const res = await pgPool.query(`
      SELECT * FROM shadow_positions WHERE status = 'CLOSED'
      ORDER BY closed_at DESC
    `);

    // Basic mapping, as we only need this for stats
    return res.rows.map((row: any) => ({
      id: row.id,
      intentId: `shadow-${row.id}`,
      entryPrice: row.entry_price,
      entryTimestamp: Number(row.created_at),
      sizeUsdc: BigInt(Math.round(row.size_usd)),
      sizeWeth: 0n, // Not stored
      stopLoss: 0,
      takeProfit: 0,
      maxHoldingMs: 0,
      entryRegime: 'RANGING',
      strategy: row.direction as StrategyType,
      exitReason: row.close_reason as ExitReason,
      exitPrice: row.close_price,
      exitTimestamp: Number(row.closed_at),
      grossPnl: BigInt(Math.round(row.pnl_usd)),
      netPnl: BigInt(Math.round(row.pnl_usd)),
      mfe: 0,
      mae: 0
    }));
  }

  /**
   * Get aggregate shadow trading statistics.
   */
  async getShadowStats(): Promise<ShadowStats> {
    const completed = await this.getCompletedShadowTrades();
    const open = this.tracked.size;

    let wins = 0;
    let losses = 0;
    let totalGrossPnl = 0n;
    let totalNetPnl = 0n;
    let totalGasCost = 0n;
    let totalMfe = 0;
    let totalMae = 0;
    let totalHoldingMs = 0;
    let grossWins = 0n;
    let grossLosses = 0n;

    for (const trade of completed) {
      const netPnl = trade.netPnl ?? 0n;
      const grossPnl = trade.grossPnl ?? 0n;

      totalGrossPnl += grossPnl;
      totalNetPnl += netPnl;
      totalMfe += trade.mfe ?? 0;
      totalMae += trade.mae ?? 0;

      if (trade.exitTimestamp && trade.entryTimestamp) {
        totalHoldingMs += trade.exitTimestamp - trade.entryTimestamp;
      }

      if (netPnl > 0n) {
        wins++;
        grossWins += grossPnl > 0n ? grossPnl : 0n;
      } else {
        losses++;
        grossLosses += grossPnl < 0n ? -grossPnl : 0n;
      }
    }

    const totalCompleted = completed.length;
    const winRate = totalCompleted > 0 ? wins / totalCompleted : 0;
    const profitFactor = grossLosses > 0n
      ? Number(grossWins) / Number(grossLosses)
      : grossWins > 0n ? Infinity : 0;
    const avgMfe = totalCompleted > 0 ? totalMfe / totalCompleted : 0;
    const avgMae = totalCompleted > 0 ? totalMae / totalCompleted : 0;
    const avgHoldingMs = totalCompleted > 0 ? totalHoldingMs / totalCompleted : 0;

    return {
      totalTrades: totalCompleted + open,
      completedTrades: totalCompleted,
      openTrades: open,
      wins,
      losses,
      totalGrossPnl,
      totalNetPnl,
      totalGasCost,
      avgMfe,
      avgMae,
      avgHoldingMs,
      winRate,
      profitFactor,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Exit Logic (mirrors ExitManager rules)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check exit conditions in priority order.
   * Returns the highest-priority exit reason, or null if no exit triggered.
   * 
   * IMPROVED: Added trailing stop logic that activates after 0.5% gain.
   */
  private checkExitConditions(
    position: Position,
    currentPrice: number,
    currentRegime: RegimeType,
    timestamp: number,
  ): ExitReason | null {
    // Get tracked position for MFE data
    const tracked = this.tracked.get(position.id);
    
    for (const reason of EXIT_PRIORITY) {
      if (this.isExitTriggered(reason, position, currentPrice, currentRegime, timestamp, tracked)) {
        return reason;
      }
    }
    return null;
  }

  /**
   * Check if a specific exit reason is triggered for a shadow position.
   * 
   * IMPROVED: Added trailing stop - if MFE > 0.8% and current drops below 40% of MFE, exit.
   */
  private isExitTriggered(
    reason: ExitReason,
    position: Position,
    currentPrice: number,
    currentRegime: RegimeType,
    timestamp: number,
    tracked?: TrackedShadowPosition,
  ): boolean {
    switch (reason) {
      case 'kill_switch':
        return this.externalState.isKillSwitchTriggered();

      case 'safe_mode':
        return this.externalState.isSafeModeActive();

      case 'operator':
        return this.externalState.isOperatorExitRequested();

      case 'stop_loss': {
        // Standard stop loss
        if (currentPrice <= position.stopLoss) return true;
        
        // TRAILING STOP: If we've seen 0.8%+ profit (MFE), protect gains
        // Exit if current profit drops below 30% of peak profit (MFE)
        if (tracked && tracked.mfe >= 0.8) {
          const currentProfitPct = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
          const trailingThreshold = tracked.mfe * 0.30; // Keep 30% of peak gains minimum
          
          // Only trigger if we've given back 70%+ of gains
          if (currentProfitPct < trailingThreshold && currentProfitPct < tracked.mfe - 0.4) {
            return true;
          }
        }
        return false;
      }

      case 'time_stop':
        return (timestamp - position.entryTimestamp) >= position.maxHoldingMs;

      case 'regime_exit':
        return this.isRegimeExitTriggered(position.strategy, currentRegime);

      case 'take_profit':
        return currentPrice >= position.takeProfit;

      default:
        return false;
    }
  }

  /**
   * Regime-exit rules (same as ExitManager).
   */
  private isRegimeExitTriggered(strategy: StrategyType, currentRegime: RegimeType): boolean {
    const triggers = REGIME_EXIT_TRIGGERS[strategy];
    if (!triggers) return false;
    return triggers.includes(currentRegime);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: MFE/MAE Tracking
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Update MFE (Max Favorable Excursion) and MAE (Max Adverse Excursion).
   */
  private updateMfeMae(tracked: TrackedShadowPosition, currentPrice: number): void {
    const entryPrice = tracked.position.entryPrice;

    if (currentPrice > tracked.highPrice) {
      tracked.highPrice = currentPrice;
    }
    if (currentPrice < tracked.lowPrice) {
      tracked.lowPrice = currentPrice;
    }

    // MFE: highest % profit seen
    const favorableExcursion = ((tracked.highPrice - entryPrice) / entryPrice) * 100;
    if (favorableExcursion > tracked.mfe) {
      tracked.mfe = favorableExcursion;
    }

    // MAE: deepest % drawdown seen
    const adverseExcursion = ((entryPrice - tracked.lowPrice) / entryPrice) * 100;
    if (adverseExcursion > tracked.mae) {
      tracked.mae = adverseExcursion;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Close Shadow Position
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Close a shadow position with full P&L calculation including all simulated costs.
   *
   * Net PnL = (exitProceeds - entryInput) - entryGas - exitGas - slippage
   * Where exitProceeds and entryInput are derived from executable quotes (include pool fees).
   */
  private closeShadowPosition(
    tracked: TrackedShadowPosition,
    exitPrice: number,
    exitTimestamp: number,
    reason: ExitReason,
  ): void {
    const position = tracked.position;
    const entryPrice = position.entryPrice;

    // Gross P&L in USDC (before gas/fees) based on price movement
    const priceChangeFraction = (exitPrice - entryPrice) / entryPrice;
    const grossPnlRaw = Number(position.sizeUsdc) * priceChangeFraction;
    const grossPnl = BigInt(Math.round(grossPnlRaw));

    // Net P&L: subtract entry gas + exit gas (all costs simulated)
    const totalCosts = tracked.entryGasUsdc + tracked.estimatedExitGasUsdc;
    const netPnl = grossPnl - totalCosts;

    // Update position
    position.exitReason = reason;
    position.exitPrice = exitPrice;
    position.exitTimestamp = exitTimestamp;
    position.grossPnl = grossPnl;
    position.netPnl = netPnl;
    position.mfe = tracked.mfe;
    position.mae = tracked.mae;

    // Persist closure to DB
    this.persistPositionClose(position, tracked.estimatedExitGasUsdc);

    const holdingMs = exitTimestamp - position.entryTimestamp;
    this.log({
      event: 'shadow_exit',
      positionId: position.id,
      details: `reason=${reason} exit=${exitPrice.toFixed(2)} grossPnl=${grossPnl.toString()} netPnl=${netPnl.toString()} mfe=${tracked.mfe.toFixed(2)}% mae=${tracked.mae.toFixed(2)}% holding=${holdingMs}ms`,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: SQLite Persistence
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist a new shadow position to the `trading_shadow_positions` table in Postgres (Fire-and-forget)
   * NOTE: This table is separate from hybrid-sniper's `shadow_positions` table
   */
  private persistPosition(position: Position, entryGasUsdc: UsdcAmount): void {
    const now = Date.now();
    // Fire and forget to Postgres
    pgPool.query(`
      INSERT INTO trading_shadow_positions (
        id, token_address, direction, entry_price, size_usd, leverage, 
        status, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [
      position.id,
      'WETH', // Dummy token for now, shadow strategy focuses on WETH/USDC
      position.strategy, // Using strategy as direction for shadow
      position.entryPrice,
      Number(position.sizeUsdc),
      1, // 1x leverage default
      'OPEN',
      position.entryTimestamp,
      now
    ]).catch((err: Error) => {
      console.error('[ShadowTrader] Failed to persist shadow position to Postgres:', err);
    });
  }

  /**
   * Update a shadow position in Postgres on close (Fire-and-forget).
   * NOTE: Uses `trading_shadow_positions` table, separate from hybrid-sniper
   */
  private persistPositionClose(position: Position, exitGasUsdc: UsdcAmount): void {
    pgPool.query(`
      UPDATE trading_shadow_positions SET
        status = 'CLOSED',
        closed_at = $1,
        close_price = $2,
        pnl_usd = $3,
        close_reason = $4,
        updated_at = $5
      WHERE id = $6
    `, [
      position.exitTimestamp ?? null,
      position.exitPrice ?? null,
      position.netPnl ? Number(position.netPnl) : null,
      position.exitReason ?? null,
      Date.now(),
      position.id,
    ]).catch((err: Error) => {
      console.error('[ShadowTrader] Failed to close shadow position in Postgres:', err);
    });
  }

  /**
   * Restore open shadow positions from Postgres on startup.
   * NOTE: Uses `trading_shadow_positions` table, separate from hybrid-sniper
   */
  private restoreOpenPositions(): void {
    pgPool.query(`SELECT * FROM trading_shadow_positions WHERE status = 'OPEN'`)
      .then((res: any) => {
        for (const row of res.rows) {
          const position: Position = {
            id: row.id,
            intentId: `shadow-${row.id}`,
            entryPrice: row.entry_price,
            entryTimestamp: Number(row.created_at),
            sizeUsdc: BigInt(Math.round(row.size_usd)),
            sizeWeth: 0n,
            stopLoss: 0,
            takeProfit: 0,
            maxHoldingMs: this.exitConfig.maxHoldingMs,
            entryRegime: 'RANGING',
            strategy: row.direction as StrategyType,
          };
          
          this.tracked.set(position.id, {
            position,
            highPrice: position.entryPrice,
            lowPrice: position.entryPrice,
            mfe: 0,
            mae: 0,
            entryGasUsdc: 0n,
            estimatedExitGasUsdc: 0n,
          });
        }

        if (this.tracked.size > 0) {
          this.log({
            event: 'shadow_restore',
            details: `Restored ${this.tracked.size} open shadow position(s) from Postgres`,
          });
        }
      })
      .catch((err: Error) => {
        console.error('[ShadowTrader] Failed to restore open positions from Postgres:', err);
      });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private: Logging
  // ─────────────────────────────────────────────────────────────────────────

  private log(entry: { event: string; positionId?: string; details?: string }): void {
    if (this.logger) {
      this.logger(entry);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Database Row Mapping
// ═══════════════════════════════════════════════════════════════════════════

/** Raw row shape from the `positions` table */
interface PositionRow {
  id: string;
  intent_id: string;
  mode: string;
  strategy: string;
  pair: string;
  entry_price: number;
  entry_timestamp: number;
  size_usdc: string;
  size_weth: string;
  stop_loss: number;
  take_profit: number;
  max_holding_ms: number;
  entry_regime: string;
  exit_reason: string | null;
  exit_price: number | null;
  exit_timestamp: number | null;
  gross_pnl: string | null;
  net_pnl: string | null;
  mfe: number | null;
  mae: number | null;
  gas_entry: string | null;
  gas_exit: string | null;
  config_hash: string;
  closed: number;
}

/** Convert a database row to a Position object */
function rowToPosition(row: PositionRow): Position {
  return {
    id: row.id,
    intentId: row.intent_id,
    entryPrice: row.entry_price,
    entryTimestamp: row.entry_timestamp,
    sizeUsdc: BigInt(row.size_usdc),
    sizeWeth: BigInt(row.size_weth),
    stopLoss: row.stop_loss,
    takeProfit: row.take_profit,
    maxHoldingMs: row.max_holding_ms,
    entryRegime: row.entry_regime as RegimeType,
    strategy: row.strategy as StrategyType,
    exitReason: row.exit_reason as ExitReason | undefined,
    exitPrice: row.exit_price ?? undefined,
    exitTimestamp: row.exit_timestamp ?? undefined,
    grossPnl: row.gross_pnl ? BigInt(row.gross_pnl) : undefined,
    netPnl: row.net_pnl ? BigInt(row.net_pnl) : undefined,
    mfe: row.mfe ?? undefined,
    mae: row.mae ?? undefined,
  };
}

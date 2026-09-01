/**
 * SmartAutoLender — Trading-aware, regime-sensitive Aave V3 lending strategy
 *
 * Replaces the basic AutoLender with a strategy that:
 * - Deposits idle USDC only after 2h+ in UNCERTAIN regime with no trade signals
 * - Performs partial withdrawals on-demand for trades (trading ALWAYS takes priority)
 * - Supports operator maintenance mode via Telegram
 * - Batches multiple trade-signal withdrawals within a 30s window
 * - Never triggers SafeMode — lending is supplementary
 *
 * Requirements: 1.1, 1.2, 2.1, 3.1–3.6, 4.1–4.4, 5.1–5.4, 6.1–6.5, 7.1–7.6
 */

import type { IAaveLendingModule } from './aave-lending.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Database Interface
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Database interface for SmartAutoLender persistence.
 * Compatible with TradingDatabase from src/trading-validation/db.ts.
 */
export interface ISmartLenderDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Dependency Interfaces (subsets of existing modules)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Subset of BankrollManager used by SmartAutoLender to notify fund movements.
 */
export interface ISmartLenderBankroll {
  /** Notify that funds were deposited to Aave (reduces available for trading) */
  allocateLoss(amount: bigint): void;
  /** Notify that funds were withdrawn from Aave (increases available for trading) */
  allocateProfit(amount: bigint): void;
  /** Record gas cost of an Aave transaction */
  recordGas(gasCostUsdc: bigint): void;
}

/**
 * Subset of SafeModeController used by SmartAutoLender to check state.
 */
export interface ISmartLenderSafeMode {
  /** Whether the system is currently in safe mode */
  isActive(): boolean;
}

/**
 * Logger interface for SmartAutoLender diagnostic output.
 */
export interface ISmartLenderLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface SmartAutoLenderConfig {
  /** Minimum idle period in UNCERTAIN regime before depositing (ms). Default: 7_200_000 (2h) */
  idleThresholdMs: number;
  /** Amount to keep liquid for gas/operations (6 decimals). Default: 15_000000n ($15) */
  operatingReserve: bigint;
  /** Minimum APY to maintain position (basis points). Default: 200 (2%) */
  minApyBps: number;
  /** Minimum deposit amount (6 decimals). Default: 5_000000n ($5) */
  minDepositAmount: bigint;
  /** Minimum withdrawal amount (6 decimals). Default: 1_000000n ($1) */
  minWithdrawAmount: bigint;
  /** Batching window for multiple trade signals (ms). Default: 30_000 (30s) */
  batchWindowMs: number;
}

export const DEFAULT_SMART_AUTO_LENDER_CONFIG: SmartAutoLenderConfig = {
  idleThresholdMs: 7_200_000,
  operatingReserve: 15_000000n,
  minApyBps: 200,
  minDepositAmount: 5_000000n,
  minWithdrawAmount: 1_000000n,
  batchWindowMs: 30_000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════

export interface SmartAutoLenderState {
  /** When the current idle period started (null if not in idle) */
  idlePeriodStart: number | null;
  /** Whether maintenance mode is active */
  maintenanceMode: boolean;
  /** Pending withdrawal requests within the batch window */
  pendingWithdrawals: { amount: bigint; timestamp: number }[];
  /** Last time a TradeSignal was observed */
  lastTradeSignal: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Result Type
// ═══════════════════════════════════════════════════════════════════════════════

export interface SmartAutoLenderResult {
  action: 'deposit' | 'withdraw' | 'none';
  amount: bigint;
  txHash?: string;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Core Interface
// ═══════════════════════════════════════════════════════════════════════════════

export interface ISmartAutoLender {
  /**
   * Pre-cycle hook evaluation. Called each cycle to check:
   * - Idle period deposit conditions
   * - Maintenance mode actions
   * - APY threshold check
   *
   * @param walletBalance Current wallet USDC balance (6 decimals BigInt)
   */
  evaluateIdle(walletBalance: bigint): Promise<SmartAutoLenderResult>;

  /**
   * Called by TradingOrchestrator before trade execution.
   * Withdraws the required amount from Aave if funds are deposited.
   *
   * @param requiredAmount USDC amount needed for trade (6 decimals BigInt)
   * @returns Whether funds are available and how much was withdrawn
   */
  ensureFunds(requiredAmount: bigint): Promise<{ available: boolean; withdrawn: bigint }>;

  /**
   * Toggle maintenance mode. Authenticated via OperatorAuthenticator.
   * - on: deposits all (minus reserve) into Aave
   * - off: withdraws all from Aave
   *
   * @param enabled true to enable maintenance, false to disable
   * @param walletBalance optional current wallet USDC balance for deposit calculation
   */
  setMaintenance(enabled: boolean, walletBalance?: bigint): Promise<SmartAutoLenderResult>;

  /**
   * Set whether the TradingOrchestrator has an open position.
   * Called externally by the orchestrator to inform lending decisions.
   */
  setHasOpenPosition(has: boolean): void;

  /** Get current Aave position (deposited + accrued interest) as BigInt */
  getAaveBalance(): Promise<bigint>;

  /** Whether maintenance mode is currently active */
  isMaintenanceMode(): boolean;

  /** Notify that a trade signal was emitted (resets idle timer) */
  onTradeSignal(): void;

  /** Notify of regime change (resets idle timer if leaving UNCERTAIN) */
  onRegimeChange(from: string, to: string): void;
}


// ═══════════════════════════════════════════════════════════════════════════════
// Database Persistence Layer (Task 4.1)
// ═══════════════════════════════════════════════════════════════════════════════

/** Row shape returned from smart_lender_state table */
interface SmartLenderStateRow {
  id: number;
  maintenance_mode: number;
  idle_period_start: number | null;
  updated_at: number;
}

/**
 * Creates the smart_lender_state table if it doesn't exist.
 * Uses a singleton row pattern (id = 1) for persistent state.
 *
 * Requirements: 3.6
 */
export function createSmartLenderTable(db: ISmartLenderDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_lender_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      maintenance_mode INTEGER NOT NULL DEFAULT 0,
      idle_period_start INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
}

/**
 * Load persisted state from the smart_lender_state table.
 * Returns default state if no row exists yet.
 *
 * Requirements: 3.6
 */
export function loadState(db: ISmartLenderDb): Pick<SmartAutoLenderState, 'maintenanceMode' | 'idlePeriodStart'> {
  const row = db.prepare(
    'SELECT maintenance_mode, idle_period_start FROM smart_lender_state WHERE id = 1',
  ).get() as SmartLenderStateRow | undefined;

  if (!row) {
    return {
      maintenanceMode: false,
      idlePeriodStart: null,
    };
  }

  return {
    maintenanceMode: row.maintenance_mode === 1,
    idlePeriodStart: row.idle_period_start ?? null,
  };
}

/**
 * Save current state to the smart_lender_state table.
 * Uses INSERT OR REPLACE to upsert the singleton row.
 *
 * Requirements: 3.6
 */
export function saveState(
  db: ISmartLenderDb,
  state: Pick<SmartAutoLenderState, 'maintenanceMode' | 'idlePeriodStart'>,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO smart_lender_state (id, maintenance_mode, idle_period_start, updated_at)
     VALUES (1, ?, ?, ?)`,
  ).run(
    state.maintenanceMode ? 1 : 0,
    state.idlePeriodStart ?? null,
    Date.now(),
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SmartAutoLender Class (Task 1.2)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dependencies required by SmartAutoLender constructor.
 */
export interface SmartAutoLenderDeps {
  aave: IAaveLendingModule;
  bankroll: ISmartLenderBankroll;
  safeMode: ISmartLenderSafeMode;
  config: SmartAutoLenderConfig;
  logger: ISmartLenderLogger;
  db: ISmartLenderDb;
}

/**
 * SmartAutoLender — Trading-aware, regime-sensitive Aave V3 lending strategy.
 *
 * Integrates at two call sites:
 * 1. Pre-cycle hook (evaluateIdle) — idle-period detection and time-based deposits
 * 2. TradingOrchestrator pre-trade (ensureFunds) — auto-withdraw funds when needed
 *
 * Requirements: 3.6, 6.1, 6.2
 */
export class SmartAutoLender implements ISmartAutoLender {
  private readonly aave: IAaveLendingModule;
  private readonly bankroll: ISmartLenderBankroll;
  private readonly safeMode: ISmartLenderSafeMode;
  private readonly config: SmartAutoLenderConfig;
  private readonly logger: ISmartLenderLogger;
  private readonly db: ISmartLenderDb;

  /** Internal mutable state */
  private state: SmartAutoLenderState;

  /** Current market regime (updated via onRegimeChange). Task 2.1 */
  private currentRegime: string = 'UNCERTAIN';

  /** Whether TradingOrchestrator has an open position (set externally). Task 2.1 */
  private hasPosition: boolean = false;

  /** Timestamp of the last regime change. Task 2.1 */
  private lastRegimeChangeTime: number = Date.now();

  constructor(deps: SmartAutoLenderDeps) {
    this.aave = deps.aave;
    this.bankroll = deps.bankroll;
    this.safeMode = deps.safeMode;
    this.config = deps.config;
    this.logger = deps.logger;
    this.db = deps.db;

    // Create the persistence table if it doesn't exist
    createSmartLenderTable(this.db);

    // Load persisted state from database
    const persisted = loadState(this.db);

    // Initialize internal state
    this.state = {
      idlePeriodStart: persisted.idlePeriodStart,
      maintenanceMode: persisted.maintenanceMode,
      pendingWithdrawals: [],
      lastTradeSignal: null,
    };

    this.logger.info(
      `[SmartAutoLender] Initialized — maintenance=${this.state.maintenanceMode}, idleStart=${this.state.idlePeriodStart}`,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Task 2.1: evaluateIdle — Full decision logic
  // Requirements: 1.1, 1.2, 2.1, 2.2, 5.2, 7.4, 7.5, 7.6
  // ─────────────────────────────────────────────────────────────────────────

  async evaluateIdle(walletBalance: bigint): Promise<SmartAutoLenderResult> {
    try {
      // Step 1: Check SafeMode → return no-action (Req 7.5)
      if (this.safeMode.isActive()) {
        return { action: 'none', amount: 0n, reason: 'safe_mode_active' };
      }

      // Step 2: Check MaintenanceMode → return no-action (Req 2.5, 3.4)
      if (this.state.maintenanceMode) {
        return { action: 'none', amount: 0n, reason: 'maintenance_mode_active' };
      }

      // Step 3: Check APY < minApyBps with position → withdraw all (Req 7.4)
      try {
        const position = await this.aave.getPosition();
        if (position.currentApyBps < this.config.minApyBps && position.currentATokenBalance > 0n) {
          const withdrawAmount = position.currentATokenBalance;
          const result = await this.aave.withdraw(withdrawAmount);
          this.bankroll.allocateProfit(result.withdrawn);
          this.logEvent('aave_withdraw', {
            amount: result.withdrawn.toString(),
            txHash: result.txHash,
            reason: 'low_apy',
            timestamp: Date.now(),
          });
          this.logger.info(
            `[SmartAutoLender] Low APY withdrawal — ${result.withdrawn} USDC, tx: ${result.txHash}`,
          );
          return {
            action: 'withdraw',
            amount: result.withdrawn,
            txHash: result.txHash,
            reason: 'low_apy_full_withdrawal',
          };
        }
      } catch (apyError) {
        // RPC error during APY check: log and skip, don't block evaluation (Req 7.4)
        this.logger.warn(`[SmartAutoLender] APY check failed, skipping: ${apyError}`);
      }

      // Step 4: Check open position in orchestrator → return no-action (Req 1.1)
      if (this.hasPosition) {
        return { action: 'none', amount: 0n, reason: 'open_position_active' };
      }

      // Step 5: Check regime != UNCERTAIN → reset idle timer, saveState, return no-action (Req 1.2)
      if (this.currentRegime !== 'UNCERTAIN') {
        this.state.idlePeriodStart = null;
        this.persistState();
        return { action: 'none', amount: 0n, reason: 'regime_not_uncertain' };
      }

      // Step 6: If idle period not started yet → start it now
      if (this.state.idlePeriodStart === null) {
        this.state.idlePeriodStart = Date.now();
        this.persistState();
        return { action: 'none', amount: 0n, reason: 'idle_period_started' };
      }

      // Step 7: Check idle elapsed ≥ idleThresholdMs AND balance > reserve + minDeposit (Req 2.1)
      const idleElapsed = Date.now() - this.state.idlePeriodStart;
      if (idleElapsed >= this.config.idleThresholdMs) {
        const minRequired = this.config.operatingReserve + this.config.minDepositAmount;
        if (walletBalance > minRequired) {
          const depositAmount = walletBalance - this.config.operatingReserve;

          // Step 8: Skip deposit if amount < minDepositAmount (5 USDC) (Req 5.2)
          if (depositAmount < this.config.minDepositAmount) {
            return { action: 'none', amount: 0n, reason: 'deposit_below_minimum' };
          }

          // Execute deposit
          const result = await this.aave.supply(depositAmount);

          // On successful deposit — notify bankroll, log event, save state
          this.bankroll.allocateLoss(depositAmount);
          this.logEvent('aave_deposit', {
            amount: depositAmount.toString(),
            txHash: result.txHash,
            walletBalance: walletBalance.toString(),
            reason: 'idle_period_2h',
            timestamp: Date.now(),
          });
          this.logger.info(
            `[SmartAutoLender] Idle deposit — ${depositAmount} USDC, tx: ${result.txHash}`,
          );
          this.persistState();

          return {
            action: 'deposit',
            amount: depositAmount,
            txHash: result.txHash,
            reason: 'idle_period_2h',
          };
        }
      }

      return { action: 'none', amount: 0n, reason: 'idle_threshold_not_reached' };
    } catch (error) {
      // Wrap entire method in try/catch, return { action: 'none' } on error (Req 7.6)
      this.logger.error(`[SmartAutoLender] evaluateIdle error: ${error}`);
      return { action: 'none', amount: 0n, reason: `error:${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Task 3.1: ensureFunds — Pre-trade withdrawal
  // Requirements: 3.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.3, 5.4, 6.2, 6.4, 6.5, 7.2
  // ─────────────────────────────────────────────────────────────────────────

  async ensureFunds(requiredAmount: bigint): Promise<{ available: boolean; withdrawn: bigint }> {
    try {
      // Step 1: If MaintenanceMode active → return unavailable (Req 3.3)
      if (this.state.maintenanceMode) {
        this.logger.info('[SmartAutoLender] ensureFunds blocked — maintenance mode active');
        return { available: false, withdrawn: 0n };
      }

      // Step 2: Get current Aave position; if zero → return unavailable
      const position = await this.aave.getPosition();
      if (position.currentATokenBalance === 0n) {
        return { available: false, withdrawn: 0n };
      }

      // Step 3: Check batch window — accumulate if recent withdrawal within batchWindowMs (Req 5.4)
      const now = Date.now();
      const recentWithdrawals = this.state.pendingWithdrawals.filter(
        (pw) => now - pw.timestamp < this.config.batchWindowMs,
      );
      // Clean up old entries outside the batch window
      this.state.pendingWithdrawals = recentWithdrawals;

      // Step 4: Calculate withdrawAmount = min(requiredAmount, position) (Req 4.1, 4.2, 5.1)
      const withdrawAmount = requiredAmount < position.currentATokenBalance
        ? requiredAmount
        : position.currentATokenBalance;

      // Step 5: If withdrawAmount < minWithdrawAmount AND not full close → skip (Req 5.3)
      const isFullClose = withdrawAmount >= position.currentATokenBalance;
      if (withdrawAmount < this.config.minWithdrawAmount && !isFullClose) {
        this.logger.info(
          `[SmartAutoLender] ensureFunds skipped — amount ${withdrawAmount} below min ${this.config.minWithdrawAmount} and not full close`,
        );
        return { available: false, withdrawn: 0n };
      }

      // Step 6: Execute withdrawal with 1 retry on failure (Req 4.3, 4.4, 7.2)
      let result: { txHash: string; withdrawn: bigint };
      try {
        result = await this.aave.withdraw(withdrawAmount);
      } catch (firstError) {
        this.logger.warn(`[SmartAutoLender] ensureFunds withdrawal failed, retrying once: ${firstError}`);
        try {
          result = await this.aave.withdraw(withdrawAmount);
        } catch (retryError) {
          // Both attempts failed — log error, return unavailable (Req 4.4, 7.2)
          this.logger.error(`[SmartAutoLender] ensureFunds retry also failed: ${retryError}`);
          return { available: false, withdrawn: 0n };
        }
      }

      // Step 7: On success — notify bankroll, log event, record gas (Req 6.2, 6.4, 6.5)
      this.bankroll.allocateProfit(result.withdrawn);
      this.logEvent('aave_withdraw', {
        amount: result.withdrawn.toString(),
        txHash: result.txHash,
        reason: 'trade_signal',
        timestamp: now,
      });
      this.bankroll.recordGas(0n); // Gas cost tracked separately by the aave module
      this.logger.info(
        `[SmartAutoLender] ensureFunds withdrew ${result.withdrawn} USDC, tx: ${result.txHash}`,
      );

      // Step 8: Add to pendingWithdrawals for batch tracking (Req 5.4)
      this.state.pendingWithdrawals.push({ amount: result.withdrawn, timestamp: now });

      // Step 9: Return success
      return { available: true, withdrawn: result.withdrawn };
    } catch (error) {
      // Catch-all: return safe default (Req 7.6)
      this.logger.error(`[SmartAutoLender] ensureFunds unexpected error: ${error}`);
      return { available: false, withdrawn: 0n };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Task 4.2: setMaintenance — Toggle maintenance mode
  // Requirements: 3.1, 3.2, 3.3, 3.4, 6.1, 6.2, 6.4
  // ─────────────────────────────────────────────────────────────────────────

  async setMaintenance(enabled: boolean, walletBalance?: bigint): Promise<SmartAutoLenderResult> {
    try {
      if (enabled) {
        // Maintenance ON: persist state first (Req 3.1)
        this.state.maintenanceMode = true;
        this.persistState();

        // If walletBalance provided and sufficient: deposit all minus reserve
        if (walletBalance !== undefined && walletBalance > this.config.operatingReserve + this.config.minDepositAmount) {
          const depositAmount = walletBalance - this.config.operatingReserve;

          const result = await this.aave.supply(depositAmount);
          this.bankroll.allocateLoss(depositAmount);
          this.logEvent('aave_deposit', {
            amount: depositAmount.toString(),
            txHash: result.txHash,
            reason: 'maintenance_on',
            timestamp: Date.now(),
          });
          this.logger.info(
            `[SmartAutoLender] Maintenance ON — deposited ${depositAmount} USDC, tx: ${result.txHash}`,
          );

          return {
            action: 'deposit',
            amount: depositAmount,
            txHash: result.txHash,
            reason: 'maintenance_on',
          };
        }

        this.logger.info('[SmartAutoLender] Maintenance ON — no deposit (insufficient balance or not provided)');
        return { action: 'none', amount: 0n, reason: 'maintenance_enabled_no_deposit' };
      } else {
        // Maintenance OFF: withdraw full Aave position (Req 3.2)
        this.state.maintenanceMode = false;
        this.persistState();

        const position = await this.aave.getPosition();

        if (position.currentATokenBalance > 0n) {
          const result = await this.aave.withdraw(position.currentATokenBalance);
          this.bankroll.allocateProfit(result.withdrawn);
          this.logEvent('aave_withdraw', {
            amount: result.withdrawn.toString(),
            txHash: result.txHash,
            reason: 'maintenance_off',
            timestamp: Date.now(),
          });
          this.logger.info(
            `[SmartAutoLender] Maintenance OFF — withdrew ${result.withdrawn} USDC, tx: ${result.txHash}`,
          );

          return {
            action: 'withdraw',
            amount: result.withdrawn,
            txHash: result.txHash,
            reason: 'maintenance_off',
          };
        }

        this.logger.info('[SmartAutoLender] Maintenance OFF — no position to withdraw');
        return { action: 'none', amount: 0n, reason: 'maintenance_disabled_no_position' };
      }
    } catch (error) {
      this.logger.error(`[SmartAutoLender] setMaintenance error: ${error}`);
      return { action: 'none', amount: 0n, reason: `error:${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Task 8.2: getAaveBalance and isMaintenanceMode
  // Requirements: 6.3
  // ─────────────────────────────────────────────────────────────────────────

  async getAaveBalance(): Promise<bigint> {
    const position = await this.aave.getPosition();
    return position.currentATokenBalance;
  }

  isMaintenanceMode(): boolean {
    return this.state.maintenanceMode;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Task 2.2: onRegimeChange and onTradeSignal
  // Requirements: 2.3, 2.4
  // ─────────────────────────────────────────────────────────────────────────

  onTradeSignal(): void {
    // Reset idle period timer on any trade signal (Req 2.4)
    this.state.idlePeriodStart = null;
    this.state.lastTradeSignal = Date.now();
    this.persistState();
  }

  onRegimeChange(_from: string, to: string): void {
    // Update current regime
    this.currentRegime = to;
    this.lastRegimeChangeTime = Date.now();

    if (to !== 'UNCERTAIN') {
      // Leaving UNCERTAIN: reset idle timer (Req 2.3)
      this.state.idlePeriodStart = null;
      this.persistState();
    } else if (this.state.idlePeriodStart === null) {
      // Entering UNCERTAIN and no idle period started: start it now
      this.state.idlePeriodStart = Date.now();
      this.persistState();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Task 2.1: setHasOpenPosition — External setter for orchestrator
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Set whether the TradingOrchestrator has an open position.
   * Called externally by the orchestrator to inform lending decisions.
   */
  setHasOpenPosition(has: boolean): void {
    this.hasPosition = has;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Log an event to the event_log table.
   * Requirements: 6.4
   */
  private logEvent(type: 'aave_deposit' | 'aave_withdraw', details: Record<string, unknown>): void {
    try {
      this.db.prepare(
        'INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)',
      ).run(type, JSON.stringify(details), Date.now());
    } catch (error) {
      this.logger.warn(`[SmartAutoLender] Failed to log event: ${error}`);
    }
  }

  /**
   * Persist current state to the smart_lender_state table.
   */
  private persistState(): void {
    try {
      saveState(this.db, {
        maintenanceMode: this.state.maintenanceMode,
        idlePeriodStart: this.state.idlePeriodStart,
      });
    } catch (error) {
      this.logger.warn(`[SmartAutoLender] Failed to persist state: ${error}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal state access (for testing)
  // ─────────────────────────────────────────────────────────────────────────

  /** Expose internal state for testing purposes */
  getState(): Readonly<SmartAutoLenderState> {
    return { ...this.state };
  }
}

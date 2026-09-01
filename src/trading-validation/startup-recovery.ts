/**
 * Trading Validation Phase - Startup Recovery
 *
 * Recovers system state after a restart. Loads persisted state from SQLite,
 * queries on-chain balances, resolves pending transaction intents, and resumes
 * position monitoring if an open position is detected.
 *
 * Enters Safe_Mode if on-chain state diverges from persisted state beyond threshold.
 * Ensures no duplicate trade intents (idempotent).
 *
 * Requirements: 28.1, 28.2, 28.3, 28.4
 */

import type { TradingDatabase } from './db.js';
import type {
  UsdcAmount,
  WethAmount,
  EthAmount,
  TradingMode,
  Position,
  TransactionIntent,
  IntentState,
  BankrollState,
} from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** On-chain balance provider for startup verification */
export interface IOnChainProvider {
  getUsdcBalance(address: string): Promise<UsdcAmount>;
  getWethBalance(address: string): Promise<WethAmount>;
  getAusdcBalance(address: string): Promise<UsdcAmount>;
  getEthBalance(address: string): Promise<EthAmount>;
  getTransactionCount(address: string): Promise<number>;
  getTransactionReceipt(txHash: string): Promise<{ status: number; blockNumber: number } | null>;
}

/** SafeMode controller interface for triggering safe mode */
export interface IRecoverySafeModeController {
  trigger(reason: string, details?: string): void;
  getState(): { active: boolean; reason?: string; since?: number };
}

/** ExitManager interface for resuming position monitoring */
export interface IRecoveryExitManager {
  registerPosition(position: Position): void;
  getOpenPosition(): Position | null;
}

/** Logger interface for recovery operations */
export interface IRecoveryLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Recovery State Types
// ═══════════════════════════════════════════════════════════════════════════

/** State loaded from SQLite persistence */
export interface PersistedState {
  phase: PhaseState | null;
  bankroll: BankrollState | null;
  openPositions: Position[];
  pendingIntents: TransactionIntent[];
  nonce: NonceState | null;
  approvals: ApprovalRecord[];
  killSwitchTriggered: boolean;
  safeModeActive: boolean;
  safeModeReason: string | null;
}

/** Phase state from trading_phase table */
export interface PhaseState {
  mode: TradingMode;
  configHash: string;
  startedAt: number;
  safeMode: boolean;
  safeModeReason: string | null;
  safeModeSince: number | null;
  lowCostMode: boolean;
  killSwitchTriggered: boolean;
  autoLenderDisabled: boolean;
  updatedAt: number;
}

/** Nonce state from nonce_registry table */
export interface NonceState {
  lastConfirmedNonce: number;
  nextNonce: number;
  updatedAt: number;
}

/** Approval record from approvals table */
export interface ApprovalRecord {
  token: string;
  spender: string;
  amount: bigint;
  txHash: string | null;
  timestamp: number;
  revoked: boolean;
}

/** On-chain balances queried during recovery */
export interface OnChainState {
  usdcBalance: UsdcAmount;
  wethBalance: WethAmount;
  ausdcBalance: UsdcAmount;
  ethBalance: EthAmount;
  walletNonce: number;
}

/** Result of the startup recovery process */
export interface RecoveryResult {
  success: boolean;
  persistedState: PersistedState;
  onChainState: OnChainState;
  resolvedIntents: ResolvedIntent[];
  safeModeTriggered: boolean;
  safeModeReason: string | null;
  positionResumed: boolean;
  warnings: string[];
}

/** Resolution of a pending intent */
export interface ResolvedIntent {
  intentId: string;
  previousState: IntentState;
  resolvedState: IntentState;
  txHash: string | null;
  resolution: 'confirmed' | 'reverted' | 'dropped' | 'still_pending';
}

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface StartupRecoveryConfig {
  walletAddress: string;
  /** Max deviation between persisted total and on-chain USDC+WETH (6 decimals) */
  deviationThresholdUsdc: UsdcAmount;
  /** Max nonce divergence before triggering safe mode */
  maxNonceDivergence: number;
}

const DEFAULT_CONFIG: StartupRecoveryConfig = {
  walletAddress: '',
  deviationThresholdUsdc: 500_000n, // $0.50 — generous threshold for rounding/gas
  maxNonceDivergence: 2,
};

// ═══════════════════════════════════════════════════════════════════════════
// Startup Recovery Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class StartupRecovery {
  private readonly db: TradingDatabase;
  private readonly config: StartupRecoveryConfig;
  private readonly provider: IOnChainProvider;
  private readonly safeModeController: IRecoverySafeModeController;
  private readonly exitManager: IRecoveryExitManager;
  private readonly logger: IRecoveryLogger;

  constructor(
    db: TradingDatabase,
    config: Partial<StartupRecoveryConfig> & { walletAddress: string },
    provider: IOnChainProvider,
    safeModeController: IRecoverySafeModeController,
    exitManager: IRecoveryExitManager,
    logger: IRecoveryLogger,
  ) {
    this.db = db;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.provider = provider;
    this.safeModeController = safeModeController;
    this.exitManager = exitManager;
    this.logger = logger;
  }

  /**
   * Execute full startup recovery procedure.
   *
   * 1. Load persisted state from SQLite (Req 28.1)
   * 2. Query on-chain balances + wallet nonce (Req 28.2)
   * 3. Resolve pending intents by hash/nonce (Req 28.3)
   * 4. Enter Safe_Mode if state diverges beyond threshold (Req 28.3)
   * 5. Resume ExitManager if open position detected (Req 28.4)
   * 6. No duplicate trade intents — idempotent (Req 28.4)
   */
  async recover(): Promise<RecoveryResult> {
    const warnings: string[] = [];

    this.logger.info('Starting recovery procedure', {
      wallet: this.config.walletAddress,
    });

    // ─── Step 1: Load persisted state from SQLite ─────────────────────
    const persistedState = this.loadPersistedState();
    this.logger.info('Loaded persisted state', {
      hasPhase: persistedState.phase !== null,
      hasBankroll: persistedState.bankroll !== null,
      openPositions: persistedState.openPositions.length,
      pendingIntents: persistedState.pendingIntents.length,
      killSwitch: persistedState.killSwitchTriggered,
      safeMode: persistedState.safeModeActive,
    });

    // If kill switch was already triggered, enter safe mode immediately
    if (persistedState.killSwitchTriggered) {
      this.logger.warn('Kill switch was previously triggered — entering Safe_Mode');
      this.safeModeController.trigger('kill_switch', 'Kill switch persisted from previous run');
      return {
        success: true,
        persistedState,
        onChainState: await this.queryOnChainState(),
        resolvedIntents: [],
        safeModeTriggered: true,
        safeModeReason: 'Kill switch persisted from previous run',
        positionResumed: false,
        warnings,
      };
    }

    // If safe mode was active, restore it
    if (persistedState.safeModeActive) {
      this.logger.warn('Safe_Mode was active before restart — restoring', {
        reason: persistedState.safeModeReason,
      });
      this.safeModeController.trigger(
        'recon_mismatch',
        `Restored from previous session: ${persistedState.safeModeReason ?? 'unknown'}`,
      );
    }

    // ─── Step 2: Query on-chain state ─────────────────────────────────
    const onChainState = await this.queryOnChainState();
    this.logger.info('Queried on-chain state', {
      usdc: onChainState.usdcBalance.toString(),
      weth: onChainState.wethBalance.toString(),
      ausdc: onChainState.ausdcBalance.toString(),
      eth: onChainState.ethBalance.toString(),
      walletNonce: onChainState.walletNonce,
    });

    // ─── Step 3: Resolve pending intents ──────────────────────────────
    const resolvedIntents = await this.resolvePendingIntents(
      persistedState.pendingIntents,
      onChainState.walletNonce,
    );

    for (const resolved of resolvedIntents) {
      this.logger.info('Resolved pending intent', {
        intentId: resolved.intentId,
        previousState: resolved.previousState,
        resolvedState: resolved.resolvedState,
        resolution: resolved.resolution,
      });
    }

    // ─── Step 4: Check for state divergence ───────────────────────────
    let safeModeTriggered = persistedState.safeModeActive;
    let safeModeReason: string | null = persistedState.safeModeReason;

    const divergence = this.checkStateDivergence(
      persistedState,
      onChainState,
    );

    if (divergence.diverged) {
      safeModeTriggered = true;
      safeModeReason = divergence.reason;
      this.logger.error('State divergence detected — entering Safe_Mode', {
        reason: divergence.reason,
        details: divergence.details,
      });
      this.safeModeController.trigger('recon_mismatch', divergence.reason);
      warnings.push(`State divergence: ${divergence.reason}`);
    }

    // Check nonce divergence
    if (persistedState.nonce) {
      const nonceDiff = Math.abs(
        onChainState.walletNonce - persistedState.nonce.nextNonce,
      );
      if (nonceDiff > this.config.maxNonceDivergence) {
        safeModeTriggered = true;
        safeModeReason = `Nonce divergence: on-chain=${onChainState.walletNonce}, persisted_next=${persistedState.nonce.nextNonce}`;
        this.logger.error('Nonce divergence beyond threshold — entering Safe_Mode', {
          onChain: onChainState.walletNonce,
          persistedNext: persistedState.nonce.nextNonce,
          threshold: this.config.maxNonceDivergence,
        });
        this.safeModeController.trigger('recon_mismatch', safeModeReason);
        warnings.push(safeModeReason);
      }
    }

    // ─── Step 5: Sync nonce registry with on-chain ────────────────────
    this.syncNonceRegistry(onChainState.walletNonce, persistedState.nonce);

    // ─── Step 6: Resume ExitManager if open position detected ─────────
    let positionResumed = false;
    if (persistedState.openPositions.length > 0) {
      const position = persistedState.openPositions[0]!;
      this.logger.info('Open position detected — resuming ExitManager', {
        positionId: position.id,
        strategy: position.strategy,
        entryPrice: position.entryPrice,
      });
      this.exitManager.registerPosition(position);
      positionResumed = true;
    }

    // Log recovery summary
    this.logRecoveryEvent(persistedState, onChainState, resolvedIntents, safeModeTriggered);

    this.logger.info('Recovery procedure complete', {
      safeModeTriggered,
      positionResumed,
      resolvedIntents: resolvedIntents.length,
      warnings: warnings.length,
    });

    return {
      success: true,
      persistedState,
      onChainState,
      resolvedIntents,
      safeModeTriggered,
      safeModeReason,
      positionResumed,
      warnings,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 1: Load Persisted State from SQLite (Req 28.1)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Load phase, bankroll, positions, pending intents, nonce, approvals,
   * kill-switch, safe-mode from SQLite.
   */
  loadPersistedState(): PersistedState {
    const phase = this.loadPhaseState();
    const bankroll = this.loadBankrollState();
    const openPositions = this.loadOpenPositions();
    const pendingIntents = this.loadPendingIntents();
    const nonce = this.loadNonceState();
    const approvals = this.loadApprovals();

    return {
      phase,
      bankroll,
      openPositions,
      pendingIntents,
      nonce,
      approvals,
      killSwitchTriggered: phase?.killSwitchTriggered ?? false,
      safeModeActive: phase?.safeMode ?? false,
      safeModeReason: phase?.safeModeReason ?? null,
    };
  }

  private loadPhaseState(): PhaseState | null {
    const row = this.db.prepare(
      'SELECT * FROM trading_phase WHERE id = 1',
    ).get() as PhaseRow | undefined;

    if (!row) return null;

    return {
      mode: row.mode as TradingMode,
      configHash: row.config_hash,
      startedAt: row.started_at,
      safeMode: row.safe_mode === 1,
      safeModeReason: row.safe_mode_reason,
      safeModeSince: row.safe_mode_since,
      lowCostMode: row.low_cost_mode === 1,
      killSwitchTriggered: row.kill_switch_triggered === 1,
      autoLenderDisabled: row.auto_lender_disabled === 1,
      updatedAt: row.updated_at,
    };
  }

  private loadBankrollState(): BankrollState | null {
    const row = this.db.prepare(
      'SELECT * FROM bankroll WHERE id = 1',
    ).get() as BankrollRow | undefined;

    if (!row) return null;

    return {
      totalUsdc: BigInt(row.total_usdc),
      activeUsdc: BigInt(row.active_usdc),
      reserveUsdc: BigInt(row.reserve_usdc),
      unrealizedPnl: 0n, // Computed at runtime, not persisted
      dailyRealizedPnl: BigInt(row.daily_realized_pnl),
      dailyGasSpent: BigInt(row.daily_gas_spent),
      experimentTotalPnl: BigInt(row.experiment_total_pnl),
    };
  }

  private loadOpenPositions(): Position[] {
    const rows = this.db.prepare(
      `SELECT * FROM positions WHERE closed = 0 ORDER BY entry_timestamp ASC`,
    ).all() as PositionRow[];

    return rows.map((row) => this.rowToPosition(row));
  }

  private loadPendingIntents(): TransactionIntent[] {
    const rows = this.db.prepare(
      `SELECT * FROM tx_intents
       WHERE state IN ('created', 'approval_pending', 'approval_submitted', 'swap_pending')
       ORDER BY created_at ASC`,
    ).all() as TxIntentRow[];

    return rows.map((row) => this.rowToIntent(row));
  }

  private loadNonceState(): NonceState | null {
    const row = this.db.prepare(
      'SELECT * FROM nonce_registry WHERE id = 1',
    ).get() as NonceRow | undefined;

    if (!row) return null;

    return {
      lastConfirmedNonce: row.last_confirmed_nonce,
      nextNonce: row.next_nonce,
      updatedAt: row.updated_at,
    };
  }

  private loadApprovals(): ApprovalRecord[] {
    const rows = this.db.prepare(
      'SELECT * FROM approvals WHERE revoked = 0 ORDER BY timestamp DESC',
    ).all() as ApprovalRow[];

    return rows.map((row) => ({
      token: row.token,
      spender: row.spender,
      amount: BigInt(row.amount),
      txHash: row.tx_hash,
      timestamp: row.timestamp,
      revoked: row.revoked === 1,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 2: Query On-Chain State (Req 28.2)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Query on-chain: USDC, WETH, aUSDC, ETH balances + wallet nonce.
   */
  private async queryOnChainState(): Promise<OnChainState> {
    const address = this.config.walletAddress;

    const [usdcBalance, wethBalance, ausdcBalance, ethBalance, walletNonce] =
      await Promise.all([
        this.provider.getUsdcBalance(address),
        this.provider.getWethBalance(address),
        this.provider.getAusdcBalance(address),
        this.provider.getEthBalance(address),
        this.provider.getTransactionCount(address),
      ]);

    return { usdcBalance, wethBalance, ausdcBalance, ethBalance, walletNonce };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 3: Resolve Pending Intents (Req 28.3)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Resolve pending intents by hash/nonce.
   * - If intent has a tx_hash, check receipt on-chain
   * - If intent nonce < wallet nonce and no receipt, mark as dropped
   * - If intent nonce >= wallet nonce, it may still be pending
   */
  private async resolvePendingIntents(
    pendingIntents: TransactionIntent[],
    walletNonce: number,
  ): Promise<ResolvedIntent[]> {
    const resolved: ResolvedIntent[] = [];

    for (const intent of pendingIntents) {
      const resolution = await this.resolveIntent(intent, walletNonce);
      resolved.push(resolution);

      // Persist the resolution
      this.updateIntentState(intent.id, resolution.resolvedState);
    }

    return resolved;
  }

  private async resolveIntent(
    intent: TransactionIntent,
    walletNonce: number,
  ): Promise<ResolvedIntent> {
    // If we have a tx hash, check on-chain receipt
    if (intent.txHash) {
      const receipt = await this.provider.getTransactionReceipt(intent.txHash);

      if (receipt) {
        const newState: IntentState = receipt.status === 1 ? 'confirmed' : 'reverted';
        return {
          intentId: intent.id,
          previousState: intent.state,
          resolvedState: newState,
          txHash: intent.txHash,
          resolution: newState === 'confirmed' ? 'confirmed' : 'reverted',
        };
      }

      // No receipt but nonce has been used — tx was likely replaced/dropped
      if (intent.nonce < walletNonce) {
        return {
          intentId: intent.id,
          previousState: intent.state,
          resolvedState: 'dropped',
          txHash: intent.txHash,
          resolution: 'dropped',
        };
      }

      // No receipt and nonce is still pending — still in mempool
      return {
        intentId: intent.id,
        previousState: intent.state,
        resolvedState: intent.state, // keep current state
        txHash: intent.txHash,
        resolution: 'still_pending',
      };
    }

    // No tx hash — if nonce < wallet nonce, mark as dropped
    if (intent.nonce < walletNonce) {
      return {
        intentId: intent.id,
        previousState: intent.state,
        resolvedState: 'dropped',
        txHash: null,
        resolution: 'dropped',
      };
    }

    // No hash, nonce not yet used — still pending (was created but never broadcast)
    return {
      intentId: intent.id,
      previousState: intent.state,
      resolvedState: intent.state,
      txHash: null,
      resolution: 'still_pending',
    };
  }

  private updateIntentState(intentId: string, newState: IntentState): void {
    this.db.prepare(
      'UPDATE tx_intents SET state = ?, updated_at = ? WHERE id = ?',
    ).run(newState, Date.now(), intentId);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 4: Check State Divergence (Req 28.3)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Compare persisted bankroll total with on-chain USDC + WETH value.
   * Enter Safe_Mode if deviation exceeds threshold.
   *
   * Note: WETH value comparison is approximate since we don't have a price feed
   * during recovery. We compare only USDC balance when no position is open,
   * or include WETH only if a position is tracked.
   */
  private checkStateDivergence(
    persisted: PersistedState,
    onChain: OnChainState,
  ): { diverged: boolean; reason: string; details?: Record<string, string> } {
    // If no bankroll state persisted yet, skip divergence check
    if (!persisted.bankroll) {
      return { diverged: false, reason: '' };
    }

    const persistedTotal = persisted.bankroll.totalUsdc;
    const onChainUsdc = onChain.usdcBalance;

    // If there's an open position, we expect some USDC to be in WETH
    // In that case, we can't do a simple USDC comparison
    if (persisted.openPositions.length > 0) {
      // With open position, just ensure USDC + aUSDC isn't wildly off
      // We can't accurately value WETH without a price, so we skip strict check
      // but flag if USDC is way below what we'd expect after removing position size
      const positionSizeUsdc = persisted.openPositions.reduce(
        (sum, p) => sum + p.sizeUsdc,
        0n,
      );
      const expectedMinUsdc = persistedTotal - positionSizeUsdc - this.config.deviationThresholdUsdc;

      if (onChainUsdc < expectedMinUsdc && expectedMinUsdc > 0n) {
        return {
          diverged: true,
          reason: `USDC balance too low with open position: on-chain=${onChainUsdc.toString()}, expected_min=${expectedMinUsdc.toString()}`,
          details: {
            persistedTotal: persistedTotal.toString(),
            onChainUsdc: onChainUsdc.toString(),
            positionSize: positionSizeUsdc.toString(),
          },
        };
      }

      return { diverged: false, reason: '' };
    }

    // No open position — USDC on-chain should approximately match persisted total
    // Allow for gas spent and small deviations
    const deviation = persistedTotal > onChainUsdc
      ? persistedTotal - onChainUsdc
      : onChainUsdc - persistedTotal;

    if (deviation > this.config.deviationThresholdUsdc) {
      return {
        diverged: true,
        reason: `USDC balance diverges from persisted total: on-chain=${onChainUsdc.toString()}, persisted=${persistedTotal.toString()}, deviation=${deviation.toString()}`,
        details: {
          persistedTotal: persistedTotal.toString(),
          onChainUsdc: onChainUsdc.toString(),
          deviation: deviation.toString(),
          threshold: this.config.deviationThresholdUsdc.toString(),
        },
      };
    }

    return { diverged: false, reason: '' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Step 5: Sync Nonce Registry
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Sync the nonce registry with on-chain wallet nonce.
   * If on-chain nonce is ahead, update persisted state (intents were confirmed externally).
   */
  private syncNonceRegistry(walletNonce: number, persisted: NonceState | null): void {
    if (!persisted) {
      // Initialize nonce registry if not present
      this.db.prepare(
        `INSERT OR REPLACE INTO nonce_registry (id, last_confirmed_nonce, next_nonce, updated_at)
         VALUES (1, ?, ?, ?)`,
      ).run(walletNonce > 0 ? walletNonce - 1 : 0, walletNonce, Date.now());
      this.logger.info('Initialized nonce registry from on-chain', { walletNonce });
      return;
    }

    // If on-chain nonce is ahead of persisted, update
    if (walletNonce > persisted.nextNonce) {
      this.db.prepare(
        `UPDATE nonce_registry
         SET last_confirmed_nonce = ?, next_nonce = ?, updated_at = ?
         WHERE id = 1`,
      ).run(walletNonce - 1, walletNonce, Date.now());
      this.logger.info('Advanced nonce registry to match on-chain', {
        previousNext: persisted.nextNonce,
        newNext: walletNonce,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Logging
  // ═══════════════════════════════════════════════════════════════════════

  private logRecoveryEvent(
    persisted: PersistedState,
    onChain: OnChainState,
    resolved: ResolvedIntent[],
    safeModeTriggered: boolean,
  ): void {
    const details = {
      mode: persisted.phase?.mode ?? 'unknown',
      hasBankroll: persisted.bankroll !== null,
      openPositions: persisted.openPositions.length,
      pendingIntents: persisted.pendingIntents.length,
      resolvedIntents: resolved.length,
      onChainUsdc: onChain.usdcBalance.toString(),
      onChainWeth: onChain.wethBalance.toString(),
      onChainEth: onChain.ethBalance.toString(),
      walletNonce: onChain.walletNonce,
      safeModeTriggered,
    };

    this.db.prepare(
      `INSERT INTO event_log (event_type, details, timestamp)
       VALUES (?, ?, ?)`,
    ).run('startup_recovery', JSON.stringify(details), Date.now());
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Row-to-Type Converters
  // ═══════════════════════════════════════════════════════════════════════

  private rowToPosition(row: PositionRow): Position {
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
      entryRegime: row.entry_regime as Position['entryRegime'],
      strategy: row.strategy as Position['strategy'],
      exitReason: row.exit_reason as Position['exitReason'] | undefined,
      exitPrice: row.exit_price ?? undefined,
      exitTimestamp: row.exit_timestamp ?? undefined,
      grossPnl: row.gross_pnl ? BigInt(row.gross_pnl) : undefined,
      netPnl: row.net_pnl ? BigInt(row.net_pnl) : undefined,
      mfe: row.mfe ?? undefined,
      mae: row.mae ?? undefined,
    };
  }

  private rowToIntent(row: TxIntentRow): TransactionIntent {
    return {
      id: row.id,
      state: row.state as IntentState,
      nonce: row.nonce,
      txHash: row.tx_hash ?? undefined,
      contractAddress: row.contract_address,
      functionName: row.function_name,
      gasLimit: BigInt(row.gas_limit),
      maxFeePerGas: row.max_fee_per_gas ? BigInt(row.max_fee_per_gas) : undefined,
      maxPriorityFeePerGas: row.max_priority_fee ? BigInt(row.max_priority_fee) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      blockNumber: row.block_number ?? undefined,
      revertReason: row.revert_reason ?? undefined,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SQLite Row Types (internal)
// ═══════════════════════════════════════════════════════════════════════════

interface PhaseRow {
  id: number;
  mode: string;
  config_hash: string;
  started_at: number;
  safe_mode: number;
  safe_mode_reason: string | null;
  safe_mode_since: number | null;
  low_cost_mode: number;
  kill_switch_triggered: number;
  auto_lender_disabled: number;
  updated_at: number;
}

interface BankrollRow {
  id: number;
  total_usdc: string;
  active_usdc: string;
  reserve_usdc: string;
  daily_realized_pnl: string;
  daily_gas_spent: string;
  experiment_total_pnl: string;
  day_start_bankroll: string;
  day_utc: string;
  updated_at: number;
}

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

interface TxIntentRow {
  id: string;
  state: string;
  nonce: number;
  tx_hash: string | null;
  contract_address: string;
  function_name: string;
  gas_limit: string;
  max_fee_per_gas: string | null;
  max_priority_fee: string | null;
  created_at: number;
  updated_at: number;
  block_number: number | null;
  revert_reason: string | null;
  operation_type: string;
}

interface NonceRow {
  id: number;
  last_confirmed_nonce: number;
  next_nonce: number;
  updated_at: number;
}

interface ApprovalRow {
  id: number;
  token: string;
  spender: string;
  amount: string;
  tx_hash: string | null;
  timestamp: number;
  revoked: number;
}

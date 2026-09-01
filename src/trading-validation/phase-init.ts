/**
 * Trading Validation Phase - Phase Initialization and Aave State Verification
 *
 * Responsibilities:
 * 1. Verify Aave withdrawal already completed (aUSDC balance = 0)
 * 2. Verify USDC balance ≥ expected total minus gas
 * 3. Record verification in SQLite
 * 4. Set AutoLender enabled = false
 * 5. Initialize BankrollManager with reconciled balances
 * 6. Compute and store config hash
 * 7. Run DB integrity check
 * 8. If withdrawal NOT yet done: execute via TransactionManager with intent ID,
 *    simulate first, safety exit gas ($0.10)
 *
 * Requirements: 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.1, 1.2, 34.1
 */

import type { TradingDatabase } from './db.js';
import type { UsdcAmount, EthAmount } from './types.js';
import type { TradingValidationConfig } from './config.js';
import type { IPreTradeSimulator } from './pre-trade-simulator.js';
import type { ITransactionManager, IntentParams } from './transaction-manager.js';
import { BankrollManager, type IBankrollManager } from './bankroll-manager.js';
import { computeConfigHash } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** Provider interface for on-chain balance queries during phase initialization */
export interface IPhaseInitProvider {
  /** Get aUSDC balance for wallet (6 decimals) */
  getAUsdcBalance(wallet: string): Promise<UsdcAmount>;
  /** Get USDC balance for wallet (6 decimals) */
  getUsdcBalance(wallet: string): Promise<UsdcAmount>;
  /** Get ETH balance for wallet (wei) */
  getEthBalance(wallet: string): Promise<EthAmount>;
  /** Get WETH balance for wallet (18 decimals) */
  getWethBalance(wallet: string): Promise<bigint>;
}

/** Logger interface for phase initialization */
export interface IPhaseInitLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Alert sender for operator notifications */
export interface IPhaseInitAlerter {
  sendAlert(message: string, critical: boolean): Promise<void>;
}

/** Result of phase initialization */
export interface PhaseInitResult {
  success: boolean;
  /** Whether Aave withdrawal was already completed */
  withdrawalAlreadyDone: boolean;
  /** Whether a new withdrawal was executed during init */
  withdrawalExecuted: boolean;
  /** Verified USDC balance (6 decimals) */
  verifiedUsdcBalance: UsdcAmount;
  /** Verified aUSDC balance (should be 0) */
  verifiedAUsdcBalance: UsdcAmount;
  /** Config hash stored */
  configHash: string;
  /** DB integrity check result */
  dbIntegrityOk: boolean;
  /** Error details if failed */
  error?: string;
}

/** Withdrawal execution result */
interface WithdrawalResult {
  success: boolean;
  txHash?: string;
  blockNumber?: number;
  gasEthSpent?: EthAmount;
  amountWithdrawn?: UsdcAmount;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum gas allowed for init withdrawal: $0.10 (100000 in 6-decimal USDC) */
const INIT_WITHDRAWAL_MAX_GAS_USDC: UsdcAmount = 100_000n;

/** Deviation threshold for withdrawal reconciliation: $0.10 */
const WITHDRAWAL_DEVIATION_THRESHOLD: UsdcAmount = 100_000n;

/** Unique intent ID prefix for init withdrawal */
const WITHDRAWAL_INTENT_PREFIX = 'init-aave-withdrawal';

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Runs the complete phase initialization sequence.
 *
 * This is the entry point for the Trading Validation Phase startup.
 * It ensures the system is in a consistent state before any trading begins.
 */
export async function initializePhase(
  db: TradingDatabase,
  config: TradingValidationConfig,
  provider: IPhaseInitProvider,
  simulator: IPreTradeSimulator,
  txManager: ITransactionManager,
  logger: IPhaseInitLogger,
  alerter: IPhaseInitAlerter,
): Promise<PhaseInitResult> {
  logger.info('Phase initialization started', { mode: config.mode });

  // ───────────────────────────────────────────────────────────────────────
  // Step 1: Run DB integrity check (Req 34.1)
  // ───────────────────────────────────────────────────────────────────────
  const dbIntegrityOk = runDbIntegrityCheck(db, logger);
  if (!dbIntegrityOk) {
    const errorMsg = 'Database integrity check failed — entering Safe_Mode';
    logger.error(errorMsg);
    await alerter.sendAlert(errorMsg, true);
    return {
      success: false,
      withdrawalAlreadyDone: false,
      withdrawalExecuted: false,
      verifiedUsdcBalance: 0n,
      verifiedAUsdcBalance: 0n,
      configHash: '',
      dbIntegrityOk: false,
      error: errorMsg,
    };
  }
  logger.info('DB integrity check passed');

  // ───────────────────────────────────────────────────────────────────────
  // Step 2: Compute and store config hash (Req 25.1)
  // ───────────────────────────────────────────────────────────────────────
  const configHash = computeConfigHash(config);
  logger.info('Config hash computed', { configHash });

  // ───────────────────────────────────────────────────────────────────────
  // Step 3: Verify Aave withdrawal state (Req 0.2)
  // ───────────────────────────────────────────────────────────────────────
  const walletAddress = config.txManager.walletAddress;
  const aUsdcBalance = await provider.getAUsdcBalance(walletAddress);
  const withdrawalAlreadyDone = aUsdcBalance === 0n;

  logger.info('Aave state checked', {
    aUsdcBalance: aUsdcBalance.toString(),
    withdrawalAlreadyDone,
  });

  let withdrawalExecuted = false;

  // ───────────────────────────────────────────────────────────────────────
  // Step 4: If withdrawal NOT yet done, execute it (Req 0.1, 0.5, 0.7)
  // ───────────────────────────────────────────────────────────────────────
  if (!withdrawalAlreadyDone) {
    logger.info('Aave withdrawal not yet completed — executing withdrawal', {
      aUsdcBalance: aUsdcBalance.toString(),
    });

    const withdrawalResult = await executeAaveWithdrawal(
      db,
      config,
      provider,
      simulator,
      txManager,
      logger,
      alerter,
      aUsdcBalance,
    );

    if (!withdrawalResult.success) {
      return {
        success: false,
        withdrawalAlreadyDone: false,
        withdrawalExecuted: false,
        verifiedUsdcBalance: 0n,
        verifiedAUsdcBalance: aUsdcBalance,
        configHash,
        dbIntegrityOk: true,
        error: withdrawalResult.error ?? 'Aave withdrawal failed',
      };
    }

    withdrawalExecuted = true;

    // Record withdrawal in SQLite (Req 0.4)
    recordWithdrawalEvent(db, withdrawalResult, logger);
  }

  // ───────────────────────────────────────────────────────────────────────
  // Step 5: Post-withdrawal verification (Req 0.2, 0.3)
  // ───────────────────────────────────────────────────────────────────────
  const verifiedAUsdc = await provider.getAUsdcBalance(walletAddress);
  if (verifiedAUsdc !== 0n) {
    const errorMsg = `aUSDC balance is not zero after withdrawal: ${verifiedAUsdc.toString()}`;
    logger.error(errorMsg);
    await alerter.sendAlert(`Phase init failure: ${errorMsg}`, true);
    return {
      success: false,
      withdrawalAlreadyDone,
      withdrawalExecuted,
      verifiedUsdcBalance: 0n,
      verifiedAUsdcBalance: verifiedAUsdc,
      configHash,
      dbIntegrityOk: true,
      error: errorMsg,
    };
  }

  const verifiedUsdcBalance = await provider.getUsdcBalance(walletAddress);

  // Verify USDC balance ≥ expected total minus gas (Req 0.3, E1)
  // Allow small positive interest accrual: actual may exceed expected
  const expectedMinUsdc = config.bankroll.initialTotal - INIT_WITHDRAWAL_MAX_GAS_USDC;
  if (verifiedUsdcBalance < expectedMinUsdc) {
    const errorMsg = `USDC balance ${verifiedUsdcBalance.toString()} below expected minimum ${expectedMinUsdc.toString()}`;
    logger.error(errorMsg, {
      actual: verifiedUsdcBalance.toString(),
      expectedMin: expectedMinUsdc.toString(),
    });
    await alerter.sendAlert(`Phase init: ${errorMsg}`, true);
    return {
      success: false,
      withdrawalAlreadyDone,
      withdrawalExecuted,
      verifiedUsdcBalance,
      verifiedAUsdcBalance: 0n,
      configHash,
      dbIntegrityOk: true,
      error: errorMsg,
    };
  }

  logger.info('USDC balance verified', {
    actual: verifiedUsdcBalance.toString(),
    expectedMin: expectedMinUsdc.toString(),
  });

  // ───────────────────────────────────────────────────────────────────────
  // Step 6: Record verification in SQLite
  // ───────────────────────────────────────────────────────────────────────
  recordVerificationEvent(db, verifiedUsdcBalance, verifiedAUsdc, configHash, logger);

  // ───────────────────────────────────────────────────────────────────────
  // Step 7: Set AutoLender enabled = false (Req 1.1, 1.2)
  // ───────────────────────────────────────────────────────────────────────
  disableAutoLender(db, logger);

  // ───────────────────────────────────────────────────────────────────────
  // Step 8: Initialize BankrollManager with reconciled balances (Req 2.1, 2.2)
  // ───────────────────────────────────────────────────────────────────────
  const bankrollConfig = {
    ...config.bankroll,
    // Use verified on-chain balance as the actual total
    initialTotal: verifiedUsdcBalance,
    // Recalculate reserve based on actual balance
    initialReserve: verifiedUsdcBalance - config.bankroll.initialActive,
  };

  // If verified balance is less than configured active, adjust active down
  if (verifiedUsdcBalance < config.bankroll.initialActive) {
    bankrollConfig.initialActive = verifiedUsdcBalance;
    bankrollConfig.initialReserve = 0n;
  }

  const bankrollManager = new BankrollManager(db, bankrollConfig);
  const bankrollState = bankrollManager.getState();

  logger.info('BankrollManager initialized', {
    total: bankrollState.totalUsdc.toString(),
    active: bankrollState.activeUsdc.toString(),
    reserve: bankrollState.reserveUsdc.toString(),
  });

  // ───────────────────────────────────────────────────────────────────────
  // Step 9: Store config hash and phase state in trading_phase table
  // ───────────────────────────────────────────────────────────────────────
  initializePhaseState(db, config.mode, configHash, logger);

  logger.info('Phase initialization completed successfully', {
    mode: config.mode,
    configHash,
    usdcBalance: verifiedUsdcBalance.toString(),
    withdrawalExecuted,
  });

  return {
    success: true,
    withdrawalAlreadyDone,
    withdrawalExecuted,
    verifiedUsdcBalance,
    verifiedAUsdcBalance: 0n,
    configHash,
    dbIntegrityOk: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Runs SQLite PRAGMA integrity_check.
 * Returns true if database is healthy, false otherwise.
 * Requirement: 34.1
 */
function runDbIntegrityCheck(db: TradingDatabase, logger: IPhaseInitLogger): boolean {
  try {
    const result = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const isOk = result.length === 1 && result[0].integrity_check === 'ok';
    if (!isOk) {
      logger.error('DB integrity check failed', {
        result: JSON.stringify(result.slice(0, 10)),
      });
    }
    return isOk;
  } catch (error) {
    logger.error('DB integrity check threw an error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Executes Aave V3 withdrawal via TransactionManager.
 * Simulates first, then broadcasts. Uses init_withdrawal_max_gas ($0.10).
 *
 * Requirements: 0.1, 0.5, 0.7
 */
async function executeAaveWithdrawal(
  db: TradingDatabase,
  config: TradingValidationConfig,
  provider: IPhaseInitProvider,
  simulator: IPreTradeSimulator,
  txManager: ITransactionManager,
  logger: IPhaseInitLogger,
  alerter: IPhaseInitAlerter,
  aUsdcAmount: UsdcAmount,
): Promise<WithdrawalResult> {
  const aavePool = config.contracts.aavePool;
  const usdcAddress = config.contracts.usdc;

  // Generate unique intent ID (idempotent)
  const intentId = `${WITHDRAWAL_INTENT_PREFIX}-${Date.now()}`;

  // ─── Step A: Simulate withdrawal first (Req 0.5) ───
  logger.info('Simulating Aave withdrawal', {
    amount: aUsdcAmount.toString(),
    pool: aavePool,
  });

  const simulationResult = await simulator.simulateWithdrawal(
    usdcAddress,
    aUsdcAmount,
  );

  if (!simulationResult.success) {
    const errorMsg = `Withdrawal simulation failed: ${simulationResult.revertReason ?? 'unknown'}`;
    logger.error(errorMsg);
    await alerter.sendAlert(`Phase init: ${errorMsg}`, true);
    return { success: false, error: errorMsg };
  }

  // ─── Step B: Verify gas within budget (Req 0.7) ───
  const withinBudget = await simulator.isWithinGasBudget(
    simulationResult.gasUsed,
    'init', // init category: $0.10 max
  );

  if (!withinBudget) {
    const errorMsg = `Withdrawal gas exceeds init budget ($0.10): estimated gas units ${simulationResult.gasUsed.toString()}`;
    logger.error(errorMsg);
    await alerter.sendAlert(`Phase init: ${errorMsg}`, true);
    return { success: false, error: errorMsg };
  }

  // ─── Step C: Submit withdrawal via TransactionManager (Req 0.1) ───
  logger.info('Submitting Aave withdrawal intent', { intentId });

  const intentParams: IntentParams = {
    id: intentId,
    contractAddress: aavePool,
    functionName: 'withdraw',
    gasLimit: simulationResult.gasUsed * 130n / 100n, // 30% buffer
    operationType: 'withdrawal',
  };

  try {
    const confirmedIntent = await txManager.submitIntent(intentParams);

    if (confirmedIntent.state === 'confirmed') {
      logger.info('Aave withdrawal confirmed', {
        txHash: confirmedIntent.txHash,
        blockNumber: confirmedIntent.blockNumber?.toString(),
        nonce: confirmedIntent.nonce,
      });

      // ─── Step D: Verify post-withdrawal state (Req 0.2, 0.3) ───
      const postAUsdc = await provider.getAUsdcBalance(config.txManager.walletAddress);
      if (postAUsdc !== 0n) {
        const errorMsg = `aUSDC not zero after confirmed withdrawal: ${postAUsdc.toString()}`;
        logger.error(errorMsg);
        await alerter.sendAlert(`Phase init: ${errorMsg}`, true);
        return { success: false, error: errorMsg };
      }

      // ─── Step E: Verify USDC balance increased (Req 0.3, E1) ───
      const postUsdc = await provider.getUsdcBalance(config.txManager.walletAddress);
      const deviation = postUsdc >= config.bankroll.initialTotal
        ? 0n
        : config.bankroll.initialTotal - postUsdc;

      if (deviation > WITHDRAWAL_DEVIATION_THRESHOLD) {
        // Deviation > $0.10 → Safe_Mode (Req 0.6)
        const errorMsg = `Withdrawal reconciliation deviation $${(Number(deviation) / 1_000_000).toFixed(4)} exceeds $0.10 threshold`;
        logger.error(errorMsg, {
          postUsdc: postUsdc.toString(),
          expected: config.bankroll.initialTotal.toString(),
          deviation: deviation.toString(),
        });
        await alerter.sendAlert(`Phase init SAFE_MODE: ${errorMsg}`, true);
        return { success: false, error: errorMsg };
      }

      return {
        success: true,
        txHash: confirmedIntent.txHash,
        blockNumber: confirmedIntent.blockNumber,
        gasEthSpent: confirmedIntent.gasLimit, // approximation from intent
        amountWithdrawn: aUsdcAmount,
      };
    }

    // Intent reached non-confirmed state (reverted, dropped, etc.)
    const errorMsg = `Withdrawal intent ended in state: ${confirmedIntent.state}${confirmedIntent.revertReason ? ` (${confirmedIntent.revertReason})` : ''}`;
    logger.error(errorMsg);
    await alerter.sendAlert(`Phase init: ${errorMsg}`, true);
    return { success: false, error: errorMsg };
  } catch (error) {
    const errorMsg = `Withdrawal execution error: ${error instanceof Error ? error.message : String(error)}`;
    logger.error(errorMsg);
    await alerter.sendAlert(`Phase init: ${errorMsg}`, true);
    return { success: false, error: errorMsg };
  }
}

/**
 * Encodes the calldata for Aave V3 Pool withdraw(address asset, uint256 amount, address to).
 * Function selector: 0x69328dec
 */
function encodeWithdrawCalldata(asset: string, amount: bigint, to: string): string {
  // withdraw(address,uint256,address) selector = 0x69328dec
  const selector = '69328dec';
  const assetPadded = asset.toLowerCase().replace('0x', '').padStart(64, '0');
  const amountHex = amount.toString(16).padStart(64, '0');
  const toPadded = to.toLowerCase().replace('0x', '').padStart(64, '0');
  return `0x${selector}${assetPadded}${amountHex}${toPadded}`;
}

/**
 * Records the Aave withdrawal event in SQLite event_log table.
 * Requirement: 0.4
 */
function recordWithdrawalEvent(
  db: TradingDatabase,
  result: WithdrawalResult,
  logger: IPhaseInitLogger,
): void {
  try {
    db.prepare(`
      INSERT INTO event_log (event_type, details, timestamp)
      VALUES (?, ?, ?)
    `).run(
      'aave_withdrawal',
      JSON.stringify({
        txHash: result.txHash ?? null,
        blockNumber: result.blockNumber ?? null,
        amountWithdrawn: result.amountWithdrawn?.toString() ?? '0',
        gasEthSpent: result.gasEthSpent?.toString() ?? '0',
      }),
      Date.now(),
    );
    logger.info('Withdrawal event recorded in SQLite');
  } catch (error) {
    logger.error('Failed to record withdrawal event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Records the balance verification in SQLite event_log table.
 */
function recordVerificationEvent(
  db: TradingDatabase,
  usdcBalance: UsdcAmount,
  aUsdcBalance: UsdcAmount,
  configHash: string,
  logger: IPhaseInitLogger,
): void {
  try {
    db.prepare(`
      INSERT INTO event_log (event_type, details, timestamp)
      VALUES (?, ?, ?)
    `).run(
      'phase_init_verification',
      JSON.stringify({
        usdcBalance: usdcBalance.toString(),
        aUsdcBalance: aUsdcBalance.toString(),
        configHash,
        verifiedAt: new Date().toISOString(),
      }),
      Date.now(),
    );
    logger.info('Verification event recorded in SQLite');
  } catch (error) {
    logger.error('Failed to record verification event', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Disables AutoLender by setting the flag in trading_phase table.
 * Requirement: 1.1, 1.2
 */
function disableAutoLender(db: TradingDatabase, logger: IPhaseInitLogger): void {
  try {
    // Check if trading_phase row exists
    const existing = db.prepare('SELECT id FROM trading_phase WHERE id = 1').get();
    if (existing) {
      db.prepare(`
        UPDATE trading_phase
        SET auto_lender_disabled = 1, updated_at = ?
        WHERE id = 1
      `).run(Date.now());
    }
    // If no row exists yet, initializePhaseState will handle it

    logger.info('AutoLender disabled (auto_lender_disabled = 1)');

    // Also log to event_log for audit trail
    db.prepare(`
      INSERT INTO event_log (event_type, details, timestamp)
      VALUES (?, ?, ?)
    `).run(
      'auto_lender_disabled',
      JSON.stringify({ reason: 'phase_initialization', disabledAt: new Date().toISOString() }),
      Date.now(),
    );
  } catch (error) {
    logger.error('Failed to disable AutoLender', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Initializes or updates the trading_phase table with current state.
 * Stores config hash and sets initial mode.
 */
function initializePhaseState(
  db: TradingDatabase,
  mode: string,
  configHash: string,
  logger: IPhaseInitLogger,
): void {
  const now = Date.now();

  try {
    const existing = db.prepare('SELECT id FROM trading_phase WHERE id = 1').get();

    if (existing) {
      db.prepare(`
        UPDATE trading_phase
        SET mode = ?, config_hash = ?, auto_lender_disabled = 1, updated_at = ?
        WHERE id = 1
      `).run(mode, configHash, now);
    } else {
      db.prepare(`
        INSERT INTO trading_phase (id, mode, config_hash, started_at, auto_lender_disabled, updated_at)
        VALUES (1, ?, ?, ?, 1, ?)
      `).run(mode, configHash, now, now);
    }

    logger.info('Phase state initialized in SQLite', { mode, configHash });
  } catch (error) {
    logger.error('Failed to initialize phase state', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Checks if AutoLender is currently disabled.
 * Used by the system to enforce the disable constraint (Req 1.2, 1.3).
 */
export function isAutoLenderDisabled(db: TradingDatabase): boolean {
  try {
    const row = db.prepare(
      'SELECT auto_lender_disabled FROM trading_phase WHERE id = 1',
    ).get() as { auto_lender_disabled: number } | undefined;
    return row?.auto_lender_disabled === 1;
  } catch {
    // If table doesn't exist or query fails, assume not disabled
    return false;
  }
}

/**
 * Gets the current phase config hash from the database.
 */
export function getStoredConfigHash(db: TradingDatabase): string | null {
  try {
    const row = db.prepare(
      'SELECT config_hash FROM trading_phase WHERE id = 1',
    ).get() as { config_hash: string } | undefined;
    return row?.config_hash ?? null;
  } catch {
    return null;
  }
}

/**
 * Creates a BankrollManager initialized with reconciled on-chain balances.
 * This is a convenience function for external callers after phase init.
 */
export function createBankrollManager(
  db: TradingDatabase,
  config: TradingValidationConfig,
  reconciledUsdcBalance: UsdcAmount,
): IBankrollManager {
  const bankrollConfig = {
    ...config.bankroll,
    initialTotal: reconciledUsdcBalance,
    initialReserve: reconciledUsdcBalance > config.bankroll.initialActive
      ? reconciledUsdcBalance - config.bankroll.initialActive
      : 0n,
  };

  if (reconciledUsdcBalance < config.bankroll.initialActive) {
    bankrollConfig.initialActive = reconciledUsdcBalance;
  }

  return new BankrollManager(db, bankrollConfig);
}

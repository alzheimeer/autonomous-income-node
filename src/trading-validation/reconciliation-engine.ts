/**
 * Trading Validation Phase - ReconciliationEngine
 *
 * Post-operation balance verification with mismatch tracking.
 * Waits for receipt + 1 block confirmation, verifies USDC and WETH balances
 * after every operation, verifies allowance after approval operations,
 * converts gas ETH→USD using current WETH/USDC price,
 * applies threshold: max(1% of operation, $0.05),
 * retries 3x with backoff on RPC error,
 * tracks mismatches: 3 in 24h → permanent KillSwitch.
 * Persists all results to reconciliation_log table.
 *
 * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
 */

import type { TradingDatabase } from './db.js';
import type {
  UsdcAmount,
  WethAmount,
  EthAmount,
  ReconciliationResult,
} from './types.js';
import type { ReconciliationConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** Expected state after an operation, provided by the caller */
export interface ExpectedState {
  /** Intent ID for linking to tx_intents table */
  intentId?: string;
  /** Expected USDC balance after operation (6 decimals) */
  expectedUsdc: UsdcAmount;
  /** Expected WETH balance after operation (18 decimals) */
  expectedWeth: WethAmount;
  /** Transaction hash to wait for confirmation */
  txHash: string;
  /** Operation size in USDC for threshold calculation (6 decimals) */
  operationSizeUsdc: UsdcAmount;
  /** Gas paid in ETH (wei) — from transaction receipt */
  gasEthSpent: EthAmount;
  /** If this was an approval operation, expected allowance */
  expectedAllowance?: bigint;
  /** Token address for allowance verification */
  allowanceToken?: string;
  /** Spender address for allowance verification */
  allowanceSpender?: string;
}

/** Provider interface for on-chain balance/state queries */
export interface IReconciliationProvider {
  /** Get USDC balance for wallet (6 decimals) */
  getUsdcBalance(wallet: string): Promise<UsdcAmount>;
  /** Get WETH balance for wallet (18 decimals) */
  getWethBalance(wallet: string): Promise<WethAmount>;
  /** Get ERC-20 allowance */
  getAllowance(token: string, owner: string, spender: string): Promise<bigint>;
  /** Get current block number */
  getBlockNumber(): Promise<number>;
  /** Get the block number in which a transaction was included */
  getTransactionBlockNumber(txHash: string): Promise<number | null>;
  /** Get current WETH/USDC price (how many USDC per 1 WETH, 6 decimal number) */
  getWethUsdcPrice(): Promise<number>;
}

/** SafeMode trigger interface for KillSwitch escalation */
export interface IReconciliationSafeModeController {
  triggerKillSwitch(reason: string): void;
  trigger(reason: 'recon_mismatch', details: string): void;
}

/** Logger interface */
export interface IReconciliationLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** IReconciliationEngine interface */
export interface IReconciliationEngine {
  /** Reconcile expected vs actual state after an operation */
  reconcile(expected: ExpectedState, operationType: string): Promise<ReconciliationResult>;
  /** Verify allowance matches expected value after approval */
  verifyAllowance(token: string, spender: string, expected: bigint): Promise<boolean>;
  /** Get count of mismatches in the last 24 hours */
  getMismatchCount24h(): number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Minimum threshold in USDC (6 decimals): $0.05 */
const MIN_THRESHOLD_USDC = 50_000n;

/** Number of mismatches in 24h to trigger KillSwitch */
const MISMATCH_KILL_SWITCH_COUNT = 3;

/** 24 hours in milliseconds */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ReconciliationEngine verifies on-chain state after every transaction.
 *
 * Flow:
 * 1. Wait for tx receipt + N block confirmations
 * 2. Query actual USDC and WETH balances
 * 3. Compare against expected with threshold: max(1% of operation, $0.05)
 * 4. Verify allowance if approval operation
 * 5. Convert gas ETH→USD using current WETH/USDC price
 * 6. Track mismatches: 3 in 24h → permanent KillSwitch
 * 7. Persist to reconciliation_log table
 *
 * RPC errors are retried 3x with exponential backoff.
 */
export class ReconciliationEngine implements IReconciliationEngine {
  private readonly db: TradingDatabase;
  private readonly config: ReconciliationConfig;
  private readonly provider: IReconciliationProvider;
  private readonly safeModeController: IReconciliationSafeModeController;
  private readonly logger: IReconciliationLogger;
  private readonly walletAddress: string;

  constructor(
    db: TradingDatabase,
    config: ReconciliationConfig,
    provider: IReconciliationProvider,
    safeModeController: IReconciliationSafeModeController,
    logger: IReconciliationLogger,
    walletAddress: string,
  ) {
    this.db = db;
    this.config = config;
    this.provider = provider;
    this.safeModeController = safeModeController;
    this.logger = logger;
    this.walletAddress = walletAddress;
  }

  /**
   * Reconcile expected vs actual on-chain state after an operation.
   *
   * 1. Wait for tx confirmation + confirmationBlocks
   * 2. Read actual balances from chain
   * 3. Compute deviation and compare against threshold
   * 4. Verify allowance if approval operation
   * 5. Convert gas to USD
   * 6. Persist result
   * 7. If mismatch: trigger Safe_Mode + check KillSwitch escalation
   *
   * Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6
   */
  async reconcile(
    expected: ExpectedState,
    operationType: string,
  ): Promise<ReconciliationResult> {
    // Step 1: Wait for block confirmation with retry on RPC error
    await this.waitForConfirmation(expected.txHash);

    // Step 2: Read actual balances with retry
    const [actualUsdc, actualWeth] = await this.withRetry(
      async () => {
        const usdc = await this.provider.getUsdcBalance(this.walletAddress);
        const weth = await this.provider.getWethBalance(this.walletAddress);
        return [usdc, weth] as const;
      },
      'getBalances',
    );

    // Step 3: Calculate deviation (absolute value of USDC difference)
    const usdcDiff = actualUsdc > expected.expectedUsdc
      ? actualUsdc - expected.expectedUsdc
      : expected.expectedUsdc - actualUsdc;
    const wethDiff = actualWeth > expected.expectedWeth
      ? actualWeth - expected.expectedWeth
      : expected.expectedWeth - actualWeth;

    // Convert WETH diff to USDC equivalent for combined deviation
    const wethUsdcPrice = await this.withRetry(
      () => this.provider.getWethUsdcPrice(),
      'getWethUsdcPrice',
    );

    // wethDiff is in 18 decimals, price is USDC per WETH (float)
    // deviationFromWeth = wethDiff * price / 1e18 * 1e6 (convert to USDC 6 decimals)
    const wethDeviationUsdc = BigInt(
      Math.round(Number(wethDiff) * wethUsdcPrice / 1e12),
    );

    // Total deviation in USDC
    const deviationUsdc = usdcDiff + wethDeviationUsdc;

    // Step 4: Compute threshold: max(1% of operation, $0.05)
    const onePercentOfOperation = expected.operationSizeUsdc / 100n;
    const threshold = onePercentOfOperation > MIN_THRESHOLD_USDC
      ? onePercentOfOperation
      : MIN_THRESHOLD_USDC;

    const matched = deviationUsdc <= threshold;

    // Step 5: Convert gas ETH→USD
    // gasEthSpent is in wei (18 decimals)
    // gasUsdEquivalent = gasEthSpent * wethUsdcPrice / 1e18 * 1e6 → USDC 6 decimals
    const gasUsdEquivalent = BigInt(
      Math.round(Number(expected.gasEthSpent) * wethUsdcPrice / 1e12),
    );

    // Step 6: Verify allowance if applicable
    let allowanceVerified: boolean | undefined;
    if (
      expected.expectedAllowance !== undefined &&
      expected.allowanceToken &&
      expected.allowanceSpender
    ) {
      allowanceVerified = await this.verifyAllowance(
        expected.allowanceToken,
        expected.allowanceSpender,
        expected.expectedAllowance,
      );
    }

    // Build result
    const result: ReconciliationResult = {
      matched,
      expectedUsdc: expected.expectedUsdc,
      actualUsdc,
      expectedWeth: expected.expectedWeth,
      actualWeth,
      deviationUsdc,
      gasEthSpent: expected.gasEthSpent,
      gasUsdEquivalent,
      allowanceVerified,
    };

    // Step 7: Persist to reconciliation_log
    this.persistResult(result, operationType, expected.intentId);

    // Step 8: Handle mismatch
    if (!matched) {
      this.logger.warn('Reconciliation mismatch detected', {
        operationType,
        intentId: expected.intentId,
        deviationUsdc: deviationUsdc.toString(),
        threshold: threshold.toString(),
        expectedUsdc: expected.expectedUsdc.toString(),
        actualUsdc: actualUsdc.toString(),
        expectedWeth: expected.expectedWeth.toString(),
        actualWeth: actualWeth.toString(),
      });

      // Trigger Safe_Mode for the mismatch
      this.safeModeController.trigger(
        'recon_mismatch',
        `Deviation ${deviationUsdc.toString()} > threshold ${threshold.toString()} for ${operationType}`,
      );

      // Check if 3 mismatches in 24h → KillSwitch
      const mismatchCount = this.getMismatchCount24h();
      if (mismatchCount >= MISMATCH_KILL_SWITCH_COUNT) {
        this.logger.error('KillSwitch triggered: 3+ reconciliation mismatches in 24h', {
          mismatchCount,
          operationType,
        });
        this.safeModeController.triggerKillSwitch(
          `${mismatchCount} reconciliation mismatches in 24h (threshold: ${MISMATCH_KILL_SWITCH_COUNT})`,
        );
      }
    } else {
      this.logger.info('Reconciliation passed', {
        operationType,
        intentId: expected.intentId,
        deviationUsdc: deviationUsdc.toString(),
        threshold: threshold.toString(),
        gasUsd: gasUsdEquivalent.toString(),
      });
    }

    return result;
  }

  /**
   * Verify ERC-20 allowance matches expected value.
   * Returns true if actual >= expected.
   *
   * Requirement: 13.2 (verify allowance after approval operations)
   */
  async verifyAllowance(
    token: string,
    spender: string,
    expected: bigint,
  ): Promise<boolean> {
    const actual = await this.withRetry(
      () => this.provider.getAllowance(token, this.walletAddress, spender),
      'getAllowance',
    );

    const verified = actual >= expected;

    if (!verified) {
      this.logger.warn('Allowance verification failed', {
        token,
        spender,
        expected: expected.toString(),
        actual: actual.toString(),
      });
    }

    return verified;
  }

  /**
   * Get count of mismatches in the last 24 hours from reconciliation_log.
   *
   * Requirement: 13.5 (track mismatches: 3 in 24h → KillSwitch)
   */
  getMismatchCount24h(): number {
    const since = Date.now() - TWENTY_FOUR_HOURS_MS;
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM reconciliation_log
       WHERE matched = 0 AND timestamp >= ?`,
    ).get(since) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Wait for transaction confirmation + N additional blocks.
   * Uses retry with backoff for RPC errors.
   *
   * Requirement: 13.1 (wait for receipt + 1 block confirmation)
   */
  private async waitForConfirmation(txHash: string): Promise<void> {
    // First, get the block in which the tx was mined
    const txBlockNumber = await this.withRetry(
      async () => {
        const block = await this.provider.getTransactionBlockNumber(txHash);
        if (block === null) {
          throw new Error(`Transaction ${txHash} not yet mined`);
        }
        return block;
      },
      'getTransactionBlockNumber',
    );

    // Wait until currentBlock >= txBlockNumber + confirmationBlocks
    const targetBlock = txBlockNumber + this.config.confirmationBlocks;

    let attempts = 0;
    const maxWaitAttempts = 60; // Max ~2 minutes at 2s intervals

    while (attempts < maxWaitAttempts) {
      const currentBlock = await this.withRetry(
        () => this.provider.getBlockNumber(),
        'getBlockNumber',
      );

      if (currentBlock >= targetBlock) {
        return;
      }

      attempts++;
      await sleep(2000); // Poll every 2 seconds (Base has ~2s blocks)
    }

    // If we exhausted wait attempts, proceed anyway with a warning
    this.logger.warn('Block confirmation wait timeout, proceeding with reconciliation', {
      txHash,
      targetBlock,
      attempts,
    });
  }

  /**
   * Execute an async operation with retry on RPC error.
   * Retries up to maxRetries times with exponential backoff.
   *
   * Requirement: 13.4 (retry 3x with backoff on RPC error)
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;

        if (attempt < this.config.maxRetries) {
          const backoffMs = this.config.retryBackoffMs * Math.pow(2, attempt);
          this.logger.warn(`RPC retry ${attempt + 1}/${this.config.maxRetries} for ${operationName}`, {
            error: error instanceof Error ? error.message : String(error),
            backoffMs,
          });
          await sleep(backoffMs);
        }
      }
    }

    // All retries exhausted
    this.logger.error(`RPC operation failed after ${this.config.maxRetries} retries: ${operationName}`, {
      error: lastError instanceof Error ? lastError.message : String(lastError),
    });
    throw lastError;
  }

  /**
   * Persist reconciliation result to the reconciliation_log table.
   *
   * Requirement: 13.6 (persist to reconciliation_log table)
   */
  private persistResult(
    result: ReconciliationResult,
    operationType: string,
    intentId?: string,
  ): void {
    const now = Date.now();

    this.db.prepare(
      `INSERT INTO reconciliation_log
       (operation_type, intent_id, expected_usdc, actual_usdc, expected_weth, actual_weth,
        deviation_usdc, gas_eth_spent, matched, allowance_verified, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      operationType,
      intentId ?? null,
      result.expectedUsdc.toString(),
      result.actualUsdc.toString(),
      result.expectedWeth.toString(),
      result.actualWeth.toString(),
      result.deviationUsdc.toString(),
      result.gasEthSpent.toString(),
      result.matched ? 1 : 0,
      result.allowanceVerified !== undefined ? (result.allowanceVerified ? 1 : 0) : null,
      now,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Async sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

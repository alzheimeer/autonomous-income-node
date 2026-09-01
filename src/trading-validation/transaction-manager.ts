/**
 * Trading Validation Phase - TransactionManager
 *
 * Single-writer pattern for transaction lifecycle management.
 * Handles nonce serialization, idempotent intent IDs, contract allowlist
 * verification (EIP-55), monitoring with 5-min timeout, speed-up/cancel
 * logic, revert decoding, and token approval management.
 *
 * Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 18.1, 18.2, 18.3, 18.4, E2, E5, E13
 */

import type { TradingDatabase } from './db.js';
import { getAddress } from 'ethers';
import type { TransactionIntent, IntentState } from './types.js';
import type { TransactionManagerConfig } from './config.js';
import { decodeRevertReason } from './pre-trade-simulator.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** Parameters for creating a new transaction intent */
export interface IntentParams {
  id: string;
  contractAddress: string;
  functionName: string;
  gasLimit: bigint;
  operationType: 'withdrawal' | 'approval' | 'entry' | 'exit' | 'gas_swap';
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}

/** Result of submitting a transaction */
export interface SubmitResult {
  intent: TransactionIntent;
  txHash: string;
}

/** Transaction receipt from provider */
export interface TxReceipt {
  status: number; // 1 = success, 0 = revert
  blockNumber: number;
  gasUsed: bigint;
  transactionHash: string;
  /** Revert data if status === 0 */
  revertData?: string;
}

/** Provider interface for broadcasting and monitoring transactions */
export interface ITxProvider {
  /** Get current on-chain nonce for the wallet */
  getTransactionCount(address: string): Promise<number>;
  /** Send a signed raw transaction */
  sendRawTransaction(signedTx: string): Promise<string>;
  /** Get transaction receipt, null if not mined yet */
  getTransactionReceipt(txHash: string): Promise<TxReceipt | null>;
  /** Get current gas price params (EIP-1559) */
  getFeeData(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }>;
  /** Check ERC-20 allowance */
  getAllowance(token: string, owner: string, spender: string): Promise<bigint>;
}

/** Signer interface for transaction signing */
export interface ITxSigner {
  /** Sign a transaction with the given params and return raw signed tx hex */
  signTransaction(params: SignTxParams): Promise<string>;
}

/** Parameters for signing a transaction */
export interface SignTxParams {
  to: string;
  nonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  data: string;
  value?: bigint;
}

/** Logger interface for transaction events */
export interface ITxLogger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/**
 * ITransactionManager interface.
 * Single-writer nonce management with idempotent intents.
 */
export interface ITransactionManager {
  /** Submit a new intent (create + broadcast). Rejects duplicate IDs. */
  submitIntent(intent: IntentParams): Promise<TransactionIntent>;
  /** Get an intent by ID */
  getIntent(id: string): TransactionIntent | null;
  /** Cancel a pending intent (submit 0-value tx to same nonce) */
  cancelIntent(id: string): Promise<TransactionIntent>;
  /** Speed up a pending intent (resubmit with higher gas) */
  speedUpIntent(id: string): Promise<TransactionIntent>;
  /** Get count of failed (reverted/broadcasted) txs today (E2) */
  getFailedTxCountToday(): number;
  /** Check current ERC-20 allowance */
  checkAllowance(token: string, spender: string): Promise<bigint>;
  /** Ensure approval is sufficient; submit approval tx if needed */
  ensureApproval(token: string, spender: string, amount: bigint): Promise<TransactionIntent | null>;
  /** Get the next nonce that would be used (without claiming it) */
  getNextNonce(): number;
  /** Get the currently pending intent (if any) */
  getPendingIntent(): TransactionIntent | null;
  /** Check if a contract address is in the allowlist (EIP-55) */
  isAllowlisted(address: string): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Mutex Implementation (single-writer pattern)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Simple async mutex for single-writer nonce serialization.
 * Ensures only one transaction is being signed/submitted at a time.
 */
class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!;
      next();
    } else {
      this.locked = false;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class TransactionManager implements ITransactionManager {
  private readonly db: TradingDatabase;
  private readonly config: TransactionManagerConfig;
  private readonly provider: ITxProvider;
  private readonly signer: ITxSigner;
  private readonly logger: ITxLogger;
  private readonly mutex = new Mutex();

  /** Checksummed allowlist for fast lookup */
  private readonly allowlistSet: Set<string>;

  constructor(
    db: TradingDatabase,
    config: TransactionManagerConfig,
    provider: ITxProvider,
    signer: ITxSigner,
    logger: ITxLogger,
  ) {
    this.db = db;
    this.config = config;
    this.provider = provider;
    this.signer = signer;
    this.logger = logger;

    // Build checksummed allowlist set
    this.allowlistSet = new Set(
      config.contractAllowlist.map((addr) => getAddress(addr)),
    );
  }

  /**
   * Submit a new transaction intent.
   * - Rejects duplicate intent IDs (idempotent)
   * - Validates contract against allowlist (EIP-55)
   * - Claims nonce under mutex (single-writer)
   * - Signs and broadcasts
   * - Monitors until receipt or 5-min timeout
   *
   * Requirements: 17.1, 17.3, 17.6
   */
  async submitIntent(params: IntentParams): Promise<TransactionIntent> {
    // Idempotent: reject duplicate intent IDs
    const existing = this.getIntent(params.id);
    if (existing) {
      this.logger.warn('Duplicate intent ID rejected', { id: params.id, existingState: existing.state });
      throw new Error(`Duplicate intent ID: ${params.id}`);
    }

    // Validate contract address against allowlist (EIP-55)
    if (!this.isAllowlisted(params.contractAddress)) {
      throw new Error(
        `Contract not in allowlist: ${params.contractAddress}`,
      );
    }

    // Acquire mutex for single-writer nonce serialization
    await this.mutex.acquire();
    try {
      // Claim next nonce
      const nonce = this.claimNextNonce();

      // Create intent record
      const now = Date.now();
      const intent: TransactionIntent = {
        id: params.id,
        state: 'created',
        nonce,
        contractAddress: params.contractAddress,
        functionName: params.functionName,
        gasLimit: params.gasLimit,
        maxFeePerGas: params.maxFeePerGas,
        maxPriorityFeePerGas: params.maxPriorityFeePerGas,
        createdAt: now,
        updatedAt: now,
      };

      // Persist intent
      this.persistIntent(intent, params.operationType);

      // Get fee data if not provided
      let maxFeePerGas = params.maxFeePerGas;
      let maxPriorityFeePerGas = params.maxPriorityFeePerGas;
      if (!maxFeePerGas || !maxPriorityFeePerGas) {
        const feeData = await this.provider.getFeeData();
        maxFeePerGas = maxFeePerGas ?? feeData.maxFeePerGas;
        maxPriorityFeePerGas = maxPriorityFeePerGas ?? feeData.maxPriorityFeePerGas;
      }

      intent.maxFeePerGas = maxFeePerGas;
      intent.maxPriorityFeePerGas = maxPriorityFeePerGas;

      // Update state to pending
      const pendingState: IntentState = params.operationType === 'approval'
        ? 'approval_pending'
        : 'swap_pending';
      this.updateIntentState(intent, pendingState);

      // Sign transaction
      const signedTx = await this.signer.signTransaction({
        to: params.contractAddress,
        nonce,
        gasLimit: params.gasLimit,
        maxFeePerGas,
        maxPriorityFeePerGas,
        data: '', // Caller encodes calldata into contractAddress interaction
      });

      // Broadcast
      const txHash = await this.provider.sendRawTransaction(signedTx);
      intent.txHash = txHash;
      this.updateIntentTxHash(intent);

      if (params.operationType === 'approval') {
        this.updateIntentState(intent, 'approval_submitted');
      }

      this.logger.info('Transaction broadcast', {
        id: intent.id,
        nonce,
        txHash,
        contract: params.contractAddress,
        function: params.functionName,
      });

      // Monitor until receipt or timeout
      const finalIntent = await this.monitorIntent(intent);
      return finalIntent;
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Get an intent by ID from the database.
   */
  getIntent(id: string): TransactionIntent | null {
    const row = this.db.prepare(
      'SELECT * FROM tx_intents WHERE id = ?',
    ).get(id) as TxIntentRow | undefined;

    if (!row) return null;
    return rowToIntent(row);
  }

  /**
   * Cancel a pending intent by submitting a 0-value tx to the same nonce.
   * Entries may cancel if quote is stale.
   *
   * Requirement: 17.5
   */
  async cancelIntent(id: string): Promise<TransactionIntent> {
    const intent = this.getIntent(id);
    if (!intent) {
      throw new Error(`Intent not found: ${id}`);
    }

    const cancelableStates: IntentState[] = ['approval_pending', 'approval_submitted', 'swap_pending'];
    if (!cancelableStates.includes(intent.state)) {
      throw new Error(`Cannot cancel intent in state: ${intent.state}`);
    }

    await this.mutex.acquire();
    try {
      // Submit a 0-value self-transfer to same nonce (cancellation pattern)
      const feeData = await this.provider.getFeeData();
      // Bump gas by 10% to ensure replacement
      const bumpedMaxFee = (feeData.maxFeePerGas * 110n) / 100n;
      const bumpedPriorityFee = (feeData.maxPriorityFeePerGas * 110n) / 100n;

      const signedTx = await this.signer.signTransaction({
        to: this.config.walletAddress,
        nonce: intent.nonce,
        gasLimit: 21_000n,
        maxFeePerGas: bumpedMaxFee,
        maxPriorityFeePerGas: bumpedPriorityFee,
        data: '0x',
        value: 0n,
      });

      const txHash = await this.provider.sendRawTransaction(signedTx);
      this.updateIntentState(intent, 'cancelled');
      intent.txHash = txHash;
      this.updateIntentTxHash(intent);

      this.logger.info('Intent cancelled', { id, nonce: intent.nonce, txHash });
      return intent;
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Speed up a pending intent by resubmitting with higher gas price.
   * Exits prefer speed-up over cancel.
   *
   * Requirement: 17.4
   */
  async speedUpIntent(id: string): Promise<TransactionIntent> {
    const intent = this.getIntent(id);
    if (!intent) {
      throw new Error(`Intent not found: ${id}`);
    }

    const speedUpableStates: IntentState[] = ['approval_pending', 'approval_submitted', 'swap_pending'];
    if (!speedUpableStates.includes(intent.state)) {
      throw new Error(`Cannot speed up intent in state: ${intent.state}`);
    }

    await this.mutex.acquire();
    try {
      const feeData = await this.provider.getFeeData();
      // Bump gas by 25% for speed-up (must exceed original + 10% minimum)
      const bumpedMaxFee = (feeData.maxFeePerGas * 125n) / 100n;
      const bumpedPriorityFee = (feeData.maxPriorityFeePerGas * 125n) / 100n;

      const signedTx = await this.signer.signTransaction({
        to: intent.contractAddress,
        nonce: intent.nonce,
        gasLimit: intent.gasLimit,
        maxFeePerGas: bumpedMaxFee,
        maxPriorityFeePerGas: bumpedPriorityFee,
        data: '', // Same calldata as original
      });

      const txHash = await this.provider.sendRawTransaction(signedTx);
      intent.txHash = txHash;
      intent.maxFeePerGas = bumpedMaxFee;
      intent.maxPriorityFeePerGas = bumpedPriorityFee;
      this.updateIntentTxHash(intent);
      this.updateIntentGas(intent);

      // State remains the same (still pending), marked as replaced
      this.updateIntentState(intent, 'replaced');

      this.logger.info('Intent speed-up submitted', {
        id,
        nonce: intent.nonce,
        newTxHash: txHash,
        maxFeePerGas: bumpedMaxFee.toString(),
      });
      return intent;
    } finally {
      this.mutex.release();
    }
  }

  /**
   * Get the count of failed (reverted/dropped) broadcasted transactions today.
   * Only counts broadcasted failures per requirement E2.
   * Does NOT count simulation failures, quote rejections, or gate rejections.
   */
  getFailedTxCountToday(): number {
    const todayUtc = getUtcDateString();
    const row = this.db.prepare(
      `SELECT COUNT(*) as count FROM tx_intents
       WHERE state IN ('reverted', 'dropped')
       AND date(updated_at / 1000, 'unixepoch') = ?`,
    ).get(todayUtc) as { count: number } | undefined;

    return row?.count ?? 0;
  }

  /**
   * Get the next nonce that would be used (without claiming it).
   * Useful for read-only inspection of the nonce state.
   */
  getNextNonce(): number {
    const row = this.db.prepare(
      'SELECT next_nonce FROM nonce_registry WHERE id = 1',
    ).get() as { next_nonce: number } | undefined;

    if (!row) {
      throw new Error('Nonce registry not initialized. Run migrations first.');
    }
    return row.next_nonce;
  }

  /**
   * Get the currently pending intent (if any).
   * Returns the most recently created intent that is not in a terminal state.
   *
   * Requirement: 17.1 (single-writer, max 1 pending)
   */
  getPendingIntent(): TransactionIntent | null {
    const row = this.db.prepare(
      `SELECT * FROM tx_intents
       WHERE state IN ('created', 'approval_pending', 'approval_submitted', 'swap_pending')
       ORDER BY created_at DESC
       LIMIT 1`,
    ).get() as TxIntentRow | undefined;

    if (!row) return null;
    return rowToIntent(row);
  }

  /**
   * Check if a contract address is in the allowlist (EIP-55 checksummed).
   * Requirement: 17.3
   */
  isAllowlisted(address: string): boolean {
    try {
      const checksummed = getAddress(address);
      return this.allowlistSet.has(checksummed);
    } catch {
      return false;
    }
  }

  /**
   * Check current ERC-20 allowance on-chain.
   *
   * Requirement: 18.1
   */
  async checkAllowance(token: string, spender: string): Promise<bigint> {
    return this.provider.getAllowance(token, this.config.walletAddress, spender);
  }

  /**
   * Ensure approval is sufficient for the requested amount.
   * Uses exact amounts (E13). Skips if existing allowance is sufficient.
   *
   * Requirements: 18.1, 18.2, 18.3, 18.4, E13
   */
  async ensureApproval(
    token: string,
    spender: string,
    amount: bigint,
  ): Promise<TransactionIntent | null> {
    const currentAllowance = await this.checkAllowance(token, spender);

    // Skip if existing allowance is sufficient (18.2)
    if (currentAllowance >= amount) {
      this.logger.info('Existing allowance sufficient, skipping approval', {
        token,
        spender,
        current: currentAllowance.toString(),
        required: amount.toString(),
      });
      return null;
    }

    // Submit exact amount approval (E13: exact amounts, no infinite approvals)
    const intentId = `approval-${token}-${spender}-${Date.now()}`;
    const intent = await this.submitIntent({
      id: intentId,
      contractAddress: token,
      functionName: 'approve',
      gasLimit: 60_000n,
      operationType: 'approval',
    });

    return intent;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Claim the next nonce from the persistent nonce_registry.
   * Single-writer ensures no conflicts.
   *
   * Requirement: 17.2
   */
  private claimNextNonce(): number {
    const row = this.db.prepare(
      'SELECT next_nonce FROM nonce_registry WHERE id = 1',
    ).get() as { next_nonce: number } | undefined;

    if (!row) {
      throw new Error('Nonce registry not initialized. Run migrations first.');
    }

    const nonce = row.next_nonce;

    // Increment next_nonce
    this.db.prepare(
      'UPDATE nonce_registry SET next_nonce = ?, updated_at = ? WHERE id = 1',
    ).run(nonce + 1, Date.now());

    return nonce;
  }

  /**
   * Monitor an intent until receipt or 5-min timeout.
   * On revert: decode reason, count as failed, no retry with stale quote.
   *
   * Requirements: 17.1, 17.5
   */
  private async monitorIntent(intent: TransactionIntent): Promise<TransactionIntent> {
    if (!intent.txHash) {
      throw new Error('Cannot monitor intent without txHash');
    }

    const startTime = Date.now();
    const timeoutMs = this.config.timeoutMs;

    while (Date.now() - startTime < timeoutMs) {
      const receipt = await this.provider.getTransactionReceipt(intent.txHash);

      if (receipt) {
        if (receipt.status === 1) {
          // Success
          this.updateIntentState(intent, 'confirmed');
          intent.blockNumber = receipt.blockNumber;
          this.updateIntentBlockNumber(intent);
          this.confirmNonce(intent.nonce);

          this.logger.info('Transaction confirmed', {
            id: intent.id,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed.toString(),
          });
          return intent;
        } else {
          // Revert: decode reason, count as failed (E2)
          const revertReason = receipt.revertData
            ? decodeRevertReason(receipt.revertData)
            : 'Unknown revert';

          intent.revertReason = revertReason;
          intent.blockNumber = receipt.blockNumber;
          this.updateIntentState(intent, 'reverted');
          this.updateIntentBlockNumber(intent);
          this.updateIntentRevertReason(intent);
          this.confirmNonce(intent.nonce);

          this.logger.error('Transaction reverted', {
            id: intent.id,
            nonce: intent.nonce,
            reason: revertReason,
            blockNumber: receipt.blockNumber,
          });
          return intent;
        }
      }

      // Poll every 2 seconds
      await sleep(2000);
    }

    // Timeout: mark as dropped
    this.updateIntentState(intent, 'dropped');
    this.logger.warn('Transaction timed out', {
      id: intent.id,
      nonce: intent.nonce,
      txHash: intent.txHash,
      timeoutMs,
    });
    return intent;
  }

  /**
   * Update last_confirmed_nonce in nonce_registry after confirmation.
   */
  private confirmNonce(nonce: number): void {
    this.db.prepare(
      `UPDATE nonce_registry SET last_confirmed_nonce = ?, updated_at = ?
       WHERE id = 1 AND last_confirmed_nonce < ?`,
    ).run(nonce, Date.now(), nonce);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Database Persistence
  // ═══════════════════════════════════════════════════════════════════════

  private persistIntent(intent: TransactionIntent, operationType: string): void {
    this.db.prepare(
      `INSERT INTO tx_intents (id, state, nonce, tx_hash, contract_address, function_name,
         gas_limit, max_fee_per_gas, max_priority_fee, created_at, updated_at,
         block_number, revert_reason, operation_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      intent.id,
      intent.state,
      intent.nonce,
      intent.txHash ?? null,
      intent.contractAddress,
      intent.functionName,
      intent.gasLimit.toString(),
      intent.maxFeePerGas?.toString() ?? null,
      intent.maxPriorityFeePerGas?.toString() ?? null,
      intent.createdAt,
      intent.updatedAt,
      intent.blockNumber ?? null,
      intent.revertReason ?? null,
      operationType,
    );
  }

  private updateIntentState(intent: TransactionIntent, newState: IntentState): void {
    intent.state = newState;
    intent.updatedAt = Date.now();
    this.db.prepare(
      'UPDATE tx_intents SET state = ?, updated_at = ? WHERE id = ?',
    ).run(newState, intent.updatedAt, intent.id);
  }

  private updateIntentTxHash(intent: TransactionIntent): void {
    this.db.prepare(
      'UPDATE tx_intents SET tx_hash = ?, updated_at = ? WHERE id = ?',
    ).run(intent.txHash ?? null, Date.now(), intent.id);
  }

  private updateIntentBlockNumber(intent: TransactionIntent): void {
    this.db.prepare(
      'UPDATE tx_intents SET block_number = ?, updated_at = ? WHERE id = ?',
    ).run(intent.blockNumber ?? null, Date.now(), intent.id);
  }

  private updateIntentRevertReason(intent: TransactionIntent): void {
    this.db.prepare(
      'UPDATE tx_intents SET revert_reason = ?, updated_at = ? WHERE id = ?',
    ).run(intent.revertReason ?? null, Date.now(), intent.id);
  }

  private updateIntentGas(intent: TransactionIntent): void {
    this.db.prepare(
      'UPDATE tx_intents SET max_fee_per_gas = ?, max_priority_fee = ?, updated_at = ? WHERE id = ?',
    ).run(
      intent.maxFeePerGas?.toString() ?? null,
      intent.maxPriorityFeePerGas?.toString() ?? null,
      Date.now(),
      intent.id,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Database row shape for tx_intents */
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

/** Convert a DB row to a TransactionIntent object */
function rowToIntent(row: TxIntentRow): TransactionIntent {
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

/** Get today's date in UTC as YYYY-MM-DD string */
function getUtcDateString(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

/** Async sleep helper */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rug Alert Service — LP Removal Detector
 *
 * Subscribes to Transfer events on the LP token contract for each monitored
 * pool and emits alerts when a significant amount of LP tokens are burned
 * (transferred to ZeroAddress) or removed from the pool address.
 *
 * On each matching Transfer event the detector fetches `totalSupply()` at the
 * event's block height to compute the percentage of supply removed:
 *   - ≥ 20% and < 60% → HIGH
 *   - ≥ 60%           → CRITICAL
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4
 */

import { ethers } from 'ethers';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { AlertEmitter } from './types.js';
import { ERC20_TRANSFER_ABI } from './abis.js';

const log = createLogger('lp-removal-detector');

// ═══════════════════════════════════════════════════════════════════════════
// Internal record (includes the live Contract instance)
// ═══════════════════════════════════════════════════════════════════════════

interface InternalLpRecord {
  positionId: string;
  /** Token contract address (used as contractAddress in AlertEvent) */
  contractAddress: string;
  lpTokenAddress: string;
  poolAddress: string;
  lpContract: ethers.Contract;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public record type (no lpContract — created internally by addPool)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Public record passed to `addPool`. Does NOT include `lpContract` — the
 * detector creates the contract instance internally.
 */
export type LpRecord = Omit<InternalLpRecord, 'lpContract'>;

// ═══════════════════════════════════════════════════════════════════════════
// LP removal percentage helper (pure, exported for testing)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Computes the percentage of total LP supply that was removed in a single
 * transfer event, using bigint arithmetic to avoid floating-point loss.
 *
 * Returns a number like 25.0 to mean "25% of supply removed".
 * Returns 0 if `totalSupply` is 0n (caller should guard against this).
 *
 * @param amount      - LP tokens transferred in the event (bigint)
 * @param totalSupply - Total LP supply at the event's block height (bigint)
 */
export function computeLpRemovedPct(amount: bigint, totalSupply: bigint): number {
  if (totalSupply === 0n) return 0;
  return Number(amount * 10_000n / totalSupply) / 100;
}

/**
 * Classifies the LP removal percentage into an alert severity.
 *
 * Thresholds (exclusive branches):
 *  - < 20%           → null (no alert)
 *  - ≥ 20% and < 60% → 'HIGH'
 *  - ≥ 60%           → 'CRITICAL'
 */
export function classifyLpRemoval(pct: number): 'HIGH' | 'CRITICAL' | null {
  if (pct >= 60) return 'CRITICAL';
  if (pct >= 20) return 'HIGH';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// LpRemovalDetector class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Attaches an ethers Transfer event listener to each registered LP token
 * contract. Filters for burns (to === ZeroAddress) and pool-address removals
 * (from === poolAddress). When a matching transfer exceeds the configured
 * severity threshold an AlertEvent is emitted via the `onAlert` callback.
 *
 * Lifecycle:
 *  - `addPool(record)`      — creates Contract, attaches listener
 *  - `removePool(posId)`    — detaches listeners, deletes record
 *  - `start()`              — no-op (listeners attached in addPool)
 *  - `stop()`               — calls removePool for every active record
 */
export class LpRemovalDetector {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly onAlert: AlertEmitter;
  private readonly records = new Map<string, InternalLpRecord>();

  constructor(provider: ethers.JsonRpcProvider, onAlert: AlertEmitter) {
    this.provider = provider;
    this.onAlert = onAlert;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Registers a pool for LP removal monitoring.
   *
   * Creates an `ethers.Contract` on the LP token address, attaches a Transfer
   * listener, and stores the internal record keyed by `positionId`.
   *
   * Re-registering an already-tracked positionId is a no-op with a warning.
   */
  addPool(record: LpRecord): void {
    if (this.records.has(record.positionId)) {
      log.warn('addPool called for already-tracked positionId — ignoring', {
        positionId: record.positionId,
      });
      return;
    }

    const lpContract = new ethers.Contract(
      record.lpTokenAddress,
      ERC20_TRANSFER_ABI,
      this.provider,
    );

    const internal: InternalLpRecord = { ...record, lpContract };
    this.records.set(record.positionId, internal);

    // Build the typed Transfer filter so ethers decodes the args for us
    const transferFilter = lpContract.filters['Transfer']();

    lpContract.on(transferFilter, (from: string, to: string, amount: bigint, event: ethers.ContractEventPayload) => {
      const isLpBurn = to === ethers.ZeroAddress;
      const isPoolRemoval = from.toLowerCase() === record.poolAddress.toLowerCase();

      if (!isLpBurn && !isPoolRemoval) return;

      // Run async processing inside a fire-and-forget wrapper so the
      // synchronous listener signature is satisfied
      this._handleTransfer(internal, from, to, amount, event).catch((err: unknown) => {
        log.error('Unhandled error in LP Transfer handler', {
          positionId: record.positionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });

    log.info('LP removal listener attached', {
      positionId: record.positionId,
      lpTokenAddress: record.lpTokenAddress,
      poolAddress: record.poolAddress,
    });
  }

  /**
   * Unregisters a pool, removing all event listeners and deleting the record.
   */
  removePool(positionId: string): void {
    const record = this.records.get(positionId);
    if (!record) return;

    try {
      record.lpContract.removeAllListeners();
    } catch (err) {
      log.warn('Error removing LP contract listeners', {
        positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.records.delete(positionId);

    log.info('LP removal listener removed', { positionId });
  }

  /**
   * No-op — listeners are attached lazily in `addPool`.
   * Exists to satisfy the detector lifecycle interface.
   */
  start(): void {
    // Listeners are attached in addPool; nothing to do here.
  }

  /**
   * Removes all active listeners and clears internal state.
   */
  stop(): void {
    for (const positionId of [...this.records.keys()]) {
      this.removePool(positionId);
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  /**
   * Async core of the Transfer event handler.
   *
   * 1. Fetches totalSupply at the event's block height.
   * 2. If totalSupply reverts or returns 0n → logs warning and skips.
   * 3. Computes the removal percentage.
   * 4. Classifies severity and emits an alert if threshold is crossed.
   */
  private async _handleTransfer(
    record: InternalLpRecord,
    from: string,
    to: string,
    amount: bigint,
    event: ethers.ContractEventPayload,
  ): Promise<void> {
    const blockNumber: number = event.log.blockNumber;
    const transactionHash: string = event.log.transactionHash;

    let totalSupply: bigint;
    try {
      totalSupply = await record.lpContract['totalSupply']({ blockTag: blockNumber }) as bigint;
    } catch (err) {
      log.warn('totalSupply() call reverted or failed — skipping LP removal check', {
        positionId: record.positionId,
        blockNumber,
        transactionHash,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    if (totalSupply === 0n) {
      log.warn('totalSupply() returned 0 — skipping LP removal check to avoid false-positive', {
        positionId: record.positionId,
        blockNumber,
        transactionHash,
      });
      return;
    }

    const removedPct = computeLpRemovedPct(amount, totalSupply);
    const severity = classifyLpRemoval(removedPct);

    if (severity === null) {
      log.debug('LP removal below threshold — no alert', {
        positionId: record.positionId,
        removedPct,
        transactionHash,
      });
      return;
    }

    const reason = severity === 'CRITICAL' ? 'LP_REMOVAL_CRITICAL' : 'LP_REMOVAL_HIGH';

    log.warn('LP removal alert', {
      positionId: record.positionId,
      severity,
      reason,
      removedPct,
      transactionHash,
      from,
      to,
    });

    await this.onAlert({
      id: randomUUID(),
      contractAddress: record.contractAddress,
      severity,
      reason,
      detectedAt: Date.now(),
      positionId: record.positionId,
      pnlUsdc: null,
      transactionHash,
    });
  }
}

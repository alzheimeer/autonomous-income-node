/**
 * AlertDispatcher — post-alert processing pipeline
 *
 * Centralises the full response to a detected rug pull alert:
 *   1. Deduplication check (suppress if already seen within TTL)
 *   2. Register in deduplication map
 *   3. Update in-memory stats
 *   4. WARNING → log only, return
 *   5. Validate position is still OPEN (Req 4.7)
 *   6. Obtain exit price via DexQuoter with 2 000 ms timeout (Req 4.4)
 *   7. Compute pnlUsdc (inverted price model — tokens-per-USDC)
 *   8. Attach pnlUsdc to event
 *   9. Call closePosition on owning executor with 500 ms deadline (Req 4.1, 4.2)
 *  10. Notify RiskBucket (Req 4.5)
 *  11. Persist alert event via MetricsRecorder (Req 4.6)
 *  12. Send Telegram notification (Req 5.1)
 *  13. Increment positionsClosedByAlert
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 8.1, 8.2, 8.3
 */

import { createLogger } from '../logger.js';
import type { DeduplicationMap } from './deduplication-map.js';
import type { TelegramNotifier } from './telegram-notifier.js';
import type { AlertEvent, MutableAlertStats, AlertSeverity } from './types.js';
import type { IShadowExecutor } from '../hybrid-sniper/shadow-executor.js';
import type { IMetricsRecorder, ShadowPosition } from '../shared/metrics-recorder.js';
import type { IRiskBucket } from '../shared/risk-bucket.js';
import type { IDexQuoter } from '../shared/dex-quoter.js';

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = createLogger('AlertDispatcher');

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Minimal interface for an executor that can force-close a position.
 * Used as a duck-typed fallback for MultiVariantExecutor (which does not yet
 * expose a fully-typed public `closePosition`).
 */
interface ICloseableExecutor {
  closePosition(
    position: ShadowPosition,
    reason: 'RUG_PULL',
    exitPrice: bigint,
  ): Promise<number | null>;
}

// ─── Helper: timeout promise ─────────────────────────────────────────────────

/**
 * Returns a Promise that rejects with a timeout error after `ms` milliseconds.
 */
function rejectAfter(ms: number): Promise<never> {
  return new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms} ms`)), ms),
  );
}

// ─── AlertDispatcher ─────────────────────────────────────────────────────────

export class AlertDispatcher {
  private readonly deduplicationMap: DeduplicationMap;
  private readonly shadowExecutor: IShadowExecutor;
  private readonly multiVariantExecutor: ICloseableExecutor | null;
  private readonly metricsRecorder: IMetricsRecorder;
  private readonly riskBucket: IRiskBucket;
  private readonly telegramNotifier: TelegramNotifier;
  private readonly stats: MutableAlertStats;
  private readonly dexQuoter: IDexQuoter;
  private readonly usdcAddress: string;

  constructor(
    deduplicationMap: DeduplicationMap,
    shadowExecutor: IShadowExecutor,
    multiVariantExecutor: { closePosition?: ICloseableExecutor['closePosition'] } | null,
    metricsRecorder: IMetricsRecorder,
    riskBucket: IRiskBucket,
    telegramNotifier: TelegramNotifier,
    stats: MutableAlertStats,
    dexQuoter: IDexQuoter,
    usdcAddress: string,
  ) {
    this.deduplicationMap = deduplicationMap;
    this.shadowExecutor = shadowExecutor;
    // Only store multiVariantExecutor if it actually exposes closePosition
    this.multiVariantExecutor =
      multiVariantExecutor !== null &&
      typeof (multiVariantExecutor as ICloseableExecutor).closePosition === 'function'
        ? (multiVariantExecutor as ICloseableExecutor)
        : null;
    this.metricsRecorder = metricsRecorder;
    this.riskBucket = riskBucket;
    this.telegramNotifier = telegramNotifier;
    this.stats = stats;
    this.dexQuoter = dexQuoter;
    this.usdcAddress = usdcAddress;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Runs the full post-alert pipeline for an incoming alert event.
   *
   * Errors inside each step are caught and logged individually so that a
   * failure in one step (e.g. MetricsRecorder) does not block subsequent
   * steps (e.g. TelegramNotifier).
   */
  async dispatch(event: AlertEvent, position: ShadowPosition): Promise<void> {
    // ── Step 1: Deduplication check ──────────────────────────────────────
    if (this.deduplicationMap.isDuplicate(event.contractAddress, event.reason)) {
      this.stats.suppressedAlerts += 1;
      log.debug('dispatch: duplicate alert suppressed', {
        contractAddress: event.contractAddress,
        reason: event.reason,
        severity: event.severity,
      });
      return;
    }

    // ── Step 2: Register in deduplication map ────────────────────────────
    this.deduplicationMap.register(event.contractAddress, event.reason);

    // ── Step 3: Update stats counters and lastAlertAt ────────────────────
    this._incrementSeverityCounter(event.severity);
    this.stats.lastAlertAt = Date.now();

    // ── Step 4: WARNING → log only and return ────────────────────────────
    if (event.severity === 'WARNING') {
      log.info('dispatch: WARNING alert logged (no position close)', {
        id: event.id,
        contractAddress: event.contractAddress,
        reason: event.reason,
        positionId: event.positionId,
      });
      return;
    }

    // ── Step 5: Validate position is OPEN (Req 4.7) ──────────────────────
    if (position.status !== 'OPEN') {
      log.warn('dispatch: position is not OPEN — discarding alert', {
        id: event.id,
        contractAddress: event.contractAddress,
        positionId: event.positionId,
        status: position.status,
      });
      return;
    }

    // ── Step 6: Obtain exit price (2 000 ms timeout) — Req 4.4 ──────────
    let exitPrice: bigint = 0n;
    try {
      exitPrice = await Promise.race([
        this.dexQuoter.quote({
          tokenIn: this.usdcAddress,
          tokenOut: position.contractAddress,
          amountIn: position.tradeSize,
          poolAddress: position.contractAddress,
        }),
        rejectAfter(2_000),
      ]);
    } catch (err) {
      log.warn('dispatch: exit price quote failed — using exitPrice = 0n (100% loss)', {
        contractAddress: event.contractAddress,
        positionId: event.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
      exitPrice = 0n;
    }

    // ── Step 7: Compute pnlUsdc (inverted price model) ───────────────────
    //
    // Prices are stored as "tokens received per tradeSize USDC" (inverted):
    //   entryPrice = tokens received when buying (higher = token is cheaper)
    //   exitPrice  = tokens received at exit time (0n for a rug = worthless)
    //
    // PnL formula (inverted):
    //   pnlUsdc = (entryPrice - exitPrice) / entryPrice * (tradeSize / 1_000_000)
    //
    // Special cases:
    //   exitPrice = 0n → 100% loss = -(tradeSize / 1_000_000)
    //   entryPrice = 0n → pnlUsdc = 0  (no valid baseline)
    let pnlUsdc: number;
    if (position.entryPrice === 0n) {
      pnlUsdc = 0;
    } else if (exitPrice === 0n) {
      // Rug pull: token is worthless — 100% loss
      pnlUsdc = -(Number(position.tradeSize) / 1_000_000);
    } else {
      const pctChange =
        Number(position.entryPrice - exitPrice) / Number(position.entryPrice);
      pnlUsdc = pctChange * (Number(position.tradeSize) / 1_000_000);
    }

    // ── Step 8: Attach pnlUsdc to event ──────────────────────────────────
    event.pnlUsdc = pnlUsdc;

    // ── Step 9: Close position with 500 ms deadline — Req 4.1, 4.2 ──────
    try {
      const closeResult = await Promise.race([
        this._closeOnOwningExecutor(position, exitPrice),
        rejectAfter(500),
      ]);

      if (closeResult === null) {
        log.warn('dispatch: closePosition returned null — position may already be closed', {
          positionId: event.positionId,
          contractAddress: event.contractAddress,
        });
      }
    } catch (err) {
      log.warn('dispatch: closePosition timed out or failed (500 ms deadline)', {
        positionId: event.positionId,
        contractAddress: event.contractAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Step 10: Notify RiskBucket — Req 4.5 ────────────────────────────
    this.riskBucket.onPositionClosed('RUG_PULL');

    // ── Step 11: Persist alert event — Req 4.6 ───────────────────────────
    try {
      await this.metricsRecorder.recordAlertEvent?.(event);
    } catch (err) {
      log.warn('dispatch: recordAlertEvent failed (non-fatal, continuing)', {
        id: event.id,
        contractAddress: event.contractAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Step 12: Send Telegram notification — Req 5.1 ────────────────────
    await this.telegramNotifier.send(event);

    // ── Step 13: Increment positionsClosedByAlert ─────────────────────────
    this.stats.positionsClosedByAlert += 1;

    log.info('dispatch: alert processed successfully', {
      id: event.id,
      contractAddress: event.contractAddress,
      severity: event.severity,
      reason: event.reason,
      positionId: event.positionId,
      pnlUsdc,
      exitPrice: exitPrice.toString(),
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Attempts to close the position on the owning executor.
   *
   * Strategy:
   *   1. Try `shadowExecutor.closePosition` first (it validates internally
   *      whether it tracks the position, returning null if not).
   *   2. If result is null (not tracked by shadow executor), fall back to
   *      `multiVariantExecutor?.closePosition` if available.
   */
  private async _closeOnOwningExecutor(
    position: ShadowPosition,
    exitPrice: bigint,
  ): Promise<number | null> {
    const shadowResult = await this.shadowExecutor.closePosition(
      position,
      'RUG_PULL',
      exitPrice,
    );

    if (shadowResult !== null) {
      return shadowResult;
    }

    // Shadow executor did not track this position — try multiVariantExecutor
    if (this.multiVariantExecutor !== null) {
      return this.multiVariantExecutor.closePosition(position, 'RUG_PULL', exitPrice);
    }

    return null;
  }

  /**
   * Increments the severity-specific alert counter.
   */
  private _incrementSeverityCounter(severity: AlertSeverity): void {
    if (severity === 'WARNING') {
      this.stats.WARNING += 1;
    } else if (severity === 'HIGH') {
      this.stats.HIGH += 1;
    } else if (severity === 'CRITICAL') {
      this.stats.CRITICAL += 1;
    }
  }
}

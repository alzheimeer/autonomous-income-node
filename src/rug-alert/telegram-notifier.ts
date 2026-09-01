/**
 * TelegramNotifier
 *
 * Wraps TelegramClient with:
 *   - 10-message / 5-minute sliding-window rate limiter (timestamp queue)
 *   - Suppression queue capped at 50 entries (drop oldest on overflow)
 *   - HTML message formatting per design spec
 *   - Single retry on send failure; logs warning on second failure
 *   - flush(timeoutMs?) drains suppression queue up to a deadline
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5
 */

import { createLogger } from '../logger.js';
import type { TelegramClient } from '../social/telegram-client.js';
import type { AlertEvent } from './types.js';
import { TradingNotifier } from '../infrastructure/trading-notifier.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum messages allowed in the sliding window. */
const RATE_LIMIT_MAX = 10;

/** Sliding window duration in milliseconds (5 minutes). */
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1_000;

/** Maximum number of events held in the suppression queue. */
const SUPPRESSION_QUEUE_MAX = 50;

// ─── Logger ──────────────────────────────────────────────────────────────────

const log = createLogger('TelegramNotifier');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Truncates an Ethereum address to the form `first8...last6`.
 * Works on any string; falls back gracefully when the string is shorter than
 * the required prefix + suffix characters.
 *
 * @example truncateAddress('0x1234567890abcdef1234') → '0x123456...ef1234'
 */
export function truncateAddress(address: string): string {
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}...${address.slice(-6)}`;
}

/**
 * Formats a PnL value as a signed number with 2 decimal places followed by
 * " USDC", or returns "N/A" when the value is null.
 */
export function formatPnl(pnlUsdc: number | null): string {
  if (pnlUsdc === null) return 'N/A';
  const sign = pnlUsdc >= 0 ? '+' : '';
  return `${sign}${pnlUsdc.toFixed(2)} USDC`;
}

/**
 * Builds the HTML-formatted rug alert message body.
 *
 * Format:
 * ```
 * 🚨 <b>RUG ALERT — {SEVERITY}</b>
 * Token: <code>{first8}...{last6}</code>
 * Reason: {reason}
 * PnL: {+X.XX USDC | N/A}
 * Detected: {UTC ISO timestamp}
 * ```
 */
export function buildAlertMessage(event: AlertEvent): string {
  const address = truncateAddress(event.contractAddress);
  const pnl = formatPnl(event.pnlUsdc);
  const detectedAt = new Date(event.detectedAt).toISOString();

  return [
    `🚨 <b>RUG ALERT — ${event.severity}</b>`,
    `Token: <code>${address}</code>`,
    `Reason: ${event.reason}`,
    `PnL: ${pnl}`,
    `Detected: ${detectedAt}`,
  ].join('\n');
}

/**
 * Builds the suppression-summary prefix message.
 *
 * Format:
 * ```
 * ⚠️ {N} alert(s) suppressed since {lastSentAt}
 * ```
 */
function buildSuppressionSummary(count: number, lastSentAt: number): string {
  const since = new Date(lastSentAt).toISOString();
  return `⚠️ ${count} alert(s) suppressed since ${since}`;
}

// ─── TelegramNotifier ────────────────────────────────────────────────────────

export class TelegramNotifier {
  /** Timestamps (ms) of successfully sent messages within the current window. */
  private readonly sentTimestamps: number[] = [];

  /** Suppressed events waiting to be sent when a rate-limit slot opens. */
  private readonly suppressionQueue: AlertEvent[] = [];

  /** Timestamp of the last successfully sent message (ms), for suppression summary. */
  private lastSentAt: number | null = null;

  /** The wrapped TradingNotifier. */
  private readonly tradingNotifier: TradingNotifier;

  /**
   * @param client - (Deprecated) The mock TelegramClient.
   */
  constructor(private readonly client: TelegramClient) {
    this.tradingNotifier = new TradingNotifier();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Attempts to send an alert via Telegram.
   *
   * Flow:
   *   1. Evict expired timestamps from the rate-limit window.
   *   2. If within the rate limit → send immediately (with suppression summary prepended if queue non-empty).
   *   3. Otherwise → enqueue. If the queue exceeds SUPPRESSION_QUEUE_MAX, drop the oldest entry.
   */
  async send(event: AlertEvent): Promise<void> {
    this._evictExpiredTimestamps();

    if (this.sentTimestamps.length < RATE_LIMIT_MAX) {
      // Slot available — send now.
      await this._sendWithRetry(event);
    } else {
      // Rate limit active — enqueue.
      this._enqueue(event);
    }
  }

  /**
   * Drains the suppression queue, sending each pending event until the queue
   * is empty or the optional `timeoutMs` deadline is reached.
   *
   * If the deadline is hit, remaining entries are discarded and the promise
   * resolves (does not reject).
   *
   * @param timeoutMs - Optional deadline in milliseconds. No limit if omitted.
   */
  async flush(timeoutMs?: number): Promise<void> {
    if (this.suppressionQueue.length === 0) return;

    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : Infinity;

    while (this.suppressionQueue.length > 0) {
      if (Date.now() >= deadline) {
        log.warn('TelegramNotifier.flush: timeout reached, discarding remaining suppressed alerts', {
          remaining: this.suppressionQueue.length,
        });
        this.suppressionQueue.length = 0;
        break;
      }

      const event = this.suppressionQueue.shift()!;
      this._evictExpiredTimestamps();

      if (this.sentTimestamps.length < RATE_LIMIT_MAX) {
        await this._sendWithRetry(event);
      } else {
        // Rate limit still active — re-enqueue and stop flushing for now.
        this.suppressionQueue.unshift(event);
        break;
      }
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Removes timestamps older than the 5-minute sliding window from the front
   * of the `sentTimestamps` queue (it is maintained in ascending order).
   */
  private _evictExpiredTimestamps(): void {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    while (this.sentTimestamps.length > 0 && this.sentTimestamps[0]! <= cutoff) {
      this.sentTimestamps.shift();
    }
  }

  /**
   * Adds an event to the suppression queue.
   * If the queue is already at its cap, the oldest (front) entry is dropped.
   */
  private _enqueue(event: AlertEvent): void {
    if (this.suppressionQueue.length >= SUPPRESSION_QUEUE_MAX) {
      const dropped = this.suppressionQueue.shift();
      log.warn('TelegramNotifier: suppression queue overflow, dropping oldest alert', {
        droppedReason: dropped?.reason,
        droppedContractAddress: dropped?.contractAddress,
      });
    }
    this.suppressionQueue.push(event);
  }

  private async doSend(text: string): Promise<boolean> {
    try {
      await this.tradingNotifier.alert('⚠️ ALERTA DEL SISTEMA', text, 'warning');
      return true;
    } catch (err) {
      log.warn(`Failed to send alert via TradingNotifier: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Sends an alert (with optional suppression summary prepended), recording
   * the timestamp on success.
   *
   * Retries once on `TelegramClient` failure. On a second failure, logs a
   * warning with the timestamp and reason, and returns without rethrowing.
   */
  private async _sendWithRetry(event: AlertEvent): Promise<void> {
    const suppressedCount = this.suppressionQueue.length;

    // Build the full message, optionally prepending the suppression summary.
    let message = buildAlertMessage(event);
    if (suppressedCount > 0 && this.lastSentAt !== null) {
      const summary = buildSuppressionSummary(suppressedCount, this.lastSentAt);
      message = `${summary}\n\n${message}`;
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
      const success = await this.doSend(message);
      if (success) {
        // Success — record timestamp and update lastSentAt.
        const now = Date.now();
        this.sentTimestamps.push(now);
        this.lastSentAt = now;
        return;
      }
      
      if (attempt === 1) {
        log.warn('TelegramNotifier: send attempt 1 failed, retrying once', {
          reason: event.reason,
          contractAddress: event.contractAddress,
        });
      }
    }

    // Both attempts failed.
    log.warn('TelegramNotifier: both send attempts failed, skipping notification', {
      timestamp: new Date().toISOString(),
      reason: event.reason,
      contractAddress: event.contractAddress,
    });
  }
}

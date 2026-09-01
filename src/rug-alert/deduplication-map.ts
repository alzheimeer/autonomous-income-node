/**
 * DeduplicationMap — in-memory alert deduplication store
 *
 * Key format: `${contractAddress.toLowerCase()}:${reason}`
 * Value:      expiry timestamp in Unix ms
 *
 * Expired entries are removed lazily on lookup (isDuplicate), so no background
 * sweep timer is needed. The map is intentionally non-persistent: it starts
 * empty on each service start to satisfy Requirement 8.6.
 *
 * Requirements: 8.1, 8.2, 8.4, 8.5, 8.6
 */

import { AlertReason } from './types.js';

const DEFAULT_TTL_MS = 120_000;

export class DeduplicationMap {
  private readonly map: Map<string, number> = new Map();
  private readonly ttlMs: number;

  constructor() {
    const raw = process.env['RUG_ALERT_DEDUP_TTL_MS'];

    if (raw === undefined || raw === '') {
      this.ttlMs = DEFAULT_TTL_MS;
    } else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        console.warn(
          `[DeduplicationMap] RUG_ALERT_DEDUP_TTL_MS="${raw}" is non-positive or non-numeric; ` +
            `falling back to default TTL of ${DEFAULT_TTL_MS} ms`,
        );
        this.ttlMs = DEFAULT_TTL_MS;
      } else {
        this.ttlMs = parsed;
      }
    }
  }

  // ─── Key helpers ──────────────────────────────────────────────────────────

  private static buildKey(contractAddress: string, reason: AlertReason): string {
    return `${contractAddress.toLowerCase()}:${reason}`;
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Returns true if a non-expired deduplication entry exists for the given
   * (contractAddress, reason) pair — i.e. the alert should be suppressed.
   *
   * Lazily removes the entry when its TTL has expired so the map stays lean.
   *
   * Requirements: 8.1, 8.2, 8.5
   */
  isDuplicate(contractAddress: string, reason: AlertReason): boolean {
    const key = DeduplicationMap.buildKey(contractAddress, reason);
    const expiry = this.map.get(key);

    if (expiry === undefined) {
      return false; // no entry → not a duplicate
    }

    if (Date.now() >= expiry) {
      this.map.delete(key); // lazy expiry removal (Requirement 8.5)
      return false;
    }

    return true; // active entry → suppress the duplicate
  }

  /**
   * Registers a new deduplication entry for (contractAddress, reason).
   * Should be called immediately after a non-duplicate alert is processed.
   *
   * Requirements: 8.1, 8.2
   */
  register(contractAddress: string, reason: AlertReason): void {
    const key = DeduplicationMap.buildKey(contractAddress, reason);
    this.map.set(key, Date.now() + this.ttlMs);
  }

  /**
   * Clears all entries. Called when the service is stopped/restarted so that
   * stale suppression entries do not carry over to the new run.
   *
   * Requirements: 8.6
   */
  clear(): void {
    this.map.clear();
  }

  // ─── Introspection (useful for tests) ────────────────────────────────────

  /** Returns the configured TTL in ms. */
  get ttl(): number {
    return this.ttlMs;
  }

  /** Returns the current number of entries (including any expired but not yet lazily removed). */
  get size(): number {
    return this.map.size;
  }
}

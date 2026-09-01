/**
 * AuditLogger
 *
 * Persists and retrieves `ModificationRecord` entries from the
 * `self_mod_history` SQLite table via `SelfModRepository`.
 *
 * The logger is the single point of truth for the modification history
 * used by the rate limiter, crash-recovery logic, and operator auditing.
 *
 * Requirements: 9.3, 9.5, 9.6
 */

import type {
  SelfModRepository,
  SelfModRecord,
  CreateSelfModInput,
} from '../state/repositories/self-mod.repo.js';

// ---------------------------------------------------------------------------
// Public domain types (re-exported so callers don't import the repo directly)
// ---------------------------------------------------------------------------

/**
 * Complete record of a single self-modification attempt.
 * Maps 1-to-1 with `SelfModRecord` from the repository layer.
 */
export type ModificationRecord = SelfModRecord;

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

/**
 * Thin facade over `SelfModRepository` that exposes the subset of operations
 * needed by the Self-Mod module: logging an attempt and retrieving history.
 *
 * The class is intentionally synchronous on the caller side — `SelfModRepository`
 * uses `better-sqlite3` which is fully synchronous, so no `await` is required.
 */
export class AuditLogger {
  constructor(private readonly repo: SelfModRepository) {}

  // ---------------------------------------------------------------------------
  // Write
  // ---------------------------------------------------------------------------

  /**
   * Persist a modification record to the database.
   *
   * Accepts a full `CreateSelfModInput` so the caller can specify all fields
   * (including `status`, `sandboxOutput`, `llmReasoning`) at log time.
   *
   * @param record - The input data for the new `self_mod_history` row.
   */
  logAttempt(record: CreateSelfModInput): void {
    this.repo.insert(record);
  }

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /**
   * Return modification records ordered by `applied_at` descending
   * (most recent first).
   *
   * @param limit - Maximum number of records to return. Defaults to 50.
   * @returns An array of `ModificationRecord` objects.
   */
  getHistory(limit = 50): ModificationRecord[] {
    return this.repo.findAll(limit);
  }

  /**
   * Count modification attempts in the most recent time window.
   *
   * Used by the rate limiter to enforce the 3-per-24h cap.
   *
   * @param windowMs - Length of the rolling window in milliseconds.
   * @returns Number of `applied` modifications within the window.
   */
  countRecentAttempts(windowMs: number): number {
    return this.repo.countAppliedInWindow(windowMs);
  }

  /**
   * Mark a previously-applied modification as reverted (crash recovery).
   *
   * @param id        - The `id` of the record to update.
   * @param timestamp - Optional unix-ms timestamp; defaults to `Date.now()`.
   */
  markReverted(id: string, timestamp?: number): void {
    this.repo.markReverted(id, timestamp);
  }

  /**
   * Find the most recently applied modification (for crash-recovery rollback).
   *
   * @returns The latest `applied` record, or `null` if none exists.
   */
  getLatestApplied(): ModificationRecord | null {
    const records = this.repo.findByStatus('applied');
    return records.length > 0 ? (records[0] ?? null) : null;
  }
}

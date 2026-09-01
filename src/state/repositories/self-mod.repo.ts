/**
 * Repository for the `self_mod_history` table.
 * Audit log for all self-modification events — applied, rejected, reverted.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type SelfModStatus = 'applied' | 'rejected' | 'reverted';

export interface SelfModRecord {
  id: string;
  filePath: string;
  diff: string;
  backupPath: string;
  llmReasoning: string | null;
  sandboxOutput: string | null;
  status: SelfModStatus;
  appliedAt: number | null;
  revertedAt: number | null;
}

export interface CreateSelfModInput {
  id: string;
  filePath: string;
  diff: string;
  backupPath: string;
  llmReasoning?: string;
  sandboxOutput?: string;
  status: SelfModStatus;
  appliedAt?: number;
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface SelfModRow {
  id: string;
  file_path: string;
  diff: string;
  backup_path: string;
  llm_reasoning: string | null;
  sandbox_output: string | null;
  status: string;
  applied_at: number | null;
  reverted_at: number | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SelfModRepository {
  constructor(private readonly db: Database) {}

  insert(input: CreateSelfModInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          number | null,
        ]
      >(`
        INSERT INTO self_mod_history
          (id, file_path, diff, backup_path, llm_reasoning,
           sandbox_output, status, applied_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.filePath,
        input.diff,
        input.backupPath,
        input.llmReasoning ?? null,
        input.sandboxOutput ?? null,
        input.status,
        input.appliedAt ?? (input.status === 'applied' ? Date.now() : null)
      );
  }

  findById(id: string): SelfModRecord | null {
    const row = this.db
      .prepare<[string], SelfModRow>(
        'SELECT * FROM self_mod_history WHERE id = ?'
      )
      .get(id) as SelfModRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  findAll(limit = 50): SelfModRecord[] {
    return (
      this.db
        .prepare<[number], SelfModRow>(
          'SELECT * FROM self_mod_history ORDER BY applied_at DESC LIMIT ?'
        )
        .all(limit) as SelfModRow[]
    ).map((r) => this.toRecord(r));
  }

  findByStatus(status: SelfModStatus): SelfModRecord[] {
    return (
      this.db
        .prepare<[string], SelfModRow>(
          'SELECT * FROM self_mod_history WHERE status = ? ORDER BY applied_at DESC'
        )
        .all(status) as SelfModRow[]
    ).map((r) => this.toRecord(r));
  }

  markReverted(id: string, revertedAt?: number): void {
    this.db
      .prepare<[number, string]>(`
        UPDATE self_mod_history
        SET status = 'reverted', reverted_at = ?
        WHERE id = ?
      `)
      .run(revertedAt ?? Date.now(), id);
  }

  /** Count modifications applied in the last `windowMs` milliseconds. */
  countAppliedInWindow(windowMs: number): number {
    const since = Date.now() - windowMs;
    const row = this.db
      .prepare<[number], { cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM self_mod_history WHERE status = 'applied' AND applied_at > ?"
      )
      .get(since) as { cnt: number };
    return row?.cnt ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: SelfModRow): SelfModRecord {
    return {
      id: row.id,
      filePath: row.file_path,
      diff: row.diff,
      backupPath: row.backup_path,
      llmReasoning: row.llm_reasoning,
      sandboxOutput: row.sandbox_output,
      status: row.status as SelfModStatus,
      appliedAt: row.applied_at,
      revertedAt: row.reverted_at,
    };
  }
}

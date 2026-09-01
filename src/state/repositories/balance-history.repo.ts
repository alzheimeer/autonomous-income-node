/**
 * Repository for the `balance_history` table.
 * Records USDC balance snapshots each time the balance changes.
 * Requirements: 4.7, 5.2
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface BalanceHistoryRecord {
  id: number;
  balanceUsdc: string; // bigint stored as string (USDC 6 decimals)
  tier: number;
  blockNumber: number | null;
  recordedAt: number; // Unix ms
}

export interface CreateBalanceHistoryInput {
  balanceUsdc: string;
  tier: number;
  blockNumber?: number;
  recordedAt?: number;
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface BalanceHistoryRow {
  id: number;
  balance_usdc: string;
  tier: number;
  block_number: number | null;
  recorded_at: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class BalanceHistoryRepository {
  constructor(private readonly db: Database) {}

  /**
   * Insert a new balance snapshot.
   */
  insert(input: CreateBalanceHistoryInput): number {
    const result = this.db
      .prepare<[string, number, number | null, number]>(`
        INSERT INTO balance_history (balance_usdc, tier, block_number, recorded_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        input.balanceUsdc,
        input.tier,
        input.blockNumber ?? null,
        input.recordedAt ?? Date.now(),
      );
    return result.lastInsertRowid as number;
  }

  /**
   * Retrieve the most recent N snapshots (newest first).
   */
  getRecent(limit = 100): BalanceHistoryRecord[] {
    return (
      this.db
        .prepare<[number], BalanceHistoryRow>(
          'SELECT * FROM balance_history ORDER BY recorded_at DESC LIMIT ?',
        )
        .all(limit) as BalanceHistoryRow[]
    ).map((r) => this.toRecord(r));
  }

  /**
   * Retrieve the single most recent snapshot.
   */
  getLatest(): BalanceHistoryRecord | null {
    const row = this.db
      .prepare<[], BalanceHistoryRow>(
        'SELECT * FROM balance_history ORDER BY recorded_at DESC LIMIT 1',
      )
      .get() as BalanceHistoryRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: BalanceHistoryRow): BalanceHistoryRecord {
    return {
      id: row.id,
      balanceUsdc: row.balance_usdc,
      tier: row.tier,
      blockNumber: row.block_number,
      recordedAt: row.recorded_at,
    };
  }
}

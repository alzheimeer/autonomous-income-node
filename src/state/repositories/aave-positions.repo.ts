/**
 * Repository for the `aave_positions` table.
 * Tracks Aave v3 lending supply/withdraw positions.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface AavePositionRow {
  id: string;
  asset: string;
  amount_deposited: string;
  a_token_balance: string;
  tx_hash_supply: string | null;
  tx_hash_withdraw: string | null;
  status: string;
  apy_at_deposit: number | null;
  deposited_at: number;
  withdrawn_at: number | null;
  withdraw_reason: string | null;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface InsertAavePositionInput {
  id: string;
  asset: string;
  amount_deposited: string;
  a_token_balance: string;
  tx_hash_supply?: string | null;
  status?: string;
  apy_at_deposit?: number | null;
  deposited_at?: number;
}

export interface UpdateAavePositionExtras {
  tx_hash_withdraw?: string | null;
  withdrawn_at?: number | null;
  withdraw_reason?: string | null;
  a_token_balance?: string;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class AavePositionsRepository {
  constructor(private readonly db: Database) {}

  insert(position: InsertAavePositionInput): void {
    this.db
      .prepare<
        [string, string, string, string, string | null, string, number | null, number]
      >(`
        INSERT INTO aave_positions
          (id, asset, amount_deposited, a_token_balance, tx_hash_supply,
           status, apy_at_deposit, deposited_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        position.id,
        position.asset,
        position.amount_deposited,
        position.a_token_balance,
        position.tx_hash_supply ?? null,
        position.status ?? 'active',
        position.apy_at_deposit ?? null,
        position.deposited_at ?? Date.now(),
      );
  }

  getActive(): AavePositionRow[] {
    return this.db
      .prepare<[], AavePositionRow>(
        "SELECT * FROM aave_positions WHERE status = 'active' ORDER BY deposited_at DESC"
      )
      .all() as AavePositionRow[];
  }

  updateStatus(id: string, status: string, extras?: UpdateAavePositionExtras): void {
    if (extras) {
      this.db
        .prepare<
          [string, string | null, number | null, string | null, string | null, string]
        >(`
          UPDATE aave_positions
          SET status = ?,
              tx_hash_withdraw = COALESCE(?, tx_hash_withdraw),
              withdrawn_at = COALESCE(?, withdrawn_at),
              withdraw_reason = COALESCE(?, withdraw_reason),
              a_token_balance = COALESCE(?, a_token_balance)
          WHERE id = ?
        `)
        .run(
          status,
          extras.tx_hash_withdraw ?? null,
          extras.withdrawn_at ?? null,
          extras.withdraw_reason ?? null,
          extras.a_token_balance ?? null,
          id,
        );
    } else {
      this.db
        .prepare<[string, string]>(
          'UPDATE aave_positions SET status = ? WHERE id = ?'
        )
        .run(status, id);
    }
  }

  getTotalDeposited(): string {
    const result = this.db
      .prepare<[], { total: string | null }>(`
        SELECT CAST(SUM(CAST(amount_deposited AS REAL)) AS TEXT) AS total
        FROM aave_positions
        WHERE status = 'active'
      `)
      .get() as { total: string | null } | undefined;
    return result?.total ?? '0';
  }
}

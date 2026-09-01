/**
 * Repository for the `lp_positions` table.
 * Tracks Uniswap v3 concentrated liquidity positions.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface LPPositionRow {
  id: string;
  token_id: string;
  token0: string;
  token1: string;
  fee_tier: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  amount0_deposited: string;
  amount1_deposited: string;
  fees_earned_0: string;
  fees_earned_1: string;
  status: string;
  impermanent_loss_bps: number;
  created_at: number;
  removed_at: number | null;
  remove_reason: string | null;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface InsertLPPositionInput {
  id: string;
  token_id: string;
  token0: string;
  token1: string;
  fee_tier: number;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  amount0_deposited: string;
  amount1_deposited: string;
  status?: string;
  created_at?: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class LPPositionsRepository {
  constructor(private readonly db: Database) {}

  insert(position: InsertLPPositionInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          number,
          number,
          number,
          string,
          string,
          string,
          string,
          number,
        ]
      >(`
        INSERT INTO lp_positions
          (id, token_id, token0, token1, fee_tier, tick_lower, tick_upper,
           liquidity, amount0_deposited, amount1_deposited, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        position.id,
        position.token_id,
        position.token0,
        position.token1,
        position.fee_tier,
        position.tick_lower,
        position.tick_upper,
        position.liquidity,
        position.amount0_deposited,
        position.amount1_deposited,
        position.status ?? 'active',
        position.created_at ?? Date.now(),
      );
  }

  getActive(): LPPositionRow[] {
    return this.db
      .prepare<[], LPPositionRow>(
        "SELECT * FROM lp_positions WHERE status = 'active' ORDER BY created_at DESC"
      )
      .all() as LPPositionRow[];
  }

  updateFees(id: string, fees0: string, fees1: string): void {
    this.db
      .prepare<[string, string, string]>(
        'UPDATE lp_positions SET fees_earned_0 = ?, fees_earned_1 = ? WHERE id = ?'
      )
      .run(fees0, fees1, id);
  }

  updateStatus(id: string, status: string, reason?: string): void {
    if (reason) {
      this.db
        .prepare<[string, number, string, string]>(
          'UPDATE lp_positions SET status = ?, removed_at = ?, remove_reason = ? WHERE id = ?'
        )
        .run(status, Date.now(), reason, id);
    } else {
      this.db
        .prepare<[string, string]>(
          'UPDATE lp_positions SET status = ? WHERE id = ?'
        )
        .run(status, id);
    }
  }
}

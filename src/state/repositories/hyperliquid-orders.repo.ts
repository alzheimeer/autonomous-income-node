/**
 * Repository for the `hyperliquid_orders` table.
 * Tracks orders placed on Hyperliquid perpetuals DEX.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface HyperliquidOrderRow {
  id: string;
  pair: string;
  side: string;
  order_type: string;
  price: number;
  size: number;
  margin_usdc: string | null;
  leverage: number;
  status: string;
  fill_price: number | null;
  pnl_usdc: string | null;
  external_order_id: string | null;
  placed_at: number;
  filled_at: number | null;
  cancelled_at: number | null;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface InsertHyperliquidOrderInput {
  id: string;
  pair: string;
  side: 'buy' | 'sell';
  order_type?: string;
  price: number;
  size: number;
  margin_usdc?: string | null;
  leverage?: number;
  status?: string;
  external_order_id?: string | null;
  placed_at?: number;
}

export interface UpdateHyperliquidOrderExtras {
  fill_price?: number | null;
  pnl_usdc?: string | null;
  filled_at?: number | null;
  cancelled_at?: number | null;
  external_order_id?: string | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class HyperliquidOrdersRepository {
  constructor(private readonly db: Database) {}

  insert(order: InsertHyperliquidOrderInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          number,
          number,
          string | null,
          number,
          string,
          string | null,
          number,
        ]
      >(`
        INSERT INTO hyperliquid_orders
          (id, pair, side, order_type, price, size, margin_usdc,
           leverage, status, external_order_id, placed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        order.id,
        order.pair,
        order.side,
        order.order_type ?? 'limit',
        order.price,
        order.size,
        order.margin_usdc ?? null,
        order.leverage ?? 1.0,
        order.status ?? 'open',
        order.external_order_id ?? null,
        order.placed_at ?? Date.now(),
      );
  }

  getOpen(): HyperliquidOrderRow[] {
    return this.db
      .prepare<[], HyperliquidOrderRow>(
        "SELECT * FROM hyperliquid_orders WHERE status = 'open' ORDER BY placed_at DESC"
      )
      .all() as HyperliquidOrderRow[];
  }

  updateStatus(id: string, status: string, extras?: UpdateHyperliquidOrderExtras): void {
    if (extras) {
      this.db
        .prepare<
          [string, number | null, string | null, number | null, number | null, string | null, string]
        >(`
          UPDATE hyperliquid_orders
          SET status = ?,
              fill_price = COALESCE(?, fill_price),
              pnl_usdc = COALESCE(?, pnl_usdc),
              filled_at = COALESCE(?, filled_at),
              cancelled_at = COALESCE(?, cancelled_at),
              external_order_id = COALESCE(?, external_order_id)
          WHERE id = ?
        `)
        .run(
          status,
          extras.fill_price ?? null,
          extras.pnl_usdc ?? null,
          extras.filled_at ?? null,
          extras.cancelled_at ?? null,
          extras.external_order_id ?? null,
          id,
        );
    } else {
      this.db
        .prepare<[string, string]>(
          'UPDATE hyperliquid_orders SET status = ? WHERE id = ?'
        )
        .run(status, id);
    }
  }

  getByPairAndStatus(pair: string, status: string): HyperliquidOrderRow[] {
    return this.db
      .prepare<[string, string], HyperliquidOrderRow>(
        'SELECT * FROM hyperliquid_orders WHERE pair = ? AND status = ? ORDER BY placed_at DESC'
      )
      .all(pair, status) as HyperliquidOrderRow[];
  }
}

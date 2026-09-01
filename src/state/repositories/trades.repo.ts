/**
 * Repository for the `trades` table.
 * Stores DeFi trade history with profit/loss accounting.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type TradeStatus = 'pending' | 'success' | 'reverted' | 'rejected';
export type TradeNetwork = 'ethereum' | 'base';
export type TradeSource = 'uniswap_v3' | '1inch';

export interface TradeRecord {
  id: string;
  network: TradeNetwork;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut: string | null;
  actualOut: string | null;
  txHash: string | null;
  status: TradeStatus;
  netProfitUsdc: string | null;
  gasCostUsdc: string | null;
  slippagePct: number | null;
  source: TradeSource | null;
  executedAt: number;
}

export interface CreateTradeInput {
  id: string;
  network: TradeNetwork;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut?: string;
  source?: TradeSource;
  gasCostUsdc?: string;
  slippagePct?: number;
  executedAt?: number;
}

export interface UpdateTradeInput {
  txHash?: string;
  status: TradeStatus;
  actualOut?: string;
  netProfitUsdc?: string;
  gasCostUsdc?: string;
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface TradeRow {
  id: string;
  network: string;
  token_in: string;
  token_out: string;
  amount_in: string;
  expected_out: string | null;
  actual_out: string | null;
  tx_hash: string | null;
  status: string;
  net_profit_usdc: string | null;
  gas_cost_usdc: string | null;
  slippage_pct: number | null;
  source: string | null;
  executed_at: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class TradesRepository {
  constructor(private readonly db: Database) {}

  insert(input: CreateTradeInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          string | null,
          number | null,
          number,
        ]
      >(`
        INSERT INTO trades
          (id, network, token_in, token_out, amount_in, expected_out,
           gas_cost_usdc, source, slippage_pct, executed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.network,
        input.tokenIn,
        input.tokenOut,
        input.amountIn,
        input.expectedOut ?? null,
        input.gasCostUsdc ?? null,
        input.source ?? null,
        input.slippagePct ?? null,
        input.executedAt ?? Date.now()
      );
  }

  findById(id: string): TradeRecord | null {
    const row = this.db
      .prepare<[string], TradeRow>('SELECT * FROM trades WHERE id = ?')
      .get(id) as TradeRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  findByStatus(status: TradeStatus, limit = 100): TradeRecord[] {
    return (
      this.db
        .prepare<[string, number], TradeRow>(
          'SELECT * FROM trades WHERE status = ? ORDER BY executed_at DESC LIMIT ?'
        )
        .all(status, limit) as TradeRow[]
    ).map((r) => this.toRecord(r));
  }

  findRecent(limit = 50): TradeRecord[] {
    return (
      this.db
        .prepare<[number], TradeRow>(
          'SELECT * FROM trades ORDER BY executed_at DESC LIMIT ?'
        )
        .all(limit) as TradeRow[]
    ).map((r) => this.toRecord(r));
  }

  updateAfterExecution(id: string, update: UpdateTradeInput): void {
    this.db
      .prepare<
        [string, string | null, string | null, string | null, string | null, string]
      >(`
        UPDATE trades
        SET status         = ?,
            tx_hash        = COALESCE(?, tx_hash),
            actual_out     = COALESCE(?, actual_out),
            net_profit_usdc = COALESCE(?, net_profit_usdc),
            gas_cost_usdc  = COALESCE(?, gas_cost_usdc)
        WHERE id = ?
      `)
      .run(
        update.status,
        update.txHash ?? null,
        update.actualOut ?? null,
        update.netProfitUsdc ?? null,
        update.gasCostUsdc ?? null,
        id
      );
  }

  getTotalProfit(): string {
    const result = this.db
      .prepare<[], { total: string | null }>(
        "SELECT CAST(SUM(CAST(net_profit_usdc AS REAL)) AS TEXT) AS total FROM trades WHERE status = 'success'"
      )
      .get() as { total: string | null };
    return result?.total ?? '0';
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: TradeRow): TradeRecord {
    return {
      id: row.id,
      network: row.network as TradeNetwork,
      tokenIn: row.token_in,
      tokenOut: row.token_out,
      amountIn: row.amount_in,
      expectedOut: row.expected_out,
      actualOut: row.actual_out,
      txHash: row.tx_hash,
      status: row.status as TradeStatus,
      netProfitUsdc: row.net_profit_usdc,
      gasCostUsdc: row.gas_cost_usdc,
      slippagePct: row.slippage_pct,
      source: row.source as TradeSource | null,
      executedAt: row.executed_at,
    };
  }
}

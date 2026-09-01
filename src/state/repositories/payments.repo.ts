/**
 * Repository for the `payments` table.
 * Tracks incoming and outgoing USDC payment records.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type PaymentDirection = 'incoming' | 'outgoing';
export type PaymentStatus = 'pending' | 'confirmed' | 'failed';

export interface PaymentRecord {
  id: string;
  direction: PaymentDirection;
  amountUsdc: string; // bigint stored as string
  counterpartyAddress: string;
  txHash: string | null;
  blockNumber: number | null;
  serviceId: string | null;
  status: PaymentStatus;
  timestamp: number;
}

export interface CreatePaymentInput {
  id: string;
  direction: PaymentDirection;
  amountUsdc: string;
  counterpartyAddress: string;
  txHash?: string;
  blockNumber?: number;
  serviceId?: string;
  status?: PaymentStatus;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface PaymentRow {
  id: string;
  direction: string;
  amount_usdc: string;
  counterparty_address: string;
  tx_hash: string | null;
  block_number: number | null;
  service_id: string | null;
  status: string;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PaymentsRepository {
  constructor(private readonly db: Database) {}

  insert(input: CreatePaymentInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string | null,
          number | null,
          string | null,
          string,
          number,
        ]
      >(`
        INSERT INTO payments
          (id, direction, amount_usdc, counterparty_address, tx_hash,
           block_number, service_id, status, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.direction,
        input.amountUsdc,
        input.counterpartyAddress,
        input.txHash ?? null,
        input.blockNumber ?? null,
        input.serviceId ?? null,
        input.status ?? 'pending',
        input.timestamp ?? Date.now()
      );
  }

  findById(id: string): PaymentRecord | null {
    const row = this.db
      .prepare<[string], PaymentRow>('SELECT * FROM payments WHERE id = ?')
      .get(id) as PaymentRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  findByDirection(direction: PaymentDirection, limit = 100): PaymentRecord[] {
    return (
      this.db
        .prepare<[string, number], PaymentRow>(
          'SELECT * FROM payments WHERE direction = ? ORDER BY timestamp DESC LIMIT ?'
        )
        .all(direction, limit) as PaymentRow[]
    ).map((r) => this.toRecord(r));
  }

  updateStatus(id: string, status: PaymentStatus, txHash?: string, blockNumber?: number): void {
    this.db
      .prepare<[string, string | null, number | null, string]>(`
        UPDATE payments
        SET status       = ?,
            tx_hash      = COALESCE(?, tx_hash),
            block_number = COALESCE(?, block_number)
        WHERE id = ?
      `)
      .run(status, txHash ?? null, blockNumber ?? null, id);
  }

  getTotalIncoming(): string {
    const result = this.db
      .prepare<[], { total: string | null }>(
        "SELECT CAST(SUM(CAST(amount_usdc AS REAL)) AS TEXT) AS total FROM payments WHERE direction = 'incoming' AND status = 'confirmed'"
      )
      .get() as { total: string | null };
    return result?.total ?? '0';
  }

  getTotalOutgoing(): string {
    const result = this.db
      .prepare<[], { total: string | null }>(
        "SELECT CAST(SUM(CAST(amount_usdc AS REAL)) AS TEXT) AS total FROM payments WHERE direction = 'outgoing' AND status = 'confirmed'"
      )
      .get() as { total: string | null };
    return result?.total ?? '0';
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: PaymentRow): PaymentRecord {
    return {
      id: row.id,
      direction: row.direction as PaymentDirection,
      amountUsdc: row.amount_usdc,
      counterpartyAddress: row.counterparty_address,
      txHash: row.tx_hash,
      blockNumber: row.block_number,
      serviceId: row.service_id,
      status: row.status as PaymentStatus,
      timestamp: row.timestamp,
    };
  }
}

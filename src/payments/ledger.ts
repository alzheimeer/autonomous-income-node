/**
 * PaymentLedger — USDC payment ledger backed by the PaymentsRepository.
 *
 * Wraps the SQLite PaymentsRepository to provide domain-level operations:
 *  - record: persist a new payment (incoming or outgoing)
 *  - confirm: mark an existing payment as confirmed with on-chain details
 *  - fail: mark a payment as failed
 *  - getById: retrieve a single payment record
 *  - listByDirection: paginated list of incoming/outgoing payments
 *  - getTotals: aggregate totals for accounting
 *
 * The domain `PaymentRecord` used here keeps `amountUsdc` as `bigint` for
 * type-safe arithmetic. Serialisation to/from SQLite (string) is handled
 * transparently inside this class.
 *
 * Requirements: 4.5
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  PaymentsRepository,
  PaymentDirection,
  PaymentStatus,
} from '../state/repositories/payments.repo.js';

// ---------------------------------------------------------------------------
// Domain types — bigint version of the repo's string-amount PaymentRecord
// ---------------------------------------------------------------------------

/**
 * Domain PaymentRecord with `amountUsdc` as native `bigint` (6-decimal USDC).
 *
 * This is the interface specified in the task and design doc.
 */
export interface PaymentRecord {
  id: string;
  direction: PaymentDirection;
  amountUsdc: bigint;
  counterpartyAddress: string;
  txHash: string | null;
  blockNumber: number | null;
  serviceId: string | null;
  timestamp: number;
  status: PaymentStatus;
}

export interface CreatePaymentOptions {
  /** Defaults to a new UUID v4. */
  id?: string;
  direction: PaymentDirection;
  /** USDC amount in 6-decimal units. */
  amountUsdc: bigint;
  counterpartyAddress: string;
  txHash?: string;
  blockNumber?: number;
  serviceId?: string;
  /** Defaults to 'pending'. */
  status?: PaymentStatus;
  /** Unix timestamp in ms. Defaults to `Date.now()`. */
  timestamp?: number;
}

export interface PaymentTotals {
  /** Total confirmed incoming amount in 6-decimal USDC units. */
  totalIncoming: bigint;
  /** Total confirmed outgoing amount in 6-decimal USDC units. */
  totalOutgoing: bigint;
  /** Net balance (incoming – outgoing). */
  netBalance: bigint;
}

// ---------------------------------------------------------------------------
// PaymentLedger interface
// ---------------------------------------------------------------------------

export interface PaymentLedger {
  /**
   * Record a new payment entry (defaults to 'pending' status).
   *
   * @returns The generated (or supplied) payment ID.
   */
  record(options: CreatePaymentOptions): string;

  /**
   * Mark an existing payment as 'confirmed' and attach on-chain details.
   */
  confirm(id: string, txHash: string, blockNumber: number): void;

  /**
   * Mark an existing payment as 'failed'.
   */
  fail(id: string): void;

  /**
   * Retrieve a single payment record by ID, or null if not found.
   */
  getById(id: string): PaymentRecord | null;

  /**
   * List payments by direction, newest first.
   *
   * @param direction 'incoming' | 'outgoing'
   * @param limit     Maximum records to return (default 100).
   */
  listByDirection(direction: PaymentDirection, limit?: number): PaymentRecord[];

  /**
   * Return confirmed aggregate totals.
   */
  getTotals(): PaymentTotals;
}

// ---------------------------------------------------------------------------
// PaymentLedgerImpl
// ---------------------------------------------------------------------------

export class PaymentLedgerImpl implements PaymentLedger {
  constructor(private readonly repo: PaymentsRepository) {}

  // ── record ─────────────────────────────────────────────────────────────────

  record(options: CreatePaymentOptions): string {
    const id = options.id ?? uuidv4();

    this.repo.insert({
      id,
      direction: options.direction,
      amountUsdc: options.amountUsdc.toString(),
      counterpartyAddress: options.counterpartyAddress,
      txHash: options.txHash,
      blockNumber: options.blockNumber,
      serviceId: options.serviceId,
      status: options.status ?? 'pending',
      timestamp: options.timestamp ?? Date.now(),
    });

    return id;
  }

  // ── confirm ────────────────────────────────────────────────────────────────

  confirm(id: string, txHash: string, blockNumber: number): void {
    this.repo.updateStatus(id, 'confirmed', txHash, blockNumber);
  }

  // ── fail ───────────────────────────────────────────────────────────────────

  fail(id: string): void {
    this.repo.updateStatus(id, 'failed');
  }

  // ── getById ────────────────────────────────────────────────────────────────

  getById(id: string): PaymentRecord | null {
    const row = this.repo.findById(id);
    return row ? this._toPaymentRecord(row) : null;
  }

  // ── listByDirection ────────────────────────────────────────────────────────

  listByDirection(direction: PaymentDirection, limit = 100): PaymentRecord[] {
    return this.repo.findByDirection(direction, limit).map((row) => this._toPaymentRecord(row));
  }

  // ── getTotals ──────────────────────────────────────────────────────────────

  getTotals(): PaymentTotals {
    const incomingStr = this.repo.getTotalIncoming();
    const outgoingStr = this.repo.getTotalOutgoing();

    // The repo stores values as decimal strings from a SQLite SUM.
    // They may be fractional (e.g. '1500.5') if old rows existed, so we
    // parse them as floats then convert to bigint via rounding.
    const totalIncoming = this._parseTotalString(incomingStr);
    const totalOutgoing = this._parseTotalString(outgoingStr);

    return {
      totalIncoming,
      totalOutgoing,
      netBalance: totalIncoming - totalOutgoing,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Convert the repo's string-amount record to the domain PaymentRecord
   * with `amountUsdc` as `bigint`.
   */
  private _toPaymentRecord(
    row: import('../state/repositories/payments.repo.js').PaymentRecord,
  ): PaymentRecord {
    return {
      id: row.id,
      direction: row.direction,
      amountUsdc: BigInt(row.amountUsdc),
      counterpartyAddress: row.counterpartyAddress,
      txHash: row.txHash,
      blockNumber: row.blockNumber,
      serviceId: row.serviceId,
      timestamp: row.timestamp,
      status: row.status,
    };
  }

  /**
   * Parse a decimal-string total (from SQLite SUM) into a bigint.
   *
   * SQLite SUM can return fractional values (e.g. '100.0') even for integer
   * columns when rows have been inserted as real numbers. We use Math.round
   * to stay in integer territory.
   */
  private _parseTotalString(value: string): bigint {
    if (!value || value === '0') return 0n;
    const num = parseFloat(value);
    if (isNaN(num)) return 0n;
    return BigInt(Math.round(num));
  }
}

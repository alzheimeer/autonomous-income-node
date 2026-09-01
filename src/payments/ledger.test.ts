/**
 * Tests for PaymentLedgerImpl.
 *
 * Uses an in-memory stub PaymentsRepository — no native SQLite binaries required.
 * This follows the same pattern used in wallet-manager.test.ts.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  PaymentDirection,
  PaymentStatus,
} from '../state/repositories/payments.repo.js';
import type {
  PaymentRecord as RepoRecord,
  CreatePaymentInput,
} from '../state/repositories/payments.repo.js';
import { PaymentLedgerImpl } from './ledger.js';

// ---------------------------------------------------------------------------
// In-memory PaymentsRepository stub (no native SQLite required)
// ---------------------------------------------------------------------------

class InMemoryPaymentsRepo {
  private store = new Map<string, RepoRecord>();

  insert(input: CreatePaymentInput): void {
    this.store.set(input.id, {
      id: input.id,
      direction: input.direction,
      amountUsdc: input.amountUsdc,
      counterpartyAddress: input.counterpartyAddress,
      txHash: input.txHash ?? null,
      blockNumber: input.blockNumber ?? null,
      serviceId: input.serviceId ?? null,
      status: (input.status ?? 'pending') as PaymentStatus,
      timestamp: input.timestamp ?? Date.now(),
    });
  }

  findById(id: string): RepoRecord | null {
    return this.store.get(id) ?? null;
  }

  findByDirection(direction: PaymentDirection, limit = 100): RepoRecord[] {
    return [...this.store.values()]
      .filter((r) => r.direction === direction)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  updateStatus(
    id: string,
    status: PaymentStatus,
    txHash?: string,
    blockNumber?: number,
  ): void {
    const record = this.store.get(id);
    if (!record) return;
    this.store.set(id, {
      ...record,
      status,
      txHash: txHash ?? record.txHash,
      blockNumber: blockNumber ?? record.blockNumber,
    });
  }

  getTotalIncoming(): string {
    let total = 0;
    for (const r of this.store.values()) {
      if (r.direction === 'incoming' && r.status === 'confirmed') {
        total += parseInt(r.amountUsdc, 10);
      }
    }
    return total.toString();
  }

  getTotalOutgoing(): string {
    let total = 0;
    for (const r of this.store.values()) {
      if (r.direction === 'outgoing' && r.status === 'confirmed') {
        total += parseInt(r.amountUsdc, 10);
      }
    }
    return total.toString();
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PaymentLedgerImpl', () => {
  let repo: InMemoryPaymentsRepo;
  let ledger: PaymentLedgerImpl;

  beforeEach(() => {
    repo = new InMemoryPaymentsRepo();
    // PaymentLedgerImpl only requires the subset interface, so cast is safe.
    ledger = new PaymentLedgerImpl(repo as unknown as import('../state/repositories/payments.repo.js').PaymentsRepository);
  });

  // ── record ──────────────────────────────────────────────────────────────

  it('record inserts a payment and returns an id', () => {
    const id = ledger.record({
      direction: 'incoming',
      amountUsdc: 5_000_000n,
      counterpartyAddress: '0xAAAA',
    });

    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('record persists the correct direction and amount', () => {
    const id = ledger.record({
      direction: 'incoming',
      amountUsdc: 1_234_567n,
      counterpartyAddress: '0xBBBB',
    });

    const payment = ledger.getById(id);
    expect(payment).not.toBeNull();
    expect(payment!.direction).toBe('incoming');
    expect(payment!.amountUsdc).toBe(1_234_567n);
    expect(payment!.counterpartyAddress).toBe('0xBBBB');
    expect(payment!.status).toBe('pending');
  });

  it('record accepts a caller-supplied id', () => {
    const customId = 'custom-payment-id-001';
    const returnedId = ledger.record({
      id: customId,
      direction: 'outgoing',
      amountUsdc: 10_000_000n,
      counterpartyAddress: '0xCCCC',
    });

    expect(returnedId).toBe(customId);
    expect(ledger.getById(customId)).not.toBeNull();
  });

  it('record stores serviceId and txHash when provided', () => {
    const id = ledger.record({
      direction: 'incoming',
      amountUsdc: 2_000_000n,
      counterpartyAddress: '0xDDDD',
      txHash: '0x' + 'a'.repeat(64),
      blockNumber: 12345,
      serviceId: 'svc-text-gen',
    });

    const payment = ledger.getById(id);
    expect(payment!.txHash).toBe('0x' + 'a'.repeat(64));
    expect(payment!.blockNumber).toBe(12345);
    expect(payment!.serviceId).toBe('svc-text-gen');
  });

  // ── confirm ─────────────────────────────────────────────────────────────

  it('confirm updates status to confirmed with tx details', () => {
    const id = ledger.record({
      direction: 'incoming',
      amountUsdc: 1_000_000n,
      counterpartyAddress: '0xEEEE',
    });

    ledger.confirm(id, '0x' + 'f'.repeat(64), 99999);

    const payment = ledger.getById(id);
    expect(payment!.status).toBe('confirmed');
    expect(payment!.txHash).toBe('0x' + 'f'.repeat(64));
    expect(payment!.blockNumber).toBe(99999);
  });

  // ── fail ────────────────────────────────────────────────────────────────

  it('fail updates status to failed', () => {
    const id = ledger.record({
      direction: 'outgoing',
      amountUsdc: 500_000n,
      counterpartyAddress: '0xFFFF',
    });

    ledger.fail(id);

    expect(ledger.getById(id)!.status).toBe('failed');
  });

  // ── getById ─────────────────────────────────────────────────────────────

  it('getById returns null for unknown id', () => {
    expect(ledger.getById('nonexistent-id')).toBeNull();
  });

  // ── listByDirection ──────────────────────────────────────────────────────

  it('listByDirection returns only records of the requested direction', () => {
    ledger.record({ direction: 'incoming', amountUsdc: 1_000_000n, counterpartyAddress: '0x1' });
    ledger.record({ direction: 'incoming', amountUsdc: 2_000_000n, counterpartyAddress: '0x2' });
    ledger.record({ direction: 'outgoing', amountUsdc: 500_000n, counterpartyAddress: '0x3' });

    const incoming = ledger.listByDirection('incoming');
    expect(incoming).toHaveLength(2);
    expect(incoming.every((p) => p.direction === 'incoming')).toBe(true);

    const outgoing = ledger.listByDirection('outgoing');
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0]!.direction).toBe('outgoing');
  });

  it('listByDirection respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      ledger.record({
        direction: 'incoming',
        amountUsdc: BigInt(i + 1) * 1_000_000n,
        counterpartyAddress: '0x' + i,
      });
    }

    const result = ledger.listByDirection('incoming', 3);
    expect(result).toHaveLength(3);
  });

  it('listByDirection returns empty array when no records match', () => {
    const result = ledger.listByDirection('outgoing');
    expect(result).toHaveLength(0);
  });

  // ── getTotals ───────────────────────────────────────────────────────────

  it('getTotals returns zero totals when there are no confirmed records', () => {
    ledger.record({ direction: 'incoming', amountUsdc: 5_000_000n, counterpartyAddress: '0x1' });
    // Status is still 'pending' — should not count toward totals
    const totals = ledger.getTotals();
    expect(totals.totalIncoming).toBe(0n);
    expect(totals.totalOutgoing).toBe(0n);
    expect(totals.netBalance).toBe(0n);
  });

  it('getTotals aggregates only confirmed payments', () => {
    const id1 = ledger.record({ direction: 'incoming', amountUsdc: 10_000_000n, counterpartyAddress: '0x1' });
    const id2 = ledger.record({ direction: 'incoming', amountUsdc: 5_000_000n, counterpartyAddress: '0x2' });
    const id3 = ledger.record({ direction: 'outgoing', amountUsdc: 3_000_000n, counterpartyAddress: '0x3' });

    ledger.confirm(id1, '0x' + '1'.repeat(64), 100);
    ledger.confirm(id2, '0x' + '2'.repeat(64), 101);
    ledger.confirm(id3, '0x' + '3'.repeat(64), 102);

    const totals = ledger.getTotals();
    expect(totals.totalIncoming).toBe(15_000_000n);
    expect(totals.totalOutgoing).toBe(3_000_000n);
    expect(totals.netBalance).toBe(12_000_000n);
  });

  it('getTotals excludes failed payments', () => {
    const id1 = ledger.record({ direction: 'incoming', amountUsdc: 10_000_000n, counterpartyAddress: '0x1' });
    const id2 = ledger.record({ direction: 'incoming', amountUsdc: 5_000_000n, counterpartyAddress: '0x2' });

    ledger.confirm(id1, '0x' + '1'.repeat(64), 100);
    ledger.fail(id2); // This should not count

    const totals = ledger.getTotals();
    expect(totals.totalIncoming).toBe(10_000_000n);
  });

  // ── amountUsdc bigint round-trip ─────────────────────────────────────────

  it('preserves large bigint amounts without precision loss', () => {
    // 1 million USDC in 6-decimal = 1_000_000_000_000n
    const largeAmount = 1_000_000_000_000n;
    const id = ledger.record({
      direction: 'incoming',
      amountUsdc: largeAmount,
      counterpartyAddress: '0xABCD',
    });

    const payment = ledger.getById(id);
    expect(payment!.amountUsdc).toBe(largeAmount);
  });

  // ── netBalance edge cases ────────────────────────────────────────────────

  it('netBalance is negative when outgoing exceeds incoming', () => {
    const id1 = ledger.record({ direction: 'incoming', amountUsdc: 3_000_000n, counterpartyAddress: '0x1' });
    const id2 = ledger.record({ direction: 'outgoing', amountUsdc: 5_000_000n, counterpartyAddress: '0x2' });

    ledger.confirm(id1, '0x' + '1'.repeat(64), 1);
    ledger.confirm(id2, '0x' + '2'.repeat(64), 2);

    const totals = ledger.getTotals();
    expect(totals.netBalance).toBe(-2_000_000n);
  });
});

/**
 * Unit tests for LiquidityMonitor
 *
 * Injects a mock contract factory to avoid real network calls.
 * Uses fake timers to drive the standard (15 s) and elevated (5 s) intervals
 * deterministically.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LiquidityMonitor, type PoolRecord, type ContractFactory } from './liquidity-monitor.js';
import type { AlertEmitter, AlertEvent } from './types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * A PoolRecord with pre-set non-zero baselines so that `_initRecord` does
 * not try to fetch them over the network.
 */
function makeRecord(overrides: Partial<PoolRecord> = {}): PoolRecord {
  return {
    positionId: 'pos-1',
    contractAddress: '0xTOKEN',
    poolAddress: '0xPOOL',
    baselineReserve0: 1_000_000n,
    baselineReserve1: 2_000_000n,
    token0: '0xT0',
    token1: '0xT1',
    consecutivePollFailures: 0,
    elevated: false,
    ...overrides,
  };
}

/**
 * Creates a ContractFactory that returns a test double using the provided
 * getReserves implementation.
 */
function makeFactory(
  getReservesImpl: () => Promise<[bigint, bigint, number]>,
): ContractFactory {
  return (_addr, _abi, _provider) => ({
    token0: () => Promise.resolve('0xT0'),
    token1: () => Promise.resolve('0xT1'),
    getReserves: getReservesImpl,
  });
}

/** Yield the microtask queue several times to drain chained promise chains. */
async function drainQueue(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('LiquidityMonitor', () => {
  let emittedAlerts: AlertEvent[];
  let onAlert: AlertEmitter;
  let monitor: LiquidityMonitor;

  beforeEach(() => {
    emittedAlerts = [];
    onAlert = vi.fn(async (event: AlertEvent) => {
      emittedAlerts.push(event);
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    monitor?.stop();
    vi.useRealTimers();
  });

  // ─── addPool / removePool ────────────────────────────────────────────────

  it('addPool does not throw and removePool cleans up', () => {
    const factory = makeFactory(async () => [1_000_000n, 2_000_000n, 0]);
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    expect(() => monitor.addPool(makeRecord())).not.toThrow();
    expect(() => monitor.removePool('pos-1')).not.toThrow();
  });

  it('removePool is a no-op for unknown positionId', () => {
    monitor = new LiquidityMonitor({} as any, onAlert, makeFactory(async () => [0n, 0n, 0]));
    expect(() => monitor.removePool('nonexistent')).not.toThrow();
  });

  // ─── start / stop ─────────────────────────────────────────────────────────

  it('stop() clears intervals without throwing', () => {
    monitor = new LiquidityMonitor({} as any, onAlert, makeFactory(async () => [0n, 0n, 0]));
    monitor.start();
    expect(() => monitor.stop()).not.toThrow();
  });

  it('calling start() twice does not create duplicate intervals', () => {
    monitor = new LiquidityMonitor({} as any, onAlert, makeFactory(async () => [0n, 0n, 0]));
    const spy = vi.spyOn(global, 'setInterval');
    monitor.start();
    const callsAfterFirst = spy.mock.calls.length;
    monitor.start();
    expect(spy.mock.calls.length).toBe(callsAfterFirst);
  });

  // ─── Drop severity thresholds ─────────────────────────────────────────────

  it('emits HIGH alert when reserve0 drops 50–79%', async () => {
    // 1_000_000 → 400_000 = 60% drop → HIGH
    const factory = makeFactory(async () => [400_000n, 2_000_000n, 0]);
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord());
    monitor.start();

    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();

    expect(emittedAlerts.length).toBeGreaterThanOrEqual(1);
    expect(emittedAlerts[0].severity).toBe('HIGH');
    expect(emittedAlerts[0].reason).toBe('LIQUIDITY_DROP_HIGH');
    expect(emittedAlerts[0].positionId).toBe('pos-1');
    expect(emittedAlerts[0].pnlUsdc).toBeNull();
  });

  it('emits CRITICAL alert when reserve0 drops ≥ 80%', async () => {
    // 1_000_000 → 100_000 = 90% drop → CRITICAL
    const factory = makeFactory(async () => [100_000n, 2_000_000n, 0]);
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord());
    monitor.start();

    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();

    const criticals = emittedAlerts.filter((a) => a.severity === 'CRITICAL');
    expect(criticals.length).toBeGreaterThanOrEqual(1);
    expect(criticals[0].reason).toBe('LIQUIDITY_DROP_CRITICAL');
  });

  it('takes the higher severity when reserves have different drop levels', async () => {
    // reserve0: 40% drop (no alert), reserve1: 85% drop (CRITICAL) → result: CRITICAL
    const factory = makeFactory(async () => [600_000n, 300_000n, 0]);
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord());
    monitor.start();

    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();

    const criticals = emittedAlerts.filter((a) => a.severity === 'CRITICAL');
    expect(criticals.length).toBeGreaterThanOrEqual(1);
  });

  it('emits no alert when both reserves drop less than 50%', async () => {
    // 40% drop on both → no alert
    const factory = makeFactory(async () => [600_000n, 1_200_000n, 0]);
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord());
    monitor.start();

    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();

    expect(emittedAlerts.length).toBe(0);
  });

  // ─── Consecutive poll failures ────────────────────────────────────────────

  it('emits RESERVE_POLL_FAILURE after exactly 3 consecutive failures', async () => {
    const factory = makeFactory(async () => {
      throw new Error('call reverted');
    });
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord());
    monitor.start();

    // Tick 1 — 1 failure, no alert yet
    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();
    expect(emittedAlerts.filter((a) => a.reason === 'RESERVE_POLL_FAILURE').length).toBe(0);

    // Tick 2 — 2 failures, no alert yet
    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();
    expect(emittedAlerts.filter((a) => a.reason === 'RESERVE_POLL_FAILURE').length).toBe(0);

    // Tick 3 — 3 failures → CRITICAL alert emitted
    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();
    const failures = emittedAlerts.filter((a) => a.reason === 'RESERVE_POLL_FAILURE');
    expect(failures.length).toBe(1);
    expect(failures[0].severity).toBe('CRITICAL');
  });

  it('emits RESERVE_POLL_FAILURE exactly once per consecutive failure run', async () => {
    const factory = makeFactory(async () => {
      throw new Error('timeout');
    });
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord());
    monitor.start();

    // 3 standard ticks → alert + elevation
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(15_001);
      await drainQueue();
    }
    expect(emittedAlerts.filter((a) => a.reason === 'RESERVE_POLL_FAILURE').length).toBe(1);

    // 3 more standard ticks (record moved to elevated set, standard set is empty)
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(15_001);
      await drainQueue();
    }
    // Still exactly 1
    expect(emittedAlerts.filter((a) => a.reason === 'RESERVE_POLL_FAILURE').length).toBe(1);
  });

  it('does NOT emit RESERVE_POLL_FAILURE when poll recovers before 3 failures', async () => {
    let callCount = 0;
    const factory = makeFactory(async () => {
      callCount++;
      if (callCount <= 2) throw new Error('timeout');
      return [1_000_000n, 2_000_000n, 0] as [bigint, bigint, number];
    });

    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord());
    monitor.start();

    // 2 failures then 1 success
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(15_001);
      await drainQueue();
    }

    expect(emittedAlerts.filter((a) => a.reason === 'RESERVE_POLL_FAILURE').length).toBe(0);
  });

  // ─── AlertEvent shape ─────────────────────────────────────────────────────

  it('emitted AlertEvent has all required fields', async () => {
    // 90% drop → CRITICAL
    const factory = makeFactory(async () => [100_000n, 2_000_000n, 0]);
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord({ positionId: 'pos-uuid', contractAddress: '0xCONTRACT' }));
    monitor.start();

    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();

    expect(emittedAlerts.length).toBeGreaterThanOrEqual(1);
    const alert = emittedAlerts[0];
    expect(typeof alert.id).toBe('string');
    expect(alert.id.length).toBeGreaterThan(0);
    expect(alert.contractAddress).toBe('0xCONTRACT');
    expect(alert.positionId).toBe('pos-uuid');
    expect(typeof alert.detectedAt).toBe('number');
    expect(alert.pnlUsdc).toBeNull();
  });

  // ─── Elevated tier ────────────────────────────────────────────────────────

  it('CRITICAL drop elevates pool to 5 s polling tier', async () => {
    const factory = makeFactory(async () => [100_000n, 2_000_000n, 0]); // 90% drop
    monitor = new LiquidityMonitor({} as any, onAlert, factory);
    monitor.addPool(makeRecord());
    monitor.start();

    // Standard tick → CRITICAL + elevation
    await vi.advanceTimersByTimeAsync(15_001);
    await drainQueue();
    const afterFirstTick = emittedAlerts.length;
    expect(afterFirstTick).toBeGreaterThanOrEqual(1);

    // Elevated tick (5 s) fires and emits more alerts
    await vi.advanceTimersByTimeAsync(5_001);
    await drainQueue();
    expect(emittedAlerts.length).toBeGreaterThan(afterFirstTick);
  });
});

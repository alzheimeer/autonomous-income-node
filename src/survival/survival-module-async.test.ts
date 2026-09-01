/**
 * Unit tests for the async SurvivalModule class (Task 5.3)
 *
 * Tests mock-mode behaviour, tier transitions, emergency events,
 * balance_history persistence, and CapabilityGates distribution.
 *
 * Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 4.7
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SurvivalModule,
  SurvivalTier,
  type TierTransitionEvent,
  type BalanceHistoryStore,
} from './index.js';
import { getCapabilityGates } from './tier-evaluator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a SurvivalModule in mock mode (no real RPC) with an injected store */
function makeMockModule(
  mockBalance: bigint,
  store?: BalanceHistoryStore,
  pollIntervalMs = 999999, // effectively disabled for unit tests
): SurvivalModule {
  // Force mock mode via env — avoid touching real process.env permanently
  const original = process.env['MOCK_ONCHAIN_IDENTITY'];
  process.env['MOCK_ONCHAIN_IDENTITY'] = 'true';
  process.env['MOCK_USDC_BALANCE'] = mockBalance.toString();

  const mod = new SurvivalModule(
    'http://localhost:8545', // unused in mock mode
    '0x0000000000000000000000000000000000000001',
    { balanceHistoryStore: store, pollIntervalMs },
  );

  // Restore original env
  if (original === undefined) {
    delete process.env['MOCK_ONCHAIN_IDENTITY'];
  } else {
    process.env['MOCK_ONCHAIN_IDENTITY'] = original;
  }

  return mod;
}

// ---------------------------------------------------------------------------
// SurvivalModule – lifecycle
// ---------------------------------------------------------------------------

describe('SurvivalModule (async) – lifecycle', () => {
  it('is not running before start()', () => {
    const mod = makeMockModule(100_000000n);
    expect(mod.isRunning()).toBe(false);
  });

  it('is running after start()', async () => {
    const mod = makeMockModule(100_000000n);
    await mod.start();
    expect(mod.isRunning()).toBe(true);
    await mod.stop();
  });

  it('is not running after stop()', async () => {
    const mod = makeMockModule(100_000000n);
    await mod.start();
    await mod.stop();
    expect(mod.isRunning()).toBe(false);
  });

  it('throws when starting an already-running module', async () => {
    const mod = makeMockModule(100_000000n);
    await mod.start();
    await expect(mod.start()).rejects.toThrow('already running');
    await mod.stop();
  });
});

// ---------------------------------------------------------------------------
// SurvivalModule – initial state
// ---------------------------------------------------------------------------

describe('SurvivalModule (async) – initial state after start()', () => {
  it('sets the correct tier for mock balance of $100 (Tier 3)', async () => {
    const mod = makeMockModule(100_000000n); // $100 USDC
    await mod.start();
    expect(mod.getCurrentTier()).toBe(SurvivalTier.TIER_3);
    await mod.stop();
  });

  it('getCurrentBalance() returns the mock balance', async () => {
    const mod = makeMockModule(5_000000n); // $5 USDC
    await mod.start();
    expect(mod.getCurrentBalance()).toBe(5_000000n);
    await mod.stop();
  });

  it('getGates() returns the gates matching the initial tier', async () => {
    const mod = makeMockModule(1000_000000n); // $1000 → TIER_4
    await mod.start();
    expect(mod.getGates()).toEqual(getCapabilityGates(SurvivalTier.TIER_4));
    await mod.stop();
  });

  it('$0 balance → EMERGENCY tier on start', async () => {
    const mod = makeMockModule(0n);
    await mod.start();
    expect(mod.getCurrentTier()).toBe(SurvivalTier.EMERGENCY);
    await mod.stop();
  });
});

// ---------------------------------------------------------------------------
// SurvivalModule – balance_history persistence
// ---------------------------------------------------------------------------

describe('SurvivalModule (async) – balance_history persistence', () => {
  it('calls store.insert on start with the initial balance', async () => {
    const store: BalanceHistoryStore = { insert: vi.fn().mockReturnValue(1) };
    const mod = makeMockModule(50_000000n, store);
    await mod.start();
    expect(store.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        balanceUsdc: '50000000',
        tier: SurvivalTier.TIER_2,
      }),
    );
    await mod.stop();
  });

  it('does not throw when store is not provided', async () => {
    const mod = makeMockModule(100_000000n, undefined);
    await expect(mod.start()).resolves.not.toThrow();
    await mod.stop();
  });
});

// ---------------------------------------------------------------------------
// SurvivalModule – tier transition events
// ---------------------------------------------------------------------------

describe('SurvivalModule (async) – tier:transition events via manual poll', () => {
  let mod: SurvivalModule;

  beforeEach(async () => {
    // Start at $5 (Tier 1), poll disabled
    mod = makeMockModule(5_000000n, undefined, 999999);
    await mod.start();
  });

  afterEach(async () => {
    await mod.stop();
  });

  it('emits tier:transition when balance moves from Tier 1 to Tier 3', async () => {
    const events: TierTransitionEvent[] = [];
    mod.on('tier:transition', (e) => events.push(e));

    // Simulate a balance update by setting env and triggering internal poll
    // We test the internal processBalanceUpdate via a subclass hook
    // Instead, we directly call the exposed protected method for testing:
    // Access private method via type cast for testing purposes
    const internal = mod as unknown as { processBalanceUpdate(b: bigint): Promise<void> };
    await internal.processBalanceUpdate(500_000000n); // $500 → TIER_3

    expect(events).toHaveLength(1);
    expect(events[0]!.previousTier).toBe(SurvivalTier.TIER_1);
    expect(events[0]!.newTier).toBe(SurvivalTier.TIER_3);
    expect(events[0]!.balance).toBe(500_000000n);
    expect(events[0]!.gates).toEqual(getCapabilityGates(SurvivalTier.TIER_3));
  });

  it('emits tier:transition exactly once for a single tier change', async () => {
    const spy = vi.fn();
    mod.on('tier:transition', spy);

    const internal = mod as unknown as { processBalanceUpdate(b: bigint): Promise<void> };
    await internal.processBalanceUpdate(1000_000000n); // TIER_1 → TIER_4

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit tier:transition when tier is unchanged', async () => {
    const spy = vi.fn();
    mod.on('tier:transition', spy);

    const internal = mod as unknown as { processBalanceUpdate(b: bigint): Promise<void> };
    await internal.processBalanceUpdate(7_000000n); // still TIER_1
    await internal.processBalanceUpdate(9_999999n); // still TIER_1

    expect(spy).not.toHaveBeenCalled();
  });

  it('emits multiple tier:transition events for multiple tier crossings', async () => {
    const tiers: SurvivalTier[] = [];
    mod.on('tier:transition', (e) => tiers.push(e.newTier));

    const internal = mod as unknown as { processBalanceUpdate(b: bigint): Promise<void> };
    await internal.processBalanceUpdate(10_000000n);   // → TIER_2
    await internal.processBalanceUpdate(100_000000n);  // → TIER_3
    await internal.processBalanceUpdate(1000_000000n); // → TIER_4

    expect(tiers).toEqual([SurvivalTier.TIER_2, SurvivalTier.TIER_3, SurvivalTier.TIER_4]);
  });
});

// ---------------------------------------------------------------------------
// SurvivalModule – tier:emergency event
// ---------------------------------------------------------------------------

describe('SurvivalModule (async) – tier:emergency event', () => {
  it('emits tier:emergency when balance reaches $0', async () => {
    const mod = makeMockModule(5_000000n, undefined, 999999);
    await mod.start();

    const emergencyBalances: bigint[] = [];
    mod.on('tier:emergency', (b) => emergencyBalances.push(b));

    const internal = mod as unknown as { processBalanceUpdate(b: bigint): Promise<void> };
    await internal.processBalanceUpdate(0n);

    expect(emergencyBalances).toHaveLength(1);
    expect(emergencyBalances[0]).toBe(0n);
    await mod.stop();
  });

  it('does NOT emit tier:emergency for non-zero balances', async () => {
    const mod = makeMockModule(5_000000n, undefined, 999999);
    await mod.start();

    const spy = vi.fn();
    mod.on('tier:emergency', spy);

    const internal = mod as unknown as { processBalanceUpdate(b: bigint): Promise<void> };
    await internal.processBalanceUpdate(1n); // $0.000001 — not emergency

    expect(spy).not.toHaveBeenCalled();
    await mod.stop();
  });
});

// ---------------------------------------------------------------------------
// SurvivalModule – CapabilityGatesDistributor integration
// ---------------------------------------------------------------------------

describe('SurvivalModule (async) – gates distributor integration', () => {
  it('notifies gates distributor subscribers on tier change', async () => {
    const mod = makeMockModule(5_000000n, undefined, 999999);
    await mod.start();

    const spy = vi.fn();
    mod.getGatesDistributor().subscribe(spy);

    const internal = mod as unknown as { processBalanceUpdate(b: bigint): Promise<void> };
    await internal.processBalanceUpdate(1000_000000n); // → TIER_4

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      SurvivalTier.TIER_4,
      getCapabilityGates(SurvivalTier.TIER_4),
    );
    await mod.stop();
  });
});

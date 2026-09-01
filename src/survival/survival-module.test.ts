/**
 * Unit tests for SurvivalModule (index.ts) and CapabilityGatesDistributor
 *
 * Validates: Requirements 5.2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SurvivalTier,
  SurvivalModuleImpl,
  createSurvivalModule,
  type TierTransitionEvent,
} from './index.js';
import { CapabilityGatesDistributor } from './capability-gates.js';
import { getCapabilityGates } from './tier-evaluator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** $0 USDC → EMERGENCY */
const BALANCE_EMERGENCY = 0n;
/** $5 USDC → TIER_1 */
const BALANCE_TIER1 = 5_000000n;
/** $50 USDC → TIER_2 */
const BALANCE_TIER2 = 50_000000n;
/** $500 USDC → TIER_3 */
const BALANCE_TIER3 = 500_000000n;
/** $1500 USDC → TIER_4 */
const BALANCE_TIER4 = 1500_000000n;

// ---------------------------------------------------------------------------
// SurvivalModuleImpl – lifecycle
// ---------------------------------------------------------------------------

describe('SurvivalModuleImpl – lifecycle', () => {
  it('is not running before start()', () => {
    const m = createSurvivalModule();
    expect(m.isRunning()).toBe(false);
  });

  it('is running after start()', () => {
    const m = createSurvivalModule();
    m.start(BALANCE_TIER2);
    expect(m.isRunning()).toBe(true);
    m.stop();
  });

  it('is not running after stop()', () => {
    const m = createSurvivalModule();
    m.start(BALANCE_TIER2);
    m.stop();
    expect(m.isRunning()).toBe(false);
  });

  it('throws when starting an already-running module', () => {
    const m = createSurvivalModule();
    m.start(BALANCE_TIER2);
    expect(() => m.start(BALANCE_TIER1)).toThrow('already running');
    m.stop();
  });

  it('throws when updateBalance is called before start', () => {
    const m = createSurvivalModule();
    expect(() => m.updateBalance(BALANCE_TIER1)).toThrow('not running');
  });
});

// ---------------------------------------------------------------------------
// SurvivalModuleImpl – getCurrentTier / getCapabilityGates
// ---------------------------------------------------------------------------

describe('SurvivalModuleImpl – initial state', () => {
  it('starts with the correct tier for the initial balance', () => {
    const m = createSurvivalModule();
    m.start(BALANCE_TIER3);
    expect(m.getCurrentTier()).toBe(SurvivalTier.TIER_3);
    m.stop();
  });

  it('getCapabilityGates returns the gates matching the initial tier', () => {
    const m = createSurvivalModule();
    m.start(BALANCE_TIER4);
    expect(m.getCapabilityGates()).toEqual(getCapabilityGates(SurvivalTier.TIER_4));
    m.stop();
  });

  it('initial balance of 0 → EMERGENCY tier', () => {
    const m = createSurvivalModule();
    m.start(BALANCE_EMERGENCY);
    expect(m.getCurrentTier()).toBe(SurvivalTier.EMERGENCY);
    m.stop();
  });
});

// ---------------------------------------------------------------------------
// SurvivalModuleImpl – updateBalance / tier transitions
// ---------------------------------------------------------------------------

describe('SurvivalModuleImpl – updateBalance', () => {
  let module: SurvivalModuleImpl;

  beforeEach(() => {
    module = createSurvivalModule();
    module.start(BALANCE_EMERGENCY);
  });

  it('updates the tier when balance crosses a threshold', () => {
    module.updateBalance(BALANCE_TIER1);
    expect(module.getCurrentTier()).toBe(SurvivalTier.TIER_1);
    module.stop();
  });

  it('does not emit tier:transition when the tier is unchanged', () => {
    module.updateBalance(BALANCE_TIER2); // EMERGENCY → TIER_2
    const spy = vi.fn();
    module.onTierTransition(spy);

    module.updateBalance(50_000001n); // still TIER_2 — no change
    expect(spy).not.toHaveBeenCalled();
    module.stop();
  });

  it('emits tier:transition exactly once when the tier changes', () => {
    const spy = vi.fn();
    module.onTierTransition(spy);

    module.updateBalance(BALANCE_TIER2); // EMERGENCY → TIER_2
    expect(spy).toHaveBeenCalledTimes(1);
    module.stop();
  });

  it('emits tier:transition with correct previousTier and newTier', () => {
    const events: TierTransitionEvent[] = [];
    module.onTierTransition(e => events.push(e));

    module.updateBalance(BALANCE_TIER1); // EMERGENCY → TIER_1
    expect(events[0]?.previousTier).toBe(SurvivalTier.EMERGENCY);
    expect(events[0]?.newTier).toBe(SurvivalTier.TIER_1);
    module.stop();
  });

  it('emits tier:transition with the triggering balance', () => {
    const events: TierTransitionEvent[] = [];
    module.onTierTransition(e => events.push(e));

    module.updateBalance(BALANCE_TIER3);
    expect(events[0]?.balance).toBe(BALANCE_TIER3);
    module.stop();
  });

  it('emits tier:transition with the correct capability gates for the new tier', () => {
    const events: TierTransitionEvent[] = [];
    module.onTierTransition(e => events.push(e));

    module.updateBalance(BALANCE_TIER4);
    expect(events[0]?.gates).toEqual(getCapabilityGates(SurvivalTier.TIER_4));
    module.stop();
  });

  it('emits tier:transition with a timestamp close to Date.now()', () => {
    const before = Date.now();
    const events: TierTransitionEvent[] = [];
    module.onTierTransition(e => events.push(e));

    module.updateBalance(BALANCE_TIER2);
    const after = Date.now();

    expect(events[0]?.timestamp).toBeGreaterThanOrEqual(before);
    expect(events[0]?.timestamp).toBeLessThanOrEqual(after);
    module.stop();
  });

  it('notifies multiple listeners on a single tier change', () => {
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    module.onTierTransition(spy1);
    module.onTierTransition(spy2);

    module.updateBalance(BALANCE_TIER2);
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
    module.stop();
  });

  it('emits a transition for each distinct threshold crossing', () => {
    const events: TierTransitionEvent[] = [];
    module.onTierTransition(e => events.push(e));

    module.updateBalance(BALANCE_TIER1); // EMERGENCY → TIER_1
    module.updateBalance(BALANCE_TIER2); // TIER_1 → TIER_2
    module.updateBalance(BALANCE_TIER3); // TIER_2 → TIER_3
    module.updateBalance(BALANCE_TIER4); // TIER_3 → TIER_4

    expect(events).toHaveLength(4);
    expect(events.map(e => e.newTier)).toEqual([
      SurvivalTier.TIER_1,
      SurvivalTier.TIER_2,
      SurvivalTier.TIER_3,
      SurvivalTier.TIER_4,
    ]);
    module.stop();
  });

  it('handles downward tier transitions (balance drop)', () => {
    module.updateBalance(BALANCE_TIER4); // → TIER_4
    const events: TierTransitionEvent[] = [];
    module.onTierTransition(e => events.push(e));

    module.updateBalance(BALANCE_TIER1); // TIER_4 → TIER_1
    expect(events[0]?.previousTier).toBe(SurvivalTier.TIER_4);
    expect(events[0]?.newTier).toBe(SurvivalTier.TIER_1);
    module.stop();
  });
});

// ---------------------------------------------------------------------------
// SurvivalModuleImpl – onTierTransition unsubscribe
// ---------------------------------------------------------------------------

describe('SurvivalModuleImpl – unsubscribe', () => {
  it('unsubscribe function stops future notifications', () => {
    const module = createSurvivalModule();
    module.start(BALANCE_EMERGENCY);

    const spy = vi.fn();
    const unsub = module.onTierTransition(spy);

    module.updateBalance(BALANCE_TIER1); // fires once
    unsub();
    module.updateBalance(BALANCE_TIER2); // should NOT fire
    expect(spy).toHaveBeenCalledTimes(1);
    module.stop();
  });
});

// ---------------------------------------------------------------------------
// SurvivalModuleImpl – notifications arrive within 1 second
// ---------------------------------------------------------------------------

describe('SurvivalModuleImpl – timing (< 1 second requirement)', () => {
  it('fires the tier:transition listener synchronously (same tick, 0 ms delay)', () => {
    const module = createSurvivalModule();
    module.start(BALANCE_EMERGENCY);

    const receivedAt: number[] = [];
    module.onTierTransition(() => receivedAt.push(Date.now()));

    const before = Date.now();
    module.updateBalance(BALANCE_TIER2);
    const after = Date.now();

    // Listener was called synchronously — receivedAt[0] is between before and after
    expect(receivedAt).toHaveLength(1);
    expect(receivedAt[0]!).toBeGreaterThanOrEqual(before);
    expect(receivedAt[0]!).toBeLessThanOrEqual(after + 1000); // comfortably < 1 s
    module.stop();
  });
});

// ---------------------------------------------------------------------------
// CapabilityGatesDistributor
// ---------------------------------------------------------------------------

describe('CapabilityGatesDistributor', () => {
  it('starts with 0 subscribers', () => {
    const d = new CapabilityGatesDistributor();
    expect(d.subscriberCount).toBe(0);
  });

  it('subscribe increases subscriber count', () => {
    const d = new CapabilityGatesDistributor();
    d.subscribe(vi.fn());
    expect(d.subscriberCount).toBe(1);
  });

  it('unsubscribe decreases subscriber count', () => {
    const d = new CapabilityGatesDistributor();
    const unsub = d.subscribe(vi.fn());
    unsub();
    expect(d.subscriberCount).toBe(0);
  });

  it('calls all subscribers with the new tier and its gates', () => {
    const d = new CapabilityGatesDistributor();
    const spy = vi.fn();
    d.subscribe(spy);

    d.notify(SurvivalTier.TIER_3);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      SurvivalTier.TIER_3,
      getCapabilityGates(SurvivalTier.TIER_3),
    );
  });

  it('notifies multiple subscribers', () => {
    const d = new CapabilityGatesDistributor();
    const s1 = vi.fn();
    const s2 = vi.fn();
    d.subscribe(s1);
    d.subscribe(s2);

    d.notify(SurvivalTier.TIER_4);
    expect(s1).toHaveBeenCalledTimes(1);
    expect(s2).toHaveBeenCalledTimes(1);
  });

  it('does not call unsubscribed callback', () => {
    const d = new CapabilityGatesDistributor();
    const spy = vi.fn();
    const unsub = d.subscribe(spy);
    unsub();

    d.notify(SurvivalTier.TIER_2);
    expect(spy).not.toHaveBeenCalled();
  });

  it('swallows subscriber errors without crashing', () => {
    const d = new CapabilityGatesDistributor();
    d.subscribe(() => {
      throw new Error('subscriber crash');
    });
    const safeSpy = vi.fn();
    d.subscribe(safeSpy);

    // Should not throw; safeSpy should still be called.
    expect(() => d.notify(SurvivalTier.TIER_1)).not.toThrow();
    expect(safeSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Integration: SurvivalModule notifies CapabilityGatesDistributor
// ---------------------------------------------------------------------------

describe('Integration: SurvivalModule → CapabilityGatesDistributor', () => {
  it('distributor subscribers receive gates update on tier change', () => {
    const distributor = new CapabilityGatesDistributor();
    const module = createSurvivalModule(distributor);
    module.start(BALANCE_EMERGENCY);

    const spy = vi.fn();
    distributor.subscribe(spy);

    module.updateBalance(BALANCE_TIER4);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      SurvivalTier.TIER_4,
      getCapabilityGates(SurvivalTier.TIER_4),
    );
    module.stop();
  });

  it('distributor does NOT receive notification when tier is unchanged', () => {
    const distributor = new CapabilityGatesDistributor();
    const module = createSurvivalModule(distributor);
    module.start(BALANCE_TIER2);

    const spy = vi.fn();
    distributor.subscribe(spy);

    module.updateBalance(50_000001n); // still TIER_2
    expect(spy).not.toHaveBeenCalled();
    module.stop();
  });

  it('factory createSurvivalModule uses a shared distributor correctly', () => {
    const distributor = new CapabilityGatesDistributor();
    const moduleA = createSurvivalModule(distributor);
    const moduleB = createSurvivalModule(distributor); // shares same distributor

    moduleA.start(BALANCE_EMERGENCY);
    moduleB.start(BALANCE_EMERGENCY);

    const spy = vi.fn();
    distributor.subscribe(spy);

    moduleA.updateBalance(BALANCE_TIER3);
    moduleB.updateBalance(BALANCE_TIER1);

    // Each module fires its own notify on the shared distributor
    expect(spy).toHaveBeenCalledTimes(2);
    moduleA.stop();
    moduleB.stop();
  });
});

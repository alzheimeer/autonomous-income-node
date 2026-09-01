/**
 * Property 7 — ActionDispatcher: plans with N > 10 actions dispatch exactly 10
 *
 * Validates: Requirements 2.3, 2.4, 2.8
 *
 * Properties verified:
 *  P7-a: For any ActionPlan with N > MAX_CONCURRENT_ACTIONS actions, dispatch
 *        returns exactly MAX_CONCURRENT_ACTIONS observations.
 *  P7-b: The dispatched actions are those with the highest priority (lowest number).
 *  P7-c: For N <= MAX_CONCURRENT_ACTIONS, all N actions are dispatched.
 *  P7-d: Dispatch never throws — all actions return an Observation.
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import {
  ActionDispatcher,
  MAX_CONCURRENT_ACTIONS,
  selectTopActions,
  type ModuleHandlers,
} from '../action-dispatcher.js';
import type { Action } from '../fallback-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an arbitrary Action for use in property tests */
const arbAction = fc.record({
  id: fc.uuid(),
  module: fc.constantFrom(
    'identity',
    'payment',
    'trading',
    'services',
    'social',
    'self-mod',
    'replication',
    'heartbeat'
  ) as fc.Arbitrary<Action['module']>,
  tool: fc.string({ minLength: 1, maxLength: 30 }),
  params: fc.constant({} as Record<string, unknown>),
  priority: fc.integer({ min: 1, max: 10 }),
});

/** A simple no-op handler that resolves immediately */
const noopHandlers: ModuleHandlers = {
  identity: async () => 'ok',
  payment: async () => 'ok',
  trading: async () => 'ok',
  services: async () => 'ok',
  social: async () => 'ok',
  'self-mod': async () => 'ok',
  replication: async () => 'ok',
  heartbeat: async () => 'ok',
};

describe('Property 7 — ActionDispatcher: MAX_CONCURRENT_ACTIONS enforcement', () => {
  /**
   * P7-a: Plans with N > MAX_CONCURRENT_ACTIONS dispatch exactly MAX_CONCURRENT_ACTIONS.
   * Validates: Requirement 2.8
   */
  it('P7-a: dispatch returns exactly MAX_CONCURRENT_ACTIONS observations when N > 10', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAction, { minLength: MAX_CONCURRENT_ACTIONS + 1, maxLength: 50 }),
        async (actions) => {
          const dispatcher = new ActionDispatcher();
          const observations = await dispatcher.dispatch(actions, noopHandlers);
          return observations.length === MAX_CONCURRENT_ACTIONS;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P7-b: The dispatched actions are those with the highest priority (lowest number).
   * Validates: Requirement 2.3
   */
  it('P7-b: selected actions are the highest-priority (lowest priority number)', () => {
    fc.assert(
      fc.property(
        fc.array(arbAction, { minLength: MAX_CONCURRENT_ACTIONS + 1, maxLength: 50 }),
        (actions) => {
          const selected = selectTopActions(actions, MAX_CONCURRENT_ACTIONS);
          const selectedIds = new Set(selected.map((a) => a.id));

          // The max priority in selected should be <= the min priority NOT selected
          const notSelectedPriorities = actions
            .filter((a) => !selectedIds.has(a.id))
            .map((a) => a.priority);

          if (notSelectedPriorities.length === 0) return true;

          const maxSelectedPriority = Math.max(...selected.map((a) => a.priority));
          const minNotSelectedPriority = Math.min(...notSelectedPriorities);

          // All selected should have priority <= any not-selected action
          return maxSelectedPriority <= minNotSelectedPriority;
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * P7-c: For N <= MAX_CONCURRENT_ACTIONS, all N actions are dispatched.
   * Validates: Requirement 2.4
   */
  it('P7-c: all actions are dispatched when count <= MAX_CONCURRENT_ACTIONS', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAction, { minLength: 0, maxLength: MAX_CONCURRENT_ACTIONS }),
        async (actions) => {
          const dispatcher = new ActionDispatcher();
          const observations = await dispatcher.dispatch(actions, noopHandlers);
          return observations.length === actions.length;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P7-d: Dispatch never throws — all action results are Observations.
   * Validates: Requirement 2.3
   */
  it('P7-d: dispatch never throws even with empty handlers map', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(arbAction, { minLength: 1, maxLength: 20 }),
        async (actions) => {
          const dispatcher = new ActionDispatcher();
          // Pass empty handlers — all should return failed Observations, not throw
          const observations = await dispatcher.dispatch(actions, {});
          const expectedCount = Math.min(actions.length, MAX_CONCURRENT_ACTIONS);
          return (
            observations.length === expectedCount &&
            observations.every(
              (obs) =>
                typeof obs.actionId === 'string' &&
                typeof obs.success === 'boolean' &&
                typeof obs.latencyMs === 'number' &&
                typeof obs.timestamp === 'number'
            )
          );
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * P7-e: selectTopActions returns exactly limit elements (or all if fewer available).
   */
  it('P7-e: selectTopActions always returns min(N, limit) elements', () => {
    fc.assert(
      fc.property(
        fc.array(arbAction, { minLength: 0, maxLength: 30 }),
        fc.integer({ min: 1, max: 20 }),
        (actions, limit) => {
          const selected = selectTopActions(actions, limit);
          const expected = Math.min(actions.length, limit);
          return selected.length === expected;
        }
      ),
      { numRuns: 300 }
    );
  });
});

/**
 * ActionDispatcher — Dispatches Actions to their target module handlers.
 *
 * Key behaviours (Requirements 2.3, 2.4, 2.8):
 *   - Accepts up to N actions; keeps the MAX_CONCURRENT_ACTIONS highest-priority
 *     ones and silently discards the rest.
 *   - Dispatches selected actions concurrently via Promise.all.
 *   - Returns an Observation for every action (success or error).
 *   - Never throws — all exceptions are caught and returned as failed Observations.
 */

import type { Action, ModuleName } from './fallback-engine.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Result of executing a single {@link Action}.
 */
export interface Observation {
  /** ID of the action that produced this observation. */
  actionId: string;
  /** Whether the action succeeded. */
  success: boolean;
  /** Arbitrary result value returned by the module handler. */
  result: unknown;
  /** Error message if the action failed. */
  error?: string;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
  /** Unix epoch timestamp (ms) when the observation was created. */
  timestamp: number;
}

/**
 * A function that handles a single action for a given module.
 * Returns the result or throws on failure.
 */
export type ModuleHandler = (action: Action) => Promise<unknown>;

/**
 * Map from ModuleName to its handler function.
 * Handlers that are not registered fall back to a "module not found" error.
 */
export type ModuleHandlers = Partial<Record<ModuleName, ModuleHandler>>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of concurrent actions per cycle (Requirement 2.8). */
export const MAX_CONCURRENT_ACTIONS = 10;

// ---------------------------------------------------------------------------
// ActionDispatcher
// ---------------------------------------------------------------------------

export class ActionDispatcher {
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = MAX_CONCURRENT_ACTIONS) {
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Dispatch up to {@link maxConcurrent} actions (those with the highest
   * priority, i.e. lowest `priority` number) and return their observations.
   *
   * If `actions.length > maxConcurrent`, the excess low-priority actions are
   * discarded — they are **not** executed and do **not** appear in the result.
   *
   * All selected actions run concurrently via `Promise.allSettled`.
   *
   * @param actions        - Full list of actions from the ActionPlan.
   * @param moduleHandlers - Handler map keyed by module name.
   * @returns Array of Observations, one per dispatched action.
   */
  async dispatch(
    actions: Action[],
    moduleHandlers: ModuleHandlers,
  ): Promise<Observation[]> {
    if (actions.length === 0) {
      return [];
    }

    // Select up to maxConcurrent highest-priority actions.
    // Lower `priority` number == higher urgency (1 is highest).
    const selected = selectTopActions(actions, this.maxConcurrent);

    // Dispatch all selected actions concurrently
    const results = await Promise.allSettled(
      selected.map((action) => this.executeAction(action, moduleHandlers)),
    );

    return results.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      // Should not happen because executeAction itself catches all errors,
      // but be defensive.
      const action = selected[idx]!;
      return {
        actionId: action.id,
        success: false,
        result: null,
        error: `Unexpected dispatcher error: ${String(result.reason)}`,
        latencyMs: 0,
        timestamp: Date.now(),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Execute a single action via its module handler.
   * Never throws — catches all errors and returns a failed Observation.
   */
  private async executeAction(
    action: Action,
    moduleHandlers: ModuleHandlers,
  ): Promise<Observation> {
    const startMs = Date.now();

    const handler = moduleHandlers[action.module];

    if (!handler) {
      return {
        actionId: action.id,
        success: false,
        result: null,
        error: `No handler registered for module "${action.module}"`,
        latencyMs: Date.now() - startMs,
        timestamp: Date.now(),
      };
    }

    try {
      const result = await handler(action);
      const endMs = Date.now();
      return {
        actionId: action.id,
        success: true,
        result,
        latencyMs: endMs - startMs,
        timestamp: endMs,
      };
    } catch (err) {
      const endMs = Date.now();
      return {
        actionId: action.id,
        success: false,
        result: null,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: endMs - startMs,
        timestamp: endMs,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Pure utility — exported for testability
// ---------------------------------------------------------------------------

/**
 * Return the top-`limit` highest-priority actions from `actions`.
 *
 * Priority is ascending (1 = highest urgency, 10 = lowest urgency).
 * When priorities are equal, the original order is preserved (stable sort).
 *
 * @param actions - Full list of candidate actions.
 * @param limit   - Maximum number of actions to return.
 */
export function selectTopActions(actions: Action[], limit: number): Action[] {
  if (actions.length <= limit) {
    return [...actions].sort((a, b) => a.priority - b.priority);
  }

  // Sort by priority ascending, then take the first `limit`
  return [...actions]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, limit);
}

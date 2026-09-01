/**
 * Capability Gates Distributor
 *
 * Manages subscriptions for capability gate updates and distributes
 * the new gates to all registered modules when a tier transition occurs.
 *
 * Requirements: 5.2
 */

import type { CapabilityGates, SurvivalTier } from './tier-evaluator.js';
import { getCapabilityGates } from './tier-evaluator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A callback invoked whenever capability gates change due to a tier transition.
 * Receives the new tier and the corresponding capability gates.
 */
export type GatesUpdateCallback = (
  tier: SurvivalTier,
  gates: CapabilityGates,
) => void;

// ---------------------------------------------------------------------------
// CapabilityGatesDistributor
// ---------------------------------------------------------------------------

/**
 * Manages a set of subscriber callbacks that are notified synchronously
 * whenever the active tier changes, giving each subscriber the updated
 * {@link CapabilityGates} for the new tier.
 *
 * The distributor is intentionally lightweight and side-effect-free: it owns
 * no EventEmitter, no timers, and no state beyond the subscriber list.
 * The {@link SurvivalModule} (index.ts) drives the actual tier transitions.
 */
export class CapabilityGatesDistributor {
  private readonly subscribers = new Set<GatesUpdateCallback>();

  /**
   * Subscribe to capability-gate updates.
   *
   * @param cb - Called synchronously whenever the tier (and therefore the
   *             capability gates) changes.
   * @returns An unsubscribe function that removes this subscriber.
   */
  subscribe(cb: GatesUpdateCallback): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  /**
   * Notify all current subscribers of a tier transition.
   *
   * Called by the SurvivalModule immediately after it confirms a tier change.
   *
   * @param newTier - The tier that just became active.
   */
  notify(newTier: SurvivalTier): void {
    const gates = getCapabilityGates(newTier);
    for (const cb of this.subscribers) {
      try {
        cb(newTier, gates);
      } catch (err) {
        // Subscribers must not crash the distribution loop.
        // Errors are surfaced as a console warning and swallowed.
        console.warn('[CapabilityGatesDistributor] subscriber threw:', err);
      }
    }
  }

  /**
   * Number of active subscribers (useful for testing / introspection).
   */
  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

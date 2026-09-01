/**
 * AgentEventBus — Typed internal EventEmitter for inter-module communication.
 *
 * Provides a strongly-typed wrapper over Node.js EventEmitter so that all
 * events in the system are validated at compile time.
 *
 * Requirements: 2.2, 2.7, 14.1
 */

import { EventEmitter } from 'node:events';

import type { TierTransitionEvent } from '../survival/index.js';

// ---------------------------------------------------------------------------
// AgentEvents — complete typed event map
// ---------------------------------------------------------------------------

/**
 * All events that can flow through the AgentEventBus.
 * Keys are event names; values are tuples of the listener arguments.
 *
 * The index signature is required so that `AgentEvents` satisfies
 * `Record<string, unknown[]>` for the TypedEventEmitter generic.
 */
export interface AgentEvents extends Record<string, unknown[]> {
  /** Identity module finished initialising — wallet address + confirmed flag. */
  'identity:ready': [payload: { address: string; confirmed: boolean }];

  /** Survival module detected a tier change. */
  'tier:transition': [event: TierTransitionEvent];

  /** Balance hit $0 — emergency mode. */
  'tier:emergency': [balance: bigint];

  /** USDC balance polled — contains new balance in 6-decimal bigint units. */
  'balance:updated': [balance: bigint, tier: number];

  /** A module reported unhealthy for 2+ consecutive heartbeat cycles. */
  'alert:module-degraded': [module: string, timestamp: number];

  /** Agent fully initialised and ReAct loop started. */
  'agent:started': [timestamp: number];

  /** Agent gracefully stopped (or halted). */
  'agent:stopping': [reason: string];

  /** Agent has fully stopped. */
  'agent:stopped': [reason: string];

  /** ReAct loop completed one full Think→Act→Observe cycle. */
  'cycle:completed': [cycleId: string, actionsCount: number];

  /** Heartbeat module triggering a health check across all modules. */
  'heartbeat:check': [timestamp: number];
}

// ---------------------------------------------------------------------------
// TypedEventEmitter helper
// ---------------------------------------------------------------------------

// Node.js 20 ships EventEmitter with a generic type parameter for the event
// map, so we can forward-declare the overloads cleanly.

type EventArgs<T, K extends keyof T> = T[K] extends unknown[] ? T[K] : never;

/**
 * Strongly-typed EventEmitter subclass.
 *
 * The generic parameter `Events` is a map of `{ eventName: [arg1, arg2, …] }`.
 * Calling `emit`, `on`, `once`, or `off` with an unknown event name is a
 * compile-time error.
 */
export class TypedEventEmitter<Events extends Record<string, unknown[]>> extends EventEmitter {
  emit<K extends keyof Events & string>(
    event: K,
    ...args: EventArgs<Events, K>
  ): boolean {
    return super.emit(event, ...args);
  }

  on<K extends keyof Events & string>(
    event: K,
    listener: (...args: EventArgs<Events, K>) => void,
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  once<K extends keyof Events & string>(
    event: K,
    listener: (...args: EventArgs<Events, K>) => void,
  ): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  off<K extends keyof Events & string>(
    event: K,
    listener: (...args: EventArgs<Events, K>) => void,
  ): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

// ---------------------------------------------------------------------------
// AgentEventBus
// ---------------------------------------------------------------------------

/**
 * Singleton-ready, typed event bus for the Autonomous Income Node.
 *
 * Usage:
 * ```ts
 * const bus = new AgentEventBus();
 * bus.on('identity:ready', ({ address, confirmed }) => { … });
 * bus.emit('identity:ready', { address: '0x…', confirmed: true });
 * ```
 */
export class AgentEventBus extends TypedEventEmitter<AgentEvents> {
  constructor() {
    super();
    // Increase the default listener limit to accommodate all modules
    this.setMaxListeners(50);
  }
}

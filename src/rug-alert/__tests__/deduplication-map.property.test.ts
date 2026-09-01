/**
 * Property-based tests for DeduplicationMap
 *
 * Feature: rug-alert-service, Property 5: Deduplication is TTL-bounded and case-insensitive
 *
 * **Validates: Requirements 8.1, 8.2, 8.5**
 */

import { describe, it, afterEach, vi } from 'vitest';
import * as fc from 'fast-check';
import { DeduplicationMap } from '../deduplication-map.js';
import type { AlertReason } from '../types.js';

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const ALL_REASONS: AlertReason[] = [
  'LIQUIDITY_DROP_HIGH',
  'LIQUIDITY_DROP_CRITICAL',
  'RESERVE_POLL_FAILURE',
  'LP_REMOVAL_HIGH',
  'LP_REMOVAL_CRITICAL',
  'DEPLOYER_SELL_HIGH',
  'DEPLOYER_SELL_CRITICAL',
  'WHALE_SELL_TO_DEX',
];

/** Arbitrary valid-looking Ethereum address (40 hex chars, 0x prefix) */
const arbAddress = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((hex) => `0x${hex}`);

/** Arbitrary AlertReason */
const arbReason = fc.constantFrom(...ALL_REASONS);

/** Arbitrary positive TTL in ms (1 ms – 10 minutes) */
const arbTtlMs = fc.integer({ min: 1, max: 600_000 });

/**
 * Builds a DeduplicationMap with a fixed TTL injected via env var
 * so the constructor reads it deterministically.
 */
function makeMapWithTtl(ttlMs: number): DeduplicationMap {
  process.env['RUG_ALERT_DEDUP_TTL_MS'] = String(ttlMs);
  return new DeduplicationMap();
}

// ─── Properties ──────────────────────────────────────────────────────────────

describe('Property 5 — DeduplicationMap: TTL-bounded deduplication', () => {
  afterEach(() => {
    delete process.env['RUG_ALERT_DEDUP_TTL_MS'];
    vi.useRealTimers();
  });

  /**
   * P5-a: A second identical alert arriving before TTL expires is suppressed.
   * Validates: Requirements 8.1, 8.2
   */
  it('P5-a: alert within TTL window is suppressed', () => {
    fc.assert(
      fc.property(arbAddress, arbReason, arbTtlMs, (address, reason, ttlMs) => {
        vi.useFakeTimers();

        const m = makeMapWithTtl(ttlMs);
        m.register(address, reason);

        // Advance time to just before expiry
        const delta = fc.sample(fc.integer({ min: 0, max: ttlMs - 1 }), 1)[0]!;
        vi.advanceTimersByTime(delta);

        const suppressed = m.isDuplicate(address, reason);

        vi.useRealTimers();
        return suppressed === true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P5-b: A second identical alert arriving at or after TTL expires is NOT suppressed.
   * Validates: Requirement 8.5
   */
  it('P5-b: alert at or after TTL expiry is NOT suppressed', () => {
    fc.assert(
      fc.property(arbAddress, arbReason, arbTtlMs, (address, reason, ttlMs) => {
        vi.useFakeTimers();

        const m = makeMapWithTtl(ttlMs);
        m.register(address, reason);

        // Advance time to at least the expiry boundary
        vi.advanceTimersByTime(ttlMs);

        const suppressed = m.isDuplicate(address, reason);

        vi.useRealTimers();
        return suppressed === false;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P5-c: Deduplication is case-insensitive — any mix of upper/lower case in the
   * address resolves to the same deduplication key.
   * Validates: Requirement 8.5
   */
  it('P5-c: registration with any casing matches lookup with any other casing', () => {
    fc.assert(
      fc.property(arbAddress, arbReason, arbTtlMs, (address, reason, ttlMs) => {
        vi.useFakeTimers();

        const m = makeMapWithTtl(ttlMs);

        // Register with uppercase
        m.register(address.toUpperCase(), reason);

        // Look up with lowercase — must still be considered a duplicate
        const result = m.isDuplicate(address.toLowerCase(), reason);

        vi.useRealTimers();
        return result === true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P5-d: No entry exists before register is called, so isDuplicate returns false.
   * Validates: Requirement 8.1
   */
  it('P5-d: isDuplicate returns false for an address+reason that was never registered', () => {
    fc.assert(
      fc.property(arbAddress, arbReason, arbTtlMs, (address, reason, ttlMs) => {
        const m = makeMapWithTtl(ttlMs);
        return m.isDuplicate(address, reason) === false;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P5-e: After clear(), isDuplicate always returns false regardless of prior registrations.
   * Validates: Requirement 8.6
   */
  it('P5-e: clear() resets all entries so no address+reason is considered a duplicate', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(arbAddress, arbReason), { minLength: 1, maxLength: 20 }),
        arbTtlMs,
        (entries, ttlMs) => {
          vi.useFakeTimers();

          const m = makeMapWithTtl(ttlMs);
          for (const [addr, rsn] of entries) {
            m.register(addr, rsn);
          }

          m.clear();

          const allClear = entries.every(([addr, rsn]) => m.isDuplicate(addr, rsn) === false);

          vi.useRealTimers();
          return allClear;
        },
      ),
      { numRuns: 100 },
    );
  });
});

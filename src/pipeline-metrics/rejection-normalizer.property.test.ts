/**
 * Property Tests for rejection-normalizer.ts
 *
 * **Validates: Requirements 3.1**
 *
 * Property 4: Gate Rejection Normalization Completeness
 * - Generate arbitrary combinations of raw rejection strings
 * - Verify each maps to exactly one of 8 normalized keys
 * - Verify one row per reason (no duplicates)
 *
 * Uses fast-check for property-based testing with vitest.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  normalizeGateRejection,
  normalizeGateRejections,
  getGateRejectionKeys,
} from './rejection-normalizer.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The 8 known raw gate rejection strings from the pipeline.
 * These come from `GateResult.rejectReasons` in CostAwareTradeGate.
 */
const RAW_GATE_REJECTION_STRINGS: readonly string[] = [
  'Net profit below minimum USD',
  'Net profit below minimum bps',
  'Entry quote stale',
  'Exit quote stale',
  'Entry price impact too high',
  'Exit price impact too high',
  'Gas exceeds budget',
  'Expected profit exceeds sanity limit',
] as const;

/**
 * The 8 normalized keys that map from the raw strings.
 */
const NORMALIZED_GATE_KEYS: readonly string[] = [
  'profit_below_min_usd',
  'profit_below_min_bps',
  'entry_quote_stale',
  'exit_quote_stale',
  'entry_impact_high',
  'exit_impact_high',
  'gas_exceeds_budget',
  'profit_sanity_fail',
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arbitrary for a single raw gate rejection string (one of the 8 known strings).
 */
const arbRawGateRejection = fc.constantFrom(...RAW_GATE_REJECTION_STRINGS);

/**
 * Arbitrary for an array of raw rejection strings (0 to 8 items, may have duplicates).
 */
const arbRawRejectionArray = fc.array(arbRawGateRejection, { minLength: 0, maxLength: 8 });

/**
 * Arbitrary for an arbitrary string (including unknown rejection strings).
 */
const arbArbitraryString = fc.string({ minLength: 0, maxLength: 100 });

/**
 * Arbitrary for a unique subset of the 8 raw rejection strings (no duplicates).
 */
const arbUniqueRawRejections = fc.shuffledSubarray(RAW_GATE_REJECTION_STRINGS, {
  minLength: 0,
  maxLength: 8,
});

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 4: Gate Rejection Normalization Completeness', () => {
  /**
   * P4-a: Each known raw rejection string maps to exactly one normalized key.
   */
  it('P4-a: each known raw rejection maps to exactly one normalized key', () => {
    fc.assert(
      fc.property(arbRawGateRejection, (rawReason) => {
        const normalized = normalizeGateRejection(rawReason);

        // Must be one of the 8 normalized keys (not unknown_gate_reason)
        expect(NORMALIZED_GATE_KEYS).toContain(normalized);

        // Must not be the fallback
        expect(normalized).not.toBe('unknown_gate_reason');

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P4-b: The normalization function is deterministic (same input → same output).
   */
  it('P4-b: normalization is deterministic', () => {
    fc.assert(
      fc.property(arbRawGateRejection, (rawReason) => {
        const first = normalizeGateRejection(rawReason);
        const second = normalizeGateRejection(rawReason);

        expect(first).toBe(second);

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P4-c: An array of raw rejections produces one normalized key per input reason.
   * Verifies that the output array length equals input array length (one row per reason).
   */
  it('P4-c: array normalization produces one row per reason', () => {
    fc.assert(
      fc.property(arbRawRejectionArray, (rawReasons) => {
        const normalized = normalizeGateRejections(rawReasons);

        // Output length must equal input length (one row per reason)
        expect(normalized).toHaveLength(rawReasons.length);

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P4-d: All 8 raw strings have distinct normalized keys (bijective mapping).
   */
  it('P4-d: all 8 raw strings map to distinct normalized keys', () => {
    const normalizedResults = RAW_GATE_REJECTION_STRINGS.map(normalizeGateRejection);
    const uniqueNormalized = new Set(normalizedResults);

    // Should have exactly 8 unique normalized keys
    expect(uniqueNormalized.size).toBe(8);

    // Each should be in the expected list
    for (const key of normalizedResults) {
      expect(NORMALIZED_GATE_KEYS).toContain(key);
    }
  });

  /**
   * P4-e: Unknown/arbitrary strings map to 'unknown_gate_reason'.
   */
  it('P4-e: unknown strings map to unknown_gate_reason fallback', () => {
    fc.assert(
      fc.property(arbArbitraryString, (arbitraryString) => {
        // Skip if this happens to be a known raw string
        if (RAW_GATE_REJECTION_STRINGS.includes(arbitraryString)) {
          return true; // Property trivially holds, nothing to test
        }

        const normalized = normalizeGateRejection(arbitraryString);
        expect(normalized).toBe('unknown_gate_reason');

        return true;
      }),
      { numRuns: 200 },
    );
  });

  /**
   * P4-f: getGateRejectionKeys returns exactly the 8 expected normalized keys.
   */
  it('P4-f: getGateRejectionKeys returns all 8 normalized keys', () => {
    const keys = getGateRejectionKeys();

    expect(keys).toHaveLength(8);

    for (const expectedKey of NORMALIZED_GATE_KEYS) {
      expect(keys).toContain(expectedKey);
    }

    // No extra keys beyond the expected 8
    for (const key of keys) {
      expect(NORMALIZED_GATE_KEYS).toContain(key);
    }
  });

  /**
   * P4-g: Batch normalization preserves input order and is consistent with single normalization.
   */
  it('P4-g: batch normalization is consistent with single normalization', () => {
    fc.assert(
      fc.property(arbRawRejectionArray, (rawReasons) => {
        const batch = normalizeGateRejections(rawReasons);
        const individual = rawReasons.map(normalizeGateRejection);

        // Batch and individual should produce identical results
        expect(batch).toEqual(individual);

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P4-h: Unique input raw reasons produce unique output normalized keys.
   */
  it('P4-h: unique raw reasons produce unique normalized keys', () => {
    fc.assert(
      fc.property(arbUniqueRawRejections, (uniqueRawReasons) => {
        const normalized = normalizeGateRejections(uniqueRawReasons);
        const uniqueNormalized = new Set(normalized);

        // Since input was unique and all are known strings, output should be unique
        expect(uniqueNormalized.size).toBe(uniqueRawReasons.length);

        return true;
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P4-i: Each normalized key maps from exactly one raw string (inverse mapping).
   */
  it('P4-i: normalized keys have exactly one source raw string', () => {
    // Build reverse mapping: normalized key → raw strings that map to it
    const reverseMap = new Map<string, string[]>();

    for (const raw of RAW_GATE_REJECTION_STRINGS) {
      const normalized = normalizeGateRejection(raw);
      const existing = reverseMap.get(normalized) ?? [];
      existing.push(raw);
      reverseMap.set(normalized, existing);
    }

    // Each normalized key should have exactly one source
    for (const [normalizedKey, sources] of reverseMap) {
      expect(sources).toHaveLength(1);
    }
  });
});

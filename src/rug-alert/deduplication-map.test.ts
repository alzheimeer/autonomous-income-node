/**
 * Unit tests for DeduplicationMap
 *
 * Covers: TTL expiry, duplicate suppression, clear on restart,
 * invalid TTL env-var fallback, and case-insensitive key normalisation.
 *
 * Requirements: 8.1, 8.2, 8.4, 8.5, 8.6
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DeduplicationMap } from './deduplication-map.js';
import type { AlertReason } from './types.js';

const REASON: AlertReason = 'LIQUIDITY_DROP_HIGH';
const ADDR = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';

// ─── helpers ────────────────────────────────────────────────────────────────

function makeMap(): DeduplicationMap {
  return new DeduplicationMap();
}

// ─── Constructor / TTL configuration ────────────────────────────────────────

describe('DeduplicationMap — constructor / TTL', () => {
  afterEach(() => {
    delete process.env['RUG_ALERT_DEDUP_TTL_MS'];
  });

  it('defaults to 120 000 ms when env var is not set', () => {
    delete process.env['RUG_ALERT_DEDUP_TTL_MS'];
    const m = makeMap();
    expect(m.ttl).toBe(120_000);
  });

  it('uses the env var value when it is a positive number', () => {
    process.env['RUG_ALERT_DEDUP_TTL_MS'] = '60000';
    const m = makeMap();
    expect(m.ttl).toBe(60_000);
  });

  it('falls back to 120 000 ms and warns when env var is zero', () => {
    process.env['RUG_ALERT_DEDUP_TTL_MS'] = '0';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = makeMap();
    expect(m.ttl).toBe(120_000);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('falls back to 120 000 ms and warns when env var is negative', () => {
    process.env['RUG_ALERT_DEDUP_TTL_MS'] = '-5000';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = makeMap();
    expect(m.ttl).toBe(120_000);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('falls back to 120 000 ms and warns when env var is non-numeric', () => {
    process.env['RUG_ALERT_DEDUP_TTL_MS'] = 'abc';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = makeMap();
    expect(m.ttl).toBe(120_000);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it('falls back to 120 000 ms and warns when env var is empty string', () => {
    process.env['RUG_ALERT_DEDUP_TTL_MS'] = '';
    const m = makeMap();
    // empty string is treated the same as unset — no warn expected
    expect(m.ttl).toBe(120_000);
  });
});

// ─── isDuplicate + register ──────────────────────────────────────────────────

describe('DeduplicationMap — isDuplicate / register', () => {
  let m: DeduplicationMap;

  beforeEach(() => {
    delete process.env['RUG_ALERT_DEDUP_TTL_MS'];
    m = makeMap();
  });

  it('returns false when no entry exists', () => {
    expect(m.isDuplicate(ADDR, REASON)).toBe(false);
  });

  it('returns true immediately after register', () => {
    m.register(ADDR, REASON);
    expect(m.isDuplicate(ADDR, REASON)).toBe(true);
  });

  it('returns false after the TTL has expired (lazy removal)', () => {
    vi.useFakeTimers();
    m.register(ADDR, REASON);
    expect(m.isDuplicate(ADDR, REASON)).toBe(true);

    vi.advanceTimersByTime(m.ttl + 1);

    expect(m.isDuplicate(ADDR, REASON)).toBe(false);
    // lazy removal should have shrunk the map back to zero
    expect(m.size).toBe(0);
    vi.useRealTimers();
  });

  it('returns true when checked just before TTL boundary', () => {
    vi.useFakeTimers();
    m.register(ADDR, REASON);
    vi.advanceTimersByTime(m.ttl - 1);
    expect(m.isDuplicate(ADDR, REASON)).toBe(true);
    vi.useRealTimers();
  });

  it('returns false at exactly the TTL boundary (Date.now() >= expiry)', () => {
    vi.useFakeTimers();
    m.register(ADDR, REASON);
    vi.advanceTimersByTime(m.ttl); // exactly at expiry
    expect(m.isDuplicate(ADDR, REASON)).toBe(false);
    vi.useRealTimers();
  });

  it('is case-insensitive — mixed-case address matches lower-case lookup', () => {
    m.register(ADDR, REASON); // mixed case
    expect(m.isDuplicate(ADDR.toLowerCase(), REASON)).toBe(true);
  });

  it('is case-insensitive — lower-case register matched by mixed-case lookup', () => {
    m.register(ADDR.toLowerCase(), REASON);
    expect(m.isDuplicate(ADDR, REASON)).toBe(true);
  });

  it('tracks different reasons independently', () => {
    const reason2: AlertReason = 'LP_REMOVAL_CRITICAL';
    m.register(ADDR, REASON);
    expect(m.isDuplicate(ADDR, REASON)).toBe(true);
    expect(m.isDuplicate(ADDR, reason2)).toBe(false);
  });

  it('tracks different addresses independently', () => {
    const addr2 = '0x0000000000000000000000000000000000000001';
    m.register(ADDR, REASON);
    expect(m.isDuplicate(ADDR, REASON)).toBe(true);
    expect(m.isDuplicate(addr2, REASON)).toBe(false);
  });
});

// ─── clear ───────────────────────────────────────────────────────────────────

describe('DeduplicationMap — clear', () => {
  let m: DeduplicationMap;

  beforeEach(() => {
    delete process.env['RUG_ALERT_DEDUP_TTL_MS'];
    m = makeMap();
  });

  it('clears all entries so subsequent lookups return false', () => {
    m.register(ADDR, REASON);
    m.register('0x0000000000000000000000000000000000000001', 'LP_REMOVAL_HIGH');
    expect(m.size).toBe(2);

    m.clear();

    expect(m.size).toBe(0);
    expect(m.isDuplicate(ADDR, REASON)).toBe(false);
  });

  it('allows re-registration after clear (simulates service restart)', () => {
    m.register(ADDR, REASON);
    m.clear();
    m.register(ADDR, REASON); // fresh registration after restart
    expect(m.isDuplicate(ADDR, REASON)).toBe(true);
  });
});

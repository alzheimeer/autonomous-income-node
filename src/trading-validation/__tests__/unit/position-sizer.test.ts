/**
 * Unit tests for PositionSizer
 *
 * Tests position sizing formula, risk budget calculation, clamping logic,
 * invalid stop guard, confidence ignoring, and logging.
 *
 * Requirements: 26.1, 26.2, 26.3, 26.4, 26.5, E10
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PositionSizer, type SizingLogger } from '../../position-sizer.js';
import type { PositionSizerConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_CONFIG: PositionSizerConfig = {
  maxRiskPerTrade: 500_000n,     // $0.50
  maxRiskPctBankroll: 0.005,     // 0.5%
  minTradeSize: 5_000_000n,      // $5.00
  maxTradeSize: 10_000_000n,     // $10.00
  minStopFraction: 0.001,        // 0.1%
};

/** $25 active bankroll */
const BANKROLL_25 = 25_000_000n;

/** $100 active bankroll */
const BANKROLL_100 = 100_000_000n;

/** $200 active bankroll (0.5% = $1.00, so maxRiskPerTrade $0.50 applies) */
const BANKROLL_200 = 200_000_000n;

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('PositionSizer', () => {
  let sizer: PositionSizer;
  let logEntries: Parameters<SizingLogger>[0][];
  let logger: SizingLogger;

  beforeEach(() => {
    logEntries = [];
    logger = (entry) => { logEntries.push(entry); };
    sizer = new PositionSizer(DEFAULT_CONFIG, logger);
  });

  // ─── Invalid Stop Guard (E10) ───────────────────────────────────────

  describe('Invalid stop guard (E10)', () => {
    it('rejects zero stop distance', () => {
      const result = sizer.calculateSize(BANKROLL_25, 0);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_stop_distance');
      expect(result.sizeUsdc).toBe(0n);
    });

    it('rejects negative stop distance', () => {
      const result = sizer.calculateSize(BANKROLL_25, -0.05);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_stop_distance');
    });

    it('rejects NaN stop distance', () => {
      const result = sizer.calculateSize(BANKROLL_25, NaN);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_stop_distance');
    });

    it('rejects Infinity stop distance', () => {
      const result = sizer.calculateSize(BANKROLL_25, Infinity);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_stop_distance');
    });

    it('rejects -Infinity stop distance', () => {
      const result = sizer.calculateSize(BANKROLL_25, -Infinity);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_stop_distance');
    });

    it('rejects stop distance below minStopFraction (0.001)', () => {
      const result = sizer.calculateSize(BANKROLL_25, 0.0005);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('invalid_stop_distance');
    });

    it('accepts stop distance at exactly minStopFraction', () => {
      const result = sizer.calculateSize(BANKROLL_200, 0.001);
      // With $200 bankroll: risk = min($0.50, $1.00) = $0.50
      // size = $0.50 / 0.001 = $500, capped at $10
      expect(result.valid).toBe(true);
    });
  });

  // ─── Risk Budget Calculation (Req 26.2) ─────────────────────────────

  describe('Risk budget calculation (Req 26.2)', () => {
    it('uses percentage of bankroll when less than maxRiskPerTrade', () => {
      // $25 bankroll: 0.5% = $0.125 = 125000n (less than $0.50)
      const result = sizer.calculateSize(BANKROLL_25, 0.02);
      expect(result.riskBudget).toBe(125_000n);
    });

    it('uses maxRiskPerTrade when percentage exceeds it', () => {
      // $200 bankroll: 0.5% = $1.00, capped at $0.50
      const result = sizer.calculateSize(BANKROLL_200, 0.02);
      expect(result.riskBudget).toBe(500_000n);
    });

    it('uses percentage for $100 bankroll', () => {
      // $100 bankroll: 0.5% = $0.50 = 500000n (equal to max, so min picks either)
      const result = sizer.calculateSize(BANKROLL_100, 0.02);
      expect(result.riskBudget).toBe(500_000n);
    });
  });

  // ─── Trade Size Formula (Req 26.1) ──────────────────────────────────

  describe('Trade size formula (Req 26.1)', () => {
    it('calculates trade_size = risk_budget / stop_distance_fraction', () => {
      // $100 bankroll: risk = $0.50, stop = 0.05 (5%)
      // size = $0.50 / 0.05 = $10.00
      const result = sizer.calculateSize(BANKROLL_100, 0.05);
      expect(result.rawSize).toBe(10_000_000n);
      expect(result.sizeUsdc).toBe(10_000_000n);
      expect(result.valid).toBe(true);
    });

    it('calculates correctly with 2% stop distance', () => {
      // $200 bankroll: risk = $0.50, stop = 0.02 (2%)
      // size = $0.50 / 0.02 = $25.00
      const result = sizer.calculateSize(BANKROLL_200, 0.02);
      expect(result.rawSize).toBe(25_000_000n);
      // Capped at $10
      expect(result.sizeUsdc).toBe(10_000_000n);
    });

    it('calculates correctly with 10% stop distance', () => {
      // $200 bankroll: risk = $0.50, stop = 0.10 (10%)
      // size = $0.50 / 0.10 = $5.00
      const result = sizer.calculateSize(BANKROLL_200, 0.10);
      expect(result.rawSize).toBe(5_000_000n);
      expect(result.sizeUsdc).toBe(5_000_000n);
      expect(result.valid).toBe(true);
    });
  });

  // ─── Clamping (Req 26.3) ────────────────────────────────────────────

  describe('Clamping (Req 26.3)', () => {
    it('skips if raw size < $5 (minTradeSize)', () => {
      // $25 bankroll: risk = $0.125, stop = 0.05 (5%)
      // size = $0.125 / 0.05 = $2.50 → below $5
      const result = sizer.calculateSize(BANKROLL_25, 0.05);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('below_minimum_trade_size');
      expect(result.rawSize).toBe(2_500_000n);
      expect(result.sizeUsdc).toBe(0n);
    });

    it('caps at $10 (maxTradeSize) if exceeds', () => {
      // $200 bankroll: risk = $0.50, stop = 0.02 (2%)
      // size = $0.50 / 0.02 = $25.00 → capped at $10
      const result = sizer.calculateSize(BANKROLL_200, 0.02);
      expect(result.valid).toBe(true);
      expect(result.sizeUsdc).toBe(10_000_000n);
      expect(result.rawSize).toBe(25_000_000n);
    });

    it('does not clamp when within range', () => {
      // $200 bankroll: risk = $0.50, stop = 0.10 (10%)
      // size = $0.50 / 0.10 = $5.00 → within [$5, $10]
      const result = sizer.calculateSize(BANKROLL_200, 0.10);
      expect(result.valid).toBe(true);
      expect(result.sizeUsdc).toBe(result.rawSize);
    });

    it('accepts exact minimum trade size', () => {
      // $200 bankroll: risk = $0.50, stop = 0.10
      // size = $0.50 / 0.10 = $5.00 exactly
      const result = sizer.calculateSize(BANKROLL_200, 0.10);
      expect(result.valid).toBe(true);
      expect(result.sizeUsdc).toBe(5_000_000n);
    });
  });

  // ─── Confidence Ignored (Req 26.4) ──────────────────────────────────

  describe('Confidence does NOT affect size (Req 26.4)', () => {
    it('produces same size regardless of confidence value', () => {
      const result1 = sizer.calculateSize(BANKROLL_100, 0.05, 0.3);
      const result2 = sizer.calculateSize(BANKROLL_100, 0.05, 0.9);
      const result3 = sizer.calculateSize(BANKROLL_100, 0.05, 1.0);
      const result4 = sizer.calculateSize(BANKROLL_100, 0.05, undefined);

      expect(result1.sizeUsdc).toBe(result2.sizeUsdc);
      expect(result2.sizeUsdc).toBe(result3.sizeUsdc);
      expect(result3.sizeUsdc).toBe(result4.sizeUsdc);
    });

    it('produces same risk budget regardless of confidence', () => {
      const result1 = sizer.calculateSize(BANKROLL_200, 0.03, 0.1);
      const result2 = sizer.calculateSize(BANKROLL_200, 0.03, 0.99);

      expect(result1.riskBudget).toBe(result2.riskBudget);
      expect(result1.rawSize).toBe(result2.rawSize);
    });
  });

  // ─── Logging (Req 26.5) ─────────────────────────────────────────────

  describe('Logging (Req 26.5)', () => {
    it('logs stop distance, risk budget, raw size, and clamped size', () => {
      sizer.calculateSize(BANKROLL_200, 0.05);

      expect(logEntries).toHaveLength(1);
      const entry = logEntries[0];
      expect(entry.stopDistanceFraction).toBe(0.05);
      expect(entry.riskBudget).toBeDefined();
      expect(entry.rawSize).toBeDefined();
      expect(entry.clampedSize).toBeDefined();
      expect(entry.valid).toBe(true);
    });

    it('logs reason on rejection', () => {
      sizer.calculateSize(BANKROLL_25, NaN);

      expect(logEntries).toHaveLength(1);
      expect(logEntries[0].valid).toBe(false);
      expect(logEntries[0].reason).toBe('invalid_stop_distance');
    });

    it('logs on every call including failures', () => {
      sizer.calculateSize(BANKROLL_25, 0.05); // below min
      sizer.calculateSize(BANKROLL_200, 0.05); // valid
      sizer.calculateSize(BANKROLL_25, -1);   // invalid stop

      expect(logEntries).toHaveLength(3);
    });

    it('works without a logger', () => {
      const noLogSizer = new PositionSizer(DEFAULT_CONFIG);
      // Should not throw
      const result = noLogSizer.calculateSize(BANKROLL_100, 0.05);
      expect(result.valid).toBe(true);
    });
  });

  // ─── Edge Cases ─────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('handles very small bankroll (below meaningful risk)', () => {
      // $1 bankroll: risk = 0.5% of $1 = $0.005 = 5000n
      // stop = 0.02: size = 5000 / 0.02 = $0.25 → below $5
      const result = sizer.calculateSize(1_000_000n, 0.02);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('below_minimum_trade_size');
    });

    it('handles zero bankroll', () => {
      const result = sizer.calculateSize(0n, 0.05);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('below_minimum_trade_size');
      expect(result.riskBudget).toBe(0n);
    });

    it('handles very large stop distance (fraction close to 1)', () => {
      // $200 bankroll: risk = $0.50, stop = 0.50 (50%)
      // size = $0.50 / 0.50 = $1.00 → below $5
      const result = sizer.calculateSize(BANKROLL_200, 0.50);
      expect(result.valid).toBe(false);
      expect(result.reason).toBe('below_minimum_trade_size');
    });

    it('handles stop distance at boundary producing exactly $5', () => {
      // $200 bankroll: risk = $0.50, stop = 0.10 (10%)
      // size = $0.50 / 0.10 = $5.00 exactly
      const result = sizer.calculateSize(BANKROLL_200, 0.10);
      expect(result.valid).toBe(true);
      expect(result.sizeUsdc).toBe(5_000_000n);
    });

    it('handles stop distance producing exactly $10', () => {
      // $200 bankroll: risk = $0.50, stop = 0.05 (5%)
      // size = $0.50 / 0.05 = $10.00 exactly
      const result = sizer.calculateSize(BANKROLL_200, 0.05);
      expect(result.valid).toBe(true);
      expect(result.sizeUsdc).toBe(10_000_000n);
    });
  });
});

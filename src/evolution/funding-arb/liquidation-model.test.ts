/**
 * Liquidation Model — Unit Tests
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { describe, it, expect } from 'vitest';
import { LiquidationModel } from './liquidation-model.js';

const BPS_DIVISOR = 10_000n;

describe('LiquidationModel', () => {
  const model = new LiquidationModel();

  describe('computeMarginState', () => {
    it('returns safe defaults when positionValue is 0n', () => {
      const state = model.computeMarginState(1_000_000n, 0n);
      expect(state.marginRatio).toBe(BPS_DIVISOR);
      expect(state.isStressed).toBe(false);
      expect(state.isLiquidated).toBe(false);
    });

    it('computes correct margin ratio (equity = 10% of position)', () => {
      // 10% margin → 1000 bps
      const equity = 100_000_000n;   // $100
      const positionValue = 1_000_000_000n; // $1000
      const state = model.computeMarginState(equity, positionValue);
      expect(state.marginRatio).toBe(1000n);
      expect(state.isStressed).toBe(false); // 1000 is NOT < 1000
      expect(state.isLiquidated).toBe(false);
    });

    it('detects stress when margin ratio is below 10% but above 6%', () => {
      // 9% margin → 900 bps
      const equity = 90_000_000n;    // $90
      const positionValue = 1_000_000_000n; // $1000
      const state = model.computeMarginState(equity, positionValue);
      expect(state.marginRatio).toBe(900n);
      expect(state.isStressed).toBe(true);
      expect(state.isLiquidated).toBe(false);
    });

    it('detects liquidation when margin ratio is below 6%', () => {
      // 5% margin → 500 bps
      const equity = 50_000_000n;    // $50
      const positionValue = 1_000_000_000n; // $1000
      const state = model.computeMarginState(equity, positionValue);
      expect(state.marginRatio).toBe(500n);
      expect(state.isStressed).toBe(true); // also stressed
      expect(state.isLiquidated).toBe(true);
    });

    it('returns not stressed and not liquidated for healthy margin', () => {
      // 50% margin → 5000 bps
      const equity = 500_000_000n;   // $500
      const positionValue = 1_000_000_000n; // $1000
      const state = model.computeMarginState(equity, positionValue);
      expect(state.marginRatio).toBe(5000n);
      expect(state.isStressed).toBe(false);
      expect(state.isLiquidated).toBe(false);
    });

    it('exactly at 600 bps is NOT liquidated', () => {
      // 6% margin → 600 bps
      const equity = 60_000_000n;    // $60
      const positionValue = 1_000_000_000n; // $1000
      const state = model.computeMarginState(equity, positionValue);
      expect(state.marginRatio).toBe(600n);
      expect(state.isLiquidated).toBe(false);
      expect(state.isStressed).toBe(true); // 600 < 1000
    });

    it('exactly at 1000 bps is NOT stressed', () => {
      // 10% margin → 1000 bps
      const equity = 100_000_000n;
      const positionValue = 1_000_000_000n;
      const state = model.computeMarginState(equity, positionValue);
      expect(state.marginRatio).toBe(1000n);
      expect(state.isStressed).toBe(false);
      expect(state.isLiquidated).toBe(false);
    });
  });

  describe('wouldLiquidate', () => {
    it('returns false when positionValue is 0n', () => {
      expect(model.wouldLiquidate(1_000_000n, 0n, 500n)).toBe(false);
    });

    it('returns false when move does not breach maintenance margin', () => {
      // equity = $100, position = $1000, margin = 1000 bps
      // move of 300 bps → loss = 300 * 1000 / 10000 = $30
      // new equity = $70, new ratio = 700 bps ≥ 600 → no liquidation
      const equity = 100_000_000n;
      const positionValue = 1_000_000_000n;
      expect(model.wouldLiquidate(equity, positionValue, 300n)).toBe(false);
    });

    it('returns true when move breaches maintenance margin', () => {
      // equity = $100, position = $1000, margin = 1000 bps
      // move of 500 bps → loss = 500 * 1000 / 10000 = $50
      // new equity = $50, new ratio = 500 bps < 600 → liquidation
      const equity = 100_000_000n;
      const positionValue = 1_000_000_000n;
      expect(model.wouldLiquidate(equity, positionValue, 500n)).toBe(true);
    });

    it('returns true when equity goes to zero or negative', () => {
      const equity = 100_000_000n;
      const positionValue = 1_000_000_000n;
      // move of 10_000 bps → loss = 10000 * 1000 / 10000 = $1000 > equity
      expect(model.wouldLiquidate(equity, positionValue, 10_000n)).toBe(true);
    });

    it('returns true at exactly the boundary move + 1 bps', () => {
      // margin ratio = 1000 bps, maintenance = 600, max move = 400
      // move of 401 → loss = 401 * 1000 / 10000 = $40.1 → equity = $59.9
      // ratio = 59_900_000 * 10000 / 1_000_000_000 = 599 < 600 → liquidation
      const equity = 100_000_000n;
      const positionValue = 1_000_000_000n;
      expect(model.wouldLiquidate(equity, positionValue, 401n)).toBe(true);
    });
  });

  describe('maxAdverseMoveBps', () => {
    it('returns BPS_DIVISOR when positionValue is 0n', () => {
      expect(model.maxAdverseMoveBps(1_000_000n, 0n)).toBe(BPS_DIVISOR);
    });

    it('returns margin_ratio - 600 for healthy position', () => {
      // equity = $100, position = $1000, margin = 1000 bps
      // max move = 1000 - 600 = 400 bps
      const equity = 100_000_000n;
      const positionValue = 1_000_000_000n;
      expect(model.maxAdverseMoveBps(equity, positionValue)).toBe(400n);
    });

    it('returns 0n when already at maintenance margin', () => {
      // equity = $60, position = $1000, margin = 600 bps
      const equity = 60_000_000n;
      const positionValue = 1_000_000_000n;
      expect(model.maxAdverseMoveBps(equity, positionValue)).toBe(0n);
    });

    it('returns 0n when already below maintenance margin', () => {
      // equity = $50, position = $1000, margin = 500 bps
      const equity = 50_000_000n;
      const positionValue = 1_000_000_000n;
      expect(model.maxAdverseMoveBps(equity, positionValue)).toBe(0n);
    });

    it('returns large value for well-collateralized position', () => {
      // equity = $500, position = $1000, margin = 5000 bps
      // max move = 5000 - 600 = 4400 bps
      const equity = 500_000_000n;
      const positionValue = 1_000_000_000n;
      expect(model.maxAdverseMoveBps(equity, positionValue)).toBe(4400n);
    });
  });

  describe('computePenalty', () => {
    it('returns 0n when positionValue is 0n', () => {
      expect(model.computePenalty(0n)).toBe(0n);
    });

    it('computes 0.5% penalty correctly', () => {
      // penalty = 1000 * 50 / 10000 = $5
      const positionValue = 1_000_000_000n; // $1000
      expect(model.computePenalty(positionValue)).toBe(5_000_000n); // $5
    });

    it('computes penalty for small position', () => {
      // penalty = 100 * 50 / 10000 = $0.5
      const positionValue = 100_000_000n; // $100
      expect(model.computePenalty(positionValue)).toBe(500_000n); // $0.50
    });

    it('truncates for non-evenly-divisible amounts', () => {
      // 33 * 50 / 10000 = 1650 / 10000 = 0 (BigInt truncation)
      // But with 6 decimals: 33_000_000 * 50 / 10_000 = 165_000
      const positionValue = 33_000_000n; // $33
      expect(model.computePenalty(positionValue)).toBe(165_000n); // $0.165
    });
  });
});

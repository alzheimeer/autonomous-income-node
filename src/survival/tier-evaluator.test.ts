/**
 * Unit tests for TierEvaluator and CapabilityGates
 *
 * Validates: Requirements 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 6.8, 8.7, 9.1, 10.1
 */

import { describe, it, expect } from 'vitest';
import {
  SurvivalTier,
  TierThresholds,
  TIER_THRESHOLDS,
  evaluateTier,
  getCapabilityGates,
} from './tier-evaluator.js';

// ---------------------------------------------------------------------------
// evaluateTier – boundary tests
// ---------------------------------------------------------------------------

describe('evaluateTier', () => {
  describe('EMERGENCY tier ($0)', () => {
    it('returns EMERGENCY for balance = 0n', () => {
      expect(evaluateTier(0n)).toBe(SurvivalTier.EMERGENCY);
    });

    it('treats negative balance as EMERGENCY', () => {
      expect(evaluateTier(-1n)).toBe(SurvivalTier.EMERGENCY);
    });
  });

  describe('TIER_1 (< $10 USDC, ≥ $0.000001)', () => {
    it('returns TIER_1 for the minimum non-zero balance (1n)', () => {
      expect(evaluateTier(1n)).toBe(SurvivalTier.TIER_1);
    });

    it('returns TIER_1 for $1 USDC (1_000000n)', () => {
      expect(evaluateTier(1_000000n)).toBe(SurvivalTier.TIER_1);
    });

    it('returns TIER_1 for just below $10 (9_999999n)', () => {
      expect(evaluateTier(9_999999n)).toBe(SurvivalTier.TIER_1);
    });
  });

  describe('TIER_2 ($10–$99 USDC)', () => {
    it('returns TIER_2 exactly at $10 (10_000000n)', () => {
      expect(evaluateTier(10_000000n)).toBe(SurvivalTier.TIER_2);
    });

    it('returns TIER_2 at $50 USDC', () => {
      expect(evaluateTier(50_000000n)).toBe(SurvivalTier.TIER_2);
    });

    it('returns TIER_2 at just below $90 (89_999999n)', () => {
      expect(evaluateTier(89_999999n)).toBe(SurvivalTier.TIER_2);
    });
  });

  describe('TIER_3 ($90–$999 USDC)', () => {
    it('returns TIER_3 exactly at $90 (90_000000n)', () => {
      expect(evaluateTier(90_000000n)).toBe(SurvivalTier.TIER_3);
    });

    it('returns TIER_3 at $500 USDC', () => {
      expect(evaluateTier(500_000000n)).toBe(SurvivalTier.TIER_3);
    });

    it('returns TIER_3 just below $1000 (999_999999n)', () => {
      expect(evaluateTier(999_999999n)).toBe(SurvivalTier.TIER_3);
    });
  });

  describe('TIER_4 (≥ $1000 USDC)', () => {
    it('returns TIER_4 exactly at $1000 (1000_000000n)', () => {
      expect(evaluateTier(1000_000000n)).toBe(SurvivalTier.TIER_4);
    });

    it('returns TIER_4 at $10,000 USDC', () => {
      expect(evaluateTier(10000_000000n)).toBe(SurvivalTier.TIER_4);
    });
  });

  describe('threshold constants', () => {
    it('TIER_4_MIN equals 1000_000000n', () => {
      expect(TierThresholds.TIER_4_MIN).toBe(1000_000000n);
    });

    it('TIER_3_MIN equals 90_000000n', () => {
      expect(TierThresholds.TIER_3_MIN).toBe(90_000000n);
    });

    it('TIER_2_MIN equals 10_000000n', () => {
      expect(TierThresholds.TIER_2_MIN).toBe(10_000000n);
    });

    it('TIER_1_MIN equals 1n', () => {
      expect(TierThresholds.TIER_1_MIN).toBe(1n);
    });

    it('EMERGENCY equals 0n', () => {
      expect(TierThresholds.EMERGENCY).toBe(0n);
    });

    it('TIER_THRESHOLDS is the canonical export (same values)', () => {
      expect(TIER_THRESHOLDS.TIER_4_MIN).toBe(1000_000000n);
      expect(TIER_THRESHOLDS.TIER_3_MIN).toBe(90_000000n);
      expect(TIER_THRESHOLDS.TIER_2_MIN).toBe(10_000000n);
      expect(TIER_THRESHOLDS.TIER_1_MIN).toBe(1n);
      expect(TIER_THRESHOLDS.EMERGENCY).toBe(0n);
    });
  });
});

// ---------------------------------------------------------------------------
// getCapabilityGates – capability matrix tests
// ---------------------------------------------------------------------------

describe('getCapabilityGates', () => {
  describe('EMERGENCY gates', () => {
    const gates = getCapabilityGates(SurvivalTier.EMERGENCY);

    it('trading is disabled', () => expect(gates.tradingEnabled).toBe(false));
    it('maxActiveStrategies = 0', () => expect(gates.maxActiveStrategies).toBe(0));
    it('selfMod is disabled', () => expect(gates.selfModEnabled).toBe(false));
    it('replication is disabled', () => expect(gates.replicationEnabled).toBe(false));
    it('llmBudgetMultiplier = 0.0', () => expect(gates.llmBudgetMultiplier).toBe(0.0));
    it('socialPosting is disabled', () => expect(gates.socialPostingEnabled).toBe(false));
    it('maxTradeSize = 0n', () => expect(gates.maxTradeSize).toBe(0n));
  });

  describe('TIER_1 gates', () => {
    const gates = getCapabilityGates(SurvivalTier.TIER_1);

    it('trading is enabled', () => expect(gates.tradingEnabled).toBe(true));
    it('maxActiveStrategies = 1', () => expect(gates.maxActiveStrategies).toBe(1));
    it('selfMod is disabled', () => expect(gates.selfModEnabled).toBe(false));
    it('replication is disabled', () => expect(gates.replicationEnabled).toBe(false));
    it('llmBudgetMultiplier = 0.4', () => expect(gates.llmBudgetMultiplier).toBe(0.4));
    it('socialPosting is disabled', () => expect(gates.socialPostingEnabled).toBe(false));
    it('maxTradeSize = 5_000000n ($5 USDC)', () => expect(gates.maxTradeSize).toBe(5_000000n));
  });

  describe('TIER_2 gates', () => {
    const gates = getCapabilityGates(SurvivalTier.TIER_2);

    it('trading is enabled', () => expect(gates.tradingEnabled).toBe(true));
    it('maxActiveStrategies = 2', () => expect(gates.maxActiveStrategies).toBe(2));
    it('selfMod is disabled', () => expect(gates.selfModEnabled).toBe(false));
    it('replication is disabled', () => expect(gates.replicationEnabled).toBe(false));
    it('llmBudgetMultiplier = 0.4', () => expect(gates.llmBudgetMultiplier).toBe(0.4));
    it('socialPosting is enabled', () => expect(gates.socialPostingEnabled).toBe(true));
    it('maxTradeSize = 5_000000n ($5 USDC)', () => expect(gates.maxTradeSize).toBe(5_000000n));
  });

  describe('TIER_3 gates', () => {
    const gates = getCapabilityGates(SurvivalTier.TIER_3);

    it('trading is enabled', () => expect(gates.tradingEnabled).toBe(true));
    it('maxActiveStrategies = 99', () =>
      expect(gates.maxActiveStrategies).toBe(99));
    it('selfMod is enabled', () => expect(gates.selfModEnabled).toBe(true));
    it('replication is disabled', () => expect(gates.replicationEnabled).toBe(false));
    it('llmBudgetMultiplier = 0.7', () => expect(gates.llmBudgetMultiplier).toBe(0.7));
    it('socialPosting is enabled', () => expect(gates.socialPostingEnabled).toBe(true));
    it('maxTradeSize is effectively unlimited (> 0n)', () =>
      expect(gates.maxTradeSize > 0n).toBe(true));
  });

  describe('TIER_4 gates', () => {
    const gates = getCapabilityGates(SurvivalTier.TIER_4);

    it('trading is enabled', () => expect(gates.tradingEnabled).toBe(true));
    it('maxActiveStrategies = 99', () =>
      expect(gates.maxActiveStrategies).toBe(99));
    it('selfMod is enabled', () => expect(gates.selfModEnabled).toBe(true));
    it('replication is enabled', () => expect(gates.replicationEnabled).toBe(true));
    it('llmBudgetMultiplier = 1.0', () => expect(gates.llmBudgetMultiplier).toBe(1.0));
    it('socialPosting is enabled', () => expect(gates.socialPostingEnabled).toBe(true));
    it('maxTradeSize is effectively unlimited (> 0n)', () =>
      expect(gates.maxTradeSize > 0n).toBe(true));
  });

  describe('gates are frozen (immutable)', () => {
    it('EMERGENCY gates object is frozen', () => {
      expect(Object.isFrozen(getCapabilityGates(SurvivalTier.EMERGENCY))).toBe(true);
    });

    it('TIER_4 gates object is frozen', () => {
      expect(Object.isFrozen(getCapabilityGates(SurvivalTier.TIER_4))).toBe(true);
    });
  });

  describe('tier-ordered monotonicity', () => {
    const tiers = [
      SurvivalTier.EMERGENCY,
      SurvivalTier.TIER_1,
      SurvivalTier.TIER_2,
      SurvivalTier.TIER_3,
      SurvivalTier.TIER_4,
    ];

    it('llmBudgetMultiplier is non-decreasing as tier increases', () => {
      const budgets = tiers.map(t => getCapabilityGates(t).llmBudgetMultiplier);
      for (let i = 1; i < budgets.length; i++) {
        expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1]!);
      }
    });

    it('maxActiveStrategies is non-decreasing as tier increases', () => {
      const strategies = tiers.map(t => getCapabilityGates(t).maxActiveStrategies);
      for (let i = 1; i < strategies.length; i++) {
        expect(strategies[i]!).toBeGreaterThanOrEqual(strategies[i - 1]!);
      }
    });

    it('replication only enabled at TIER_4', () => {
      const replication = tiers.map(t => getCapabilityGates(t).replicationEnabled);
      expect(replication).toEqual([false, false, false, false, true]);
    });

    it('selfMod enabled from TIER_3 onwards', () => {
      const selfMod = tiers.map(t => getCapabilityGates(t).selfModEnabled);
      expect(selfMod).toEqual([false, false, false, true, true]);
    });

    it('socialPosting enabled from TIER_2 onwards', () => {
      const social = tiers.map(t => getCapabilityGates(t).socialPostingEnabled);
      expect(social).toEqual([false, false, true, true, true]);
    });
  });

  describe('combined evaluateTier + getCapabilityGates integration', () => {
    it('$0 balance → emergency gates (no trading)', () => {
      const gates = getCapabilityGates(evaluateTier(0n));
      expect(gates.tradingEnabled).toBe(false);
      expect(gates.llmBudgetMultiplier).toBe(0.0);
    });

    it('$5 USDC balance → Tier 1 gates (1 strategy, $5 trade limit)', () => {
      const gates = getCapabilityGates(evaluateTier(5_000000n));
      expect(gates.tradingEnabled).toBe(true);
      expect(gates.maxActiveStrategies).toBe(1);
      expect(gates.maxTradeSize).toBe(5_000000n);
    });

    it('$50 USDC balance → Tier 2 gates (2 strategies, social enabled)', () => {
      const gates = getCapabilityGates(evaluateTier(50_000000n));
      expect(gates.maxActiveStrategies).toBe(2);
      expect(gates.socialPostingEnabled).toBe(true);
      expect(gates.selfModEnabled).toBe(false);
    });

    it('$500 USDC balance → Tier 3 gates (selfMod enabled, no replication)', () => {
      const gates = getCapabilityGates(evaluateTier(500_000000n));
      expect(gates.selfModEnabled).toBe(true);
      expect(gates.replicationEnabled).toBe(false);
      expect(gates.llmBudgetMultiplier).toBe(0.7);
    });

    it('$1000 USDC balance → Tier 4 gates (full capabilities)', () => {
      const gates = getCapabilityGates(evaluateTier(1000_000000n));
      expect(gates.selfModEnabled).toBe(true);
      expect(gates.replicationEnabled).toBe(true);
      expect(gates.llmBudgetMultiplier).toBe(1.0);
    });
  });
});

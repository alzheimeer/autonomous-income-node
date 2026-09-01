/**
 * SmartMoneyCurator — Property-Based Tests: Wallet Exclusion Filters
 *
 * Property-based tests for SmartMoneyCurator exclusion filters using Vitest + fast-check.
 *
 * **Property 2: Wallet Exclusion Filters Enforcement**
 * For any wallet under evaluation, SmartMoneyCurator SHALL exclude the wallet
 * if ANY of the following conditions are met:
 * - same_block_trade_pct > 50% (MEV bot indicator)
 * - has_deployed_tokens_180d = true
 * - honeypot_exposure_pct > 20%
 * - received_deployer_airdrop = true
 * - same_counterparty_trade_pct > 30% (wash trading indicator)
 *
 * **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  SmartMoneyCurator,
  DEFAULT_EXCLUSION_FILTERS,
  type WalletExclusionMetrics,
} from '../modules/SmartMoneyCurator.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants - Exclusion Thresholds (from Requirements)
// ═══════════════════════════════════════════════════════════════════════════

/** Max same-block trade percentage (Req 1.7) - above this = MEV bot */
const MAX_SAME_BLOCK_TRADE_PCT = 0.50;

/** Max honeypot exposure percentage (Req 1.9) - above this = risky wallet */
const MAX_HONEYPOT_EXPOSURE_PCT = 0.20;

/** Max same-counterparty percentage (Req 1.11) - above this = wash trading */
const MAX_SAME_COUNTERPARTY_PCT = 0.30;

// ═══════════════════════════════════════════════════════════════════════════
// Generators for Property-Based Testing
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a percentage ABOVE the MEV threshold (>50%)
 * Using integer conversion to avoid floating point precision issues
 */
const mevTriggeringPct = fc.integer({ min: 51, max: 100 }).map(n => n / 100);

/**
 * Generate a percentage AT OR BELOW the MEV threshold (≤50%)
 */
const mevSafePct = fc.integer({ min: 0, max: 50 }).map(n => n / 100);

/**
 * Generate a percentage ABOVE the honeypot threshold (>20%)
 */
const honeypotTriggeringPct = fc.integer({ min: 21, max: 100 }).map(n => n / 100);

/**
 * Generate a percentage AT OR BELOW the honeypot threshold (≤20%)
 */
const honeypotSafePct = fc.integer({ min: 0, max: 20 }).map(n => n / 100);

/**
 * Generate a percentage ABOVE the wash trading threshold (>30%)
 */
const washTradingTriggeringPct = fc.integer({ min: 31, max: 100 }).map(n => n / 100);

/**
 * Generate a percentage AT OR BELOW the wash trading threshold (≤30%)
 */
const washTradingSafePct = fc.integer({ min: 0, max: 30 }).map(n => n / 100);

/**
 * Generate clean exclusion metrics (no flags triggered)
 * All percentages are safely below their thresholds
 */
const cleanExclusionMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: mevSafePct,
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: honeypotSafePct,
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: washTradingSafePct,
});

/**
 * Generate metrics where ONLY the MEV flag is triggered (Req 1.7)
 */
const mevBotMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: mevTriggeringPct,
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: honeypotSafePct,
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: washTradingSafePct,
});

/**
 * Generate metrics where ONLY the token deployer flag is triggered (Req 1.8)
 */
const tokenDeployerMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: mevSafePct,
  hasDeployedTokensRecently: fc.constant(true),
  honeypotExposurePct: honeypotSafePct,
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: washTradingSafePct,
});

/**
 * Generate metrics where ONLY the honeypot exposure flag is triggered (Req 1.9)
 */
const honeypotExposureMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: mevSafePct,
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: honeypotTriggeringPct,
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: washTradingSafePct,
});

/**
 * Generate metrics where ONLY the deployer airdrop flag is triggered (Req 1.10)
 */
const deployerAirdropMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: mevSafePct,
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: honeypotSafePct,
  receivedDeployerAirdrop: fc.constant(true),
  sameCounterpartyPct: washTradingSafePct,
});

/**
 * Generate metrics where ONLY the wash trading flag is triggered (Req 1.11)
 */
const washTradingMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: mevSafePct,
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: honeypotSafePct,
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: washTradingTriggeringPct,
});

/**
 * Generate metrics where MULTIPLE flags are triggered
 */
const multipleExclusionMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: fc.oneof(mevTriggeringPct, mevSafePct),
  hasDeployedTokensRecently: fc.boolean(),
  honeypotExposurePct: fc.oneof(honeypotTriggeringPct, honeypotSafePct),
  receivedDeployerAirdrop: fc.boolean(),
  sameCounterpartyPct: fc.oneof(washTradingTriggeringPct, washTradingSafePct),
}).filter(m => {
  // Ensure at least 2 flags are triggered
  let count = 0;
  if (m.sameBlockTradePct > MAX_SAME_BLOCK_TRADE_PCT) count++;
  if (m.hasDeployedTokensRecently) count++;
  if (m.honeypotExposurePct > MAX_HONEYPOT_EXPOSURE_PCT) count++;
  if (m.receivedDeployerAirdrop) count++;
  if (m.sameCounterpartyPct > MAX_SAME_COUNTERPARTY_PCT) count++;
  return count >= 2;
});

/**
 * Generate arbitrary exclusion metrics (may or may not trigger exclusions)
 */
const arbitraryExclusionMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: fc.integer({ min: 0, max: 100 }).map(n => n / 100),
  hasDeployedTokensRecently: fc.boolean(),
  honeypotExposurePct: fc.integer({ min: 0, max: 100 }).map(n => n / 100),
  receivedDeployerAirdrop: fc.boolean(),
  sameCounterpartyPct: fc.integer({ min: 0, max: 100 }).map(n => n / 100),
});

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Calculates expected exclusion based on metrics and thresholds
 */
function shouldBeExcluded(metrics: WalletExclusionMetrics): boolean {
  return (
    metrics.sameBlockTradePct > MAX_SAME_BLOCK_TRADE_PCT ||
    metrics.hasDeployedTokensRecently === true ||
    metrics.honeypotExposurePct > MAX_HONEYPOT_EXPOSURE_PCT ||
    metrics.receivedDeployerAirdrop === true ||
    metrics.sameCounterpartyPct > MAX_SAME_COUNTERPARTY_PCT
  );
}

/**
 * Returns which flags should be triggered
 */
function getExpectedTriggeredFilters(metrics: WalletExclusionMetrics): string[] {
  const triggered: string[] = [];
  if (metrics.sameBlockTradePct > MAX_SAME_BLOCK_TRADE_PCT) {
    triggered.push('sameBlockTrade');
  }
  if (metrics.hasDeployedTokensRecently) {
    triggered.push('tokenDeployer');
  }
  if (metrics.honeypotExposurePct > MAX_HONEYPOT_EXPOSURE_PCT) {
    triggered.push('honeypotExposure');
  }
  if (metrics.receivedDeployerAirdrop) {
    triggered.push('deployerRecipient');
  }
  if (metrics.sameCounterpartyPct > MAX_SAME_COUNTERPARTY_PCT) {
    triggered.push('sameCounterparty');
  }
  return triggered;
}

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('SmartMoneyCurator - Property 2: Wallet Exclusion Filters Enforcement', () => {
  
  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.1: Clean wallets pass all filters
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.1: Clean wallets pass all filters', () => {
    /**
     * **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**
     *
     * For any wallet where ALL metrics are within acceptable thresholds,
     * the wallet SHALL NOT be excluded.
     */
    it('does not exclude wallets with all metrics below thresholds', () => {
      fc.assert(
        fc.property(cleanExclusionMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          const result = curator.evaluateExclusionFiltersDetailed(metrics);

          // Should not be excluded
          expect(result.excluded).toBe(false);

          // No filters should be triggered
          expect(result.triggeredFilters).toHaveLength(0);

          // Verify each individual filter status
          expect(result.filters.sameBlockTrade.triggered).toBe(false);
          expect(result.filters.tokenDeployer.triggered).toBe(false);
          expect(result.filters.honeypotExposure.triggered).toBe(false);
          expect(result.filters.deployerRecipient.triggered).toBe(false);
          expect(result.filters.sameCounterparty.triggered).toBe(false);
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.2: MEV bot detection (Req 1.7)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.2: MEV Bot Detection (same_block_trade_pct > 50%)', () => {
    /**
     * **Validates: Requirement 1.7**
     *
     * THE Smart_Money_Curator SHALL exclude wallets with more than 50%
     * of trades in the same block as another trade (MEV bot indicator).
     */
    it('excludes wallets with same_block_trade_pct > 50%', () => {
      fc.assert(
        fc.property(mevBotMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          const result = curator.evaluateExclusionFiltersDetailed(metrics);

          // Should be excluded
          expect(result.excluded).toBe(true);

          // Specifically the sameBlockTrade filter should be triggered
          expect(result.filters.sameBlockTrade.triggered).toBe(true);
          expect(result.triggeredFilters).toContain('sameBlockTrade');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirement 1.7 (boundary)**
     *
     * Wallet at exactly 50% should NOT be excluded (threshold is >50%).
     */
    it('does not exclude wallets with same_block_trade_pct exactly at 50%', () => {
      const curator = new SmartMoneyCurator();
      const metrics: WalletExclusionMetrics = {
        sameBlockTradePct: 0.50, // Exactly at threshold
        hasDeployedTokensRecently: false,
        honeypotExposurePct: 0.10,
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: 0.10,
      };

      const result = curator.evaluateExclusionFiltersDetailed(metrics);
      expect(result.excluded).toBe(false);
      expect(result.filters.sameBlockTrade.triggered).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.3: Token deployer exclusion (Req 1.8)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.3: Token Deployer Exclusion (has_deployed_tokens_180d)', () => {
    /**
     * **Validates: Requirement 1.8**
     *
     * THE Smart_Money_Curator SHALL exclude wallets that have deployed
     * tokens in the last 180 days.
     */
    it('excludes wallets that have deployed tokens recently', () => {
      fc.assert(
        fc.property(tokenDeployerMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          const result = curator.evaluateExclusionFiltersDetailed(metrics);

          // Should be excluded
          expect(result.excluded).toBe(true);

          // Specifically the tokenDeployer filter should be triggered
          expect(result.filters.tokenDeployer.triggered).toBe(true);
          expect(result.triggeredFilters).toContain('tokenDeployer');
        }),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.4: Honeypot exposure exclusion (Req 1.9)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.4: Honeypot Exposure Exclusion (honeypot_exposure_pct > 20%)', () => {
    /**
     * **Validates: Requirement 1.9**
     *
     * THE Smart_Money_Curator SHALL exclude wallets where more than 20%
     * of purchased tokens were honeypots or rugs.
     */
    it('excludes wallets with honeypot_exposure_pct > 20%', () => {
      fc.assert(
        fc.property(honeypotExposureMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          const result = curator.evaluateExclusionFiltersDetailed(metrics);

          // Should be excluded
          expect(result.excluded).toBe(true);

          // Specifically the honeypotExposure filter should be triggered
          expect(result.filters.honeypotExposure.triggered).toBe(true);
          expect(result.triggeredFilters).toContain('honeypotExposure');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirement 1.9 (boundary)**
     *
     * Wallet at exactly 20% should NOT be excluded (threshold is >20%).
     */
    it('does not exclude wallets with honeypot_exposure_pct exactly at 20%', () => {
      const curator = new SmartMoneyCurator();
      const metrics: WalletExclusionMetrics = {
        sameBlockTradePct: 0.10,
        hasDeployedTokensRecently: false,
        honeypotExposurePct: 0.20, // Exactly at threshold
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: 0.10,
      };

      const result = curator.evaluateExclusionFiltersDetailed(metrics);
      expect(result.excluded).toBe(false);
      expect(result.filters.honeypotExposure.triggered).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.5: Deployer airdrop exclusion (Req 1.10)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.5: Deployer Airdrop Exclusion (received_deployer_airdrop)', () => {
    /**
     * **Validates: Requirement 1.10**
     *
     * THE Smart_Money_Curator SHALL exclude wallets that received tokens
     * directly from token deployers (insider airdrop indicator).
     */
    it('excludes wallets that received deployer airdrops', () => {
      fc.assert(
        fc.property(deployerAirdropMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          const result = curator.evaluateExclusionFiltersDetailed(metrics);

          // Should be excluded
          expect(result.excluded).toBe(true);

          // Specifically the deployerRecipient filter should be triggered
          expect(result.filters.deployerRecipient.triggered).toBe(true);
          expect(result.triggeredFilters).toContain('deployerRecipient');
        }),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.6: Wash trading detection (Req 1.11)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.6: Wash Trading Detection (same_counterparty_trade_pct > 30%)', () => {
    /**
     * **Validates: Requirement 1.11**
     *
     * THE Smart_Money_Curator SHALL exclude wallets with more than 30%
     * of trades with the same counterparty (wash trading indicator).
     */
    it('excludes wallets with same_counterparty_trade_pct > 30%', () => {
      fc.assert(
        fc.property(washTradingMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          const result = curator.evaluateExclusionFiltersDetailed(metrics);

          // Should be excluded
          expect(result.excluded).toBe(true);

          // Specifically the sameCounterparty filter should be triggered
          expect(result.filters.sameCounterparty.triggered).toBe(true);
          expect(result.triggeredFilters).toContain('sameCounterparty');
        }),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirement 1.11 (boundary)**
     *
     * Wallet at exactly 30% should NOT be excluded (threshold is >30%).
     */
    it('does not exclude wallets with same_counterparty_trade_pct exactly at 30%', () => {
      const curator = new SmartMoneyCurator();
      const metrics: WalletExclusionMetrics = {
        sameBlockTradePct: 0.10,
        hasDeployedTokensRecently: false,
        honeypotExposurePct: 0.10,
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: 0.30, // Exactly at threshold
      };

      const result = curator.evaluateExclusionFiltersDetailed(metrics);
      expect(result.excluded).toBe(false);
      expect(result.filters.sameCounterparty.triggered).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.7: Multiple exclusion flags
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.7: Multiple Exclusion Flags Trigger Exclusion', () => {
    /**
     * **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**
     *
     * When multiple exclusion conditions are met simultaneously,
     * the wallet SHALL be excluded and all triggered filters SHALL be reported.
     */
    it('excludes wallets with multiple triggered filters and reports all', () => {
      fc.assert(
        fc.property(multipleExclusionMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          const result = curator.evaluateExclusionFiltersDetailed(metrics);

          // Should be excluded
          expect(result.excluded).toBe(true);

          // Multiple filters should be triggered (at least 2)
          expect(result.triggeredFilters.length).toBeGreaterThanOrEqual(2);

          // Verify the triggered filters match expectations
          const expectedFilters = getExpectedTriggeredFilters(metrics);
          expect(result.triggeredFilters.sort()).toEqual(expectedFilters.sort());
        }),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.8: Universal property - exclusion is correctly computed
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.8: Universal Exclusion Correctness', () => {
    /**
     * **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**
     *
     * For ANY wallet metrics, the exclusion result SHALL match the logical
     * OR of all individual filter conditions.
     */
    it('exclusion result matches logical OR of all conditions', () => {
      fc.assert(
        fc.property(arbitraryExclusionMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          const result = curator.evaluateExclusionFiltersDetailed(metrics);

          // Calculate expected exclusion
          const expectedExcluded = shouldBeExcluded(metrics);

          // Result should match our expectation
          expect(result.excluded).toBe(expectedExcluded);

          // Triggered filters should match
          const expectedFilters = getExpectedTriggeredFilters(metrics);
          expect(result.triggeredFilters.sort()).toEqual(expectedFilters.sort());
        }),
        { numRuns: 200 }
      );
    });

    /**
     * **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**
     *
     * The evaluateExclusionFilters boolean method SHALL return consistent
     * results with evaluateExclusionFiltersDetailed.
     */
    it('simple and detailed exclusion methods return consistent results', () => {
      fc.assert(
        fc.property(arbitraryExclusionMetrics, (metrics) => {
          const curator = new SmartMoneyCurator();
          
          const simpleResult = curator.evaluateExclusionFilters(metrics);
          const detailedResult = curator.evaluateExclusionFiltersDetailed(metrics);

          // Both methods should return the same exclusion decision
          expect(simpleResult).toBe(detailedResult.excluded);
        }),
        { numRuns: 100 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 2.9: Configuration respects defaults
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 2.9: Exclusion Thresholds Match Requirements', () => {
    /**
     * Verifies that default exclusion filters match requirement specifications.
     */
    it('default filters match requirement thresholds', () => {
      expect(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct).toBe(0.50);
      expect(DEFAULT_EXCLUSION_FILTERS.excludeTokenDeployers).toBe(true);
      expect(DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct).toBe(0.20);
      expect(DEFAULT_EXCLUSION_FILTERS.excludeDeployerRecipients).toBe(true);
      expect(DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct).toBe(0.30);
    });

    /**
     * Verifies curator uses correct default thresholds.
     */
    it('curator uses correct default thresholds', () => {
      const curator = new SmartMoneyCurator();
      const filters = curator.getExclusionFilters();

      expect(filters.maxSameBlockTradePct).toBe(0.50);
      expect(filters.excludeTokenDeployers).toBe(true);
      expect(filters.maxHoneypotExposurePct).toBe(0.20);
      expect(filters.excludeDeployerRecipients).toBe(true);
      expect(filters.maxSameCounterpartyPct).toBe(0.30);
    });
  });
});

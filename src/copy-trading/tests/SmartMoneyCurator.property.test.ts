/**
 * SmartMoneyCurator — Property-Based Tests
 *
 * Property-based tests for SmartMoneyCurator using Vitest + fast-check.
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
 *
 * **Property 3: Wallet Count Bounds Invariant**
 * For any sequence of wallet additions and removals, the count of monitored
 * wallets SHALL always satisfy: 10 ≤ count ≤ 50
 *
 * **Validates: Requirements 1.1**
 *
 * **Property 5: Degraded Wallet Removal**
 * For any wallet where win_rate drops below 60% during re-evaluation,
 * the SmartMoneyCurator SHALL remove it from the monitored list within
 * the next re-evaluation cycle (if above minimum wallet count).
 *
 * **Validates: Requirements 1.13, 1.14**
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import {
  SmartMoneyCurator,
  DEGRADED_WIN_RATE_THRESHOLD,
  MIN_WALLET_COUNT,
  MAX_WALLET_COUNT,
  DEFAULT_EXCLUSION_FILTERS,
  WalletExclusionMetrics
} from '../modules/SmartMoneyCurator.js';
import {
  WalletMetrics,
  WalletExclusionMetrics as TypesExclusionMetrics,
  PerformanceTier
} from '../interfaces/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const INCLUSION_WIN_RATE = 0.70; // 70% for inclusion
const MIN_ACCEPTABLE_WIN_RATE = DEGRADED_WIN_RATE_THRESHOLD; // 60% for re-evaluation
const MINIMUM_WALLETS_THRESHOLD = 10; // Minimum wallets required (from Property 3)

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a valid Ethereum address based on an index
 */
function generateValidAddress(index: number): string {
  return `0x${index.toString(16).padStart(40, '0')}`;
}

/**
 * Create valid inclusion metrics for a wallet
 */
function createValidInclusionMetrics(winRate: number): WalletMetrics {
  return {
    winRate,
    totalPnlUsdc: 60000,
    tradeCount: 150,
    avgHoldingTimeSec: 3600,
    volumeUsdc: 600000,
    sharpeRatio: 1.5,
    maxDrawdownPct: 15,
    profitFactor: 2.0,
    profitableWeeksPct: 75
  };
}

/**
 * Create clean exclusion metrics (no exclusions)
 * Note: Percentages are expressed as decimals (0.10 = 10%)
 * Thresholds: sameBlockTradePct < 0.50, honeypotExposurePct < 0.20, sameCounterpartyPct < 0.30
 */
function createCleanExclusionMetrics(): WalletExclusionMetrics {
  return {
    sameBlockTradePct: 0.10,           // 10% - below 50% threshold
    hasDeployedTokensRecently: false,
    honeypotExposurePct: 0.05,         // 5% - below 20% threshold
    receivedDeployerAirdrop: false,
    sameCounterpartyPct: 0.10          // 10% - below 30% threshold
  };
}

/**
 * Create extended metrics for re-evaluation
 */
function createExtendedMetrics(winRate: number): WalletMetrics & {
  tier?: PerformanceTier;
  lastEvaluatedAt?: number;
  recentTrades?: { timestamp: number; pnl: number }[];
} {
  return {
    winRate,
    totalPnlUsdc: 60000,
    tradeCount: 150,
    avgHoldingTimeSec: 3600,
    volumeUsdc: 600000,
    sharpeRatio: 1.5,
    maxDrawdownPct: 15,
    profitFactor: 2.0,
    profitableWeeksPct: 75
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a valid win rate for inclusion (≥70%)
 * Using integer conversion to avoid floating point precision issues
 */
const validInclusionWinRate = fc.integer({ min: 70, max: 100 }).map(n => n / 100);

/**
 * Generate a degraded win rate (strictly below 60%)
 * Using integer conversion to avoid floating point precision issues
 */
const degradedWinRate = fc.integer({ min: 1, max: 59 }).map(n => n / 100);

/**
 * Generate a valid non-degraded win rate (≥60%)
 * This represents wallets that should NOT be removed
 * Using integer conversion to avoid floating point precision issues
 */
const nonDegradedWinRate = fc.integer({ min: 60, max: 100 }).map(n => n / 100);

/**
 * Generate number of wallets above minimum (11-30)
 */
const walletsAboveMinimum = fc.integer({ min: MINIMUM_WALLETS_THRESHOLD + 1, max: 30 });

/**
 * Generate number of wallets at exactly minimum (10)
 */
const walletsAtMinimum = fc.constant(MINIMUM_WALLETS_THRESHOLD);

/**
 * Generate number of degraded wallets to test (1-5)
 */
const degradedWalletCount = fc.integer({ min: 1, max: 5 });

// ═══════════════════════════════════════════════════════════════════════════
// Property 2 Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a percentage value above a threshold (exclusive)
 * @param threshold - The threshold value (e.g., 0.50 for 50%)
 * @param max - Maximum value (default 1.0 = 100%)
 */
function percentageAboveThreshold(threshold: number, max: number = 1.0): fc.Arbitrary<number> {
  const minInt = Math.floor(threshold * 100) + 1;
  const maxInt = Math.floor(max * 100);
  return fc.integer({ min: minInt, max: maxInt }).map(n => n / 100);
}

/**
 * Generate a percentage value at or below a threshold (inclusive)
 */
function percentageAtOrBelowThreshold(threshold: number): fc.Arbitrary<number> {
  const maxInt = Math.floor(threshold * 100);
  return fc.integer({ min: 0, max: maxInt }).map(n => n / 100);
}

/**
 * Generate clean exclusion metrics that pass ALL exclusion filters
 */
const cleanExclusionMetricsGen: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct),
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct),
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct),
});

/**
 * Generate exclusion metrics that trigger MEV bot filter (Req 1.7)
 */
const mevBotMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: percentageAboveThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct),
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct),
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct),
});

/**
 * Generate exclusion metrics that trigger token deployer filter (Req 1.8)
 */
const tokenDeployerMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct),
  hasDeployedTokensRecently: fc.constant(true),
  honeypotExposurePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct),
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct),
});

/**
 * Generate exclusion metrics that trigger honeypot exposure filter (Req 1.9)
 */
const honeypotExposureMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct),
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: percentageAboveThreshold(DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct),
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct),
});

/**
 * Generate exclusion metrics that trigger deployer airdrop filter (Req 1.10)
 */
const deployerAirdropMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct),
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct),
  receivedDeployerAirdrop: fc.constant(true),
  sameCounterpartyPct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct),
});

/**
 * Generate exclusion metrics that trigger wash trading filter (Req 1.11)
 */
const washTradingMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct),
  hasDeployedTokensRecently: fc.constant(false),
  honeypotExposurePct: percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct),
  receivedDeployerAirdrop: fc.constant(false),
  sameCounterpartyPct: percentageAboveThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct),
});

/**
 * Generate random exclusion metrics (may or may not trigger filters)
 */
const randomExclusionMetrics: fc.Arbitrary<WalletExclusionMetrics> = fc.record({
  sameBlockTradePct: fc.integer({ min: 0, max: 100 }).map(n => n / 100),
  hasDeployedTokensRecently: fc.boolean(),
  honeypotExposurePct: fc.integer({ min: 0, max: 100 }).map(n => n / 100),
  receivedDeployerAirdrop: fc.boolean(),
  sameCounterpartyPct: fc.integer({ min: 0, max: 100 }).map(n => n / 100),
});

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// Property 2: Wallet Exclusion Filters Enforcement
// **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**
// ═══════════════════════════════════════════════════════════════════════════

describe('SmartMoneyCurator - Property 2: Wallet Exclusion Filters Enforcement', () => {

  let curator: SmartMoneyCurator;

  beforeEach(() => {
    curator = new SmartMoneyCurator();
  });

  // Property 2.1: MEV Bot Filter (Req 1.7)
  describe('Property 2.1: MEV Bot Filter - same_block_trade_pct > 50%', () => {
    /**
     * **Validates: Requirements 1.7**
     */
    it('excludes wallets with same_block_trade_pct > 50%', () => {
      fc.assert(
        fc.property(mevBotMetrics, (metrics) => {
          const result = curator.evaluateExclusionFilters(metrics);
          expect(result).toBe(true);
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          expect(detailed.excluded).toBe(true);
          expect(detailed.filters.sameBlockTrade.triggered).toBe(true);
          expect(detailed.triggeredFilters).toContain('sameBlockTrade');
        }),
        { numRuns: 100 }
      );
    });

    it('does not trigger for same_block_trade_pct <= 50%', () => {
      fc.assert(
        fc.property(
          percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct),
          (sameBlockPct) => {
            const metrics: WalletExclusionMetrics = {
              sameBlockTradePct: sameBlockPct,
              hasDeployedTokensRecently: false,
              honeypotExposurePct: 0,
              receivedDeployerAirdrop: false,
              sameCounterpartyPct: 0,
            };
            const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
            expect(detailed.filters.sameBlockTrade.triggered).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Property 2.2: Token Deployer Filter (Req 1.8)
  describe('Property 2.2: Token Deployer Filter - has_deployed_tokens_180d = true', () => {
    /**
     * **Validates: Requirements 1.8**
     */
    it('excludes wallets that deployed tokens recently', () => {
      fc.assert(
        fc.property(tokenDeployerMetrics, (metrics) => {
          const result = curator.evaluateExclusionFilters(metrics);
          expect(result).toBe(true);
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          expect(detailed.excluded).toBe(true);
          expect(detailed.filters.tokenDeployer.triggered).toBe(true);
          expect(detailed.triggeredFilters).toContain('tokenDeployer');
        }),
        { numRuns: 50 }
      );
    });

    it('does not trigger for non-deployer wallets', () => {
      fc.assert(
        fc.property(cleanExclusionMetricsGen, (metrics) => {
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          expect(detailed.filters.tokenDeployer.triggered).toBe(false);
        }),
        { numRuns: 50 }
      );
    });
  });

  // Property 2.3: Honeypot Exposure Filter (Req 1.9)
  describe('Property 2.3: Honeypot Exposure Filter - honeypot_exposure_pct > 20%', () => {
    /**
     * **Validates: Requirements 1.9**
     */
    it('excludes wallets with honeypot_exposure_pct > 20%', () => {
      fc.assert(
        fc.property(honeypotExposureMetrics, (metrics) => {
          const result = curator.evaluateExclusionFilters(metrics);
          expect(result).toBe(true);
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          expect(detailed.excluded).toBe(true);
          expect(detailed.filters.honeypotExposure.triggered).toBe(true);
          expect(detailed.triggeredFilters).toContain('honeypotExposure');
        }),
        { numRuns: 100 }
      );
    });

    it('does not trigger for honeypot_exposure_pct <= 20%', () => {
      fc.assert(
        fc.property(
          percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct),
          (honeypotPct) => {
            const metrics: WalletExclusionMetrics = {
              sameBlockTradePct: 0,
              hasDeployedTokensRecently: false,
              honeypotExposurePct: honeypotPct,
              receivedDeployerAirdrop: false,
              sameCounterpartyPct: 0,
            };
            const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
            expect(detailed.filters.honeypotExposure.triggered).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Property 2.4: Deployer Airdrop Filter (Req 1.10)
  describe('Property 2.4: Deployer Airdrop Filter - received_deployer_airdrop = true', () => {
    /**
     * **Validates: Requirements 1.10**
     */
    it('excludes wallets that received deployer airdrops', () => {
      fc.assert(
        fc.property(deployerAirdropMetrics, (metrics) => {
          const result = curator.evaluateExclusionFilters(metrics);
          expect(result).toBe(true);
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          expect(detailed.excluded).toBe(true);
          expect(detailed.filters.deployerRecipient.triggered).toBe(true);
          expect(detailed.triggeredFilters).toContain('deployerRecipient');
        }),
        { numRuns: 50 }
      );
    });

    it('does not trigger for wallets without deployer airdrops', () => {
      fc.assert(
        fc.property(cleanExclusionMetricsGen, (metrics) => {
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          expect(detailed.filters.deployerRecipient.triggered).toBe(false);
        }),
        { numRuns: 50 }
      );
    });
  });

  // Property 2.5: Wash Trading Filter (Req 1.11)
  describe('Property 2.5: Wash Trading Filter - same_counterparty_trade_pct > 30%', () => {
    /**
     * **Validates: Requirements 1.11**
     */
    it('excludes wallets with same_counterparty_trade_pct > 30%', () => {
      fc.assert(
        fc.property(washTradingMetrics, (metrics) => {
          const result = curator.evaluateExclusionFilters(metrics);
          expect(result).toBe(true);
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          expect(detailed.excluded).toBe(true);
          expect(detailed.filters.sameCounterparty.triggered).toBe(true);
          expect(detailed.triggeredFilters).toContain('sameCounterparty');
        }),
        { numRuns: 100 }
      );
    });

    it('does not trigger for same_counterparty_trade_pct <= 30%', () => {
      fc.assert(
        fc.property(
          percentageAtOrBelowThreshold(DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct),
          (counterpartyPct) => {
            const metrics: WalletExclusionMetrics = {
              sameBlockTradePct: 0,
              hasDeployedTokensRecently: false,
              honeypotExposurePct: 0,
              receivedDeployerAirdrop: false,
              sameCounterpartyPct: counterpartyPct,
            };
            const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
            expect(detailed.filters.sameCounterparty.triggered).toBe(false);
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  // Property 2.6: ANY filter triggers exclusion
  describe('Property 2.6: ANY filter triggers exclusion', () => {
    /**
     * **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**
     */
    it('excludes wallet if ANY filter condition is met', () => {
      fc.assert(
        fc.property(randomExclusionMetrics, (metrics) => {
          const result = curator.evaluateExclusionFilters(metrics);
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          
          const shouldBeExcluded = 
            metrics.sameBlockTradePct > DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct ||
            metrics.hasDeployedTokensRecently ||
            metrics.honeypotExposurePct > DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct ||
            metrics.receivedDeployerAirdrop ||
            metrics.sameCounterpartyPct > DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct;
          
          expect(result).toBe(shouldBeExcluded);
          expect(detailed.excluded).toBe(shouldBeExcluded);
          
          if (shouldBeExcluded) {
            expect(detailed.triggeredFilters.length).toBeGreaterThan(0);
          } else {
            expect(detailed.triggeredFilters.length).toBe(0);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('can trigger multiple filters simultaneously', () => {
      fc.assert(
        fc.property(fc.integer({ min: 2, max: 5 }), (numFilters) => {
          const metrics: WalletExclusionMetrics = {
            sameBlockTradePct: numFilters >= 1 ? 0.60 : 0.10,
            hasDeployedTokensRecently: numFilters >= 2,
            honeypotExposurePct: numFilters >= 3 ? 0.30 : 0.05,
            receivedDeployerAirdrop: numFilters >= 4,
            sameCounterpartyPct: numFilters >= 5 ? 0.40 : 0.10,
          };
          
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          expect(detailed.excluded).toBe(true);
          expect(detailed.triggeredFilters.length).toBeGreaterThanOrEqual(1);
        }),
        { numRuns: 50 }
      );
    });
  });

  // Property 2.7: Clean metrics pass ALL filters
  describe('Property 2.7: Clean metrics pass ALL filters', () => {
    /**
     * **Validates: Requirements 1.7, 1.8, 1.9, 1.10, 1.11**
     */
    it('passes wallets that meet none of the exclusion conditions', () => {
      fc.assert(
        fc.property(cleanExclusionMetricsGen, (metrics) => {
          const result = curator.evaluateExclusionFilters(metrics);
          const detailed = curator.evaluateExclusionFiltersDetailed(metrics);
          
          expect(result).toBe(false);
          expect(detailed.excluded).toBe(false);
          expect(detailed.triggeredFilters.length).toBe(0);
        }),
        { numRuns: 100 }
      );
    });
  });

  // Property 2.8: Boundary conditions
  describe('Property 2.8: Boundary conditions', () => {
    /**
     * **Validates: Requirements 1.7, 1.9, 1.11**
     */
    it('does not exclude when values are exactly at threshold', () => {
      const atThresholds: WalletExclusionMetrics = {
        sameBlockTradePct: DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct,
        hasDeployedTokensRecently: false,
        honeypotExposurePct: DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct,
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct,
      };
      
      const result = curator.evaluateExclusionFilters(atThresholds);
      const detailed = curator.evaluateExclusionFiltersDetailed(atThresholds);
      
      expect(result).toBe(false);
      expect(detailed.excluded).toBe(false);
      expect(detailed.triggeredFilters.length).toBe(0);
    });

    it('excludes when values are just above threshold', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('sameBlock', 'honeypot', 'counterparty'),
          (filterType) => {
            const metrics: WalletExclusionMetrics = {
              sameBlockTradePct: filterType === 'sameBlock' 
                ? DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct + 0.01 
                : 0,
              hasDeployedTokensRecently: false,
              honeypotExposurePct: filterType === 'honeypot'
                ? DEFAULT_EXCLUSION_FILTERS.maxHoneypotExposurePct + 0.01
                : 0,
              receivedDeployerAirdrop: false,
              sameCounterpartyPct: filterType === 'counterparty'
                ? DEFAULT_EXCLUSION_FILTERS.maxSameCounterpartyPct + 0.01
                : 0,
            };
            
            const result = curator.evaluateExclusionFilters(metrics);
            expect(result).toBe(true);
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Property 3: Wallet Count Bounds Invariant
// **Validates: Requirements 1.1**
//
// For any sequence of wallet additions and removals, the count of monitored
// wallets SHALL always satisfy: 10 ≤ count ≤ 50
// ═══════════════════════════════════════════════════════════════════════════

describe('SmartMoneyCurator - Property 3: Wallet Count Bounds Invariant', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // Type definitions for operations
  // ═══════════════════════════════════════════════════════════════════════

  type AddOperation = { type: 'add'; addressIndex: number };
  type RemoveOperation = { type: 'remove'; addressIndex: number };
  type WalletOperation = AddOperation | RemoveOperation;

  // ═══════════════════════════════════════════════════════════════════════
  // Helper to create a curator with N wallets pre-populated
  // ═══════════════════════════════════════════════════════════════════════

  function createCuratorWithWallets(count: number): SmartMoneyCurator {
    const curator = new SmartMoneyCurator();
    const exclusionMetrics = createCleanExclusionMetrics();

    for (let i = 1; i <= count; i++) {
      const metrics = createValidInclusionMetrics(0.75);
      curator.addWalletWithMetrics(generateValidAddress(i), metrics, exclusionMetrics);
    }

    return curator;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Generators for wallet operations
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Generate a random wallet operation (add or remove)
   * Uses address indices in range 1-100 to allow for a variety of addresses
   */
  const walletOperation: fc.Arbitrary<WalletOperation> = fc.oneof(
    fc.record({
      type: fc.constant('add' as const),
      addressIndex: fc.integer({ min: 1, max: 100 })
    }),
    fc.record({
      type: fc.constant('remove' as const),
      addressIndex: fc.integer({ min: 1, max: 100 })
    })
  );

  /**
   * Generate a sequence of wallet operations (5-50 operations)
   */
  const operationSequence: fc.Arbitrary<WalletOperation[]> = fc.array(
    walletOperation,
    { minLength: 5, maxLength: 50 }
  );

  /**
   * Generate initial wallet count (must be at least MIN_WALLET_COUNT=10)
   */
  const initialWalletCount = fc.integer({ min: MIN_WALLET_COUNT, max: MAX_WALLET_COUNT });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.1: Count never exceeds MAX_WALLET_COUNT (50)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.1: Upper bound - count never exceeds 50', () => {

    /**
     * **Validates: Requirements 1.1**
     *
     * For any sequence of add operations, the count SHALL never exceed 50.
     */
    it('rejects additions when at maximum wallet count', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          (additionalAttempts) => {
            // Start with MAX_WALLET_COUNT wallets
            const curator = createCuratorWithWallets(MAX_WALLET_COUNT);

            expect(curator.getWalletCount()).toBe(MAX_WALLET_COUNT);
            expect(curator.canAddWallet()).toBe(false);

            // Try to add more wallets
            const exclusionMetrics = createCleanExclusionMetrics();

            for (let i = 1; i <= additionalAttempts; i++) {
              const metrics = createValidInclusionMetrics(0.75);
              const newAddress = generateValidAddress(MAX_WALLET_COUNT + i);
              const result = curator.addWalletWithMetrics(newAddress, metrics, exclusionMetrics);

              // Addition should fail
              expect(result).toBeNull();

              // Count should still be at maximum
              expect(curator.getWalletCount()).toBe(MAX_WALLET_COUNT);
              expect(curator.getWalletCount()).toBeLessThanOrEqual(MAX_WALLET_COUNT);
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    /**
     * **Validates: Requirements 1.1**
     *
     * For any sequence of operations starting below max, count never exceeds 50.
     */
    it('maintains upper bound through random operation sequences', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: MIN_WALLET_COUNT, max: MAX_WALLET_COUNT - 5 }),
          operationSequence,
          (startCount, operations) => {
            const curator = createCuratorWithWallets(startCount);
            const exclusionMetrics = createCleanExclusionMetrics();
            const usedAddresses = new Set<number>();

            // Track which addresses are already used
            for (let i = 1; i <= startCount; i++) {
              usedAddresses.add(i);
            }

            // Apply operations
            for (const op of operations) {
              if (op.type === 'add') {
                // Only try to add if not already present
                if (!usedAddresses.has(op.addressIndex)) {
                  const metrics = createValidInclusionMetrics(0.75);
                  const address = generateValidAddress(op.addressIndex);
                  const result = curator.addWalletWithMetrics(address, metrics, exclusionMetrics);

                  if (result !== null) {
                    usedAddresses.add(op.addressIndex);
                  }
                }
              } else {
                // Try to remove
                const address = generateValidAddress(op.addressIndex);
                const removed = curator.removeWallet(address);

                if (removed) {
                  usedAddresses.delete(op.addressIndex);
                }
              }

              // INVARIANT: Count must never exceed MAX_WALLET_COUNT
              expect(curator.getWalletCount()).toBeLessThanOrEqual(MAX_WALLET_COUNT);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.2: Count never goes below MIN_WALLET_COUNT (10)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.2: Lower bound - count never goes below 10', () => {

    /**
     * **Validates: Requirements 1.1**
     *
     * For any sequence of remove operations, the count SHALL never go below 10.
     */
    it('rejects removals when at minimum wallet count', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: MIN_WALLET_COUNT }),
          (removalAttempts) => {
            // Start with exactly MIN_WALLET_COUNT wallets
            const curator = createCuratorWithWallets(MIN_WALLET_COUNT);

            expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT);
            expect(curator.canRemoveWallet()).toBe(false);

            // Try to remove wallets
            for (let i = 1; i <= removalAttempts; i++) {
              const address = generateValidAddress(i);
              const result = curator.removeWallet(address);

              // Removal should fail
              expect(result).toBe(false);

              // Count should still be at minimum
              expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT);
              expect(curator.getWalletCount()).toBeGreaterThanOrEqual(MIN_WALLET_COUNT);
            }
          }
        ),
        { numRuns: 30 }
      );
    });

    /**
     * **Validates: Requirements 1.1**
     *
     * For any sequence of operations starting above min, count never goes below 10.
     */
    it('maintains lower bound through random operation sequences', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: MIN_WALLET_COUNT + 5, max: MAX_WALLET_COUNT }),
          operationSequence,
          (startCount, operations) => {
            const curator = createCuratorWithWallets(startCount);
            const exclusionMetrics = createCleanExclusionMetrics();
            const usedAddresses = new Set<number>();

            // Track which addresses are already used
            for (let i = 1; i <= startCount; i++) {
              usedAddresses.add(i);
            }

            // Apply operations
            for (const op of operations) {
              if (op.type === 'add') {
                // Only try to add if not already present
                if (!usedAddresses.has(op.addressIndex)) {
                  const metrics = createValidInclusionMetrics(0.75);
                  const address = generateValidAddress(op.addressIndex);
                  const result = curator.addWalletWithMetrics(address, metrics, exclusionMetrics);

                  if (result !== null) {
                    usedAddresses.add(op.addressIndex);
                  }
                }
              } else {
                // Try to remove
                const address = generateValidAddress(op.addressIndex);
                const removed = curator.removeWallet(address);

                if (removed) {
                  usedAddresses.delete(op.addressIndex);
                }
              }

              // INVARIANT: Count must never go below MIN_WALLET_COUNT
              expect(curator.getWalletCount()).toBeGreaterThanOrEqual(MIN_WALLET_COUNT);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.3: Combined bounds invariant (10 ≤ count ≤ 50)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.3: Combined bounds - 10 ≤ count ≤ 50 always holds', () => {

    /**
     * **Validates: Requirements 1.1**
     *
     * For ANY sequence of add/remove operations starting from ANY valid state,
     * the count SHALL ALWAYS satisfy: 10 ≤ count ≤ 50
     */
    it('maintains bounds through arbitrary operation sequences', () => {
      fc.assert(
        fc.property(
          initialWalletCount,
          operationSequence,
          (startCount, operations) => {
            const curator = createCuratorWithWallets(startCount);
            const exclusionMetrics = createCleanExclusionMetrics();
            const usedAddresses = new Set<number>();

            // Track which addresses are already used
            for (let i = 1; i <= startCount; i++) {
              usedAddresses.add(i);
            }

            // Initial state must satisfy bounds
            expect(curator.getWalletCount()).toBeGreaterThanOrEqual(MIN_WALLET_COUNT);
            expect(curator.getWalletCount()).toBeLessThanOrEqual(MAX_WALLET_COUNT);

            // Apply each operation and verify bounds
            for (const op of operations) {
              if (op.type === 'add') {
                // Only try to add if not already present
                if (!usedAddresses.has(op.addressIndex)) {
                  const metrics = createValidInclusionMetrics(0.75);
                  const address = generateValidAddress(op.addressIndex);
                  const result = curator.addWalletWithMetrics(address, metrics, exclusionMetrics);

                  if (result !== null) {
                    usedAddresses.add(op.addressIndex);
                  }
                }
              } else {
                // Try to remove
                const address = generateValidAddress(op.addressIndex);
                const removed = curator.removeWallet(address);

                if (removed) {
                  usedAddresses.delete(op.addressIndex);
                }
              }

              // INVARIANT: 10 ≤ count ≤ 50 MUST hold after EVERY operation
              const count = curator.getWalletCount();
              expect(count).toBeGreaterThanOrEqual(MIN_WALLET_COUNT);
              expect(count).toBeLessThanOrEqual(MAX_WALLET_COUNT);
            }
          }
        ),
        { numRuns: 100 }
      );
    });

    /**
     * **Validates: Requirements 1.1**
     *
     * Stress test with long sequences of operations (100+ operations)
     */
    it('maintains bounds through long operation sequences', () => {
      fc.assert(
        fc.property(
          initialWalletCount,
          fc.array(walletOperation, { minLength: 50, maxLength: 150 }),
          (startCount, operations) => {
            const curator = createCuratorWithWallets(startCount);
            const exclusionMetrics = createCleanExclusionMetrics();
            const usedAddresses = new Set<number>();

            for (let i = 1; i <= startCount; i++) {
              usedAddresses.add(i);
            }

            // Verify bounds after each operation in long sequence
            for (const op of operations) {
              if (op.type === 'add' && !usedAddresses.has(op.addressIndex)) {
                const metrics = createValidInclusionMetrics(0.75);
                const address = generateValidAddress(op.addressIndex);
                const result = curator.addWalletWithMetrics(address, metrics, exclusionMetrics);

                if (result !== null) {
                  usedAddresses.add(op.addressIndex);
                }
              } else if (op.type === 'remove') {
                const address = generateValidAddress(op.addressIndex);
                const removed = curator.removeWallet(address);

                if (removed) {
                  usedAddresses.delete(op.addressIndex);
                }
              }

              // INVARIANT must hold
              const count = curator.getWalletCount();
              expect(count).toBeGreaterThanOrEqual(MIN_WALLET_COUNT);
              expect(count).toBeLessThanOrEqual(MAX_WALLET_COUNT);
            }
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.4: canAddWallet/canRemoveWallet correctness
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.4: canAddWallet/canRemoveWallet reflect actual bounds', () => {

    /**
     * **Validates: Requirements 1.1**
     *
     * canAddWallet() returns true iff count < 50
     * canRemoveWallet() returns true iff count > 10
     */
    it('helper methods correctly reflect bounds state', () => {
      fc.assert(
        fc.property(
          initialWalletCount,
          (startCount) => {
            const curator = createCuratorWithWallets(startCount);
            const count = curator.getWalletCount();

            // canAddWallet should be true iff count < MAX_WALLET_COUNT
            if (count < MAX_WALLET_COUNT) {
              expect(curator.canAddWallet()).toBe(true);
            } else {
              expect(curator.canAddWallet()).toBe(false);
            }

            // canRemoveWallet should be true iff count > MIN_WALLET_COUNT
            if (count > MIN_WALLET_COUNT) {
              expect(curator.canRemoveWallet()).toBe(true);
            } else {
              expect(curator.canRemoveWallet()).toBe(false);
            }
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * **Validates: Requirements 1.1**
     *
     * canAddWallet/canRemoveWallet stay correct after operations
     */
    it('helper methods remain correct after operations', () => {
      fc.assert(
        fc.property(
          initialWalletCount,
          operationSequence,
          (startCount, operations) => {
            const curator = createCuratorWithWallets(startCount);
            const exclusionMetrics = createCleanExclusionMetrics();
            const usedAddresses = new Set<number>();

            for (let i = 1; i <= startCount; i++) {
              usedAddresses.add(i);
            }

            for (const op of operations) {
              if (op.type === 'add' && !usedAddresses.has(op.addressIndex)) {
                const metrics = createValidInclusionMetrics(0.75);
                const address = generateValidAddress(op.addressIndex);
                const result = curator.addWalletWithMetrics(address, metrics, exclusionMetrics);

                if (result !== null) {
                  usedAddresses.add(op.addressIndex);
                }
              } else if (op.type === 'remove') {
                const address = generateValidAddress(op.addressIndex);
                const removed = curator.removeWallet(address);

                if (removed) {
                  usedAddresses.delete(op.addressIndex);
                }
              }

              // Verify helper methods are consistent with actual count
              const count = curator.getWalletCount();
              expect(curator.canAddWallet()).toBe(count < MAX_WALLET_COUNT);
              expect(curator.canRemoveWallet()).toBe(count > MIN_WALLET_COUNT);
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 3.5: Boundary transitions are handled correctly
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 3.5: Boundary transition behavior', () => {

    /**
     * **Validates: Requirements 1.1**
     *
     * When transitioning from count=10 to count=11 (via add),
     * subsequent removes should work until count=10.
     */
    it('correctly handles transition from min to min+1', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          (addCount) => {
            const curator = createCuratorWithWallets(MIN_WALLET_COUNT);
            const exclusionMetrics = createCleanExclusionMetrics();

            // At minimum, cannot remove
            expect(curator.canRemoveWallet()).toBe(false);
            expect(curator.removeWallet(generateValidAddress(1))).toBe(false);

            // Add one wallet
            const newAddress = generateValidAddress(MIN_WALLET_COUNT + 1);
            const metrics = createValidInclusionMetrics(0.75);
            const addResult = curator.addWalletWithMetrics(newAddress, metrics, exclusionMetrics);

            expect(addResult).not.toBeNull();
            expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT + 1);

            // Now can remove
            expect(curator.canRemoveWallet()).toBe(true);

            // Remove the new wallet
            expect(curator.removeWallet(newAddress)).toBe(true);
            expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT);

            // Back to minimum, cannot remove again
            expect(curator.canRemoveWallet()).toBe(false);
          }
        ),
        { numRuns: 20 }
      );
    });

    /**
     * **Validates: Requirements 1.1**
     *
     * When transitioning from count=50 to count=49 (via remove),
     * subsequent adds should work until count=50.
     */
    it('correctly handles transition from max to max-1', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 10 }),
          (removeCount) => {
            const curator = createCuratorWithWallets(MAX_WALLET_COUNT);
            const exclusionMetrics = createCleanExclusionMetrics();

            // At maximum, cannot add
            expect(curator.canAddWallet()).toBe(false);

            const failedAddress = generateValidAddress(MAX_WALLET_COUNT + 1);
            const metrics = createValidInclusionMetrics(0.75);
            expect(curator.addWalletWithMetrics(failedAddress, metrics, exclusionMetrics)).toBeNull();

            // Remove one wallet
            expect(curator.removeWallet(generateValidAddress(1))).toBe(true);
            expect(curator.getWalletCount()).toBe(MAX_WALLET_COUNT - 1);

            // Now can add
            expect(curator.canAddWallet()).toBe(true);

            // Add a new wallet
            const newAddress = generateValidAddress(MAX_WALLET_COUNT + 1);
            expect(curator.addWalletWithMetrics(newAddress, metrics, exclusionMetrics)).not.toBeNull();
            expect(curator.getWalletCount()).toBe(MAX_WALLET_COUNT);

            // Back to maximum, cannot add again
            expect(curator.canAddWallet()).toBe(false);
          }
        ),
        { numRuns: 20 }
      );
    });
  });
});

describe('SmartMoneyCurator - Property 5: Degraded Wallet Removal', () => {

  // ═══════════════════════════════════════════════════════════════════════
  // Property 5.1: Degraded wallets are removed when above minimum
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 5.1: Degraded wallets are removed when above minimum', () => {

    /**
     * **Validates: Requirements 1.14**
     *
     * For any wallet count above minimum (>10), if a wallet's win_rate
     * drops below 60%, it SHALL be removed after re-evaluation.
     */
    it('removes wallet with degraded win_rate when above minimum wallet count', () => {
      fc.assert(
        fc.property(
          walletsAboveMinimum,
          degradedWinRate,
          async (totalWallets, newWinRate) => {
            const curator = new SmartMoneyCurator();
            const exclusionMetrics = createCleanExclusionMetrics();

            // Add wallets (all start with valid win rate)
            for (let i = 1; i <= totalWallets; i++) {
              const metrics = createValidInclusionMetrics(0.75);
              curator.addWalletWithMetrics(generateValidAddress(i), metrics, exclusionMetrics);
            }

            const initialCount = curator.getWalletCount();
            expect(initialCount).toBe(totalWallets);

            // Degrade wallet #1's win rate
            curator.reEvaluateWallet(
              generateValidAddress(1),
              createExtendedMetrics(newWinRate)
            );

            // Verify wallet is marked as degraded
            const degradedBefore = curator.getDegradedWallets();
            expect(degradedBefore.some(w => w.address === generateValidAddress(1))).toBe(true);

            // Trigger re-evaluation
            await curator.reEvaluateAll();

            // Wallet should be removed
            const isStillMonitored = curator.isMonitored(generateValidAddress(1));
            const finalCount = curator.getWalletCount();

            expect(isStillMonitored).toBe(false);
            expect(finalCount).toBe(totalWallets - 1);
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * **Validates: Requirements 1.14**
     *
     * Multiple degraded wallets are all removed (down to minimum)
     */
    it('removes multiple degraded wallets down to minimum count', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: MINIMUM_WALLETS_THRESHOLD + 3, max: 25 }),
          degradedWalletCount,
          degradedWinRate,
          async (totalWallets, numDegraded, newWinRate) => {
            // Ensure we don't try to degrade more wallets than would leave us above minimum
            const maxDegradable = totalWallets - MINIMUM_WALLETS_THRESHOLD;
            const actualDegraded = Math.min(numDegraded, maxDegradable);

            const curator = new SmartMoneyCurator();
            const exclusionMetrics = createCleanExclusionMetrics();

            // Add wallets
            for (let i = 1; i <= totalWallets; i++) {
              const metrics = createValidInclusionMetrics(0.75);
              curator.addWalletWithMetrics(generateValidAddress(i), metrics, exclusionMetrics);
            }

            // Degrade some wallets
            for (let i = 1; i <= actualDegraded; i++) {
              curator.reEvaluateWallet(
                generateValidAddress(i),
                createExtendedMetrics(newWinRate)
              );
            }

            // Re-evaluate
            await curator.reEvaluateAll();

            // All degraded wallets should be removed
            for (let i = 1; i <= actualDegraded; i++) {
              expect(curator.isMonitored(generateValidAddress(i))).toBe(false);
            }

            // Final count should be reduced
            const finalCount = curator.getWalletCount();
            expect(finalCount).toBe(totalWallets - actualDegraded);
            expect(finalCount).toBeGreaterThanOrEqual(MINIMUM_WALLETS_THRESHOLD);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 5.2: Degraded wallets are kept when at minimum
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 5.2: Degraded wallets are kept when at minimum', () => {

    /**
     * **Validates: Requirements 1.1, 1.14**
     *
     * When wallet count equals minimum (10), degraded wallets
     * SHALL NOT be removed to maintain the minimum count invariant.
     */
    it('does not remove degraded wallets when at minimum count', () => {
      fc.assert(
        fc.property(
          degradedWinRate,
          fc.integer({ min: 1, max: MINIMUM_WALLETS_THRESHOLD }),
          async (newWinRate, numToDegade) => {
            const curator = new SmartMoneyCurator();
            const exclusionMetrics = createCleanExclusionMetrics();

            // Add exactly minimum wallets
            for (let i = 1; i <= MINIMUM_WALLETS_THRESHOLD; i++) {
              const metrics = createValidInclusionMetrics(0.75);
              curator.addWalletWithMetrics(generateValidAddress(i), metrics, exclusionMetrics);
            }

            expect(curator.getWalletCount()).toBe(MINIMUM_WALLETS_THRESHOLD);

            // Degrade some wallets
            for (let i = 1; i <= numToDegade; i++) {
              curator.reEvaluateWallet(
                generateValidAddress(i),
                createExtendedMetrics(newWinRate)
              );
            }

            // Re-evaluate
            await curator.reEvaluateAll();

            // All wallets should still be monitored (minimum count protected)
            for (let i = 1; i <= MINIMUM_WALLETS_THRESHOLD; i++) {
              expect(curator.isMonitored(generateValidAddress(i))).toBe(true);
            }

            // Count should still be at minimum
            expect(curator.getWalletCount()).toBe(MINIMUM_WALLETS_THRESHOLD);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 5.3: Non-degraded wallets are never removed
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 5.3: Non-degraded wallets are never removed', () => {

    /**
     * **Validates: Requirements 1.14**
     *
     * Wallets with win_rate >= 60% SHALL NOT be removed during re-evaluation.
     */
    it('keeps wallets with win_rate at or above 60%', () => {
      fc.assert(
        fc.property(
          walletsAboveMinimum,
          nonDegradedWinRate,
          async (totalWallets, newWinRate) => {
            const curator = new SmartMoneyCurator();
            const exclusionMetrics = createCleanExclusionMetrics();

            // Add wallets
            for (let i = 1; i <= totalWallets; i++) {
              const metrics = createValidInclusionMetrics(0.75);
              curator.addWalletWithMetrics(generateValidAddress(i), metrics, exclusionMetrics);
            }

            // Update wallet #1 with non-degraded win rate (still ≥60%)
            curator.reEvaluateWallet(
              generateValidAddress(1),
              createExtendedMetrics(newWinRate)
            );

            // Verify not marked as degraded
            const degraded = curator.getDegradedWallets();
            expect(degraded.some(w => w.address === generateValidAddress(1))).toBe(false);

            // Re-evaluate
            await curator.reEvaluateAll();

            // Wallet should still be monitored
            expect(curator.isMonitored(generateValidAddress(1))).toBe(true);
            expect(curator.getWalletCount()).toBe(totalWallets);
          }
        ),
        { numRuns: 50 }
      );
    });

    /**
     * **Validates: Requirements 1.14**
     *
     * Wallet at exactly 60% win_rate is considered acceptable (not degraded).
     */
    it('wallet at exactly 60% win_rate is not removed', () => {
      fc.assert(
        fc.property(
          walletsAboveMinimum,
          async (totalWallets) => {
            const curator = new SmartMoneyCurator();
            const exclusionMetrics = createCleanExclusionMetrics();

            // Add wallets
            for (let i = 1; i <= totalWallets; i++) {
              const metrics = createValidInclusionMetrics(0.75);
              curator.addWalletWithMetrics(generateValidAddress(i), metrics, exclusionMetrics);
            }

            // Update wallet #1 to exactly 60%
            curator.reEvaluateWallet(
              generateValidAddress(1),
              createExtendedMetrics(DEGRADED_WIN_RATE_THRESHOLD)
            );

            // Verify not marked as degraded
            const degraded = curator.getDegradedWallets();
            expect(degraded.some(w => w.address === generateValidAddress(1))).toBe(false);

            // Re-evaluate
            await curator.reEvaluateAll();

            // Wallet should still be monitored
            expect(curator.isMonitored(generateValidAddress(1))).toBe(true);
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Property 5.4: Degraded threshold is respected at boundary
  // ═══════════════════════════════════════════════════════════════════════

  describe('Property 5.4: Boundary conditions at 60% threshold', () => {

    /**
     * **Validates: Requirements 1.14**
     *
     * For win_rate just below 60% (e.g., 59.99%), wallet is degraded.
     * For win_rate at exactly 60%, wallet is NOT degraded.
     */
    it('correctly classifies wallets at boundary (59.99% vs 60%)', () => {
      fc.assert(
        fc.property(
          walletsAboveMinimum,
          fc.integer({ min: 55, max: 59 }).map(n => n / 100),
          async (totalWallets, belowThreshold) => {
            const curator = new SmartMoneyCurator();
            const exclusionMetrics = createCleanExclusionMetrics();

            // Add wallets
            for (let i = 1; i <= totalWallets; i++) {
              const metrics = createValidInclusionMetrics(0.75);
              curator.addWalletWithMetrics(generateValidAddress(i), metrics, exclusionMetrics);
            }

            // Degrade wallet #1 to just below threshold
            curator.reEvaluateWallet(
              generateValidAddress(1),
              createExtendedMetrics(belowThreshold)
            );

            // Update wallet #2 to exactly threshold
            curator.reEvaluateWallet(
              generateValidAddress(2),
              createExtendedMetrics(DEGRADED_WIN_RATE_THRESHOLD)
            );

            const degraded = curator.getDegradedWallets();

            // Wallet #1 should be degraded (below threshold)
            expect(degraded.some(w => w.address === generateValidAddress(1))).toBe(true);

            // Wallet #2 should NOT be degraded (at threshold)
            expect(degraded.some(w => w.address === generateValidAddress(2))).toBe(false);
          }
        ),
        { numRuns: 30 }
      );
    });
  });
});

/**
 * @fileoverview Tests for SmartMoneyCurator module
 * 
 * Tests inclusion criteria (Req 1.2-1.6), exclusion filters (Req 1.7-1.11),
 * tier assignment (Req 1.12), and wallet management (Req 1.1, 1.13, 1.14).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SmartMoneyCurator,
  WalletMetrics,
  FullWalletMetrics,
  WalletExclusionMetrics,
  ExtendedWalletMetrics,
  DEFAULT_INCLUSION_CRITERIA,
  DEFAULT_EXCLUSION_FILTERS,
  MIN_WALLET_COUNT,
  MAX_WALLET_COUNT,
  DEGRADED_WIN_RATE_THRESHOLD,
} from '../modules/SmartMoneyCurator.js';

describe('SmartMoneyCurator', () => {
  let curator: SmartMoneyCurator;

  beforeEach(() => {
    curator = new SmartMoneyCurator();
  });

  afterEach(() => {
    curator.stopReEvaluation();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // INCLUSION CRITERIA TESTS (Task 5.1)
  // Requirements: 1.2, 1.3, 1.4, 1.5, 1.6
  // ═══════════════════════════════════════════════════════════════════════════

  describe('evaluateInclusionCriteria', () => {
    const passingMetrics: WalletMetrics = {
      winRate: 0.75,           // > 70% (Req 1.2)
      totalPnlUsdc: 75000,     // > $50,000 (Req 1.3)
      tradeCount: 150,         // > 100 (Req 1.4)
      avgHoldingTimeSec: 3600, // 1 hour (between 15min-7days) (Req 1.5)
      volumeUsdc: 600000,      // > $500,000 (Req 1.6)
    };

    it('returns true for wallet meeting all criteria', () => {
      const result = curator.evaluateInclusionCriteria(passingMetrics);
      expect(result).toBe(true);
    });

    it('returns false for wallet with low win rate (Req 1.2)', () => {
      const metrics: WalletMetrics = { ...passingMetrics, winRate: 0.65 };
      expect(curator.evaluateInclusionCriteria(metrics)).toBe(false);
    });

    it('returns false for wallet with low PnL (Req 1.3)', () => {
      const metrics: WalletMetrics = { ...passingMetrics, totalPnlUsdc: 40000 };
      expect(curator.evaluateInclusionCriteria(metrics)).toBe(false);
    });

    it('returns false for wallet with low trade count (Req 1.4)', () => {
      const metrics: WalletMetrics = { ...passingMetrics, tradeCount: 50 };
      expect(curator.evaluateInclusionCriteria(metrics)).toBe(false);
    });

    it('returns false for wallet with holding time too short (Req 1.5)', () => {
      const metrics: WalletMetrics = { ...passingMetrics, avgHoldingTimeSec: 300 };
      expect(curator.evaluateInclusionCriteria(metrics)).toBe(false);
    });

    it('returns false for wallet with holding time too long (Req 1.5)', () => {
      const metrics: WalletMetrics = { ...passingMetrics, avgHoldingTimeSec: 700000 };
      expect(curator.evaluateInclusionCriteria(metrics)).toBe(false);
    });

    it('returns false for wallet with low volume (Req 1.6)', () => {
      const metrics: WalletMetrics = { ...passingMetrics, volumeUsdc: 300000 };
      expect(curator.evaluateInclusionCriteria(metrics)).toBe(false);
    });

    it('returns boundary values correctly', () => {
      // Exactly at minimums
      const boundaryMetrics: WalletMetrics = {
        winRate: 0.70,
        totalPnlUsdc: 50000,
        tradeCount: 100,
        avgHoldingTimeSec: 900, // 15 min minimum
        volumeUsdc: 500000,
      };
      expect(curator.evaluateInclusionCriteria(boundaryMetrics)).toBe(true);
    });
  });

  describe('evaluateInclusionCriteriaDetailed', () => {
    it('provides detailed breakdown of failed criteria', () => {
      const failingMetrics: WalletMetrics = {
        winRate: 0.60,         // Below 70%
        totalPnlUsdc: 30000,   // Below $50,000
        tradeCount: 150,       // Passes
        avgHoldingTimeSec: 3600,
        volumeUsdc: 600000,
      };

      const result = curator.evaluateInclusionCriteriaDetailed(failingMetrics);

      expect(result.passed).toBe(false);
      expect(result.failedCriteria).toContain('winRate');
      expect(result.failedCriteria).toContain('historicalPnl');
      expect(result.failedCriteria).not.toContain('tradeCount');
      expect(result.criteria.winRate.passed).toBe(false);
      expect(result.criteria.historicalPnl.passed).toBe(false);
      expect(result.criteria.tradeCount.passed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // EXCLUSION FILTERS TESTS (Task 5.3)
  // Requirements: 1.7, 1.8, 1.9, 1.10, 1.11
  // ═══════════════════════════════════════════════════════════════════════════

  describe('evaluateExclusionFilters', () => {
    const passingExclusionMetrics: WalletExclusionMetrics = {
      sameBlockTradePct: 0.10,           // < 50% (Req 1.7)
      hasDeployedTokensRecently: false,   // Not a deployer (Req 1.8)
      honeypotExposurePct: 0.05,         // < 20% (Req 1.9)
      receivedDeployerAirdrop: false,    // Not airdrop recipient (Req 1.10)
      sameCounterpartyPct: 0.10,         // < 30% (Req 1.11)
    };

    it('returns false (no exclusion) for clean wallet', () => {
      const result = curator.evaluateExclusionFilters(passingExclusionMetrics);
      expect(result).toBe(false);
    });

    it('returns true (exclude) for MEV bot indicator (Req 1.7)', () => {
      const metrics: WalletExclusionMetrics = {
        ...passingExclusionMetrics,
        sameBlockTradePct: 0.60, // > 50%
      };
      expect(curator.evaluateExclusionFilters(metrics)).toBe(true);
    });

    it('returns true (exclude) for token deployer (Req 1.8)', () => {
      const metrics: WalletExclusionMetrics = {
        ...passingExclusionMetrics,
        hasDeployedTokensRecently: true,
      };
      expect(curator.evaluateExclusionFilters(metrics)).toBe(true);
    });

    it('returns true (exclude) for honeypot exposure (Req 1.9)', () => {
      const metrics: WalletExclusionMetrics = {
        ...passingExclusionMetrics,
        honeypotExposurePct: 0.25, // > 20%
      };
      expect(curator.evaluateExclusionFilters(metrics)).toBe(true);
    });

    it('returns true (exclude) for deployer airdrop recipient (Req 1.10)', () => {
      const metrics: WalletExclusionMetrics = {
        ...passingExclusionMetrics,
        receivedDeployerAirdrop: true,
      };
      expect(curator.evaluateExclusionFilters(metrics)).toBe(true);
    });

    it('returns true (exclude) for wash trader (Req 1.11)', () => {
      const metrics: WalletExclusionMetrics = {
        ...passingExclusionMetrics,
        sameCounterpartyPct: 0.40, // > 30%
      };
      expect(curator.evaluateExclusionFilters(metrics)).toBe(true);
    });
  });

  describe('evaluateExclusionFiltersDetailed', () => {
    it('provides detailed breakdown of triggered filters', () => {
      const metrics: WalletExclusionMetrics = {
        sameBlockTradePct: 0.60,
        hasDeployedTokensRecently: true,
        honeypotExposurePct: 0.05,
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: 0.10,
      };

      const result = curator.evaluateExclusionFiltersDetailed(metrics);

      expect(result.excluded).toBe(true);
      expect(result.triggeredFilters).toContain('sameBlockTrade');
      expect(result.triggeredFilters).toContain('tokenDeployer');
      expect(result.triggeredFilters).not.toContain('honeypotExposure');
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // TIER ASSIGNMENT TESTS (Task 5.5)
  // Requirement: 1.12
  // ═══════════════════════════════════════════════════════════════════════════

  describe('calculateWalletScore', () => {
    it('calculates score as winRate × profitFactor × sharpeRatio', () => {
      const metrics: ExtendedWalletMetrics = {
        winRate: 0.80,
        totalPnlUsdc: 100000,
        tradeCount: 200,
        avgHoldingTimeSec: 3600,
        volumeUsdc: 1000000,
        sharpeRatio: 1.5,
        profitFactor: 2.0,
      };

      const score = curator.calculateWalletScore(metrics);
      // 0.80 * 2.0 * 1.5 = 2.4
      expect(score).toBeCloseTo(2.4, 5);
    });

    it('returns 0 when any factor is 0', () => {
      const metrics: ExtendedWalletMetrics = {
        winRate: 0,
        totalPnlUsdc: 100000,
        tradeCount: 200,
        avgHoldingTimeSec: 3600,
        volumeUsdc: 1000000,
        sharpeRatio: 1.5,
        profitFactor: 2.0,
      };

      expect(curator.calculateWalletScore(metrics)).toBe(0);
    });
  });

  describe('assignTier', () => {
    it('assigns S_TIER for ranks 1-5', () => {
      expect(curator.assignTier(1)).toBe('S_TIER');
      expect(curator.assignTier(5)).toBe('S_TIER');
    });

    it('assigns A_TIER for ranks 6-15', () => {
      expect(curator.assignTier(6)).toBe('A_TIER');
      expect(curator.assignTier(15)).toBe('A_TIER');
    });

    it('assigns B_TIER for ranks 16-50', () => {
      expect(curator.assignTier(16)).toBe('B_TIER');
      expect(curator.assignTier(50)).toBe('B_TIER');
    });

    it('throws for invalid ranks', () => {
      expect(() => curator.assignTier(0)).toThrow();
      expect(() => curator.assignTier(51)).toThrow();
    });
  });


  describe('assignTiers', () => {
    it('assigns tiers based on score ranking', () => {
      const wallets = [
        { address: '0xA', metrics: createExtendedMetrics(0.90, 3.0, 2.0) }, // Score: 5.4
        { address: '0xB', metrics: createExtendedMetrics(0.80, 2.0, 1.5) }, // Score: 2.4
        { address: '0xC', metrics: createExtendedMetrics(0.70, 1.5, 1.0) }, // Score: 1.05
      ];

      const result = curator.assignTiers(wallets);

      expect(result[0].address).toBe('0xA'); // Highest score
      expect(result[0].tier).toBe('S_TIER');
      expect(result[1].address).toBe('0xB');
      expect(result[1].tier).toBe('S_TIER');
      expect(result[2].address).toBe('0xC');
      expect(result[2].tier).toBe('S_TIER'); // Still S tier (only 3 wallets)
    });

    it('throws for more than 50 wallets', () => {
      const wallets = Array(51).fill(null).map((_, i) => ({
        address: `0x${i}`,
        metrics: createExtendedMetrics(0.75, 1.5, 1.2),
      }));

      expect(() => curator.assignTiers(wallets)).toThrow();
    });

    it('is idempotent - same input produces same output', () => {
      const wallets = [
        { address: '0xA', metrics: createExtendedMetrics(0.85, 2.5, 1.8) },
        { address: '0xB', metrics: createExtendedMetrics(0.75, 2.0, 1.5) },
      ];

      const result1 = curator.assignTiers(wallets);
      const result2 = curator.assignTiers(wallets);

      expect(result1).toEqual(result2);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // WALLET MANAGEMENT TESTS (Task 5.7)
  // Requirement: 1.1 - Maintain 10-50 monitored wallets
  // ═══════════════════════════════════════════════════════════════════════════

  describe('addWalletWithMetrics', () => {
    const validAddress = '0x1234567890abcdef1234567890abcdef12345678';
    const fullMetrics: FullWalletMetrics = {
      winRate: 0.75,
      totalPnlUsdc: 75000,
      tradeCount: 150,
      avgHoldingTimeSec: 3600,
      volumeUsdc: 600000,
      sharpeRatio: 1.5,
      profitFactor: 2.0,
      maxDrawdownPct: 0.15,
      profitableWeeksPct: 0.70,
    };
    const cleanExclusionMetrics: WalletExclusionMetrics = {
      sameBlockTradePct: 0.10,
      hasDeployedTokensRecently: false,
      honeypotExposurePct: 0.05,
      receivedDeployerAirdrop: false,
      sameCounterpartyPct: 0.10,
    };


    it('adds a wallet meeting all criteria', () => {
      const wallet = curator.addWalletWithMetrics(validAddress, fullMetrics, cleanExclusionMetrics);

      expect(wallet).not.toBeNull();
      expect(wallet?.address).toBe(validAddress);
      expect(wallet?.isActive).toBe(true);
      expect(curator.getWalletCount()).toBe(1);
    });

    it('rejects invalid address format', () => {
      const wallet = curator.addWalletWithMetrics('invalid', fullMetrics, cleanExclusionMetrics);
      expect(wallet).toBeNull();
    });

    it('rejects duplicate addresses', () => {
      curator.addWalletWithMetrics(validAddress, fullMetrics, cleanExclusionMetrics);
      const duplicate = curator.addWalletWithMetrics(validAddress, fullMetrics, cleanExclusionMetrics);

      expect(duplicate).toBeNull();
      expect(curator.getWalletCount()).toBe(1);
    });

    it('rejects wallet not meeting inclusion criteria', () => {
      const lowWinRateMetrics: FullWalletMetrics = {
        ...fullMetrics,
        winRate: 0.50, // Below 70%
      };

      const wallet = curator.addWalletWithMetrics(validAddress, lowWinRateMetrics, cleanExclusionMetrics);
      expect(wallet).toBeNull();
    });

    it('rejects wallet triggering exclusion filter', () => {
      const mevMetrics: WalletExclusionMetrics = {
        ...cleanExclusionMetrics,
        sameBlockTradePct: 0.60, // MEV bot indicator
      };

      const wallet = curator.addWalletWithMetrics(validAddress, fullMetrics, mevMetrics);
      expect(wallet).toBeNull();
    });

    it('respects MAX_WALLET_COUNT limit', () => {
      // Add MAX_WALLET_COUNT wallets
      for (let i = 0; i < MAX_WALLET_COUNT; i++) {
        const addr = `0x${i.toString().padStart(40, '0')}`;
        curator.addWalletWithMetrics(addr, fullMetrics, cleanExclusionMetrics);
      }

      expect(curator.getWalletCount()).toBe(MAX_WALLET_COUNT);

      // Try to add one more
      const overflow = curator.addWalletWithMetrics(
        '0xoverflow00000000000000000000000000000000',
        fullMetrics,
        cleanExclusionMetrics
      );
      expect(overflow).toBeNull();
    });
  });


  describe('removeWallet', () => {
    it('removes wallet when above MIN_WALLET_COUNT', () => {
      const fullMetrics: FullWalletMetrics = {
        winRate: 0.75,
        totalPnlUsdc: 75000,
        tradeCount: 150,
        avgHoldingTimeSec: 3600,
        volumeUsdc: 600000,
        sharpeRatio: 1.5,
        profitFactor: 2.0,
        maxDrawdownPct: 0.15,
        profitableWeeksPct: 0.70,
      };
      const cleanExclusionMetrics: WalletExclusionMetrics = {
        sameBlockTradePct: 0.10,
        hasDeployedTokensRecently: false,
        honeypotExposurePct: 0.05,
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: 0.10,
      };

      // Add MIN_WALLET_COUNT + 1 wallets
      for (let i = 0; i < MIN_WALLET_COUNT + 1; i++) {
        const addr = `0x${i.toString().padStart(40, '0')}`;
        curator.addWalletWithMetrics(addr, fullMetrics, cleanExclusionMetrics);
      }

      const addrToRemove = `0x${'0'.padStart(40, '0')}`;
      const removed = curator.removeWallet(addrToRemove);

      expect(removed).toBe(true);
      expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT);
    });

    it('refuses to remove when at MIN_WALLET_COUNT', () => {
      const fullMetrics: FullWalletMetrics = {
        winRate: 0.75,
        totalPnlUsdc: 75000,
        tradeCount: 150,
        avgHoldingTimeSec: 3600,
        volumeUsdc: 600000,
        sharpeRatio: 1.5,
        profitFactor: 2.0,
        maxDrawdownPct: 0.15,
        profitableWeeksPct: 0.70,
      };
      const cleanExclusionMetrics: WalletExclusionMetrics = {
        sameBlockTradePct: 0.10,
        hasDeployedTokensRecently: false,
        honeypotExposurePct: 0.05,
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: 0.10,
      };

      // Add exactly MIN_WALLET_COUNT wallets
      for (let i = 0; i < MIN_WALLET_COUNT; i++) {
        const addr = `0x${i.toString().padStart(40, '0')}`;
        curator.addWalletWithMetrics(addr, fullMetrics, cleanExclusionMetrics);
      }

      const addrToRemove = `0x${'0'.padStart(40, '0')}`;
      const removed = curator.removeWallet(addrToRemove);

      expect(removed).toBe(false);
      expect(curator.getWalletCount()).toBe(MIN_WALLET_COUNT);
    });

    it('returns false for non-existent wallet', () => {
      const removed = curator.removeWallet('0xnonexistent00000000000000000000000000');
      expect(removed).toBe(false);
    });
  });


  describe('getWallets', () => {
    it('returns wallets sorted by tier and score', () => {
      const cleanExclusionMetrics: WalletExclusionMetrics = {
        sameBlockTradePct: 0.10,
        hasDeployedTokensRecently: false,
        honeypotExposurePct: 0.05,
        receivedDeployerAirdrop: false,
        sameCounterpartyPct: 0.10,
      };

      // Add wallets with different scores
      curator.addWalletWithMetrics(
        '0x1111111111111111111111111111111111111111',
        createFullMetrics(0.90, 3.0, 2.0), // High score
        cleanExclusionMetrics
      );
      curator.addWalletWithMetrics(
        '0x2222222222222222222222222222222222222222',
        createFullMetrics(0.70, 1.5, 1.0), // Low score
        cleanExclusionMetrics
      );

      const wallets = curator.getWallets();

      expect(wallets.length).toBe(2);
      // Higher score should come first
      expect(wallets[0].address).toBe('0x1111111111111111111111111111111111111111');
    });

    it('returns empty array initially', () => {
      expect(curator.getWallets()).toEqual([]);
    });
  });

  describe('isMonitored', () => {
    it('returns true for monitored wallet', () => {
      const addr = '0x1234567890abcdef1234567890abcdef12345678';
      curator.addWalletWithMetrics(
        addr,
        createFullMetrics(0.75, 2.0, 1.5),
        createCleanExclusionMetrics()
      );

      expect(curator.isMonitored(addr)).toBe(true);
    });

    it('returns false for non-monitored wallet', () => {
      expect(curator.isMonitored('0xnotmonitored0000000000000000000000000000')).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // RE-EVALUATION TESTS (Task 5.9)
  // Requirements: 1.13, 1.14
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getDegradedWallets', () => {
    it('identifies wallets with win rate below 60%', () => {
      // Add a high-performing wallet first
      curator.addWalletWithMetrics(
        '0x1111111111111111111111111111111111111111',
        createFullMetrics(0.75, 2.0, 1.5),
        createCleanExclusionMetrics()
      );

      // Manually modify a wallet's metrics to simulate degradation
      // (In production, this would happen via reEvaluateWallet)
      const wallets = curator.getWallets();
      if (wallets.length > 0) {
        wallets[0].metrics.winRate = 0.55; // Below 60%
      }

      const degraded = curator.getDegradedWallets();
      expect(degraded.length).toBe(1);
      expect(degraded[0].metrics.winRate).toBeLessThan(DEGRADED_WIN_RATE_THRESHOLD);
    });

    it('returns empty array when no degraded wallets', () => {
      curator.addWalletWithMetrics(
        '0x1111111111111111111111111111111111111111',
        createFullMetrics(0.75, 2.0, 1.5),
        createCleanExclusionMetrics()
      );

      const degraded = curator.getDegradedWallets();
      expect(degraded.length).toBe(0);
    });
  });


  describe('reEvaluationTimer', () => {
    it('starts and stops re-evaluation timer', () => {
      expect(curator.isReEvaluationRunning()).toBe(false);

      curator.startReEvaluation();
      expect(curator.isReEvaluationRunning()).toBe(true);

      curator.stopReEvaluation();
      expect(curator.isReEvaluationRunning()).toBe(false);
    });

    it('does not start multiple timers', () => {
      curator.startReEvaluation();
      curator.startReEvaluation(); // Should warn but not crash

      expect(curator.isReEvaluationRunning()).toBe(true);

      curator.stopReEvaluation();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIGURATION TESTS
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getInclusionCriteria', () => {
    it('returns default criteria', () => {
      const criteria = curator.getInclusionCriteria();

      expect(criteria.minWinRate).toBe(DEFAULT_INCLUSION_CRITERIA.minWinRate);
      expect(criteria.minHistoricalPnlUsdc).toBe(DEFAULT_INCLUSION_CRITERIA.minHistoricalPnlUsdc);
    });

    it('returns custom criteria when configured', () => {
      const customCurator = new SmartMoneyCurator({
        inclusionCriteria: { minWinRate: 0.80 },
      });

      const criteria = customCurator.getInclusionCriteria();
      expect(criteria.minWinRate).toBe(0.80);
    });
  });

  describe('getExclusionFilters', () => {
    it('returns default filters', () => {
      const filters = curator.getExclusionFilters();

      expect(filters.maxSameBlockTradePct).toBe(DEFAULT_EXCLUSION_FILTERS.maxSameBlockTradePct);
      expect(filters.excludeTokenDeployers).toBe(DEFAULT_EXCLUSION_FILTERS.excludeTokenDeployers);
    });

    it('returns custom filters when configured', () => {
      const customCurator = new SmartMoneyCurator({
        exclusionFilters: { maxSameBlockTradePct: 0.30 },
      });

      const filters = customCurator.getExclusionFilters();
      expect(filters.maxSameBlockTradePct).toBe(0.30);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

function createExtendedMetrics(
  winRate: number,
  profitFactor: number,
  sharpeRatio: number
): ExtendedWalletMetrics {
  return {
    winRate,
    totalPnlUsdc: 75000,
    tradeCount: 150,
    avgHoldingTimeSec: 3600,
    volumeUsdc: 600000,
    sharpeRatio,
    profitFactor,
  };
}

function createFullMetrics(
  winRate: number,
  profitFactor: number,
  sharpeRatio: number
): FullWalletMetrics {
  return {
    ...createExtendedMetrics(winRate, profitFactor, sharpeRatio),
    maxDrawdownPct: 0.15,
    profitableWeeksPct: 0.70,
  };
}

function createCleanExclusionMetrics(): WalletExclusionMetrics {
  return {
    sameBlockTradePct: 0.10,
    hasDeployedTokensRecently: false,
    honeypotExposurePct: 0.05,
    receivedDeployerAirdrop: false,
    sameCounterpartyPct: 0.10,
  };
}

/**
 * Strategy Registry Integration — Unit Tests
 *
 * Tests the mapping of backtest results to EvolutionDatabase strategy lifecycle.
 * Verifies:
 *   - VIABLE → DORMANT status
 *   - UNVIABLE → ARCHIVED_BASELINE with reason NEGATIVE_EXPECTANCY
 *   - Evidence contains all required keys: period, coins, optimal_capital, alpha, max_drawdown
 *   - Strategy creation when not existing
 *   - Strategy update when already existing
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 11.4
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerFundingArbResult,
  buildBacktestMetadata,
  FUNDING_ARB_STRATEGY_ID,
  type BacktestMetadata,
  type FundingArbEvidence,
} from './strategy-integration.js';
import type { OptimizationResult, CapitalEvaluation } from './bankroll-optimizer.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mock EvolutionDatabase
// ═══════════════════════════════════════════════════════════════════════════

interface MockStrategyRecord {
  strategy_id: string;
  status: string;
  evidence: unknown;
  archived_reason: string;
  notes: string;
  tags: string[];
  [key: string]: unknown;
}

interface MockTransition {
  strategy_id: string;
  from_status: string;
  to_status: string;
  reason: string;
}

class MockEvolutionDatabase {
  strategies: Map<string, MockStrategyRecord> = new Map();
  transitions: MockTransition[] = [];

  getStrategy(strategyId: string): MockStrategyRecord | null {
    return this.strategies.get(strategyId) ?? null;
  }

  insertStrategy(record: Record<string, unknown>): void {
    this.strategies.set(record.strategy_id as string, record as unknown as MockStrategyRecord);
  }

  updateStrategy(strategyId: string, updates: Record<string, unknown>): void {
    const existing = this.strategies.get(strategyId);
    if (existing) {
      Object.assign(existing, updates);
    }
  }

  updateStatus(strategyId: string, newStatus: string, _reason: string): void {
    const existing = this.strategies.get(strategyId);
    if (existing) {
      existing.status = newStatus;
    }
  }

  insertTransition(
    strategyId: string,
    fromStatus: string,
    toStatus: string,
    reason: string,
  ): void {
    this.transitions.push({
      strategy_id: strategyId,
      from_status: fromStatus,
      to_status: toStatus,
      reason,
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeViableResult(): OptimizationResult {
  const evaluations: CapitalEvaluation[] = [
    {
      capitalUsdc: 500_000_000n,  // $500
      netPnl: 50_000_000n,        // $50 profit
      alpha: 30_000_000n,         // $30 alpha
      maxDrawdownBps: 800n,       // 8% drawdown
      liquidationCount: 0,
      edgePositive: true,
      noLiquidations: true,
      drawdownAcceptable: true,
      viable: true,
    },
  ];

  return {
    evaluations,
    minimumViableCapital: 500_000_000n,
    overallVerdict: 'VIABLE',
  };
}

function makeUnviableResult(): OptimizationResult {
  const evaluations: CapitalEvaluation[] = [
    {
      capitalUsdc: 99_000_000n,   // $99
      netPnl: -10_000_000n,       // -$10 loss
      alpha: -20_000_000n,        // -$20 alpha
      maxDrawdownBps: 2000n,      // 20% drawdown
      liquidationCount: 2,
      edgePositive: false,
      noLiquidations: false,
      drawdownAcceptable: false,
      viable: false,
    },
    {
      capitalUsdc: 200_000_000n,  // $200
      netPnl: -5_000_000n,        // -$5 loss
      alpha: -15_000_000n,        // -$15 alpha
      maxDrawdownBps: 1600n,      // 16% drawdown
      liquidationCount: 0,
      edgePositive: false,
      noLiquidations: true,
      drawdownAcceptable: false,
      viable: false,
    },
  ];

  return {
    evaluations,
    minimumViableCapital: null,
    overallVerdict: 'UNVIABLE',
  };
}

function makeMetadata(overrides?: Partial<BacktestMetadata>): BacktestMetadata {
  return {
    period: 90,
    coins: ['ETH', 'BTC'],
    alpha: 30_000_000n,
    maxDrawdownBps: 800n,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('registerFundingArbResult', () => {
  let db: MockEvolutionDatabase;

  beforeEach(() => {
    db = new MockEvolutionDatabase();
  });

  describe('VIABLE verdict → DORMANT status', () => {
    it('should create strategy with DORMANT status when viable and not existing', () => {
      const result = makeViableResult();
      const metadata = makeMetadata();

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      expect(strategy).not.toBeNull();
      expect(strategy!.status).toBe('DORMANT');
    });

    it('should set empty archived_reason when viable', () => {
      const result = makeViableResult();
      const metadata = makeMetadata();

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      expect(strategy!.archived_reason).toBe('');
    });

    it('should update existing strategy to DORMANT when viable', () => {
      // Pre-existing strategy in ARCHIVED_BASELINE state
      db.strategies.set(FUNDING_ARB_STRATEGY_ID, {
        strategy_id: FUNDING_ARB_STRATEGY_ID,
        status: 'ARCHIVED_BASELINE',
        evidence: {},
        archived_reason: 'NEGATIVE_EXPECTANCY',
        notes: '',
        tags: [],
      });

      const result = makeViableResult();
      const metadata = makeMetadata();

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      expect(strategy!.status).toBe('DORMANT');
      expect(strategy!.archived_reason).toBe('');
    });

    it('should record transition from previous status to DORMANT', () => {
      db.strategies.set(FUNDING_ARB_STRATEGY_ID, {
        strategy_id: FUNDING_ARB_STRATEGY_ID,
        status: 'ARCHIVED_BASELINE',
        evidence: {},
        archived_reason: 'NEGATIVE_EXPECTANCY',
        notes: '',
        tags: [],
      });

      const result = makeViableResult();
      const metadata = makeMetadata();

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      expect(db.transitions).toHaveLength(1);
      expect(db.transitions[0]!.from_status).toBe('ARCHIVED_BASELINE');
      expect(db.transitions[0]!.to_status).toBe('DORMANT');
    });
  });

  describe('UNVIABLE verdict → ARCHIVED_BASELINE status', () => {
    it('should create strategy with ARCHIVED_BASELINE status when unviable', () => {
      const result = makeUnviableResult();
      const metadata = makeMetadata({ alpha: -20_000_000n, maxDrawdownBps: 2000n });

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      expect(strategy).not.toBeNull();
      expect(strategy!.status).toBe('ARCHIVED_BASELINE');
    });

    it('should set archived_reason to NEGATIVE_EXPECTANCY when unviable', () => {
      const result = makeUnviableResult();
      const metadata = makeMetadata({ alpha: -20_000_000n, maxDrawdownBps: 2000n });

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      expect(strategy!.archived_reason).toBe('NEGATIVE_EXPECTANCY');
    });

    it('should update existing strategy to ARCHIVED_BASELINE when unviable', () => {
      db.strategies.set(FUNDING_ARB_STRATEGY_ID, {
        strategy_id: FUNDING_ARB_STRATEGY_ID,
        status: 'DORMANT',
        evidence: {},
        archived_reason: '',
        notes: '',
        tags: [],
      });

      const result = makeUnviableResult();
      const metadata = makeMetadata({ alpha: -20_000_000n, maxDrawdownBps: 2000n });

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      expect(strategy!.status).toBe('ARCHIVED_BASELINE');
      expect(strategy!.archived_reason).toBe('NEGATIVE_EXPECTANCY');
    });

    it('should record transition from previous status to ARCHIVED_BASELINE', () => {
      db.strategies.set(FUNDING_ARB_STRATEGY_ID, {
        strategy_id: FUNDING_ARB_STRATEGY_ID,
        status: 'DORMANT',
        evidence: {},
        archived_reason: '',
        notes: '',
        tags: [],
      });

      const result = makeUnviableResult();
      const metadata = makeMetadata({ alpha: -20_000_000n, maxDrawdownBps: 2000n });

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      expect(db.transitions).toHaveLength(1);
      expect(db.transitions[0]!.from_status).toBe('DORMANT');
      expect(db.transitions[0]!.to_status).toBe('ARCHIVED_BASELINE');
      expect(db.transitions[0]!.reason).toContain('NEGATIVE_EXPECTANCY');
    });
  });

  describe('Evidence persistence completeness (Property 20)', () => {
    it('should store evidence with all required keys when viable', () => {
      const result = makeViableResult();
      const metadata = makeMetadata({ period: 90, coins: ['ETH', 'BTC'] });

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      const evidence = strategy!.evidence as unknown as FundingArbEvidence;

      // All five required keys must be present
      expect(evidence).toHaveProperty('period');
      expect(evidence).toHaveProperty('coins');
      expect(evidence).toHaveProperty('optimal_capital');
      expect(evidence).toHaveProperty('alpha');
      expect(evidence).toHaveProperty('max_drawdown');
    });

    it('should store correct evidence values when viable', () => {
      const result = makeViableResult();
      const metadata = makeMetadata({
        period: 90,
        coins: ['ETH', 'BTC'],
        alpha: 30_000_000n,
        maxDrawdownBps: 800n,
      });

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      const evidence = strategy!.evidence as unknown as FundingArbEvidence;

      expect(evidence.period).toBe(90);
      expect(evidence.coins).toEqual(['ETH', 'BTC']);
      expect(evidence.optimal_capital).toBe('500000000');
      expect(evidence.alpha).toBe('30000000');
      expect(evidence.max_drawdown).toBe(800);
    });

    it('should store optimal_capital as null when unviable', () => {
      const result = makeUnviableResult();
      const metadata = makeMetadata({ alpha: -20_000_000n, maxDrawdownBps: 2000n });

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      const evidence = strategy!.evidence as unknown as FundingArbEvidence;

      expect(evidence.optimal_capital).toBeNull();
    });

    it('should store all required keys even when unviable', () => {
      const result = makeUnviableResult();
      const metadata = makeMetadata({
        period: 30,
        coins: ['SOL'],
        alpha: -5_000_000n,
        maxDrawdownBps: 1800n,
      });

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      const evidence = strategy!.evidence as unknown as FundingArbEvidence;

      expect(evidence.period).toBe(30);
      expect(evidence.coins).toEqual(['SOL']);
      expect(evidence.optimal_capital).toBeNull();
      expect(evidence.alpha).toBe('-5000000');
      expect(evidence.max_drawdown).toBe(1800);
    });
  });

  describe('New strategy creation', () => {
    it('should create strategy with correct ID', () => {
      const result = makeViableResult();
      const metadata = makeMetadata();

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      expect(db.strategies.has(FUNDING_ARB_STRATEGY_ID)).toBe(true);
    });

    it('should record initial transition from CANDIDATE', () => {
      const result = makeViableResult();
      const metadata = makeMetadata();

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      expect(db.transitions).toHaveLength(1);
      expect(db.transitions[0]!.from_status).toBe('CANDIDATE');
      expect(db.transitions[0]!.to_status).toBe('DORMANT');
    });

    it('should include funding-arb tags on new strategy', () => {
      const result = makeViableResult();
      const metadata = makeMetadata();

      registerFundingArbResult(db as unknown as import('../evolution-database.js').EvolutionDatabase, result, metadata);

      const strategy = db.getStrategy(FUNDING_ARB_STRATEGY_ID);
      expect(strategy!.tags).toContain('funding-arb');
    });
  });
});

describe('buildBacktestMetadata', () => {
  it('should aggregate coins from multiple results', () => {
    const results = new Map<string, OptimizationResult>();
    results.set('ETH', makeViableResult());
    results.set('BTC', makeUnviableResult());

    const metadata = buildBacktestMetadata(results, 90);

    expect(metadata.coins).toContain('ETH');
    expect(metadata.coins).toContain('BTC');
    expect(metadata.coins).toHaveLength(2);
  });

  it('should find the best alpha across all evaluations', () => {
    const results = new Map<string, OptimizationResult>();

    // ETH has alpha of 30_000_000n
    results.set('ETH', makeViableResult());
    // BTC has alphas of -20_000_000n and -15_000_000n
    results.set('BTC', makeUnviableResult());

    const metadata = buildBacktestMetadata(results, 90);

    // Best alpha is from ETH: 30_000_000n
    expect(metadata.alpha).toBe(30_000_000n);
  });

  it('should find the worst drawdown across all evaluations', () => {
    const results = new Map<string, OptimizationResult>();
    results.set('ETH', makeViableResult());   // 800 bps
    results.set('BTC', makeUnviableResult()); // 2000 bps

    const metadata = buildBacktestMetadata(results, 90);

    expect(metadata.maxDrawdownBps).toBe(2000n);
  });

  it('should set the correct period', () => {
    const results = new Map<string, OptimizationResult>();
    results.set('ETH', makeViableResult());

    const metadata = buildBacktestMetadata(results, 180);

    expect(metadata.period).toBe(180);
  });

  it('should handle empty results', () => {
    const results = new Map<string, OptimizationResult>();

    const metadata = buildBacktestMetadata(results, 90);

    expect(metadata.coins).toEqual([]);
    expect(metadata.alpha).toBe(0n);
    expect(metadata.maxDrawdownBps).toBe(0n);
    expect(metadata.period).toBe(90);
  });
});

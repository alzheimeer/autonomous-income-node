/**
 * Property Test: Observer Never Throws
 *
 * **Property 3: Observer Never Throws**
 * Generate arbitrary inputs (including nulls, malformed details, simulate DB failures)
 * Verify no method throws to caller
 *
 * **Validates: Requirements 2.4, 17.1**
 *
 * All 11 observer methods in PipelineMetricsRecorder must be:
 * - Synchronous
 * - Void return
 * - Never throw exceptions to the caller
 *
 * This ensures the observer pattern maintains non-interference with the
 * TradingOrchestrator pipeline (Req 17.1) and errors during recording
 * are logged internally without propagating (Req 2.4).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { PipelineMetricsRecorder } from './pipeline-observer.js';
import { MetricsDatabase } from './metrics-database.js';
import type { IPipelineObserver } from './pipeline-observer.js';
import type { Indicators } from '../trading-validation/strategy-engine.js';
import type { TradeCandidate, RegimeType, StrategyType } from '../trading-validation/types.js';
import type { GateResult, CostBreakdown } from '../trading-validation/cost-aware-trade-gate.js';

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries (fast-check generators)
// ═══════════════════════════════════════════════════════════════════════════

/** Arbitrary for RegimeType */
const arbRegimeType: fc.Arbitrary<RegimeType> = fc.constantFrom(
  'TRENDING_UP',
  'TRENDING_DOWN',
  'RANGING',
  'VOLATILE',
  'UNCERTAIN',
);

/** Arbitrary for StrategyType */
const arbStrategyType: fc.Arbitrary<StrategyType> = fc.constantFrom(
  'trend_pullback',
  'mean_reversion',
  'momentum_breakout',
  'dip_buying',
);

/** Arbitrary Indicators (including edge cases like NaN, Infinity, negative) */
const arbIndicators: fc.Arbitrary<Indicators> = fc.record({
  ema20: fc.oneof(fc.double(), fc.constant(NaN), fc.constant(Infinity), fc.constant(-Infinity)),
  ema50: fc.oneof(fc.double(), fc.constant(NaN), fc.constant(Infinity)),
  ema200: fc.oneof(fc.double(), fc.constant(NaN), fc.constant(-Infinity)),
  rsi14: fc.oneof(fc.double({ min: 0, max: 100 }), fc.constant(NaN)),
  atr14: fc.oneof(fc.double({ min: 0 }), fc.constant(NaN)),
  volumeZScore: fc.oneof(fc.double(), fc.constant(NaN), fc.constant(Infinity)),
  bollingerBands: fc.record({
    upper: fc.oneof(fc.double(), fc.constant(NaN)),
    middle: fc.oneof(fc.double(), fc.constant(NaN)),
    lower: fc.oneof(fc.double(), fc.constant(NaN)),
  }),
  lastPrice: fc.oneof(fc.double({ min: 0 }), fc.constant(NaN)),
  candleCount: fc.integer({ min: 0, max: 10000 }),
});

/** Arbitrary for nullable/undefined Indicators */
const arbMaybeIndicators: fc.Arbitrary<Indicators | undefined> = fc.oneof(
  arbIndicators,
  fc.constant(undefined),
);

/** Arbitrary TradeCandidate (including malformed/edge cases) */
const arbTradeCandidate: fc.Arbitrary<TradeCandidate> = fc.record({
  id: fc.oneof(fc.string(), fc.constant('')),
  strategy: arbStrategyType,
  pair: fc.constant('WETH/USDC' as const),
  direction: fc.constant('long' as const),
  confidence: fc.oneof(fc.double({ min: 0, max: 1 }), fc.constant(NaN)),
  stopDistanceFraction: fc.oneof(fc.double({ min: 0, max: 1 }), fc.constant(NaN)),
  takeProfitFraction: fc.oneof(fc.double({ min: 0, max: 1 }), fc.constant(NaN)),
  regime: arbRegimeType,
  createdAt: fc.integer({ min: 0 }),
  expiresAt: fc.integer({ min: 0 }),
});

/** Arbitrary for nullable TradeCandidate */
const arbMaybeTradeCandidate: fc.Arbitrary<TradeCandidate | null> = fc.oneof(
  arbTradeCandidate,
  fc.constant(null),
);

/** Arbitrary CostBreakdown with BigInt values */
const arbCostBreakdown: fc.Arbitrary<CostBreakdown> = fc.record({
  entryInput: fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
  exitProceeds: fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
  entryGas: fc.bigInt({ min: 0n, max: 1_000_000n }),
  exitGas: fc.bigInt({ min: 0n, max: 1_000_000n }),
  externalFees: fc.bigInt({ min: 0n, max: 1_000_000n }),
  safetyMargin: fc.bigInt({ min: 0n, max: 1_000_000n }),
  netProfit: fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
});

/** Arbitrary GateResult */
const arbGateResult: fc.Arbitrary<GateResult> = fc.record({
  passed: fc.boolean(),
  netProfitUsdc: fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
  netProfitBps: fc.oneof(fc.integer({ min: -10000, max: 10000 }), fc.constant(NaN)),
  costBreakdown: arbCostBreakdown,
  rejectReasons: fc.array(fc.string(), { minLength: 0, maxLength: 10 }),
});

/** Arbitrary evaluation skip reason */
const arbSkipReason: fc.Arbitrary<'mutex' | 'not_running' | 'cannot_evaluate'> = fc.constantFrom(
  'mutex',
  'not_running',
  'cannot_evaluate',
);

/** Arbitrary trading mode */
const arbTradingMode: fc.Arbitrary<'shadow' | 'micro'> = fc.constantFrom('shadow', 'micro');

/** Arbitrary session ID (including empty, very long, special chars) */
const arbSessionId: fc.Arbitrary<string> = fc.oneof(
  fc.uuid(),
  fc.string(),
  fc.constant(''),
  fc.constant('x'.repeat(10000)),
  fc.constant('\u0000\u0001\u0002'),
);

/** Arbitrary strategy sub-reason (including malformed) */
const arbSubReason: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constantFrom(
    'warmup_incomplete',
    'position_open',
    'regime_not_actionable',
    'cooldown_active',
    'trend_ema_distance',
    'trend_rsi_out_of_range',
    'trend_volume_low',
    'trend_ema_order',
    'trend_price_below_ema50',
    'mean_rev_above_bb',
    'mean_rev_rsi_high',
    'mean_rev_volume_low',
    'mean_rev_atr_ratio',
    'unknown',
  ),
  fc.string(),
  fc.constant(undefined),
);

/** Arbitrary StrategyDiagnostics object (including malformed) */
const arbStrategyDiagnostics = fc.oneof(
  fc.record({
    regime: fc.oneof(fc.string(), fc.constant(undefined)),
    positionOpen: fc.oneof(fc.boolean(), fc.constant(undefined)),
    cooldownRemaining: fc.oneof(fc.integer(), fc.constant(undefined)),
  }),
  fc.constant(undefined),
  fc.constant({}),
  fc.constant({ malformedKey: { nested: [1, 2, 3] } }),
);

/** Arbitrary BigInt (including negative and very large values) */
const arbBigInt: fc.Arbitrary<bigint | undefined> = fc.oneof(
  fc.bigInt({ min: -1_000_000_000_000n, max: 1_000_000_000_000n }),
  fc.constant(undefined),
);

/** Arbitrary position sizing reason */
const arbPositionSizingReason: fc.Arbitrary<string | undefined> = fc.oneof(
  fc.constantFrom(
    'size_below_minimum',
    'size_exceeds_max',
    'kelly_zero',
    'bankroll_too_low',
    'unknown',
  ),
  fc.string(),
  fc.constant(undefined),
);

// ═══════════════════════════════════════════════════════════════════════════
// Mock Factory: Failing Database
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a MetricsDatabase mock that throws on every operation.
 * Used to simulate DB failures and verify observer catches exceptions.
 */
function createFailingDatabase(): MetricsDatabase {
  const mockDb = {
    isDegraded: false,
    insertEvent: vi.fn().mockImplementation(() => {
      throw new Error('Simulated DB failure: insertEvent');
    }),
    insertRejection: vi.fn().mockImplementation(() => {
      throw new Error('Simulated DB failure: insertRejection');
    }),
    insertNearMiss: vi.fn().mockImplementation(() => {
      throw new Error('Simulated DB failure: insertNearMiss');
    }),
    queryEvents: vi.fn().mockReturnValue([]),
    queryRejections: vi.fn().mockReturnValue([]),
    queryNearMisses: vi.fn().mockReturnValue([]),
    insertBacktestRun: vi.fn().mockReturnValue(-1),
    insertBacktestTrade: vi.fn().mockReturnValue(-1),
    close: vi.fn(),
  } as unknown as MetricsDatabase;
  return mockDb;
}

/**
 * Creates a MetricsDatabase mock that works normally (in-memory).
 */
function createWorkingDatabase(): MetricsDatabase {
  return new MetricsDatabase(':memory:');
}

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 3: Observer Never Throws', () => {
  describe('with working database', () => {
    let db: MetricsDatabase;
    let recorder: PipelineMetricsRecorder;

    beforeEach(() => {
      db = createWorkingDatabase();
      recorder = new PipelineMetricsRecorder(db);
    });

    it('onEvaluationStarted never throws for any session ID', () => {
      fc.assert(
        fc.property(arbSessionId, (sessionId) => {
          expect(() => recorder.onEvaluationStarted(sessionId)).not.toThrow();
        }),
        { numRuns: 200 },
      );
    });

    it('onEvaluationSkipped never throws for any skip reason', () => {
      fc.assert(
        fc.property(arbSkipReason, (reason) => {
          expect(() => recorder.onEvaluationSkipped(reason)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });

    it('onIndicatorsResult never throws for arbitrary indicators', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          arbMaybeIndicators,
          arbMaybeIndicators,
          (available, ind1h, ind15m) => {
            expect(() => recorder.onIndicatorsResult(available, ind1h, ind15m)).not.toThrow();
          },
        ),
        { numRuns: 300 },
      );
    });

    it('onStrategyResult never throws for arbitrary candidates and diagnostics', () => {
      fc.assert(
        fc.property(
          arbMaybeTradeCandidate,
          arbSubReason,
          arbStrategyDiagnostics,
          (candidate, subReason, diagnostics) => {
            expect(() => recorder.onStrategyResult(candidate, subReason, diagnostics)).not.toThrow();
          },
        ),
        { numRuns: 300 },
      );
    });

    it('onDailyLossLimitHit never throws', () => {
      fc.assert(
        fc.property(fc.constant(undefined), () => {
          expect(() => recorder.onDailyLossLimitHit()).not.toThrow();
        }),
        { numRuns: 50 },
      );
    });

    it('onPositionSizingResult never throws for arbitrary inputs', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          arbPositionSizingReason,
          arbBigInt,
          (passed, reason, sizeUsdc) => {
            expect(() => recorder.onPositionSizingResult(passed, reason, sizeUsdc)).not.toThrow();
          },
        ),
        { numRuns: 200 },
      );
    });

    it('onBankrollResult never throws for any boolean', () => {
      fc.assert(
        fc.property(fc.boolean(), (sufficient) => {
          expect(() => recorder.onBankrollResult(sufficient)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });

    it('onAaveFundsResult never throws for any boolean', () => {
      fc.assert(
        fc.property(fc.boolean(), (available) => {
          expect(() => recorder.onAaveFundsResult(available)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });

    it('onGateResult never throws for arbitrary GateResult', () => {
      fc.assert(
        fc.property(arbGateResult, (result) => {
          expect(() => recorder.onGateResult(result)).not.toThrow();
        }),
        { numRuns: 300 },
      );
    });

    it('onTradeExecuted never throws for arbitrary mode and candidateId', () => {
      fc.assert(
        fc.property(arbTradingMode, fc.string(), (mode, candidateId) => {
          expect(() => recorder.onTradeExecuted(mode, candidateId)).not.toThrow();
        }),
        { numRuns: 200 },
      );
    });
  });

  describe('with failing database (simulated DB failures)', () => {
    let recorder: PipelineMetricsRecorder;

    beforeEach(() => {
      const failingDb = createFailingDatabase();
      recorder = new PipelineMetricsRecorder(failingDb);
    });

    it('onEvaluationStarted never throws even when DB fails', () => {
      fc.assert(
        fc.property(arbSessionId, (sessionId) => {
          expect(() => recorder.onEvaluationStarted(sessionId)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });

    it('onEvaluationSkipped never throws even when DB fails', () => {
      fc.assert(
        fc.property(arbSkipReason, (reason) => {
          expect(() => recorder.onEvaluationSkipped(reason)).not.toThrow();
        }),
        { numRuns: 50 },
      );
    });

    it('onIndicatorsResult never throws even when DB fails', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          arbMaybeIndicators,
          arbMaybeIndicators,
          (available, ind1h, ind15m) => {
            expect(() => recorder.onIndicatorsResult(available, ind1h, ind15m)).not.toThrow();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('onStrategyResult never throws even when DB fails', () => {
      fc.assert(
        fc.property(
          arbMaybeTradeCandidate,
          arbSubReason,
          arbStrategyDiagnostics,
          (candidate, subReason, diagnostics) => {
            expect(() => recorder.onStrategyResult(candidate, subReason, diagnostics)).not.toThrow();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('onDailyLossLimitHit never throws even when DB fails', () => {
      expect(() => recorder.onDailyLossLimitHit()).not.toThrow();
    });

    it('onPositionSizingResult never throws even when DB fails', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          arbPositionSizingReason,
          arbBigInt,
          (passed, reason, sizeUsdc) => {
            expect(() => recorder.onPositionSizingResult(passed, reason, sizeUsdc)).not.toThrow();
          },
        ),
        { numRuns: 100 },
      );
    });

    it('onBankrollResult never throws even when DB fails', () => {
      fc.assert(
        fc.property(fc.boolean(), (sufficient) => {
          expect(() => recorder.onBankrollResult(sufficient)).not.toThrow();
        }),
        { numRuns: 50 },
      );
    });

    it('onAaveFundsResult never throws even when DB fails', () => {
      fc.assert(
        fc.property(fc.boolean(), (available) => {
          expect(() => recorder.onAaveFundsResult(available)).not.toThrow();
        }),
        { numRuns: 50 },
      );
    });

    it('onGateResult never throws even when DB fails', () => {
      fc.assert(
        fc.property(arbGateResult, (result) => {
          expect(() => recorder.onGateResult(result)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });

    it('onTradeExecuted never throws even when DB fails', () => {
      fc.assert(
        fc.property(arbTradingMode, fc.string(), (mode, candidateId) => {
          expect(() => recorder.onTradeExecuted(mode, candidateId)).not.toThrow();
        }),
        { numRuns: 100 },
      );
    });
  });

  describe('combined stress test with mixed inputs', () => {
    it('all 11 methods called with extreme inputs never throw', () => {
      fc.assert(
        fc.property(
          // Generate inputs for all 11 methods
          arbSessionId,
          arbSkipReason,
          fc.boolean(),
          arbMaybeIndicators,
          arbMaybeIndicators,
          arbMaybeTradeCandidate,
          arbSubReason,
          arbStrategyDiagnostics,
          fc.boolean(),
          arbPositionSizingReason,
          arbBigInt,
          fc.boolean(),
          fc.boolean(),
          arbGateResult,
          arbTradingMode,
          fc.string(),
          (
            sessionId,
            skipReason,
            indicatorsAvailable,
            ind1h,
            ind15m,
            candidate,
            subReason,
            diagnostics,
            sizingPassed,
            sizingReason,
            sizeUsdc,
            bankrollSufficient,
            aaveFundsAvailable,
            gateResult,
            mode,
            candidateId,
          ) => {
            // Test with both working and failing database
            const workingDb = createWorkingDatabase();
            const failingDb = createFailingDatabase();

            for (const db of [workingDb, failingDb]) {
              const recorder = new PipelineMetricsRecorder(db);

              // Call all 11 methods - none should throw
              expect(() => recorder.onEvaluationStarted(sessionId)).not.toThrow();
              expect(() => recorder.onEvaluationSkipped(skipReason)).not.toThrow();
              expect(() => recorder.onIndicatorsResult(indicatorsAvailable, ind1h, ind15m)).not.toThrow();
              expect(() => recorder.onStrategyResult(candidate, subReason, diagnostics)).not.toThrow();
              expect(() => recorder.onDailyLossLimitHit()).not.toThrow();
              expect(() => recorder.onPositionSizingResult(sizingPassed, sizingReason, sizeUsdc)).not.toThrow();
              expect(() => recorder.onBankrollResult(bankrollSufficient)).not.toThrow();
              expect(() => recorder.onAaveFundsResult(aaveFundsAvailable)).not.toThrow();
              expect(() => recorder.onGateResult(gateResult)).not.toThrow();
              expect(() => recorder.onTradeExecuted(mode, candidateId)).not.toThrow();

              // Clean up
              if (db.close) db.close();
            }
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

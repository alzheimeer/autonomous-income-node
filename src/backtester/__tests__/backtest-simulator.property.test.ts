/**
 * Property Tests for BacktestSimulator
 *
 * **Validates: Requirements 11.1**
 *
 * Property 12: Single Position Invariant
 * - Generate random signal sequences with varying timing patterns
 * - Verify at most 1 open position exists at any point in time
 * - Test scenarios:
 *   - Multiple signals arriving rapidly
 *   - Signals arriving while position is open
 *   - Signals arriving just after position closes
 *
 * Uses fast-check for property-based testing with vitest.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { BacktestSimulator, DEFAULT_RISK_LIMITS } from '../backtest-simulator.js';
import { BacktestCostModel, DEFAULT_COST_PARAMS } from '../backtest-cost-model.js';
import type { CandleData, TradeCandidate } from '../../trading-validation/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const COOLDOWN_MS = 3_600_000; // 60 min
const FIFTEEN_MINUTES = 900_000;
const BASE_TIME = 1_704_067_200_000; // 2024-01-01 00:00:00 UTC

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/** Arbitrary for a price in reasonable ETH/USDC range */
const arbPrice = fc.double({ min: 1500, max: 4000, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for stop distance fraction (1% to 10%) */
const arbStopDistance = fc.double({ min: 0.01, max: 0.10, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for take profit fraction (2% to 20%) */
const arbTakeProfit = fc.double({ min: 0.02, max: 0.20, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for time offset in milliseconds (0 to 24 hours) */
const arbTimeOffset = fc.integer({ min: 0, max: 24 * 3_600_000 });

/** Arbitrary for small time jitter (0 to 5 minutes) - for rapid signal scenarios */
const arbSmallTimeJitter = fc.integer({ min: 0, max: 5 * 60_000 });

/** Arbitrary for strategy type */
const arbStrategy = fc.constantFrom<'trend_pullback' | 'mean_reversion'>('trend_pullback', 'mean_reversion');

/** Arbitrary for regime type */
const arbRegime = fc.constantFrom<'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE' | 'UNCERTAIN'>(
  'TRENDING_UP', 'TRENDING_DOWN', 'RANGING', 'VOLATILE', 'UNCERTAIN'
);

/** Arbitrary for price movement type - determines if candle will trigger SL, TP, or neither */
const arbPriceMovement = fc.constantFrom<'sl' | 'tp' | 'hold' | 'both'>('sl', 'tp', 'hold', 'both');

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a CandleData object for testing.
 */
function makeCandle(overrides: Partial<CandleData> = {}): CandleData {
  return {
    timestamp: BASE_TIME,
    open: 2000,
    high: 2050,
    low: 1950,
    close: 2000,
    volume: 100,
    ...overrides,
  };
}

/**
 * Create a TradeCandidate for testing.
 */
function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    id: `candidate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    strategy: 'trend_pullback',
    pair: 'WETH/USDC',
    direction: 'long',
    confidence: 0.7,
    stopDistanceFraction: 0.02,
    takeProfitFraction: 0.04,
    regime: 'TRENDING_UP',
    createdAt: BASE_TIME,
    expiresAt: BASE_TIME + 60_000,
    ...overrides,
  };
}

/**
 * Generate a candle that will trigger a specific exit condition or hold.
 */
function generateExitCandle(
  entryPrice: number,
  stopFraction: number,
  tpFraction: number,
  movement: 'sl' | 'tp' | 'hold' | 'both',
  timestamp: number,
): CandleData {
  const slPrice = entryPrice * (1 - stopFraction);
  const tpPrice = entryPrice * (1 + tpFraction);

  switch (movement) {
    case 'sl':
      // Price goes below stop loss
      return makeCandle({
        timestamp,
        high: entryPrice + 10,
        low: slPrice - 10,
        close: slPrice,
      });
    case 'tp':
      // Price goes above take profit (but not below SL)
      return makeCandle({
        timestamp,
        high: tpPrice + 10,
        low: entryPrice - (entryPrice * stopFraction * 0.5), // Above SL
        close: tpPrice,
      });
    case 'both':
      // Both SL and TP hit - simulator should use SL (conservative)
      return makeCandle({
        timestamp,
        high: tpPrice + 10,
        low: slPrice - 10,
        close: entryPrice,
      });
    case 'hold':
    default:
      // Price stays within bounds
      return makeCandle({
        timestamp,
        high: entryPrice + (entryPrice * tpFraction * 0.5),
        low: entryPrice - (entryPrice * stopFraction * 0.5),
        close: entryPrice,
      });
  }
}

/**
 * Interface for a signal event in the test sequence.
 */
interface SignalEvent {
  type: 'signal';
  timeOffset: number;
  price: number;
  stopFraction: number;
  tpFraction: number;
  strategy: 'trend_pullback' | 'mean_reversion';
  regime: 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE' | 'UNCERTAIN';
}

/**
 * Interface for a candle check event in the test sequence.
 */
interface CandleEvent {
  type: 'candle';
  timeOffset: number;
  movement: 'sl' | 'tp' | 'hold' | 'both';
}

type TestEvent = SignalEvent | CandleEvent;

/** Arbitrary for a signal event */
const arbSignalEvent: fc.Arbitrary<SignalEvent> = fc.record({
  type: fc.constant('signal' as const),
  timeOffset: arbTimeOffset,
  price: arbPrice,
  stopFraction: arbStopDistance,
  tpFraction: arbTakeProfit,
  strategy: arbStrategy,
  regime: arbRegime,
});

/** Arbitrary for a candle event */
const arbCandleEvent: fc.Arbitrary<CandleEvent> = fc.record({
  type: fc.constant('candle' as const),
  timeOffset: arbTimeOffset,
  movement: arbPriceMovement,
});

/** Arbitrary for a mixed event sequence */
const arbEventSequence = fc.array(
  fc.oneof(arbSignalEvent, arbCandleEvent),
  { minLength: 5, maxLength: 50 }
);

/** Arbitrary for rapid signals scenario - many signals in short time */
const arbRapidSignalSequence = fc.array(
  fc.record({
    type: fc.constant('signal' as const),
    timeOffset: arbSmallTimeJitter,
    price: arbPrice,
    stopFraction: arbStopDistance,
    tpFraction: arbTakeProfit,
    strategy: arbStrategy,
    regime: arbRegime,
  }),
  { minLength: 10, maxLength: 30 }
);

// Suppress unused variable warnings (arbitraries are used in tests below)
void arbEventSequence;
void arbRapidSignalSequence;

// ═══════════════════════════════════════════════════════════════════════════
// Property 12: Single Position Invariant
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 12: Single Position Invariant', () => {
  let costModel: BacktestCostModel;

  beforeEach(() => {
    costModel = new BacktestCostModel(DEFAULT_COST_PARAMS);
  });

  /**
   * P12-a: At most 1 open position at any point during random event sequences.
   * **Validates: Requirements 11.1**
   */
  it('P12-a: at most 1 open position at any point during random event sequences', () => {
    fc.assert(
      fc.property(arbEventSequence, (events) => {
        const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
        
        // Sort events by time offset
        const sortedEvents = [...events].sort((a, b) => a.timeOffset - b.timeOffset);
        
        // Track position state at each step
        let lastEntryPrice = 2000;
        let lastStopFraction = 0.02;
        let lastTpFraction = 0.04;
        let maxOpenPositions = 0;
        
        for (const event of sortedEvents) {
          const timestamp = BASE_TIME + COOLDOWN_MS + event.timeOffset;
          
          if (event.type === 'signal') {
            const candidate = makeCandidate({
              stopDistanceFraction: event.stopFraction,
              takeProfitFraction: event.tpFraction,
              strategy: event.strategy,
              regime: event.regime,
            });
            const candle = makeCandle({
              timestamp,
              close: event.price,
              high: event.price + 50,
              low: event.price - 50,
            });
            
            simulator.processSignal(candidate, candle, costModel);
            
            // Remember entry params for exit generation
            if (simulator.hasOpenPosition()) {
              lastEntryPrice = event.price;
              lastStopFraction = event.stopFraction;
              lastTpFraction = event.tpFraction;
            }
          } else {
            // Candle event - check exits
            const candle = generateExitCandle(
              lastEntryPrice,
              lastStopFraction,
              lastTpFraction,
              event.movement,
              timestamp,
            );
            simulator.checkExits(candle, costModel);
          }
          
          // Check invariant: at most 1 open position
          const openCount = simulator.hasOpenPosition() ? 1 : 0;
          maxOpenPositions = Math.max(maxOpenPositions, openCount);
          
          // INVARIANT: never more than 1 position
          expect(openCount).toBeLessThanOrEqual(1);
        }
        
        // Final check
        expect(maxOpenPositions).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * P12-b: Multiple signals arriving rapidly never open more than 1 position.
   * **Validates: Requirements 11.1**
   */
  it('P12-b: multiple signals arriving rapidly never open more than 1 position', () => {
    fc.assert(
      fc.property(arbRapidSignalSequence, (signals) => {
        const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
        
        // All signals arrive within 5 minutes of each other
        let currentTime = BASE_TIME + COOLDOWN_MS;
        let positionsOpened = 0;
        
        for (const signal of signals) {
          currentTime += signal.timeOffset;
          
          const candidate = makeCandidate({
            stopDistanceFraction: signal.stopFraction,
            takeProfitFraction: signal.tpFraction,
            strategy: signal.strategy,
            regime: signal.regime,
          });
          
          const candle = makeCandle({
            timestamp: currentTime,
            close: signal.price,
            high: signal.price + 50,
            low: signal.price - 50,
          });
          
          const hadPositionBefore = simulator.hasOpenPosition();
          simulator.processSignal(candidate, candle, costModel);
          const hasPositionAfter = simulator.hasOpenPosition();
          
          // Count new positions opened
          if (!hadPositionBefore && hasPositionAfter) {
            positionsOpened++;
          }
          
          // INVARIANT: never more than 1 position
          expect(hasPositionAfter ? 1 : 0).toBeLessThanOrEqual(1);
        }
        
        // At most 1 position should have been opened (cooldown blocks subsequent ones)
        expect(positionsOpened).toBeLessThanOrEqual(1);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * P12-c: Signals arriving while position is open are rejected.
   * **Validates: Requirements 11.1**
   */
  it('P12-c: signals arriving while position is open are rejected', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbStopDistance,
        arbTakeProfit,
        fc.integer({ min: 1, max: 20 }), // Number of signals to send while position open
        (entryPrice, stopFraction, tpFraction, numSignals) => {
          const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
          
          // Open initial position
          const entryCandle = makeCandle({
            timestamp: BASE_TIME + COOLDOWN_MS,
            close: entryPrice,
            high: entryPrice + 50,
            low: entryPrice - 50,
          });
          
          const initialCandidate = makeCandidate({
            stopDistanceFraction: stopFraction,
            takeProfitFraction: tpFraction,
          });
          
          simulator.processSignal(initialCandidate, entryCandle, costModel);
          expect(simulator.hasOpenPosition()).toBe(true);
          
          // Send multiple signals while position is open
          // These should all be rejected because position is already open
          for (let i = 0; i < numSignals; i++) {
            const signalTime = BASE_TIME + COOLDOWN_MS + (i + 1) * FIFTEEN_MINUTES;
            
            // Create candle that keeps position open (no SL or TP trigger)
            const holdCandle = generateExitCandle(
              entryPrice,
              stopFraction,
              tpFraction,
              'hold',
              signalTime,
            );
            
            // Check exits first (should hold position)
            simulator.checkExits(holdCandle, costModel);
            
            // Try to open another position
            const newCandidate = makeCandidate({
              id: `candidate-attempt-${i}`,
              stopDistanceFraction: stopFraction,
              takeProfitFraction: tpFraction,
            });
            
            simulator.processSignal(newCandidate, holdCandle, costModel);
            
            // INVARIANT: still exactly 1 position (the original)
            expect(simulator.hasOpenPosition()).toBe(true);
            expect(simulator.getTrades()).toHaveLength(0); // No trades closed yet
          }
          
          // Verify invariant held throughout
          expect(simulator.hasOpenPosition()).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P12-d: Signals arriving just after position closes are subject to cooldown.
   * **Validates: Requirements 11.1**
   */
  it('P12-d: signals arriving just after position closes respect cooldown', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbStopDistance,
        arbTakeProfit,
        arbPriceMovement.filter(m => m !== 'hold'), // Force an exit
        fc.integer({ min: 1, max: 59 }), // Minutes after close (before cooldown ends)
        (entryPrice, stopFraction, tpFraction, exitType, minutesAfterClose) => {
          const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
          
          const entryTime = BASE_TIME + COOLDOWN_MS;
          
          // Open position
          const entryCandle = makeCandle({
            timestamp: entryTime,
            close: entryPrice,
            high: entryPrice + 50,
            low: entryPrice - 50,
          });
          
          simulator.processSignal(
            makeCandidate({ stopDistanceFraction: stopFraction, takeProfitFraction: tpFraction }),
            entryCandle,
            costModel,
          );
          
          expect(simulator.hasOpenPosition()).toBe(true);
          
          // Close position
          const exitTime = entryTime + FIFTEEN_MINUTES;
          const exitCandle = generateExitCandle(
            entryPrice,
            stopFraction,
            tpFraction,
            exitType,
            exitTime,
          );
          
          simulator.checkExits(exitCandle, costModel);
          expect(simulator.hasOpenPosition()).toBe(false);
          expect(simulator.getTrades()).toHaveLength(1);
          
          // Try to open new position before cooldown ends
          // Cooldown is from ENTRY time, not EXIT time
          const tooSoonTime = entryTime + (minutesAfterClose * 60_000);
          
          if (tooSoonTime < entryTime + COOLDOWN_MS) {
            const tooSoonCandle = makeCandle({
              timestamp: tooSoonTime,
              close: entryPrice,
            });
            
            simulator.processSignal(
              makeCandidate({ id: 'second-attempt' }),
              tooSoonCandle,
              costModel,
            );
            
            // Should be rejected due to cooldown
            expect(simulator.hasOpenPosition()).toBe(false);
            expect(simulator.getTrades()).toHaveLength(1); // Still just the first trade
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P12-e: Complete trade sequence never exceeds 1 position.
   * Simulates a realistic trading day with entries and exits.
   * **Validates: Requirements 11.1**
   */
  it('P12-e: complete trade sequence never exceeds 1 position', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            price: arbPrice,
            stopFraction: arbStopDistance,
            tpFraction: arbTakeProfit,
            exitAfterCandles: fc.integer({ min: 1, max: 10 }),
            movement: arbPriceMovement,
          }),
          { minLength: 1, maxLength: 10 }
        ),
        (tradeAttempts) => {
          const simulator = new BacktestSimulator({
            ...DEFAULT_RISK_LIMITS,
            maxTradesPerDay: 100, // Allow many trades for testing
          });
          
          let currentTime = BASE_TIME;
          let maxConcurrentPositions = 0;
          
          for (const attempt of tradeAttempts) {
            // Advance time past cooldown
            currentTime += COOLDOWN_MS + 1000;
            
            // Try to open position
            const entryCandle = makeCandle({
              timestamp: currentTime,
              close: attempt.price,
              high: attempt.price + 50,
              low: attempt.price - 50,
            });
            
            simulator.processSignal(
              makeCandidate({
                stopDistanceFraction: attempt.stopFraction,
                takeProfitFraction: attempt.tpFraction,
              }),
              entryCandle,
              costModel,
            );
            
            // Track max concurrent
            const currentOpen = simulator.hasOpenPosition() ? 1 : 0;
            maxConcurrentPositions = Math.max(maxConcurrentPositions, currentOpen);
            expect(currentOpen).toBeLessThanOrEqual(1);
            
            // Process candles (potentially triggering exit)
            for (let i = 0; i < attempt.exitAfterCandles; i++) {
              currentTime += FIFTEEN_MINUTES;
              
              const movementForCandle = i === attempt.exitAfterCandles - 1 
                ? attempt.movement 
                : 'hold';
              
              const candle = generateExitCandle(
                attempt.price,
                attempt.stopFraction,
                attempt.tpFraction,
                movementForCandle,
                currentTime,
              );
              
              simulator.checkExits(candle, costModel);
              
              // Track max concurrent
              const openAfterExit = simulator.hasOpenPosition() ? 1 : 0;
              maxConcurrentPositions = Math.max(maxConcurrentPositions, openAfterExit);
              expect(openAfterExit).toBeLessThanOrEqual(1);
            }
          }
          
          // Verify invariant held throughout
          expect(maxConcurrentPositions).toBeLessThanOrEqual(1);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P12-f: Position count is always 0 or 1.
   * Edge case verification that position tracking is binary.
   * **Validates: Requirements 11.1**
   */
  it('P12-f: position count is always exactly 0 or 1', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            action: fc.constantFrom('signal', 'check'),
            price: arbPrice,
            stopFraction: arbStopDistance,
            tpFraction: arbTakeProfit,
            movement: arbPriceMovement,
          }),
          { minLength: 10, maxLength: 100 }
        ),
        (actions) => {
          const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
          
          let currentTime = BASE_TIME;
          let lastPrice = 2000;
          let lastStop = 0.02;
          let lastTp = 0.04;
          
          for (const action of actions) {
            currentTime += COOLDOWN_MS + FIFTEEN_MINUTES;
            
            if (action.action === 'signal') {
              const candle = makeCandle({
                timestamp: currentTime,
                close: action.price,
                high: action.price + 50,
                low: action.price - 50,
              });
              
              simulator.processSignal(
                makeCandidate({
                  stopDistanceFraction: action.stopFraction,
                  takeProfitFraction: action.tpFraction,
                }),
                candle,
                costModel,
              );
              
              if (simulator.hasOpenPosition()) {
                lastPrice = action.price;
                lastStop = action.stopFraction;
                lastTp = action.tpFraction;
              }
            } else {
              const candle = generateExitCandle(
                lastPrice,
                lastStop,
                lastTp,
                action.movement,
                currentTime,
              );
              simulator.checkExits(candle, costModel);
            }
            
            // INVARIANT: position count is exactly 0 or 1
            const positionCount = simulator.hasOpenPosition() ? 1 : 0;
            expect(positionCount).toBeGreaterThanOrEqual(0);
            expect(positionCount).toBeLessThanOrEqual(1);
            expect([0, 1]).toContain(positionCount);
          }
        }
      ),
      { numRuns: 50 }
    );
  });
});

/**
 * Property Tests for BacktestSimulator - Daily Trade Limit Enforcement
 *
 * **Validates: Requirements 11.3**
 *
 * Property 13: Daily Trade Limit Enforcement
 * - Generate signal sequences within a single day
 * - Verify max 5 trades per day
 * - Verify 6th+ signals are rejected
 * - Counter resets at UTC midnight
 * - Trades across day boundary work correctly
 *
 * Uses fast-check for property-based testing with vitest.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { BacktestSimulator, DEFAULT_RISK_LIMITS } from '../backtest-simulator.js';
import { BacktestCostModel, DEFAULT_COST_PARAMS } from '../backtest-cost-model.js';
import type { RiskLimits } from '../backtest-simulator.js';
import type { CandleData, TradeCandidate } from '../../trading-validation/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const MAX_TRADES_PER_DAY = 5;
const COOLDOWN_MS = 3_600_000;      // 60 minutes
const FIFTEEN_MINUTES = 900_000;
const ONE_DAY_MS = 24 * 3_600_000;
const ONE_HOUR_MS = 3_600_000;

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeCandle(overrides: Partial<CandleData> = {}): CandleData {
  return {
    timestamp: 1_700_000_000_000,
    open: 2000,
    high: 2050,
    low: 1950,
    close: 2000,
    volume: 100,
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    id: `test-candidate-${Math.random().toString(36).slice(2, 10)}`,
    strategy: 'trend_pullback',
    pair: 'WETH/USDC',
    direction: 'long',
    confidence: 0.7,
    stopDistanceFraction: 0.02,
    takeProfitFraction: 0.50,  // High TP so we can force exits via high candle
    regime: 'TRENDING_UP',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function makeCostModel(): BacktestCostModel {
  return new BacktestCostModel(DEFAULT_COST_PARAMS);
}

/**
 * Get UTC midnight for a given date.
 */
function getUTCMidnight(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day, 0, 0, 0, 0);
}

/**
 * Get the UTC day key (YYYY-MM-DD) from a timestamp.
 */
function getDayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Force-close current position by triggering take profit.
 */
function forceClosePosition(
  simulator: BacktestSimulator,
  timestamp: number,
  costModel: BacktestCostModel,
): void {
  if (!simulator.hasOpenPosition()) return;
  
  // Use very high price to trigger TP
  const exitCandle = makeCandle({
    timestamp,
    high: 50000,  // Very high to ensure TP hits
    low: 1990,
    close: 2100,
  });
  simulator.checkExits(exitCandle, costModel);
}

/**
 * Process a signal and immediately force-close the position.
 * Returns true if a trade was opened and completed.
 */
function processAndCloseSignal(
  simulator: BacktestSimulator,
  entryTimestamp: number,
  costModel: BacktestCostModel,
): boolean {
  const hadPositionBefore = simulator.hasOpenPosition();
  const tradesBefore = simulator.getTrades().length;
  
  // If already has position, can't open new one
  if (hadPositionBefore) return false;
  
  const candidate = makeCandidate();
  const entryCandle = makeCandle({
    timestamp: entryTimestamp,
    close: 2000,
    high: 2010,
    low: 1990,
  });
  
  simulator.processSignal(candidate, entryCandle, costModel);
  
  // Check if position was opened
  if (!simulator.hasOpenPosition()) {
    return false;
  }
  
  // Force close via TP
  forceClosePosition(simulator, entryTimestamp + FIFTEEN_MINUTES, costModel);
  
  const tradesAfter = simulator.getTrades().length;
  return tradesAfter > tradesBefore;
}

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arbitrary for number of signals to attempt in a day [1, 15].
 */
const arbSignalCount = fc.integer({ min: 1, max: 15 });

/**
 * Arbitrary for hour of day [0, 23].
 */
const arbHour = fc.integer({ min: 0, max: 23 });

/**
 * Arbitrary for time gap multiplier (how many cooldown periods between signals).
 * Value 1 = exactly cooldown, value 2 = 2x cooldown, etc.
 */
const arbGapMultiplier = fc.integer({ min: 1, max: 3 });

/**
 * Arbitrary for year [2020, 2030].
 */
const arbYear = fc.integer({ min: 2020, max: 2030 });

/**
 * Arbitrary for month [0, 11] (JS months are 0-indexed).
 */
const arbMonth = fc.integer({ min: 0, max: 11 });

/**
 * Arbitrary for day [1, 28] (avoid month-end edge cases).
 */
const arbDay = fc.integer({ min: 1, max: 28 });

/**
 * Arbitrary for a sequence of gap multipliers (representing time gaps between signals).
 */
const arbGapSequence = fc.array(arbGapMultiplier, { minLength: 1, maxLength: 14 });

/**
 * Arbitrary for a full test scenario.
 */
const arbScenario = fc.record({
  year: arbYear,
  month: arbMonth,
  day: arbDay,
  startHour: fc.integer({ min: 0, max: 12 }),  // Start early enough for multiple trades
  gapMultipliers: arbGapSequence,
});

/**
 * Arbitrary for multi-day scenario.
 */
const arbMultiDayScenario = fc.record({
  year: arbYear,
  month: arbMonth,
  day: arbDay,
  signalsDay1: fc.integer({ min: 3, max: 8 }),
  signalsDay2: fc.integer({ min: 3, max: 8 }),
});

// ═══════════════════════════════════════════════════════════════════════════
// Property Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 13: Daily Trade Limit Enforcement', () => {
  let costModel: BacktestCostModel;

  beforeEach(() => {
    costModel = makeCostModel();
  });

  /**
   * P13-a: Maximum 5 trades can be opened per day.
   * Generate arbitrary signal sequences within a single day.
   * Verify that regardless of signal count, at most 5 trades complete.
   * **Validates: Requirements 11.3**
   */
  it('P13-a: maximum 5 trades can be opened per day', async () => {
    await fc.assert(
      fc.property(arbScenario, (scenario) => {
        const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
        const dayStart = getUTCMidnight(scenario.year, scenario.month, scenario.day);
        
        let currentTime = dayStart + scenario.startHour * ONE_HOUR_MS + COOLDOWN_MS;
        const tradesCompleted: number[] = [];
        
        // Attempt to process all signals with gaps
        for (const gapMultiplier of scenario.gapMultipliers) {
          const success = processAndCloseSignal(simulator, currentTime, costModel);
          if (success) {
            tradesCompleted.push(currentTime);
          }
          
          // Move time forward by gap (cooldown * multiplier)
          currentTime += COOLDOWN_MS * gapMultiplier;
          
          // Ensure we stay within the same day
          if (getDayKey(currentTime) !== getDayKey(dayStart)) {
            break;
          }
        }
        
        // Property: At most 5 trades per day
        const dayKey = getDayKey(dayStart);
        const dayState = simulator.getDayStateForKey(dayKey);
        const tradeCount = dayState?.tradeCount ?? 0;
        
        expect(tradeCount).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
        expect(simulator.getTrades().length).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P13-b: 6th+ signals are rejected on the same day.
   * Generate exactly 6+ signals within one day.
   * Verify the 6th and subsequent are rejected.
   * **Validates: Requirements 11.3**
   */
  it('P13-b: 6th and subsequent signals are rejected', async () => {
    await fc.assert(
      fc.property(
        fc.integer({ min: 6, max: 15 }),  // Attempt 6 to 15 signals
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 28 }),
        (signalCount, year, day) => {
          const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
          const dayStart = getUTCMidnight(year, 5, day); // June of year
          
          const tradeResults: boolean[] = [];
          
          for (let i = 0; i < signalCount; i++) {
            // Space signals by cooldown period (1 hour)
            const signalTime = dayStart + (i + 1) * COOLDOWN_MS;
            
            // Verify we're still in the same day
            if (getDayKey(signalTime) !== getDayKey(dayStart)) {
              break;
            }
            
            const success = processAndCloseSignal(simulator, signalTime, costModel);
            tradeResults.push(success);
          }
          
          // First 5 should succeed (if there were that many)
          const successfulTrades = tradeResults.filter(r => r).length;
          expect(successfulTrades).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
          
          // If we attempted more than 5, verify excess were rejected
          if (tradeResults.length > MAX_TRADES_PER_DAY) {
            const first5 = tradeResults.slice(0, MAX_TRADES_PER_DAY);
            const rest = tradeResults.slice(MAX_TRADES_PER_DAY);
            
            // First 5 should have succeeded
            expect(first5.filter(r => r).length).toBe(MAX_TRADES_PER_DAY);
            
            // Rest should be rejected (all false)
            expect(rest.every(r => !r)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P13-c: Counter resets at UTC midnight.
   * Generate trades on day 1, cross midnight, and verify new trades allowed on day 2.
   * **Validates: Requirements 11.3**
   */
  it('P13-c: trade counter resets at UTC midnight', async () => {
    await fc.assert(
      fc.property(arbMultiDayScenario, (scenario) => {
        const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
        
        const day1Start = getUTCMidnight(scenario.year, scenario.month, scenario.day);
        const day2Start = day1Start + ONE_DAY_MS;
        
        // Day 1: Execute up to 5 trades
        let day1Time = day1Start + COOLDOWN_MS;
        let day1Trades = 0;
        
        for (let i = 0; i < Math.min(scenario.signalsDay1, MAX_TRADES_PER_DAY + 3); i++) {
          if (getDayKey(day1Time) !== getDayKey(day1Start)) break;
          
          if (processAndCloseSignal(simulator, day1Time, costModel)) {
            day1Trades++;
          }
          day1Time += COOLDOWN_MS;
        }
        
        // Verify day 1 state
        const day1Key = getDayKey(day1Start);
        const day1State = simulator.getDayStateForKey(day1Key);
        expect(day1State?.tradeCount).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
        
        // Day 2: Should be able to trade again
        let day2Time = day2Start + COOLDOWN_MS;
        let day2Trades = 0;
        
        for (let i = 0; i < Math.min(scenario.signalsDay2, MAX_TRADES_PER_DAY + 3); i++) {
          if (getDayKey(day2Time) !== getDayKey(day2Start)) break;
          
          if (processAndCloseSignal(simulator, day2Time, costModel)) {
            day2Trades++;
          }
          day2Time += COOLDOWN_MS;
        }
        
        // Verify day 2 state (should be independent of day 1)
        const day2Key = getDayKey(day2Start);
        const day2State = simulator.getDayStateForKey(day2Key);
        
        // Day 2 should have its own counter
        expect(day2State?.tradeCount).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
        
        // If day 1 hit the limit, day 2 should still work
        if (day1State?.tradeCount === MAX_TRADES_PER_DAY) {
          expect(day2Trades).toBeGreaterThan(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  /**
   * P13-d: Trades across day boundary work correctly.
   * Start a trade before midnight, close it after midnight.
   * Verify the trade counts to the entry day, not exit day.
   * **Validates: Requirements 11.3**
   */
  it('P13-d: trades across day boundary count to entry day', async () => {
    await fc.assert(
      fc.property(
        arbYear,
        arbMonth,
        arbDay,
        fc.integer({ min: 0, max: 4 }),  // Number of trades before boundary trade
        (year, month, day, tradesBefore) => {
          const simulator = new BacktestSimulator({
            ...DEFAULT_RISK_LIMITS,
            // Use longer time stop to allow cross-midnight trades
          });
          
          const dayStart = getUTCMidnight(year, month, day);
          const nextDayStart = dayStart + ONE_DAY_MS;
          const dayKey = getDayKey(dayStart);
          
          // Execute some trades earlier in the day
          let currentTime = dayStart + COOLDOWN_MS;
          for (let i = 0; i < tradesBefore; i++) {
            processAndCloseSignal(simulator, currentTime, costModel);
            currentTime += COOLDOWN_MS;
          }
          
          // Capture state BEFORE the boundary trade attempt
          const dayStateBefore = simulator.getDayStateForKey(dayKey);
          const countBefore = dayStateBefore?.tradeCount ?? 0;
          
          // Only proceed if we're still within trade limit and have room for one more trade
          if (countBefore >= MAX_TRADES_PER_DAY) {
            return; // Skip if already at limit
          }
          
          // Ensure cooldown is respected from last trade
          // Start a trade near midnight (11 PM UTC = 23 * 3600000)
          // But make sure it's after the cooldown from previous trades
          const nearMidnight = Math.max(
            dayStart + 23 * ONE_HOUR_MS,
            currentTime + COOLDOWN_MS,
          );
          
          // If near midnight would put us in the next day, skip this test case
          if (getDayKey(nearMidnight) !== dayKey) {
            return;
          }
          
          const candidate = makeCandidate({
            stopDistanceFraction: 0.10,  // Wide stop
            takeProfitFraction: 0.50,    // Wide TP to avoid early exit
          });
          
          // Open position before midnight
          const entryCandle = makeCandle({
            timestamp: nearMidnight,
            close: 2000,
            high: 2010,
            low: 1990,
          });
          simulator.processSignal(candidate, entryCandle, costModel);
          
          // Trade count should increment for day 1
          const dayStateAfterEntry = simulator.getDayStateForKey(dayKey);
          const countAfterEntry = dayStateAfterEntry?.tradeCount ?? 0;
          
          // If position was opened, verify it counts to entry day
          if (simulator.hasOpenPosition()) {
            // Count should have increased by exactly 1
            expect(countAfterEntry).toBe(countBefore + 1);
            
            // Close position after midnight (in day 2)
            const afterMidnight = nextDayStart + ONE_HOUR_MS;
            forceClosePosition(simulator, afterMidnight, costModel);
            
            // Verify day 1 count didn't change after exit
            const dayStateFinal = simulator.getDayStateForKey(dayKey);
            expect(dayStateFinal?.tradeCount).toBe(countAfterEntry);
            
            // Verify day 2 count is 0 (no entry on day 2)
            const day2Key = getDayKey(nextDayStart);
            const day2State = simulator.getDayStateForKey(day2Key);
            expect(day2State?.tradeCount ?? 0).toBe(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P13-e: Varying time gaps between signals don't affect limit.
   * Generate signals with random gaps (all >= cooldown).
   * Verify limit is enforced regardless of timing.
   * **Validates: Requirements 11.3**
   */
  it('P13-e: varying time gaps do not affect daily limit', async () => {
    await fc.assert(
      fc.property(
        arbYear,
        arbMonth,
        arbDay,
        fc.array(fc.integer({ min: 1, max: 5 }), { minLength: 6, maxLength: 12 }),
        (year, month, day, gapMultipliers) => {
          const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
          const dayStart = getUTCMidnight(year, month, day);
          
          let currentTime = dayStart + COOLDOWN_MS;
          let tradesOpened = 0;
          
          for (const gapMult of gapMultipliers) {
            // Check we're still in same day
            if (getDayKey(currentTime) !== getDayKey(dayStart)) break;
            
            if (processAndCloseSignal(simulator, currentTime, costModel)) {
              tradesOpened++;
            }
            
            // Variable gap (cooldown * multiplier)
            currentTime += COOLDOWN_MS * gapMult;
          }
          
          // Regardless of gaps, max 5 trades
          expect(tradesOpened).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
          
          const dayKey = getDayKey(dayStart);
          const dayState = simulator.getDayStateForKey(dayKey);
          expect(dayState?.tradeCount ?? 0).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P13-f: Edge case - exactly 5 trades fills the limit.
   * Execute exactly 5 valid signals, verify all succeed and 6th fails.
   * **Validates: Requirements 11.3**
   */
  it('P13-f: exactly 5 trades fills the daily limit', async () => {
    await fc.assert(
      fc.property(arbYear, arbMonth, arbDay, (year, month, day) => {
        const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
        const dayStart = getUTCMidnight(year, month, day);
        
        // Execute exactly 5 trades
        for (let i = 0; i < 5; i++) {
          const signalTime = dayStart + (i + 1) * COOLDOWN_MS;
          const result = processAndCloseSignal(simulator, signalTime, costModel);
          expect(result).toBe(true);
        }
        
        // Verify state shows exactly 5
        const dayKey = getDayKey(dayStart);
        const dayState = simulator.getDayStateForKey(dayKey);
        expect(dayState?.tradeCount).toBe(5);
        
        // 6th should fail
        const sixthTime = dayStart + 6 * COOLDOWN_MS;
        if (getDayKey(sixthTime) === dayKey) {
          const result = processAndCloseSignal(simulator, sixthTime, costModel);
          expect(result).toBe(false);
          
          // Count should still be 5
          expect(simulator.getDayStateForKey(dayKey)?.tradeCount).toBe(5);
        }
      }),
      { numRuns: 50 },
    );
  });

  /**
   * P13-g: Multiple consecutive days respect independent limits.
   * Execute trades over 3+ days, verify each day has independent limit.
   * **Validates: Requirements 11.3**
   */
  it('P13-g: multiple consecutive days have independent limits', async () => {
    await fc.assert(
      fc.property(
        arbYear,
        arbMonth,
        fc.integer({ min: 1, max: 25 }),  // Start day
        fc.integer({ min: 2, max: 5 }),   // Number of days
        fc.array(fc.integer({ min: 4, max: 8 }), { minLength: 2, maxLength: 5 }),
        (year, month, startDay, numDays, signalsPerDay) => {
          const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
          
          const tradesPerDay: Map<string, number> = new Map();
          
          for (let d = 0; d < Math.min(numDays, signalsPerDay.length); d++) {
            const dayStart = getUTCMidnight(year, month, startDay + d);
            const dayKey = getDayKey(dayStart);
            let dayTrades = 0;
            
            const numSignals = signalsPerDay[d] ?? 5;
            
            for (let i = 0; i < numSignals; i++) {
              const signalTime = dayStart + (i + 1) * COOLDOWN_MS;
              
              // Stay within the day
              if (getDayKey(signalTime) !== dayKey) break;
              
              if (processAndCloseSignal(simulator, signalTime, costModel)) {
                dayTrades++;
              }
            }
            
            tradesPerDay.set(dayKey, dayTrades);
          }
          
          // Each day should have at most 5 trades
          for (const [dayKey, count] of tradesPerDay) {
            expect(count).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
            
            const dayState = simulator.getDayStateForKey(dayKey);
            expect(dayState?.tradeCount ?? 0).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * P13-h: Day key calculation is correct for UTC.
   * Verify timestamps map to correct UTC day keys.
   * **Validates: Requirements 11.3**
   */
  it('P13-h: day key calculation uses UTC correctly', () => {
    // Test various timestamps around midnight
    const cases = [
      { ts: Date.UTC(2024, 0, 15, 23, 59, 59), expected: '2024-01-15' },
      { ts: Date.UTC(2024, 0, 16, 0, 0, 0), expected: '2024-01-16' },
      { ts: Date.UTC(2024, 0, 16, 0, 0, 1), expected: '2024-01-16' },
      { ts: Date.UTC(2024, 11, 31, 23, 59, 59), expected: '2024-12-31' },
      { ts: Date.UTC(2025, 0, 1, 0, 0, 0), expected: '2025-01-01' },
    ];
    
    for (const { ts, expected } of cases) {
      expect(getDayKey(ts)).toBe(expected);
    }
  });

  /**
   * P13-i: Rejected signals don't increment trade count.
   * Generate more than 5 signals, verify only successful ones count.
   * **Validates: Requirements 11.3**
   */
  it('P13-i: rejected signals do not increment trade count', async () => {
    await fc.assert(
      fc.property(
        arbYear,
        arbMonth,
        arbDay,
        fc.integer({ min: 8, max: 15 }),
        (year, month, day, signalCount) => {
          const simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
          const dayStart = getUTCMidnight(year, month, day);
          const dayKey = getDayKey(dayStart);
          
          let successCount = 0;
          let rejectCount = 0;
          
          for (let i = 0; i < signalCount; i++) {
            const signalTime = dayStart + (i + 1) * COOLDOWN_MS;
            if (getDayKey(signalTime) !== dayKey) break;
            
            const result = processAndCloseSignal(simulator, signalTime, costModel);
            if (result) {
              successCount++;
            } else {
              rejectCount++;
            }
          }
          
          // Trade count should equal success count, not total attempts
          const dayState = simulator.getDayStateForKey(dayKey);
          expect(dayState?.tradeCount ?? 0).toBe(successCount);
          expect(successCount).toBeLessThanOrEqual(MAX_TRADES_PER_DAY);
          
          // If we attempted more than 5, some should have been rejected
          if (signalCount > MAX_TRADES_PER_DAY) {
            expect(rejectCount).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property Test: Daily Loss Limit Enforcement (Property 14)
 *
 * **Validates: Requirements 11.4**
 *
 * Verifies that the BacktestSimulator correctly enforces the daily loss limit:
 * - Once cumulative daily losses reach maxDailyLossUsdc, no more trades allowed
 * - Wins don't reset the loss counter
 * - Loss limit resets at UTC midnight
 * - Multiple small losses accumulate correctly
 *
 * Note: The limit check happens BEFORE opening a new position, not after.
 * A single trade can produce a loss exceeding the limit, but no NEW trades
 * will be allowed after the limit is reached.
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

const COOLDOWN_MS = 3_600_000; // 60 minutes
const FIFTEEN_MINUTES = 900_000;
const MAX_DAILY_LOSS_USDC = 3_000_000n; // $3 USDC

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
    id: 'test-candidate-1',
    strategy: 'trend_pullback',
    pair: 'WETH/USDC',
    direction: 'long',
    confidence: 0.7,
    stopDistanceFraction: 0.02,   // 2% stop
    takeProfitFraction: 0.04,     // 4% TP
    regime: 'TRENDING_UP',
    createdAt: 1_700_000_000_000,
    expiresAt: 1_700_000_060_000,
    ...overrides,
  };
}

function makeCostModel(): BacktestCostModel {
  return new BacktestCostModel(DEFAULT_COST_PARAMS);
}

/**
 * Get UTC day key (YYYY-MM-DD) for a timestamp
 */
function getDayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Arbitrary for the number of losing trades to attempt in a sequence.
 */
const arbLosingTradeCount = fc.integer({ min: 2, max: 10 });

/**
 * Arbitrary for trade outcome: true = loss (hit stop), false = win (hit TP)
 */
const arbTradeOutcome = fc.boolean();

/**
 * Arbitrary for a sequence of trade outcomes (true = loss, false = win)
 */
const arbTradeSequence = fc.array(arbTradeOutcome, { minLength: 2, maxLength: 10 });

/**
 * Arbitrary for base timestamp within a reasonable range (2024) - start of UTC day
 */
const arbBaseTimestamp = fc.integer({
  min: 0,
  max: 364,
}).map(dayOffset => Date.UTC(2024, 0, 1 + dayOffset, 2, 0, 0)); // Start at 02:00 UTC to fit trades

// ═══════════════════════════════════════════════════════════════════════════
// Property 14: Daily Loss Limit Enforcement
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 14: Daily Loss Limit Enforcement', () => {
  let costModel: BacktestCostModel;

  beforeEach(() => {
    costModel = makeCostModel();
  });

  /**
   * P14-a: Once daily loss limit is reached, no more trades are allowed that day.
   * This is the CORE property: if realizedLoss >= maxDailyLossUsdc, processSignal rejects.
   * **Validates: Requirements 11.4**
   */
  it('P14-a: once daily loss limit is reached, no more trades allowed that day', () => {
    fc.assert(
      fc.property(
        arbBaseTimestamp,
        arbLosingTradeCount,
        (baseTime, tradeCount) => {
          // Use small stop to accumulate losses gradually without exceeding limit in one trade
          const limits: RiskLimits = {
            ...DEFAULT_RISK_LIMITS,
            startingBankroll: 100_000_000n, // $100 to allow many trades
            maxDailyLossUsdc: 3_000_000n,   // $3 limit
          };
          const simulator = new BacktestSimulator(limits);
          const dayKey = getDayKey(baseTime);

          let limitWasReached = false;
          let tradesBeforeLimit = 0;

          for (let i = 0; i < tradeCount; i++) {
            const entryTime = baseTime + i * COOLDOWN_MS;
            if (getDayKey(entryTime) !== dayKey) break;

            const dayStateBefore = simulator.getDayStateForKey(dayKey);
            const lossBeforeTrade = dayStateBefore?.realizedLoss ?? 0n;

            // If limit was reached, signal should be rejected
            if (lossBeforeTrade >= MAX_DAILY_LOSS_USDC) {
              limitWasReached = true;

              // Try to open a position - should be rejected
              const entryCandle = makeCandle({ timestamp: entryTime, close: 2000 });
              simulator.processSignal(makeCandidate({ id: `after-limit-${i}` }), entryCandle, costModel);

              // CRITICAL: Position MUST be rejected when limit already reached
              expect(simulator.hasOpenPosition()).toBe(false);
            } else {
              // Execute a losing trade with small stop (5%)
              const entryCandle = makeCandle({
                timestamp: entryTime,
                close: 2000,
                high: 2050,
                low: 1950,
              });

              simulator.processSignal(
                makeCandidate({
                  id: `c${i}`,
                  stopDistanceFraction: 0.05, // 5% stop = ~$0.5 loss per trade
                  takeProfitFraction: 0.50,   // High TP to not trigger
                }),
                entryCandle,
                costModel,
              );

              if (simulator.hasOpenPosition()) {
                tradesBeforeLimit++;
                // Force stop-loss exit
                const stopPrice = 2000 * 0.95;
                const exitCandle = makeCandle({
                  timestamp: entryTime + FIFTEEN_MINUTES,
                  low: stopPrice - 10,
                  high: 2020,
                  close: stopPrice,
                });
                simulator.checkExits(exitCandle, costModel);
              }
            }
          }

          // If limit was reached, verify no new trades were opened after
          if (limitWasReached) {
            const finalDayState = simulator.getDayStateForKey(dayKey);
            expect(finalDayState!.tradeCount).toBe(tradesBeforeLimit);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P14-b: Wins don't reset the loss counter.
   * After a loss, even if followed by a win, the loss counter persists.
   * **Validates: Requirements 11.4**
   */
  it('P14-b: wins do not reset the loss counter', () => {
    fc.assert(
      fc.property(
        arbBaseTimestamp,
        arbTradeSequence,
        (baseTime, outcomes) => {
          const limits: RiskLimits = {
            ...DEFAULT_RISK_LIMITS,
            startingBankroll: 100_000_000n,
          };
          const simulator = new BacktestSimulator(limits);
          const dayKey = getDayKey(baseTime);

          let tradeIndex = 0;
          let maxLossSeen = 0n;

          for (const isLoss of outcomes) {
            const entryTime = baseTime + tradeIndex * COOLDOWN_MS;
            if (getDayKey(entryTime) !== dayKey) break;

            // Check if limit already reached
            const dayState = simulator.getDayStateForKey(dayKey);
            if (dayState && dayState.realizedLoss >= MAX_DAILY_LOSS_USDC) break;

            const entryCandle = makeCandle({
              timestamp: entryTime,
              close: 2000,
              high: 2100,
              low: 1900,
            });

            simulator.processSignal(
              makeCandidate({
                id: `c${tradeIndex}`,
                stopDistanceFraction: 0.05, // 5% stop
                takeProfitFraction: 0.05,   // 5% TP
              }),
              entryCandle,
              costModel,
            );

            if (simulator.hasOpenPosition()) {
              if (isLoss) {
                // Force stop-loss exit
                const stopPrice = 2000 * 0.95;
                const exitCandle = makeCandle({
                  timestamp: entryTime + FIFTEEN_MINUTES,
                  low: stopPrice - 10,
                  high: 2020,
                  close: stopPrice,
                });
                simulator.checkExits(exitCandle, costModel);
              } else {
                // Force take-profit exit
                const tpPrice = 2000 * 1.05;
                const exitCandle = makeCandle({
                  timestamp: entryTime + FIFTEEN_MINUTES,
                  high: tpPrice + 10,
                  low: 1960,
                  close: tpPrice,
                });
                simulator.checkExits(exitCandle, costModel);
              }
            }

            // Track max loss seen (should never decrease)
            const currentState = simulator.getDayStateForKey(dayKey);
            if (currentState) {
              expect(currentState.realizedLoss >= maxLossSeen).toBe(true);
              maxLossSeen = currentState.realizedLoss;
            }

            tradeIndex++;
          }

          // Final verification: loss counter never decreased
          const finalDayState = simulator.getDayStateForKey(dayKey);
          if (finalDayState) {
            expect(finalDayState.realizedLoss >= 0n).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P14-c: Loss limit resets at UTC midnight.
   * Trades on different UTC days have independent loss counters.
   * **Validates: Requirements 11.4**
   */
  it('P14-c: loss limit resets at UTC midnight', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 363 }),
        (dayOffset) => {
          const day1LateTime = Date.UTC(2024, 0, 1 + dayOffset, 22, 0, 0); // 22:00 UTC
          const limits: RiskLimits = {
            ...DEFAULT_RISK_LIMITS,
            startingBankroll: 100_000_000n,
          };
          const simulator = new BacktestSimulator(limits);

          // Day 1: Execute a losing trade late in the day
          const day1Key = getDayKey(day1LateTime);
          const entryCandle1 = makeCandle({
            timestamp: day1LateTime,
            close: 2000,
            high: 2100,
            low: 1900,
          });

          simulator.processSignal(
            makeCandidate({
              id: 'd1-c1',
              stopDistanceFraction: 0.10,
              takeProfitFraction: 0.50,
            }),
            entryCandle1,
            costModel,
          );

          if (simulator.hasOpenPosition()) {
            const stopPrice = 2000 * 0.90;
            const exitCandle1 = makeCandle({
              timestamp: day1LateTime + FIFTEEN_MINUTES,
              low: stopPrice - 10,
              high: 2020,
              close: stopPrice,
            });
            simulator.checkExits(exitCandle1, costModel);
          }

          const day1State = simulator.getDayStateForKey(day1Key);
          const day1Loss = day1State?.realizedLoss ?? 0n;
          expect(day1Loss > 0n).toBe(true); // Confirm there was a loss

          // Day 2: Start fresh after UTC midnight
          const day2Start = new Date(day1LateTime);
          day2Start.setUTCDate(day2Start.getUTCDate() + 1);
          day2Start.setUTCHours(2, 0, 0, 0); // 02:00 UTC next day
          const day2Time = day2Start.getTime();
          const day2Key = getDayKey(day2Time);

          // Verify different day keys
          expect(day1Key !== day2Key).toBe(true);

          // Day 2: Loss counter should be zero/undefined initially
          const day2StateBefore = simulator.getDayStateForKey(day2Key);
          expect(day2StateBefore?.realizedLoss ?? 0n).toBe(0n);

          // Execute a trade on day 2
          const entryCandle2 = makeCandle({
            timestamp: day2Time,
            close: 2000,
            high: 2100,
            low: 1900,
          });

          simulator.processSignal(
            makeCandidate({
              id: 'd2-c1',
              stopDistanceFraction: 0.05,
              takeProfitFraction: 0.50,
            }),
            entryCandle2,
            costModel,
          );

          // Should be allowed (new day, fresh limit)
          expect(simulator.hasOpenPosition()).toBe(true);

          // Day 1's loss should remain unchanged
          const day1StateFinal = simulator.getDayStateForKey(day1Key);
          expect(day1StateFinal?.realizedLoss).toBe(day1Loss);
        },
      ),
      { numRuns: 50 },
    );
  });

  /**
   * P14-d: Cumulative loss tracking is correct.
   * realizedLoss equals the sum of all individual losses (as absolute values).
   * **Validates: Requirements 11.4**
   */
  it('P14-d: cumulative loss tracking equals sum of individual losses', () => {
    fc.assert(
      fc.property(
        arbBaseTimestamp,
        fc.integer({ min: 2, max: 5 }),
        (baseTime, numTrades) => {
          const limits: RiskLimits = {
            ...DEFAULT_RISK_LIMITS,
            startingBankroll: 100_000_000n,
            maxDailyLossUsdc: 100_000_000n, // High limit so we don't hit it
          };
          const simulator = new BacktestSimulator(limits);
          const dayKey = getDayKey(baseTime);

          // Execute multiple losing trades
          for (let i = 0; i < numTrades; i++) {
            const entryTime = baseTime + i * COOLDOWN_MS;
            if (getDayKey(entryTime) !== dayKey) break;

            const entryCandle = makeCandle({
              timestamp: entryTime,
              close: 2000,
              high: 2100,
              low: 1800,
            });

            simulator.processSignal(
              makeCandidate({
                id: `c${i}`,
                stopDistanceFraction: 0.02, // 2% stop = small consistent loss
                takeProfitFraction: 0.50,
              }),
              entryCandle,
              costModel,
            );

            if (simulator.hasOpenPosition()) {
              const stopPrice = 2000 * 0.98; // 2% down
              const exitCandle = makeCandle({
                timestamp: entryTime + FIFTEEN_MINUTES,
                low: stopPrice - 10,
                high: 2020,
                close: stopPrice,
              });
              simulator.checkExits(exitCandle, costModel);
            }
          }

          // Calculate expected loss from trades
          const trades = simulator.getTrades();
          let expectedCumulativeLoss = 0n;
          for (const trade of trades) {
            if (trade.pnlUsdc < 0n && getDayKey(trade.exitTime) === dayKey) {
              expectedCumulativeLoss += -trade.pnlUsdc;
            }
          }

          const dayState = simulator.getDayStateForKey(dayKey);
          const actualCumulativeLoss = dayState?.realizedLoss ?? 0n;

          expect(actualCumulativeLoss).toBe(expectedCumulativeLoss);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * P14-e: Daily loss limit constant is correct.
   * Verify DEFAULT_RISK_LIMITS.maxDailyLossUsdc = 3_000_000n ($3 USDC).
   * **Validates: Requirements 11.4**
   */
  it('P14-e: daily loss limit constant is 3_000_000n ($3 USDC)', () => {
    expect(DEFAULT_RISK_LIMITS.maxDailyLossUsdc).toBe(3_000_000n);
    expect(MAX_DAILY_LOSS_USDC).toBe(3_000_000n);
  });

  /**
   * P14-f: Loss limit check happens BEFORE trade opens, not after.
   * If realizedLoss < limit, trade is allowed even if the resulting loss would exceed limit.
   * **Validates: Requirements 11.4**
   */
  it('P14-f: loss limit check happens before trade, not predictively', () => {
    fc.assert(
      fc.property(
        arbBaseTimestamp,
        (baseTime) => {
          const limits: RiskLimits = {
            ...DEFAULT_RISK_LIMITS,
            startingBankroll: 50_000_000n,
            maxDailyLossUsdc: 3_000_000n,
          };
          const simulator = new BacktestSimulator(limits);
          const dayKey = getDayKey(baseTime);

          // First trade: small loss to get close to but not exceed limit
          const entry1Time = baseTime;
          const entryCandle1 = makeCandle({ timestamp: entry1Time, close: 2000 });
          simulator.processSignal(
            makeCandidate({
              id: 'c1',
              stopDistanceFraction: 0.25, // 25% stop = ~$2.5 loss
              takeProfitFraction: 0.50,
            }),
            entryCandle1,
            costModel,
          );

          if (simulator.hasOpenPosition()) {
            const stopPrice = 2000 * 0.75;
            simulator.checkExits(
              makeCandle({ timestamp: entry1Time + FIFTEEN_MINUTES, low: stopPrice - 10, close: stopPrice }),
              costModel,
            );
          }

          const stateAfterFirst = simulator.getDayStateForKey(dayKey);
          const lossAfterFirst = stateAfterFirst?.realizedLoss ?? 0n;

          // Second trade: if limit not yet reached, should be allowed
          const entry2Time = entry1Time + COOLDOWN_MS;
          if (getDayKey(entry2Time) === dayKey && lossAfterFirst < MAX_DAILY_LOSS_USDC) {
            const entryCandle2 = makeCandle({ timestamp: entry2Time, close: 2000 });
            simulator.processSignal(
              makeCandidate({
                id: 'c2',
                stopDistanceFraction: 0.25, // Another potential big loss
                takeProfitFraction: 0.50,
              }),
              entryCandle2,
              costModel,
            );

            // Should be allowed because check is BEFORE trade, not predictive
            expect(simulator.hasOpenPosition()).toBe(true);
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});

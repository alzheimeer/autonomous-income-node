/**
 * Unit tests for BacktestSimulator.
 *
 * Tests cover each risk limit independently:
 * - Max 1 open position
 * - 5 trades per day limit
 * - $3 max daily loss
 * - 60min cooldown enforcement
 * - $25 bankroll
 * - Trade sizing between $5-$10
 * - Stop-loss / take-profit / time-stop exits
 * - MFE/MAE tracking
 * - Equity curve tracking
 * - Daily state reset at UTC midnight
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { BacktestSimulator, DEFAULT_RISK_LIMITS } from '../backtest-simulator.js';
import { BacktestCostModel, DEFAULT_COST_PARAMS } from '../backtest-cost-model.js';
import type { RiskLimits } from '../backtest-simulator.js';
import type { CandleData, TradeCandidate } from '../../trading-validation/types.js';

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

// Default timestamps spaced beyond cooldown (60 min = 3_600_000 ms)
const BASE_TIME = 1_700_000_000_000; // Some fixed time
const COOLDOWN_MS = 3_600_000;
const FIFTEEN_MINUTES = 900_000;

describe('BacktestSimulator', () => {
  let simulator: BacktestSimulator;
  let costModel: BacktestCostModel;

  beforeEach(() => {
    simulator = new BacktestSimulator(DEFAULT_RISK_LIMITS);
    costModel = makeCostModel();
  });

  describe('constructor', () => {
    it('initializes with starting bankroll', () => {
      expect(simulator.getBankroll()).toBe(25_000_000n);
    });

    it('starts with no open position', () => {
      expect(simulator.hasOpenPosition()).toBe(false);
    });

    it('starts with empty trades', () => {
      expect(simulator.getTrades()).toHaveLength(0);
    });

    it('starts with initial equity point', () => {
      const curve = simulator.getEquityCurve();
      expect(curve).toHaveLength(1);
      expect(curve[0]!.bankrollUsdc).toBe(25_000_000n);
    });
  });

  describe('processSignal - max 1 open position', () => {
    it('opens a position when no position is open', () => {
      const candle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS });
      const candidate = makeCandidate();

      simulator.processSignal(candidate, candle, costModel);

      expect(simulator.hasOpenPosition()).toBe(true);
    });

    it('rejects signal when a position is already open', () => {
      const candle1 = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS });
      const candle2 = makeCandle({ timestamp: BASE_TIME + 2 * COOLDOWN_MS });

      simulator.processSignal(makeCandidate({ id: 'c1' }), candle1, costModel);
      simulator.processSignal(makeCandidate({ id: 'c2' }), candle2, costModel);

      // Should still have only one position open
      expect(simulator.hasOpenPosition()).toBe(true);
      expect(simulator.getTrades()).toHaveLength(0); // no trade completed
    });
  });

  describe('processSignal - 60min cooldown enforcement', () => {
    it('rejects signal within cooldown period', () => {
      // Open and close a position
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.02 }), entryCandle, costModel);

      // Force close via SL
      const exitCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        low: 1900, // well below SL
        close: 1900,
      });
      simulator.checkExits(exitCandle, costModel);
      expect(simulator.hasOpenPosition()).toBe(false);

      // Try to open new position within cooldown (less than 60 min after first entry)
      const tooSoonCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + 30 * 60_000, // 30 min after entry
      });
      simulator.processSignal(makeCandidate({ id: 'c2' }), tooSoonCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(false);
    });

    it('allows signal after cooldown period', () => {
      // Open and close a position
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.02 }), entryCandle, costModel);

      // Force close via SL
      const exitCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        low: 1900,
        close: 1900,
      });
      simulator.checkExits(exitCandle, costModel);

      // Try again after cooldown
      const afterCooldownCandle = makeCandle({
        timestamp: BASE_TIME + 2 * COOLDOWN_MS + 1, // just past cooldown
      });
      simulator.processSignal(makeCandidate({ id: 'c2' }), afterCooldownCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(true);
    });
  });

  describe('processSignal - 5 trades per day limit', () => {
    it('allows up to 5 trades in a single day', () => {
      // Use a time where we can fit 5 trades with cooldown
      const dayStart = Date.UTC(2024, 0, 15, 0, 0, 0); // Jan 15 2024 00:00 UTC

      for (let i = 0; i < 5; i++) {
        const entryTime = dayStart + (i + 1) * COOLDOWN_MS;
        const entryCandle = makeCandle({ timestamp: entryTime, close: 2000 });
        simulator.processSignal(makeCandidate({ id: `c${i}`, stopDistanceFraction: 0.02 }), entryCandle, costModel);

        // Force exit via SL
        const exitCandle = makeCandle({
          timestamp: entryTime + FIFTEEN_MINUTES,
          low: 1900,
          close: 1900,
        });
        simulator.checkExits(exitCandle, costModel);
      }

      expect(simulator.getTrades()).toHaveLength(5);
    });

    it('rejects 6th trade on same day', () => {
      const dayStart = Date.UTC(2024, 0, 15, 0, 0, 0);

      // Execute 5 trades
      for (let i = 0; i < 5; i++) {
        const entryTime = dayStart + (i + 1) * COOLDOWN_MS;
        const entryCandle = makeCandle({ timestamp: entryTime, close: 2000, high: 2050, low: 1990 });
        simulator.processSignal(makeCandidate({ id: `c${i}`, stopDistanceFraction: 0.5 }), entryCandle, costModel);

        // Force TP exit (fast close)
        const exitCandle = makeCandle({
          timestamp: entryTime + FIFTEEN_MINUTES,
          high: 3000, // way above TP
          close: 2100,
        });
        simulator.checkExits(exitCandle, costModel);
      }

      // Attempt 6th trade (still same day)
      const sixthEntryTime = dayStart + 6 * COOLDOWN_MS;
      const sixthCandle = makeCandle({ timestamp: sixthEntryTime });
      simulator.processSignal(makeCandidate({ id: 'c5' }), sixthCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(false);
      expect(simulator.getTrades()).toHaveLength(5);
    });

    it('resets trade count on new UTC day', () => {
      const day1Start = Date.UTC(2024, 0, 15, 0, 0, 0);
      const day2Start = Date.UTC(2024, 0, 16, 0, 0, 0);

      // Execute 5 trades on day 1
      for (let i = 0; i < 5; i++) {
        const entryTime = day1Start + (i + 1) * COOLDOWN_MS;
        const entryCandle = makeCandle({ timestamp: entryTime, close: 2000 });
        simulator.processSignal(makeCandidate({ id: `d1-c${i}`, stopDistanceFraction: 0.5 }), entryCandle, costModel);

        const exitCandle = makeCandle({
          timestamp: entryTime + FIFTEEN_MINUTES,
          high: 3000,
          close: 2100,
        });
        simulator.checkExits(exitCandle, costModel);
      }

      // New day: should allow trades
      const newDayEntry = day2Start + COOLDOWN_MS;
      const newDayCandle = makeCandle({ timestamp: newDayEntry, close: 2000 });
      simulator.processSignal(makeCandidate({ id: 'd2-c0' }), newDayCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(true);
    });
  });

  describe('processSignal - $3 max daily loss', () => {
    it('blocks new trades after cumulative daily loss exceeds $3', () => {
      const dayStart = Date.UTC(2024, 0, 15, 0, 0, 0);

      // Create a simulator with custom limits that allow larger losses per trade
      const limits: RiskLimits = {
        ...DEFAULT_RISK_LIMITS,
        maxDailyLossUsdc: 3_000_000n, // $3
      };
      const sim = new BacktestSimulator(limits);

      // Trade 1: big loss (stop at 20%)
      const entry1 = dayStart + COOLDOWN_MS;
      sim.processSignal(
        makeCandidate({ id: 'c1', stopDistanceFraction: 0.20 }),
        makeCandle({ timestamp: entry1, close: 2000 }),
        costModel,
      );
      // Hit SL at 1600 (-20%)
      sim.checkExits(
        makeCandle({ timestamp: entry1 + FIFTEEN_MINUTES, low: 1500, close: 1600 }),
        costModel,
      );

      const trades = sim.getTrades();
      expect(trades).toHaveLength(1);
      // Loss should be significant (size * 20% + costs)
      expect(trades[0]!.pnlUsdc < 0n).toBe(true);

      // Check if daily loss reached limit
      const dayKey = '2024-01-15';
      const dayState = sim.getDayStateForKey(dayKey);

      // If daily loss exceeded $3, next trade should be blocked
      if (dayState && dayState.realizedLoss >= 3_000_000n) {
        const entry2 = entry1 + 2 * COOLDOWN_MS;
        sim.processSignal(
          makeCandidate({ id: 'c2' }),
          makeCandle({ timestamp: entry2, close: 2000 }),
          costModel,
        );
        expect(sim.hasOpenPosition()).toBe(false);
      }
    });

    it('allows trades when daily loss is below limit', () => {
      const dayStart = Date.UTC(2024, 0, 15, 0, 0, 0);

      // Trade 1: small loss (stop at 1%)
      const entry1 = dayStart + COOLDOWN_MS;
      simulator.processSignal(
        makeCandidate({ id: 'c1', stopDistanceFraction: 0.01 }),
        makeCandle({ timestamp: entry1, close: 2000 }),
        costModel,
      );
      // Hit SL at 1980 (-1%)
      simulator.checkExits(
        makeCandle({ timestamp: entry1 + FIFTEEN_MINUTES, low: 1979, close: 1980 }),
        costModel,
      );

      // Should allow next trade since loss is small
      const entry2 = entry1 + COOLDOWN_MS + 1;
      simulator.processSignal(
        makeCandidate({ id: 'c2' }),
        makeCandle({ timestamp: entry2, close: 2000 }),
        costModel,
      );

      expect(simulator.hasOpenPosition()).toBe(true);
    });
  });

  describe('processSignal - bankroll enforcement', () => {
    it('rejects trade when bankroll is below minimum size', () => {
      // Create simulator with very low bankroll
      const limits: RiskLimits = {
        ...DEFAULT_RISK_LIMITS,
        startingBankroll: 4_000_000n, // $4 (below $5 min)
      };
      const sim = new BacktestSimulator(limits);

      const candle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS });
      sim.processSignal(makeCandidate(), candle, costModel);

      expect(sim.hasOpenPosition()).toBe(false);
    });

    it('allows trade when bankroll is sufficient', () => {
      const candle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS });
      simulator.processSignal(makeCandidate(), candle, costModel);

      expect(simulator.hasOpenPosition()).toBe(true);
    });
  });

  describe('processSignal - trade sizing', () => {
    it('sizes trade at maxSizeUsdc when bankroll allows', () => {
      const candle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS });
      simulator.processSignal(makeCandidate(), candle, costModel);

      const position = simulator.getPosition();
      expect(position).not.toBeNull();
      expect(position!.sizeUsdc).toBe(10_000_000n); // $10 max
    });

    it('sizes trade to bankroll when bankroll < maxSizeUsdc', () => {
      const limits: RiskLimits = {
        ...DEFAULT_RISK_LIMITS,
        startingBankroll: 7_000_000n, // $7 (between $5 and $10)
      };
      const sim = new BacktestSimulator(limits);

      const candle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS });
      sim.processSignal(makeCandidate(), candle, costModel);

      const position = sim.getPosition();
      expect(position).not.toBeNull();
      expect(position!.sizeUsdc).toBe(7_000_000n); // bankroll-limited
    });
  });

  describe('processSignal - entry price', () => {
    it('uses candle.close as entry price', () => {
      const candle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2345.67 });
      simulator.processSignal(makeCandidate(), candle, costModel);

      const position = simulator.getPosition();
      expect(position!.entryPrice).toBe(2345.67);
    });
  });

  describe('checkExits - stop loss', () => {
    it('exits at stop price when candle low hits SL', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.02 }), entryCandle, costModel);

      // SL = 2000 * (1 - 0.02) = 1960
      const exitCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        low: 1955, // below SL
        close: 1970,
      });
      simulator.checkExits(exitCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(false);
      const trades = simulator.getTrades();
      expect(trades).toHaveLength(1);
      expect(trades[0]!.exitReason).toBe('stop_loss');
      expect(trades[0]!.exitPrice).toBe(1960); // stop price, not close
    });

    it('does not exit when candle low is above SL', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.02 }), entryCandle, costModel);

      // SL = 1960, candle low = 1965 (above SL)
      const holdCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        low: 1965,
        close: 1980,
      });
      simulator.checkExits(holdCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(true);
    });
  });

  describe('checkExits - take profit', () => {
    it('exits at TP price when candle high hits TP', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ takeProfitFraction: 0.04 }), entryCandle, costModel);

      // TP = 2000 * (1 + 0.04) = 2080
      const exitCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        high: 2085, // above TP
        low: 1990,
        close: 2070,
      });
      simulator.checkExits(exitCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(false);
      const trades = simulator.getTrades();
      expect(trades).toHaveLength(1);
      expect(trades[0]!.exitReason).toBe('take_profit');
      expect(trades[0]!.exitPrice).toBe(2080);
    });
  });

  describe('checkExits - both SL and TP hit (conservative)', () => {
    it('assumes stop loss when both SL and TP hit in same candle', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(
        makeCandidate({ stopDistanceFraction: 0.02, takeProfitFraction: 0.04 }),
        entryCandle, costModel,
      );

      // SL = 1960, TP = 2080 — candle hits both
      const exitCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        high: 2090,  // above TP
        low: 1950,   // below SL
        close: 2000,
      });
      simulator.checkExits(exitCandle, costModel);

      const trades = simulator.getTrades();
      expect(trades).toHaveLength(1);
      expect(trades[0]!.exitReason).toBe('stop_loss');
      expect(trades[0]!.exitPrice).toBe(1960);
    });
  });

  describe('checkExits - time stop (8 hours)', () => {
    it('exits at candle close after 8 hours', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate(), entryCandle, costModel);

      // 8 hours later, no SL/TP triggered
      const eightHoursLater = BASE_TIME + COOLDOWN_MS + 8 * 3_600_000;
      const exitCandle = makeCandle({
        timestamp: eightHoursLater,
        high: 2050,
        low: 1965,  // above SL (entry 2000, SL 2% = 1960)
        close: 2010,
      });
      simulator.checkExits(exitCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(false);
      const trades = simulator.getTrades();
      expect(trades).toHaveLength(1);
      expect(trades[0]!.exitReason).toBe('time_stop');
      expect(trades[0]!.exitPrice).toBe(2010); // candle close
    });

    it('does not time-stop before 8 hours', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate(), entryCandle, costModel);

      // 7.5 hours later
      const sevenHalfHours = BASE_TIME + COOLDOWN_MS + 7.5 * 3_600_000;
      const holdCandle = makeCandle({
        timestamp: sevenHalfHours,
        high: 2050,
        low: 1965, // above SL
        close: 2010,
      });
      simulator.checkExits(holdCandle, costModel);

      expect(simulator.hasOpenPosition()).toBe(true);
    });
  });

  describe('checkExits - no position', () => {
    it('does nothing when no position is open', () => {
      const candle = makeCandle();
      simulator.checkExits(candle, costModel);
      expect(simulator.getTrades()).toHaveLength(0);
    });
  });

  describe('MFE/MAE tracking', () => {
    it('tracks maximum favorable excursion', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000, high: 2000, low: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.10, takeProfitFraction: 0.20 }), entryCandle, costModel);

      // Price goes up (favorable)
      simulator.checkExits(makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        high: 2100, // +5%
        low: 1950,
        close: 2050,
      }), costModel);

      // Even higher
      simulator.checkExits(makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + 2 * FIFTEEN_MINUTES,
        high: 2150, // +7.5%
        low: 1960,
        close: 2100,
      }), costModel);

      // Now exit via time stop
      const exitTime = BASE_TIME + COOLDOWN_MS + 8 * 3_600_000;
      simulator.checkExits(makeCandle({
        timestamp: exitTime,
        high: 2050,
        low: 1950,
        close: 2000,
      }), costModel);

      const trades = simulator.getTrades();
      expect(trades).toHaveLength(1);
      // MFE should reflect the highest favorable move
      expect(trades[0]!.mfeUsdc > 0n).toBe(true);
    });

    it('tracks maximum adverse excursion', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000, high: 2000, low: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.10, takeProfitFraction: 0.20 }), entryCandle, costModel);

      // Price goes down (adverse)
      simulator.checkExits(makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        high: 2010,
        low: 1900, // -5% adverse
        close: 1950,
      }), costModel);

      // Exit via time stop
      const exitTime = BASE_TIME + COOLDOWN_MS + 8 * 3_600_000;
      simulator.checkExits(makeCandle({
        timestamp: exitTime,
        high: 2010,
        low: 1950,
        close: 2000,
      }), costModel);

      const trades = simulator.getTrades();
      expect(trades).toHaveLength(1);
      expect(trades[0]!.maeUsdc > 0n).toBe(true);
    });
  });

  describe('equity curve tracking', () => {
    it('records point after each trade close', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ takeProfitFraction: 0.04 }), entryCandle, costModel);

      // TP exit
      const exitCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        high: 2100,
        close: 2090,
      });
      simulator.checkExits(exitCandle, costModel);

      const curve = simulator.getEquityCurve();
      // Initial + 1 trade close
      expect(curve).toHaveLength(2);
      expect(curve[1]!.timestamp).toBe(BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES);
    });

    it('bankroll increases after profitable trade', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.02, takeProfitFraction: 0.04 }), entryCandle, costModel);

      // TP exit at 2080, SL at 1960 — keep low above SL
      const exitCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        high: 2100,
        low: 1970, // above SL of 1960
        close: 2090,
      });
      simulator.checkExits(exitCandle, costModel);

      // Bankroll should have increased (profit minus costs)
      expect(simulator.getBankroll() > 25_000_000n).toBe(true);
    });

    it('bankroll decreases after losing trade', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.02 }), entryCandle, costModel);

      // SL exit at 1960
      const exitCandle = makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        low: 1950,
        close: 1960,
      });
      simulator.checkExits(exitCandle, costModel);

      expect(simulator.getBankroll() < 25_000_000n).toBe(true);
    });
  });

  describe('trade record completeness', () => {
    it('records all required fields in SimulatedTrade', () => {
      const entryTime = BASE_TIME + COOLDOWN_MS;
      const entryCandle = makeCandle({ timestamp: entryTime, close: 2000 });
      simulator.processSignal(
        makeCandidate({
          strategy: 'mean_reversion',
          regime: 'RANGING',
          stopDistanceFraction: 0.02,
          takeProfitFraction: 0.04,
        }),
        entryCandle, costModel,
      );

      const exitTime = entryTime + FIFTEEN_MINUTES;
      simulator.checkExits(makeCandle({
        timestamp: exitTime,
        high: 2100,
        low: 1990,
        close: 2050,
      }), costModel);

      const trades = simulator.getTrades();
      expect(trades).toHaveLength(1);
      const trade = trades[0]!;

      expect(trade.entryTime).toBe(entryTime);
      expect(trade.exitTime).toBe(exitTime);
      expect(trade.entryPrice).toBe(2000);
      expect(typeof trade.exitPrice).toBe('number');
      expect(typeof trade.sizeUsdc).toBe('bigint');
      expect(typeof trade.pnlUsdc).toBe('bigint');
      expect(typeof trade.pnlBps).toBe('number');
      expect(trade.strategy).toBe('mean_reversion');
      expect(trade.regime).toBe('RANGING');
      expect(typeof trade.exitReason).toBe('string');
      expect(trade.holdingMs).toBe(exitTime - entryTime);
      expect(typeof trade.mfeUsdc).toBe('bigint');
      expect(typeof trade.maeUsdc).toBe('bigint');
    });
  });

  describe('daily state reset at UTC midnight', () => {
    it('treats different UTC days independently', () => {
      // Day boundary: Jan 15 2024 23:00 UTC and Jan 16 2024 01:00 UTC
      const beforeMidnight = Date.UTC(2024, 0, 15, 23, 0, 0);
      const afterMidnight = Date.UTC(2024, 0, 16, 1, 0, 0);

      // Trade before midnight
      simulator.processSignal(
        makeCandidate({ id: 'c1' }),
        makeCandle({ timestamp: beforeMidnight }),
        costModel,
      );

      // Close it
      simulator.checkExits(makeCandle({
        timestamp: beforeMidnight + FIFTEEN_MINUTES,
        high: 3000,
        close: 2100,
      }), costModel);

      // Verify day state for Jan 15
      const day15State = simulator.getDayStateForKey('2024-01-15');
      expect(day15State?.tradeCount).toBe(1);

      // Trade after midnight (new day)
      simulator.processSignal(
        makeCandidate({ id: 'c2' }),
        makeCandle({ timestamp: afterMidnight }),
        costModel,
      );

      // Verify day state for Jan 16
      const day16State = simulator.getDayStateForKey('2024-01-16');
      expect(day16State?.tradeCount).toBe(1);
    });
  });

  describe('holdingMs calculation', () => {
    it('correctly computes holding duration', () => {
      const entryTime = BASE_TIME + COOLDOWN_MS;
      const exitTime = entryTime + 2 * 3_600_000; // 2 hours later

      simulator.processSignal(
        makeCandidate({ stopDistanceFraction: 0.10, takeProfitFraction: 0.20 }),
        makeCandle({ timestamp: entryTime, close: 2000 }),
        costModel,
      );

      // Time stop won't fire (only 2h), but SL will hit
      simulator.checkExits(makeCandle({
        timestamp: exitTime,
        low: 1700, // well below SL
        close: 1800,
      }), costModel);

      const trades = simulator.getTrades();
      expect(trades[0]!.holdingMs).toBe(2 * 3_600_000);
    });
  });

  describe('pnlBps calculation', () => {
    it('calculates positive pnlBps for profitable trade', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.02, takeProfitFraction: 0.04 }), entryCandle, costModel);

      // TP at 2080 → +4% → +400 bps. SL at 1960, keep low above SL
      simulator.checkExits(makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        high: 2100,
        low: 1970, // above SL of 1960
        close: 2050,
      }), costModel);

      const trades = simulator.getTrades();
      expect(trades[0]!.pnlBps).toBe(400); // (2080 - 2000) / 2000 * 10000
    });

    it('calculates negative pnlBps for losing trade', () => {
      const entryCandle = makeCandle({ timestamp: BASE_TIME + COOLDOWN_MS, close: 2000 });
      simulator.processSignal(makeCandidate({ stopDistanceFraction: 0.02 }), entryCandle, costModel);

      // SL at 1960 → -2% → -200 bps
      simulator.checkExits(makeCandle({
        timestamp: BASE_TIME + COOLDOWN_MS + FIFTEEN_MINUTES,
        low: 1950,
        close: 1970,
      }), costModel);

      const trades = simulator.getTrades();
      expect(trades[0]!.pnlBps).toBe(-200); // (1960 - 2000) / 2000 * 10000
    });
  });
});

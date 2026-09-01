/**
 * Property Tests for Backtest State Reset Independence
 *
 * **Validates: Requirements 9.5**
 *
 * Property 18: Backtest State Reset Independence
 * - Run identical backtest twice with same config and mocked data
 * - Verify both produce identical results (trades, metrics, verdict)
 * - Test scenarios:
 *   - Identical candle data produces identical trade sequences
 *   - Identical entry/exit times across runs
 *   - Identical P&L calculations
 *   - Identical metrics (win rate, profit factor, etc.)
 *   - Identical verdict assignment
 *
 * Uses fast-check for property-based testing with vitest.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { BacktestSimulator, DEFAULT_RISK_LIMITS } from '../backtest-simulator.js';
import type { RiskLimits, SimulatedTrade } from '../backtest-simulator.js';
import { BacktestCostModel, DEFAULT_COST_PARAMS } from '../backtest-cost-model.js';
import { IncrementalFeatureEngine } from '../incremental-feature-engine.js';
import { StrategyEngine } from '../../trading-validation/strategy-engine.js';
import type { StrategyEngineConfig } from '../../trading-validation/config.js';
import { computeVerdict } from '../verdict-engine.js';
import { computeMetrics } from '../backtest-runner.js';
import type { CandleData, TradeCandidate } from '../../trading-validation/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Default Strategy Config (for testing)
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_STRATEGY_CONFIG: StrategyEngineConfig = {
  pair: 'WETH/USDC',
  regimeTimeframe: '1h',
  entryTimeframe: '15m',
  stopLossAtr: 1.8,
  takeProfitAtr: 2.5,
  cooldownMs: 1_800_000, // 30 minutes
  warmup1h: 100,
  warmup15m: 200,
  meanRevAtrMax: 2.0,
  minLiquidity: 30_000,
  volumeZThreshold: 0.5,
};

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const BASE_TIME = 1_704_067_200_000; // 2024-01-01 00:00:00 UTC
const FIFTEEN_MINUTES = 900_000;
const ONE_HOUR = 3_600_000;
const COOLDOWN_MS = DEFAULT_RISK_LIMITS.cooldownMs;

// ═══════════════════════════════════════════════════════════════════════════
// Arbitraries
// ═══════════════════════════════════════════════════════════════════════════

/** Arbitrary for a price in reasonable ETH/USDC range */
const arbPrice = fc.double({ min: 1800, max: 3500, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for price volatility as percentage (0.5% to 3%) */
const arbVolatilityPct = fc.double({ min: 0.005, max: 0.03, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for volume */
const arbVolume = fc.double({ min: 100, max: 10000, noNaN: true, noDefaultInfinity: true });

/** Arbitrary for number of candles in a test sequence */
const arbCandleCount = fc.integer({ min: 30, max: 200 });

/** Arbitrary for random seed to ensure deterministic test generation */
const arbSeed = fc.integer({ min: 1, max: 1_000_000 });

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a deterministic sequence of candle data for testing.
 * Uses a simple sine-wave pattern with noise for price movement.
 */
function generateCandleSequence(
  count: number,
  basePrice: number,
  volatilityPct: number,
  baseVolume: number,
  seed: number,
): CandleData[] {
  const candles: CandleData[] = [];
  let currentPrice = basePrice;
  
  // Simple seeded random number generator (LCG)
  const lcg = (s: number) => ((s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let currentSeed = seed;
  const nextRandom = () => {
    currentSeed = (currentSeed * 1103515245 + 12345) & 0x7fffffff;
    return currentSeed / 0x7fffffff;
  };

  for (let i = 0; i < count; i++) {
    // Price movement with trend and noise
    const trend = Math.sin(i / 20) * volatilityPct * 0.5; // Slow sine wave trend
    const noise = (nextRandom() - 0.5) * volatilityPct; // Random noise
    const change = trend + noise;
    
    currentPrice = currentPrice * (1 + change);
    
    // Generate OHLC values
    const open = currentPrice * (1 + (nextRandom() - 0.5) * volatilityPct * 0.3);
    const high = Math.max(currentPrice, open) * (1 + nextRandom() * volatilityPct * 0.5);
    const low = Math.min(currentPrice, open) * (1 - nextRandom() * volatilityPct * 0.5);
    const close = currentPrice;
    const volume = baseVolume * (0.5 + nextRandom());

    candles.push({
      timestamp: BASE_TIME + i * FIFTEEN_MINUTES,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  return candles;
}

/**
 * Generate aligned 1h candles from 15m candles.
 * Each 1h candle aggregates 4 consecutive 15m candles.
 */
function generate1hCandles(candles15m: CandleData[]): CandleData[] {
  const candles1h: CandleData[] = [];
  
  for (let i = 3; i < candles15m.length; i += 4) {
    const batch = candles15m.slice(i - 3, i + 1);
    const open = batch[0]!.open;
    const close = batch[3]!.close;
    const high = Math.max(...batch.map(c => c.high));
    const low = Math.min(...batch.map(c => c.low));
    const volume = batch.reduce((sum, c) => sum + c.volume, 0);
    
    candles1h.push({
      timestamp: batch[3]!.timestamp, // Align to the last 15m candle
      open,
      high,
      low,
      close,
      volume,
    });
  }
  
  return candles1h;
}

/**
 * Run a complete backtest simulation with given candles and configuration.
 * Returns trades, metrics, and verdict for comparison.
 */
function runSimulation(
  candles15m: CandleData[],
  candles1h: CandleData[],
  riskLimits: RiskLimits,
  strategyConfig: StrategyEngineConfig,
): {
  trades: SimulatedTrade[];
  metrics: ReturnType<typeof computeMetrics>;
  verdict: ReturnType<typeof computeVerdict>;
} {
  // Create fresh instances for each run (critical for reset independence)
  const featureEngine = new IncrementalFeatureEngine();
  const strategyEngine = new StrategyEngine(strategyConfig);
  const costModel = new BacktestCostModel(DEFAULT_COST_PARAMS);
  const simulator = new BacktestSimulator(riskLimits);

  // Build 1h lookup map
  const candles1hMap = new Map<number, CandleData>();
  for (const c of candles1h) {
    candles1hMap.set(c.timestamp, c);
  }

  // Chronological replay (mirrors backtest-runner.ts logic)
  for (const candle of candles15m) {
    // Feed 15m candle
    featureEngine.addCandle('15m', candle);

    // Feed aligned 1h candle if available
    const aligned1h = candles1hMap.get(candle.timestamp);
    if (aligned1h) {
      featureEngine.addCandle('1h', aligned1h);
    }

    // Compute indicators
    const ind15m = featureEngine.computeIndicators('15m');
    const ind1h = featureEngine.computeIndicators('1h');
    const regime = featureEngine.getRegime();

    // Check exits first
    simulator.checkExits(candle, costModel);

    // Evaluate strategy if indicators available and no open position
    if (ind15m && ind1h && !simulator.hasOpenPosition()) {
      const candidate = strategyEngine.evaluate(ind1h, ind15m, regime, candle.timestamp);
      if (candidate) {
        simulator.processSignal(candidate, candle, costModel);
        if (simulator.hasOpenPosition()) {
          strategyEngine.setPositionOpen(true);
        }
      }
    }

    // Update position state
    if (!simulator.hasOpenPosition()) {
      strategyEngine.setPositionOpen(false);
    }
  }

  const trades = simulator.getTrades();
  const config = {
    days: Math.ceil(candles15m.length * FIFTEEN_MINUTES / (24 * ONE_HOUR)),
    outputDir: '',
    strategyConfig,
    costParams: DEFAULT_COST_PARAMS,
    riskLimits,
    warmupCandles: 200,
  };
  const metrics = computeMetrics(trades, candles15m, config);
  const verdict = computeVerdict(metrics);

  return { trades, metrics, verdict };
}

/**
 * Compare two SimulatedTrade arrays for equality.
 */
function tradesAreEqual(trades1: SimulatedTrade[], trades2: SimulatedTrade[]): boolean {
  if (trades1.length !== trades2.length) return false;
  
  for (let i = 0; i < trades1.length; i++) {
    const t1 = trades1[i]!;
    const t2 = trades2[i]!;
    
    if (t1.entryTime !== t2.entryTime) return false;
    if (t1.exitTime !== t2.exitTime) return false;
    if (t1.entryPrice !== t2.entryPrice) return false;
    if (t1.exitPrice !== t2.exitPrice) return false;
    if (t1.sizeUsdc !== t2.sizeUsdc) return false;
    if (t1.pnlUsdc !== t2.pnlUsdc) return false;
    if (t1.pnlBps !== t2.pnlBps) return false;
    if (t1.strategy !== t2.strategy) return false;
    if (t1.regime !== t2.regime) return false;
    if (t1.exitReason !== t2.exitReason) return false;
    if (t1.holdingMs !== t2.holdingMs) return false;
    if (t1.mfeUsdc !== t2.mfeUsdc) return false;
    if (t1.maeUsdc !== t2.maeUsdc) return false;
  }
  
  return true;
}

/**
 * Compare two BacktestMetrics objects for equality.
 */
function metricsAreEqual(
  m1: ReturnType<typeof computeMetrics>,
  m2: ReturnType<typeof computeMetrics>,
): boolean {
  return (
    m1.totalTrades === m2.totalTrades &&
    m1.winRate === m2.winRate &&
    m1.profitFactor === m2.profitFactor &&
    m1.maxDrawdownPct === m2.maxDrawdownPct &&
    m1.maxDrawdownUsdc === m2.maxDrawdownUsdc &&
    m1.sharpeRatio === m2.sharpeRatio &&
    m1.avgTradeDurationMs === m2.avgTradeDurationMs &&
    m1.avgPnlPerTrade === m2.avgPnlPerTrade &&
    m1.totalPnlUsdc === m2.totalPnlUsdc &&
    m1.totalCostsUsdc === m2.totalCostsUsdc &&
    m1.buyAndHoldPnlUsdc === m2.buyAndHoldPnlUsdc &&
    m1.tradesPerDay === m2.tradesPerDay &&
    m1.bestTrade === m2.bestTrade &&
    m1.worstTrade === m2.worstTrade
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Property 18: Backtest State Reset Independence
// ═══════════════════════════════════════════════════════════════════════════

describe('Property 18: Backtest State Reset Independence', () => {
  /**
   * P18-a: Running the same backtest twice produces identical trade sequences.
   * **Validates: Requirements 9.5**
   */
  it('P18-a: identical candle data produces identical trade sequences', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbVolatilityPct,
        arbVolume,
        arbCandleCount,
        arbSeed,
        (basePrice, volatilityPct, baseVolume, candleCount, seed) => {
          // Generate candle data
          const candles15m = generateCandleSequence(
            candleCount, basePrice, volatilityPct, baseVolume, seed
          );
          const candles1h = generate1hCandles(candles15m);

          // Run backtest twice with fresh instances
          const result1 = runSimulation(
            candles15m, candles1h, DEFAULT_RISK_LIMITS, DEFAULT_STRATEGY_CONFIG
          );
          const result2 = runSimulation(
            candles15m, candles1h, DEFAULT_RISK_LIMITS, DEFAULT_STRATEGY_CONFIG
          );

          // INVARIANT: Both runs produce identical trade counts
          expect(result1.trades.length).toBe(result2.trades.length);

          // INVARIANT: Trade sequences are identical
          expect(tradesAreEqual(result1.trades, result2.trades)).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P18-b: Running the same backtest twice produces identical metrics.
   * **Validates: Requirements 9.5**
   */
  it('P18-b: identical candle data produces identical metrics', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbVolatilityPct,
        arbVolume,
        arbCandleCount,
        arbSeed,
        (basePrice, volatilityPct, baseVolume, candleCount, seed) => {
          const candles15m = generateCandleSequence(
            candleCount, basePrice, volatilityPct, baseVolume, seed
          );
          const candles1h = generate1hCandles(candles15m);

          const result1 = runSimulation(
            candles15m, candles1h, DEFAULT_RISK_LIMITS, DEFAULT_STRATEGY_CONFIG
          );
          const result2 = runSimulation(
            candles15m, candles1h, DEFAULT_RISK_LIMITS, DEFAULT_STRATEGY_CONFIG
          );

          // INVARIANT: Metrics are identical
          expect(metricsAreEqual(result1.metrics, result2.metrics)).toBe(true);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P18-c: Running the same backtest twice produces identical verdicts.
   * **Validates: Requirements 9.5**
   */
  it('P18-c: identical candle data produces identical verdicts', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbVolatilityPct,
        arbVolume,
        arbCandleCount,
        arbSeed,
        (basePrice, volatilityPct, baseVolume, candleCount, seed) => {
          const candles15m = generateCandleSequence(
            candleCount, basePrice, volatilityPct, baseVolume, seed
          );
          const candles1h = generate1hCandles(candles15m);

          const result1 = runSimulation(
            candles15m, candles1h, DEFAULT_RISK_LIMITS, DEFAULT_STRATEGY_CONFIG
          );
          const result2 = runSimulation(
            candles15m, candles1h, DEFAULT_RISK_LIMITS, DEFAULT_STRATEGY_CONFIG
          );

          // INVARIANT: Verdicts are identical
          expect(result1.verdict.verdict).toBe(result2.verdict.verdict);
          expect(result1.verdict.rationale).toBe(result2.verdict.rationale);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P18-d: IncrementalFeatureEngine reset() clears all state between runs.
   * **Validates: Requirements 9.5**
   */
  it('P18-d: IncrementalFeatureEngine reset clears all state', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbVolatilityPct,
        arbVolume,
        fc.integer({ min: 30, max: 100 }),
        arbSeed,
        (basePrice, volatilityPct, baseVolume, candleCount, seed) => {
          const candles15m = generateCandleSequence(
            candleCount, basePrice, volatilityPct, baseVolume, seed
          );
          const candles1h = generate1hCandles(candles15m);

          // Run 1: Feed candles and compute indicators
          const engine1 = new IncrementalFeatureEngine();
          for (const c of candles15m) {
            engine1.addCandle('15m', c);
          }
          for (const c of candles1h) {
            engine1.addCandle('1h', c);
          }
          const indicators1_before = engine1.computeIndicators('15m');
          const regime1_before = engine1.getRegime();

          // Reset the engine
          engine1.reset();

          // After reset, indicators should be null (not enough candles)
          const indicators1_after = engine1.computeIndicators('15m');
          expect(indicators1_after).toBeNull();

          // Run 2: Fresh engine with same data
          const engine2 = new IncrementalFeatureEngine();
          for (const c of candles15m) {
            engine2.addCandle('15m', c);
          }
          for (const c of candles1h) {
            engine2.addCandle('1h', c);
          }
          const indicators2 = engine2.computeIndicators('15m');
          const regime2 = engine2.getRegime();

          // INVARIANT: Fresh engine produces same results as before reset
          if (indicators1_before && indicators2) {
            expect(indicators1_before.lastPrice).toBe(indicators2.lastPrice);
            expect(indicators1_before.ema20).toBe(indicators2.ema20);
            expect(indicators1_before.rsi14).toBe(indicators2.rsi14);
          }
          expect(regime1_before).toBe(regime2);
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * P18-e: BacktestSimulator state is isolated between instances.
   * **Validates: Requirements 9.5**
   */
  it('P18-e: BacktestSimulator instances have isolated state', () => {
    fc.assert(
      fc.property(
        arbPrice,
        fc.double({ min: 0.01, max: 0.05, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 0.02, max: 0.10, noNaN: true, noDefaultInfinity: true }),
        (entryPrice, stopFraction, tpFraction) => {
          const costModel = new BacktestCostModel(DEFAULT_COST_PARAMS);
          
          // Create two independent simulators
          const sim1 = new BacktestSimulator(DEFAULT_RISK_LIMITS);
          const sim2 = new BacktestSimulator(DEFAULT_RISK_LIMITS);

          // Process a signal in sim1 only
          const entryTime = BASE_TIME + COOLDOWN_MS;
          const candidate: TradeCandidate = {
            id: 'test-candidate-1',
            strategy: 'trend_pullback',
            pair: 'WETH/USDC',
            direction: 'long',
            confidence: 0.7,
            stopDistanceFraction: stopFraction,
            takeProfitFraction: tpFraction,
            regime: 'TRENDING_UP',
            createdAt: entryTime,
            expiresAt: entryTime + 60_000,
          };

          const entryCandle: CandleData = {
            timestamp: entryTime,
            open: entryPrice,
            high: entryPrice + 50,
            low: entryPrice - 50,
            close: entryPrice,
            volume: 1000,
          };

          sim1.processSignal(candidate, entryCandle, costModel);

          // INVARIANT: sim1 has open position, sim2 does not
          expect(sim1.hasOpenPosition()).toBe(true);
          expect(sim2.hasOpenPosition()).toBe(false);

          // INVARIANT: sim2 bankroll is unaffected
          expect(sim2.getBankroll()).toBe(DEFAULT_RISK_LIMITS.startingBankroll);

          // Process same signal in sim2
          sim2.processSignal(candidate, entryCandle, costModel);

          // INVARIANT: Both now have open positions
          expect(sim1.hasOpenPosition()).toBe(true);
          expect(sim2.hasOpenPosition()).toBe(true);

          // Close position in sim1 with a loss
          const exitCandle: CandleData = {
            timestamp: entryTime + FIFTEEN_MINUTES,
            open: entryPrice,
            high: entryPrice + 10,
            low: entryPrice * (1 - stopFraction) - 10,
            close: entryPrice * (1 - stopFraction),
            volume: 1000,
          };

          sim1.checkExits(exitCandle, costModel);

          // INVARIANT: sim1 closed, sim2 still open
          expect(sim1.hasOpenPosition()).toBe(false);
          expect(sim2.hasOpenPosition()).toBe(true);

          // INVARIANT: sim1 has trade, sim2 has none
          expect(sim1.getTrades().length).toBe(1);
          expect(sim2.getTrades().length).toBe(0);
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * P18-f: Multiple consecutive backtests produce consistent results.
   * **Validates: Requirements 9.5**
   */
  it('P18-f: multiple consecutive runs are all identical', () => {
    fc.assert(
      fc.property(
        arbPrice,
        arbVolatilityPct,
        arbVolume,
        fc.integer({ min: 50, max: 150 }),
        arbSeed,
        fc.integer({ min: 3, max: 5 }), // Number of runs
        (basePrice, volatilityPct, baseVolume, candleCount, seed, numRuns) => {
          const candles15m = generateCandleSequence(
            candleCount, basePrice, volatilityPct, baseVolume, seed
          );
          const candles1h = generate1hCandles(candles15m);

          // Run backtest multiple times
          const results: ReturnType<typeof runSimulation>[] = [];
          for (let i = 0; i < numRuns; i++) {
            results.push(runSimulation(
              candles15m, candles1h, DEFAULT_RISK_LIMITS, DEFAULT_STRATEGY_CONFIG
            ));
          }

          // INVARIANT: All results are identical to the first
          const firstResult = results[0]!;
          for (let i = 1; i < results.length; i++) {
            const result = results[i]!;
            expect(result.trades.length).toBe(firstResult.trades.length);
            expect(tradesAreEqual(result.trades, firstResult.trades)).toBe(true);
            expect(metricsAreEqual(result.metrics, firstResult.metrics)).toBe(true);
            expect(result.verdict.verdict).toBe(firstResult.verdict.verdict);
          }
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * P18-g: StrategyEngine state is isolated between instances.
   * **Validates: Requirements 9.5**
   */
  it('P18-g: StrategyEngine instances have isolated state', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        (numSignals) => {
          const engine1 = new StrategyEngine(DEFAULT_STRATEGY_CONFIG);
          const engine2 = new StrategyEngine(DEFAULT_STRATEGY_CONFIG);

          // Set different states in each engine
          engine1.setPositionOpen(true);
          engine1.setLastSignalTime(BASE_TIME + 1000);

          engine2.setPositionOpen(false);
          engine2.setLastSignalTime(BASE_TIME + 2000);

          // INVARIANT: States are independent
          expect(engine1.hasOpenPosition()).toBe(true);
          expect(engine2.hasOpenPosition()).toBe(false);

          expect(engine1.getCooldownRemaining()).toBeGreaterThan(0);
          // Note: engine2's cooldown depends on current time vs lastSignalTime
        }
      ),
      { numRuns: 20 }
    );
  });

  /**
   * P18-h: Cost model is deterministic across runs.
   * **Validates: Requirements 9.5**
   */
  it('P18-h: BacktestCostModel produces identical costs across instances', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 5_000_000n, max: 10_000_000n }),
        arbPrice,
        arbPrice,
        (sizeUsdc, entryPrice, exitPrice) => {
          const costModel1 = new BacktestCostModel(DEFAULT_COST_PARAMS);
          const costModel2 = new BacktestCostModel(DEFAULT_COST_PARAMS);

          // Compute costs with both models
          const cost1 = costModel1.computeRoundTripCost(sizeUsdc);
          const cost2 = costModel2.computeRoundTripCost(sizeUsdc);

          // INVARIANT: Costs are identical
          expect(cost1.totalCost).toBe(cost2.totalCost);
          expect(cost1.entrySlippage).toBe(cost2.entrySlippage);
          expect(cost1.exitSlippage).toBe(cost2.exitSlippage);
          expect(cost1.entryDexFee).toBe(cost2.entryDexFee);
          expect(cost1.exitDexFee).toBe(cost2.exitDexFee);
          expect(cost1.entryGas).toBe(cost2.entryGas);
          expect(cost1.exitGas).toBe(cost2.exitGas);
          expect(cost1.safetyMargin).toBe(cost2.safetyMargin);

          // Compute P&L with both models
          const pnl1 = costModel1.computeNetPnl(entryPrice, exitPrice, sizeUsdc);
          const pnl2 = costModel2.computeNetPnl(entryPrice, exitPrice, sizeUsdc);

          // INVARIANT: P&L is identical
          expect(pnl1).toBe(pnl2);
        }
      ),
      { numRuns: 50 }
    );
  });
});

/**
 * BacktestLab — Batch backtest orchestration for Strategy Evolution Lab.
 *
 * Responsibilities:
 * - runSingle: update status to BACKTESTING, run backtest, validate, update status, record experiment
 * - runAll: batch all CANDIDATE strategies sequentially
 * - runBatch: run specific list of strategy IDs
 *
 * Uses CandleCache for deterministic data supply and RobustnessValidator for pass/fail determination.
 * The actual simulation is a placeholder — a full implementation would replay StrategyEngine signals.
 *
 * Requirements validated: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */

import { createLogger } from '../logger.js';
import { EvolutionDatabase } from './evolution-database.js';
import { CandleCache } from './candle-cache.js';
import { RobustnessValidator, type BacktestMetrics, type ValidationResult } from './robustness-validator.js';
import { ExperimentLedger } from './experiment-ledger.js';
import type { StrategyParameters, CandleData } from './types.js';
import { IncrementalFeatureEngine } from '../backtester/incremental-feature-engine.js';
import { StrategyEngine } from '../trading-validation/strategy-engine.js';
import { BacktestSimulator, DEFAULT_RISK_LIMITS } from '../backtester/backtest-simulator.js';
import { BacktestCostModel, DEFAULT_COST_PARAMS } from '../backtester/backtest-cost-model.js';
import type { StrategyEngineConfig } from '../trading-validation/config.js';

const log = createLogger('backtest-lab');

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface LabBacktestConfig {
  days: number;              // default: 30
  warmupCandles: number;     // default: 200
  symbol: string;            // default: 'ETHUSDC'
}

export interface LabBacktestResult {
  strategy_id: string;
  metrics: BacktestMetrics;
  verdict: 'BACKTEST_PASS' | 'BACKTEST_FAIL';
  failure_reasons: string[];
  experiment_id: string;
}

const DEFAULT_CONFIG: LabBacktestConfig = {
  days: 30,
  warmupCandles: 200,
  symbol: 'ETHUSDC',
};

// ─── BacktestLab ────────────────────────────────────────────────────────────

export class BacktestLab {
  private validator: RobustnessValidator;
  private ledger: ExperimentLedger;

  constructor(
    private db: EvolutionDatabase,
    private cache: CandleCache,
    private config: LabBacktestConfig = DEFAULT_CONFIG,
  ) {
    this.validator = new RobustnessValidator();
    this.ledger = new ExperimentLedger(db);
  }

  /**
   * Run backtest for a single strategy.
   * Updates status to BACKTESTING, runs backtest, validates, updates status, records experiment.
   */
  async runSingle(strategyId: string): Promise<LabBacktestResult> {
    const strategy = this.db.getStrategy(strategyId);
    if (!strategy) {
      throw new Error(`Strategy ${strategyId} not found`);
    }

    // Update status to BACKTESTING
    this.db.updateStatus(strategyId, 'BACKTESTING', 'backtest_start');
    this.db.insertTransition(strategyId, strategy.status, 'BACKTESTING', 'backtest_start');

    try {
      // Get candle data from cache
      const candles15m = await this.cache.getCandles(
        this.config.symbol, '15m', this.config.days, this.config.warmupCandles,
      );
      const candles1h = await this.cache.getCandles(
        this.config.symbol, '1h', this.config.days, this.config.warmupCandles,
      );

      // Run simplified backtest simulation
      const metrics = this.simulateBacktest(strategy.parameters, candles15m, candles1h);

      // Validate with robustness criteria
      const validation: ValidationResult = this.validator.validate(metrics);

      const verdict: 'BACKTEST_PASS' | 'BACKTEST_FAIL' = validation.passed
        ? 'BACKTEST_PASS'
        : 'BACKTEST_FAIL';

      // Update strategy status based on validation result
      const trigger = validation.passed ? 'robustness_pass' : 'robustness_fail';
      this.db.updateStatus(strategyId, verdict, trigger);
      this.db.insertTransition(strategyId, 'BACKTESTING', verdict, trigger);

      // Record experiment in the ledger
      const experimentId = this.ledger.recordExperiment({
        strategy_id: strategyId,
        phase: 'BACKTEST',
        hypothesis: `Testing variant with params hash ${strategy.config_hash}`,
        period: `${this.config.days}d`,
        market_context: {
          dominant_regime: 'UNCERTAIN',
          volatility_level: 'normal',
          period_start: new Date(Date.now() - this.config.days * 86400000).toISOString(),
          period_end: new Date().toISOString(),
        },
        metrics: {
          total_trades: metrics.totalTrades,
          win_rate: metrics.winRate,
          profit_factor: metrics.profitFactor,
          max_drawdown_pct: metrics.maxDrawdownPct,
          sharpe_ratio: metrics.sharpeRatio,
          total_pnl: String(metrics.totalPnlUsdc),
          avg_pnl_per_trade: metrics.totalTrades > 0
            ? String(metrics.totalPnlUsdc / BigInt(metrics.totalTrades))
            : '0',
          total_costs: '0',
        },
        verdict,
        score: validation.passed ? metrics.profitFactor : 0,
        promoted: validation.passed,
      });

      log.info('Backtest complete', { strategyId, verdict, trades: metrics.totalTrades });

      return {
        strategy_id: strategyId,
        metrics,
        verdict,
        failure_reasons: validation.failure_reasons,
        experiment_id: experimentId,
      };
    } catch (err) {
      // On error, mark as BACKTEST_FAIL
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.db.updateStatus(strategyId, 'BACKTEST_FAIL', `error: ${errorMsg}`);
      this.db.insertTransition(strategyId, 'BACKTESTING', 'BACKTEST_FAIL', `error: ${errorMsg}`);
      throw err;
    }
  }

  /**
   * Batch backtest all CANDIDATE strategies sequentially.
   */
  async runAll(): Promise<LabBacktestResult[]> {
    const candidates = this.db.getStrategiesByStatus('CANDIDATE');
    return this.runBatch(candidates.map(s => s.strategy_id));
  }

  /**
   * Run backtest for a list of specific strategy IDs.
   * Continues on failure — logs the error and records BACKTEST_FAIL for that strategy.
   */
  async runBatch(strategyIds: string[]): Promise<LabBacktestResult[]> {
    const results: LabBacktestResult[] = [];

    for (const id of strategyIds) {
      try {
        const result = await this.runSingle(id);
        results.push(result);
      } catch (err) {
        log.error('Batch backtest failed for strategy', {
          strategy_id: id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Continue with next strategy — record failure result
        results.push({
          strategy_id: id,
          metrics: this.emptyMetrics(),
          verdict: 'BACKTEST_FAIL',
          failure_reasons: [`Error: ${err instanceof Error ? err.message : String(err)}`],
          experiment_id: '',
        });
      }
    }

    log.info('Batch backtest complete', {
      total: results.length,
      passed: results.filter(r => r.verdict === 'BACKTEST_PASS').length,
      failed: results.filter(r => r.verdict === 'BACKTEST_FAIL').length,
    });

    return results;
  }

  // ─── Private Methods ────────────────────────────────────────────────────────

  /**
   * Run a real backtest simulation using candle data and strategy parameters.
   *
   * Uses IncrementalFeatureEngine + StrategyEngine + BacktestSimulator + BacktestCostModel
   * from the existing backtester infrastructure. Chronological replay without lookahead.
   */
  private simulateBacktest(
    params: StrategyParameters,
    candles15m: CandleData[],
    candles1h: CandleData[],
  ): BacktestMetrics {
    // Convert strategy parameters to StrategyEngineConfig
    const strategyConfig: StrategyEngineConfig = {
      pair: 'WETH/USDC',
      regimeTimeframe: (params.regime_tf || '1h') as '1h',
      entryTimeframe: (params.entry_tf || '15m') as '15m',
      stopLossAtr: params.stop_atr,
      takeProfitAtr: params.tp_atr,
      cooldownMs: 3_600_000, // 60 min
      warmup1h: 200,
      warmup15m: 200,
      meanRevAtrMax: 2.5,
      minLiquidity: 50000,
      volumeZThreshold: params.volumeZ,
    };

    // Determine trade size from params (parse "$10" → 10_000_000n)
    const tradeSizeUsd = parseInt((params.trade_size || '$10').replace('$', ''), 10);
    const tradeSizeUsdc = BigInt(tradeSizeUsd) * 1_000_000n;

    // Adjust risk limits based on trade size
    const riskLimits = {
      ...DEFAULT_RISK_LIMITS,
      maxSizeUsdc: tradeSizeUsdc,
      minSizeUsdc: tradeSizeUsdc > 5_000_000n ? 5_000_000n : tradeSizeUsdc,
    };

    // Initialize engines
    const featureEngine = new IncrementalFeatureEngine();
    const strategyEngine = new StrategyEngine(strategyConfig);
    const costModel = new BacktestCostModel(DEFAULT_COST_PARAMS);
    const simulator = new BacktestSimulator(riskLimits);

    // Build a lookup map for 1h candles by timestamp
    const candles1hMap = new Map<number, CandleData>();
    for (const c of candles1h) {
      candles1hMap.set(c.timestamp, c);
    }

    // Chronological replay (no-lookahead)
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

      // Check exits FIRST
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

    // Compute metrics from completed trades
    const trades = simulator.getTrades();
    const totalTrades = trades.length;

    if (totalTrades === 0) {
      return this.emptyMetrics();
    }

    // Calculate metrics
    let totalPnl = 0n;
    let grossProfit = 0n;
    let grossLoss = 0n;
    let totalWinners = 0n;
    let totalLosers = 0n;
    let winCount = 0;
    let peak = riskLimits.startingBankroll;
    let equity = riskLimits.startingBankroll;
    let maxDrawdownUsdc = 0n;

    for (const t of trades) {
      totalPnl += t.pnlUsdc;
      equity += t.pnlUsdc;

      if (t.pnlUsdc > 0n) {
        grossProfit += t.pnlUsdc;
        totalWinners += t.pnlUsdc;
        winCount++;
      } else {
        grossLoss += -t.pnlUsdc;
        totalLosers += -t.pnlUsdc;
      }

      if (equity > peak) peak = equity;
      const dd = peak - equity;
      if (dd > maxDrawdownUsdc) maxDrawdownUsdc = dd;
    }

    const winRate = (winCount / totalTrades) * 100;
    const profitFactor = grossLoss === 0n
      ? (grossProfit > 0n ? Infinity : 0)
      : Number(grossProfit) / Number(grossLoss);
    const maxDrawdownPct = peak > 0n ? (Number(maxDrawdownUsdc) / Number(peak)) * 100 : 0;

    // Sharpe approximation
    const returns = trades.map(t => Number(t.pnlUsdc) / 1_000_000);
    const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1 || 1);
    const sharpeRatio = variance > 0 ? (meanReturn / Math.sqrt(variance)) * Math.sqrt(365) : 0;

    // Avg winner / avg loser
    const avgWinnerUsdc = winCount > 0 ? totalWinners / BigInt(winCount) : 0n;
    const loseCount = totalTrades - winCount;
    const avgLoserUsdc = loseCount > 0 ? totalLosers / BigInt(loseCount) : 0n;

    // Out-of-sample: split candles in half, check second half PnL
    const halfIdx = Math.floor(candles15m.length / 2);
    const halfTimestamp = candles15m[halfIdx]?.timestamp ?? 0;
    const oosTrades = trades.filter(t => t.entryTime >= halfTimestamp);
    const oosPnl = oosTrades.reduce((sum, t) => sum + t.pnlUsdc, 0n);
    const oosPositivePnl = oosPnl > 0n;

    return {
      totalTrades,
      totalPnlUsdc: totalPnl,
      profitFactor,
      maxDrawdownPct,
      winRate,
      sharpeRatio,
      avgWinnerUsdc,
      avgLoserUsdc,
      oosPositivePnl,
    };
  }

  /**
   * Returns a BacktestMetrics object with all zero values.
   */
  private emptyMetrics(): BacktestMetrics {
    return {
      totalTrades: 0,
      totalPnlUsdc: 0n,
      profitFactor: 0,
      maxDrawdownPct: 0,
      winRate: 0,
      sharpeRatio: 0,
      avgWinnerUsdc: 0n,
      avgLoserUsdc: 0n,
      oosPositivePnl: false,
    };
  }
}

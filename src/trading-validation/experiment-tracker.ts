/**
 * Experiment Tracker - Trading Validation Phase
 *
 * Records every trade with full metadata + config hash.
 * Evaluates Shadow Pass and Micro Pass criteria.
 * Compares performance against benchmarks (hold-WETH, Aave yield).
 * Config hash change invalidates experiment data.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 25.1, 25.2
 */

import type { Position, TradingMode, UsdcAmount } from './types.js';
import type { ExperimentConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** Recorded trade with metadata for experiment tracking */
export interface ExperimentTrade {
  position: Position;
  mode: TradingMode;
  configHash: string;
  recordedAt: number;
  valid: boolean; // false if config hash changed after recording
}

/** Pass/fail result with reasons */
export interface PassResult {
  passed: boolean;
  reasons: string[];
}

/** Benchmark comparison data */
export interface BenchmarkComparison {
  holdWethReturn: number;       // % return of holding WETH over experiment period
  aaveYield: UsdcAmount;        // estimated Aave yield over experiment period
  strategyReturn: number;       // % return of the strategy
  outperformsHoldWeth: boolean;
  outperformsAave: boolean;
}

/** Summary report of the experiment */
export interface ExperimentReport {
  mode: TradingMode;
  configHash: string;
  totalTrades: number;
  validTrades: number;
  invalidatedTrades: number;
  netPnl: UsdcAmount;
  grossWins: UsdcAmount;
  grossLosses: UsdcAmount;
  profitFactor: number;
  maxDrawdown: UsdcAmount;
  failedTxRate: number;
  avgSlippageDev: number;
  sharpeRatio: number | null;    // null if sample < 20
  winRate: number;
  avgHoldingMs: number;
  experimentDays: number;
  shadowPass: PassResult;
  microPass: PassResult;
  benchmark: BenchmarkComparison;
  reconMismatches: number;
  operatorConfirmed: boolean;
}

/** External data provider for failed tx and recon info */
export interface IExperimentDataProvider {
  getFailedTxCount(): number;
  getTotalTxCount(): number;
  getReconMismatchCount(): number;
  getSlippageDeviations(): number[]; // array of slippage_actual / slippage_estimated ratios
  getWethPriceAtStart(): number;
  getWethPriceNow(): number;
}

/** Logger callback */
export type ExperimentLogger = (entry: {
  event: string;
  details: Record<string, unknown>;
}) => void;

/** The main ExperimentTracker interface (matches design doc canonical IExperimentTracker) */
export interface IExperimentTracker {
  recordTrade(trade: Position, mode: TradingMode): void;
  checkShadowPass(): PassResult;
  checkMicroPass(): PassResult;
  getReport(): ExperimentReport;
  getConfigHash(): string;
  isConfigChanged(currentHash: string): boolean;
  // Extended methods beyond canonical interface
  invalidateOnConfigChange(newHash: string): void;
  getTradeCount(): number;
  getNetPnl(): UsdcAmount;
  getBenchmarkComparison(): BenchmarkComparison;
  setOperatorConfirmed(confirmed: boolean): void;
  isOperatorConfirmed(): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Aave yield approximation: ~7% APY on ~$100 = ~$0.02/day */
const AAVE_DAILY_YIELD_USDC = 20_000n; // $0.02 in 6-decimal USDC

/** Annualization factor for Sharpe: sqrt(365) */
const SQRT_365 = Math.sqrt(365);

/** Minimum sample for Sharpe ratio calculation */
const SHARPE_MIN_SAMPLE = 20;

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class ExperimentTracker implements IExperimentTracker {
  private trades: ExperimentTrade[] = [];
  private currentConfigHash: string;
  private readonly config: ExperimentConfig;
  private readonly dataProvider: IExperimentDataProvider;
  private readonly logger?: ExperimentLogger;
  private operatorConfirmed = false;
  private experimentStartTime: number;

  constructor(
    config: ExperimentConfig,
    dataProvider: IExperimentDataProvider,
    logger?: ExperimentLogger,
  ) {
    this.config = config;
    this.currentConfigHash = config.configHash;
    this.dataProvider = dataProvider;
    this.logger = logger;
    this.experimentStartTime = Date.now();
  }

  // ─── Core Methods ─────────────────────────────────────────────────────

  recordTrade(trade: Position, mode: TradingMode): void {
    const record: ExperimentTrade = {
      position: trade,
      mode,
      configHash: this.currentConfigHash,
      recordedAt: Date.now(),
      valid: true,
    };

    this.trades.push(record);

    this.logger?.({
      event: 'trade_recorded',
      details: {
        positionId: trade.id,
        mode,
        configHash: this.currentConfigHash,
        netPnl: trade.netPnl?.toString() ?? '0',
        strategy: trade.strategy,
        exitReason: trade.exitReason ?? 'none',
      },
    });
  }

  checkShadowPass(): PassResult {
    const reasons: string[] = [];
    const validTrades = this.getValidTrades('shadow');
    const tradeCount = validTrades.length;
    const netPnl = this.computeNetPnl(validTrades);
    const experimentDays = this.getExperimentDays();

    // Criterion 1: ≥10 trades minimum
    if (tradeCount < this.config.shadowPassMinTrades) {
      reasons.push(
        `Insufficient trades: ${tradeCount}/${this.config.shadowPassMinTrades} minimum`,
      );
    }

    // Criterion 2: (≥20 trades OR 7 days elapsed)
    const hasTargetTrades = tradeCount >= this.config.shadowPassTargetTrades;
    const hasDaysElapsed = experimentDays >= this.config.shadowPassDays;
    if (!hasTargetTrades && !hasDaysElapsed) {
      reasons.push(
        `Need ${this.config.shadowPassTargetTrades} trades OR ${this.config.shadowPassDays} days. ` +
        `Have ${tradeCount} trades and ${experimentDays} days`,
      );
    }

    // Criterion 3: Net P&L ≥ 0
    if (netPnl < 0n) {
      reasons.push(`Net P&L negative: ${netPnl.toString()} USDC`);
    }

    // Criterion 4: No bugs (recon mismatches = 0)
    const reconMismatches = this.dataProvider.getReconMismatchCount();
    if (reconMismatches > 0) {
      reasons.push(`Reconciliation mismatches detected: ${reconMismatches}`);
    }

    // Criterion 5: Operator confirmation
    if (!this.operatorConfirmed) {
      reasons.push('Operator confirmation required');
    }

    // Sharpe > 0.5 required only when sample ≥ 20
    if (tradeCount >= SHARPE_MIN_SAMPLE) {
      const sharpe = this.computeSharpe(validTrades);
      if (sharpe !== null && sharpe < 0.5) {
        reasons.push(`Sharpe ratio too low: ${sharpe.toFixed(3)} < 0.5`);
      }
    }

    const passed = reasons.length === 0;

    this.logger?.({
      event: 'shadow_pass_check',
      details: { passed, reasons, tradeCount, netPnl: netPnl.toString(), experimentDays },
    });

    return { passed, reasons };
  }

  checkMicroPass(): PassResult {
    const reasons: string[] = [];
    const validTrades = this.getValidTrades('micro');
    const tradeCount = validTrades.length;
    const netPnl = this.computeNetPnl(validTrades);
    const { grossWins, grossLosses } = this.computeGrossWinsLosses(validTrades);
    const maxDrawdown = this.computeMaxDrawdown(validTrades);
    const profitFactor = grossLosses > 0n
      ? Number(grossWins) / Number(grossLosses)
      : grossWins > 0n ? Infinity : 0;

    // Criterion 1: 20+ trades
    if (tradeCount < this.config.microPassMinTrades) {
      reasons.push(
        `Insufficient trades: ${tradeCount}/${this.config.microPassMinTrades}`,
      );
    }

    // Criterion 2: Positive net P&L
    if (netPnl <= 0n) {
      reasons.push(`Net P&L not positive: ${netPnl.toString()} USDC`);
    }

    // Criterion 3: Profit factor > 1.2
    if (profitFactor <= this.config.microPassProfitFactor) {
      reasons.push(
        `Profit factor too low: ${profitFactor.toFixed(3)} ≤ ${this.config.microPassProfitFactor}`,
      );
    }

    // Criterion 4: Drawdown < $10
    if (maxDrawdown > this.config.microPassMaxDrawdown) {
      reasons.push(
        `Max drawdown exceeded: ${maxDrawdown.toString()} > ${this.config.microPassMaxDrawdown.toString()}`,
      );
    }

    // Criterion 5: Failed tx < 10%
    const totalTx = this.dataProvider.getTotalTxCount();
    const failedTx = this.dataProvider.getFailedTxCount();
    const failedRate = totalTx > 0 ? failedTx / totalTx : 0;
    if (failedRate >= this.config.microPassMaxFailedRate) {
      reasons.push(
        `Failed tx rate too high: ${(failedRate * 100).toFixed(1)}% ≥ ${(this.config.microPassMaxFailedRate * 100).toFixed(1)}%`,
      );
    }

    // Criterion 6: Slippage deviation < 1.5x
    const slippageDevs = this.dataProvider.getSlippageDeviations();
    const avgSlippageDev = slippageDevs.length > 0
      ? slippageDevs.reduce((a, b) => a + b, 0) / slippageDevs.length
      : 0;
    if (avgSlippageDev >= this.config.microPassMaxSlippageDev) {
      reasons.push(
        `Avg slippage deviation too high: ${avgSlippageDev.toFixed(3)}x ≥ ${this.config.microPassMaxSlippageDev}x`,
      );
    }

    // Criterion 7: No recon mismatch
    const reconMismatches = this.dataProvider.getReconMismatchCount();
    if (reconMismatches > 0) {
      reasons.push(`Reconciliation mismatches: ${reconMismatches}`);
    }

    // Sharpe > 0.5 required only when sample ≥ 20
    if (tradeCount >= SHARPE_MIN_SAMPLE) {
      const sharpe = this.computeSharpe(validTrades);
      if (sharpe !== null && sharpe < 0.5) {
        reasons.push(`Sharpe ratio too low: ${sharpe.toFixed(3)} < 0.5`);
      }
    }

    const passed = reasons.length === 0;

    this.logger?.({
      event: 'micro_pass_check',
      details: {
        passed, reasons, tradeCount,
        netPnl: netPnl.toString(), profitFactor,
        maxDrawdown: maxDrawdown.toString(), failedRate, avgSlippageDev,
      },
    });

    return { passed, reasons };
  }

  getSummaryReport(): ExperimentReport {
    return this.getReport();
  }

  getReport(): ExperimentReport {
    const allValid = this.getValidTrades();
    const shadowTrades = this.getValidTrades('shadow');
    const microTrades = this.getValidTrades('micro');
    const mode: TradingMode = microTrades.length > 0 ? 'micro' : 'shadow';
    const activeTrades = mode === 'micro' ? microTrades : shadowTrades;

    const netPnl = this.computeNetPnl(activeTrades);
    const { grossWins, grossLosses } = this.computeGrossWinsLosses(activeTrades);
    const maxDrawdown = this.computeMaxDrawdown(activeTrades);
    const profitFactor = grossLosses > 0n
      ? Number(grossWins) / Number(grossLosses)
      : grossWins > 0n ? Infinity : 0;

    const totalTx = this.dataProvider.getTotalTxCount();
    const failedTx = this.dataProvider.getFailedTxCount();
    const failedRate = totalTx > 0 ? failedTx / totalTx : 0;

    const slippageDevs = this.dataProvider.getSlippageDeviations();
    const avgSlippageDev = slippageDevs.length > 0
      ? slippageDevs.reduce((a, b) => a + b, 0) / slippageDevs.length
      : 0;

    const sharpe = this.computeSharpe(activeTrades);
    const winCount = activeTrades.filter(t => (t.position.netPnl ?? 0n) > 0n).length;
    const winRate = activeTrades.length > 0 ? winCount / activeTrades.length : 0;

    const avgHoldingMs = this.computeAvgHoldingMs(activeTrades);
    const experimentDays = this.getExperimentDays();

    return {
      mode,
      configHash: this.currentConfigHash,
      totalTrades: this.trades.length,
      validTrades: allValid.length,
      invalidatedTrades: this.trades.filter(t => !t.valid).length,
      netPnl,
      grossWins,
      grossLosses,
      profitFactor,
      maxDrawdown,
      failedTxRate: failedRate,
      avgSlippageDev,
      sharpeRatio: sharpe,
      winRate,
      avgHoldingMs,
      experimentDays,
      shadowPass: this.checkShadowPass(),
      microPass: this.checkMicroPass(),
      benchmark: this.getBenchmarkComparison(),
      reconMismatches: this.dataProvider.getReconMismatchCount(),
      operatorConfirmed: this.operatorConfirmed,
    };
  }

  invalidateOnConfigChange(newHash: string): void {
    if (newHash === this.currentConfigHash) {
      return;
    }

    // Invalidate all trades with old hash
    for (const trade of this.trades) {
      if (trade.configHash !== newHash) {
        trade.valid = false;
      }
    }

    this.logger?.({
      event: 'config_hash_changed',
      details: {
        oldHash: this.currentConfigHash,
        newHash,
        invalidatedCount: this.trades.filter(t => !t.valid).length,
      },
    });

    this.currentConfigHash = newHash;
    // Reset experiment start for new config
    this.experimentStartTime = Date.now();
  }

  getConfigHash(): string {
    return this.currentConfigHash;
  }

  isConfigChanged(currentHash: string): boolean {
    return currentHash !== this.currentConfigHash;
  }

  getTradeCount(): number {
    return this.getValidTrades().length;
  }

  getNetPnl(): UsdcAmount {
    return this.computeNetPnl(this.getValidTrades());
  }

  getBenchmarkComparison(): BenchmarkComparison {
    const experimentDays = this.getExperimentDays();
    const validTrades = this.getValidTrades();
    const netPnl = this.computeNetPnl(validTrades);

    // Hold-WETH benchmark: price appreciation over experiment period
    const wethStart = this.dataProvider.getWethPriceAtStart();
    const wethNow = this.dataProvider.getWethPriceNow();
    const holdWethReturn = wethStart > 0
      ? ((wethNow - wethStart) / wethStart) * 100
      : 0;

    // Aave yield benchmark: ~$0.02/day at 7% APY on ~$100
    const aaveYield = AAVE_DAILY_YIELD_USDC * BigInt(Math.max(1, experimentDays));

    // Strategy return (% of starting bankroll ~$25 active)
    // Using active bankroll denominator of $25 (25_000_000)
    const activeBankroll = 25_000_000n;
    const strategyReturn = activeBankroll > 0n
      ? (Number(netPnl) / Number(activeBankroll)) * 100
      : 0;

    return {
      holdWethReturn,
      aaveYield,
      strategyReturn,
      outperformsHoldWeth: strategyReturn > holdWethReturn,
      outperformsAave: netPnl > aaveYield,
    };
  }

  setOperatorConfirmed(confirmed: boolean): void {
    this.operatorConfirmed = confirmed;
    this.logger?.({
      event: 'operator_confirmation',
      details: { confirmed },
    });
  }

  isOperatorConfirmed(): boolean {
    return this.operatorConfirmed;
  }

  // ─── Private Helpers ──────────────────────────────────────────────────

  private getValidTrades(mode?: TradingMode): ExperimentTrade[] {
    return this.trades.filter(t => {
      if (!t.valid) return false;
      if (t.configHash !== this.currentConfigHash) return false;
      if (mode && t.mode !== mode) return false;
      return true;
    });
  }

  private computeNetPnl(trades: ExperimentTrade[]): UsdcAmount {
    let total = 0n;
    for (const trade of trades) {
      total += trade.position.netPnl ?? 0n;
    }
    return total;
  }

  private computeGrossWinsLosses(trades: ExperimentTrade[]): {
    grossWins: UsdcAmount;
    grossLosses: UsdcAmount;
  } {
    let grossWins = 0n;
    let grossLosses = 0n;
    for (const trade of trades) {
      const pnl = trade.position.netPnl ?? 0n;
      if (pnl > 0n) {
        grossWins += pnl;
      } else if (pnl < 0n) {
        grossLosses += -pnl; // absolute value
      }
    }
    return { grossWins, grossLosses };
  }

  private computeMaxDrawdown(trades: ExperimentTrade[]): UsdcAmount {
    let peak = 0n;
    let equity = 0n;
    let maxDrawdown = 0n;

    for (const trade of trades) {
      equity += trade.position.netPnl ?? 0n;
      if (equity > peak) {
        peak = equity;
      }
      const drawdown = peak - equity;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }
    return maxDrawdown;
  }

  private computeSharpe(trades: ExperimentTrade[]): number | null {
    if (trades.length < SHARPE_MIN_SAMPLE) {
      return null;
    }

    const pnls = trades.map(t => Number(t.position.netPnl ?? 0n));
    const n = pnls.length;
    const mean = pnls.reduce((a, b) => a + b, 0) / n;

    const variance = pnls.reduce((acc, p) => acc + (p - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);

    if (stddev === 0) {
      return mean > 0 ? Infinity : mean < 0 ? -Infinity : 0;
    }

    // Daily Sharpe annualized with sqrt(365)
    const dailySharpe = mean / stddev;
    return dailySharpe * SQRT_365;
  }

  private computeAvgHoldingMs(trades: ExperimentTrade[]): number {
    if (trades.length === 0) return 0;

    let totalHolding = 0;
    let countWithExit = 0;
    for (const trade of trades) {
      const p = trade.position;
      if (p.exitTimestamp && p.entryTimestamp) {
        totalHolding += p.exitTimestamp - p.entryTimestamp;
        countWithExit++;
      }
    }
    return countWithExit > 0 ? totalHolding / countWithExit : 0;
  }

  private getExperimentDays(): number {
    const elapsed = Date.now() - this.experimentStartTime;
    return Math.floor(elapsed / (24 * 60 * 60 * 1000));
  }
}

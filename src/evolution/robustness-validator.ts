/**
 * Robustness Validator — evaluates backtest results against 8 criteria
 * for BACKTEST_PASS or BACKTEST_FAIL determination.
 *
 * All 8 criteria must pass for the strategy to advance.
 * Requirements: 7.3, 7.4, 7.5
 */

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface RobustnessCriteria {
  min_trades: number;           // >= 30
  min_pnl: bigint;              // > 0
  min_profit_factor: number;    // > 1.25
  max_drawdown_pct: number;     // < 5%
  oos_positive_pnl: boolean;    // out-of-sample positive
  min_win_rate: number;         // > 35%
  min_winner_ratio: number;     // avg winner > 1.5x avg loser
  min_sharpe: number;           // > 0.5
}

export const DEFAULT_ROBUSTNESS_CRITERIA: RobustnessCriteria = {
  min_trades: 30,
  min_pnl: 0n,
  min_profit_factor: 1.25,
  max_drawdown_pct: 5.0,
  oos_positive_pnl: true,
  min_win_rate: 35,
  min_winner_ratio: 1.5,
  min_sharpe: 0.5,
};

export interface BacktestMetrics {
  totalTrades: number;
  totalPnlUsdc: bigint;         // net PnL in 6-decimal USDC
  profitFactor: number;
  maxDrawdownPct: number;
  winRate: number;              // percentage (0-100)
  sharpeRatio: number;
  avgWinnerUsdc: bigint;        // average winning trade PnL
  avgLoserUsdc: bigint;         // average losing trade PnL (negative)
  oosPositivePnl: boolean;      // out-of-sample test result
}

export interface CriterionResult {
  passed: boolean;
  actual: string;
  threshold: string;
}

export interface ValidationResult {
  passed: boolean;
  criteria_results: Record<string, CriterionResult>;
  failure_reasons: string[];
}

// ─── Validator ──────────────────────────────────────────────────────────────

export class RobustnessValidator {
  private criteria: RobustnessCriteria;

  constructor(criteria?: RobustnessCriteria) {
    this.criteria = criteria ?? DEFAULT_ROBUSTNESS_CRITERIA;
  }

  /**
   * Validate backtest metrics against all 8 robustness criteria.
   * ALL criteria must pass for the overall result to be `passed: true`.
   */
  validate(metrics: BacktestMetrics): ValidationResult {
    const results: Record<string, CriterionResult> = {};
    const failures: string[] = [];

    // 1. Total trades >= min_trades (30)
    const tradesPassed = metrics.totalTrades >= this.criteria.min_trades;
    results['total_trades'] = {
      passed: tradesPassed,
      actual: String(metrics.totalTrades),
      threshold: `>= ${this.criteria.min_trades}`,
    };
    if (!tradesPassed) {
      failures.push(`Total trades ${metrics.totalTrades} < ${this.criteria.min_trades}`);
    }

    // 2. Net PnL > 0
    const pnlPassed = metrics.totalPnlUsdc > this.criteria.min_pnl;
    results['net_pnl'] = {
      passed: pnlPassed,
      actual: String(metrics.totalPnlUsdc),
      threshold: `> ${this.criteria.min_pnl}`,
    };
    if (!pnlPassed) {
      failures.push(`Net PnL ${metrics.totalPnlUsdc} <= 0`);
    }

    // 3. Profit factor > 1.25
    const pfPassed = metrics.profitFactor > this.criteria.min_profit_factor;
    results['profit_factor'] = {
      passed: pfPassed,
      actual: String(metrics.profitFactor.toFixed(2)),
      threshold: `> ${this.criteria.min_profit_factor}`,
    };
    if (!pfPassed) {
      failures.push(`Profit factor ${metrics.profitFactor.toFixed(2)} <= ${this.criteria.min_profit_factor}`);
    }

    // 4. Max drawdown < 5%
    const ddPassed = metrics.maxDrawdownPct < this.criteria.max_drawdown_pct;
    results['max_drawdown'] = {
      passed: ddPassed,
      actual: `${metrics.maxDrawdownPct.toFixed(2)}%`,
      threshold: `< ${this.criteria.max_drawdown_pct}%`,
    };
    if (!ddPassed) {
      failures.push(`Max drawdown ${metrics.maxDrawdownPct.toFixed(2)}% >= ${this.criteria.max_drawdown_pct}%`);
    }

    // 5. OOS positive PnL
    const oosPassed = !this.criteria.oos_positive_pnl || metrics.oosPositivePnl;
    results['oos_pnl'] = {
      passed: oosPassed,
      actual: metrics.oosPositivePnl ? 'positive' : 'negative',
      threshold: 'positive',
    };
    if (!oosPassed) {
      failures.push('Out-of-sample PnL is negative');
    }

    // 6. Win rate > 35%
    const wrPassed = metrics.winRate > this.criteria.min_win_rate;
    results['win_rate'] = {
      passed: wrPassed,
      actual: `${metrics.winRate.toFixed(1)}%`,
      threshold: `> ${this.criteria.min_win_rate}%`,
    };
    if (!wrPassed) {
      failures.push(`Win rate ${metrics.winRate.toFixed(1)}% <= ${this.criteria.min_win_rate}%`);
    }

    // 7. Winner/loser ratio > 1.5
    // avg_winner / abs(avg_loser) > 1.5
    const avgLoserAbs = metrics.avgLoserUsdc < 0n ? -metrics.avgLoserUsdc : metrics.avgLoserUsdc;
    let winnerRatio = 0;
    if (avgLoserAbs > 0n) {
      winnerRatio = Number(metrics.avgWinnerUsdc * 100n / avgLoserAbs) / 100;
    } else if (metrics.avgWinnerUsdc > 0n) {
      winnerRatio = Infinity;
    }
    const ratPassed = winnerRatio > this.criteria.min_winner_ratio;
    results['winner_ratio'] = {
      passed: ratPassed,
      actual: winnerRatio === Infinity ? 'Infinity' : String(winnerRatio.toFixed(2)),
      threshold: `> ${this.criteria.min_winner_ratio}`,
    };
    if (!ratPassed) {
      failures.push(
        `Winner/loser ratio ${winnerRatio === Infinity ? 'Infinity' : winnerRatio.toFixed(2)} <= ${this.criteria.min_winner_ratio}`,
      );
    }

    // 8. Sharpe ratio > 0.5
    const sharpePassed = metrics.sharpeRatio > this.criteria.min_sharpe;
    results['sharpe_ratio'] = {
      passed: sharpePassed,
      actual: String(metrics.sharpeRatio.toFixed(2)),
      threshold: `> ${this.criteria.min_sharpe}`,
    };
    if (!sharpePassed) {
      failures.push(`Sharpe ratio ${metrics.sharpeRatio.toFixed(2)} <= ${this.criteria.min_sharpe}`);
    }

    return {
      passed: failures.length === 0,
      criteria_results: results,
      failure_reasons: failures,
    };
  }
}

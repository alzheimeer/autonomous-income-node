import { describe, it, expect } from 'vitest';
import {
  RobustnessValidator,
  DEFAULT_ROBUSTNESS_CRITERIA,
  type BacktestMetrics,
} from './robustness-validator.js';

/** Helper to create metrics that pass all 8 criteria */
function passingMetrics(): BacktestMetrics {
  return {
    totalTrades: 50,
    totalPnlUsdc: 500_000_000n, // 500 USDC (6 decimals)
    profitFactor: 2.0,
    maxDrawdownPct: 3.0,
    winRate: 55.0,
    sharpeRatio: 1.2,
    avgWinnerUsdc: 30_000_000n, // 30 USDC
    avgLoserUsdc: -15_000_000n, // -15 USDC (ratio = 2.0)
    oosPositivePnl: true,
  };
}

describe('RobustnessValidator', () => {
  describe('DEFAULT_ROBUSTNESS_CRITERIA', () => {
    it('has expected default thresholds', () => {
      expect(DEFAULT_ROBUSTNESS_CRITERIA.min_trades).toBe(30);
      expect(DEFAULT_ROBUSTNESS_CRITERIA.min_pnl).toBe(0n);
      expect(DEFAULT_ROBUSTNESS_CRITERIA.min_profit_factor).toBe(1.25);
      expect(DEFAULT_ROBUSTNESS_CRITERIA.max_drawdown_pct).toBe(5.0);
      expect(DEFAULT_ROBUSTNESS_CRITERIA.oos_positive_pnl).toBe(true);
      expect(DEFAULT_ROBUSTNESS_CRITERIA.min_win_rate).toBe(35);
      expect(DEFAULT_ROBUSTNESS_CRITERIA.min_winner_ratio).toBe(1.5);
      expect(DEFAULT_ROBUSTNESS_CRITERIA.min_sharpe).toBe(0.5);
    });
  });

  describe('validate — all criteria pass', () => {
    it('returns passed: true with no failure_reasons', () => {
      const validator = new RobustnessValidator();
      const result = validator.validate(passingMetrics());

      expect(result.passed).toBe(true);
      expect(result.failure_reasons).toHaveLength(0);
      expect(Object.keys(result.criteria_results)).toHaveLength(8);
    });

    it('marks all 8 criteria as passed individually', () => {
      const validator = new RobustnessValidator();
      const result = validator.validate(passingMetrics());

      for (const [_key, criterion] of Object.entries(result.criteria_results)) {
        expect(criterion.passed).toBe(true);
      }
    });
  });

  describe('validate — individual criteria failures', () => {
    it('fails total_trades when below threshold', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), totalTrades: 20 };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['total_trades'].passed).toBe(false);
      expect(result.criteria_results['total_trades'].actual).toBe('20');
      expect(result.failure_reasons).toContain('Total trades 20 < 30');
    });

    it('fails net_pnl when zero or negative', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), totalPnlUsdc: -100n };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['net_pnl'].passed).toBe(false);
      expect(result.failure_reasons).toContain('Net PnL -100 <= 0');
    });

    it('fails net_pnl when exactly zero', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), totalPnlUsdc: 0n };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['net_pnl'].passed).toBe(false);
    });

    it('fails profit_factor when below threshold', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), profitFactor: 1.1 };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['profit_factor'].passed).toBe(false);
      expect(result.criteria_results['profit_factor'].actual).toBe('1.10');
      expect(result.failure_reasons[0]).toContain('Profit factor');
    });

    it('fails max_drawdown when exceeding threshold', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), maxDrawdownPct: 6.5 };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['max_drawdown'].passed).toBe(false);
      expect(result.criteria_results['max_drawdown'].actual).toBe('6.50%');
      expect(result.failure_reasons[0]).toContain('Max drawdown');
    });

    it('fails max_drawdown when exactly at threshold (not strictly less)', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), maxDrawdownPct: 5.0 };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['max_drawdown'].passed).toBe(false);
    });

    it('fails oos_pnl when out-of-sample is negative', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), oosPositivePnl: false };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['oos_pnl'].passed).toBe(false);
      expect(result.criteria_results['oos_pnl'].actual).toBe('negative');
      expect(result.failure_reasons).toContain('Out-of-sample PnL is negative');
    });

    it('fails win_rate when below threshold', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), winRate: 30.0 };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['win_rate'].passed).toBe(false);
      expect(result.criteria_results['win_rate'].actual).toBe('30.0%');
    });

    it('fails win_rate when exactly at threshold (not strictly greater)', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), winRate: 35.0 };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['win_rate'].passed).toBe(false);
    });

    it('fails winner_ratio when below threshold', () => {
      const validator = new RobustnessValidator();
      // avgWinner = 20, avgLoser = -20 → ratio = 1.0
      const metrics = {
        ...passingMetrics(),
        avgWinnerUsdc: 20_000_000n,
        avgLoserUsdc: -20_000_000n,
      };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['winner_ratio'].passed).toBe(false);
      expect(result.criteria_results['winner_ratio'].actual).toBe('1.00');
    });

    it('fails sharpe_ratio when below threshold', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), sharpeRatio: 0.3 };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.criteria_results['sharpe_ratio'].passed).toBe(false);
      expect(result.criteria_results['sharpe_ratio'].actual).toBe('0.30');
    });
  });

  describe('validate — edge cases', () => {
    it('handles avgLoserUsdc = 0 with positive winner → Infinity ratio', () => {
      const validator = new RobustnessValidator();
      const metrics = {
        ...passingMetrics(),
        avgWinnerUsdc: 10_000_000n,
        avgLoserUsdc: 0n,
      };
      const result = validator.validate(metrics);

      expect(result.criteria_results['winner_ratio'].passed).toBe(true);
      expect(result.criteria_results['winner_ratio'].actual).toBe('Infinity');
    });

    it('handles avgLoserUsdc = 0 and avgWinnerUsdc = 0 → ratio 0', () => {
      const validator = new RobustnessValidator();
      const metrics = {
        ...passingMetrics(),
        avgWinnerUsdc: 0n,
        avgLoserUsdc: 0n,
      };
      const result = validator.validate(metrics);

      expect(result.criteria_results['winner_ratio'].passed).toBe(false);
      expect(result.criteria_results['winner_ratio'].actual).toBe('0.00');
    });

    it('collects multiple failure reasons when many criteria fail', () => {
      const validator = new RobustnessValidator();
      const metrics: BacktestMetrics = {
        totalTrades: 10,
        totalPnlUsdc: -50n,
        profitFactor: 0.8,
        maxDrawdownPct: 8.0,
        winRate: 20.0,
        sharpeRatio: -0.5,
        avgWinnerUsdc: 5_000_000n,
        avgLoserUsdc: -10_000_000n, // ratio = 0.5
        oosPositivePnl: false,
      };
      const result = validator.validate(metrics);

      expect(result.passed).toBe(false);
      expect(result.failure_reasons.length).toBe(8);
    });

    it('passes exact boundary: 30 trades passes (>= 30)', () => {
      const validator = new RobustnessValidator();
      const metrics = { ...passingMetrics(), totalTrades: 30 };
      const result = validator.validate(metrics);

      expect(result.criteria_results['total_trades'].passed).toBe(true);
    });
  });

  describe('validate — custom criteria', () => {
    it('uses custom criteria when provided', () => {
      const customCriteria = {
        ...DEFAULT_ROBUSTNESS_CRITERIA,
        min_trades: 10,
        min_sharpe: 0.1,
      };
      const validator = new RobustnessValidator(customCriteria);
      const metrics = {
        ...passingMetrics(),
        totalTrades: 15,
        sharpeRatio: 0.2,
      };
      const result = validator.validate(metrics);

      expect(result.criteria_results['total_trades'].passed).toBe(true);
      expect(result.criteria_results['sharpe_ratio'].passed).toBe(true);
    });

    it('skips OOS check when oos_positive_pnl criteria is false', () => {
      const customCriteria = {
        ...DEFAULT_ROBUSTNESS_CRITERIA,
        oos_positive_pnl: false,
      };
      const validator = new RobustnessValidator(customCriteria);
      const metrics = { ...passingMetrics(), oosPositivePnl: false };
      const result = validator.validate(metrics);

      expect(result.criteria_results['oos_pnl'].passed).toBe(true);
    });
  });
});

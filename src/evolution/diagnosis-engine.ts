/**
 * Strategy Evolution Lab — Diagnosis Engine
 *
 * Analyzes strategy performance data against 8 diagnostic rules to identify
 * specific failure patterns. Returns a ranked list of diagnoses sorted by
 * confidence descending, each with suggested parameter adjustments.
 *
 * Zero external dependencies. Pure logic module.
 */

import type { DiagnosisCode, StrategyParameters } from './types.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

export interface DiagnosisResult {
  code: DiagnosisCode;
  confidence: number;         // 0.0 - 1.0
  description: string;
  suggested_adjustments: ParameterAdjustment[];
}

export interface ParameterAdjustment {
  parameter: keyof StrategyParameters;
  direction: 'increase' | 'decrease';
  suggested_values: (number | string)[];
}

export interface PerformanceData {
  total_trades: number;
  gross_profit: bigint;
  gross_loss: bigint;
  total_costs: bigint;
  avg_tp_distance_bps: number;
  sl_hit_rate: number;         // 0.0 - 1.0
  avg_mae_vs_stop: number;     // 0.0 - 1.0 (fraction, e.g., 0.15 means MAE is 15% of stop)
  raw_signals: number;
  filtered_signals: number;
  regime_opportunities: number;
  net_pnl_per_winner: bigint;
  tp_gains_positive: boolean;
  risk_metrics_in_bounds: boolean;
  period_days: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Clamp a value to [0.0, 1.0] */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Absolute value for bigint */
function absBI(n: bigint): bigint {
  return n < 0n ? -n : n;
}

// ─── Diagnosis Engine ───────────────────────────────────────────────────────

export class DiagnosisEngine {
  /**
   * Analyze performance data against all 8 diagnostic rules.
   * Returns a ranked list sorted by confidence descending.
   * Only rules whose condition is met are included.
   */
  diagnose(data: PerformanceData): DiagnosisResult[] {
    const results: DiagnosisResult[] = [];

    this.checkCostDominated(data, results);
    this.checkCostsKillEdge(data, results);
    this.checkTpTooSmall(data, results);
    this.checkSlTooTight(data, results);
    this.checkTooFewSignals(data, results);
    this.checkGateTooStrict(data, results);
    this.checkRiskOkStrategyWeak(data, results);
    this.checkRegimeNoOpportunity(data, results);

    // Sort by confidence descending
    results.sort((a, b) => b.confidence - a.confidence);

    return results;
  }

  // ─── Rule: COST_DOMINATED ───────────────────────────────────────────────

  private checkCostDominated(data: PerformanceData, results: DiagnosisResult[]): void {
    const grossLossAbs = absBI(data.gross_loss);

    // Edge case: no loss — cannot be cost-dominated
    if (grossLossAbs === 0n) return;

    // Condition: total_costs > 80% of |gross_loss|
    // Equivalent: total_costs * 10 > grossLossAbs * 8
    if (data.total_costs * 10n > grossLossAbs * 8n) {
      // Confidence: min(1.0, costs / gross_loss)
      const confidence = clamp01(
        Number(data.total_costs * 1000n / grossLossAbs) / 1000,
      );

      results.push({
        code: 'COST_DOMINATED',
        confidence,
        description:
          'Total trading costs exceed 80% of gross loss, indicating costs are the primary drag on performance.',
        suggested_adjustments: [
          {
            parameter: 'tp_atr',
            direction: 'increase',
            suggested_values: [2.5, 3.0, 3.5],
          },
          {
            parameter: 'trade_size',
            direction: 'increase',
            suggested_values: ['$15', '$20'],
          },
        ],
      });
    }
  }

  // ─── Rule: COSTS_KILL_EDGE ──────────────────────────────────────────────

  private checkCostsKillEdge(data: PerformanceData, results: DiagnosisResult[]): void {
    // Condition: tp_gains positive AND net_pnl_per_winner < 0
    if (data.tp_gains_positive && data.net_pnl_per_winner < 0n) {
      results.push({
        code: 'COSTS_KILL_EDGE',
        confidence: 0.9,
        description:
          'Take-profit gains are positive but net PnL per winner is negative after costs, meaning costs fully consume the edge.',
        suggested_adjustments: [
          {
            parameter: 'tp_atr',
            direction: 'increase',
            suggested_values: [3.0, 3.5, 4.0],
          },
          {
            parameter: 'volumeZ',
            direction: 'decrease',
            suggested_values: [0.8],
          },
        ],
      });
    }
  }

  // ─── Rule: TP_TOO_SMALL ─────────────────────────────────────────────────

  private checkTpTooSmall(data: PerformanceData, results: DiagnosisResult[]): void {
    // Condition: avg_tp_distance_bps < 150
    if (data.avg_tp_distance_bps < 150) {
      // Confidence: 1.0 - (avg_tp_bps / 150)
      const confidence = clamp01(1.0 - data.avg_tp_distance_bps / 150);

      results.push({
        code: 'TP_TOO_SMALL',
        confidence,
        description:
          'Average take-profit distance is below 150 bps, leaving insufficient room to cover costs and generate profit.',
        suggested_adjustments: [
          {
            parameter: 'tp_atr',
            direction: 'increase',
            suggested_values: [2.5, 3.0, 3.5, 4.0],
          },
        ],
      });
    }
  }

  // ─── Rule: SL_TOO_TIGHT ─────────────────────────────────────────────────

  private checkSlTooTight(data: PerformanceData, results: DiagnosisResult[]): void {
    // Condition: sl_hit_rate > 0.7 AND avg_mae_vs_stop < 0.2
    if (data.sl_hit_rate > 0.7 && data.avg_mae_vs_stop < 0.2) {
      // Confidence: sl_hit_rate (already 0-1)
      const confidence = clamp01(data.sl_hit_rate);

      results.push({
        code: 'SL_TOO_TIGHT',
        confidence,
        description:
          'Stop-loss hit rate exceeds 70% while average MAE is well within stop distance, indicating stops are too tight for normal price fluctuation.',
        suggested_adjustments: [
          {
            parameter: 'stop_atr',
            direction: 'increase',
            suggested_values: [2.0, 2.5],
          },
        ],
      });
    }
  }

  // ─── Rule: TOO_FEW_SIGNALS ──────────────────────────────────────────────

  private checkTooFewSignals(data: PerformanceData, results: DiagnosisResult[]): void {
    // Normalize trades to a 30-day equivalent period
    // Condition: (total_trades * 30 / period_days) < 10
    if (data.period_days <= 0) return;

    const normalizedTrades = (data.total_trades * 30) / data.period_days;

    if (normalizedTrades < 10) {
      // Confidence: 1.0 - (normalizedTrades / 10)
      const confidence = clamp01(1.0 - normalizedTrades / 10);

      results.push({
        code: 'TOO_FEW_SIGNALS',
        confidence,
        description:
          'Trade frequency is below 10 trades per 30-day equivalent period, providing insufficient sample size for reliable performance assessment.',
        suggested_adjustments: [
          {
            parameter: 'rsi_reversion',
            direction: 'decrease',
            suggested_values: [25, 28],
          },
          {
            parameter: 'rsi_trend',
            direction: 'decrease',
            suggested_values: [30],
          },
          {
            parameter: 'rsi_trend',
            direction: 'increase',
            suggested_values: [55, 60],
          },
        ],
      });
    }
  }

  // ─── Rule: GATE_TOO_STRICT ──────────────────────────────────────────────

  private checkGateTooStrict(data: PerformanceData, results: DiagnosisResult[]): void {
    // Edge case: no raw signals — cannot compute ratio
    if (data.raw_signals === 0) return;

    const filterRatio = data.filtered_signals / data.raw_signals;

    // Condition: filtered / raw > 0.5
    if (filterRatio > 0.5) {
      // Confidence: filtered / raw (clamped to 1.0)
      const confidence = clamp01(filterRatio);

      results.push({
        code: 'GATE_TOO_STRICT',
        confidence,
        description:
          'More than 50% of raw signals are being filtered out by entry gates, potentially eliminating profitable opportunities.',
        suggested_adjustments: [
          {
            parameter: 'volumeZ',
            direction: 'decrease',
            suggested_values: [0.8, 1.0],
          },
          {
            parameter: 'rsi_trend',
            direction: 'decrease',
            suggested_values: [30],
          },
          {
            parameter: 'rsi_trend',
            direction: 'increase',
            suggested_values: [55, 60],
          },
        ],
      });
    }
  }

  // ─── Rule: RISK_OK_STRATEGY_WEAK ────────────────────────────────────────

  private checkRiskOkStrategyWeak(data: PerformanceData, results: DiagnosisResult[]): void {
    // Condition: risk_metrics_in_bounds && total PnL < 0
    // We infer negative PnL from gross_profit + gross_loss - total_costs
    // gross_loss is expected to be negative or treated as magnitude
    const netPnl = data.gross_profit - absBI(data.gross_loss) - data.total_costs;

    if (data.risk_metrics_in_bounds && netPnl < 0n) {
      results.push({
        code: 'RISK_OK_STRATEGY_WEAK',
        confidence: 0.7,
        description:
          'Risk metrics (drawdown, position sizing) are within bounds but PnL is negative, indicating the core strategy logic needs improvement.',
        suggested_adjustments: [
          {
            parameter: 'tp_atr',
            direction: 'increase',
            suggested_values: [2.5, 3.0],
          },
          {
            parameter: 'stop_atr',
            direction: 'increase',
            suggested_values: [2.0, 2.5],
          },
        ],
      });
    }
  }

  // ─── Rule: REGIME_NO_OPPORTUNITY ────────────────────────────────────────

  private checkRegimeNoOpportunity(data: PerformanceData, results: DiagnosisResult[]): void {
    // Condition: regime_opportunities < 5
    if (data.regime_opportunities < 5) {
      // Confidence: 1.0 - (opportunities / 5)
      const confidence = clamp01(1.0 - data.regime_opportunities / 5);

      results.push({
        code: 'REGIME_NO_OPPORTUNITY',
        confidence,
        description:
          'The dominant market regime during the test period offered fewer than 5 entry opportunities for this strategy type.',
        suggested_adjustments: [],
      });
    }
  }
}

/**
 * Strategy Evolution Lab — Type Definitions
 *
 * All interfaces, union types, and constants for the Strategy Evolution Lab module.
 * This is a pure type/constant definitions file with zero external dependencies.
 */

// ─── Strategy Status Lifecycle ──────────────────────────────────────────────

export type StrategyStatus =
  | 'CANDIDATE' | 'BACKTESTING' | 'BACKTEST_PASS' | 'BACKTEST_FAIL'
  | 'SHADOW' | 'SHADOW_PASS' | 'SHADOW_FAIL'
  | 'MICRO' | 'MICRO_PASS' | 'MICRO_FAIL'
  | 'ACTIVE' | 'PAUSED' | 'DORMANT'
  | 'ARCHIVED_BASELINE' | 'REJECTED';

export const VALID_STATUSES: readonly StrategyStatus[] = [
  'CANDIDATE', 'BACKTESTING', 'BACKTEST_PASS', 'BACKTEST_FAIL',
  'SHADOW', 'SHADOW_PASS', 'SHADOW_FAIL',
  'MICRO', 'MICRO_PASS', 'MICRO_FAIL',
  'ACTIVE', 'PAUSED', 'DORMANT',
  'ARCHIVED_BASELINE', 'REJECTED',
] as const;

// ─── Market Regime ──────────────────────────────────────────────────────────

export type RegimeType = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE' | 'UNCERTAIN';

// ─── Diagnosis Codes ────────────────────────────────────────────────────────

export type DiagnosisCode =
  | 'COST_DOMINATED' | 'COSTS_KILL_EDGE' | 'TP_TOO_SMALL'
  | 'SL_TOO_TIGHT' | 'TOO_FEW_SIGNALS' | 'GATE_TOO_STRICT'
  | 'RISK_OK_STRATEGY_WEAK' | 'REGIME_NO_OPPORTUNITY';

// ─── Strategy Parameters ────────────────────────────────────────────────────

export interface StrategyParameters {
  entry_tf: string;
  regime_tf: string;
  stop_atr: number;
  tp_atr: number;
  rsi_trend: [number, number];
  rsi_reversion: number;
  volumeZ: number;
  trade_size: string;
}

// ─── Strategy Evidence ──────────────────────────────────────────────────────

export interface StrategyEvidence {
  source?: string;
  verdict?: string;
  trades?: number;
  win_rate?: number;
  pnl?: string;
  period?: string;
}

// ─── Revival Rules ──────────────────────────────────────────────────────────

export interface RevivalRules {
  regime: RegimeType[];
  min_days_matching: number;
}

// ─── Strategy Record ────────────────────────────────────────────────────────

export interface StrategyRecord {
  strategy_id: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  status: StrategyStatus;
  config_hash: string;
  parameters: StrategyParameters;
  tags: string[];
  best_regime: RegimeType[];
  evidence: StrategyEvidence;
  notes: string;
  archived_reason: string;
  revival_rules: RevivalRules | null;
}

// ─── Experiment Types ───────────────────────────────────────────────────────

export type ExperimentPhase = 'BACKTEST' | 'SHADOW' | 'MICRO';

export interface MarketContext {
  dominant_regime: RegimeType;
  volatility_level: string;
  period_start: string;
  period_end: string;
}

export interface ExperimentMetrics {
  total_trades: number;
  win_rate: number;
  profit_factor: number;
  max_drawdown_pct: number;
  sharpe_ratio: number;
  total_pnl: string;
  avg_pnl_per_trade: string;
  total_costs: string;
}

export interface ExperimentRecord {
  experiment_id: string;
  strategy_id: string;
  parent_id: string | null;
  phase: ExperimentPhase;
  hypothesis: string;
  period: string;
  market_context: MarketContext;
  metrics: ExperimentMetrics;
  verdict: string;
  score: number;
  promoted: boolean;
  created_at: string;
}

// ─── State Transitions ──────────────────────────────────────────────────────

export interface StateTransition {
  from: StrategyStatus;
  to: StrategyStatus;
  requires_approval: boolean;
  trigger: string;
}

export const VALID_TRANSITIONS: StateTransition[] = [
  { from: 'CANDIDATE', to: 'BACKTESTING', requires_approval: false, trigger: 'backtest_start' },
  { from: 'BACKTESTING', to: 'BACKTEST_PASS', requires_approval: false, trigger: 'robustness_pass' },
  { from: 'BACKTESTING', to: 'BACKTEST_FAIL', requires_approval: false, trigger: 'robustness_fail' },
  { from: 'BACKTEST_PASS', to: 'SHADOW', requires_approval: false, trigger: 'auto_advance' },
  { from: 'SHADOW', to: 'SHADOW_PASS', requires_approval: false, trigger: 'shadow_pass' },
  { from: 'SHADOW', to: 'SHADOW_FAIL', requires_approval: false, trigger: 'shadow_fail' },
  { from: 'SHADOW_PASS', to: 'MICRO', requires_approval: true, trigger: 'operator_approval' },
  { from: 'MICRO', to: 'MICRO_PASS', requires_approval: false, trigger: 'micro_pass' },
  { from: 'MICRO', to: 'MICRO_FAIL', requires_approval: false, trigger: 'micro_fail' },
  { from: 'MICRO_PASS', to: 'ACTIVE', requires_approval: false, trigger: 'auto_promote' },
  { from: 'ACTIVE', to: 'DORMANT', requires_approval: false, trigger: 'regime_mismatch_7d' },
  { from: 'DORMANT', to: 'SHADOW', requires_approval: false, trigger: 'revival_match_3d' },
  { from: 'CANDIDATE', to: 'REJECTED', requires_approval: false, trigger: 'manual_reject' },
  { from: 'BACKTEST_PASS', to: 'REJECTED', requires_approval: false, trigger: 'manual_reject' },
  { from: 'SHADOW_PASS', to: 'REJECTED', requires_approval: false, trigger: 'manual_reject' },
  { from: 'ACTIVE', to: 'PAUSED', requires_approval: false, trigger: 'manual_pause' },
  { from: 'PAUSED', to: 'ACTIVE', requires_approval: false, trigger: 'manual_resume' },
];

// ─── Transition Record ──────────────────────────────────────────────────────

export interface TransitionRecord {
  id: number;
  strategy_id: string;
  from_status: StrategyStatus;
  to_status: StrategyStatus;
  reason: string;
  experiment_id: string | null;
  timestamp: string;
}

// ─── Pending Promotion ──────────────────────────────────────────────────────

export interface PendingPromotion {
  strategy_id: string;
  from_status: StrategyStatus;
  to_status: StrategyStatus;
  created_at: string;
  resolved: boolean;
  resolved_at: string | null;
  approved: boolean | null;
}

// ─── Candle Data (Cache Operations) ─────────────────────────────────────────

export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

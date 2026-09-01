/**
 * Strategy Evolution Lab — Public API
 * 
 * Central export point for the evolution module.
 * All classes, types, interfaces, and constants are re-exported from here.
 */

// ─── Core Database ──────────────────────────────────────────────────────────
export { EvolutionDatabase } from './evolution-database.js';

// ─── Data Layer ─────────────────────────────────────────────────────────────
export { StrategyRegistry } from './strategy-registry.js';
export { ExperimentLedger, type CreateExperimentInput } from './experiment-ledger.js';

// ─── Intelligence ───────────────────────────────────────────────────────────
export { DiagnosisEngine, type DiagnosisResult, type ParameterAdjustment, type PerformanceData } from './diagnosis-engine.js';
export { VariantGenerator, PARAMETER_GRID, ARCHETYPE_PRESETS } from './variant-generator.js';

// ─── Execution ──────────────────────────────────────────────────────────────
export { CandleCache, type CandleCacheOptions } from './candle-cache.js';
export { BacktestLab, type LabBacktestConfig, type LabBacktestResult } from './backtest-lab.js';
export { RobustnessValidator, DEFAULT_ROBUSTNESS_CRITERIA, type RobustnessCriteria, type BacktestMetrics, type ValidationResult, type CriterionResult } from './robustness-validator.js';

// ─── Advanced Testing ───────────────────────────────────────────────────────
export { ShadowTournament, DEFAULT_SHADOW_CRITERIA, type ShadowParticipant, type ShadowMetrics, type ShadowCriteria } from './shadow-tournament.js';

// ─── Lifecycle Management ───────────────────────────────────────────────────
export { StrategyRouter, REGIME_STRATEGY_MAP, type RoutingDecision } from './strategy-router.js';
export { DormancyRevival, type DormancyConfig } from './dormancy-revival.js';
export { PromotionEngine, type PromotionConfig, type PromotionResult } from './promotion-engine.js';

// ─── Reports ────────────────────────────────────────────────────────────────
export { EvolutionReport, type CycleReport } from './evolution-report.js';

// ─── API Routes ─────────────────────────────────────────────────────────────
export { registerEvolutionRoutes, type EvolutionRouteDeps } from './evolution-routes.js';

// ─── Initialization ─────────────────────────────────────────────────────────
export { initializeBaseline, BASELINE_PARAMETERS, BASELINE_EVIDENCE } from './baseline.js';

// ─── Integration Wire ───────────────────────────────────────────────────────
export { wireEvolution } from './wire.js';

// ─── Types ──────────────────────────────────────────────────────────────────
export type {
  StrategyStatus,
  RegimeType,
  DiagnosisCode,
  StrategyParameters,
  StrategyRecord,
  StrategyEvidence,
  RevivalRules,
  ExperimentPhase,
  ExperimentRecord,
  MarketContext,
  ExperimentMetrics,
  StateTransition,
  TransitionRecord,
  PendingPromotion,
  CandleData,
} from './types.js';

export { VALID_STATUSES, VALID_TRANSITIONS } from './types.js';

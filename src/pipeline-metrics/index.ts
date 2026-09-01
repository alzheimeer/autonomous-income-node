/**
 * Pipeline Metrics — Public Exports
 *
 * Central barrel file for the pipeline-metrics module.
 * Re-exports all public types, classes, and functions used by other modules.
 */

// ── Database ────────────────────────────────────────────────────────────────
export {
  MetricsDatabase,
  createMetricsDatabase,
  METRICS_DB_PATH,
} from './metrics-database.js';

export type {
  PipelineEventType,
  PipelineEvent,
  RejectionRecord,
  NearMissRecord,
  BacktestTradeRecord,
} from './metrics-database.js';

// ── Observer ────────────────────────────────────────────────────────────────
export { PipelineMetricsRecorder } from './pipeline-observer.js';

export type {
  IPipelineObserver,
  StrategyDiagnostics,
} from './pipeline-observer.js';

// ── Rejection Normalizer ────────────────────────────────────────────────────
export {
  normalizeGateRejection,
  normalizeGateRejections,
  normalizePositionSizingRejection,
  detectStrategySubReason,
} from './rejection-normalizer.js';

export type { StrategySubReasonKey } from './rejection-normalizer.js';

// ── Near-Miss Detector ──────────────────────────────────────────────────────
export { detectNearMisses } from './near-miss-detector.js';

export type { NearMiss } from './near-miss-detector.js';

// ── Aggregate Metrics ───────────────────────────────────────────────────────
export { computeAggregateMetrics } from './aggregate-metrics.js';

export type { AggregateMetrics } from './aggregate-metrics.js';

// ── Telegram Summary ────────────────────────────────────────────────────────
export {
  formatTelegramSummary,
  getPipelineTelegramSummary,
} from './telegram-summary.js';

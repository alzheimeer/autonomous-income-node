/**
 * Pipeline Metrics - Aggregate Metrics Computation
 *
 * Computes rolling aggregate metrics from persisted event data in MetricsDatabase.
 * All computations use SQL queries against the database — no in-memory-only state.
 *
 * Metrics computed:
 *   - signalsPerHour: strategy_signal_generated events / hours in window
 *   - evaluationsPerHour: evaluation_started events / hours in window
 *   - regimeDistribution: percentage of each regime type from indicators_computed events
 *   - rejectionDistribution: count and percentage of each normalized rejection reason
 *   - nearMissFrequency: count per indicator name from near_misses table
 *   - passThroughRate: gate_passed / (gate_passed + gate_rejected)
 *   - dataIncomplete: true when window has < 1 hour of actual data
 *
 * Requirements: 5.1, 5.2, 5.3
 */

import type { MetricsDatabase, PipelineEventType } from './metrics-database.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface AggregateMetrics {
  signalsPerHour: number;
  evaluationsPerHour: number;
  regimeDistribution: Record<string, number>; // regime → percentage
  rejectionDistribution: Record<string, { count: number; percentage: number }>;
  nearMissFrequency: Record<string, number>; // indicator_name → count
  passThroughRate: number; // signals that passed gate / total signals
  dataIncomplete: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute aggregate metrics from persisted event data in the given time window.
 *
 * @param db - MetricsDatabase instance to query
 * @param windowHours - Rolling window in hours (default 24, max 168)
 * @returns AggregateMetrics computed from SQL queries against the database
 */
export function computeAggregateMetrics(
  db: MetricsDatabase,
  windowHours: number = 24,
): AggregateMetrics {
  // Clamp window to valid range
  const clampedWindow = Math.min(Math.max(windowHours, 0), 168);
  const now = Date.now();
  const windowMs = clampedWindow * 60 * 60 * 1000;
  const since = now - windowMs;

  // If DB is degraded, return empty metrics
  if (db.isDegraded) {
    return emptyMetrics(true);
  }

  // Determine actual data span for dataIncomplete flag
  const dataSpanHours = computeDataSpanHours(db, since);
  const dataIncomplete = dataSpanHours < 1;

  // Use actual hours for rate computation (avoid division by zero)
  const effectiveHours = Math.max(dataSpanHours, 1 / 60); // at least 1 minute

  // Count events by type in the window
  const signalCount = countEventsByType(db, since, 'strategy_signal_generated');
  const evaluationCount = countEventsByType(db, since, 'evaluation_started');
  const gatePassedCount = countEventsByType(db, since, 'gate_passed');
  const gateRejectedCount = countEventsByType(db, since, 'gate_rejected');

  // Compute rates
  const signalsPerHour = signalCount / effectiveHours;
  const evaluationsPerHour = evaluationCount / effectiveHours;

  // Pass-through rate: gate_passed / (gate_passed + gate_rejected)
  const totalGateDecisions = gatePassedCount + gateRejectedCount;
  const passThroughRate = totalGateDecisions > 0
    ? gatePassedCount / totalGateDecisions
    : 0;

  // Regime distribution from event details
  const regimeDistribution = computeRegimeDistribution(db, since);

  // Rejection distribution from rejection_reasons table
  const rejectionDistribution = computeRejectionDistribution(db, since);

  // Near-miss frequency from near_misses table
  const nearMissFrequency = computeNearMissFrequency(db, since);

  return {
    signalsPerHour,
    evaluationsPerHour,
    regimeDistribution,
    rejectionDistribution,
    nearMissFrequency,
    passThroughRate,
    dataIncomplete,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

function emptyMetrics(dataIncomplete: boolean): AggregateMetrics {
  return {
    signalsPerHour: 0,
    evaluationsPerHour: 0,
    regimeDistribution: {},
    rejectionDistribution: {},
    nearMissFrequency: {},
    passThroughRate: 0,
    dataIncomplete,
  };
}

/**
 * Compute the actual time span of data in the window (in hours).
 * Uses the difference between the earliest and latest event timestamps.
 */
function computeDataSpanHours(db: MetricsDatabase, since: number): number {
  const events = db.queryEvents({ since, limit: 1 });
  if (events.length === 0) return 0;

  // Get the earliest event in window (query is DESC by default, so get last page)
  // We'll use the queryEvents with a large limit to find the range
  // More efficient: get min/max timestamps via dedicated queries
  const latestEvents = db.queryEvents({ since, limit: 1 });
  if (latestEvents.length === 0) return 0;

  const latestTimestamp = latestEvents[0].timestamp;

  // Get oldest event in window by querying with a high limit sorted desc (last item is oldest)
  // Since queryEvents sorts DESC and has a limit, get a reasonable batch
  const allEvents = db.queryEvents({ since, limit: 10000 });
  if (allEvents.length === 0) return 0;

  const oldestTimestamp = allEvents[allEvents.length - 1].timestamp;
  const spanMs = latestTimestamp - oldestTimestamp;

  return spanMs / (60 * 60 * 1000);
}

/**
 * Count events of a specific type within the time window.
 */
function countEventsByType(db: MetricsDatabase, since: number, eventType: PipelineEventType): number {
  const events = db.queryEvents({
    since,
    eventType,
    limit: 100000,
  });
  return events.length;
}

/**
 * Compute regime distribution from indicators_computed and strategy_signal_generated events.
 * Extracts regime from event details and computes percentage for each regime type.
 */
function computeRegimeDistribution(db: MetricsDatabase, since: number): Record<string, number> {
  // Query indicators_computed events which contain regime info
  const indicatorEvents = db.queryEvents({
    since,
    eventType: 'indicators_computed',
    limit: 100000,
  });

  // Also check strategy events for regime info
  const strategySignalEvents = db.queryEvents({
    since,
    eventType: 'strategy_signal_generated',
    limit: 100000,
  });

  const strategyNoSignalEvents = db.queryEvents({
    since,
    eventType: 'strategy_no_signal',
    limit: 100000,
  });

  const regimeCounts: Record<string, number> = {};
  let total = 0;

  // Extract regime from event details
  const allEvents = [...indicatorEvents, ...strategySignalEvents, ...strategyNoSignalEvents];
  for (const event of allEvents) {
    const regime = extractRegime(event.details);
    if (regime) {
      regimeCounts[regime] = (regimeCounts[regime] ?? 0) + 1;
      total++;
    }
  }

  // Convert counts to percentages
  const distribution: Record<string, number> = {};
  if (total > 0) {
    for (const [regime, count] of Object.entries(regimeCounts)) {
      distribution[regime] = Math.round((count / total) * 10000) / 100; // 2 decimal percentage
    }
  }

  return distribution;
}

/**
 * Extract regime string from event details.
 */
function extractRegime(details: Record<string, unknown>): string | null {
  if (typeof details.regime === 'string') return details.regime;
  if (typeof details.current_regime === 'string') return details.current_regime;
  return null;
}

/**
 * Compute rejection distribution from rejection_reasons table.
 * Filters by events in the time window via event_id join.
 */
function computeRejectionDistribution(
  db: MetricsDatabase,
  since: number,
): Record<string, { count: number; percentage: number }> {
  // Get all rejection events in the window
  const rejectionEvents = db.queryEvents({
    since,
    eventType: 'gate_rejected',
    limit: 100000,
  });

  // Also include strategy_no_signal and position_sizing_rejected
  const strategyNoSignals = db.queryEvents({
    since,
    eventType: 'strategy_no_signal',
    limit: 100000,
  });

  const positionSizingRejected = db.queryEvents({
    since,
    eventType: 'position_sizing_rejected',
    limit: 100000,
  });

  // Collect all event IDs that may have rejections
  const allRejectionEventIds = new Set<number>();
  for (const e of [...rejectionEvents, ...strategyNoSignals, ...positionSizingRejected]) {
    allRejectionEventIds.add(e.id);
  }

  // Query rejections for these events
  const reasonCounts: Record<string, number> = {};
  let total = 0;

  for (const eventId of allRejectionEventIds) {
    const rejections = db.queryRejections({ eventId, limit: 100 });
    for (const r of rejections) {
      reasonCounts[r.reason_key] = (reasonCounts[r.reason_key] ?? 0) + 1;
      total++;
    }
  }

  // Convert to distribution with count and percentage
  const distribution: Record<string, { count: number; percentage: number }> = {};
  for (const [key, count] of Object.entries(reasonCounts)) {
    distribution[key] = {
      count,
      percentage: total > 0 ? Math.round((count / total) * 10000) / 100 : 0,
    };
  }

  return distribution;
}

/**
 * Compute near-miss frequency from near_misses table.
 * Groups by indicator_name and counts occurrences in the time window.
 */
function computeNearMissFrequency(db: MetricsDatabase, since: number): Record<string, number> {
  // Get events in the window that might have near misses
  // Near misses are linked to strategy_no_signal events
  const strategyNoSignals = db.queryEvents({
    since,
    eventType: 'strategy_no_signal',
    limit: 100000,
  });

  const frequency: Record<string, number> = {};

  for (const event of strategyNoSignals) {
    const nearMisses = db.queryNearMisses({ eventId: event.id, limit: 100 });
    for (const nm of nearMisses) {
      frequency[nm.indicator_name] = (frequency[nm.indicator_name] ?? 0) + 1;
    }
  }

  return frequency;
}

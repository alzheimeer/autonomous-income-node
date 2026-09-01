/**
 * Pipeline Metrics - Telegram Summary Formatter
 *
 * Formats aggregate pipeline metrics into a Telegram-compatible markdown string
 * suitable for inclusion in the daily Telegram report. The summary includes:
 *   - Evaluations (24h)
 *   - Signals (24h)
 *   - Pass-through rate
 *   - Top 3 rejection reasons
 *   - Near-miss count
 *   - Current regime
 *
 * Respects ≤ 500 character limit for Telegram message compatibility.
 *
 * Requirements: 7.1, 7.2, 7.3
 */

import type { AggregateMetrics } from './aggregate-metrics.js';
import type { MetricsDatabase } from './metrics-database.js';
import { computeAggregateMetrics } from './aggregate-metrics.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum character length for Telegram summary messages */
const MAX_TELEGRAM_LENGTH = 500;

/** Fallback message when MetricsDatabase is unavailable */
const FALLBACK_MESSAGE = '📊 Pipeline metrics unavailable';

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Format aggregate metrics into a Telegram-compatible markdown summary.
 *
 * Produces a multi-line string containing:
 *   - Header with emoji
 *   - Evaluations and signals counts (24h extrapolation from hourly rates)
 *   - Pass-through rate as percentage
 *   - Top 3 rejection reasons sorted by count
 *   - Near-miss total count
 *   - Current regime
 *
 * The result is truncated to ≤ 500 characters for Telegram compatibility.
 *
 * @param metrics - Pre-computed aggregate metrics for the reporting window
 * @param regime - Current market regime string (e.g., 'TRENDING_UP', 'RANGING')
 * @returns Telegram markdown string, truncated to ≤ 500 characters
 */
export function formatTelegramSummary(metrics: AggregateMetrics, regime: string): string {
  const topRejections = Object.entries(metrics.rejectionDistribution)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 3)
    .map(([key, { count }]) => `${key}: ${count}`)
    .join(', ');

  const nearMissCount = Object.values(metrics.nearMissFrequency)
    .reduce((a, b) => a + b, 0);

  const lines = [
    `📊 *Pipeline (24h)*`,
    `Evals: ${metrics.evaluationsPerHour * 24 | 0} | Signals: ${metrics.signalsPerHour * 24 | 0}`,
    `Pass-through: ${(metrics.passThroughRate * 100).toFixed(1)}%`,
    `Rejections: ${topRejections || 'none'}`,
    `Near-misses: ${nearMissCount}`,
    `Regime: ${regime}`,
  ];

  return lines.join('\n').slice(0, MAX_TELEGRAM_LENGTH);
}

/**
 * Compute aggregate metrics from the database and format as a Telegram summary.
 *
 * Combines metric computation with formatting in a single call for convenience.
 * Returns a fallback string if the database is in degraded mode or null.
 *
 * @param db - MetricsDatabase instance to query (or null if unavailable)
 * @param currentRegime - Current market regime string
 * @returns Formatted Telegram markdown string, or fallback if DB unavailable
 */
export function getPipelineTelegramSummary(db: MetricsDatabase | null, currentRegime: string = 'UNKNOWN'): string {
  if (!db || db.isDegraded) {
    return FALLBACK_MESSAGE;
  }

  try {
    const metrics = computeAggregateMetrics(db, 24);
    return formatTelegramSummary(metrics, currentRegime);
  } catch {
    return FALLBACK_MESSAGE;
  }
}

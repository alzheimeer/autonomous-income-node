/**
 * Tests for Pipeline Metrics - Telegram Summary Formatter
 *
 * Validates: Requirements 7.1, 7.2, 7.3
 */

import { describe, it, expect } from 'vitest';
import { formatTelegramSummary, getPipelineTelegramSummary } from './telegram-summary.js';
import type { AggregateMetrics } from './aggregate-metrics.js';
import type { MetricsDatabase } from './metrics-database.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createMetrics(overrides: Partial<AggregateMetrics> = {}): AggregateMetrics {
  return {
    signalsPerHour: 2.5,
    evaluationsPerHour: 60,
    regimeDistribution: { TRENDING_UP: 40, RANGING: 35, UNCERTAIN: 25 },
    rejectionDistribution: {
      profit_below_min_usd: { count: 15, percentage: 50 },
      entry_impact_high: { count: 10, percentage: 33.3 },
      gas_exceeds_budget: { count: 5, percentage: 16.7 },
    },
    nearMissFrequency: { rsi14: 3, volume_z: 2, price_vs_ema20: 1 },
    passThroughRate: 0.35,
    dataIncomplete: false,
    ...overrides,
  };
}

function createDegradedDb(): MetricsDatabase {
  return { isDegraded: true } as unknown as MetricsDatabase;
}

// ═══════════════════════════════════════════════════════════════════════════
// formatTelegramSummary tests
// ═══════════════════════════════════════════════════════════════════════════

describe('formatTelegramSummary', () => {
  it('should include all required sections', () => {
    const metrics = createMetrics();
    const result = formatTelegramSummary(metrics, 'TRENDING_UP');

    expect(result).toContain('📊 *Pipeline (24h)*');
    expect(result).toContain('Evals:');
    expect(result).toContain('Signals:');
    expect(result).toContain('Pass-through:');
    expect(result).toContain('Rejections:');
    expect(result).toContain('Near-misses:');
    expect(result).toContain('Regime: TRENDING_UP');
  });

  it('should compute 24h totals from hourly rates', () => {
    const metrics = createMetrics({
      signalsPerHour: 2.5,
      evaluationsPerHour: 60,
    });
    const result = formatTelegramSummary(metrics, 'RANGING');

    // 2.5 * 24 = 60, 60 * 24 = 1440
    expect(result).toContain('Evals: 1440');
    expect(result).toContain('Signals: 60');
  });

  it('should format pass-through rate as percentage with 1 decimal', () => {
    const metrics = createMetrics({ passThroughRate: 0.356 });
    const result = formatTelegramSummary(metrics, 'RANGING');

    expect(result).toContain('Pass-through: 35.6%');
  });

  it('should show top 3 rejections sorted by count descending', () => {
    const metrics = createMetrics({
      rejectionDistribution: {
        profit_below_min_usd: { count: 15, percentage: 50 },
        entry_impact_high: { count: 10, percentage: 33.3 },
        gas_exceeds_budget: { count: 5, percentage: 16.7 },
        entry_quote_stale: { count: 2, percentage: 6.7 },
      },
    });
    const result = formatTelegramSummary(metrics, 'RANGING');

    // Should only include top 3
    expect(result).toContain('profit_below_min_usd: 15');
    expect(result).toContain('entry_impact_high: 10');
    expect(result).toContain('gas_exceeds_budget: 5');
    expect(result).not.toContain('entry_quote_stale');
  });

  it('should show "none" when no rejections exist', () => {
    const metrics = createMetrics({ rejectionDistribution: {} });
    const result = formatTelegramSummary(metrics, 'UNCERTAIN');

    expect(result).toContain('Rejections: none');
  });

  it('should sum all near-miss frequencies', () => {
    const metrics = createMetrics({
      nearMissFrequency: { rsi14: 3, volume_z: 2, price_vs_ema20: 1 },
    });
    const result = formatTelegramSummary(metrics, 'TRENDING_UP');

    expect(result).toContain('Near-misses: 6');
  });

  it('should show 0 near-misses when frequency map is empty', () => {
    const metrics = createMetrics({ nearMissFrequency: {} });
    const result = formatTelegramSummary(metrics, 'RANGING');

    expect(result).toContain('Near-misses: 0');
  });

  it('should not exceed 500 characters', () => {
    // Create metrics with very long rejection keys
    const longRejections: Record<string, { count: number; percentage: number }> = {};
    for (let i = 0; i < 20; i++) {
      longRejections[`very_long_rejection_reason_name_number_${i}`] = { count: 100 - i, percentage: 5 };
    }
    const metrics = createMetrics({ rejectionDistribution: longRejections });
    const result = formatTelegramSummary(metrics, 'TRENDING_UP');

    expect(result.length).toBeLessThanOrEqual(500);
  });

  it('should use Telegram-compatible markdown with newline separators', () => {
    const metrics = createMetrics();
    const result = formatTelegramSummary(metrics, 'TRENDING_UP');

    // Uses *bold* for header (Telegram MarkdownV1)
    expect(result).toContain('*Pipeline (24h)*');
    // Uses newlines as separators
    expect(result.split('\n').length).toBeGreaterThanOrEqual(6);
  });

  it('should return a string type', () => {
    const metrics = createMetrics();
    const result = formatTelegramSummary(metrics, 'TRENDING_UP');

    expect(typeof result).toBe('string');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getPipelineTelegramSummary tests
// ═══════════════════════════════════════════════════════════════════════════

describe('getPipelineTelegramSummary', () => {
  it('should return fallback string when db is degraded', () => {
    const db = createDegradedDb();
    const result = getPipelineTelegramSummary(db, 'TRENDING_UP');

    expect(result).toBe('📊 Pipeline metrics unavailable');
  });

  it('should return fallback string when db is null', () => {
    const result = getPipelineTelegramSummary(null, 'TRENDING_UP');

    expect(result).toBe('📊 Pipeline metrics unavailable');
  });

  it('should return a plain string (not an object)', () => {
    const db = createDegradedDb();
    const result = getPipelineTelegramSummary(db, 'RANGING');

    expect(typeof result).toBe('string');
  });
});

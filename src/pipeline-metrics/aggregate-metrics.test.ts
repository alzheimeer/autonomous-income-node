/**
 * Tests for aggregate metrics computation.
 * Uses in-memory SQLite to avoid test pollution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createMetricsDatabase, MetricsDatabase } from './metrics-database.js';
import { computeAggregateMetrics } from './aggregate-metrics.js';
import type { AggregateMetrics } from './aggregate-metrics.js';

describe('computeAggregateMetrics', () => {
  let db: MetricsDatabase;

  beforeEach(() => {
    db = createMetricsDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('returns empty metrics with dataIncomplete=true when no events exist', () => {
    const metrics = computeAggregateMetrics(db);

    expect(metrics.signalsPerHour).toBe(0);
    expect(metrics.evaluationsPerHour).toBe(0);
    expect(metrics.regimeDistribution).toEqual({});
    expect(metrics.rejectionDistribution).toEqual({});
    expect(metrics.nearMissFrequency).toEqual({});
    expect(metrics.passThroughRate).toBe(0);
    expect(metrics.dataIncomplete).toBe(true);
  });

  it('returns dataIncomplete=true when data span is less than 1 hour', () => {
    const now = Date.now();
    // Insert events spanning only 30 minutes
    db.insertEvent(now - 30 * 60 * 1000, 'evaluation_started', {}, 'session-1');
    db.insertEvent(now - 15 * 60 * 1000, 'evaluation_started', {}, 'session-1');
    db.insertEvent(now, 'evaluation_started', {}, 'session-1');

    const metrics = computeAggregateMetrics(db);

    expect(metrics.dataIncomplete).toBe(true);
  });

  it('returns dataIncomplete=false when data span exceeds 1 hour', () => {
    const now = Date.now();
    // Insert events spanning 2 hours
    db.insertEvent(now - 2 * 60 * 60 * 1000, 'evaluation_started', {}, 'session-1');
    db.insertEvent(now, 'evaluation_started', {}, 'session-1');

    const metrics = computeAggregateMetrics(db);

    expect(metrics.dataIncomplete).toBe(false);
  });

  it('computes signalsPerHour correctly', () => {
    const now = Date.now();
    // Insert 6 signal events spanning 3 hours
    for (let i = 0; i < 6; i++) {
      db.insertEvent(
        now - (3 * 60 * 60 * 1000) + (i * 30 * 60 * 1000),
        'strategy_signal_generated',
        { regime: 'TRENDING_UP' },
        'session-1',
      );
    }
    // Add start/end markers so data span = 3 hours
    db.insertEvent(now - 3 * 60 * 60 * 1000, 'evaluation_started', {}, 'session-1');
    db.insertEvent(now, 'evaluation_started', {}, 'session-1');

    const metrics = computeAggregateMetrics(db);

    // 6 signals over ~3 hours = 2 signals/hour
    expect(metrics.signalsPerHour).toBeCloseTo(2, 0);
  });

  it('computes evaluationsPerHour correctly', () => {
    const now = Date.now();
    // Insert 12 evaluation events spanning 4 hours
    for (let i = 0; i < 12; i++) {
      db.insertEvent(
        now - (4 * 60 * 60 * 1000) + (i * 20 * 60 * 1000),
        'evaluation_started',
        {},
        'session-1',
      );
    }

    const metrics = computeAggregateMetrics(db);

    // 12 evaluations over 4 hours = 3 evaluations/hour (approx)
    expect(metrics.evaluationsPerHour).toBeCloseTo(3, 0);
  });

  it('computes passThroughRate correctly', () => {
    const now = Date.now();
    // 3 gate_passed, 7 gate_rejected = 30% pass-through
    for (let i = 0; i < 3; i++) {
      db.insertEvent(now - (i + 1) * 60 * 60 * 1000, 'gate_passed', {}, 'session-1');
    }
    for (let i = 0; i < 7; i++) {
      db.insertEvent(now - (i + 1) * 60 * 60 * 1000, 'gate_rejected', {}, 'session-1');
    }

    const metrics = computeAggregateMetrics(db);

    expect(metrics.passThroughRate).toBeCloseTo(0.3, 2);
  });

  it('computes passThroughRate as 0 when no gate decisions exist', () => {
    const now = Date.now();
    db.insertEvent(now - 2 * 60 * 60 * 1000, 'evaluation_started', {}, 'session-1');
    db.insertEvent(now, 'evaluation_started', {}, 'session-1');

    const metrics = computeAggregateMetrics(db);

    expect(metrics.passThroughRate).toBe(0);
  });

  it('computes regimeDistribution from indicators_computed events', () => {
    const now = Date.now();
    // 3 TRENDING_UP, 2 RANGING, 1 VOLATILE = 50%, 33.33%, 16.67%
    db.insertEvent(now - 6 * 60 * 60 * 1000, 'indicators_computed', { regime: 'TRENDING_UP' }, 's1');
    db.insertEvent(now - 5 * 60 * 60 * 1000, 'indicators_computed', { regime: 'TRENDING_UP' }, 's1');
    db.insertEvent(now - 4 * 60 * 60 * 1000, 'indicators_computed', { regime: 'TRENDING_UP' }, 's1');
    db.insertEvent(now - 3 * 60 * 60 * 1000, 'indicators_computed', { regime: 'RANGING' }, 's1');
    db.insertEvent(now - 2 * 60 * 60 * 1000, 'indicators_computed', { regime: 'RANGING' }, 's1');
    db.insertEvent(now - 1 * 60 * 60 * 1000, 'indicators_computed', { regime: 'VOLATILE' }, 's1');

    const metrics = computeAggregateMetrics(db);

    expect(metrics.regimeDistribution['TRENDING_UP']).toBe(50);
    expect(metrics.regimeDistribution['RANGING']).toBeCloseTo(33.33, 1);
    expect(metrics.regimeDistribution['VOLATILE']).toBeCloseTo(16.67, 1);
  });

  it('computes rejectionDistribution from rejection_reasons table', () => {
    const now = Date.now();
    // Insert gate_rejected events with associated rejection reasons
    const eid1 = db.insertEvent(now - 3 * 60 * 60 * 1000, 'gate_rejected', {}, 's1');
    db.insertRejection(eid1, 'profit_below_min_usd', '0.5');
    db.insertRejection(eid1, 'gas_exceeds_budget', '0.02');

    const eid2 = db.insertEvent(now - 2 * 60 * 60 * 1000, 'gate_rejected', {}, 's1');
    db.insertRejection(eid2, 'profit_below_min_usd', '0.3');

    const eid3 = db.insertEvent(now - 1 * 60 * 60 * 1000, 'gate_rejected', {}, 's1');
    db.insertRejection(eid3, 'entry_impact_high', '50');

    const metrics = computeAggregateMetrics(db);

    expect(metrics.rejectionDistribution['profit_below_min_usd'].count).toBe(2);
    expect(metrics.rejectionDistribution['gas_exceeds_budget'].count).toBe(1);
    expect(metrics.rejectionDistribution['entry_impact_high'].count).toBe(1);
    // Total = 4 rejections: 2/4=50%, 1/4=25%, 1/4=25%
    expect(metrics.rejectionDistribution['profit_below_min_usd'].percentage).toBe(50);
    expect(metrics.rejectionDistribution['gas_exceeds_budget'].percentage).toBe(25);
  });

  it('computes nearMissFrequency from near_misses table', () => {
    const now = Date.now();
    const eid1 = db.insertEvent(now - 3 * 60 * 60 * 1000, 'strategy_no_signal', {}, 's1');
    db.insertNearMiss(eid1, 'rsi14', 33.5, 35, 1.5);
    db.insertNearMiss(eid1, 'volume_z', 0.9, 1.0, 0.1);

    const eid2 = db.insertEvent(now - 2 * 60 * 60 * 1000, 'strategy_no_signal', {}, 's1');
    db.insertNearMiss(eid2, 'rsi14', 34.0, 35, 1.0);

    const metrics = computeAggregateMetrics(db);

    expect(metrics.nearMissFrequency['rsi14']).toBe(2);
    expect(metrics.nearMissFrequency['volume_z']).toBe(1);
  });

  it('respects the window parameter (only counts events within window)', () => {
    const now = Date.now();
    // Event within 2h window
    db.insertEvent(now - 1 * 60 * 60 * 1000, 'evaluation_started', {}, 's1');
    db.insertEvent(now, 'evaluation_started', {}, 's1');
    // Event outside 2h window (3 hours ago)
    db.insertEvent(now - 3 * 60 * 60 * 1000, 'evaluation_started', {}, 's1');

    const metrics = computeAggregateMetrics(db, 2);

    // Only 2 events are within the 2h window
    expect(metrics.evaluationsPerHour).toBeCloseTo(2, 0);
  });

  it('clamps window to maximum 168 hours', () => {
    const now = Date.now();
    db.insertEvent(now - 2 * 60 * 60 * 1000, 'evaluation_started', {}, 's1');
    db.insertEvent(now, 'evaluation_started', {}, 's1');

    // Should not throw with window > 168
    const metrics = computeAggregateMetrics(db, 500);

    expect(metrics).toBeDefined();
    expect(metrics.evaluationsPerHour).toBeGreaterThan(0);
  });

  it('handles degraded database gracefully', () => {
    // Create a DB that will fail (invalid path on most systems)
    const degradedDb = createMetricsDatabase('/nonexistent/path/to/db.sqlite');

    const metrics = computeAggregateMetrics(degradedDb);

    expect(metrics.dataIncomplete).toBe(true);
    expect(metrics.signalsPerHour).toBe(0);
    expect(metrics.evaluationsPerHour).toBe(0);
    expect(metrics.passThroughRate).toBe(0);

    degradedDb.close();
  });

  it('correctly conforms to AggregateMetrics interface shape', () => {
    const metrics = computeAggregateMetrics(db);

    // Verify all required fields exist
    const requiredKeys: (keyof AggregateMetrics)[] = [
      'signalsPerHour',
      'evaluationsPerHour',
      'regimeDistribution',
      'rejectionDistribution',
      'nearMissFrequency',
      'passThroughRate',
      'dataIncomplete',
    ];

    for (const key of requiredKeys) {
      expect(metrics).toHaveProperty(key);
    }

    expect(typeof metrics.signalsPerHour).toBe('number');
    expect(typeof metrics.evaluationsPerHour).toBe('number');
    expect(typeof metrics.regimeDistribution).toBe('object');
    expect(typeof metrics.rejectionDistribution).toBe('object');
    expect(typeof metrics.nearMissFrequency).toBe('object');
    expect(typeof metrics.passThroughRate).toBe('number');
    expect(typeof metrics.dataIncomplete).toBe('boolean');
  });
});

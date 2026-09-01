/**
 * Unit tests for baseline strategy initialization.
 *
 * Uses an in-memory SQLite database via EvolutionDatabase(':memory:').
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvolutionDatabase } from './evolution-database.js';
import { StrategyRegistry } from './strategy-registry.js';
import { initializeBaseline, BASELINE_PARAMETERS, BASELINE_EVIDENCE } from './baseline.js';

describe('initializeBaseline', () => {
  let db: EvolutionDatabase;

  beforeEach(() => {
    db = new EvolutionDatabase(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('should create baseline_v1 entry on first run', () => {
    const created = initializeBaseline(db);
    expect(created).toBe(true);

    const strategies = db.getStrategiesByStatus('ARCHIVED_BASELINE');
    expect(strategies).toHaveLength(1);
  });

  it('should be idempotent — second call returns false and does not duplicate', () => {
    initializeBaseline(db);
    const secondCall = initializeBaseline(db);
    expect(secondCall).toBe(false);

    const strategies = db.getStrategiesByStatus('ARCHIVED_BASELINE');
    expect(strategies).toHaveLength(1);
  });

  it('should set parent_id to null (root of lineage)', () => {
    initializeBaseline(db);
    const [baseline] = db.getStrategiesByStatus('ARCHIVED_BASELINE');
    expect(baseline.parent_id).toBeNull();
  });

  it('should store correct parameters from informe30-23-07-2026.md', () => {
    initializeBaseline(db);
    const [baseline] = db.getStrategiesByStatus('ARCHIVED_BASELINE');

    expect(baseline.parameters).toEqual(BASELINE_PARAMETERS);
    expect(baseline.parameters.entry_tf).toBe('15m');
    expect(baseline.parameters.regime_tf).toBe('1h');
    expect(baseline.parameters.stop_atr).toBe(1.5);
    expect(baseline.parameters.tp_atr).toBe(2.0);
    expect(baseline.parameters.rsi_trend).toEqual([35, 50]);
    expect(baseline.parameters.rsi_reversion).toBe(30);
    expect(baseline.parameters.volumeZ).toBe(1.0);
    expect(baseline.parameters.trade_size).toBe('$10');
  });

  it('should store evidence metadata with NEGATIVE_EXPECTANCY verdict', () => {
    initializeBaseline(db);
    const [baseline] = db.getStrategiesByStatus('ARCHIVED_BASELINE');

    expect(baseline.evidence).toEqual(BASELINE_EVIDENCE);
    expect(baseline.evidence.verdict).toBe('NEGATIVE_EXPECTANCY');
    expect(baseline.evidence.trades).toBe(17);
    expect(baseline.evidence.win_rate).toBe(0);
    expect(baseline.evidence.pnl).toBe('-2100000');
    expect(baseline.evidence.period).toBe('30d');
    expect(baseline.evidence.source).toBe('docs/informe30-23-07-2026.md');
  });

  it('should compute a valid config_hash (SHA-256 hex)', () => {
    initializeBaseline(db);
    const [baseline] = db.getStrategiesByStatus('ARCHIVED_BASELINE');

    // SHA-256 hex is 64 characters
    expect(baseline.config_hash).toMatch(/^[0-9a-f]{64}$/);

    // Verify it matches the expected computation
    const registry = new StrategyRegistry(db);
    const expectedHash = registry.computeConfigHash(BASELINE_PARAMETERS);
    expect(baseline.config_hash).toBe(expectedHash);
  });

  it('should include baseline tags for searchability', () => {
    initializeBaseline(db);
    const [baseline] = db.getStrategiesByStatus('ARCHIVED_BASELINE');

    expect(baseline.tags).toContain('baseline');
    expect(baseline.tags).toContain('v1');
    expect(baseline.tags).toContain('informe30');
  });

  it('should set best_regime to TRENDING_UP', () => {
    initializeBaseline(db);
    const [baseline] = db.getStrategiesByStatus('ARCHIVED_BASELINE');

    expect(baseline.best_regime).toEqual(['TRENDING_UP']);
  });

  it('should have a UUID strategy_id', () => {
    initializeBaseline(db);
    const [baseline] = db.getStrategiesByStatus('ARCHIVED_BASELINE');

    // UUID v4 pattern
    expect(baseline.strategy_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('should set revival_rules to null', () => {
    initializeBaseline(db);
    const [baseline] = db.getStrategiesByStatus('ARCHIVED_BASELINE');

    expect(baseline.revival_rules).toBeNull();
  });
});

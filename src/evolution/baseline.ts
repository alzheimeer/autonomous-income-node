/**
 * Strategy Evolution Lab — Baseline Strategy Initialization
 *
 * Creates the baseline_v1 entry with ARCHIVED_BASELINE status on first run.
 * Parameters and evidence sourced from docs/informe30-23-07-2026.md.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4
 */

import { randomUUID } from 'node:crypto';
import { EvolutionDatabase } from './evolution-database.js';
import { StrategyRegistry } from './strategy-registry.js';
import type { StrategyParameters, StrategyEvidence } from './types.js';

/**
 * Baseline strategy parameters from informe30-23-07-2026.md
 */
export const BASELINE_PARAMETERS: StrategyParameters = {
  entry_tf: '15m',
  regime_tf: '1h',
  stop_atr: 1.5,
  tp_atr: 2.0,
  rsi_trend: [35, 50],
  rsi_reversion: 30,
  volumeZ: 1.0,
  trade_size: '$10',
};

/**
 * Evidence from the 30-day backtest report.
 * PnL stored as integer text (BigInt pattern): -$2.10 = -2100000 in 6-decimal USDC.
 */
export const BASELINE_EVIDENCE: StrategyEvidence = {
  source: 'docs/informe30-23-07-2026.md',
  verdict: 'NEGATIVE_EXPECTANCY',
  trades: 17,
  win_rate: 0,
  pnl: '-2100000',
  period: '30d',
};

/**
 * Initialize the baseline strategy if not already present.
 * Should be called on first database open / application startup.
 *
 * Idempotent: returns true if baseline was created, false if already existed.
 */
export function initializeBaseline(db: EvolutionDatabase): boolean {
  // Check if baseline already exists — idempotent guard
  const existing = db.getStrategiesByStatus('ARCHIVED_BASELINE');
  if (existing.length > 0) {
    return false;
  }

  const registry = new StrategyRegistry(db);
  const configHash = registry.computeConfigHash(BASELINE_PARAMETERS);

  db.insertStrategy({
    strategy_id: randomUUID(),
    parent_id: null,
    status: 'ARCHIVED_BASELINE',
    config_hash: configHash,
    parameters: BASELINE_PARAMETERS,
    tags: ['baseline', 'v1', 'informe30'],
    best_regime: ['TRENDING_UP'],
    evidence: BASELINE_EVIDENCE,
    notes: 'Original production strategy from 30-day backtest. NEGATIVE_EXPECTANCY verdict.',
    archived_reason: 'Baseline reference — not for active trading',
    revival_rules: null,
  });

  return true;
}

/**
 * Strategy Evolution Lab — Database Adapter
 *
 * SQLite database for strategy lifecycle, experiments, state transitions,
 * and pending promotions. Uses `data/evolution.db`.
 *
 * Follows the same `node:sqlite` DatabaseSync pattern as MetricsDatabase.
 *
 * Features:
 *   - 4 tables: strategies, experiments, state_transitions, pending_promotions
 *   - Degraded mode: if DB inaccessible, logs error and all operations become no-ops
 *   - JSON serialization for complex fields (parameters, tags, evidence, etc.)
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 15.2, 15.5
 */

import { createRequire } from 'node:module';
import { createLogger } from '../logger.js';
import type {
  StrategyRecord,
  StrategyStatus,
  ExperimentRecord,
  ExperimentPhase,
  TransitionRecord,
  PendingPromotion,
} from './types.js';
import { VALID_STATUSES } from './types.js';

const log = createLogger('evolution-db');

// Use createRequire to load node:sqlite — avoids Vite module resolution issues
const require = createRequire(import.meta.url);
const { DatabaseSync: NativeDatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => NativeDatabase;
};

/** Minimal type for the native DatabaseSync instance */
interface NativeDatabase {
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
}

interface NativeStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema SQL
// ═══════════════════════════════════════════════════════════════════════════

const SCHEMA_SQL = `
-- Strategies table
CREATE TABLE IF NOT EXISTS strategies (
  strategy_id TEXT PRIMARY KEY,
  parent_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN (
    'CANDIDATE','BACKTESTING','BACKTEST_PASS','BACKTEST_FAIL',
    'SHADOW','SHADOW_PASS','SHADOW_FAIL',
    'MICRO','MICRO_PASS','MICRO_FAIL',
    'ACTIVE','PAUSED','DORMANT','ARCHIVED_BASELINE','REJECTED'
  )),
  config_hash TEXT NOT NULL,
  parameters TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  best_regime TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '{}',
  notes TEXT NOT NULL DEFAULT '',
  archived_reason TEXT NOT NULL DEFAULT '',
  revival_rules TEXT
);

CREATE INDEX IF NOT EXISTS idx_strategies_status ON strategies(status);
CREATE INDEX IF NOT EXISTS idx_strategies_parent ON strategies(parent_id);
CREATE INDEX IF NOT EXISTS idx_strategies_hash ON strategies(config_hash);

-- Experiments table
CREATE TABLE IF NOT EXISTS experiments (
  experiment_id TEXT PRIMARY KEY,
  strategy_id TEXT NOT NULL REFERENCES strategies(strategy_id),
  parent_id TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('BACKTEST','SHADOW','MICRO')),
  hypothesis TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL DEFAULT '',
  market_context TEXT NOT NULL DEFAULT '{}',
  metrics TEXT NOT NULL DEFAULT '{}',
  verdict TEXT NOT NULL DEFAULT '',
  score REAL NOT NULL DEFAULT 0.0,
  promoted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_experiments_strategy ON experiments(strategy_id);
CREATE INDEX IF NOT EXISTS idx_experiments_phase ON experiments(phase);

-- State transitions log
CREATE TABLE IF NOT EXISTS state_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id TEXT NOT NULL REFERENCES strategies(strategy_id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  experiment_id TEXT,
  timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transitions_strategy ON state_transitions(strategy_id);

-- Pending promotions (approval gate)
CREATE TABLE IF NOT EXISTS pending_promotions (
  strategy_id TEXT PRIMARY KEY REFERENCES strategies(strategy_id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT,
  approved INTEGER
);
`;

// ═══════════════════════════════════════════════════════════════════════════
// Row types (raw DB rows before deserialization)
// ═══════════════════════════════════════════════════════════════════════════

interface StrategyRow {
  strategy_id: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  status: string;
  config_hash: string;
  parameters: string;
  tags: string;
  best_regime: string;
  evidence: string;
  notes: string;
  archived_reason: string;
  revival_rules: string | null;
}

interface ExperimentRow {
  experiment_id: string;
  strategy_id: string;
  parent_id: string | null;
  phase: string;
  hypothesis: string;
  period: string;
  market_context: string;
  metrics: string;
  verdict: string;
  score: number;
  promoted: number;
  created_at: string;
}

interface TransitionRow {
  id: number;
  strategy_id: string;
  from_status: string;
  to_status: string;
  reason: string;
  experiment_id: string | null;
  timestamp: string;
}

interface PendingPromotionRow {
  strategy_id: string;
  from_status: string;
  to_status: string;
  created_at: string;
  resolved: number;
  resolved_at: string | null;
  approved: number | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// EvolutionDatabase
// ═══════════════════════════════════════════════════════════════════════════

/**
 * EvolutionDatabase provides storage for strategy lifecycle management,
 * experiments, state transitions, and pending promotions.
 *
 * Operates in degraded mode if the database file is inaccessible —
 * all write/read methods become no-ops returning empty arrays or null.
 */
export class EvolutionDatabase {
  private db: NativeDatabase | null = null;
  private degraded = false;

  constructor(path: string = 'data/evolution.db') {
    try {
      this.db = new NativeDatabaseSync(path);
      this.db.exec(SCHEMA_SQL);
      log.info('EvolutionDatabase initialized', { path });
    } catch (err) {
      this.degraded = true;
      this.db = null;
      log.error('EvolutionDatabase failed to initialize — operating in degraded mode', {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Whether the database is operating in degraded (no-op) mode */
  get isDegraded(): boolean {
    return this.degraded;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Strategy Registry
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert a new strategy record. created_at and updated_at are auto-set.
   */
  insertStrategy(record: Omit<StrategyRecord, 'created_at' | 'updated_at'>): void {
    if (!this.db) return;
    try {
      const now = new Date().toISOString();
      const stmt = this.db.prepare(`
        INSERT INTO strategies (
          strategy_id, parent_id, created_at, updated_at, status, config_hash,
          parameters, tags, best_regime, evidence, notes, archived_reason, revival_rules
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.strategy_id,
        record.parent_id,
        now,
        now,
        record.status,
        record.config_hash,
        JSON.stringify(record.parameters),
        JSON.stringify(record.tags),
        JSON.stringify(record.best_regime),
        JSON.stringify(record.evidence),
        record.notes,
        record.archived_reason,
        record.revival_rules ? JSON.stringify(record.revival_rules) : null,
      );
    } catch (err) {
      log.error('insertStrategy failed', {
        strategy_id: record.strategy_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get a single strategy by ID.
   */
  getStrategy(strategyId: string): StrategyRecord | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare('SELECT * FROM strategies WHERE strategy_id = ?');
      const row = stmt.get(strategyId) as StrategyRow | undefined;
      return row ? this.deserializeStrategy(row) : null;
    } catch (err) {
      log.error('getStrategy failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Get all strategies with a given status.
   */
  getStrategiesByStatus(status: StrategyStatus): StrategyRecord[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare('SELECT * FROM strategies WHERE status = ?');
      const rows = stmt.all(status) as StrategyRow[];
      return rows.map((r) => this.deserializeStrategy(r));
    } catch (err) {
      log.error('getStrategiesByStatus failed', {
        status,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Get all strategies in the registry.
   */
  getAllStrategies(): StrategyRecord[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare('SELECT * FROM strategies');
      const rows = stmt.all() as StrategyRow[];
      return rows.map((r) => this.deserializeStrategy(r));
    } catch (err) {
      log.error('getAllStrategies failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Update strategy status with validation. Also updates updated_at.
   */
  updateStatus(strategyId: string, newStatus: StrategyStatus, reason: string): void {
    if (!this.db) return;
    try {
      if (!VALID_STATUSES.includes(newStatus)) {
        log.warn('updateStatus called with invalid status', { strategyId, newStatus });
        return;
      }
      const now = new Date().toISOString();
      const stmt = this.db.prepare(
        'UPDATE strategies SET status = ?, updated_at = ? WHERE strategy_id = ?',
      );
      stmt.run(newStatus, now, strategyId);
      log.info('Strategy status updated', { strategyId, newStatus, reason });
    } catch (err) {
      log.error('updateStatus failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Partial update of a strategy record.
   */
  updateStrategy(strategyId: string, updates: Partial<StrategyRecord>): void {
    if (!this.db) return;
    try {
      const setClauses: string[] = [];
      const values: unknown[] = [];

      if (updates.status !== undefined) {
        setClauses.push('status = ?');
        values.push(updates.status);
      }
      if (updates.config_hash !== undefined) {
        setClauses.push('config_hash = ?');
        values.push(updates.config_hash);
      }
      if (updates.parameters !== undefined) {
        setClauses.push('parameters = ?');
        values.push(JSON.stringify(updates.parameters));
      }
      if (updates.tags !== undefined) {
        setClauses.push('tags = ?');
        values.push(JSON.stringify(updates.tags));
      }
      if (updates.best_regime !== undefined) {
        setClauses.push('best_regime = ?');
        values.push(JSON.stringify(updates.best_regime));
      }
      if (updates.evidence !== undefined) {
        setClauses.push('evidence = ?');
        values.push(JSON.stringify(updates.evidence));
      }
      if (updates.notes !== undefined) {
        setClauses.push('notes = ?');
        values.push(updates.notes);
      }
      if (updates.archived_reason !== undefined) {
        setClauses.push('archived_reason = ?');
        values.push(updates.archived_reason);
      }
      if (updates.revival_rules !== undefined) {
        setClauses.push('revival_rules = ?');
        values.push(updates.revival_rules ? JSON.stringify(updates.revival_rules) : null);
      }
      if (updates.parent_id !== undefined) {
        setClauses.push('parent_id = ?');
        values.push(updates.parent_id);
      }

      if (setClauses.length === 0) return;

      // Always update updated_at
      setClauses.push('updated_at = ?');
      values.push(new Date().toISOString());

      values.push(strategyId);

      const sql = `UPDATE strategies SET ${setClauses.join(', ')} WHERE strategy_id = ?`;
      const stmt = this.db.prepare(sql);
      stmt.run(...values);
    } catch (err) {
      log.error('updateStrategy failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Experiment Ledger
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert a new experiment record.
   */
  insertExperiment(record: ExperimentRecord): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO experiments (
          experiment_id, strategy_id, parent_id, phase, hypothesis, period,
          market_context, metrics, verdict, score, promoted, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        record.experiment_id,
        record.strategy_id,
        record.parent_id,
        record.phase,
        record.hypothesis,
        record.period,
        JSON.stringify(record.market_context),
        JSON.stringify(record.metrics),
        record.verdict,
        record.score,
        record.promoted ? 1 : 0,
        record.created_at,
      );
    } catch (err) {
      log.error('insertExperiment failed', {
        experiment_id: record.experiment_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get a single experiment by ID.
   */
  getExperiment(experimentId: string): ExperimentRecord | null {
    if (!this.db) return null;
    try {
      const stmt = this.db.prepare('SELECT * FROM experiments WHERE experiment_id = ?');
      const row = stmt.get(experimentId) as ExperimentRow | undefined;
      return row ? this.deserializeExperiment(row) : null;
    } catch (err) {
      log.error('getExperiment failed', {
        experiment_id: experimentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Get all experiments for a given strategy.
   */
  getExperimentsForStrategy(strategyId: string): ExperimentRecord[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM experiments WHERE strategy_id = ? ORDER BY created_at ASC',
      );
      const rows = stmt.all(strategyId) as ExperimentRow[];
      return rows.map((r) => this.deserializeExperiment(r));
    } catch (err) {
      log.error('getExperimentsForStrategy failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Get the latest experiment for a strategy, optionally filtered by phase.
   */
  getLatestExperiment(strategyId: string, phase?: ExperimentPhase): ExperimentRecord | null {
    if (!this.db) return null;
    try {
      let sql = 'SELECT * FROM experiments WHERE strategy_id = ?';
      const params: unknown[] = [strategyId];

      if (phase) {
        sql += ' AND phase = ?';
        params.push(phase);
      }

      sql += ' ORDER BY created_at DESC LIMIT 1';

      const stmt = this.db.prepare(sql);
      const row = stmt.get(...params) as ExperimentRow | undefined;
      return row ? this.deserializeExperiment(row) : null;
    } catch (err) {
      log.error('getLatestExperiment failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State Transition History
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Record a state transition.
   */
  insertTransition(
    strategyId: string,
    from: StrategyStatus,
    to: StrategyStatus,
    reason: string,
    experimentId?: string,
  ): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT INTO state_transitions (strategy_id, from_status, to_status, reason, experiment_id, timestamp)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      stmt.run(strategyId, from, to, reason, experimentId ?? null, new Date().toISOString());
    } catch (err) {
      log.error('insertTransition failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get all state transitions for a strategy, ordered chronologically.
   */
  getTransitionHistory(strategyId: string): TransitionRecord[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(
        'SELECT * FROM state_transitions WHERE strategy_id = ? ORDER BY timestamp ASC',
      );
      const rows = stmt.all(strategyId) as TransitionRow[];
      return rows.map((r) => ({
        id: r.id,
        strategy_id: r.strategy_id,
        from_status: r.from_status as StrategyStatus,
        to_status: r.to_status as StrategyStatus,
        reason: r.reason,
        experiment_id: r.experiment_id,
        timestamp: r.timestamp,
      }));
    } catch (err) {
      log.error('getTransitionHistory failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pending Promotions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Insert a pending promotion request (approval gate).
   */
  insertPendingPromotion(strategyId: string, from: StrategyStatus, to: StrategyStatus): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO pending_promotions (strategy_id, from_status, to_status, created_at, resolved, resolved_at, approved)
        VALUES (?, ?, ?, ?, 0, NULL, NULL)
      `);
      stmt.run(strategyId, from, to, new Date().toISOString());
    } catch (err) {
      log.error('insertPendingPromotion failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Get all unresolved pending promotions.
   */
  getPendingPromotions(): PendingPromotion[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare('SELECT * FROM pending_promotions WHERE resolved = 0');
      const rows = stmt.all() as PendingPromotionRow[];
      return rows.map((r) => ({
        strategy_id: r.strategy_id,
        from_status: r.from_status as StrategyStatus,
        to_status: r.to_status as StrategyStatus,
        created_at: r.created_at,
        resolved: r.resolved === 1,
        resolved_at: r.resolved_at,
        approved: r.approved === null ? null : r.approved === 1,
      }));
    } catch (err) {
      log.error('getPendingPromotions failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Resolve a pending promotion (approve or reject).
   */
  resolvePendingPromotion(strategyId: string, approved: boolean): void {
    if (!this.db) return;
    try {
      const stmt = this.db.prepare(`
        UPDATE pending_promotions
        SET resolved = 1, resolved_at = ?, approved = ?
        WHERE strategy_id = ?
      `);
      stmt.run(new Date().toISOString(), approved ? 1 : 0, strategyId);
    } catch (err) {
      log.error('resolvePendingPromotion failed', {
        strategy_id: strategyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Close the database connection.
   */
  close(): void {
    if (!this.db) return;
    try {
      this.db.close();
      this.db = null;
      log.info('EvolutionDatabase closed');
    } catch (err) {
      log.error('EvolutionDatabase close failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private deserializeStrategy(row: StrategyRow): StrategyRecord {
    return {
      strategy_id: row.strategy_id,
      parent_id: row.parent_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      status: row.status as StrategyStatus,
      config_hash: row.config_hash,
      parameters: JSON.parse(row.parameters) as StrategyRecord['parameters'],
      tags: JSON.parse(row.tags) as string[],
      best_regime: JSON.parse(row.best_regime) as StrategyRecord['best_regime'],
      evidence: JSON.parse(row.evidence) as StrategyRecord['evidence'],
      notes: row.notes,
      archived_reason: row.archived_reason,
      revival_rules: row.revival_rules
        ? (JSON.parse(row.revival_rules) as StrategyRecord['revival_rules'])
        : null,
    };
  }

  private deserializeExperiment(row: ExperimentRow): ExperimentRecord {
    return {
      experiment_id: row.experiment_id,
      strategy_id: row.strategy_id,
      parent_id: row.parent_id,
      phase: row.phase as ExperimentPhase,
      hypothesis: row.hypothesis,
      period: row.period,
      market_context: JSON.parse(row.market_context) as ExperimentRecord['market_context'],
      metrics: JSON.parse(row.metrics) as ExperimentRecord['metrics'],
      verdict: row.verdict,
      score: row.score,
      promoted: row.promoted === 1,
      created_at: row.created_at,
    };
  }
}

/**
 * Strategy Evolution Lab — Experiment Ledger
 *
 * Higher-level experiment lifecycle operations built on EvolutionDatabase.
 * Provides experiment recording, phase tracking (linking via parent_id),
 * metrics recording on completion, and query helpers.
 *
 * Requirements: 3.1, 3.2, 3.3
 */

import { randomUUID } from 'node:crypto';
import { EvolutionDatabase } from './evolution-database.js';
import type {
  ExperimentRecord,
  ExperimentPhase,
  ExperimentMetrics,
  MarketContext,
} from './types.js';

export interface CreateExperimentInput {
  strategy_id: string;
  parent_id?: string | null;   // previous phase experiment
  phase: ExperimentPhase;
  hypothesis: string;
  period: string;
  market_context: MarketContext;
  metrics: ExperimentMetrics;
  verdict: string;
  score: number;
  promoted: boolean;
}

export class ExperimentLedger {
  constructor(private db: EvolutionDatabase) {}

  /**
   * Record a new experiment. Auto-generates experiment_id and created_at.
   * Returns the generated experiment_id.
   */
  recordExperiment(input: CreateExperimentInput): string {
    const experiment_id = randomUUID();
    const record: ExperimentRecord = {
      experiment_id,
      strategy_id: input.strategy_id,
      parent_id: input.parent_id ?? null,
      phase: input.phase,
      hypothesis: input.hypothesis,
      period: input.period,
      market_context: input.market_context,
      metrics: input.metrics,
      verdict: input.verdict,
      score: input.score,
      promoted: input.promoted,
      created_at: new Date().toISOString(),
    };
    this.db.insertExperiment(record);
    return experiment_id;
  }

  /**
   * Get the latest experiment for a strategy in a given phase.
   */
  getLatestByPhase(strategyId: string, phase: ExperimentPhase): ExperimentRecord | null {
    return this.db.getLatestExperiment(strategyId, phase);
  }

  /**
   * Get the full experiment chain for a strategy (all phases, ordered chronologically).
   * This shows the full journey: BACKTEST → SHADOW → MICRO
   */
  getExperimentChain(strategyId: string): ExperimentRecord[] {
    return this.db.getExperimentsForStrategy(strategyId);
  }

  /**
   * Get all experiments for a strategy.
   */
  getAllForStrategy(strategyId: string): ExperimentRecord[] {
    return this.db.getExperimentsForStrategy(strategyId);
  }

  /**
   * Get a single experiment by ID.
   */
  getById(experimentId: string): ExperimentRecord | null {
    return this.db.getExperiment(experimentId);
  }

  /**
   * Link experiments across phases. When a strategy advances from
   * BACKTEST → SHADOW → MICRO, the new experiment references the
   * previous phase's experiment via parent_id.
   *
   * This helper finds the latest experiment in the previous phase
   * and returns it for use as parent_id in the new experiment.
   */
  getPreviousPhaseExperiment(
    strategyId: string,
    currentPhase: ExperimentPhase,
  ): ExperimentRecord | null {
    const previousPhase = this.getPreviousPhase(currentPhase);
    if (!previousPhase) return null;
    return this.db.getLatestExperiment(strategyId, previousPhase);
  }

  /**
   * Get the phase that precedes the given phase in the lifecycle.
   */
  private getPreviousPhase(phase: ExperimentPhase): ExperimentPhase | null {
    switch (phase) {
      case 'BACKTEST': return null;
      case 'SHADOW': return 'BACKTEST';
      case 'MICRO': return 'SHADOW';
      default: return null;
    }
  }
}

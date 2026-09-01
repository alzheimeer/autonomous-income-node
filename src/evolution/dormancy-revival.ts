/**
 * Strategy Evolution Lab — Dormancy & Revival Logic
 *
 * Manages the lifecycle transitions between ACTIVE → DORMANT (when market regime
 * mismatches persist for 7+ consecutive days) and DORMANT → SHADOW (when revival
 * conditions match for 3+ consecutive days).
 *
 * Requirements: 9.3, 9.4, 9.5
 */

import { EvolutionDatabase } from './evolution-database.js';
import type { RegimeType, StrategyRecord } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('dormancy-revival');

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for dormancy detection and revival evaluation thresholds.
 */
export interface DormancyConfig {
  /** Number of consecutive days of regime mismatch before ACTIVE → DORMANT (default: 7) */
  dormancy_threshold_days: number;
  /** Number of consecutive days of regime match before DORMANT → SHADOW (default: 3) */
  revival_threshold_days: number;
}

const DEFAULT_CONFIG: DormancyConfig = {
  dormancy_threshold_days: 7,
  revival_threshold_days: 3,
};

// ═══════════════════════════════════════════════════════════════════════════
// DormancyRevival
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Handles dormancy detection and revival evaluation for strategy lifecycle.
 *
 * - **Dormancy**: ACTIVE strategies whose `best_regime` does not include the
 *   current regime for 7+ consecutive days are transitioned to DORMANT.
 * - **Revival**: DORMANT strategies whose `revival_rules.regime` includes the
 *   current regime for 3+ consecutive days are transitioned to SHADOW for re-validation.
 */
export class DormancyRevival {
  private config: DormancyConfig;

  constructor(private db: EvolutionDatabase, config?: Partial<DormancyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check ACTIVE strategies for dormancy trigger.
   *
   * If an ACTIVE strategy's `best_regime` does not include the `currentRegime`
   * and the mismatch has persisted for `consecutiveDays` >= dormancy_threshold_days (7),
   * the strategy transitions to DORMANT.
   *
   * @param currentRegime - The currently detected market regime
   * @param consecutiveDays - Number of consecutive days the current regime has been active
   * @returns Array of strategy IDs that were transitioned to DORMANT
   */
  checkDormancy(currentRegime: RegimeType, consecutiveDays: number): string[] {
    if (consecutiveDays < this.config.dormancy_threshold_days) {
      return [];
    }

    const activeStrategies = this.db.getStrategiesByStatus('ACTIVE');
    const transitioned: string[] = [];

    for (const strategy of activeStrategies) {
      if (!this.isRegimeMatch(strategy.best_regime, currentRegime)) {
        this.db.updateStatus(strategy.strategy_id, 'DORMANT', 'regime_mismatch_7d');
        this.db.insertTransition(
          strategy.strategy_id,
          'ACTIVE',
          'DORMANT',
          `Regime mismatch for ${consecutiveDays}d (current: ${currentRegime})`,
        );
        transitioned.push(strategy.strategy_id);
        log.info('Strategy moved to DORMANT', {
          strategy_id: strategy.strategy_id,
          regime: currentRegime,
          days: consecutiveDays,
        });
      }
    }

    return transitioned;
  }

  /**
   * Check DORMANT strategies for revival trigger.
   *
   * If a DORMANT strategy's `revival_rules.regime` includes the `currentRegime`
   * and the match has persisted for `consecutiveDays` >= the strategy's
   * `revival_rules.min_days_matching` (default: 3), the strategy transitions
   * to SHADOW for re-validation.
   *
   * @param currentRegime - The currently detected market regime
   * @param consecutiveDays - Number of consecutive days the current regime has been active
   * @returns Array of strategy IDs that were transitioned to SHADOW
   */
  checkRevival(currentRegime: RegimeType, consecutiveDays: number): string[] {
    if (consecutiveDays < this.config.revival_threshold_days) {
      return [];
    }

    const dormantStrategies = this.db.getStrategiesByStatus('DORMANT');
    const revived: string[] = [];

    for (const strategy of dormantStrategies) {
      if (!strategy.revival_rules) {
        continue;
      }

      const minDays = strategy.revival_rules.min_days_matching || this.config.revival_threshold_days;
      if (consecutiveDays < minDays) {
        continue;
      }

      if (this.isRegimeMatch(strategy.revival_rules.regime, currentRegime)) {
        this.db.updateStatus(strategy.strategy_id, 'SHADOW', 'revival_match_3d');
        this.db.insertTransition(
          strategy.strategy_id,
          'DORMANT',
          'SHADOW',
          `Revival: regime ${currentRegime} matched for ${consecutiveDays}d`,
        );
        revived.push(strategy.strategy_id);
        log.info('Strategy revived to SHADOW', {
          strategy_id: strategy.strategy_id,
          regime: currentRegime,
          days: consecutiveDays,
        });
      }
    }

    return revived;
  }

  /**
   * Run both dormancy and revival checks in a single evaluation pass.
   *
   * @param currentRegime - The currently detected market regime
   * @param consecutiveDays - Number of consecutive days the current regime has been active
   * @returns Object containing arrays of strategy IDs that were made dormant or revived
   */
  evaluate(currentRegime: RegimeType, consecutiveDays: number): {
    dormant: string[];
    revived: string[];
  } {
    const dormant = this.checkDormancy(currentRegime, consecutiveDays);
    const revived = this.checkRevival(currentRegime, consecutiveDays);
    return { dormant, revived };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if a regime list includes the given regime type.
   */
  private isRegimeMatch(regimes: RegimeType[], target: RegimeType): boolean {
    return regimes.includes(target);
  }
}

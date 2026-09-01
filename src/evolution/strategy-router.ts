/**
 * Strategy Router — maps market regimes to recommended strategy types.
 *
 * Determines which strategy should be active based on detected market conditions,
 * identifies ACTIVE strategies that are mismatched for dormancy consideration,
 * and finds DORMANT strategies eligible for revival.
 *
 * Requirements: 9.1, 9.2, 9.3
 */

import { EvolutionDatabase } from './evolution-database.js';
import type { RegimeType } from './types.js';

// ─── Interfaces ─────────────────────────────────────────────────────────────

/** Result of a routing decision for a given regime. */
export interface RoutingDecision {
  /** The strategy_id recommended for activation, or null if none matches. */
  recommended_strategy_id: string | null;
  /** The current regime used for the routing decision. */
  regime: RegimeType;
  /** The strategy type recommended for this regime. */
  strategy_type: string;
  /** Human-readable explanation of the routing decision. */
  reason: string;
}

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Maps each market regime to the strategy types allowed to trade.
 *
 * - TRENDING_UP/DOWN → trend and momentum strategies
 * - RANGING → mean_reversion strategies
 * - VOLATILE/UNCERTAIN → no-trade (empty array)
 */
export const REGIME_STRATEGY_MAP: Record<RegimeType, string[]> = {
  TRENDING_UP: ['trend', 'momentum'],
  TRENDING_DOWN: ['trend', 'momentum'],
  RANGING: ['mean_reversion'],
  VOLATILE: [],
  UNCERTAIN: [],
};

// ─── Router ─────────────────────────────────────────────────────────────────

export class StrategyRouter {
  constructor(private db: EvolutionDatabase) {}

  /**
   * Get routing decision for the current regime.
   *
   * Looks up allowed strategy types for the regime, then searches
   * ACTIVE strategies whose `best_regime` includes the current regime.
   * Returns the first matching strategy or null if none found.
   *
   * @param currentRegime - The detected market regime
   * @returns Routing decision with recommended strategy and reason
   */
  route(currentRegime: RegimeType): RoutingDecision {
    const allowedTypes = REGIME_STRATEGY_MAP[currentRegime];

    // No-trade regimes: VOLATILE and UNCERTAIN
    if (allowedTypes.length === 0) {
      return {
        recommended_strategy_id: null,
        regime: currentRegime,
        strategy_type: 'none',
        reason: 'No-trade regime',
      };
    }

    const active = this.db.getStrategiesByStatus('ACTIVE');
    const matching = active.filter((s) => s.best_regime.includes(currentRegime));

    if (matching.length === 0) {
      return {
        recommended_strategy_id: null,
        regime: currentRegime,
        strategy_type: allowedTypes[0],
        reason: 'No active strategy matches regime',
      };
    }

    return {
      recommended_strategy_id: matching[0].strategy_id,
      regime: currentRegime,
      strategy_type: allowedTypes[0],
      reason: 'Active strategy matches',
    };
  }

  /**
   * Check all ACTIVE strategies for dormancy eligibility.
   *
   * A strategy becomes dormant when it does not match the current regime
   * for 7 or more consecutive days (regime_mismatch_7d trigger).
   *
   * @param currentRegime - The current detected market regime
   * @param consecutiveDays - Number of consecutive days the regime has persisted
   * @returns Array of strategy_ids that should transition to DORMANT
   */
  checkDormancy(currentRegime: RegimeType, consecutiveDays: number): string[] {
    if (consecutiveDays < 7) return [];

    const active = this.db.getStrategiesByStatus('ACTIVE');
    return active
      .filter((s) => !s.best_regime.includes(currentRegime))
      .map((s) => s.strategy_id);
  }

  /**
   * Check DORMANT strategies for revival eligibility.
   *
   * A dormant strategy is eligible for revival when the current regime
   * matches its revival_rules and the match has persisted for 3+ consecutive days.
   * Revived strategies transition to SHADOW for re-validation.
   *
   * @param currentRegime - The current detected market regime
   * @param consecutiveDays - Number of consecutive days the regime has persisted
   * @returns Array of strategy_ids eligible for revival to SHADOW
   */
  checkRevival(currentRegime: RegimeType, consecutiveDays: number): string[] {
    if (consecutiveDays < 3) return [];

    const dormant = this.db.getStrategiesByStatus('DORMANT');
    return dormant
      .filter((s) => s.revival_rules?.regime.includes(currentRegime))
      .map((s) => s.strategy_id);
  }
}

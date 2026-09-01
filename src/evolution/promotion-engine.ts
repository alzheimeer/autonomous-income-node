/**
 * Strategy Evolution Lab — Promotion Engine
 *
 * State machine governing strategy lifecycle transitions with operator approval gates.
 * Enforces valid state transitions, records all transitions with timestamps,
 * and manages pending promotions requiring operator approval.
 *
 * Key behaviors:
 *   - Validates transitions against the VALID_TRANSITIONS map
 *   - Requires operator approval for SHADOW_PASS → MICRO (unless auto_micro_preauthorized)
 *   - Records all transitions with timestamp, reason, and experiment_id
 *   - Exposes pending promotions for CLI/API review
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { EvolutionDatabase } from './evolution-database.js';
import type { StrategyStatus } from './types.js';
import { VALID_TRANSITIONS } from './types.js';
import { createLogger } from '../logger.js';

const log = createLogger('promotion-engine');

// ─── Configuration ──────────────────────────────────────────────────────────

/**
 * Configuration for the Promotion Engine.
 */
export interface PromotionConfig {
  /**
   * When true, SHADOW_PASS → MICRO transitions are auto-approved
   * without requiring operator confirmation.
   * Default: false (operator approval required).
   */
  auto_micro_preauthorized: boolean;
}

/**
 * Result of a promotion attempt.
 */
export interface PromotionResult {
  /** Whether the promotion was executed successfully */
  success: boolean;
  /** The strategy's status before the promotion attempt */
  from: StrategyStatus;
  /** The target status of the promotion attempt */
  to: StrategyStatus;
  /** Whether the transition requires operator approval */
  requires_approval: boolean;
  /** The pending promotion ID if approval is required */
  pending_id?: string;
  /** Human-readable reason for the result */
  reason: string;
}

const DEFAULT_CONFIG: PromotionConfig = {
  auto_micro_preauthorized: false,
};

// ─── Forward progression map ────────────────────────────────────────────────

/**
 * Maps each state to its primary "forward" advancement target.
 * This represents the happy-path progression through the lifecycle.
 * Does not include failure, dormancy, or manual transitions.
 */
const FORWARD_MAP: Partial<Record<StrategyStatus, StrategyStatus>> = {
  'CANDIDATE': 'BACKTESTING',
  'BACKTESTING': 'BACKTEST_PASS',
  'BACKTEST_PASS': 'SHADOW',
  'SHADOW': 'SHADOW_PASS',
  'SHADOW_PASS': 'MICRO',
  'MICRO': 'MICRO_PASS',
  'MICRO_PASS': 'ACTIVE',
};

// ═══════════════════════════════════════════════════════════════════════════
// PromotionEngine
// ═══════════════════════════════════════════════════════════════════════════

/**
 * State machine that governs strategy advancement through lifecycle phases
 * with appropriate approval gates.
 *
 * Responsibilities:
 * - Validate transitions against VALID_TRANSITIONS
 * - Check approval requirements (SHADOW_PASS → MICRO needs operator approval)
 * - Execute valid transitions or create pending promotions
 * - Record all transitions with metadata for auditability
 */
export class PromotionEngine {
  private config: PromotionConfig;

  constructor(
    private db: EvolutionDatabase,
    config?: PromotionConfig,
  ) {
    this.config = config ?? DEFAULT_CONFIG;
  }

  /**
   * Attempt to advance a strategy to its next valid state.
   *
   * If the transition requires approval and auto_micro_preauthorized is false,
   * creates a pending promotion instead of executing immediately.
   *
   * @param strategyId - The strategy to promote
   * @param experimentId - Optional experiment that triggered this promotion
   * @returns PromotionResult with success/failure details
   */
  promote(strategyId: string, experimentId?: string): PromotionResult {
    const strategy = this.db.getStrategy(strategyId);
    if (!strategy) {
      return {
        success: false,
        from: 'CANDIDATE',
        to: 'CANDIDATE',
        requires_approval: false,
        reason: 'Strategy not found',
      };
    }

    const nextState = this.getNextState(strategy.status);
    if (!nextState) {
      return {
        success: false,
        from: strategy.status,
        to: strategy.status,
        requires_approval: false,
        reason: `No valid forward state from ${strategy.status}`,
      };
    }

    // Validate the transition exists in the allowed set
    if (!this.isValidTransition(strategy.status, nextState)) {
      log.warn('Promotion rejected — transition not in valid set', {
        strategyId,
        from: strategy.status,
        to: nextState,
      });
      return {
        success: false,
        from: strategy.status,
        to: nextState,
        requires_approval: false,
        reason: `Transition ${strategy.status} → ${nextState} is not defined in the valid transition map`,
      };
    }

    // Look up the transition definition for approval requirement
    const transition = VALID_TRANSITIONS.find(
      (t) => t.from === strategy.status && t.to === nextState,
    );

    // Determine if approval is needed
    const needsApproval =
      transition !== undefined &&
      transition.requires_approval &&
      !this.config.auto_micro_preauthorized;

    if (needsApproval) {
      // Create pending promotion for operator review
      this.db.insertPendingPromotion(strategyId, strategy.status, nextState);
      log.info('Promotion pending operator approval', {
        strategyId,
        from: strategy.status,
        to: nextState,
      });
      return {
        success: false,
        from: strategy.status,
        to: nextState,
        requires_approval: true,
        pending_id: strategyId,
        reason: 'Requires operator approval',
      };
    }

    // Execute the transition
    const trigger = transition?.trigger ?? 'promote';
    this.db.updateStatus(strategyId, nextState, trigger);
    this.db.insertTransition(strategyId, strategy.status, nextState, trigger, experimentId);
    log.info('Strategy promoted', { strategyId, from: strategy.status, to: nextState, trigger });

    return {
      success: true,
      from: strategy.status,
      to: nextState,
      requires_approval: false,
      reason: 'Promoted successfully',
    };
  }

  /**
   * Approve a pending promotion for the given strategy.
   * Executes the previously blocked transition and records it.
   *
   * @param strategyId - The strategy with a pending promotion
   * @returns PromotionResult with the executed transition details
   */
  approve(strategyId: string): PromotionResult {
    const pending = this.db.getPendingPromotions().find(
      (p) => p.strategy_id === strategyId,
    );

    if (!pending) {
      return {
        success: false,
        from: 'CANDIDATE',
        to: 'CANDIDATE',
        requires_approval: false,
        reason: 'No pending promotion found for this strategy',
      };
    }

    // Resolve the pending promotion
    this.db.resolvePendingPromotion(strategyId, true);

    // Execute the transition
    this.db.updateStatus(strategyId, pending.to_status, 'operator_approved');
    this.db.insertTransition(
      strategyId,
      pending.from_status,
      pending.to_status,
      'operator_approved',
    );

    log.info('Promotion approved by operator', {
      strategyId,
      from: pending.from_status,
      to: pending.to_status,
    });

    return {
      success: true,
      from: pending.from_status,
      to: pending.to_status,
      requires_approval: false,
      reason: 'Approved by operator',
    };
  }

  /**
   * Reject a pending promotion for the given strategy.
   * The strategy remains in its current state.
   *
   * @param strategyId - The strategy with a pending promotion
   * @param reason - Human-readable rejection reason
   */
  reject(strategyId: string, reason: string): void {
    this.db.resolvePendingPromotion(strategyId, false);
    log.info('Promotion rejected by operator', { strategyId, reason });
  }

  /**
   * Check whether a transition from one status to another is valid
   * according to the VALID_TRANSITIONS map.
   *
   * @param from - Current strategy status
   * @param to - Target strategy status
   * @returns true if the transition is defined in VALID_TRANSITIONS
   */
  isValidTransition(from: StrategyStatus, to: StrategyStatus): boolean {
    return VALID_TRANSITIONS.some((t) => t.from === from && t.to === to);
  }

  /**
   * Determine the next valid "forward" state for a given current state.
   * Returns the primary advancement path (not failure, dormancy, or manual transitions).
   *
   * @param current - The current strategy status
   * @returns The next forward state, or null if no forward path exists
   */
  getNextState(current: StrategyStatus): StrategyStatus | null {
    return FORWARD_MAP[current] ?? null;
  }
}

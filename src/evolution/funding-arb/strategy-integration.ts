/**
 * Funding Arbitrage Backtest — Strategy Registry Integration
 *
 * Wires backtest results to the existing EvolutionDatabase (Strategy Registry).
 * Maps the backtest verdict to strategy lifecycle status:
 *   - VIABLE → DORMANT
 *   - UNVIABLE → ARCHIVED_BASELINE with reason NEGATIVE_EXPECTANCY
 *
 * Stores evidence JSON: { period, coins, optimal_capital, alpha, max_drawdown }
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4
 */

import { createLogger } from '../../logger.js';
import type { EvolutionDatabase } from '../evolution-database.js';
import type { OptimizationResult } from './bankroll-optimizer.js';
import { BPS_DIVISOR } from './simulator.js';

const log = createLogger('funding-arb-registry');

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Strategy ID for funding-arb in the registry */
export const FUNDING_ARB_STRATEGY_ID = 'funding-arb';

/** Config hash placeholder for funding-arb strategy */
const FUNDING_ARB_CONFIG_HASH = 'funding-arb-backtest-v1';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Metadata about the backtest run, used to build the evidence record.
 */
export interface BacktestMetadata {
  /** Number of days in the backtest period */
  period: number;
  /** List of coin symbols evaluated */
  coins: string[];
  /** Best alpha across all evaluations (BigInt, 6-decimal USDC) */
  alpha: bigint;
  /** Maximum drawdown in bps across all evaluations */
  maxDrawdownBps: bigint;
}

/**
 * Evidence JSON stored in the strategy record.
 * All fields are required per Property 20.
 */
export interface FundingArbEvidence {
  period: number;
  coins: string[];
  optimal_capital: string | null;
  alpha: string;
  max_drawdown: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Core Function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register or update the funding-arb strategy in the EvolutionDatabase
 * based on the backtest optimization result.
 *
 * - If the strategy doesn't exist yet, it creates it.
 * - If it already exists, it updates the status and evidence.
 *
 * Verdict mapping (Property 17):
 *   - VIABLE → DORMANT
 *   - UNVIABLE → ARCHIVED_BASELINE with reason NEGATIVE_EXPECTANCY
 *
 * Evidence must contain (Property 20):
 *   - period: number of days
 *   - coins: list of coin symbols
 *   - optimal_capital: minimum viable capital as string, or null
 *   - alpha: best alpha as string (BigInt serialized)
 *   - max_drawdown: max drawdown in bps (number)
 *
 * @param db - EvolutionDatabase instance
 * @param result - OptimizationResult from BankrollOptimizer
 * @param metadata - Additional metadata about the backtest run
 */
export function registerFundingArbResult(
  db: EvolutionDatabase,
  result: OptimizationResult,
  metadata: BacktestMetadata,
): void {
  // Determine status based on verdict
  const newStatus = result.overallVerdict === 'VIABLE' ? 'DORMANT' : 'ARCHIVED_BASELINE';
  const archivedReason = result.overallVerdict === 'UNVIABLE' ? 'NEGATIVE_EXPECTANCY' : '';

  // Build evidence object with all required keys
  const evidence: FundingArbEvidence = {
    period: metadata.period,
    coins: metadata.coins,
    optimal_capital: result.minimumViableCapital !== null
      ? result.minimumViableCapital.toString()
      : null,
    alpha: metadata.alpha.toString(),
    max_drawdown: Number(metadata.maxDrawdownBps),
  };

  // Check if strategy already exists
  const existing = db.getStrategy(FUNDING_ARB_STRATEGY_ID);

  if (existing) {
    // Update existing strategy
    const previousStatus = existing.status;

    db.updateStrategy(FUNDING_ARB_STRATEGY_ID, {
      status: newStatus,
      evidence: evidence as unknown as import('../types.js').StrategyEvidence,
      archived_reason: archivedReason,
    });

    // Record state transition
    db.insertTransition(
      FUNDING_ARB_STRATEGY_ID,
      previousStatus,
      newStatus,
      result.overallVerdict === 'VIABLE'
        ? 'Backtest passed — viable at tested capital levels'
        : 'Backtest failed — NEGATIVE_EXPECTANCY',
    );

    log.info('Funding-arb strategy updated in registry', {
      previousStatus,
      newStatus,
      verdict: result.overallVerdict,
      optimalCapital: result.minimumViableCapital?.toString() ?? 'none',
    });
  } else {
    // Create new strategy entry
    db.insertStrategy({
      strategy_id: FUNDING_ARB_STRATEGY_ID,
      parent_id: null,
      status: newStatus,
      config_hash: FUNDING_ARB_CONFIG_HASH,
      parameters: {
        entry_tf: '1h',
        regime_tf: '1d',
        stop_atr: 0,
        tp_atr: 0,
        rsi_trend: [0, 0],
        rsi_reversion: 0,
        volumeZ: 0,
        trade_size: '0',
      },
      tags: ['funding-arb', 'delta-neutral', 'backtest'],
      best_regime: [],
      evidence: evidence as unknown as import('../types.js').StrategyEvidence,
      notes: 'Funding rate arbitrage strategy (long spot + short perp)',
      archived_reason: archivedReason,
      revival_rules: null,
    });

    // Record initial transition
    db.insertTransition(
      FUNDING_ARB_STRATEGY_ID,
      'CANDIDATE',
      newStatus,
      result.overallVerdict === 'VIABLE'
        ? 'Initial backtest passed — strategy set to DORMANT'
        : 'Initial backtest failed — NEGATIVE_EXPECTANCY',
    );

    log.info('Funding-arb strategy registered in registry', {
      status: newStatus,
      verdict: result.overallVerdict,
      optimalCapital: result.minimumViableCapital?.toString() ?? 'none',
    });
  }
}

/**
 * Build BacktestMetadata from an array of OptimizationResults.
 *
 * Convenience function that aggregates multi-coin results into a single
 * metadata record for the registry.
 *
 * @param results - Map of coin → OptimizationResult
 * @param periodDays - Number of days the backtest covered
 * @returns Aggregated BacktestMetadata
 */
export function buildBacktestMetadata(
  results: Map<string, OptimizationResult>,
  periodDays: number,
): BacktestMetadata {
  const coins: string[] = [];
  let bestAlpha = -9_999_999_999_999n; // Very negative starting point
  let worstDrawdown = 0n;

  for (const [coin, result] of results) {
    coins.push(coin);

    // Find the best alpha across all evaluations for this coin
    for (const evaluation of result.evaluations) {
      if (evaluation.alpha > bestAlpha) {
        bestAlpha = evaluation.alpha;
      }
      if (evaluation.maxDrawdownBps > worstDrawdown) {
        worstDrawdown = evaluation.maxDrawdownBps;
      }
    }
  }

  // If no evaluations found, use 0
  if (bestAlpha === -9_999_999_999_999n) {
    bestAlpha = 0n;
  }

  return {
    period: periodDays,
    coins,
    alpha: bestAlpha,
    maxDrawdownBps: worstDrawdown,
  };
}

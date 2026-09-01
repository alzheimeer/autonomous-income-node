/**
 * Pipeline Observer — IPipelineObserver Interface & PipelineMetricsRecorder
 *
 * Passive observer for the TradingOrchestrator pipeline. Every method is
 * synchronous, void, and NEVER throws to the caller. Errors during recording
 * are caught and logged internally.
 *
 * The PipelineMetricsRecorder maps observer method calls to the 18 pipeline
 * event types defined in MetricsDatabase.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 17.1, 17.2
 */

import { randomUUID } from 'node:crypto';
import type { Indicators } from '../trading-validation/strategy-engine.js';
import type { TradeCandidate } from '../trading-validation/types.js';
import type { GateResult } from '../trading-validation/cost-aware-trade-gate.js';
import { MetricsDatabase } from './metrics-database.js';
import { createLogger } from '../logger.js';

const log = createLogger('pipeline-observer');

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Diagnostics data optionally attached to strategy evaluation results.
 * Contains the regime and any sub-reason explaining why no signal was generated.
 */
export interface StrategyDiagnostics {
  regime?: string;
  positionOpen?: boolean;
  cooldownRemaining?: number;
  [key: string]: unknown;
}

// ═══════════════════════════════════════════════════════════════════════════
// IPipelineObserver Interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Observer interface for the TradingOrchestrator pipeline.
 *
 * All methods are synchronous, void, and must never throw.
 * Implementations should wrap internal logic in try/catch.
 */
export interface IPipelineObserver {
  onEvaluationStarted(sessionId: string): void;
  onEvaluationSkipped(reason: 'mutex' | 'not_running' | 'cannot_evaluate'): void;
  onIndicatorsResult(available: boolean, indicators1h?: Indicators, indicators15m?: Indicators): void;
  onStrategyResult(candidate: TradeCandidate | null, subReason?: string, indicators?: StrategyDiagnostics): void;
  onDailyLossLimitHit(): void;
  onPositionSizingResult(passed: boolean, reason?: string, sizeUsdc?: bigint): void;
  onBankrollResult(sufficient: boolean): void;
  onAaveFundsResult(available: boolean): void;
  onGateResult(result: GateResult): void;
  onTradeExecuted(mode: 'shadow' | 'micro', candidateId: string): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// PipelineMetricsRecorder
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Records pipeline events to MetricsDatabase.
 *
 * Each observer method:
 * 1. Wraps logic in try/catch — NEVER throws to caller
 * 2. Persists event synchronously to MetricsDatabase
 * 3. Maps the call to one or more of the 18 defined event types
 */
export class PipelineMetricsRecorder implements IPipelineObserver {
  private readonly db: MetricsDatabase;
  private readonly sessionId: string;

  constructor(db: MetricsDatabase) {
    this.db = db;
    this.sessionId = randomUUID();
  }

  /** Expose session ID for testing and debugging */
  getSessionId(): string {
    return this.sessionId;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Observer Methods
  // ─────────────────────────────────────────────────────────────────────────

  onEvaluationStarted(sessionId: string): void {
    try {
      this.db.insertEvent(
        Date.now(),
        'evaluation_started',
        { orchestrator_session: sessionId },
        this.sessionId,
      );
    } catch (err) {
      log.error('onEvaluationStarted failed', { error: this.formatError(err) });
    }
  }

  onEvaluationSkipped(reason: 'mutex' | 'not_running' | 'cannot_evaluate'): void {
    try {
      const eventTypeMap = {
        mutex: 'evaluation_skipped_mutex',
        not_running: 'evaluation_skipped_not_running',
        cannot_evaluate: 'evaluation_skipped_cannot_evaluate',
      } as const;

      this.db.insertEvent(
        Date.now(),
        eventTypeMap[reason],
        { reason },
        this.sessionId,
      );
    } catch (err) {
      log.error('onEvaluationSkipped failed', { error: this.formatError(err) });
    }
  }

  onIndicatorsResult(available: boolean, indicators1h?: Indicators, indicators15m?: Indicators): void {
    try {
      if (!available) {
        this.db.insertEvent(
          Date.now(),
          'indicators_unavailable',
          {},
          this.sessionId,
        );
      } else {
        this.db.insertEvent(
          Date.now(),
          'indicators_computed',
          {
            indicators1h: indicators1h ? this.serializeIndicators(indicators1h) : null,
            indicators15m: indicators15m ? this.serializeIndicators(indicators15m) : null,
          },
          this.sessionId,
        );
      }
    } catch (err) {
      log.error('onIndicatorsResult failed', { error: this.formatError(err) });
    }
  }

  onStrategyResult(candidate: TradeCandidate | null, subReason?: string, indicators?: StrategyDiagnostics): void {
    try {
      if (candidate === null) {
        this.db.insertEvent(
          Date.now(),
          'strategy_no_signal',
          {
            sub_reason: subReason ?? 'unknown',
            diagnostics: indicators ?? {},
          },
          this.sessionId,
        );
      } else {
        this.db.insertEvent(
          Date.now(),
          'strategy_signal_generated',
          {
            candidate_id: candidate.id,
            strategy: candidate.strategy,
            confidence: candidate.confidence,
            regime: candidate.regime,
            stop_distance: candidate.stopDistanceFraction,
            take_profit: candidate.takeProfitFraction,
          },
          this.sessionId,
        );
      }
    } catch (err) {
      log.error('onStrategyResult failed', { error: this.formatError(err) });
    }
  }

  onDailyLossLimitHit(): void {
    try {
      this.db.insertEvent(
        Date.now(),
        'daily_loss_limit_hit',
        {},
        this.sessionId,
      );
    } catch (err) {
      log.error('onDailyLossLimitHit failed', { error: this.formatError(err) });
    }
  }

  onPositionSizingResult(passed: boolean, reason?: string, sizeUsdc?: bigint): void {
    try {
      if (!passed) {
        this.db.insertEvent(
          Date.now(),
          'position_sizing_rejected',
          { reason: reason ?? 'unknown' },
          this.sessionId,
        );
      } else {
        this.db.insertEvent(
          Date.now(),
          'position_sized',
          { size_usdc: sizeUsdc?.toString() ?? '0' },
          this.sessionId,
        );
      }
    } catch (err) {
      log.error('onPositionSizingResult failed', { error: this.formatError(err) });
    }
  }

  onBankrollResult(sufficient: boolean): void {
    try {
      if (!sufficient) {
        this.db.insertEvent(
          Date.now(),
          'bankroll_insufficient',
          {},
          this.sessionId,
        );
      } else {
        this.db.insertEvent(
          Date.now(),
          'bankroll_approved',
          {},
          this.sessionId,
        );
      }
    } catch (err) {
      log.error('onBankrollResult failed', { error: this.formatError(err) });
    }
  }

  onAaveFundsResult(available: boolean): void {
    try {
      if (!available) {
        this.db.insertEvent(
          Date.now(),
          'aave_funds_unavailable',
          {},
          this.sessionId,
        );
      } else {
        this.db.insertEvent(
          Date.now(),
          'aave_funds_secured',
          {},
          this.sessionId,
        );
      }
    } catch (err) {
      log.error('onAaveFundsResult failed', { error: this.formatError(err) });
    }
  }

  onGateResult(result: GateResult): void {
    try {
      if (!result.passed) {
        this.db.insertEvent(
          Date.now(),
          'gate_rejected',
          {
            reject_reasons: result.rejectReasons,
            net_profit_usdc: result.netProfitUsdc.toString(),
            net_profit_bps: result.netProfitBps,
          },
          this.sessionId,
        );
      } else {
        this.db.insertEvent(
          Date.now(),
          'gate_passed',
          {
            net_profit_usdc: result.netProfitUsdc.toString(),
            net_profit_bps: result.netProfitBps,
          },
          this.sessionId,
        );
      }
    } catch (err) {
      log.error('onGateResult failed', { error: this.formatError(err) });
    }
  }

  onTradeExecuted(mode: 'shadow' | 'micro', candidateId: string): void {
    try {
      this.db.insertEvent(
        Date.now(),
        'trade_executed',
        { mode, candidate_id: candidateId },
        this.sessionId,
      );
    } catch (err) {
      log.error('onTradeExecuted failed', { error: this.formatError(err) });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private serializeIndicators(ind: Indicators): Record<string, unknown> {
    return {
      ema20: ind.ema20,
      ema50: ind.ema50,
      ema200: ind.ema200,
      rsi14: ind.rsi14,
      atr14: ind.atr14,
      volumeZScore: ind.volumeZScore,
      bollingerBands: ind.bollingerBands,
      lastPrice: ind.lastPrice,
      candleCount: ind.candleCount,
    };
  }

  private formatError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

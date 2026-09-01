/**
 * Trading Validation Phase - SafeModeController
 *
 * Implements ISafeModeController with state machine:
 *   Normal → SafeMode → (operator confirm) → Normal
 *   Normal → LowCostMode → Normal
 *   SafeMode → KillSwitch (permanent)
 *
 * Triggers for Safe_Mode: recon_mismatch, failed_tx_limit, rpc_failure,
 *   gas_critical, kill_switch, unexpected_position, deviation_alerts,
 *   db_integrity, secret_leak
 *
 * AI budget exceeded → LowCostMode (NOT Safe_Mode).
 * In Safe_Mode: no new positions, may close existing, Telegram alert.
 * KillSwitch is permanent (cannot be resumed without manual intervention).
 * Require operator confirmation to resume from Safe_Mode.
 * Log all transitions to event_log table.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 9.4
 */

import type { TradingDatabase } from './db.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types and Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** Possible system states */
export type SafeModeState = 'normal' | 'safe_mode' | 'low_cost_mode' | 'kill_switch';

/** Triggers that activate Safe_Mode */
export type SafeModeTrigger =
  | 'recon_mismatch'
  | 'failed_tx_limit'
  | 'rpc_failure'
  | 'gas_critical'
  | 'kill_switch'
  | 'unexpected_position'
  | 'deviation_alerts'
  | 'db_integrity'
  | 'secret_leak';

/** Operator authentication token for resume operations */
export interface OperatorAuth {
  source: 'telegram' | 'api_key';
  chatId?: string;
  timestamp: number;
  verified: boolean;
}

/** Alert callback for Telegram notifications */
export interface IAlertCallback {
  sendAlert(message: string): void | Promise<void>;
}

/** Snapshot of current controller state */
export interface SafeModeSnapshot {
  state: SafeModeState;
  reason?: string;
  since?: number;
  details?: string;
}

/** ISafeModeController interface */
export interface ISafeModeController {
  /** Trigger Safe_Mode with a reason and optional details */
  trigger(reason: SafeModeTrigger, details?: string): void;
  /** Resume from Safe_Mode with operator authentication */
  resume(auth: OperatorAuth): boolean;
  /** Trigger permanent KillSwitch (cannot be resumed) */
  triggerKillSwitch(reason: string): void;
  /** Enter LowCostMode (AI budget exceeded) */
  enterLowCostMode(): void;
  /** Exit LowCostMode back to Normal */
  exitLowCostMode(): void;
  /** Get current state snapshot */
  getState(): SafeModeSnapshot;
  /** Whether new trades can be opened */
  canTrade(): boolean;
  /** Whether existing positions can be closed */
  canClosePosition(): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SafeModeController manages the system's safety state machine.
 *
 * State transitions:
 * - Normal → SafeMode (on critical trigger)
 * - SafeMode → Normal (operator resume)
 * - SafeMode → KillSwitch (permanent)
 * - Normal → LowCostMode (AI budget exceeded)
 * - LowCostMode → Normal (budget reset or manual exit)
 * - Normal → KillSwitch (kill_switch trigger)
 *
 * KillSwitch is a terminal state — only manual intervention (outside this
 * controller) can reset it.
 */
export class SafeModeController implements ISafeModeController {
  private readonly db: TradingDatabase;
  private readonly alertCallback?: IAlertCallback;

  // In-memory state (backed by SQLite)
  private currentState: SafeModeState = 'normal';
  private currentReason?: string;
  private currentDetails?: string;
  private currentSince?: number;

  constructor(db: TradingDatabase, alertCallback?: IAlertCallback) {
    this.db = db;
    this.alertCallback = alertCallback;
    this.loadState();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State Loading
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Load current state from trading_phase table.
   * Maps the SQLite column flags to our SafeModeState enum.
   */
  private loadState(): void {
    const row = this.db.prepare(
      'SELECT safe_mode, safe_mode_reason, safe_mode_since, low_cost_mode, kill_switch_triggered FROM trading_phase WHERE id = 1'
    ).get() as {
      safe_mode: number;
      safe_mode_reason: string | null;
      safe_mode_since: number | null;
      low_cost_mode: number;
      kill_switch_triggered: number;
    } | undefined;

    if (!row) {
      // No trading_phase row yet — stay in normal state
      this.currentState = 'normal';
      return;
    }

    if (row.kill_switch_triggered) {
      this.currentState = 'kill_switch';
      this.currentReason = row.safe_mode_reason ?? 'kill_switch';
      this.currentSince = row.safe_mode_since ?? undefined;
    } else if (row.safe_mode) {
      this.currentState = 'safe_mode';
      this.currentReason = row.safe_mode_reason ?? undefined;
      this.currentSince = row.safe_mode_since ?? undefined;
    } else if (row.low_cost_mode) {
      this.currentState = 'low_cost_mode';
    } else {
      this.currentState = 'normal';
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // State Persistence
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Persist current state to trading_phase table.
   */
  private persistState(): void {
    const now = Date.now();
    const row = this.db.prepare('SELECT id FROM trading_phase WHERE id = 1').get();

    if (!row) {
      // trading_phase row doesn't exist yet — cannot persist until phase is initialized
      // This is a safety fallback; normally phase-init creates this row first
      return;
    }

    const safeMode = this.currentState === 'safe_mode' || this.currentState === 'kill_switch' ? 1 : 0;
    const lowCostMode = this.currentState === 'low_cost_mode' ? 1 : 0;
    const killSwitch = this.currentState === 'kill_switch' ? 1 : 0;

    this.db.prepare(`
      UPDATE trading_phase
      SET safe_mode = ?,
          safe_mode_reason = ?,
          safe_mode_since = ?,
          low_cost_mode = ?,
          kill_switch_triggered = ?,
          updated_at = ?
      WHERE id = 1
    `).run(
      safeMode,
      this.currentReason ?? null,
      this.currentSince ?? null,
      lowCostMode,
      killSwitch,
      now,
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Event Logging
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Log a state transition to the event_log table.
   */
  private logTransition(eventType: string, details: Record<string, unknown>): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO event_log (event_type, details, timestamp) VALUES (?, ?, ?)'
    ).run(eventType, JSON.stringify(details), now);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Alert
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send alert via the injected callback. Fire-and-forget for async callbacks.
   */
  private sendAlert(message: string): void {
    if (this.alertCallback) {
      try {
        const result = this.alertCallback.sendAlert(message);
        // If it returns a promise, we don't await — fire and forget
        if (result && typeof (result as Promise<void>).catch === 'function') {
          (result as Promise<void>).catch(() => {
            // Alert delivery failure is non-critical
          });
        }
      } catch {
        // Alert delivery failure is non-critical
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API — ISafeModeController
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Trigger Safe_Mode with a specific reason.
   *
   * If the trigger is 'kill_switch', it goes directly to KillSwitch (permanent).
   * If already in kill_switch state, does nothing (cannot escalate further).
   * If already in safe_mode, logs the additional trigger but stays in safe_mode.
   */
  trigger(reason: SafeModeTrigger, details?: string): void {
    // KillSwitch is terminal — no further transitions
    if (this.currentState === 'kill_switch') {
      this.logTransition('safe_mode_trigger_ignored', {
        reason,
        details: details ?? null,
        currentState: 'kill_switch',
        message: 'Already in KillSwitch, trigger ignored',
      });
      return;
    }

    // kill_switch trigger goes directly to KillSwitch
    if (reason === 'kill_switch') {
      this.triggerKillSwitch(details ?? 'kill_switch trigger');
      return;
    }

    const previousState = this.currentState;
    const now = Date.now();

    // If already in safe_mode, log additional trigger
    if (this.currentState === 'safe_mode') {
      this.logTransition('safe_mode_additional_trigger', {
        reason,
        details: details ?? null,
        previousReason: this.currentReason,
      });
      return;
    }

    // Transition to safe_mode
    this.currentState = 'safe_mode';
    this.currentReason = reason;
    this.currentDetails = details;
    this.currentSince = now;

    this.persistState();
    this.logTransition('safe_mode_entered', {
      reason,
      details: details ?? null,
      previousState,
      timestamp: now,
    });

    // Send Telegram alert
    this.sendAlert(
      `🚨 SAFE MODE ACTIVATED\nReason: ${reason}\nDetails: ${details ?? 'none'}\nTime: ${new Date(now).toISOString()}`
    );
  }

  /**
   * Resume from Safe_Mode with operator authentication.
   *
   * Returns true if successfully resumed, false if:
   * - Auth not verified
   * - Not in safe_mode state (kill_switch cannot be resumed)
   */
  resume(auth: OperatorAuth): boolean {
    // Only resume from safe_mode
    if (this.currentState !== 'safe_mode') {
      this.logTransition('safe_mode_resume_rejected', {
        currentState: this.currentState,
        reason: this.currentState === 'kill_switch'
          ? 'KillSwitch is permanent'
          : 'Not in safe_mode',
        authSource: auth.source,
      });
      return false;
    }

    // Verify operator auth
    if (!auth.verified) {
      this.logTransition('safe_mode_resume_rejected', {
        currentState: this.currentState,
        reason: 'Auth not verified',
        authSource: auth.source,
      });
      return false;
    }

    const previousReason = this.currentReason;
    const previousSince = this.currentSince;

    // Transition to normal
    this.currentState = 'normal';
    this.currentReason = undefined;
    this.currentDetails = undefined;
    this.currentSince = undefined;

    this.persistState();
    this.logTransition('safe_mode_resumed', {
      previousReason,
      previousSince,
      resumedBy: auth.source,
      chatId: auth.chatId ?? null,
      timestamp: Date.now(),
    });

    this.sendAlert(
      `✅ SAFE MODE DEACTIVATED\nResumed by: ${auth.source}\nPrevious reason: ${previousReason ?? 'unknown'}`
    );

    return true;
  }

  /**
   * Trigger permanent KillSwitch. Cannot be resumed through this controller.
   */
  triggerKillSwitch(reason: string): void {
    // Already in kill_switch — nothing to do
    if (this.currentState === 'kill_switch') {
      return;
    }

    const previousState = this.currentState;
    const now = Date.now();

    this.currentState = 'kill_switch';
    this.currentReason = reason;
    this.currentDetails = `KillSwitch activated: ${reason}`;
    this.currentSince = now;

    this.persistState();
    this.logTransition('kill_switch_activated', {
      reason,
      previousState,
      timestamp: now,
    });

    this.sendAlert(
      `🛑 KILL SWITCH ACTIVATED (PERMANENT)\nReason: ${reason}\nTime: ${new Date(now).toISOString()}\nManual intervention required to reset.`
    );
  }

  /**
   * Enter LowCostMode (AI budget exceeded).
   * Does NOT trigger Safe_Mode per Requirement 9.4/23.2.
   *
   * LowCostMode only applies from Normal state.
   * If in safe_mode or kill_switch, LowCostMode is irrelevant.
   */
  enterLowCostMode(): void {
    if (this.currentState !== 'normal') {
      this.logTransition('low_cost_mode_ignored', {
        currentState: this.currentState,
        reason: 'Cannot enter LowCostMode from non-normal state',
      });
      return;
    }

    this.currentState = 'low_cost_mode';
    this.currentReason = undefined;
    this.currentDetails = undefined;
    this.currentSince = Date.now();

    this.persistState();
    this.logTransition('low_cost_mode_entered', {
      timestamp: this.currentSince,
    });
  }

  /**
   * Exit LowCostMode back to Normal.
   * Only valid when currently in low_cost_mode.
   */
  exitLowCostMode(): void {
    if (this.currentState !== 'low_cost_mode') {
      return;
    }

    this.currentState = 'normal';
    this.currentReason = undefined;
    this.currentDetails = undefined;
    this.currentSince = undefined;

    this.persistState();
    this.logTransition('low_cost_mode_exited', {
      timestamp: Date.now(),
    });
  }

  /**
   * Get current state snapshot.
   */
  getState(): SafeModeSnapshot {
    return {
      state: this.currentState,
      reason: this.currentReason,
      since: this.currentSince,
      details: this.currentDetails,
    };
  }

  /**
   * Whether new trades can be opened.
   *
   * Trading is allowed in: normal, low_cost_mode
   * Trading is blocked in: safe_mode, kill_switch
   */
  canTrade(): boolean {
    return this.currentState === 'normal' || this.currentState === 'low_cost_mode';
  }

  /**
   * Whether existing positions can be closed.
   *
   * Closing is allowed in all states EXCEPT kill_switch where even
   * closing might be blocked (but per spec, safe_mode allows closing).
   * KillSwitch: attempt to close is still allowed for safety.
   */
  canClosePosition(): boolean {
    // All states allow closing existing positions for safety
    // Even kill_switch should allow closing to minimize exposure
    return true;
  }
}

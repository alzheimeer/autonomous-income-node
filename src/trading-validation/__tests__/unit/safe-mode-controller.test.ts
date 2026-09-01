/**
 * Unit tests for SafeModeController
 *
 * Tests state machine transitions, trigger handling, operator resume,
 * KillSwitch permanence, LowCostMode, event logging, and alert callbacks.
 *
 * Requirements: 23.1, 23.2, 23.3, 23.4, 9.4
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDatabase, type TradingDatabase } from '../../db.js';
import { runMigrations } from '../../migrations.js';
import { SafeModeController } from '../../safe-mode-controller.js';
import type {
  SafeModeTrigger,
  OperatorAuth,
  IAlertCallback,
} from '../../safe-mode-controller.js';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createDb(): TradingDatabase {
  const db = createDatabase(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

/**
 * Insert a trading_phase row so SafeModeController can persist state.
 */
function seedTradingPhase(db: TradingDatabase): void {
  db.prepare(`
    INSERT INTO trading_phase (id, mode, config_hash, started_at, updated_at)
    VALUES (1, 'shadow', 'test_hash', ?, ?)
  `).run(Date.now(), Date.now());
}

function verifiedAuth(source: 'telegram' | 'api_key' = 'telegram'): OperatorAuth {
  return {
    source,
    chatId: '12345',
    timestamp: Date.now(),
    verified: true,
  };
}

function unverifiedAuth(): OperatorAuth {
  return {
    source: 'telegram',
    chatId: '12345',
    timestamp: Date.now(),
    verified: false,
  };
}

function createMockAlert(): IAlertCallback & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    sendAlert(message: string) {
      messages.push(message);
    },
  };
}

function getEventLogs(db: TradingDatabase): Array<{ event_type: string; details: string; timestamp: number }> {
  return db.prepare('SELECT event_type, details, timestamp FROM event_log ORDER BY id ASC').all() as Array<{
    event_type: string;
    details: string;
    timestamp: number;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('SafeModeController', () => {
  let db: TradingDatabase;

  beforeEach(() => {
    db = createDb();
    seedTradingPhase(db);
  });

  afterEach(() => {
    db.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────

  describe('initialization', () => {
    it('starts in normal state', () => {
      const controller = new SafeModeController(db);
      const state = controller.getState();
      expect(state.state).toBe('normal');
      expect(state.reason).toBeUndefined();
      expect(state.since).toBeUndefined();
    });

    it('loads safe_mode state from database', () => {
      // Manually set safe_mode in DB
      db.prepare(`
        UPDATE trading_phase SET safe_mode = 1, safe_mode_reason = 'rpc_failure', safe_mode_since = 1000 WHERE id = 1
      `).run();

      const controller = new SafeModeController(db);
      const state = controller.getState();
      expect(state.state).toBe('safe_mode');
      expect(state.reason).toBe('rpc_failure');
      expect(state.since).toBe(1000);
    });

    it('loads kill_switch state from database', () => {
      db.prepare(`
        UPDATE trading_phase SET kill_switch_triggered = 1, safe_mode_reason = 'recon_mismatch', safe_mode_since = 2000 WHERE id = 1
      `).run();

      const controller = new SafeModeController(db);
      const state = controller.getState();
      expect(state.state).toBe('kill_switch');
      expect(state.reason).toBe('recon_mismatch');
    });

    it('loads low_cost_mode state from database', () => {
      db.prepare(`
        UPDATE trading_phase SET low_cost_mode = 1 WHERE id = 1
      `).run();

      const controller = new SafeModeController(db);
      const state = controller.getState();
      expect(state.state).toBe('low_cost_mode');
    });

    it('works without trading_phase row (stays normal)', () => {
      db.prepare('DELETE FROM trading_phase WHERE id = 1').run();
      const controller = new SafeModeController(db);
      expect(controller.getState().state).toBe('normal');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // trigger() — Normal → SafeMode
  // ─────────────────────────────────────────────────────────────────────────

  describe('trigger()', () => {
    it('transitions from normal to safe_mode', () => {
      const controller = new SafeModeController(db);
      controller.trigger('recon_mismatch', 'Balance deviation $0.50');

      const state = controller.getState();
      expect(state.state).toBe('safe_mode');
      expect(state.reason).toBe('recon_mismatch');
      expect(state.details).toBe('Balance deviation $0.50');
      expect(state.since).toBeGreaterThan(0);
    });

    it('transitions from low_cost_mode to safe_mode', () => {
      const controller = new SafeModeController(db);
      controller.enterLowCostMode();
      controller.trigger('gas_critical', 'ETH < 0.002');

      const state = controller.getState();
      expect(state.state).toBe('safe_mode');
      expect(state.reason).toBe('gas_critical');
    });

    it('persists state to trading_phase table', () => {
      const controller = new SafeModeController(db);
      controller.trigger('failed_tx_limit', '3 failed txs today');

      const row = db.prepare('SELECT safe_mode, safe_mode_reason FROM trading_phase WHERE id = 1').get() as {
        safe_mode: number;
        safe_mode_reason: string;
      };
      expect(row.safe_mode).toBe(1);
      expect(row.safe_mode_reason).toBe('failed_tx_limit');
    });

    it('logs additional trigger when already in safe_mode', () => {
      const controller = new SafeModeController(db);
      controller.trigger('recon_mismatch', 'first');
      controller.trigger('rpc_failure', 'second');

      // State should still reflect the first trigger
      expect(controller.getState().reason).toBe('recon_mismatch');

      // But the additional trigger should be logged
      const logs = getEventLogs(db);
      const additionalLog = logs.find((l) => l.event_type === 'safe_mode_additional_trigger');
      expect(additionalLog).toBeDefined();
      const details = JSON.parse(additionalLog!.details);
      expect(details.reason).toBe('rpc_failure');
      expect(details.previousReason).toBe('recon_mismatch');
    });

    it('does nothing when in kill_switch state', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('test');
      controller.trigger('gas_critical', 'should be ignored');

      expect(controller.getState().state).toBe('kill_switch');

      const logs = getEventLogs(db);
      const ignoredLog = logs.find((l) => l.event_type === 'safe_mode_trigger_ignored');
      expect(ignoredLog).toBeDefined();
    });

    it('sends Telegram alert on trigger', () => {
      const alert = createMockAlert();
      const controller = new SafeModeController(db, alert);
      controller.trigger('db_integrity', 'Corruption detected');

      expect(alert.messages).toHaveLength(1);
      expect(alert.messages[0]).toContain('SAFE MODE ACTIVATED');
      expect(alert.messages[0]).toContain('db_integrity');
      expect(alert.messages[0]).toContain('Corruption detected');
    });

    it('logs transition to event_log', () => {
      const controller = new SafeModeController(db);
      controller.trigger('secret_leak', 'Key exposed');

      const logs = getEventLogs(db);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      const entryLog = logs.find((l) => l.event_type === 'safe_mode_entered');
      expect(entryLog).toBeDefined();
      const details = JSON.parse(entryLog!.details);
      expect(details.reason).toBe('secret_leak');
      expect(details.previousState).toBe('normal');
    });

    const allTriggers: SafeModeTrigger[] = [
      'recon_mismatch',
      'failed_tx_limit',
      'rpc_failure',
      'gas_critical',
      'unexpected_position',
      'deviation_alerts',
      'db_integrity',
      'secret_leak',
    ];

    it.each(allTriggers)('handles trigger "%s" correctly', (trigger) => {
      const controller = new SafeModeController(db);
      controller.trigger(trigger);
      expect(controller.getState().state).toBe('safe_mode');
      expect(controller.getState().reason).toBe(trigger);
    });

    it('kill_switch trigger goes directly to KillSwitch', () => {
      const controller = new SafeModeController(db);
      controller.trigger('kill_switch', '3 mismatches in 24h');

      const state = controller.getState();
      expect(state.state).toBe('kill_switch');
      expect(state.reason).toBe('3 mismatches in 24h');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // resume() — SafeMode → Normal (operator confirm)
  // ─────────────────────────────────────────────────────────────────────────

  describe('resume()', () => {
    it('resumes from safe_mode with verified auth', () => {
      const controller = new SafeModeController(db);
      controller.trigger('rpc_failure');

      const result = controller.resume(verifiedAuth());
      expect(result).toBe(true);
      expect(controller.getState().state).toBe('normal');
    });

    it('rejects resume with unverified auth', () => {
      const controller = new SafeModeController(db);
      controller.trigger('rpc_failure');

      const result = controller.resume(unverifiedAuth());
      expect(result).toBe(false);
      expect(controller.getState().state).toBe('safe_mode');
    });

    it('rejects resume when not in safe_mode (normal)', () => {
      const controller = new SafeModeController(db);
      const result = controller.resume(verifiedAuth());
      expect(result).toBe(false);
    });

    it('rejects resume from kill_switch', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('permanent');

      const result = controller.resume(verifiedAuth());
      expect(result).toBe(false);
      expect(controller.getState().state).toBe('kill_switch');
    });

    it('persists normal state after resume', () => {
      const controller = new SafeModeController(db);
      controller.trigger('gas_critical');
      controller.resume(verifiedAuth());

      const row = db.prepare('SELECT safe_mode, safe_mode_reason FROM trading_phase WHERE id = 1').get() as {
        safe_mode: number;
        safe_mode_reason: string | null;
      };
      expect(row.safe_mode).toBe(0);
      expect(row.safe_mode_reason).toBeNull();
    });

    it('logs resume event', () => {
      const controller = new SafeModeController(db);
      controller.trigger('deviation_alerts');
      controller.resume(verifiedAuth('api_key'));

      const logs = getEventLogs(db);
      const resumeLog = logs.find((l) => l.event_type === 'safe_mode_resumed');
      expect(resumeLog).toBeDefined();
      const details = JSON.parse(resumeLog!.details);
      expect(details.resumedBy).toBe('api_key');
      expect(details.previousReason).toBe('deviation_alerts');
    });

    it('sends alert on successful resume', () => {
      const alert = createMockAlert();
      const controller = new SafeModeController(db, alert);
      controller.trigger('rpc_failure');
      controller.resume(verifiedAuth());

      expect(alert.messages).toHaveLength(2); // trigger + resume
      expect(alert.messages[1]).toContain('SAFE MODE DEACTIVATED');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // triggerKillSwitch() — Permanent state
  // ─────────────────────────────────────────────────────────────────────────

  describe('triggerKillSwitch()', () => {
    it('transitions to kill_switch from normal', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('3 recon mismatches');

      const state = controller.getState();
      expect(state.state).toBe('kill_switch');
      expect(state.reason).toBe('3 recon mismatches');
    });

    it('transitions to kill_switch from safe_mode', () => {
      const controller = new SafeModeController(db);
      controller.trigger('rpc_failure');
      controller.triggerKillSwitch('escalated');

      expect(controller.getState().state).toBe('kill_switch');
    });

    it('is idempotent when already in kill_switch', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('first');
      controller.triggerKillSwitch('second');

      expect(controller.getState().reason).toBe('first');
    });

    it('cannot be resumed', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('permanent');

      expect(controller.resume(verifiedAuth())).toBe(false);
      expect(controller.getState().state).toBe('kill_switch');
    });

    it('persists kill_switch to database', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('fatal error');

      const row = db.prepare('SELECT kill_switch_triggered FROM trading_phase WHERE id = 1').get() as {
        kill_switch_triggered: number;
      };
      expect(row.kill_switch_triggered).toBe(1);
    });

    it('sends alert', () => {
      const alert = createMockAlert();
      const controller = new SafeModeController(db, alert);
      controller.triggerKillSwitch('critical');

      expect(alert.messages).toHaveLength(1);
      expect(alert.messages[0]).toContain('KILL SWITCH ACTIVATED');
      expect(alert.messages[0]).toContain('PERMANENT');
    });

    it('logs transition', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('reason');

      const logs = getEventLogs(db);
      const ksLog = logs.find((l) => l.event_type === 'kill_switch_activated');
      expect(ksLog).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // LowCostMode — AI budget exceeded
  // ─────────────────────────────────────────────────────────────────────────

  describe('LowCostMode', () => {
    it('enters low_cost_mode from normal', () => {
      const controller = new SafeModeController(db);
      controller.enterLowCostMode();

      expect(controller.getState().state).toBe('low_cost_mode');
    });

    it('exits low_cost_mode back to normal', () => {
      const controller = new SafeModeController(db);
      controller.enterLowCostMode();
      controller.exitLowCostMode();

      expect(controller.getState().state).toBe('normal');
    });

    it('does NOT enter low_cost_mode from safe_mode', () => {
      const controller = new SafeModeController(db);
      controller.trigger('rpc_failure');
      controller.enterLowCostMode();

      // Should stay in safe_mode
      expect(controller.getState().state).toBe('safe_mode');
    });

    it('does NOT enter low_cost_mode from kill_switch', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('fatal');
      controller.enterLowCostMode();

      expect(controller.getState().state).toBe('kill_switch');
    });

    it('exitLowCostMode does nothing if not in low_cost_mode', () => {
      const controller = new SafeModeController(db);
      controller.exitLowCostMode(); // should be no-op
      expect(controller.getState().state).toBe('normal');
    });

    it('persists low_cost_mode to database', () => {
      const controller = new SafeModeController(db);
      controller.enterLowCostMode();

      const row = db.prepare('SELECT low_cost_mode FROM trading_phase WHERE id = 1').get() as {
        low_cost_mode: number;
      };
      expect(row.low_cost_mode).toBe(1);
    });

    it('logs entry and exit', () => {
      const controller = new SafeModeController(db);
      controller.enterLowCostMode();
      controller.exitLowCostMode();

      const logs = getEventLogs(db);
      expect(logs.some((l) => l.event_type === 'low_cost_mode_entered')).toBe(true);
      expect(logs.some((l) => l.event_type === 'low_cost_mode_exited')).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // canTrade() and canClosePosition()
  // ─────────────────────────────────────────────────────────────────────────

  describe('canTrade()', () => {
    it('allows trading in normal state', () => {
      const controller = new SafeModeController(db);
      expect(controller.canTrade()).toBe(true);
    });

    it('allows trading in low_cost_mode', () => {
      const controller = new SafeModeController(db);
      controller.enterLowCostMode();
      expect(controller.canTrade()).toBe(true);
    });

    it('blocks trading in safe_mode', () => {
      const controller = new SafeModeController(db);
      controller.trigger('rpc_failure');
      expect(controller.canTrade()).toBe(false);
    });

    it('blocks trading in kill_switch', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('fatal');
      expect(controller.canTrade()).toBe(false);
    });
  });

  describe('canClosePosition()', () => {
    it('allows closing in normal state', () => {
      const controller = new SafeModeController(db);
      expect(controller.canClosePosition()).toBe(true);
    });

    it('allows closing in safe_mode', () => {
      const controller = new SafeModeController(db);
      controller.trigger('gas_critical');
      expect(controller.canClosePosition()).toBe(true);
    });

    it('allows closing in kill_switch', () => {
      const controller = new SafeModeController(db);
      controller.triggerKillSwitch('fatal');
      expect(controller.canClosePosition()).toBe(true);
    });

    it('allows closing in low_cost_mode', () => {
      const controller = new SafeModeController(db);
      controller.enterLowCostMode();
      expect(controller.canClosePosition()).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // State persistence and reload
  // ─────────────────────────────────────────────────────────────────────────

  describe('persistence across instances', () => {
    it('new instance loads safe_mode state from previous', () => {
      const c1 = new SafeModeController(db);
      c1.trigger('unexpected_position', 'unknown WETH balance');

      const c2 = new SafeModeController(db);
      const state = c2.getState();
      expect(state.state).toBe('safe_mode');
      expect(state.reason).toBe('unexpected_position');
    });

    it('new instance loads kill_switch state from previous', () => {
      const c1 = new SafeModeController(db);
      c1.triggerKillSwitch('permanent reason');

      const c2 = new SafeModeController(db);
      expect(c2.getState().state).toBe('kill_switch');
      expect(c2.canTrade()).toBe(false);
    });

    it('new instance loads normal state after resume', () => {
      const c1 = new SafeModeController(db);
      c1.trigger('rpc_failure');
      c1.resume(verifiedAuth());

      const c2 = new SafeModeController(db);
      expect(c2.getState().state).toBe('normal');
      expect(c2.canTrade()).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Alert callback error handling
  // ─────────────────────────────────────────────────────────────────────────

  describe('alert error handling', () => {
    it('does not throw when alert callback throws', () => {
      const badAlert: IAlertCallback = {
        sendAlert() {
          throw new Error('Network error');
        },
      };
      const controller = new SafeModeController(db, badAlert);
      // Should not throw
      expect(() => controller.trigger('rpc_failure')).not.toThrow();
    });

    it('does not throw when alert callback returns rejected promise', () => {
      const badAlert: IAlertCallback = {
        sendAlert() {
          return Promise.reject(new Error('Timeout'));
        },
      };
      const controller = new SafeModeController(db, badAlert);
      expect(() => controller.trigger('gas_critical')).not.toThrow();
    });

    it('works without alert callback', () => {
      const controller = new SafeModeController(db);
      // Should not throw
      expect(() => controller.trigger('db_integrity')).not.toThrow();
      expect(controller.getState().state).toBe('safe_mode');
    });
  });
});

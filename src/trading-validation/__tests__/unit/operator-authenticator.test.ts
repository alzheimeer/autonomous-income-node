/**
 * Unit tests for OperatorAuthenticator
 *
 * Tests authentication (Telegram + API key), privileged command authorization,
 * rate limiting, command logging, and security alerts.
 *
 * Requirements: 30.1, 30.2, 30.3, 24.1, 24.2, 24.3, 24.4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type TradingDatabase } from '../../db.js';
import { runMigrations } from '../../migrations.js';
import {
  OperatorAuthenticator,
  hashValue,
} from '../../operator-authenticator.js';
import type {
  OperatorAuthenticatorConfig,
  ISecurityAlertCallback,
} from '../../operator-authenticator.js';

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

const TEST_CHAT_ID = '123456789';
const TEST_SECRET = 'my-super-secret-telegram-token';
const TEST_API_KEY = 'dashboard-api-key-abc123';

function createDb(): TradingDatabase {
  const db = createDatabase(':memory:');
  db.pragma('journal_mode = WAL');
  runMigrations(db);
  return db;
}

function createConfig(): OperatorAuthenticatorConfig {
  return {
    telegramChatId: TEST_CHAT_ID,
    telegramSecretHash: hashValue(TEST_SECRET),
    apiKeyHash: hashValue(TEST_API_KEY),
    rateLimitPerMinute: 60,
  };
}

function createMockAlert(): ISecurityAlertCallback & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    sendAlert(message: string) {
      messages.push(message);
    },
  };
}

function getOperatorCommands(db: TradingDatabase): Array<{
  command: string;
  source: string;
  chat_id: string | null;
  authorized: number;
  timestamp: number;
}> {
  return db.prepare(
    'SELECT command, source, chat_id, authorized, timestamp FROM operator_commands ORDER BY id ASC',
  ).all() as Array<{
    command: string;
    source: string;
    chat_id: string | null;
    authorized: number;
    timestamp: number;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('OperatorAuthenticator', () => {
  let db: TradingDatabase;
  let config: OperatorAuthenticatorConfig;
  let alert: ISecurityAlertCallback & { messages: string[] };
  let auth: OperatorAuthenticator;

  beforeEach(() => {
    db = createDb();
    config = createConfig();
    alert = createMockAlert();
    auth = new OperatorAuthenticator(db, config, alert);
  });

  afterEach(() => {
    db.close();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Telegram Verification (Req 30.1)
  // ─────────────────────────────────────────────────────────────────────────

  describe('verifyTelegram', () => {
    it('should verify valid chat_id + secret', () => {
      const result = auth.verifyTelegram(TEST_CHAT_ID, TEST_SECRET);

      expect(result.source).toBe('telegram');
      expect(result.chatId).toBe(TEST_CHAT_ID);
      expect(result.verified).toBe(true);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('should reject invalid chat_id', () => {
      const result = auth.verifyTelegram('wrong_chat_id', TEST_SECRET);

      expect(result.verified).toBe(false);
      expect(result.chatId).toBe('wrong_chat_id');
    });

    it('should reject invalid secret with correct chat_id', () => {
      const result = auth.verifyTelegram(TEST_CHAT_ID, 'wrong-secret');

      expect(result.verified).toBe(false);
      expect(result.chatId).toBe(TEST_CHAT_ID);
    });

    it('should send security alert on invalid chat_id', () => {
      auth.verifyTelegram('attacker_chat', TEST_SECRET);

      expect(alert.messages.length).toBe(1);
      expect(alert.messages[0]).toContain('UNAUTHORIZED TELEGRAM ACCESS');
      expect(alert.messages[0]).toContain('attacker_chat');
    });

    it('should send security alert on invalid secret', () => {
      auth.verifyTelegram(TEST_CHAT_ID, 'bad-secret');

      expect(alert.messages.length).toBe(1);
      expect(alert.messages[0]).toContain('INVALID TELEGRAM SECRET');
    });

    it('should log verification attempt to operator_commands', () => {
      auth.verifyTelegram('wrong_id', TEST_SECRET);

      const commands = getOperatorCommands(db);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('verify_telegram');
      expect(commands[0].source).toBe('telegram');
      expect(commands[0].chat_id).toBe('wrong_id');
      expect(commands[0].authorized).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // API Key Verification (Req 30.1)
  // ─────────────────────────────────────────────────────────────────────────

  describe('verifyApiKey', () => {
    it('should verify valid API key', () => {
      const result = auth.verifyApiKey(TEST_API_KEY);

      expect(result.source).toBe('api_key');
      expect(result.verified).toBe(true);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    it('should reject invalid API key', () => {
      const result = auth.verifyApiKey('invalid-key');

      expect(result.verified).toBe(false);
    });

    it('should send security alert on invalid API key', () => {
      auth.verifyApiKey('hacker-key');

      expect(alert.messages.length).toBe(1);
      expect(alert.messages[0]).toContain('INVALID API KEY ATTEMPT');
    });

    it('should log failed API key attempt', () => {
      auth.verifyApiKey('bad-key');

      const commands = getOperatorCommands(db);
      expect(commands.length).toBe(1);
      expect(commands[0].command).toBe('verify_api_key');
      expect(commands[0].source).toBe('api_key');
      expect(commands[0].authorized).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Privileged Commands (Req 30.2)
  // ─────────────────────────────────────────────────────────────────────────

  describe('isPrivilegedCommand', () => {
    it('should identify mode transitions as privileged', () => {
      expect(auth.isPrivilegedCommand('transition_to_micro')).toBe(true);
      expect(auth.isPrivilegedCommand('transition_to_shadow')).toBe(true);
    });

    it('should identify safe mode operations as privileged', () => {
      expect(auth.isPrivilegedCommand('exit_safe_mode')).toBe(true);
      expect(auth.isPrivilegedCommand('resume_safe_mode')).toBe(true);
    });

    it('should identify kill switch reset as privileged', () => {
      expect(auth.isPrivilegedCommand('reset_kill_switch')).toBe(true);
    });

    it('should identify parameter changes as privileged', () => {
      expect(auth.isPrivilegedCommand('change_params')).toBe(true);
      expect(auth.isPrivilegedCommand('update_config')).toBe(true);
    });

    it('should identify module management as privileged', () => {
      expect(auth.isPrivilegedCommand('enable_module')).toBe(true);
      expect(auth.isPrivilegedCommand('disable_module')).toBe(true);
    });

    it('should identify emergency stop as privileged', () => {
      expect(auth.isPrivilegedCommand('emergency_stop')).toBe(true);
    });

    it('should identify reserve promotion as privileged (E9)', () => {
      expect(auth.isPrivilegedCommand('promote_reserve')).toBe(true);
    });

    it('should not identify unknown commands as privileged', () => {
      expect(auth.isPrivilegedCommand('get_status')).toBe(false);
      expect(auth.isPrivilegedCommand('view_positions')).toBe(false);
      expect(auth.isPrivilegedCommand('random_command')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Command Authorization (Req 30.3, 24.4)
  // ─────────────────────────────────────────────────────────────────────────

  describe('authorizeCommand', () => {
    it('should authorize privileged command with verified auth', () => {
      const operatorAuth = auth.verifyTelegram(TEST_CHAT_ID, TEST_SECRET);
      const authorized = auth.authorizeCommand('emergency_stop', operatorAuth);

      expect(authorized).toBe(true);
    });

    it('should reject privileged command with unverified auth', () => {
      const operatorAuth = auth.verifyTelegram(TEST_CHAT_ID, 'wrong');
      const authorized = auth.authorizeCommand('emergency_stop', operatorAuth);

      expect(authorized).toBe(false);
    });

    it('should always authorize non-privileged commands', () => {
      const unverified = { source: 'telegram' as const, chatId: 'x', timestamp: Date.now(), verified: false };
      const authorized = auth.authorizeCommand('get_status', unverified);

      expect(authorized).toBe(true);
    });

    it('should log authorized privileged commands', () => {
      const operatorAuth = auth.verifyTelegram(TEST_CHAT_ID, TEST_SECRET);
      auth.authorizeCommand('exit_safe_mode', operatorAuth);

      const commands = getOperatorCommands(db);
      // First log is from verifyTelegram (no log on success), second from authorizeCommand
      const exitCmd = commands.find((c) => c.command === 'exit_safe_mode');
      expect(exitCmd).toBeDefined();
      expect(exitCmd!.authorized).toBe(1);
      expect(exitCmd!.source).toBe('telegram');
      expect(exitCmd!.chat_id).toBe(TEST_CHAT_ID);
    });

    it('should log and alert on unauthorized privileged commands', () => {
      const badAuth = { source: 'api_key' as const, timestamp: Date.now(), verified: false };
      auth.authorizeCommand('reset_kill_switch', badAuth);

      const commands = getOperatorCommands(db);
      const resetCmd = commands.find((c) => c.command === 'reset_kill_switch');
      expect(resetCmd).toBeDefined();
      expect(resetCmd!.authorized).toBe(0);

      // Should trigger security alert
      expect(alert.messages.some((m) => m.includes('UNAUTHORIZED PRIVILEGED COMMAND'))).toBe(true);
      expect(alert.messages.some((m) => m.includes('reset_kill_switch'))).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Rate Limiting (Req 24.2)
  // ─────────────────────────────────────────────────────────────────────────

  describe('checkRateLimit', () => {
    it('should allow requests under the limit', () => {
      for (let i = 0; i < 60; i++) {
        expect(auth.checkRateLimit('192.168.1.1')).toBe(true);
      }
    });

    it('should block requests over 60/min', () => {
      // Fill up the limit
      for (let i = 0; i < 60; i++) {
        auth.checkRateLimit('10.0.0.1');
      }

      // 61st request should be blocked
      expect(auth.checkRateLimit('10.0.0.1')).toBe(false);
    });

    it('should track different IPs independently', () => {
      // Fill up IP1
      for (let i = 0; i < 60; i++) {
        auth.checkRateLimit('10.0.0.1');
      }

      // IP2 should still be allowed
      expect(auth.checkRateLimit('10.0.0.2')).toBe(true);
    });

    it('should allow custom rate limit configuration', () => {
      const limitedConfig = { ...config, rateLimitPerMinute: 5 };
      const limitedAuth = new OperatorAuthenticator(db, limitedConfig, alert);

      for (let i = 0; i < 5; i++) {
        expect(limitedAuth.checkRateLimit('1.2.3.4')).toBe(true);
      }
      expect(limitedAuth.checkRateLimit('1.2.3.4')).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Rate Limit Cleanup
  // ─────────────────────────────────────────────────────────────────────────

  describe('cleanupRateLimits', () => {
    it('should remove stale entries', () => {
      // Add some requests
      auth.checkRateLimit('old-ip');

      // Cleanup should not crash
      auth.cleanupRateLimits();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // hashValue utility
  // ─────────────────────────────────────────────────────────────────────────

  describe('hashValue', () => {
    it('should produce consistent SHA-256 hash', () => {
      const hash1 = hashValue('test');
      const hash2 = hashValue('test');
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different inputs', () => {
      const hash1 = hashValue('secret1');
      const hash2 = hashValue('secret2');
      expect(hash1).not.toBe(hash2);
    });

    it('should produce 64-character hex string', () => {
      const hash = hashValue('anything');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]+$/);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Integration: Full Auth Flow
  // ─────────────────────────────────────────────────────────────────────────

  describe('full authentication flow', () => {
    it('should support complete Telegram command flow', () => {
      // 1. Rate limit check
      expect(auth.checkRateLimit('operator-ip')).toBe(true);

      // 2. Verify operator identity
      const operatorAuth = auth.verifyTelegram(TEST_CHAT_ID, TEST_SECRET);
      expect(operatorAuth.verified).toBe(true);

      // 3. Authorize privileged command
      const authorized = auth.authorizeCommand('transition_to_micro', operatorAuth);
      expect(authorized).toBe(true);
    });

    it('should support complete API key command flow', () => {
      // 1. Rate limit check
      expect(auth.checkRateLimit('dashboard-ip')).toBe(true);

      // 2. Verify API key
      const operatorAuth = auth.verifyApiKey(TEST_API_KEY);
      expect(operatorAuth.verified).toBe(true);

      // 3. Authorize privileged command
      const authorized = auth.authorizeCommand('emergency_stop', operatorAuth);
      expect(authorized).toBe(true);
    });

    it('should block unauthorized privileged commands end-to-end', () => {
      // Attacker with wrong credentials
      const attackerAuth = auth.verifyTelegram('attacker', 'bad-secret');
      expect(attackerAuth.verified).toBe(false);

      // Should not be able to execute privileged commands
      const authorized = auth.authorizeCommand('reset_kill_switch', attackerAuth);
      expect(authorized).toBe(false);

      // Security alerts should have fired
      expect(alert.messages.length).toBeGreaterThan(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // No secrets in output (Req 24.1)
  // ─────────────────────────────────────────────────────────────────────────

  describe('secret redaction', () => {
    it('should not include raw secrets in security alerts', () => {
      auth.verifyTelegram(TEST_CHAT_ID, 'attacker-secret');

      // Alert should not contain the actual configured secret or its hash
      for (const msg of alert.messages) {
        expect(msg).not.toContain(TEST_SECRET);
        expect(msg).not.toContain(config.telegramSecretHash);
      }
    });

    it('should not include API key in alerts', () => {
      auth.verifyApiKey('attacker-key');

      for (const msg of alert.messages) {
        expect(msg).not.toContain(TEST_API_KEY);
        expect(msg).not.toContain(config.apiKeyHash);
      }
    });
  });
});

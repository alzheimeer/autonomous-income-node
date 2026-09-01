/**
 * Trading Validation Phase - OperatorAuthenticator
 *
 * Implements IOperatorAuthenticator interface for authenticating operator
 * commands via Telegram chat_id + secret or dashboard API key.
 *
 * Features:
 * - Verify Telegram chat_id + secret pair
 * - Verify API key for dashboard access
 * - Define privileged commands (mode transitions, exit Safe_Mode, etc.)
 * - Log all commands to operator_commands table
 * - Reject + security alert on unauthorized attempts
 * - Rate limiting: 60 req/min per CF-Connecting-IP
 *
 * Requirements: 30.1, 30.2, 30.3, 24.1, 24.2, 24.3, 24.4
 */

import type { TradingDatabase } from './db.js';
import { createHash, timingSafeEqual } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════
// Types and Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** Operator authentication result */
export interface OperatorAuth {
  source: 'telegram' | 'api_key';
  chatId?: string;
  timestamp: number;
  verified: boolean;
}

/** Configuration for the OperatorAuthenticator */
export interface OperatorAuthenticatorConfig {
  /** Authorized Telegram chat ID */
  telegramChatId: string;
  /** SHA-256 hash of the Telegram secret (never store raw) */
  telegramSecretHash: string;
  /** SHA-256 hash of the API key (never store raw) */
  apiKeyHash: string;
  /** Max requests per minute per IP (default: 60) */
  rateLimitPerMinute: number;
}

/** Alert callback for security notifications */
export interface ISecurityAlertCallback {
  sendAlert(message: string): void | Promise<void>;
}

/** IOperatorAuthenticator interface */
export interface IOperatorAuthenticator {
  /** Verify Telegram chat_id + secret */
  verifyTelegram(chatId: string, secret: string): OperatorAuth;
  /** Verify API key for dashboard access */
  verifyApiKey(key: string): OperatorAuth;
  /** Check if a command is privileged (requires auth) */
  isPrivilegedCommand(command: string): boolean;
  /** Log and authorize a command. Returns OperatorAuth if authorized. */
  authorizeCommand(command: string, auth: OperatorAuth): boolean;
  /** Check rate limit for a given IP. Returns true if allowed, false if rate-limited. */
  checkRateLimit(ip: string): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Privileged commands that require operator authentication.
 * Per Req 30.2: mode transitions, exit Safe_Mode, reset KillSwitch,
 * change params, enable modules, emergency stop.
 */
const PRIVILEGED_COMMANDS: ReadonlySet<string> = new Set([
  // Mode transitions
  'transition_to_micro',
  'transition_to_shadow',

  // Safe_Mode operations
  'exit_safe_mode',
  'resume_safe_mode',

  // KillSwitch
  'reset_kill_switch',

  // Parameter changes
  'change_params',
  'update_config',
  'freeze_config',

  // Module management
  'enable_module',
  'disable_module',
  'enable_research_budget',

  // Emergency
  'emergency_stop',

  // Bankroll / Reserve management (E9)
  'promote_reserve',

  // Experiment management
  'start_experiment',
  'reset_experiment',

  // Manual overrides
  'force_close_position',
  'manual_approve',
]);

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * OperatorAuthenticator handles authentication and authorization of
 * operator commands from Telegram and the dashboard API.
 *
 * Security measures:
 * - Timing-safe comparison for secrets/API keys
 * - SHA-256 hashing (raw secrets never stored)
 * - Rate limiting per CF-Connecting-IP
 * - All commands logged (authorized and unauthorized)
 * - Security alerts on unauthorized privileged command attempts
 */
export class OperatorAuthenticator implements IOperatorAuthenticator {
  private readonly db: TradingDatabase;
  private readonly config: OperatorAuthenticatorConfig;
  private readonly alertCallback?: ISecurityAlertCallback;

  /**
   * In-memory rate limit tracking.
   * Maps IP → array of request timestamps (within the current minute window).
   */
  private readonly rateLimitMap: Map<string, number[]> = new Map();

  /** Cleanup interval for stale rate limit entries */
  private readonly RATE_LIMIT_WINDOW_MS = 60_000;

  constructor(
    db: TradingDatabase,
    config: OperatorAuthenticatorConfig,
    alertCallback?: ISecurityAlertCallback,
  ) {
    this.db = db;
    this.config = config;
    this.alertCallback = alertCallback;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Verify a Telegram operator by chat_id + secret.
   *
   * Uses timing-safe comparison to prevent timing attacks.
   * The secret is hashed with SHA-256 before comparison.
   */
  verifyTelegram(chatId: string, secret: string): OperatorAuth {
    const now = Date.now();

    // Check chat_id matches configured operator
    if (chatId !== this.config.telegramChatId) {
      this.logCommand('verify_telegram', 'telegram', chatId, false);
      this.sendSecurityAlert(
        `⚠️ UNAUTHORIZED TELEGRAM ACCESS\nChat ID: ${chatId}\nExpected: [REDACTED]\nTime: ${new Date(now).toISOString()}`,
      );
      return { source: 'telegram', chatId, timestamp: now, verified: false };
    }

    // Timing-safe comparison of secret hash
    const secretHash = hashValue(secret);
    const isValid = timingSafeCompare(secretHash, this.config.telegramSecretHash);

    if (!isValid) {
      this.logCommand('verify_telegram', 'telegram', chatId, false);
      this.sendSecurityAlert(
        `⚠️ INVALID TELEGRAM SECRET\nChat ID: ${chatId}\nTime: ${new Date(now).toISOString()}`,
      );
    }

    return { source: 'telegram', chatId, timestamp: now, verified: isValid };
  }

  /**
   * Verify an API key for dashboard access.
   *
   * Uses timing-safe comparison to prevent timing attacks.
   * The key is hashed with SHA-256 before comparison.
   */
  verifyApiKey(key: string): OperatorAuth {
    const now = Date.now();

    const keyHash = hashValue(key);
    const isValid = timingSafeCompare(keyHash, this.config.apiKeyHash);

    if (!isValid) {
      this.logCommand('verify_api_key', 'api_key', undefined, false);
      this.sendSecurityAlert(
        `⚠️ INVALID API KEY ATTEMPT\nTime: ${new Date(now).toISOString()}`,
      );
    }

    return { source: 'api_key', timestamp: now, verified: isValid };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Authorization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if a command is privileged (requires authentication).
   */
  isPrivilegedCommand(command: string): boolean {
    return PRIVILEGED_COMMANDS.has(command);
  }

  /**
   * Authorize and log a command execution.
   *
   * Returns true if the command is authorized, false otherwise.
   * Non-privileged commands are always authorized (but still logged).
   * Privileged commands require verified OperatorAuth.
   *
   * All commands (authorized or not) are logged to the operator_commands table.
   * Unauthorized privileged commands trigger a security alert.
   */
  authorizeCommand(command: string, auth: OperatorAuth): boolean {
    const isPrivileged = this.isPrivilegedCommand(command);

    // Non-privileged commands are always authorized
    if (!isPrivileged) {
      this.logCommand(command, auth.source, auth.chatId, true);
      return true;
    }

    // Privileged commands require verified auth
    const authorized = auth.verified;
    this.logCommand(command, auth.source, auth.chatId, authorized);

    if (!authorized) {
      this.sendSecurityAlert(
        `🚨 UNAUTHORIZED PRIVILEGED COMMAND\nCommand: ${command}\nSource: ${auth.source}\nChat ID: ${auth.chatId ?? 'N/A'}\nTime: ${new Date(auth.timestamp).toISOString()}`,
      );
    }

    return authorized;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Rate Limiting (Req 24.2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check rate limit for a given IP address.
   *
   * Per Req 24.2: 60 req/min per CF-Connecting-IP.
   * Uses a sliding window approach.
   *
   * Returns true if the request is allowed, false if rate-limited.
   */
  checkRateLimit(ip: string): boolean {
    const now = Date.now();
    const windowStart = now - this.RATE_LIMIT_WINDOW_MS;

    // Get or create timestamps array for this IP
    let timestamps = this.rateLimitMap.get(ip);
    if (!timestamps) {
      timestamps = [];
      this.rateLimitMap.set(ip, timestamps);
    }

    // Remove expired entries (outside the 60s window)
    const validTimestamps = timestamps.filter((t) => t > windowStart);
    this.rateLimitMap.set(ip, validTimestamps);

    // Check if under limit
    if (validTimestamps.length >= this.config.rateLimitPerMinute) {
      return false;
    }

    // Record this request
    validTimestamps.push(now);
    return true;
  }

  /**
   * Clean up stale rate limit entries.
   * Call periodically (e.g., every 5 minutes) to prevent memory leaks.
   */
  cleanupRateLimits(): void {
    const now = Date.now();
    const windowStart = now - this.RATE_LIMIT_WINDOW_MS;

    for (const [ip, timestamps] of this.rateLimitMap.entries()) {
      const valid = timestamps.filter((t) => t > windowStart);
      if (valid.length === 0) {
        this.rateLimitMap.delete(ip);
      } else {
        this.rateLimitMap.set(ip, valid);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Command Logging (Req 30.3)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Log a command to the operator_commands table.
   *
   * Per Req 30.3: Log all commands (authorized and unauthorized).
   */
  private logCommand(
    command: string,
    source: string,
    chatId: string | undefined,
    authorized: boolean,
  ): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO operator_commands (command, source, chat_id, authorized, timestamp) VALUES (?, ?, ?, ?, ?)',
    ).run(command, source, chatId ?? null, authorized ? 1 : 0, now);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Security Alerts (Req 24.4, 30.3)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a security alert via the injected callback.
   * Fire-and-forget for async callbacks.
   */
  private sendSecurityAlert(message: string): void {
    if (this.alertCallback) {
      try {
        const result = this.alertCallback.sendAlert(message);
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
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Hash a value with SHA-256 and return hex string.
 * Used for comparing secrets without storing raw values.
 */
export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Timing-safe string comparison.
 * Prevents timing attacks when comparing hashed secrets.
 *
 * Returns true if both strings are equal, false otherwise.
 * Always takes the same amount of time regardless of where strings differ.
 */
function timingSafeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a comparison to maintain constant-ish time
    // but result will always be false
    const bufA = Buffer.from(a, 'utf8');
    const bufB = Buffer.from(a, 'utf8'); // compare against itself to burn time
    timingSafeEqual(bufA, bufB);
    return false;
  }

  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return timingSafeEqual(bufA, bufB);
}

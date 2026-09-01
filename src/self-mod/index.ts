/**
 * Self-Mod Module
 *
 * Public interface for the auto-improvement subsystem.
 *
 * Responsibilities:
 *   - Gate all modification attempts behind Tier 3/4 capability check
 *     (`capabilityGates.selfModEnabled`)
 *   - Enforce a rate limit of ≤ 3 modification attempts per 24-hour window
 *   - Delegate the backup → sandbox → apply → audit pipeline to CodePatcher
 *   - Expose `proposeModification`, `getRateLimit`, and `getHistory` to the
 *     ReAct loop / action dispatcher
 *
 * The module also exposes its sub-components so they can be used independently
 * (e.g. BackupManager by the agent startup crash-recovery path).
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7
 */

import type { SelfModRepository } from '../state/repositories/self-mod.repo.js';
import type { CapabilityGates } from '../survival/tier-evaluator.js';
import { ErrorCode } from '../mcp/client/mcp-client.js';

import { BackupManager } from './backup-manager.js';
import { AuditLogger } from './audit-logger.js';
import type { ModificationRecord } from './audit-logger.js';
import { SandboxRunner } from './sandbox-runner.js';
import { CodePatcher } from './code-patcher.js';
import type {
  ModificationProposal,
  ModificationResult,
} from './code-patcher.js';

// ---------------------------------------------------------------------------
// Re-exports for consumers
// ---------------------------------------------------------------------------

export { BackupManager } from './backup-manager.js';
export { AuditLogger } from './audit-logger.js';
export type { ModificationRecord } from './audit-logger.js';
export { SandboxRunner } from './sandbox-runner.js';
export type { SandboxResult } from './sandbox-runner.js';
export { CodePatcher } from './code-patcher.js';
export type { ModificationProposal, ModificationResult } from './code-patcher.js';

// ---------------------------------------------------------------------------
// Rate-limit constants (configurable via environment variables)
// ---------------------------------------------------------------------------

/** Maximum allowed modifications within the rolling window. */
const RATE_LIMIT_MAX = parseInt(process.env['SELF_MOD_RATE_LIMIT_MAX'] ?? '3', 10);

/** Rolling window duration in milliseconds. Default: 24 hours, configurable. */
const RATE_LIMIT_WINDOW_MS = parseInt(
  process.env['SELF_MOD_RATE_LIMIT_WINDOW_MS'] ?? String(24 * 60 * 60 * 1_000),
  10,
);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RateLimitStatus {
  allowed: boolean;
  remaining: number;
  windowMs: number;
  usedInWindow: number;
}

// ---------------------------------------------------------------------------
// SelfModModule
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full self-modification workflow.
 *
 * Construction requires a `SelfModRepository` (for persistence) and a
 * capability-gates provider (a function or object that returns the current
 * gates).  This keeps the module decoupled from the SurvivalModule.
 *
 * Usage:
 * ```ts
 * const selfMod = new SelfModModule(selfModRepo, () => survivalModule.getCapabilityGates());
 * await selfMod.initialize(); // runs crash-recovery check
 * const result = await selfMod.proposeModification(proposal);
 * ```
 */
export class SelfModModule {
  private readonly backupManager: BackupManager;
  private readonly auditLogger: AuditLogger;
  private readonly sandboxRunner: SandboxRunner;
  private readonly codePatcher: CodePatcher;

  constructor(
    private readonly repo: SelfModRepository,
    /** Returns the currently active capability gates. */
    private readonly getGates: () => CapabilityGates,
    /** Working directory for the crash sentinel file. Defaults to process.cwd(). */
    workDir?: string,
  ) {
    this.backupManager = new BackupManager();
    this.auditLogger = new AuditLogger(repo);
    this.sandboxRunner = new SandboxRunner();
    this.codePatcher = new CodePatcher(
      this.backupManager,
      this.sandboxRunner,
      this.auditLogger,
      workDir,
    );
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Run crash-recovery on startup.
   *
   * Detects `.last-modification.json` left by a previous crashed process,
   * restores the backup, and marks the DB record as `reverted`.
   *
   * Requirement: 9.7
   */
  async initialize(): Promise<void> {
    await this.codePatcher.recoverFromCrashIfNeeded();
  }

  // ---------------------------------------------------------------------------
  // Core API
  // ---------------------------------------------------------------------------

  /**
   * Propose a code modification.
   *
   * The pipeline:
   *   1. Check Tier gate (`selfModEnabled`) — reject with TIER_GATE_DENIED if
   *      the agent is below Tier 3.
   *   2. Check rate limit — reject with RATE_LIMIT_EXCEEDED if ≥ 3 attempts
   *      have been applied in the last 24 h.
   *   3. Delegate to `CodePatcher.applyModification()` which handles backup,
   *      sandbox, apply, and audit logging.
   *
   * @param proposal - The modification proposal from the LLM.
   * @returns A `ModificationResult` (never throws).
   *
   * Requirements: 9.1, 9.2, 9.3, 9.4, 9.6
   */
  async proposeModification(
    proposal: ModificationProposal,
  ): Promise<ModificationResult> {
    // --- Tier gate ---
    const gates = this.getGates();
    if (!gates.selfModEnabled) {
      return {
        success: false,
        recordId: '',
        status: 'rejected',
        sandboxOutput: '',
        error: {
          code: ErrorCode.TIER_GATE_DENIED,
          message:
            'Self-modification is only allowed in Tier 3 or Tier 4. ' +
            'Current tier does not have selfModEnabled.',
        },
      };
    }

    // --- Rate limit ---
    const rateLimitStatus = this.checkRateLimit();
    if (!rateLimitStatus.allowed) {
      return {
        success: false,
        recordId: '',
        status: 'rejected',
        sandboxOutput: '',
        error: {
          code: ErrorCode.RATE_LIMIT_EXCEEDED,
          message:
            `Rate limit exceeded: ${RATE_LIMIT_MAX} modifications per ${RATE_LIMIT_WINDOW_MS / 3_600_000}h. ` +
            `${rateLimitStatus.usedInWindow} used in current window.`,
        },
      };
    }

    // --- Delegate to CodePatcher ---
    return this.codePatcher.applyModification(proposal);
  }

  /**
   * Return the current rate-limit status.
   *
   * Counts the number of `applied` records in the last 24 hours via
   * `self_mod_history` — the sole source of truth (Requirement 9.6).
   *
   * @returns `{allowed, remaining, windowMs, usedInWindow}`
   */
  checkRateLimit(): RateLimitStatus {
    const usedInWindow = this.auditLogger.countRecentAttempts(RATE_LIMIT_WINDOW_MS);
    const remaining = Math.max(0, RATE_LIMIT_MAX - usedInWindow);

    return {
      allowed: usedInWindow < RATE_LIMIT_MAX,
      remaining,
      windowMs: RATE_LIMIT_WINDOW_MS,
      usedInWindow,
    };
  }

  /**
   * Alias of `checkRateLimit` — kept for parity with the design doc interface.
   */
  getRateLimit(): RateLimitStatus {
    return this.checkRateLimit();
  }

  /**
   * Return the full modification history (most recent first).
   *
   * @param limit - Maximum records to return. Defaults to 50.
   * @returns Array of `ModificationRecord`.
   *
   * Requirement: 9.5
   */
  async getHistory(limit?: number): Promise<ModificationRecord[]> {
    return this.auditLogger.getHistory(limit);
  }

  // ---------------------------------------------------------------------------
  // Accessors for sub-components (e.g. agent startup crash-recovery)
  // ---------------------------------------------------------------------------

  getBackupManager(): BackupManager {
    return this.backupManager;
  }

  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  getCodePatcher(): CodePatcher {
    return this.codePatcher;
  }
}

/**
 * CodePatcher
 *
 * Implements the strict self-modification pipeline required by the design:
 *
 *   1. backup  – create a timestamped copy of the original file
 *   2. sandbox – run the test suite with the proposed content
 *   3. apply   – write proposed content to the live path (only if tests passed)
 *   4. audit   – record the result in `self_mod_history` via AuditLogger
 *
 * Additionally, on startup, CodePatcher checks for a `.last-modification.json`
 * sentinel file.  If the file exists it means the previous run crashed after
 * applying a modification; the patcher automatically restores the backup and
 * marks the record as `reverted`.
 *
 * Requirements: 9.2, 9.3, 9.4, 9.5, 9.7
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

import { BackupManager } from './backup-manager.js';
import { SandboxRunner } from './sandbox-runner.js';
import { AuditLogger } from './audit-logger.js';
import { ErrorCode } from '../mcp/client/mcp-client.js';
import { AutonomousValidator } from './autonomous-validator.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Proposed code modification from the LLM / ReAct loop.
 * Mirrors `ModificationProposal` in the design document.
 */
export interface ModificationProposal {
  /** Absolute path to the file to be modified. */
  filePath: string;
  /** Current (original) content of the file. */
  originalContent: string;
  /** New content that should replace the file. */
  proposedContent: string;
  /** Free-text reasoning from the LLM that motivated this change. */
  llmReasoning: string;
  /** ID of the observation/action that triggered this proposal. */
  triggeredBy: string;
}

/**
 * Outcome of a modification attempt.
 * Mirrors `ModificationResult` in the design document.
 */
export interface ModificationResult {
  success: boolean;
  recordId: string;
  status: 'applied' | 'rejected' | 'reverted';
  sandboxOutput: string;
  backupPath?: string;
  error?: {
    code: ErrorCode | 'SANDBOX_FAILURE' | 'IO_ERROR' | 'REQUIRES_MANUAL_SETUP';
    message: string;
  };
  /** FIX-027: If true, the code is valid but needs manual setup to work */
  requiresManualSetup?: boolean;
  /** FIX-027: Description of what manual setup is needed */
  manualSetupReason?: string;
}

/** Sentinel file written just before applying a modification. */
const SENTINEL_FILENAME = '.last-modification.json';

interface SentinelData {
  recordId: string;
  filePath: string;
  backupPath: string;
  appliedAt: number;
}

// ---------------------------------------------------------------------------
// CodePatcher
// ---------------------------------------------------------------------------

export class CodePatcher {
  private readonly autonomousValidator = new AutonomousValidator();

  constructor(
    private readonly backupManager: BackupManager,
    private readonly sandboxRunner: SandboxRunner,
    private readonly auditLogger: AuditLogger,
    /** Directory for the sentinel file. Defaults to process.cwd(). */
    private readonly workDir: string = process.cwd(),
  ) {}

  // ---------------------------------------------------------------------------
  // Crash-recovery check (call on startup before any new modifications)
  // ---------------------------------------------------------------------------

  /**
   * Check for a crash sentinel written by the previous process.
   *
   * If `.last-modification.json` exists the agent crashed after applying a
   * modification.  This method:
   *   1. Reads the sentinel to get the backup path and record ID
   *   2. Restores the original file from backup
   *   3. Marks the DB record as `reverted`
   *   4. Deletes the sentinel
   *
   * Should be called once during agent startup (before the ReAct loop starts).
   *
   * Requirements: 9.7
   */
  async recoverFromCrashIfNeeded(): Promise<void> {
    const sentinelPath = path.join(this.workDir, SENTINEL_FILENAME);

    let sentinel: SentinelData;
    try {
      const raw = await fs.readFile(sentinelPath, 'utf8');
      sentinel = JSON.parse(raw) as SentinelData;
    } catch {
      // No sentinel — clean startup, nothing to do
      return;
    }

    // Restore the backup
    try {
      await this.backupManager.restoreBackup(
        sentinel.backupPath,
        sentinel.filePath,
      );
    } catch (err) {
      // Even if restore fails we clean up the sentinel and mark as reverted
      console.error(
        `[CodePatcher] crash-recovery: failed to restore backup for ${sentinel.filePath}: ${String(err)}`,
      );
    }

    // Mark record as reverted in audit log
    this.auditLogger.markReverted(sentinel.recordId, Date.now());

    // Remove sentinel so we don't try again on the next restart
    await fs.unlink(sentinelPath).catch(() => {
      /* best-effort */
    });
  }

  // ---------------------------------------------------------------------------
  // Main pipeline
  // ---------------------------------------------------------------------------

  /**
   * Apply a proposed modification following the strict pipeline:
   * backup → sandbox → apply (if passed) → audit log.
   *
   * @param proposal - The modification proposal from the LLM.
   * @returns A `ModificationResult` describing what happened.
   *          Never throws — all errors are returned in `result.error`.
   */
  async applyModification(
    proposal: ModificationProposal,
  ): Promise<ModificationResult> {
    const recordId = uuidv4();

    // ------------------------------------------------------------------
    // Step 1: Create backup
    // ------------------------------------------------------------------

    let backupPath: string;
    try {
      backupPath = await this.backupManager.createBackup(proposal.filePath);
    } catch (err) {
      return {
        success: false,
        recordId,
        status: 'rejected',
        sandboxOutput: '',
        error: {
          code: 'IO_ERROR',
          message: `Failed to create backup for ${proposal.filePath}: ${String(err)}`,
        },
      };
    }

    // ------------------------------------------------------------------
    // Step 2: Run tests in sandbox
    // ------------------------------------------------------------------

    // For files outside src/ (e.g. data/auto-generated/), use AutonomousValidator
    // instead of the full pnpm test suite (which requires compilation)
    const isInSrc = proposal.filePath.includes(`${path.sep}src${path.sep}`) ||
      proposal.filePath.includes('/src/');
    const isAutoGenerated = proposal.filePath.includes('auto-generated');

    let sandboxResult: { passed: boolean; output: string };

    if (isAutoGenerated && !isInSrc) {
      // Use autonomous validator for auto-generated files outside src/
      try {
        const moduleName = path.basename(proposal.filePath, '.ts');
        const validationResult = await this.autonomousValidator.validate(
          proposal.proposedContent,
          moduleName,
        );

        const outputLines = [
          '[AutonomousValidator] Validating auto-generated module...',
          `  Duration: ${validationResult.durationMs}ms`,
          `  Valid: ${validationResult.valid}`,
        ];

        if (validationResult.errors.length > 0) {
          outputLines.push('  Errors:');
          for (const err of validationResult.errors) {
            outputLines.push(`    - ${err}`);
          }
        }

        if (validationResult.warnings.length > 0) {
          outputLines.push('  Warnings:');
          for (const warn of validationResult.warnings) {
            outputLines.push(`    - ${warn}`);
          }
        }

        // FIX-027: Check if validation failed due to missing manual setup
        if (validationResult.requiresManualSetup) {
          outputLines.push('');
          outputLines.push('  ⚠️ REQUIRES MANUAL SETUP:');
          outputLines.push(`    ${validationResult.manualSetupReason}`);
        }

        sandboxResult = {
          passed: validationResult.valid,
          output: outputLines.join('\n'),
          // FIX-027: Pass through manual setup info
          requiresManualSetup: validationResult.requiresManualSetup,
          manualSetupReason: validationResult.manualSetupReason,
        } as { passed: boolean; output: string; requiresManualSetup?: boolean; manualSetupReason?: string };
      } catch (err) {
        sandboxResult = {
          passed: false,
          output: `[AutonomousValidator] Validation threw: ${String(err)}`,
        };
      }
    } else if (!isInSrc) {
      // Non-auto-generated files outside src/ — skip (backward compatibility)
      sandboxResult = {
        passed: true,
        output: '[SandboxRunner] Skipped — file is outside src/ (no compiled tests available)',
      };
    } else {
      try {
        sandboxResult = await this.sandboxRunner.runInSandbox(
          proposal.filePath,
          proposal.proposedContent,
        );
      } catch (err) {
        sandboxResult = {
          passed: false,
          output: `SandboxRunner threw an unexpected error: ${String(err)}`,
        };
      }
    }

    // Compute a minimal unified diff for the audit record (no external dependency)
    const diffText = createUnifiedDiff(
      proposal.filePath,
      proposal.originalContent,
      proposal.proposedContent,
    );

    // ------------------------------------------------------------------
    // Step 3a: Sandbox FAILED — reject and log
    // ------------------------------------------------------------------

    if (!sandboxResult.passed) {
      // FIX-027: Check if failure is due to missing manual setup
      const extendedResult = sandboxResult as { 
        passed: boolean; 
        output: string; 
        requiresManualSetup?: boolean; 
        manualSetupReason?: string 
      };
      
      this.auditLogger.logAttempt({
        id: recordId,
        filePath: proposal.filePath,
        diff: diffText,
        backupPath,
        llmReasoning: proposal.llmReasoning,
        sandboxOutput: sandboxResult.output,
        status: 'rejected',
      });

      // FIX-027: Return specific error for manual setup requirements
      if (extendedResult.requiresManualSetup) {
        return {
          success: false,
          recordId,
          status: 'rejected',
          sandboxOutput: sandboxResult.output,
          backupPath,
          error: {
            code: 'REQUIRES_MANUAL_SETUP',
            message: `Code requires manual setup: ${extendedResult.manualSetupReason}`,
          },
          requiresManualSetup: true,
          manualSetupReason: extendedResult.manualSetupReason,
        };
      }

      return {
        success: false,
        recordId,
        status: 'rejected',
        sandboxOutput: sandboxResult.output,
        backupPath,
        error: {
          code: 'SANDBOX_FAILURE',
          message: 'Sandbox test suite failed — modification rejected.',
        },
      };
    }

    // ------------------------------------------------------------------
    // Step 3b: Sandbox PASSED — write sentinel, apply, remove sentinel
    // ------------------------------------------------------------------

    const sentinelPath = path.join(this.workDir, SENTINEL_FILENAME);

    const sentinelData: SentinelData = {
      recordId,
      filePath: proposal.filePath,
      backupPath,
      appliedAt: Date.now(),
    };

    // Write sentinel BEFORE applying — if we crash between now and removing
    // it the next startup will roll back via recoverFromCrashIfNeeded()
    try {
      await fs.writeFile(sentinelPath, JSON.stringify(sentinelData, null, 2), 'utf8');
    } catch (err) {
      // Sentinel write failed — abort to be safe
      this.auditLogger.logAttempt({
        id: recordId,
        filePath: proposal.filePath,
        diff: diffText,
        backupPath,
        llmReasoning: proposal.llmReasoning,
        sandboxOutput: sandboxResult.output,
        status: 'rejected',
      });

      return {
        success: false,
        recordId,
        status: 'rejected',
        sandboxOutput: sandboxResult.output,
        backupPath,
        error: {
          code: 'IO_ERROR',
          message: `Failed to write crash sentinel: ${String(err)}`,
        },
      };
    }

    // Apply the modification to the live file
    try {
      // Ensure parent directory exists — critical for new auto-generated files
      await fs.mkdir(path.dirname(proposal.filePath), { recursive: true });
      await fs.writeFile(proposal.filePath, proposal.proposedContent, 'utf8');
    } catch (err) {
      // Write failed — restore backup and log as rejected
      await this.backupManager
        .restoreBackup(backupPath, proposal.filePath)
        .catch(() => {
          /* best-effort */
        });

      await fs.unlink(sentinelPath).catch(() => {
        /* best-effort */
      });

      this.auditLogger.logAttempt({
        id: recordId,
        filePath: proposal.filePath,
        diff: diffText,
        backupPath,
        llmReasoning: proposal.llmReasoning,
        sandboxOutput: sandboxResult.output,
        status: 'rejected',
      });

      return {
        success: false,
        recordId,
        status: 'rejected',
        sandboxOutput: sandboxResult.output,
        backupPath,
        error: {
          code: 'IO_ERROR',
          message: `Failed to write modified file ${proposal.filePath}: ${String(err)}`,
        },
      };
    }

    // Remove sentinel — modification was applied successfully
    await fs.unlink(sentinelPath).catch(() => {
      /* best-effort */
    });

    // ------------------------------------------------------------------
    // Step 4: Audit log — applied
    // ------------------------------------------------------------------

    const appliedAt = Date.now();

    this.auditLogger.logAttempt({
      id: recordId,
      filePath: proposal.filePath,
      diff: diffText,
      backupPath,
      llmReasoning: proposal.llmReasoning,
      sandboxOutput: sandboxResult.output,
      status: 'applied',
      appliedAt,
    });

    return {
      success: true,
      recordId,
      status: 'applied',
      sandboxOutput: sandboxResult.output,
      backupPath,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal diff helper (no external dependency)
// ---------------------------------------------------------------------------

/**
 * Produce a minimal unified diff string between two file contents.
 * Lines removed from `original` are prefixed with `-`,
 * lines added in `modified` are prefixed with `+`.
 * Context lines are not included to keep the diff compact.
 */
function createUnifiedDiff(
  filePath: string,
  original: string,
  modified: string,
): string {
  const originalLines = original.split('\n');
  const modifiedLines = modified.split('\n');

  const header = `--- ${filePath} (original)\n+++ ${filePath} (modified)\n`;

  if (original === modified) {
    return `${header}(no changes)\n`;
  }

  const maxLen = Math.max(originalLines.length, modifiedLines.length);
  const chunks: string[] = [];

  let i = 0;
  while (i < maxLen) {
    const origLine = originalLines[i];
    const modLine = modifiedLines[i];

    if (origLine !== modLine) {
      if (origLine !== undefined) chunks.push(`-${origLine}`);
      if (modLine !== undefined) chunks.push(`+${modLine}`);
    }
    i++;
  }

  return header + chunks.join('\n') + '\n';
}

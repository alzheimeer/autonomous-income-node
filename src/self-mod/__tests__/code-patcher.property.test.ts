/**
 * Property 13 — CodePatcher: sandbox always runs before apply
 *
 * Validates: Requirements 9.2, 9.3, 9.4, 9.5
 *
 * Properties verified:
 *  P13-a: When sandbox fails, the result is always 'rejected' (never 'applied').
 *  P13-b: When sandbox passes, the result is always 'applied'.
 *  P13-c: A backup is always created before sandbox runs (backupPath in result).
 *  P13-d: When sandbox fails, the live file is never modified.
 *  P13-e: The recordId in the result is always a non-empty UUID string.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodePatcher } from '../code-patcher.js';
import type { BackupManager } from '../backup-manager.js';
import type { SandboxRunner } from '../sandbox-runner.js';
import type { AuditLogger } from '../audit-logger.js';

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function createBackupManagerStub(backupDir: string): BackupManager {
  let callCount = 0;
  return {
    createBackup: async (filePath: string) => {
      callCount++;
      const backupPath = join(backupDir, `backup-${callCount}.bak`);
      try {
        const content = readFileSync(filePath, 'utf8');
        writeFileSync(backupPath, content);
      } catch {
        writeFileSync(backupPath, '');
      }
      return backupPath;
    },
    restoreBackup: async (backupPath: string, targetPath: string) => {
      const content = readFileSync(backupPath, 'utf8');
      writeFileSync(targetPath, content);
    },
    listBackups: async () => [],
    cleanOldBackups: async () => {},
  } as unknown as BackupManager;
}

function createSandboxStub(passes: boolean): SandboxRunner {
  return {
    runInSandbox: async () => ({
      passed: passes,
      output: passes ? 'All tests passed' : 'Tests failed: assertion error',
    }),
  } as unknown as SandboxRunner;
}

const auditRecords: unknown[] = [];
function createAuditLoggerStub(): AuditLogger {
  return {
    logAttempt: (record: unknown) => {
      auditRecords.push(record);
    },
    getHistory: () => [],
    countRecentAttempts: () => 0,
    markReverted: () => {},
    getLatestApplied: () => null,
  } as unknown as AuditLogger;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'patcher-test-'));
  const srcDir = join(dir, 'src');
  mkdirSync(srcDir);
  tempDirs.push(dir);
  return srcDir;
}

function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbFileContent = fc.string({ minLength: 0, maxLength: 500 });
const arbReasoning = fc.string({ minLength: 0, maxLength: 200 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 13 — CodePatcher: sandbox-before-apply invariants', () => {
  afterEach(cleanupTempDirs);

  /**
   * P13-a: When sandbox fails, the result status is always 'rejected'.
   * Validates: Requirement 9.3, 9.4
   */
  it('P13-a: failing sandbox always produces rejected result', async () => {
    await fc.assert(
      fc.asyncProperty(arbFileContent, arbFileContent, arbReasoning, async (original, proposed, reasoning) => {
        const dir = makeTempDir();
        const filePath = join(dir, 'module.ts');
        writeFileSync(filePath, original);

        const patcher = new CodePatcher(
          createBackupManagerStub(dir),
          createSandboxStub(false),
          createAuditLoggerStub(),
          dir
        );

        const result = await patcher.applyModification({
          filePath,
          originalContent: original,
          proposedContent: proposed,
          llmReasoning: reasoning,
          triggeredBy: 'test',
        });

        return result.status === 'rejected' && result.success === false;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * P13-b: When sandbox passes, the result status is always 'applied'.
   * Validates: Requirement 9.3, 9.4
   */
  it('P13-b: passing sandbox always produces applied result', async () => {
    await fc.assert(
      fc.asyncProperty(arbFileContent, arbFileContent, arbReasoning, async (original, proposed, reasoning) => {
        const dir = makeTempDir();
        const filePath = join(dir, 'module.ts');
        writeFileSync(filePath, original);

        const patcher = new CodePatcher(
          createBackupManagerStub(dir),
          createSandboxStub(true),
          createAuditLoggerStub(),
          dir
        );

        const result = await patcher.applyModification({
          filePath,
          originalContent: original,
          proposedContent: proposed,
          llmReasoning: reasoning,
          triggeredBy: 'test',
        });

        return result.status === 'applied' && result.success === true;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * P13-c: A backupPath is always present in the result (backup was created).
   * Validates: Requirement 9.2 (backup before sandbox)
   */
  it('P13-c: backupPath is always present in the result', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFileContent,
        arbFileContent,
        fc.boolean(),
        async (original, proposed, sandboxPasses) => {
          const dir = makeTempDir();
          const filePath = join(dir, 'module.ts');
          writeFileSync(filePath, original);

          const patcher = new CodePatcher(
            createBackupManagerStub(dir),
            createSandboxStub(sandboxPasses),
            createAuditLoggerStub(),
            dir
          );

          const result = await patcher.applyModification({
            filePath,
            originalContent: original,
            proposedContent: proposed,
            llmReasoning: 'test',
            triggeredBy: 'test',
          });

          return typeof result.backupPath === 'string' && result.backupPath.length > 0;
        }
      ),
      { numRuns: 30 }
    );
  });

  /**
   * P13-d: When sandbox fails, the original file is never modified.
   * Validates: Requirement 9.3
   */
  it('P13-d: failing sandbox never modifies the live file', async () => {
    await fc.assert(
      fc.asyncProperty(arbFileContent, arbFileContent, arbReasoning, async (original, proposed, reasoning) => {
        const dir = makeTempDir();
        const filePath = join(dir, 'module.ts');
        writeFileSync(filePath, original);

        const patcher = new CodePatcher(
          createBackupManagerStub(dir),
          createSandboxStub(false),
          createAuditLoggerStub(),
          dir
        );

        await patcher.applyModification({
          filePath,
          originalContent: original,
          proposedContent: proposed,
          llmReasoning: reasoning,
          triggeredBy: 'test',
        });

        const afterContent = readFileSync(filePath, 'utf8');
        return afterContent === original;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * P13-e: recordId is always a non-empty string (UUID format).
   * Validates: Requirement 9.5
   */
  it('P13-e: recordId is always a valid UUID string', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbFileContent,
        arbFileContent,
        fc.boolean(),
        async (original, proposed, sandboxPasses) => {
          const dir = makeTempDir();
          const filePath = join(dir, 'module.ts');
          writeFileSync(filePath, original);

          const patcher = new CodePatcher(
            createBackupManagerStub(dir),
            createSandboxStub(sandboxPasses),
            createAuditLoggerStub(),
            dir
          );

          const result = await patcher.applyModification({
            filePath,
            originalContent: original,
            proposedContent: proposed,
            llmReasoning: 'test',
            triggeredBy: 'test',
          });

          // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
          return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            result.recordId
          );
        }
      ),
      { numRuns: 30 }
    );
  });
});

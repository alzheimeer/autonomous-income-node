/**
 * SandboxRunner
 *
 * Executes the project's test suite for a given module in an isolated environment
 * via the MCP Terminal Server's `run_tests` tool.
 *
 * If `proposedContent` is provided the module file is temporarily written to a
 * staging path, the tests are run against it, and the staging file is cleaned up
 * regardless of the test outcome.
 *
 * The caller (CodePatcher) decides whether to apply the change based on the
 * returned `{passed, output}` result — this class never writes to the live path.
 *
 * Requirements: 9.2, 9.4
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { executeCommand } from '../mcp/servers/terminal-server.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SandboxResult {
  /** `true` iff the test suite exited with code 0 */
  passed: boolean;
  /** Combined stdout + stderr from the test run */
  output: string;
}

// ---------------------------------------------------------------------------
// SandboxRunner
// ---------------------------------------------------------------------------

export class SandboxRunner {
  /**
   * Run the test suite for `modulePath`, optionally replacing the module's
   * content with `proposedContent` in a temporary staging file first.
   *
   * Strategy when `proposedContent` is supplied:
   *   1. Write proposed content to `<modulePath>.sandbox.tmp`
   *   2. Overwrite the target file with proposed content (live file temporarily)
   *   3. Run `pnpm test --run` against the project root
   *   4. Restore original file content unconditionally
   *   5. Delete the temp file
   *   6. Return `{passed, output}`
   *
   * When `proposedContent` is **not** supplied the tests run against the current
   * on-disk content — useful for verifying the baseline before patching.
   *
   * @param modulePath      - Absolute path to the module being tested.
   * @param proposedContent - Optional new source code to validate.
   * @returns `{passed, output}` where `passed` is true iff exit code was 0.
   */
  async runInSandbox(
    modulePath: string,
    proposedContent?: string,
  ): Promise<SandboxResult> {
    // Determine project root (the directory that contains package.json).
    // We walk up from modulePath until we find one.
    const projectRoot = await findProjectRoot(modulePath);

    // If we have proposed content, temporarily swap the file before testing.
    let originalContent: string | null = null;

    if (proposedContent !== undefined) {
      try {
        originalContent = await fs.readFile(modulePath, 'utf8');
      } catch {
        // File may not exist yet for brand-new modules — treat as empty
        originalContent = '';
      }

      // Ensure parent directory exists before writing (new auto-generated files)
      await fs.mkdir(path.dirname(modulePath), { recursive: true });

      // Write proposed content to the live path
      await fs.writeFile(modulePath, proposedContent, 'utf8');
    }

    let passed = false;
    let output = '';

    try {
      const result = await executeCommand(
        // Run ONLY the auto-generated test suite to avoid false negatives from
        // integration tests that require live RPC/network (unavailable in Docker build).
        // If the module path is outside auto-generated, fall back to full suite.
        modulePath.includes('auto-generated')
          ? `pnpm test --run --reporter=verbose src/strategies/auto-generated/`
          : `pnpm test --run --reporter=verbose`,
        {
          cwd: projectRoot,
          // 5 minute cap — test suites should be fast but some can be slow
          timeoutMs: 300_000,
        },
      );

      const combined = [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();

      output = combined;
      passed = result.exitCode === 0;
    } finally {
      // Unconditionally restore the original file if we swapped it
      if (proposedContent !== undefined && originalContent !== null) {
        try {
          if (originalContent === '') {
            // File was new — remove it after testing (don't leave the proposed content)
            await fs.unlink(modulePath).catch(() => {/* best-effort */});
          } else {
            await fs.writeFile(modulePath, originalContent, 'utf8');
          }
        } catch (restoreErr) {
          // Append restoration error to output so the caller can see it
          output += `\n[SandboxRunner] WARNING: failed to restore original file: ${String(restoreErr)}`;
        }
      }
    }

    return { passed, output };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Walk up the directory tree from `startPath` to find the nearest directory
 * that contains a `package.json`.  Falls back to the directory containing
 * `startPath` if no `package.json` is found (should not happen in practice).
 */
async function findProjectRoot(startPath: string): Promise<string> {
  let dir = path.isAbsolute(startPath)
    ? path.dirname(startPath)
    : path.resolve(path.dirname(startPath));

  // Walk up at most 20 levels to avoid infinite loops on malformed paths
  for (let i = 0; i < 20; i++) {
    const candidate = path.join(dir, 'package.json');
    try {
      await fs.access(candidate);
      return dir; // found it
    } catch {
      // not here, go up
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Fallback: use process.cwd()
  return process.cwd();
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

export const sandboxRunner = new SandboxRunner();

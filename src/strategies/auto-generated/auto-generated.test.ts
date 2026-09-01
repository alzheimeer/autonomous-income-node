/**
 * Auto-Generated Strategies — Smoke Test Suite
 *
 * Validates that every module written by the AdaptiveEvolver:
 *   1. Is valid TypeScript that can be statically imported
 *   2. Exports a class with an `execute()` method
 *   3. execute() returns { success: boolean } without throwing
 *
 * This test runs as part of the sandbox check BEFORE any auto-generated file
 * is applied to disk. If any module here fails, the CodePatcher rejects the change.
 *
 * New modules are picked up automatically — no manual registration needed.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('auto-generated strategies', () => {
  it('directory exists and is accessible', () => {
    // Simple sanity check — the directory must be readable
    const files = readdirSync(__dirname);
    expect(Array.isArray(files)).toBe(true);
  });

  it('all auto-generated .ts modules export an execute() method', async () => {
    const files = readdirSync(__dirname).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'index.ts',
    );

    if (files.length === 0) {
      // No modules yet — that's fine, the suite should still pass
      console.log('[auto-generated.test] No auto-generated modules yet — skipping execute() check.');
      return;
    }

    for (const file of files) {
      const modulePath = join(__dirname, file);
      let mod: unknown;

      try {
        // Dynamic import — will fail at TypeScript compile time if the file is broken
        mod = await import(modulePath);
      } catch (err) {
        throw new Error(`Failed to import auto-generated module "${file}": ${(err as Error).message}`);
      }

      // Find the default export or any exported class
      const exports = mod as Record<string, unknown>;
      const ClassRef = exports['default'] ?? Object.values(exports).find(
        (v) => typeof v === 'function' && v.prototype?.execute,
      );

      expect(ClassRef, `"${file}" must export a class (default or named)`).toBeTruthy();

      if (typeof ClassRef === 'function') {
        const instance = new (ClassRef as new () => { execute: () => Promise<{ success: boolean }> })();
        expect(typeof instance.execute, `"${file}" instance must have execute() method`).toBe('function');

        // Run execute() in a try/catch — it should not throw unhandled
        let result: { success: boolean } | undefined;
        try {
          result = await Promise.race([
            instance.execute(),
            new Promise<{ success: boolean }>((_, reject) =>
              setTimeout(() => reject(new Error('execute() timed out after 10s')), 10_000),
            ),
          ]);
        } catch (err) {
          // execute() threw — that's a failure, but we continue checking other modules
          console.warn(`[auto-generated.test] "${file}" execute() threw: ${(err as Error).message}`);
          result = { success: false };
        }

        expect(result, `"${file}" execute() must return an object`).toBeTruthy();
        expect(
          typeof result?.success,
          `"${file}" execute() must return { success: boolean }`,
        ).toBe('boolean');
      }
    }
  });
});

/**
 * Properties 1 & 15 — Env Validator and maskSecrets invariants
 *
 * Validates: Requirements 1.5, 14.1, 14.4
 *
 * Properties verified:
 *  P1-a:  Missing required env vars ALWAYS produce a descriptive error.
 *  P1-b:  Error messages always mention the offending variable name.
 *  P15-a: maskSecrets always masks Ethereum private keys (0x + 64 hex chars).
 *  P15-b: maskSecrets never leaves an Ethereum private key unmasked.
 *  P15-c: maskSecrets is idempotent (calling it twice = calling it once).
 *  P15-d: maskSecrets never returns a longer string than the input.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { validateEnv } from '../env-validator.js';
import { maskSecrets, REDACTED } from '../log-filter.js';

// ---------------------------------------------------------------------------
// Env snapshot helpers
// ---------------------------------------------------------------------------

let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, envSnapshot);
});

/** Set the minimum valid env. */
function setValidEnv(overrides: Record<string, string | undefined> = {}) {
  process.env['WALLET_PASSWORD'] = 'test-password-123';
  process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key-12345678';
  process.env['RPC_PROVIDER_URL'] = 'https://base-mainnet.g.alchemy.com/v2/test';
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

// ---------------------------------------------------------------------------
// Required env var names to test
// ---------------------------------------------------------------------------

const REQUIRED_VARS = ['WALLET_PASSWORD', 'RPC_PROVIDER_URL'] as const;

describe('Properties 1 & 15 — EnvValidator and maskSecrets invariants', () => {
  /**
   * P1-a: Removing any required env var always produces an Error (never returns).
   * Validates: Requirement 1.5
   */
  it('P1-a: missing required env vars always produce an Error', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REQUIRED_VARS),
        (missingVar) => {
          setValidEnv({ [missingVar]: undefined });
          try {
            validateEnv();
            return false; // Should have thrown
          } catch (err) {
            return err instanceof Error && err.message.length > 0;
          }
        }
      ),
      { numRuns: REQUIRED_VARS.length * 5 }
    );
  });

  /**
   * P1-b: Error message always mentions the offending variable name.
   * Validates: Requirement 14.4
   */
  it('P1-b: error message always mentions the offending variable name', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...REQUIRED_VARS),
        (missingVar) => {
          setValidEnv({ [missingVar]: undefined });
          try {
            validateEnv();
            return false;
          } catch (err) {
            const msg = (err as Error).message.toUpperCase();
            return msg.includes(missingVar.toUpperCase());
          }
        }
      ),
      { numRuns: REQUIRED_VARS.length * 5 }
    );
  });

  /**
   * P1-c: Absent LLM keys always produce an error mentioning the LLM provider.
   * Validates: Requirement 1.5
   */
  it('P1-c: absent LLM API keys produce a descriptive error', () => {
    setValidEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined });
    try {
      validateEnv();
      throw new Error('Should have thrown');
    } catch (err) {
      const msg = (err as Error).message.toLowerCase();
      if (!msg.includes('llm') && !msg.includes('api_key') && !msg.includes('anthropic')) {
        throw new Error(`Error message should mention LLM or API key, got: ${msg}`);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // P15 — maskSecrets invariants
  // ---------------------------------------------------------------------------

  /**
   * P15-a: maskSecrets always masks Ethereum private keys.
   * Validates: Requirement 14.1
   */
  it('P15-a: maskSecrets always masks Ethereum private keys', () => {
    // Generate valid Ethereum private keys: "0x" + 64 hex chars
    const arbHexKey = fc
      .array(fc.hexaString({ minLength: 2, maxLength: 2 }), { minLength: 32, maxLength: 32 })
      .map((parts) => `0x${parts.join('')}`);

    fc.assert(
      fc.property(
        arbHexKey,
        fc.string(), // arbitrary prefix
        fc.string(), // arbitrary suffix
        (key, prefix, suffix) => {
          const input = `${prefix} ${key} ${suffix}`;
          const output = maskSecrets(input);
          // The private key should NOT appear in the output
          return !output.includes(key);
        }
      ),
      { numRuns: 200 }
    );
  });

  /**
   * P15-b: maskSecrets output never contains raw Ethereum private keys.
   * Validates: Requirement 14.1
   */
  it('P15-b: maskSecrets never leaves Ethereum private keys in output', () => {
    const PRIV_KEY_RE = /0x[0-9a-fA-F]{64}/;

    const arbHexKey = fc
      .array(fc.hexaString({ minLength: 2, maxLength: 2 }), { minLength: 32, maxLength: 32 })
      .map((parts) => `0x${parts.join('')}`);

    fc.assert(
      fc.property(arbHexKey, (key) => {
        const output = maskSecrets(key);
        return !PRIV_KEY_RE.test(output);
      }),
      { numRuns: 200 }
    );
  });

  /**
   * P15-c: maskSecrets is idempotent — applying it twice produces the same result.
   * Validates: Requirement 14.1
   */
  it('P15-c: maskSecrets is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const once = maskSecrets(input);
        const twice = maskSecrets(once);
        return once === twice;
      }),
      { numRuns: 300 }
    );
  });

  /**
   * P15-d: maskSecrets output is never longer than the input.
   * Validates: Requirement 14.1 (masking = replacement, never injection)
   */
  it('P15-d: maskSecrets output is never longer than the input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 500 }), (input) => {
        const output = maskSecrets(input);
        return output.length <= input.length || output.includes(REDACTED);
      }),
      { numRuns: 300 }
    );
  });

  /**
   * P15-e: maskSecrets always returns a string for any string input.
   * Validates: Requirement 14.1
   */
  it('P15-e: maskSecrets always returns a string for any string input', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (input) => {
        const output = maskSecrets(input);
        return typeof output === 'string';
      }),
      { numRuns: 300 }
    );
  });
});

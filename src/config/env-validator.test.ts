/**
 * Unit tests for src/config/env-validator.ts
 *
 * Validates:
 *  - Required variables are enforced (WALLET_PASSWORD, RPC_PROVIDER_URL)
 *  - At least one LLM key must be present
 *  - Defaults are applied for optional variables
 *  - Error messages are descriptive and list each offending variable
 *
 * Requirements: 1.5, 14.4
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { validateEnv } from './env-validator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Snapshot the current process.env and restore it after each test. */
let envSnapshot: NodeJS.ProcessEnv;

beforeEach(() => {
  envSnapshot = { ...process.env };
});

afterEach(() => {
  // Remove all keys added during test, then restore snapshot
  for (const key of Object.keys(process.env)) {
    if (!(key in envSnapshot)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, envSnapshot);
});

/** Populate the minimum valid env for testing. */
function setValidEnv(overrides: Record<string, string | undefined> = {}) {
  process.env['WALLET_PASSWORD'] = 'super-secret-password';
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
// Tests
// ---------------------------------------------------------------------------

describe('validateEnv', () => {
  describe('required variables', () => {
    it('passes when all required variables are present', () => {
      setValidEnv();
      expect(() => validateEnv()).not.toThrow();
    });

    it('throws when WALLET_PASSWORD is missing', () => {
      setValidEnv({ WALLET_PASSWORD: undefined });
      expect(() => validateEnv()).toThrow(/WALLET_PASSWORD/i);
    });

    it('throws when WALLET_PASSWORD is empty string', () => {
      setValidEnv({ WALLET_PASSWORD: '' });
      expect(() => validateEnv()).toThrow(/WALLET_PASSWORD/i);
    });

    it('throws when RPC_PROVIDER_URL is missing', () => {
      setValidEnv({ RPC_PROVIDER_URL: undefined });
      expect(() => validateEnv()).toThrow(/RPC_PROVIDER_URL/i);
    });

    it('throws when RPC_PROVIDER_URL is not a valid URL', () => {
      setValidEnv({ RPC_PROVIDER_URL: 'not-a-url' });
      expect(() => validateEnv()).toThrow(/RPC_PROVIDER_URL/i);
    });

    it('throws when neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set', () => {
      setValidEnv({
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      });
      expect(() => validateEnv()).toThrow(/OPENAI_API_KEY/i);
    });

    it('does not throw when only OPENAI_API_KEY is set (no Anthropic)', () => {
      setValidEnv({
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: 'sk-openai-test-key-12345678',
      });
      expect(() => validateEnv()).not.toThrow();
    });

    it('does not throw when only ANTHROPIC_API_KEY is set', () => {
      setValidEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-key-12345678', OPENAI_API_KEY: undefined, LLM_PROVIDER: 'anthropic' });
      expect(() => validateEnv()).not.toThrow();
    });
  });

  describe('returned values', () => {
    it('returns WALLET_PASSWORD as provided', () => {
      setValidEnv({ WALLET_PASSWORD: 'my-wallet-pass' });
      const env = validateEnv();
      expect(env.WALLET_PASSWORD).toBe('my-wallet-pass');
    });

    it('returns RPC_PROVIDER_URL as provided', () => {
      setValidEnv({ RPC_PROVIDER_URL: 'https://rpc.example.com/v2/abc' });
      const env = validateEnv();
      expect(env.RPC_PROVIDER_URL).toBe('https://rpc.example.com/v2/abc');
    });

    it('applies default NODE_ENV = development when not set', () => {
      setValidEnv();
      delete process.env['NODE_ENV'];
      const env = validateEnv();
      expect(env.NODE_ENV).toBe('development');
    });

    it('applies default API_PORT = 3000 when not set', () => {
      setValidEnv();
      delete process.env['API_PORT'];
      const env = validateEnv();
      expect(env.API_PORT).toBe(3000);
    });

    it('applies default DB_PATH when not set', () => {
      setValidEnv();
      delete process.env['DB_PATH'];
      const env = validateEnv();
      expect(env.DB_PATH).toBe('./data/agent.db');
    });

    it('applies default KEYS_PATH when not set', () => {
      setValidEnv();
      delete process.env['KEYS_PATH'];
      const env = validateEnv();
      expect(env.KEYS_PATH).toBe('./keys');
    });
  });

  describe('error message quality', () => {
    it('error message mentions .env.example', () => {
      setValidEnv({ WALLET_PASSWORD: undefined });
      try {
        validateEnv();
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        expect((err as Error).message).toMatch(/\.env\.example/i);
      }
    });

    it('error message lists each offending variable', () => {
      setValidEnv({
        WALLET_PASSWORD: undefined,
        RPC_PROVIDER_URL: undefined,
        ANTHROPIC_API_KEY: undefined,
        OPENAI_API_KEY: undefined,
      });
      try {
        validateEnv();
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const msg = (err as Error).message;
        expect(msg).toMatch(/WALLET_PASSWORD/i);
        expect(msg).toMatch(/RPC_PROVIDER_URL/i);
      }
    });

    it('error includes a bullet list of issues', () => {
      setValidEnv({ WALLET_PASSWORD: undefined });
      try {
        validateEnv();
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        // The error format uses '  •' bullet points
        expect((err as Error).message).toMatch(/•/);
      }
    });
  });

  describe('NODE_ENV validation', () => {
    it('accepts production as NODE_ENV', () => {
      setValidEnv({ NODE_ENV: 'production' });
      const env = validateEnv();
      expect(env.NODE_ENV).toBe('production');
    });

    it('accepts test as NODE_ENV', () => {
      setValidEnv({ NODE_ENV: 'test' });
      const env = validateEnv();
      expect(env.NODE_ENV).toBe('test');
    });

    it('throws for an unsupported NODE_ENV value', () => {
      setValidEnv({ NODE_ENV: 'staging' });
      expect(() => validateEnv()).toThrow(/NODE_ENV/i);
    });
  });
});

/**
 * Unit tests for src/config/log-filter.ts
 *
 * Validates:
 *  - Ethereum private keys are redacted
 *  - High-entropy API key tokens are redacted
 *  - BIP-39 mnemonics (12 and 24 words) are redacted
 *  - Named key=value patterns are redacted
 *  - Normal log messages are left unchanged
 *  - shannonEntropy correctness
 *  - safeStringify masks objects
 *  - secretFingerprint is consistent and short
 *
 * Requirements: 14.1
 */

import { describe, it, expect } from 'vitest';
import {
  maskSecrets,
  shannonEntropy,
  safeStringify,
  secretFingerprint,
  REDACTED,
} from './log-filter.js';

// ---------------------------------------------------------------------------
// Shannon entropy
// ---------------------------------------------------------------------------

describe('shannonEntropy', () => {
  it('returns 0 for empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('returns 0 for a single repeated character', () => {
    expect(shannonEntropy('aaaaaaaaaa')).toBe(0);
  });

  it('returns a positive value for a diverse string', () => {
    expect(shannonEntropy('abcdefghij')).toBeGreaterThan(0);
  });

  it('returns higher entropy for random-looking strings', () => {
    const natural = 'the quick brown fox';
    const random = 'Xk9!mZ4@qW2#nL7$pR1%';
    expect(shannonEntropy(random)).toBeGreaterThan(shannonEntropy(natural));
  });
});

// ---------------------------------------------------------------------------
// Ethereum private keys
// ---------------------------------------------------------------------------

describe('maskSecrets — Ethereum private keys', () => {
  it('redacts a standalone private key', () => {
    const key = '0x' + 'a1b2c3d4'.repeat(8); // 64 hex chars
    const log = `Signing with key=${key}`;
    expect(maskSecrets(log)).not.toContain(key);
    expect(maskSecrets(log)).toContain(REDACTED);
  });

  it('redacts uppercase hex private key', () => {
    const key = '0x' + 'DEADBEEF'.repeat(8);
    expect(maskSecrets(key)).not.toContain(key);
  });

  it('does NOT redact a short 0x hex string (< 64 hex chars)', () => {
    const shortHex = '0xdeadbeef'; // only 8 hex chars
    const log = `tx hash: ${shortHex}`;
    const result = maskSecrets(log);
    expect(result).toContain(shortHex);
  });

  it('does NOT redact a wallet address (40 hex chars after 0x)', () => {
    const address = '0x' + 'a'.repeat(40);
    const log = `wallet address: ${address}`;
    const result = maskSecrets(log);
    expect(result).toContain(address);
  });
});

// ---------------------------------------------------------------------------
// BIP-39 mnemonics
// ---------------------------------------------------------------------------

describe('maskSecrets — BIP-39 mnemonics', () => {
  it('redacts a 12-word mnemonic', () => {
    const mnemonic = 'abandon ability able about above absent absorb abstract absurd abuse access accident';
    const log = `mnemonic: ${mnemonic}`;
    expect(maskSecrets(log)).not.toContain(mnemonic);
  });

  it('redacts a 24-word mnemonic', () => {
    const mnemonic =
      'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
      'account accuse achieve acid acoustic acquire across act action actor actress actual';
    const log = `seed phrase: ${mnemonic}`;
    expect(maskSecrets(log)).not.toContain(mnemonic);
  });

  it('does NOT redact a 6-word phrase (too short for BIP-39)', () => {
    const phrase = 'hello world foo bar baz qux';
    const log = `description: ${phrase}`;
    // 6 words should NOT be matched as a BIP-39 mnemonic
    const result = maskSecrets(log);
    expect(result).toContain(phrase);
  });
});

// ---------------------------------------------------------------------------
// Named key=value patterns
// ---------------------------------------------------------------------------

describe('maskSecrets — named patterns', () => {
  it('redacts password= pattern', () => {
    const log = 'Connecting with password=MySecretPass123';
    const result = maskSecrets(log);
    expect(result).not.toContain('MySecretPass123');
    expect(result).toContain(REDACTED);
  });

  it('redacts api_key: pattern', () => {
    const log = 'Using api_key: sk-ant-very-long-secret-key-12345';
    const result = maskSecrets(log);
    expect(result).not.toContain('sk-ant-very-long-secret-key-12345');
  });

  it('redacts private_key= pattern', () => {
    const log = 'private_key=0xsomethinglong1234567890';
    const result = maskSecrets(log);
    expect(result).not.toContain('0xsomethinglong1234567890');
  });

  it('redacts bearer token pattern', () => {
    const log = 'Authorization: bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload';
    const result = maskSecrets(log);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9');
  });
});

// ---------------------------------------------------------------------------
// Normal log messages should pass through unchanged
// ---------------------------------------------------------------------------

describe('maskSecrets — safe messages', () => {
  it('does not alter a plain info log', () => {
    const log = 'Agent started on port 3000';
    expect(maskSecrets(log)).toBe(log);
  });

  it('does not alter a numeric value', () => {
    const log = 'Balance: 1234567 USDC';
    expect(maskSecrets(log)).toBe(log);
  });

  it('does not alter a short URL', () => {
    const log = 'Connected to https://rpc.example.com';
    expect(maskSecrets(log)).toBe(log);
  });

  it('handles empty string', () => {
    expect(maskSecrets('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// safeStringify
// ---------------------------------------------------------------------------

describe('safeStringify', () => {
  it('masks secrets in a JSON object', () => {
    // Use key name containing "password" so the named pattern triggers
    const obj = {
      wallet_password: 'super-secret-password',
      address: '0x1234',
    };
    const result = safeStringify(obj);
    expect(result).not.toContain('super-secret-password');
  });

  it('passes through non-sensitive objects without error', () => {
    const obj = { tier: 3, balance: '1000.00', module: 'trading' };
    const result = safeStringify(obj);
    expect(result).toContain('tier');
    expect(result).toContain('3');
  });

  it('handles non-serialisable values gracefully', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    // Should not throw
    expect(() => safeStringify(circular)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// secretFingerprint
// ---------------------------------------------------------------------------

describe('secretFingerprint', () => {
  it('returns an 8-character hex string', () => {
    const fp = secretFingerprint('my-secret-key');
    expect(fp).toHaveLength(8);
    expect(fp).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', () => {
    const fp1 = secretFingerprint('same');
    const fp2 = secretFingerprint('same');
    expect(fp1).toBe(fp2);
  });

  it('differs for different inputs', () => {
    expect(secretFingerprint('key-a')).not.toBe(secretFingerprint('key-b'));
  });
});

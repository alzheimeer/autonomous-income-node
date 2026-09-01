/**
 * Property 18 — ConfigStore: encrypted keystore never contains plaintext private key
 *
 * Validates: Requirements 14.1, 14.2, 14.3
 *
 * Properties verified:
 *  P18-a: encryptKeystore output never contains the plaintext private key.
 *  P18-b: encryptKeystore output is not the same string as the input.
 *  P18-c: decryptKeystore(encryptKeystore(data, pwd), pwd) === data (round-trip).
 *  P18-d: decryptKeystore with wrong password always throws.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ConfigStore } from '../config-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate valid Ethereum-like private keys: 0x + 64 hex chars */
const arbPrivateKey = fc
  .array(fc.hexaString({ minLength: 2, maxLength: 2 }), { minLength: 32, maxLength: 32 })
  .map((parts) => `0x${parts.join('')}`);

/** Generate a password string */
const arbPassword = fc.string({ minLength: 8, maxLength: 64 }).filter((s) => s.trim().length > 0);

/** Generate plaintext that looks like a keystore envelope with a private key */
const arbKeystoreEnvelope = fc
  .record({
    address: fc.hexaString({ minLength: 40, maxLength: 40 }).map((h) => `0x${h}`),
    publicKey: fc.hexaString({ minLength: 66, maxLength: 66 }).map((h) => `0x${h}`),
    privateKeyHex: fc
      .array(fc.hexaString({ minLength: 2, maxLength: 2 }), { minLength: 32, maxLength: 32 })
      .map((parts) => parts.join('')),
    mnemonic: fc.constant('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
    derivationPath: fc.constant("m/44'/60'/0'/0/0"),
    createdAt: fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }),
  })
  .map((envelope) => JSON.stringify(envelope));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 18 — ConfigStore: keystore encryption invariants', () => {
  const store = new ConfigStore();

  /**
   * P18-a: Encrypted output never contains the raw private key.
   * Validates: Requirement 14.1
   */
  it('P18-a: encrypted output never contains the plaintext private key', () => {
    fc.assert(
      fc.property(arbPrivateKey, arbPassword, (privateKey, password) => {
        const plaintext = JSON.stringify({ privateKeyHex: privateKey.replace(/^0x/, '') });
        const encrypted = store.encryptKeystore(plaintext, password);
        // The raw private key (with or without 0x prefix) must not appear in base64 blob
        return (
          !encrypted.includes(privateKey) &&
          !encrypted.includes(privateKey.replace(/^0x/, ''))
        );
      }),
      { numRuns: 50 }
    );
  });

  /**
   * P18-b: Encrypted output is always different from the input plaintext.
   * Validates: Requirement 14.2
   */
  it('P18-b: encrypted output is never identical to the plaintext input', () => {
    fc.assert(
      fc.property(arbKeystoreEnvelope, arbPassword, (plaintext, password) => {
        const encrypted = store.encryptKeystore(plaintext, password);
        return encrypted !== plaintext;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * P18-c: decrypt(encrypt(data, pwd), pwd) === data — round-trip property.
   * Validates: Requirement 14.3
   */
  it('P18-c: encrypt/decrypt round-trip always recovers the original plaintext', () => {
    fc.assert(
      fc.property(arbKeystoreEnvelope, arbPassword, (plaintext, password) => {
        const encrypted = store.encryptKeystore(plaintext, password);
        const decrypted = store.decryptKeystore(encrypted, password);
        return decrypted === plaintext;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * P18-d: Decrypting with the wrong password always throws.
   * Validates: Requirement 14.2
   */
  it('P18-d: decrypting with wrong password always throws', () => {
    fc.assert(
      fc.property(
        arbKeystoreEnvelope,
        arbPassword,
        arbPassword,
        (plaintext, correctPwd, wrongPwd) => {
          fc.pre(correctPwd !== wrongPwd);
          const encrypted = store.encryptKeystore(plaintext, correctPwd);
          try {
            store.decryptKeystore(encrypted, wrongPwd);
            return false; // Should have thrown
          } catch {
            return true;
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P18-e: Two encryptions of the same data with the same password produce
   * different ciphertexts (IVs are random).
   * Validates: Requirement 14.2 (semantic security)
   */
  it('P18-e: two encryptions of the same data always produce different ciphertexts', () => {
    fc.assert(
      fc.property(arbKeystoreEnvelope, arbPassword, (plaintext, password) => {
        const enc1 = store.encryptKeystore(plaintext, password);
        const enc2 = store.encryptKeystore(plaintext, password);
        return enc1 !== enc2; // Different IVs → different ciphertexts
      }),
      { numRuns: 50 }
    );
  });
});

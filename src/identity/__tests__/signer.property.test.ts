/**
 * Property 3 — Signer: sign + verify round-trip
 *
 * Validates: Requirements 3.7, 14.1
 *
 * Properties verified:
 *  P3-a: sign(msg) → verifyOwn(msg, sig) is always true (round-trip).
 *  P3-b: verifyOwn with a different message is always false.
 *  P3-c: recoverAddress always returns the wallet's address for valid signatures.
 *  P3-d: sign never exposes the private key in the returned signature string.
 */

import { describe, it, beforeAll } from 'vitest';
import * as fc from 'fast-check';
import { Wallet } from 'ethers';
import { SignerImpl } from '../signer.js';
import type { WalletManager } from '../wallet-manager.js';

// ---------------------------------------------------------------------------
// Minimal WalletManager stub (no disk I/O, no SQLite)
// ---------------------------------------------------------------------------

function createStubWalletManager(wallet: Wallet): WalletManager {
  return {
    initializeWallet: async () => ({
      address: wallet.address,
      publicKey: wallet.signingKey.publicKey,
      keystorePath: '/dev/null',
      createdAt: Date.now(),
    }),
    loadWallet: async () => ({
      address: wallet.address,
      publicKey: wallet.signingKey.publicKey,
      keystorePath: '/dev/null',
      createdAt: Date.now(),
    }),
    signMessage: (msg: string) => wallet.signMessage(msg),
    getAddress: () => wallet.address,
  };
}

// ---------------------------------------------------------------------------
// Fixed test wallet (deterministic private key for property tests)
// ---------------------------------------------------------------------------

const TEST_WALLET = Wallet.createRandom();
let signer: SignerImpl;

beforeAll(() => {
  signer = new SignerImpl(createStubWalletManager(TEST_WALLET));
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** Arbitrary printable ASCII string messages */
const arbMessage = fc.string({ minLength: 0, maxLength: 500 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 3 — Signer: sign/verify round-trip invariants', () => {
  /**
   * P3-a: sign(msg) then verifyOwn(msg, sig) always returns true.
   * Validates: Requirement 3.7
   */
  it('P3-a: sign + verifyOwn is a perfect round-trip for any message', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessage, async (message) => {
        const signature = await signer.sign(message);
        return signer.verifyOwn(message, signature);
      }),
      { numRuns: 50 }
    );
  });

  /**
   * P3-b: verifyOwn with a tampered message always returns false.
   * Validates: Requirement 3.7
   */
  it('P3-b: verifyOwn with a different message always returns false', async () => {
    await fc.assert(
      fc.asyncProperty(
        arbMessage,
        arbMessage,
        async (original, tampered) => {
          fc.pre(original !== tampered);
          const signature = await signer.sign(original);
          return !signer.verifyOwn(tampered, signature);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P3-c: recoverAddress always returns the wallet's own address for valid sigs.
   * Validates: Requirement 3.7
   */
  it('P3-c: recoverAddress always returns the wallet address for its own signatures', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessage, async (message) => {
        const signature = await signer.sign(message);
        const recovered = signer.recoverAddress(message, signature);
        return recovered.toLowerCase() === TEST_WALLET.address.toLowerCase();
      }),
      { numRuns: 50 }
    );
  });

  /**
   * P3-d: The signature never contains the wallet's private key.
   * Validates: Requirement 14.1
   */
  it('P3-d: signatures never contain the private key', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessage, async (message) => {
        const signature = await signer.sign(message);
        const privKeyHex = TEST_WALLET.privateKey.replace(/^0x/i, '').toLowerCase();
        return !signature.toLowerCase().includes(privKeyHex);
      }),
      { numRuns: 50 }
    );
  });

  /**
   * P3-e: sign always produces a 0x-prefixed 65-byte (130 hex char) string.
   * Validates: Requirement 3.7
   */
  it('P3-e: sign always returns a 0x-prefixed 65-byte hex signature', async () => {
    await fc.assert(
      fc.asyncProperty(arbMessage, async (message) => {
        const signature = await signer.sign(message);
        // 0x + 130 hex chars = 132 chars total
        return /^0x[0-9a-fA-F]{130}$/.test(signature);
      }),
      { numRuns: 50 }
    );
  });
});

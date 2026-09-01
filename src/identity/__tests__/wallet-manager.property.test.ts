/**
 * Property 2 — WalletManager: canonical identity invariant
 *
 * Validates: Requirements 1.1, 1.6, 3.1, 14.1
 *
 * Properties verified:
 *  P2-a: initializeWallet returns an address that starts with 0x.
 *  P2-b: The same keystore path always returns the same address (idempotency).
 *  P2-c: getAddress() after init always matches the returned WalletInfo.address.
 *  P2-d: Private key is never present in WalletInfo fields (no leakage).
 *  P2-e: initializeWallet with two different passwords on separate keystores
 *        produces two different addresses (key derivation uses entropy).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WalletManagerImpl } from '../wallet-manager.js';

// ---------------------------------------------------------------------------
// Minimal in-memory IdentityPersistence stub
// ---------------------------------------------------------------------------

function createInMemoryPersistence() {
  const store = new Map<string, { walletAddress: string }>();
  let nextId = 1;
  return {
    findByAddress: (addr: string) => store.get(addr.toLowerCase()) ?? null,
    create: (input: { walletAddress: string; publicKey: string; createdAt: number }) => {
      store.set(input.walletAddress.toLowerCase(), { walletAddress: input.walletAddress });
      return nextId++;
    },
  };
}

// ---------------------------------------------------------------------------
// Helper to create a temp dir cleaned up after each test
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wallet-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbPassword = fc
  .string({ minLength: 12, maxLength: 64 })
  .filter((s) => s.trim().length >= 8);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 2 — WalletManager: canonical identity invariants', () => {
  /**
   * P2-a: initializeWallet always returns an address starting with 0x.
   * Validates: Requirement 3.1
   */
  it('P2-a: initializeWallet always returns a 0x-prefixed Ethereum address', async () => {
    await fc.assert(
      fc.asyncProperty(arbPassword, async (password) => {
        const dir = makeTempDir();
        const persistence = createInMemoryPersistence();
        const manager = new WalletManagerImpl(
          persistence,
          join(dir, 'keystore.json')
        );
        const info = await manager.initializeWallet(password);
        return /^0x[0-9a-fA-F]{40}$/.test(info.address);
      }),
      { numRuns: 5 }
    );
  });

  /**
   * P2-b: Calling initializeWallet twice on the same path returns the same address.
   * Validates: Requirement 1.1 (idempotency / canonical identity)
   */
  it('P2-b: initializeWallet on an existing keystore always returns the same address', async () => {
    await fc.assert(
      fc.asyncProperty(arbPassword, async (password) => {
        const dir = makeTempDir();
        const persistence = createInMemoryPersistence();
        const manager = new WalletManagerImpl(
          persistence,
          join(dir, 'keystore.json')
        );
        const first = await manager.initializeWallet(password);
        const second = await manager.initializeWallet(password);
        return first.address === second.address;
      }),
      { numRuns: 5 }
    );
  });

  /**
   * P2-c: getAddress() after init always matches the returned WalletInfo.address.
   * Validates: Requirement 3.1
   */
  it('P2-c: getAddress() always returns the same address as initializeWallet', async () => {
    await fc.assert(
      fc.asyncProperty(arbPassword, async (password) => {
        const dir = makeTempDir();
        const persistence = createInMemoryPersistence();
        const manager = new WalletManagerImpl(
          persistence,
          join(dir, 'keystore.json')
        );
        const info = await manager.initializeWallet(password);
        return manager.getAddress() === info.address;
      }),
      { numRuns: 5 }
    );
  });

  /**
   * P2-d: WalletInfo fields never contain the private key or mnemonic in plaintext.
   * Validates: Requirement 14.1
   */
  it('P2-d: WalletInfo fields never expose private key or mnemonic', async () => {
    await fc.assert(
      fc.asyncProperty(arbPassword, async (password) => {
        const dir = makeTempDir();
        const persistence = createInMemoryPersistence();
        const manager = new WalletManagerImpl(
          persistence,
          join(dir, 'keystore.json')
        );
        const info = await manager.initializeWallet(password);
        // WalletInfo fields: address, publicKey, keystorePath, createdAt
        const serialised = JSON.stringify(info);
        // Private keys are 64 hex chars; mnemonics have spaces and BIP-39 words
        const hasPrivKey = /\b[0-9a-f]{64}\b/.test(serialised);
        // Check no bip39 mnemonic pattern: 12+ lowercase words separated by spaces
        const hasMnemonic = /\b([a-z]+ ){11,}[a-z]+\b/.test(serialised);
        return !hasPrivKey && !hasMnemonic;
      }),
      { numRuns: 5 }
    );
  });

  /**
   * P2-e: Two wallets created with different passwords have different addresses.
   * Validates: Requirement 1.6 (entropy-based key generation)
   */
  it('P2-e: two independently generated wallets always have different addresses', async () => {
    // Run this as a deterministic example test — full property over random passwords
    // is too slow; a few samples suffice to validate entropy randomness.
    const results: string[] = [];
    for (let i = 0; i < 5; i++) {
      const dir = makeTempDir();
      const persistence = createInMemoryPersistence();
      const manager = new WalletManagerImpl(
        persistence,
        join(dir, 'keystore.json')
      );
      const info = await manager.initializeWallet(`password-${i}-${Date.now()}`);
      results.push(info.address);
    }
    const unique = new Set(results);
    expect(unique.size).toBe(results.length);
  });
});

/**
 * Unit tests for WalletManagerImpl and SignerImpl.
 *
 * Uses a pure in-memory identity stub — no native SQLite binaries required.
 *
 * Tests cover:
 *  - New wallet generation (BIP-39, valid address, keystore written)
 *  - Keystore round-trip (encrypt → decrypt → same address)
 *  - loadWallet on existing keystore
 *  - Error on loadWallet without keystore / wrong password
 *  - signMessage / verifyOwn / recoverAddress
 *  - getAddress before init throws
 *  - Private key does NOT appear in WalletInfo fields
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { WalletManagerImpl, type IdentityPersistence } from './wallet-manager.js';
import { SignerImpl } from './signer.js';

// ---------------------------------------------------------------------------
// In-memory IdentityPersistence stub (no native SQLite required)
// ---------------------------------------------------------------------------

function makeInMemoryRepo(): IdentityPersistence {
  const store = new Map<string, { walletAddress: string }>();
  return {
    findByAddress(address: string) {
      return store.get(address) ?? null;
    },
    create(input) {
      store.set(input.walletAddress, { walletAddress: input.walletAddress });
      return store.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let testDir: string;
let repo: IdentityPersistence;
const PASSWORD = 'test-password-42!';

beforeEach(() => {
  testDir = join(tmpdir(), `ain-wallet-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(testDir, { recursive: true });
  repo = makeInMemoryRepo();
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// WalletManagerImpl — new wallet creation
// ---------------------------------------------------------------------------

describe('WalletManagerImpl — new wallet', () => {
  it('creates a keystore file on first initializeWallet call', async () => {
    const keystorePath = join(testDir, 'keystore.json');
    const manager = new WalletManagerImpl(repo, keystorePath);

    await manager.initializeWallet(PASSWORD);

    expect(existsSync(keystorePath)).toBe(true);
  });

  it('returns the keystore path in WalletInfo', async () => {
    const keystorePath = join(testDir, 'keystore.json');
    const manager = new WalletManagerImpl(repo, keystorePath);
    const info = await manager.initializeWallet(PASSWORD);
    expect(info.keystorePath).toBe(keystorePath);
  });

  it('returns a valid checksummed Ethereum address (0x + 40 hex)', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    const info = await manager.initializeWallet(PASSWORD);
    expect(info.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('returns a non-empty publicKey', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    const info = await manager.initializeWallet(PASSWORD);
    expect(info.publicKey.length).toBeGreaterThan(0);
  });

  it('sets createdAt to a recent Unix timestamp', async () => {
    const before = Date.now();
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    const info = await manager.initializeWallet(PASSWORD);
    const after = Date.now();

    expect(info.createdAt).toBeGreaterThanOrEqual(before);
    expect(info.createdAt).toBeLessThanOrEqual(after);
  });

  it('persists the identity record via the repository', async () => {
    let created = false;
    const trackingRepo: IdentityPersistence = {
      findByAddress: () => null,
      create: (input) => {
        created = true;
        return 1;
      },
    };
    const manager = new WalletManagerImpl(trackingRepo, join(testDir, 'keystore.json'));
    await manager.initializeWallet(PASSWORD);
    expect(created).toBe(true);
  });

  it('does NOT expose the private key in WalletInfo fields', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    const info = await manager.initializeWallet(PASSWORD);

    // WalletInfo must not have a privateKey field
    expect(Object.keys(info)).not.toContain('privateKey');
    expect(Object.keys(info)).not.toContain('mnemonic');
    expect(Object.keys(info)).not.toContain('privateKeyHex');

    // The serialized form should only contain the expected 4 fields
    const serialized = JSON.stringify(info);
    const parsed = JSON.parse(serialized);
    const allowedKeys = new Set(['address', 'publicKey', 'keystorePath', 'createdAt']);
    for (const key of Object.keys(parsed)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
  });

  it('second initializeWallet call on existing keystore is idempotent', async () => {
    const keystorePath = join(testDir, 'keystore.json');
    const manager1 = new WalletManagerImpl(repo, keystorePath);
    const info1 = await manager1.initializeWallet(PASSWORD);

    const manager2 = new WalletManagerImpl(makeInMemoryRepo(), keystorePath);
    const info2 = await manager2.initializeWallet(PASSWORD);

    expect(info2.address).toBe(info1.address);
    expect(info2.publicKey).toBe(info1.publicKey);
  });
});

// ---------------------------------------------------------------------------
// WalletManagerImpl — loadWallet
// ---------------------------------------------------------------------------

describe('WalletManagerImpl — loadWallet', () => {
  it('loads and returns the same address as created', async () => {
    const keystorePath = join(testDir, 'keystore.json');
    const creator = new WalletManagerImpl(repo, keystorePath);
    const createdInfo = await creator.initializeWallet(PASSWORD);

    const loader = new WalletManagerImpl(makeInMemoryRepo(), keystorePath);
    const loadedInfo = await loader.loadWallet(PASSWORD);

    expect(loadedInfo.address).toBe(createdInfo.address);
    expect(loadedInfo.publicKey).toBe(createdInfo.publicKey);
  });

  it('throws when keystore file does not exist', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'nonexistent.json'));
    await expect(manager.loadWallet(PASSWORD)).rejects.toThrow(/Keystore not found/);
  });

  it('throws on wrong password', async () => {
    const keystorePath = join(testDir, 'keystore.json');
    await new WalletManagerImpl(repo, keystorePath).initializeWallet(PASSWORD);

    const loader = new WalletManagerImpl(makeInMemoryRepo(), keystorePath);
    await expect(loader.loadWallet('wrong-password')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// WalletManagerImpl — signing guards
// ---------------------------------------------------------------------------

describe('WalletManagerImpl — signMessage', () => {
  it('produces a 65-byte EIP-191 signature (0x + 130 hex)', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    await manager.initializeWallet(PASSWORD);

    const sig = await manager.signMessage('hello world');
    expect(sig).toMatch(/^0x[0-9a-fA-F]{130}$/);
  });

  it('throws if no wallet is loaded', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    await expect(manager.signMessage('test')).rejects.toThrow(/No wallet loaded/);
  });

  it('getAddress throws before wallet is loaded', () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    expect(() => manager.getAddress()).toThrow(/No wallet loaded/);
  });

  it('getAddress returns the address after initializeWallet', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    const info = await manager.initializeWallet(PASSWORD);
    expect(manager.getAddress()).toBe(info.address);
  });
});

// ---------------------------------------------------------------------------
// SignerImpl
// ---------------------------------------------------------------------------

describe('SignerImpl', () => {
  it('sign() returns the same result as WalletManager.signMessage()', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    await manager.initializeWallet(PASSWORD);

    const signer = new SignerImpl(manager);
    const message = 'authenticate:12345';

    const sigFromManager = await manager.signMessage(message);
    const sigFromSigner = await signer.sign(message);

    expect(sigFromSigner).toBe(sigFromManager);
  });

  it('verifyOwn() returns true for a message signed by this wallet', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    await manager.initializeWallet(PASSWORD);

    const signer = new SignerImpl(manager);
    const message = 'verify-me';
    const signature = await signer.sign(message);

    expect(signer.verifyOwn(message, signature)).toBe(true);
  });

  it('verifyOwn() returns false for a signature from a different wallet', async () => {
    const manager1 = new WalletManagerImpl(repo, join(testDir, 'ks1.json'));
    await manager1.initializeWallet(PASSWORD);

    const manager2 = new WalletManagerImpl(makeInMemoryRepo(), join(testDir, 'ks2.json'));
    await manager2.initializeWallet(PASSWORD);

    const signer1 = new SignerImpl(manager1);
    const signer2 = new SignerImpl(manager2);

    const message = 'cross-wallet';
    const sig2 = await signer2.sign(message);

    expect(signer1.verifyOwn(message, sig2)).toBe(false);
  });

  it('recoverAddress() returns the checksummed address of the signer', async () => {
    const manager = new WalletManagerImpl(repo, join(testDir, 'keystore.json'));
    const info = await manager.initializeWallet(PASSWORD);

    const signer = new SignerImpl(manager);
    const message = 'recover-test';
    const signature = await signer.sign(message);

    const recovered = signer.recoverAddress(message, signature);
    expect(recovered.toLowerCase()).toBe(info.address.toLowerCase());
  });
});

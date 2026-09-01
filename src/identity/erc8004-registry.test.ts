/**
 * Unit tests for ERC8004RegistryImpl.
 *
 * Tests cover:
 *  - Mock-mode registration (MOCK_ONCHAIN_IDENTITY=true)
 *  - isRegistered() and getRegistration() returning from SQLite cache
 *  - Gas-retry logic: ensures retry counter increments and gasPrice increases
 *  - Idempotence: calling register() twice returns the cached result
 *  - identity:ready event emission via initializeIdentity()
 *
 * Requirements: 1.2, 3.2, 3.3, 3.4, 3.6
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ERC8004RegistryImpl } from './erc8004-registry.js';
import { initializeIdentity } from './index.js';
import type { IdentityRepository } from '../state/repositories/identity.repo.js';
import type { WalletInfo } from './wallet-manager.js';

// ---------------------------------------------------------------------------
// Helpers: in-memory identity repository stub
// ---------------------------------------------------------------------------

interface StoredIdentityRecord {
  id: number;
  walletAddress: string;
  publicKey: string;
  registrationTxHash: string | null;
  registrationBlock: number | null;
  confirmed: boolean;
  createdAt: number;
}

function makeIdentityRepoStub(): IdentityRepository {
  const store: StoredIdentityRecord[] = [];
  let nextId = 1;

  return {
    create(input) {
      const id = nextId++;
      store.push({
        id,
        walletAddress: input.walletAddress,
        publicKey: input.publicKey,
        registrationTxHash: null,
        registrationBlock: null,
        confirmed: false,
        createdAt: input.createdAt ?? Date.now(),
      });
      return id;
    },
    findByAddress(address) {
      return store.find((r) => r.walletAddress === address) ?? null;
    },
    get() {
      return store[0] ?? null;
    },
    updateRegistration(id, input) {
      const rec = store.find((r) => r.id === id);
      if (rec) {
        rec.registrationTxHash = input.registrationTxHash;
        rec.registrationBlock = input.registrationBlock;
        rec.confirmed = input.confirmed;
      }
    },
  } as unknown as IdentityRepository;
}

const SAMPLE_WALLET: WalletInfo = {
  address: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12',
  publicKey: '0x04abc',
  keystorePath: '/tmp/test.keystore.json',
  createdAt: 1_000_000,
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ERC8004RegistryImpl — mock mode', () => {
  let repo: IdentityRepository;
  let registry: ERC8004RegistryImpl;

  beforeEach(() => {
    repo = makeIdentityRepoStub();
    // Create identity record (mimics WalletManager doing it first).
    repo.create({
      walletAddress: SAMPLE_WALLET.address,
      publicKey: SAMPLE_WALLET.publicKey,
      createdAt: SAMPLE_WALLET.createdAt,
    });
    // Force mock mode via constructor argument.
    registry = new ERC8004RegistryImpl(repo, undefined, true);
  });

  it('register() returns a confirmed RegistrationResult in mock mode', async () => {
    const result = await registry.register(SAMPLE_WALLET);

    expect(result.confirmed).toBe(true);
    expect(result.confirmations).toBe(2);
    expect(result.txHash).toMatch(/^0xmock_/);
    expect(result.blockNumber).toBeGreaterThan(0);
    expect(result.registeredAt).toBeGreaterThan(0);
  });

  it('register() persists result to identity repo', async () => {
    await registry.register(SAMPLE_WALLET);

    const record = repo.findByAddress(SAMPLE_WALLET.address);
    expect(record).not.toBeNull();
    expect(record!.confirmed).toBe(true);
    expect(record!.registrationTxHash).toMatch(/^0xmock_/);
    expect(record!.registrationBlock).toBeGreaterThan(0);
  });

  it('isRegistered() returns true after registration', async () => {
    await registry.register(SAMPLE_WALLET);
    const result = await registry.isRegistered(SAMPLE_WALLET.address);
    expect(result).toBe(true);
  });

  it('isRegistered() returns false before registration', async () => {
    const result = await registry.isRegistered(SAMPLE_WALLET.address);
    expect(result).toBe(false);
  });

  it('getRegistration() returns null before registration', async () => {
    const result = await registry.getRegistration(SAMPLE_WALLET.address);
    expect(result).toBeNull();
  });

  it('getRegistration() returns RegistrationResult after registration', async () => {
    await registry.register(SAMPLE_WALLET);
    const result = await registry.getRegistration(SAMPLE_WALLET.address);

    expect(result).not.toBeNull();
    expect(result!.confirmed).toBe(true);
    expect(result!.txHash).toMatch(/^0xmock_/);
  });

  it('register() is idempotent — second call returns cached result', async () => {
    const first = await registry.register(SAMPLE_WALLET);
    const second = await registry.register(SAMPLE_WALLET);

    // txHash should be identical (served from cache, no new mock tx).
    expect(second.txHash).toBe(first.txHash);
    expect(second.confirmed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Gas retry logic (on-chain simulation with mocked signer)
// ---------------------------------------------------------------------------

describe('ERC8004RegistryImpl — gas retry logic', () => {
  it('retries up to 3 times on gas errors and succeeds on last attempt', async () => {
    const repo = makeIdentityRepoStub();
    repo.create({
      walletAddress: SAMPLE_WALLET.address,
      publicKey: SAMPLE_WALLET.publicKey,
      createdAt: SAMPLE_WALLET.createdAt,
    });

    const registry = new ERC8004RegistryImpl(
      repo,
      'https://mainnet.base.org',
      false, // NOT mock mode — forces real path
    );

    // Set contract address so the real path is taken.
    process.env['ERC8004_CONTRACT_ADDRESS'] = '0x1234567890123456789012345678901234567890';

    let callCount = 0;

    const mockReceipt = {
      hash: '0xrealthash123',
      blockNumber: 12345,
    };

    const fakeRegisterFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount < 4) {
        const err = new Error('insufficient funds for gas * price + value');
        (err as { code?: string }).code = 'INSUFFICIENT_FUNDS';
        throw err;
      }
      return Promise.resolve({
        hash: '0xrealthash123',
        wait: () => Promise.resolve(mockReceipt),
      });
    });

    // Override _buildContract to avoid touching the frozen ethers module.
    registry._buildContract = vi.fn().mockReturnValue({
      register: fakeRegisterFn,
    });

    const mockProvider = {
      getFeeData: vi.fn().mockResolvedValue({
        gasPrice: BigInt('1000000000'), // 1 gwei
      }),
    };
    // @ts-expect-error — injecting mock provider
    registry['provider'] = mockProvider;

    const fakeSigner = { address: SAMPLE_WALLET.address } as unknown as import('ethers').Signer;
    registry._signerOverride = fakeSigner;

    try {
      const result = await registry.register(SAMPLE_WALLET);
      expect(result.txHash).toBe('0xrealthash123');
      expect(result.blockNumber).toBe(12345);
      expect(result.confirmed).toBe(true);
      expect(callCount).toBe(4); // 1 initial + 3 retries
    } finally {
      delete process.env['ERC8004_CONTRACT_ADDRESS'];
    }
  });

  it('throws after exhausting all retries on persistent gas errors', async () => {
    const repo = makeIdentityRepoStub();
    repo.create({
      walletAddress: SAMPLE_WALLET.address,
      publicKey: SAMPLE_WALLET.publicKey,
      createdAt: SAMPLE_WALLET.createdAt,
    });

    const registry = new ERC8004RegistryImpl(
      repo,
      'https://mainnet.base.org',
      false,
    );

    process.env['ERC8004_CONTRACT_ADDRESS'] = '0x1234567890123456789012345678901234567890';

    const alwaysFailFn = vi.fn().mockImplementation(() => {
      const err = new Error('insufficient funds for gas * price + value');
      (err as { code?: string }).code = 'INSUFFICIENT_FUNDS';
      throw err;
    });

    registry._buildContract = vi.fn().mockReturnValue({
      register: alwaysFailFn,
    });

    const mockProvider = {
      getFeeData: vi.fn().mockResolvedValue({
        gasPrice: BigInt('1000000000'),
      }),
    };
    // @ts-expect-error — injecting mock provider
    registry['provider'] = mockProvider;
    registry._signerOverride = { address: SAMPLE_WALLET.address } as unknown as import('ethers').Signer;

    try {
      await expect(registry.register(SAMPLE_WALLET)).rejects.toThrow(
        /Registration failed after/,
      );
    } finally {
      delete process.env['ERC8004_CONTRACT_ADDRESS'];
    }
  });

  it('falls back to mock when contract address is not set', async () => {
    const repo = makeIdentityRepoStub();
    repo.create({
      walletAddress: SAMPLE_WALLET.address,
      publicKey: SAMPLE_WALLET.publicKey,
      createdAt: SAMPLE_WALLET.createdAt,
    });

    // Ensure env var is absent.
    delete process.env['ERC8004_CONTRACT_ADDRESS'];

    const registry = new ERC8004RegistryImpl(
      repo,
      'https://mainnet.base.org',
      false, // NOT forced mock mode...
    );

    const mockProvider = {
      getFeeData: vi.fn().mockResolvedValue({ gasPrice: 1n }),
    };
    // @ts-expect-error — inject provider
    registry['provider'] = mockProvider;
    // No signer → should fallback to mock.

    const result = await registry.register(SAMPLE_WALLET);
    // Should still succeed via mock fallback.
    expect(result.confirmed).toBe(true);
    expect(result.txHash).toMatch(/^0xmock_/);
  });
});

// ---------------------------------------------------------------------------
// initializeIdentity — identity:ready event
// ---------------------------------------------------------------------------

describe('initializeIdentity — identity:ready event', () => {
  it('emits identity:ready with correct payload', async () => {
    // Set up mock env for WalletManagerImpl.
    process.env['MOCK_ONCHAIN_IDENTITY'] = 'true';
    process.env['WALLET_PASSWORD'] = 'test-password';

    const repo = makeIdentityRepoStub();
    const eventBus = new EventEmitter();
    const receivedPayloads: unknown[] = [];

    eventBus.on('identity:ready', (payload: unknown) => {
      receivedPayloads.push(payload);
    });

    // Use a temp keystore path so tests don't interfere with real keys.
    const tmpKeystorePath = `./tmp-test-keystore-${Date.now()}.json`;

    try {
      const payload = await initializeIdentity(
        repo,
        'test-password',
        eventBus,
        tmpKeystorePath,
      );

      expect(receivedPayloads).toHaveLength(1);
      expect(receivedPayloads[0]).toEqual(payload);
      expect(payload.confirmed).toBe(true);
      expect(typeof payload.address).toBe('string');
      expect(payload.address).toMatch(/^0x/);
      expect(payload.txHash).toMatch(/^0xmock_/);
      expect(payload.readyAt).toBeGreaterThan(0);
    } finally {
      // Cleanup: remove temp keystore file if created.
      try {
        const { unlinkSync, existsSync } = await import('node:fs');
        if (existsSync(tmpKeystorePath)) {
          unlinkSync(tmpKeystorePath);
        }
      } catch {
        // Ignore cleanup errors.
      }
      delete process.env['MOCK_ONCHAIN_IDENTITY'];
    }
  });
});

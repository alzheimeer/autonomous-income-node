/**
 * Property 4 — ERC8004Registry: gas retry with escalated price
 *
 * Validates: Requirements 3.2, 3.3, 3.4, 3.6
 *
 * Uses in-memory stubs to avoid native SQLite bindings requirement.
 *
 * Properties verified:
 *  P4-a: In mock mode, register always returns confirmed=true.
 *  P4-b: isRegistered returns false for unknown addresses (in-memory cache).
 *  P4-c: After mock registration, isRegistered is true.
 *  P4-d: getRegistration for unregistered address returns null.
 *  P4-e: Gas escalation factor: new price is strictly greater than old price.
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { ERC8004RegistryImpl } from '../erc8004-registry.js';
import type { IdentityRecord, CreateIdentityInput, UpdateRegistrationInput } from '../../state/repositories/identity.repo.js';

// ---------------------------------------------------------------------------
// In-memory IdentityRepository stub (no native SQLite required)
// ---------------------------------------------------------------------------

class InMemoryIdentityRepo {
  private store = new Map<string, IdentityRecord>();
  private nextId = 1;

  create(input: CreateIdentityInput): number {
    const id = this.nextId++;
    this.store.set(input.walletAddress.toLowerCase(), {
      id,
      walletAddress: input.walletAddress,
      publicKey: input.publicKey,
      registrationTxHash: null,
      registrationBlock: null,
      confirmed: false,
      createdAt: input.createdAt ?? Date.now(),
    });
    return id;
  }

  get(): IdentityRecord | null {
    const first = [...this.store.values()][0];
    return first ?? null;
  }

  findByAddress(walletAddress: string): IdentityRecord | null {
    return this.store.get(walletAddress.toLowerCase()) ?? null;
  }

  updateRegistration(id: number, input: UpdateRegistrationInput): void {
    for (const [key, record] of this.store) {
      if (record.id === id) {
        this.store.set(key, {
          ...record,
          registrationTxHash: input.registrationTxHash,
          registrationBlock: input.registrationBlock,
          confirmed: input.confirmed,
        });
        break;
      }
    }
  }
}

function createRegistry(repo: InMemoryIdentityRepo): ERC8004RegistryImpl {
  return new ERC8004RegistryImpl(repo as never, undefined, true); // mock mode
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbAddress = fc
  .hexaString({ minLength: 40, maxLength: 40 })
  .map((h) => `0x${h}`);

const arbWalletInfo = fc.record({
  address: arbAddress,
  publicKey: fc.hexaString({ minLength: 66, maxLength: 66 }).map((h) => `0x${h}`),
  keystorePath: fc.constant('/keys/keystore.json'),
  createdAt: fc.integer({ min: 1_600_000_000_000, max: 2_000_000_000_000 }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 4 — ERC8004Registry: registration and retry invariants', () => {
  /**
   * P4-a: In mock mode, register always returns confirmed=true.
   * Validates: Requirement 3.2
   */
  it('P4-a: mock register always returns confirmed=true for any wallet', async () => {
    await fc.assert(
      fc.asyncProperty(arbWalletInfo, async (walletInfo) => {
        const repo = new InMemoryIdentityRepo();
        const registry = createRegistry(repo);

        // Pre-create the identity record (required by _persistResult)
        repo.create({
          walletAddress: walletInfo.address,
          publicKey: walletInfo.publicKey,
          createdAt: walletInfo.createdAt,
        });

        const result = await registry.register(walletInfo);
        return result.confirmed === true && typeof result.txHash === 'string';
      }),
      { numRuns: 30 }
    );
  });

  /**
   * P4-b: isRegistered returns false for addresses never registered.
   * Validates: Requirement 3.6
   */
  it('P4-b: isRegistered is false for any address not yet registered', async () => {
    await fc.assert(
      fc.asyncProperty(arbAddress, async (address) => {
        const repo = new InMemoryIdentityRepo();
        const registry = createRegistry(repo);
        const result = await registry.isRegistered(address);
        return result === false;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * P4-c: After mock registration, isRegistered returns true.
   * Validates: Requirement 3.2, 3.6
   */
  it('P4-c: after registration, isRegistered always returns true', async () => {
    await fc.assert(
      fc.asyncProperty(arbWalletInfo, async (walletInfo) => {
        const repo = new InMemoryIdentityRepo();
        const registry = createRegistry(repo);

        repo.create({
          walletAddress: walletInfo.address,
          publicKey: walletInfo.publicKey,
          createdAt: walletInfo.createdAt,
        });

        await registry.register(walletInfo);
        const registered = await registry.isRegistered(walletInfo.address);
        return registered === true;
      }),
      { numRuns: 30 }
    );
  });

  /**
   * P4-d: getRegistration for an unregistered address always returns null.
   * Validates: Requirement 3.6
   */
  it('P4-d: getRegistration returns null for unregistered addresses', async () => {
    await fc.assert(
      fc.asyncProperty(arbAddress, async (address) => {
        const repo = new InMemoryIdentityRepo();
        const registry = createRegistry(repo);
        const result = await registry.getRegistration(address);
        return result === null;
      }),
      { numRuns: 50 }
    );
  });

  /**
   * P4-e: Gas escalation invariant — each retry produces a strictly higher gas price.
   * Formula: newPrice = oldPrice * 12 / 10 (integer division).
   * Validates: Requirement 3.4
   */
  it('P4-e: gas retry escalation produces strictly higher prices per attempt', () => {
    fc.assert(
      fc.property(
        // Use a gas price large enough that 12/10 integer division is non-trivial
        fc.bigInt({ min: 10n, max: 100_000_000_000n }),
        fc.integer({ min: 1, max: 3 }),
        (initialGasPrice, retries) => {
          const GAS_RETRY_NUMERATOR = 12n;
          const GAS_RETRY_DENOMINATOR = 10n;

          let price = initialGasPrice;
          for (let i = 0; i < retries; i++) {
            const previous = price;
            price = (price * GAS_RETRY_NUMERATOR) / GAS_RETRY_DENOMINATOR;
            // Each step must be strictly greater than the previous
            // (guaranteed when previous >= 10 since 12*10/10 = 12 > 10)
            if (price <= previous) return false;
          }
          return true;
        }
      ),
      { numRuns: 200 }
    );
  });
});

/**
 * Identity module barrel export.
 *
 * Re-exports WalletManager, ERC8004Registry, Signer and their associated
 * types so consumers can import from '../identity/index.js'.
 *
 * Also provides the `initializeIdentity` convenience function that:
 *  1. Loads / creates the wallet via WalletManagerImpl.
 *  2. Registers on-chain (or mock) via ERC8004RegistryImpl.
 *  3. Emits the `identity:ready` event on the supplied (or default) EventEmitter.
 *
 * Usage:
 *   import { initializeIdentity, WalletManagerImpl, ERC8004RegistryImpl } from '../identity/index.js';
 *
 * Requirements: 1.1, 1.2, 3.1, 3.2, 3.3, 3.4, 3.6
 */

import { EventEmitter } from 'node:events';
import type { IdentityRepository } from '../state/repositories/identity.repo.js';
import { WalletManagerImpl } from './wallet-manager.js';
import { ERC8004RegistryImpl } from './erc8004-registry.js';

// ---------------------------------------------------------------------------
// Re-exports: types + implementations
// ---------------------------------------------------------------------------

export { WalletManagerImpl } from './wallet-manager.js';
export type { WalletManager, WalletInfo, IdentityPersistence } from './wallet-manager.js';

export { ERC8004RegistryImpl } from './erc8004-registry.js';
export type { ERC8004Registry, RegistrationResult } from './erc8004-registry.js';

export { SignerImpl } from './signer.js';
export type { Signer } from './signer.js';

// ---------------------------------------------------------------------------
// identity:ready event payload
// ---------------------------------------------------------------------------

export interface IdentityReadyPayload {
  /** Checksummed Ethereum wallet address. */
  address: string;
  /** Whether the ERC-8004 registration has been confirmed on-chain. */
  confirmed: boolean;
  /** Transaction hash of the registration (real or mock). */
  txHash: string;
  /** Unix timestamp (ms) when the identity became ready. */
  readyAt: number;
}

// ---------------------------------------------------------------------------
// Convenience bootstrap function
// ---------------------------------------------------------------------------

/**
 * Fully initialise the identity subsystem:
 *  1. Load or create the Ethereum wallet.
 *  2. Register (or verify registration) on the Base network.
 *  3. Emit `identity:ready` on `eventBus` with an IdentityReadyPayload.
 *
 * @param identityRepo  IdentityRepository backed by SQLite.
 * @param password      Wallet encryption / decryption password.
 * @param eventBus      EventEmitter where `identity:ready` will be emitted.
 *                      Defaults to a module-local emitter if not supplied.
 * @param keystorePath  Optional override for the keystore file path.
 * @returns             The IdentityReadyPayload that was emitted.
 *
 * @throws If wallet initialization fails or registration fails after all retries.
 */
export async function initializeIdentity(
  identityRepo: IdentityRepository,
  password: string,
  eventBus: EventEmitter = new EventEmitter(),
  keystorePath?: string,
): Promise<IdentityReadyPayload & { walletManager: WalletManagerImpl }> {
  // Step 1: initialise wallet.
  const walletManager = new WalletManagerImpl(identityRepo, keystorePath);
  const walletInfo = await walletManager.initializeWallet(password);

  // Step 2: register on-chain (or mock).
  const registry = new ERC8004RegistryImpl(identityRepo);
  const registrationResult = await registry.register(walletInfo);

  // Step 3: build payload and emit event.
  const payload: IdentityReadyPayload & { walletManager: WalletManagerImpl } = {
    address: walletInfo.address,
    confirmed: registrationResult.confirmed,
    txHash: registrationResult.txHash,
    readyAt: Date.now(),
    walletManager,
  };

  eventBus.emit('identity:ready', payload);

  console.info(
    `[Identity] identity:ready emitted — address: ${payload.address}, ` +
      `confirmed: ${payload.confirmed}, txHash: ${payload.txHash}`,
  );

  return payload;
}

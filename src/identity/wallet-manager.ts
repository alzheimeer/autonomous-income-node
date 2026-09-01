/**
 * WalletManager — BIP-39 wallet generation and AES-256 encrypted keystore management.
 *
 * Implements the full wallet lifecycle for the Autonomous Income Node:
 *  1. On first start: generate BIP-39 mnemonic → derive HD wallet (m/44'/60'/0'/0/0)
 *     → encrypt keystore via ConfigStore → chmod 600 → persist to SQLite.
 *  2. On subsequent starts: detect existing keystore → decrypt → return WalletInfo.
 *
 * SECURITY INVARIANTS:
 *  - Private keys and mnemonics NEVER appear in logs (maskSecrets applied to all output).
 *  - The in-memory wallet is kept as a module-private singleton; callers get only WalletInfo.
 *  - Keystore file is always written with chmod 600.
 *
 * Requirements: 1.1, 1.6, 3.1, 3.7, 14.1, 14.2, 14.6
 */

import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as bip39 from 'bip39';
import { HDNodeWallet, Wallet } from 'ethers';
import { ConfigStore, maskSecrets } from '../config/index.js';
import type { CreateIdentityInput } from '../state/repositories/identity.repo.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletInfo {
  /** Checksummed Ethereum address (0x...). */
  address: string;
  /** Compressed or uncompressed public key as hex string. */
  publicKey: string;
  /** Absolute path of the encrypted keystore file on disk. */
  keystorePath: string;
  /** Unix timestamp (ms) when the wallet was first created. */
  createdAt: number;
}

export interface WalletManager {
  /**
   * Initialise the wallet subsystem.
   *
   * If a keystore already exists at `keystorePath`, it is decrypted and
   * loaded. Otherwise a new BIP-39 mnemonic is generated, an HD wallet is
   * derived, and the encrypted keystore is written to disk.
   *
   * Always persists the identity record to SQLite if not already present.
   *
   * @param password  Encryption / decryption password (from WALLET_PASSWORD env).
   * @returns         WalletInfo for the active wallet.
   */
  initializeWallet(password: string): Promise<WalletInfo>;

  /**
   * Load an existing keystore from disk.
   * Throws if the keystore file does not exist or the password is wrong.
   *
   * @param password  Decryption password.
   * @returns         WalletInfo for the loaded wallet.
   */
  loadWallet(password: string): Promise<WalletInfo>;

  /**
   * Sign an arbitrary UTF-8 message with the loaded private key.
   * Requires `initializeWallet` or `loadWallet` to have been called first.
   *
   * @param message  The message to sign (UTF-8 string or hex).
   * @returns        EIP-191 signature as a hex string (0x...).
   */
  signMessage(message: string): Promise<string>;

  /**
   * Return the checksummed Ethereum address of the active wallet.
   * Throws if no wallet has been loaded yet.
   */
  getAddress(): string;
}

// ---------------------------------------------------------------------------
// Derivation path
// ---------------------------------------------------------------------------

/** Standard BIP-44 Ethereum derivation path, index 0. */
const ETH_DERIVATION_PATH = "m/44'/60'/0'/0/0";

// ---------------------------------------------------------------------------
// Keystore envelope
// ---------------------------------------------------------------------------

/**
 * Structure serialised as JSON, then encrypted with ConfigStore, and written
 * to the keystore file.
 *
 * We store the private key (hex without 0x prefix) and mnemonic so the
 * wallet can always be deterministically recovered.
 *
 * NOTE: This JSON is ONLY ever stored encrypted. It must never be logged.
 */
interface KeystoreEnvelope {
  address: string;
  publicKey: string;
  /** Private key as 64-character hex (no 0x prefix). */
  privateKeyHex: string;
  /** BIP-39 mnemonic phrase (12 or 24 words). */
  mnemonic: string;
  /** Derivation path used. */
  derivationPath: string;
  /** Unix timestamp (ms) of creation. */
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Injectable identity persistence interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for identity persistence that WalletManagerImpl depends on.
 * The full `IdentityRepository` satisfies this interface, but tests can inject
 * a lightweight in-memory implementation without requiring native SQLite addons.
 */
export interface IdentityPersistence {
  findByAddress(walletAddress: string): { walletAddress: string } | null;
  create(input: CreateIdentityInput): number;
}

// ---------------------------------------------------------------------------
// WalletManagerImpl
// ---------------------------------------------------------------------------

export class WalletManagerImpl implements WalletManager {
  /** In-memory wallet — only set after initializeWallet / loadWallet. */
  private _wallet: HDNodeWallet | Wallet | null = null;
  /** Cached WalletInfo returned to callers. */
  private _walletInfo: WalletInfo | null = null;

  private readonly configStore: ConfigStore;
  private readonly keystorePath: string;
  private readonly identityPersistence: IdentityPersistence;

  /**
   * @param identityPersistence  Repository (or stub) for persisting the identity record.
   * @param keystorePath         Path for the encrypted keystore file.
   *                             Defaults to KEYSTORE_PATH env var or './keys/keystore.json'.
   */
  constructor(
    identityPersistence: IdentityPersistence,
    keystorePath?: string,
  ) {
    this.configStore = new ConfigStore();
    this.keystorePath = resolve(
      keystorePath ??
        process.env['KEYSTORE_PATH'] ??
        './keys/keystore.json',
    );
    this.identityPersistence = identityPersistence;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  async initializeWallet(password: string): Promise<WalletInfo> {
    if (existsSync(this.keystorePath)) {
      // Keystore already exists — load and decrypt it.
      return this.loadWallet(password);
    }

    // First start — generate a new wallet.
    return this._createWallet(password);
  }

  async loadWallet(password: string): Promise<WalletInfo> {
    if (!existsSync(this.keystorePath)) {
      throw new Error(
        `[WalletManager] Keystore not found at ${this.keystorePath}. ` +
          'Call initializeWallet() to create a new wallet first.',
      );
    }

    // Decrypt and parse the envelope.
    const plaintext = this.configStore.readKeystore(this.keystorePath, password);
    const envelope: KeystoreEnvelope = JSON.parse(plaintext) as KeystoreEnvelope;

    // Reconstruct the wallet from private key for signing operations.
    this._wallet = new Wallet('0x' + envelope.privateKeyHex);

    const info: WalletInfo = {
      address: envelope.address,
      publicKey: envelope.publicKey,
      keystorePath: this.keystorePath,
      createdAt: envelope.createdAt,
    };
    this._walletInfo = info;

    // Ensure the identity record exists in SQLite (idempotent).
    this._persistIdentity(info);

    console.info(
      `[WalletManager] Wallet loaded — address: ${info.address} ` +
        `(fingerprint: ${maskSecrets(envelope.privateKeyHex).slice(0, 8)})`,
    );

    return info;
  }

  async signMessage(message: string): Promise<string> {
    if (!this._wallet) {
      throw new Error(
        '[WalletManager] No wallet loaded. Call initializeWallet() or loadWallet() first.',
      );
    }
    // EIP-191 personal sign
    const signature = await this._wallet.signMessage(message);
    return signature;
  }

  getAddress(): string {
    if (!this._walletInfo) {
      throw new Error(
        '[WalletManager] No wallet loaded. Call initializeWallet() or loadWallet() first.',
      );
    }
    return this._walletInfo.address;
  }

  /**
   * Return the ethers Wallet instance for signing transactions.
   * Requires `initializeWallet` or `loadWallet` to have been called first.
   * This is used by the TradeExecutor to sign and broadcast swap transactions.
   */
  getSigner(): Wallet {
    if (!this._wallet) {
      throw new Error(
        '[WalletManager] No wallet loaded. Call initializeWallet() or loadWallet() first.',
      );
    }
    // Return Wallet (not HDNodeWallet) — both extend BaseWallet and support sendTransaction
    return this._wallet instanceof Wallet ? this._wallet : new Wallet((this._wallet as HDNodeWallet).privateKey);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Generate a fresh BIP-39 wallet, encrypt it, write to disk, and persist
   * the identity record to SQLite.
   */
  private async _createWallet(password: string): Promise<WalletInfo> {
    // Generate 128-bit entropy → 12-word mnemonic (compatible with MetaMask etc.)
    const mnemonic = bip39.generateMnemonic(128);

    // Derive wallet using ethers v6 HDNodeWallet
    const hdNode = HDNodeWallet.fromPhrase(mnemonic, undefined, ETH_DERIVATION_PATH);

    const createdAt = Date.now();

    const envelope: KeystoreEnvelope = {
      address: hdNode.address,
      publicKey: hdNode.publicKey,
      // Strip 0x prefix for compact storage
      privateKeyHex: hdNode.privateKey.replace(/^0x/i, ''),
      mnemonic,
      derivationPath: ETH_DERIVATION_PATH,
      createdAt,
    };

    // Encrypt and write to disk (ConfigStore handles chmod 600).
    this._ensureParentDir(this.keystorePath);
    const plaintext = JSON.stringify(envelope);
    this.configStore.writeKeystore(this.keystorePath, plaintext, password);

    // Keep the wallet in memory for signing.
    this._wallet = new Wallet(hdNode.privateKey);

    const info: WalletInfo = {
      address: hdNode.address,
      publicKey: hdNode.publicKey,
      keystorePath: this.keystorePath,
      createdAt,
    };
    this._walletInfo = info;

    // Persist identity to SQLite.
    this._persistIdentity(info);

    // Log creation WITHOUT exposing any secret material.
    console.info(
      `[WalletManager] New wallet created — address: ${info.address} ` +
        `path: ${this.keystorePath}`,
    );

    return info;
  }

  /**
   * Persist the wallet identity to SQLite if not already present.
   * Idempotent — does nothing if the address is already recorded.
   */
  private _persistIdentity(info: WalletInfo): void {
    const existing = this.identityPersistence.findByAddress(info.address);
    if (!existing) {
      this.identityPersistence.create({
        walletAddress: info.address,
        publicKey: info.publicKey,
        createdAt: info.createdAt,
      });
    }
  }

  /**
   * Ensure the parent directory for `filePath` exists, creating it
   * recursively if necessary.
   */
  private _ensureParentDir(filePath: string): void {
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
  }
}

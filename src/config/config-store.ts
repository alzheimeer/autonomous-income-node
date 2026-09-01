/**
 * ConfigStore — encrypted keystore manager for Autonomous Income Node.
 *
 * Provides AES-256-GCM encryption/decryption of sensitive keystore data,
 * enforces chmod 600 permissions on written files, and watches for external
 * file changes via chokidar.
 *
 * SECURITY INVARIANTS:
 *  - Plaintext keystore content is NEVER logged.
 *  - Private keys, mnemonics, and passwords are NEVER written to stdout.
 *  - All writes use AES-256-GCM with a random IV and authentication tag.
 *
 * Requirements: 14.1, 14.2, 14.3, 14.5, 14.6
 */

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  scryptSync,
} from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';

// ---------------------------------------------------------------------------
// Encryption constants
// ---------------------------------------------------------------------------

/** AES-256-GCM key length in bytes. */
const KEY_LENGTH = 32; // 256 bits

/** GCM IV length in bytes (96-bit is standard for GCM). */
const IV_LENGTH = 12;

/** GCM authentication tag length in bytes. */
const AUTH_TAG_LENGTH = 16;

/**
 * scrypt parameters. N=2^14 is the OWASP-recommended minimum for interactive
 * logins; suitable for keystore operations that aren't in a hot path.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * Fixed salt length for key derivation.
 * A unique salt is generated per encryption operation and stored alongside
 * the ciphertext so decryption can reproduce the same derived key.
 */
const SALT_LENGTH = 32;

// ---------------------------------------------------------------------------
// Serialization format
// ---------------------------------------------------------------------------

/**
 * Binary layout of the encrypted blob (all lengths in bytes):
 *
 *   [ salt (32) | iv (12) | authTag (16) | ciphertext (variable) ]
 *
 * The whole blob is base64-encoded for storage as a UTF-8 string.
 */

// ---------------------------------------------------------------------------
// ConfigStore class
// ---------------------------------------------------------------------------

export class ConfigStore {
  // Active chokidar watchers keyed by absolute path.
  private readonly _watchers = new Map<string, FSWatcher>();

  // ── Encryption / Decryption ──────────────────────────────────────────────

  /**
   * Encrypts `data` with AES-256-GCM using a key derived from `password`.
   *
   * @param data     Plaintext string to encrypt (e.g. JSON keystore).
   * @param password Password used for key derivation (not logged).
   * @returns        Base64-encoded ciphertext blob.
   */
  encryptKeystore(data: string, password: string): string {
    const salt = randomBytes(SALT_LENGTH);
    const iv = randomBytes(IV_LENGTH);

    const key = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);

    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(salt); // bind salt to the authenticated data

    const ciphertext = Buffer.concat([
      cipher.update(data, 'utf8'),
      cipher.final(),
    ]);

    const authTag = cipher.getAuthTag();

    // Pack: salt | iv | authTag | ciphertext
    const blob = Buffer.concat([salt, iv, authTag, ciphertext]);
    return blob.toString('base64');
  }

  /**
   * Decrypts an AES-256-GCM encrypted blob produced by {@link encryptKeystore}.
   *
   * @param encrypted  Base64-encoded ciphertext blob.
   * @param password   Password used for key derivation (not logged).
   * @returns          Original plaintext string.
   * @throws           If the password is wrong or the blob is tampered with.
   */
  decryptKeystore(encrypted: string, password: string): string {
    const blob = Buffer.from(encrypted, 'base64');

    if (blob.length < SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH) {
      throw new Error('[ConfigStore] Encrypted blob is too short to be valid.');
    }

    let offset = 0;

    const salt = blob.subarray(offset, (offset += SALT_LENGTH));
    const iv = blob.subarray(offset, (offset += IV_LENGTH));
    const authTag = blob.subarray(offset, (offset += AUTH_TAG_LENGTH));
    const ciphertext = blob.subarray(offset);

    const key = scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(salt);
    decipher.setAuthTag(authTag);

    try {
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch {
      // Do NOT include the password or any key material in the error.
      throw new Error(
        '[ConfigStore] Decryption failed: incorrect password or corrupted data.',
      );
    }
  }

  // ── File I/O ─────────────────────────────────────────────────────────────

  /**
   * Encrypts `data` and writes it to `filePath`, then enforces chmod 600
   * (owner read+write only) to protect the keystore file.
   *
   * @param filePath  Destination path for the encrypted keystore.
   * @param data      Plaintext keystore content (never logged).
   * @param password  Encryption password (never logged).
   */
  writeKeystore(filePath: string, data: string, password: string): void {
    const encrypted = this.encryptKeystore(data, password);
    writeFileSync(filePath, encrypted, { encoding: 'utf8' });

    // Restrict permissions to owner read+write only (octal 0o600).
    // On Windows this is a no-op for the execute bit but still restricts
    // write access to non-owner users where supported.
    chmodSync(filePath, 0o600);
  }

  /**
   * Reads the encrypted keystore from `filePath` and decrypts it.
   *
   * @param filePath  Path to the encrypted keystore file.
   * @param password  Decryption password (never logged).
   * @returns         Original plaintext keystore content.
   */
  readKeystore(filePath: string, password: string): string {
    const encrypted = readFileSync(filePath, { encoding: 'utf8' });
    return this.decryptKeystore(encrypted, password);
  }

  // ── File Watching ────────────────────────────────────────────────────────

  /**
   * Watches `filePath` for external modifications and invokes `callback`
   * whenever the file changes.
   *
   * The callback is intentionally not passed any file content — it is the
   * caller's responsibility to reload via {@link readKeystore} with the
   * password. This prevents accidental exposure of decrypted data.
   *
   * A second call with the same path replaces the existing watcher.
   *
   * @param filePath  Absolute or relative path to the file to watch.
   * @param callback  Invoked on any `change` event for the watched file.
   */
  watchConfig(filePath: string, callback: () => void): void {
    // If there's an existing watcher for this path, close it first.
    const existing = this._watchers.get(filePath);
    if (existing) {
      void existing.close();
    }

    const watcher = chokidar.watch(filePath, {
      // Ignore the initial "add" event — only react to actual changes.
      ignoreInitial: true,
      // Use polling on network / Docker volumes where native events may fail.
      usePolling: false,
      // Avoid duplicate events from rapid writes.
      awaitWriteFinish: {
        stabilityThreshold: 300,
        pollInterval: 100,
      },
    });

    watcher.on('change', () => {
      callback();
    });

    watcher.on('error', (_err: unknown) => {
      // Errors are silently swallowed to avoid crashing the agent.
      // The calling module can implement its own retry / alerting logic.
    });

    this._watchers.set(filePath, watcher);
  }

  /**
   * Stops all active file watchers.  Call this during graceful shutdown.
   */
  async closeAllWatchers(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [, watcher] of this._watchers) {
      closePromises.push(watcher.close());
    }
    await Promise.all(closePromises);
    this._watchers.clear();
  }
}

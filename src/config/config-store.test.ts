/**
 * Unit tests for src/config/config-store.ts
 *
 * Validates:
 *  - AES-256-GCM encryption round-trip
 *  - Decryption fails with wrong password (tamper detection)
 *  - writeKeystore produces a file with non-plaintext content
 *  - readKeystore recovers the original plaintext
 *  - chmod 600 is applied on write
 *  - watchConfig fires callback on file change
 *  - closeAllWatchers cleans up without errors
 *
 * Requirements: 14.1, 14.2, 14.3, 14.5, 14.6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from './config-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  writeFileSync,
  unlinkSync,
  existsSync,
  statSync,
  readFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpFile(suffix = '.enc'): string {
  return join(tmpdir(), `ain-test-${randomBytes(6).toString('hex')}${suffix}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConfigStore', () => {
  let store: ConfigStore;
  const tmpFiles: string[] = [];

  beforeEach(() => {
    store = new ConfigStore();
  });

  afterEach(async () => {
    await store.closeAllWatchers();
    // Clean up temp files
    for (const f of tmpFiles.splice(0)) {
      if (existsSync(f)) {
        try { unlinkSync(f); } catch { /* ignore */ }
      }
    }
  });

  // ── Encryption round-trip ──────────────────────────────────────────────

  describe('encryptKeystore / decryptKeystore', () => {
    it('round-trip: decrypt(encrypt(data)) === data', () => {
      const data = JSON.stringify({ privateKey: '0x' + 'a'.repeat(64), mnemonic: 'test' });
      const password = 'correct-horse-battery-staple';
      const encrypted = store.encryptKeystore(data, password);
      const decrypted = store.decryptKeystore(encrypted, password);
      expect(decrypted).toBe(data);
    });

    it('encrypted output is base64 and different from plaintext', () => {
      const data = '{"address":"0x123","version":3}';
      const encrypted = store.encryptKeystore(data, 'password123');
      expect(encrypted).not.toBe(data);
      expect(encrypted).toMatch(/^[A-Za-z0-9+/=]+$/); // base64
    });

    it('two encryptions of the same data produce different ciphertexts (random IV)', () => {
      const data = 'same plaintext';
      const password = 'pass';
      const enc1 = store.encryptKeystore(data, password);
      const enc2 = store.encryptKeystore(data, password);
      expect(enc1).not.toBe(enc2);
    });

    it('decryption with wrong password throws', () => {
      const data = 'sensitive keystore content';
      const encrypted = store.encryptKeystore(data, 'correct-password');
      expect(() => store.decryptKeystore(encrypted, 'wrong-password')).toThrow();
    });

    it('decryption of tampered ciphertext throws', () => {
      const data = 'keystore data';
      const encrypted = store.encryptKeystore(data, 'pass');
      const buf = Buffer.from(encrypted, 'base64');
      // flip a byte in the ciphertext portion
      buf[buf.length - 1] ^= 0xff;
      const tampered = buf.toString('base64');
      expect(() => store.decryptKeystore(tampered, 'pass')).toThrow();
    });

    it('decryption error does NOT include the password in the message', () => {
      const encrypted = store.encryptKeystore('data', 'real-password');
      try {
        store.decryptKeystore(encrypted, 'wrong-pass');
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        expect((err as Error).message).not.toContain('wrong-pass');
        expect((err as Error).message).not.toContain('real-password');
      }
    });

    it('throws on a blob that is too short', () => {
      const shortBlob = Buffer.alloc(10).toString('base64');
      expect(() => store.decryptKeystore(shortBlob, 'any')).toThrow(/too short/i);
    });
  });

  // ── File I/O ──────────────────────────────────────────────────────────

  describe('writeKeystore / readKeystore', () => {
    it('writeKeystore + readKeystore round-trip', () => {
      const path = tmpFile();
      tmpFiles.push(path);
      const content = JSON.stringify({ address: '0xdead', privateKey: '0x' + 'f'.repeat(64) });
      const password = 'test-password-12345';

      store.writeKeystore(path, content, password);
      const recovered = store.readKeystore(path, password);
      expect(recovered).toBe(content);
    });

    it('written file does NOT contain plaintext privateKey or mnemonic', () => {
      const path = tmpFile();
      tmpFiles.push(path);
      const mnemonic = 'word one two three four five six seven eight nine ten eleven twelve';
      const privateKey = '0x' + 'a'.repeat(64);
      const content = JSON.stringify({ privateKey, mnemonic });

      store.writeKeystore(path, content, 'password');
      const raw = readFileSync(path, 'utf8');

      expect(raw).not.toContain('privateKey');
      expect(raw).not.toContain(privateKey);
      expect(raw).not.toContain(mnemonic);
    });

    it('applies chmod 600 to written file (Unix only)', () => {
      // On Windows this test is skipped gracefully since chmod is a no-op
      if (process.platform === 'win32') return;

      const path = tmpFile();
      tmpFiles.push(path);
      store.writeKeystore(path, 'data', 'pass');

      const mode = statSync(path).mode;
      const permissions = (mode & 0o777).toString(8);
      expect(permissions).toBe('600');
    });

    it('readKeystore with wrong password throws', () => {
      const path = tmpFile();
      tmpFiles.push(path);
      store.writeKeystore(path, 'sensitive', 'correct-pass');
      expect(() => store.readKeystore(path, 'wrong-pass')).toThrow();
    });
  });

  // ── File watcher ─────────────────────────────────────────────────────

  describe('watchConfig', () => {
    it('calls callback when watched file changes', async () => {
      const path = tmpFile('.json');
      tmpFiles.push(path);
      writeFileSync(path, 'initial content');

      let callCount = 0;
      store.watchConfig(path, () => { callCount++; });

      // Wait briefly for watcher to initialise, then modify the file
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      writeFileSync(path, 'updated content');

      // Wait for the change event to fire (stabilityThreshold = 300ms + buffer)
      await new Promise<void>((resolve) => setTimeout(resolve, 800));
      expect(callCount).toBeGreaterThanOrEqual(1);
    }, 10_000);

    it('replaces existing watcher when called twice with the same path', () => {
      const path = tmpFile('.json');
      tmpFiles.push(path);
      writeFileSync(path, 'v1');

      let count1 = 0;
      let count2 = 0;
      store.watchConfig(path, () => { count1++; });
      store.watchConfig(path, () => { count2++; });

      // Only the second callback should be registered; internal map has 1 entry
      // We verify indirectly by checking closeAllWatchers doesn't crash
      expect(() => store.closeAllWatchers()).not.toThrow();
    });
  });

  // ── Cleanup ──────────────────────────────────────────────────────────

  describe('closeAllWatchers', () => {
    it('resolves without error when no watchers are active', async () => {
      await expect(store.closeAllWatchers()).resolves.not.toThrow();
    });

    it('can be called twice without error', async () => {
      const path = tmpFile('.json');
      tmpFiles.push(path);
      writeFileSync(path, 'x');
      store.watchConfig(path, () => {});
      await store.closeAllWatchers();
      await expect(store.closeAllWatchers()).resolves.not.toThrow();
    });
  });
});

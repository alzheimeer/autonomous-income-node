/**
 * BackupManager
 *
 * Creates, restores and queries timestamped file backups for the Self-Mod module.
 * Used before any live code modification so that the agent can roll back
 * automatically if a crash is detected on the subsequent restart.
 *
 * Backup naming convention:  <originalPath>.<timestamp_ms>.bak
 *   e.g.  src/strategies/trading/index.ts.1719000000000.bak
 *
 * Requirements: 9.3, 9.7
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// BackupManager
// ---------------------------------------------------------------------------

export class BackupManager {
  /**
   * Create a backup of `filePath` by copying it to `<filePath>.<timestamp>.bak`.
   *
   * @param filePath - Absolute or relative path to the file that should be backed up.
   * @returns The path to the newly created backup file.
   * @throws If the source file cannot be read or the destination cannot be written.
   */
  async createBackup(filePath: string): Promise<string> {
    const timestamp = Date.now();
    const backupPath = `${filePath}.${timestamp}.bak`;

    // Ensure the destination directory exists (same dir as original)
    const destDir = path.dirname(backupPath);
    await fs.mkdir(destDir, { recursive: true });

    // For new files that don't exist yet, create an empty backup
    // so that the crash-recovery sentinel can still reference a valid path
    try {
      await fs.copyFile(filePath, backupPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        // Source file doesn't exist yet (new auto-generated file) — write empty backup
        await fs.writeFile(backupPath, '', 'utf8');
      } else {
        throw err;
      }
    }

    return backupPath;
  }

  /**
   * Restore a backup by copying `backupPath` over `originalPath`.
   *
   * @param backupPath   - Path to the `.bak` file produced by {@link createBackup}.
   * @param originalPath - Destination path where the original file should be restored.
   * @throws If the backup file cannot be read or the destination cannot be written.
   */
  async restoreBackup(backupPath: string, originalPath: string): Promise<void> {
    // Ensure destination directory exists in case the original was removed
    const destDir = path.dirname(originalPath);
    await fs.mkdir(destDir, { recursive: true });

    await fs.copyFile(backupPath, originalPath);
  }

  /**
   * Find the most recent backup for `filePath` by scanning its parent directory.
   *
   * Backup files match the pattern `<basename>.<timestamp>.bak` where
   * `timestamp` is a numeric (millisecond epoch) value.
   *
   * @param filePath - The original file path whose backups should be searched.
   * @returns The absolute/relative path to the newest backup, or `null` if none
   *          exist.
   */
  async getLatestBackup(filePath: string): Promise<string | null> {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);

    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      // Directory doesn't exist yet — no backups
      return null;
    }

    // Pattern: <basename>.<timestamp>.bak
    const backupPattern = new RegExp(
      `^${escapeRegex(base)}\\.(\\d+)\\.bak$`
    );

    let latestTimestamp = -1;
    let latestPath: string | null = null;

    for (const entry of entries) {
      const match = backupPattern.exec(entry);
      if (!match) continue;

      const timestamp = parseInt(match[1]!, 10);
      if (timestamp > latestTimestamp) {
        latestTimestamp = timestamp;
        latestPath = path.join(dir, entry);
      }
    }

    return latestPath;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Escape special regex characters in a string so it can be used as a literal. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

export const backupManager = new BackupManager();

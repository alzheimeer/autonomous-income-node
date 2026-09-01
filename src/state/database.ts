/**
 * SQLite database wrapper using Node.js 24 native node:sqlite.
 * Handles initialization, migrations, integrity checks, and periodic backups.
 * Requirements: 12.1, 12.2, 12.5, 12.6
 * 
 * MIGRATED from better-sqlite3 to node:sqlite due to Node 24 compatibility issues.
 * The better-sqlite3 destructor crashes on Node 24 with:
 *   "Assertion failed: (env) != nullptr" in RemoveEnvironmentCleanupHook
 */

import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Use createRequire to load node:sqlite — avoids Vite's module resolution issues
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => NativeDatabase;
};

// ---------------------------------------------------------------------------
// Native Database Types (node:sqlite)
// ---------------------------------------------------------------------------

interface NativeDatabase {
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
}

interface NativeStatement {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

// ---------------------------------------------------------------------------
// Better-sqlite3 Compatible Interface
// ---------------------------------------------------------------------------

export interface Statement<TParams extends unknown[] = unknown[], TResult = unknown> {
  run(...params: TParams): { changes: number; lastInsertRowid: number | bigint };
  get(...params: TParams): TResult | undefined;
  all(...params: TParams): TResult[];
}

/**
 * Database interface compatible with better-sqlite3.
 * Repositories import this type instead of 'better-sqlite3'.
 */
export interface Database {
  prepare<TParams extends unknown[] = unknown[], TResult = unknown>(sql: string): Statement<TParams, TResult>;
  exec(sql: string): void;
  pragma(cmd: string): unknown;
  transaction<T, Args extends unknown[]>(fn: (...args: Args) => T): (...args: Args) => T;
  close(): void;
  open: boolean;
}

/**
 * Wrapper that provides a better-sqlite3 compatible API over node:sqlite.
 * This allows existing repositories to work without modification.
 */
class DatabaseWrapper implements Database {
  private db: NativeDatabase;
  open: boolean = true;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
  }

  prepare<TParams extends unknown[] = unknown[], TResult = unknown>(sql: string): Statement<TParams, TResult> {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params: TParams) => stmt.run(...params),
      get: (...params: TParams) => stmt.get(...params) as TResult | undefined,
      all: (...params: TParams) => stmt.all(...params) as TResult[],
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  pragma(cmd: string): unknown {
    const stmt = this.db.prepare(`PRAGMA ${cmd}`);
    try {
      return stmt.all();
    } catch {
      this.db.exec(`PRAGMA ${cmd}`);
      return [];
    }
  }

  transaction<T, Args extends unknown[]>(fn: (...args: Args) => T): (...args: Args) => T {
    return (...args: Args) => {
      this.db.exec('BEGIN');
      try {
        const result = fn(...args);
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  close(): void {
    if (this.open) {
      this.db.close();
      this.open = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DatabaseConfig {
  /** Path to the SQLite file. Defaults to DB_PATH env var or ./data/agent.db */
  dbPath?: string;
  /** Directory for 24-hour backups. Defaults to BACKUP_DIR env var or ./data/backups */
  backupDir?: string;
  /** Enable WAL journal mode (recommended for concurrent reads). Default: true */
  walMode?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, 'migrations');

// ---------------------------------------------------------------------------
// AgentDatabase
// ---------------------------------------------------------------------------

export class AgentDatabase {
  private db: DatabaseWrapper;
  private dbPath: string;
  private backupDir: string;
  private backupIntervalHandle?: NodeJS.Timeout;

  constructor(config: DatabaseConfig = {}) {
    this.dbPath = config.dbPath ?? process.env['DB_PATH'] ?? './data/agent.db';
    this.backupDir =
      config.backupDir ?? process.env['BACKUP_DIR'] ?? './data/backups';

    // Ensure parent directory exists
    mkdirSync(dirname(this.dbPath), { recursive: true });

    // Open database using node:sqlite wrapper
    this.db = new DatabaseWrapper(this.dbPath);

    // Performance settings
    if (config.walMode !== false) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -16000'); // 16 MB page cache
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run startup checks and migrations. Must be called before first use.
   * Throws DatabaseIntegrityError on integrity failure (process should exit code 2).
   * Requirement: 12.2, 12.5
   */
  initialize(): void {
    this.checkIntegrity();
    this.runMigrations();
    this.scheduleBackups();
  }

  /** Return the database wrapper for repository use. */
  getDb(): DatabaseWrapper {
    return this.db;
  }

  /** Close database connection and cancel scheduled backup. */
  close(): void {
    if (this.backupIntervalHandle) {
      clearInterval(this.backupIntervalHandle);
      this.backupIntervalHandle = undefined;
    }
    this.db.close();
  }

  /**
   * Manually trigger a timestamped backup right now.
   * Returns a Promise that resolves when the backup is complete.
   * Requirement: 12.6
   * 
   * Note: node:sqlite doesn't have native backup() like better-sqlite3.
   * We checkpoint WAL first, then copy the file.
   */
  async backup(): Promise<void> {
    mkdirSync(this.backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(this.backupDir, `agent_${timestamp}.db`);

    // Checkpoint WAL to ensure all data is in main file
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // If not in WAL mode, this is fine
    }

    // Copy the database file
    copyFileSync(this.dbPath, backupPath);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Run PRAGMA integrity_check and throw if the DB is corrupt.
   * Requirement: 12.5
   */
  private checkIntegrity(): void {
    const result = this.db
      .prepare('PRAGMA integrity_check')
      .all() as Array<{ integrity_check: string }>;

    const ok = result.length === 1 && result[0]!.integrity_check === 'ok';

    if (!ok) {
      const details = result.map((r) => r.integrity_check).join('; ');
      throw new DatabaseIntegrityError(
        `SQLite integrity check failed: ${details}`
      );
    }
  }

  /**
   * Apply any migration .sql files that haven't been run yet, in order.
   * Requirement: 12.2
   */
  private runMigrations(): void {
    // Bootstrap migrations tracking table before querying it
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name    TEXT    NOT NULL,
        applied_at INTEGER NOT NULL
      );
    `);

    const applied = new Set<number>(
      (
        this.db
          .prepare('SELECT version FROM schema_migrations')
          .all() as Array<{ version: number }>
      ).map((r) => r.version)
    );

    const migrations = this.discoverMigrations();

    for (const { version, name, filePath } of migrations) {
      if (applied.has(version)) continue;

      const sql = readFileSync(filePath, 'utf8');

      // Execute entire migration inside a transaction
      const runMigration = this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare(
            'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
          )
          .run(version, name, Date.now());
      });

      runMigration();
    }
  }

  /**
   * Discover and sort migration .sql files from the migrations directory.
   */
  private discoverMigrations(): Array<{
    version: number;
    name: string;
    filePath: string;
  }> {
    let files: string[];
    try {
      files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    } catch {
      // migrations dir may not exist yet in some test environments
      return [];
    }

    return files
      .map((file) => {
        const match = /^(\d+)_(.+)\.sql$/.exec(file);
        if (!match) return null;
        return {
          version: parseInt(match[1]!, 10),
          name: match[2]!,
          filePath: join(MIGRATIONS_DIR, file),
        };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null)
      .sort((a, b) => a.version - b.version);
  }

  /**
   * Schedule an automatic backup every 24 hours.
   * Requirement: 12.6
   */
  private scheduleBackups(): void {
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

    this.backupIntervalHandle = setInterval(() => {
      this.backup().catch((err) => {
        // Non-fatal: log but don't crash the agent
        console.error('[AgentDatabase] Scheduled backup failed:', err);
      });
    }, TWENTY_FOUR_HOURS_MS);

    // Don't keep the Node.js event loop alive solely for periodic backups
    if (typeof this.backupIntervalHandle.unref === 'function') {
      this.backupIntervalHandle.unref();
    }
  }
}

// ---------------------------------------------------------------------------
// Custom errors
// ---------------------------------------------------------------------------

export class DatabaseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseIntegrityError';
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (shared across all repositories)
// ---------------------------------------------------------------------------

let _instance: AgentDatabase | null = null;

/** Get (or create) the module-level database singleton. */
export function getDatabase(config?: DatabaseConfig): AgentDatabase {
  if (!_instance) {
    _instance = new AgentDatabase(config);
  }
  return _instance;
}

/** Destroy the singleton — useful for testing or graceful shutdown. */
export function resetDatabaseInstance(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

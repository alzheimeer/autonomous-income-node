/**
 * ResearchDatabase — SQLite wrapper with migration runner for research.db
 *
 * Uses Node.js 24 native node:sqlite API (migrated from better-sqlite3).
 * Stores data in ./data/research.db by default.
 *
 * Pattern follows src/state/database.ts for consistency.
 */

import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, readdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use createRequire to load node:sqlite — avoids Vite's module resolution issues
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => NativeDatabase;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MIGRATIONS_DIR = join(__dirname, 'migrations');

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
// Better-sqlite3 Compatible Interface (for repositories)
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

// ---------------------------------------------------------------------------
// Database Wrapper (better-sqlite3 compatible)
// ---------------------------------------------------------------------------

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

export interface ResearchDatabaseConfig {
  /** Path to the SQLite file. Defaults to ./data/research.db */
  dbPath?: string;
  /** Directory for backups. Defaults to ./data/backups */
  backupDir?: string;
  /** Enable WAL journal mode (recommended). Default: true */
  walMode?: boolean;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

// ---------------------------------------------------------------------------
// Custom Errors
// ---------------------------------------------------------------------------

export class DatabaseIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseIntegrityError';
  }
}

// ---------------------------------------------------------------------------
// ResearchDatabase
// ---------------------------------------------------------------------------

export class ResearchDatabase {
  private db: DatabaseWrapper;
  private readonly dbPath: string;
  private readonly backupDir: string;
  private backupIntervalHandle?: NodeJS.Timeout;

  constructor(config?: Partial<ResearchDatabaseConfig>) {
    this.dbPath = config?.dbPath ?? process.env['RESEARCH_DB_PATH'] ?? './data/research.db';
    this.backupDir = config?.backupDir ?? process.env['RESEARCH_BACKUP_DIR'] ?? './data/backups';

    // Ensure parent directory exists
    mkdirSync(dirname(this.dbPath), { recursive: true });

    // Open database using node:sqlite wrapper
    this.db = new DatabaseWrapper(this.dbPath);

    // Performance settings
    if (config?.walMode !== false) {
      this.db.pragma('journal_mode = WAL');
    }
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -8000'); // 8 MB page cache
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Run startup checks and migrations. Must be called before first use.
   * Throws DatabaseIntegrityError on integrity failure.
   */
  initialize(): void {
    this.checkIntegrity();
    this.runMigrations();
    this.scheduleBackups();
    console.log('[ResearchDatabase] Initialized at', this.dbPath);
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
   * Manually trigger a timestamped backup.
   * Uses WAL checkpoint then file copy (node:sqlite doesn't have native backup).
   */
  async backup(): Promise<void> {
    mkdirSync(this.backupDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(this.backupDir, `research_${timestamp}.db`);

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
   */
  private checkIntegrity(): void {
    const result = this.db
      .prepare<[], { integrity_check: string }>('PRAGMA integrity_check')
      .all();

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
   */
  private runMigrations(): void {
    // Bootstrap migrations tracking table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      );
    `);

    const migrations = this.discoverMigrations();
    const applied = new Set(
      this.db
        .prepare<[], { name: string }>('SELECT name FROM _migrations')
        .all()
        .map((row) => row.name)
    );

    for (const { name, filePath } of migrations) {
      if (applied.has(name)) continue;

      const sql = readFileSync(filePath, 'utf-8');

      // Execute entire migration inside a transaction
      const runMigration = this.db.transaction(() => {
        this.db.exec(sql);
        this.db
          .prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
          .run(name, Date.now());
      });

      runMigration();
      console.log(`[ResearchDatabase] Applied migration: ${name}`);
    }
  }

  /**
   * Discover and sort migration .sql files from the migrations directory.
   */
  private discoverMigrations(): Array<{ name: string; filePath: string }> {
    const dirs = [
      MIGRATIONS_DIR,
      join(process.cwd(), 'dist', 'research', 'state', 'migrations'),
    ];

    for (const dir of dirs) {
      if (!existsSync(dir)) continue;

      try {
        const files = readdirSync(dir)
          .filter((f) => f.endsWith('.sql'))
          .sort();

        return files.map((name) => ({
          name,
          filePath: join(dir, name),
        }));
      } catch {
        continue;
      }
    }

    console.warn('[ResearchDatabase] No migrations directory found, skipping.');
    return [];
  }

  /**
   * Schedule an automatic backup every 24 hours.
   */
  private scheduleBackups(): void {
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1_000;

    this.backupIntervalHandle = setInterval(() => {
      this.backup().catch((err) => {
        console.error('[ResearchDatabase] Scheduled backup failed:', err);
      });
    }, TWENTY_FOUR_HOURS_MS);

    // Don't keep the Node.js event loop alive solely for backups
    if (typeof this.backupIntervalHandle.unref === 'function') {
      this.backupIntervalHandle.unref();
    }
  }

  // ---------------------------------------------------------------------------
  // Convenience query methods
  // ---------------------------------------------------------------------------

  run(sql: string, ...params: unknown[]): RunResult {
    return this.db.prepare(sql).run(...params);
  }

  get<T = unknown>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = unknown>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let _instance: ResearchDatabase | null = null;

/** Get (or create) the module-level database singleton. */
export function getResearchDatabase(config?: Partial<ResearchDatabaseConfig>): ResearchDatabase {
  if (!_instance) {
    _instance = new ResearchDatabase(config);
  }
  return _instance;
}

/** Destroy the singleton — useful for testing or graceful shutdown. */
export function resetResearchDatabaseInstance(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

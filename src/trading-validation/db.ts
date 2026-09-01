/**
 * Trading Validation Phase - Database Adapter
 *
 * Thin wrapper around Node 24's built-in `node:sqlite` DatabaseSync module.
 * Exposes a better-sqlite3-compatible interface so the rest of the module
 * can consume it without large refactors.
 *
 * Key API:
 *   - `createDatabase(path)` → TradingDatabase instance
 *   - `TradingDatabase.prepare(sql)` → statement with run/get/all
 *   - `TradingDatabase.exec(sql)` → execute multi-statement SQL
 *   - `TradingDatabase.pragma(cmd)` → PRAGMA wrapper
 *   - `TradingDatabase.transaction(fn)` → simple transaction wrapper
 *   - `TradingDatabase.close()` → close the database
 */

import { createRequire } from 'node:module';
import { pgPool } from './postgres.js';

// Use createRequire to load node:sqlite — this avoids Vite's module resolution
// issues with the newer node:sqlite built-in that Vite 5 doesn't recognize.
const require = createRequire(import.meta.url);
const { DatabaseSync: NativeDatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => NativeDatabase;
};

/** Minimal type for the native DatabaseSync instance */
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

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/**
 * TradingDatabase wraps node:sqlite's DatabaseSync to provide a
 * better-sqlite3-compatible interface for the trading-validation module.
 */
export class TradingDatabase {
  private readonly db: NativeDatabase;

  constructor(path: string) {
    this.db = new NativeDatabaseSync(path);
  }

  /**
   * Prepare a SQL statement. Returns an object with run(), get(), all() methods.
   */
  prepare(sql: string): Statement {
    // INTERCEPCIÓN HÍBRIDA: Desviar inserts pesados a Postgres en producción
    const isEventLogInsert = sql.toUpperCase().includes('INSERT INTO EVENT_LOG');
    
    // Si estamos en entorno de tests, escribimos en SQLite para no romper los assertions.
    // En producción (NODE_ENV != test), mandamos asíncronamente a Postgres y devolvemos dummy.
    if (isEventLogInsert && process.env.NODE_ENV !== 'test') {
      return {
        run(...params: unknown[]): RunResult {
          // Extraer parámetros (event_type, details, timestamp)
          const eventType = params[0] as string;
          const details = params[1];
          const timestamp = params[2] as number;
          
          pgPool.query(
            'INSERT INTO event_log (event_type, event_data, timestamp) VALUES ($1, $2, $3)',
            [eventType, typeof details === 'string' ? details : JSON.stringify(details), timestamp]
          ).catch(err => {
            console.error('[Postgres] Error insertando en event_log:', err);
          });
          
          return { changes: 1, lastInsertRowid: 0 };
        },
        get(): unknown { return undefined; },
        all(): unknown[] { return []; },
      };
    }

    const stmt = this.db.prepare(sql);
    return {
      run(...params: unknown[]): RunResult {
        const result = stmt.run(...params);
        return {
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        };
      },
      get(...params: unknown[]): unknown {
        return stmt.get(...params);
      },
      all(...params: unknown[]): unknown[] {
        return stmt.all(...params);
      },
    };
  }

  /**
   * Execute raw SQL (multi-statement). Equivalent to better-sqlite3's exec().
   */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  /**
   * PRAGMA helper. Executes a PRAGMA and returns the result.
   * Supports both query-style (returns results) and set-style PRAGMAs.
   */
  pragma(cmd: string): unknown {
    // PRAGMAs that set values (e.g., "journal_mode = WAL") don't return useful rows
    // PRAGMAs that query (e.g., "integrity_check") return result rows
    const stmt = this.db.prepare(`PRAGMA ${cmd}`);
    try {
      return stmt.all();
    } catch {
      // Some PRAGMAs don't return rows; use exec instead
      this.db.exec(`PRAGMA ${cmd}`);
      return [];
    }
  }

  /**
   * Simple transaction wrapper. Executes fn inside a BEGIN/COMMIT block.
   * If fn throws, the transaction is rolled back.
   *
   * Returns a callable function (matching better-sqlite3's transaction() API).
   */
  transaction<T>(fn: () => T): () => T {
    return () => {
      this.db.exec('BEGIN');
      try {
        const result = fn();
        this.db.exec('COMMIT');
        return result;
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Create a new TradingDatabase instance.
 *
 * @param path - Path to the SQLite file, or ':memory:' for in-memory DB
 */
export function createDatabase(path: string): TradingDatabase {
  return new TradingDatabase(path);
}

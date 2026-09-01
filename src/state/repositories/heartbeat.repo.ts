/**
 * Repository for the `heartbeat_events` and `crash_events` tables.
 * Records module health snapshots and crash recovery state.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface HeartbeatEvent {
  id: number;
  moduleStatuses: Record<string, string>; // module → 'healthy' | 'degraded' | 'down'
  tier: number;
  balanceUsdc: string;
  llmAvailable: boolean;
  recordedAt: number;
}

export interface CreateHeartbeatInput {
  moduleStatuses: Record<string, string>;
  tier: number;
  balanceUsdc: string;
  llmAvailable: boolean;
  recordedAt?: number;
}

export interface CrashEvent {
  id: number;
  lastKnownState: Record<string, unknown> | null;
  crashedAt: number;
  recoveredAt: number | null;
}

export interface CreateCrashInput {
  lastKnownState?: Record<string, unknown>;
  crashedAt?: number;
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

interface HeartbeatRow {
  id: number;
  module_statuses: string;
  tier: number;
  balance_usdc: string;
  llm_available: number;
  recorded_at: number;
}

interface CrashRow {
  id: number;
  last_known_state: string | null;
  crashed_at: number;
  recovered_at: number | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class HeartbeatRepository {
  constructor(private readonly db: Database) {}

  insertHeartbeat(input: CreateHeartbeatInput): number {
    const result = this.db
      .prepare<[string, number, string, number, number]>(`
        INSERT INTO heartbeat_events
          (module_statuses, tier, balance_usdc, llm_available, recorded_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(
        JSON.stringify(input.moduleStatuses),
        input.tier,
        input.balanceUsdc,
        input.llmAvailable ? 1 : 0,
        input.recordedAt ?? Date.now()
      );
    return result.lastInsertRowid as number;
  }

  getLatestHeartbeat(): HeartbeatEvent | null {
    const row = this.db
      .prepare<[], HeartbeatRow>(
        'SELECT * FROM heartbeat_events ORDER BY recorded_at DESC LIMIT 1'
      )
      .get() as HeartbeatRow | undefined;
    return row ? this.toHeartbeatRecord(row) : null;
  }

  findHeartbeats(since: number, limit = 100): HeartbeatEvent[] {
    return (
      this.db
        .prepare<[number, number], HeartbeatRow>(
          'SELECT * FROM heartbeat_events WHERE recorded_at > ? ORDER BY recorded_at DESC LIMIT ?'
        )
        .all(since, limit) as HeartbeatRow[]
    ).map((r) => this.toHeartbeatRecord(r));
  }

  // ---------------------------------------------------------------------------
  // Crash events
  // ---------------------------------------------------------------------------

  insertCrash(input: CreateCrashInput): number {
    const result = this.db
      .prepare<[string | null, number]>(`
        INSERT INTO crash_events (last_known_state, crashed_at)
        VALUES (?, ?)
      `)
      .run(
        input.lastKnownState ? JSON.stringify(input.lastKnownState) : null,
        input.crashedAt ?? Date.now()
      );
    return result.lastInsertRowid as number;
  }

  markRecovered(id: number, recoveredAt?: number): void {
    this.db
      .prepare<[number, number]>(
        'UPDATE crash_events SET recovered_at = ? WHERE id = ?'
      )
      .run(recoveredAt ?? Date.now(), id);
  }

  getUnrecoveredCrash(): CrashEvent | null {
    const row = this.db
      .prepare<[], CrashRow>(
        'SELECT * FROM crash_events WHERE recovered_at IS NULL ORDER BY crashed_at DESC LIMIT 1'
      )
      .get() as CrashRow | undefined;
    return row ? this.toCrashRecord(row) : null;
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toHeartbeatRecord(row: HeartbeatRow): HeartbeatEvent {
    return {
      id: row.id,
      moduleStatuses: JSON.parse(row.module_statuses) as Record<string, string>,
      tier: row.tier,
      balanceUsdc: row.balance_usdc,
      llmAvailable: Boolean(row.llm_available),
      recordedAt: row.recorded_at,
    };
  }

  private toCrashRecord(row: CrashRow): CrashEvent {
    return {
      id: row.id,
      lastKnownState: row.last_known_state
        ? (JSON.parse(row.last_known_state) as Record<string, unknown>)
        : null,
      crashedAt: row.crashed_at,
      recoveredAt: row.recovered_at,
    };
  }
}

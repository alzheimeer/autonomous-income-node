/**
 * Repository for the `observations` table.
 * Persists ReAct loop action results — the "Observe" phase output.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface ObservationRecord {
  id: string;
  actionId: string;
  cycleId: string;
  module: string;
  tool: string;
  inputSummary: string | null;
  success: boolean;
  resultSummary: string | null;
  error: string | null;
  latencyMs: number | null;
  timestamp: number;
}

export interface CreateObservationInput {
  id: string;
  actionId: string;
  cycleId: string;
  module: string;
  tool: string;
  inputSummary?: string;
  success: boolean;
  resultSummary?: string;
  error?: string;
  latencyMs?: number;
  timestamp?: number;
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface ObservationRow {
  id: string;
  action_id: string;
  cycle_id: string;
  module: string;
  tool: string;
  input_summary: string | null;
  success: number; // 0 | 1
  result_summary: string | null;
  error: string | null;
  latency_ms: number | null;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class ObservationsRepository {
  constructor(private readonly db: Database) {}

  insert(input: CreateObservationInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string,
          string | null,
          number,
          string | null,
          string | null,
          number | null,
          number,
        ]
      >(`
        INSERT INTO observations
          (id, action_id, cycle_id, module, tool, input_summary,
           success, result_summary, error, latency_ms, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.actionId,
        input.cycleId,
        input.module,
        input.tool,
        input.inputSummary ?? null,
        input.success ? 1 : 0,
        input.resultSummary ?? null,
        input.error ?? null,
        input.latencyMs ?? null,
        input.timestamp ?? Date.now()
      );
  }

  /** Insert multiple observations in a single transaction. */
  insertMany(inputs: CreateObservationInput[]): void {
    const insertOne = this.db.prepare<
      [
        string,
        string,
        string,
        string,
        string,
        string | null,
        number,
        string | null,
        string | null,
        number | null,
        number,
      ]
    >(`
      INSERT INTO observations
        (id, action_id, cycle_id, module, tool, input_summary,
         success, result_summary, error, latency_ms, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction((obs: CreateObservationInput[]) => {
      for (const o of obs) {
        insertOne.run(
          o.id,
          o.actionId,
          o.cycleId,
          o.module,
          o.tool,
          o.inputSummary ?? null,
          o.success ? 1 : 0,
          o.resultSummary ?? null,
          o.error ?? null,
          o.latencyMs ?? null,
          o.timestamp ?? Date.now()
        );
      }
    });

    tx(inputs);
  }

  findByCycle(cycleId: string): ObservationRecord[] {
    return (
      this.db
        .prepare<[string], ObservationRow>(
          'SELECT * FROM observations WHERE cycle_id = ? ORDER BY timestamp ASC'
        )
        .all(cycleId) as ObservationRow[]
    ).map((r) => this.toRecord(r));
  }

  findRecent(limit = 100): ObservationRecord[] {
    return (
      this.db
        .prepare<[number], ObservationRow>(
          'SELECT * FROM observations ORDER BY timestamp DESC LIMIT ?'
        )
        .all(limit) as ObservationRow[]
    ).map((r) => this.toRecord(r));
  }

  findByModule(module: string, limit = 50): ObservationRecord[] {
    return (
      this.db
        .prepare<[string, number], ObservationRow>(
          'SELECT * FROM observations WHERE module = ? ORDER BY timestamp DESC LIMIT ?'
        )
        .all(module, limit) as ObservationRow[]
    ).map((r) => this.toRecord(r));
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: ObservationRow): ObservationRecord {
    return {
      id: row.id,
      actionId: row.action_id,
      cycleId: row.cycle_id,
      module: row.module,
      tool: row.tool,
      inputSummary: row.input_summary,
      success: Boolean(row.success),
      resultSummary: row.result_summary,
      error: row.error,
      latencyMs: row.latency_ms,
      timestamp: row.timestamp,
    };
  }
}

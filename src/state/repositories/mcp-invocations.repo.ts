/**
 * Repository for the `mcp_invocations` table.
 * Logs every MCP tool call with latency and success status.
 * Requirement: 13.7
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface McpInvocationRecord {
  id: string;
  server: string;
  tool: string;
  inputSummary: string | null;
  outputSummary: string | null;
  success: boolean;
  latencyMs: number | null;
  error: string | null;
  invokedAt: number;
}

export interface CreateMcpInvocationInput {
  id: string;
  server: string;
  tool: string;
  inputSummary?: string;
  outputSummary?: string;
  success: boolean;
  latencyMs?: number;
  error?: string;
  invokedAt?: number;
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface McpInvocationRow {
  id: string;
  server: string;
  tool: string;
  input_summary: string | null;
  output_summary: string | null;
  success: number;
  latency_ms: number | null;
  error: string | null;
  invoked_at: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class McpInvocationsRepository {
  constructor(private readonly db: Database) {}

  insert(input: CreateMcpInvocationInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string | null,
          string | null,
          number,
          number | null,
          string | null,
          number,
        ]
      >(`
        INSERT INTO mcp_invocations
          (id, server, tool, input_summary, output_summary,
           success, latency_ms, error, invoked_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.server,
        input.tool,
        input.inputSummary ?? null,
        input.outputSummary ?? null,
        input.success ? 1 : 0,
        input.latencyMs ?? null,
        input.error ?? null,
        input.invokedAt ?? Date.now()
      );
  }

  findByServerTool(server: string, tool: string, limit = 50): McpInvocationRecord[] {
    return (
      this.db
        .prepare<[string, string, number], McpInvocationRow>(
          'SELECT * FROM mcp_invocations WHERE server = ? AND tool = ? ORDER BY invoked_at DESC LIMIT ?'
        )
        .all(server, tool, limit) as McpInvocationRow[]
    ).map((r) => this.toRecord(r));
  }

  findRecent(limit = 100): McpInvocationRecord[] {
    return (
      this.db
        .prepare<[number], McpInvocationRow>(
          'SELECT * FROM mcp_invocations ORDER BY invoked_at DESC LIMIT ?'
        )
        .all(limit) as McpInvocationRow[]
    ).map((r) => this.toRecord(r));
  }

  /** Average latency for a server/tool pair over the last N records. */
  averageLatency(server: string, tool: string, lastN = 20): number | null {
    const result = this.db
      .prepare<[string, string, number], { avg_lat: number | null }>(`
        SELECT AVG(latency_ms) AS avg_lat
        FROM (
          SELECT latency_ms FROM mcp_invocations
          WHERE server = ? AND tool = ?
          ORDER BY invoked_at DESC
          LIMIT ?
        )
      `)
      .get(server, tool, lastN) as { avg_lat: number | null };
    return result?.avg_lat ?? null;
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: McpInvocationRow): McpInvocationRecord {
    return {
      id: row.id,
      server: row.server,
      tool: row.tool,
      inputSummary: row.input_summary,
      outputSummary: row.output_summary,
      success: Boolean(row.success),
      latencyMs: row.latency_ms,
      error: row.error,
      invokedAt: row.invoked_at,
    };
  }
}

/**
 * Repository for the `knowledge_base` table.
 * Persists discovered opportunities and intelligence entries.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface KnowledgeBaseRow {
  id: string;
  source: string;
  type: string;
  title: string;
  description: string | null;
  protocol_name: string | null;
  estimated_yield_bps: number | null;
  risk_level: string | null;
  required_capital_usdc: string | null;
  viability_score: number;
  status: string;
  metadata: string | null;
  discovered_at: number;
  last_evaluated_at: number | null;
  expires_at: number | null;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface InsertKnowledgeBaseInput {
  id: string;
  source: string;
  type: string;
  title: string;
  description?: string | null;
  protocol_name?: string | null;
  estimated_yield_bps?: number | null;
  risk_level?: string | null;
  required_capital_usdc?: string | null;
  viability_score?: number;
  status?: string;
  metadata?: string | null;
  discovered_at?: number;
  last_evaluated_at?: number | null;
  expires_at?: number | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class KnowledgeBaseRepository {
  constructor(private readonly db: Database) {}

  insert(entry: InsertKnowledgeBaseInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string,
          string,
          string | null,
          string | null,
          number | null,
          string | null,
          string | null,
          number,
          string,
          string | null,
          number,
          number | null,
          number | null,
        ]
      >(`
        INSERT INTO knowledge_base
          (id, source, type, title, description, protocol_name,
           estimated_yield_bps, risk_level, required_capital_usdc,
           viability_score, status, metadata, discovered_at,
           last_evaluated_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        entry.id,
        entry.source,
        entry.type,
        entry.title,
        entry.description ?? null,
        entry.protocol_name ?? null,
        entry.estimated_yield_bps ?? null,
        entry.risk_level ?? null,
        entry.required_capital_usdc ?? null,
        entry.viability_score ?? 0,
        entry.status ?? 'new',
        entry.metadata ?? null,
        entry.discovered_at ?? Date.now(),
        entry.last_evaluated_at ?? null,
        entry.expires_at ?? null,
      );
  }

  getById(id: string): KnowledgeBaseRow | null {
    const row = this.db
      .prepare<[string], KnowledgeBaseRow>(
        'SELECT * FROM knowledge_base WHERE id = ?'
      )
      .get(id) as KnowledgeBaseRow | undefined;
    return row ?? null;
  }

  getByStatus(status: string, limit: number): KnowledgeBaseRow[] {
    return this.db
      .prepare<[string, number], KnowledgeBaseRow>(
        'SELECT * FROM knowledge_base WHERE status = ? ORDER BY viability_score DESC LIMIT ?'
      )
      .all(status, limit) as KnowledgeBaseRow[];
  }

  updateStatus(id: string, status: string): void {
    this.db
      .prepare<[string, string]>(
        'UPDATE knowledge_base SET status = ? WHERE id = ?'
      )
      .run(status, id);
  }

  updateViabilityScore(id: string, score: number): void {
    this.db
      .prepare<[number, number, string]>(
        'UPDATE knowledge_base SET viability_score = ?, last_evaluated_at = ? WHERE id = ?'
      )
      .run(score, Date.now(), id);
  }

  findDuplicate(protocolName: string, type: string): KnowledgeBaseRow | null {
    const row = this.db
      .prepare<[string, string], KnowledgeBaseRow>(
        'SELECT * FROM knowledge_base WHERE protocol_name = ? AND type = ? LIMIT 1'
      )
      .get(protocolName, type) as KnowledgeBaseRow | undefined;
    return row ?? null;
  }

  getActionable(limit: number): KnowledgeBaseRow[] {
    return this.db
      .prepare<[number], KnowledgeBaseRow>(
        "SELECT * FROM knowledge_base WHERE status = 'actionable' ORDER BY viability_score DESC LIMIT ?"
      )
      .all(limit) as KnowledgeBaseRow[];
  }
}

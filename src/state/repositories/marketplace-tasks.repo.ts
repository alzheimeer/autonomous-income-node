/**
 * Repository for the `marketplace_tasks` table.
 * Tracks tasks discovered and executed on marketplaces.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

export interface MarketplaceTaskRow {
  id: string;
  marketplace: string;
  external_task_id: string | null;
  title: string;
  description: string | null;
  required_capability: string;
  payment_usdc: string;
  estimated_cost_usdc: string | null;
  deadline: number | null;
  status: string;
  result_summary: string | null;
  execution_time_ms: number | null;
  accepted_at: number | null;
  completed_at: number | null;
  discovered_at: number;
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface InsertMarketplaceTaskInput {
  id: string;
  marketplace: string;
  external_task_id?: string | null;
  title: string;
  description?: string | null;
  required_capability: string;
  payment_usdc: string;
  estimated_cost_usdc?: string | null;
  deadline?: number | null;
  status?: string;
  discovered_at?: number;
}

export interface UpdateMarketplaceTaskExtras {
  result_summary?: string | null;
  execution_time_ms?: number | null;
  accepted_at?: number | null;
  completed_at?: number | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class MarketplaceTasksRepository {
  constructor(private readonly db: Database) {}

  insert(task: InsertMarketplaceTaskInput): void {
    this.db
      .prepare<
        [
          string,
          string,
          string | null,
          string,
          string | null,
          string,
          string,
          string | null,
          number | null,
          string,
          number,
        ]
      >(`
        INSERT INTO marketplace_tasks
          (id, marketplace, external_task_id, title, description,
           required_capability, payment_usdc, estimated_cost_usdc,
           deadline, status, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        task.id,
        task.marketplace,
        task.external_task_id ?? null,
        task.title,
        task.description ?? null,
        task.required_capability,
        task.payment_usdc,
        task.estimated_cost_usdc ?? null,
        task.deadline ?? null,
        task.status ?? 'discovered',
        task.discovered_at ?? Date.now(),
      );
  }

  getById(id: string): MarketplaceTaskRow | null {
    const row = this.db
      .prepare<[string], MarketplaceTaskRow>(
        'SELECT * FROM marketplace_tasks WHERE id = ?'
      )
      .get(id) as MarketplaceTaskRow | undefined;
    return row ?? null;
  }

  getByStatus(status: string): MarketplaceTaskRow[] {
    return this.db
      .prepare<[string], MarketplaceTaskRow>(
        'SELECT * FROM marketplace_tasks WHERE status = ? ORDER BY discovered_at DESC'
      )
      .all(status) as MarketplaceTaskRow[];
  }

  updateStatus(id: string, status: string, extras?: UpdateMarketplaceTaskExtras): void {
    if (extras) {
      this.db
        .prepare<
          [string, string | null, number | null, number | null, number | null, string]
        >(`
          UPDATE marketplace_tasks
          SET status = ?,
              result_summary = COALESCE(?, result_summary),
              execution_time_ms = COALESCE(?, execution_time_ms),
              accepted_at = COALESCE(?, accepted_at),
              completed_at = COALESCE(?, completed_at)
          WHERE id = ?
        `)
        .run(
          status,
          extras.result_summary ?? null,
          extras.execution_time_ms ?? null,
          extras.accepted_at ?? null,
          extras.completed_at ?? null,
          id,
        );
    } else {
      this.db
        .prepare<[string, string]>(
          'UPDATE marketplace_tasks SET status = ? WHERE id = ?'
        )
        .run(status, id);
    }
  }

  getPending(): MarketplaceTaskRow[] {
    return this.db
      .prepare<[], MarketplaceTaskRow>(
        "SELECT * FROM marketplace_tasks WHERE status = 'discovered' ORDER BY deadline ASC"
      )
      .all() as MarketplaceTaskRow[];
  }
}

/**
 * Repository for the `child_agents` table.
 * Registry of Docker-based child agent instances.
 */

import type { Database } from '../database.js';

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type ChildAgentStatus = 'running' | 'stopped' | 'emergency' | 'unknown';

export interface ChildAgentRecord {
  id: string;
  walletAddress: string;
  containerId: string;
  parentId: string;
  initialFunding: string; // bigint as string
  status: ChildAgentStatus;
  spawnedAt: number;
  lastHeartbeat: number | null;
}

export interface CreateChildAgentInput {
  id: string;
  walletAddress: string;
  containerId: string;
  parentId: string;
  initialFunding: string;
  status?: ChildAgentStatus;
  spawnedAt?: number;
}

// ---------------------------------------------------------------------------
// Row type
// ---------------------------------------------------------------------------

interface ChildAgentRow {
  id: string;
  wallet_address: string;
  container_id: string;
  parent_id: string;
  initial_funding: string;
  status: string;
  spawned_at: number;
  last_heartbeat: number | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class ChildAgentsRepository {
  constructor(private readonly db: Database) {}

  insert(input: CreateChildAgentInput): void {
    this.db
      .prepare<
        [string, string, string, string, string, string, number]
      >(`
        INSERT INTO child_agents
          (id, wallet_address, container_id, parent_id, initial_funding,
           status, spawned_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.walletAddress,
        input.containerId,
        input.parentId,
        input.initialFunding,
        input.status ?? 'running',
        input.spawnedAt ?? Date.now()
      );
  }

  findById(id: string): ChildAgentRecord | null {
    const row = this.db
      .prepare<[string], ChildAgentRow>(
        'SELECT * FROM child_agents WHERE id = ?'
      )
      .get(id) as ChildAgentRow | undefined;
    return row ? this.toRecord(row) : null;
  }

  findAll(): ChildAgentRecord[] {
    return (
      this.db
        .prepare<[], ChildAgentRow>(
          'SELECT * FROM child_agents ORDER BY spawned_at ASC'
        )
        .all() as ChildAgentRow[]
    ).map((r) => this.toRecord(r));
  }

  findActive(): ChildAgentRecord[] {
    return (
      this.db
        .prepare<[], ChildAgentRow>(
          "SELECT * FROM child_agents WHERE status = 'running' ORDER BY spawned_at ASC"
        )
        .all() as ChildAgentRow[]
    ).map((r) => this.toRecord(r));
  }

  updateStatus(id: string, status: ChildAgentStatus): void {
    this.db
      .prepare<[string, string]>(
        'UPDATE child_agents SET status = ? WHERE id = ?'
      )
      .run(status, id);
  }

  updateHeartbeat(id: string, timestamp?: number): void {
    this.db
      .prepare<[number, string]>(
        'UPDATE child_agents SET last_heartbeat = ? WHERE id = ?'
      )
      .run(timestamp ?? Date.now(), id);
  }

  countActive(): number {
    const result = this.db
      .prepare<[], { cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM child_agents WHERE status = 'running'"
      )
      .get() as { cnt: number };
    return result?.cnt ?? 0;
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private toRecord(row: ChildAgentRow): ChildAgentRecord {
    return {
      id: row.id,
      walletAddress: row.wallet_address,
      containerId: row.container_id,
      parentId: row.parent_id,
      initialFunding: row.initial_funding,
      status: row.status as ChildAgentStatus,
      spawnedAt: row.spawned_at,
      lastHeartbeat: row.last_heartbeat,
    };
  }
}

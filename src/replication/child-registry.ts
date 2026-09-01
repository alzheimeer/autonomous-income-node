/**
 * ChildRegistry
 *
 * Read/write access to the child_agents table with domain-level logic:
 * - getActive(): returns running children, capped at MAX_CHILDREN.
 * - updateStatus(): changes the status column.
 * - detectEmergency(): returns children whose last_heartbeat is stale or
 *   whose status is 'emergency', indicating $0 balance / unreachable agent.
 *
 * Requirements: 10.3, 10.4, 10.5, 10.7
 */

import type {
  ChildAgentsRepository,
  ChildAgentRecord,
  ChildAgentStatus,
} from '../state/repositories/child-agents.repo.js';

// ---------------------------------------------------------------------------
// Re-export types for consumers
// ---------------------------------------------------------------------------
export type { ChildAgentRecord, ChildAgentStatus };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of active child agents per parent (Requirement 10.4) */
const MAX_CHILDREN = 5;

/**
 * How long without a heartbeat before a child is considered in emergency.
 * Default: 10 minutes (conservative — actual agents ping every 30s).
 */
const EMERGENCY_HEARTBEAT_STALE_MS = 10 * 60 * 1_000;

// ---------------------------------------------------------------------------
// ChildRegistry
// ---------------------------------------------------------------------------

export class ChildRegistry {
  constructor(private readonly repo: ChildAgentsRepository) {}

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * Return all running children, capped at MAX_CHILDREN.
   * Requirement: 10.4, 10.7
   */
  async getActive(): Promise<ChildAgentRecord[]> {
    const all = this.repo.findActive();
    return all.slice(0, MAX_CHILDREN);
  }

  /**
   * True when the current running child count is at the maximum.
   * Requirement: 10.4
   */
  async isAtCapacity(): Promise<boolean> {
    return this.repo.countActive() >= MAX_CHILDREN;
  }

  /**
   * Return all children in 'emergency' status, OR children whose last
   * heartbeat is older than EMERGENCY_HEARTBEAT_STALE_MS.
   * Requirement: 10.5
   */
  async detectEmergency(): Promise<ChildAgentRecord[]> {
    const all = this.repo.findAll();
    const now = Date.now();

    return all.filter((child) => {
      if (child.status === 'emergency') return true;

      // Stale heartbeat on a "running" child → treat as emergency
      if (
        child.status === 'running' &&
        child.lastHeartbeat !== null &&
        now - child.lastHeartbeat > EMERGENCY_HEARTBEAT_STALE_MS
      ) {
        return true;
      }

      return false;
    });
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Update the operational status of a child agent.
   * Requirement: 10.3
   */
  updateStatus(id: string, status: ChildAgentStatus): void {
    this.repo.updateStatus(id, status);
  }

  /**
   * Record a heartbeat ping from a child agent.
   * Requirement: 10.5, 10.7
   */
  recordHeartbeat(id: string, timestamp?: number): void {
    this.repo.updateHeartbeat(id, timestamp);
  }

  /**
   * Return a specific child by ID, or null if not found.
   */
  findById(id: string): ChildAgentRecord | null {
    return this.repo.findById(id);
  }

  /**
   * Return all children regardless of status.
   */
  findAll(): ChildAgentRecord[] {
    return this.repo.findAll();
  }

  /** Exposed constant for use in ReplicationModule */
  static readonly MAX_CHILDREN = MAX_CHILDREN;
}

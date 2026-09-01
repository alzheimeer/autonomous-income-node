/**
 * Property 19 — ChildRegistry: maximum 5 active children
 *
 * Validates: Requirements 10.3, 10.4, 10.5, 10.7
 *
 * Uses in-memory stub to avoid native SQLite bindings requirement.
 *
 * Properties verified:
 *  P19-a: getActive() never returns more than 5 children regardless of how many are stored.
 *  P19-b: isAtCapacity() is true if and only if active count >= 5.
 *  P19-c: getActive() result length equals min(runningCount, 5).
 *  P19-d: updateStatus changes status and is reflected by getActive().
 *  P19-e: MAX_CHILDREN constant is exactly 5.
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { ChildRegistry } from '../child-registry.js';
import type { ChildAgentRecord, ChildAgentStatus } from '../child-registry.js';

// ---------------------------------------------------------------------------
// In-memory ChildAgentsRepository stub (no native SQLite required)
// ---------------------------------------------------------------------------

class InMemoryChildAgentsRepo {
  private store = new Map<string, ChildAgentRecord>();

  insert(input: { id: string; walletAddress: string; containerId: string; parentId: string; initialFunding: string; status?: ChildAgentStatus; spawnedAt?: number }): void {
    this.store.set(input.id, {
      id: input.id,
      walletAddress: input.walletAddress,
      containerId: input.containerId,
      parentId: input.parentId,
      initialFunding: input.initialFunding,
      status: input.status ?? 'running',
      spawnedAt: input.spawnedAt ?? Date.now(),
      lastHeartbeat: null,
    });
  }

  findById(id: string): ChildAgentRecord | null {
    return this.store.get(id) ?? null;
  }

  findActive(): ChildAgentRecord[] {
    return [...this.store.values()]
      .filter((r) => r.status === 'running')
      .sort((a, b) => a.spawnedAt - b.spawnedAt);
  }

  findAll(): ChildAgentRecord[] {
    return [...this.store.values()].sort((a, b) => a.spawnedAt - b.spawnedAt);
  }

  updateStatus(id: string, status: ChildAgentStatus): void {
    const record = this.store.get(id);
    if (record) this.store.set(id, { ...record, status });
  }

  updateHeartbeat(id: string, timestamp?: number): void {
    const record = this.store.get(id);
    if (record) this.store.set(id, { ...record, lastHeartbeat: timestamp ?? Date.now() });
  }

  countActive(): number {
    return this.findActive().length;
  }
}

const MAX_CHILDREN = 5;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 19 — ChildRegistry: max 5 active children invariant', () => {
  /**
   * P19-a: getActive() never returns more than MAX_CHILDREN entries.
   * Validates: Requirement 10.4
   */
  it('P19-a: getActive() always returns at most 5 children', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 20 }),
        async (runningCount) => {
          const repo = new InMemoryChildAgentsRepo();
          const registry = new ChildRegistry(repo as never);

          for (let i = 0; i < runningCount; i++) {
            repo.insert({
              id: `child-${i}`,
              walletAddress: `0x${'a'.repeat(40)}`,
              containerId: `container-${i}`,
              parentId: 'parent-0',
              initialFunding: '1000000',
              status: 'running',
              spawnedAt: i,
            });
          }

          const active = await registry.getActive();
          return active.length <= MAX_CHILDREN;
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P19-b: isAtCapacity() is true iff running count >= MAX_CHILDREN.
   * Validates: Requirement 10.4
   */
  it('P19-b: isAtCapacity() correctly reflects whether the limit is reached', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }),
        async (runningCount) => {
          const repo = new InMemoryChildAgentsRepo();
          const registry = new ChildRegistry(repo as never);

          for (let i = 0; i < runningCount; i++) {
            repo.insert({
              id: `child-${i}`,
              walletAddress: `0x${'b'.repeat(40)}`,
              containerId: `container-${i}`,
              parentId: 'parent-0',
              initialFunding: '1000000',
              status: 'running',
            });
          }

          const atCapacity = await registry.isAtCapacity();
          return atCapacity === (runningCount >= MAX_CHILDREN);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P19-c: getActive().length === min(runningCount, MAX_CHILDREN).
   * Validates: Requirement 10.4, 10.7
   */
  it('P19-c: getActive() length equals min(runningCount, 5)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 15 }),
        async (runningCount) => {
          const repo = new InMemoryChildAgentsRepo();
          const registry = new ChildRegistry(repo as never);

          for (let i = 0; i < runningCount; i++) {
            repo.insert({
              id: `child-${i}`,
              walletAddress: `0x${'c'.repeat(40)}`,
              containerId: `container-${i}`,
              parentId: 'parent-0',
              initialFunding: '1000000',
              status: 'running',
              spawnedAt: i,
            });
          }

          const active = await registry.getActive();
          return active.length === Math.min(runningCount, MAX_CHILDREN);
        }
      ),
      { numRuns: 50 }
    );
  });

  /**
   * P19-d: updateStatus to 'stopped' removes the child from getActive().
   * Validates: Requirement 10.3
   */
  it('P19-d: updating a running child to stopped removes it from active list', async () => {
    const repo = new InMemoryChildAgentsRepo();
    const registry = new ChildRegistry(repo as never);

    repo.insert({
      id: 'child-test',
      walletAddress: `0x${'d'.repeat(40)}`,
      containerId: 'container-test',
      parentId: 'parent-0',
      initialFunding: '1000000',
      status: 'running',
    });

    const beforeUpdate = await registry.getActive();
    expect(beforeUpdate.some((c) => c.id === 'child-test')).toBe(true);

    registry.updateStatus('child-test', 'stopped');

    const afterUpdate = await registry.getActive();
    expect(afterUpdate.some((c) => c.id === 'child-test')).toBe(false);
  });

  /**
   * P19-e: MAX_CHILDREN constant is always 5.
   * Validates: Requirement 10.4
   */
  it('P19-e: ChildRegistry.MAX_CHILDREN is exactly 5', () => {
    expect(ChildRegistry.MAX_CHILDREN).toBe(5);
  });
});

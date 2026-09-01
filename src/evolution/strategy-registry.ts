/**
 * Strategy Evolution Lab — Strategy Registry
 *
 * Higher-level operations wrapping EvolutionDatabase for strategy lifecycle management.
 * Provides config hashing, lineage tracking, status validation, and grouping helpers.
 *
 * Requirements: 1.4, 2.1, 2.2, 2.3
 */

import { createHash } from 'node:crypto';
import { EvolutionDatabase } from './evolution-database.js';
import type { StrategyRecord, StrategyStatus, StrategyParameters } from './types.js';
import { VALID_STATUSES } from './types.js';

export class StrategyRegistry {
  constructor(private db: EvolutionDatabase) {}

  /**
   * Compute SHA-256 hash of canonically serialized parameters JSON.
   * Canonical = sorted keys via JSON.stringify replacer.
   * Produces deterministic results: same parameters always yield the same hash.
   */
  computeConfigHash(parameters: StrategyParameters): string {
    const canonical = JSON.stringify(parameters, Object.keys(parameters).sort());
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * Validate a status value against VALID_STATUSES.
   * Returns true if the string is one of the 14 valid StrategyStatus values.
   */
  isValidStatus(status: string): status is StrategyStatus {
    return VALID_STATUSES.includes(status as StrategyStatus);
  }

  /**
   * Get the full lineage (ancestry chain) of a strategy.
   * Traverses parent_id until reaching null (root/baseline).
   * Returns array from oldest ancestor to the strategy itself.
   */
  getLineage(strategyId: string): StrategyRecord[] {
    const lineage: StrategyRecord[] = [];
    let currentId: string | null = strategyId;

    while (currentId !== null) {
      const record = this.db.getStrategy(currentId);
      if (!record) break;
      lineage.unshift(record);
      currentId = record.parent_id;
    }

    return lineage;
  }

  /**
   * Get direct children of a strategy (variants derived from it).
   * Filters all strategies whose parent_id matches the given strategyId.
   */
  getChildren(strategyId: string): StrategyRecord[] {
    const all = this.db.getAllStrategies();
    return all.filter((s) => s.parent_id === strategyId);
  }

  /**
   * Group all strategies by their current status.
   * Returns a Map<StrategyStatus, StrategyRecord[]> for CLI/API display.
   */
  groupByStatus(): Map<StrategyStatus, StrategyRecord[]> {
    const all = this.db.getAllStrategies();
    const grouped = new Map<StrategyStatus, StrategyRecord[]>();

    for (const status of VALID_STATUSES) {
      grouped.set(status, []);
    }

    for (const strategy of all) {
      const list = grouped.get(strategy.status);
      if (list) {
        list.push(strategy);
      }
    }

    return grouped;
  }

  /**
   * Count strategies per status (lightweight version of groupByStatus).
   * Returns a Record mapping each valid status to its count.
   */
  countByStatus(): Record<StrategyStatus, number> {
    const all = this.db.getAllStrategies();
    const counts = {} as Record<StrategyStatus, number>;

    for (const status of VALID_STATUSES) {
      counts[status] = 0;
    }

    for (const strategy of all) {
      if (counts[strategy.status] !== undefined) {
        counts[strategy.status]++;
      }
    }

    return counts;
  }
}

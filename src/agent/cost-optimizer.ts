/**
 * CostOptimizer — LLM call caching + adaptive interval
 *
 * Reduces LLM API costs by caching ActionPlan results keyed on
 * a hash of the current agent context state. Also provides an
 * adaptive interval recommendation based on opportunity presence.
 *
 * Revenue Optimization Engine — Task 1
 */

import { createHash } from 'node:crypto';
import type { ActionPlan } from './fallback-engine.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface CostOptimizerConfig {
  /** Maximum number of cached entries (LRU eviction). Default: 50 */
  cacheMaxEntries: number;
  /** Cache time-to-live in milliseconds. Default: 300_000 (5 min) */
  cacheTtlMs: number;
  /** Cycle interval when no opportunities detected (ms). Default: 300_000 */
  idleIntervalMs: number;
  /** Cycle interval when opportunities are active (ms). Default: 60_000 */
  activeIntervalMs: number;
}

export const DEFAULT_COST_OPTIMIZER_CONFIG: CostOptimizerConfig = {
  cacheMaxEntries: 50,
  cacheTtlMs: 300_000,
  idleIntervalMs: 300_000,
  activeIntervalMs: 60_000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

interface CacheEntry {
  plan: ActionPlan;
  timestamp: number;
}

/** Minimal state fields needed for context hashing */
export interface HashableState {
  tier: number;
  balanceUsdc: bigint;
  topOpportunities?: unknown[];
  aaveState?: 'idle' | 'deposited';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class CostOptimizer {
  private readonly cache: Map<string, CacheEntry> = new Map();
  private readonly config: CostOptimizerConfig;

  // Metrics
  private cacheHits = 0;
  private cacheMisses = 0;

  constructor(config?: Partial<CostOptimizerConfig>) {
    this.config = { ...DEFAULT_COST_OPTIMIZER_CONFIG, ...config };
  }

  /**
   * Generates a SHA256 hash of the current context state.
   * Only includes stable fields that determine LLM behavior:
   * - Survival tier
   * - Balance bucket (0-10, 10-50, 50-100, 100-500, 500+)
   * - Number of opportunities (0, 1-3, 4+)
   * - Aave position state (idle/deposited)
   */
  computeContextHash(state: HashableState): string {
    const balanceBucket = this.getBalanceBucket(state.balanceUsdc);
    const oppCount = state.topOpportunities?.length ?? 0;
    const oppBucket = oppCount === 0 ? '0' : oppCount <= 3 ? '1-3' : '4+';
    const aaveState = state.aaveState ?? 'idle';

    const input = `tier:${state.tier}|bal:${balanceBucket}|opp:${oppBucket}|aave:${aaveState}`;
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
  }

  /**
   * Retrieves a cached ActionPlan if the TTL is still valid.
   * Returns null on cache miss or TTL expiry.
   */
  getCachedPlan(hash: string): ActionPlan | null {
    const entry = this.cache.get(hash);
    if (!entry) {
      this.cacheMisses++;
      return null;
    }

    const age = Date.now() - entry.timestamp;
    if (age > this.config.cacheTtlMs) {
      // TTL expired — remove stale entry
      this.cache.delete(hash);
      this.cacheMisses++;
      return null;
    }

    // LRU refresh: delete and re-insert to move to end
    this.cache.delete(hash);
    this.cache.set(hash, entry);
    this.cacheHits++;
    return entry.plan;
  }

  /**
   * Stores an ActionPlan in cache. Evicts LRU entry if cache exceeds max size.
   */
  cachePlan(hash: string, plan: ActionPlan): void {
    // Evict LRU (first entry in Map) if at capacity
    if (this.cache.size >= this.config.cacheMaxEntries) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(hash, { plan, timestamp: Date.now() });
  }

  /**
   * Returns recommended cycle interval based on whether opportunities exist.
   * - Active (has opportunities): 60s for quick response
   * - Idle (no opportunities): 300s to save costs
   */
  getRecommendedInterval(hasOpportunities: boolean): number {
    return hasOpportunities
      ? this.config.activeIntervalMs
      : this.config.idleIntervalMs;
  }

  /** Get cache hit/miss metrics */
  getMetrics(): { hits: number; misses: number; size: number } {
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      size: this.cache.size,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getBalanceBucket(balance: bigint): string {
    const usdcAmount = balance / 1_000000n; // Convert to whole USDC
    if (usdcAmount < 10n) return '0-10';
    if (usdcAmount < 50n) return '10-50';
    if (usdcAmount < 100n) return '50-100';
    if (usdcAmount < 500n) return '100-500';
    return '500+';
  }
}

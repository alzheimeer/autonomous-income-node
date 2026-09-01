/**
 * ProposalConsolidator — Periodic cleanup and classification of research proposals
 *
 * Runs every 24 hours to:
 *   1. Classify all proposals by their current state
 *   2. Move terminal states (implemented, failed, descartada) to "already investigated"
 *   3. Generate a summary report for logging/Telegram
 *   4. Update the blacklist with titles that shouldn't be re-investigated
 *
 * Interval: Daily (24h) — chosen because:
 *   - Research cycles run hourly, so daily gives enough samples
 *   - Not too frequent to waste resources
 *   - Not too infrequent to let stale data accumulate
 *
 * Requirements: FIX-028 — Prevent re-investigation of processed proposals
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { KnowledgeBaseRepository, KnowledgeBaseRow } from '../state/repositories/knowledge-base.repo.js';
import type { OpportunityStatus } from '../research/comms/protocol.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface ConsolidationConfig {
  /** Interval between consolidations (ms). Default: 86_400_000 (24 hours) */
  intervalMs: number;
  /** Path to the blacklist file. Default: data/research-blacklist.json */
  blacklistPath: string;
  /** Path to the consolidated history file. Default: data/proposal-history.json */
  historyPath: string;
  /** Max age for "stale" proposals before auto-discard (ms). Default: 7 days */
  staleThresholdMs: number;
}

export interface ProposalSummary {
  id: string;
  title: string;
  status: OpportunityStatus;
  score: number;
  source: string;
  discoveredAt: number;
  lastEvaluatedAt: number;
  reason?: string;
}

export interface ConsolidationReport {
  timestamp: number;
  period: { start: number; end: number };
  totals: {
    total: number;
    implemented: number;
    failed: number;
    pending: number;
    needsSetup: number;
    stale: number;
    discarded: number;
  };
  implemented: ProposalSummary[];
  failed: ProposalSummary[];
  pending: ProposalSummary[];
  needsManualSetup: ProposalSummary[];
  staleDiscarded: ProposalSummary[];
  newlyBlacklisted: string[];
}

export interface BlacklistEntry {
  title: string;
  reason: string;
  addedAt: number;
  originalId: string;
}

export interface ProposalHistory {
  lastConsolidation: number;
  totalProcessed: number;
  implemented: ProposalSummary[];
  failed: ProposalSummary[];
  discarded: ProposalSummary[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[ProposalConsolidator]';

const DEFAULT_CONFIG: ConsolidationConfig = {
  intervalMs: 24 * 60 * 60 * 1_000,           // 24 hours
  blacklistPath: 'data/research-blacklist.json',
  historyPath: 'data/proposal-history.json',
  staleThresholdMs: 7 * 24 * 60 * 60 * 1_000, // 7 days
};

/** Terminal states — proposals in these states should be moved to history */
const TERMINAL_STATES: OpportunityStatus[] = [
  'implementada',
  'failed_no_revenue',
  'descartada',
];

/** Active states — proposals still being processed */
const ACTIVE_STATES: OpportunityStatus[] = [
  'new',
  'activa',
  'profundización',
  'pendiente_aprobacion',
  'aprobada',
  'code_generated',
  'revenue_tracking',
];

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class ProposalConsolidator {
  private readonly config: ConsolidationConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private lastConsolidation: number = 0;

  constructor(
    private readonly knowledgeRepo: KnowledgeBaseRepository,
    config?: Partial<ConsolidationConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.loadLastConsolidation();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Start the periodic consolidation loop.
   * Runs immediately if more than 24h since last consolidation.
   */
  start(): void {
    if (this.intervalHandle) return;

    console.log(
      `${LOG_PREFIX} Started (interval: ${this.config.intervalMs / 3_600_000}h, ` +
      `stale threshold: ${this.config.staleThresholdMs / 86_400_000} days)`
    );

    // Check if we should run immediately
    const timeSinceLast = Date.now() - this.lastConsolidation;
    if (timeSinceLast >= this.config.intervalMs) {
      console.log(`${LOG_PREFIX} Last consolidation was ${Math.round(timeSinceLast / 3_600_000)}h ago, running now...`);
      this.consolidate().catch(err => {
        console.error(`${LOG_PREFIX} Initial consolidation failed:`, (err as Error).message);
      });
    } else {
      const nextIn = Math.round((this.config.intervalMs - timeSinceLast) / 3_600_000);
      console.log(`${LOG_PREFIX} Next consolidation in ${nextIn}h`);
    }

    // Start interval
    this.intervalHandle = setInterval(() => {
      this.consolidate().catch(err => {
        console.error(`${LOG_PREFIX} Consolidation cycle failed:`, (err as Error).message);
      });
    }, this.config.intervalMs);
  }

  /** Stop the periodic consolidation loop. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log(`${LOG_PREFIX} Stopped.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core consolidation logic
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run a full consolidation cycle.
   *
   * Steps:
   *   1. Fetch all proposals from knowledge_base
   *   2. Classify by status
   *   3. Identify stale proposals (> 7 days without progress)
   *   4. Mark stale as 'descartada'
   *   5. Move terminal states to history file
   *   6. Add failed/discarded titles to blacklist
   *   7. Generate and return report
   */
  async consolidate(): Promise<ConsolidationReport> {
    const startTime = Date.now();
    const periodStart = this.lastConsolidation || startTime - this.config.intervalMs;

    console.log(`${LOG_PREFIX} Starting consolidation cycle...`);

    // 1. Fetch all proposals
    const allProposals = this.fetchAllProposals();
    console.log(`${LOG_PREFIX} Found ${allProposals.length} total proposals`);

    // 2. Classify by status
    const classified = this.classifyProposals(allProposals);

    // 3. Identify stale proposals
    const staleProposals = this.identifyStaleProposals(classified.active);
    
    // 4. Mark stale as 'descartada'
    for (const stale of staleProposals) {
      this.knowledgeRepo.updateStatus(stale.id, 'descartada');
      stale.status = 'descartada';
      stale.reason = `Stale: no progress for ${Math.round(this.config.staleThresholdMs / 86_400_000)} days`;
    }

    // 5. Load and update history
    const history = this.loadHistory();
    const newlyTerminal = [
      ...classified.terminal,
      ...staleProposals,
    ];

    // Separate by outcome
    const newImplemented = newlyTerminal.filter(p => p.status === 'implementada');
    const newFailed = newlyTerminal.filter(p => 
      p.status === 'failed_no_revenue' || 
      (p.status === 'descartada' && p.reason?.includes('Stale'))
    );
    const newDiscarded = newlyTerminal.filter(p => 
      p.status === 'descartada' && !p.reason?.includes('Stale')
    );

    // Add to history (avoid duplicates)
    const existingIds = new Set([
      ...history.implemented.map(p => p.id),
      ...history.failed.map(p => p.id),
      ...history.discarded.map(p => p.id),
    ]);

    for (const p of newImplemented) {
      if (!existingIds.has(p.id)) {
        history.implemented.push(p);
        history.totalProcessed++;
      }
    }
    for (const p of newFailed) {
      if (!existingIds.has(p.id)) {
        history.failed.push(p);
        history.totalProcessed++;
      }
    }
    for (const p of newDiscarded) {
      if (!existingIds.has(p.id)) {
        history.discarded.push(p);
        history.totalProcessed++;
      }
    }

    history.lastConsolidation = startTime;

    // 6. Update blacklist with failed/discarded titles
    const blacklist = this.loadBlacklist();
    const newlyBlacklisted: string[] = [];

    for (const proposal of [...newFailed, ...newDiscarded]) {
      const normalizedTitle = this.normalizeTitle(proposal.title);
      const alreadyBlacklisted = blacklist.some(b => 
        this.normalizeTitle(b.title) === normalizedTitle
      );

      if (!alreadyBlacklisted) {
        blacklist.push({
          title: proposal.title,
          reason: proposal.reason ?? `Status: ${proposal.status}`,
          addedAt: startTime,
          originalId: proposal.id,
        });
        newlyBlacklisted.push(proposal.title);
      }
    }

    // 7. Save updated files
    this.saveHistory(history);
    this.saveBlacklist(blacklist);
    this.saveLastConsolidation(startTime);

    // Build report
    const report: ConsolidationReport = {
      timestamp: startTime,
      period: { start: periodStart, end: startTime },
      totals: {
        total: allProposals.length,
        implemented: classified.implemented.length,
        failed: classified.failed.length,
        pending: classified.active.length - staleProposals.length,
        needsSetup: classified.needsSetup.length,
        stale: staleProposals.length,
        discarded: classified.discarded.length + staleProposals.length,
      },
      implemented: classified.implemented,
      failed: classified.failed,
      pending: classified.active.filter(p => !staleProposals.includes(p)),
      needsManualSetup: classified.needsSetup,
      staleDiscarded: staleProposals,
      newlyBlacklisted,
    };

    // Log summary
    const duration = Date.now() - startTime;
    console.log(
      `${LOG_PREFIX} Consolidation complete in ${duration}ms:\n` +
      `  Total: ${report.totals.total}\n` +
      `  ✅ Implemented: ${report.totals.implemented}\n` +
      `  ❌ Failed: ${report.totals.failed}\n` +
      `  ⏳ Pending: ${report.totals.pending}\n` +
      `  🔧 Needs Setup: ${report.totals.needsSetup}\n` +
      `  ⏰ Stale (now discarded): ${report.totals.stale}\n` +
      `  🗑️ Discarded: ${report.totals.discarded}\n` +
      `  📝 Newly blacklisted: ${report.newlyBlacklisted.length}`
    );

    return report;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Proposal fetching and classification
  // ─────────────────────────────────────────────────────────────────────────────

  private fetchAllProposals(): ProposalSummary[] {
    const proposals: ProposalSummary[] = [];

    // Fetch from each status
    for (const status of [...TERMINAL_STATES, ...ACTIVE_STATES]) {
      try {
        const rows = this.knowledgeRepo.getByStatus(status, 1000);
        for (const row of rows) {
          proposals.push(this.rowToSummary(row, status));
        }
      } catch (err) {
        console.warn(`${LOG_PREFIX} Failed to fetch status ${status}:`, (err as Error).message);
      }
    }

    return proposals;
  }

  private rowToSummary(row: KnowledgeBaseRow, status: OpportunityStatus): ProposalSummary {
    return {
      id: row.id,
      title: row.protocol_name ?? row.title ?? 'Unknown',
      status,
      score: row.viability_score ?? 0,
      source: row.source ?? 'unknown',
      discoveredAt: row.discovered_at ?? Date.now(),
      lastEvaluatedAt: row.last_evaluated_at ?? Date.now(),
    };
  }

  private classifyProposals(proposals: ProposalSummary[]): {
    terminal: ProposalSummary[];
    active: ProposalSummary[];
    implemented: ProposalSummary[];
    failed: ProposalSummary[];
    discarded: ProposalSummary[];
    needsSetup: ProposalSummary[];
  } {
    const terminal = proposals.filter(p => TERMINAL_STATES.includes(p.status));
    const active = proposals.filter(p => ACTIVE_STATES.includes(p.status));
    
    return {
      terminal,
      active,
      implemented: proposals.filter(p => p.status === 'implementada'),
      failed: proposals.filter(p => p.status === 'failed_no_revenue'),
      discarded: proposals.filter(p => p.status === 'descartada'),
      // "pendiente_aprobacion" likely means needs manual setup/approval
      needsSetup: proposals.filter(p => p.status === 'pendiente_aprobacion'),
    };
  }

  private identifyStaleProposals(activeProposals: ProposalSummary[]): ProposalSummary[] {
    const now = Date.now();
    return activeProposals.filter(p => {
      const age = now - p.lastEvaluatedAt;
      return age > this.config.staleThresholdMs;
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // File persistence
  // ─────────────────────────────────────────────────────────────────────────────

  private loadHistory(): ProposalHistory {
    const path = resolve(process.cwd(), this.config.historyPath);
    try {
      if (existsSync(path)) {
        const content = readFileSync(path, 'utf-8');
        return JSON.parse(content) as ProposalHistory;
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to load history:`, (err as Error).message);
    }

    return {
      lastConsolidation: 0,
      totalProcessed: 0,
      implemented: [],
      failed: [],
      discarded: [],
    };
  }

  private saveHistory(history: ProposalHistory): void {
    const path = resolve(process.cwd(), this.config.historyPath);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(history, null, 2), 'utf-8');
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to save history:`, (err as Error).message);
    }
  }

  private loadBlacklist(): BlacklistEntry[] {
    const path = resolve(process.cwd(), this.config.blacklistPath);
    try {
      if (existsSync(path)) {
        const content = readFileSync(path, 'utf-8');
        return JSON.parse(content) as BlacklistEntry[];
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to load blacklist:`, (err as Error).message);
    }
    return [];
  }

  private saveBlacklist(blacklist: BlacklistEntry[]): void {
    const path = resolve(process.cwd(), this.config.blacklistPath);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(blacklist, null, 2), 'utf-8');
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to save blacklist:`, (err as Error).message);
    }
  }

  private loadLastConsolidation(): void {
    const history = this.loadHistory();
    this.lastConsolidation = history.lastConsolidation;
  }

  private saveLastConsolidation(timestamp: number): void {
    this.lastConsolidation = timestamp;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  private normalizeTitle(title: string): string {
    return title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .trim();
  }

  /**
   * Get current blacklist for use by Research Agent dedup.
   */
  getBlacklist(): BlacklistEntry[] {
    return this.loadBlacklist();
  }

  /**
   * Get the last consolidation report (cached).
   */
  getLastReport(): ConsolidationReport | null {
    // Could cache the last report in memory, but for now just return null
    return null;
  }

  /**
   * Manually trigger a consolidation (for testing or admin commands).
   */
  async runNow(): Promise<ConsolidationReport> {
    return this.consolidate();
  }
}

// Export factory function
export function createProposalConsolidator(
  knowledgeRepo: KnowledgeBaseRepository,
  config?: Partial<ConsolidationConfig>,
): ProposalConsolidator {
  return new ProposalConsolidator(knowledgeRepo, config);
}

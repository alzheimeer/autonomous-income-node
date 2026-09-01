/**
 * Proposal Watcher — Monitors ./investigacion/ for Research Agent proposals
 *
 * This module watches for strategy_proposal files from the Research Agent
 * and passes them to the AdaptiveEvolver for implementation.
 *
 * Protocol:
 * - Research Agent writes: {timestamp}_strategy_proposal_{id}.json
 * - Operator Agent writes: {timestamp}_strategy_proposal_{id}_ack.json
 *
 * Tasks: 10.1, 10.2
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { AdaptiveEvolver } from '../intelligence/adaptive-evolver.js';
import type { StrategyProposal, AckMessage, StrategyProposalPayload } from '../research/comms/protocol.js';

// ── Configuration ────────────────────────────────────────────────────────────

const LOG_PREFIX = '[ProposalWatcher]';

export interface ProposalWatcherConfig {
  /** Directory to watch for proposals */
  watchDir: string;
  /** Polling interval in milliseconds (default: 30000 = 30s) */
  pollIntervalMs: number;
  /** Maximum age of proposals to process (default: 24 hours) */
  maxAgeMs: number;
}

const DEFAULT_CONFIG: ProposalWatcherConfig = {
  watchDir: './investigacion',
  pollIntervalMs: 30_000,
  maxAgeMs: 24 * 60 * 60 * 1_000, // 24 hours
};

// ── Types ────────────────────────────────────────────────────────────────────

interface ProcessedFile {
  filename: string;
  processedAt: number;
  status: 'implemented' | 'failed';
}

// ── ProposalWatcher Class ────────────────────────────────────────────────────

export class ProposalWatcher {
  private readonly config: ProposalWatcherConfig;
  private readonly processedFiles = new Map<string, ProcessedFile>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private adaptiveEvolver: AdaptiveEvolver | null = null;

  constructor(config: Partial<ProposalWatcherConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Ensure watch directory exists
    if (!existsSync(this.config.watchDir)) {
      mkdirSync(this.config.watchDir, { recursive: true });
      console.log(`${LOG_PREFIX} Created watch directory: ${this.config.watchDir}`);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Start watching for strategy proposals.
   * @param evolver The AdaptiveEvolver to queue proposals to
   */
  start(evolver: AdaptiveEvolver): void {
    if (this.intervalHandle) {
      console.log(`${LOG_PREFIX} Already running`);
      return;
    }

    this.adaptiveEvolver = evolver;

    console.log(
      `${LOG_PREFIX} Started watching ${this.config.watchDir} ` +
      `(poll every ${this.config.pollIntervalMs / 1000}s)`
    );

    // Initial scan
    this.scanForProposals();

    // Set up polling interval
    this.intervalHandle = setInterval(() => {
      this.scanForProposals();
    }, this.config.pollIntervalMs);
  }

  /**
   * Stop watching for proposals.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log(`${LOG_PREFIX} Stopped`);
    }
    this.adaptiveEvolver = null;
  }

  // ── Scanning ───────────────────────────────────────────────────────────────

  /**
   * Scan the watch directory for new strategy proposal files.
   */
  private scanForProposals(): void {
    try {
      const files = readdirSync(this.config.watchDir);
      
      // Filter for strategy proposal files
      const proposalFiles = files.filter(f => 
        f.includes('_strategy_proposal_') && 
        f.endsWith('.json') &&
        !f.includes('_ack.json')
      );

      for (const filename of proposalFiles) {
        // Skip if already processed
        if (this.processedFiles.has(filename)) {
          continue;
        }

        // Skip if ACK file already exists
        const ackFilename = filename.replace('.json', '_ack.json');
        if (files.includes(ackFilename)) {
          // Mark as processed to avoid checking again
          this.processedFiles.set(filename, {
            filename,
            processedAt: Date.now(),
            status: 'implemented',
          });
          continue;
        }

        this.processProposalFile(filename);
      }

      // Cleanup old entries from processedFiles (older than maxAgeMs)
      const cutoff = Date.now() - this.config.maxAgeMs;
      const keysToDelete: string[] = [];
      this.processedFiles.forEach((value, key) => {
        if (value.processedAt < cutoff) {
          keysToDelete.push(key);
        }
      });
      keysToDelete.forEach(key => this.processedFiles.delete(key));
    } catch (err) {
      // Directory might not exist or be inaccessible — non-fatal
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`${LOG_PREFIX} Scan error:`, (err as Error).message);
      }
    }
  }

  /**
   * Process a single strategy proposal file.
   */
  private processProposalFile(filename: string): void {
    const filePath = join(this.config.watchDir, filename);
    let status: 'implemented' | 'failed' = 'failed';
    let error: string | null = null;

    try {
      console.log(`${LOG_PREFIX} Processing proposal: ${filename}`);

      // Read and parse the proposal file
      const content = readFileSync(filePath, 'utf-8');
      const proposal = JSON.parse(content) as StrategyProposal;

      // Validate proposal structure
      if (!this.isValidProposal(proposal)) {
        throw new Error('Invalid proposal structure');
      }

      // Check age — skip if too old
      const proposalTime = new Date(proposal.timestamp).getTime();
      if (Date.now() - proposalTime > this.config.maxAgeMs) {
        console.log(`${LOG_PREFIX} Skipping old proposal (age > ${this.config.maxAgeMs}ms): ${filename}`);
        error = 'Proposal too old';
        status = 'failed';
      } else if (this.adaptiveEvolver) {
        // Queue the proposal for the AdaptiveEvolver
        this.adaptiveEvolver.queueResearchProposal({
          opportunityId: proposal.payload.opportunityId,
          title: proposal.payload.title,
          source: 'research-agent',
          estimatedRevenue: 'TBD',
          priority: proposal.priority === 'P4' ? 'P3' : proposal.priority, // Map P4 to P3 (AdaptiveEvolver only accepts P1-P3)
        });

        console.log(
          `${LOG_PREFIX} Queued proposal: "${proposal.payload.title}" ` +
          `(priority: ${proposal.priority}, id: ${proposal.payload.opportunityId})`
        );
        status = 'implemented';
      } else {
        error = 'AdaptiveEvolver not available';
        console.warn(`${LOG_PREFIX} ${error}`);
      }
    } catch (err) {
      error = (err as Error).message;
      console.error(`${LOG_PREFIX} Failed to process ${filename}:`, error);
    }

    // Mark as processed
    this.processedFiles.set(filename, {
      filename,
      processedAt: Date.now(),
      status,
    });

    // Write ACK file
    this.writeAckFile(filename, status, error);
  }

  /**
   * Validate that a parsed object is a valid StrategyProposal.
   */
  private isValidProposal(obj: unknown): obj is StrategyProposal {
    if (typeof obj !== 'object' || obj === null) return false;
    const proposal = obj as Record<string, unknown>;

    if (proposal.type !== 'strategy_proposal') return false;
    if (typeof proposal.timestamp !== 'string') return false;
    if (!['P1', 'P2', 'P3', 'P4'].includes(proposal.priority as string)) return false;
    
    const payload = proposal.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') return false;
    if (typeof payload.opportunityId !== 'string') return false;
    if (typeof payload.title !== 'string') return false;

    return true;
  }

  // ── ACK Files ──────────────────────────────────────────────────────────────

  /**
   * Write an acknowledgment file for a processed proposal.
   * Format: {timestamp}_strategy_proposal_{id}_ack.json
   */
  private writeAckFile(
    originalFilename: string,
    status: 'implemented' | 'failed',
    error: string | null
  ): void {
    try {
      // Extract the original ID from the filename
      // Format: {timestamp}_strategy_proposal_{id}.json
      const match = originalFilename.match(/_strategy_proposal_([^.]+)\.json$/);
      const originalId = match ? match[1] : 'unknown';

      const ackFilename = originalFilename.replace('.json', '_ack.json');
      const ackPath = join(this.config.watchDir, ackFilename);

      const ackMessage: AckMessage = {
        type: 'ack',
        originalId,
        status,
        error,
      };

      writeFileSync(ackPath, JSON.stringify(ackMessage, null, 2), 'utf-8');
      console.log(`${LOG_PREFIX} Wrote ACK: ${ackFilename} (status: ${status})`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to write ACK:`, (err as Error).message);
    }
  }

  // ── Manual ACK ─────────────────────────────────────────────────────────────

  /**
   * Manually write an ACK file for a specific opportunity.
   * Used when the operator implements or rejects a proposal outside the normal flow.
   */
  writeManualAck(
    opportunityId: string,
    status: 'implemented' | 'failed',
    error: string | null = null
  ): void {
    const timestamp = Date.now();
    const ackFilename = `${timestamp}_strategy_proposal_${opportunityId}_ack.json`;
    const ackPath = join(this.config.watchDir, ackFilename);

    const ackMessage: AckMessage = {
      type: 'ack',
      originalId: opportunityId,
      status,
      error,
    };

    try {
      writeFileSync(ackPath, JSON.stringify(ackMessage, null, 2), 'utf-8');
      console.log(`${LOG_PREFIX} Wrote manual ACK: ${ackFilename} (status: ${status})`);
    } catch (err) {
      console.error(`${LOG_PREFIX} Failed to write manual ACK:`, (err as Error).message);
    }
  }

  // ── Getters ────────────────────────────────────────────────────────────────

  /**
   * Get the count of processed proposals.
   */
  getProcessedCount(): { total: number; implemented: number; failed: number } {
    let implemented = 0;
    let failed = 0;

    this.processedFiles.forEach((entry) => {
      if (entry.status === 'implemented') implemented++;
      else failed++;
    });

    return { total: this.processedFiles.size, implemented, failed };
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.intervalHandle !== null;
  }
}

// ── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a ProposalWatcher instance with default or custom configuration.
 */
export function createProposalWatcher(config?: Partial<ProposalWatcherConfig>): ProposalWatcher {
  return new ProposalWatcher(config);
}

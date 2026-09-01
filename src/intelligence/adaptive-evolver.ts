/**
 * AdaptiveEvolver — Bridge between KnowledgeAcquirer and SelfModModule
 *
 * This module is the "adaptive brain" that:
 * 1. Periodically reviews actionable entries from KnowledgeAcquirer
 * 2. For each non-implemented opportunity, generates an implementation plan via LLM
 * 3. Delegates the modification to SelfModModule (backup → sandbox → test → apply)
 * 4. Marks opportunities as "implemented" or "failed_implementation"
 *
 * Safety:
 *   - Starts in dryRun mode by default (only logs what it WOULD do)
 *   - Respects SelfModModule rate limit (3 modifications / 24h)
 *   - Respects tier gate (Tier 3+ required for actual modifications)
 *
 * Requirements: 9.x, 10.x (bridge between discovery and self-improvement)
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type { McpClient } from '../mcp/client/mcp-client.js';
import type { IKnowledgeAcquirer, KnowledgeEntry } from './knowledge-acquirer.js';
import type { SelfModModule } from '../self-mod/index.js';
import type { KnowledgeBaseRepository } from '../state/repositories/knowledge-base.repo.js';
import { FeasibilityAssessor, type FeasibilityAssessment, type FeasibilityCategory } from './feasibility-assessor.js';
import { ProposalRefiner, type RefinedProposal } from './proposal-refiner.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface AdaptiveEvolverConfig {
  /** Interval between evaluations (ms). Default: 3600_000 (1 hour) */
  evaluationIntervalMs: number;
  /** Maximum implementations per cycle. Default: 1 */
  maxImplementationsPerCycle: number;
  /** Minimum score to attempt implementation. Default: 75 */
  minScoreForImplementation: number;
  /** If true, only generates the plan but does NOT apply (dry-run). Default: true */
  dryRun: boolean;
}

export interface ImplementationPlan {
  opportunityId: string;
  protocolName: string;
  type: string;
  targetFile: string;
  description: string;
  generatedCode: string;
  testDescription: string;
}

export type ImplementationStatus =
  | 'implemented'
  | 'failed'
  | 'dry_run'
  | 'error'
  | 'skipped'
  | 'needs_manual_setup'  // FIX-027: New status for opportunities requiring setup
  | 'not_feasible'        // FIX-027: Cannot implement with current stack
  | 'refined';            // FIX-029: Proposal was refined and re-queued

export interface ImplementationResult {
  opportunityId: string;
  status: ImplementationStatus;
  plan?: ImplementationPlan;
  error?: string;
  /** FIX-027: Feasibility assessment when status is needs_manual_setup */
  feasibilityAssessment?: FeasibilityAssessment;
  /** FIX-029: Refined proposal when status is 'refined' */
  refinedProposal?: RefinedProposal;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[AdaptiveEvolver]';

// ═══════════════════════════════════════════════════════════════════════════════
// Research Proposal Queue types
// ═══════════════════════════════════════════════════════════════════════════════

/** Proposal ingested from the Research Agent via ./investigacion/ */
export interface ResearchProposal {
  opportunityId: string;
  title: string;
  source: string;
  estimatedRevenue: string;
  priority: 'P1' | 'P2' | 'P3';
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Attempt to repair a truncated JSON string.
 * When LLM output is cut off mid-stream, the JSON object may be incomplete.
 * This function closes open strings, arrays, and objects so JSON.parse can succeed.
 * The repaired value may have partial data (e.g. truncated generatedCode) but at least
 * allows the caller to check which fields exist before discarding.
 */
function repairTruncatedJson(raw: string): string {
  // If it already parses, do nothing
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    // Continue with repair
  }

  let s = raw.trimEnd();

  // Close any open string by adding a quote if we're inside one
  // Count unescaped double quotes — odd count means we're in a string
  let inString = false;
  let escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') inString = !inString;
  }
  if (inString) {
    // Escape any trailing backslash before closing
    s = s.replace(/\\$/, '') + '"';
  }

  // Count unclosed braces and brackets
  const stack: string[] = [];
  inString = false;
  escaped = false;
  for (const ch of s) {
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }

  // Remove trailing comma before closing (invalid JSON)
  s = s.replace(/,\s*$/, '');

  // Close unclosed structures in reverse order
  while (stack.length > 0) {
    s += stack.pop();
  }

  return s;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class AdaptiveEvolver {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private evaluationInProgress = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Set of opportunity IDs that have been processed (implemented or failed).
   * Prevents re-processing the same opportunity in the same session.
   */
  private readonly processedIds = new Set<string>();

  /**
   * Map of target file paths to last attempt timestamp.
   * Prevents hammering the same file repeatedly in short succession.
   */
  private readonly fileAttemptTimes = new Map<string, number>();

  /** Cooldown period before retrying the same file (1 hour) */
  private readonly FILE_RETRY_COOLDOWN_MS = 60 * 60 * 1_000;

  /**
   * Queue of research proposals received from the Research Agent file watcher.
   * Proposals are processed on the next evaluateAndImplement() cycle.
   */
  private readonly researchQueue: ResearchProposal[] = [];

  /** Recent implementation results — exposed for DailyReport */
  private readonly recentResults: Array<{
    title: string;
    status: ImplementationStatus;
    targetFile?: string;
    error?: string;
    ts: number;
  }> = [];

  /**
   * FIX-027: Opportunities that require manual setup.
   * Queued separately so they don't block automatable opportunities.
   */
  private readonly manualSetupQueue: Array<{
    opportunity: KnowledgeEntry;
    assessment: FeasibilityAssessment;
    queuedAt: number;
  }> = [];

  /** FIX-027: FeasibilityAssessor instance */
  private readonly feasibilityAssessor: FeasibilityAssessor;

  /** FIX-029: ProposalRefiner instance for second-chance evaluation */
  private readonly proposalRefiner: ProposalRefiner;

  /** FIX-029: Queue of refined proposals ready for re-evaluation */
  private readonly refinedQueue: Array<{
    original: KnowledgeEntry;
    refined: RefinedProposal;
    queuedAt: number;
  }> = [];

  constructor(
    private readonly config: AdaptiveEvolverConfig,
    private readonly knowledgeAcquirer: IKnowledgeAcquirer,
    private readonly selfModModule: SelfModModule,
    private readonly llmClient: McpClient,
    private readonly knowledgeRepo: KnowledgeBaseRepository,
  ) {
    // FIX-027: Initialize feasibility assessor
    this.feasibilityAssessor = new FeasibilityAssessor(llmClient);
    // FIX-029: Initialize proposal refiner
    this.proposalRefiner = new ProposalRefiner(knowledgeRepo, llmClient, {
      minScoreForRefinement: 50,  // Attempt refinement for proposals with score >= 50
      minRefinedScore: 65,        // Accept refinement if new score >= 65
      maxRefinementAttempts: 2,   // Max 2 attempts per proposal
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /** Start the periodic evaluation loop. */
  start(): void {
    if (this.intervalHandle) return;

    console.log(
      `${LOG_PREFIX} Started (interval: ${this.config.evaluationIntervalMs}ms, ` +
      `dryRun: ${this.config.dryRun}, minScore: ${this.config.minScoreForImplementation}).`,
    );

    this.intervalHandle = setInterval(() => {
      this.evaluateAndImplement().catch((err) => {
        console.error(`${LOG_PREFIX} Evaluation cycle error:`, (err as Error).message);
      });
    }, this.config.evaluationIntervalMs);
  }

  /** Stop the periodic evaluation loop. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log(`${LOG_PREFIX} Stopped.`);
    }
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  /**
   * Returns the last N implementation results for reporting (e.g. DailyReport).
   * Results are trimmed to the last 24h and capped at 20 entries.
   */
  getRecentResults(limit = 10): typeof this.recentResults {
    const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
    return this.recentResults
      .filter(r => r.ts >= cutoff)
      .slice(-limit);
  }

  /**
   * FIX-027: Returns opportunities that require manual setup.
   * Useful for generating reports or Telegram notifications.
   */
  getManualSetupQueue(): ReadonlyArray<{
    opportunity: KnowledgeEntry;
    assessment: FeasibilityAssessment;
    queuedAt: number;
  }> {
    return this.manualSetupQueue;
  }

  /**
   * FIX-027: Mark a manual setup opportunity as completed.
   * Call this after manual setup is done to re-queue for implementation.
   */
  markManualSetupComplete(opportunityId: string): boolean {
    const index = this.manualSetupQueue.findIndex(
      item => item.opportunity.id === opportunityId
    );
    if (index === -1) return false;

    const [item] = this.manualSetupQueue.splice(index, 1);
    
    // Re-queue for implementation (remove from processed set)
    this.processedIds.delete(opportunityId);
    
    console.log(
      `${LOG_PREFIX} Manual setup marked complete for "${item.opportunity.protocolName}". ` +
      `Will attempt implementation on next cycle.`
    );
    
    return true;
  }

  /**
   * FIX-029: Returns proposals that were refined and are ready for re-evaluation.
   */
  getRefinedQueue(): ReadonlyArray<{
    original: KnowledgeEntry;
    refined: RefinedProposal;
    queuedAt: number;
  }> {
    return this.refinedQueue;
  }

  /**
   * FIX-029: Get all refined proposals (including already processed ones).
   */
  getAllRefinedProposals(): RefinedProposal[] {
    return this.proposalRefiner.getRefinedProposals();
  }

  /**
   * FIX-029: Accept a refined proposal for implementation.
   * Creates a new KnowledgeEntry with the refined data.
   */
  acceptRefinedProposal(originalId: string): boolean {
    const index = this.refinedQueue.findIndex(
      item => item.original.id === originalId
    );
    if (index === -1) return false;

    const [item] = this.refinedQueue.splice(index, 1);
    const refined = item.refined;

    // Create a new entry for the refined proposal
    const newId = `refined-${originalId}-${Date.now()}`;
    const newEntry: KnowledgeEntry = {
      id: newId,
      protocolName: refined.refinedTitle,
      type: item.original.type,
      estimatedApyBps: item.original.estimatedApyBps,
      requiredCapitalUsdc: item.original.requiredCapitalUsdc,
      riskFactors: item.original.riskFactors,
      viabilityScore: refined.refinedScore,
      source: `refined:${item.original.source}`,
      status: 'actionable',
      discoveredAt: Date.now(),
      lastEvaluatedAt: Date.now(),
      description: `${refined.refinedDescription}\n\nMilestones:\n${
        refined.milestones.map(m => `- ${m.description} (${m.estimatedDays}d): ${m.metric}`).join('\n')
      }`,
    };

    // Insert into knowledge base
    this.knowledgeRepo.insert({
      id: newEntry.id,
      source: newEntry.source,
      type: newEntry.type,
      title: newEntry.protocolName,
      description: newEntry.description,
      protocol_name: newEntry.protocolName,
      estimated_yield_bps: newEntry.estimatedApyBps,
      risk_level: 'medium',
      required_capital_usdc: String(newEntry.requiredCapitalUsdc),
      viability_score: newEntry.viabilityScore,
      status: 'actionable',
      discovered_at: newEntry.discoveredAt,
      last_evaluated_at: newEntry.lastEvaluatedAt,
    });

    console.log(
      `${LOG_PREFIX} ✅ Accepted refined proposal "${refined.refinedTitle}" as new entry ${newId}`
    );

    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Research Queue
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Enqueue a research proposal from the file watcher.
   * It will be processed on the next evaluateAndImplement() cycle,
   * or immediately if the queue is new and the evolver is idle.
   */
  queueResearchProposal(proposal: ResearchProposal): void {
    // Avoid duplicates in the queue
    if (this.processedIds.has(proposal.opportunityId)) {
      console.log(`${LOG_PREFIX} Proposal already processed: ${proposal.title}`);
      return;
    }
    const alreadyQueued = this.researchQueue.some(p => p.opportunityId === proposal.opportunityId);
    if (alreadyQueued) return;

    // Filter out low-value proposals that won't generate income
    const lowValuePatterns = [
      /^GitHub trending:/i,         // GitHub trending repos don't generate income
      /system-design-primer/i,      // Educational repos
      /^Browser automation:/i,      // Web scraping guides (no direct income)
      /What Is Web Scraping/i,      // Educational content
      /comparison.*review/i,        // Review articles
      /buyer.*guide/i,              // Buying guides
    ];

    const isLowValue = lowValuePatterns.some(pattern => pattern.test(proposal.title));
    console.log(`${LOG_PREFIX} Filter check: title="${proposal.title}", isLowValue=${isLowValue}, priority=${proposal.priority}`);
    
    // Filter out low-value proposals regardless of priority
    // The Research Agent marks everything as P1, so we can't rely on priority
    if (isLowValue) {
      console.log(`${LOG_PREFIX} Skipping low-value proposal: "${proposal.title}"`);
      this.processedIds.add(proposal.opportunityId); // Mark as processed to avoid retry
      return;
    }

    // Calculate expected target file path for deduplication
    const sanitizedName = proposal.title
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const expectedFile = `data/auto-generated/${sanitizedName}.ts`;

    // Check if we recently attempted this file
    const lastAttempt = this.fileAttemptTimes.get(expectedFile);
    if (lastAttempt && Date.now() - lastAttempt < this.FILE_RETRY_COOLDOWN_MS) {
      const cooldownRemaining = Math.round((this.FILE_RETRY_COOLDOWN_MS - (Date.now() - lastAttempt)) / 60_000);
      console.log(`${LOG_PREFIX} File "${expectedFile}" in cooldown (${cooldownRemaining}m remaining), skipping proposal`);
      return;
    }

    this.researchQueue.push(proposal);
    console.log(`${LOG_PREFIX} Queued research proposal: "${proposal.title}" (queue size: ${this.researchQueue.length})`);

    // Debounced immediate evaluation — cancels previous timer if called repeatedly
    // so we batch multiple proposals arriving at once into a single evaluation cycle
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (!this.evaluationInProgress) {
        this.evaluateAndImplement().catch((err) => {
          console.error(`${LOG_PREFIX} Immediate evaluation error:`, (err as Error).message);
        });
      }
    }, 5_000); // 5s window to batch proposals arriving at once
  }

  /**
   * Check if a proposal has high income potential based on keywords
   */
  private hasIncomePoential(title: string): boolean {
    const incomePatterns = [
      /DeFi|yield|APY|staking|lending|liquidity/i,
      /trading|arbitrage|MEV|swap/i,
      /reward|earn|profit|revenue/i,
      /airdrop|bounty|grant/i,
      /API|service|integration/i,
      /agent.*key|agent.*directory/i,  // Agent-related services
    ];
    return incomePatterns.some(pattern => pattern.test(title));
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core evaluation logic
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate actionable opportunities and attempt to implement them.
   *
   * Flow:
   *   1. Drain the research queue (proposals from file watcher) — these take priority
   *   2. Get actionable entries from KnowledgeAcquirer (score >= minScore)
   *   3. Filter out already-processed entries
   *   4. For each (up to maxImplementationsPerCycle):
   *      a. Generate implementation plan via LLM
   *      b. If dryRun: log and record as dry_run
   *      c. Else: propose modification via SelfModModule
   *      d. Mark as implemented or failed
   */
  async evaluateAndImplement(): Promise<ImplementationResult[]> {
    // Guard against concurrent execution
    if (this.evaluationInProgress) {
      console.log(`${LOG_PREFIX} Evaluation already in progress, skipping.`);
      return [];
    }
    this.evaluationInProgress = true;
    const results: ImplementationResult[] = [];

    // 0. Check rate limit FIRST — before draining queue, so proposals are not lost
    const rateLimit = this.selfModModule.checkRateLimit();
    if (!rateLimit.allowed && !this.config.dryRun) {
      console.log(
        `${LOG_PREFIX} Rate limit reached (${rateLimit.usedInWindow}/${rateLimit.remaining + rateLimit.usedInWindow} in window). Skipping — proposals remain in queue.`,
      );
      this.evaluationInProgress = false;
      return results;
    }

    // 1. Drain research queue into KnowledgeEntry format (priority processing)
    const researchEntries: KnowledgeEntry[] = [];
    while (this.researchQueue.length > 0) {
      const proposal = this.researchQueue.shift()!;
      if (this.processedIds.has(proposal.opportunityId)) continue;

      // Convert research proposal to a KnowledgeEntry-like object for the evolver
      researchEntries.push({
        id: proposal.opportunityId,
        protocolName: proposal.title,
        type: 'service', // research proposals are service/integration type
        estimatedApyBps: 0,
        requiredCapitalUsdc: 0n,
        riskFactors: [],
        viabilityScore: proposal.priority === 'P1' ? 80 : proposal.priority === 'P2' ? 70 : 60,
        source: proposal.source,
        status: 'actionable',
        discoveredAt: Date.now(),
        lastEvaluatedAt: Date.now(),
        // Extra context for the LLM prompt — properly typed via KnowledgeEntry.description
        description: `Research Agent proposal: ${proposal.title}. Estimated revenue: ${proposal.estimatedRevenue}. Source: ${proposal.source}.`,
      });
    }

    // 2. Get entries from KnowledgeAcquirer
    const knowledgeEntries = this.knowledgeAcquirer
      .getActionableEntries(10)
      .filter((e) => e.viabilityScore >= this.config.minScoreForImplementation)
      .filter((e) => e.status === 'actionable')
      .filter((e) => !this.processedIds.has(e.id));

    // Combine: research queue first (higher priority), then knowledge base
    const opportunities = [...researchEntries, ...knowledgeEntries];

    if (opportunities.length === 0) {
      console.log(`${LOG_PREFIX} No actionable opportunities to implement.`);
      this.evaluationInProgress = false;
      return results;
    }

    console.log(
      `${LOG_PREFIX} Found ${opportunities.length} candidate opportunities ` +
      `(processing up to ${this.config.maxImplementationsPerCycle}).`,
    );

    // 3. Process each opportunity (up to max per cycle)
    for (const opp of opportunities.slice(0, this.config.maxImplementationsPerCycle)) {
      console.log(
        `${LOG_PREFIX} Evaluating: ${opp.protocolName} (${opp.type}, score: ${opp.viabilityScore})`,
      );

      try {
        // FIX-027: Check feasibility BEFORE generating implementation plan
        const feasibilityAssessment = await this.feasibilityAssessor.assess({
          id: opp.id,
          title: opp.protocolName,
          source: opp.source,
          description: opp.description ?? '',
          estimatedRevenue: opp.estimatedApyBps > 0 
            ? `${(opp.estimatedApyBps / 100).toFixed(1)}% APY` 
            : 'Unknown',
          category: opp.type,
        });

        // Handle non-automatable opportunities
        if (!feasibilityAssessment.canTestNow) {
          if (feasibilityAssessment.category === 'REQUIRES_SETUP') {
            // Queue for manual setup
            console.log(
              `${LOG_PREFIX} ⏸️ "${opp.protocolName}" requires manual setup. ` +
              `Steps: ${feasibilityAssessment.manualSetupSteps.map(s => s.action).join(', ')}`
            );
            
            this.manualSetupQueue.push({
              opportunity: opp,
              assessment: feasibilityAssessment,
              queuedAt: Date.now(),
            });
            
            this.processedIds.add(opp.id);
            results.push({
              opportunityId: opp.id,
              status: 'needs_manual_setup',
              feasibilityAssessment,
            });
            continue;
          }
          
          if (feasibilityAssessment.category === 'REQUIRES_ONGOING_MANUAL' ||
              feasibilityAssessment.category === 'NOT_FEASIBLE') {
            
            // FIX-029: Before discarding, try to refine the proposal
            const originalScore = opp.viabilityScore ?? 0;
            if (originalScore >= 50) {
              console.log(
                `${LOG_PREFIX} 🔄 "${opp.protocolName}" not feasible, attempting refinement...`
              );
              
              const refinementResult = await this.proposalRefiner.refineProposal(
                opp.id,
                opp.protocolName,
                opp.description ?? '',
                `${feasibilityAssessment.category}: ${feasibilityAssessment.reasoning}`,
                originalScore,
                feasibilityAssessment,
              );
              
              if (refinementResult.success && refinementResult.refined) {
                // Refinement successful! Queue the refined version
                console.log(
                  `${LOG_PREFIX} ✨ Refined "${opp.protocolName}" → "${refinementResult.refined.refinedTitle}" ` +
                  `(score: ${originalScore} → ${refinementResult.refined.refinedScore})`
                );
                
                this.refinedQueue.push({
                  original: opp,
                  refined: refinementResult.refined,
                  queuedAt: Date.now(),
                });
                
                this.processedIds.add(opp.id);
                results.push({
                  opportunityId: opp.id,
                  status: 'refined',
                  refinedProposal: refinementResult.refined,
                });
                continue;
              } else {
                console.log(
                  `${LOG_PREFIX} ❌ Refinement failed for "${opp.protocolName}": ${refinementResult.error}`
                );
              }
            }
            
            // Skip entirely — cannot be automated and cannot be refined
            console.log(
              `${LOG_PREFIX} ❌ "${opp.protocolName}" is not feasible for automation: ` +
              `${feasibilityAssessment.reasoning}`
            );
            
            this.markAsFailed(opp.id, `Not feasible: ${feasibilityAssessment.category}`);
            results.push({
              opportunityId: opp.id,
              status: 'not_feasible',
              error: feasibilityAssessment.reasoning,
              feasibilityAssessment,
            });
            continue;
          }
        }

        console.log(
          `${LOG_PREFIX} ✅ "${opp.protocolName}" is automatable (confidence: ${feasibilityAssessment.confidence}%)`
        );

        // Generate implementation plan with LLM
        const plan = await this.generateImplementationPlan(opp);

        if (!plan) {
          console.log(
            `${LOG_PREFIX} LLM couldn't generate a plan for ${opp.protocolName}. Skipping.`,
          );
          results.push({ opportunityId: opp.id, status: 'skipped' });
          continue;
        }

        console.log(
          `${LOG_PREFIX} Plan generated for ${opp.protocolName}: ${plan.targetFile}`,
        );

        // If dry-run, only log
        if (this.config.dryRun) {
          console.log(
            `${LOG_PREFIX} DRY RUN — would implement: ${plan.description}`,
          );
          console.log(
            `${LOG_PREFIX} DRY RUN — target: ${plan.targetFile} (${plan.generatedCode.length} chars)`,
          );
          results.push({ opportunityId: opp.id, status: 'dry_run', plan });
          this.processedIds.add(opp.id);
          continue;
        }

        // Read existing file content (empty for new files)
        // Always resolve to absolute path — BackupManager and SandboxRunner require it
        // IMPORTANT: Redirect src/ paths to data/auto-generated/ — the container
        // runs as non-root user `ain` which has NO write permission to /app/src/.
        // /app/data/ is the only writable directory for auto-generated code.
        const resolvedRelative = plan.targetFile.startsWith('src/')
          ? plan.targetFile.replace(/^src\//, 'data/auto-generated/')
          : plan.targetFile.startsWith('data/')
            ? plan.targetFile
            : `data/auto-generated/${plan.targetFile}`;

        const absolutePath = resolve(process.cwd(), resolvedRelative);

        let originalContent = '';
        try {
          originalContent = readFileSync(absolutePath, 'utf-8');
        } catch {
          // File doesn't exist yet — create parent directory so CodePatcher can write it
          try {
            const { dirname } = await import('node:path');
            mkdirSync(dirname(absolutePath), { recursive: true });
          } catch {
            // Directory already exists or cannot be created — CodePatcher handles errors
          }
          originalContent = '';
        }

        // Propose modification via SelfModModule (use absolute path)
        const modResult = await this.selfModModule.proposeModification({
          filePath: absolutePath,
          originalContent,
          proposedContent: plan.generatedCode,
          llmReasoning: plan.description,
          triggeredBy: `adaptive-evolver:${opp.id}`,
        });

        // Track file attempt time to avoid hammering the same file
        this.fileAttemptTimes.set(resolvedRelative, Date.now());

        if (modResult.success) {
          // Success — mark as implemented
          this.markAsImplemented(opp.id);
          console.log(
            `${LOG_PREFIX} ✅ Successfully implemented: ${opp.protocolName}`,
          );
          results.push({ opportunityId: opp.id, status: 'implemented', plan });
        } else {
          // Failure — mark as failed
          const errorMsg = modResult.error?.message ?? 'Unknown error';
          this.markAsFailed(opp.id, errorMsg);
          console.log(
            `${LOG_PREFIX} ❌ Failed to implement ${opp.protocolName}: ${errorMsg}`,
          );
          results.push({
            opportunityId: opp.id,
            status: 'failed',
            plan,
            error: errorMsg,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `${LOG_PREFIX} Error processing ${opp.protocolName}: ${msg}`,
        );
        results.push({ opportunityId: opp.id, status: 'error', error: msg });
        this.processedIds.add(opp.id);
      }
    }

    // Record results for DailyReport
    for (const r of results) {
      const opp = opportunities.find(o => o.id === r.opportunityId);
      this.recentResults.push({
        title: opp?.protocolName ?? r.opportunityId,
        status: r.status,
        targetFile: r.plan?.targetFile,
        error: r.error,
        ts: Date.now(),
      });
    }
    // Keep only last 50 results in memory
    if (this.recentResults.length > 50) {
      this.recentResults.splice(0, this.recentResults.length - 50);
    }

    this.evaluationInProgress = false;
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LLM-powered plan generation
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Uses the LLM client to generate an implementation plan for a given opportunity.
   * Returns null if the LLM fails to produce a valid plan.
   */
  private async generateImplementationPlan(
    opp: KnowledgeEntry,
  ): Promise<ImplementationPlan | null> {
    const sanitizedName = opp.protocolName
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // Use extra description if available (from research proposals)
    const extraContext = opp.description
      ? `\nAdditional context: ${opp.description}`
      : '';

    const prompt = `Generate a TypeScript module for a Base blockchain agent.

Opportunity: ${opp.protocolName} (${opp.type}, score: ${opp.viabilityScore}/100)
APY: ${(opp.estimatedApyBps / 100).toFixed(1)}%, Capital: $${Number(opp.requiredCapitalUsdc) / 1_000_000}
${opp.description ? `Context: ${opp.description.slice(0, 200)}` : ''}

Requirements:
- File: data/auto-generated/${sanitizedName}.ts
- Export class with: execute(): Promise<{ success: boolean; profitUsdc?: bigint }>
- Use ethers v6 for blockchain, axios for HTTP
- Handle all errors (no unhandled throws)
- Keep code under 80 lines

Respond ONLY with this JSON (no markdown):
{"targetFile":"data/auto-generated/${sanitizedName}.ts","description":"one line description","generatedCode":"// TypeScript code here","testDescription":"how to test"}`;

    try {
      const result = await this.llmClient.callTool<unknown>('infer', {
        systemPrompt:
          'You are a code generation assistant. Return only valid JSON. No markdown fences, no explanation text.',
        userMessage: prompt,
        // Use DeepSeek Flash for code generation — fast enough to stay within
        // MCP timeout (~30s). Pro is too slow for 8192 tokens and times out.
        ...(process.env['FORCE_LOCAL_CODER'] === 'true' && process.env['CODER_MODEL']
          ? { model: process.env['CODER_MODEL'] }
          : { model: process.env['CODER_MODEL'] ?? 'deepseek-v4-flash' }),
        maxTokens: 4096,
        temperature: 0.2,
      });

      if (!result.ok) {
        console.warn(
          `${LOG_PREFIX} LLM call failed: ${result.error.message}`,
        );
        return null;
      }

      // Parse the LLM response
      const raw = result.value;
      let parsed: Record<string, unknown>;

      if (typeof raw === 'string') {
        // Try to extract JSON from possible markdown fences
        const cleaned = raw
          .replace(/^```json?\s*\n?/m, '')
          .replace(/\n?```\s*$/m, '')
          .trim();
        parsed = JSON.parse(repairTruncatedJson(cleaned)) as Record<string, unknown>;
      } else if (
        raw &&
        typeof raw === 'object' &&
        'content' in (raw as Record<string, unknown>)
      ) {
        const content = (raw as { content: string }).content;
        const cleaned = content
          .replace(/^```json?\s*\n?/m, '')
          .replace(/\n?```\s*$/m, '')
          .trim();
        parsed = JSON.parse(repairTruncatedJson(cleaned)) as Record<string, unknown>;
      } else {
        parsed = raw as Record<string, unknown>;
      }

      // Validate required fields
      if (
        !parsed['targetFile'] ||
        !parsed['generatedCode'] ||
        !parsed['description']
      ) {
        console.warn(`${LOG_PREFIX} LLM response missing required fields.`);
        return null;
      }

      return {
        opportunityId: opp.id,
        protocolName: opp.protocolName,
        type: opp.type,
        targetFile: String(parsed['targetFile']),
        description: String(parsed['description']),
        generatedCode: String(parsed['generatedCode']),
        testDescription: String(parsed['testDescription'] ?? ''),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} Failed to parse LLM plan: ${msg}`);
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Status tracking
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Mark an opportunity as successfully implemented.
   * Updates the knowledge base status to 'integrated'.
   */
  private markAsImplemented(opportunityId: string): void {
    this.processedIds.add(opportunityId);
    try {
      this.knowledgeRepo.updateStatus(opportunityId, 'integrated');
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} Failed to update status for ${opportunityId}:`,
        (err as Error).message,
      );
    }
  }

  /**
   * Mark an opportunity as failed implementation.
   * Updates the knowledge base status to 'descartada'.
   */
  private markAsFailed(opportunityId: string, reason: string): void {
    this.processedIds.add(opportunityId);
    try {
      this.knowledgeRepo.updateStatus(opportunityId, 'descartada');
      console.log(`${LOG_PREFIX} Marked ${opportunityId} as descartada: ${reason}`);
    } catch (err) {
      console.warn(
        `${LOG_PREFIX} Failed to update status for ${opportunityId}:`,
        (err as Error).message,
      );
    }
  }
}

/**
 * ProposalRefiner — Second-chance evaluation for discarded proposals
 *
 * When a proposal is initially discarded (NOT_FEASIBLE, REQUIRES_SETUP, low score),
 * this module attempts to REFINE it by:
 *   1. Analyzing WHY it was discarded
 *   2. Generating alternative approaches via LLM
 *   3. Re-scoring the refined version
 *   4. If viable, creating a NEW proposal with the refinements
 *
 * Example:
 *   Original: "YouTube monetization" → Discarded (requires 4000h + 1000 subs)
 *   Refined: "2 AI tutorial channels with cross-posting" → Viable (3-6 month plan)
 *
 * Runs:
 *   - On-demand when AdaptiveEvolver discards a high-potential proposal (score >= 60)
 *   - Weekly batch for all proposals in "descartada" with score >= 50
 *
 * Requirements: FIX-029 — Proposal Refinement System
 */

import type { McpClient } from '../mcp/client/mcp-client.js';
import type { KnowledgeBaseRepository, KnowledgeBaseRow } from '../state/repositories/knowledge-base.repo.js';
import type { FeasibilityAssessment, FeasibilityCategory, ManualSetupStep } from './feasibility-assessor.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface RefinementStrategy {
  type: 'constraint_relaxation' | 'scope_reduction' | 'strategy_pivot' | 'resource_optimization' | 'timeline_extension' | 'hybrid';
  description: string;
  changes: string[];
}

export interface RefinedProposal {
  /** Original proposal ID */
  originalId: string;
  /** Original title */
  originalTitle: string;
  /** Why the original was discarded */
  originalRejectionReason: string;
  /** New refined title */
  refinedTitle: string;
  /** Detailed description of the refined approach */
  refinedDescription: string;
  /** Strategy used to refine */
  strategy: RefinementStrategy;
  /** New score after refinement */
  refinedScore: number;
  /** New feasibility category */
  feasibility: FeasibilityCategory;
  /** Manual steps still required (if any) */
  manualStepsRequired: ManualSetupStep[];
  /** Estimated timeline to first revenue */
  timelineToRevenue: string;
  /** Confidence in the refinement (0-100) */
  confidence: number;
  /** Milestones for tracking progress */
  milestones: Array<{
    description: string;
    estimatedDays: number;
    metric: string;
  }>;
  /** LLM reasoning for the refinement */
  reasoning: string;
  /** Timestamp of refinement */
  refinedAt: number;
}

export interface RefinementResult {
  success: boolean;
  originalId: string;
  refined?: RefinedProposal;
  error?: string;
  /** If true, the proposal cannot be refined (fundamentally not viable) */
  unrefinable?: boolean;
}

export interface RefinerConfig {
  /** Minimum original score to attempt refinement. Default: 50 */
  minScoreForRefinement: number;
  /** Minimum refined score to accept. Default: 65 */
  minRefinedScore: number;
  /** Maximum refinement attempts per proposal. Default: 2 */
  maxRefinementAttempts: number;
  /** Interval for batch refinement (ms). Default: 7 days */
  batchIntervalMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[ProposalRefiner]';

const DEFAULT_CONFIG: RefinerConfig = {
  minScoreForRefinement: 50,
  minRefinedScore: 65,
  maxRefinementAttempts: 2,
  batchIntervalMs: 7 * 24 * 60 * 60 * 1_000, // 7 days
};

/** Proposals that fundamentally cannot be refined */
const UNREFINABLE_PATTERNS = [
  /\bcsam\b/i,                    // Illegal content
  /\bpyramid\s*scheme\b/i,        // Scams
  /\bponzi\b/i,                   // Scams
  /\bmoney\s*laundering\b/i,      // Illegal
  /\bkyc\s*bypass\b/i,            // Illegal
];

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class ProposalRefiner {
  private readonly config: RefinerConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  
  /** Track refinement attempts per proposal */
  private readonly refinementAttempts = new Map<string, number>();
  
  /** Cache of successful refinements */
  private readonly refinedProposals = new Map<string, RefinedProposal>();

  /** FIX-029: Track failed refinements for reporting */
  private readonly failedRefinements = new Map<string, {
    title: string;
    reason: string;
    attempts: number;
    lastAttempt: number;
  }>();

  constructor(
    private readonly knowledgeRepo: KnowledgeBaseRepository,
    private readonly llmClient: McpClient,
    config?: Partial<RefinerConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Start the weekly batch refinement loop.
   */
  start(): void {
    if (this.intervalHandle) return;

    console.log(
      `${LOG_PREFIX} Started (batch interval: ${this.config.batchIntervalMs / 86_400_000} days, ` +
      `min score: ${this.config.minScoreForRefinement})`
    );

    this.intervalHandle = setInterval(() => {
      this.runBatchRefinement().catch(err => {
        console.error(`${LOG_PREFIX} Batch refinement failed:`, (err as Error).message);
      });
    }, this.config.batchIntervalMs);
  }

  /** Stop the batch refinement loop. */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      console.log(`${LOG_PREFIX} Stopped.`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // On-demand refinement (called by AdaptiveEvolver)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Attempt to refine a single proposal that was just discarded.
   * Called immediately when a high-potential proposal (score >= 60) is rejected.
   */
  async refineProposal(
    proposalId: string,
    originalTitle: string,
    originalDescription: string,
    rejectionReason: string,
    originalScore: number,
    feasibilityAssessment?: FeasibilityAssessment,
  ): Promise<RefinementResult> {
    // Check if fundamentally unrefinable
    if (this.isUnrefinable(originalTitle, originalDescription)) {
      return {
        success: false,
        originalId: proposalId,
        unrefinable: true,
        error: 'Proposal contains content that cannot be refined (illegal/scam)',
      };
    }

    // Check score threshold
    if (originalScore < this.config.minScoreForRefinement) {
      return {
        success: false,
        originalId: proposalId,
        error: `Score ${originalScore} below minimum ${this.config.minScoreForRefinement} for refinement`,
      };
    }

    // Check attempt limit
    const attempts = this.refinementAttempts.get(proposalId) ?? 0;
    if (attempts >= this.config.maxRefinementAttempts) {
      return {
        success: false,
        originalId: proposalId,
        error: `Max refinement attempts (${this.config.maxRefinementAttempts}) reached`,
      };
    }

    console.log(`${LOG_PREFIX} Attempting refinement for "${originalTitle}" (attempt ${attempts + 1})`);

    try {
      const refined = await this.generateRefinement(
        proposalId,
        originalTitle,
        originalDescription,
        rejectionReason,
        feasibilityAssessment,
      );

      // Update attempt counter
      this.refinementAttempts.set(proposalId, attempts + 1);

      if (!refined) {
        // Track failed refinement
        this.trackFailedRefinement(proposalId, originalTitle, 'LLM could not generate a viable refinement', attempts + 1);
        return {
          success: false,
          originalId: proposalId,
          error: 'LLM could not generate a viable refinement',
        };
      }

      // Check if refined version meets threshold
      if (refined.refinedScore < this.config.minRefinedScore) {
        console.log(
          `${LOG_PREFIX} Refinement score ${refined.refinedScore} below threshold ${this.config.minRefinedScore}`
        );
        // Track failed refinement
        this.trackFailedRefinement(proposalId, originalTitle, `Refined score ${refined.refinedScore} below minimum ${this.config.minRefinedScore}`, attempts + 1);
        return {
          success: false,
          originalId: proposalId,
          error: `Refined score ${refined.refinedScore} below minimum ${this.config.minRefinedScore}`,
        };
      }

      // Success! Cache and remove from failed tracking if it was there
      this.refinedProposals.set(proposalId, refined);
      this.failedRefinements.delete(proposalId);
      
      console.log(
        `${LOG_PREFIX} ✅ Successfully refined "${originalTitle}" → "${refined.refinedTitle}" ` +
        `(score: ${originalScore} → ${refined.refinedScore})`
      );

      return {
        success: true,
        originalId: proposalId,
        refined,
      };
    } catch (err) {
      // Track failed refinement
      this.trackFailedRefinement(proposalId, originalTitle, (err as Error).message, attempts + 1);
      return {
        success: false,
        originalId: proposalId,
        error: `Refinement failed: ${(err as Error).message}`,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Batch refinement (weekly)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run batch refinement on all discarded proposals with score >= threshold.
   */
  async runBatchRefinement(): Promise<RefinementResult[]> {
    console.log(`${LOG_PREFIX} Starting batch refinement...`);

    const results: RefinementResult[] = [];

    // Fetch discarded proposals with decent scores
    const discarded = this.knowledgeRepo.getByStatus('descartada', 100);
    const candidates = discarded.filter(p => 
      (p.viability_score ?? 0) >= this.config.minScoreForRefinement
    );

    console.log(`${LOG_PREFIX} Found ${candidates.length} candidates for refinement`);

    // Process each (limit to 5 per batch to control costs)
    for (const proposal of candidates.slice(0, 5)) {
      const result = await this.refineProposal(
        proposal.id,
        proposal.protocol_name ?? proposal.title ?? 'Unknown',
        proposal.description ?? '',
        'Previously discarded',
        proposal.viability_score ?? 0,
      );

      results.push(result);

      // Small delay between LLM calls
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    const successful = results.filter(r => r.success).length;
    console.log(`${LOG_PREFIX} Batch complete: ${successful}/${results.length} refined successfully`);

    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // LLM-powered refinement generation
  // ─────────────────────────────────────────────────────────────────────────────

  private async generateRefinement(
    proposalId: string,
    originalTitle: string,
    originalDescription: string,
    rejectionReason: string,
    feasibilityAssessment?: FeasibilityAssessment,
  ): Promise<RefinedProposal | null> {
    const manualStepsInfo = feasibilityAssessment?.manualSetupSteps
      ? feasibilityAssessment.manualSetupSteps.map(s => `- ${s.action}: ${s.reason}`).join('\n')
      : 'None specified';

    const prompt = `You are a business strategist helping an autonomous AI agent find income opportunities.

ORIGINAL PROPOSAL (DISCARDED):
- Title: ${originalTitle}
- Description: ${originalDescription}
- Rejection reason: ${rejectionReason}
- Manual steps required: 
${manualStepsInfo}

AGENT CAPABILITIES:
- TypeScript/Node.js runtime 24/7
- $99 USDC on Base blockchain
- Can generate content (text, code)
- Can interact with APIs
- Can deploy web services
- CANNOT: create accounts manually, do KYC, verify emails, make phone calls

YOUR TASK:
Analyze why this proposal was rejected and propose a REFINED VERSION that could work.

Consider these strategies:
1. CONSTRAINT_RELAXATION: Reduce requirements (e.g., 2 channels instead of 10)
2. SCOPE_REDUCTION: Focus on a specific niche (e.g., AI tutorials only)
3. STRATEGY_PIVOT: Different approach to same goal (e.g., affiliate instead of ads)
4. RESOURCE_OPTIMIZATION: Reuse/repurpose content (e.g., shorts → long form)
5. TIMELINE_EXTENSION: Accept longer timeline with clear milestones

IMPORTANT:
- The refined proposal MUST be executable by the agent
- If manual setup is unavoidable, it must be ONE-TIME and clearly defined
- Include specific milestones with metrics
- Be realistic about timelines and revenue expectations

Respond ONLY with valid JSON:
{
  "canBeRefined": true/false,
  "unrefinableReason": "only if canBeRefined is false",
  "refinedTitle": "New specific title",
  "refinedDescription": "Detailed description of the refined approach (2-3 paragraphs)",
  "strategy": {
    "type": "constraint_relaxation|scope_reduction|strategy_pivot|resource_optimization|timeline_extension|hybrid",
    "description": "How the strategy was applied",
    "changes": ["change 1", "change 2", ...]
  },
  "refinedScore": 0-100,
  "feasibility": "FULLY_AUTOMATABLE|REQUIRES_SETUP",
  "manualStepsRequired": [
    {"action": "...", "reason": "...", "estimatedTime": "...", "blocking": true/false}
  ],
  "timelineToRevenue": "e.g., 3-6 months",
  "milestones": [
    {"description": "First milestone", "estimatedDays": 30, "metric": "100 subscribers"},
    {"description": "Second milestone", "estimatedDays": 90, "metric": "1000 subscribers"}
  ],
  "confidence": 0-100,
  "reasoning": "2-3 sentences explaining why this refinement works"
}`;

    const result = await this.llmClient.callTool<unknown>('infer', {
      systemPrompt: 'You are a strategic business analyst. Return only valid JSON.',
      userMessage: prompt,
      model: process.env['CODER_MODEL'] ?? 'deepseek-v4-flash',
      maxTokens: 2048,
      temperature: 0.3,
    });

    if (!result.ok) {
      console.warn(`${LOG_PREFIX} LLM call failed:`, result.error.message);
      return null;
    }

    // Parse response
    const raw = result.value;
    let parsed: Record<string, unknown>;

    try {
      if (typeof raw === 'string') {
        const cleaned = raw
          .replace(/^```json?\s*\n?/m, '')
          .replace(/\n?```\s*$/m, '')
          .trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found');
        parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } else if (raw && typeof raw === 'object' && 'content' in (raw as Record<string, unknown>)) {
        const content = (raw as { content: string }).content;
        const cleaned = content
          .replace(/^```json?\s*\n?/m, '')
          .replace(/\n?```\s*$/m, '')
          .trim();
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON found');
        parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      } else {
        parsed = raw as Record<string, unknown>;
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to parse LLM response:`, (err as Error).message);
      return null;
    }

    // Check if LLM says it can't be refined
    if (parsed['canBeRefined'] === false) {
      console.log(`${LOG_PREFIX} LLM determined proposal cannot be refined: ${parsed['unrefinableReason']}`);
      return null;
    }

    // Build RefinedProposal
    return {
      originalId: proposalId,
      originalTitle,
      originalRejectionReason: rejectionReason,
      refinedTitle: String(parsed['refinedTitle'] ?? originalTitle),
      refinedDescription: String(parsed['refinedDescription'] ?? ''),
      strategy: this.parseStrategy(parsed['strategy']),
      refinedScore: typeof parsed['refinedScore'] === 'number' 
        ? Math.min(100, Math.max(0, parsed['refinedScore']))
        : 50,
      feasibility: this.parseFeasibility(parsed['feasibility']),
      manualStepsRequired: this.parseManualSteps(parsed['manualStepsRequired']),
      timelineToRevenue: String(parsed['timelineToRevenue'] ?? 'Unknown'),
      milestones: this.parseMilestones(parsed['milestones']),
      confidence: typeof parsed['confidence'] === 'number'
        ? Math.min(100, Math.max(0, parsed['confidence']))
        : 50,
      reasoning: String(parsed['reasoning'] ?? ''),
      refinedAt: Date.now(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private isUnrefinable(title: string, description: string): boolean {
    const text = `${title} ${description}`.toLowerCase();
    return UNREFINABLE_PATTERNS.some(p => p.test(text));
  }

  private parseStrategy(raw: unknown): RefinementStrategy {
    if (typeof raw !== 'object' || raw === null) {
      return { type: 'hybrid', description: 'Unknown', changes: [] };
    }
    const s = raw as Record<string, unknown>;
    return {
      type: this.parseStrategyType(s['type']),
      description: String(s['description'] ?? ''),
      changes: Array.isArray(s['changes']) ? s['changes'].map(String) : [],
    };
  }

  private parseStrategyType(raw: unknown): RefinementStrategy['type'] {
    const valid = ['constraint_relaxation', 'scope_reduction', 'strategy_pivot', 
                   'resource_optimization', 'timeline_extension', 'hybrid'];
    if (typeof raw === 'string' && valid.includes(raw)) {
      return raw as RefinementStrategy['type'];
    }
    return 'hybrid';
  }

  private parseFeasibility(raw: unknown): FeasibilityCategory {
    if (typeof raw === 'string') {
      if (raw.toUpperCase().includes('FULLY')) return 'FULLY_AUTOMATABLE';
      if (raw.toUpperCase().includes('SETUP')) return 'REQUIRES_SETUP';
    }
    return 'REQUIRES_SETUP';
  }

  private parseManualSteps(raw: unknown): ManualSetupStep[] {
    if (!Array.isArray(raw)) return [];
    return raw.map((s: unknown) => {
      if (typeof s !== 'object' || s === null) {
        return { action: 'Unknown', reason: 'Unknown', estimatedTime: 'Unknown', blocking: true };
      }
      const step = s as Record<string, unknown>;
      return {
        action: String(step['action'] ?? 'Unknown'),
        reason: String(step['reason'] ?? 'Unknown'),
        estimatedTime: String(step['estimatedTime'] ?? 'Unknown'),
        blocking: step['blocking'] !== false,
      };
    });
  }

  private parseMilestones(raw: unknown): RefinedProposal['milestones'] {
    if (!Array.isArray(raw)) return [];
    return raw.map((m: unknown) => {
      if (typeof m !== 'object' || m === null) {
        return { description: 'Unknown', estimatedDays: 30, metric: 'Unknown' };
      }
      const mile = m as Record<string, unknown>;
      return {
        description: String(mile['description'] ?? 'Unknown'),
        estimatedDays: typeof mile['estimatedDays'] === 'number' ? mile['estimatedDays'] : 30,
        metric: String(mile['metric'] ?? 'Unknown'),
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public accessors
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get all successfully refined proposals.
   */
  getRefinedProposals(): RefinedProposal[] {
    return Array.from(this.refinedProposals.values());
  }

  /**
   * Get refinement for a specific proposal ID.
   */
  getRefinement(originalId: string): RefinedProposal | undefined {
    return this.refinedProposals.get(originalId);
  }

  /**
   * Get all failed refinements (proposals that couldn't be refined).
   * Useful for reporting and blacklist updates.
   */
  getFailedRefinements(): Array<{
    proposalId: string;
    title: string;
    reason: string;
    attempts: number;
    lastAttempt: number;
  }> {
    return Array.from(this.failedRefinements.entries()).map(([id, data]) => ({
      proposalId: id,
      ...data,
    }));
  }

  /**
   * Check if a proposal has exhausted all refinement attempts.
   */
  isRefinementExhausted(proposalId: string): boolean {
    const attempts = this.refinementAttempts.get(proposalId) ?? 0;
    return attempts >= this.config.maxRefinementAttempts;
  }

  /**
   * Clear refinement cache (useful for testing).
   */
  clearCache(): void {
    this.refinedProposals.clear();
    this.refinementAttempts.clear();
    this.failedRefinements.clear();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Track a failed refinement attempt.
   */
  private trackFailedRefinement(
    proposalId: string, 
    title: string, 
    reason: string, 
    attempts: number
  ): void {
    this.failedRefinements.set(proposalId, {
      title,
      reason,
      attempts,
      lastAttempt: Date.now(),
    });
    console.log(
      `${LOG_PREFIX} Tracked failed refinement for "${title}" (attempt ${attempts}/${this.config.maxRefinementAttempts}): ${reason}`
    );
  }
}

// Export factory
export function createProposalRefiner(
  knowledgeRepo: KnowledgeBaseRepository,
  llmClient: McpClient,
  config?: Partial<RefinerConfig>,
): ProposalRefiner {
  return new ProposalRefiner(knowledgeRepo, llmClient, config);
}

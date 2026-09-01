/**
 * FeasibilityAssessor — Pre-implementation feasibility check
 *
 * Evaluates whether an opportunity can be tested autonomously or requires
 * manual setup steps BEFORE code generation begins.
 *
 * Categories:
 *   - FULLY_AUTOMATABLE: Can be implemented and tested without human intervention
 *   - REQUIRES_SETUP: Needs manual setup but then runs autonomously
 *   - REQUIRES_ONGOING_MANUAL: Needs continuous human involvement (reject)
 *   - NOT_FEASIBLE: Cannot be implemented with current stack (reject)
 *
 * Manual setup examples:
 *   - Creating accounts on external services
 *   - Obtaining API keys from services that require email verification
 *   - Setting up OAuth credentials
 *   - Deploying infrastructure (domains, servers)
 *   - KYC verification requirements
 *
 * Requirements: Extends 9.x self-mod to prevent wasted LLM calls
 */

import type { McpClient } from '../mcp/client/mcp-client.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type FeasibilityCategory =
  | 'FULLY_AUTOMATABLE'      // Can implement and test now
  | 'REQUIRES_SETUP'         // Needs manual setup, then autonomous
  | 'REQUIRES_ONGOING_MANUAL' // Needs continuous human involvement
  | 'NOT_FEASIBLE';          // Cannot implement with current stack

export interface ManualSetupStep {
  /** What needs to be done manually */
  action: string;
  /** Why this step cannot be automated */
  reason: string;
  /** Estimated time to complete (e.g., "5 min", "1-2 days for KYC") */
  estimatedTime: string;
  /** Whether this blocks testing entirely until completed */
  blocking: boolean;
}

export interface FeasibilityAssessment {
  /** Unique ID for tracking */
  assessmentId: string;
  /** Reference to the opportunity being assessed */
  opportunityId: string;
  /** Title for logging */
  opportunityTitle: string;
  /** Overall feasibility category */
  category: FeasibilityCategory;
  /** Can we start testing immediately? */
  canTestNow: boolean;
  /** Steps required before testing (empty if FULLY_AUTOMATABLE) */
  manualSetupSteps: ManualSetupStep[];
  /** What the agent CAN do autonomously */
  automatableActions: string[];
  /** LLM reasoning for the assessment */
  reasoning: string;
  /** Confidence score (0-100) in the assessment */
  confidence: number;
  /** Timestamp of assessment */
  assessedAt: number;
}

export interface OpportunityContext {
  id: string;
  title: string;
  source: string;
  description: string;
  estimatedRevenue: string;
  category: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_PREFIX = '[FeasibilityAssessor]';

/**
 * Patterns that indicate manual setup is likely required.
 * Used as a fast pre-filter before LLM assessment.
 */
const MANUAL_SETUP_INDICATORS = [
  // Account creation
  /create.*(account|profile|login)/i,
  /sign.?up|register|registration/i,
  /verify.*(email|phone|identity)/i,
  /kyc|know your customer/i,
  
  // API credentials
  /api.?key.*(obtain|get|create|register)/i,
  /oauth|authentication.*(setup|configure)/i,
  /credentials?.*(manual|setup)/i,
  
  // Infrastructure
  /domain.*(purchase|register|setup|configure)/i,
  /server.*(deploy|provision|setup)/i,
  /hosting.*(setup|configure)/i,
  /ssl.*(certificate|setup)/i,
  
  // External services requiring human interaction
  /apply.*(program|partnership|affiliate)/i,
  /approval.*(required|needed|manual)/i,
  /waitlist|waiting list/i,
  /invite.?(only|code|required)/i,
  
  // Content platforms (usually require manual verification)
  /youtube.*(channel|monetization|partner)/i,
  /tiktok.*(creator|fund|program)/i,
  /twitch.*(affiliate|partner)/i,
];

/**
 * Patterns that indicate full automation is possible.
 * If these match AND no MANUAL_SETUP_INDICATORS match, likely automatable.
 */
const FULLY_AUTOMATABLE_INDICATORS = [
  /smart.?contract.*(interact|call|execute)/i,
  /on.?chain.*(transaction|swap|transfer)/i,
  /defi.*(yield|farm|stake|lend)/i,
  /api.*(public|open|free)/i,
  /rss|feed.*(read|parse|aggregate)/i,
  /scrape|crawl.*(public|website)/i,
  /arbitrage.*(detect|execute)/i,
];

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class FeasibilityAssessor {
  private assessmentCount = 0;

  constructor(
    private readonly llmClient: McpClient,
  ) {}

  /**
   * Assess whether an opportunity can be tested autonomously.
   *
   * Returns a FeasibilityAssessment that AdaptiveEvolver uses to:
   *   - Skip opportunities that need manual setup (queue for later)
   *   - Proceed with fully automatable opportunities
   *   - Log what manual steps would be needed for REQUIRES_SETUP
   */
  async assess(opportunity: OpportunityContext): Promise<FeasibilityAssessment> {
    const assessmentId = `feasibility-${Date.now()}-${++this.assessmentCount}`;
    const startTime = Date.now();

    // Fast pre-filter with regex patterns
    const preFilterResult = this.preFilterCheck(opportunity);
    
    if (preFilterResult.definitelyAutomatable) {
      console.log(`${LOG_PREFIX} Pre-filter: "${opportunity.title}" appears fully automatable`);
      return this.createAssessment(assessmentId, opportunity, {
        category: 'FULLY_AUTOMATABLE',
        canTestNow: true,
        manualSetupSteps: [],
        automatableActions: ['Full implementation via smart contracts or public APIs'],
        reasoning: 'Pre-filter detected on-chain/API patterns with no manual setup indicators',
        confidence: 75, // Lower confidence because we didn't use LLM
      });
    }

    if (preFilterResult.likelyNeedsManualSetup) {
      console.log(`${LOG_PREFIX} Pre-filter: "${opportunity.title}" likely needs manual setup, confirming with LLM...`);
    }

    // Use LLM for detailed assessment
    try {
      const llmAssessment = await this.assessWithLLM(opportunity);
      
      console.log(
        `${LOG_PREFIX} Assessment for "${opportunity.title}": ${llmAssessment.category} ` +
        `(can test now: ${llmAssessment.canTestNow}, confidence: ${llmAssessment.confidence}%) ` +
        `[${Date.now() - startTime}ms]`
      );

      return this.createAssessment(assessmentId, opportunity, llmAssessment);
    } catch (err) {
      // LLM failed — fall back to pre-filter result
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`${LOG_PREFIX} LLM assessment failed: ${msg}. Using pre-filter result.`);

      const category = preFilterResult.likelyNeedsManualSetup
        ? 'REQUIRES_SETUP'
        : 'FULLY_AUTOMATABLE';

      return this.createAssessment(assessmentId, opportunity, {
        category,
        canTestNow: category === 'FULLY_AUTOMATABLE',
        manualSetupSteps: preFilterResult.likelyNeedsManualSetup
          ? [{ action: 'Unknown setup required', reason: 'LLM assessment failed', estimatedTime: 'Unknown', blocking: true }]
          : [],
        automatableActions: ['Assessment uncertain due to LLM failure'],
        reasoning: `Pre-filter fallback: ${preFilterResult.likelyNeedsManualSetup ? 'detected manual setup indicators' : 'no manual setup indicators detected'}`,
        confidence: 40, // Low confidence for fallback
      });
    }
  }

  /**
   * Quick pre-filter using regex patterns.
   * Saves LLM calls for obviously automatable or obviously manual opportunities.
   */
  private preFilterCheck(opportunity: OpportunityContext): {
    definitelyAutomatable: boolean;
    likelyNeedsManualSetup: boolean;
    matchedIndicators: string[];
  } {
    const text = `${opportunity.title} ${opportunity.description}`.toLowerCase();
    
    const manualMatches: string[] = [];
    for (const pattern of MANUAL_SETUP_INDICATORS) {
      const match = text.match(pattern);
      if (match) {
        manualMatches.push(match[0]);
      }
    }

    const automatableMatches: string[] = [];
    for (const pattern of FULLY_AUTOMATABLE_INDICATORS) {
      const match = text.match(pattern);
      if (match) {
        automatableMatches.push(match[0]);
      }
    }

    // If automatable patterns match AND no manual patterns, likely automatable
    const definitelyAutomatable = automatableMatches.length > 0 && manualMatches.length === 0;
    
    // If manual patterns match, likely needs setup
    const likelyNeedsManualSetup = manualMatches.length > 0;

    return {
      definitelyAutomatable,
      likelyNeedsManualSetup,
      matchedIndicators: [...manualMatches, ...automatableMatches],
    };
  }

  /**
   * Use LLM to assess feasibility in detail.
   */
  private async assessWithLLM(opportunity: OpportunityContext): Promise<{
    category: FeasibilityCategory;
    canTestNow: boolean;
    manualSetupSteps: ManualSetupStep[];
    automatableActions: string[];
    reasoning: string;
    confidence: number;
  }> {
    const prompt = `You are evaluating if an opportunity can be TESTED autonomously by an AI agent.

AGENT CAPABILITIES:
- TypeScript/Node.js runtime 24/7
- $99 USDC on Base blockchain (can interact with smart contracts via ethers v6)
- HTTP requests to public APIs (axios)
- File system access (read/write local files)
- SQLite database
- NO ability to: create accounts, verify emails, do KYC, set up OAuth manually, purchase domains, etc.

OPPORTUNITY TO ASSESS:
- Title: ${opportunity.title}
- Source: ${opportunity.source}
- Category: ${opportunity.category}
- Description: ${opportunity.description}
- Estimated Revenue: ${opportunity.estimatedRevenue}

QUESTION: Can this opportunity be IMPLEMENTED AND TESTED right now without human intervention?

Categorize as:
1. FULLY_AUTOMATABLE — Can implement and test immediately with existing capabilities
2. REQUIRES_SETUP — Needs manual setup (account creation, API key registration, etc.) but then runs autonomously
3. REQUIRES_ONGOING_MANUAL — Needs continuous human involvement (content approval, manual trading decisions)
4. NOT_FEASIBLE — Cannot be implemented with our tech stack

For REQUIRES_SETUP, list each manual step needed with:
- action: What needs to be done
- reason: Why it can't be automated
- estimatedTime: How long it takes
- blocking: Does this completely block testing?

Respond ONLY with valid JSON:
{
  "category": "FULLY_AUTOMATABLE|REQUIRES_SETUP|REQUIRES_ONGOING_MANUAL|NOT_FEASIBLE",
  "canTestNow": true/false,
  "manualSetupSteps": [
    {"action": "...", "reason": "...", "estimatedTime": "...", "blocking": true/false}
  ],
  "automatableActions": ["what the agent CAN do autonomously"],
  "reasoning": "2-3 sentences explaining assessment",
  "confidence": 0-100
}`;

    const result = await this.llmClient.callTool<unknown>('infer', {
      systemPrompt: 'You are a technical feasibility analyst. Return only valid JSON.',
      userMessage: prompt,
      model: process.env['CODER_MODEL'] ?? 'deepseek-v4-flash',
      maxTokens: 1024,
      temperature: 0.1,
    });

    if (!result.ok) {
      throw new Error(`LLM call failed: ${result.error.message}`);
    }

    // Parse response
    const raw = result.value;
    let parsed: Record<string, unknown>;

    if (typeof raw === 'string') {
      const cleaned = raw
        .replace(/^```json?\s*\n?/m, '')
        .replace(/\n?```\s*$/m, '')
        .trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } else if (raw && typeof raw === 'object' && 'content' in (raw as Record<string, unknown>)) {
      const content = (raw as { content: string }).content;
      const cleaned = content
        .replace(/^```json?\s*\n?/m, '')
        .replace(/\n?```\s*$/m, '')
        .trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');
      parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } else {
      parsed = raw as Record<string, unknown>;
    }

    // Validate and normalize response
    const category = this.normalizeCategory(parsed['category']);
    const manualSetupSteps = this.normalizeSetupSteps(parsed['manualSetupSteps']);

    return {
      category,
      canTestNow: parsed['canTestNow'] === true,
      manualSetupSteps,
      automatableActions: Array.isArray(parsed['automatableActions'])
        ? (parsed['automatableActions'] as string[])
        : ['Unknown'],
      reasoning: typeof parsed['reasoning'] === 'string'
        ? parsed['reasoning']
        : 'No reasoning provided',
      confidence: typeof parsed['confidence'] === 'number'
        ? Math.min(100, Math.max(0, parsed['confidence']))
        : 50,
    };
  }

  /**
   * Normalize category from LLM response.
   */
  private normalizeCategory(raw: unknown): FeasibilityCategory {
    if (typeof raw !== 'string') return 'NOT_FEASIBLE';
    
    const upper = raw.toUpperCase().replace(/[^A-Z_]/g, '');
    
    if (upper.includes('FULLY') && upper.includes('AUTOMAT')) return 'FULLY_AUTOMATABLE';
    if (upper.includes('REQUIRES') && upper.includes('SETUP')) return 'REQUIRES_SETUP';
    if (upper.includes('ONGOING') || upper.includes('MANUAL')) return 'REQUIRES_ONGOING_MANUAL';
    if (upper.includes('NOT') && upper.includes('FEASIBLE')) return 'NOT_FEASIBLE';
    
    return 'NOT_FEASIBLE';
  }

  /**
   * Normalize manual setup steps from LLM response.
   */
  private normalizeSetupSteps(raw: unknown): ManualSetupStep[] {
    if (!Array.isArray(raw)) return [];
    
    return raw.map((step: unknown) => {
      if (typeof step !== 'object' || step === null) {
        return {
          action: 'Unknown step',
          reason: 'Could not parse',
          estimatedTime: 'Unknown',
          blocking: true,
        };
      }
      
      const s = step as Record<string, unknown>;
      return {
        action: typeof s['action'] === 'string' ? s['action'] : 'Unknown action',
        reason: typeof s['reason'] === 'string' ? s['reason'] : 'Unknown reason',
        estimatedTime: typeof s['estimatedTime'] === 'string' ? s['estimatedTime'] : 'Unknown',
        blocking: s['blocking'] !== false, // Default to blocking
      };
    });
  }

  /**
   * Create the final assessment object.
   */
  private createAssessment(
    assessmentId: string,
    opportunity: OpportunityContext,
    result: Omit<FeasibilityAssessment, 'assessmentId' | 'opportunityId' | 'opportunityTitle' | 'assessedAt'>
  ): FeasibilityAssessment {
    return {
      assessmentId,
      opportunityId: opportunity.id,
      opportunityTitle: opportunity.title,
      ...result,
      assessedAt: Date.now(),
    };
  }
}

// Export singleton for convenience
let singletonInstance: FeasibilityAssessor | null = null;

export function getFeasibilityAssessor(llmClient: McpClient): FeasibilityAssessor {
  if (!singletonInstance) {
    singletonInstance = new FeasibilityAssessor(llmClient);
  }
  return singletonInstance;
}

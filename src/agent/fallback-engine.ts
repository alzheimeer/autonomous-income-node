/**
 * FallbackEngine — Rule-based decision engine used when the LLM is unavailable.
 *
 * Activated when:
 *   - The agent is in Tier 1 (LLM budget multiplier = 0.4, fallback-preferred)
 *   - The ReAct loop has experienced 5 consecutive LLM failures (Requirement 2.7)
 *
 * Rules (from design doc):
 *   - EMERGENCY → no actions (do nothing)
 *   - Tier 1    → no actions  (LLM budget 40% but strictly rule-based in fallback)
 *   - Tier >= 2 → try 1 service (lowest-cost option)
 *   - Tier >= 3 → also attempt trading (1 scan action)
 *
 * Requirements: 2.7
 */

import { SurvivalTier } from '../survival/tier-evaluator.js';
import type { ContextSnapshot } from './context-builder.js';

// ---------------------------------------------------------------------------
// Action types (shared with react-loop and action-dispatcher)
// ---------------------------------------------------------------------------

/**
 * A single dispatchable action produced by either the LLM or the fallback engine.
 */
export interface Action {
  id: string;
  /** Which module handles this action. */
  module: ModuleName;
  /** The tool to invoke on the module. */
  tool: string;
  /** Parameters passed to the tool. */
  params: Record<string, unknown>;
  /** Priority: 1 = highest urgency, 10 = lowest urgency. */
  priority: number;
}

/**
 * A high-level plan produced by Think (LLM) or FallbackEngine.
 */
export interface ActionPlan {
  /** Free-text explanation of the agent's reasoning. */
  reasoning: string;
  /** Ordered list of actions to dispatch. */
  actions: Action[];
  /** What the agent expects to achieve this cycle. */
  expectedOutcome: string;
}

/**
 * All valid module names.
 */
export type ModuleName =
  | 'identity'
  | 'payment'
  | 'trading'
  | 'services'
  | 'social'
  | 'self-mod'
  | 'replication'
  | 'heartbeat'
  | 'lending'
  | 'lp'
  | 'perps'
  | 'marketplace';

// ---------------------------------------------------------------------------
// Counter for unique action IDs within a fallback plan
// ---------------------------------------------------------------------------

let _fallbackActionCounter = 0;

function nextFallbackId(): string {
  return `fallback-${Date.now()}-${++_fallbackActionCounter}`;
}

// ---------------------------------------------------------------------------
// FallbackEngine
// ---------------------------------------------------------------------------

/**
 * Generates a rule-based {@link ActionPlan} from the current {@link ContextSnapshot}
 * when the LLM is not available.
 *
 * The rules are deliberately conservative to protect the agent's balance:
 *
 * | Tier        | Allowed actions                                          |
 * |-------------|----------------------------------------------------------|
 * | EMERGENCY   | none (balance = $0)                                      |
 * | TIER_1      | 1 service request (balance < $10, prioritise services)   |
 * | TIER_2      | 1 service + 1 social post (social enabled)               |
 * | TIER_3      | 1 service + 1 trading scan + 1 social post               |
 * | TIER_4      | 1 service + 1 trading scan + 1 social post               |
 */
export function getFallbackPlan(context: ContextSnapshot): ActionPlan {
  const tier: SurvivalTier = context.tier as SurvivalTier;

  // EMERGENCY → do nothing (no funds at all)
  if (tier === SurvivalTier.EMERGENCY) {
    return {
      reasoning: 'EMERGENCY mode: balance is $0. No actions permitted. Waiting for funding.',
      actions: [],
      expectedOutcome: 'No expenditure this cycle. Agent remains alive.',
    };
  }

  // TIER_1 → balance < $10: prioritize services (cheapest income strategy)
  // Per requirement: if balance < $10, prioritize services to recover
  if (tier === SurvivalTier.TIER_1) {
    return {
      reasoning:
        'TIER_1 fallback: balance below $10. Prioritising services (cheapest income stream) to recover.',
      actions: [
        {
          id: nextFallbackId(),
          module: 'services',
          tool: 'list_pending_requests',
          params: { limit: 1 },
          priority: 1,
        },
      ],
      expectedOutcome: 'Attempt 1 service request to generate minimal income.',
    };
  }

  // TIER_2+ → try at least 1 service
  const actions: Action[] = [];

  // Service action — cheapest built-in service (web-scraping at $0.20)
  if (tier >= SurvivalTier.TIER_2) {
    actions.push({
      id: nextFallbackId(),
      module: 'services',
      tool: 'list_pending_requests',
      params: { limit: 1 },
      priority: 2,
    });
  }

  // Trading scan — only TIER_3 and above (trading enabled in gates)
  if (tier >= SurvivalTier.TIER_3) {
    actions.push({
      id: nextFallbackId(),
      module: 'trading',
      tool: 'scan_opportunities',
      params: {
        network: 'base',
        maxResults: 1,
        minNetProfitUsdc: '500000', // $0.50 minimum profit threshold
      },
      priority: 3,
    });
  }

  // For TIER_3+: Also add an Aave monitoring action
  if (tier >= SurvivalTier.TIER_3) {
    actions.push({
      id: nextFallbackId(),
      module: 'lending',
      tool: 'monitor',
      params: {},
      priority: 4,
    });
  }

  // Social posting — only TIER_2 and above (social posting enabled in gates)
  if (tier >= SurvivalTier.TIER_2) {
    actions.push({
      id: nextFallbackId(),
      module: 'social',
      tool: 'post_scheduled_content',
      params: {
        topic: 'autonomous-ai-agent',
        maxLength: 280,
      },
      priority: 5,
    });
  }

  const tierLabel = tierName(tier);

  return {
    reasoning: `Fallback rule-based plan for ${tierLabel}. LLM unavailable. Executing conservative actions to maintain income without LLM guidance.`,
    actions,
    expectedOutcome:
      actions.length > 0
        ? `Execute ${actions.length} conservative action(s) to generate minimal income while LLM recovers.`
        : 'No actions this cycle.',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tierName(tier: SurvivalTier): string {
  const names: Record<SurvivalTier, string> = {
    [SurvivalTier.EMERGENCY]: 'EMERGENCY',
    [SurvivalTier.TIER_1]: 'TIER_1',
    [SurvivalTier.TIER_2]: 'TIER_2',
    [SurvivalTier.TIER_3]: 'TIER_3',
    [SurvivalTier.TIER_4]: 'TIER_4',
  };
  return names[tier] ?? `TIER_${tier}`;
}

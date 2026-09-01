/**
 * ContextBuilder — Builds a sanitised ContextSnapshot from the current agent state.
 *
 * The snapshot is consumed by the ReAct loop's Think phase to build the LLM
 * prompt.  It intentionally omits ALL secrets: private keys, API keys,
 * passwords, mnemonics.
 *
 * Requirements: 2.2, 14.1
 */

import type { SurvivalTier, CapabilityGates } from '../survival/tier-evaluator.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single recent observation record surfaced to the LLM.
 * Contains only the information needed for reasoning — no raw secrets.
 */
export interface RecentObservation {
  actionId: string;
  module: string;
  tool: string;
  success: boolean;
  resultSummary: string | null;
  error: string | null;
  latencyMs: number | null;
  timestamp: number;
}

/**
 * A running income strategy visible to the LLM.
 */
export interface ActiveStrategy {
  id: string;
  name: string;
  module: string;
  enabled: boolean;
}

/**
 * A pending task the agent has queued for execution.
 */
export interface PendingTask {
  id: string;
  description: string;
  priority: number;
  createdAt: number;
}

/**
 * The full agent state handed to `buildContext`.
 * Callers are responsible for never placing secrets in this object.
 */
export interface AgentContextState {
  /** Wallet address (public — safe to include). */
  walletAddress: string;

  /** Current USDC balance in 6-decimal bigint units. */
  balanceUsdc: bigint;

  /** Current operational tier. */
  tier: SurvivalTier;

  /** Currently active capability gates. */
  gates: CapabilityGates;

  /** Active income strategies. */
  activeStrategies: ActiveStrategy[];

  /** Tasks queued but not yet executed. */
  pendingTasks: PendingTask[];

  /**
   * Recent observations from previous cycles (caller pre-filters to the
   * desired window; ContextBuilder further trims to `maxRecentObservations`).
   */
  recentObservations: RecentObservation[];

  /** Number of consecutive LLM failures (drives fallback logic hint). */
  consecutiveLlmFailures: number;

  /** ISO-8601 timestamp of the current cycle start. */
  cycleStartedAt: string;

  /** Total number of cycles executed since the agent started. */
  totalCycles: number;

  /** Top actionable opportunities from OpportunityDiscovery */
  topOpportunities?: Array<{
    title: string;
    type: string;
    estimatedYieldBps: number;
    riskLevel: string;
    viabilityScore: number;
  }>;

  /** Strategy performance rankings from StrategyTracker */
  strategyRankings?: {
    top: Array<{ source: string; pnlPerDayUsdc: string; enabled: boolean }>;
    bottom: Array<{ source: string; pnlPerDayUsdc: string; enabled: boolean }>;
  };

  /** Actionable knowledge entries */
  actionableKnowledge?: Array<{
    protocolName: string;
    type: string;
    estimatedApyBps: number;
    viabilityScore: number;
  }>;

  /** Aave lending position summary */
  aavePosition?: {
    depositedUsdc: string;
    accruedInterest: string;
    currentApyBps: number;
  } | null;

  /** Active LP positions count and total fees */
  lpPositionsSummary?: {
    count: number;
    totalFeesUsdc: string;
  } | null;

  /** Technical indicators from FeatureEngine */
  technicalIndicators?: string | null;
}

/**
 * Sanitised snapshot ready to be serialised into an LLM prompt.
 *
 * INVARIANT: This struct must NEVER contain private keys, API keys,
 * passwords, mnemonics, or any other secret material.
 */
export interface ContextSnapshot {
  walletAddress: string;
  /** USDC balance as a human-readable string, e.g. "42.50" */
  balanceUsdcFormatted: string;
  /** Raw 6-decimal bigint represented as a string for JSON serialisation. */
  balanceUsdcRaw: string;
  tier: number;
  tierLabel: string;
  gates: CapabilityGates;
  activeStrategies: ActiveStrategy[];
  pendingTasks: PendingTask[];
  /** Trimmed to the last N observations. */
  recentObservations: RecentObservation[];
  consecutiveLlmFailures: number;
  cycleStartedAt: string;
  totalCycles: number;
  topOpportunities: Array<{ title: string; type: string; estimatedYieldBps: number; riskLevel: string; viabilityScore: number }>;
  strategyRankings: { top: Array<{ source: string; pnlPerDayUsdc: string; enabled: boolean }>; bottom: Array<{ source: string; pnlPerDayUsdc: string; enabled: boolean }> };
  actionableKnowledge: Array<{ protocolName: string; type: string; estimatedApyBps: number; viabilityScore: number }>;
  aavePosition: { depositedUsdc: string; accruedInterest: string; currentApyBps: number } | null;
  lpPositionsSummary: { count: number; totalFeesUsdc: string } | null;
  /** Pre-formatted technical indicators string for LLM context */
  technicalIndicators: string | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIER_LABELS: Record<number, string> = {
  0: 'EMERGENCY',
  1: 'TIER_1',
  2: 'TIER_2',
  3: 'TIER_3',
  4: 'TIER_4',
};

const DEFAULT_MAX_OBSERVATIONS = 20;

// ---------------------------------------------------------------------------
// ContextBuilder
// ---------------------------------------------------------------------------

/**
 * Builds a sanitised {@link ContextSnapshot} from the provided agent state.
 *
 * @param agentState - Current agent state (must not contain secrets).
 * @param maxRecentObservations - Maximum number of recent observations to
 *   include in the snapshot (default: 20).
 * @returns A frozen ContextSnapshot ready for LLM prompt serialisation.
 */
export function buildContext(
  agentState: AgentContextState,
  maxRecentObservations = DEFAULT_MAX_OBSERVATIONS,
): ContextSnapshot {
  // Format balance as human-readable USDC string (6 decimals)
  const balanceUsdcFormatted = formatUsdc(agentState.balanceUsdc);

  // Trim recent observations to the last N entries (most recent last)
  const trimmedObservations = agentState.recentObservations
    .slice(-maxRecentObservations)
    .map(sanitiseObservation);

  // Sanitise strategies and tasks (defensive copies — strip any accidental
  // secret fields added by callers)
  const sanitisedStrategies = agentState.activeStrategies.map((s) => ({
    id: s.id,
    name: s.name,
    module: s.module,
    enabled: s.enabled,
  }));

  const sanitisedTasks = agentState.pendingTasks.map((t) => ({
    id: t.id,
    description: t.description,
    priority: t.priority,
    createdAt: t.createdAt,
  }));

  const snapshot: ContextSnapshot = {
    walletAddress: agentState.walletAddress,
    balanceUsdcFormatted,
    balanceUsdcRaw: agentState.balanceUsdc.toString(),
    tier: agentState.tier as number,
    tierLabel: TIER_LABELS[agentState.tier as number] ?? 'UNKNOWN',
    gates: agentState.gates,
    activeStrategies: sanitisedStrategies,
    pendingTasks: sanitisedTasks,
    recentObservations: trimmedObservations,
    consecutiveLlmFailures: agentState.consecutiveLlmFailures,
    cycleStartedAt: agentState.cycleStartedAt,
    totalCycles: agentState.totalCycles,
    topOpportunities: agentState.topOpportunities ?? [],
    strategyRankings: agentState.strategyRankings ?? { top: [], bottom: [] },
    actionableKnowledge: agentState.actionableKnowledge ?? [],
    aavePosition: agentState.aavePosition ?? null,
    lpPositionsSummary: agentState.lpPositionsSummary ?? null,
    technicalIndicators: agentState.technicalIndicators ?? null,
  };

  return Object.freeze(snapshot);
}

/**
 * Serialise a ContextSnapshot to a compact JSON string suitable for
 * inclusion as part of an LLM prompt.
 *
 * Converts bigint-backed strings (balanceUsdcRaw) and boolean gates
 * into JSON-serialisable form.
 */
export function serializeContext(snapshot: ContextSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Format a 6-decimal USDC bigint as a human-readable dollar string.
 * e.g. 100_500000n → "100.50"
 */
function formatUsdc(raw: bigint): string {
  const whole = raw / 1_000000n;
  const frac = raw % 1_000000n;
  const fracStr = frac.toString().padStart(6, '0').slice(0, 2); // cents precision
  return `${whole}.${fracStr}`;
}

/**
 * Return a safe copy of an observation with no secret material.
 * resultSummary and error fields are truncated to 500 chars.
 */
function sanitiseObservation(obs: RecentObservation): RecentObservation {
  return {
    actionId: obs.actionId,
    module: obs.module,
    tool: obs.tool,
    success: obs.success,
    resultSummary: obs.resultSummary ? obs.resultSummary.slice(0, 500) : null,
    error: obs.error ? obs.error.slice(0, 500) : null,
    latencyMs: obs.latencyMs,
    timestamp: obs.timestamp,
  };
}

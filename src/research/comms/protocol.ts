/**
 * Inter-agent communication protocol types.
 *
 * Research Agent writes JSON files to ./investigacion/
 * Operator Agent reads them and writes ACKs back.
 *
 * Protocol format for files:
 * - Research → Operator: {timestamp}_{type}_{id}.json
 * - Operator → Research: {timestamp}_{type}_{id}_ack.json
 */

// ── Priority levels ────────────────────────────────────────────────────────
// P1 = A2A agent marketplaces (highest priority)
// P2 = RPA browser automation
// P3 = Content generation (YouTube/TikTok)
// P4 = Trading (lowest priority, requires approval gate)

export type Priority = 'P1' | 'P2' | 'P3' | 'P4';

// ── Opportunity status lifecycle ───────────────────────────────────────────
// new → activa → profundización → pendiente_aprobacion → aprobada → implementada
//                                                      → descartada (razón)
//     → descartada (score < 50)

export type OpportunityStatus =
  | 'new'                   // Just discovered, not yet evaluated
  | 'activa'                // Actively being researched
  | 'profundización'        // Needs deeper investigation
  | 'pendiente_aprobacion'  // Waiting for human approval via Telegram
  | 'aprobada'              // Human approved, ready for implementation
  | 'code_generated'        // AdaptiveEvolver accepted code but no revenue yet
  | 'revenue_tracking'      // Monitoring for revenue over 7 days
  | 'implementada'          // Confirmed revenue generation
  | 'failed_no_revenue'     // No revenue after 7-day tracking period
  | 'descartada';           // Discarded (low score, rejected, or timeout)

// ── Raw opportunity from scanners ──────────────────────────────────────────

export interface RawOpportunity {
  /** Descriptive title of the opportunity */
  title: string;
  /** Source where it was discovered (e.g., "defi-llama", "google-search") */
  source: string;
  /** Category classification for prioritization */
  category: 'a2a' | 'rpa' | 'content' | 'trading' | 'other';
  /** Detailed description of the opportunity */
  description: string;
  /** Estimated revenue potential (e.g., "$50-100/month") */
  estimatedRevenue: string;
  /** Capital required to execute (e.g., "$20 USDC") */
  capitalRequired: string;
  /** Risk assessment level */
  riskLevel: 'low' | 'medium' | 'high';
  /** Level of automation possible */
  automationLevel: 'full' | 'partial' | 'manual';
  /** URL to the source for verification */
  sourceUrl?: string;
  /** Additional scanner-specific metadata */
  metadata: Record<string, unknown>;
}

// ── Score dimensions for LLM evaluation ────────────────────────────────────

export interface ScoreDimensions {
  /** Technical feasibility given current stack (0-100, weight 30%) */
  viability: number;
  /** Risk assessment where 100 = no risk (0-100, weight 25%) */
  risk: number;
  /** Alignment with available capital ~$99.62 USDC (0-100, weight 25%) */
  capital: number;
  /** Ability to execute without manual intervention (0-100, weight 20%) */
  automation: number;
}

// ── Scored opportunity (after LLM evaluation) ──────────────────────────────

export interface ScoredOpportunity extends RawOpportunity {
  /** Unique identifier for the opportunity */
  id: string;
  /** Composite score (0-100) calculated from weighted dimensions */
  score: number;
  /** Individual dimension scores */
  dimensions: ScoreDimensions;
  /** Priority category (P1-P4) */
  priority: Priority;
  /** Current status in the opportunity lifecycle */
  status: OpportunityStatus;
  /** LLM reasoning for the assigned score */
  reasoning: string;
  /** Unix timestamp when discovered */
  discoveredAt: number;
  /** Unix timestamp of last LLM evaluation */
  lastEvaluatedAt: number;
  /** Unix timestamp when status last changed */
  statusChangedAt?: number;
}

// ── Strategy proposal (Research → Operator) ────────────────────────────────

export interface StrategyProposalPayload {
  /** Reference to the scored opportunity */
  opportunityId: string;
  /** Human-readable title for the strategy */
  title: string;
  /** TypeScript code to implement the strategy */
  implementation: string;
  /** Command to run tests (e.g., "pnpm test -- --run") */
  testCommand: string;
  /** Whether the operator agent needs to restart after implementation */
  requiresRestart: boolean;
}

export interface StrategyProposal {
  type: 'strategy_proposal';
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Priority level for execution ordering */
  priority: Priority;
  /** Strategy details */
  payload: StrategyProposalPayload;
}

// ── Acknowledgment (Operator → Research) ───────────────────────────────────

export interface AckMessage {
  type: 'ack';
  /** Original opportunity/strategy ID being acknowledged */
  originalId: string;
  /** Result of the implementation attempt */
  status: 'implemented' | 'failed';
  /** Error message if status is 'failed', null otherwise */
  error: string | null;
}

// Alias for backwards compatibility
export type StrategyAck = AckMessage;

// ── Status update message ──────────────────────────────────────────────────

export interface StatusUpdate {
  type: 'status_update';
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Priority level */
  priority: Priority;
  /** Status update details */
  payload: {
    /** Opportunity ID being updated */
    opportunityId: string;
    /** Previous status */
    previousStatus: OpportunityStatus;
    /** New status */
    newStatus: OpportunityStatus;
    /** Reason for status change */
    reason: string;
  };
}

// ── Opportunity notification message ───────────────────────────────────────

export interface OpportunityMessage {
  type: 'opportunity';
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Priority level */
  priority: Priority;
  /** Opportunity data */
  payload: ScoredOpportunity;
}

// ── Generic inter-agent message envelope ───────────────────────────────────

export type InterAgentMessage =
  | StrategyProposal
  | AckMessage
  | StatusUpdate
  | OpportunityMessage;

// ── Approval request (for Telegram gate) ───────────────────────────────────

export interface ApprovalRequest {
  /** Reference to the opportunity being approved */
  opportunityId: string;
  /** Description of the strategy */
  strategy: string;
  /** Risk percentage (0-100, higher = riskier) */
  riskPercent: number;
  /** Capital required in USDC (e.g., "$20.00") */
  capitalRequired: string;
  /** Best-case return estimate */
  bestCase: string;
  /** Worst-case loss estimate */
  worstCase: string;
}

export interface ApprovalResponse {
  /** Approval record ID */
  id: string;
  /** Reference to the opportunity */
  opportunityId: string;
  /** Whether the user approved the strategy */
  approved: boolean;
  /** Unix timestamp when the user responded */
  respondedAt: number;
}

// ── Scan cycle result ──────────────────────────────────────────────────────

export interface CycleResult {
  /** Unique identifier for this scan cycle */
  scanId: string;
  /** Unix timestamp when the cycle started */
  startedAt: number;
  /** Unix timestamp when the cycle completed */
  completedAt: number;
  /** Number of sources successfully scanned */
  sourcesScanned: number;
  /** Number of sources that failed to scan */
  sourcesFailed: number;
  /** Total opportunities discovered */
  opportunitiesFound: number;
  /** Opportunities with score >= threshold (actionable) */
  opportunitiesActionable: number;
  /** Error message if the cycle failed */
  error?: string;
}

// ── Engine state ───────────────────────────────────────────────────────────

export type EngineState = 'idle' | 'scanning' | 'evaluating' | 'communicating' | 'stopped';

// ── Helper type guards ─────────────────────────────────────────────────────

export function isStrategyProposal(msg: InterAgentMessage): msg is StrategyProposal {
  return msg.type === 'strategy_proposal';
}

export function isAckMessage(msg: InterAgentMessage): msg is AckMessage {
  return msg.type === 'ack';
}

export function isStatusUpdate(msg: InterAgentMessage): msg is StatusUpdate {
  return msg.type === 'status_update';
}

export function isOpportunityMessage(msg: InterAgentMessage): msg is OpportunityMessage {
  return msg.type === 'opportunity';
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Weights for composite score calculation */
export const SCORE_WEIGHTS = {
  viability: 0.30,
  risk: 0.25,
  capital: 0.25,
  automation: 0.20,
} as const;

/** Priority order for sorting (lower index = higher priority) */
export const PRIORITY_ORDER: readonly Priority[] = ['P1', 'P2', 'P3', 'P4'] as const;

/** Minimum score threshold for actionable opportunities */
export const MIN_ACTIONABLE_SCORE = 70;

/** Minimum score threshold for automatic alerts */
export const ALERT_SCORE_THRESHOLD = 90;

/** Number of high-score opportunities to trigger batch alert */
export const BATCH_ALERT_THRESHOLD = 3;

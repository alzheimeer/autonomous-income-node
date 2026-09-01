/**
 * ReActLoop — Think → Act → Observe cycle.
 *
 * Behaviours (Requirements 2.1 – 2.8):
 *   2.1  Configurable interval ≥ 1 000 ms between cycles.
 *   2.2  Think: query LLM via MCP LLM Server with structured context prompt.
 *   2.3  Parse LLM response into typed Action objects.
 *   2.4  Act: dispatch each Action to its module handler.
 *   2.5  Observe: persist all Observations to SQLite.
 *   2.6  LLM timeout after 30 s → skip cycle, increment failureCounter.
 *   2.7  5 consecutive LLM failures → switch to fallback rule-based mode.
 *   2.8  Maximum 10 concurrent Actions per cycle.
 */

import { randomUUID } from 'node:crypto';

import type { ObservationsRepository } from '../state/repositories/observations.repo.js';
import type { McpClient } from '../mcp/client/mcp-client.js';
import type { AgentEventBus } from './event-bus.js';
import {
  buildContext,
  type AgentContextState,
  type ContextSnapshot,
} from './context-builder.js';
import {
  getFallbackPlan,
  type Action,
  type ActionPlan,
  type ModuleName,
} from './fallback-engine.js';
import {
  ActionDispatcher,
  type Observation,
  type ModuleHandlers,
} from './action-dispatcher.js';
import { CostOptimizer, type HashableState } from './cost-optimizer.js';
import { ModelRouter, type TriageResult } from './model-router.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum allowed cycle interval in ms (Requirement 2.1). */
export const MIN_INTERVAL_MS = 1_000;

/** Default cycle interval (1 minute). */
export const DEFAULT_INTERVAL_MS = 60_000;

/** LLM call timeout in ms (Requirement 2.6). */
export const LLM_TIMEOUT_MS = 30_000;

/** Number of consecutive LLM failures before switching to fallback (Req. 2.7). */
export const MAX_LLM_FAILURES = 5;

/** Maximum concurrent actions per cycle (Requirement 2.8). */
export const MAX_ACTIONS_PER_CYCLE = 10;

// ---------------------------------------------------------------------------
// System prompt template
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an autonomous income-generating AI agent.
Your goal is to generate USDC income through legitimate strategies: DeFi trading,
digital services, and content creation.

You operate according to a strict constitution (no harm, transparent identity,
proportional self-preservation). Your decisions must respect the current
survival tier and capability gates provided in the context.

Respond ONLY with a valid JSON object matching this schema:
{
  "reasoning": "<string - max 1-2 concise sentences, under 30 words>",
  "actions": [
    {
      "id": "<unique-string>",
      "module": "<identity|payment|trading|services|social|self-mod|replication|heartbeat|lending|lp|perps|marketplace>",
      "tool": "<tool-name>",
      "params": { ... },
      "priority": <1-10>
    }
  ],
  "expectedOutcome": "<string>"
}

Available modules:
- identity: wallet address and chain info
- payment: balance and Conway network status
- trading: execute DeFi arbitrage/swap opportunities
- services: list available x402 services
- social: post content to Telegram/Discord
- heartbeat: agent health status
- lending: Aave V3 USDC supply/monitoring
- lp: stablecoin LP provisioning
- perps: Hyperliquid perpetuals grid trading
- marketplace: autonomous task discovery and execution
- self-mod: code self-modification (Tier 3+ only)
- replication: agent replication (Tier 4+ only)

Keep actions concrete and executable. Do not include secrets or credentials in params.`;

// ---------------------------------------------------------------------------
// LLM response parsing helpers
// ---------------------------------------------------------------------------

interface RawActionPlan {
  reasoning?: unknown;
  actions?: unknown;
  expectedOutcome?: unknown;
}

const VALID_MODULES = new Set<ModuleName>([
  'identity', 'payment', 'trading', 'services',
  'social', 'self-mod', 'replication', 'heartbeat',
  'lending', 'lp', 'perps', 'marketplace',
]);

function isValidModule(m: unknown): m is ModuleName {
  return typeof m === 'string' && VALID_MODULES.has(m as ModuleName);
}

/**
 * Parse the raw LLM text response into a typed {@link ActionPlan}.
 * Throws if the response cannot be parsed or the schema is invalid.
 */
export function parseLlmResponse(raw: string): ActionPlan {
  let parsed: RawActionPlan;

  // The LLM may wrap the JSON in markdown code fences, include <think> reasoning blocks, or add preamble text
  let cleaned = raw.trim();

  // Strip DeepSeek reasoning blocks if present
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  // Try to extract JSON from markdown code fence first
  const codeFenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (codeFenceMatch?.[1]) {
    cleaned = codeFenceMatch[1].trim();
  } else {
    // Try to find a JSON object directly in the response
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    } else {
      // Remove leading/trailing code fence markers if present
      cleaned = cleaned
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/, '')
        .trim();
    }
  }

  try {
    parsed = JSON.parse(cleaned) as RawActionPlan;
  } catch (err: any) {
    // Attempt to repair truncated JSON
    try {
        let repaired = cleaned;
        if (!repaired.endsWith('}')) {
            // Remove trailing comma or partial key/value if present
            repaired = repaired.replace(/,?\s*("[^"]*"?|[^"}\]\s]*)$/, '');
            if (!repaired.endsWith(']')) repaired += ']';
            if (!repaired.endsWith('}')) repaired += '}';
        }
        parsed = JSON.parse(repaired) as RawActionPlan;
    } catch (repairErr: any) {
        // If repair fails, return a safe fallback to avoid crashing the ReActLoop
        console.warn('[ReActLoop] Failed to parse and repair LLM JSON. Returning safe fallback plan. Original error:', err.message);
        return {
            reasoning: 'LLM response was truncated or invalid. Safely skipping this cycle.',
            actions: [],
            expectedOutcome: 'Wait for next cycle.'
        };
    }
  }

  if (typeof parsed.reasoning !== 'string') {
    // Claude sometimes omits reasoning — use a default
    parsed.reasoning = 'No reasoning provided by LLM.';
  }
  if (!Array.isArray(parsed.actions)) {
    // LLM may return empty object or omit actions — treat as empty plan
    parsed.actions = [];
  }
  if (typeof parsed.expectedOutcome !== 'string') {
    parsed.expectedOutcome = 'No expected outcome provided.';
  }

  const actions: Action[] = (parsed.actions as unknown[]).map((raw, i) => {
    const a = raw as Record<string, unknown>;

    if (!a || typeof a !== 'object') {
      throw new Error(`Action[${i}] is not an object`);
    }
    if (typeof a['id'] !== 'string' || !a['id']) {
      throw new Error(`Action[${i}] missing or empty "id" field`);
    }
    if (!isValidModule(a['module'])) {
      throw new Error(`Action[${i}] has invalid module: ${String(a['module'])}`);
    }
    if (typeof a['tool'] !== 'string' || !a['tool']) {
      throw new Error(`Action[${i}] missing or empty "tool" field`);
    }
    if (typeof a['params'] !== 'object' || a['params'] === null || Array.isArray(a['params'])) {
      throw new Error(`Action[${i}] "params" must be a plain object`);
    }
    const priority = typeof a['priority'] === 'number' ? a['priority'] : 5;

    return {
      id: a['id'] as string,
      module: a['module'] as ModuleName,
      tool: a['tool'] as string,
      params: a['params'] as Record<string, unknown>,
      priority: Math.max(1, Math.min(10, Math.round(priority))),
    };
  });

  return {
    reasoning: parsed.reasoning as string,
    actions,
    expectedOutcome: parsed.expectedOutcome as string,
  };
}

// ---------------------------------------------------------------------------
// ReActLoop options
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the ReActLoop.
 */
export interface ReActLoopDeps {
  /** LLM MCP client (must already be connected). */
  llmClient: McpClient;

  /** Repository for persisting observations. */
  observationsRepo: ObservationsRepository;

  /** Typed event bus — used to emit cycle:completed. */
  eventBus: AgentEventBus;

  /**
   * Function that returns the current agent state for context building.
   * Called at the start of each Think phase.
   */
  getAgentState: () => AgentContextState;

  /** Module handler map for the ActionDispatcher. */
  moduleHandlers: ModuleHandlers;

  /** Optional CostOptimizer for caching LLM plans and adaptive intervals. */
  costOptimizer?: CostOptimizer;

  /** Optional ModelRouter for multi-model routing (cost reduction ~60%). */
  modelRouter?: ModelRouter;

  /** Optional pre-cycle hook executed before each Think phase. */
  preCycleHook?: () => Promise<void>;
}

/**
 * Configuration options for the ReActLoop.
 */
export interface ReActLoopOptions {
  /** Cycle interval in ms. Clamped to MIN_INTERVAL_MS (1 000 ms). */
  intervalMs?: number;

  /** Maximum concurrent actions per cycle. Defaults to MAX_ACTIONS_PER_CYCLE. */
  maxActionsPerCycle?: number;

  /** LLM timeout in ms. Defaults to LLM_TIMEOUT_MS (30 000). */
  llmTimeoutMs?: number;

  /** Max consecutive LLM failures before fallback. Defaults to MAX_LLM_FAILURES. */
  maxLlmFailures?: number;
}

// ---------------------------------------------------------------------------
// ReActLoop
// ---------------------------------------------------------------------------

export class ReActLoop {
  // --- config ---
  private intervalMs: number;
  private readonly maxActionsPerCycle: number;
  private readonly llmTimeoutMs: number;
  private readonly maxLlmFailures: number;

  // --- deps ---
  private readonly llmClient: McpClient;
  private readonly observationsRepo: ObservationsRepository;
  private readonly eventBus: AgentEventBus;
  private readonly getAgentState: () => AgentContextState;
  private readonly dispatcher: ActionDispatcher;
  private readonly moduleHandlers: ModuleHandlers;
  private readonly costOptimizer: CostOptimizer | null;
  private readonly modelRouter: ModelRouter | null;
  private readonly preCycleHook: (() => Promise<void>) | null;

  // --- state ---
  private running = false;
  private cycleTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveLlmFailures = 0;
  private inFallbackMode = false;
  private totalCycles = 0;

  constructor(deps: ReActLoopDeps, options: ReActLoopOptions = {}) {
    this.llmClient = deps.llmClient;
    this.observationsRepo = deps.observationsRepo;
    this.eventBus = deps.eventBus;
    this.getAgentState = deps.getAgentState;
    this.moduleHandlers = deps.moduleHandlers;
    this.costOptimizer = deps.costOptimizer ?? null;
    this.modelRouter = deps.modelRouter ?? null;
    this.preCycleHook = deps.preCycleHook ?? null;

    this.intervalMs = Math.max(
      MIN_INTERVAL_MS,
      options.intervalMs ?? DEFAULT_INTERVAL_MS,
    );
    this.maxActionsPerCycle = options.maxActionsPerCycle ?? MAX_ACTIONS_PER_CYCLE;
    this.llmTimeoutMs = options.llmTimeoutMs ?? LLM_TIMEOUT_MS;
    this.maxLlmFailures = options.maxLlmFailures ?? MAX_LLM_FAILURES;

    this.dispatcher = new ActionDispatcher(this.maxActionsPerCycle);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start the ReAct loop. Runs the first cycle immediately, then schedules
   * subsequent cycles at the configured interval.
   *
   * Requirement 2.1: interval ≥ 1 second.
   */
  async start(): Promise<void> {
    if (this.running) {
      throw new Error('ReActLoop is already running. Call stop() first.');
    }

    this.running = true;
    this.eventBus.emit('agent:started', Date.now());

    // Kick off the first cycle, then schedule recurring cycles
    this.scheduleNextCycle(0);
  }

  /**
   * Stop the loop gracefully. Waits for any in-progress cycle to finish
   * before resolving.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.cycleTimer !== null) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }

    this.eventBus.emit('agent:stopped', 'ReActLoop.stop() called');
  }

  /** Whether the loop is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  /** Whether the loop is currently in fallback rule-based mode. */
  isInFallbackMode(): boolean {
    return this.inFallbackMode;
  }

  /** Number of consecutive LLM failures since the last success. */
  getConsecutiveLlmFailures(): number {
    return this.consecutiveLlmFailures;
  }

  /** Total cycles executed since start. */
  getTotalCycles(): number {
    return this.totalCycles;
  }

  /** Dynamically change the cycle interval (ms). Takes effect on next scheduled cycle. */
  setIntervalMs(ms: number): void {
    this.intervalMs = Math.max(MIN_INTERVAL_MS, ms);
  }

  /** Get the current cycle interval (ms). */
  getIntervalMs(): number {
    return this.intervalMs;
  }

  // -------------------------------------------------------------------------
  // Core cycle
  // -------------------------------------------------------------------------

  /**
   * Execute one full Think → Act → Observe cycle.
   * Never throws — all errors are handled internally.
   */
  async runCycle(): Promise<void> {
    const cycleId = randomUUID();
    const cycleStartedAt = new Date().toISOString();

    // Run pre-cycle hook (AutoLender, MultiSourceScanner, etc.)
    if (this.preCycleHook) {
      try {
        await this.preCycleHook();
      } catch (err) {
        console.warn('[ReActLoop] Pre-cycle hook failed (non-fatal):', err);
      }
    }

    // Build context
    const state = this.getAgentState();
    const context = buildContext({
      ...state,
      consecutiveLlmFailures: this.consecutiveLlmFailures,
      cycleStartedAt,
      totalCycles: this.totalCycles,
    });

    // --- Think ---
    const plan = await this.think(context, state);

    // --- Act ---
    const observations = await this.act(plan);

    // --- Observe ---
    await this.observe(observations, cycleId, plan);

    this.totalCycles++;
    this.eventBus.emit('cycle:completed', cycleId, observations.length);
    // Signal heartbeat to record this cycle
    this.eventBus.emit('heartbeat:check', Date.now());

    // Update interval via CostOptimizer after cycle
    if (this.costOptimizer) {
      const hasOpportunities = (state.topOpportunities?.length ?? 0) > 0;
      const recommended = this.costOptimizer.getRecommendedInterval(hasOpportunities);
      if (recommended !== this.intervalMs) {
        const reason = hasOpportunities ? 'active' : 'idle';
        console.log(`[ReActLoop] Interval adjusted to ${recommended}ms (reason: ${reason})`);
        this.intervalMs = recommended;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Think phase
  // -------------------------------------------------------------------------

  /**
   * Think phase: query the LLM (or use fallback rules) to produce an ActionPlan.
   *
   * - If in fallback mode, skip the LLM and use getFallbackPlan directly.
   * - If the LLM times out or fails, increment the failure counter.
   * - After maxLlmFailures consecutive failures, engage fallback mode.
   * - CostOptimizer cache: if context hash matches a cached plan, skip LLM.
   *
   * Requirement 2.2, 2.6, 2.7
   */
  private async think(context: ContextSnapshot, state?: AgentContextState): Promise<ActionPlan> {
    // In fallback mode, skip LLM entirely
    if (this.inFallbackMode) {
      return getFallbackPlan(context);
    }

    // CostOptimizer cache check — skip LLM if we have a valid cached plan
    let contextHash: string | null = null;
    if (this.costOptimizer && state) {
      const hashableState: HashableState = {
        tier: state.tier,
        balanceUsdc: state.balanceUsdc,
        topOpportunities: state.topOpportunities,
        aaveState: (state as any).aaveState ?? 'idle',
      };
      contextHash = this.costOptimizer.computeContextHash(hashableState);
      const cached = this.costOptimizer.getCachedPlan(contextHash);
      if (cached) {
        console.log('[CostOptimizer] Cache hit, skipping LLM call');
        return cached;
      }
    }

    // Attempt LLM inference with timeout
    try {
      // ModelRouter triage — cheap Haiku call to decide if full LLM is needed
      if (this.modelRouter && this.modelRouter.isEnabled() && state) {
        const techRegime = (state as any).technicalIndicators
          ? ((state as any).technicalIndicators as string).match(/Regime: (\w+)/)?.[1] ?? 'unknown'
          : 'unavailable';
        const summary = this.modelRouter.buildTriageSummary({
          balanceUsdc: state.balanceUsdc,
          tier: state.tier,
          opportunityCount: state.topOpportunities?.length ?? 0,
          lastAction: 'cycle',
          aaveState: `regime:${techRegime}`,
        });

        const triageResult: TriageResult = await this.modelRouter.triage(summary, this.llmClient);
        const recommendedModel = this.modelRouter.getRecommendedModel(triageResult);

        if (recommendedModel === null) {
          // Haiku says "wait" → skip expensive LLM call entirely
          console.log('[ModelRouter] Triage: wait → skipping full LLM call');
          return {
            reasoning: 'ModelRouter triage: no actionable signal detected. Skipping LLM.',
            actions: [{
              id: `heartbeat-${Date.now()}`,
              module: 'heartbeat' as ModuleName,
              tool: 'emit_heartbeat',
              params: {},
              priority: 1,
            }],
            expectedOutcome: 'Heartbeat only — no signal detected.',
          };
        }
      }

      const plan = await withTimeout(
        this.callLlm(context),
        this.llmTimeoutMs,
        `LLM inference timed out after ${this.llmTimeoutMs}ms`,
      );

      // Success — reset failure counter and ensure fallback mode is off
      this.consecutiveLlmFailures = 0;
      this.inFallbackMode = false;
      // Signal LLM availability to heartbeat
      this.eventBus.emit('heartbeat:check', Date.now());

      // Cache the plan for future context matches
      if (this.costOptimizer && contextHash) {
        this.costOptimizer.cachePlan(contextHash, plan);
      }

      return plan;
    } catch (err) {
      this.consecutiveLlmFailures++;
      const reason = err instanceof Error ? err.message : String(err);

      console.warn(
        `[ReActLoop] LLM failure #${this.consecutiveLlmFailures}: ${reason}`,
      );

      // Check if we've hit the fallback threshold (Requirement 2.7)
      if (this.consecutiveLlmFailures >= this.maxLlmFailures) {
        if (!this.inFallbackMode) {
          console.warn(
            `[ReActLoop] Switching to fallback rule-based mode after ${this.consecutiveLlmFailures} consecutive LLM failures.`,
          );
          this.inFallbackMode = true;
        }
        return getFallbackPlan(context);
      }

      // Requirement 2.6: skip cycle by returning an empty plan
      return {
        reasoning: `LLM failure #${this.consecutiveLlmFailures}: ${reason}. Skipping cycle.`,
        actions: [],
        expectedOutcome: 'Cycle skipped due to LLM failure.',
      };
    }
  }

  /**
   * Call the LLM via the MCP LLM Server and parse the response into an ActionPlan.
   */
  private async callLlm(context: ContextSnapshot): Promise<ActionPlan> {
    const userMessage = buildUserMessage(context);

    const result = await this.llmClient.callTool<unknown>('infer', {
      systemPrompt: SYSTEM_PROMPT,
      userMessage,
      maxTokens: 2048,
    });

    if (!result.ok) {
      throw new Error(`MCP LLM error: ${result.error.message}`);
    }

    // The MCP llm-server returns an InferResult: { content, model, provider, ... }
    // The MCP client may parse it as a nested object or as a string.
    // We extract the text content robustly.
    const val = result.value;
    let rawContent = '';

    if (typeof val === 'string') {
      rawContent = val;
    } else if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      // InferResult shape: { content: string, model: string, ... }
      if (typeof obj['content'] === 'string') {
        rawContent = obj['content'];
      } else if (typeof obj['text'] === 'string') {
        rawContent = obj['text'];
      } else {
        // Last resort: stringify the whole object and hope the LLM embedded JSON
        rawContent = JSON.stringify(val);
      }
    }

    if (!rawContent.trim()) {
      throw new Error('LLM returned empty response');
    }

    console.log('[ReActLoop] Raw LLM response (first 500 chars):', rawContent.slice(0, 500));

    return parseLlmResponse(rawContent);
  }

  // -------------------------------------------------------------------------
  // Act phase
  // -------------------------------------------------------------------------

  /**
   * Act phase: dispatch all actions in the plan via the ActionDispatcher.
   *
   * Requirement 2.4, 2.8
   */
  private async act(plan: ActionPlan): Promise<Observation[]> {
    if (plan.actions.length === 0) {
      return [];
    }

    return this.dispatcher.dispatch(plan.actions, this.moduleHandlers);
  }

  // -------------------------------------------------------------------------
  // Observe phase
  // -------------------------------------------------------------------------

  /**
   * Observe phase: persist all observations to SQLite.
   *
   * Requirement 2.5
   */
  private async observe(
    observations: Observation[],
    cycleId: string,
    plan: ActionPlan,
  ): Promise<void> {
    if (observations.length === 0) return;

    // Look up the module/tool for each observation from the original plan
    const actionMap = new Map<string, Action>(
      plan.actions.map((a) => [a.id, a]),
    );

    try {
      this.observationsRepo.insertMany(
        observations.map((obs) => {
          const action = actionMap.get(obs.actionId);
          return {
            id: randomUUID(),
            actionId: obs.actionId,
            cycleId,
            module: action?.module ?? 'unknown',
            tool: action?.tool ?? 'unknown',
            success: obs.success,
            resultSummary: obs.result != null
              ? JSON.stringify(obs.result, (_k, v) =>
                  typeof v === 'bigint' ? v.toString() : v
                ).slice(0, 500)
              : undefined,
            error: obs.error ?? undefined,
            latencyMs: obs.latencyMs,
            timestamp: obs.timestamp,
          };
        }),
      );
    } catch (err) {
      // Non-fatal: log and continue (Requirement 12.4 — fallback log file not
      // implemented here; that's HeartbeatModule's concern)
      console.error('[ReActLoop] Failed to persist observations:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  private scheduleNextCycle(delayMs: number): void {
    if (!this.running) return;

    this.cycleTimer = setTimeout(() => {
      if (!this.running) return;

      this.runCycle()
        .catch((err) => {
          // runCycle should never throw, but be safe
          console.error('[ReActLoop] Unexpected cycle error:', err);
        })
        .finally(() => {
          // Schedule next cycle after the current one finishes
          if (this.running) {
            this.scheduleNextCycle(this.intervalMs);
          }
        });
    }, delayMs);
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Build the user message portion of the LLM prompt from the context snapshot.
 * Serialises the snapshot to JSON and includes basic human-readable summary.
 */
function buildUserMessage(ctx: ContextSnapshot): string {
  // Build optional sections
  const sections: string[] = [];

  sections.push(`## Current Agent State

- **Wallet**: ${ctx.walletAddress}
- **Balance**: $${ctx.balanceUsdcFormatted} USDC (raw: ${ctx.balanceUsdcRaw})
- **Tier**: ${ctx.tierLabel} (${ctx.tier})
- **Cycle**: #${ctx.totalCycles}
- **Consecutive LLM failures**: ${ctx.consecutiveLlmFailures}
- **Active strategies**: ${ctx.activeStrategies.length}
- **Pending tasks**: ${ctx.pendingTasks.length}
- **LLM budget multiplier**: ${ctx.gates.llmBudgetMultiplier}`);

  // Technical Indicators (from FeatureEngine)
  if (ctx.technicalIndicators) {
    sections.push(ctx.technicalIndicators);
  }

  // Aave position
  if (ctx.aavePosition) {
    sections.push(`## Aave V3 Position
- Deposited: $${ctx.aavePosition.depositedUsdc} USDC
- Interest accrued: $${ctx.aavePosition.accruedInterest}
- Current APY: ${(ctx.aavePosition.currentApyBps / 100).toFixed(2)}%`);
  }

  // Top opportunities
  if (ctx.topOpportunities.length > 0) {
    sections.push(`## Top Opportunities (${ctx.topOpportunities.length})
${ctx.topOpportunities.map(o => `- ${o.title} | ${o.type} | yield: ${o.estimatedYieldBps}bps | risk: ${o.riskLevel} | score: ${o.viabilityScore}`).join('\n')}`);
  }

  // Strategy rankings
  if (ctx.strategyRankings.top.length > 0 || ctx.strategyRankings.bottom.length > 0) {
    sections.push(`## Strategy Performance
Top: ${ctx.strategyRankings.top.map(s => `${s.source}: ${s.pnlPerDayUsdc}/day (${s.enabled ? '✅' : '❌'})`).join(', ')}
Bottom: ${ctx.strategyRankings.bottom.map(s => `${s.source}: ${s.pnlPerDayUsdc}/day (${s.enabled ? '✅' : '❌'})`).join(', ')}`);
  }

  sections.push(`## Capability Gates
\`\`\`json
${JSON.stringify(ctx.gates, (_k, v) => typeof v === 'bigint' ? v.toString() + 'n' : v, 2)}
\`\`\``);

  if (ctx.recentObservations.length > 0) {
    sections.push(`## Recent Observations (last ${ctx.recentObservations.length})
\`\`\`json
${JSON.stringify(ctx.recentObservations.slice(-5), null, 2)}
\`\`\``);
  }

  sections.push(`---
Decide what actions to take this cycle. Respect the capability gates.
Return ONLY the JSON ActionPlan.`);

  return sections.join('\n\n');
}

/**
 * Race a promise against a timeout. Rejects with `timeoutMessage` if the
 * timeout fires first.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

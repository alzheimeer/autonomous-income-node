/**
 * ModelRouter — Routes LLM calls to the cheapest appropriate model.
 *
 * Strategy:
 * - Haiku for triage ("is there a signal worth analyzing?")
 * - Sonnet only when Haiku says "yes" or context is complex
 * - Skip LLM entirely if CostOptimizer cache hit
 *
 * Cost savings: ~60% reduction by skipping expensive Sonnet calls
 * when no actionable signal is detected.
 *
 * Works ON TOP of CostOptimizer cache:
 *   CostOptimizer cache hit? → use cached (free)
 *   No cache? → ModelRouter triage (cheap Haiku call ~$0.001)
 *   Haiku says "wait"? → skip expensive LLM (save ~$0.03)
 *   Haiku says "signal"? → call full LLM (Sonnet)
 */

import type { McpClient } from '../mcp/client/mcp-client.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface ModelRouterConfig {
  /** Cheap, fast model for triage. Default: 'claude-haiku-4-5' */
  triageModel: string;
  /** Better reasoning model for full analysis. Default: 'claude-sonnet-4-20250514' */
  signalModel: string;
  /** Max triage cost per day in cents. Default: 10 */
  maxTriageCostPerDay: number;
  /** Whether model routing is enabled. Default: true */
  enabled: boolean;
}

export const DEFAULT_MODEL_ROUTER_CONFIG: ModelRouterConfig = {
  // Triage: DeepSeek V4 Flash — $0.002/día, ~1.2s, sin swap de VRAM
  // qwen3.5:9b local era 934ms pero causaba swaps de 60s al alternar con otros modelos
  triageModel: process.env['TRIAGE_MODEL'] ?? 'deepseek-v4-flash',
  // Análisis completo: DeepSeek V4 Flash — mismo modelo, sin latencia de carga
  signalModel: process.env['SIGNAL_MODEL'] ?? 'deepseek-v4-flash',
  maxTriageCostPerDay: 10,
  enabled: true,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type TriageResult = 'signal' | 'wait' | 'uncertain';

export interface TriageStats {
  totalTriages: number;
  signalCount: number;
  waitCount: number;
  uncertainCount: number;
  skippedLlmCalls: number;
  estimatedSavingsCents: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Triage prompt — kept SHORT to save tokens (< 50 tokens response)
// ═══════════════════════════════════════════════════════════════════════════════

const TRIAGE_PROMPT = `Given this market context, is there any actionable trading signal?
Respond ONLY with one word: signal / wait / uncertain`;

// ═══════════════════════════════════════════════════════════════════════════════
// ModelRouter
// ═══════════════════════════════════════════════════════════════════════════════

export class ModelRouter {
  private readonly config: ModelRouterConfig;
  private readonly stats: TriageStats = {
    totalTriages: 0,
    signalCount: 0,
    waitCount: 0,
    uncertainCount: 0,
    skippedLlmCalls: 0,
    estimatedSavingsCents: 0,
  };

  /** Daily triage cost tracking (reset at midnight) */
  private dailyTriageCostCents = 0;
  private lastResetDate = '';

  constructor(config: Partial<ModelRouterConfig> = {}) {
    this.config = { ...DEFAULT_MODEL_ROUTER_CONFIG, ...config };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Triage: ask Haiku if this context has any actionable signal.
   * Returns: 'signal' | 'wait' | 'uncertain'
   *
   * The context summary should be SHORT (1-2 lines):
   *   "Balance: $X, Tier: Y, Opportunities: Z, Last cycle action: W"
   */
  async triage(contextSummary: string, llmClient: McpClient): Promise<TriageResult> {
    if (!this.config.enabled) {
      return 'signal'; // If disabled, always proceed with full LLM
    }

    this.resetDailyIfNeeded();

    // If we've exceeded daily triage budget, skip triage and go to full LLM
    if (this.dailyTriageCostCents >= this.config.maxTriageCostPerDay) {
      console.log('[ModelRouter] Daily triage budget exceeded, defaulting to signal');
      return 'signal';
    }

    try {
      const result = await llmClient.callTool<unknown>('infer', {
        systemPrompt: TRIAGE_PROMPT,
        userMessage: contextSummary,
        model: this.config.triageModel,
      });

      // Track cost (~$0.001 per triage call = 0.1 cents)
      this.dailyTriageCostCents += 0.1;
      this.stats.totalTriages++;

      if (!result.ok) {
        // On triage failure, default to 'signal' (proceed with full LLM)
        return 'signal';
      }

      const response = this.extractContent(result.value);
      return this.parseTriageResponse(response);
    } catch {
      // Never throw — on error, default to proceeding with full LLM
      return 'signal';
    }
  }

  /**
   * Get the recommended model for the current context.
   * If triage says 'wait', returns null (skip LLM entirely).
   * If 'signal', returns signalModel.
   * If 'uncertain', returns triageModel again for a second check.
   */
  getRecommendedModel(triageResult: TriageResult): string | null {
    switch (triageResult) {
      case 'wait':
        this.stats.skippedLlmCalls++;
        this.stats.estimatedSavingsCents += 3; // ~$0.03 saved per skip
        return null;
      case 'signal':
        return this.config.signalModel;
      case 'uncertain':
        return this.config.triageModel;
      default:
        return this.config.signalModel;
    }
  }

  /**
   * Build a short context summary for triage (keeps token count minimal).
   */
  buildTriageSummary(params: {
    balanceUsdc: bigint;
    tier: number;
    opportunityCount: number;
    lastAction: string;
    aaveState?: string;
  }): string {
    const balanceFormatted = (Number(params.balanceUsdc) / 1_000_000).toFixed(2);
    return (
      `Balance: $${balanceFormatted}, Tier: ${params.tier}, ` +
      `Opportunities: ${params.opportunityCount}, ` +
      `Last action: ${params.lastAction}, Aave: ${params.aaveState ?? 'idle'}`
    );
  }

  /**
   * Get current triage statistics.
   */
  getStats(): Readonly<TriageStats> {
    return { ...this.stats };
  }

  /**
   * Whether model routing is enabled.
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private parseTriageResponse(raw: string): TriageResult {
    const normalized = raw.trim().toLowerCase();

    if (normalized.includes('signal')) {
      this.stats.signalCount++;
      return 'signal';
    }
    if (normalized.includes('wait')) {
      this.stats.waitCount++;
      return 'wait';
    }
    if (normalized.includes('uncertain')) {
      this.stats.uncertainCount++;
      return 'uncertain';
    }

    // If LLM gives an unexpected response, treat as 'signal' (safe default)
    this.stats.signalCount++;
    return 'signal';
  }

  private extractContent(val: unknown): string {
    if (typeof val === 'string') return val;
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (typeof obj['content'] === 'string') return obj['content'];
      if (typeof obj['text'] === 'string') return obj['text'];
    }
    return '';
  }

  private resetDailyIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyTriageCostCents = 0;
      this.lastResetDate = today;
    }
  }
}

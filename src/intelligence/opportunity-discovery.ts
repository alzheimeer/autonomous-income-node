/**
 * Opportunity Discovery Module
 *
 * Scans external APIs (DeFiLlama, x402 Bazaar, Hyperliquid) for income
 * opportunities and evaluates viability via LLM scoring. Actionable
 * opportunities are persisted to the knowledge_base table for the
 * ReAct loop to act upon.
 *
 * Requirements: 9.1, 9.2, 9.3
 */

import { randomUUID } from 'node:crypto';

import type { OpportunityDiscoveryConfig } from '../config/income-sustainability.config.js';
import type {
  KnowledgeBaseRepository,
  KnowledgeBaseRow,
} from '../state/repositories/knowledge-base.repo.js';
import type { McpClient, Result } from '../mcp/client/mcp-client.js';
import type { IHyperliquidApi } from '../strategies/perps/hyperliquid-api.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type OpportunityType =
  | 'defi_yield'
  | 'marketplace_task'
  | 'funding_arb'
  | 'new_protocol'
  | 'lp_pool';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface DiscoveredOpportunity {
  id: string;
  source: 'defillama' | 'x402_bazaar' | 'hyperliquid' | 'coingecko' | 'scrape';
  type: OpportunityType;
  title: string;
  description: string;
  estimatedYieldBps: number;
  riskLevel: RiskLevel;
  requiredCapitalUsdc: bigint;
  discoveredAt: number;
  viabilityScore: number;
  status: 'new' | 'actionable' | 'expired' | 'executed';
  metadata: Record<string, unknown>;
}

export interface IOpportunityDiscovery {
  scan(): Promise<DiscoveredOpportunity[]>;
  getTopOpportunities(limit?: number): DiscoveredOpportunity[];
  start(): void;
  stop(): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Extended config (adds bazaarUrl for the x402 scanner)
// ═══════════════════════════════════════════════════════════════════════════════

export interface OpportunityDiscoveryFullConfig extends OpportunityDiscoveryConfig {
  /** x402 Bazaar base URL (e.g. "https://bazaar.x402.org") */
  bazaarUrl?: string;
  /** Agent capabilities for task matching */
  capabilities?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DeFiLlama response types
// ═══════════════════════════════════════════════════════════════════════════════

interface DefiLlamaPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number | null;
  apyBase: number | null;
  stablecoin: boolean;
  exposure: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// x402 Bazaar response types
// ═══════════════════════════════════════════════════════════════════════════════

interface BazaarTask {
  id: string;
  title: string;
  description: string;
  reward_usdc: number;
  required_capabilities: string[];
  status: string;
  deadline?: string;
}

interface BazaarTasksResponse {
  tasks: BazaarTask[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// LLM response parsing
// ═══════════════════════════════════════════════════════════════════════════════

interface LlmTextContent {
  type: 'text';
  text: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

const DEFILLAMA_POOLS_URL = 'https://yields.llama.fi/pools';
const DEFAULT_INTERVAL_MS = 1_800_000; // 30 minutes
const DEFAULT_MIN_VIABILITY_SCORE = 70;
const DEFAULT_VIABILITY_SCORE = 50;
const FUNDING_RATE_THRESHOLD = 0.0001; // 0.01% per 8h = 10 bps

export class OpportunityDiscovery implements IOpportunityDiscovery {
  private readonly config: OpportunityDiscoveryFullConfig;
  private readonly repo: KnowledgeBaseRepository;
  private readonly llmClient: McpClient | null;
  private readonly hyperliquidApi: IHyperliquidApi | null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: OpportunityDiscoveryFullConfig,
    repo: KnowledgeBaseRepository,
    llmClient: McpClient | null,
    hyperliquidApi?: IHyperliquidApi | null,
  ) {
    this.config = config;
    this.repo = repo;
    this.llmClient = llmClient;
    this.hyperliquidApi = hyperliquidApi ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Run all scanners in parallel, score results, persist actionable ones.
   */
  async scan(): Promise<DiscoveredOpportunity[]> {
    const results = await Promise.allSettled([
      this.scanDeFiLlama(),
      this.scanBazaar(),
      this.scanHyperliquidFunding(),
    ]);

    const opportunities: DiscoveredOpportunity[] = [];

    for (const result of results) {
      if (result.status === 'fulfilled') {
        opportunities.push(...result.value);
      } else {
        console.warn(
          '[OpportunityDiscovery] Scanner failed:',
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    }

    // Score and persist
    const scored = await this.scoreAndPersist(opportunities);
    return scored;
  }

  /**
   * Return top actionable opportunities from DB.
   */
  getTopOpportunities(limit = 5): DiscoveredOpportunity[] {
    const rows = this.repo.getActionable(limit);
    return rows.map(rowToOpportunity);
  }

  /**
   * Start periodic scanning.
   */
  start(): void {
    if (this.intervalHandle !== null) return;

    const intervalMs = this.config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.intervalHandle = setInterval(() => {
      void this.scan().catch((err) => {
        console.error('[OpportunityDiscovery] Scan cycle error:', err);
      });
    }, intervalMs);

    // Run initial scan immediately
    void this.scan().catch((err) => {
      console.error('[OpportunityDiscovery] Initial scan error:', err);
    });
  }

  /**
   * Stop periodic scanning.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scanner: DeFiLlama
  // ─────────────────────────────────────────────────────────────────────────────

  private async scanDeFiLlama(): Promise<DiscoveredOpportunity[]> {
    const response = await fetch(DEFILLAMA_POOLS_URL, {
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`DeFiLlama returned ${response.status}`);
    }

    const json = (await response.json()) as { data: DefiLlamaPool[] };
    const pools = json.data ?? [];

    // Filter: Base chain only, valid APY
    const basePools = pools
      .filter(
        (p) =>
          p.chain?.toLowerCase() === 'base' &&
          p.apy !== null &&
          p.apy !== undefined &&
          p.apy > 0,
      )
      .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
      .slice(0, 10);

    return basePools.map((pool): DiscoveredOpportunity => {
      const apyBps = Math.round((pool.apy ?? 0) * 100);
      const riskLevel = this.assessDefiRisk(pool);

      return {
        id: randomUUID(),
        source: 'defillama',
        type: 'defi_yield',
        title: `${pool.project} - ${pool.symbol}`,
        description: `DeFi yield on ${pool.project} (${pool.symbol}) on Base. TVL: $${Math.round(pool.tvlUsd).toLocaleString()}. Stablecoin: ${pool.stablecoin}`,
        estimatedYieldBps: apyBps,
        riskLevel,
        requiredCapitalUsdc: pool.stablecoin ? 20_000000n : 50_000000n,
        discoveredAt: Date.now(),
        viabilityScore: 0,
        status: 'new',
        metadata: {
          poolId: pool.pool,
          project: pool.project,
          symbol: pool.symbol,
          tvlUsd: pool.tvlUsd,
          apy: pool.apy,
          stablecoin: pool.stablecoin,
          exposure: pool.exposure,
        },
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scanner: x402 Bazaar
  // ─────────────────────────────────────────────────────────────────────────────

  private async scanBazaar(): Promise<DiscoveredOpportunity[]> {
    const bazaarUrl = this.config.bazaarUrl;
    if (!bazaarUrl) {
      return [];
    }

    const url = `${bazaarUrl}/v1/tasks?status=open`;
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`x402 Bazaar returned ${response.status}`);
    }

    const json = (await response.json()) as BazaarTasksResponse;
    const tasks = json.tasks ?? [];

    // Filter by matching capabilities
    const agentCapabilities = new Set(this.config.capabilities ?? []);
    const matchingTasks = tasks.filter((task) =>
      task.required_capabilities.some((cap) => agentCapabilities.has(cap)),
    );

    return matchingTasks.map((task): DiscoveredOpportunity => {
      // Convert reward to bps estimate (annualized from a single task is not meaningful,
      // so we store the raw reward as bps equivalent for comparison)
      const rewardBps = Math.round(task.reward_usdc * 100); // $1 reward = 100 bps equivalent

      return {
        id: randomUUID(),
        source: 'x402_bazaar',
        type: 'marketplace_task',
        title: task.title,
        description: task.description,
        estimatedYieldBps: rewardBps,
        riskLevel: 'low',
        requiredCapitalUsdc: 0n, // Tasks don't require capital
        discoveredAt: Date.now(),
        viabilityScore: 0,
        status: 'new',
        metadata: {
          taskId: task.id,
          rewardUsdc: task.reward_usdc,
          requiredCapabilities: task.required_capabilities,
          deadline: task.deadline,
        },
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scanner: Hyperliquid Funding Rates
  // ─────────────────────────────────────────────────────────────────────────────

  private async scanHyperliquidFunding(): Promise<DiscoveredOpportunity[]> {
    if (!this.hyperliquidApi) {
      return [];
    }

    const fundingRates = await this.hyperliquidApi.getFundingRates();

    // Filter: rate > 0.01% (10 bps per 8h)
    // Annualized: rate * 3 (per day) * 365 = rate * 1095
    const profitable = fundingRates.filter((fr) => fr.rate > FUNDING_RATE_THRESHOLD);

    return profitable.map((fr): DiscoveredOpportunity => {
      // Annualize: rate per 8h → rate per year (×3×365 = ×1095)
      const annualizedBps = Math.round(fr.rate * 1095 * 10_000);

      return {
        id: randomUUID(),
        source: 'hyperliquid',
        type: 'funding_arb',
        title: `${fr.coin} Funding Rate Arb`,
        description: `Funding rate arbitrage on ${fr.coin}. Current 8h rate: ${(fr.rate * 100).toFixed(4)}%. Annualized: ~${annualizedBps} bps.`,
        estimatedYieldBps: annualizedBps,
        riskLevel: this.assessFundingRisk(fr.rate),
        requiredCapitalUsdc: 10_000000n, // $10 minimum margin
        discoveredAt: Date.now(),
        viabilityScore: 0,
        status: 'new',
        metadata: {
          coin: fr.coin,
          fundingRate8h: fr.rate,
          annualizedBps,
        },
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Scoring & Persistence
  // ─────────────────────────────────────────────────────────────────────────────

  private async scoreAndPersist(
    opportunities: DiscoveredOpportunity[],
  ): Promise<DiscoveredOpportunity[]> {
    const minScore = this.config.minViabilityScore ?? DEFAULT_MIN_VIABILITY_SCORE;
    const results: DiscoveredOpportunity[] = [];

    for (const opp of opportunities) {
      // Deduplication: check if we already have this protocol+type combo
      const protocolName = this.extractProtocolName(opp);
      const existing = this.repo.findDuplicate(protocolName, opp.type);
      if (existing) {
        // Update existing entry score if it's still active
        if (existing.status === 'new' || existing.status === 'actionable') {
          continue; // Skip duplicate
        }
      }

      // LLM viability scoring
      const score = await this.getViabilityScore(opp);
      opp.viabilityScore = score;
      opp.status = score >= minScore ? 'actionable' : 'new';

      // Persist to knowledge_base
      this.repo.insert({
        id: opp.id,
        source: opp.source,
        type: opp.type,
        title: opp.title,
        description: opp.description,
        protocol_name: protocolName,
        estimated_yield_bps: opp.estimatedYieldBps,
        risk_level: opp.riskLevel,
        required_capital_usdc: opp.requiredCapitalUsdc.toString(),
        viability_score: opp.viabilityScore,
        status: opp.status,
        metadata: JSON.stringify(opp.metadata),
        discovered_at: opp.discoveredAt,
      });

      results.push(opp);
    }

    return results;
  }

  /**
   * Request LLM viability scoring. Falls back to DEFAULT_VIABILITY_SCORE on failure.
   */
  private async getViabilityScore(opp: DiscoveredOpportunity): Promise<number> {
    if (!this.llmClient) {
      return DEFAULT_VIABILITY_SCORE;
    }

    const prompt = [
      'Score this opportunity 0-100 based on viability for an autonomous agent with $99 USDC capital on Base chain.',
      'Consider: required capital, risk level, alignment with honest earning (no exploits/manipulation), expected ROI.',
      'Respond with only a number 0-100.',
      `Opportunity: ${opp.title} - ${opp.description} - Estimated yield: ${opp.estimatedYieldBps} bps - Risk: ${opp.riskLevel}`,
    ].join('\n');

    try {
      const result: Result<unknown> = await this.llmClient.callTool('generate_text', {
        prompt,
        maxTokens: 10,
      });

      if (!result.ok) {
        console.warn('[OpportunityDiscovery] LLM scoring failed:', result.error.message);
        return DEFAULT_VIABILITY_SCORE;
      }

      // Parse the numeric response
      const value = result.value;
      const text = this.extractTextFromResult(value);
      const score = Number.parseInt(text.trim(), 10);

      if (Number.isNaN(score) || score < 0 || score > 100) {
        return DEFAULT_VIABILITY_SCORE;
      }

      return score;
    } catch (err) {
      console.warn(
        '[OpportunityDiscovery] LLM scoring error:',
        err instanceof Error ? err.message : String(err),
      );
      return DEFAULT_VIABILITY_SCORE;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private extractTextFromResult(value: unknown): string {
    // MCP tool results typically have { content: [{ type: 'text', text: '...' }] }
    if (value && typeof value === 'object') {
      const obj = value as Record<string, unknown>;
      if (Array.isArray(obj.content)) {
        const textContent = obj.content.find(
          (c): c is LlmTextContent =>
            typeof c === 'object' && c !== null && (c as LlmTextContent).type === 'text',
        );
        if (textContent) return textContent.text;
      }
      // Direct string value
      if (typeof obj.text === 'string') return obj.text;
    }
    if (typeof value === 'string') return value;
    return String(value);
  }

  private extractProtocolName(opp: DiscoveredOpportunity): string {
    const meta = opp.metadata;
    if (typeof meta.project === 'string') return meta.project;
    if (typeof meta.coin === 'string') return meta.coin;
    if (typeof meta.taskId === 'string') return `bazaar_${meta.taskId}`;
    return opp.title.toLowerCase().replace(/\s+/g, '_').slice(0, 64);
  }

  private assessDefiRisk(pool: DefiLlamaPool): RiskLevel {
    // Stablecoin pools with high TVL → low risk
    if (pool.stablecoin && pool.tvlUsd > 1_000_000) return 'low';
    // Non-stablecoin or low TVL → higher risk
    if (!pool.stablecoin || pool.tvlUsd < 100_000) return 'high';
    return 'medium';
  }

  private assessFundingRisk(rate: number): RiskLevel {
    // Very high rates can reverse quickly
    if (rate > 0.001) return 'high'; // >0.1% per 8h
    if (rate > 0.0003) return 'medium'; // >0.03% per 8h
    return 'low';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Row → Domain conversion helper
// ═══════════════════════════════════════════════════════════════════════════════

function rowToOpportunity(row: KnowledgeBaseRow): DiscoveredOpportunity {
  return {
    id: row.id,
    source: row.source as DiscoveredOpportunity['source'],
    type: row.type as OpportunityType,
    title: row.title,
    description: row.description ?? '',
    estimatedYieldBps: row.estimated_yield_bps ?? 0,
    riskLevel: (row.risk_level as RiskLevel) ?? 'medium',
    requiredCapitalUsdc: BigInt(row.required_capital_usdc ?? '0'),
    discoveredAt: row.discovered_at,
    viabilityScore: row.viability_score,
    status: row.status as DiscoveredOpportunity['status'],
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {},
  };
}

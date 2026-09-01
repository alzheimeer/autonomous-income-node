/**
 * Knowledge Acquirer — Continuous Discovery Module
 *
 * Discovers new protocols, income sources, and opportunities from DeFi
 * ecosystem sources. Scores them via LLM and persists actionable entries
 * for the ReAct loop to evaluate and integrate.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5
 */

import { randomUUID } from 'node:crypto';

import type { McpClient } from '../mcp/client/mcp-client.js';
import type {
  KnowledgeBaseRepository,
  KnowledgeBaseRow,
} from '../state/repositories/knowledge-base.repo.js';
import type { KnowledgeAcquirerConfig } from '../config/income-sustainability.config.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface KnowledgeEntry {
  id: string;
  protocolName: string;
  type: 'lending' | 'dex' | 'yield' | 'service' | 'perps' | 'bridge';
  estimatedApyBps: number;
  requiredCapitalUsdc: bigint;
  riskFactors: string[];
  viabilityScore: number;
  source: string;
  status: 'new' | 'actionable' | 'dismissed' | 'integrated';
  discoveredAt: number;
  lastEvaluatedAt: number;
  /** Optional extra context for the AdaptiveEvolver LLM prompt (e.g. from research proposals) */
  description?: string;
}

export interface KnowledgeSource {
  name: string;
  url: string;
  type: 'api' | 'html_scrape';
}

export interface IKnowledgeAcquirer {
  acquire(): Promise<KnowledgeEntry[]>;
  getActionableEntries(limit?: number): KnowledgeEntry[];
  start(): void;
  stop(): void;
  isDuplicate(protocolName: string, type: string): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Default sources
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_SOURCES: KnowledgeSource[] = [
  {
    name: 'DeFiLlama Base',
    url: 'https://yields.llama.fi/pools',
    type: 'api' as const,
  },
  {
    name: 'CoinGecko Base',
    url: 'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&category=base-ecosystem&order=volume_desc',
    type: 'api' as const,
  },
];

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_VIABILITY_SCORE = 50;
const VALID_TYPES = new Set<KnowledgeEntry['type']>([
  'lending',
  'dex',
  'yield',
  'service',
  'perps',
  'bridge',
]);

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class KnowledgeAcquirer implements IKnowledgeAcquirer {
  private readonly config: KnowledgeAcquirerConfig;
  private readonly sources: KnowledgeSource[];
  private readonly repo: KnowledgeBaseRepository;
  private readonly llmClient: McpClient | null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    config: KnowledgeAcquirerConfig,
    repo: KnowledgeBaseRepository,
    llmClient?: McpClient,
  ) {
    this.config = config;
    this.repo = repo;
    this.llmClient = llmClient ?? null;
    this.sources = DEFAULT_SOURCES;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // acquire() — Main discovery loop (Req 10.1, 10.2)
  // ─────────────────────────────────────────────────────────────────────────

  async acquire(): Promise<KnowledgeEntry[]> {
    const discovered: KnowledgeEntry[] = [];

    for (const source of this.sources) {
      try {
        const entries = await this.processSource(source);
        discovered.push(...entries);
      } catch (err) {
        // Req 10.5: If a source fails, log error and continue
        console.error(
          `[KnowledgeAcquirer] Source "${source.name}" failed:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return discovered;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getActionableEntries() — Retrieve top actionable entries (Req 10.3)
  // ─────────────────────────────────────────────────────────────────────────

  getActionableEntries(limit = 5): KnowledgeEntry[] {
    const rows = this.repo.getActionable(limit);
    return rows.map((row) => this.rowToEntry(row));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // start() / stop() — Scheduled scanning (Req 10.4)
  // ─────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.intervalHandle !== null) return;

    this.intervalHandle = setInterval(() => {
      void this.acquire().catch((err) => {
        console.error(
          '[KnowledgeAcquirer] Scheduled scan failed:',
          err instanceof Error ? err.message : String(err),
        );
      });
    }, this.config.intervalMs);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // isDuplicate() — Check for existing protocol/type combo
  // ─────────────────────────────────────────────────────────────────────────

  isDuplicate(protocolName: string, type: string): boolean {
    return this.repo.findDuplicate(protocolName, type) !== null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Process a single source: fetch, parse, deduplicate, score, store.
   */
  private async processSource(source: KnowledgeSource): Promise<KnowledgeEntry[]> {
    // Step 1: Fetch with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(source.url, { signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${source.url}`);
    }

    // Step 2: Parse response
    const rawData: unknown = await response.json();
    const candidates = this.extractCandidates(rawData, source);

    // Step 3-7: Deduplicate, score, and store
    const entries: KnowledgeEntry[] = [];

    for (const candidate of candidates) {
      // Step 4: Deduplicate
      if (this.repo.findDuplicate(candidate.protocolName, candidate.type) !== null) {
        continue;
      }

      // Step 5: Score via LLM (or default)
      const score = await this.scoreCandidate(candidate);

      // Step 6: Determine status
      const status: KnowledgeEntry['status'] =
        score >= this.config.minActionableScore ? 'actionable' : 'new';

      const now = Date.now();
      const entry: KnowledgeEntry = {
        id: randomUUID(),
        protocolName: candidate.protocolName,
        type: candidate.type,
        estimatedApyBps: candidate.estimatedApyBps,
        requiredCapitalUsdc: candidate.requiredCapitalUsdc,
        riskFactors: candidate.riskFactors,
        viabilityScore: score,
        source: source.name,
        status,
        discoveredAt: now,
        lastEvaluatedAt: now,
      };

      // Step 7: Store in knowledge_base
      this.repo.insert({
        id: entry.id,
        source: entry.source,
        type: entry.type,
        title: entry.protocolName,
        protocol_name: entry.protocolName,
        estimated_yield_bps: entry.estimatedApyBps,
        risk_level: this.riskLevel(entry.riskFactors),
        required_capital_usdc: entry.requiredCapitalUsdc.toString(),
        viability_score: entry.viabilityScore,
        status: entry.status,
        metadata: JSON.stringify({
          riskFactors: entry.riskFactors,
        }),
        discovered_at: entry.discoveredAt,
        last_evaluated_at: entry.lastEvaluatedAt,
      });

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Extract candidate entries from raw API response data.
   * Handles DeFiLlama pools format and CoinGecko markets format.
   */
  private extractCandidates(
    rawData: unknown,
    source: KnowledgeSource,
  ): CandidateEntry[] {
    const candidates: CandidateEntry[] = [];

    if (!rawData || typeof rawData !== 'object') return candidates;

    // DeFiLlama format: { data: [{ pool, project, chain, apy, tvlUsd, ... }] }
    if (source.name.includes('DeFiLlama')) {
      const data = (rawData as Record<string, unknown>).data;
      if (!Array.isArray(data)) return candidates;

      for (const pool of data) {
        if (!isRecord(pool)) continue;

        const chain = String(pool.chain ?? '').toLowerCase();
        // Only Base chain pools
        if (chain !== 'base') continue;

        const name = String(pool.project ?? pool.pool ?? '');
        const apy = Number(pool.apy ?? 0);
        const tvl = Number(pool.tvlUsd ?? 0);

        if (!name || apy <= 0) continue;

        const type = this.classifyProtocolType(pool);
        if (!type) continue;

        candidates.push({
          protocolName: name,
          type,
          estimatedApyBps: Math.round(apy * 100),
          requiredCapitalUsdc: this.estimateRequiredCapital(tvl),
          riskFactors: this.assessRiskFactors(pool),
        });
      }
    }

    // CoinGecko format: [{ id, symbol, name, market_cap, total_volume, ... }]
    if (source.name.includes('CoinGecko')) {
      if (!Array.isArray(rawData)) return candidates;

      for (const coin of rawData) {
        if (!isRecord(coin)) continue;

        const name = String(coin.name ?? coin.id ?? '');
        if (!name) continue;

        // CoinGecko doesn't provide APY directly; estimate based on volume
        const volume = Number(coin.total_volume ?? 0);
        const marketCap = Number(coin.market_cap ?? 0);

        // Only include if reasonable volume/market cap ratio suggests activity
        if (volume < 10_000 || marketCap < 100_000) continue;

        candidates.push({
          protocolName: name,
          type: 'dex', // Default classification for ecosystem tokens
          estimatedApyBps: 0, // Unknown APY; LLM will evaluate
          requiredCapitalUsdc: 99_000000n, // $99 max for MVP agent
          riskFactors: ['unverified_apy', 'ecosystem_token'],
        });
      }
    }

    return candidates;
  }

  /**
   * Classify a DeFiLlama pool into a protocol type.
   */
  private classifyProtocolType(
    pool: Record<string, unknown>,
  ): KnowledgeEntry['type'] | null {
    const symbol = String(pool.symbol ?? '').toLowerCase();
    const project = String(pool.project ?? '').toLowerCase();
    const category = String(pool.category ?? '').toLowerCase();

    if (category.includes('lending') || category.includes('lend')) return 'lending';
    if (category.includes('dex') || category.includes('swap')) return 'dex';
    if (category.includes('yield') || category.includes('farm')) return 'yield';
    if (category.includes('bridge')) return 'bridge';
    if (category.includes('perp') || category.includes('derivative')) return 'perps';
    if (category.includes('service')) return 'service';

    // Heuristic fallback
    if (project.includes('aave') || project.includes('compound') || project.includes('lend')) return 'lending';
    if (project.includes('uniswap') || project.includes('swap') || project.includes('dex')) return 'dex';
    if (symbol.includes('lp') || project.includes('farm')) return 'yield';
    if (project.includes('bridge') || project.includes('hop') || project.includes('stargate')) return 'bridge';
    if (project.includes('perp') || project.includes('gmx')) return 'perps';

    // Default to yield for unclassified pools with APY
    return 'yield';
  }

  /**
   * Estimate required capital from TVL — agent has $99 max.
   * For pools with very high TVL, minimum entry is likely small.
   */
  private estimateRequiredCapital(tvl: number): bigint {
    // Agent has $99 max, so always cap at that
    if (tvl > 1_000_000) return 10_000000n; // $10 minimum for large pools
    if (tvl > 100_000) return 25_000000n; // $25 for medium pools
    return 50_000000n; // $50 for small pools (higher relative impact)
  }

  /**
   * Assess risk factors from pool metadata.
   */
  private assessRiskFactors(pool: Record<string, unknown>): string[] {
    const factors: string[] = [];

    const tvl = Number(pool.tvlUsd ?? 0);
    const apy = Number(pool.apy ?? 0);
    const ilRisk = Boolean(pool.ilRisk);
    const stablecoin = Boolean(pool.stablecoin);

    if (tvl < 100_000) factors.push('low_tvl');
    if (apy > 100) factors.push('high_apy_suspicious');
    if (apy > 1000) factors.push('extreme_apy');
    if (ilRisk) factors.push('impermanent_loss');
    if (!stablecoin) factors.push('volatile_assets');

    const exposure = String(pool.exposure ?? '').toLowerCase();
    if (exposure.includes('single')) factors.push('single_asset');

    return factors;
  }

  /**
   * Score a candidate using LLM client, or return default score.
   */
  private async scoreCandidate(candidate: CandidateEntry): Promise<number> {
    if (!this.llmClient) return DEFAULT_VIABILITY_SCORE;

    const apyPercent = (candidate.estimatedApyBps / 100).toFixed(2);
    const capitalUsd = Number(candidate.requiredCapitalUsdc) / 1_000_000;

    const prompt = [
      'Score this DeFi protocol opportunity 0-100 for an autonomous AI agent with $99 USDC on Base.',
      `Protocol: ${candidate.protocolName}, Type: ${candidate.type}, APY: ${apyPercent}%, Capital needed: $${capitalUsd}`,
      'Consider: is it legitimate? Does it require human verification? Can an agent interact programmatically?',
      'Respond with only a number.',
    ].join('\n');

    try {
      const result = await this.llmClient.callTool<{ text: string }>('generate_text', {
        prompt,
        maxTokens: 10,
      });

      if (result.ok && result.value?.text) {
        const score = parseInt(result.value.text.trim(), 10);
        if (!isNaN(score) && score >= 0 && score <= 100) {
          return score;
        }
      }

      return DEFAULT_VIABILITY_SCORE;
    } catch {
      // If LLM scoring fails, assign default score of 50
      return DEFAULT_VIABILITY_SCORE;
    }
  }

  /**
   * Determine risk level string from risk factors array.
   */
  private riskLevel(factors: string[]): string {
    if (factors.includes('extreme_apy') || factors.includes('high_apy_suspicious')) {
      return 'high';
    }
    if (factors.includes('low_tvl') || factors.includes('impermanent_loss')) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Convert a repository row back to a KnowledgeEntry.
   */
  private rowToEntry(row: KnowledgeBaseRow): KnowledgeEntry {
    let riskFactors: string[] = [];
    if (row.metadata) {
      try {
        const parsed = JSON.parse(row.metadata) as { riskFactors?: string[] };
        riskFactors = parsed.riskFactors ?? [];
      } catch {
        riskFactors = [];
      }
    }

    return {
      id: row.id,
      protocolName: row.protocol_name ?? row.title,
      type: this.validateType(row.type),
      estimatedApyBps: row.estimated_yield_bps ?? 0,
      requiredCapitalUsdc: BigInt(row.required_capital_usdc ?? '0'),
      riskFactors,
      viabilityScore: row.viability_score,
      source: row.source,
      status: (row.status as KnowledgeEntry['status']) ?? 'new',
      discoveredAt: row.discovered_at,
      lastEvaluatedAt: row.last_evaluated_at ?? row.discovered_at,
    };
  }

  /**
   * Validate and coerce a type string to a valid KnowledgeEntry type.
   */
  private validateType(type: string): KnowledgeEntry['type'] {
    if (VALID_TYPES.has(type as KnowledgeEntry['type'])) {
      return type as KnowledgeEntry['type'];
    }
    return 'yield'; // safe default
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal types
// ═══════════════════════════════════════════════════════════════════════════════

interface CandidateEntry {
  protocolName: string;
  type: KnowledgeEntry['type'];
  estimatedApyBps: number;
  requiredCapitalUsdc: bigint;
  riskFactors: string[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

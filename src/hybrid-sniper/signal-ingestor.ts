/**
 * Hybrid Sniper — SignalIngestor
 *
 * Ingests token signals from four sources:
 *   1. DexScreener polling (GET /token-boosts/latest/v1) every pollIntervalMs
 *   2. GeckoTerminal polling (GET /networks/base/new_pools) every geckoIntervalMs
 *   3. Bitquery GraphQL polling (new tokens on Base in last 5 min) every pollIntervalMs
 *   4. Webhook POST /webhook/alpha (ingestWebhook)
 *
 * Features:
 *   - Dedup window: 60s sliding Map<contractAddress, lastSeenMs>
 *     with per-cycle purge of expired entries
 *   - DexScreener rate-limit handling: 429 → pause 60s
 *   - GeckoTerminal rate-limit handling: 429 → pause 60s (30 calls/min free, no key required)
 *   - Bitquery auth handling: 401 → disable for session
 *   - Non-blocking validator call (fire-and-forget)
 *   - Stats: totalReceived, totalDeduped
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
 */

import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { SniperSignal, IMetricsRecorder, IContractValidator } from '../shared/index.js';

const log = createLogger('signal-ingestor');

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export interface DexScreenerPair {
  chainId: string;
  /** Pool/pair address from DexScreener (this is the liquidity pool, not the token) */
  pairAddress?: string;
  baseToken: { address: string; symbol: string };
  volume: { h1: number };
  liquidity: { usd: number };
}

/** GeckoTerminal new_pools response pool entry */
export interface GeckoTerminalPool {
  id: string;
  attributes: {
    name: string;
    address: string;           // pool address
    pool_created_at: string;   // ISO timestamp
    reserve_in_usd: string;
    fdv_usd: string | null;
    volume_usd: { h1: string };
    transactions: { m5: { buys: number; sells: number } };
  };
  relationships: {
    base_token: { data: { id: string } };  // "base_0xADDRESS"
    dex: { data: { id: string } };         // "uniswap-v3-base", "aerodrome-v2-base", etc.
  };
}

export interface BitqueryToken {
  address: string;
  symbol: string;
}

export interface WebhookBody {
  ticker: string;
  contractAddress: string;
  source: string;
}

export interface ISignalIngestor {
  start(): void;
  stop(): void;
  ingestWebhook(body: WebhookBody): Promise<SniperSignal>;
  getStats(): { totalReceived: number; totalDeduped: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const DEXSCREENER_URL = 'https://api.dexscreener.com/token-boosts/latest/v1';
// Endpoint alternativo para pares activos de Base (cuando token-boosts no devuelve Base):
// /latest/dex/pairs/base devuelve 404
// /latest/dex/search?q=USDC&chainId=base devuelve 404 (chainId query param deprecated)
// Solución: usar token-profiles que devuelve tokens recientes cross-chain, filtrar a base
const DEXSCREENER_TOKEN_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1';
// Fallback directo: search sin chainId param (retorna todas las chains, filtramos a base)
const DEXSCREENER_BASE_SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search/?q=WETH+base';
const GECKOTERMINAL_BASE_NEW_POOLS_URL = 'https://api.geckoterminal.com/api/v2/networks/base/new_pools';
// Bitquery v2 (streaming.bitquery.io) - usando nueva API key pagada
const BITQUERY_URL = 'https://streaming.bitquery.io/graphql';
const DEDUP_WINDOW_MS = 60_000;
const DEXSCREENER_RATE_LIMIT_PAUSE_MS = 60_000;
const GECKOTERMINAL_RATE_LIMIT_PAUSE_MS = 120_000; // 2 min pause after 429
const GECKOTERMINAL_POLL_INTERVAL_MS = 25_000; // 25s polling — conservative to avoid 429 (free tier: 30 calls/min)
const MAX_PAIRS_PER_CYCLE = 20;

// ═══════════════════════════════════════════════════════════════════════════
// SignalIngestor
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SignalIngestor normalises and dispatches token signals from multiple sources.
 *
 * Dedup logic: a contractAddress seen within the last 60 seconds is silently
 * dropped (counted as totalDeduped). Expired entries are purged on every check.
 */
export class SignalIngestor implements ISignalIngestor {
  private readonly contractValidator: IContractValidator;
  private readonly metricsRecorder: IMetricsRecorder | null;
  private readonly pollIntervalMs: number;
  private readonly bitqueryApiKey: string | null;

  /** contractAddress → lastSeenMs */
  private dedupMap = new Map<string, number>();

  private dexscreenerPausedUntil = 0;
  private geckoTerminalPausedUntil = 0;
  private bitqueryDisabled = false;
  private bitqueryWarnedOnce = false;

  private dexscreenerIntervalId: ReturnType<typeof setInterval> | null = null;
  private geckoTerminalIntervalId: ReturnType<typeof setInterval> | null = null;
  private bitqueryIntervalId: ReturnType<typeof setInterval> | null = null;
  private totalReceived = 0;
  private totalDeduped = 0;

  constructor(
    contractValidator: IContractValidator,
    config: {
      pollIntervalMs: number;
      bitqueryApiKey: string | null;
      metricsRecorder?: IMetricsRecorder | null;
      wsProviderUrl?: string | null;
    },
  ) {
    this.contractValidator = contractValidator;
    this.pollIntervalMs = config.pollIntervalMs ?? 3_000; // Fast 3s polling for low latency
    this.bitqueryApiKey = config.bitqueryApiKey;
    this.metricsRecorder = config.metricsRecorder ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /** Start polling DexScreener, GeckoTerminal, and Bitquery at the configured intervals. */
  start(): void {
    this.dexscreenerIntervalId = setInterval(() => {
      void this.pollDexScreener();
    }, this.pollIntervalMs);

    // GeckoTerminal: free, no API key, 30 calls/min — poll every 25s (conservative)
    // With 25s interval we make ~2.4 calls/min, well under the 30/min limit
    this.geckoTerminalIntervalId = setInterval(() => {
      void this.pollGeckoTerminal();
    }, GECKOTERMINAL_POLL_INTERVAL_MS);

    this.bitqueryIntervalId = setInterval(() => {
      void this.pollBitquery();
    }, this.pollIntervalMs);
  }

  /** Stop all polling intervals. */
  stop(): void {
    if (this.dexscreenerIntervalId !== null) {
      clearInterval(this.dexscreenerIntervalId);
      this.dexscreenerIntervalId = null;
    }
    if (this.geckoTerminalIntervalId !== null) {
      clearInterval(this.geckoTerminalIntervalId);
      this.geckoTerminalIntervalId = null;
    }
    if (this.bitqueryIntervalId !== null) {
      clearInterval(this.bitqueryIntervalId);
      this.bitqueryIntervalId = null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stats
  // ─────────────────────────────────────────────────────────────────────────

  getStats(): { totalReceived: number; totalDeduped: number } {
    return {
      totalReceived: this.totalReceived,
      totalDeduped: this.totalDeduped,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Dedup
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Checks whether a signal for `contractAddress` should be processed.
   *
   * Steps:
   *   1. Purge all entries where `now - lastSeen > 60_000`.
   *   2. If address is still in the map → return false (duplicate).
   *   3. Otherwise → record it and return true.
   */
  shouldProcess(contractAddress: string, now: number): boolean {
    // Step 1: purge expired entries
    for (const [addr, lastSeen] of this.dedupMap) {
      if (now - lastSeen > DEDUP_WINDOW_MS) {
        this.dedupMap.delete(addr);
      }
    }

    // Step 2: check for duplicate
    if (this.dedupMap.has(contractAddress)) {
      return false;
    }

    // Step 3: record and allow
    this.dedupMap.set(contractAddress, now);
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Webhook ingestion
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Normalise and dispatch a webhook signal.
   *
   * - Throws if `contractAddress` is missing/empty.
   * - Captures ingestionTime BEFORE any async work.
   * - Dedup: if duplicate, logs debug and returns the signal without validating.
   * - If passes dedup: calls contractValidator.validate() in the background (non-blocking).
   * - Always returns the SniperSignal immediately.
   */
  async ingestWebhook(body: WebhookBody): Promise<SniperSignal> {
    if (!body.contractAddress) {
      throw new Error('contractAddress required');
    }

    // ingestionTime captured before any async work
    const ingestionTime = Date.now();
    this.totalReceived++;

    const signal: SniperSignal = {
      id: randomUUID(),
      ticker: body.ticker ?? '',
      contractAddress: body.contractAddress,
      source: 'webhook',
      ingestionTime,
    };

    const isDuplicate = !this.shouldProcess(body.contractAddress, ingestionTime);

    if (isDuplicate) {
      this.totalDeduped++;
      log.debug('SignalIngestor: webhook signal deduplicated', {
        contractAddress: body.contractAddress,
        signalId: signal.id,
      });
      return signal;
    }

    // Validate and record the signal
    void this.contractValidator.validate(signal).then((result) => {
      if (this.metricsRecorder) {
        this.metricsRecorder.recordSignal(signal, result);
      }
    }).catch((err: unknown) => {
      log.warn('SignalIngestor: validator error (webhook)', {
        contractAddress: body.contractAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      if (this.metricsRecorder) {
        this.metricsRecorder.recordSignal(signal, {
          passed: false,
          rejectReason: 'QUOTE_ERROR',
          validatedAt: Date.now(),
          latencyMs: Date.now() - ingestionTime,
        });
      }
    });

    return signal;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DexScreener polling
  // ─────────────────────────────────────────────────────────────────────────

  private async pollDexScreener(): Promise<void> {
    // Skip if rate-limited
    if (Date.now() < this.dexscreenerPausedUntil) {
      return;
    }

    try {
      const response = await axios.get<unknown>(DEXSCREENER_URL, { timeout: 15_000 });

      const pairs = this.parseDexScreenerResponse(response.data);

      // token-boosts endpoint covers all chains — filter to Base only
      // Pre-filter: volume > $10k AND liquidity >= $5k to reduce garbage signals
      // This reduces RPC calls by rejecting low-liquidity tokens early
      const basePairs = pairs.filter((p) => 
        p.chainId === 'base' && 
        p.volume?.h1 > 10_000 &&
        (p.liquidity?.usd ?? 0) >= 5_000  // Pre-filter: min $5k liquidity
      );

      if (basePairs.length > 0) {
        // Found Base tokens in the boosts feed
        for (const pair of basePairs.slice(0, MAX_PAIRS_PER_CYCLE)) {
          await this.dispatchSignal(
            pair.baseToken.symbol,
            pair.baseToken.address,
            'dexscreener',
            pair.pairAddress,
          );
        }
      } else {
        // token-boosts had no Base tokens (common — mostly Solana) →
        // try token-profiles (cross-chain, filter to base) then search fallback
        log.debug('DexScreener: no Base tokens in boosts feed, trying token-profiles + search fallback');
        await this.pollDexScreenerTokenProfiles();
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;

        if (status === 429) {
          this.dexscreenerPausedUntil = Date.now() + DEXSCREENER_RATE_LIMIT_PAUSE_MS;
          log.warn('DexScreener rate-limited, pausing 60s');
          return;
        }

        if (status && status >= 500 && status < 600) {
          log.warn('SignalIngestor: DexScreener 5xx error', { status });
          return;
        }

        log.warn('SignalIngestor: DexScreener request failed', { error: err.message });
      } else {
        log.warn('SignalIngestor: DexScreener unexpected error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Stage 1 of fallback: polls token-profiles/latest/v1 (cross-chain, filter to base).
   * This endpoint is stable and well-documented. Falls through to search fallback
   * if no Base tokens found or on error.
   */
  private async pollDexScreenerTokenProfiles(): Promise<void> {
    try {
      const response = await axios.get<unknown>(DEXSCREENER_TOKEN_PROFILES_URL, { timeout: 15_000 });
      const data = response.data;

      // token-profiles returns an array of { chainId, tokenAddress, url, ... }
      // We need to resolve to pairs — use the addresses to fetch pairs
      type TokenProfile = { chainId: string; tokenAddress: string };
      const profiles: TokenProfile[] = Array.isArray(data) ? (data as TokenProfile[]) : [];
      const baseProfiles = profiles.filter((p) => p.chainId === 'base').slice(0, MAX_PAIRS_PER_CYCLE);

      if (baseProfiles.length > 0) {
        log.debug(`DexScreener token-profiles: ${baseProfiles.length} Base tokens found`);
        for (const profile of baseProfiles) {
          // Dispatch with address as ticker placeholder — ContractValidator will resolve symbol
          await this.dispatchSignal(
            profile.tokenAddress.slice(0, 8),
            profile.tokenAddress,
            'dexscreener',
            profile.tokenAddress,
          );
        }
        return; // success — no need for search fallback
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 429) {
          this.dexscreenerPausedUntil = Date.now() + DEXSCREENER_RATE_LIMIT_PAUSE_MS;
          log.warn('DexScreener token-profiles rate-limited, pausing 60s');
          return;
        }
      }
      log.debug('DexScreener token-profiles failed, falling back to search', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Stage 2 fallback: search endpoint (no chainId param — that query param is deprecated)
    await this.pollDexScreenerBaseFallback();
  }

  /**
   * Stage 2 fallback: search endpoint with a Base-specific query.
   * Does NOT use the deprecated chainId query param (returns 404).
   * Filters results to base chain in-process.
   */
  private async pollDexScreenerBaseFallback(): Promise<void> {
    try {
      const response = await axios.get<unknown>(DEXSCREENER_BASE_SEARCH_URL, { timeout: 15_000 });

      const data = response.data as { pairs?: DexScreenerPair[] } | null;
      // search endpoint may return pairs from multiple chains — filter to base only
      const allPairs: DexScreenerPair[] = Array.isArray(data?.pairs) ? data!.pairs : [];
      const pairs = allPairs.filter((p) => p.chainId === 'base');

      const filtered = pairs
        .filter((p) => p.volume?.h1 > 10_000 && (p.liquidity?.usd ?? 0) >= 5_000)
        .slice(0, MAX_PAIRS_PER_CYCLE);

      log.debug(`DexScreener Base search fallback: ${filtered.length} pairs`);

      for (const pair of filtered) {
        await this.dispatchSignal(
          pair.baseToken.symbol,
          pair.baseToken.address,
          'dexscreener',
          pair.pairAddress,
        );
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        if (status === 429) {
          this.dexscreenerPausedUntil = Date.now() + DEXSCREENER_RATE_LIMIT_PAUSE_MS;
          log.warn('DexScreener Base search fallback rate-limited, pausing 60s');
          return;
        }
        const status2 = err.response?.status;
        if (status2 === 404) {
          log.warn('SignalIngestor: DexScreener Base search returned 404 — endpoint may have changed', {
            url: DEXSCREENER_BASE_SEARCH_URL,
          });
          return;
        }
      }
      log.warn('SignalIngestor: DexScreener Base search fallback failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Parse DexScreener response — handles both array and { pairs: [] } shapes. */
  private parseDexScreenerResponse(data: unknown): DexScreenerPair[] {
    if (Array.isArray(data)) {
      return data as DexScreenerPair[];
    }
    if (data && typeof data === 'object' && 'pairs' in data) {
      const pairs = (data as { pairs: unknown }).pairs;
      if (Array.isArray(pairs)) return pairs as DexScreenerPair[];
    }
    return [];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GeckoTerminal polling
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Poll GeckoTerminal for new Base network pools.
   *
   * Endpoint: GET https://api.geckoterminal.com/api/v2/networks/base/new_pools
   * - No API key required
   * - Free tier: 30 calls/min (we poll every 60s → well under limit)
   * - Returns pools sorted by creation time, most recent first
   * - Each pool has the pool address directly (no token/pool confusion)
   *
   * Filters applied:
   *   - reserve_in_usd >= $10,000 (min liquidity — same threshold as ContractValidator)
   *   - volume_usd.h1 > $5,000 (some trading activity in last hour)
   *
   * The pool address from GeckoTerminal's `attributes.address` IS the pool,
   * and `relationships.base_token.data.id` is "base_0xTOKENADDRESS".
   * This correctly separates token from pool — resolving the historical bug.
   */
  private async pollGeckoTerminal(): Promise<void> {
    if (Date.now() < this.geckoTerminalPausedUntil) {
      return;
    }

    try {
      const response = await axios.get<unknown>(GECKOTERMINAL_BASE_NEW_POOLS_URL, {
        timeout: 15_000,
        headers: { Accept: 'application/json;version=20230302' },
      });

      const pools = this.parseGeckoTerminalResponse(response.data);

      const MIN_RESERVE_USD = 10_000;
      // Pools recién creadas tienen poco volumen acumulado en h1. 
      // Se aumentó a $5,000 (desde $500) para evitar tokens muertos/scams de bajo esfuerzo.
      // El indicador real de actividad es tener transacciones en los últimos 5 minutos.
      const MIN_VOLUME_H1_USD = 5_000;

      const filtered = pools
        .filter((p) => {
          const reserve = parseFloat(p.attributes.reserve_in_usd) || 0;
          const vol = parseFloat(p.attributes.volume_usd.h1) || 0;
          const recentBuys = p.attributes.transactions?.m5?.buys ?? 0;
          // Necesita: liquidez mínima + (algo de volumen O compras recientes en 5m)
          return reserve >= MIN_RESERVE_USD && (vol >= MIN_VOLUME_H1_USD || recentBuys > 0);
        })
        .slice(0, MAX_PAIRS_PER_CYCLE);

      for (const pool of filtered) {
        // base_token.data.id format: "base_0xADDRESS" → extract address
        const tokenId = pool.relationships.base_token.data.id; // "base_0x..."
        const tokenAddress = tokenId.startsWith('base_') ? tokenId.slice(5) : tokenId;

        // Extract ticker from pool name (e.g. "ROOK / ETH 0.05%" → "ROOK")
        const ticker = pool.attributes.name.split(' ')[0] ?? 'UNKNOWN';

        // pool.attributes.address IS the pool address — use it directly
        const poolAddress = pool.attributes.address;

        await this.dispatchSignal(ticker, tokenAddress, 'geckoterminal', poolAddress);
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;

        if (status === 429) {
          this.geckoTerminalPausedUntil = Date.now() + GECKOTERMINAL_RATE_LIMIT_PAUSE_MS;
          log.warn('SignalIngestor: GeckoTerminal rate-limited, pausing 60s');
          return;
        }

        if (status && status >= 500 && status < 600) {
          log.warn('SignalIngestor: GeckoTerminal 5xx error', { status });
          return;
        }

        log.warn('SignalIngestor: GeckoTerminal request failed', { error: err.message });
      } else {
        log.warn('SignalIngestor: GeckoTerminal unexpected error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Parse GeckoTerminal new_pools response into pool list. */
  private parseGeckoTerminalResponse(data: unknown): GeckoTerminalPool[] {
    try {
      const d = data as { data?: unknown[] };
      if (!Array.isArray(d?.data)) return [];
      return d.data as GeckoTerminalPool[];
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Bitquery polling
  // ─────────────────────────────────────────────────────────────────────────

  private async pollBitquery(): Promise<void> {
    // Warn once if API key is missing
    if (!this.bitqueryApiKey) {
      if (!this.bitqueryWarnedOnce) {
        log.warn('SignalIngestor: Bitquery API key not set — skipping Bitquery polling');
        this.bitqueryWarnedOnce = true;
      }
      return;
    }

    if (this.bitqueryDisabled) {
      return;
    }

    // Use Bitquery v2 (streaming.bitquery.io) — requires paid plan
    // Query for new token creations on Base chain
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

    const query = `{
  EVM(network: base) {
    TokenHolders(
      limit: { count: 10 }
      orderBy: { descending: Block_Time }
      where: { Block: { Time: { after: "${fiveMinutesAgo}" } } }
    ) {
      Token {
        SmartContract
        Symbol
      }
      Block {
        Time
      }
    }
  }
}`;

    try {
      const response = await axios.post<unknown>(
        BITQUERY_URL,
        { query },
        {
          headers: {
            Authorization: `Bearer ${this.bitqueryApiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15_000,
        },
      );

      const tokens = this.parseBitqueryResponseV2(response.data);

      for (const token of tokens) {
        await this.dispatchSignal(token.symbol, token.address, 'bitquery');
      }
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;

        if (status === 401) {
          log.warn('SignalIngestor: Bitquery 401 — disabling Bitquery for this session');
          this.bitqueryDisabled = true;
          return;
        }

        if (status === 402) {
          // Plan limit reached — disable silently, DexScreener covers this
          log.warn('SignalIngestor: Bitquery 402 — plan limit reached, disabling Bitquery');
          this.bitqueryDisabled = true;
          return;
        }

        if (status === 403) {
          // Forbidden — API key invalid or not activated
          log.warn('SignalIngestor: Bitquery 403 — API key invalid/inactive, disabling Bitquery');
          this.bitqueryDisabled = true;
          return;
        }

        log.warn('SignalIngestor: Bitquery request failed', {
          status,
          error: err.message,
        });
      } else {
        log.warn('SignalIngestor: Bitquery unexpected error', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Parse Bitquery v2 GraphQL response into a flat token list.
   *
   * Uses v2 schema (streaming.bitquery.io) with EVM.TokenHolders
   */
  private parseBitqueryResponseV2(data: unknown): BitqueryToken[] {
    try {
      const holders = (
        data as {
          data?: {
            EVM?: {
              TokenHolders?: Array<{
                Token: {
                  SmartContract: string;
                  Symbol: string;
                };
              }>;
            };
          };
        }
      )?.data?.EVM?.TokenHolders;

      if (!Array.isArray(holders)) return [];

      return holders
        .filter(h => h.Token?.SmartContract && h.Token?.Symbol)
        .map(h => ({
          address: h.Token.SmartContract,
          symbol: h.Token.Symbol,
        }));
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal dispatch (shared by DexScreener + Bitquery)
  // ─────────────────────────────────────────────────────────────────────────

  private async dispatchSignal(
    ticker: string,
    contractAddress: string,
    source: 'dexscreener' | 'geckoterminal' | 'bitquery',
    poolAddress?: string,
  ): Promise<void> {
    if (!contractAddress) return;

    const ingestionTime = Date.now();
    this.totalReceived++;

    const signal: SniperSignal = {
      id: randomUUID(),
      ticker,
      contractAddress,
      source,
      ingestionTime,
      ...(poolAddress ? { poolAddress } : {}),
    };

    if (!this.shouldProcess(contractAddress, ingestionTime)) {
      this.totalDeduped++;
      log.debug('SignalIngestor: signal deduplicated', { contractAddress, source });
      return;
    }

    // Validate and record the signal
    void this.contractValidator.validate(signal).then((result) => {
      // Record the signal and validation result to DB
      if (this.metricsRecorder) {
        this.metricsRecorder.recordSignal(signal, result);
      }
    }).catch((err: unknown) => {
      log.warn('SignalIngestor: validator error', {
        contractAddress,
        source,
        error: err instanceof Error ? err.message : String(err),
      });
      // Record failed validation with QUOTE_ERROR
      if (this.metricsRecorder) {
        this.metricsRecorder.recordSignal(signal, {
          passed: false,
          rejectReason: 'QUOTE_ERROR',
          validatedAt: Date.now(),
          latencyMs: Date.now() - ingestionTime,
        });
      }
    });
  }
}

/**
 * Hybrid Sniper — Entry Point
 *
 * Orchestrates all Hybrid Sniper modules and exposes:
 *   - initHybridSniper(env)  → HybridSniperModule
 *   - wireSniper(fastify, module)  → registers Fastify routes
 *
 * Design principles:
 *   - Non-fatal: any initialization failure is caught and propagated to AgentCore,
 *     which wraps the call in try/catch.
 *   - Degraded MetricsRecorder: if DB fails, the recorder operates as no-ops.
 *   - Phase 0 Shadow Mode: no real transactions, all quotes via staticCall.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 8.1, 8.3, 8.5
 */

import { ethers } from 'ethers';
import type { FastifyInstance } from 'fastify';
import { createLogger } from '../logger.js';
import { MetricsRecorder, RiskBucket, DexQuoter, ContractValidator } from '../shared/index.js';
import { SignalIngestor } from './signal-ingestor.js';
import { ShadowExecutor } from './shadow-executor.js';
import { MultiVariantExecutor } from './multi-variant-executor.js';
import { DEFAULT_EXPLORATION_CONFIG } from './exploration-config.js';
import type { WebhookBody } from './signal-ingestor.js';
import { RugAlertService } from '../rug-alert/rug-alert-service.js';

const log = createLogger('hybrid-sniper');

// ═══════════════════════════════════════════════════════════════════════════
// Public interfaces
// ═══════════════════════════════════════════════════════════════════════════

export interface HybridSniperConfig {
  enabled: boolean;
  rpcUrl: string;
  riskBudgetUsdc: number;
  tradeSizeUsdc: number;
  maxLossStreak: number;
  tpPct: number;
  slPct: number;
  dexscreenerPollIntervalMs: number;
  bitqueryApiKey: string | null;
  dbPath: string;
  agentAddress: string;
  /** Enable multi-variant exploration mode */
  explorationMode: boolean;
}

export interface HybridSniperModule {
  signalIngestor: SignalIngestor;
  contractValidator: ContractValidator;
  shadowExecutor: ShadowExecutor;
  multiVariantExecutor: MultiVariantExecutor | null;
  riskBucket: RiskBucket;
  metricsRecorder: MetricsRecorder;
  config: HybridSniperConfig;
  isEnabled: boolean;
  rugAlertService?: RugAlertService | null;
  stop(): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// initHybridSniper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Initialize all Hybrid Sniper modules in the correct dependency order.
 *
 * Reads configuration from environment variables with sensible defaults.
 * Starts the SignalIngestor polling loop and ShadowExecutor monitoring loop.
 *
 * Returns the fully assembled HybridSniperModule.
 */
export async function initHybridSniper(
  env: Record<string, string | undefined>,
): Promise<HybridSniperModule> {
  // ─── Read configuration from environment ──────────────────────────────────
  const riskBudgetUsdc = parseFloat(env['SNIPER_RISK_BUDGET_USDC'] ?? '') || 15;
  const tradeSizeUsdc = parseFloat(env['SNIPER_TRADE_SIZE_USDC'] ?? '') || 5;
  // Reduced to 3: tighter circuit breaker since we're using realistic stop losses now
  const maxLossStreak = parseInt(env['SNIPER_MAX_LOSS_STREAK'] ?? '', 10) || 3;
  // Adjusted TP/SL for micro-cap volatility: need room to breathe and capture real gains
  // Previous: TP 40%, SL 15% 
  // New: TP 150%, SL 40%
  const tpPct = parseFloat(env['SNIPER_TP_PCT'] ?? '') || 150;
  const slPct = parseFloat(env['SNIPER_SL_PCT'] ?? '') || 40;
  const pollIntervalMs = parseInt(env['SNIPER_POLL_INTERVAL_MS'] ?? '', 10) || 30_000;
  const bitqueryApiKey = env['BITQUERY_API_KEY'] ?? null;
  const rpcUrl = env['RPC_PROVIDER_URL'] ?? '';
  const dbPath = env['SNIPER_DB_PATH'] ?? 'data/sniper-metrics.db';
  // Bug fix: read agentAddress from env instead of using hardcoded zero address
  const agentAddress =
    env['WALLET_ADDRESS'] ??
    env['AGENT_WALLET_ADDRESS'] ??
    '0x0000000000000000000000000000000000000000';

  const config: HybridSniperConfig = {
    enabled: env['SNIPER_ENABLED'] === 'true',
    rpcUrl,
    riskBudgetUsdc,
    tradeSizeUsdc,
    maxLossStreak,
    tpPct,
    slPct,
    dexscreenerPollIntervalMs: pollIntervalMs,
    bitqueryApiKey: bitqueryApiKey || null,
    dbPath,
    agentAddress,
    explorationMode: env['SNIPER_EXPLORATION_MODE'] !== 'false', // enabled by default in shadow mode
  };

  // ─── 1. MetricsRecorder (degraded mode if DB fails) ───────────────────────
  // SniperDatabase already handles its own try/catch and sets degraded=true
  const metricsRecorder = new MetricsRecorder(dbPath);

  if (metricsRecorder.isDegraded) {
    log.warn('MetricsRecorder: operating in degraded mode (no DB persistence)');
  }

  // ─── 2. RiskBucket ────────────────────────────────────────────────────────
  const riskBucket = new RiskBucket(env);

  // ─── 3. DexQuoter ─────────────────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(rpcUrl || undefined);
  const dexQuoter = new DexQuoter(provider);

  // ─── 4. ContractValidator ─────────────────────────────────────────────────
  const contractValidator = new ContractValidator(dexQuoter, provider, {
    tradeSizeUsdc,
    agentAddress,
  });

  // ─── 5. SignalIngestor ────────────────────────────────────────────────────
  const signalIngestor = new SignalIngestor(contractValidator, {
    pollIntervalMs,
    bitqueryApiKey: bitqueryApiKey || null,
    metricsRecorder,
  });

  // ─── 6. ShadowExecutor ────────────────────────────────────────────────────
  const shadowExecutor = new ShadowExecutor(dexQuoter, riskBucket, metricsRecorder, {
    tradeSizeUsdc,
    tpPct,
    slPct,
    monitorIntervalMs: 10_000,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  });

  // ─── 7. MultiVariantExecutor (exploration mode) ─────────────────────────────
  let multiVariantExecutor: MultiVariantExecutor | null = null;
  if (config.explorationMode) {
    multiVariantExecutor = new MultiVariantExecutor(
      dexQuoter,
      riskBucket,
      metricsRecorder,
      DEFAULT_EXPLORATION_CONFIG,
    );

    // Connect ContractValidator to MultiVariantExecutor
    // When a signal passes validation, open positions for all variants
    contractValidator.onValidationPassed = async (signal) => {
      if (multiVariantExecutor) {
        await multiVariantExecutor.openMultiVariantPositions(signal);
      }
    };

    log.info('Multi-variant exploration mode enabled', {
      variants: DEFAULT_EXPLORATION_CONFIG.variants.length,
      establishedPairs: DEFAULT_EXPLORATION_CONFIG.establishedPairs.length,
    });
  }

  // ─── 8.5. RugAlertService ───────────────────────────────────────────────
  let rugAlertService: RugAlertService | null = null;
  try {
    const { TelegramClient } = await import('../social/telegram-client.js');
    const telegramClient = new TelegramClient();
    rugAlertService = new RugAlertService(
      provider, dexQuoter, shadowExecutor, multiVariantExecutor,
      metricsRecorder, riskBucket, telegramClient, env
    );
    await rugAlertService.start();
    log.info('RugAlertService started');
  } catch (err) {
    log.warn('RugAlertService failed to start — DEGRADED mode', {
      error: err instanceof Error ? err.message : String(err),
    });
    rugAlertService = null;
  }

  // Monkey-patch shadowExecutor.openPosition to track positions with RugAlertService
  const _origShadowOpen = shadowExecutor.openPosition.bind(shadowExecutor);
  shadowExecutor.openPosition = async (signal) => {
    const position = await _origShadowOpen(signal);
    if (position && rugAlertService) {
      // Use contractAddress as both pool and LP token address as fallback
      // (real pool address resolution would require additional on-chain lookup)
      rugAlertService.trackPosition(position, signal.poolAddress ?? position.contractAddress, position.contractAddress);
    }
    return position;
  };

  // Monkey-patch multiVariantExecutor.openMultiVariantPositions to track positions
  if (multiVariantExecutor) {
    const _origMultiOpen = multiVariantExecutor.openMultiVariantPositions.bind(multiVariantExecutor);
    multiVariantExecutor.openMultiVariantPositions = async (signal) => {
      const positions = await _origMultiOpen(signal);
      if (rugAlertService) {
        for (const position of positions) {
          rugAlertService.trackPosition(position, signal.poolAddress ?? position.contractAddress, position.contractAddress);
        }
      }
      return positions;
    };
  }

  // ─── 8. Start loops ───────────────────────────────────────────────────────
  signalIngestor.start();
  await shadowExecutor.start(); // Now async to restore positions from DB
  if (multiVariantExecutor) {
    await multiVariantExecutor.start(); // FIX: Now async to restore positions from DB

    // Start established pair monitoring (poll every 5 minutes)
    // Execute immediately on startup, then repeat every 5 minutes
    void multiVariantExecutor.openEstablishedPairPositions();
    setInterval(() => {
      if (multiVariantExecutor) {
        void multiVariantExecutor.openEstablishedPairPositions();
      }
    }, 5 * 60 * 1000);
  }

  log.info('HybridSniper Phase 0 Shadow Mode initialized', {
    riskBudgetUsdc,
    tradeSizeUsdc,
    maxLossStreak,
    tpPct,
    slPct,
    pollIntervalMs,
    hasBitquery: !!bitqueryApiKey,
    dbPath,
    explorationMode: config.explorationMode,
  });

  // ─── 9. Assemble and return module ────────────────────────────────────────
  const module: HybridSniperModule = {
    signalIngestor,
    contractValidator,
    shadowExecutor,
    multiVariantExecutor,
    riskBucket,
    metricsRecorder,
    config,
    isEnabled: config.enabled,
    rugAlertService,

    stop(): void {
      signalIngestor.stop();
      shadowExecutor.stop();
      if (multiVariantExecutor) {
        multiVariantExecutor.stop();
      }
      if (rugAlertService) {
        void rugAlertService.stop();
      }
      metricsRecorder.close();
      log.info('HybridSniper stopped');
    },
  };

  return module;
}

// ═══════════════════════════════════════════════════════════════════════════
// Mutable module holder — allows late injection after Fastify starts listening
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Global mutable holder for the HybridSniperModule.
 *
 * `wireSniper` registers routes that close over this holder.
 * `setHybridSniperModule` updates the holder at any time — even after
 * Fastify has started listening — so routes automatically use the live module.
 */
const _sniperHolder: { current: HybridSniperModule | null } = { current: null };

/**
 * Update the live HybridSniperModule reference used by the registered routes.
 * Call this from AgentCore after `initHybridSniper` completes (Step 5.5).
 */
export function setHybridSniperModule(module: HybridSniperModule): void {
  _sniperHolder.current = module;
}

// ═══════════════════════════════════════════════════════════════════════════
// wireSniper
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register Hybrid Sniper HTTP routes on an existing Fastify server.
 *
 * Routes:
 *   POST /webhook/alpha  — ingest an external alpha signal
 *   GET  /sniper/status  — recent signals, avg latency, circuit breaker state
 *
 * Routes close over `_sniperHolder`, so calling `setHybridSniperModule` after
 * Fastify starts listening will make the routes use the live module immediately.
 *
 * If the holder is null or module.isEnabled === false, routes return HTTP 503.
 */
export function wireSniper(
  fastify: FastifyInstance,
  module: HybridSniperModule | null,
): void {
  // Seed the holder with the provided module (may be null on first call from heartbeat)
  if (module !== null) {
    _sniperHolder.current = module;
  }

  // ─── POST /webhook/alpha ──────────────────────────────────────────────────
  fastify.post('/webhook/alpha', async (request, reply) => {
    const m = _sniperHolder.current;
    if (!m || !m.isEnabled) {
      return reply.status(503).send({ error: 'Hybrid Sniper is disabled' });
    }

    const body = request.body as WebhookBody;
    if (!body?.contractAddress) {
      return reply.status(400).send({ error: 'contractAddress required' });
    }

    const signal = await m.signalIngestor.ingestWebhook(body);
    return reply.status(200).send({ ok: true, signalId: signal.id });
  });

  // ─── GET /sniper/status ───────────────────────────────────────────────────
  fastify.get('/sniper/status', async (_request, reply) => {
    const m = _sniperHolder.current;
    if (!m || !m.isEnabled) {
      return reply.status(503).send({ error: 'Hybrid Sniper is disabled' });
    }

    const signals = await m.metricsRecorder.getRecentSignals(10);
    const avgLatencyMs = await m.metricsRecorder.getAverageLatency(10);
    const circuitBreaker = m.riskBucket.getState();

    // Include exploration metrics if enabled
    let exploration = null;
    if (m.multiVariantExecutor) {
      const variantMetrics = m.multiVariantExecutor.getVariantMetrics();
      const openPositions = m.multiVariantExecutor.getOpenPositions();
      const best = m.multiVariantExecutor.getBestVariant();

      exploration = {
        enabled: true,
        totalOpenPositions: openPositions.length,
        variantCount: variantMetrics.length,
        bestVariant: best ? {
          id: best.variantId,
          name: best.variantName,
          pnl: best.totalPnlUsdc,
          winRate: best.winRate,
          trades: best.totalTrades,
        } : null,
        variants: variantMetrics.slice(0, 5).map(v => ({
          id: v.variantId,
          name: v.variantName,
          trades: v.totalTrades,
          winRate: v.winRate,
          pnl: v.totalPnlUsdc,
        })),
      };
    }

    return reply.status(200).send({ signals, avgLatencyMs, circuitBreaker, exploration, rugAlerts: m.rugAlertService?.getAlertStats() ?? null });
  });

  // ─── GET /sniper/rug-alerts ───────────────────────────────────────────────
  fastify.get('/sniper/rug-alerts', async (_request, reply) => {
    const m = _sniperHolder.current;
    if (!m || !m.isEnabled) {
      return reply.status(503).send({ error: 'Hybrid Sniper is disabled' });
    }
    const stats = m.rugAlertService?.getAlertStats() ?? null;
    if (!stats) {
      return reply.status(503).send({ error: 'Rug Alert Service unavailable' });
    }
    return reply.status(200).send({
      monitoredPositions: m.rugAlertService!.getMonitoredCount(),
      ...stats,
    });
  });

  // ─── GET /sniper/variants — Detailed variant metrics ─────────────────────
  fastify.get('/sniper/variants', async (_request, reply) => {
    const m = _sniperHolder.current;
    if (!m || !m.isEnabled) {
      return reply.status(503).send({ error: 'Hybrid Sniper is disabled' });
    }

    if (!m.multiVariantExecutor) {
      return reply.status(400).send({ error: 'Exploration mode not enabled' });
    }

    const variantMetrics = m.multiVariantExecutor.getVariantMetrics();
    const openPositions = m.multiVariantExecutor.getOpenPositions();

    return reply.status(200).send({
      totalOpenPositions: openPositions.length,
      variants: variantMetrics,
    });
  });

  // ─── GET /sniper/report — Generate exploration report ────────────────────
  fastify.get('/sniper/report', async (_request, reply) => {
    const m = _sniperHolder.current;
    if (!m || !m.isEnabled) {
      return reply.status(503).send({ error: 'Hybrid Sniper is disabled' });
    }

    if (!m.multiVariantExecutor) {
      return reply.status(400).send({ error: 'Exploration mode not enabled' });
    }

    const report = m.multiVariantExecutor.generateReport();
    return reply.status(200).send({ report });
  });
}

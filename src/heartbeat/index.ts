/**
 * Heartbeat module — barrel export + HeartbeatModule with Fastify endpoints.
 *
 * Exposes:
 *   GET /health    → 200 (healthy) or 503 (unhealthy), always < 500 ms
 *   GET /metrics   → MetricsSnapshot
 *   GET /status    → full agent status
 *   POST /heartbeat → ping from child agents
 *
 * Also emits a health check event every 30 seconds (HealthChecker).
 *
 * Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 10.7
 */

export { HealthChecker } from './health-checker.js';
export type {
  HealthStatus,
  ModuleHealthStatus,
} from './health-checker.js';

export { MetricsCollector } from './metrics-collector.js';
export type { MetricsSnapshot } from './metrics-collector.js';

// ---------------------------------------------------------------------------
// HeartbeatModule – combined interface
// ---------------------------------------------------------------------------

import Fastify, { type FastifyInstance } from 'fastify';
import type { SurvivalTier } from '../survival/tier-evaluator.js';
import type { HeartbeatRepository } from '../state/repositories/heartbeat.repo.js';
import type { ChildRegistry } from '../replication/child-registry.js';
import {
  HealthChecker,
  type HealthStatus,
  type ModuleHealthStatus,
} from './health-checker.js';
import { MetricsCollector, type MetricsSnapshot } from './metrics-collector.js';
import { wireEvolution } from '../evolution/wire.js';
import { wireSniper } from '../hybrid-sniper/index.js';
import type { HybridSniperModule } from '../hybrid-sniper/index.js';

export interface HeartbeatModule {
  start(): void;
  stop(): Promise<void>;
  getHealthStatus(): HealthStatus;
  getMetrics(): MetricsSnapshot;
  setModuleStatus(module: string, status: ModuleHealthStatus): void;
  startHttpServer(port: number): Promise<void>;
  setWalletAddress(address: string): void;
}

// ---------------------------------------------------------------------------
// Factory / default implementation
// ---------------------------------------------------------------------------

/**
 * Create a HeartbeatModule that wraps HealthChecker + MetricsCollector
 * and optionally starts a Fastify HTTP server exposing /health, /metrics,
 * /status, and POST /heartbeat.
 *
 * Requirement 11.3 — /health must respond in < 500 ms.
 */
export function createHeartbeatModule(
  repo: HeartbeatRepository | null = null,
  childRegistry: ChildRegistry | null = null
): HeartbeatModule & {
  checker: HealthChecker;
  metrics: MetricsCollector;
  fastify: FastifyInstance;
  setUsdcBalance(balance: bigint): void;
  setBalanceBreakdown(walletUsdc: bigint, aaveUsdc: bigint): void;
  setTier(tier: SurvivalTier): void;
  setLlmAvailable(available: boolean): void;
  recordCycle(): void;
  recordIncome(amountUsdc: bigint): void;
  recordError(): void;
} {
  const checker = new HealthChecker(repo);
  const metrics = new MetricsCollector();
  const fastify = buildFastifyServer(checker, metrics, childRegistry);

  return {
    checker,
    metrics,
    fastify,

    start() {
      metrics.start();
      checker.start();
    },

    async stop() {
      checker.stop();
      metrics.stop();
      await fastify.close();
    },

    getHealthStatus(): HealthStatus {
      return checker.getHealthStatus();
    },

    getMetrics(): MetricsSnapshot {
      return metrics.getMetrics();
    },

    setModuleStatus(module: string, status: ModuleHealthStatus): void {
      checker.setModuleStatus(module, status);
    },

    async startHttpServer(port: number): Promise<void> {
      await fastify.listen({ port, host: '0.0.0.0' });
      console.log(`[HeartbeatModule] HTTP server listening on port ${port}`);
    },

    // Passthrough helpers for dependent modules
    setUsdcBalance(balance: bigint): void {
      checker.setUsdcBalance(balance);
    },
    setBalanceBreakdown(walletUsdc: bigint, aaveUsdc: bigint): void {
      checker.setBalanceBreakdown(walletUsdc, aaveUsdc);
    },
    setTier(tier: SurvivalTier): void {
      checker.setTier(tier);
    },
    setLlmAvailable(available: boolean): void {
      checker.setLlmAvailable(available);
    },
    setWalletAddress(address: string): void {
      checker.setWalletAddress(address);
    },
    recordCycle(): void {
      metrics.recordCycle();
    },
    recordIncome(amountUsdc: bigint): void {
      metrics.recordIncome(amountUsdc);
    },
    recordError(): void {
      metrics.recordError();
    },
  };
}

// ---------------------------------------------------------------------------
// Fastify server builder
// ---------------------------------------------------------------------------

/**
 * Build and register all heartbeat HTTP routes on a Fastify instance.
 * Requirements: 11.3, 11.5, 10.7
 */
function buildFastifyServer(
  checker: HealthChecker,
  metrics: MetricsCollector,
  childRegistry: ChildRegistry | null,
  hybridSniperModule: HybridSniperModule | null = null,
): FastifyInstance {
  const fastify = Fastify({
    logger: false,
    // Disable default 404 handler verbose logging
    disableRequestLogging: true,
  });

  // ---------------------------------------------------------------------------
  // GET /health  — Requirement 11.3
  // Must respond in < 500 ms with HTTP 200 (healthy) or 503 (unhealthy/degraded).
  // ---------------------------------------------------------------------------
  fastify.get('/health', async (_req, reply) => {
    const status = checker.getHealthStatus();
    const httpStatus = status.overall === 'healthy' ? 200 : 503;

    return reply.status(httpStatus).send({
      status: status.overall,
      tier: status.tier,
      llmAvailable: status.llmAvailable,
      balanceUsdc: status.usdcBalance.toString(),
      balanceBreakdown: status.balanceBreakdown ? {
        walletUsdc: status.balanceBreakdown.walletUsdc.toString(),
        aaveUsdc: status.balanceBreakdown.aaveUsdc.toString(),
      } : undefined,
      modules: Object.fromEntries(
        Object.entries(status.modules).map(([name, ms]) => [
          name,
          { status: ms.status, consecutiveFailures: ms.consecutiveFailures },
        ])
      ),
      timestamp: status.timestamp,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /metrics  — Requirement 11.5
  // Returns MetricsSnapshot with serialized bigint fields.
  // ---------------------------------------------------------------------------
  fastify.get('/metrics', async (_req, reply) => {
    const snapshot = metrics.getMetrics();
    return reply.status(200).send({
      ...snapshot,
      // bigint → string for JSON serialization
      totalIncomeUsdc: snapshot.totalIncomeUsdc.toString(),
    });
  });

  // ---------------------------------------------------------------------------
  // GET /status  — Full agent status
  // ---------------------------------------------------------------------------
  fastify.get('/status', async (_req, reply) => {
    const health = checker.getHealthStatus();
    const metricsSnapshot = metrics.getMetrics();

    // Load children if registry is wired up (Requirement 10.7)
    let children: unknown[] = [];
    if (childRegistry !== null) {
      try {
        children = await childRegistry.getActive();
      } catch {
        children = [];
      }
    }

    return reply.status(200).send({
      health: {
        overall: health.overall,
        tier: health.tier,
        balanceUsdc: health.usdcBalance.toString(),
        llmAvailable: health.llmAvailable,
        modules: health.modules,
        timestamp: health.timestamp,
      },
      metrics: {
        ...metricsSnapshot,
        totalIncomeUsdc: metricsSnapshot.totalIncomeUsdc.toString(),
      },
      children,
    });
  });

  // ---------------------------------------------------------------------------
  // GET /identity  — Wallet address of the agent
  // ---------------------------------------------------------------------------
  fastify.get('/identity', async (_req, reply) => {
    const walletAddress = checker.getWalletAddress();
    return reply.status(200).send({
      walletAddress,
      network: 'base',
      chainId: 8453,
      note: 'Send ETH (for gas) and USDC to this address on Base network to fund the agent',
    });
  });
  // ---------------------------------------------------------------------------
  fastify.get('/children', async (_req, reply) => {
    if (childRegistry === null) {
      return reply.status(200).send({ children: [] });
    }

    try {
      const active = await childRegistry.getActive();
      return reply.status(200).send({
        children: active.map((c) => ({
          id: c.id,
          walletAddress: c.walletAddress,
          containerId: c.containerId,
          status: c.status,
          spawnedAt: c.spawnedAt,
          lastHeartbeat: c.lastHeartbeat,
          initialFunding: c.initialFunding,
        })),
        count: active.length,
      });
    } catch (err) {
      console.error('[HeartbeatModule] GET /children error:', err);
      return reply.status(500).send({ error: 'Failed to retrieve children' });
    }
  });

  // ---------------------------------------------------------------------------
  // POST /heartbeat  — Child agent ping (Requirement 10.7)
  // ---------------------------------------------------------------------------
  fastify.post('/heartbeat', async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const agentId = typeof body?.agentId === 'string' ? body.agentId : null;
    const status = typeof body?.status === 'string' ? body.status : 'healthy';

    if (agentId && childRegistry !== null) {
      childRegistry.recordHeartbeat(agentId, Date.now());
    }

    // Also update the module status in HealthChecker if agentId present
    if (agentId) {
      checker.setModuleStatus(`child:${agentId}`, {
        status: status === 'healthy' ? 'healthy' : 'unhealthy',
        lastCheck: Date.now(),
        consecutiveFailures: 0,
      });
    }

    return reply.status(200).send({
      ok: true,
      receivedAt: Date.now(),
    });
  });

  // ---------------------------------------------------------------------------
  // GET /report  — Latest daily report (JSON format)
  // ---------------------------------------------------------------------------
  fastify.get('/report', async (_req, reply) => {
    const health = checker.getHealthStatus();
    const metricsSnapshot = metrics.getMetrics();
    const now = new Date();

    const report = {
      date: now.toISOString().slice(0, 10),
      generatedAt: now.toISOString(),
      balance: {
        total: health.usdcBalance.toString(),
        totalFormatted: `$${(Number(health.usdcBalance) / 1_000_000).toFixed(2)}`,
        wallet: (health as any).walletUsdc?.toString() ?? 'unknown',
        aave: (health as any).aaveUsdc?.toString() ?? 'unknown',
      },
      tier: health.tier,
      tierLabel: health.tier === 3 ? 'TIER_3' : health.tier === 4 ? 'TIER_4' : `TIER_${health.tier}`,
      health: {
        overall: health.overall,
        llmAvailable: health.llmAvailable,
        modules: health.modules,
      },
      metrics: {
        totalCycles: metricsSnapshot.totalCycles,
        totalErrors: metricsSnapshot.totalErrors,
        totalIncomeUsdc: metricsSnapshot.totalIncomeUsdc.toString(),
        uptimeSeconds: Math.floor(metricsSnapshot.uptimeMs / 1000),
      },
      endpoints: {
        services: 'https://api.niklauss.uk/services',
        health: 'https://health.niklauss.uk/health',
        research: 'https://research.niklauss.uk/health',
      },
    };

    return reply.status(200).send(report);
  });

  // ---------------------------------------------------------------------------
  // Strategy Evolution Lab routes (Requirements 12.1, 15.3)
  // ---------------------------------------------------------------------------
  wireEvolution(fastify);

  // ---------------------------------------------------------------------------
  // Hybrid Sniper routes — wired here so AgentCore can inject the live module
  // via createHeartbeatModule's exposed fastify instance after initialization.
  // Pass null as placeholder; AgentCore calls wireSniper(fastify, module) in
  // Step 5.5 once hybridSniperModule is ready.
  // ---------------------------------------------------------------------------
  wireSniper(fastify, hybridSniperModule);

  return fastify;
}

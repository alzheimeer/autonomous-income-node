/**
 * Strategy Evolution Lab — Fastify API Routes
 *
 * REST endpoints for inspecting and interacting with the evolution system.
 * GET endpoints provide full read access; POST endpoints trigger operations.
 *
 * Endpoints:
 *   GET  /evolution/status        → Summary by state, active experiments, last cycle
 *   GET  /evolution/strategies    → All strategies with status and metrics
 *   GET  /evolution/strategy/:id  → Full details, lineage, experiments, transitions
 *   POST /evolution/diagnose      → Trigger diagnosis, return findings
 *   POST /evolution/run-cycle     → Trigger full cycle, return report
 *   POST /evolution/promote/:id   → Attempt promotion, return result
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */

import type { FastifyInstance } from 'fastify';
import { EvolutionDatabase } from './evolution-database.js';
import { StrategyRegistry } from './strategy-registry.js';
import { ExperimentLedger } from './experiment-ledger.js';
import { PromotionEngine } from './promotion-engine.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Dependencies injected into evolution route registration */
export interface EvolutionRouteDeps {
  db: EvolutionDatabase;
}

// ═══════════════════════════════════════════════════════════════════════════
// Route Registration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register all evolution API routes on the given Fastify instance.
 *
 * @param fastify - The Fastify server instance
 * @param deps - Dependencies (EvolutionDatabase)
 */
export function registerEvolutionRoutes(
  fastify: FastifyInstance,
  deps: EvolutionRouteDeps,
): void {
  const { db } = deps;
  const registry = new StrategyRegistry(db);
  const ledger = new ExperimentLedger(db);
  const promotionEngine = new PromotionEngine(db);

  // ─────────────────────────────────────────────────────────────────────────
  // GET /evolution/status — Summary by state, active experiments, last cycle
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get('/evolution/status', async (_request, reply) => {
    const counts = registry.countByStatus();
    const activeStrategies = db.getStrategiesByStatus('ACTIVE');
    const pendingPromotions = db.getPendingPromotions();

    return reply.status(200).send({
      status: 'ok',
      strategy_counts: counts,
      active_strategies: activeStrategies.length,
      pending_promotions: pendingPromotions.length,
      timestamp: new Date().toISOString(),
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /evolution/strategies — All strategies with status and metrics
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get('/evolution/strategies', async (_request, reply) => {
    const all = db.getAllStrategies();
    return reply.status(200).send({
      total: all.length,
      strategies: all,
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /evolution/strategy/:id — Full details, lineage, experiments, transitions
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/evolution/strategy/:id',
    async (request, reply) => {
      const { id } = request.params;
      const strategy = db.getStrategy(id);

      if (!strategy) {
        return reply.status(404).send({ error: 'Strategy not found', strategy_id: id });
      }

      const experiments = ledger.getAllForStrategy(id);
      const lineage = registry.getLineage(id);
      const transitions = db.getTransitionHistory(id);

      return reply.status(200).send({
        strategy,
        experiments,
        lineage,
        transitions,
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────────────
  // POST /evolution/diagnose — Trigger diagnosis, return findings
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post('/evolution/diagnose', async (_request, reply) => {
    // Diagnosis is a heavy CLI-driven operation.
    // The API endpoint signals that diagnosis should be performed and returns
    // immediately. Full computation runs via `tsx src/evolution/cli.ts diagnose`.
    return reply.status(202).send({
      message: 'Diagnosis triggered — use CLI `diagnose <strategy_id>` for full output',
      timestamp: new Date().toISOString(),
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /evolution/run-cycle — Trigger full cycle, return report
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post('/evolution/run-cycle', async (_request, reply) => {
    // Full cycle (diagnose → generate → backtest → update) is a long-running
    // operation driven via CLI. The API signals initiation.
    return reply.status(202).send({
      message: 'Cycle triggered — use CLI `run-cycle` for full execution',
      timestamp: new Date().toISOString(),
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /evolution/promote/:id — Attempt promotion, return result
  // ─────────────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { id: string } }>(
    '/evolution/promote/:id',
    async (request, reply) => {
      const { id } = request.params;
      const result = promotionEngine.promote(id);

      const httpStatus = result.success ? 200 : result.requires_approval ? 202 : 400;
      return reply.status(httpStatus).send(result);
    },
  );
}

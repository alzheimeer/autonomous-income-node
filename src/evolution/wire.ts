/**
 * Strategy Evolution Lab — Fastify Integration Wire
 *
 * Wires the evolution module into an existing Fastify server.
 * Call this from the main HTTP server setup (heartbeat module).
 *
 * Requirements: 12.1, 15.3
 */

import type { FastifyInstance } from 'fastify';
import { EvolutionDatabase } from './evolution-database.js';
import { registerEvolutionRoutes } from './evolution-routes.js';
import { initializeBaseline } from './baseline.js';
import { FundingDatabase } from './funding-arb/database.js';
import { registerFundingArbRoutes } from './funding-arb/api-route.js';

/**
 * Wire the evolution module into an existing Fastify server.
 *
 * - Instantiates EvolutionDatabase with the default path
 * - Ensures the baseline strategy exists
 * - Registers all /evolution/* routes
 * - Registers /evolution/funding-arb route
 *
 * Safe to call multiple times (baseline init is idempotent).
 */
export function wireEvolution(fastify: FastifyInstance): void {
  const db = new EvolutionDatabase('data/evolution.db');
  initializeBaseline(db);
  registerEvolutionRoutes(fastify, { db });

  // Funding Arbitrage Backtest routes (Requirements 10.1, 10.2, 10.3)
  const fundingDb = new FundingDatabase('data/funding.db');
  registerFundingArbRoutes(fastify, fundingDb);
}

/**
 * Funding Arbitrage Backtest — Fastify API Route
 *
 * Exposes GET /evolution/funding-arb endpoint that returns the latest
 * backtest results from the FundingDatabase.
 *
 * Response format:
 *   - status: 'ok' with results when data exists
 *   - status: 'no_data' with descriptive message when no results found
 *
 * BigInt values are serialized as strings in the JSON response.
 *
 * Requirements: 10.1, 10.2, 10.3
 */

import type { FastifyInstance } from 'fastify';
import { FundingDatabase, type BacktestResultRow } from './database.js';

// ═══════════════════════════════════════════════════════════════════════════
// Response Types
// ═══════════════════════════════════════════════════════════════════════════

export interface FundingArbCoinResult {
  coin: string;
  netPnl: string;
  alpha: string;
  maxDrawdownBps: number;
  liquidations: number;
  verdict: string;
}

export interface FundingArbApiResponse {
  status: 'ok' | 'no_data';
  message?: string;
  results?: {
    runId: string;
    timestamp: string;
    coins: FundingArbCoinResult[];
    optimalCapital: string | null;
    overallVerdict: string;
    costScenario: string;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Route Registration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register the funding-arb API routes on the given Fastify instance.
 *
 * @param fastify - The Fastify server instance
 * @param db - FundingDatabase instance for reading backtest results
 */
export function registerFundingArbRoutes(
  fastify: FastifyInstance,
  db: FundingDatabase,
): void {
  // ─────────────────────────────────────────────────────────────────────────
  // GET /evolution/funding-arb — Latest backtest results
  // ─────────────────────────────────────────────────────────────────────────
  fastify.get('/evolution/funding-arb', async (_request, reply) => {
    const rows = db.getLatestResults();

    if (rows.length === 0) {
      const response: FundingArbApiResponse = {
        status: 'no_data',
        message: 'No backtest results found',
      };
      return reply.status(200).send(response);
    }

    // Group results by coin — pick the best capital level per coin
    // (the one with the highest alpha among viable results, or the highest capital if none viable)
    const coinMap = new Map<string, BacktestResultRow>();

    for (const row of rows) {
      const existing = coinMap.get(row.coin);
      if (!existing) {
        coinMap.set(row.coin, row);
      } else {
        // Prefer VIABLE over UNVIABLE, then higher alpha
        if (row.verdict === 'VIABLE' && existing.verdict !== 'VIABLE') {
          coinMap.set(row.coin, row);
        } else if (row.verdict === existing.verdict && row.alpha > existing.alpha) {
          coinMap.set(row.coin, row);
        }
      }
    }

    // Build per-coin results array
    const coins: FundingArbCoinResult[] = [];
    for (const [, row] of coinMap) {
      coins.push({
        coin: row.coin,
        netPnl: row.net_pnl.toString(),
        alpha: row.alpha.toString(),
        maxDrawdownBps: row.max_drawdown_bps,
        liquidations: row.liquidation_count,
        verdict: row.verdict,
      });
    }

    // Find optimal capital: smallest capital among viable results
    const viableRows = rows.filter((r) => r.verdict === 'VIABLE');
    let optimalCapital: string | null = null;
    if (viableRows.length > 0) {
      const minCapital = viableRows.reduce(
        (min, r) => (r.capital_usdc < min ? r.capital_usdc : min),
        viableRows[0].capital_usdc,
      );
      optimalCapital = minCapital.toString();
    }

    // Overall verdict: VIABLE if any result is viable
    const overallVerdict = viableRows.length > 0 ? 'VIABLE' : 'UNVIABLE';

    // Use the first row's metadata for run info
    const firstRow = rows[0];

    const response: FundingArbApiResponse = {
      status: 'ok',
      results: {
        runId: firstRow.run_id,
        timestamp: firstRow.created_at,
        coins,
        optimalCapital,
        overallVerdict,
        costScenario: firstRow.cost_scenario,
      },
    };

    return reply.status(200).send(response);
  });
}

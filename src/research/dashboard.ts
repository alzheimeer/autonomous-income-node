/**
 * ResearchDashboard — Fastify on port 3002.
 *
 * Endpoints:
 * - GET /health → {"status":"ok","uptime":...}
 * - GET /state → engine state (idle/scanning/evaluating)
 * - GET /opportunities → paginated list from DB
 * - GET /strategies → strategies with status
 * - GET /prices → cached price data
 * - GET /stats → counts by status and priority
 * - GET /log → last 50 from master_log
 */

import Fastify from 'fastify';
import type { ResearchDatabase } from './state/database.js';
import type { PriceFeedService } from './price-feed.js';
import type { EngineState } from './comms/protocol.js';

export interface DashboardDeps {
  db: ResearchDatabase;
  priceFeed: PriceFeedService;
  getState: () => EngineState;
}

export class ResearchDashboard {
  private readonly port: number;
  private readonly db: ResearchDatabase;
  private readonly priceFeed: PriceFeedService;
  private readonly getState: () => EngineState;
  private readonly startedAt: number;
  private server: ReturnType<typeof Fastify> | null = null;

  constructor(deps: DashboardDeps) {
    this.port = parseInt(process.env['RESEARCH_DASHBOARD_PORT'] ?? '3002', 10);
    this.db = deps.db;
    this.priceFeed = deps.priceFeed;
    this.getState = deps.getState;
    this.startedAt = Date.now();
  }

  async start(): Promise<void> {
    const app = Fastify({ logger: false });

    // GET /health
    app.get('/health', async () => ({
      status: 'ok',
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      timestamp: new Date().toISOString(),
    }));

    // GET /state
    app.get('/state', async () => ({
      state: this.getState(),
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
    }));

    // GET /opportunities
    app.get('/opportunities', async (request) => {
      const query = request.query as Record<string, string>;
      const limit = Math.min(parseInt(query['limit'] ?? '20', 10), 100);
      const offset = parseInt(query['offset'] ?? '0', 10);
      const status = query['status'];

      let sql = 'SELECT * FROM opportunities';
      const params: unknown[] = [];

      if (status) {
        sql += ' WHERE status = ?';
        params.push(status);
      }

      sql += ' ORDER BY score DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const rows = this.db.all(sql, ...params);
      const total = this.db.get<{ count: number }>(
        `SELECT COUNT(*) as count FROM opportunities${status ? ' WHERE status = ?' : ''}`,
        ...(status ? [status] : []),
      );

      return {
        data: rows,
        pagination: { limit, offset, total: total?.count ?? 0 },
      };
    });

    // GET /strategies
    app.get('/strategies', async () => {
      const rows = this.db.all('SELECT * FROM strategies ORDER BY created_at DESC LIMIT 50');
      return { data: rows };
    });

    // GET /prices
    app.get('/prices', async () => ({
      prices: this.priceFeed.getAllPrices(),
      lastUpdate: this.priceFeed.getAllPrices()[0]?.timestamp ?? null,
    }));

    // GET /stats
    app.get('/stats', async () => {
      const byStatus = this.db.all<{ status: string; count: number }>(
        'SELECT status, COUNT(*) as count FROM opportunities GROUP BY status',
      );
      const byPriority = this.db.all<{ priority: string; count: number }>(
        'SELECT priority, COUNT(*) as count FROM opportunities GROUP BY priority',
      );
      const totalScans = this.db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM scan_history',
      );
      const pendingApprovals = this.db.get<{ count: number }>(
        "SELECT COUNT(*) as count FROM approvals WHERE status = 'pending'",
      );

      return {
        byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.count])),
        byPriority: Object.fromEntries(byPriority.map((r) => [r.priority, r.count])),
        totalScans: totalScans?.count ?? 0,
        pendingApprovals: pendingApprovals?.count ?? 0,
      };
    });

    // GET /log
    app.get('/log', async () => {
      const rows = this.db.all(
        'SELECT id, title, score, status, priority, discovered_at FROM opportunities ORDER BY discovered_at DESC LIMIT 50',
      );
      return { entries: rows };
    });

    // GET /scanner-health — FIX 2: Scanner reliability dashboard
    app.get('/scanner-health', async () => {
      try {
        // Latest status per scanner
        const latestPerScanner = this.db.all<{
          scanner: string;
          status: string;
          results_count: number;
          error: string | null;
          timestamp: number;
        }>(
          `SELECT sh1.scanner, sh1.status, sh1.results_count, sh1.error, sh1.timestamp
           FROM scanner_health sh1
           INNER JOIN (
             SELECT scanner, MAX(timestamp) as max_ts FROM scanner_health GROUP BY scanner
           ) sh2 ON sh1.scanner = sh2.scanner AND sh1.timestamp = sh2.max_ts`,
        );

        // Failure counts per scanner (last 10 cycles)
        const failureCounts = this.db.all<{ scanner: string; total: number; failures: number }>(
          `SELECT scanner,
                  COUNT(*) as total,
                  SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failures
           FROM (
             SELECT scanner, status FROM scanner_health ORDER BY timestamp DESC LIMIT 50
           )
           GROUP BY scanner`,
        );

        return {
          scanners: latestPerScanner.map((s) => ({
            ...s,
            lastCheck: new Date(s.timestamp).toISOString(),
            failureStats: failureCounts.find((f) => f.scanner === s.scanner) ?? { total: 0, failures: 0 },
          })),
        };
      } catch {
        return { scanners: [], error: 'scanner_health table not available (run migration 002)' };
      }
    });

    // GET /revenue-status — FIX 3: Revenue lifecycle tracking
    app.get('/revenue-status', async () => {
      try {
        const codeGenerated = this.db.all<{ id: string; title: string; code_generated_at: number; revenue_check_at: number }>(
          `SELECT id, title, code_generated_at, revenue_check_at
           FROM opportunities WHERE status = 'code_generated' ORDER BY code_generated_at DESC`,
        );
        const revenueTracking = this.db.all<{ id: string; title: string; revenue_check_at: number; actual_revenue: string | null }>(
          `SELECT id, title, revenue_check_at, actual_revenue
           FROM opportunities WHERE status = 'revenue_tracking' ORDER BY revenue_check_at ASC`,
        );
        const confirmed = this.db.all<{ id: string; title: string; actual_revenue: string | null }>(
          `SELECT id, title, actual_revenue
           FROM opportunities WHERE status = 'implementada' AND actual_revenue IS NOT NULL LIMIT 20`,
        );
        const failed = this.db.all<{ id: string; title: string }>(
          `SELECT id, title FROM opportunities WHERE status = 'failed_no_revenue' ORDER BY status_changed_at DESC LIMIT 20`,
        );

        return {
          summary: {
            code_generated: codeGenerated.length,
            revenue_tracking: revenueTracking.length,
            revenue_confirmed: confirmed.length,
            failed_no_revenue: failed.length,
          },
          code_generated: codeGenerated,
          revenue_tracking: revenueTracking.map((r) => ({
            ...r,
            daysRemaining: Math.max(0, Math.ceil((r.revenue_check_at - Date.now()) / (24 * 60 * 60 * 1000))),
          })),
          confirmed,
          failed,
        };
      } catch {
        return { summary: {}, error: 'Revenue tracking columns not available (run migration 002)' };
      }
    });

    await app.listen({ port: this.port, host: '0.0.0.0' });
    this.server = app;
    console.log(`[ResearchDashboard] Listening on http://0.0.0.0:${this.port}`);
  }

  async stop(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = null;
    }
  }
}

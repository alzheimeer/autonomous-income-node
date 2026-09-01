/**
 * Pipeline Metrics - API Route
 *
 * Registers the `GET /trading/pipeline-metrics` Fastify route.
 * Follows the same pattern as `src/trading-validation/api-routes.ts`:
 *   - Operator authentication via IOperatorAuthenticator
 *   - Rate limiting via getClientIp + in-memory counter
 *   - JSON response with BigInt serialization
 *
 * Query parameters:
 *   - window: number (hours, default 24, max 168)
 *   - include_events: boolean (default false)
 *   - include_near_misses: boolean (default false)
 *
 * Returns:
 *   - 200: Aggregate metrics + optional events/near-misses
 *   - 401: Unauthorized
 *   - 429: Rate limited
 *   - 503: MetricsDatabase unavailable
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IOperatorAuthenticator, OperatorAuth } from '../trading-validation/operator-authenticator.js';
import type { MetricsDatabase } from './metrics-database.js';
import { computeAggregateMetrics } from './aggregate-metrics.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Dependencies for pipeline metrics route */
export interface PipelineMetricsDeps {
  db: MetricsDatabase;
  authenticator: IOperatorAuthenticator;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract the client IP from Cloudflare headers or fallback to socket IP.
 */
function getClientIp(request: FastifyRequest): string {
  const cfIp = request.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.length > 0) {
    return cfIp;
  }
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim();
  }
  return request.ip;
}

/**
 * Authenticate a request via Authorization header (API key) or X-Telegram-Auth headers.
 */
function authenticateRequest(
  request: FastifyRequest,
  authenticator: IOperatorAuthenticator,
): OperatorAuth {
  const authHeader = request.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7);
    return authenticator.verifyApiKey(apiKey);
  }

  const chatId = request.headers['x-telegram-chat-id'];
  const secret = request.headers['x-telegram-secret'];
  if (typeof chatId === 'string' && typeof secret === 'string') {
    return authenticator.verifyTelegram(chatId, secret);
  }

  return {
    source: 'api_key',
    timestamp: Date.now(),
    verified: false,
  };
}

/**
 * Parse a boolean query parameter.
 * Accepts 'true', '1', 'yes' as truthy; everything else is false.
 */
function parseBooleanParam(value: string | undefined): boolean {
  if (!value) return false;
  return value === 'true' || value === '1' || value === 'yes';
}

// ═══════════════════════════════════════════════════════════════════════════
// Route Registration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register the `GET /trading/pipeline-metrics` route on a Fastify instance.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 *
 * @param fastify - Fastify instance to register the route on
 * @param deps - Dependencies (MetricsDatabase + IOperatorAuthenticator)
 */
export function registerPipelineMetricsRoute(
  fastify: FastifyInstance,
  deps: PipelineMetricsDeps,
): void {
  const { db, authenticator } = deps;

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/pipeline-metrics
  // Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
  // ─────────────────────────────────────────────────────────────────────────

  fastify.get('/trading/pipeline-metrics', async (request: FastifyRequest, reply: FastifyReply) => {
    const ip = getClientIp(request);

    // Rate limit check (Req 6.2 — uses existing operator auth middleware pattern)
    if (!authenticator.checkRateLimit(ip)) {
      return reply.status(429).send({
        error: 'Rate limit exceeded',
        message: 'Max 60 requests per minute. Try again later.',
      });
    }

    // Authentication check (Req 6.2)
    const auth = authenticateRequest(request, authenticator);
    if (!auth.verified) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Valid API key or Telegram credentials required.',
      });
    }

    // Check database availability (Req 6.5)
    if (db.isDegraded) {
      return reply.status(503).send({
        error: 'Service Unavailable',
        message: 'Metrics database is unavailable. Operating in degraded mode.',
      });
    }

    // Parse query parameters (Req 6.3)
    const query = request.query as {
      window?: string;
      include_events?: string;
      include_near_misses?: string;
    };

    // window: hours, default 24, max 168
    const windowRaw = parseInt(query.window ?? '24', 10);
    const window = Math.min(Math.max(isNaN(windowRaw) ? 24 : windowRaw, 1), 168);

    const includeEvents = parseBooleanParam(query.include_events);
    const includeNearMisses = parseBooleanParam(query.include_near_misses);

    // Compute aggregate metrics (Req 6.4)
    const metrics = computeAggregateMetrics(db, window);

    // Build response
    const response: Record<string, unknown> = {
      metrics,
      window,
      timestamp: Date.now(),
    };

    // Optionally include last 10 events (Req 6.4)
    if (includeEvents) {
      response.events = db.queryEvents({ limit: 10 });
    }

    // Optionally include last 10 near-misses (Req 6.4)
    if (includeNearMisses) {
      response.near_misses = db.queryNearMisses({ limit: 10 });
    }

    return reply.status(200).send(response);
  });
}

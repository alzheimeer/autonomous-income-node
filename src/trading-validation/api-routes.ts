/**
 * Trading Validation Phase - API Routes
 *
 * Fastify route registration for trading state endpoints.
 * Integrates with the existing Fastify 4 server on port 3000.
 *
 * Endpoints:
 *   GET  /trading/status          — Current trading mode, safe-mode state, can-trade flag
 *   GET  /trading/bankroll        — Bankroll allocation (active/reserve/totals)
 *   GET  /trading/positions       — Position history (open + closed)
 *   GET  /trading/experiment      — Experiment report (shadow/micro pass criteria)
 *   POST /trading/emergency-stop  — Authenticated emergency stop
 *
 * Security:
 *   - Auth required for all /trading/* endpoints (Req 24.3)
 *   - No secrets in responses (Req 24.1) — uses redactSecrets
 *   - Rate limit: 60 req/min per CF-Connecting-IP (Req 24.2)
 *   - Access logging for all endpoints (Req 24.4)
 *
 * BigInt values serialized as strings (Req 29.3).
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4, 33.1, 33.2, 33.3
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { IOperatorAuthenticator, OperatorAuth } from './operator-authenticator.js';
import type { ISafeModeController } from './safe-mode-controller.js';
import type { BankrollState, Position, TradingMode } from './types.js';
import { redactSecrets } from './daily-metrics.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Dependencies injected into route registration */
export interface TradingApiDeps {
  /** Operator authenticator for verifying API keys */
  authenticator: IOperatorAuthenticator;
  /** SafeMode controller for state queries and emergency stop */
  safeModeController: ISafeModeController;
  /** Returns current bankroll state */
  getBankrollState: () => BankrollState;
  /** Returns current trading mode */
  getTradingMode: () => TradingMode;
  /** Returns position history (all positions, open first) */
  getPositions: (options?: { limit?: number; offset?: number; closed?: boolean }) => Position[];
  /** Returns the experiment report (JSON-serializable with BigInt as strings) */
  getExperimentReport: () => Record<string, unknown>;
  /** Execute emergency stop (blocks entries, optionally closes positions) */
  executeEmergencyStop: (closePositions: boolean) => void;
  /** Database reference for access logging */
  logAccess: (endpoint: string, ip: string, authorized: boolean) => void;
}

/** Serialized bankroll state (BigInt → string) */
interface SerializedBankrollState {
  totalUsdc: string;
  activeUsdc: string;
  reserveUsdc: string;
  unrealizedPnl: string;
  dailyRealizedPnl: string;
  dailyGasSpent: string;
  experimentTotalPnl: string;
}

/** Serialized position (BigInt → string) */
interface SerializedPosition {
  id: string;
  intentId: string;
  entryPrice: number;
  entryTimestamp: number;
  sizeUsdc: string;
  sizeWeth: string;
  stopLoss: number;
  takeProfit: number;
  maxHoldingMs: number;
  entryRegime: string;
  strategy: string;
  exitReason?: string;
  exitPrice?: number;
  exitTimestamp?: number;
  grossPnl?: string;
  netPnl?: string;
  mfe?: number;
  mae?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Serialize a BankrollState for JSON response (BigInt → string).
 * Requirements: 29.3
 */
function serializeBankrollState(state: BankrollState): SerializedBankrollState {
  return {
    totalUsdc: state.totalUsdc.toString(),
    activeUsdc: state.activeUsdc.toString(),
    reserveUsdc: state.reserveUsdc.toString(),
    unrealizedPnl: state.unrealizedPnl.toString(),
    dailyRealizedPnl: state.dailyRealizedPnl.toString(),
    dailyGasSpent: state.dailyGasSpent.toString(),
    experimentTotalPnl: state.experimentTotalPnl.toString(),
  };
}

/**
 * Serialize a Position for JSON response (BigInt → string).
 * Requirements: 29.3
 */
function serializePosition(pos: Position): SerializedPosition {
  return {
    id: pos.id,
    intentId: pos.intentId,
    entryPrice: pos.entryPrice,
    entryTimestamp: pos.entryTimestamp,
    sizeUsdc: pos.sizeUsdc.toString(),
    sizeWeth: pos.sizeWeth.toString(),
    stopLoss: pos.stopLoss,
    takeProfit: pos.takeProfit,
    maxHoldingMs: pos.maxHoldingMs,
    entryRegime: pos.entryRegime,
    strategy: pos.strategy,
    exitReason: pos.exitReason,
    exitPrice: pos.exitPrice,
    exitTimestamp: pos.exitTimestamp,
    grossPnl: pos.grossPnl?.toString(),
    netPnl: pos.netPnl?.toString(),
    mfe: pos.mfe,
    mae: pos.mae,
  };
}

/**
 * Extract the client IP from Cloudflare headers or fallback to socket IP.
 * Requirements: 24.2
 */
function getClientIp(request: FastifyRequest): string {
  // CF-Connecting-IP is the real client IP behind Cloudflare Tunnel
  const cfIp = request.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.length > 0) {
    return cfIp;
  }
  // Fallback: X-Forwarded-For or direct socket
  const xff = request.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0]!.trim();
  }
  return request.ip;
}

/**
 * Authenticate a request via Authorization header (API key) or X-Telegram-Auth headers.
 * Returns OperatorAuth result.
 */
function authenticateRequest(
  request: FastifyRequest,
  authenticator: IOperatorAuthenticator,
): OperatorAuth {
  // Try API key from Authorization: Bearer <key>
  const authHeader = request.headers['authorization'];
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const apiKey = authHeader.slice(7);
    return authenticator.verifyApiKey(apiKey);
  }

  // Try Telegram auth from custom headers
  const chatId = request.headers['x-telegram-chat-id'];
  const secret = request.headers['x-telegram-secret'];
  if (typeof chatId === 'string' && typeof secret === 'string') {
    return authenticator.verifyTelegram(chatId, secret);
  }

  // No credentials provided
  return {
    source: 'api_key',
    timestamp: Date.now(),
    verified: false,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Route Registration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Register all trading state API routes on a Fastify instance.
 *
 * Call this during application startup with the shared Fastify instance.
 *
 * All routes:
 * - Require authentication (Req 24.3)
 * - Rate-limited at 60 req/min per CF-Connecting-IP (Req 24.2)
 * - Redact secrets from responses (Req 24.1)
 * - Log access (Req 24.4)
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4, 33.1, 33.2, 33.3
 */
export function registerTradingRoutes(
  fastify: FastifyInstance,
  deps: TradingApiDeps,
): void {
  const { authenticator, safeModeController } = deps;

  // ─────────────────────────────────────────────────────────────────────────
  // Shared preHandler: rate limit + auth
  // ─────────────────────────────────────────────────────────────────────────

  const tradingPreHandler = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    const ip = getClientIp(request);

    // Rate limit check (Req 24.2)
    if (!authenticator.checkRateLimit(ip)) {
      deps.logAccess(request.url, ip, false);
      reply.status(429).send({
        error: 'Rate limit exceeded',
        message: 'Max 60 requests per minute. Try again later.',
      });
      return;
    }

    // Authentication check (Req 24.3)
    const auth = authenticateRequest(request, authenticator);
    if (!auth.verified) {
      deps.logAccess(request.url, ip, false);
      reply.status(401).send({
        error: 'Unauthorized',
        message: 'Valid API key or Telegram credentials required.',
      });
      return;
    }

    // Store auth on request for downstream use
    (request as FastifyRequest & { operatorAuth?: OperatorAuth }).operatorAuth = auth;

    // Log access (Req 24.4)
    deps.logAccess(request.url, ip, true);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/status — Current trading state overview
  // Requirements: 24.1, 24.3, 33.1
  // ─────────────────────────────────────────────────────────────────────────

  fastify.get('/trading/status', { preHandler: tradingPreHandler }, async (_request, reply) => {
    const safeState = safeModeController.getState();
    const mode = deps.getTradingMode();
    const canTrade = safeModeController.canTrade();
    const canClose = safeModeController.canClosePosition();

    const response = {
      mode,
      safeMode: {
        state: safeState.state,
        reason: safeState.reason ?? null,
        since: safeState.since ?? null,
      },
      canTrade,
      canClosePosition: canClose,
      timestamp: Date.now(),
    };

    // Redact any potential secrets from serialized response (Req 24.1)
    const safeJson = redactSecrets(JSON.stringify(response));
    return reply.status(200).header('content-type', 'application/json').send(safeJson);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/bankroll — Bankroll allocation state
  // Requirements: 24.1, 24.3
  // ─────────────────────────────────────────────────────────────────────────

  fastify.get('/trading/bankroll', { preHandler: tradingPreHandler }, async (_request, reply) => {
    const state = deps.getBankrollState();
    const serialized = serializeBankrollState(state);

    const response = {
      ...serialized,
      timestamp: Date.now(),
    };

    const safeJson = redactSecrets(JSON.stringify(response));
    return reply.status(200).header('content-type', 'application/json').send(safeJson);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/positions — Position history
  // Requirements: 24.1, 24.3
  // Query params: ?limit=50&offset=0&closed=true
  // ─────────────────────────────────────────────────────────────────────────

  fastify.get('/trading/positions', { preHandler: tradingPreHandler }, async (request, reply) => {
    const query = request.query as { limit?: string; offset?: string; closed?: string };

    const limit = Math.min(Math.max(parseInt(query.limit ?? '50', 10) || 50, 1), 200);
    const offset = Math.max(parseInt(query.offset ?? '0', 10) || 0, 0);
    const closedFilter = query.closed === 'true' ? true : query.closed === 'false' ? false : undefined;

    const positions = deps.getPositions({ limit, offset, closed: closedFilter });
    const serialized = positions.map(serializePosition);

    const response = {
      positions: serialized,
      count: serialized.length,
      limit,
      offset,
      timestamp: Date.now(),
    };

    const safeJson = redactSecrets(JSON.stringify(response));
    return reply.status(200).header('content-type', 'application/json').send(safeJson);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/experiment — Experiment report
  // Requirements: 24.1, 24.3, 14.6
  // ─────────────────────────────────────────────────────────────────────────

  fastify.get('/trading/experiment', { preHandler: tradingPreHandler }, async (_request, reply) => {
    const report = deps.getExperimentReport();

    const response = {
      ...report,
      timestamp: Date.now(),
    };

    // The experiment report may contain BigInt values already serialized by the caller
    const safeJson = redactSecrets(JSON.stringify(response, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    ));
    return reply.status(200).header('content-type', 'application/json').send(safeJson);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /trading/emergency-stop — Authenticated emergency stop
  // Requirements: 33.1, 33.2, 33.3, 24.3, 24.4
  // ─────────────────────────────────────────────────────────────────────────

  fastify.post('/trading/emergency-stop', { preHandler: tradingPreHandler }, async (request, reply) => {
    const auth = (request as FastifyRequest & { operatorAuth?: OperatorAuth }).operatorAuth;

    if (!auth || !auth.verified) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Valid credentials required for emergency stop.',
      });
    }

    // Emergency stop is a privileged command (Req 33.1)
    const authorized = authenticator.authorizeCommand('emergency_stop', auth);
    if (!authorized) {
      return reply.status(403).send({
        error: 'Forbidden',
        message: 'Emergency stop requires privileged authorization.',
      });
    }

    // Parse body for optional close_positions flag (Req 33.2)
    const body = request.body as { closePositions?: boolean } | null;
    const closePositions = body?.closePositions ?? false;

    // Execute emergency stop (Req 33.1: immediately blocks all entries)
    deps.executeEmergencyStop(closePositions);

    const response = {
      success: true,
      message: 'Emergency stop activated. All entries blocked.',
      closePositions,
      timestamp: Date.now(),
    };

    return reply.status(200).send(response);
  });
}

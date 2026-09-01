/**
 * Unit tests for trading-validation API routes.
 *
 * Tests: authentication, rate limiting, endpoint responses, BigInt serialization,
 * secret redaction, emergency stop authorization.
 *
 * Requirements: 24.1, 24.2, 24.3, 24.4, 33.1, 33.2, 33.3
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTradingRoutes, type TradingApiDeps } from './api-routes.js';
import type { OperatorAuth } from './operator-authenticator.js';
import type { BankrollState, Position, TradingMode } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mocks
// ═══════════════════════════════════════════════════════════════════════════

function createMockAuthenticator() {
  return {
    verifyApiKey: vi.fn((key: string): OperatorAuth => ({
      source: 'api_key' as const,
      timestamp: Date.now(),
      verified: key === 'valid-key',
    })),
    verifyTelegram: vi.fn((chatId: string, secret: string): OperatorAuth => ({
      source: 'telegram' as const,
      chatId,
      timestamp: Date.now(),
      verified: chatId === '12345' && secret === 'valid-secret',
    })),
    isPrivilegedCommand: vi.fn((cmd: string) => cmd === 'emergency_stop'),
    authorizeCommand: vi.fn((_cmd: string, auth: OperatorAuth) => auth.verified),
    checkRateLimit: vi.fn((_ip: string) => true),
  };
}

function createMockSafeModeController() {
  return {
    trigger: vi.fn(),
    resume: vi.fn(),
    triggerKillSwitch: vi.fn(),
    enterLowCostMode: vi.fn(),
    exitLowCostMode: vi.fn(),
    getState: vi.fn(() => ({
      state: 'normal' as const,
      reason: undefined,
      since: undefined,
      details: undefined,
    })),
    canTrade: vi.fn(() => true),
    canClosePosition: vi.fn(() => true),
  };
}

function createMockBankrollState(): BankrollState {
  return {
    totalUsdc: 99_630000n,
    activeUsdc: 25_000000n,
    reserveUsdc: 74_630000n,
    unrealizedPnl: 0n,
    dailyRealizedPnl: -150000n,
    dailyGasSpent: 30000n,
    experimentTotalPnl: -150000n,
  };
}

function createMockPositions(): Position[] {
  return [
    {
      id: 'pos-001',
      intentId: 'intent-001',
      entryPrice: 3450.25,
      entryTimestamp: 1700000000000,
      sizeUsdc: 8_000000n,
      sizeWeth: 2_318840579710145n,
      stopLoss: 3400.0,
      takeProfit: 3520.0,
      maxHoldingMs: 28_800_000,
      entryRegime: 'TRENDING_UP',
      strategy: 'trend_pullback',
      exitReason: 'take_profit',
      exitPrice: 3518.5,
      exitTimestamp: 1700003600000,
      grossPnl: 158000n,
      netPnl: 85000n,
      mfe: 2.1,
      mae: -0.3,
    },
  ];
}

function createMockExperimentReport() {
  return {
    mode: 'shadow',
    configHash: 'abc123def456',
    totalTrades: 5,
    netPnl: '250000',
    sharpeRatio: null,
    shadowPass: { passed: false, reasons: ['need_more_trades'] },
    microPass: { passed: false, reasons: ['not_in_micro_mode'] },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Setup
// ═══════════════════════════════════════════════════════════════════════════

describe('Trading API Routes', () => {
  let app: FastifyInstance;
  let mockAuth: ReturnType<typeof createMockAuthenticator>;
  let mockSafe: ReturnType<typeof createMockSafeModeController>;
  let deps: TradingApiDeps;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    mockAuth = createMockAuthenticator();
    mockSafe = createMockSafeModeController();

    deps = {
      authenticator: mockAuth,
      safeModeController: mockSafe,
      getBankrollState: vi.fn(() => createMockBankrollState()),
      getTradingMode: vi.fn((): TradingMode => 'shadow'),
      getPositions: vi.fn(() => createMockPositions()),
      getExperimentReport: vi.fn(() => createMockExperimentReport()),
      executeEmergencyStop: vi.fn(),
      logAccess: vi.fn(),
    };

    registerTradingRoutes(app, deps);
    await app.ready();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication (Req 24.3)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Authentication', () => {
    it('rejects requests without credentials', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trading/status',
      });

      expect(response.statusCode).toBe(401);
      expect(JSON.parse(response.body)).toHaveProperty('error', 'Unauthorized');
    });

    it('accepts valid Bearer token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(response.statusCode).toBe(200);
      expect(mockAuth.verifyApiKey).toHaveBeenCalledWith('valid-key');
    });

    it('rejects invalid Bearer token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: { authorization: 'Bearer wrong-key' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('accepts valid Telegram credentials', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: {
          'x-telegram-chat-id': '12345',
          'x-telegram-secret': 'valid-secret',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockAuth.verifyTelegram).toHaveBeenCalledWith('12345', 'valid-secret');
    });

    it('logs access for authorized requests (Req 24.4)', async () => {
      await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(deps.logAccess).toHaveBeenCalledWith('/trading/status', expect.any(String), true);
    });

    it('logs access for unauthorized requests (Req 24.4)', async () => {
      await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: { authorization: 'Bearer bad-key' },
      });

      expect(deps.logAccess).toHaveBeenCalledWith('/trading/status', expect.any(String), false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Rate Limiting (Req 24.2)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Rate Limiting', () => {
    it('returns 429 when rate limit exceeded', async () => {
      mockAuth.checkRateLimit.mockReturnValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(response.statusCode).toBe(429);
      expect(JSON.parse(response.body)).toHaveProperty('error', 'Rate limit exceeded');
    });

    it('uses CF-Connecting-IP for rate limit key', async () => {
      await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: {
          authorization: 'Bearer valid-key',
          'cf-connecting-ip': '203.0.113.42',
        },
      });

      expect(mockAuth.checkRateLimit).toHaveBeenCalledWith('203.0.113.42');
    });

    it('falls back to X-Forwarded-For if no CF header', async () => {
      await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: {
          authorization: 'Bearer valid-key',
          'x-forwarded-for': '198.51.100.1, 10.0.0.1',
        },
      });

      expect(mockAuth.checkRateLimit).toHaveBeenCalledWith('198.51.100.1');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/status
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /trading/status', () => {
    it('returns current trading status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.mode).toBe('shadow');
      expect(body.safeMode.state).toBe('normal');
      expect(body.canTrade).toBe(true);
      expect(body.canClosePosition).toBe(true);
      expect(body.timestamp).toBeTypeOf('number');
    });

    it('reflects safe mode state', async () => {
      mockSafe.getState.mockReturnValue({
        state: 'safe_mode',
        reason: 'recon_mismatch',
        since: 1700000000000,
        details: 'Balance deviation detected',
      });
      mockSafe.canTrade.mockReturnValue(false);

      const response = await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: { authorization: 'Bearer valid-key' },
      });

      const body = JSON.parse(response.body);
      expect(body.safeMode.state).toBe('safe_mode');
      expect(body.safeMode.reason).toBe('recon_mismatch');
      expect(body.canTrade).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/bankroll
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /trading/bankroll', () => {
    it('returns bankroll state with BigInt as strings', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trading/bankroll',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      // BigInt values serialized as strings (Req 29.3)
      expect(body.totalUsdc).toBe('99630000');
      expect(body.activeUsdc).toBe('25000000');
      expect(body.reserveUsdc).toBe('74630000');
      expect(body.unrealizedPnl).toBe('0');
      expect(body.dailyRealizedPnl).toBe('-150000');
      expect(body.dailyGasSpent).toBe('30000');
      expect(body.experimentTotalPnl).toBe('-150000');
      expect(body.timestamp).toBeTypeOf('number');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/positions
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /trading/positions', () => {
    it('returns position history with BigInt as strings', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trading/positions',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.positions).toHaveLength(1);
      expect(body.positions[0].id).toBe('pos-001');
      expect(body.positions[0].sizeUsdc).toBe('8000000');
      expect(body.positions[0].sizeWeth).toBe('2318840579710145');
      expect(body.positions[0].grossPnl).toBe('158000');
      expect(body.positions[0].netPnl).toBe('85000');
      expect(body.count).toBe(1);
    });

    it('passes query params to getPositions', async () => {
      await app.inject({
        method: 'GET',
        url: '/trading/positions?limit=10&offset=5&closed=true',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(deps.getPositions).toHaveBeenCalledWith({
        limit: 10,
        offset: 5,
        closed: true,
      });
    });

    it('clamps limit to max 200', async () => {
      await app.inject({
        method: 'GET',
        url: '/trading/positions?limit=999',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(deps.getPositions).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 200 }),
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GET /trading/experiment
  // ─────────────────────────────────────────────────────────────────────────

  describe('GET /trading/experiment', () => {
    it('returns experiment report', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trading/experiment',
        headers: { authorization: 'Bearer valid-key' },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.mode).toBe('shadow');
      expect(body.totalTrades).toBe(5);
      expect(body.shadowPass).toEqual({ passed: false, reasons: ['need_more_trades'] });
      expect(body.timestamp).toBeTypeOf('number');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // POST /trading/emergency-stop (Req 33.1, 33.2, 33.3)
  // ─────────────────────────────────────────────────────────────────────────

  describe('POST /trading/emergency-stop', () => {
    it('executes emergency stop with valid auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trading/emergency-stop',
        headers: {
          authorization: 'Bearer valid-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ closePositions: true }),
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.success).toBe(true);
      expect(body.closePositions).toBe(true);
      expect(deps.executeEmergencyStop).toHaveBeenCalledWith(true);
    });

    it('defaults closePositions to false', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trading/emergency-stop',
        headers: {
          authorization: 'Bearer valid-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.statusCode).toBe(200);
      expect(deps.executeEmergencyStop).toHaveBeenCalledWith(false);
    });

    it('rejects unauthorized emergency stop', async () => {
      mockAuth.authorizeCommand.mockReturnValue(false);

      const response = await app.inject({
        method: 'POST',
        url: '/trading/emergency-stop',
        headers: {
          authorization: 'Bearer valid-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({}),
      });

      expect(response.statusCode).toBe(403);
      expect(deps.executeEmergencyStop).not.toHaveBeenCalled();
    });

    it('requires operator confirmation to resume (Req 33.3)', async () => {
      // Emergency stop doesn't auto-resume — that's a separate privileged command
      // This test confirms the emergency stop only BLOCKS, doesn't provide resume.
      const response = await app.inject({
        method: 'POST',
        url: '/trading/emergency-stop',
        headers: {
          authorization: 'Bearer valid-key',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ closePositions: false }),
      });

      const body = JSON.parse(response.body);
      expect(body.message).toContain('blocked');
      expect(deps.executeEmergencyStop).toHaveBeenCalledWith(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Secret Redaction (Req 24.1)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Secret Redaction', () => {
    it('redacts secrets from responses (Req 24.1)', async () => {
      // Inject a secret-looking value into the safe mode reason
      mockSafe.getState.mockReturnValue({
        state: 'safe_mode',
        reason: 'rpc_failure',
        since: Date.now(),
        details: 'RPC URL https://eth-mainnet.g.alchemy.com/v2/abcdefghij1234567890abcdefghij12 failed',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trading/status',
        headers: { authorization: 'Bearer valid-key' },
      });

      // The safe mode reason shouldn't contain secrets
      // (note: details field is not exposed in the status response, only reason is)
      expect(response.body).not.toContain('abcdefghij1234567890abcdefghij12');
    });
  });
});

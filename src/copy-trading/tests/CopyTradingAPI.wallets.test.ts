/**
 * @fileoverview Tests for Copy Trading API wallet endpoints (Task 21.2)
 * 
 * Tests the following endpoints:
 * - GET /copy/wallets - List monitored wallets with tiers/metrics (Req 9.2)
 * - POST /copy/wallets - Add wallet to monitored list (Req 9.3)
 * - DELETE /copy/wallets/:address - Remove wallet from monitored list (Req 9.4)
 * - Address validation returning HTTP 400 (Req 9.9)
 * 
 * @module copy-trading/tests/CopyTradingAPI.wallets.test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CopyTradingAPI, type CopyTradingRouteDeps, type WalletListResponse } from '../routes/copy.js';
import type { ISmartMoneyCurator, SmartMoneyWallet, WalletTier } from '../interfaces/types.js';

// =============================================================================
// MOCK HELPERS
// =============================================================================

/**
 * Create a mock SmartMoneyWallet for testing
 */
function createMockWallet(overrides: Partial<SmartMoneyWallet> = {}): SmartMoneyWallet {
  const now = Date.now();
  return {
    address: overrides.address ?? '0x1234567890123456789012345678901234567890',
    tier: overrides.tier ?? 'A_TIER',
    metrics: {
      winRate: 0.75,
      totalPnlUsdc: 100000,
      tradeCount: 150,
      avgHoldingTimeSec: 3600,
      volumeUsdc: 750000,
      sharpeRatio: 1.5,
      maxDrawdownPct: 0.15,
      profitFactor: 2.0,
      profitableWeeksPct: 0.8,
      ...overrides.metrics,
    },
    flags: {
      isMevBot: false,
      isTokenDeployer: false,
      hasHoneypotExposure: false,
      isWashTrader: false,
      ...overrides.flags,
    },
    addedAt: overrides.addedAt ?? now,
    lastEvaluatedAt: overrides.lastEvaluatedAt ?? now,
    isActive: overrides.isActive ?? true,
  };
}

/**
 * Create a mock curator for testing
 */
function createMockCurator(wallets: SmartMoneyWallet[] = []): ISmartMoneyCurator {
  const walletsMap = new Map<string, SmartMoneyWallet>();
  wallets.forEach(w => walletsMap.set(w.address.toLowerCase(), w));

  return {
    getWallets: vi.fn(() => Array.from(walletsMap.values())),
    getWalletsByTier: vi.fn((tier: WalletTier) => 
      Array.from(walletsMap.values()).filter(w => w.tier === tier)
    ),
    addWallet: vi.fn(async (address: string) => {
      const normalizedAddress = address.toLowerCase();
      if (walletsMap.has(normalizedAddress)) {
        return null;
      }
      const newWallet = createMockWallet({ address });
      walletsMap.set(normalizedAddress, newWallet);
      return newWallet;
    }),
    removeWallet: vi.fn((address: string) => {
      const normalizedAddress = address.toLowerCase();
      const existed = walletsMap.has(normalizedAddress);
      walletsMap.delete(normalizedAddress);
      return existed;
    }),
    reEvaluateAll: vi.fn(async () => {}),
    isMonitored: vi.fn((address: string) => walletsMap.has(address.toLowerCase())),
  };
}

/**
 * Make a test HTTP request using fetch
 */
async function makeRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: object,
  headers: Record<string, string> = {}
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  const options: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  return fetch(url, options);
}

// =============================================================================
// TEST SUITES
// =============================================================================

describe('CopyTradingAPI - Wallet Endpoints (Task 21.2)', () => {
  let api: CopyTradingAPI;
  let mockCurator: ISmartMoneyCurator;
  let baseUrl: string;
  const testPort = 3099;

  beforeEach(async () => {
    mockCurator = createMockCurator();
    const deps: CopyTradingRouteDeps = {
      curator: mockCurator,
    };
    api = new CopyTradingAPI(deps, testPort);
    await api.start();
    baseUrl = `http://127.0.0.1:${testPort}`;
  });

  afterEach(async () => {
    await api.stop();
  });

  // ===========================================================================
  // GET /copy/wallets - Requirement 9.2
  // ===========================================================================

  describe('GET /copy/wallets (Req 9.2)', () => {
    it('should return empty list when no wallets monitored', async () => {
      const response = await makeRequest(baseUrl, 'GET', '/copy/wallets');
      
      expect(response.status).toBe(200);
      const data = await response.json() as WalletListResponse;
      expect(data.wallets).toEqual([]);
      expect(data.total).toBe(0);
    });

    it('should return list of monitored wallets with tiers and metrics', async () => {
      const wallet1 = createMockWallet({
        address: '0x1111111111111111111111111111111111111111',
        tier: 'S_TIER',
      });
      const wallet2 = createMockWallet({
        address: '0x2222222222222222222222222222222222222222',
        tier: 'A_TIER',
      });

      mockCurator = createMockCurator([wallet1, wallet2]);
      await api.stop();
      api = new CopyTradingAPI({ curator: mockCurator }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'GET', '/copy/wallets');
      
      expect(response.status).toBe(200);
      const data = await response.json() as WalletListResponse;
      expect(data.total).toBe(2);
      expect(data.wallets).toHaveLength(2);

      // Verify first wallet structure
      const w1 = data.wallets.find(w => w.address === wallet1.address);
      expect(w1).toBeDefined();
      expect(w1?.tier).toBe('S_TIER');
      expect(w1?.metrics).toHaveProperty('winRate');
      expect(w1?.metrics).toHaveProperty('totalPnlUsdc');
      expect(w1?.metrics).toHaveProperty('tradeCount');
      expect(w1?.metrics).toHaveProperty('sharpeRatio');
      expect(w1?.isActive).toBe(true);
      expect(w1?.addedAt).toBeGreaterThan(0);
      expect(w1?.lastEvaluatedAt).toBeGreaterThan(0);
    });

    it('should return all required fields for each wallet', async () => {
      const wallet = createMockWallet({
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
        tier: 'B_TIER',
        metrics: {
          winRate: 0.72,
          totalPnlUsdc: 55000,
          tradeCount: 120,
          avgHoldingTimeSec: 7200,
          volumeUsdc: 600000,
          sharpeRatio: 1.3,
          maxDrawdownPct: 0.18,
          profitFactor: 1.8,
          profitableWeeksPct: 0.75,
        },
      });

      mockCurator = createMockCurator([wallet]);
      await api.stop();
      api = new CopyTradingAPI({ curator: mockCurator }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'GET', '/copy/wallets');
      const data = await response.json() as WalletListResponse;

      const returnedWallet = data.wallets[0];
      expect(returnedWallet.address).toBe(wallet.address);
      expect(returnedWallet.tier).toBe('B_TIER');
      expect(returnedWallet.metrics.winRate).toBe(0.72);
      expect(returnedWallet.metrics.totalPnlUsdc).toBe(55000);
      expect(returnedWallet.metrics.tradeCount).toBe(120);
      expect(returnedWallet.metrics.sharpeRatio).toBe(1.3);
    });
  });

  // ===========================================================================
  // POST /copy/wallets - Requirement 9.3, 9.9
  // ===========================================================================

  describe('POST /copy/wallets (Req 9.3, 9.9)', () => {
    it('should add a valid wallet and return 201', async () => {
      const validAddress = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';

      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: validAddress,
      });

      expect(response.status).toBe(201);
      const data = await response.json();
      expect(data.message).toBe('Wallet added successfully');
      expect(data.wallet).toBeDefined();
      expect(data.wallet.address).toBe(validAddress);
      expect(data.wallet.tier).toBeDefined();
      expect(data.wallet.isActive).toBe(true);
      expect(data.wallet.addedAt).toBeGreaterThan(0);

      // Verify curator was called
      expect(mockCurator.addWallet).toHaveBeenCalledWith(validAddress);
    });

    it('should return 400 for invalid address format - missing 0x prefix', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '1234567890123456789012345678901234567890',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Bad Request');
      expect(data.message).toContain('Invalid wallet address');
    });

    it('should return 400 for invalid address format - too short', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '0x1234567890',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Bad Request');
    });

    it('should return 400 for invalid address format - too long', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '0x12345678901234567890123456789012345678901234567890',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Bad Request');
    });

    it('should return 400 for invalid address format - non-hex characters', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Bad Request');
    });

    it('should return 400 when address is empty', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '',
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Bad Request');
    });

    it('should return 400 when address is missing', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {});

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Bad Request');
    });

    it('should return 400 when wallet is already monitored', async () => {
      const existingAddress = '0x1234567890123456789012345678901234567890';
      const existingWallet = createMockWallet({ address: existingAddress });
      mockCurator = createMockCurator([existingWallet]);
      await api.stop();
      api = new CopyTradingAPI({ curator: mockCurator }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: existingAddress,
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.message).toContain('does not meet inclusion criteria or is already monitored');
    });

    it('should handle lowercase addresses', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '0xabcdef1234567890abcdef1234567890abcdef12',
      });

      expect(response.status).toBe(201);
    });

    it('should handle mixed-case addresses', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '0xAbCdEf1234567890abcdef1234567890AbCdEf12',
      });

      expect(response.status).toBe(201);
    });
  });

  // ===========================================================================
  // DELETE /copy/wallets/:address - Requirement 9.4, 9.9
  // ===========================================================================

  describe('DELETE /copy/wallets/:address (Req 9.4, 9.9)', () => {
    it('should remove an existing wallet and return 200', async () => {
      const walletAddress = '0x1234567890123456789012345678901234567890';
      const existingWallet = createMockWallet({ address: walletAddress });
      mockCurator = createMockCurator([existingWallet]);
      await api.stop();
      api = new CopyTradingAPI({ curator: mockCurator }, testPort);
      await api.start();

      const response = await makeRequest(baseUrl, 'DELETE', `/copy/wallets/${walletAddress}`);

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.message).toBe('Wallet removed successfully');
      expect(data.address).toBe(walletAddress);
      expect(data.removedAt).toBeGreaterThan(0);

      // Verify curator was called
      expect(mockCurator.isMonitored).toHaveBeenCalledWith(walletAddress);
      expect(mockCurator.removeWallet).toHaveBeenCalledWith(walletAddress);
    });

    it('should return 404 when wallet not found', async () => {
      const nonExistentAddress = '0xabcdef1234567890abcdef1234567890abcdef12';

      const response = await makeRequest(baseUrl, 'DELETE', `/copy/wallets/${nonExistentAddress}`);

      expect(response.status).toBe(404);
      const data = await response.json();
      expect(data.error).toBe('Not Found');
      expect(data.message).toContain('Wallet not found');
    });

    it('should return 400 for invalid address format in URL', async () => {
      const response = await makeRequest(baseUrl, 'DELETE', '/copy/wallets/invalid-address');

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe('Bad Request');
      expect(data.message).toContain('Invalid wallet address format');
    });

    it('should return 400 for address missing 0x prefix', async () => {
      const response = await makeRequest(baseUrl, 'DELETE', '/copy/wallets/1234567890123456789012345678901234567890');

      expect(response.status).toBe(400);
    });

    it('should return 400 for address too short', async () => {
      const response = await makeRequest(baseUrl, 'DELETE', '/copy/wallets/0x123');

      expect(response.status).toBe(400);
    });
  });

  // ===========================================================================
  // API Key Authentication - Requirement 9.10
  // ===========================================================================

  describe('API Key Authentication for mutating endpoints (Req 9.10)', () => {
    const testApiKey = 'test-api-key-12345';

    beforeEach(async () => {
      await api.stop();
      mockCurator = createMockCurator([
        createMockWallet({ address: '0x1234567890123456789012345678901234567890' })
      ]);
      api = new CopyTradingAPI({ curator: mockCurator, apiKey: testApiKey }, testPort);
      await api.start();
    });

    it('GET /copy/wallets should not require API key', async () => {
      const response = await makeRequest(baseUrl, 'GET', '/copy/wallets');
      expect(response.status).toBe(200);
    });

    it('POST /copy/wallets should return 401 without API key', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '0xaabbccdd1234567890aabbccdd1234567890aabb',
      });

      expect(response.status).toBe(401);
      const data = await response.json();
      expect(data.error).toBe('Unauthorized');
    });

    it('POST /copy/wallets should succeed with valid API key in Authorization header', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', 
        { address: '0xaabbccdd1234567890aabbccdd1234567890aabb' },
        { 'Authorization': `Bearer ${testApiKey}` }
      );

      expect(response.status).toBe(201);
    });

    it('POST /copy/wallets should succeed with valid API key in X-API-Key header', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', 
        { address: '0xbbccddee1234567890bbccddee1234567890bbcc' },
        { 'X-API-Key': testApiKey }
      );

      expect(response.status).toBe(201);
    });

    it('DELETE /copy/wallets/:address should return 401 without API key', async () => {
      const response = await makeRequest(baseUrl, 'DELETE', '/copy/wallets/0x1234567890123456789012345678901234567890');

      expect(response.status).toBe(401);
    });

    it('DELETE /copy/wallets/:address should succeed with valid API key', async () => {
      const response = await makeRequest(
        baseUrl, 
        'DELETE', 
        '/copy/wallets/0x1234567890123456789012345678901234567890',
        undefined,
        { 'Authorization': `Bearer ${testApiKey}` }
      );

      expect(response.status).toBe(200);
    });

    it('should return 401 with invalid API key', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', 
        { address: '0xccddeeFF1234567890ccddeeFF1234567890ccdd' },
        { 'Authorization': 'Bearer invalid-key' }
      );

      expect(response.status).toBe(401);
    });
  });

  // ===========================================================================
  // Service Unavailable when curator not initialized
  // ===========================================================================

  describe('Service Unavailable scenarios', () => {
    beforeEach(async () => {
      await api.stop();
      api = new CopyTradingAPI({}, testPort); // No curator
      await api.start();
    });

    it('POST /copy/wallets should return 503 when curator not initialized', async () => {
      const response = await makeRequest(baseUrl, 'POST', '/copy/wallets', {
        address: '0x1234567890123456789012345678901234567890',
      });

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toBe('Service Unavailable');
      expect(data.message).toContain('Curator not initialized');
    });

    it('DELETE /copy/wallets/:address should return 503 when curator not initialized', async () => {
      const response = await makeRequest(baseUrl, 'DELETE', '/copy/wallets/0x1234567890123456789012345678901234567890');

      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.error).toBe('Service Unavailable');
    });
  });
});

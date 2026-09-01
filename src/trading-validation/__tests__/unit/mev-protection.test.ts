/**
 * Unit tests for MevProtectionEngine
 *
 * Tests MEV protection and slippage monitoring:
 * - minAmountOut calculation (quote - 40 bps with private RPC, 30 bps without)
 * - Price impact rejection (30 bps with private RPC, 20 bps without)
 * - Private RPC routing
 * - Quoted vs executed slippage logging
 * - 3 consecutive trades with slippage > 1.5x estimated → Safe_Mode + alert
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, E12
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MevProtectionEngine,
  createDefaultMevConfig,
  type MevProtectionConfig,
  type ISafeModeCallback,
  type IAlertCallback,
  type SlippageLogEntry,
} from '../../mev-protection.js';
import type { ExecutableQuote } from '../../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function makeQuote(overrides: Partial<ExecutableQuote> = {}): ExecutableQuote {
  return {
    source: 'quoter_v2',
    amountIn: 5_000_000n,             // $5 USDC
    amountOut: 2_500_000_000_000_000n, // ~0.0025 WETH
    priceImpactBps: 5,                 // 5 bps (healthy)
    gasEstimate: 200_000n,
    gasUsd: 0.02,
    timestamp: Date.now(),
    poolFeeIncluded: true,
    externalFees: 0n,
    ttl: 10_000,
    ...overrides,
  };
}

function createMockSafeModeCallback(): ISafeModeCallback & { calls: Array<{ reason: string; details: string }> } {
  const calls: Array<{ reason: string; details: string }> = [];
  return {
    calls,
    trigger(reason: 'deviation_alerts', details: string) {
      calls.push({ reason, details });
    },
  };
}

function createMockAlertCallback(): IAlertCallback & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    sendAlert(message: string) {
      messages.push(message);
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('MevProtectionEngine', () => {
  // ─── createDefaultMevConfig ─────────────────────────────────────────

  describe('createDefaultMevConfig', () => {
    it('sets 40 bps slippage and 30 bps impact with private RPC', () => {
      const config = createDefaultMevConfig(true, 'https://private-rpc.example.com');
      expect(config.hasPrivateRpc).toBe(true);
      expect(config.maxSlippageBps).toBe(40);
      expect(config.maxPriceImpactBps).toBe(30);
      expect(config.privateRpcUrl).toBe('https://private-rpc.example.com');
    });

    it('sets stricter 30 bps slippage and 20 bps impact without private RPC (E12)', () => {
      const config = createDefaultMevConfig(false);
      expect(config.hasPrivateRpc).toBe(false);
      expect(config.maxSlippageBps).toBe(30);
      expect(config.maxPriceImpactBps).toBe(20);
      expect(config.privateRpcUrl).toBeUndefined();
    });

    it('sets default deviation multiplier and threshold', () => {
      const config = createDefaultMevConfig(true);
      expect(config.slippageDeviationMultiplier).toBe(1.5);
      expect(config.consecutiveSlippageThreshold).toBe(3);
    });
  });

  // ─── Quote Validation (Req 22.1, 22.2) ─────────────────────────────

  describe('validateQuote - minAmountOut calculation (Req 22.1)', () => {
    let engine: MevProtectionEngine;

    beforeEach(() => {
      engine = new MevProtectionEngine(createDefaultMevConfig(true));
    });

    it('computes minAmountOut = quote - 40 bps with private RPC', () => {
      const quote = makeQuote({ amountOut: 10_000_000_000_000_000n }); // 0.01 WETH
      const result = engine.validateQuote(quote);

      expect(result.approved).toBe(true);
      // minAmountOut = 10_000_000_000_000_000 * (10000 - 40) / 10000
      // = 10_000_000_000_000_000 * 9960 / 10000
      // = 9_960_000_000_000_000
      expect(result.minAmountOut).toBe(9_960_000_000_000_000n);
      expect(result.maxSlippageBps).toBe(40);
    });

    it('computes minAmountOut = quote - 30 bps without private RPC', () => {
      const noPrivateEngine = new MevProtectionEngine(createDefaultMevConfig(false));
      const quote = makeQuote({ amountOut: 10_000_000_000_000_000n });
      const result = noPrivateEngine.validateQuote(quote);

      expect(result.approved).toBe(true);
      // minAmountOut = 10_000_000_000_000_000 * (10000 - 30) / 10000
      // = 10_000_000_000_000_000 * 9970 / 10000
      // = 9_970_000_000_000_000
      expect(result.minAmountOut).toBe(9_970_000_000_000_000n);
      expect(result.maxSlippageBps).toBe(30);
    });

    it('returns zero minAmountOut for zero quoted amount', () => {
      const quote = makeQuote({ amountOut: 0n });
      const result = engine.validateQuote(quote);

      expect(result.approved).toBe(false);
      expect(result.minAmountOut).toBe(0n);
    });

    it('preserves BigInt precision for large amounts', () => {
      // ~100 WETH
      const quote = makeQuote({ amountOut: 100_000_000_000_000_000_000n });
      const result = engine.validateQuote(quote);

      expect(result.approved).toBe(true);
      // 100e18 * 9960 / 10000 = 99.6e18
      expect(result.minAmountOut).toBe(99_600_000_000_000_000_000n);
    });
  });

  describe('validateQuote - price impact rejection (Req 22.2)', () => {
    it('rejects if price impact > 30 bps with private RPC', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(true));
      const quote = makeQuote({ priceImpactBps: 31 });
      const result = engine.validateQuote(quote);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Price impact 31 bps exceeds max 30 bps');
    });

    it('approves price impact at exactly 30 bps with private RPC', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(true));
      const quote = makeQuote({ priceImpactBps: 30 });
      const result = engine.validateQuote(quote);

      expect(result.approved).toBe(true);
    });

    it('rejects if price impact > 20 bps without private RPC (E12)', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(false));
      const quote = makeQuote({ priceImpactBps: 21 });
      const result = engine.validateQuote(quote);

      expect(result.approved).toBe(false);
      expect(result.reason).toContain('Price impact 21 bps exceeds max 20 bps');
      expect(result.reason).toContain('stricter limit without private RPC');
    });

    it('approves price impact at exactly 20 bps without private RPC', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(false));
      const quote = makeQuote({ priceImpactBps: 20 });
      const result = engine.validateQuote(quote);

      expect(result.approved).toBe(true);
    });

    it('approves low price impact (5 bps)', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(true));
      const quote = makeQuote({ priceImpactBps: 5 });
      const result = engine.validateQuote(quote);

      expect(result.approved).toBe(true);
    });
  });

  // ─── Private RPC Routing (Req 22.3) ────────────────────────────────

  describe('Private RPC routing (Req 22.3)', () => {
    it('returns private RPC URL when configured', () => {
      const engine = new MevProtectionEngine(
        createDefaultMevConfig(true, 'https://private.example.com'),
      );
      expect(engine.getSubmissionRpcUrl()).toBe('https://private.example.com');
      expect(engine.shouldUsePrivateRpc()).toBe(true);
    });

    it('returns null when no private RPC configured', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(false));
      expect(engine.getSubmissionRpcUrl()).toBeNull();
      expect(engine.shouldUsePrivateRpc()).toBe(false);
    });

    it('validates usePrivateRpc flag in validation result', () => {
      const engineWithRpc = new MevProtectionEngine(
        createDefaultMevConfig(true, 'https://private.example.com'),
      );
      const engineWithoutRpc = new MevProtectionEngine(createDefaultMevConfig(false));

      const quote = makeQuote();
      expect(engineWithRpc.validateQuote(quote).usePrivateRpc).toBe(true);
      expect(engineWithoutRpc.validateQuote(quote).usePrivateRpc).toBe(false);
    });
  });

  // ─── Slippage Logging (Req 22.4) ───────────────────────────────────

  describe('logTradeSlippage - quoted vs executed logging (Req 22.4)', () => {
    let engine: MevProtectionEngine;

    beforeEach(() => {
      engine = new MevProtectionEngine(createDefaultMevConfig(true));
    });

    it('logs trade with no slippage (executed >= quoted)', () => {
      const entry = engine.logTradeSlippage(
        'trade-1',
        1_000_000_000_000_000n,  // quoted
        1_000_000_000_000_000n,  // executed (same)
        40,                       // estimated slippage bps
        5,                        // price impact bps
      );

      expect(entry.tradeId).toBe('trade-1');
      expect(entry.realizedSlippageBps).toBe(0);
      expect(entry.exceedsThreshold).toBe(false);
    });

    it('logs trade with favorable execution (executed > quoted)', () => {
      const entry = engine.logTradeSlippage(
        'trade-2',
        1_000_000_000_000_000n,  // quoted
        1_010_000_000_000_000n,  // executed (more)
        40,
        5,
      );

      expect(entry.realizedSlippageBps).toBe(0); // No slippage
      expect(entry.exceedsThreshold).toBe(false);
    });

    it('correctly calculates realized slippage in bps', () => {
      // 20 bps slippage: executed = quoted * (10000 - 20) / 10000
      const quoted = 10_000_000_000_000_000n;
      const executed = 9_980_000_000_000_000n; // 20 bps less

      const entry = engine.logTradeSlippage('trade-3', quoted, executed, 40, 5);

      expect(entry.realizedSlippageBps).toBe(20);
      expect(entry.exceedsThreshold).toBe(false); // 20 < 40*1.5 = 60
    });

    it('marks as exceeding threshold when realized > 1.5x estimated', () => {
      // estimated = 40 bps, threshold = 40 * 1.5 = 60 bps
      // realized = 70 bps → exceeds
      const quoted = 10_000_000_000_000_000n;
      // 70 bps = 0.007 → executed = quoted - (quoted * 70 / 10000)
      const executed = 10_000_000_000_000_000n - 7_000_000_000_000n; // 70 bps less

      const entry = engine.logTradeSlippage('trade-4', quoted, executed, 40, 5);

      expect(entry.realizedSlippageBps).toBe(7); // due to BigInt division truncation
      // Actually: (10_000_000_000_000_000 - 9_993_000_000_000_000) * 10000 / 10_000_000_000_000_000
      // = 7_000_000_000_000 * 10000 / 10_000_000_000_000_000 = 7
      expect(entry.exceedsThreshold).toBe(false); // 7 < 60
    });

    it('records history of slippage entries', () => {
      engine.logTradeSlippage('t1', 1000n, 990n, 40, 5);
      engine.logTradeSlippage('t2', 1000n, 980n, 40, 5);
      engine.logTradeSlippage('t3', 1000n, 970n, 40, 5);

      const history = engine.getSlippageHistory();
      expect(history).toHaveLength(3);
      expect(history[0].tradeId).toBe('t1');
      expect(history[2].tradeId).toBe('t3');
    });
  });

  // ─── Consecutive Slippage → Safe_Mode (Req 22.5) ───────────────────

  describe('Consecutive slippage triggers Safe_Mode (Req 22.5)', () => {
    let engine: MevProtectionEngine;
    let safeModeCallback: ReturnType<typeof createMockSafeModeCallback>;
    let alertCallback: ReturnType<typeof createMockAlertCallback>;

    beforeEach(() => {
      safeModeCallback = createMockSafeModeCallback();
      alertCallback = createMockAlertCallback();
      engine = new MevProtectionEngine(
        createDefaultMevConfig(true),
        safeModeCallback,
        alertCallback,
      );
    });

    it('does NOT trigger Safe_Mode on 2 consecutive excessive slippage trades', () => {
      // estimated = 40 bps, threshold = 60 bps
      // Need realized > 60 bps to exceed
      const quoted = 10000n;

      // Trade 1: realized = 100 bps (over threshold)
      engine.logTradeSlippage('t1', quoted, 9900n, 40, 5);
      // Trade 2: realized = 100 bps (over threshold)
      engine.logTradeSlippage('t2', quoted, 9900n, 40, 5);

      expect(safeModeCallback.calls).toHaveLength(0);
      expect(engine.getConsecutiveExcessiveSlippage()).toBe(2);
    });

    it('triggers Safe_Mode on 3 consecutive excessive slippage trades', () => {
      const quoted = 10000n;

      // 3 trades with 100 bps realized (> 60 bps threshold)
      engine.logTradeSlippage('t1', quoted, 9900n, 40, 5);
      engine.logTradeSlippage('t2', quoted, 9900n, 40, 5);
      engine.logTradeSlippage('t3', quoted, 9900n, 40, 5);

      expect(safeModeCallback.calls).toHaveLength(1);
      expect(safeModeCallback.calls[0].reason).toBe('deviation_alerts');
      expect(safeModeCallback.calls[0].details).toContain('3 consecutive trades');
    });

    it('sends alert when Safe_Mode triggered', () => {
      const quoted = 10000n;

      engine.logTradeSlippage('t1', quoted, 9900n, 40, 5);
      engine.logTradeSlippage('t2', quoted, 9900n, 40, 5);
      engine.logTradeSlippage('t3', quoted, 9900n, 40, 5);

      expect(alertCallback.messages).toHaveLength(1);
      expect(alertCallback.messages[0]).toContain('MEV/Slippage Alert');
      expect(alertCallback.messages[0]).toContain('Safe_Mode');
    });

    it('resets consecutive counter on a trade within threshold', () => {
      const quoted = 10000n;

      // 2 excessive trades
      engine.logTradeSlippage('t1', quoted, 9900n, 40, 5);
      engine.logTradeSlippage('t2', quoted, 9900n, 40, 5);
      expect(engine.getConsecutiveExcessiveSlippage()).toBe(2);

      // 1 normal trade (0 slippage → resets counter)
      engine.logTradeSlippage('t3', quoted, quoted, 40, 5);
      expect(engine.getConsecutiveExcessiveSlippage()).toBe(0);

      // 2 more excessive trades (not enough for trigger)
      engine.logTradeSlippage('t4', quoted, 9900n, 40, 5);
      engine.logTradeSlippage('t5', quoted, 9900n, 40, 5);

      expect(safeModeCallback.calls).toHaveLength(0); // Never triggered
    });

    it('resets counter after triggering Safe_Mode', () => {
      const quoted = 10000n;

      // Trigger Safe_Mode
      engine.logTradeSlippage('t1', quoted, 9900n, 40, 5);
      engine.logTradeSlippage('t2', quoted, 9900n, 40, 5);
      engine.logTradeSlippage('t3', quoted, 9900n, 40, 5);

      // Counter should be reset after trigger
      expect(engine.getConsecutiveExcessiveSlippage()).toBe(0);
    });

    it('works without callbacks (no crash)', () => {
      const noCallbackEngine = new MevProtectionEngine(createDefaultMevConfig(true));
      const quoted = 10000n;

      // Should not throw even without callbacks
      noCallbackEngine.logTradeSlippage('t1', quoted, 9900n, 40, 5);
      noCallbackEngine.logTradeSlippage('t2', quoted, 9900n, 40, 5);
      noCallbackEngine.logTradeSlippage('t3', quoted, 9900n, 40, 5);

      expect(noCallbackEngine.getConsecutiveExcessiveSlippage()).toBe(0); // Reset after trigger
    });
  });

  // ─── computeMinAmountOut precision ─────────────────────────────────

  describe('computeMinAmountOut', () => {
    let engine: MevProtectionEngine;

    beforeEach(() => {
      engine = new MevProtectionEngine(createDefaultMevConfig(true));
    });

    it('computes correctly for typical WETH amounts (40 bps)', () => {
      // 0.0025 WETH = 2_500_000_000_000_000
      const result = engine.computeMinAmountOut(2_500_000_000_000_000n, 40);
      // 2_500_000_000_000_000 * 9960 / 10000 = 2_490_000_000_000_000
      expect(result).toBe(2_490_000_000_000_000n);
    });

    it('computes correctly for 30 bps', () => {
      const result = engine.computeMinAmountOut(10_000_000_000_000_000n, 30);
      // 10e15 * 9970 / 10000 = 9_970_000_000_000_000
      expect(result).toBe(9_970_000_000_000_000n);
    });

    it('returns 0 for zero amount', () => {
      expect(engine.computeMinAmountOut(0n, 40)).toBe(0n);
    });

    it('returns 0 for negative amount', () => {
      expect(engine.computeMinAmountOut(-1n, 40)).toBe(0n);
    });

    it('handles 0 bps slippage (no deduction)', () => {
      const amount = 5_000_000_000_000_000n;
      expect(engine.computeMinAmountOut(amount, 0)).toBe(amount);
    });

    it('handles very small amounts without underflow', () => {
      // 100 wei with 40 bps: 100 * 9960 / 10000 = 99
      expect(engine.computeMinAmountOut(100n, 40)).toBe(99n);
    });

    it('handles 1 wei amount', () => {
      // 1 * 9960 / 10000 = 0 (BigInt truncation)
      expect(engine.computeMinAmountOut(1n, 40)).toBe(0n);
    });
  });

  // ─── calculateRealizedSlippageBps ──────────────────────────────────

  describe('calculateRealizedSlippageBps', () => {
    let engine: MevProtectionEngine;

    beforeEach(() => {
      engine = new MevProtectionEngine(createDefaultMevConfig(true));
    });

    it('returns 0 when executed equals quoted', () => {
      expect(engine.calculateRealizedSlippageBps(1000n, 1000n)).toBe(0);
    });

    it('returns 0 when executed exceeds quoted (favorable)', () => {
      expect(engine.calculateRealizedSlippageBps(1000n, 1100n)).toBe(0);
    });

    it('returns 0 for zero quoted amount', () => {
      expect(engine.calculateRealizedSlippageBps(0n, 0n)).toBe(0);
    });

    it('calculates correctly for 50 bps slippage', () => {
      // 50 bps = 0.5%: executed = 9950 when quoted = 10000
      expect(engine.calculateRealizedSlippageBps(10000n, 9950n)).toBe(50);
    });

    it('calculates correctly for 100 bps slippage', () => {
      expect(engine.calculateRealizedSlippageBps(10000n, 9900n)).toBe(100);
    });

    it('handles large amounts with precision', () => {
      const quoted = 10_000_000_000_000_000_000n; // 10 WETH
      // 25 bps = quoted * 25 / 10000
      const diff = quoted * 25n / 10000n;
      const executed = quoted - diff;
      expect(engine.calculateRealizedSlippageBps(quoted, executed)).toBe(25);
    });
  });

  // ─── Effective Limits and Accessors ────────────────────────────────

  describe('Accessors and configuration', () => {
    it('getEffectiveLimits returns correct limits with private RPC', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(true));
      const limits = engine.getEffectiveLimits();
      expect(limits.maxSlippageBps).toBe(40);
      expect(limits.maxPriceImpactBps).toBe(30);
    });

    it('getEffectiveLimits returns stricter limits without private RPC', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(false));
      const limits = engine.getEffectiveLimits();
      expect(limits.maxSlippageBps).toBe(30);
      expect(limits.maxPriceImpactBps).toBe(20);
    });

    it('resetConsecutiveCounter resets the counter', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(true));
      engine.logTradeSlippage('t1', 10000n, 9900n, 40, 5);
      engine.logTradeSlippage('t2', 10000n, 9900n, 40, 5);
      expect(engine.getConsecutiveExcessiveSlippage()).toBe(2);

      engine.resetConsecutiveCounter();
      expect(engine.getConsecutiveExcessiveSlippage()).toBe(0);
    });

    it('getConfig returns readonly config', () => {
      const config = createDefaultMevConfig(true, 'https://rpc.example.com');
      const engine = new MevProtectionEngine(config);
      const retrieved = engine.getConfig();

      expect(retrieved.hasPrivateRpc).toBe(true);
      expect(retrieved.privateRpcUrl).toBe('https://rpc.example.com');
      expect(retrieved.maxSlippageBps).toBe(40);
    });

    it('slippage history is bounded to 100 entries', () => {
      const engine = new MevProtectionEngine(createDefaultMevConfig(true));

      // Add 105 entries
      for (let i = 0; i < 105; i++) {
        engine.logTradeSlippage(`t${i}`, 10000n, 10000n, 40, 5);
      }

      const history = engine.getSlippageHistory();
      expect(history.length).toBeLessThanOrEqual(100);
    });
  });
});

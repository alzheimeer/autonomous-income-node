/**
 * Unit tests for ExitManager
 *
 * Tests deterministic exit logic: SL, TP, time-stop, regime-exit, KillSwitch, operator, Safe_Mode.
 * Validates priority ordering, MFE/MAE tracking, retry logic, and position lifecycle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ExitManager } from '../../exit-manager.js';
import type {
  ExternalStateProvider,
  ExitLogger,
  GetQuoteCallback,
  SimulateExitCallback,
  ExecuteExitCallback,
} from '../../exit-manager.js';
import type { Position, ExitReason, RegimeType } from '../../types.js';
import type { ExitManagerConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createConfig(overrides?: Partial<ExitManagerConfig>): ExitManagerConfig {
  return {
    stopLossAtr: 1.5,
    takeProfitAtr: 2.0,
    maxHoldingMs: 28_800_000, // 8h
    safetyExitMaxGas: 100000n, // $0.10
    maxExitRetries: 2,
    ...overrides,
  };
}

function createExternalState(overrides?: Partial<ExternalStateProvider>): ExternalStateProvider {
  return {
    isKillSwitchTriggered: () => false,
    isSafeModeActive: () => false,
    isOperatorExitRequested: () => false,
    ...overrides,
  };
}

function createPosition(overrides?: Partial<Position>): Position {
  return {
    id: 'pos-001',
    intentId: 'intent-001',
    entryPrice: 2000,
    entryTimestamp: 1_700_000_000_000,
    sizeUsdc: 5_000000n,
    sizeWeth: 2_500_000_000_000_000n, // 0.0025 WETH
    stopLoss: 1970,        // ~1.5% below entry
    takeProfit: 2040,      // ~2.0% above entry
    maxHoldingMs: 28_800_000, // 8h
    entryRegime: 'TRENDING_UP' as RegimeType,
    strategy: 'trend_pullback' as const,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('ExitManager', () => {
  let config: ExitManagerConfig;
  let externalState: ExternalStateProvider;
  let logs: Array<Record<string, unknown>>;
  let logger: ExitLogger;

  beforeEach(() => {
    config = createConfig();
    externalState = createExternalState();
    logs = [];
    logger = (entry) => { logs.push(entry); };
  });

  describe('registerPosition', () => {
    it('should register a position and set state to monitoring', () => {
      const em = new ExitManager(config, externalState, { logger });
      const position = createPosition();

      em.registerPosition(position);

      const tracked = em.getTrackedPosition();
      expect(tracked).not.toBeNull();
      expect(tracked!.state).toBe('monitoring');
      expect(tracked!.position.id).toBe('pos-001');
      expect(tracked!.mfe).toBe(0);
      expect(tracked!.mae).toBe(0);
      expect(tracked!.highPrice).toBe(2000);
      expect(tracked!.lowPrice).toBe(2000);
    });

    it('should throw if registering while another position is active', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition());

      expect(() => em.registerPosition(createPosition({ id: 'pos-002' }))).toThrow(
        'Cannot register position: existing position pos-001 is still active'
      );
    });

    it('should allow registering after previous position is closed', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition());
      em.closePosition(2020, 1_700_001_000_000, 'take_profit', 100000n, 80000n);

      // Should not throw
      em.registerPosition(createPosition({ id: 'pos-002' }));
      expect(em.getTrackedPosition()!.position.id).toBe('pos-002');
    });

    it('should log position registration', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition());

      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        event: 'position_registered',
        positionId: 'pos-001',
        price: 2000,
      });
    });
  });

  describe('checkExits - Stop Loss', () => {
    it('should trigger stop_loss when price <= SL level', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ stopLoss: 1970 }));

      const signal = em.checkExits(1970, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('stop_loss');
      expect(signal!.currentPrice).toBe(1970);
    });

    it('should trigger stop_loss when price below SL level', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ stopLoss: 1970 }));

      const signal = em.checkExits(1960, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('stop_loss');
    });

    it('should not trigger stop_loss when price above SL level', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ stopLoss: 1970 }));

      const signal = em.checkExits(1971, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).toBeNull();
    });
  });

  describe('checkExits - Take Profit', () => {
    it('should trigger take_profit when price >= TP level', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ takeProfit: 2040 }));

      const signal = em.checkExits(2040, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('take_profit');
    });

    it('should trigger take_profit when price above TP level', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ takeProfit: 2040 }));

      const signal = em.checkExits(2050, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('take_profit');
    });

    it('should not trigger take_profit when price below TP level', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ takeProfit: 2040 }));

      const signal = em.checkExits(2039, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).toBeNull();
    });
  });

  describe('checkExits - Time Stop', () => {
    it('should trigger time_stop when holding exceeds maxHoldingMs', () => {
      const em = new ExitManager(config, externalState, { logger });
      const entryTs = 1_700_000_000_000;
      em.registerPosition(createPosition({ entryTimestamp: entryTs, maxHoldingMs: 28_800_000 }));

      // 8h later
      const signal = em.checkExits(2010, 'TRENDING_UP', entryTs + 28_800_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('time_stop');
    });

    it('should not trigger time_stop before max holding time', () => {
      const em = new ExitManager(config, externalState, { logger });
      const entryTs = 1_700_000_000_000;
      em.registerPosition(createPosition({ entryTimestamp: entryTs, maxHoldingMs: 28_800_000 }));

      // 7h 59m later
      const signal = em.checkExits(2010, 'TRENDING_UP', entryTs + 28_799_999);
      expect(signal).toBeNull();
    });
  });

  describe('checkExits - Regime Exit', () => {
    it('should trigger regime_exit for trend_pullback on TRENDING_DOWN', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ strategy: 'trend_pullback', entryRegime: 'TRENDING_UP' }));

      const signal = em.checkExits(2010, 'TRENDING_DOWN', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('regime_exit');
    });

    it('should trigger regime_exit for trend_pullback on VOLATILE', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ strategy: 'trend_pullback', entryRegime: 'TRENDING_UP' }));

      const signal = em.checkExits(2010, 'VOLATILE', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('regime_exit');
    });

    it('should trigger regime_exit for trend_pullback on UNCERTAIN', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ strategy: 'trend_pullback', entryRegime: 'TRENDING_UP' }));

      const signal = em.checkExits(2010, 'UNCERTAIN', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('regime_exit');
    });

    it('should NOT trigger regime_exit for trend_pullback on RANGING', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ strategy: 'trend_pullback', entryRegime: 'TRENDING_UP' }));

      const signal = em.checkExits(2010, 'RANGING', 1_700_000_100_000);
      expect(signal).toBeNull();
    });

    it('should trigger regime_exit for mean_reversion on VOLATILE', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ strategy: 'mean_reversion', entryRegime: 'RANGING' }));

      const signal = em.checkExits(2010, 'VOLATILE', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('regime_exit');
    });

    it('should trigger regime_exit for mean_reversion on UNCERTAIN', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ strategy: 'mean_reversion', entryRegime: 'RANGING' }));

      const signal = em.checkExits(2010, 'UNCERTAIN', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('regime_exit');
    });

    it('should trigger regime_exit for mean_reversion on TRENDING_DOWN', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ strategy: 'mean_reversion', entryRegime: 'RANGING' }));

      const signal = em.checkExits(2010, 'TRENDING_DOWN', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('regime_exit');
    });

    it('should NOT trigger regime_exit for mean_reversion on TRENDING_UP', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ strategy: 'mean_reversion', entryRegime: 'RANGING' }));

      const signal = em.checkExits(2010, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).toBeNull();
    });
  });

  describe('checkExits - KillSwitch, Safe_Mode, Operator', () => {
    it('should trigger kill_switch when KillSwitch is active', () => {
      const state = createExternalState({ isKillSwitchTriggered: () => true });
      const em = new ExitManager(config, state, { logger });
      em.registerPosition(createPosition());

      const signal = em.checkExits(2010, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('kill_switch');
    });

    it('should trigger safe_mode when Safe_Mode is active', () => {
      const state = createExternalState({ isSafeModeActive: () => true });
      const em = new ExitManager(config, state, { logger });
      em.registerPosition(createPosition());

      const signal = em.checkExits(2010, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('safe_mode');
    });

    it('should trigger operator exit when requested', () => {
      const state = createExternalState({ isOperatorExitRequested: () => true });
      const em = new ExitManager(config, state, { logger });
      em.registerPosition(createPosition());

      const signal = em.checkExits(2010, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).not.toBeNull();
      expect(signal!.reason).toBe('operator');
    });
  });

  describe('checkExits - Priority Ordering', () => {
    it('KillSwitch should have highest priority over stop_loss', () => {
      const state = createExternalState({ isKillSwitchTriggered: () => true });
      const em = new ExitManager(config, state, { logger });
      // Price also below stop loss
      em.registerPosition(createPosition({ stopLoss: 2010 }));

      const signal = em.checkExits(2000, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal!.reason).toBe('kill_switch');
    });

    it('Safe_Mode should take priority over stop_loss', () => {
      const state = createExternalState({ isSafeModeActive: () => true });
      const em = new ExitManager(config, state, { logger });
      em.registerPosition(createPosition({ stopLoss: 2010 }));

      const signal = em.checkExits(2000, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal!.reason).toBe('safe_mode');
    });

    it('stop_loss should take priority over time_stop', () => {
      const em = new ExitManager(config, externalState, { logger });
      const entryTs = 1_700_000_000_000;
      em.registerPosition(createPosition({ stopLoss: 1970, entryTimestamp: entryTs, maxHoldingMs: 28_800_000 }));

      // Both SL and time_stop triggered
      const signal = em.checkExits(1960, 'TRENDING_UP', entryTs + 28_800_000);
      expect(signal!.reason).toBe('stop_loss');
    });

    it('time_stop should take priority over regime_exit', () => {
      const em = new ExitManager(config, externalState, { logger });
      const entryTs = 1_700_000_000_000;
      em.registerPosition(createPosition({
        strategy: 'trend_pullback',
        entryRegime: 'TRENDING_UP',
        entryTimestamp: entryTs,
        maxHoldingMs: 28_800_000,
      }));

      // Both time_stop and regime_exit triggered (TRENDING_DOWN), but price is fine
      const signal = em.checkExits(2010, 'TRENDING_DOWN', entryTs + 28_800_000);
      expect(signal!.reason).toBe('time_stop');
    });

    it('regime_exit should take priority over take_profit', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({
        strategy: 'trend_pullback',
        entryRegime: 'TRENDING_UP',
        takeProfit: 2040,
      }));

      // Both regime_exit (VOLATILE) and take_profit (price >= 2040) triggered
      const signal = em.checkExits(2050, 'VOLATILE', 1_700_000_100_000);
      expect(signal!.reason).toBe('regime_exit');
    });
  });

  describe('checkExits - No Position / Closed / Pending', () => {
    it('should return null when no position registered', () => {
      const em = new ExitManager(config, externalState, { logger });
      const signal = em.checkExits(2000, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal).toBeNull();
    });

    it('should return null when position is closed', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition());
      em.closePosition(2020, 1_700_001_000_000, 'take_profit', 100000n, 80000n);

      const signal = em.checkExits(1950, 'TRENDING_UP', 1_700_002_000_000);
      expect(signal).toBeNull();
    });

    it('should return null when exit is already pending', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ stopLoss: 1970 }));

      // First call triggers exit
      const signal1 = em.checkExits(1960, 'TRENDING_UP', 1_700_000_100_000);
      expect(signal1).not.toBeNull();
      expect(signal1!.reason).toBe('stop_loss');

      // Second call should return null (exit_pending)
      const signal2 = em.checkExits(1950, 'TRENDING_UP', 1_700_000_200_000);
      expect(signal2).toBeNull();
    });
  });

  describe('MFE/MAE Tracking', () => {
    it('should track MFE as highest % profit above entry', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ entryPrice: 2000 }));

      em.onPriceUpdate(2020); // +1%
      em.onPriceUpdate(2050); // +2.5%
      em.onPriceUpdate(2030); // +1.5% (pullback)

      const tracked = em.getTrackedPosition();
      expect(tracked!.mfe).toBe(2.5); // highest was 2050 → (2050-2000)/2000*100 = 2.5%
    });

    it('should track MAE as deepest % drawdown below entry', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ entryPrice: 2000 }));

      em.onPriceUpdate(1980); // -1%
      em.onPriceUpdate(1960); // -2%
      em.onPriceUpdate(1990); // -0.5% (recovery)

      const tracked = em.getTrackedPosition();
      expect(tracked!.mae).toBe(2); // deepest was 1960 → (2000-1960)/2000*100 = 2%
    });

    it('should track both MFE and MAE independently', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ entryPrice: 2000 }));

      em.onPriceUpdate(2040); // +2% (MFE candidate)
      em.onPriceUpdate(1950); // -2.5% (MAE candidate)
      em.onPriceUpdate(2020); // +1% (recovery)

      const tracked = em.getTrackedPosition();
      expect(tracked!.mfe).toBe(2);   // (2040-2000)/2000*100
      expect(tracked!.mae).toBe(2.5); // (2000-1950)/2000*100
    });

    it('should start MFE/MAE at 0 at entry', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ entryPrice: 2000 }));

      const tracked = em.getTrackedPosition();
      expect(tracked!.mfe).toBe(0);
      expect(tracked!.mae).toBe(0);
    });

    it('should update MFE/MAE during checkExits', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ entryPrice: 2000, takeProfit: 3000, stopLoss: 1500 }));

      // Price goes up — no exit triggered but MFE updated
      em.checkExits(2100, 'TRENDING_UP', 1_700_000_100_000);

      const tracked = em.getTrackedPosition();
      expect(tracked!.mfe).toBe(5); // (2100-2000)/2000*100
    });

    it('should not update MFE/MAE on closed position', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ entryPrice: 2000 }));
      em.closePosition(2020, 1_700_001_000_000, 'take_profit', 100000n, 80000n);

      em.onPriceUpdate(2100); // should be ignored

      // getTrackedPosition returns closed state with final MFE/MAE
      const tracked = em.getTrackedPosition();
      expect(tracked!.mfe).toBe(0); // was never updated above entry
    });
  });

  describe('getOpenPosition', () => {
    it('should return null when no position', () => {
      const em = new ExitManager(config, externalState, { logger });
      expect(em.getOpenPosition()).toBeNull();
    });

    it('should return position with MFE/MAE when open', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ entryPrice: 2000 }));
      em.onPriceUpdate(2050);

      const pos = em.getOpenPosition();
      expect(pos).not.toBeNull();
      expect(pos!.mfe).toBe(2.5);
    });

    it('should return null when position is closed', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition());
      em.closePosition(2020, 1_700_001_000_000, 'take_profit', 100000n, 80000n);

      expect(em.getOpenPosition()).toBeNull();
    });
  });

  describe('isExitPending', () => {
    it('should return false when no position', () => {
      const em = new ExitManager(config, externalState, { logger });
      expect(em.isExitPending()).toBe(false);
    });

    it('should return false when monitoring', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition());
      expect(em.isExitPending()).toBe(false);
    });

    it('should return true after exit triggered', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ stopLoss: 1970 }));
      em.checkExits(1960, 'TRENDING_UP', 1_700_000_100_000);
      expect(em.isExitPending()).toBe(true);
    });
  });

  describe('executeExit', () => {
    it('should succeed on first attempt with valid callbacks', async () => {
      const getQuote: GetQuoteCallback = vi.fn().mockResolvedValue({ priceUsd: 2000, gasUsd: 0.05 });
      const simulateExit: SimulateExitCallback = vi.fn().mockResolvedValue({ success: true });
      const executeExit: ExecuteExitCallback = vi.fn().mockResolvedValue({ success: true, txHash: '0xabc' });

      const em = new ExitManager(config, externalState, { logger, getQuote, simulateExit, executeExit });
      em.registerPosition(createPosition());

      const result = await em.executeExit('stop_loss', 1960, 1_700_000_100_000);
      expect(result.success).toBe(true);
      expect(getQuote).toHaveBeenCalledTimes(1);
      expect(simulateExit).toHaveBeenCalledTimes(1);
      expect(executeExit).toHaveBeenCalledTimes(1);
    });

    it('should retry on execution failure up to maxExitRetries', async () => {
      const getQuote: GetQuoteCallback = vi.fn().mockResolvedValue({ priceUsd: 2000, gasUsd: 0.05 });
      const simulateExit: SimulateExitCallback = vi.fn().mockResolvedValue({ success: true });
      const executeExit: ExecuteExitCallback = vi.fn()
        .mockResolvedValueOnce({ success: false, reason: 'nonce_conflict' })
        .mockResolvedValueOnce({ success: false, reason: 'reverted' })
        .mockResolvedValueOnce({ success: true, txHash: '0xdef' });

      const em = new ExitManager(config, externalState, { logger, getQuote, simulateExit, executeExit });
      em.registerPosition(createPosition());

      const result = await em.executeExit('stop_loss', 1960, 1_700_000_100_000);
      expect(result.success).toBe(true);
      expect(executeExit).toHaveBeenCalledTimes(3); // initial + 2 retries
    });

    it('should fail after maxExitRetries exhausted', async () => {
      const getQuote: GetQuoteCallback = vi.fn().mockResolvedValue({ priceUsd: 2000, gasUsd: 0.05 });
      const simulateExit: SimulateExitCallback = vi.fn().mockResolvedValue({ success: true });
      const executeExit: ExecuteExitCallback = vi.fn()
        .mockResolvedValue({ success: false, reason: 'reverted' });

      const em = new ExitManager(config, externalState, { logger, getQuote, simulateExit, executeExit });
      em.registerPosition(createPosition());

      const result = await em.executeExit('stop_loss', 1960, 1_700_000_100_000);
      expect(result.success).toBe(false);
      expect(result.reason).toContain('retries_exhausted');
      expect(executeExit).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    });

    it('should skip attempt if gas exceeds safety max', async () => {
      const getQuote: GetQuoteCallback = vi.fn()
        .mockResolvedValueOnce({ priceUsd: 2000, gasUsd: 0.15 }) // too high
        .mockResolvedValueOnce({ priceUsd: 2000, gasUsd: 0.15 }) // too high
        .mockResolvedValueOnce({ priceUsd: 2000, gasUsd: 0.15 }); // too high
      const simulateExit: SimulateExitCallback = vi.fn().mockResolvedValue({ success: true });
      const executeExit: ExecuteExitCallback = vi.fn().mockResolvedValue({ success: true });

      const em = new ExitManager(config, externalState, { logger, getQuote, simulateExit, executeExit });
      em.registerPosition(createPosition());

      const result = await em.executeExit('stop_loss', 1960, 1_700_000_100_000);
      expect(result.success).toBe(false);
      // Execute should never be called since gas is too high
      expect(executeExit).not.toHaveBeenCalled();
    });

    it('should skip attempt if simulation fails', async () => {
      const getQuote: GetQuoteCallback = vi.fn().mockResolvedValue({ priceUsd: 2000, gasUsd: 0.05 });
      const simulateExit: SimulateExitCallback = vi.fn()
        .mockResolvedValueOnce({ success: false, reason: 'insufficient_balance' })
        .mockResolvedValueOnce({ success: false, reason: 'insufficient_balance' })
        .mockResolvedValueOnce({ success: true });
      const executeExit: ExecuteExitCallback = vi.fn().mockResolvedValue({ success: true, txHash: '0x123' });

      const em = new ExitManager(config, externalState, { logger, getQuote, simulateExit, executeExit });
      em.registerPosition(createPosition());

      const result = await em.executeExit('stop_loss', 1960, 1_700_000_100_000);
      expect(result.success).toBe(true);
      expect(simulateExit).toHaveBeenCalledTimes(3);
      expect(executeExit).toHaveBeenCalledTimes(1);
    });

    it('should return signal_only when no execute callback (shadow mode)', async () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition());

      const result = await em.executeExit('stop_loss', 1960, 1_700_000_100_000);
      expect(result.success).toBe(true);
      expect(result.reason).toBe('signal_only');
    });

    it('should return failure when no active position', async () => {
      const em = new ExitManager(config, externalState, { logger });
      const result = await em.executeExit('stop_loss', 1960, 1_700_000_100_000);
      expect(result.success).toBe(false);
      expect(result.reason).toBe('no_active_position');
    });
  });

  describe('closePosition', () => {
    it('should mark position as closed with exit details', () => {
      const em = new ExitManager(config, externalState, { logger });
      em.registerPosition(createPosition({ entryPrice: 2000 }));
      em.onPriceUpdate(2050); // set MFE

      em.closePosition(2030, 1_700_001_000_000, 'take_profit', 150000n, 120000n);

      const tracked = em.getTrackedPosition();
      expect(tracked!.state).toBe('closed');
      expect(tracked!.position.exitReason).toBe('take_profit');
      expect(tracked!.position.exitPrice).toBe(2030);
      expect(tracked!.position.exitTimestamp).toBe(1_700_001_000_000);
      expect(tracked!.position.grossPnl).toBe(150000n);
      expect(tracked!.position.netPnl).toBe(120000n);
      expect(tracked!.position.mfe).toBe(2.5); // from MFE tracking
    });

    it('should log position closure with P&L and duration', () => {
      const em = new ExitManager(config, externalState, { logger });
      const entryTs = 1_700_000_000_000;
      em.registerPosition(createPosition({ entryPrice: 2000, entryTimestamp: entryTs }));

      em.closePosition(2030, entryTs + 3_600_000, 'take_profit', 150000n, 120000n);

      const closeLog = logs.find((l) => l.event === 'position_closed');
      expect(closeLog).toBeDefined();
      expect(closeLog!.reason).toBe('take_profit');
      expect(closeLog!.holdingDurationMs).toBe(3_600_000);
      expect(closeLog!.price).toBe(2030);
    });
  });
});

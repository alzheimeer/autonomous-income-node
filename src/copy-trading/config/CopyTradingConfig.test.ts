/**
 * Tests for CopyTradingConfig
 *
 * Verifies:
 * - Default values are applied correctly
 * - Environment variables are parsed correctly
 * - Invalid values fall back to defaults
 * - Validation rules are enforced
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadCopyTradingConfig,
  COPY_TRADING_DEFAULTS,
  type CopyTradingConfig,
} from './CopyTradingConfig.js';

// Mock logger to avoid console output during tests
vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('CopyTradingConfig', () => {
  const BASE_ENV = {
    RPC_PROVIDER_URL: 'https://test-rpc.example.com',
  };

  describe('loadCopyTradingConfig', () => {
    describe('default values', () => {
      it('applies all default values when no env vars are set', () => {
        const config = loadCopyTradingConfig(BASE_ENV);

        // Capital & Sizing
        expect(config.initialCapitalUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
        expect(config.maxPositionUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_POSITION_USDC);
        expect(config.copyRatio).toBe(COPY_TRADING_DEFAULTS.COPY_RATIO);

        // Exit Parameters
        expect(config.takeProfitPct).toBe(COPY_TRADING_DEFAULTS.COPY_TP_PCT);
        expect(config.stopLossPct).toBe(COPY_TRADING_DEFAULTS.COPY_SL_PCT);
        expect(config.trailActivationPct).toBe(COPY_TRADING_DEFAULTS.COPY_TRAIL_ACTIVATION_PCT);
        expect(config.trailDistancePct).toBe(COPY_TRADING_DEFAULTS.COPY_TRAIL_DISTANCE_PCT);
        expect(config.timeStopHours).toBe(COPY_TRADING_DEFAULTS.COPY_TIME_STOP_HOURS);

        // Risk Management
        expect(config.maxLossStreak).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_LOSS_STREAK);
        expect(config.maxGasGwei).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_GAS_GWEI);
        expect(config.maxConcurrentPositions).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_CONCURRENT_POSITIONS);
        expect(config.maxDailyCapitalPct).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_DAILY_CAPITAL_PCT);
        expect(config.circuitBreakerHours).toBe(COPY_TRADING_DEFAULTS.COPY_CIRCUIT_BREAKER_HOURS);
        expect(config.maxDrawdownPct).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_DRAWDOWN_PCT);
        expect(config.minReservePct).toBe(COPY_TRADING_DEFAULTS.COPY_MIN_RESERVE_PCT);

        // RPC & Connectivity
        expect(config.pollingIntervalMs).toBe(COPY_TRADING_DEFAULTS.COPY_POLLING_INTERVAL_MS);
        expect(config.heartbeatIntervalMs).toBe(COPY_TRADING_DEFAULTS.COPY_HEARTBEAT_INTERVAL_MS);
        expect(config.reconnectTimeoutMs).toBe(COPY_TRADING_DEFAULTS.COPY_RECONNECT_TIMEOUT_MS);

        // Validation Thresholds
        expect(config.minLiquidityUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_MIN_LIQUIDITY_USDC);
        expect(config.minLiquidityWeth).toBe(COPY_TRADING_DEFAULTS.COPY_MIN_LIQUIDITY_WETH);
        expect(config.maxSlippagePct).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_SLIPPAGE_PCT);
        expect(config.maxTaxPct).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_TAX_PCT);
        expect(config.minLpLockPct).toBe(COPY_TRADING_DEFAULTS.COPY_MIN_LP_LOCK_PCT);

        // Anti-Baiting
        expect(config.maxVolumeFootprintPct).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_VOLUME_FOOTPRINT_PCT);
        expect(config.executionDelayMinMs).toBe(COPY_TRADING_DEFAULTS.COPY_EXECUTION_DELAY_MIN_MS);
        expect(config.executionDelayMaxMs).toBe(COPY_TRADING_DEFAULTS.COPY_EXECUTION_DELAY_MAX_MS);
        expect(config.maxBaitFlags).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_BAIT_FLAGS);
        expect(config.baitFlagWindowDays).toBe(COPY_TRADING_DEFAULTS.COPY_BAIT_FLAG_WINDOW_DAYS);
      });
    });

    describe('RPC URL handling', () => {
      it('uses COPY_WS_RPC_URL when provided', () => {
        const env = {
          ...BASE_ENV,
          COPY_WS_RPC_URL: 'wss://copy-specific-rpc.example.com',
        };
        const config = loadCopyTradingConfig(env);
        expect(config.wsRpcUrl).toBe('wss://copy-specific-rpc.example.com');
      });

      it('falls back to RPC_PROVIDER_URL when COPY_WS_RPC_URL is not set', () => {
        const config = loadCopyTradingConfig(BASE_ENV);
        expect(config.wsRpcUrl).toBe('https://test-rpc.example.com');
      });

      it('throws when neither COPY_WS_RPC_URL nor RPC_PROVIDER_URL is set', () => {
        expect(() => loadCopyTradingConfig({})).toThrow(
          'COPY_WS_RPC_URL or RPC_PROVIDER_URL is required',
        );
      });

      it('sets httpRpcUrl when COPY_HTTP_RPC_URL is provided', () => {
        const env = {
          ...BASE_ENV,
          COPY_HTTP_RPC_URL: 'https://http-fallback.example.com',
        };
        const config = loadCopyTradingConfig(env);
        expect(config.httpRpcUrl).toBe('https://http-fallback.example.com');
      });

      it('sets httpRpcUrl to null when not provided', () => {
        const config = loadCopyTradingConfig(BASE_ENV);
        expect(config.httpRpcUrl).toBeNull();
      });
    });

    describe('environment variable parsing', () => {
      it('parses numeric environment variables correctly', () => {
        const env = {
          ...BASE_ENV,
          COPY_INITIAL_CAPITAL_USDC: '1000',
          COPY_MAX_POSITION_USDC: '200',
          COPY_RATIO: '0.15',
          COPY_TP_PCT: '75',
          COPY_SL_PCT: '15',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.initialCapitalUsdc).toBe(1000);
        expect(config.maxPositionUsdc).toBe(200);
        expect(config.copyRatio).toBe(0.15);
        expect(config.takeProfitPct).toBe(75);
        expect(config.stopLossPct).toBe(15);
      });

      it('handles decimal numbers correctly', () => {
        const env = {
          ...BASE_ENV,
          COPY_MIN_LIQUIDITY_WETH: '3.5',
          COPY_RATIO: '0.05',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.minLiquidityWeth).toBe(3.5);
        expect(config.copyRatio).toBe(0.05);
      });
    });

    describe('invalid value handling', () => {
      it('uses default for non-numeric values', () => {
        const env = {
          ...BASE_ENV,
          COPY_INITIAL_CAPITAL_USDC: 'invalid',
          COPY_TP_PCT: 'not-a-number',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.initialCapitalUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
        expect(config.takeProfitPct).toBe(COPY_TRADING_DEFAULTS.COPY_TP_PCT);
      });

      it('uses default for empty string values', () => {
        const env = {
          ...BASE_ENV,
          COPY_INITIAL_CAPITAL_USDC: '',
          COPY_MAX_POSITION_USDC: '   ',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.initialCapitalUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
        expect(config.maxPositionUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_POSITION_USDC);
      });

      it('uses default for negative values where positive required', () => {
        const env = {
          ...BASE_ENV,
          COPY_INITIAL_CAPITAL_USDC: '-100',
          COPY_MAX_GAS_GWEI: '-50',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.initialCapitalUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
        expect(config.maxGasGwei).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_GAS_GWEI);
      });

      it('uses default for percentages out of range', () => {
        const env = {
          ...BASE_ENV,
          COPY_TP_PCT: '150', // > 100
          COPY_SL_PCT: '-5',  // < 0
        };
        const config = loadCopyTradingConfig(env);

        expect(config.takeProfitPct).toBe(COPY_TRADING_DEFAULTS.COPY_TP_PCT);
        expect(config.stopLossPct).toBe(COPY_TRADING_DEFAULTS.COPY_SL_PCT);
      });

      it('uses default for ratio out of range', () => {
        const env = {
          ...BASE_ENV,
          COPY_RATIO: '1.5', // > 1
        };
        const config = loadCopyTradingConfig(env);

        expect(config.copyRatio).toBe(COPY_TRADING_DEFAULTS.COPY_RATIO);
      });

      it('rounds non-integer values for integer fields', () => {
        const env = {
          ...BASE_ENV,
          COPY_MAX_LOSS_STREAK: '3.7',
          COPY_MAX_BAIT_FLAGS: '2.2',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.maxLossStreak).toBe(4); // rounded from 3.7
        expect(config.maxBaitFlags).toBe(2);  // rounded from 2.2
      });
    });

    describe('validation rules', () => {
      it('adjusts executionDelayMaxMs when min >= max', () => {
        const env = {
          ...BASE_ENV,
          COPY_EXECUTION_DELAY_MIN_MS: '30000',
          COPY_EXECUTION_DELAY_MAX_MS: '20000',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.executionDelayMinMs).toBe(30000);
        expect(config.executionDelayMaxMs).toBe(31000); // adjusted to min + 1000
      });

      it('caps maxPositionUsdc to initialCapitalUsdc', () => {
        const env = {
          ...BASE_ENV,
          COPY_INITIAL_CAPITAL_USDC: '100',
          COPY_MAX_POSITION_USDC: '500',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.initialCapitalUsdc).toBe(100);
        expect(config.maxPositionUsdc).toBe(100); // capped to initialCapitalUsdc
      });
    });

    describe('requirement compliance', () => {
      it('Req 10.1: reads initial capital from COPY_INITIAL_CAPITAL_USDC with default 500', () => {
        // Default
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.initialCapitalUsdc).toBe(500);

        // Custom
        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_INITIAL_CAPITAL_USDC: '2000' });
        expect(config.initialCapitalUsdc).toBe(2000);
      });

      it('Req 10.2: reads max position size from COPY_MAX_POSITION_USDC with default 100', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.maxPositionUsdc).toBe(100);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_MAX_POSITION_USDC: '50' });
        expect(config.maxPositionUsdc).toBe(50);
      });

      it('Req 10.3: reads copy ratio from COPY_RATIO with default 0.10', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.copyRatio).toBe(0.10);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_RATIO: '0.25' });
        expect(config.copyRatio).toBe(0.25);
      });

      it('Req 10.4: reads take profit from COPY_TP_PCT with default 50', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.takeProfitPct).toBe(50);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_TP_PCT: '75' });
        expect(config.takeProfitPct).toBe(75);
      });

      it('Req 10.5: reads stop loss from COPY_SL_PCT with default 20', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.stopLossPct).toBe(20);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_SL_PCT: '10' });
        expect(config.stopLossPct).toBe(10);
      });

      it('Req 10.6: reads trail activation from COPY_TRAIL_ACTIVATION_PCT with default 10', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.trailActivationPct).toBe(10);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_TRAIL_ACTIVATION_PCT: '15' });
        expect(config.trailActivationPct).toBe(15);
      });

      it('Req 10.7: reads trail distance from COPY_TRAIL_DISTANCE_PCT with default 10', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.trailDistancePct).toBe(10);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_TRAIL_DISTANCE_PCT: '5' });
        expect(config.trailDistancePct).toBe(5);
      });

      it('Req 10.8: reads time stop from COPY_TIME_STOP_HOURS with default 48', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.timeStopHours).toBe(48);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_TIME_STOP_HOURS: '24' });
        expect(config.timeStopHours).toBe(24);
      });

      it('Req 10.9: reads max gas from COPY_MAX_GAS_GWEI with default 50', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.maxGasGwei).toBe(50);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_MAX_GAS_GWEI: '100' });
        expect(config.maxGasGwei).toBe(100);
      });

      it('Req 10.10: reads RPC WebSocket URL from COPY_WS_RPC_URL', () => {
        const config = loadCopyTradingConfig({
          COPY_WS_RPC_URL: 'wss://custom-ws.example.com',
        });
        expect(config.wsRpcUrl).toBe('wss://custom-ws.example.com');
      });

      it('Req 10.11: reads circuit breaker loss streak from COPY_MAX_LOSS_STREAK with default 3', () => {
        let config = loadCopyTradingConfig(BASE_ENV);
        expect(config.maxLossStreak).toBe(3);

        config = loadCopyTradingConfig({ ...BASE_ENV, COPY_MAX_LOSS_STREAK: '5' });
        expect(config.maxLossStreak).toBe(5);
      });

      it('Req 10.12: validates all numeric environment variables and uses defaults for invalid', () => {
        const env = {
          ...BASE_ENV,
          COPY_INITIAL_CAPITAL_USDC: 'not-a-number',
          COPY_MAX_POSITION_USDC: 'invalid',
          COPY_RATIO: 'bad',
        };
        const config = loadCopyTradingConfig(env);

        expect(config.initialCapitalUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_INITIAL_CAPITAL_USDC);
        expect(config.maxPositionUsdc).toBe(COPY_TRADING_DEFAULTS.COPY_MAX_POSITION_USDC);
        expect(config.copyRatio).toBe(COPY_TRADING_DEFAULTS.COPY_RATIO);
      });

      // Req 10.13 (logging) is tested implicitly by not throwing
    });
  });
});

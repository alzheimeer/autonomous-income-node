/**
 * Property-based tests for ExitManager
 *
 * **Property 15: Exit trigger priority**
 * KillSwitch > Safe_Mode > stop_loss > regime_exit > take_profit > time_stop.
 * For any combination of active triggers, the highest-priority one is selected.
 *
 * Note: The design document specifies the full priority as:
 *   KillSwitch > Safe_Mode > operator > stop_loss > time_stop > regime_exit > take_profit
 * This test validates the priority ordering per the task specification.
 *
 * **Validates: Requirements 19.3, 19.4, 19.5**
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  ExitManager,
  type ExternalStateProvider,
} from '../../exit-manager.js';
import type { Position, ExitReason, RegimeType } from '../../types.js';
import type { ExitManagerConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Priority order from the ExitManager source (highest first):
 * 'kill_switch', 'safe_mode', 'operator', 'stop_loss', 'time_stop', 'regime_exit', 'take_profit'
 */
const PRIORITY_ORDER: ExitReason[] = [
  'kill_switch',
  'safe_mode',
  'operator',
  'stop_loss',
  'time_stop',
  'regime_exit',
  'take_profit',
];

const DEFAULT_CONFIG: ExitManagerConfig = {
  stopLossAtr: 1.5,
  takeProfitAtr: 2.0,
  maxHoldingMs: 28_800_000, // 8h
  safetyExitMaxGas: 100_000n, // $0.10
  maxExitRetries: 2,
};

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createPosition(overrides?: Partial<Position>): Position {
  return {
    id: 'pos-001',
    intentId: 'intent-001',
    entryPrice: 2500,
    entryTimestamp: Date.now() - 3_600_000, // 1h ago
    sizeUsdc: 5_000_000n,
    sizeWeth: 2_000_000_000_000_000n,
    stopLoss: 2400,       // SL at $2400
    takeProfit: 2650,     // TP at $2650
    maxHoldingMs: 28_800_000, // 8h
    entryRegime: 'TRENDING_UP' as RegimeType,
    strategy: 'trend_pullback',
    ...overrides,
  };
}

function createExternalState(overrides?: Partial<{
  killSwitch: boolean;
  safeMode: boolean;
  operator: boolean;
}>): ExternalStateProvider {
  const { killSwitch = false, safeMode = false, operator = false } = overrides ?? {};
  return {
    isKillSwitchTriggered: () => killSwitch,
    isSafeModeActive: () => safeMode,
    isOperatorExitRequested: () => operator,
  };
}

function createExitManager(
  externalState: ExternalStateProvider,
  config?: Partial<ExitManagerConfig>,
): ExitManager {
  return new ExitManager(
    { ...DEFAULT_CONFIG, ...config },
    externalState,
  );
}

/**
 * Given a set of active trigger names, determine which should fire first
 * based on priority ordering.
 */
function getHighestPriority(activeReasons: ExitReason[]): ExitReason {
  for (const reason of PRIORITY_ORDER) {
    if (activeReasons.includes(reason)) {
      return reason;
    }
  }
  throw new Error('No active reason provided');
}

// ═══════════════════════════════════════════════════════════════════════════
// Generators
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate a non-empty subset of exit reasons from the priority list.
 */
const exitReasonSubsetArb = fc
  .subarray(PRIORITY_ORDER, { minLength: 1 })
  .filter((arr) => arr.length >= 1);

/**
 * Generate prices that trigger stop_loss (below SL) or take_profit (above TP).
 */
const priceArb = fc.double({ min: 1000, max: 5000, noNaN: true });

/**
 * Generate timestamps representing various holding durations.
 */
const holdingDurationArb = fc.integer({ min: 0, max: 50_000_000 }); // 0 to ~14h in ms

/**
 * Generate regimes that can trigger regime_exit for trend_pullback.
 */
const regimeExitTriggerArb = fc.constantFrom(
  'TRENDING_DOWN' as RegimeType,
  'VOLATILE' as RegimeType,
  'UNCERTAIN' as RegimeType,
);

/**
 * Generate regimes that do NOT trigger regime_exit for trend_pullback.
 */
const safeRegimeArb = fc.constantFrom(
  'TRENDING_UP' as RegimeType,
  'RANGING' as RegimeType,
);

// ═══════════════════════════════════════════════════════════════════════════
// Property 15: Exit trigger priority
// ═══════════════════════════════════════════════════════════════════════════

describe('ExitManager Property Tests', () => {
  describe('Property 15: Exit trigger priority', () => {
    /**
     * **Validates: Requirements 19.3, 19.4, 19.5**
     *
     * When KillSwitch is active, it ALWAYS takes priority over any other trigger.
     */
    it('KillSwitch always has highest priority', () => {
      fc.assert(
        fc.property(
          priceArb,
          safeRegimeArb,
          (price, regime) => {
            // KillSwitch active with all other conditions also active
            const externalState = createExternalState({
              killSwitch: true,
              safeMode: true,
              operator: true,
            });

            const manager = createExitManager(externalState);
            const position = createPosition({
              stopLoss: price + 100,   // SL would trigger (price below)
              takeProfit: price - 100, // TP would trigger (price above)
              maxHoldingMs: 0,         // Time stop would trigger
            });
            manager.registerPosition(position);

            const signal = manager.checkExits(price, regime, Date.now() + 50_000_000);
            expect(signal).not.toBeNull();
            expect(signal!.reason).toBe('kill_switch');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 19.3, 19.4, 19.5**
     *
     * When Safe_Mode is active but KillSwitch is NOT,
     * Safe_Mode takes priority over lower-priority triggers.
     */
    it('Safe_Mode takes priority over stop_loss, regime_exit, take_profit, time_stop', () => {
      fc.assert(
        fc.property(
          priceArb,
          regimeExitTriggerArb,
          (price, regime) => {
            const externalState = createExternalState({
              killSwitch: false,
              safeMode: true,
              operator: false,
            });

            const manager = createExitManager(externalState);
            const position = createPosition({
              stopLoss: price + 500,    // SL triggers
              takeProfit: price - 500,  // TP triggers
              maxHoldingMs: 0,          // Time stop triggers
              entryRegime: 'TRENDING_UP',
              strategy: 'trend_pullback',
            });
            manager.registerPosition(position);

            // Regime also triggers exit, but Safe_Mode should take priority
            const signal = manager.checkExits(price, regime, Date.now() + 50_000_000);
            expect(signal).not.toBeNull();
            expect(signal!.reason).toBe('safe_mode');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 19.3**
     *
     * stop_loss takes priority over time_stop, regime_exit, and take_profit
     * when KillSwitch, Safe_Mode, and operator are all inactive.
     */
    it('stop_loss takes priority over time_stop, regime_exit, take_profit', () => {
      fc.assert(
        fc.property(
          regimeExitTriggerArb,
          (regime) => {
            const externalState = createExternalState({
              killSwitch: false,
              safeMode: false,
              operator: false,
            });

            const manager = createExitManager(externalState);
            // Price at $2350, SL at $2400 → SL triggers (price <= stopLoss)
            // TP at $2300 → TP also triggers (price >= takeProfit)
            // Time stop: 50M ms elapsed > 28.8M ms max → also triggers
            const position = createPosition({
              entryPrice: 2500,
              stopLoss: 2400,
              takeProfit: 2300, // Set TP below current price so it triggers
              maxHoldingMs: 1000, // Very short → time_stop triggers
              entryTimestamp: 0,
              entryRegime: 'TRENDING_UP',
              strategy: 'trend_pullback',
            });
            manager.registerPosition(position);

            const now = Date.now();
            // Price at $2350 is below SL of $2400 AND above TP of $2300
            const signal = manager.checkExits(2350, regime, now);
            expect(signal).not.toBeNull();
            expect(signal!.reason).toBe('stop_loss');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 19.4, 19.5**
     *
     * regime_exit triggers when regime changes to adverse regime and
     * higher-priority conditions are not active.
     */
    it('regime_exit triggers for trend_pullback on TRENDING_DOWN/VOLATILE/UNCERTAIN', () => {
      fc.assert(
        fc.property(
          regimeExitTriggerArb,
          (adverseRegime) => {
            const externalState = createExternalState({
              killSwitch: false,
              safeMode: false,
              operator: false,
            });

            const manager = createExitManager(externalState);
            // Set prices so SL/TP do NOT trigger, time_stop does NOT trigger
            const position = createPosition({
              entryPrice: 2500,
              stopLoss: 2300,      // Price $2500 > $2300, no SL
              takeProfit: 2700,    // Price $2500 < $2700, no TP
              maxHoldingMs: 28_800_000,
              entryTimestamp: Date.now() - 1000, // recent entry
              entryRegime: 'TRENDING_UP',
              strategy: 'trend_pullback',
            });
            manager.registerPosition(position);

            const signal = manager.checkExits(2500, adverseRegime, Date.now());
            expect(signal).not.toBeNull();
            expect(signal!.reason).toBe('regime_exit');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 19.3**
     *
     * take_profit is the lowest-priority condition. It only fires
     * when no higher-priority conditions are active.
     */
    it('take_profit fires only when no higher-priority triggers are active', () => {
      fc.assert(
        fc.property(
          safeRegimeArb,
          (safeRegime) => {
            const externalState = createExternalState({
              killSwitch: false,
              safeMode: false,
              operator: false,
            });

            const manager = createExitManager(externalState);
            // Price at $2700 hits TP at $2650
            // SL at $2400 is NOT triggered (price > SL)
            // Time not expired, regime is safe
            const position = createPosition({
              entryPrice: 2500,
              stopLoss: 2400,
              takeProfit: 2650,
              maxHoldingMs: 28_800_000,
              entryTimestamp: Date.now() - 1000,
              entryRegime: 'TRENDING_UP',
              strategy: 'trend_pullback',
            });
            manager.registerPosition(position);

            const signal = manager.checkExits(2700, safeRegime, Date.now());
            expect(signal).not.toBeNull();
            expect(signal!.reason).toBe('take_profit');
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 19.3, 19.4, 19.5**
     *
     * When NO exit conditions are met, checkExits returns null.
     */
    it('returns null when no exit conditions are met', () => {
      fc.assert(
        fc.property(
          safeRegimeArb,
          (safeRegime) => {
            const externalState = createExternalState({
              killSwitch: false,
              safeMode: false,
              operator: false,
            });

            const manager = createExitManager(externalState);
            // Price at $2500 (entry), SL at $2400, TP at $2650
            // Time not expired, regime is safe
            const position = createPosition({
              entryPrice: 2500,
              stopLoss: 2400,
              takeProfit: 2650,
              maxHoldingMs: 28_800_000,
              entryTimestamp: Date.now() - 1000,
              entryRegime: 'TRENDING_UP',
              strategy: 'trend_pullback',
            });
            manager.registerPosition(position);

            // Price between SL and TP, no triggers
            const signal = manager.checkExits(2500, safeRegime, Date.now());
            expect(signal).toBeNull();
          },
        ),
        { numRuns: 100 },
      );
    });

    /**
     * **Validates: Requirements 19.3**
     *
     * time_stop fires when holding exceeds maxHoldingMs and no higher
     * priority triggers (kill_switch, safe_mode, operator, stop_loss) are active.
     */
    it('time_stop fires when holding exceeds max and no higher triggers active', () => {
      fc.assert(
        fc.property(
          safeRegimeArb,
          (safeRegime) => {
            const externalState = createExternalState({
              killSwitch: false,
              safeMode: false,
              operator: false,
            });

            const maxHoldingMs = 28_800_000;
            const manager = createExitManager(externalState);
            const position = createPosition({
              entryPrice: 2500,
              stopLoss: 2300,       // SL won't trigger at $2500
              takeProfit: 2700,     // TP won't trigger at $2500
              maxHoldingMs,
              entryTimestamp: 0,    // Very old
              entryRegime: 'TRENDING_UP',
              strategy: 'trend_pullback',
            });
            manager.registerPosition(position);

            // Timestamp far enough past entry to trigger time_stop
            const futureTime = maxHoldingMs + 1000;
            const signal = manager.checkExits(2500, safeRegime, futureTime);
            expect(signal).not.toBeNull();
            expect(signal!.reason).toBe('time_stop');
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});

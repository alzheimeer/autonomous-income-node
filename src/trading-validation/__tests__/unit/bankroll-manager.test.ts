/**
 * Unit tests for BankrollManager
 *
 * Tests all bankroll management logic: allocation, loss/profit handling,
 * sweep conditions, low-total formula, daily reset, and trade eligibility.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, E9
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase, type TradingDatabase } from '../../db.js';
import { runMigrations } from '../../migrations.js';
import { BankrollManager } from '../../bankroll-manager.js';
import type { BankrollManagerConfig } from '../../config.js';

// Default config matching spec defaults
function defaultConfig(): BankrollManagerConfig {
  return {
    initialTotal: 99_630000n,
    initialActive: 25_000000n,
    initialReserve: 74_630000n,
    minActive: 5_000000n,
    sweepThresholdPct: 0.20,
    sweepMinExcess: 5_000000n,
    lowTotalThreshold: 80_000000n,
  };
}

describe('BankrollManager', () => {
  let db: TradingDatabase;
  let manager: BankrollManager;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);
    manager = new BankrollManager(db, defaultConfig());
  });

  afterEach(() => {
    db.close();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  describe('initialization', () => {
    it('seeds bankroll with config defaults when empty', () => {
      const state = manager.getState();
      expect(state.totalUsdc).toBe(99_630000n);
      expect(state.activeUsdc).toBe(25_000000n);
      expect(state.reserveUsdc).toBe(74_630000n);
      expect(state.dailyRealizedPnl).toBe(0n);
      expect(state.dailyGasSpent).toBe(0n);
      expect(state.experimentTotalPnl).toBe(0n);
    });

    it('does not overwrite existing bankroll on second instantiation', () => {
      // Modify state
      manager.allocateProfit(1_000000n); // +$1

      // Re-instantiate
      const manager2 = new BankrollManager(db, defaultConfig());
      const state = manager2.getState();
      expect(state.activeUsdc).toBe(26_000000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // canTrade - Requirement 2.4, 2.5
  // ═══════════════════════════════════════════════════════════════════════════

  describe('canTrade', () => {
    it('approves trade when size <= active and active >= minActive', () => {
      expect(manager.canTrade(10_000000n)).toBe(true); // $10
      expect(manager.canTrade(25_000000n)).toBe(true); // $25 (full active)
    });

    it('rejects trade when size > active', () => {
      expect(manager.canTrade(26_000000n)).toBe(false); // > $25
      expect(manager.canTrade(100_000000n)).toBe(false);
    });

    it('rejects trade when active < minActive ($5)', () => {
      // Drain active below $5
      manager.allocateLoss(21_000000n); // active goes from $25 to $4
      expect(manager.canTrade(1_000000n)).toBe(false);
    });

    it('rejects even small trade when active is below minActive', () => {
      manager.allocateLoss(22_000000n); // active = $3
      expect(manager.canTrade(1n)).toBe(false); // Even 1 unit
    });

    it('approves trade at exactly minActive boundary', () => {
      manager.allocateLoss(20_000000n); // active = $5 (exactly minActive)
      expect(manager.canTrade(5_000000n)).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // allocateLoss - Requirement 2.3
  // ═══════════════════════════════════════════════════════════════════════════

  describe('allocateLoss', () => {
    it('deducts loss from active capital', () => {
      manager.allocateLoss(3_000000n); // $3 loss
      const state = manager.getState();
      expect(state.activeUsdc).toBe(22_000000n);
      expect(state.reserveUsdc).toBe(74_630000n); // Unchanged
    });

    it('never touches reserve on loss', () => {
      manager.allocateLoss(25_000000n); // Exhaust all active
      const state = manager.getState();
      expect(state.activeUsdc).toBe(0n);
      expect(state.reserveUsdc).toBe(74_630000n); // Still untouched
    });

    it('clamps active at zero (no negative)', () => {
      manager.allocateLoss(30_000000n); // More than active
      const state = manager.getState();
      expect(state.activeUsdc).toBe(0n);
      expect(state.totalUsdc).toBe(74_630000n); // Only reserve remains
    });

    it('preserves total = active + reserve', () => {
      manager.allocateLoss(10_000000n);
      const state = manager.getState();
      expect(state.totalUsdc).toBe(state.activeUsdc + state.reserveUsdc);
    });

    it('updates daily PnL tracker', () => {
      manager.allocateLoss(2_000000n);
      const state = manager.getState();
      expect(state.dailyRealizedPnl).toBe(-2_000000n);
    });

    it('updates experiment total PnL', () => {
      manager.allocateLoss(1_500000n);
      const state = manager.getState();
      expect(state.experimentTotalPnl).toBe(-1_500000n);
    });

    it('accumulates multiple losses', () => {
      manager.allocateLoss(1_000000n);
      manager.allocateLoss(2_000000n);
      const state = manager.getState();
      expect(state.activeUsdc).toBe(22_000000n);
      expect(state.dailyRealizedPnl).toBe(-3_000000n);
    });

    it('ignores zero or negative amounts', () => {
      manager.allocateLoss(0n);
      manager.allocateLoss(-1_000000n);
      const state = manager.getState();
      expect(state.activeUsdc).toBe(25_000000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // allocateProfit - Requirement 2.8
  // ═══════════════════════════════════════════════════════════════════════════

  describe('allocateProfit', () => {
    it('adds profit to active', () => {
      manager.allocateProfit(500000n); // $0.50
      const state = manager.getState();
      expect(state.activeUsdc).toBe(25_500000n);
    });

    it('updates daily PnL tracker', () => {
      manager.allocateProfit(800000n);
      const state = manager.getState();
      expect(state.dailyRealizedPnl).toBe(800000n);
    });

    it('updates experiment total PnL', () => {
      manager.allocateProfit(1_200000n);
      const state = manager.getState();
      expect(state.experimentTotalPnl).toBe(1_200000n);
    });

    it('ignores zero or negative amounts', () => {
      manager.allocateProfit(0n);
      manager.allocateProfit(-500000n);
      const state = manager.getState();
      expect(state.activeUsdc).toBe(25_000000n);
    });

    it('triggers sweep when >20% growth AND excess > $5', () => {
      // Need active to exceed threshold: 25_000000 * 1.2 = 30_000000
      // Plus excess > $5, so active needs to be > 35_000000
      manager.allocateProfit(11_000000n); // active = $36
      const state = manager.getState();
      // Threshold = $25 + 20% = $30. Excess = $36 - $30 = $6 > $5 → sweep
      expect(state.activeUsdc).toBe(30_000000n); // threshold
      expect(state.reserveUsdc).toBe(74_630000n + 6_000000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // recordGas
  // ═══════════════════════════════════════════════════════════════════════════

  describe('recordGas', () => {
    it('deducts gas from active', () => {
      manager.recordGas(50000n); // $0.05
      const state = manager.getState();
      expect(state.activeUsdc).toBe(24_950000n);
    });

    it('tracks daily gas spending', () => {
      manager.recordGas(50000n);
      manager.recordGas(30000n);
      const state = manager.getState();
      expect(state.dailyGasSpent).toBe(80000n);
    });

    it('clamps active at zero when gas exceeds active', () => {
      manager.recordGas(26_000000n);
      const state = manager.getState();
      expect(state.activeUsdc).toBe(0n);
    });

    it('ignores zero or negative amounts', () => {
      manager.recordGas(0n);
      manager.recordGas(-50000n);
      const state = manager.getState();
      expect(state.activeUsdc).toBe(25_000000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // checkSweep - Requirement 2.8
  // ═══════════════════════════════════════════════════════════════════════════

  describe('checkSweep', () => {
    it('does not sweep when active below threshold', () => {
      manager.allocateProfit(2_000000n); // active = $27, below $30 threshold
      const state = manager.getState();
      expect(state.activeUsdc).toBe(27_000000n);
      expect(state.reserveUsdc).toBe(74_630000n);
    });

    it('does not sweep when excess <= $5', () => {
      // Threshold = $30. Need active = $35 for excess of $5
      manager.allocateProfit(9_000000n); // active = $34, excess = $4 < $5
      const state = manager.getState();
      expect(state.activeUsdc).toBe(34_000000n); // No sweep
    });

    it('sweeps excess when >20% growth AND excess > $5', () => {
      manager.allocateProfit(15_000000n); // active = $40, excess = $10
      const state = manager.getState();
      // After sweep: active = threshold ($30), reserve += $10
      expect(state.activeUsdc).toBe(30_000000n);
      expect(state.reserveUsdc).toBe(74_630000n + 10_000000n);
    });

    it('logs sweep event', () => {
      manager.allocateProfit(15_000000n);
      const events = db.prepare(
        "SELECT * FROM event_log WHERE event_type = 'sweep_to_reserve'"
      ).all() as Array<{ details: string }>;
      expect(events.length).toBe(1);
      const details = JSON.parse(events[0].details);
      expect(details.amount).toBe('10000000');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Low-total formula - Requirement 2.6
  // ═══════════════════════════════════════════════════════════════════════════

  describe('low-total formula', () => {
    it('reduces active when total < $80', () => {
      // Start with a smaller total: use a custom config with small total
      const smallConfig: BankrollManagerConfig = {
        initialTotal: 60_000000n, // $60
        initialActive: 25_000000n, // $25
        initialReserve: 35_000000n,
        minActive: 5_000000n,
        sweepThresholdPct: 0.20,
        sweepMinExcess: 5_000000n,
        lowTotalThreshold: 80_000000n,
      };

      const db2 = createDatabase(':memory:');
      db2.pragma('journal_mode = WAL');
      runMigrations(db2);
      const mgr = new BankrollManager(db2, smallConfig);

      // After a loss that triggers low-total formula
      mgr.allocateLoss(15_000000n); // active = $10, total = $45
      const state = mgr.getState();
      // min($20, 25% of $45) = min($20, $11.25) = $11.25 → but active is $10 so stays $10
      expect(state.activeUsdc).toBe(10_000000n);

      db2.close();
    });

    it('caps active at min($20, 25% of total) on loss', () => {
      // Exhaust active to trigger low-total: lose $23 → active $2, total $76.63
      manager.allocateLoss(23_000000n);
      const state = manager.getState();
      // total = $2 + $74.63 = $76.63 < $80
      // min($20, 25% of $76.63) = min($20, $19.16) = $19.16
      // But active is only $2, so it stays at $2 (formula only reduces, doesn't increase)
      expect(state.activeUsdc).toBe(2_000000n);
    });

    it('applies formula when gas drains active below threshold', () => {
      // Scenario: config with total starting below $80
      const smallConfig: BankrollManagerConfig = {
        initialTotal: 70_000000n, // $70
        initialActive: 25_000000n,
        initialReserve: 45_000000n,
        minActive: 5_000000n,
        sweepThresholdPct: 0.20,
        sweepMinExcess: 5_000000n,
        lowTotalThreshold: 80_000000n,
      };

      const db2 = createDatabase(':memory:');
      db2.pragma('journal_mode = WAL');
      runMigrations(db2);
      const mgr = new BankrollManager(db2, smallConfig);

      // Already below $80: min($20, 25% of $70) = min($20, $17.5) = $17.5
      // active = $25 > $17.5 → should be capped on next loss
      mgr.allocateLoss(1_000000n); // active = $24, total = $69
      const state = mgr.getState();
      // min($20, 25% of $69) = min($20, $17.25) = $17.25
      // active was $24, now capped to $17.25
      expect(state.activeUsdc).toBe(17_250000n);
      expect(state.totalUsdc).toBe(69_000000n);

      db2.close();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // promoteReserve - Requirement 2.7
  // ═══════════════════════════════════════════════════════════════════════════

  describe('promoteReserve', () => {
    it('moves funds from reserve to active', () => {
      manager.promoteReserve(10_000000n); // $10
      const state = manager.getState();
      expect(state.activeUsdc).toBe(35_000000n);
      expect(state.reserveUsdc).toBe(64_630000n);
    });

    it('preserves total after promotion', () => {
      manager.promoteReserve(5_000000n);
      const state = manager.getState();
      expect(state.totalUsdc).toBe(99_630000n);
    });

    it('throws when amount > reserve', () => {
      expect(() => manager.promoteReserve(75_000000n)).toThrow(
        /Cannot promote.*from reserve/
      );
    });

    it('logs promote event with timestamp', () => {
      manager.promoteReserve(5_000000n);
      const events = db.prepare(
        "SELECT * FROM event_log WHERE event_type = 'promote_reserve'"
      ).all() as Array<{ details: string }>;
      expect(events.length).toBe(1);
      const details = JSON.parse(events[0].details);
      expect(details.amount).toBe('5000000');
      expect(details.timestamp).toBeDefined();
    });

    it('ignores zero amount', () => {
      manager.promoteReserve(0n);
      const state = manager.getState();
      expect(state.activeUsdc).toBe(25_000000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Daily Reset
  // ═══════════════════════════════════════════════════════════════════════════

  describe('resetDaily', () => {
    it('resets daily_realized_pnl to zero', () => {
      manager.allocateProfit(2_000000n);
      expect(manager.getState().dailyRealizedPnl).toBe(2_000000n);

      manager.resetDaily();
      expect(manager.getState().dailyRealizedPnl).toBe(0n);
    });

    it('resets daily_gas_spent to zero', () => {
      manager.recordGas(50000n);
      expect(manager.getState().dailyGasSpent).toBe(50000n);

      manager.resetDaily();
      expect(manager.getState().dailyGasSpent).toBe(0n);
    });

    it('updates day_start_bankroll to current total', () => {
      manager.allocateProfit(1_000000n); // total unchanged (goes to active)
      manager.resetDaily();

      const row = db.prepare('SELECT day_start_bankroll FROM bankroll WHERE id = 1').get() as { day_start_bankroll: string };
      expect(row.day_start_bankroll).toBe('100630000');
    });

    it('preserves experiment_total_pnl across daily reset', () => {
      manager.allocateProfit(2_000000n);
      manager.resetDaily();
      const state = manager.getState();
      expect(state.experimentTotalPnl).toBe(2_000000n); // Not reset
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getAvailableForTrading
  // ═══════════════════════════════════════════════════════════════════════════

  describe('getAvailableForTrading', () => {
    it('returns active when above minActive', () => {
      expect(manager.getAvailableForTrading()).toBe(25_000000n);
    });

    it('returns zero when active < minActive', () => {
      manager.allocateLoss(21_000000n); // active = $4
      expect(manager.getAvailableForTrading()).toBe(0n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Integration Scenarios
  // ═══════════════════════════════════════════════════════════════════════════

  describe('integrated scenarios', () => {
    it('loss then profit maintains consistency', () => {
      manager.allocateLoss(5_000000n);  // active = $20
      manager.allocateProfit(3_000000n); // active = $23
      const state = manager.getState();
      expect(state.activeUsdc).toBe(23_000000n);
      expect(state.reserveUsdc).toBe(74_630000n);
      expect(state.totalUsdc).toBe(97_630000n);
      expect(state.dailyRealizedPnl).toBe(-2_000000n); // net -$2
    });

    it('multiple operations preserve total = active + reserve', () => {
      manager.allocateLoss(2_000000n);
      manager.allocateProfit(1_000000n);
      manager.recordGas(50000n);
      manager.allocateProfit(500000n);
      const state = manager.getState();
      expect(state.totalUsdc).toBe(state.activeUsdc + state.reserveUsdc);
    });

    it('drain active then promote and resume trading', () => {
      manager.allocateLoss(22_000000n); // active = $3, below minActive
      expect(manager.canTrade(5_000000n)).toBe(false);

      manager.promoteReserve(10_000000n); // active = $13
      expect(manager.canTrade(5_000000n)).toBe(true);
    });
  });
});

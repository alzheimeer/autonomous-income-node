/**
 * Startup Recovery - Unit Tests
 *
 * Tests for the startup recovery procedure: loading persisted state,
 * resolving pending intents, detecting state divergence, and resuming
 * position monitoring.
 *
 * Requirements: 28.1, 28.2, 28.3, 28.4
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDatabase, type TradingDatabase } from '../db.js';
import { runMigrations } from '../migrations.js';
import {
  StartupRecovery,
  type IOnChainProvider,
  type IRecoverySafeModeController,
  type IRecoveryExitManager,
  type IRecoveryLogger,
  type StartupRecoveryConfig,
} from '../startup-recovery.js';
import type { Position } from '../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createMockProvider(overrides: Partial<IOnChainProvider> = {}): IOnChainProvider {
  return {
    getUsdcBalance: vi.fn().mockResolvedValue(99_630000n),
    getWethBalance: vi.fn().mockResolvedValue(0n),
    getAusdcBalance: vi.fn().mockResolvedValue(0n),
    getEthBalance: vi.fn().mockResolvedValue(5_000_000_000_000_000n), // 0.005 ETH
    getTransactionCount: vi.fn().mockResolvedValue(10),
    getTransactionReceipt: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function createMockSafeModeController(): IRecoverySafeModeController {
  return {
    trigger: vi.fn(),
    getState: vi.fn().mockReturnValue({ active: false }),
  };
}

function createMockExitManager(): IRecoveryExitManager {
  return {
    registerPosition: vi.fn(),
    getOpenPosition: vi.fn().mockReturnValue(null),
  };
}

function createMockLogger(): IRecoveryLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createTestConfig(): StartupRecoveryConfig {
  return {
    walletAddress: '0x1234567890abcdef1234567890abcdef12345678',
    deviationThresholdUsdc: 500_000n, // $0.50
    maxNonceDivergence: 2,
  };
}

function seedPhaseState(db: TradingDatabase): void {
  db.prepare(
    `INSERT INTO trading_phase (id, mode, config_hash, started_at, safe_mode, safe_mode_reason, safe_mode_since, low_cost_mode, kill_switch_triggered, auto_lender_disabled, updated_at)
     VALUES (1, 'shadow', 'abc123hash', ?, 0, NULL, NULL, 0, 0, 1, ?)`,
  ).run(Date.now() - 3600_000, Date.now());
}

function seedBankroll(db: TradingDatabase, totalUsdc = '99630000'): void {
  db.prepare(
    `INSERT INTO bankroll (id, total_usdc, active_usdc, reserve_usdc, daily_realized_pnl, daily_gas_spent, experiment_total_pnl, day_start_bankroll, day_utc, updated_at)
     VALUES (1, ?, '25000000', '74630000', '0', '0', '0', ?, '2025-01-01', ?)`,
  ).run(totalUsdc, totalUsdc, Date.now());
}

function seedNonceRegistry(db: TradingDatabase, lastConfirmed = 9, nextNonce = 10): void {
  db.prepare(
    `INSERT INTO nonce_registry (id, last_confirmed_nonce, next_nonce, updated_at)
     VALUES (1, ?, ?, ?)`,
  ).run(lastConfirmed, nextNonce, Date.now());
}

function seedPendingIntent(
  db: TradingDatabase,
  id: string,
  nonce: number,
  state = 'swap_pending',
  txHash: string | null = '0xabc123',
): void {
  db.prepare(
    `INSERT INTO tx_intents (id, state, nonce, tx_hash, contract_address, function_name, gas_limit, created_at, updated_at, operation_type)
     VALUES (?, ?, ?, ?, '0x1111111111111111111111111111111111111111', 'exactInputSingle', '250000', ?, ?, 'entry')`,
  ).run(id, state, nonce, txHash, Date.now() - 60_000, Date.now() - 60_000);
}

function seedOpenPosition(db: TradingDatabase, intentId = 'intent-1'): void {
  // First ensure the intent exists
  const existingIntent = db.prepare('SELECT id FROM tx_intents WHERE id = ?').get(intentId);
  if (!existingIntent) {
    seedPendingIntent(db, intentId, 9, 'confirmed', '0xconfirmed');
    db.prepare('UPDATE tx_intents SET state = ? WHERE id = ?').run('confirmed', intentId);
  }

  db.prepare(
    `INSERT INTO positions (id, intent_id, mode, strategy, pair, entry_price, entry_timestamp, size_usdc, size_weth, stop_loss, take_profit, max_holding_ms, entry_regime, closed, config_hash)
     VALUES ('pos-1', ?, 'micro', 'trend_pullback', 'WETH/USDC', 2500.00, ?, '7000000', '2800000000000000', 2462.50, 2575.00, 28800000, 'TRENDING_UP', 0, 'abc123hash')`,
  ).run(intentId, Date.now() - 1800_000);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('StartupRecovery', () => {
  let db: TradingDatabase;
  let provider: IOnChainProvider;
  let safeModeController: IRecoverySafeModeController;
  let exitManager: IRecoveryExitManager;
  let logger: IRecoveryLogger;
  let config: StartupRecoveryConfig;
  let recovery: StartupRecovery;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.pragma('journal_mode = WAL');
    runMigrations(db);

    provider = createMockProvider();
    safeModeController = createMockSafeModeController();
    exitManager = createMockExitManager();
    logger = createMockLogger();
    config = createTestConfig();

    recovery = new StartupRecovery(
      db,
      config,
      provider,
      safeModeController,
      exitManager,
      logger,
    );
  });

  describe('Requirement 28.1 - Load persisted state from SQLite', () => {
    it('should return empty state when DB has no phase/bankroll data', async () => {
      const result = await recovery.recover();

      expect(result.success).toBe(true);
      expect(result.persistedState.phase).toBeNull();
      expect(result.persistedState.bankroll).toBeNull();
      expect(result.persistedState.openPositions).toHaveLength(0);
      expect(result.persistedState.pendingIntents).toHaveLength(0);
      expect(result.persistedState.nonce).toBeNull();
    });

    it('should load phase state from trading_phase table', async () => {
      seedPhaseState(db);
      seedNonceRegistry(db);

      const result = await recovery.recover();

      expect(result.persistedState.phase).not.toBeNull();
      expect(result.persistedState.phase!.mode).toBe('shadow');
      expect(result.persistedState.phase!.configHash).toBe('abc123hash');
      expect(result.persistedState.phase!.autoLenderDisabled).toBe(true);
      expect(result.persistedState.phase!.safeMode).toBe(false);
      expect(result.persistedState.phase!.killSwitchTriggered).toBe(false);
    });

    it('should load bankroll state with BigInt values', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db);

      const result = await recovery.recover();

      expect(result.persistedState.bankroll).not.toBeNull();
      expect(result.persistedState.bankroll!.totalUsdc).toBe(99_630000n);
      expect(result.persistedState.bankroll!.activeUsdc).toBe(25_000000n);
      expect(result.persistedState.bankroll!.reserveUsdc).toBe(74_630000n);
      expect(result.persistedState.bankroll!.dailyRealizedPnl).toBe(0n);
      expect(result.persistedState.bankroll!.dailyGasSpent).toBe(0n);
    });

    it('should load open positions', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db);
      seedOpenPosition(db, 'intent-open');

      // Adjust provider for position scenario
      provider = createMockProvider({
        getUsdcBalance: vi.fn().mockResolvedValue(92_630000n), // Less USDC due to position
        getWethBalance: vi.fn().mockResolvedValue(2_800_000_000_000_000n),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.persistedState.openPositions).toHaveLength(1);
      expect(result.persistedState.openPositions[0]!.id).toBe('pos-1');
      expect(result.persistedState.openPositions[0]!.sizeUsdc).toBe(7_000000n);
      expect(result.persistedState.openPositions[0]!.strategy).toBe('trend_pullback');
    });

    it('should load pending intents', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db);
      seedPendingIntent(db, 'pending-1', 10, 'swap_pending', '0xhash1');

      const result = await recovery.recover();

      expect(result.persistedState.pendingIntents).toHaveLength(1);
      expect(result.persistedState.pendingIntents[0]!.id).toBe('pending-1');
      expect(result.persistedState.pendingIntents[0]!.state).toBe('swap_pending');
    });

    it('should load nonce state', async () => {
      seedPhaseState(db);
      seedNonceRegistry(db, 9, 10);

      const result = await recovery.recover();

      expect(result.persistedState.nonce).not.toBeNull();
      expect(result.persistedState.nonce!.lastConfirmedNonce).toBe(9);
      expect(result.persistedState.nonce!.nextNonce).toBe(10);
    });

    it('should load approvals', async () => {
      seedPhaseState(db);
      seedNonceRegistry(db);

      db.prepare(
        `INSERT INTO approvals (token, spender, amount, tx_hash, timestamp, revoked)
         VALUES ('0xUSDC', '0xRouter', '10000000', '0xtxhash', ?, 0)`,
      ).run(Date.now());

      const result = await recovery.recover();

      expect(result.persistedState.approvals).toHaveLength(1);
      expect(result.persistedState.approvals[0]!.token).toBe('0xUSDC');
      expect(result.persistedState.approvals[0]!.amount).toBe(10_000000n);
    });
  });

  describe('Requirement 28.2 - Query on-chain state', () => {
    it('should query all on-chain balances', async () => {
      seedPhaseState(db);
      seedNonceRegistry(db);

      const result = await recovery.recover();

      expect(provider.getUsdcBalance).toHaveBeenCalledWith(config.walletAddress);
      expect(provider.getWethBalance).toHaveBeenCalledWith(config.walletAddress);
      expect(provider.getAusdcBalance).toHaveBeenCalledWith(config.walletAddress);
      expect(provider.getEthBalance).toHaveBeenCalledWith(config.walletAddress);
      expect(provider.getTransactionCount).toHaveBeenCalledWith(config.walletAddress);

      expect(result.onChainState.usdcBalance).toBe(99_630000n);
      expect(result.onChainState.wethBalance).toBe(0n);
      expect(result.onChainState.ausdcBalance).toBe(0n);
      expect(result.onChainState.ethBalance).toBe(5_000_000_000_000_000n);
      expect(result.onChainState.walletNonce).toBe(10);
    });
  });

  describe('Requirement 28.3 - Resolve pending intents', () => {
    it('should resolve confirmed intent from receipt', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db, 9, 10);
      seedPendingIntent(db, 'intent-confirmed', 9, 'swap_pending', '0xconfirmed');

      provider = createMockProvider({
        getTransactionReceipt: vi.fn().mockResolvedValue({ status: 1, blockNumber: 100 }),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.resolvedIntents).toHaveLength(1);
      expect(result.resolvedIntents[0]!.resolution).toBe('confirmed');
      expect(result.resolvedIntents[0]!.resolvedState).toBe('confirmed');

      // Verify persisted in DB
      const row = db.prepare('SELECT state FROM tx_intents WHERE id = ?').get('intent-confirmed') as { state: string };
      expect(row.state).toBe('confirmed');
    });

    it('should resolve reverted intent from receipt', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db, 9, 10);
      seedPendingIntent(db, 'intent-reverted', 9, 'swap_pending', '0xreverted');

      provider = createMockProvider({
        getTransactionReceipt: vi.fn().mockResolvedValue({ status: 0, blockNumber: 100 }),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.resolvedIntents[0]!.resolution).toBe('reverted');
      expect(result.resolvedIntents[0]!.resolvedState).toBe('reverted');
    });

    it('should mark intent as dropped when nonce < wallet nonce and no receipt', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db, 7, 8);
      seedPendingIntent(db, 'intent-dropped', 7, 'swap_pending', '0xdropped');

      // Wallet nonce is 10, intent nonce is 7 → dropped
      provider = createMockProvider({
        getTransactionCount: vi.fn().mockResolvedValue(10),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.resolvedIntents[0]!.resolution).toBe('dropped');
      expect(result.resolvedIntents[0]!.resolvedState).toBe('dropped');
    });

    it('should keep intent as still_pending when nonce >= wallet nonce', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db, 9, 11);
      seedPendingIntent(db, 'intent-pending', 11, 'swap_pending', '0xpending');

      // Wallet nonce is 10, intent nonce is 11 → still pending
      provider = createMockProvider({
        getTransactionCount: vi.fn().mockResolvedValue(10),
        getTransactionReceipt: vi.fn().mockResolvedValue(null),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.resolvedIntents[0]!.resolution).toBe('still_pending');
      expect(result.resolvedIntents[0]!.resolvedState).toBe('swap_pending');
    });

    it('should enter Safe_Mode on state divergence beyond threshold', async () => {
      seedPhaseState(db);
      seedBankroll(db, '99630000'); // persisted total = $99.63
      seedNonceRegistry(db);

      // On-chain shows much less USDC (divergence > $0.50 threshold)
      provider = createMockProvider({
        getUsdcBalance: vi.fn().mockResolvedValue(90_000000n), // $90, divergence = $9.63
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.safeModeTriggered).toBe(true);
      expect(safeModeController.trigger).toHaveBeenCalled();
    });

    it('should NOT enter Safe_Mode when deviation is within threshold', async () => {
      seedPhaseState(db);
      seedBankroll(db, '99630000');
      seedNonceRegistry(db);

      // On-chain is within $0.50 of persisted
      provider = createMockProvider({
        getUsdcBalance: vi.fn().mockResolvedValue(99_400000n), // $99.40, deviation = $0.23
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.safeModeTriggered).toBe(false);
    });

    it('should enter Safe_Mode on nonce divergence beyond threshold', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db, 5, 6); // persisted next = 6

      // On-chain nonce is 10, persisted next is 6 → divergence = 4 > threshold of 2
      provider = createMockProvider({
        getTransactionCount: vi.fn().mockResolvedValue(10),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.safeModeTriggered).toBe(true);
      expect(result.safeModeReason).toContain('Nonce divergence');
    });
  });

  describe('Requirement 28.4 - Resume ExitManager and idempotency', () => {
    it('should resume ExitManager when open position detected', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db);
      seedOpenPosition(db, 'intent-pos');

      // USDC is less because some is in WETH position
      provider = createMockProvider({
        getUsdcBalance: vi.fn().mockResolvedValue(92_630000n),
        getWethBalance: vi.fn().mockResolvedValue(2_800_000_000_000_000n),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      const result = await recovery.recover();

      expect(result.positionResumed).toBe(true);
      expect(exitManager.registerPosition).toHaveBeenCalledTimes(1);
      expect(exitManager.registerPosition).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'pos-1',
          strategy: 'trend_pullback',
          sizeUsdc: 7_000000n,
        }),
      );
    });

    it('should NOT resume ExitManager when no open position', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db);

      const result = await recovery.recover();

      expect(result.positionResumed).toBe(false);
      expect(exitManager.registerPosition).not.toHaveBeenCalled();
    });

    it('should immediately trigger Safe_Mode if kill switch was persisted', async () => {
      // Seed phase with kill switch triggered
      db.prepare(
        `INSERT INTO trading_phase (id, mode, config_hash, started_at, safe_mode, kill_switch_triggered, auto_lender_disabled, updated_at)
         VALUES (1, 'shadow', 'abc123', ?, 0, 1, 1, ?)`,
      ).run(Date.now() - 3600_000, Date.now());
      seedNonceRegistry(db);

      const result = await recovery.recover();

      expect(result.safeModeTriggered).toBe(true);
      expect(safeModeController.trigger).toHaveBeenCalledWith(
        'kill_switch',
        expect.stringContaining('Kill switch persisted'),
      );
    });

    it('should log recovery event to event_log', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db);

      await recovery.recover();

      const events = db.prepare(
        "SELECT * FROM event_log WHERE event_type = 'startup_recovery'",
      ).all() as Array<{ event_type: string; details: string }>;

      expect(events).toHaveLength(1);
      expect(JSON.parse(events[0]!.details)).toHaveProperty('mode', 'shadow');
    });

    it('should sync nonce registry with on-chain nonce', async () => {
      seedPhaseState(db);
      seedBankroll(db);
      seedNonceRegistry(db, 8, 9); // persisted next = 9

      // On-chain nonce is 10 → should advance
      provider = createMockProvider({
        getTransactionCount: vi.fn().mockResolvedValue(10),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      await recovery.recover();

      const row = db.prepare('SELECT * FROM nonce_registry WHERE id = 1').get() as {
        next_nonce: number;
        last_confirmed_nonce: number;
      };
      expect(row.next_nonce).toBe(10);
      expect(row.last_confirmed_nonce).toBe(9);
    });

    it('should initialize nonce registry if not present', async () => {
      seedPhaseState(db);
      // No nonce registry seeded

      provider = createMockProvider({
        getTransactionCount: vi.fn().mockResolvedValue(5),
      });
      recovery = new StartupRecovery(db, config, provider, safeModeController, exitManager, logger);

      await recovery.recover();

      const row = db.prepare('SELECT * FROM nonce_registry WHERE id = 1').get() as {
        next_nonce: number;
        last_confirmed_nonce: number;
      };
      expect(row.next_nonce).toBe(5);
      expect(row.last_confirmed_nonce).toBe(4);
    });
  });
});

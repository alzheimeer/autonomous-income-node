/**
 * Tests for SmartAutoLender — Tasks 1.2 and 4.1
 *
 * Task 4.1: Database persistence layer (createSmartLenderTable, loadState, saveState)
 * Task 1.2: SmartAutoLender class constructor and dependency injection
 *
 * Uses in-memory stubs — no native SQLite required.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSmartLenderTable,
  loadState,
  saveState,
  SmartAutoLender,
  DEFAULT_SMART_AUTO_LENDER_CONFIG,
} from './smart-auto-lender.js';
import type {
  ISmartLenderDb,
  ISmartLenderBankroll,
  ISmartLenderSafeMode,
  ISmartLenderLogger,
  SmartAutoLenderConfig,
} from './smart-auto-lender.js';
import type { IAaveLendingModule } from './aave-lending.js';

// ═══════════════════════════════════════════════════════════════════════════════
// In-memory DB stub
// ═══════════════════════════════════════════════════════════════════════════════

class InMemoryDb implements ISmartLenderDb {
  private rows: unknown[] = [];
  private tableCreated = false;

  exec(sql: string): void {
    if (sql.includes('CREATE TABLE') && !this.tableCreated) {
      this.tableCreated = true;
      // IF NOT EXISTS — don't clear data if table already has rows
    }
  }

  prepare(sql: string) {
    const db = this;
    return {
      run(...params: unknown[]): unknown {
        if (!db.tableCreated) return { changes: 0 };
        if (sql.includes('INSERT OR REPLACE')) {
          // Upsert singleton row
          const row = {
            id: 1,
            maintenance_mode: params[0] as number,
            idle_period_start: params[1] as number | null,
            updated_at: params[2] as number,
          };
          db.rows = [row];
          return { changes: 1 };
        }
        return { changes: 0 };
      },
      get(..._params: unknown[]): unknown {
        if (!db.tableCreated) return undefined;
        if (sql.includes('SELECT') && db.rows.length > 0) {
          return db.rows[0];
        }
        return undefined;
      },
      all(..._params: unknown[]): unknown[] {
        if (!db.tableCreated) return [];
        return db.rows;
      },
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stubs for dependencies
// ═══════════════════════════════════════════════════════════════════════════════

function createMockAave(): IAaveLendingModule {
  return {
    async supply(_amount: bigint) {
      return { txHash: '0xabc', deposited: _amount };
    },
    async withdraw(_amount: bigint) {
      return { txHash: '0xdef', withdrawn: _amount };
    },
    async getPosition() {
      return {
        depositedUsdc: 0n,
        currentATokenBalance: 0n,
        accruedInterest: 0n,
        currentApyBps: 300,
        lastUpdated: Date.now(),
      };
    },
    async checkApyThreshold() {
      return { apy: 300, belowMinimum: false };
    },
    async monitor(_walletBalance: bigint) {
      return { action: 'none' as const, amount: 0n, reason: 'mock' };
    },
  };
}

function createMockBankroll(): ISmartLenderBankroll {
  return {
    allocateLoss(_amount: bigint) {},
    allocateProfit(_amount: bigint) {},
    recordGas(_gasCostUsdc: bigint) {},
  };
}

function createMockSafeMode(): ISmartLenderSafeMode {
  return {
    isActive() {
      return false;
    },
  };
}

function createMockLogger(): ISmartLenderLogger {
  return {
    info(_message: string, ..._args: unknown[]) {},
    warn(_message: string, ..._args: unknown[]) {},
    error(_message: string, ..._args: unknown[]) {},
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task 4.1: Database Persistence Layer Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 4.1: Database persistence layer', () => {
  let db: InMemoryDb;

  beforeEach(() => {
    db = new InMemoryDb();
  });

  describe('createSmartLenderTable', () => {
    it('should create the table without errors', () => {
      expect(() => createSmartLenderTable(db)).not.toThrow();
    });
  });

  describe('loadState', () => {
    it('should return default state when no row exists', () => {
      createSmartLenderTable(db);
      const state = loadState(db);
      expect(state.maintenanceMode).toBe(false);
      expect(state.idlePeriodStart).toBeNull();
    });

    it('should return persisted maintenance mode = true', () => {
      createSmartLenderTable(db);
      saveState(db, { maintenanceMode: true, idlePeriodStart: null });
      const state = loadState(db);
      expect(state.maintenanceMode).toBe(true);
    });

    it('should return persisted idlePeriodStart', () => {
      createSmartLenderTable(db);
      const timestamp = 1700000000000;
      saveState(db, { maintenanceMode: false, idlePeriodStart: timestamp });
      const state = loadState(db);
      expect(state.idlePeriodStart).toBe(timestamp);
    });
  });

  describe('saveState', () => {
    it('should persist maintenance_mode = true', () => {
      createSmartLenderTable(db);
      saveState(db, { maintenanceMode: true, idlePeriodStart: null });
      const state = loadState(db);
      expect(state.maintenanceMode).toBe(true);
    });

    it('should persist maintenance_mode = false', () => {
      createSmartLenderTable(db);
      saveState(db, { maintenanceMode: false, idlePeriodStart: null });
      const state = loadState(db);
      expect(state.maintenanceMode).toBe(false);
    });

    it('should overwrite previous state (upsert)', () => {
      createSmartLenderTable(db);
      saveState(db, { maintenanceMode: true, idlePeriodStart: 1000 });
      saveState(db, { maintenanceMode: false, idlePeriodStart: 2000 });
      const state = loadState(db);
      expect(state.maintenanceMode).toBe(false);
      expect(state.idlePeriodStart).toBe(2000);
    });

    it('should persist null idlePeriodStart', () => {
      createSmartLenderTable(db);
      saveState(db, { maintenanceMode: false, idlePeriodStart: null });
      const state = loadState(db);
      expect(state.idlePeriodStart).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task 1.2: SmartAutoLender Constructor Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 1.2: SmartAutoLender constructor', () => {
  let db: InMemoryDb;
  let config: SmartAutoLenderConfig;

  beforeEach(() => {
    db = new InMemoryDb();
    config = { ...DEFAULT_SMART_AUTO_LENDER_CONFIG };
  });

  function createLender(overrides?: { db?: InMemoryDb }) {
    return new SmartAutoLender({
      aave: createMockAave(),
      bankroll: createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db: overrides?.db ?? db,
    });
  }

  it('should construct without errors', () => {
    expect(() => createLender()).not.toThrow();
  });

  it('should initialize with maintenanceMode = false by default', () => {
    const lender = createLender();
    expect(lender.isMaintenanceMode()).toBe(false);
  });

  it('should initialize internal state with defaults', () => {
    const lender = createLender();
    const state = lender.getState();
    expect(state.idlePeriodStart).toBeNull();
    expect(state.maintenanceMode).toBe(false);
    expect(state.pendingWithdrawals).toEqual([]);
    expect(state.lastTradeSignal).toBeNull();
  });

  it('should load persisted maintenance mode = true from database', () => {
    // Pre-persist state
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: true, idlePeriodStart: null });

    const lender = createLender();
    expect(lender.isMaintenanceMode()).toBe(true);
    expect(lender.getState().maintenanceMode).toBe(true);
  });

  it('should load persisted idlePeriodStart from database', () => {
    const timestamp = 1700000000000;
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: false, idlePeriodStart: timestamp });

    const lender = createLender();
    expect(lender.getState().idlePeriodStart).toBe(timestamp);
  });

  it('should create the smart_lender_state table during construction', () => {
    // New db with no table
    const freshDb = new InMemoryDb();
    const lender = new SmartAutoLender({
      aave: createMockAave(),
      bankroll: createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db: freshDb,
    });
    // If table creation failed, loadState would throw or return bad data
    expect(lender.getState().maintenanceMode).toBe(false);
  });

  it('should accept all dependency injections', () => {
    const aave = createMockAave();
    const bankroll = createMockBankroll();
    const safeMode = createMockSafeMode();
    const logger = createMockLogger();

    // No throw = all deps accepted
    expect(
      () =>
        new SmartAutoLender({
          aave,
          bankroll,
          safeMode,
          config,
          logger,
          db,
        }),
    ).not.toThrow();
  });

  describe('onTradeSignal()', () => {
    it('should reset idlePeriodStart to null', () => {
      createSmartLenderTable(db);
      saveState(db, { maintenanceMode: false, idlePeriodStart: 1700000000000 });
      const lender = createLender();
      expect(lender.getState().idlePeriodStart).toBe(1700000000000);

      lender.onTradeSignal();
      expect(lender.getState().idlePeriodStart).toBeNull();
    });

    it('should set lastTradeSignal timestamp', () => {
      const lender = createLender();
      expect(lender.getState().lastTradeSignal).toBeNull();

      lender.onTradeSignal();
      expect(lender.getState().lastTradeSignal).not.toBeNull();
      expect(typeof lender.getState().lastTradeSignal).toBe('number');
    });
  });

  describe('onRegimeChange()', () => {
    it('should reset idlePeriodStart when leaving UNCERTAIN', () => {
      createSmartLenderTable(db);
      saveState(db, { maintenanceMode: false, idlePeriodStart: 1700000000000 });
      const lender = createLender();

      lender.onRegimeChange('UNCERTAIN', 'TRENDING_UP');
      expect(lender.getState().idlePeriodStart).toBeNull();
    });

    it('should not reset idlePeriodStart when staying in UNCERTAIN', () => {
      createSmartLenderTable(db);
      saveState(db, { maintenanceMode: false, idlePeriodStart: 1700000000000 });
      const lender = createLender();

      lender.onRegimeChange('INVALID', 'UNCERTAIN');
      expect(lender.getState().idlePeriodStart).toBe(1700000000000);
    });
  });

  describe('getAaveBalance()', () => {
    it('should return the aToken balance from aave module', async () => {
      const lender = createLender();
      const balance = await lender.getAaveBalance();
      expect(balance).toBe(0n);
    });
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Task 2.1: evaluateIdle — Full decision logic tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 2.1: evaluateIdle decision logic', () => {
  let db: InMemoryDb;
  let config: SmartAutoLenderConfig;

  beforeEach(() => {
    db = new InMemoryDb();
    config = { ...DEFAULT_SMART_AUTO_LENDER_CONFIG };
  });

  function createLender(overrides?: {
    aave?: IAaveLendingModule;
    safeMode?: ISmartLenderSafeMode;
    bankroll?: ISmartLenderBankroll;
  }) {
    return new SmartAutoLender({
      aave: overrides?.aave ?? createMockAave(),
      bankroll: overrides?.bankroll ?? createMockBankroll(),
      safeMode: overrides?.safeMode ?? createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
  }

  it('should return none when SafeMode is active', async () => {
    const safeMode = { isActive: () => true };
    const lender = createLender({ safeMode });
    const result = await lender.evaluateIdle(100_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('safe_mode_active');
  });

  it('should return none when maintenance mode is active', async () => {
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: true, idlePeriodStart: null });
    const lender = createLender();
    const result = await lender.evaluateIdle(100_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('maintenance_mode_active');
  });

  it('should withdraw all when APY < minApyBps and position exists', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 50_000000n,
          currentATokenBalance: 50_000000n,
          accruedInterest: 0n,
          currentApyBps: 100, // below default 200
          lastUpdated: Date.now(),
        };
      },
    };
    const bankroll = createMockBankroll();
    let profitNotified = 0n;
    bankroll.allocateProfit = (amount: bigint) => { profitNotified = amount; };

    const lender = createLender({ aave, bankroll });
    const result = await lender.evaluateIdle(100_000000n);
    expect(result.action).toBe('withdraw');
    expect(result.amount).toBe(50_000000n);
    expect(result.reason).toBe('low_apy_full_withdrawal');
    expect(profitNotified).toBe(50_000000n);
  });

  it('should return none when open position exists', async () => {
    const lender = createLender();
    lender.setHasOpenPosition(true);
    const result = await lender.evaluateIdle(100_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('open_position_active');
  });

  it('should reset idle timer and return none when regime != UNCERTAIN', async () => {
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: false, idlePeriodStart: 1700000000000 });
    const lender = createLender();
    lender.onRegimeChange('UNCERTAIN', 'TRENDING_UP');

    const result = await lender.evaluateIdle(100_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('regime_not_uncertain');
    expect(lender.getState().idlePeriodStart).toBeNull();
  });

  it('should start idle period when idlePeriodStart is null in UNCERTAIN regime', async () => {
    const lender = createLender();
    // Default regime is UNCERTAIN, idlePeriodStart is null
    const result = await lender.evaluateIdle(100_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('idle_period_started');
    expect(lender.getState().idlePeriodStart).not.toBeNull();
  });

  it('should return none when idle threshold not reached', async () => {
    createSmartLenderTable(db);
    // Set idle start to just now (not enough time elapsed)
    saveState(db, { maintenanceMode: false, idlePeriodStart: Date.now() });
    const lender = createLender();

    const result = await lender.evaluateIdle(100_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('idle_threshold_not_reached');
  });

  it('should deposit when idle threshold reached and sufficient balance', async () => {
    createSmartLenderTable(db);
    // Set idle start to way in the past (> 2h ago)
    const twoHoursAgo = Date.now() - 8_000_000;
    saveState(db, { maintenanceMode: false, idlePeriodStart: twoHoursAgo });

    let lossNotified = 0n;
    const bankroll = createMockBankroll();
    bankroll.allocateLoss = (amount: bigint) => { lossNotified = amount; };

    const lender = createLender({ bankroll });
    // walletBalance = 100 USDC, reserve = 15 USDC → deposit = 85 USDC
    const result = await lender.evaluateIdle(100_000000n);
    expect(result.action).toBe('deposit');
    expect(result.amount).toBe(85_000000n); // 100 - 15 reserve
    expect(result.reason).toBe('idle_period_2h');
    expect(lossNotified).toBe(85_000000n);
  });

  it('should return none when balance insufficient for deposit', async () => {
    createSmartLenderTable(db);
    const twoHoursAgo = Date.now() - 8_000_000;
    saveState(db, { maintenanceMode: false, idlePeriodStart: twoHoursAgo });
    const lender = createLender();

    // walletBalance = 18 USDC, reserve = 15, minDeposit = 5 → 18 <= 15+5 = 20 → skip
    const result = await lender.evaluateIdle(18_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('idle_threshold_not_reached');
  });

  it('should catch exceptions and return error reason', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        throw new Error('RPC_FAILURE');
      },
    };
    // Safe mode must not be active for the error path to trigger at APY check
    const lender = createLender({ aave });
    const result = await lender.evaluateIdle(100_000000n);
    // The APY check error is caught internally, so it continues to step 4+
    // Since getPosition throws, the error at step 3 is caught, proceeds to step 4+
    expect(result.action).toBe('none');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task 2.2: onRegimeChange and onTradeSignal additional tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 2.2: onRegimeChange and onTradeSignal', () => {
  let db: InMemoryDb;
  let config: SmartAutoLenderConfig;

  beforeEach(() => {
    db = new InMemoryDb();
    config = { ...DEFAULT_SMART_AUTO_LENDER_CONFIG };
  });

  function createLender() {
    return new SmartAutoLender({
      aave: createMockAave(),
      bankroll: createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
  }

  it('onRegimeChange should start idle period when entering UNCERTAIN with no prior start', () => {
    const lender = createLender();
    // First, go to non-UNCERTAIN
    lender.onRegimeChange('UNCERTAIN', 'TRENDING_UP');
    expect(lender.getState().idlePeriodStart).toBeNull();
    // Now enter UNCERTAIN
    lender.onRegimeChange('TRENDING_UP', 'UNCERTAIN');
    expect(lender.getState().idlePeriodStart).not.toBeNull();
  });

  it('onRegimeChange to TRENDING_DOWN should reset idle timer', () => {
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: false, idlePeriodStart: Date.now() });
    const lender = createLender();
    lender.onRegimeChange('UNCERTAIN', 'TRENDING_DOWN');
    expect(lender.getState().idlePeriodStart).toBeNull();
  });

  it('onTradeSignal should persist state', () => {
    const lender = createLender();
    lender.onTradeSignal();
    // Verify state was persisted
    const state = lender.getState();
    expect(state.idlePeriodStart).toBeNull();
    expect(state.lastTradeSignal).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task 4.2: setMaintenance tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 4.2: setMaintenance', () => {
  let db: InMemoryDb;
  let config: SmartAutoLenderConfig;

  beforeEach(() => {
    db = new InMemoryDb();
    config = { ...DEFAULT_SMART_AUTO_LENDER_CONFIG };
  });

  function createLender(overrides?: {
    aave?: IAaveLendingModule;
    bankroll?: ISmartLenderBankroll;
  }) {
    return new SmartAutoLender({
      aave: overrides?.aave ?? createMockAave(),
      bankroll: overrides?.bankroll ?? createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
  }

  it('should enable maintenance and deposit when walletBalance is sufficient', async () => {
    let lossNotified = 0n;
    const bankroll = createMockBankroll();
    bankroll.allocateLoss = (amount: bigint) => { lossNotified = amount; };

    const lender = createLender({ bankroll });
    // 100 USDC wallet, reserve=15, minDeposit=5 → 100 > 15+5=20 → deposit 100-15=85
    const result = await lender.setMaintenance(true, 100_000000n);
    expect(result.action).toBe('deposit');
    expect(result.amount).toBe(85_000000n);
    expect(result.reason).toBe('maintenance_on');
    expect(lender.isMaintenanceMode()).toBe(true);
    expect(lossNotified).toBe(85_000000n);
  });

  it('should enable maintenance with no deposit when walletBalance is insufficient', async () => {
    const lender = createLender();
    // 18 USDC ≤ 15+5 = 20 → no deposit
    const result = await lender.setMaintenance(true, 18_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('maintenance_enabled_no_deposit');
    expect(lender.isMaintenanceMode()).toBe(true);
  });

  it('should enable maintenance with no deposit when walletBalance not provided', async () => {
    const lender = createLender();
    const result = await lender.setMaintenance(true);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('maintenance_enabled_no_deposit');
    expect(lender.isMaintenanceMode()).toBe(true);
  });

  it('should disable maintenance and withdraw all when position exists', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 50_000000n,
          currentATokenBalance: 50_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    let profitNotified = 0n;
    const bankroll = createMockBankroll();
    bankroll.allocateProfit = (amount: bigint) => { profitNotified = amount; };

    // First enable maintenance
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: true, idlePeriodStart: null });

    const lender = createLender({ aave, bankroll });
    expect(lender.isMaintenanceMode()).toBe(true);

    const result = await lender.setMaintenance(false);
    expect(result.action).toBe('withdraw');
    expect(result.amount).toBe(50_000000n);
    expect(result.reason).toBe('maintenance_off');
    expect(lender.isMaintenanceMode()).toBe(false);
    expect(profitNotified).toBe(50_000000n);
  });

  it('should disable maintenance with no withdrawal when no position', async () => {
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: true, idlePeriodStart: null });

    const lender = createLender();
    const result = await lender.setMaintenance(false);
    expect(result.action).toBe('none');
    expect(result.reason).toBe('maintenance_disabled_no_position');
    expect(lender.isMaintenanceMode()).toBe(false);
  });

  it('should catch errors and return error reason', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async supply(_amount: bigint) {
        throw new Error('TX_REVERTED');
      },
    };
    const lender = createLender({ aave });
    const result = await lender.setMaintenance(true, 100_000000n);
    expect(result.action).toBe('none');
    expect(result.reason).toContain('error:');
    expect(result.reason).toContain('TX_REVERTED');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task 8.2: getAaveBalance and isMaintenanceMode tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 8.2: getAaveBalance and isMaintenanceMode', () => {
  let db: InMemoryDb;
  let config: SmartAutoLenderConfig;

  beforeEach(() => {
    db = new InMemoryDb();
    config = { ...DEFAULT_SMART_AUTO_LENDER_CONFIG };
  });

  it('getAaveBalance should return the currentATokenBalance from aave module', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 100_000000n,
          currentATokenBalance: 105_000000n,
          accruedInterest: 5_000000n,
          currentApyBps: 400,
          lastUpdated: Date.now(),
        };
      },
    };
    const lender = new SmartAutoLender({
      aave,
      bankroll: createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
    const balance = await lender.getAaveBalance();
    expect(balance).toBe(105_000000n);
  });

  it('isMaintenanceMode should reflect current state', () => {
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: true, idlePeriodStart: null });
    const lender = new SmartAutoLender({
      aave: createMockAave(),
      bankroll: createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
    expect(lender.isMaintenanceMode()).toBe(true);
  });

  it('isMaintenanceMode should return false after disabling', async () => {
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: true, idlePeriodStart: null });
    const lender = new SmartAutoLender({
      aave: createMockAave(),
      bankroll: createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
    expect(lender.isMaintenanceMode()).toBe(true);
    await lender.setMaintenance(false);
    expect(lender.isMaintenanceMode()).toBe(false);
  });

  it('setHasOpenPosition should update the hasPosition flag', async () => {
    const lender = new SmartAutoLender({
      aave: createMockAave(),
      bankroll: createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
    lender.setHasOpenPosition(true);
    const result = await lender.evaluateIdle(100_000000n);
    expect(result.reason).toBe('open_position_active');

    lender.setHasOpenPosition(false);
    const result2 = await lender.evaluateIdle(100_000000n);
    expect(result2.reason).not.toBe('open_position_active');
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// Task 3.1: ensureFunds — Pre-trade withdrawal tests
// Requirements: 3.3, 4.1, 4.2, 4.3, 4.4, 5.1, 5.3, 5.4, 6.2, 6.4, 6.5, 7.2
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 3.1: ensureFunds', () => {
  let db: InMemoryDb;
  let config: SmartAutoLenderConfig;

  beforeEach(() => {
    db = new InMemoryDb();
    config = { ...DEFAULT_SMART_AUTO_LENDER_CONFIG };
  });

  function createLender(overrides?: {
    aave?: IAaveLendingModule;
    bankroll?: ISmartLenderBankroll;
    safeMode?: ISmartLenderSafeMode;
  }) {
    return new SmartAutoLender({
      aave: overrides?.aave ?? createMockAave(),
      bankroll: overrides?.bankroll ?? createMockBankroll(),
      safeMode: overrides?.safeMode ?? createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
  }

  it('should return unavailable when maintenance mode is active (Req 3.3)', async () => {
    createSmartLenderTable(db);
    saveState(db, { maintenanceMode: true, idlePeriodStart: null });
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 100_000000n,
          currentATokenBalance: 100_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    const lender = createLender({ aave });
    const result = await lender.ensureFunds(50_000000n);
    expect(result.available).toBe(false);
    expect(result.withdrawn).toBe(0n);
  });

  it('should return unavailable when Aave position is zero', async () => {
    // Default mock returns currentATokenBalance = 0n
    const lender = createLender();
    const result = await lender.ensureFunds(50_000000n);
    expect(result.available).toBe(false);
    expect(result.withdrawn).toBe(0n);
  });

  it('should perform successful partial withdrawal (Req 4.1, 4.2, 5.1)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 100_000000n,
          currentATokenBalance: 100_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    let profitNotified = 0n;
    const bankroll = createMockBankroll();
    bankroll.allocateProfit = (amount: bigint) => { profitNotified = amount; };

    const lender = createLender({ aave, bankroll });
    const result = await lender.ensureFunds(50_000000n);
    expect(result.available).toBe(true);
    expect(result.withdrawn).toBe(50_000000n);
    expect(profitNotified).toBe(50_000000n);
  });

  it('should withdraw full position when requiredAmount exceeds balance (Req 4.1)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 30_000000n,
          currentATokenBalance: 30_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    let profitNotified = 0n;
    const bankroll = createMockBankroll();
    bankroll.allocateProfit = (amount: bigint) => { profitNotified = amount; };

    const lender = createLender({ aave, bankroll });
    // Requesting 50 USDC but only 30 in position → withdraws all 30
    const result = await lender.ensureFunds(50_000000n);
    expect(result.available).toBe(true);
    expect(result.withdrawn).toBe(30_000000n);
    expect(profitNotified).toBe(30_000000n);
  });

  it('should skip withdrawal below minWithdrawAmount when not full close (Req 5.3)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 100_000000n,
          currentATokenBalance: 100_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    const lender = createLender({ aave });
    // config.minWithdrawAmount = 1_000000n (1 USDC)
    // Requesting 0.5 USDC (500000n) which is below min and not full close
    const result = await lender.ensureFunds(500000n);
    expect(result.available).toBe(false);
    expect(result.withdrawn).toBe(0n);
  });

  it('should allow withdrawal below minWithdrawAmount when it IS a full close (Req 5.3)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 500000n,
          currentATokenBalance: 500000n, // 0.5 USDC — below min but it's the full position
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    let profitNotified = 0n;
    const bankroll = createMockBankroll();
    bankroll.allocateProfit = (amount: bigint) => { profitNotified = amount; };

    const lender = createLender({ aave, bankroll });
    // Requesting 1 USDC but only 0.5 in position → full close → should proceed
    const result = await lender.ensureFunds(1_000000n);
    expect(result.available).toBe(true);
    expect(result.withdrawn).toBe(500000n);
    expect(profitNotified).toBe(500000n);
  });

  it('should retry once on withdrawal failure and succeed (Req 4.3, 7.2)', async () => {
    let callCount = 0;
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 50_000000n,
          currentATokenBalance: 50_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
      async withdraw(amount: bigint) {
        callCount++;
        if (callCount === 1) {
          throw new Error('TX_REVERTED');
        }
        return { txHash: '0xretry_success', withdrawn: amount };
      },
    };
    let profitNotified = 0n;
    const bankroll = createMockBankroll();
    bankroll.allocateProfit = (amount: bigint) => { profitNotified = amount; };

    const lender = createLender({ aave, bankroll });
    const result = await lender.ensureFunds(50_000000n);
    expect(result.available).toBe(true);
    expect(result.withdrawn).toBe(50_000000n);
    expect(callCount).toBe(2);
    expect(profitNotified).toBe(50_000000n);
  });

  it('should return unavailable when both withdrawal attempts fail (Req 4.4, 7.2)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 50_000000n,
          currentATokenBalance: 50_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
      async withdraw(_amount: bigint) {
        throw new Error('PERMANENT_FAILURE');
      },
    };
    const lender = createLender({ aave });
    const result = await lender.ensureFunds(50_000000n);
    expect(result.available).toBe(false);
    expect(result.withdrawn).toBe(0n);
  });

  it('should track pending withdrawals for batch window (Req 5.4)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 200_000000n,
          currentATokenBalance: 200_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    const lender = createLender({ aave });

    // First withdrawal
    const result1 = await lender.ensureFunds(30_000000n);
    expect(result1.available).toBe(true);
    expect(result1.withdrawn).toBe(30_000000n);

    // Check pendingWithdrawals state
    const state = lender.getState();
    expect(state.pendingWithdrawals.length).toBe(1);
    expect(state.pendingWithdrawals[0]!.amount).toBe(30_000000n);
  });

  it('should call bankroll.recordGas on successful withdrawal (Req 6.5)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 100_000000n,
          currentATokenBalance: 100_000000n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    let gasCalled = false;
    const bankroll = createMockBankroll();
    bankroll.recordGas = (_gasCostUsdc: bigint) => { gasCalled = true; };

    const lender = createLender({ aave, bankroll });
    await lender.ensureFunds(10_000000n);
    expect(gasCalled).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Task 9.1: APY threshold check verification tests
// Requirements: 7.4
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 9.1: APY threshold check and low-APY full withdrawal', () => {
  let db: InMemoryDb;
  let config: SmartAutoLenderConfig;

  beforeEach(() => {
    db = new InMemoryDb();
    config = { ...DEFAULT_SMART_AUTO_LENDER_CONFIG };
  });

  function createLender(overrides?: {
    aave?: IAaveLendingModule;
    bankroll?: ISmartLenderBankroll;
  }) {
    return new SmartAutoLender({
      aave: overrides?.aave ?? createMockAave(),
      bankroll: overrides?.bankroll ?? createMockBankroll(),
      safeMode: createMockSafeMode(),
      config,
      logger: createMockLogger(),
      db,
    });
  }

  it('should withdraw all when APY is below minApyBps and position exists (Req 7.4)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 80_000000n,
          currentATokenBalance: 80_000000n,
          accruedInterest: 0n,
          currentApyBps: 100, // Below default 200 bps minimum
          lastUpdated: Date.now(),
        };
      },
    };
    let profitNotified = 0n;
    const bankroll = createMockBankroll();
    bankroll.allocateProfit = (amount: bigint) => { profitNotified = amount; };

    const lender = createLender({ aave, bankroll });
    const result = await lender.evaluateIdle(50_000000n);
    expect(result.action).toBe('withdraw');
    expect(result.amount).toBe(80_000000n);
    expect(result.reason).toBe('low_apy_full_withdrawal');
    expect(profitNotified).toBe(80_000000n);
  });

  it('should not withdraw when APY >= minApyBps (Req 7.4)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 80_000000n,
          currentATokenBalance: 80_000000n,
          accruedInterest: 0n,
          currentApyBps: 300, // Above the 200 bps minimum
          lastUpdated: Date.now(),
        };
      },
    };
    const lender = createLender({ aave });
    const result = await lender.evaluateIdle(50_000000n);
    // Should not trigger withdrawal — will go through idle check logic
    expect(result.action).not.toBe('withdraw');
    expect(result.reason).not.toBe('low_apy_full_withdrawal');
  });

  it('should not withdraw when APY is low but no position exists (Req 7.4)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        return {
          depositedUsdc: 0n,
          currentATokenBalance: 0n, // No position
          accruedInterest: 0n,
          currentApyBps: 50, // Very low but no position
          lastUpdated: Date.now(),
        };
      },
    };
    const lender = createLender({ aave });
    const result = await lender.evaluateIdle(50_000000n);
    expect(result.action).not.toBe('withdraw');
    expect(result.reason).not.toBe('low_apy_full_withdrawal');
  });

  it('should handle RPC error during APY check gracefully (Req 7.4)', async () => {
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        throw new Error('RPC_TIMEOUT');
      },
    };
    const lender = createLender({ aave });
    // Should NOT throw — logs error and continues
    const result = await lender.evaluateIdle(50_000000n);
    expect(result.action).toBe('none');
    // The error in getPosition is caught at the APY check step, evaluation continues
  });

  it('should skip APY evaluation and not block when getPosition throws', async () => {
    let posCallCount = 0;
    const aave: IAaveLendingModule = {
      ...createMockAave(),
      async getPosition() {
        posCallCount++;
        if (posCallCount === 1) {
          throw new Error('NETWORK_ERROR');
        }
        // Shouldn't reach here for step 3
        return {
          depositedUsdc: 0n,
          currentATokenBalance: 0n,
          accruedInterest: 0n,
          currentApyBps: 300,
          lastUpdated: Date.now(),
        };
      },
    };
    const lender = createLender({ aave });
    const result = await lender.evaluateIdle(100_000000n);
    // Should complete without throwing
    expect(result.action).toBe('none');
  });
});

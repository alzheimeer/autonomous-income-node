/**
 * Unit tests for Phase Initialization and Aave State Verification
 *
 * Tests the phase initialization sequence including:
 * - DB integrity check
 * - Aave withdrawal verification (aUSDC = 0)
 * - USDC balance verification
 * - AutoLender disable
 * - BankrollManager initialization
 * - Config hash computation and storage
 * - Withdrawal execution flow (when not already done)
 *
 * Requirements: 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 1.1, 1.2, 34.1
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  initializePhase,
  isAutoLenderDisabled,
  getStoredConfigHash,
  createBankrollManager,
  type IPhaseInitProvider,
  type IPhaseInitLogger,
  type IPhaseInitAlerter,
} from '../../phase-init.js';
import type { IPreTradeSimulator, SimulationResult } from '../../pre-trade-simulator.js';
import type { ITransactionManager, IntentParams } from '../../transaction-manager.js';
import type { TradingValidationConfig } from '../../config.js';
import type { TransactionIntent } from '../../types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

const WALLET_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

/** Minimal config for testing */
function createTestConfig(overrides?: Partial<TradingValidationConfig>): TradingValidationConfig {
  return {
    mode: 'shadow',
    configHash: '',
    bankroll: {
      initialTotal: 99_630000n,
      initialActive: 25_000000n,
      initialReserve: 74_630000n,
      minActive: 5_000000n,
      sweepThresholdPct: 0.20,
      sweepMinExcess: 5_000000n,
      lowTotalThreshold: 80_000000n,
    },
    risk: {
      maxTradeUsdc: 10_000000n,
      maxExposureUsdc: 25_000000n,
      maxPositions: 1,
      maxTradesDay: 3,
      maxFailedTxDay: 3,
      maxDailyLossUsdc: 3_000000n,
      maxExperimentLoss: 10_000000n,
    },
    gate: {
      minNetProfitUsdc: 80000n,
      minNetProfitBps: 50,
      safetyMarginBps: 20,
      maxQuoteAgeMs: 10_000,
      sanityMaxProfitPct: 0.50,
      maxSlippageBps: 40,
      maxPriceImpactBps: 30,
      minLiquidity: 50_000,
      discretionaryMaxGas: 50000n,
      hasPrivateRpc: false,
    },
    strategy: {
      pair: 'WETH/USDC',
      regimeTimeframe: '1h',
      entryTimeframe: '15m',
      stopLossAtr: 1.5,
      takeProfitAtr: 2.0,
      cooldownMs: 3_600_000,
      warmup1h: 300,
      warmup15m: 500,
      meanRevAtrMax: 2.5,
      minLiquidity: 50_000,
      volumeZThreshold: 1.0,
    },
    marketData: {
      wsUrl: 'wss://stream.binance.com:9443/ws',
      restUrl: 'https://api.binance.com/api/v3',
      restPollingMs: 10_000,
      staleThresholdMs: 90_000,
      priceMoveTriggerAtrPct: 0.5,
      volumeZTrigger: 2.0,
      maxEvalPerHour: 20,
      debounceMs: 60_000,
    },
    quoteEngine: {
      quoterV2Address: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      swapRouterAddress: '0x2626664c2603336E57B271c5C0b26F421741e481',
      usdcAddress: USDC_ADDRESS,
      wethAddress: '0x4200000000000000000000000000000000000006',
      feeTier: 500,
      quoteTtlMs: 10_000,
      basisAlertBps: 100,
    },
    txManager: {
      walletAddress: WALLET_ADDRESS,
      timeoutMs: 300_000,
      maxFailedTxDay: 3,
      contractAllowlist: [USDC_ADDRESS, AAVE_POOL],
    },
    positionSizer: {
      maxRiskPerTrade: 500000n,
      maxRiskPctBankroll: 0.005,
      minTradeSize: 5_000000n,
      maxTradeSize: 10_000000n,
      minStopFraction: 0.001,
    },
    exitManager: {
      stopLossAtr: 1.5,
      takeProfitAtr: 2.0,
      maxHoldingMs: 28_800_000,
      safetyExitMaxGas: 100000n,
      maxExitRetries: 2,
    },
    gasReserve: {
      minReserveEth: 5_000_000_000_000_000n,
      criticalReserveEth: 2_000_000_000_000_000n,
      cyclesRequired: 2,
    },
    reconciliation: {
      confirmationBlocks: 1,
      maxRetries: 3,
      retryBackoffMs: 1000,
      mismatchesForKillSwitch: 3,
    },
    experiment: {
      configHash: '',
      shadowPassMinTrades: 10,
      shadowPassTargetTrades: 20,
      shadowPassDays: 7,
      microPassMinTrades: 20,
      microPassProfitFactor: 1.2,
      microPassMaxDrawdown: 10_000000n,
      microPassMaxFailedRate: 0.10,
      microPassMaxSlippageDev: 1.5,
    },
    aiBudget: {
      globalHardCapDay: 0.20,
      tradingBudgetDay: 0.10,
      servicesBudgetDay: 0.05,
      researchBudgetDay: 0.00,
      diagnosticsBudgetDay: 0.02,
      sonnetMinProfit: 150000n,
    },
    contracts: {
      usdc: USDC_ADDRESS,
      weth: '0x4200000000000000000000000000000000000006',
      swapRouter: '0x2626664c2603336E57B271c5C0b26F421741e481',
      quoterV2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
      aavePool: AAVE_POOL,
      aUsdc: '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB',
      allowlist: [USDC_ADDRESS, AAVE_POOL],
    },
    alerts: {
      telegramChatId: '12345',
      nonCriticalMaxPerHour: 10,
      deviationThresholdPct: 0.50,
      deviationThresholdUsdc: 30000n,
      consecutiveDeviationsForSafe: 3,
    },
    ...overrides,
  } as TradingValidationConfig;
}

function createMockProvider(opts?: {
  aUsdcBalance?: bigint;
  usdcBalance?: bigint;
  ethBalance?: bigint;
  wethBalance?: bigint;
}): IPhaseInitProvider {
  return {
    getAUsdcBalance: vi.fn().mockResolvedValue(opts?.aUsdcBalance ?? 0n),
    getUsdcBalance: vi.fn().mockResolvedValue(opts?.usdcBalance ?? 99_630000n),
    getEthBalance: vi.fn().mockResolvedValue(opts?.ethBalance ?? 10_000_000_000_000_000n),
    getWethBalance: vi.fn().mockResolvedValue(opts?.wethBalance ?? 0n),
  };
}

function createMockSimulator(opts?: {
  simulationSuccess?: boolean;
  gasUsed?: bigint;
  withinBudget?: boolean;
}): IPreTradeSimulator {
  return {
    simulateApproval: vi.fn().mockResolvedValue({
      success: true,
      gasUsed: 50_000n,
    }),
    simulateSwap: vi.fn().mockResolvedValue({
      success: true,
      gasUsed: 150_000n,
    }),
    simulateWithdrawal: vi.fn().mockResolvedValue({
      success: opts?.simulationSuccess ?? true,
      gasUsed: opts?.gasUsed ?? 200_000n,
      revertReason: opts?.simulationSuccess === false ? 'InsufficientBalance' : undefined,
    } satisfies SimulationResult),
    isWithinGasBudget: vi.fn().mockResolvedValue(opts?.withinBudget ?? true),
    hasQuoteDrifted: vi.fn().mockReturnValue(false),
  };
}

function createMockTxManager(confirmedIntent?: Partial<TransactionIntent>): ITransactionManager {
  const defaultIntent: TransactionIntent = {
    id: 'init-aave-withdrawal-123',
    state: 'confirmed',
    nonce: 0,
    txHash: '0xabc123',
    contractAddress: AAVE_POOL,
    functionName: 'withdraw',
    gasLimit: 260_000n,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    blockNumber: 12345,
    ...confirmedIntent,
  };

  return {
    submitIntent: vi.fn().mockResolvedValue(defaultIntent),
    getIntent: vi.fn().mockReturnValue(null),
    cancelIntent: vi.fn(),
    speedUpIntent: vi.fn(),
    getFailedTxCountToday: vi.fn().mockReturnValue(0),
    checkAllowance: vi.fn().mockResolvedValue(0n),
    ensureApproval: vi.fn().mockResolvedValue(null),
    getNextNonce: vi.fn().mockReturnValue(0),
    getPendingIntent: vi.fn().mockReturnValue(null),
    isAllowlisted: vi.fn().mockReturnValue(true),
  };
}

function createMockLogger(): IPhaseInitLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockAlerter(): IPhaseInitAlerter {
  return {
    sendAlert: vi.fn().mockResolvedValue(undefined),
  };
}

/** Creates a minimal in-memory mock DB that supports the operations in phase-init */
function createMockDb() {
  const store: Record<string, unknown[]> = {
    event_log: [],
  };
  let phaseRow: Record<string, unknown> | null = null;

  return {
    pragma: vi.fn().mockReturnValue([{ integrity_check: 'ok' }]),
    prepare: vi.fn().mockImplementation((sql: string) => {
      return {
        run: vi.fn().mockImplementation((...args: unknown[]) => {
          if (sql.includes('INSERT INTO event_log')) {
            store.event_log.push({ args });
          } else if (sql.includes('INSERT INTO trading_phase')) {
            phaseRow = {
              id: 1,
              mode: args[0],
              config_hash: args[1],
              started_at: args[2],
              auto_lender_disabled: 1,
              updated_at: args[3],
            };
          } else if (sql.includes('UPDATE trading_phase')) {
            if (phaseRow) {
              if (sql.includes('auto_lender_disabled = 1, updated_at')) {
                phaseRow.auto_lender_disabled = 1;
                phaseRow.updated_at = args[0];
              } else if (sql.includes('mode = ?')) {
                phaseRow.mode = args[0];
                phaseRow.config_hash = args[1];
                phaseRow.updated_at = args[2];
              }
            }
          } else if (sql.includes('INSERT INTO bankroll')) {
            // Bankroll initialization
          }
          return { changes: 1 };
        }),
        get: vi.fn().mockImplementation(() => {
          if (sql.includes('SELECT id FROM trading_phase')) {
            return phaseRow ? { id: 1 } : undefined;
          }
          if (sql.includes('SELECT auto_lender_disabled')) {
            return phaseRow ? { auto_lender_disabled: phaseRow.auto_lender_disabled } : undefined;
          }
          if (sql.includes('SELECT config_hash')) {
            return phaseRow ? { config_hash: phaseRow.config_hash } : undefined;
          }
          if (sql.includes('SELECT id FROM bankroll')) {
            return undefined; // BankrollManager will seed
          }
          if (sql.includes('SELECT * FROM bankroll')) {
            return {
              total_usdc: '99630000',
              active_usdc: '25000000',
              reserve_usdc: '74630000',
              daily_realized_pnl: '0',
              daily_gas_spent: '0',
              experiment_total_pnl: '0',
              day_start_bankroll: '99630000',
              day_utc: new Date().toISOString().slice(0, 10),
              updated_at: Date.now(),
            };
          }
          return undefined;
        }),
      };
    }),
    _store: store,
    _getPhaseRow: () => phaseRow,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests: DB Integrity Check
// ═══════════════════════════════════════════════════════════════════════════

describe('Phase Initialization', () => {
  let config: TradingValidationConfig;
  let logger: IPhaseInitLogger;
  let alerter: IPhaseInitAlerter;

  beforeEach(() => {
    config = createTestConfig();
    logger = createMockLogger();
    alerter = createMockAlerter();
  });

  describe('DB Integrity Check (Req 34.1)', () => {
    it('should fail initialization if integrity check fails', async () => {
      const db = createMockDb();
      db.pragma.mockReturnValue([{ integrity_check: 'corrupted page' }]);

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        createMockProvider(),
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.success).toBe(false);
      expect(result.dbIntegrityOk).toBe(false);
      expect(result.error).toContain('integrity check failed');
      expect(alerter.sendAlert).toHaveBeenCalledWith(
        expect.stringContaining('integrity check failed'),
        true,
      );
    });

    it('should pass when integrity check returns ok', async () => {
      const db = createMockDb();
      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        createMockProvider(),
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.dbIntegrityOk).toBe(true);
    });

    it('should handle integrity check throwing an error', async () => {
      const db = createMockDb();
      db.pragma.mockImplementation(() => { throw new Error('DB locked'); });

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        createMockProvider(),
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.success).toBe(false);
      expect(result.dbIntegrityOk).toBe(false);
    });
  });

  describe('Aave State Verification (Req 0.2)', () => {
    it('should detect withdrawal already completed (aUSDC = 0)', async () => {
      const provider = createMockProvider({ aUsdcBalance: 0n, usdcBalance: 99_630000n });
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.success).toBe(true);
      expect(result.withdrawalAlreadyDone).toBe(true);
      expect(result.withdrawalExecuted).toBe(false);
    });

    it('should execute withdrawal when aUSDC > 0', async () => {
      // First call: initial check in initializePhase (non-zero)
      // Second call: post-withdrawal check INSIDE executeAaveWithdrawal
      // Third call: post-withdrawal verification in initializePhase (Step 5)
      const provider = createMockProvider({ usdcBalance: 99_630000n });
      const getAUsdcMock = vi.fn()
        .mockResolvedValueOnce(50_000000n) // Initial check: not withdrawn
        .mockResolvedValueOnce(0n)         // Inside executeAaveWithdrawal: Step D
        .mockResolvedValueOnce(0n);        // Back in initializePhase: Step 5
      provider.getAUsdcBalance = getAUsdcMock;

      const db = createMockDb();
      const txManager = createMockTxManager();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        txManager,
        logger,
        alerter,
      );

      expect(result.success).toBe(true);
      expect(result.withdrawalAlreadyDone).toBe(false);
      expect(result.withdrawalExecuted).toBe(true);
      expect(txManager.submitIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          contractAddress: AAVE_POOL,
          functionName: 'withdraw',
          operationType: 'withdrawal',
        }),
      );
    });

    it('should fail if aUSDC still non-zero after withdrawal', async () => {
      const provider = createMockProvider();
      const getAUsdcMock = vi.fn()
        .mockResolvedValueOnce(50_000000n) // Initial: not withdrawn
        .mockResolvedValueOnce(50_000000n); // Inside executeAaveWithdrawal: still not zero
      provider.getAUsdcBalance = getAUsdcMock;

      const db = createMockDb();
      const txManager = createMockTxManager({
        state: 'confirmed',
        txHash: '0xfail',
      });

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        txManager,
        logger,
        alerter,
      );

      // The withdrawal was confirmed but aUSDC still not zero → error from within executeAaveWithdrawal
      expect(result.success).toBe(false);
      expect(result.error).toContain('aUSDC not zero');
    });
  });

  describe('USDC Balance Verification (Req 0.3)', () => {
    it('should pass when USDC balance >= expected minus gas', async () => {
      const provider = createMockProvider({ usdcBalance: 99_630000n });
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.success).toBe(true);
      expect(result.verifiedUsdcBalance).toBe(99_630000n);
    });

    it('should pass when USDC exceeds expected (interest accrual)', async () => {
      const provider = createMockProvider({ usdcBalance: 99_700000n });
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.success).toBe(true);
      expect(result.verifiedUsdcBalance).toBe(99_700000n);
    });

    it('should fail when USDC balance below expected minus gas', async () => {
      // Expected min = 99_630000 - 100_000 = 99_530000
      const provider = createMockProvider({ usdcBalance: 90_000000n });
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('USDC balance');
      expect(result.error).toContain('below expected minimum');
    });
  });

  describe('Simulation Failure (Req 0.5)', () => {
    it('should not broadcast if simulation fails', async () => {
      const provider = createMockProvider({ aUsdcBalance: 50_000000n });
      // Second call after the failed path won't happen since we return early
      const simulator = createMockSimulator({ simulationSuccess: false });
      const txManager = createMockTxManager();
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        simulator,
        txManager,
        logger,
        alerter,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('simulation failed');
      expect(txManager.submitIntent).not.toHaveBeenCalled();
      expect(alerter.sendAlert).toHaveBeenCalled();
    });

    it('should not broadcast if gas exceeds init budget', async () => {
      const provider = createMockProvider({ aUsdcBalance: 50_000000n });
      const simulator = createMockSimulator({ withinBudget: false });
      const txManager = createMockTxManager();
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        simulator,
        txManager,
        logger,
        alerter,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('gas exceeds init budget');
      expect(txManager.submitIntent).not.toHaveBeenCalled();
    });
  });

  describe('AutoLender Disable (Req 1.1, 1.2)', () => {
    it('should set auto_lender_disabled = 1 during init', async () => {
      const provider = createMockProvider();
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.success).toBe(true);
      // Verify the phase row was created with auto_lender_disabled
      const phaseRow = db._getPhaseRow();
      expect(phaseRow).not.toBeNull();
      expect(phaseRow?.auto_lender_disabled).toBe(1);
    });
  });

  describe('Config Hash (Req 25.1)', () => {
    it('should compute and return a non-empty config hash', async () => {
      const provider = createMockProvider();
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      expect(result.success).toBe(true);
      expect(result.configHash).toBeTruthy();
      expect(result.configHash.length).toBe(64); // SHA-256 hex
    });

    it('should store config hash in phase state', async () => {
      const provider = createMockProvider();
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      const phaseRow = db._getPhaseRow();
      expect(phaseRow?.config_hash).toBe(result.configHash);
    });
  });

  describe('Withdrawal Recording (Req 0.4)', () => {
    it('should record withdrawal event in SQLite event_log', async () => {
      const provider = createMockProvider({ usdcBalance: 99_630000n });
      const getAUsdcMock = vi.fn()
        .mockResolvedValueOnce(50_000000n) // Initial check
        .mockResolvedValueOnce(0n)         // Inside executeAaveWithdrawal: Step D
        .mockResolvedValueOnce(0n);        // Back in initializePhase: Step 5
      provider.getAUsdcBalance = getAUsdcMock;

      const db = createMockDb();

      await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        createMockTxManager(),
        logger,
        alerter,
      );

      // Check that event_log insert was called for withdrawal
      const eventLogCalls = db._store.event_log;
      expect(eventLogCalls.length).toBeGreaterThan(0);
    });
  });

  describe('Withdrawal Reverted Intent (Req 0.6)', () => {
    it('should fail if withdrawal intent reverts', async () => {
      const provider = createMockProvider({ aUsdcBalance: 50_000000n });
      const txManager = createMockTxManager({
        state: 'reverted',
        revertReason: 'InsufficientBalance',
      });
      const db = createMockDb();

      const result = await initializePhase(
        db as unknown as import('../../db.js').TradingDatabase,
        config,
        provider,
        createMockSimulator(),
        txManager,
        logger,
        alerter,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('reverted');
      expect(alerter.sendAlert).toHaveBeenCalled();
    });
  });

  describe('Helper Functions', () => {
    it('isAutoLenderDisabled returns false when no row exists', () => {
      const db = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(undefined),
        }),
      };
      expect(isAutoLenderDisabled(db as unknown as import('../../db.js').TradingDatabase)).toBe(false);
    });

    it('isAutoLenderDisabled returns true when flag is 1', () => {
      const db = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({ auto_lender_disabled: 1 }),
        }),
      };
      expect(isAutoLenderDisabled(db as unknown as import('../../db.js').TradingDatabase)).toBe(true);
    });

    it('getStoredConfigHash returns null when no row exists', () => {
      const db = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue(undefined),
        }),
      };
      expect(getStoredConfigHash(db as unknown as import('../../db.js').TradingDatabase)).toBeNull();
    });

    it('getStoredConfigHash returns hash when row exists', () => {
      const db = {
        prepare: vi.fn().mockReturnValue({
          get: vi.fn().mockReturnValue({ config_hash: 'abc123' }),
        }),
      };
      expect(getStoredConfigHash(db as unknown as import('../../db.js').TradingDatabase)).toBe('abc123');
    });
  });
});

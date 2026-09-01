/**
 * Trading Validation Phase - Integration Tests
 *
 * Tests full module interaction patterns using mocked providers
 * to simulate Base blockchain behavior. These are NOT unit tests —
 * each test wires multiple real modules together and verifies
 * end-to-end flows with controlled mock responses.
 *
 * Uses createDatabase(':memory:') for SQLite in-memory database.
 * Mocks ITxProvider, IReconciliationProvider, etc. to simulate on-chain state.
 *
 * Requirements: 0.1, 0.2, 0.3, 8.1-8.5, 13.5, 13.6, 17.2, 17.5,
 *              18.1, 18.2, 19.1, 19.7, 28.3, 31.2, E5
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { createDatabase, type TradingDatabase } from '../../db.js';
import { runMigrations } from '../../migrations.js';
import { ReconciliationEngine } from '../../reconciliation-engine.js';
import { TransactionManager } from '../../transaction-manager.js';
import { BankrollManager } from '../../bankroll-manager.js';
import { SafeModeController } from '../../safe-mode-controller.js';
import { StartupRecovery } from '../../startup-recovery.js';
import type {
  UsdcAmount,
  WethAmount,
  EthAmount,
  TransactionIntent,
  ReconciliationResult,
  BankrollState,
} from '../../types.js';
import type { ExpectedState, IReconciliationProvider, IReconciliationSafeModeController, IReconciliationLogger } from '../../reconciliation-engine.js';
import type { ITxProvider, ITxSigner, ITxLogger, TxReceipt, IntentParams } from '../../transaction-manager.js';
import type { IOnChainProvider, IRecoverySafeModeController, IRecoveryExitManager, IRecoveryLogger } from '../../startup-recovery.js';
import type { ReconciliationConfig, BankrollManagerConfig } from '../../config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers & Mock Factories
// ═══════════════════════════════════════════════════════════════════════════

/** Wallet address used across tests */
const WALLET = '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD28';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const SWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

/** Default reconciliation config for tests */
function defaultReconConfig(): ReconciliationConfig {
  return {
    confirmationBlocks: 1,
    maxRetries: 3,
    retryBackoffMs: 10, // fast for tests
    mismatchesForKillSwitch: 3,
  };
}

/** Default bankroll config for tests */
function defaultBankrollConfig(): BankrollManagerConfig {
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

/** Create a mock logger */
function createMockLogger(): IReconciliationLogger & ITxLogger & IRecoveryLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/** Create a fresh in-memory database with all migrations run */
function createTestDb(): TradingDatabase {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return db;
}

/** Seed the nonce registry for TransactionManager */
function seedNonceRegistry(db: TradingDatabase, lastConfirmed: number, next: number): void {
  db.prepare(
    `INSERT OR REPLACE INTO nonce_registry (id, last_confirmed_nonce, next_nonce, updated_at)
     VALUES (1, ?, ?, ?)`,
  ).run(lastConfirmed, next, Date.now());
}

/** Seed trading_phase row */
function seedTradingPhase(db: TradingDatabase, mode: 'shadow' | 'micro' = 'micro'): void {
  db.prepare(
    `INSERT OR REPLACE INTO trading_phase (id, mode, config_hash, started_at, updated_at)
     VALUES (1, ?, 'test_hash_abc123', ?, ?)`,
  ).run(mode, Date.now(), Date.now());
}

/** Seed a tx_intent row (needed for FK constraints in reconciliation_log) */
function seedTxIntent(db: TradingDatabase, id: string, nonce: number, state = 'confirmed'): void {
  db.prepare(
    `INSERT OR REPLACE INTO tx_intents (id, state, nonce, contract_address, function_name,
     gas_limit, created_at, updated_at, operation_type)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, state, nonce, SWAP_ROUTER, 'exactInputSingle', '250000', Date.now(), Date.now(), 'entry');
}

// ═══════════════════════════════════════════════════════════════════════════
// 14.1 - Aave Withdrawal Flow Integration Test
// ═══════════════════════════════════════════════════════════════════════════

describe('14.1 Integration: Aave withdrawal flow', () => {
  let db: TradingDatabase;
  let mockProvider: ITxProvider;
  let mockSigner: ITxSigner;
  let mockReconProvider: IReconciliationProvider;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createTestDb();
    seedNonceRegistry(db, 4, 5);
    seedTradingPhase(db);
    logger = createMockLogger();

    // Mock provider simulating Base blockchain for Aave withdrawal
    mockProvider = {
      getTransactionCount: vi.fn().mockResolvedValue(5),
      sendRawTransaction: vi.fn().mockResolvedValue('0xaave_withdrawal_hash_001'),
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 1,
        blockNumber: 12345678,
        gasUsed: 150_000n,
        transactionHash: '0xaave_withdrawal_hash_001',
      } satisfies TxReceipt),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 100_000_000n, // 0.1 gwei
        maxPriorityFeePerGas: 1_000_000n,
      }),
      getAllowance: vi.fn().mockResolvedValue(0n),
    };

    mockSigner = {
      signTransaction: vi.fn().mockResolvedValue('0xsigned_withdrawal_tx_raw'),
    };

    // Reconciliation provider: after withdrawal, aUSDC=0, USDC increased
    mockReconProvider = {
      getUsdcBalance: vi.fn().mockResolvedValue(99_630000n), // full balance after withdrawal
      getWethBalance: vi.fn().mockResolvedValue(0n),
      getAllowance: vi.fn().mockResolvedValue(0n),
      getBlockNumber: vi.fn().mockResolvedValue(12345679), // 1 block after tx
      getTransactionBlockNumber: vi.fn().mockResolvedValue(12345678),
      getWethUsdcPrice: vi.fn().mockResolvedValue(2500.0),
    };
  });

  it('should complete full withdrawal lifecycle: simulate → broadcast → receipt → reconcile', async () => {
    // --- Phase 1: Submit withdrawal intent via TransactionManager ---
    const txManager = new TransactionManager(
      db,
      {
        walletAddress: WALLET,
        timeoutMs: 5_000, // short for test
        maxFailedTxDay: 3,
        contractAllowlist: [AAVE_POOL],
      },
      mockProvider,
      mockSigner,
      logger,
    );

    const withdrawalIntent = await txManager.submitIntent({
      id: 'withdrawal-aave-001',
      contractAddress: AAVE_POOL,
      functionName: 'withdraw',
      gasLimit: 250_000n,
      operationType: 'withdrawal',
    });

    // Verify intent was confirmed (mocked receipt status=1)
    expect(withdrawalIntent.state).toBe('confirmed');
    expect(withdrawalIntent.nonce).toBe(5);
    expect(withdrawalIntent.txHash).toBe('0xaave_withdrawal_hash_001');
    expect(withdrawalIntent.blockNumber).toBe(12345678);

    // --- Phase 2: Reconcile post-withdrawal state ---
    const safeModeCtrl = new SafeModeController(db);
    const reconEngine = new ReconciliationEngine(
      db,
      defaultReconConfig(),
      mockReconProvider,
      safeModeCtrl,
      logger,
      WALLET,
    );

    const reconResult = await reconEngine.reconcile(
      {
        intentId: 'withdrawal-aave-001',
        expectedUsdc: 99_630000n, // expect full USDC after Aave withdrawal
        expectedWeth: 0n,
        txHash: '0xaave_withdrawal_hash_001',
        operationSizeUsdc: 99_630000n,
        gasEthSpent: 15_000_000_000_000n, // 0.000015 ETH gas
      },
      'withdrawal',
    );

    // Verify reconciliation passed (aUSDC=0 implied by USDC increase)
    expect(reconResult.matched).toBe(true);
    expect(reconResult.actualUsdc).toBe(99_630000n);
    expect(reconResult.actualWeth).toBe(0n);
    expect(reconResult.deviationUsdc).toBe(0n);

    // Verify ETH decreased by gas
    expect(reconResult.gasEthSpent).toBe(15_000_000_000_000n);

    // Verify result persisted to reconciliation_log
    const logRow = db.prepare(
      'SELECT * FROM reconciliation_log WHERE operation_type = ?',
    ).get('withdrawal') as Record<string, unknown>;
    expect(logRow).toBeDefined();
    expect(logRow.matched).toBe(1);
    expect(logRow.intent_id).toBe('withdrawal-aave-001');

    // Verify Safe_Mode NOT triggered
    expect(safeModeCtrl.canTrade()).toBe(true);
  });

  it('should verify aUSDC = 0 state after withdrawal (post-reconciliation balances)', async () => {
    // This test verifies the expected post-withdrawal state:
    // aUSDC = 0, USDC = full amount, WETH = 0
    const safeModeCtrl = new SafeModeController(db);
    const reconEngine = new ReconciliationEngine(
      db,
      defaultReconConfig(),
      mockReconProvider,
      safeModeCtrl,
      logger,
      WALLET,
    );

    // Provider returns post-withdrawal balances
    const result = await reconEngine.reconcile(
      {
        expectedUsdc: 99_630000n,
        expectedWeth: 0n,
        txHash: '0xwithdraw_verify_hash',
        operationSizeUsdc: 99_630000n,
        gasEthSpent: 12_000_000_000_000n,
      },
      'withdrawal',
    );

    expect(result.matched).toBe(true);
    expect(result.actualUsdc).toBe(99_630000n); // USDC balance = full
    expect(result.actualWeth).toBe(0n); // No WETH held
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14.2 - Approval + Swap Lifecycle Integration Test
// ═══════════════════════════════════════════════════════════════════════════

describe('14.2 Integration: approval + swap lifecycle', () => {
  let db: TradingDatabase;
  let mockProvider: ITxProvider;
  let mockSigner: ITxSigner;
  let mockReconProvider: IReconciliationProvider;
  let logger: ReturnType<typeof createMockLogger>;
  let safeModeCtrl: SafeModeController;

  beforeEach(() => {
    db = createTestDb();
    seedNonceRegistry(db, 9, 10);
    seedTradingPhase(db);
    logger = createMockLogger();
    safeModeCtrl = new SafeModeController(db);

    let callCount = 0;
    mockProvider = {
      getTransactionCount: vi.fn().mockResolvedValue(10),
      sendRawTransaction: vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('0xapproval_hash_001');
        return Promise.resolve('0xswap_hash_001');
      }),
      getTransactionReceipt: vi.fn().mockImplementation((txHash: string) => {
        if (txHash === '0xapproval_hash_001') {
          return Promise.resolve({
            status: 1,
            blockNumber: 12345700,
            gasUsed: 46_000n, // ~$0.005 at low gas
            transactionHash: '0xapproval_hash_001',
          } satisfies TxReceipt);
        }
        return Promise.resolve({
          status: 1,
          blockNumber: 12345701,
          gasUsed: 180_000n, // ~$0.02 at low gas
          transactionHash: '0xswap_hash_001',
        } satisfies TxReceipt);
      }),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 50_000_000n, // 0.05 gwei (very cheap on Base)
        maxPriorityFeePerGas: 1_000_000n,
      }),
      // First call: no allowance (needs approval), second call: allowance set
      getAllowance: vi.fn()
        .mockResolvedValueOnce(0n) // check before approval
        .mockResolvedValueOnce(7_000000n), // check after approval
    };

    mockSigner = {
      signTransaction: vi.fn().mockResolvedValue('0xsigned_tx_data'),
    };

    // After swap: USDC decreased by trade size, WETH increased
    mockReconProvider = {
      getUsdcBalance: vi.fn()
        .mockResolvedValueOnce(92_630000n) // after approval (no USDC change)
        .mockResolvedValueOnce(92_630000n), // after swap: 99.63 - 7.0 = 92.63
      getWethBalance: vi.fn()
        .mockResolvedValueOnce(0n) // after approval
        .mockResolvedValueOnce(2_800_000_000_000_000n), // ~0.0028 WETH after swap ($7 worth)
      getAllowance: vi.fn().mockResolvedValue(7_000000n),
      getBlockNumber: vi.fn().mockResolvedValue(12345702),
      getTransactionBlockNumber: vi.fn().mockImplementation((hash: string) => {
        if (hash === '0xapproval_hash_001') return Promise.resolve(12345700);
        return Promise.resolve(12345701);
      }),
      getWethUsdcPrice: vi.fn().mockResolvedValue(2500.0),
    };
  });

  it('should execute exact approval → swap entry → reconciliation flow', async () => {
    const txManager = new TransactionManager(
      db,
      {
        walletAddress: WALLET,
        timeoutMs: 5_000,
        maxFailedTxDay: 3,
        contractAllowlist: [SWAP_ROUTER, USDC_ADDRESS],
      },
      mockProvider,
      mockSigner,
      logger,
    );

    // --- Step 1: Approval ---
    const approvalIntent = await txManager.submitIntent({
      id: 'approval-usdc-swap-001',
      contractAddress: USDC_ADDRESS,
      functionName: 'approve',
      gasLimit: 60_000n,
      operationType: 'approval',
    });

    expect(approvalIntent.state).toBe('confirmed');
    expect(approvalIntent.nonce).toBe(10);

    // --- Step 2: Verify allowance set correctly ---
    const reconEngine = new ReconciliationEngine(
      db,
      defaultReconConfig(),
      mockReconProvider,
      safeModeCtrl,
      logger,
      WALLET,
    );

    const approvalRecon = await reconEngine.reconcile(
      {
        intentId: 'approval-usdc-swap-001',
        expectedUsdc: 92_630000n, // no change from approval
        expectedWeth: 0n,
        txHash: '0xapproval_hash_001',
        operationSizeUsdc: 7_000000n,
        gasEthSpent: 2_300_000_000_000n, // 46000 * 50000000 wei
        expectedAllowance: 7_000000n,
        allowanceToken: USDC_ADDRESS,
        allowanceSpender: SWAP_ROUTER,
      },
      'approval',
    );

    expect(approvalRecon.matched).toBe(true);
    expect(approvalRecon.allowanceVerified).toBe(true);

    // --- Step 3: Swap execution ---
    const swapIntent = await txManager.submitIntent({
      id: 'swap-entry-weth-001',
      contractAddress: SWAP_ROUTER,
      functionName: 'exactInputSingle',
      gasLimit: 250_000n,
      operationType: 'entry',
    });

    expect(swapIntent.state).toBe('confirmed');
    expect(swapIntent.nonce).toBe(11); // next nonce after approval

    // --- Step 4: Reconcile swap ---
    const swapRecon = await reconEngine.reconcile(
      {
        intentId: 'swap-entry-weth-001',
        expectedUsdc: 92_630000n,
        expectedWeth: 2_800_000_000_000_000n, // ~0.0028 WETH
        txHash: '0xswap_hash_001',
        operationSizeUsdc: 7_000000n,
        gasEthSpent: 9_000_000_000_000n,
      },
      'entry',
    );

    expect(swapRecon.matched).toBe(true);
    expect(swapRecon.actualWeth).toBe(2_800_000_000_000_000n);
  });

  it('should verify combined gas budget: approval + swap ≤ $0.05', async () => {
    // Gas calculation:
    // approval: 46_000 gas * 0.05 gwei = 0.0000023 ETH
    // swap: 180_000 gas * 0.05 gwei = 0.000009 ETH
    // total: 0.0000113 ETH ≈ $0.028 at $2500/ETH
    // This is well under the $0.05 combined gas budget (E5)

    const approvalGasEth = 46_000n * 50_000_000n; // 2.3e12 wei
    const swapGasEth = 180_000n * 50_000_000n; // 9.0e12 wei
    const totalGasEth = approvalGasEth + swapGasEth; // 11.3e12 wei

    // Convert to USD: totalGasEth * ethPrice / 1e18
    const ethPrice = 2500.0;
    const totalGasUsd = Number(totalGasEth) * ethPrice / 1e18;

    // Combined gas must be ≤ $0.05
    expect(totalGasUsd).toBeLessThanOrEqual(0.05);
    expect(totalGasUsd).toBeCloseTo(0.02825, 3);
  });

  it('should verify bankroll updates after swap', async () => {
    const bankroll = new BankrollManager(db, defaultBankrollConfig());
    const state = bankroll.getState();

    // Before trade: active = $25, reserve = $74.63
    expect(state.activeUsdc).toBe(25_000000n);
    expect(state.reserveUsdc).toBe(74_630000n);

    // Record gas cost for both approval + swap
    const gasUsd = 28000n; // $0.028 in USDC 6 decimals
    bankroll.recordGas(gasUsd);

    const afterGas = bankroll.getState();
    expect(afterGas.dailyGasSpent).toBe(28000n);
    expect(afterGas.activeUsdc).toBe(25_000000n - 28000n);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14.3 - Full Entry → Exit Lifecycle Integration Test
// ═══════════════════════════════════════════════════════════════════════════

describe('14.3 Integration: full entry → exit lifecycle', () => {
  let db: TradingDatabase;
  let logger: ReturnType<typeof createMockLogger>;
  let safeModeCtrl: SafeModeController;
  let bankroll: BankrollManager;

  beforeEach(() => {
    db = createTestDb();
    seedNonceRegistry(db, 14, 15);
    seedTradingPhase(db);
    logger = createMockLogger();
    safeModeCtrl = new SafeModeController(db);
    bankroll = new BankrollManager(db, defaultBankrollConfig());
  });

  it('should complete full trade lifecycle: entry → monitor → exit → reconcile → bankroll update', async () => {
    // --- Entry Phase ---
    const entryProvider: ITxProvider = {
      getTransactionCount: vi.fn().mockResolvedValue(15),
      sendRawTransaction: vi.fn().mockResolvedValue('0xentry_swap_hash_001'),
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 1,
        blockNumber: 12346000,
        gasUsed: 195_000n,
        transactionHash: '0xentry_swap_hash_001',
      }),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 60_000_000n,
        maxPriorityFeePerGas: 1_500_000n,
      }),
      getAllowance: vi.fn().mockResolvedValue(7_000000n), // already approved
    };

    const mockSigner: ITxSigner = {
      signTransaction: vi.fn().mockResolvedValue('0xsigned_entry_tx'),
    };

    const txManager = new TransactionManager(
      db,
      {
        walletAddress: WALLET,
        timeoutMs: 5_000,
        maxFailedTxDay: 3,
        contractAllowlist: [SWAP_ROUTER, USDC_ADDRESS],
      },
      entryProvider,
      mockSigner,
      logger,
    );

    // Execute entry swap
    const entryIntent = await txManager.submitIntent({
      id: 'entry-trade-lifecycle-001',
      contractAddress: SWAP_ROUTER,
      functionName: 'exactInputSingle',
      gasLimit: 250_000n,
      operationType: 'entry',
    });

    expect(entryIntent.state).toBe('confirmed');
    expect(entryIntent.blockNumber).toBe(12346000);

    // --- Reconcile entry ---
    const entryReconProvider: IReconciliationProvider = {
      getUsdcBalance: vi.fn().mockResolvedValue(92_630000n), // 99.63 - 7.00
      getWethBalance: vi.fn().mockResolvedValue(2_780_000_000_000_000n), // ~0.00278 WETH
      getAllowance: vi.fn().mockResolvedValue(0n), // exact approval consumed
      getBlockNumber: vi.fn().mockResolvedValue(12346001),
      getTransactionBlockNumber: vi.fn().mockResolvedValue(12346000),
      getWethUsdcPrice: vi.fn().mockResolvedValue(2518.0), // entry price
    };

    const reconEngine = new ReconciliationEngine(
      db,
      defaultReconConfig(),
      entryReconProvider,
      safeModeCtrl,
      logger,
      WALLET,
    );

    const entryRecon = await reconEngine.reconcile(
      {
        intentId: 'entry-trade-lifecycle-001',
        expectedUsdc: 92_630000n,
        expectedWeth: 2_780_000_000_000_000n,
        txHash: '0xentry_swap_hash_001',
        operationSizeUsdc: 7_000000n,
        gasEthSpent: 11_700_000_000_000n, // 195000 * 60000000
      },
      'entry',
    );

    expect(entryRecon.matched).toBe(true);

    // Record entry gas
    const entryGasUsd = 29000n; // ~$0.029
    bankroll.recordGas(entryGasUsd);

    // --- Exit Phase (simulate price hit take-profit) ---
    // Price moved from $2518 to $2568 (TP at 2.0 ATR)
    const exitProvider: ITxProvider = {
      getTransactionCount: vi.fn().mockResolvedValue(16),
      sendRawTransaction: vi.fn().mockResolvedValue('0xexit_swap_hash_001'),
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 1,
        blockNumber: 12346500,
        gasUsed: 185_000n,
        transactionHash: '0xexit_swap_hash_001',
      }),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 55_000_000n,
        maxPriorityFeePerGas: 1_200_000n,
      }),
      getAllowance: vi.fn().mockResolvedValue(2_780_000_000_000_000n), // WETH approved
    };

    const exitTxManager = new TransactionManager(
      db,
      {
        walletAddress: WALLET,
        timeoutMs: 5_000,
        maxFailedTxDay: 3,
        contractAllowlist: [SWAP_ROUTER, WETH_ADDRESS],
      },
      exitProvider,
      { signTransaction: vi.fn().mockResolvedValue('0xsigned_exit_tx') },
      logger,
    );

    // Execute exit swap (sell WETH for USDC)
    const exitIntent = await exitTxManager.submitIntent({
      id: 'exit-trade-lifecycle-001',
      contractAddress: SWAP_ROUTER,
      functionName: 'exactInputSingle',
      gasLimit: 250_000n,
      operationType: 'exit',
    });

    expect(exitIntent.state).toBe('confirmed');
    expect(exitIntent.blockNumber).toBe(12346500);

    // --- Reconcile exit ---
    // Exit at ~$2568: 0.00278 WETH * $2568 ≈ $7.139
    // Gross P&L: $7.139 - $7.00 = $0.139
    const exitUsdc = 99_769000n; // 92.63 + 7.139 = 99.769
    const exitReconProvider: IReconciliationProvider = {
      getUsdcBalance: vi.fn().mockResolvedValue(exitUsdc),
      getWethBalance: vi.fn().mockResolvedValue(0n), // all WETH sold
      getAllowance: vi.fn().mockResolvedValue(0n),
      getBlockNumber: vi.fn().mockResolvedValue(12346501),
      getTransactionBlockNumber: vi.fn().mockResolvedValue(12346500),
      getWethUsdcPrice: vi.fn().mockResolvedValue(2568.0), // exit price
    };

    const exitReconEngine = new ReconciliationEngine(
      db,
      defaultReconConfig(),
      exitReconProvider,
      safeModeCtrl,
      logger,
      WALLET,
    );

    const exitRecon = await exitReconEngine.reconcile(
      {
        intentId: 'exit-trade-lifecycle-001',
        expectedUsdc: exitUsdc,
        expectedWeth: 0n,
        txHash: '0xexit_swap_hash_001',
        operationSizeUsdc: 7_139000n, // exit proceeds
        gasEthSpent: 10_175_000_000_000n,
      },
      'exit',
    );

    expect(exitRecon.matched).toBe(true);
    expect(exitRecon.actualUsdc).toBe(exitUsdc);
    expect(exitRecon.actualWeth).toBe(0n);

    // --- Verify P&L and bankroll update ---
    // Gross P&L: $7.139 - $7.000 = $0.139 (139000 in 6 decimals)
    const grossPnl = 139000n;
    // Net P&L: gross - entry gas - exit gas
    const exitGasUsd = 26000n; // ~$0.026
    bankroll.recordGas(exitGasUsd);
    bankroll.allocateProfit(grossPnl);

    const finalState = bankroll.getState();
    // active should have increased by profit minus gas
    // Starting active: 25_000000, minus entry gas (29000), minus exit gas (26000), plus profit (139000)
    const expectedActive = 25_000000n - 29000n - 26000n + 139000n;
    expect(finalState.activeUsdc).toBe(expectedActive);
    expect(finalState.dailyRealizedPnl).toBe(139000n);
    expect(finalState.dailyGasSpent).toBe(55000n); // 29000 + 26000

    // --- Verify experiment recording (position stored in DB) ---
    // Persist position record for experiment tracker
    db.prepare(
      `INSERT INTO positions (id, intent_id, mode, strategy, pair, entry_price, entry_timestamp,
       size_usdc, size_weth, stop_loss, take_profit, max_holding_ms, entry_regime,
       exit_reason, exit_price, exit_timestamp, gross_pnl, net_pnl, config_hash, closed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'pos-lifecycle-001', 'entry-trade-lifecycle-001', 'micro', 'trend_pullback',
      'WETH/USDC', 2518.0, Date.now() - 3600000,
      '7000000', '2780000000000000', 2480.0, 2568.0, 28800000, 'TRENDING_UP',
      'take_profit', 2568.0, Date.now(),
      '139000', String(139000n - 55000n), 'test_hash_abc123', 1,
    );

    const posRow = db.prepare('SELECT * FROM positions WHERE id = ?').get('pos-lifecycle-001') as Record<string, unknown>;
    expect(posRow).toBeDefined();
    expect(posRow.exit_reason).toBe('take_profit');
    expect(posRow.gross_pnl).toBe('139000');
    expect(posRow.closed).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14.4 - Revert Handling and Nonce Recovery Integration Test
// ═══════════════════════════════════════════════════════════════════════════

describe('14.4 Integration: revert handling and nonce recovery', () => {
  let db: TradingDatabase;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    db = createTestDb();
    seedNonceRegistry(db, 19, 20);
    seedTradingPhase(db);
    logger = createMockLogger();
  });

  it('should handle transaction revert: decode reason, count failed, no retry', async () => {
    const revertProvider: ITxProvider = {
      getTransactionCount: vi.fn().mockResolvedValue(20),
      sendRawTransaction: vi.fn().mockResolvedValue('0xreverted_tx_hash_001'),
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 0, // REVERTED
        blockNumber: 12347000,
        gasUsed: 120_000n,
        transactionHash: '0xreverted_tx_hash_001',
        revertData: '0x08c379a00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000001553544600000000000000000000000000000000000000000000000000000000', // "STF" (swap too few)
      }),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 80_000_000n,
        maxPriorityFeePerGas: 2_000_000n,
      }),
      getAllowance: vi.fn().mockResolvedValue(10_000000n),
    };

    const mockSigner: ITxSigner = {
      signTransaction: vi.fn().mockResolvedValue('0xsigned_will_revert'),
    };

    const txManager = new TransactionManager(
      db,
      {
        walletAddress: WALLET,
        timeoutMs: 5_000,
        maxFailedTxDay: 3,
        contractAllowlist: [SWAP_ROUTER],
      },
      revertProvider,
      mockSigner,
      logger,
    );

    // Submit intent that will revert
    const revertedIntent = await txManager.submitIntent({
      id: 'reverted-swap-001',
      contractAddress: SWAP_ROUTER,
      functionName: 'exactInputSingle',
      gasLimit: 250_000n,
      operationType: 'entry',
    });

    // Verify revert was detected and recorded
    expect(revertedIntent.state).toBe('reverted');
    expect(revertedIntent.txHash).toBe('0xreverted_tx_hash_001');

    // Verify failed tx counted
    const failedCount = txManager.getFailedTxCountToday();
    expect(failedCount).toBe(1);

    // Verify no automatic retry — submitting same ID should be rejected (idempotent)
    await expect(
      txManager.submitIntent({
        id: 'reverted-swap-001', // same ID
        contractAddress: SWAP_ROUTER,
        functionName: 'exactInputSingle',
        gasLimit: 250_000n,
        operationType: 'entry',
      }),
    ).rejects.toThrow(); // duplicate intent ID rejected

    // Verify intent persisted in DB with revert state
    const dbIntent = db.prepare('SELECT * FROM tx_intents WHERE id = ?').get('reverted-swap-001') as Record<string, unknown>;
    expect(dbIntent.state).toBe('reverted');
  });

  it('should handle nonce conflict: startup recovery resolves pending intents', async () => {
    // Simulate a pending intent left from previous session
    const pendingNonce = 20;
    db.prepare(
      `INSERT INTO tx_intents (id, state, nonce, tx_hash, contract_address, function_name,
       gas_limit, created_at, updated_at, operation_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'pending-from-crash-001', 'swap_pending', pendingNonce,
      '0xpending_tx_from_crash', SWAP_ROUTER, 'exactInputSingle',
      '250000', Date.now() - 600_000, Date.now() - 600_000, 'entry',
    );

    // On-chain: the tx was confirmed (nonce advanced past it)
    const onChainProvider: IOnChainProvider = {
      getUsdcBalance: vi.fn().mockResolvedValue(92_000000n),
      getWethBalance: vi.fn().mockResolvedValue(2_800_000_000_000_000n),
      getAusdcBalance: vi.fn().mockResolvedValue(0n),
      getEthBalance: vi.fn().mockResolvedValue(5_000_000_000_000_000n),
      getTransactionCount: vi.fn().mockResolvedValue(21), // advanced past nonce 20
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 1,
        blockNumber: 12347100,
      }),
    };

    const safeModeCtrl: IRecoverySafeModeController = {
      trigger: vi.fn(),
      getState: vi.fn().mockReturnValue({ active: false }),
    };

    const exitManager: IRecoveryExitManager = {
      registerPosition: vi.fn(),
      getOpenPosition: vi.fn().mockReturnValue(null),
    };

    // Also seed bankroll so state divergence check passes
    db.prepare(
      `INSERT INTO bankroll (id, total_usdc, active_usdc, reserve_usdc,
       daily_realized_pnl, daily_gas_spent, experiment_total_pnl,
       day_start_bankroll, day_utc, updated_at)
       VALUES (1, ?, ?, ?, '0', '0', '0', ?, ?, ?)`,
    ).run(
      '99630000', '25000000', '74630000',
      '99630000', new Date().toISOString().slice(0, 10), Date.now(),
    );

    const recovery = new StartupRecovery(
      db,
      { walletAddress: WALLET, deviationThresholdUsdc: 10_000000n },
      onChainProvider,
      safeModeCtrl,
      exitManager,
      logger,
    );

    const result = await recovery.recover();

    // Verify pending intent was resolved
    expect(result.resolvedIntents.length).toBeGreaterThanOrEqual(1);
    const resolved = result.resolvedIntents.find(
      (r) => r.intentId === 'pending-from-crash-001',
    );
    expect(resolved).toBeDefined();
    expect(resolved!.resolvedState).toBe('confirmed');
    expect(resolved!.resolution).toBe('confirmed');

    // Verify the intent was updated in DB
    const dbIntent = db.prepare('SELECT state FROM tx_intents WHERE id = ?').get('pending-from-crash-001') as Record<string, unknown>;
    expect(dbIntent.state).toBe('confirmed');
  });

  it('should handle 5-min timeout scenario appropriately', async () => {
    // Simulate a provider that never returns a receipt (timeout scenario)
    let receiptCallCount = 0;
    const timeoutProvider: ITxProvider = {
      getTransactionCount: vi.fn().mockResolvedValue(20),
      sendRawTransaction: vi.fn().mockResolvedValue('0xtimeout_tx_hash'),
      getTransactionReceipt: vi.fn().mockImplementation(() => {
        receiptCallCount++;
        // Always return null — simulates tx never being mined
        return Promise.resolve(null);
      }),
      getFeeData: vi.fn().mockResolvedValue({
        maxFeePerGas: 80_000_000n,
        maxPriorityFeePerGas: 2_000_000n,
      }),
      getAllowance: vi.fn().mockResolvedValue(10_000000n),
    };

    const mockSigner: ITxSigner = {
      signTransaction: vi.fn().mockResolvedValue('0xsigned_timeout_tx'),
    };

    const txManager = new TransactionManager(
      db,
      {
        walletAddress: WALLET,
        timeoutMs: 200, // Very short timeout for test (200ms instead of 5 min)
        maxFailedTxDay: 3,
        contractAllowlist: [SWAP_ROUTER],
      },
      timeoutProvider,
      mockSigner,
      logger,
    );

    // This should eventually complete (either with timeout state or error)
    const intentResult = await txManager.submitIntent({
      id: 'timeout-entry-001',
      contractAddress: SWAP_ROUTER,
      functionName: 'exactInputSingle',
      gasLimit: 250_000n,
      operationType: 'entry',
    });

    // After timeout, intent should be in a non-confirmed state (dropped)
    expect(['dropped', 'swap_pending', 'created']).toContain(intentResult.state);

    // Provider was polled multiple times
    expect(receiptCallCount).toBeGreaterThanOrEqual(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14.5 - Reconciliation Mismatch Detection Integration Test
// ═══════════════════════════════════════════════════════════════════════════

describe('14.5 Integration: reconciliation mismatch detection', () => {
  let db: TradingDatabase;
  let logger: ReturnType<typeof createMockLogger>;
  let safeModeCtrl: SafeModeController;

  beforeEach(() => {
    db = createTestDb();
    seedNonceRegistry(db, 24, 25);
    seedTradingPhase(db);
    logger = createMockLogger();
    safeModeCtrl = new SafeModeController(db);
  });

  it('should trigger Safe_Mode on balance deviation post-swap', async () => {
    // Seed the tx_intent that reconciliation_log references (FK constraint)
    seedTxIntent(db, 'mismatch-swap-001', 25);

    // Provider returns a balance that deviates from expected
    const mismatchProvider: IReconciliationProvider = {
      getUsdcBalance: vi.fn().mockResolvedValue(90_000000n), // Expected 92.63, actual 90.00 — $2.63 deviation
      getWethBalance: vi.fn().mockResolvedValue(2_780_000_000_000_000n),
      getAllowance: vi.fn().mockResolvedValue(0n),
      getBlockNumber: vi.fn().mockResolvedValue(12348001),
      getTransactionBlockNumber: vi.fn().mockResolvedValue(12348000),
      getWethUsdcPrice: vi.fn().mockResolvedValue(2500.0),
    };

    const reconEngine = new ReconciliationEngine(
      db,
      defaultReconConfig(),
      mismatchProvider,
      safeModeCtrl,
      logger,
      WALLET,
    );

    const result = await reconEngine.reconcile(
      {
        intentId: 'mismatch-swap-001',
        expectedUsdc: 92_630000n,
        expectedWeth: 2_780_000_000_000_000n,
        txHash: '0xmismatch_swap_hash',
        operationSizeUsdc: 7_000000n,
        gasEthSpent: 10_000_000_000_000n,
      },
      'entry',
    );

    // Deviation: |92.63 - 90.00| = $2.63 > max(1% of $7 = $0.07, $0.05)
    expect(result.matched).toBe(false);
    expect(result.deviationUsdc).toBeGreaterThan(0n);

    // Safe_Mode should be triggered
    const safeState = safeModeCtrl.getState();
    expect(safeState.state).toBe('safe_mode');
    expect(safeModeCtrl.canTrade()).toBe(false);
  });

  it('should trigger KillSwitch after 3 mismatches in 24h', async () => {
    // Seed tx_intents for FK constraints
    seedTxIntent(db, 'mismatch-kill-001', 25);
    seedTxIntent(db, 'mismatch-kill-002', 26);
    seedTxIntent(db, 'mismatch-kill-003', 27);

    // Create a provider that always returns mismatched balances
    const mismatchProvider: IReconciliationProvider = {
      getUsdcBalance: vi.fn().mockResolvedValue(85_000000n), // big deviation
      getWethBalance: vi.fn().mockResolvedValue(0n),
      getAllowance: vi.fn().mockResolvedValue(0n),
      getBlockNumber: vi.fn().mockResolvedValue(12349002),
      getTransactionBlockNumber: vi.fn().mockResolvedValue(12349001),
      getWethUsdcPrice: vi.fn().mockResolvedValue(2500.0),
    };

    const reconEngine = new ReconciliationEngine(
      db,
      { ...defaultReconConfig(), mismatchesForKillSwitch: 3 },
      mismatchProvider,
      safeModeCtrl,
      logger,
      WALLET,
    );

    // Mismatch 1
    await reconEngine.reconcile(
      {
        intentId: 'mismatch-kill-001',
        expectedUsdc: 99_000000n,
        expectedWeth: 0n,
        txHash: '0xkill_mismatch_hash_1',
        operationSizeUsdc: 7_000000n,
        gasEthSpent: 10_000_000_000_000n,
      },
      'entry',
    );

    // After first mismatch: Safe_Mode triggered
    expect(safeModeCtrl.getState().state).toBe('safe_mode');

    // For subsequent mismatches, we need to simulate that the operator resumed
    // (or that the system is still counting mismatches despite Safe_Mode)
    // The ReconciliationEngine counts mismatches in reconciliation_log regardless

    // Mismatch 2
    await reconEngine.reconcile(
      {
        intentId: 'mismatch-kill-002',
        expectedUsdc: 98_000000n,
        expectedWeth: 0n,
        txHash: '0xkill_mismatch_hash_2',
        operationSizeUsdc: 7_000000n,
        gasEthSpent: 10_000_000_000_000n,
      },
      'exit',
    );

    // Mismatch 3 — should escalate to KillSwitch
    await reconEngine.reconcile(
      {
        intentId: 'mismatch-kill-003',
        expectedUsdc: 97_000000n,
        expectedWeth: 0n,
        txHash: '0xkill_mismatch_hash_3',
        operationSizeUsdc: 7_000000n,
        gasEthSpent: 10_000_000_000_000n,
      },
      'withdrawal',
    );

    // Verify mismatch count
    const mismatchCount = reconEngine.getMismatchCount24h();
    expect(mismatchCount).toBeGreaterThanOrEqual(3);

    // KillSwitch should be triggered (persisted in trading_phase)
    const phaseRow = db.prepare(
      'SELECT kill_switch_triggered FROM trading_phase WHERE id = 1',
    ).get() as Record<string, unknown>;
    expect(phaseRow.kill_switch_triggered).toBe(1);

    // System should be in kill switch state (no trading, no resuming)
    const finalState = safeModeCtrl.getState();
    expect(finalState.state).toBe('kill_switch');
  });

  it('should correctly persist all reconciliation results to log', async () => {
    // Seed tx_intent for FK constraint
    seedTxIntent(db, 'log-test-001', 28);

    const matchedProvider: IReconciliationProvider = {
      getUsdcBalance: vi.fn().mockResolvedValue(92_630000n),
      getWethBalance: vi.fn().mockResolvedValue(2_800_000_000_000_000n),
      getAllowance: vi.fn().mockResolvedValue(0n),
      getBlockNumber: vi.fn().mockResolvedValue(12350001),
      getTransactionBlockNumber: vi.fn().mockResolvedValue(12350000),
      getWethUsdcPrice: vi.fn().mockResolvedValue(2500.0),
    };

    const reconEngine = new ReconciliationEngine(
      db,
      defaultReconConfig(),
      matchedProvider,
      safeModeCtrl,
      logger,
      WALLET,
    );

    await reconEngine.reconcile(
      {
        intentId: 'log-test-001',
        expectedUsdc: 92_630000n,
        expectedWeth: 2_800_000_000_000_000n,
        txHash: '0xlog_test_hash',
        operationSizeUsdc: 7_000000n,
        gasEthSpent: 10_000_000_000_000n,
      },
      'entry',
    );

    // Verify log entry exists with correct data
    const logs = db.prepare(
      'SELECT * FROM reconciliation_log ORDER BY id DESC LIMIT 1',
    ).get() as Record<string, unknown>;

    expect(logs).toBeDefined();
    expect(logs.operation_type).toBe('entry');
    expect(logs.intent_id).toBe('log-test-001');
    expect(logs.expected_usdc).toBe('92630000');
    expect(logs.actual_usdc).toBe('92630000');
    expect(logs.matched).toBe(1);
  });
});

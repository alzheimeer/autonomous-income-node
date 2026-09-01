/**
 * Trading Validation Phase - Bootstrap Module
 *
 * Wires and starts the TradingOrchestrator for shadow mode trading.
 * Creates all real modules (MarketData, Strategy, Gate, Sizer, ShadowTrader,
 * ExperimentTracker, BankrollManager, SafeModeController) and stubs for
 * on-chain modules not needed in shadow mode.
 *
 * Called from AgentCore after Step 5 (heartbeat/HTTP server is up).
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 7.4, 7.5, 12.4, E3, E7, E8
 */

import { createShadowOrchestrator } from './create-shadow-orchestrator.js';
import { TradingDatabase } from './db.js';
import { BankrollManager } from './bankroll-manager.js';
import { SafeModeController } from './safe-mode-controller.js';
import { ExperimentTracker } from './experiment-tracker.js';
import type { IExperimentDataProvider } from './experiment-tracker.js';
import { loadConfig } from './config.js';
import { runMigrations } from './migrations.js';
import type { TradingOrchestrator } from './orchestrator.js';
import { createMetricsDatabase } from '../pipeline-metrics/metrics-database.js';
import type { MetricsDatabase } from '../pipeline-metrics/metrics-database.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface BootstrapDeps {
  /** The agent's raw database (node:sqlite DatabaseSync-compatible) */
  db: unknown;
  /** Base mainnet RPC URL (e.g., process.env.RPC_PROVIDER_URL) */
  rpcUrl: string;
  /** Agent wallet address (checksummed) */
  walletAddress: string;
}

export interface BootstrapResult {
  /** The started TradingOrchestrator instance */
  orchestrator: TradingOrchestrator;
  /** BankrollManager for API routes to query real bankroll state */
  bankrollManager: BankrollManager;
  /** SafeModeController for API routes to query/trigger safe mode */
  safeModeController: SafeModeController;
  /** ExperimentTracker for API routes to query experiment reports */
  experimentTracker: ExperimentTracker;
  /** MetricsDatabase for pipeline-metrics API route */
  metricsDb: MetricsDatabase | null;
  /** Graceful shutdown function */
  stop: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bootstrap Function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Bootstraps the TradingOrchestrator for shadow mode.
 *
 * 1. Ensures trading-validation DB tables exist (idempotent migrations)
 * 2. Instantiates all trading-validation modules with their dependencies
 * 3. Starts the orchestrator (connects to Binance, begins market data ingestion)
 * 4. Returns the started orchestrator + key managers for API route consumption
 *
 * @param deps - Database, RPC URL, and wallet address
 * @returns Started orchestrator and exposed managers for API integration
 *
 * @example
 * ```ts
 * const result = await bootstrapTradingOrchestrator({
 *   db: agentDatabase.getDb(),
 *   rpcUrl: env.RPC_PROVIDER_URL,
 *   walletAddress: '0x...',
 * });
 * // Use result.bankrollManager in API routes
 * // Call result.stop() on graceful shutdown
 * ```
 */
export async function bootstrapTradingOrchestrator(
  deps: BootstrapDeps,
): Promise<BootstrapResult> {
  const { db, rpcUrl, walletAddress } = deps;

  // 1. Ensure trading tables exist (idempotent — safe to call multiple times)
  runMigrations(db as any);

  // 2. Load config (from env vars with defaults)
  const config = loadConfig();

  // 3. Create TradingDatabase wrapper for standalone access to managers
  //    Uses same path as the agent DB so we share the same file
  const tradingDb = new TradingDatabase('data/agent.db');

  // 4. Instantiate managers that the API routes need direct access to
  const bankrollManager = new BankrollManager(tradingDb, config.bankroll);
  const safeModeController = new SafeModeController(tradingDb);

  // ExperimentTracker needs an external data provider
  const experimentDataProvider: IExperimentDataProvider = {
    getFailedTxCount: () => 0,   // No real TX in shadow mode
    getTotalTxCount: () => 0,
    getReconMismatchCount: () => 0,
    getSlippageDeviations: () => [],
    getWethPriceAtStart: () => 0, // Will be populated once market data starts
    getWethPriceNow: () => 0,
  };

  const experimentTracker = new ExperimentTracker(
    config.experiment,
    experimentDataProvider,
    (entry) => {
      console.log(`[ExperimentTracker] ${entry.event}`, entry.details);
    },
  );

  // 5. Create the full shadow orchestrator (wires all modules internally)
  const orchestrator = await createShadowOrchestrator({
    db,
    rpcUrl,
    walletAddress,
  });

  // 6. Start the orchestrator (connects WebSocket, begins market data ingestion)
  await orchestrator.start();

  console.log('[Bootstrap] TradingOrchestrator started in SHADOW mode');

  // 7. Create MetricsDatabase for pipeline-metrics API route (best-effort)
  let metricsDb: MetricsDatabase | null = null;
  try {
    metricsDb = createMetricsDatabase();
  } catch (err) {
    console.warn('[Bootstrap] MetricsDatabase unavailable (pipeline-metrics route will return 503):', (err as Error).message);
  }

  // 8. Return orchestrator + managers for API route integration
  return {
    orchestrator,
    bankrollManager,
    safeModeController,
    experimentTracker,
    metricsDb,
    stop: () => {
      orchestrator.stop();
      console.log('[Bootstrap] TradingOrchestrator stopped');
    },
  };
}

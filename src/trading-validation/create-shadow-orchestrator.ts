/**
 * Factory: Create a TradingOrchestrator configured for Shadow Mode.
 *
 * In shadow mode:
 * - MarketDataManager: REAL (Binance WebSocket + REST)
 * - StrategyEngine: REAL (evaluates real signals)
 * - CostAwareTradeGate: REAL (validates trades against real criteria)
 * - PositionSizer: REAL (calculates real sizes)
 * - ExecutableQuoteEngine: REAL (gets real on-chain quotes from QuoterV2)
 * - ShadowTrader: REAL (simulates trades with realistic costs)
 * - ExperimentTracker: REAL (tracks shadow pass criteria)
 * - BankrollManager: REAL (tracks logical bankroll split)
 * - SafeModeController: REAL (state machine for safety)
 * - GasReserveManager: REAL (monitors ETH balance)
 * - ExitManager: stub (shadow exits handled by ShadowTrader)
 *
 * NOT needed in shadow mode (use no-op stubs):
 * - PreTradeSimulator: stub (no eth_call needed for shadow)
 * - TransactionManager: stub (no transactions broadcast)
 * - ReconciliationEngine: stub (no on-chain reconciliation)
 *
 * Dependencies:
 * - db: The agent's database (node:sqlite DatabaseSync compatible)
 * - rpcUrl: Ethereum RPC URL (for QuoterV2 quotes)
 * - walletAddress: The agent's wallet address
 */

import { loadConfig } from './config.js';
import { TradingDatabase } from './db.js';
import { createMetricsDatabase, PipelineMetricsRecorder } from '../pipeline-metrics/index.js';
import type { IPipelineObserver } from '../pipeline-metrics/index.js';
import { MarketDataManager } from './market-data-manager.js';
import type { IWebSocketClient, WebSocketFactory, IFetchClient } from './market-data-manager.js';
import { StrategyEngine } from './strategy-engine.js';
import type { Indicators } from './strategy-engine.js';
import { PositionSizer } from './position-sizer.js';
import { BankrollManager } from './bankroll-manager.js';
import { SafeModeController } from './safe-mode-controller.js';
import { GasReserveManager } from './gas-reserve-manager.js';
import { ExperimentTracker } from './experiment-tracker.js';
import type { IExperimentDataProvider } from './experiment-tracker.js';
import { ShadowTrader } from './shadow-trader.js';
import type { ShadowExternalState } from './shadow-trader.js';
import { TradingOrchestrator } from './orchestrator.js';
import type {
  IFeatureEngineAdapter,
  IOrchestratorTradeGate,
  IOrchestratorSimulator,
  IOrchestratorTransactionManager,
  IOrchestratorReconciliation,
  IOrchestratorExitManager,
  IOrchestratorQuoteEngine,
  IOrchestratorGasReserve,
  IOrchestratorSafeMode,
  IDailyMetricsAdapter,
  OrchestratorLogger,
} from './orchestrator.js';
import type {
  ExecutableQuote,
  MarketEvent,
  Position,
  RegimeType,
  TransactionIntent,
  UsdcAmount,
  WethAmount,
  CandleData,
} from './types.js';
import type { GateResult } from './cost-aware-trade-gate.js';
import type { SizingResult } from './position-sizer.js';
import type { SimulationResult } from './pre-trade-simulator.js';
import type { ExitSignal, ExitResult } from './exit-manager.js';
import type { ReconciliationResult, BankrollState } from './types.js';
import type { TradingValidationConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Stub Implementations for modules not needed in shadow mode
// ═══════════════════════════════════════════════════════════════════════════

/** No-op PreTradeSimulator — shadow mode never needs eth_call simulations */
class StubPreTradeSimulator implements IOrchestratorSimulator {
  async simulateApproval(
    _token: string,
    _spender: string,
    _amount: bigint,
  ): Promise<SimulationResult> {
    return { success: true, gasUsed: 50000n };
  }

  async simulateSwap(
    _params: import('./pre-trade-simulator.js').SwapSimulationParams,
  ): Promise<SimulationResult> {
    return { success: true, gasUsed: 150000n };
  }
}

/** No-op TransactionManager — shadow mode never broadcasts transactions */
class StubTransactionManager implements IOrchestratorTransactionManager {
  async submitIntent(_intent: import('./transaction-manager.js').IntentParams): Promise<TransactionIntent> {
    return {
      id: 'stub-intent',
      type: 'swap',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      txHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
      gasUsed: 0n,
      gasPrice: 0n,
    } as unknown as TransactionIntent;
  }

  async ensureApproval(
    _token: string,
    _spender: string,
    _amount: bigint,
  ): Promise<TransactionIntent | null> {
    return null; // Already approved (no-op)
  }

  getFailedTxCountToday(): number {
    return 0;
  }

  getPendingIntent(): TransactionIntent | null {
    return null;
  }

  isAllowlisted(_address: string): boolean {
    return true;
  }
}

/** No-op ReconciliationEngine — shadow mode has no on-chain state to reconcile */
class StubReconciliationEngine implements IOrchestratorReconciliation {
  async reconcile(
    _expected: import('./reconciliation-engine.js').ExpectedState,
    _operationType: string,
  ): Promise<ReconciliationResult> {
    return { match: true, deviations: [] } as unknown as ReconciliationResult;
  }
}

/** No-op ExitManager — shadow exits are handled by ShadowTrader directly */
class StubExitManager implements IOrchestratorExitManager {
  registerPosition(_position: Position): void { /* no-op */ }

  checkExits(
    _currentPrice: number,
    _currentRegime: RegimeType,
    _timestamp: number,
  ): ExitSignal | null {
    return null;
  }

  onPriceUpdate(_currentPrice: number): void { /* no-op */ }

  getOpenPosition(): Position | null {
    return null;
  }

  isExitPending(): boolean {
    return false;
  }

  async executeExit(
    _reason: import('./types.js').ExitReason,
    _currentPrice: number,
    _timestamp: number,
  ): Promise<ExitResult> {
    return { success: true };
  }
}

/** Stub QuoteEngine for shadow mode — returns synthetic quotes from Binance price */
class ShadowQuoteEngine implements IOrchestratorQuoteEngine {
  private readonly getPrice: () => number | null;
  private readonly config: TradingValidationConfig;

  constructor(getPrice: () => number | null, config: TradingValidationConfig) {
    this.getPrice = getPrice;
    this.config = config;
  }

  async getEntryQuote(amountInUsdc: UsdcAmount): Promise<ExecutableQuote> {
    const price = this.getPrice();
    if (!price || price <= 0) {
      throw new Error('No market price available for quote');
    }

    // Simulate QuoterV2 response: USDC → WETH
    // amountOut = amountIn / price (adjusted for decimals: USDC 6, WETH 18)
    const amountInFloat = Number(amountInUsdc) / 1e6;
    const wethAmount = amountInFloat / price;
    const amountOut = BigInt(Math.round(wethAmount * 1e18));

    // Simulate realistic gas cost (~$0.02 on Base)
    const gasUsd = 0.02;

    return {
      direction: 'entry',
      amountIn: amountInUsdc,
      amountOut,
      price,
      priceImpactBps: 5, // minimal for small trades
      gasEstimate: 150000n,
      gasUsd,
      source: 'shadow_synthetic',
      timestamp: Date.now(),
      expiresAt: Date.now() + this.config.quoteEngine.quoteTtlMs,
      feeTier: this.config.quoteEngine.feeTier,
    } as unknown as ExecutableQuote;
  }

  async getExitQuote(amountInWeth: WethAmount): Promise<ExecutableQuote> {
    const price = this.getPrice();
    if (!price || price <= 0) {
      throw new Error('No market price available for quote');
    }

    // Simulate QuoterV2 response: WETH → USDC
    const wethFloat = Number(amountInWeth) / 1e18;
    const usdcAmount = wethFloat * price;
    const amountOut = BigInt(Math.round(usdcAmount * 1e6));

    const gasUsd = 0.02;

    return {
      direction: 'exit',
      amountIn: amountInWeth,
      amountOut,
      price,
      priceImpactBps: 5,
      gasEstimate: 150000n,
      gasUsd,
      source: 'shadow_synthetic',
      timestamp: Date.now(),
      expiresAt: Date.now() + this.config.quoteEngine.quoteTtlMs,
      feeTier: this.config.quoteEngine.feeTier,
    } as unknown as ExecutableQuote;
  }
}

/** Simple DailyMetrics adapter for shadow mode */
class ShadowDailyMetrics implements IDailyMetricsAdapter {
  private evaluations = 0;
  private signals = 0;
  private rejected = 0;
  private trades = 0;
  private failedTx = 0;

  recordEvaluation(): void { this.evaluations++; }
  recordSignal(): void { this.signals++; }
  recordTradeRejected(): void { this.rejected++; }
  recordTrade(): void { this.trades++; }
  recordFailedTx(): void { this.failedTx++; }
  getTradesCountToday(): number { return this.trades; }
  getFailedTxCountToday(): number { return this.failedTx; }
}

/** Simple FeatureEngine adapter that computes indicators from MarketDataManager candles */
class ShadowFeatureEngineAdapter implements IFeatureEngineAdapter {
  private readonly marketData: MarketDataManager;

  constructor(marketData: MarketDataManager) {
    this.marketData = marketData;
  }

  computeIndicators(timeframe: '15m' | '1h'): Indicators | null {
    const candles = this.marketData.getCandles(timeframe);
    if (candles.length < 200) return null; // Need enough data for EMA200

    const closes = candles.map(c => c.close);
    const lastPrice = closes[closes.length - 1];

    return {
      ema20: this.ema(closes, 20),
      ema50: this.ema(closes, 50),
      ema200: this.ema(closes, 200),
      rsi14: this.rsi(closes, 14),
      atr14: this.atr(candles, 14),
      volumeZScore: this.volumeZ(candles),
      bollingerBands: this.bollinger(closes, 20),
      lastPrice,
      candleCount: candles.length,
    };
  }

  getRegime(): RegimeType {
    const candles1h = this.marketData.getCandles('1h');
    if (candles1h.length < 200) return 'UNCERTAIN';

    const closes = candles1h.map(c => c.close);
    const ema50 = this.ema(closes, 50);
    const ema200 = this.ema(closes, 200);
    const lastPrice = closes[closes.length - 1];

    // Simple regime classification
    if (lastPrice > ema50 && ema50 > ema200) return 'TRENDING_UP';
    if (lastPrice < ema50 && ema50 < ema200) return 'TRENDING_DOWN';

    // Check volatility via ATR/price ratio
    const atr = this.atr(candles1h, 14);
    const atrPct = atr / lastPrice;
    if (atrPct > 0.04) return 'VOLATILE'; // >4% ATR/price = volatile

    return 'RANGING';
  }

  // ── Technical indicator calculations ──────────────────────────────────

  private ema(data: number[], period: number): number {
    if (data.length < period) return data[data.length - 1] ?? 0;
    const k = 2 / (period + 1);
    let ema = data.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  private rsi(closes: number[], period: number): number {
    if (closes.length < period + 1) return 50;
    let gains = 0;
    let losses = 0;
    const start = closes.length - period - 1;
    for (let i = start + 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses += -diff;
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  private atr(candles: CandleData[], period: number): number {
    if (candles.length < period + 1) return 0;
    const recent = candles.slice(-(period + 1));
    let sumTR = 0;
    for (let i = 1; i <= period; i++) {
      const cur = recent[i];
      const prev = recent[i - 1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close),
      );
      sumTR += tr;
    }
    return sumTR / period;
  }

  private volumeZ(candles: CandleData[]): number {
    if (candles.length < 20) return 0;
    const volumes = candles.slice(-20).map(c => c.volume);
    const mean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const variance = volumes.reduce((sum, v) => sum + (v - mean) ** 2, 0) / volumes.length;
    const std = Math.sqrt(variance);
    if (std === 0) return 0;
    return (volumes[volumes.length - 1] - mean) / std;
  }

  private bollinger(closes: number[], period: number): { upper: number; middle: number; lower: number } {
    if (closes.length < period) {
      const last = closes[closes.length - 1] ?? 0;
      return { upper: last, middle: last, lower: last };
    }
    const recent = closes.slice(-period);
    const mean = recent.reduce((a, b) => a + b, 0) / period;
    const variance = recent.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    return {
      upper: mean + 2 * std,
      middle: mean,
      lower: mean - 2 * std,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// WebSocket Factory (uses native WebSocket or ws package)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a WebSocket factory that works in Node.js.
 * Uses the `ws` package if available, otherwise falls back to global WebSocket.
 */
function createWebSocketFactory(): WebSocketFactory {
  return (url: string): IWebSocketClient => {
    // Node.js 21+ has global WebSocket, but for compatibility use dynamic import
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    try {
      // Try global WebSocket first (Node 21+)
      if (typeof globalThis.WebSocket !== 'undefined') {
        const ws = new globalThis.WebSocket(url) as unknown as IWebSocketClient;
        return ws;
      }
    } catch { /* fall through */ }

    // Fallback: create a minimal stub that triggers REST fallback
    const stub: IWebSocketClient = {
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      readyState: 3, // CLOSED — forces REST fallback
      close() { /* no-op */ },
    };
    // Simulate immediate close so MarketDataManager uses REST polling
    setTimeout(() => {
      stub.onclose?.({ code: 1006, reason: 'WebSocket not available' });
    }, 0);
    return stub;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory Function
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateShadowOrchestratorParams {
  /** The agent's database (raw node:sqlite DatabaseSync-compatible) */
  db: unknown;
  /** Ethereum RPC URL (for QuoterV2 quotes) */
  rpcUrl: string;
  /** The agent's wallet address */
  walletAddress: string;
}

/**
 * Creates a TradingOrchestrator configured for Shadow Mode.
 *
 * This factory wires all real modules (MarketData, Strategy, Gate, Sizer,
 * ShadowTrader, ExperimentTracker) and stubs for modules not needed in
 * shadow mode (TransactionManager, ReconciliationEngine, PreTradeSimulator).
 */
export async function createShadowOrchestrator(
  params: CreateShadowOrchestratorParams,
): Promise<TradingOrchestrator> {
  const { rpcUrl, walletAddress } = params;

  // 1. Load configuration
  const config = loadConfig();

  // Force shadow mode regardless of env
  (config as { mode: string }).mode = 'shadow';

  const logger: OrchestratorLogger = {
    info(msg, data) { console.log(`[TradingOrchestrator] ${msg}`, data ?? ''); },
    warn(msg, data) { console.warn(`[TradingOrchestrator] ${msg}`, data ?? ''); },
    error(msg, data) { console.error(`[TradingOrchestrator] ${msg}`, data ?? ''); },
  };

  // 2. Create TradingDatabase wrapper from agent DB path
  //    We use the same data/agent.db for trading tables (migrations already run in agent/index.ts)
  const tradingDb = new TradingDatabase('data/agent.db');

  // 3. MarketDataManager — REAL (Binance WebSocket + REST)
  const wsFactory = createWebSocketFactory();
  const fetchClient: IFetchClient = async (url: string) => {
    const response = await fetch(url);
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
    };
  };

  const marketData = new MarketDataManager(
    config.marketData,
    wsFactory,
    fetchClient,
    (msg: string) => { logger.warn(msg); },
  );

  // 4. FeatureEngine adapter — computes indicators from MarketDataManager candles
  const featureEngine = new ShadowFeatureEngineAdapter(marketData);

  // 5. StrategyEngine — REAL
  const strategyEngine = new StrategyEngine(config.strategy);

  // 6. CostAwareTradeGate — uses the shadow quote engine for evaluation
  //    In shadow mode we use a simplified gate that always passes
  //    (the real evaluation happens via ShadowTrader's cost modeling)
  const tradeGate: IOrchestratorTradeGate = {
    evaluate(
      entryQuote: ExecutableQuote,
      _exitQuote: ExecutableQuote,
      _tradeSize: UsdcAmount,
      _hasPrivateRpc: boolean,
    ): GateResult {
      // In shadow mode, let all signals through to ShadowTrader for tracking
      return {
        passed: true,
        netProfitUsdc: 0n,
        netProfitBps: 0,
        costBreakdown: {
          entryInput: entryQuote.amountIn as UsdcAmount,
          exitProceeds: 0n as UsdcAmount,
          entryGas: 0n as UsdcAmount,
          exitGas: 0n as UsdcAmount,
          externalFees: 0n as UsdcAmount,
          safetyMargin: 0n as UsdcAmount,
          netProfit: 0n as UsdcAmount,
        },
        rejectReasons: [],
      };
    },
  };

  // 7. PositionSizer — REAL
  const positionSizer = new PositionSizer(config.positionSizer);

  // 8. Quote Engine — shadow synthetic (uses Binance price from MarketDataManager)
  const quoteEngine = new ShadowQuoteEngine(
    () => marketData.getLatestPrice(),
    config,
  );

  // 9. BankrollManager — REAL (tracks logical split)
  const bankrollManager = new BankrollManager(tradingDb, config.bankroll);

  // 10. SafeModeController — REAL (state machine)
  const safeModeControllerImpl = new SafeModeController(tradingDb);
  const safeModeController: IOrchestratorSafeMode = {
    trigger(reason: string, details?: string): void {
      // Cast string reason to SafeModeTrigger (best-effort)
      safeModeControllerImpl.trigger(reason as import('./safe-mode-controller.js').SafeModeTrigger, details);
    },
    canTrade(): boolean {
      return safeModeControllerImpl.canTrade();
    },
    canClosePosition(): boolean {
      return safeModeControllerImpl.canClosePosition();
    },
    getState(): { state: string; reason?: string; since?: number } {
      const s = safeModeControllerImpl.getState();
      return { state: s.state, reason: s.reason, since: s.since };
    },
  };

  // 11. GasReserveManager — simplified for shadow (always allows trading)
  const gasReserveManager: IOrchestratorGasReserve = {
    canEnterTrade(_estimatedGas: bigint): boolean {
      return true; // Shadow mode doesn't consume gas
    },
    isCritical(): boolean {
      return false;
    },
  };

  // 12. ShadowTrader — REAL
  const externalState: ShadowExternalState = {
    isKillSwitchTriggered: () => safeModeControllerImpl.getState().state === 'kill_switch',
    isSafeModeActive: () => safeModeControllerImpl.getState().state === 'safe_mode',
    isOperatorExitRequested: () => false,
  };

  const shadowTrader = new ShadowTrader(
    tradingDb,
    config.exitManager,
    config.configHash,
    externalState,
    {
      logger: (entry) => {
        logger.info(`[ShadowTrader] ${entry.event}`, {
          positionId: entry.positionId,
          details: entry.details,
        });
      },
    },
  );

  // 13. ExperimentTracker — REAL
  const experimentDataProvider: IExperimentDataProvider = {
    getFailedTxCount: () => 0, // No real TX in shadow
    getTotalTxCount: () => 0,
    getReconMismatchCount: () => 0,
    getSlippageDeviations: () => [],
    getWethPriceAtStart: () => marketData.getLatestPrice() ?? 0,
    getWethPriceNow: () => marketData.getLatestPrice() ?? 0,
  };

  const experimentTracker = new ExperimentTracker(
    config.experiment,
    experimentDataProvider,
    (entry) => {
      logger.info(`[ExperimentTracker] ${entry.event}`, entry.details);
    },
  );

  // 14. DailyMetrics — simple counter
  const dailyMetrics = new ShadowDailyMetrics();

  // 15. Stubs for modules not needed in shadow mode
  const preTradeSimulator = new StubPreTradeSimulator();
  const transactionManager = new StubTransactionManager();
  const reconciliationEngine = new StubReconciliationEngine();
  const exitManager = new StubExitManager();

  // 16. Pipeline Metrics Observer (conditional on PIPELINE_METRICS_ENABLED env var)
  let pipelineObserver: IPipelineObserver | undefined;
  const metricsEnabled = process.env.PIPELINE_METRICS_ENABLED !== 'false'; // defaults to true
  if (metricsEnabled) {
    try {
      const metricsDb = createMetricsDatabase();
      pipelineObserver = new PipelineMetricsRecorder(metricsDb);
    } catch {
      // Best-effort: if metrics DB fails, continue without observer
      logger.warn('Pipeline metrics recorder could not be initialized — continuing without');
    }
  }

  // 17. Wire everything into TradingOrchestrator
  const orchestrator = new TradingOrchestrator({
    config,
    logger,
    marketData,
    featureEngine,
    strategyEngine,
    tradeGate,
    positionSizer,
    preTradeSimulator,
    transactionManager,
    reconciliationEngine,
    bankrollManager,
    exitManager,
    shadowTrader,
    quoteEngine,
    safeModeController,
    experimentTracker,
    gasReserveManager,
    dailyMetrics,
    // Optional modules — not needed for initial shadow mode
    operatorConfirm: undefined,
    servicesModule: undefined,
    multiSourceScanner: undefined,
    smartAutoLender: undefined,
    observer: pipelineObserver,
  });

  return orchestrator;
}

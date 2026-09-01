/**
 * Trading Validation Phase - Orchestrator
 *
 * Wires the complete trading pipeline:
 *   MarketDataManager → FeatureEngine → StrategyEngine → CostAwareTradeGate
 *   → PositionSizer → PreTradeSimulator → TransactionManager
 *   → ReconciliationEngine → BankrollManager
 *
 * ExitManager runs an independent monitoring loop.
 * Mode branching: Shadow_Mode → ShadowTrader; Micro_Mode → TransactionManager.
 *
 * Disabled modules: AdaptiveEvolver, SelfMod, SocialModule, OpportunityDiscovery,
 *   KnowledgeAcquirer, Hyperliquid.
 * MultiSourceScanner: shadow-only mode.
 * ServicesModule: active only if margin-positive.
 *
 * Daily loss check: before every entry, every exit sim, once/min with position open.
 * Mode transition: shadow → micro requires operator confirm + pass criteria.
 *
 * Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 7.4, 7.5, 12.4, E3, E7, E8
 */

import { randomUUID } from 'node:crypto';

import type {
  TradingMode,
  MarketEvent,
  TradeCandidate,
  RegimeType,
  UsdcAmount,
  WethAmount,
  EthAmount,
  Position,
  ExecutableQuote,
} from './types.js';
import type { TradingValidationConfig } from './config.js';
import type { IMarketDataManager } from './market-data-manager.js';
import type { Indicators } from './strategy-engine.js';
import type { GateResult } from './cost-aware-trade-gate.js';
import type { SizingResult } from './position-sizer.js';
import type { SimulationResult, SwapSimulationParams } from './pre-trade-simulator.js';
import type { TransactionIntent } from './types.js';
import type { IntentParams } from './transaction-manager.js';
import type { ExpectedState } from './reconciliation-engine.js';
import type { ExitSignal, ExitResult } from './exit-manager.js';
import type { ReconciliationResult, BankrollState } from './types.js';
import type { ISmartAutoLender } from '../strategies/lending/smart-auto-lender.js';
import type { IPipelineObserver } from '../pipeline-metrics/pipeline-observer.js';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Modules disabled during trading validation phase.
 *
 * Rationale:
 * - AdaptiveEvolver/SelfMod: Could modify trading code mid-experiment, invalidating results
 * - Hyperliquid: Competes for same funds, would contaminate P&L metrics
 *
 * Modules ALLOWED to run (read-only, informational):
 * - OpportunityDiscovery: Scans for opportunities (no execution)
 * - KnowledgeAcquirer: Learns new protocols (no execution)
 * - SocialModule: Posts to Telegram/Discord (visibility, no fund impact)
 */
export const DISABLED_MODULES = [
  'AdaptiveEvolver',
  'SelfMod',
  'Hyperliquid',
] as const;

/** Orchestrator state for external monitoring */
export interface OrchestratorState {
  mode: TradingMode;
  running: boolean;
  lastEvaluation: number;
  lastDailyLossCheck: number;
  positionOpen: boolean;
  safeMode: boolean;
  killSwitch: boolean;
  evaluationCount: number;
  tradesExecuted: number;
  tradesShadowed: number;
  servicesActive: boolean;
  multiSourceScannerMode: 'shadow_only' | 'disabled';
}

/** Orchestrator logger interface */
export interface OrchestratorLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Operator confirm callback for mode transitions */
export interface IOperatorConfirmCallback {
  requestModeTransition(
    from: TradingMode,
    to: TradingMode,
    passResult: { passed: boolean; reasons: string[] },
  ): Promise<boolean>;
}

/** FeatureEngine adapter interface for indicator computation */
export interface IFeatureEngineAdapter {
  computeIndicators(timeframe: '15m' | '1h'): Indicators | null;
  getRegime(): RegimeType;
}

/** Strategy engine interface extended for orchestrator use */
export interface IOrchestratorStrategyEngine {
  evaluate(
    indicators1h: Indicators,
    indicators15m: Indicators,
    regime: RegimeType,
  ): TradeCandidate | null;
  isWarmedUp(): boolean;
  getCooldownRemaining(): number;
  hasOpenPosition(): boolean;
  setPositionOpen(open: boolean): void;
}

/** Trade gate interface as used by orchestrator */
export interface IOrchestratorTradeGate {
  evaluate(
    entryQuote: ExecutableQuote,
    exitQuote: ExecutableQuote,
    tradeSize: UsdcAmount,
    hasPrivateRpc: boolean,
  ): GateResult;
}

/** Position sizer interface as used by orchestrator */
export interface IOrchestratorPositionSizer {
  calculateSize(
    bankrollActive: UsdcAmount,
    stopDistanceFraction: number,
    confidence?: number,
  ): SizingResult;
}

/** Pre-trade simulator interface as used by orchestrator */
export interface IOrchestratorSimulator {
  simulateApproval(token: string, spender: string, amount: bigint): Promise<SimulationResult>;
  simulateSwap(params: SwapSimulationParams): Promise<SimulationResult>;
}

/** Transaction manager interface as used by orchestrator */
export interface IOrchestratorTransactionManager {
  submitIntent(intent: IntentParams): Promise<TransactionIntent>;
  ensureApproval(token: string, spender: string, amount: bigint): Promise<TransactionIntent | null>;
  getFailedTxCountToday(): number;
  getPendingIntent(): TransactionIntent | null;
  isAllowlisted(address: string): boolean;
}

/** Reconciliation engine interface as used by orchestrator */
export interface IOrchestratorReconciliation {
  reconcile(expected: ExpectedState, operationType: string): Promise<ReconciliationResult>;
}

/** Bankroll manager interface as used by orchestrator */
export interface IOrchestratorBankroll {
  getState(): BankrollState;
  canTrade(size: UsdcAmount): boolean;
  allocateLoss(amount: UsdcAmount): void;
  allocateProfit(amount: UsdcAmount): void;
  recordGas(gasUsd: UsdcAmount): void;
  getAvailableForTrading(): UsdcAmount;
}

/** Exit manager interface as used by orchestrator */
export interface IOrchestratorExitManager {
  registerPosition(position: Position): void;
  checkExits(currentPrice: number, currentRegime: RegimeType, timestamp: number): ExitSignal | null;
  onPriceUpdate(currentPrice: number): void;
  getOpenPosition(): Position | null;
  isExitPending(): boolean;
  executeExit(reason: import('./types.js').ExitReason, currentPrice: number, timestamp: number): Promise<ExitResult>;
}

/** Shadow trader interface as used by orchestrator */
export interface IOrchestratorShadowTrader {
  executeShadow(candidate: TradeCandidate, quote: ExecutableQuote, size: UsdcAmount): string;
  checkShadowExits(currentPrice: number, regime: RegimeType): void;
}

/** Quote engine interface as used by orchestrator */
export interface IOrchestratorQuoteEngine {
  getEntryQuote(amountInUsdc: UsdcAmount): Promise<ExecutableQuote>;
  getExitQuote(amountInWeth: WethAmount): Promise<ExecutableQuote>;
}

/** Safe mode controller interface as used by orchestrator */
export interface IOrchestratorSafeMode {
  trigger(reason: string, details?: string): void;
  canTrade(): boolean;
  canClosePosition(): boolean;
  getState(): { state: string; reason?: string; since?: number };
}

/** Experiment tracker interface as used by orchestrator */
export interface IOrchestratorExperimentTracker {
  recordTrade(trade: Position, mode: TradingMode): void;
  checkShadowPass(): { passed: boolean; reasons: string[] };
  checkMicroPass(): { passed: boolean; reasons: string[] };
}

/** Gas reserve manager interface as used by orchestrator */
export interface IOrchestratorGasReserve {
  canEnterTrade(estimatedGas: EthAmount): boolean;
  isCritical(): boolean;
}

/** DailyMetrics adapter for orchestrator */
export interface IDailyMetricsAdapter {
  recordEvaluation(): void;
  recordSignal(): void;
  recordTradeRejected(): void;
  recordTrade(): void;
  recordFailedTx(): void;
  getTradesCountToday(): number;
  getFailedTxCountToday(): number;
}

/** Services module interface (active only if margin-positive) */
export interface IServicesModule {
  isMarginPositive(): boolean;
  enable(): void;
  disable(): void;
}

/** MultiSourceScanner interface (shadow-only mode) */
export interface IMultiSourceScanner {
  setShadowOnly(enabled: boolean): void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Orchestrator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * TradingOrchestrator is the top-level coordinator that wires all trading
 * modules together. It handles the event-driven evaluation pipeline,
 * mode branching (shadow vs micro), daily loss checks, exit monitoring,
 * and module lifecycle management.
 */
export class TradingOrchestrator {
  private readonly config: TradingValidationConfig;
  private readonly logger: OrchestratorLogger;

  // Core pipeline modules
  private readonly marketData: IMarketDataManager;
  private readonly featureEngine: IFeatureEngineAdapter;
  private readonly strategyEngine: IOrchestratorStrategyEngine;
  private readonly tradeGate: IOrchestratorTradeGate;
  private readonly positionSizer: IOrchestratorPositionSizer;
  private readonly preTradeSimulator: IOrchestratorSimulator;
  private readonly transactionManager: IOrchestratorTransactionManager;
  private readonly reconciliationEngine: IOrchestratorReconciliation;
  private readonly bankrollManager: IOrchestratorBankroll;

  // Exit & shadow modules
  private readonly exitManager: IOrchestratorExitManager;
  private readonly shadowTrader: IOrchestratorShadowTrader;
  private readonly quoteEngine: IOrchestratorQuoteEngine;

  // Safety & tracking
  private readonly safeModeController: IOrchestratorSafeMode;
  private readonly experimentTracker: IOrchestratorExperimentTracker;
  private readonly gasReserveManager: IOrchestratorGasReserve;
  private readonly dailyMetrics: IDailyMetricsAdapter;

  // Optional integrations
  private readonly operatorConfirm: IOperatorConfirmCallback | null;
  private readonly servicesModule: IServicesModule | null;
  private readonly multiSourceScanner: IMultiSourceScanner | null;
  private readonly smartAutoLender: ISmartAutoLender | null;
  private readonly observer: IPipelineObserver | null;

  // Internal state
  private mode: TradingMode;
  private running = false;
  private exitMonitorTimer: ReturnType<typeof setInterval> | null = null;
  private dailyLossCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastEvaluation = 0;
  private lastDailyLossCheck = 0;
  private evaluationCount = 0;
  private tradesExecuted = 0;
  private tradesShadowed = 0;
  private evaluating = false; // mutex to prevent concurrent evaluations

  constructor(params: {
    config: TradingValidationConfig;
    logger: OrchestratorLogger;
    marketData: IMarketDataManager;
    featureEngine: IFeatureEngineAdapter;
    strategyEngine: IOrchestratorStrategyEngine;
    tradeGate: IOrchestratorTradeGate;
    positionSizer: IOrchestratorPositionSizer;
    preTradeSimulator: IOrchestratorSimulator;
    transactionManager: IOrchestratorTransactionManager;
    reconciliationEngine: IOrchestratorReconciliation;
    bankrollManager: IOrchestratorBankroll;
    exitManager: IOrchestratorExitManager;
    shadowTrader: IOrchestratorShadowTrader;
    quoteEngine: IOrchestratorQuoteEngine;
    safeModeController: IOrchestratorSafeMode;
    experimentTracker: IOrchestratorExperimentTracker;
    gasReserveManager: IOrchestratorGasReserve;
    dailyMetrics: IDailyMetricsAdapter;
    operatorConfirm?: IOperatorConfirmCallback;
    servicesModule?: IServicesModule;
    multiSourceScanner?: IMultiSourceScanner;
    smartAutoLender?: ISmartAutoLender;
    observer?: IPipelineObserver;
  }) {
    this.config = params.config;
    this.logger = params.logger;
    this.marketData = params.marketData;
    this.featureEngine = params.featureEngine;
    this.strategyEngine = params.strategyEngine;
    this.tradeGate = params.tradeGate;
    this.positionSizer = params.positionSizer;
    this.preTradeSimulator = params.preTradeSimulator;
    this.transactionManager = params.transactionManager;
    this.reconciliationEngine = params.reconciliationEngine;
    this.bankrollManager = params.bankrollManager;
    this.exitManager = params.exitManager;
    this.shadowTrader = params.shadowTrader;
    this.quoteEngine = params.quoteEngine;
    this.safeModeController = params.safeModeController;
    this.experimentTracker = params.experimentTracker;
    this.gasReserveManager = params.gasReserveManager;
    this.dailyMetrics = params.dailyMetrics;
    this.operatorConfirm = params.operatorConfirm ?? null;
    this.servicesModule = params.servicesModule ?? null;
    this.multiSourceScanner = params.multiSourceScanner ?? null;
    this.smartAutoLender = params.smartAutoLender ?? null;
    this.observer = params.observer ?? null;
    this.mode = params.config.mode;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start the orchestrator:
   * 1. Disable paused modules
   * 2. Configure MultiSourceScanner as shadow-only
   * 3. Wire MarketDataManager event handler
   * 4. Start exit monitoring loop
   * 5. Start daily loss check timer (1/min when position open)
   * 6. Start MarketDataManager
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.logger.info('Orchestrator starting', { mode: this.mode });

    // Disable paused modules (Req 10.3)
    this.disablePausedModules();

    // MultiSourceScanner: shadow-only mode (Req 10.4)
    if (this.multiSourceScanner) {
      this.multiSourceScanner.setShadowOnly(true);
    }

    // ServicesModule: active only if margin-positive (Req 10.5)
    this.updateServicesModuleState();

    // Wire market event handler (Req 10.1)
    this.marketData.onEvent((event: MarketEvent) => {
      // Notify SmartAutoLender of regime changes
      if (this.smartAutoLender && event.type === 'regime_change') {
        this.smartAutoLender.onRegimeChange(
          event.from ?? '',
          event.to ?? '',
        );
      }

      void this.handleMarketEvent(event);
    });

    // Start exit monitoring loop - independent from entry (Req E7)
    this.startExitMonitor();

    // Start daily loss check timer (1/min with position open)
    this.startDailyLossCheckTimer();

    // Start market data ingestion
    await this.marketData.start();

    this.logger.info('Orchestrator started successfully');
  }

  /**
   * Stop the orchestrator gracefully.
   * Does NOT close positions — that's ExitManager's responsibility.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;

    this.marketData.stop();

    if (this.exitMonitorTimer) {
      clearInterval(this.exitMonitorTimer);
      this.exitMonitorTimer = null;
    }

    if (this.dailyLossCheckTimer) {
      clearInterval(this.dailyLossCheckTimer);
      this.dailyLossCheckTimer = null;
    }

    this.logger.info('Orchestrator stopped');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Event Handler: MarketEvent → Evaluate → Gate → Size → Simulate → Execute
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Core event handler. Triggered on every MarketEvent from MarketDataManager.
   * Implements the full entry pipeline with mode branching.
   *
   * Requirements: 10.1, 10.2, E3, E8
   */
  private async handleMarketEvent(_event: MarketEvent): Promise<void> {
    // Mutex: prevent concurrent evaluations
    if (this.evaluating) {
      if (this.observer) {
        try { this.observer.onEvaluationSkipped('mutex'); } catch { /* never propagate */ }
      }
      return;
    }
    this.evaluating = true;

    try {
      // Pre-checks
      if (!this.running) {
        if (this.observer) {
          try { this.observer.onEvaluationSkipped('not_running'); } catch { /* never propagate */ }
        }
        return;
      }
      if (!this.canEvaluate()) {
        if (this.observer) {
          try { this.observer.onEvaluationSkipped('cannot_evaluate'); } catch { /* never propagate */ }
        }
        return;
      }

      const sessionId = randomUUID();
      if (this.observer) {
        try { this.observer.onEvaluationStarted(sessionId); } catch { /* never propagate */ }
      }

      this.dailyMetrics.recordEvaluation();
      this.evaluationCount++;
      this.lastEvaluation = Date.now();

      // Step 1: Compute indicators via FeatureEngine
      const indicators1h = this.featureEngine.computeIndicators('1h');
      const indicators15m = this.featureEngine.computeIndicators('15m');
      const regime = this.featureEngine.getRegime();

      if (!indicators1h || !indicators15m) {
        this.logger.warn('Indicators not available, skipping evaluation');
        if (this.observer) {
          try { this.observer.onIndicatorsResult(false); } catch { /* never propagate */ }
        }
        return;
      }

      if (this.observer) {
        try { this.observer.onIndicatorsResult(true, indicators1h, indicators15m); } catch { /* never propagate */ }
      }

      // Step 2: StrategyEngine evaluation
      const candidate = this.strategyEngine.evaluate(indicators1h, indicators15m, regime);

      if (this.observer) {
        try { this.observer.onStrategyResult(candidate, undefined, undefined); } catch { /* never propagate */ }
      }

      if (!candidate) return;

      // Notify SmartAutoLender of trade signal (resets idle timer)
      if (this.smartAutoLender) {
        this.smartAutoLender.onTradeSignal();
      }

      this.dailyMetrics.recordSignal();
      this.logger.info('Trade candidate generated', {
        id: candidate.id,
        strategy: candidate.strategy,
        confidence: candidate.confidence,
        regime,
      });

      // Step 3: Daily loss check before entry (Req E3)
      if (!this.passDailyLossCheck()) {
        this.logger.warn('Daily loss limit reached, rejecting candidate');
        this.dailyMetrics.recordTradeRejected();
        if (this.observer) {
          try { this.observer.onDailyLossLimitHit(); } catch { /* never propagate */ }
        }
        return;
      }

      // Step 4: Position sizing
      const bankrollState = this.bankrollManager.getState();
      const sizeResult = this.positionSizer.calculateSize(
        bankrollState.activeUsdc,
        candidate.stopDistanceFraction,
        candidate.confidence,
      );

      if (!sizeResult.valid) {
        this.logger.info('Position sizing rejected', { reason: sizeResult.reason });
        this.dailyMetrics.recordTradeRejected();
        if (this.observer) {
          try { this.observer.onPositionSizingResult(false, sizeResult.reason, undefined); } catch { /* never propagate */ }
        }
        return;
      }

      if (this.observer) {
        try { this.observer.onPositionSizingResult(true, undefined, sizeResult.sizeUsdc); } catch { /* never propagate */ }
      }

      // Step 5: Check bankroll can cover the trade
      if (!this.bankrollManager.canTrade(sizeResult.sizeUsdc)) {
        this.logger.warn('Bankroll insufficient for trade', {
          requestedSize: sizeResult.sizeUsdc.toString(),
        });
        this.dailyMetrics.recordTradeRejected();
        if (this.observer) {
          try { this.observer.onBankrollResult(false); } catch { /* never propagate */ }
        }
        return;
      }

      if (this.observer) {
        try { this.observer.onBankrollResult(true); } catch { /* never propagate */ }
      }

      // Step 5.5: Ensure funds available from Aave if needed
      if (this.smartAutoLender) {
        const availableBalance = this.bankrollManager.getAvailableForTrading();
        if (availableBalance < sizeResult.sizeUsdc) {
          const needed = sizeResult.sizeUsdc - availableBalance;
          const aaveResult = await this.smartAutoLender.ensureFunds(needed);
          if (!aaveResult.available) {
            this.logger.warn('Funds unavailable after Aave withdraw attempt');
            this.dailyMetrics.recordTradeRejected();
            if (this.observer) {
              try { this.observer.onAaveFundsResult(false); } catch { /* never propagate */ }
            }
            return;
          }
        }
        // Notify SmartAutoLender of trade signal (resets idle timer)
        this.smartAutoLender.onTradeSignal();
      }

      if (this.observer) {
        try { this.observer.onAaveFundsResult(true); } catch { /* never propagate */ }
      }

      // Step 6: Get quotes for gate evaluation
      const entryQuote = await this.quoteEngine.getEntryQuote(sizeResult.sizeUsdc);
      const exitQuote = await this.quoteEngine.getExitQuote(entryQuote.amountOut);

      // Step 7: CostAwareTradeGate evaluation
      const gateResult = this.tradeGate.evaluate(
        entryQuote,
        exitQuote,
        sizeResult.sizeUsdc,
        this.config.gate.hasPrivateRpc,
      );

      if (this.observer) {
        try { this.observer.onGateResult(gateResult); } catch { /* never propagate */ }
      }

      if (!gateResult.passed) {
        this.logger.info('Trade rejected by gate', {
          reasons: gateResult.rejectReasons,
          candidateId: candidate.id,
        });
        this.dailyMetrics.recordTradeRejected();
        return;
      }

      // Step 8: Mode branching
      if (this.mode === 'shadow') {
        await this.executeShadowTrade(candidate, entryQuote, sizeResult);
      } else {
        await this.executeMicroTrade(candidate, entryQuote, sizeResult);
      }

      if (this.observer) {
        try { this.observer.onTradeExecuted(this.mode as 'shadow' | 'micro', candidate.id); } catch { /* never propagate */ }
      }
    } catch (err) {
      this.logger.error('Error in market event handler', {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.evaluating = false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Shadow Mode Execution (Req 7.4, 7.5)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Execute trade in shadow mode: use ShadowTrader with executable quotes.
   * No on-chain transaction — just simulation with realistic cost modeling.
   */
  private async executeShadowTrade(
    candidate: TradeCandidate,
    entryQuote: ExecutableQuote,
    sizeResult: SizingResult,
  ): Promise<void> {
    try {
      // Execute shadow trade with executable quote
      const shadowId = this.shadowTrader.executeShadow(
        candidate,
        entryQuote,
        sizeResult.sizeUsdc,
      );

      this.tradesShadowed++;
      this.dailyMetrics.recordTrade();

      this.logger.info('Shadow trade executed', {
        shadowId,
        strategy: candidate.strategy,
        size: sizeResult.sizeUsdc.toString(),
      });
    } catch (err) {
      this.logger.error('Shadow trade execution failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Micro Mode Execution (Req 10.2, E8)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Execute trade in micro mode: full on-chain pipeline.
   * PreTradeSimulator → TransactionManager → ReconciliationEngine → BankrollManager
   */
  private async executeMicroTrade(
    candidate: TradeCandidate,
    entryQuote: ExecutableQuote,
    sizeResult: SizingResult,
  ): Promise<void> {
    try {
      // Check gas reserve before entry
      const gasEstimate = 300_000n * 2n * 30_000_000_000n; // ~0.018 ETH estimated
      if (!this.gasReserveManager.canEnterTrade(gasEstimate)) {
        this.logger.warn('Gas reserve insufficient, blocking entry');
        this.dailyMetrics.recordTradeRejected();
        return;
      }

      // Check max trades per day (Req E8)
      if (this.dailyMetrics.getTradesCountToday() >= this.config.risk.maxTradesDay) {
        this.logger.warn('Max daily trades reached');
        this.dailyMetrics.recordTradeRejected();
        return;
      }

      // Check max failed transactions per day (Req E2)
      if (this.dailyMetrics.getFailedTxCountToday() >= this.config.risk.maxFailedTxDay) {
        this.logger.warn('Max failed transactions/day reached, blocking entry');
        this.safeModeController.trigger('failed_tx_limit', 'Max failed TX threshold reached');
        return;
      }

      // Step A: Simulate approval
      const approvalSim = await this.preTradeSimulator.simulateApproval(
        this.config.contracts.usdc,
        this.config.contracts.swapRouter,
        sizeResult.sizeUsdc,
      );

      if (!approvalSim.success) {
        this.logger.error('Approval simulation failed', {
          reason: approvalSim.revertReason,
        });
        this.dailyMetrics.recordFailedTx();
        return;
      }

      // Step B: Simulate swap
      const minAmountOut = this.calculateMinAmountOut(entryQuote.amountOut);
      const swapSim = await this.preTradeSimulator.simulateSwap({
        tokenIn: this.config.contracts.usdc,
        tokenOut: this.config.contracts.weth,
        amountIn: sizeResult.sizeUsdc,
        amountOutMinimum: minAmountOut,
        fee: this.config.quoteEngine.feeTier,
        recipient: this.config.txManager.walletAddress,
        sqrtPriceLimitX96: 0n, // 0 = no price limit (standard for exact input)
      });

      if (!swapSim.success) {
        this.logger.error('Swap simulation failed', { reason: swapSim.revertReason });
        this.dailyMetrics.recordFailedTx();
        return;
      }

      // Step C: Ensure approval is sufficient (submits approval tx if needed)
      const approvalIntent = await this.transactionManager.ensureApproval(
        this.config.contracts.usdc,
        this.config.contracts.swapRouter,
        sizeResult.sizeUsdc,
      );

      if (approvalIntent && approvalIntent.state === 'reverted') {
        this.logger.error('Approval transaction reverted', {
          reason: approvalIntent.revertReason,
        });
        this.dailyMetrics.recordFailedTx();
        return;
      }

      // Step D: Submit swap intent
      const swapIntent = await this.transactionManager.submitIntent({
        id: `entry-${candidate.id}`,
        contractAddress: this.config.contracts.swapRouter,
        functionName: 'exactInputSingle',
        gasLimit: swapSim.gasUsed * 130n / 100n, // 30% buffer
        operationType: 'entry',
      });

      if (swapIntent.state === 'reverted' || swapIntent.state === 'dropped') {
        this.logger.error('Swap transaction failed', {
          state: swapIntent.state,
          reason: swapIntent.revertReason,
        });
        this.dailyMetrics.recordFailedTx();
        return;
      }

      // Step E: Reconciliation
      const reconResult = await this.reconciliationEngine.reconcile(
        {
          intentId: swapIntent.id,
          expectedUsdc: bankrollStateUsdc(this.bankrollManager, sizeResult.sizeUsdc, 'subtract'),
          expectedWeth: minAmountOut,
          txHash: swapIntent.txHash ?? '',
          operationSizeUsdc: sizeResult.sizeUsdc,
          gasEthSpent: swapIntent.gasLimit, // approximation
        },
        'entry',
      );

      if (!reconResult.matched) {
        this.logger.error('Reconciliation mismatch after entry', {
          deviation: reconResult.deviationUsdc.toString(),
        });
        // Safe mode is triggered internally by reconciliation engine on threshold breach
      }

      // Step F: Update bankroll with gas costs
      this.bankrollManager.recordGas(reconResult.gasUsdEquivalent);

      // Step G: Register position with ExitManager
      const entryPrice = this.marketData.getLatestPrice() ?? 0;
      const position: Position = {
        id: swapIntent.id,
        intentId: swapIntent.id,
        entryPrice,
        entryTimestamp: Date.now(),
        sizeUsdc: sizeResult.sizeUsdc,
        sizeWeth: minAmountOut,
        stopLoss: entryPrice * (1 - candidate.stopDistanceFraction),
        takeProfit: entryPrice * (1 + candidate.takeProfitFraction),
        maxHoldingMs: this.config.exitManager.maxHoldingMs,
        entryRegime: candidate.regime,
        strategy: candidate.strategy,
      };

      this.exitManager.registerPosition(position);
      this.strategyEngine.setPositionOpen(true);
      this.smartAutoLender?.setHasOpenPosition(true);

      // Step H: Record trade in experiment tracker
      this.experimentTracker.recordTrade(position, this.mode);

      this.tradesExecuted++;
      this.dailyMetrics.recordTrade();

      this.logger.info('Micro trade executed successfully', {
        positionId: position.id,
        entryPrice,
        size: sizeResult.sizeUsdc.toString(),
        strategy: candidate.strategy,
      });
    } catch (err) {
      this.logger.error('Micro trade execution failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.dailyMetrics.recordFailedTx();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Exit Monitor Loop (Independent from Entry) (Req E7)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start the exit monitoring loop.
   * Checks exits every 5 seconds for open positions.
   * Also checks shadow exits at the same interval.
   */
  private startExitMonitor(): void {
    const EXIT_CHECK_INTERVAL_MS = 5_000;

    this.exitMonitorTimer = setInterval(() => {
      if (!this.running) return;
      void this.checkExits();
    }, EXIT_CHECK_INTERVAL_MS);
  }

  /**
   * Check exit conditions for both real and shadow positions.
   */
  private async checkExits(): Promise<void> {
    const currentPrice = this.marketData.getLatestPrice();
    if (currentPrice === null) return;

    const regime = this.featureEngine.getRegime();
    const now = Date.now();

    // Check shadow exits (always active)
    this.shadowTrader.checkShadowExits(currentPrice, regime);

    // Check real position exits (micro mode only)
    const openPosition = this.exitManager.getOpenPosition();
    if (!openPosition) return;

    // Update MFE/MAE tracking
    this.exitManager.onPriceUpdate(currentPrice);

    // Check exit conditions
    const exitSignal = this.exitManager.checkExits(currentPrice, regime, now);
    if (!exitSignal) return;

    this.logger.info('Exit signal detected', {
      reason: exitSignal.reason,
      positionId: exitSignal.positionId,
      currentPrice,
    });

    // Execute exit
    try {
      const exitResult = await this.exitManager.executeExit(
        exitSignal.reason,
        currentPrice,
        now,
      );

      if (exitResult.success) {
        // Release position lock on strategy engine
        this.strategyEngine.setPositionOpen(false);
        this.smartAutoLender?.setHasOpenPosition(false);

        this.logger.info('Position exited successfully', {
          reason: exitSignal.reason,
          txHash: exitResult.txHash,
        });
      } else {
        this.logger.error('Exit execution failed', {
          reason: exitResult.reason,
        });
      }
    } catch (err) {
      this.logger.error('Exit execution error', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Daily Loss Check (Req E3)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Start timer for daily loss check (every 60s when position open).
   */
  private startDailyLossCheckTimer(): void {
    const DAILY_LOSS_CHECK_INTERVAL_MS = 60_000; // 1 minute

    this.dailyLossCheckTimer = setInterval(() => {
      if (!this.running) return;

      // Only run periodic check when position is open
      if (this.exitManager.getOpenPosition()) {
        this.passDailyLossCheck();
      }
    }, DAILY_LOSS_CHECK_INTERVAL_MS);
  }

  /**
   * Check if daily loss limit has been reached.
   * Returns true if trading is still allowed, false if limit breached.
   *
   * Daily loss = daily_realized_pnl (losses) + daily_gas_spent + unrealized_pnl (losses)
   * Limit: $3.00 (config.risk.maxDailyLossUsdc)
   */
  private passDailyLossCheck(): boolean {
    const state = this.bankrollManager.getState();
    const totalDailyLoss =
      (state.dailyRealizedPnl < 0n ? -state.dailyRealizedPnl : 0n) +
      state.dailyGasSpent +
      (state.unrealizedPnl < 0n ? -state.unrealizedPnl : 0n);

    const limitBreached = totalDailyLoss >= this.config.risk.maxDailyLossUsdc;

    if (limitBreached) {
      this.lastDailyLossCheck = Date.now();
      this.logger.warn('Daily loss limit breached', {
        totalDailyLoss: totalDailyLoss.toString(),
        limit: this.config.risk.maxDailyLossUsdc.toString(),
      });
    }

    return !limitBreached;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Mode Transition Logic (Req 10.2)
  // Shadow → Micro requires: operator confirm + pass criteria
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Attempt mode transition from shadow to micro.
   * Requirements:
   * - Shadow pass criteria met (≥10 trades, net P&L ≥ 0, ≥20 or 7 days, operator confirm)
   * - Operator confirmation
   *
   * Returns true if transition succeeded.
   */
  async requestModeTransition(): Promise<boolean> {
    if (this.mode !== 'shadow') {
      this.logger.warn('Mode transition only supported from shadow to micro');
      return false;
    }

    // Check shadow pass criteria
    const passResult = this.experimentTracker.checkShadowPass();
    if (!passResult.passed) {
      this.logger.info('Shadow pass criteria not met', { reasons: passResult.reasons });
      return false;
    }

    // Request operator confirmation
    if (!this.operatorConfirm) {
      this.logger.warn('No operator confirm callback configured');
      return false;
    }

    const confirmed = await this.operatorConfirm.requestModeTransition(
      'shadow',
      'micro',
      passResult,
    );

    if (!confirmed) {
      this.logger.info('Operator rejected mode transition');
      return false;
    }

    // Execute transition
    this.mode = 'micro';
    this.logger.info('Mode transitioned to micro', {
      previousShadowTrades: this.tradesShadowed,
    });

    return true;
  }

  /**
   * Get current mode.
   */
  getMode(): TradingMode {
    return this.mode;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Pre-Evaluation Guards
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Determine if the system can evaluate a new trade signal.
   */
  private canEvaluate(): boolean {
    // SafeMode / KillSwitch blocks new entries
    if (!this.safeModeController.canTrade()) {
      return false;
    }

    // Market data must be valid (not stale)
    if (!this.marketData.isValid()) {
      return false;
    }

    // Already have open position (max 1) in micro mode
    if (this.exitManager.getOpenPosition() !== null && this.mode === 'micro') {
      return false;
    }

    // Max experiment loss check
    const bankrollState = this.bankrollManager.getState();
    if (bankrollState.experimentTotalPnl <= -this.config.risk.maxExperimentLoss) {
      this.logger.warn('Max experiment loss reached, blocking evaluation');
      return false;
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Module Management
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Disable paused modules per spec (Req 10.3).
   * These modules are not active during trading validation phase.
   */
  private disablePausedModules(): void {
    this.logger.info('Disabled modules for trading validation phase', {
      modules: [...DISABLED_MODULES],
    });
    // The actual disabling is handled by not instantiating these modules
    // and by the AgentCore config. This is logged for audit trail.
  }

  /**
   * Update ServicesModule state based on margin positivity (Req 10.5).
   */
  private updateServicesModuleState(): void {
    if (!this.servicesModule) return;

    if (this.servicesModule.isMarginPositive()) {
      this.servicesModule.enable();
    } else {
      this.servicesModule.disable();
    }
  }

  /**
   * Calculate minimum amount out with slippage protection.
   * Uses configured slippage (40 bps with private RPC, 30 bps without).
   */
  private calculateMinAmountOut(quotedAmountOut: bigint): bigint {
    const slippageBps = this.config.gate.hasPrivateRpc
      ? this.config.gate.maxSlippageBps
      : 30; // stricter without private RPC

    return quotedAmountOut * BigInt(10_000 - slippageBps) / 10_000n;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // State Accessors
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Get current orchestrator state for monitoring/API.
   */
  getState(): OrchestratorState {
    const safeModeState = this.safeModeController.getState();
    return {
      mode: this.mode,
      running: this.running,
      lastEvaluation: this.lastEvaluation,
      lastDailyLossCheck: this.lastDailyLossCheck,
      positionOpen: this.exitManager.getOpenPosition() !== null,
      safeMode: safeModeState.state === 'safe_mode',
      killSwitch: safeModeState.state === 'kill_switch',
      evaluationCount: this.evaluationCount,
      tradesExecuted: this.tradesExecuted,
      tradesShadowed: this.tradesShadowed,
      servicesActive: this.servicesModule?.isMarginPositive() ?? false,
      multiSourceScannerMode: 'shadow_only',
    };
  }

  /**
   * Check if orchestrator is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Helper to compute expected USDC balance after an operation.
 * This is a rough helper — actual reconciliation uses on-chain queries.
 */
function bankrollStateUsdc(
  bankroll: IOrchestratorBankroll,
  operationAmount: UsdcAmount,
  direction: 'subtract' | 'add',
): UsdcAmount {
  const state = bankroll.getState();
  return direction === 'subtract'
    ? state.totalUsdc - operationAmount
    : state.totalUsdc + operationAmount;
}

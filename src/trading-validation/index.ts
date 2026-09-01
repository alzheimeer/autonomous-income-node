/**
 * Trading Validation Phase - Barrel Export
 *
 * All shared types, interfaces, and market event types for the trading validation system.
 */

export type {
  // Amount types
  UsdcAmount,
  WethAmount,
  EthAmount,

  // Union types
  TradingMode,
  RegimeType,
  StrategyType,
  ExitReason,
  IntentState,

  // Market data types
  CandleData,
  MarketEvent,

  // Core trading interfaces
  TradeCandidate,
  ExecutableQuote,
  SizedTrade,
  Position,
  TransactionIntent,
  BankrollState,
  ReconciliationResult,
} from './types.js';

// Migrations
export { runMigrations } from './migrations.js';

// Configuration
export {
  loadConfig,
  computeConfigHash,
  validateConfig,
  isValidChecksumAddress,
} from './config.js';

// Market Data Manager
export { MarketDataManager } from './market-data-manager.js';
export type {
  IMarketDataManager,
  IWebSocketClient,
  WebSocketFactory,
  IFetchClient,
  IAlertCallback,
} from './market-data-manager.js';

export type {
  TradingValidationConfig,
  BankrollManagerConfig,
  RiskConfig,
  TradeGateConfig,
  StrategyEngineConfig,
  MarketDataConfig,
  QuoteEngineConfig,
  TransactionManagerConfig,
  PositionSizerConfig,
  ExitManagerConfig,
  GasReserveConfig,
  ReconciliationConfig,
  ExperimentConfig,
  AiBudgetConfig,
  ContractsConfig,
  AlertsConfig,
  ConfigValidationError,
} from './config.js';

// Bankroll Manager
export { BankrollManager } from './bankroll-manager.js';
export type { IBankrollManager } from './bankroll-manager.js';

// Gas Reserve Manager
export {
  GasReserveManager,
  GAS_PER_CYCLE_UNITS,
  APPROVAL_GAS_UNITS,
  SWAP_GAS_UNITS,
} from './gas-reserve-manager.js';

export type {
  IGasReserveManager,
  IEthBalanceProvider,
  ISafeModeTrigger,
} from './gas-reserve-manager.js';

// Executable Quote Engine
export { ExecutableQuoteEngine } from './executable-quote-engine.js';
export type {
  IExecutableQuoteEngine,
  IQuoterV2Provider,
  QuoteExactInputSingleParams,
  QuoterV2Result,
  IAggregatorProvider,
  AggregatorQuoteResult,
  IBinancePriceProvider,
  IGasPriceProvider,
  IQuoteLogger,
  QuoteLogEntry,
} from './executable-quote-engine.js';

// Strategy Engine
export { StrategyEngine } from './strategy-engine.js';
export type { IStrategyEngine, Indicators } from './strategy-engine.js';

// Cost-Aware Trade Gate
export { CostAwareTradeGate } from './cost-aware-trade-gate.js';
export type {
  ICostAwareTradeGate,
  GateResult,
  CostBreakdown,
  IQuoteProvider,
  IGateSimulationProvider,
  ILiquidityProvider,
  GateLogger,
} from './cost-aware-trade-gate.js';

// Position Sizer
export { PositionSizer } from './position-sizer.js';
export type {
  IPositionSizer,
  SizingResult,
  SizingLogger,
} from './position-sizer.js';

// Safe Mode Controller
export { SafeModeController } from './safe-mode-controller.js';
export type {
  ISafeModeController,
  SafeModeState,
  SafeModeTrigger,
  SafeModeSnapshot,
  OperatorAuth as SafeModeOperatorAuth,
  IAlertCallback as ISafeModeAlertCallback,
} from './safe-mode-controller.js';

// Pre-Trade Simulator
export {
  PreTradeSimulator,
  GAS_BUDGET_LIMITS,
  encodeApprove,
  encodeExactInputSingle,
  encodeWithdraw,
  decodeRevertReason,
} from './pre-trade-simulator.js';
export type {
  IPreTradeSimulator,
  SimulationResult,
  SwapSimulationParams,
  GasCategory,
  ISimulationProvider,
  EthCallParams,
  EthCallResult,
  ISimulationGasPriceProvider,
} from './pre-trade-simulator.js';

// Transaction Manager
export { TransactionManager } from './transaction-manager.js';
export type {
  ITransactionManager,
  IntentParams,
  SubmitResult,
  TxReceipt,
  ITxProvider,
  ITxSigner,
  SignTxParams,
  ITxLogger,
} from './transaction-manager.js';

// Exit Manager
export { ExitManager } from './exit-manager.js';
export type {
  IExitManager,
  ExitSignal,
  ExitResult,
  TrackedPosition,
  PositionState,
  ExternalStateProvider,
  GetQuoteCallback,
  SimulateExitCallback,
  ExecuteExitCallback,
  ExitLogger,
} from './exit-manager.js';

// Reconciliation Engine
export { ReconciliationEngine } from './reconciliation-engine.js';
export type {
  IReconciliationEngine,
  ExpectedState,
  IReconciliationProvider,
  IReconciliationSafeModeController,
  IReconciliationLogger,
} from './reconciliation-engine.js';

// Experiment Tracker
export { ExperimentTracker } from './experiment-tracker.js';
export type {
  IExperimentTracker,
  ExperimentTrade,
  PassResult,
  BenchmarkComparison,
  ExperimentReport,
  IExperimentDataProvider,
  ExperimentLogger,
} from './experiment-tracker.js';

// Operator Authenticator
export { OperatorAuthenticator, hashValue } from './operator-authenticator.js';
export type {
  IOperatorAuthenticator,
  OperatorAuth,
  OperatorAuthenticatorConfig,
  ISecurityAlertCallback,
} from './operator-authenticator.js';

// Orchestrator
export { TradingOrchestrator, DISABLED_MODULES } from './orchestrator.js';
export type {
  OrchestratorState,
  OrchestratorLogger,
  IOperatorConfirmCallback,
  IFeatureEngineAdapter,
  IOrchestratorStrategyEngine,
  IOrchestratorTradeGate,
  IOrchestratorPositionSizer,
  IOrchestratorSimulator,
  IOrchestratorTransactionManager,
  IOrchestratorReconciliation,
  IOrchestratorBankroll,
  IOrchestratorExitManager,
  IOrchestratorShadowTrader,
  IOrchestratorQuoteEngine,
  IOrchestratorSafeMode,
  IOrchestratorExperimentTracker,
  IOrchestratorGasReserve,
  IDailyMetricsAdapter,
  IServicesModule,
  IMultiSourceScanner,
} from './orchestrator.js';

// Startup Recovery
export { StartupRecovery } from './startup-recovery.js';
export type {
  IOnChainProvider,
  IRecoverySafeModeController,
  IRecoveryExitManager,
  IRecoveryLogger,
  PersistedState,
  PhaseState,
  NonceState,
  ApprovalRecord,
  OnChainState,
  RecoveryResult,
  ResolvedIntent,
  StartupRecoveryConfig,
} from './startup-recovery.js';

// MEV Protection and Slippage Monitoring
export {
  MevProtectionEngine,
  createDefaultMevConfig,
} from './mev-protection.js';
export type {
  MevProtectionConfig,
  SlippageLogEntry,
  MevValidationResult,
  ISafeModeCallback,
  IAlertCallback as IMevAlertCallback,
} from './mev-protection.js';

// Daily Metrics and AI Budget
export { DailyMetricsManager, redactSecrets, selectLlmModel } from './daily-metrics.js';
export type {
  AiCostCategory,
  LlmModelTier,
  AlertSeverity,
  DailyMetricsSnapshot,
  AiBudgetStatus,
  LlmCallRecord,
  IAlertSender,
  IBackupTrigger,
  ISafeModeForMetrics,
  IDailyMetricsDb,
} from './daily-metrics.js';

// API Routes
export { registerTradingRoutes } from './api-routes.js';
export type { TradingApiDeps } from './api-routes.js';

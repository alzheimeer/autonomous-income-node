/**
 * Copy-Trading Smart Money Module
 *
 * Sistema de copy-trading que monitorea wallets "smart money" curadas en tiempo real
 * y replica automáticamente sus trades de manera proporcional.
 *
 * Arquitectura de módulos:
 * - SmartMoneyCurator: Selección y mantenimiento de wallets a seguir
 * - WalletWatcher: Monitoreo de eventos on-chain en tiempo real
 * - SignalEnricher: Validación y enriquecimiento de señales
 * - CopyExecutor: Ejecución de trades con sizing dinámico
 * - ExitManager: Gestión de estrategias de salida
 * - AntiBaitingModule: Protección contra manipulación
 * - CopyMetricsRecorder: Persistencia de métricas y reporting
 *
 * Módulos compartidos reutilizados de src/shared/:
 * - DexQuoter: Cotizaciones DEX via staticCall
 * - RiskBucket: Gestión de riesgo y circuit breaker
 * - MetricsRecorder: Persistencia base de métricas en PostgreSQL
 * - ContractValidator: Validación de honeypots y liquidez
 *
 * @module copy-trading
 * @see requirements.md para requisitos completos
 * @see design.md para arquitectura técnica
 */

// =============================================================================
// Configuration Exports
// =============================================================================
export { CopyTradingConfig, loadCopyTradingConfig } from './config/CopyTradingConfig.js';

// =============================================================================
// Interface/Type Exports
// =============================================================================
export type {
  WalletTier,
  SwapAction,
  WalletInclusionCriteria,
  WalletExclusionFilters,
  SmartMoneyWallet,
  ISmartMoneyCurator,
  CopySignal,
  EnrichedSignal,
  EnrichmentRejectReason,
  CopyPosition,
  ExecutionResult,
  ExecutionRejectReason,
  ExitReason,
  ExitRecord,
} from './interfaces/types.js';

// =============================================================================
// Module Exports
// =============================================================================
export {
  SmartMoneyCurator,
  DEFAULT_INCLUSION_CRITERIA,
  type WalletMetrics,
  type InclusionEvaluationResult,
  type SmartMoneyCuratorConfig,
} from './modules/SmartMoneyCurator.js';

export {
  AntiBaitingModule,
  createAntiBaitingModule,
  DEFAULT_DEPLOYER_LOOKBACK_DAYS,
  DEFAULT_EXECUTION_DELAY_MS as DEFAULT_ANTI_BAITING_DELAY_MS,
  DEFAULT_ROUND_TRIP_WINDOW_MS,
  DEFAULT_MAX_BAIT_FLAGS,
  DEFAULT_FLAG_WINDOW_MS,
  DEFAULT_MAX_MONITORED_HOLDERS_PCT,
  DEFAULT_MAX_VOLUME_FOOTPRINT_PCT,
  type AntiBaitingModuleConfig,
  type AntiBaitingStats,
  type DeployerCacheEntry,
} from './modules/AntiBaitingModule.js';

export {
  CopyExecutor,
  createCopyExecutor,
  createCopyExecutorWithRiskManager,
  DEFAULT_TIER_MULTIPLIERS,
  MIN_POSITION_USDC,
  DEFAULT_COPY_RATIO,
  DEFAULT_MAX_CAPITAL_PCT,
  DEFAULT_MAX_POSITION_USDC,
  DEFAULT_EXECUTION_DELAY_MS,
  DEFAULT_SPLIT_THRESHOLD_USDC,
  DEFAULT_SPLIT_COUNT,
  DEFAULT_SPLIT_DELAY_MS,
  DEFAULT_BASE_SLIPPAGE_PCT,
  DEFAULT_SLIPPAGE_PER_MISSING_LIQUIDITY,
  DEFAULT_MAX_SLIPPAGE_PCT,
  DEFAULT_MAX_GAS_GWEI,
  type CopyExecutorConfig,
  type PositionSizeResult,
} from './modules/CopyExecutor.js';

export {
  CopyTradingRiskManager,
  createCopyTradingRiskManager,
  MAX_CONCURRENT_POSITIONS,
  MAX_DAILY_CAPITAL_PCT,
  DAILY_PNL_LOSS_THRESHOLD_PCT,
  MAX_POSITION_DRAWDOWN_PCT,
  MIN_CAPITAL_RESERVE_PCT,
  CIRCUIT_BREAKER_DURATION_MS,
  type TradeAllowedResult,
  type CopyTradingRiskManagerConfig,
  type CopyTradingCircuitBreakerState,
  type IPositionTracker,
} from './modules/CopyTradingRiskManager.js';

// TODO: Export WalletWatcher (Task 7)
// TODO: Export SignalEnricher (Task 9) - export blocked by compilation issue

export {
  CopyMetricsRecorder,
  createCopyMetricsRecorder,
  type SignalValidationResult,
  type CopySignalRecord,
  type CopyPositionRecord,
  type ICopyMetricsRecorder,
} from './modules/CopyMetricsRecorder.js';

export {
  ExitManager,
  TrailingStopStateMachine,
  createExitManager,
  createDefaultExitStrategyConfig,
  DEFAULT_MONITORING_INTERVAL_MS,
  DEFAULT_TAKE_PROFIT_PCT,
  DEFAULT_STOP_LOSS_PCT,
  DEFAULT_TRAILING_INITIAL_DISTANCE_PCT,
  DEFAULT_TRAILING_ACTIVATION_PCT,
  DEFAULT_TRAILING_DISTANCE_PCT,
  DEFAULT_TIME_STOP_HOURS,
  DEFAULT_FOLLOW_INSIDER_THRESHOLD_PCT,
  DEFAULT_FOLLOW_INSIDER_MAX_WAIT_MS,
  DEFAULT_FOLLOW_INSIDER_EXECUTE_WINDOW_MS,
  RUG_PULL_QUOTE_FAIL_THRESHOLD,
  type ExitManagerConfig,
  type PositionState,
  type ExitEvent,
  type ExitManagerStats,
} from './modules/ExitManager.js';

// =============================================================================
// HTTP API Routes Export (Task 21)
// =============================================================================
export {
  CopyTradingAPI,
  createCopyTradingAPI,
  type CopyTradingRouteDeps,
  type SystemStatusResponse,
  type WalletListResponse,
  type PositionWithPnL,
  type PositionsListResponse,
  type CircuitBreakerResetResponse,
  type AggregatedMetricsResponse,
} from './routes/copy.js';

// =============================================================================
// Orchestrator Export (Task 23)
// =============================================================================
export {
  CopyTradingOrchestrator,
  type CopyTradingOrchestratorDeps,
  type OrchestratorStatus,
  type ShutdownResult,
  type SignalProcessingStats,
} from './CopyTradingOrchestrator.js';



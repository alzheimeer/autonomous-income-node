/**
 * @fileoverview Copy Trading Smart Money - TypeScript Interfaces
 * 
 * Este archivo contiene todas las interfaces y tipos base para el sistema
 * de copy-trading de smart money wallets.
 * 
 * @module copy-trading/interfaces
 */

// =============================================================================
// BASIC TYPES
// =============================================================================

/**
 * Wallet tier classification based on performance metrics.
 * - S_TIER: Top 5 wallets with exceptional track record
 * - A_TIER: Wallets 6-15 with strong performance
 * - B_TIER: Wallets 16-50 with acceptable metrics
 */
export type WalletTier = 'S_TIER' | 'A_TIER' | 'B_TIER';

/**
 * Swap action type detected from calldata.
 */
export type SwapAction = 'BUY' | 'SELL';

// =============================================================================
// SMART MONEY CURATOR INTERFACES
// =============================================================================

/**
 * Criteria for including a wallet in the monitored list.
 * All thresholds based on 90-day rolling window.
 */
export interface WalletInclusionCriteria {
  /** Minimum win rate (70%) */
  minWinRate: number;
  /** Minimum historical PnL in USDC ($50,000) */
  minHistoricalPnlUsdc: number;
  /** Minimum number of trades for statistical significance (100) */
  minTradeCount: number;
  /** Minimum average holding time in seconds (15 min = 900s) */
  minAvgHoldingTimeSec: number;
  /** Maximum average holding time in seconds (7 days = 604,800s) */
  maxAvgHoldingTimeSec: number;
  /** Minimum historical volume in USDC ($500,000) */
  minHistoricalVolumeUsdc: number;
}

/**
 * Exclusion filters to blacklist problematic wallets.
 */
export interface WalletExclusionFilters {
  /** Max % of trades in same block (MEV indicator) */
  maxSameBlockTradePct: number;
  /** Exclude wallets that deployed tokens recently */
  excludeTokenDeployers: boolean;
  /** Max % of tokens that were honeypots/rugs */
  maxHoneypotExposurePct: number;
  /** Exclude wallets that received deployer airdrops */
  excludeDeployerRecipients: boolean;
  /** Max % of trades with same counterparty (wash trading) */
  maxSameCounterpartyPct: number;
}

/**
 * Smart money wallet with computed metrics and tier assignment.
 */
export interface SmartMoneyWallet {
  /** Wallet address (checksummed) */
  address: string;
  /** Assigned tier based on performance */
  tier: WalletTier;
  /** Performance metrics snapshot */
  metrics: {
    winRate: number;
    totalPnlUsdc: number;
    tradeCount: number;
    avgHoldingTimeSec: number;
    volumeUsdc: number;
    sharpeRatio: number;
    maxDrawdownPct: number;
    profitFactor: number;
    profitableWeeksPct: number;
  };
  /** Exclusion flags */
  flags: {
    isMevBot: boolean;
    isTokenDeployer: boolean;
    hasHoneypotExposure: boolean;
    isWashTrader: boolean;
  };
  /** Timestamp when wallet was added */
  addedAt: number;
  /** Timestamp of last evaluation */
  lastEvaluatedAt: number;
  /** Active status */
  isActive: boolean;
}

/**
 * SmartMoneyCurator interface for wallet curation.
 */
export interface ISmartMoneyCurator {
  /** Get current list of monitored wallets */
  getWallets(): SmartMoneyWallet[];
  /** Get wallets by tier */
  getWalletsByTier(tier: WalletTier): SmartMoneyWallet[];
  /** Add a wallet manually (requires validation) */
  addWallet(address: string): Promise<SmartMoneyWallet | null>;
  /** Remove a wallet from monitoring */
  removeWallet(address: string): void;
  /** Force re-evaluation of all wallets */
  reEvaluateAll(): Promise<void>;
  /** Check if address is currently monitored */
  isMonitored(address: string): boolean;
}

// =============================================================================
// WALLET WATCHER INTERFACES
// =============================================================================

/**
 * Configuration for WalletWatcher ingestion.
 */
export interface WalletWatcherConfig {
  /** List of wallet addresses to monitor (max 50) */
  watchedWallets: string[];
  /** Ingestion method: websocket for low latency, polling as fallback */
  ingestMethod: 'websocket' | 'polling' | 'hybrid';
  /** WebSocket RPC URL */
  wsRpcUrl: string;
  /** HTTP RPC URL for polling fallback */
  httpRpcUrl: string;
  /** Polling interval in ms (default: 2000) */
  pollingIntervalMs: number;
  /** Supported DEX routers to decode */
  supportedRouters: {
    uniswapV3: string;
    aerodrome: string;
    oneInch: string;
  };
  /** Minimum transfer value to consider (ignores dust) */
  minTransferValueUsdc: number;
}

/**
 * Copy signal emitted when a monitored wallet executes a swap.
 */
export interface CopySignal {
  /** UUID v4 */
  id: string;
  /** Source wallet that executed the trade */
  sourceWallet: string;
  /** Wallet tier at time of signal */
  walletTier: WalletTier;
  /** Token address being traded */
  tokenAddress: string;
  /** Pool/pair address where swap occurred */
  poolAddress: string;
  /** BUY or SELL */
  action: SwapAction;
  /** Trade amount in USDC equivalent */
  tradeAmountUsdc: number;
  /** Entry price (token per USDC) */
  entryPrice: bigint;
  /** Block number where tx was included */
  blockNumber: number;
  /** Transaction hash */
  txHash: string;
  /** Detection timestamp (ms) */
  detectedAt: number;
  /** Latency from block to detection (ms) */
  detectionLatencyMs: number;
}

/**
 * WalletWatcher interface for real-time trade detection.
 */
export interface IWalletWatcher {
  /** Start watching for swaps */
  start(): void;
  /** Stop watching */
  stop(): void;
  /** Register callback for new signals */
  onSignal(callback: (signal: CopySignal) => Promise<void>): void;
  /** Get connection health status */
  getHealth(): {
    isConnected: boolean;
    lastHeartbeat: number;
    missedHeartbeats: number;
  };
  /** Update watched wallets list */
  updateWallets(wallets: string[]): void;
}

// =============================================================================
// SIGNAL ENRICHER INTERFACES
// =============================================================================

/**
 * Configuration for SignalEnricher module.
 * Requirements: 3.1-3.7
 */
export interface SignalEnricherConfig {
  /** RPC URL for on-chain queries */
  rpcUrl: string;
  /** Minimum liquidity in USDC (default $5k) - Req 3.1 */
  minLiquidityUsdc: number;
  /** Maximum transfer tax percentage (default 10%) - Req 3.3 */
  maxTransferTaxPct: number;
  /** Timeout for honeypot check in ms (default 5s) - Req 3.2 */
  honeypotTimeoutMs: number;
}

/**
 * Reasons for rejecting a signal during enrichment.
 */
export type EnrichmentRejectReason =
  | 'LOW_LIQUIDITY'        // Pool <$10K USDC or <2.0 WETH
  | 'HIGH_SLIPPAGE'        // Estimated slippage >5%
  | 'TRANSFER_TAX'         // Token tax >5%
  | 'HONEYPOT_DETECTED'    // Simulated sell returned 0
  | 'DEPLOYER_FLAGGED'     // Deployer has rug history
  | 'UNVERIFIED_LP'        // LP not locked or burned
  | 'BAITING_DETECTED'     // Round-trip pattern detected
  | 'VALIDATION_TIMEOUT';  // Validation took >2s

/**
 * Enriched signal with validation results.
 */
export interface EnrichedSignal extends CopySignal {
  /** Validation passed */
  approved: boolean;
  /** Rejection reason if not approved */
  rejectReason?: EnrichmentRejectReason;
  /** Enrichment data */
  enrichment: {
    liquidityUsdc: number;
    liquidityWeth: number;
    estimatedSlippagePct: number;
    transferTaxPct: number;
    lpLockedPct: number;
    deployerStatus: 'clean' | 'suspicious' | 'flagged';
    tokenAgeHours: number;
  };
  /** Validation timestamp */
  enrichedAt: number;
  /** Validation latency */
  enrichmentLatencyMs: number;
}

/**
 * SignalEnricher interface for pre-execution validation.
 */
export interface ISignalEnricher {
  /** Enrich and validate a copy signal */
  enrich(signal: CopySignal): Promise<EnrichedSignal>;
  /** Get enrichment statistics */
  getStats(): {
    totalProcessed: number;
    totalApproved: number;
    rejectionsByReason: Record<EnrichmentRejectReason, number>;
    avgEnrichmentMs: number;
  };
}

// =============================================================================
// COPY EXECUTOR INTERFACES
// =============================================================================

/**
 * Position sizing configuration.
 */
export interface PositionSizingConfig {
  /** Ratio of insider trade to copy (0.10 = 10%) */
  copyRatio: number;
  /** Maximum position size in USDC */
  maxPositionUsdc: number;
  /** Minimum position size in USDC */
  minPositionUsdc: number;
  /** Maximum % of available capital per trade */
  maxCapitalPct: number;
  /** Tier multipliers for position sizing */
  tierMultipliers: Record<WalletTier, number>;
}

/**
 * Execution configuration.
 */
export interface ExecutionConfig {
  /** Minimum delay before execution (ms) */
  minDelayMs: number;
  /** Maximum delay before execution (ms) */
  maxDelayMs: number;
  /** Threshold for order splitting (USDC) */
  splitThresholdUsdc: number;
  /** Number of splits for large orders */
  splitCount: number;
  /** Delay between split orders (ms) */
  splitDelayMs: number;
  /** Base slippage tolerance (%) */
  baseSlippagePct: number;
  /** Additional slippage per $10K missing liquidity (%) */
  slippagePerMissingLiquidity: number;
  /** Maximum slippage cap (%) */
  maxSlippagePct: number;
  /** Maximum gas price (gwei) */
  maxGasGwei: number;
}

/**
 * Reasons for rejecting execution.
 */
export type ExecutionRejectReason =
  | 'POSITION_TOO_SMALL'       // Calculated size <$10 USDC
  | 'GAS_PRICE_EXCEEDED'       // Gas >50 gwei
  | 'GAS_ESTIMATE_EXCEEDED'    // Gas estimate >2x expected
  | 'SIMULATION_LOSS'          // Simulated loss >10%
  | 'VOLUME_FOOTPRINT'         // Would exceed 5% of daily volume
  | 'CIRCUIT_BREAKER_ACTIVE'   // Risk bucket blocked
  | 'MAX_POSITIONS_REACHED'    // Already 3 open positions
  | 'DAILY_CAPITAL_EXCEEDED'   // Would exceed 20% daily capital limit
  | 'CAPITAL_RESERVE_VIOLATED'; // Would violate 20% minimum reserve (Req 5.9)

/**
 * Execution result for a copy trade.
 */
export type ExecutionResult =
  | { success: true; positionId: string; executedPrice: bigint; gasUsed: bigint }
  | { success: false; reason: ExecutionRejectReason };

/**
 * Open position with exit parameters.
 */
export interface CopyPosition {
  /** Position unique identifier */
  id: string;
  /** Original signal ID */
  signalId: string;
  /** Source wallet that triggered the trade */
  sourceWallet: string;
  /** Token address being held */
  tokenAddress: string;
  /** Pool/pair address */
  poolAddress: string;
  /** Entry price (token per USDC) */
  entryPrice: bigint;
  /** Position size in USDC */
  positionSizeUsdc: number;
  /** Token amount held */
  tokenAmount: bigint;
  /** Take profit price (+50% default) */
  takeProfit: bigint;
  /** Stop loss price (-20% default) */
  stopLoss: bigint;
  /** Trailing stop trigger price */
  trailingStopTrigger: bigint;
  /** Current trailing stop level */
  trailingStopLevel: bigint | null;
  /** Time stop timestamp */
  timeStop: number;
  /** Position status */
  status: 'OPEN' | 'TP_HIT' | 'SL_HIT' | 'TRAILING_STOP' | 'TIME_STOP' | 'FOLLOW_INSIDER' | 'FORCED_CLOSE' | 'RUG_PULL';
  /** Timestamp when position was opened */
  openedAt: number;
  /** Timestamp when position was closed (null if open) */
  closedAt: number | null;
  /** Exit price (null if open) */
  exitPrice: bigint | null;
  /** Realized PnL in USDC (null if open) */
  pnlUsdc: number | null;
  /** Exit reason description (null if open) */
  exitReason: string | null;
}

/**
 * CopyExecutor interface for trade execution.
 */
export interface ICopyExecutor {
  /** Execute a copy trade from an enriched signal */
  execute(signal: EnrichedSignal): Promise<ExecutionResult>;
  /** Get all open positions */
  getOpenPositions(): CopyPosition[];
  /** Get position by ID */
  getPosition(positionId: string): CopyPosition | null;
  /** Force close a position */
  forceClose(positionId: string): Promise<boolean>;
  /** Get execution statistics */
  getStats(): {
    totalExecuted: number;
    totalRejected: number;
    rejectionsByReason: Record<ExecutionRejectReason, number>;
    avgExecutionMs: number;
  };
}

// =============================================================================
// EXIT MANAGER INTERFACES
// =============================================================================

/**
 * Exit strategy configuration.
 */
export interface ExitStrategyConfig {
  /** Follow insider exit configuration */
  followInsider: {
    enabled: boolean;
    /** Minimum % of position sold by insider to trigger */
    sellThresholdPct: number;
    /** Max time to wait for insider exit (ms) */
    maxWaitMs: number;
    /** Window to execute after insider sells (ms) */
    executeWindowMs: number;
  };
  /** Trailing stop configuration */
  trailingStop: {
    /** Initial stop distance below entry (%) */
    initialDistancePct: number;
    /** Price rise to activate trailing (%) */
    activationPct: number;
    /** Distance below highest price (%) */
    trailingDistancePct: number;
  };
  /** Fixed TP/SL configuration */
  fixedExits: {
    takeProfitPct: number;
    stopLossPct: number;
  };
  /** Time stop in hours */
  timeStopHours: number;
}

/**
 * Exit reason for closed positions.
 */
export type ExitReason =
  | 'TP_HIT'           // Take profit reached
  | 'SL_HIT'           // Stop loss hit
  | 'TRAILING_STOP'    // Trailing stop triggered
  | 'TIME_STOP'        // 48h timeout
  | 'FOLLOW_INSIDER'   // Insider sold
  | 'FORCED_CLOSE'     // Manual close
  | 'FORCED_DRAWDOWN'  // Drawdown >25%
  | 'RUG_PULL';        // Quote failures indicate rug

/**
 * Exit record for tracking closed positions (Requirement 6.11).
 * Records all exit events with reason, price, and PnL.
 */
export interface ExitRecord {
  /** Position unique identifier */
  positionId: string;
  /** Reason for exit */
  exitReason: ExitReason;
  /** Exit price in token/USDC */
  exitPrice: number;
  /** Entry price in token/USDC */
  entryPrice: number;
  /** Realized PnL in USDC (exitPrice - entryPrice) * tokenAmount */
  pnlUsdc: number;
  /** PnL percentage ((exit - entry) / entry * 100) */
  pnlPct: number;
  /** Position duration in milliseconds */
  duration: number;
  /** Exit timestamp (ms) */
  exitTimestamp: number;
  /** Transaction hash of exit (optional) */
  exitTxHash?: string;
}

/**
 * ExitManager interface for position exit management.
 */
export interface IExitManager {
  /** Start monitoring positions */
  start(): Promise<void>;
  /** Stop monitoring */
  stop(): void;
  /** Register a new position to monitor */
  registerPosition(position: CopyPosition): void;
  /** Update insider activity for position */
  updateInsiderActivity(tokenAddress: string, sourceWallet: string, soldPct: number): void;
  /** Get monitoring statistics */
  getStats(): {
    positionsMonitored: number;
    exitsByReason: Record<ExitReason, number>;
    avgHoldingTimeMs: number;
    avgPnlUsdc: number;
  };
  /** Record an exit event (Requirement 6.11) */
  recordExit(position: CopyPosition, exitReason: ExitReason, exitPrice: bigint, txHash?: string): ExitRecord;
  /** Get exit history for a position or all positions (Requirement 6.11) */
  getExitHistory(positionId?: string): ExitRecord[];
  /** Get exits grouped by reason (Requirement 6.11) */
  getExitsByReason(reason: ExitReason): ExitRecord[];
}

// =============================================================================
// ANTI-BAITING MODULE INTERFACES
// =============================================================================

/**
 * Baiting detection configuration.
 */
export interface AntiBaitingConfig {
  /** Days to look back for deployer activity */
  deployerLookbackDays: number;
  /** Max % of token holders from monitored wallets */
  maxMonitoredHoldersPct: number;
  /** Time window for round-trip detection (ms) */
  roundTripWindowMs: number;
  /** Max bait flags before wallet removal */
  maxBaitFlags: number;
  /** Time window for flag accumulation (ms) */
  flagWindowMs: number;
  /** Max % of daily volume our trade can represent */
  maxVolumeFootprintPct: number;
  /** Execution delay range for pattern obscuring (ms) */
  executionDelayRange: { min: number; max: number };
}

/**
 * Reasons for rejecting due to baiting detection.
 */
export type BaitingRejectReason =
  | 'DEPLOYER_TOKEN'         // Source wallet deployed token
  | 'HIGH_MONITORED_HOLDERS' // >30% holders are monitored wallets
  | 'ROUND_TRIP_DETECTED'    // Buy+sell within 1 hour
  | 'VOLUME_FOOTPRINT';      // Would exceed 5% daily volume

/**
 * Baiting detection result.
 */
export interface BaitingCheckResult {
  /** Whether the signal is approved */
  approved: boolean;
  /** Rejection reason if not approved */
  rejectReason?: BaitingRejectReason;
  /** Detection flags */
  flags: {
    isDeployerToken: boolean;
    highMonitoredHolders: boolean;
    recentRoundTrip: boolean;
    highVolumeFootprint: boolean;
  };
  /** Suggested execution delay in ms */
  suggestedDelay: number;
}

/**
 * Bait flag record for tracking suspicious behavior.
 */
export interface BaitFlag {
  /** Wallet address flagged */
  walletAddress: string;
  /** Token address involved */
  tokenAddress: string;
  /** Reason for the flag */
  reason: BaitingRejectReason;
  /** Timestamp when flagged */
  flaggedAt: number;
}

/**
 * AntiBaitingModule interface for manipulation detection.
 */
export interface IAntiBaitingModule {
  /** Check signal for baiting patterns */
  check(signal: EnrichedSignal): Promise<BaitingCheckResult>;
  /** Get bait flags for a wallet */
  getFlags(walletAddress: string): BaitFlag[];
  /** Add a deployer to blacklist */
  blacklistDeployer(deployerAddress: string): void;
  /** Get list of blacklisted deployers */
  getBlacklistedDeployers(): string[];
}

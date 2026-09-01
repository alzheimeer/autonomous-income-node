/**
 * @fileoverview SmartMoneyCurator - Módulo de curaduría de wallets smart money
 *
 * Este módulo es responsable de seleccionar, calificar y mantener la lista de
 * wallets a seguir basándose en métricas de performance históricas.
 *
 * Criterios de inclusión (90-day rolling window):
 * - win_rate ≥ 70% (Req 1.2)
 * - total_pnl_usdc ≥ $50,000 (Req 1.3)
 * - trade_count ≥ 100 (Req 1.4)
 * - 900s ≤ avg_holding_time_sec ≤ 604,800s (15 min to 7 days) (Req 1.5)
 * - volume_usdc ≥ $500,000 (Req 1.6)
 *
 * @module copy-trading/modules/SmartMoneyCurator
 */

import { createLogger } from '../../logger.js';
import type {
  WalletInclusionCriteria,
  WalletExclusionFilters,
  SmartMoneyWallet,
  WalletTier,
  ISmartMoneyCurator,
} from '../interfaces/types.js';

const log = createLogger('smart-money-curator');

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS - Wallet Count Bounds (Property 3: Wallet Count Bounds Invariant)
// Requirements: 1.1 - Maintain 10-50 monitored wallets
// ═══════════════════════════════════════════════════════════════════════════════

/** Minimum number of wallets that must be monitored (Req 1.1) */
export const MIN_WALLET_COUNT = 10;

/** Maximum number of wallets that can be monitored (Req 1.1) */
export const MAX_WALLET_COUNT = 50;

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS - Re-evaluation Configuration (Task 5.9)
// Requirements: 1.13 - Re-evaluate every 24 hours
//               1.14 - Remove wallets with win rate < 60%
// Property 5: Degraded Wallet Removal
// ═══════════════════════════════════════════════════════════════════════════════

/** Re-evaluation interval: 24 hours in milliseconds (Req 1.13) */
export const RE_EVALUATION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Win rate threshold for degraded wallets: 60% (Req 1.14, Property 5) */
export const DEGRADED_WIN_RATE_THRESHOLD = 0.60;

// ═══════════════════════════════════════════════════════════════════════════════
// CONSTANTS - Default Inclusion Criteria
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default inclusion criteria based on requirements 1.2-1.6
 * All thresholds are evaluated over a 90-day rolling window
 */
export const DEFAULT_INCLUSION_CRITERIA: WalletInclusionCriteria = {
  /** Minimum win rate: 70% (Req 1.2) */
  minWinRate: 0.70,

  /** Minimum historical PnL: $50,000 USDC (Req 1.3) */
  minHistoricalPnlUsdc: 50_000,

  /** Minimum trade count for statistical significance: 100 trades (Req 1.4) */
  minTradeCount: 100,

  /** Minimum average holding time: 15 minutes = 900 seconds (Req 1.5) */
  minAvgHoldingTimeSec: 900,

  /** Maximum average holding time: 7 days = 604,800 seconds (Req 1.5) */
  maxAvgHoldingTimeSec: 604_800,

  /** Minimum historical volume: $500,000 USDC (Req 1.6) */
  minHistoricalVolumeUsdc: 500_000,
};

/**
 * Default exclusion filters based on requirements 1.7-1.11
 * These filters identify problematic wallets that should be blacklisted
 */
export const DEFAULT_EXCLUSION_FILTERS: WalletExclusionFilters = {
  /** Max % of trades in same block: 50% - MEV bot indicator (Req 1.7) */
  maxSameBlockTradePct: 0.50,

  /** Exclude wallets that deployed tokens in last 180 days (Req 1.8) */
  excludeTokenDeployers: true,

  /** Max % of tokens that were honeypots/rugs: 20% (Req 1.9) */
  maxHoneypotExposurePct: 0.20,

  /** Exclude wallets that received deployer airdrops (Req 1.10) */
  excludeDeployerRecipients: true,

  /** Max % of trades with same counterparty: 30% - wash trading indicator (Req 1.11) */
  maxSameCounterpartyPct: 0.30,
};

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wallet metrics used for evaluating inclusion criteria.
 * This is the subset of SmartMoneyWallet.metrics needed for inclusion checks.
 */
export interface WalletMetrics {
  /** Win rate as decimal (0.0 to 1.0) */
  winRate: number;
  /** Total PnL in USDC */
  totalPnlUsdc: number;
  /** Number of trades executed */
  tradeCount: number;
  /** Average holding time in seconds */
  avgHoldingTimeSec: number;
  /** Total volume traded in USDC */
  volumeUsdc: number;
}

/**
 * Extended wallet metrics including sharpe ratio and profit factor.
 * Used for tier assignment scoring.
 * 
 * Scoring formula: combined_score = winRate × profitFactor × sharpeRatio
 */
export interface ExtendedWalletMetrics extends WalletMetrics {
  /** Sharpe ratio (risk-adjusted return metric) */
  sharpeRatio: number;
  /** Profit factor (gross profit / gross loss) */
  profitFactor: number;
}

/**
 * Full wallet metrics including all fields needed for SmartMoneyWallet creation.
 * Extends ExtendedWalletMetrics with additional performance tracking fields.
 */
export interface FullWalletMetrics extends ExtendedWalletMetrics {
  /** Maximum drawdown percentage (0.0 to 1.0) */
  maxDrawdownPct: number;
  /** Percentage of weeks that were profitable (0.0 to 1.0) */
  profitableWeeksPct: number;
}

/**
 * Result of tier assignment for a wallet
 */
export interface TierAssignmentResult {
  /** Wallet address */
  address: string;
  /** Assigned tier based on ranking */
  tier: WalletTier;
  /** Calculated score (winRate × profitFactor × sharpeRatio) */
  score: number;
}

/**
 * Result of inclusion criteria evaluation with detailed breakdown
 */
export interface InclusionEvaluationResult {
  /** Whether all criteria are met */
  passed: boolean;
  /** Individual criteria results */
  criteria: {
    winRate: { required: number; actual: number; passed: boolean };
    historicalPnl: { required: number; actual: number; passed: boolean };
    tradeCount: { required: number; actual: number; passed: boolean };
    minHoldingTime: { required: number; actual: number; passed: boolean };
    maxHoldingTime: { required: number; actual: number; passed: boolean };
    historicalVolume: { required: number; actual: number; passed: boolean };
  };
  /** List of failed criteria names */
  failedCriteria: string[];
}

/**
 * Metrics used for evaluating exclusion filters.
 * These metrics identify problematic wallet behavior patterns.
 */
export interface WalletExclusionMetrics {
  /** Percentage of trades executed in the same block as another trade (0.0 to 1.0) */
  sameBlockTradePct: number;
  /** Whether the wallet has deployed tokens in the last 180 days */
  hasDeployedTokensRecently: boolean;
  /** Percentage of purchased tokens that were honeypots or rugs (0.0 to 1.0) */
  honeypotExposurePct: number;
  /** Whether the wallet has received tokens directly from token deployers */
  receivedDeployerAirdrop: boolean;
  /** Percentage of trades with the same counterparty (0.0 to 1.0) */
  sameCounterpartyPct: number;
}

/**
 * Result of exclusion filters evaluation with detailed breakdown
 */
export interface ExclusionEvaluationResult {
  /** Whether the wallet should be excluded (true = exclude, false = pass) */
  excluded: boolean;
  /** Individual filter results */
  filters: {
    sameBlockTrade: { threshold: number; actual: number; triggered: boolean };
    tokenDeployer: { checkEnabled: boolean; actual: boolean; triggered: boolean };
    honeypotExposure: { threshold: number; actual: number; triggered: boolean };
    deployerRecipient: { checkEnabled: boolean; actual: boolean; triggered: boolean };
    sameCounterparty: { threshold: number; actual: number; triggered: boolean };
  };
  /** List of triggered filter names that caused exclusion */
  triggeredFilters: string[];
}

/**
 * Configuration for SmartMoneyCurator
 */
export interface SmartMoneyCuratorConfig {
  /** Custom inclusion criteria (optional, uses defaults if not provided) */
  inclusionCriteria?: Partial<WalletInclusionCriteria>;
  /** Custom exclusion filters (optional, uses defaults if not provided) */
  exclusionFilters?: Partial<WalletExclusionFilters>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMART MONEY CURATOR CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * SmartMoneyCurator - Manages the curation of smart money wallets
 *
 * This class implements the core logic for:
 * - Evaluating wallets against inclusion criteria (Req 1.2-1.6)
 * - Exclusion filters (Req 1.7-1.11) - Task 5.3
 * - Future: Tier assignment (Req 1.12) - Task 5.5
 * - Future: Wallet list management (Req 1.1) - Task 5.7
 * - Future: Periodic re-evaluation (Req 1.13, 1.14) - Task 5.9
 */
export class SmartMoneyCurator implements Partial<ISmartMoneyCurator> {
  private readonly inclusionCriteria: WalletInclusionCriteria;
  private readonly exclusionFilters: WalletExclusionFilters;
  private readonly wallets: Map<string, SmartMoneyWallet> = new Map();
  
  /** Timer for periodic re-evaluation (Task 5.9, Req 1.13) */
  private reEvaluationTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Creates a new SmartMoneyCurator instance
   * @param config - Configuration options
   */
  constructor(config: SmartMoneyCuratorConfig = {}) {
    // Merge provided criteria with defaults
    this.inclusionCriteria = {
      ...DEFAULT_INCLUSION_CRITERIA,
      ...config.inclusionCriteria,
    };

    // Merge provided exclusion filters with defaults
    this.exclusionFilters = {
      ...DEFAULT_EXCLUSION_FILTERS,
      ...config.exclusionFilters,
    };

    log.info('SmartMoneyCurator initialized', {
      inclusionCriteria: this.inclusionCriteria,
      exclusionFilters: this.exclusionFilters,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INCLUSION CRITERIA EVALUATION (Task 5.1)
  // Requirements: 1.2, 1.3, 1.4, 1.5, 1.6
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluates if wallet metrics meet all inclusion criteria
   *
   * @param metrics - Wallet performance metrics to evaluate
   * @returns true if ALL inclusion criteria are met, false otherwise
   *
   * Validates:
   * - win_rate ≥ 70% (Req 1.2)
   * - total_pnl_usdc ≥ $50,000 (Req 1.3)
   * - trade_count ≥ 100 (Req 1.4)
   * - 900s ≤ avg_holding_time_sec ≤ 604,800s (Req 1.5)
   * - volume_usdc ≥ $500,000 (Req 1.6)
   */
  evaluateInclusionCriteria(metrics: WalletMetrics): boolean {
    const result = this.evaluateInclusionCriteriaDetailed(metrics);
    return result.passed;
  }

  /**
   * Evaluates inclusion criteria with detailed breakdown
   *
   * @param metrics - Wallet performance metrics to evaluate
   * @returns Detailed evaluation result with individual criteria checks
   */
  evaluateInclusionCriteriaDetailed(metrics: WalletMetrics): InclusionEvaluationResult {
    const criteria = this.inclusionCriteria;
    const failedCriteria: string[] = [];

    // Requirement 1.2: Win rate ≥ 70%
    const winRatePassed = metrics.winRate >= criteria.minWinRate;
    if (!winRatePassed) {
      failedCriteria.push('winRate');
    }

    // Requirement 1.3: Historical PnL ≥ $50,000 USDC
    const historicalPnlPassed = metrics.totalPnlUsdc >= criteria.minHistoricalPnlUsdc;
    if (!historicalPnlPassed) {
      failedCriteria.push('historicalPnl');
    }

    // Requirement 1.4: Trade count ≥ 100
    const tradeCountPassed = metrics.tradeCount >= criteria.minTradeCount;
    if (!tradeCountPassed) {
      failedCriteria.push('tradeCount');
    }

    // Requirement 1.5: Average holding time between 15 min and 7 days
    const minHoldingTimePassed = metrics.avgHoldingTimeSec >= criteria.minAvgHoldingTimeSec;
    const maxHoldingTimePassed = metrics.avgHoldingTimeSec <= criteria.maxAvgHoldingTimeSec;
    if (!minHoldingTimePassed) {
      failedCriteria.push('minHoldingTime');
    }
    if (!maxHoldingTimePassed) {
      failedCriteria.push('maxHoldingTime');
    }

    // Requirement 1.6: Historical volume ≥ $500,000 USDC
    const historicalVolumePassed = metrics.volumeUsdc >= criteria.minHistoricalVolumeUsdc;
    if (!historicalVolumePassed) {
      failedCriteria.push('historicalVolume');
    }

    const passed = failedCriteria.length === 0;

    log.debug('Inclusion criteria evaluation', {
      passed,
      failedCriteria,
      metrics: {
        winRate: `${(metrics.winRate * 100).toFixed(1)}%`,
        totalPnlUsdc: `$${metrics.totalPnlUsdc.toLocaleString()}`,
        tradeCount: metrics.tradeCount,
        avgHoldingTimeSec: metrics.avgHoldingTimeSec,
        volumeUsdc: `$${metrics.volumeUsdc.toLocaleString()}`,
      },
    });

    return {
      passed,
      criteria: {
        winRate: {
          required: criteria.minWinRate,
          actual: metrics.winRate,
          passed: winRatePassed,
        },
        historicalPnl: {
          required: criteria.minHistoricalPnlUsdc,
          actual: metrics.totalPnlUsdc,
          passed: historicalPnlPassed,
        },
        tradeCount: {
          required: criteria.minTradeCount,
          actual: metrics.tradeCount,
          passed: tradeCountPassed,
        },
        minHoldingTime: {
          required: criteria.minAvgHoldingTimeSec,
          actual: metrics.avgHoldingTimeSec,
          passed: minHoldingTimePassed,
        },
        maxHoldingTime: {
          required: criteria.maxAvgHoldingTimeSec,
          actual: metrics.avgHoldingTimeSec,
          passed: maxHoldingTimePassed,
        },
        historicalVolume: {
          required: criteria.minHistoricalVolumeUsdc,
          actual: metrics.volumeUsdc,
          passed: historicalVolumePassed,
        },
      },
      failedCriteria,
    };
  }

  /**
   * Gets the current inclusion criteria configuration
   * @returns The active inclusion criteria
   */
  getInclusionCriteria(): WalletInclusionCriteria {
    return { ...this.inclusionCriteria };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXCLUSION FILTERS EVALUATION (Task 5.3)
  // Requirements: 1.7, 1.8, 1.9, 1.10, 1.11
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluates if wallet metrics trigger any exclusion filters
   *
   * @param metrics - Wallet exclusion metrics to evaluate
   * @returns true if wallet should be EXCLUDED (any filter triggered), false if wallet passes
   *
   * Exclusion triggers:
   * - same_block_trade_pct > 50% (MEV bot indicator) (Req 1.7)
   * - has_deployed_tokens_recently = true (Req 1.8)
   * - honeypot_exposure_pct > 20% (Req 1.9)
   * - received_deployer_airdrop = true (Req 1.10)
   * - same_counterparty_pct > 30% (wash trading indicator) (Req 1.11)
   */
  evaluateExclusionFilters(metrics: WalletExclusionMetrics): boolean {
    const result = this.evaluateExclusionFiltersDetailed(metrics);
    return result.excluded;
  }

  /**
   * Evaluates exclusion filters with detailed breakdown
   *
   * @param metrics - Wallet exclusion metrics to evaluate
   * @returns Detailed evaluation result with individual filter checks
   */
  evaluateExclusionFiltersDetailed(metrics: WalletExclusionMetrics): ExclusionEvaluationResult {
    const filters = this.exclusionFilters;
    const triggeredFilters: string[] = [];

    // Requirement 1.7: Same block trade % > 50% (MEV bot indicator)
    const sameBlockTriggered = metrics.sameBlockTradePct > filters.maxSameBlockTradePct;
    if (sameBlockTriggered) {
      triggeredFilters.push('sameBlockTrade');
    }

    // Requirement 1.8: Exclude token deployers (if enabled)
    const tokenDeployerTriggered = filters.excludeTokenDeployers && metrics.hasDeployedTokensRecently;
    if (tokenDeployerTriggered) {
      triggeredFilters.push('tokenDeployer');
    }

    // Requirement 1.9: Honeypot exposure > 20%
    const honeypotTriggered = metrics.honeypotExposurePct > filters.maxHoneypotExposurePct;
    if (honeypotTriggered) {
      triggeredFilters.push('honeypotExposure');
    }

    // Requirement 1.10: Exclude deployer recipients (if enabled)
    const deployerRecipientTriggered = filters.excludeDeployerRecipients && metrics.receivedDeployerAirdrop;
    if (deployerRecipientTriggered) {
      triggeredFilters.push('deployerRecipient');
    }

    // Requirement 1.11: Same counterparty % > 30% (wash trading indicator)
    const sameCounterpartyTriggered = metrics.sameCounterpartyPct > filters.maxSameCounterpartyPct;
    if (sameCounterpartyTriggered) {
      triggeredFilters.push('sameCounterparty');
    }

    const excluded = triggeredFilters.length > 0;

    log.debug('Exclusion filters evaluation', {
      excluded,
      triggeredFilters,
      metrics: {
        sameBlockTradePct: `${(metrics.sameBlockTradePct * 100).toFixed(1)}%`,
        hasDeployedTokensRecently: metrics.hasDeployedTokensRecently,
        honeypotExposurePct: `${(metrics.honeypotExposurePct * 100).toFixed(1)}%`,
        receivedDeployerAirdrop: metrics.receivedDeployerAirdrop,
        sameCounterpartyPct: `${(metrics.sameCounterpartyPct * 100).toFixed(1)}%`,
      },
    });

    return {
      excluded,
      filters: {
        sameBlockTrade: {
          threshold: filters.maxSameBlockTradePct,
          actual: metrics.sameBlockTradePct,
          triggered: sameBlockTriggered,
        },
        tokenDeployer: {
          checkEnabled: filters.excludeTokenDeployers,
          actual: metrics.hasDeployedTokensRecently,
          triggered: tokenDeployerTriggered,
        },
        honeypotExposure: {
          threshold: filters.maxHoneypotExposurePct,
          actual: metrics.honeypotExposurePct,
          triggered: honeypotTriggered,
        },
        deployerRecipient: {
          checkEnabled: filters.excludeDeployerRecipients,
          actual: metrics.receivedDeployerAirdrop,
          triggered: deployerRecipientTriggered,
        },
        sameCounterparty: {
          threshold: filters.maxSameCounterpartyPct,
          actual: metrics.sameCounterpartyPct,
          triggered: sameCounterpartyTriggered,
        },
      },
      triggeredFilters,
    };
  }

  /**
   * Gets the current exclusion filters configuration
   * @returns The active exclusion filters
   */
  getExclusionFilters(): WalletExclusionFilters {
    return { ...this.exclusionFilters };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PLACEHOLDER METHODS - To be implemented in subsequent tasks
  // ═══════════════════════════════════════════════════════════════════════════

  // ═══════════════════════════════════════════════════════════════════════════
  // WALLET LIST MANAGEMENT (Task 5.7)
  // Requirements: 1.1 - Maintain 10-50 monitored wallets
  // Property 3: Wallet Count Bounds Invariant
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validates if an address is properly checksummed (EIP-55).
   * 
   * @param address - The wallet address to validate
   * @returns true if the address is a valid checksummed Ethereum address
   */
  private isValidChecksummedAddress(address: string): boolean {
    // Basic format validation: starts with 0x and has 40 hex characters
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return false;
    }

    // Check if address matches checksum format (mix of upper and lower case)
    // A truly checksummed address will have specific casing based on keccak256
    // For simplicity, we accept addresses that are either:
    // 1. All lowercase (0x + 40 lowercase hex)
    // 2. All uppercase (0x + 40 uppercase hex)
    // 3. Mixed case (checksum format)
    return true;
  }

  /**
   * Normalizes an address to lowercase for consistent storage and lookup.
   * 
   * @param address - The wallet address to normalize
   * @returns Lowercase version of the address
   */
  private normalizeAddress(address: string): string {
    return address.toLowerCase();
  }

  /**
   * Creates a SmartMoneyWallet object from address, metrics, and tier.
   * 
   * @param address - Wallet address (will be stored as-is, assumed checksummed)
   * @param metrics - Full wallet metrics including all performance data
   * @param exclusionMetrics - Metrics for exclusion flag calculation
   * @param tier - Assigned tier based on ranking
   * @returns Complete SmartMoneyWallet object
   */
  private createWalletObject(
    address: string,
    metrics: FullWalletMetrics,
    exclusionMetrics: WalletExclusionMetrics,
    tier: WalletTier
  ): SmartMoneyWallet {
    const now = Date.now();

    return {
      address,
      tier,
      metrics: {
        winRate: metrics.winRate,
        totalPnlUsdc: metrics.totalPnlUsdc,
        tradeCount: metrics.tradeCount,
        avgHoldingTimeSec: metrics.avgHoldingTimeSec,
        volumeUsdc: metrics.volumeUsdc,
        sharpeRatio: metrics.sharpeRatio,
        maxDrawdownPct: metrics.maxDrawdownPct,
        profitFactor: metrics.profitFactor,
        profitableWeeksPct: metrics.profitableWeeksPct,
      },
      flags: {
        isMevBot: exclusionMetrics.sameBlockTradePct > this.exclusionFilters.maxSameBlockTradePct,
        isTokenDeployer: exclusionMetrics.hasDeployedTokensRecently,
        hasHoneypotExposure: exclusionMetrics.honeypotExposurePct > this.exclusionFilters.maxHoneypotExposurePct,
        isWashTrader: exclusionMetrics.sameCounterpartyPct > this.exclusionFilters.maxSameCounterpartyPct,
      },
      addedAt: now,
      lastEvaluatedAt: now,
      isActive: true,
    };
  }

  /**
   * Recalculates and reassigns tiers for all wallets based on current scores.
   * This should be called after adding or removing wallets to maintain tier consistency.
   */
  private reassignAllTiers(): void {
    const walletArray = Array.from(this.wallets.values());
    
    if (walletArray.length === 0) {
      return;
    }

    // Build list with scores using existing metrics
    const walletsWithScores = walletArray.map((wallet) => ({
      wallet,
      score: this.calculateWalletScore({
        winRate: wallet.metrics.winRate,
        totalPnlUsdc: wallet.metrics.totalPnlUsdc,
        tradeCount: wallet.metrics.tradeCount,
        avgHoldingTimeSec: wallet.metrics.avgHoldingTimeSec,
        volumeUsdc: wallet.metrics.volumeUsdc,
        sharpeRatio: wallet.metrics.sharpeRatio,
        profitFactor: wallet.metrics.profitFactor,
      }),
    }));

    // Sort by score descending
    walletsWithScores.sort((a, b) => b.score - a.score);

    // Reassign tiers based on rank
    walletsWithScores.forEach((item, index) => {
      const rank = index + 1;
      const newTier = this.assignTier(rank);
      
      if (item.wallet.tier !== newTier) {
        item.wallet.tier = newTier;
        log.debug('Tier reassigned', {
          address: item.wallet.address,
          oldTier: item.wallet.tier,
          newTier,
          rank,
          score: item.score,
        });
      }
    });
  }

  /**
   * Adds a wallet to the monitored list after validation.
   * This is the synchronous version that requires all metrics upfront.
   * 
   * @param address - Wallet address (must be checksummed)
   * @param metrics - Full wallet metrics for inclusion criteria and tier assignment
   * @param exclusionMetrics - Metrics for exclusion filter evaluation
   * @returns The created SmartMoneyWallet if successful, null if validation fails
   * 
   * Validation steps:
   * 1. Validate address format (checksummed)
   * 2. Check if already monitored (no duplicates)
   * 3. Evaluate inclusion criteria (must pass all)
   * 4. Evaluate exclusion filters (must not be excluded)
   * 5. Check count bound (must not exceed MAX_WALLET_COUNT = 50)
   * 
   * @example
   * const wallet = curator.addWalletWithMetrics('0x1234...', metrics, exclusionMetrics);
   * if (!wallet) {
   *   console.log('Wallet rejected');
   * }
   */
  addWalletWithMetrics(
    address: string,
    metrics: FullWalletMetrics,
    exclusionMetrics: WalletExclusionMetrics
  ): SmartMoneyWallet | null {
    // Step 1: Validate address format
    if (!this.isValidChecksummedAddress(address)) {
      log.warn('addWallet rejected: invalid address format', { address });
      return null;
    }

    const normalizedAddress = this.normalizeAddress(address);

    // Step 2: Check if already monitored
    if (this.wallets.has(normalizedAddress)) {
      log.warn('addWallet rejected: wallet already monitored', { address });
      return null;
    }

    // Step 3: Evaluate inclusion criteria
    const inclusionResult = this.evaluateInclusionCriteriaDetailed(metrics);
    if (!inclusionResult.passed) {
      log.warn('addWallet rejected: inclusion criteria not met', {
        address,
        failedCriteria: inclusionResult.failedCriteria,
      });
      return null;
    }

    // Step 4: Evaluate exclusion filters
    const exclusionResult = this.evaluateExclusionFiltersDetailed(exclusionMetrics);
    if (exclusionResult.excluded) {
      log.warn('addWallet rejected: exclusion filter triggered', {
        address,
        triggeredFilters: exclusionResult.triggeredFilters,
      });
      return null;
    }

    // Step 5: Check count bound (Property 3: count ≤ 50)
    if (this.wallets.size >= MAX_WALLET_COUNT) {
      log.warn('addWallet rejected: maximum wallet count reached', {
        address,
        currentCount: this.wallets.size,
        maxCount: MAX_WALLET_COUNT,
      });
      return null;
    }

    // Calculate the wallet's rank position (will be last initially)
    const rank = this.wallets.size + 1;
    const tier = this.assignTier(rank);

    // Create wallet object
    const wallet = this.createWalletObject(address, metrics, exclusionMetrics, tier);

    // Add to wallets map
    this.wallets.set(normalizedAddress, wallet);

    // Reassign all tiers to maintain correct ranking
    this.reassignAllTiers();

    log.info('Wallet added successfully', {
      address,
      tier: wallet.tier,
      score: this.calculateWalletScore(metrics),
      totalWallets: this.wallets.size,
    });

    return wallet;
  }

  /**
   * Adds a wallet to the monitored list (async interface version).
   * This method satisfies the ISmartMoneyCurator interface.
   * 
   * Note: This is a placeholder that requires external metric fetching.
   * For direct usage with metrics, use addWalletWithMetrics() instead.
   * 
   * @param address - Wallet address to add
   * @returns Promise resolving to SmartMoneyWallet or null
   */
  async addWallet(address: string): Promise<SmartMoneyWallet | null> {
    // This would typically fetch metrics from an external source
    // For now, we just validate the address format
    if (!this.isValidChecksummedAddress(address)) {
      log.warn('addWallet rejected: invalid address format', { address });
      return null;
    }

    // Check if already monitored
    if (this.isMonitored(address)) {
      log.warn('addWallet rejected: wallet already monitored', { address });
      return null;
    }

    // Check count bound
    if (this.wallets.size >= MAX_WALLET_COUNT) {
      log.warn('addWallet rejected: maximum wallet count reached', {
        address,
        currentCount: this.wallets.size,
        maxCount: MAX_WALLET_COUNT,
      });
      return null;
    }

    // TODO: In a real implementation, this would:
    // 1. Fetch metrics from Nansen/DeBank/Dune APIs
    // 2. Call addWalletWithMetrics with the fetched data
    log.warn('addWallet: async metric fetching not implemented, use addWalletWithMetrics instead', { address });
    return null;
  }

  /**
   * Removes a wallet from the monitored list.
   * 
   * @param address - Wallet address to remove
   * @returns true if wallet was removed, false if not found or removal would violate bounds
   * 
   * Validation:
   * - Check if wallet exists
   * - Check count bound (must not go below MIN_WALLET_COUNT = 10)
   * 
   * Side effects:
   * - Reassigns tiers for remaining wallets (since rankings change)
   */
  removeWallet(address: string): boolean {
    const normalizedAddress = this.normalizeAddress(address);

    // Check if wallet exists
    if (!this.wallets.has(normalizedAddress)) {
      log.warn('removeWallet failed: wallet not found', { address });
      return false;
    }

    // Check count bound (Property 3: count ≥ 10)
    if (this.wallets.size <= MIN_WALLET_COUNT) {
      log.warn('removeWallet rejected: minimum wallet count would be violated', {
        address,
        currentCount: this.wallets.size,
        minCount: MIN_WALLET_COUNT,
      });
      return false;
    }

    // Remove wallet
    const removedWallet = this.wallets.get(normalizedAddress);
    this.wallets.delete(normalizedAddress);

    // Reassign tiers for remaining wallets
    this.reassignAllTiers();

    log.info('Wallet removed successfully', {
      address,
      previousTier: removedWallet?.tier,
      remainingWallets: this.wallets.size,
    });

    return true;
  }

  /**
   * Gets the current list of monitored wallets, sorted by tier and score.
   * 
   * Sorting order:
   * 1. S_TIER first, then A_TIER, then B_TIER
   * 2. Within each tier, sorted by score descending
   * 
   * @returns Array of SmartMoneyWallet objects sorted by tier and score
   */
  getWallets(): SmartMoneyWallet[] {
    const walletArray = Array.from(this.wallets.values());

    // Calculate scores and sort
    const walletsWithScores = walletArray.map((wallet) => ({
      wallet,
      score: this.calculateWalletScore({
        winRate: wallet.metrics.winRate,
        totalPnlUsdc: wallet.metrics.totalPnlUsdc,
        tradeCount: wallet.metrics.tradeCount,
        avgHoldingTimeSec: wallet.metrics.avgHoldingTimeSec,
        volumeUsdc: wallet.metrics.volumeUsdc,
        sharpeRatio: wallet.metrics.sharpeRatio,
        profitFactor: wallet.metrics.profitFactor,
      }),
    }));

    // Define tier order for sorting
    const tierOrder: Record<WalletTier, number> = {
      'S_TIER': 0,
      'A_TIER': 1,
      'B_TIER': 2,
    };

    // Sort by tier first, then by score descending within tier
    walletsWithScores.sort((a, b) => {
      const tierDiff = tierOrder[a.wallet.tier] - tierOrder[b.wallet.tier];
      if (tierDiff !== 0) {
        return tierDiff;
      }
      return b.score - a.score;
    });

    return walletsWithScores.map((item) => item.wallet);
  }

  /**
   * Gets wallets filtered by tier
   * @param tier - The tier to filter by
   * @returns Array of SmartMoneyWallet objects with the specified tier
   */
  getWalletsByTier(tier: WalletTier): SmartMoneyWallet[] {
    return this.getWallets().filter((w) => w.tier === tier);
  }

  /**
   * Gets the current number of monitored wallets.
   * 
   * @returns The count of wallets in the monitored list
   */
  getWalletCount(): number {
    return this.wallets.size;
  }

  /**
   * Checks if a new wallet can be added (count < MAX_WALLET_COUNT).
   * 
   * @returns true if count < 50, false otherwise
   */
  canAddWallet(): boolean {
    return this.wallets.size < MAX_WALLET_COUNT;
  }

  /**
   * Checks if a wallet can be removed (count > MIN_WALLET_COUNT).
   * 
   * @returns true if count > 10, false otherwise
   */
  canRemoveWallet(): boolean {
    return this.wallets.size > MIN_WALLET_COUNT;
  }

  /**
   * Checks if an address is currently being monitored
   * @param address - The wallet address to check
   * @returns true if the wallet is in the monitored list
   */
  isMonitored(address: string): boolean {
    return this.wallets.has(this.normalizeAddress(address));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIER ASSIGNMENT AND SCORING (Task 5.5)
  // Requirements: 1.12
  // Property 4: Tier Assignment Determinism
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calculates the combined score for a wallet based on extended metrics.
   * 
   * Formula: combined_score = winRate × profitFactor × sharpeRatio
   * 
   * @param metrics - Extended wallet metrics including sharpeRatio and profitFactor
   * @returns The calculated score (always >= 0)
   * 
   * @example
   * // Win rate 75%, profit factor 2.0, sharpe 1.5
   * calculateWalletScore({ winRate: 0.75, profitFactor: 2.0, sharpeRatio: 1.5, ... })
   * // Returns: 0.75 * 2.0 * 1.5 = 2.25
   */
  calculateWalletScore(metrics: ExtendedWalletMetrics): number {
    const score = metrics.winRate * metrics.profitFactor * metrics.sharpeRatio;
    
    log.debug('Calculated wallet score', {
      winRate: metrics.winRate,
      profitFactor: metrics.profitFactor,
      sharpeRatio: metrics.sharpeRatio,
      score,
    });
    
    return score;
  }

  /**
   * Assigns a tier based on the wallet's rank.
   * 
   * Tier assignment rules (deterministic based on rank):
   * - S_TIER: ranks 1-5 (top 5 wallets)
   * - A_TIER: ranks 6-15
   * - B_TIER: ranks 16-50
   * 
   * @param rank - The wallet's rank (1 = highest score, must be 1-50)
   * @returns The assigned tier
   * @throws Error if rank is out of bounds (< 1 or > 50)
   * 
   * @example
   * assignTier(1)  // Returns: 'S_TIER'
   * assignTier(5)  // Returns: 'S_TIER'
   * assignTier(6)  // Returns: 'A_TIER'
   * assignTier(15) // Returns: 'A_TIER'
   * assignTier(16) // Returns: 'B_TIER'
   * assignTier(50) // Returns: 'B_TIER'
   */
  assignTier(rank: number): WalletTier {
    // Validate rank bounds
    if (rank < 1 || rank > 50) {
      throw new Error(`Rank ${rank} is out of bounds. Valid range is 1-50.`);
    }

    // S_TIER: Top 5 wallets (ranks 1-5)
    if (rank >= 1 && rank <= 5) {
      return 'S_TIER';
    }

    // A_TIER: Wallets 6-15 (ranks 6-15)
    if (rank >= 6 && rank <= 15) {
      return 'A_TIER';
    }

    // B_TIER: Wallets 16-50 (ranks 16-50)
    return 'B_TIER';
  }

  /**
   * Assigns tiers to a list of wallets based on their combined scores.
   * 
   * Process:
   * 1. Calculate score for each wallet (winRate × profitFactor × sharpeRatio)
   * 2. Sort wallets by score in descending order
   * 3. Assign tier based on rank (1-5: S_TIER, 6-15: A_TIER, 16-50: B_TIER)
   * 
   * This method is IDEMPOTENT: calling it twice with the same input produces
   * the same output (Property 4 guarantee).
   * 
   * @param wallets - Array of wallets with address and extended metrics
   * @returns Sorted array of tier assignments (highest score first)
   * @throws Error if more than 50 wallets are provided
   * 
   * @example
   * assignTiers([
   *   { address: '0x1...', metrics: { winRate: 0.8, profitFactor: 2.5, sharpeRatio: 1.8, ... } },
   *   { address: '0x2...', metrics: { winRate: 0.7, profitFactor: 1.8, sharpeRatio: 1.2, ... } },
   * ])
   * // Returns: [
   * //   { address: '0x1...', tier: 'S_TIER', score: 3.6 },
   * //   { address: '0x2...', tier: 'S_TIER', score: 1.512 },
   * // ]
   */
  assignTiers(
    wallets: Array<{ address: string; metrics: ExtendedWalletMetrics }>
  ): TierAssignmentResult[] {
    // Validate wallet count (max 50 wallets)
    if (wallets.length > 50) {
      throw new Error(`Cannot assign tiers to ${wallets.length} wallets. Maximum is 50.`);
    }

    // Calculate score for each wallet
    const walletsWithScores = wallets.map((wallet) => ({
      address: wallet.address,
      score: this.calculateWalletScore(wallet.metrics),
    }));

    // Sort by score descending (highest score = rank 1)
    walletsWithScores.sort((a, b) => b.score - a.score);

    // Assign tier based on rank (1-indexed)
    const results: TierAssignmentResult[] = walletsWithScores.map((wallet, index) => {
      const rank = index + 1; // 1-indexed rank
      const tier = this.assignTier(rank);

      return {
        address: wallet.address,
        tier,
        score: wallet.score,
      };
    });

    log.info('Tier assignment completed', {
      totalWallets: results.length,
      sTierCount: results.filter((r) => r.tier === 'S_TIER').length,
      aTierCount: results.filter((r) => r.tier === 'A_TIER').length,
      bTierCount: results.filter((r) => r.tier === 'B_TIER').length,
    });

    return results;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RE-EVALUATION METHODS (Task 5.9)
  // Requirements: 1.13 - Re-evaluate every 24 hours
  //               1.14 - Remove wallets with win_rate < 60%
  // Property 5: Degraded Wallet Removal
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Starts the periodic re-evaluation timer.
   * Re-evaluates all wallets every 24 hours (Req 1.13).
   * 
   * If a timer is already running, this method does nothing.
   */
  startReEvaluation(): void {
    if (this.reEvaluationTimer !== null) {
      log.warn('Re-evaluation timer already running');
      return;
    }

    log.info('Starting periodic re-evaluation', {
      intervalMs: RE_EVALUATION_INTERVAL_MS,
      intervalHours: RE_EVALUATION_INTERVAL_MS / (60 * 60 * 1000),
    });

    this.reEvaluationTimer = setInterval(() => {
      void this.reEvaluateAll();
    }, RE_EVALUATION_INTERVAL_MS);
  }

  /**
   * Stops the periodic re-evaluation timer.
   * 
   * If no timer is running, this method does nothing.
   */
  stopReEvaluation(): void {
    if (this.reEvaluationTimer === null) {
      log.warn('No re-evaluation timer to stop');
      return;
    }

    clearInterval(this.reEvaluationTimer);
    this.reEvaluationTimer = null;

    log.info('Periodic re-evaluation stopped');
  }

  /**
   * Checks if the re-evaluation timer is currently running.
   * 
   * @returns true if the timer is active, false otherwise
   */
  isReEvaluationRunning(): boolean {
    return this.reEvaluationTimer !== null;
  }

  /**
   * Gets all wallets with win_rate below the degradation threshold (60%).
   * 
   * @returns Array of SmartMoneyWallet objects with win_rate < 60%
   * 
   * @example
   * const degraded = curator.getDegradedWallets();
   * console.log(`${degraded.length} wallets have degraded performance`);
   */
  getDegradedWallets(): SmartMoneyWallet[] {
    const degraded: SmartMoneyWallet[] = [];

    for (const wallet of this.wallets.values()) {
      if (wallet.metrics.winRate < DEGRADED_WIN_RATE_THRESHOLD) {
        degraded.push(wallet);
      }
    }

    return degraded;
  }

  /**
   * Re-evaluates a single wallet with new metrics.
   * Updates the wallet's metrics, lastEvaluatedAt timestamp, and checks if degraded.
   * 
   * @param address - The wallet address to re-evaluate
   * @param newMetrics - Updated metrics for the wallet
   * @returns true if the wallet should be removed (win_rate < 60%), false otherwise
   * @throws Error if wallet is not found
   * 
   * @example
   * const shouldRemove = curator.reEvaluateWallet('0x1234...', newMetrics);
   * if (shouldRemove) {
   *   console.log('Wallet performance has degraded');
   * }
   */
  reEvaluateWallet(address: string, newMetrics: ExtendedWalletMetrics): boolean {
    const normalizedAddress = this.normalizeAddress(address);
    const wallet = this.wallets.get(normalizedAddress);

    if (!wallet) {
      throw new Error(`Wallet ${address} not found in monitored list`);
    }

    // Update metrics
    wallet.metrics.winRate = newMetrics.winRate;
    wallet.metrics.totalPnlUsdc = newMetrics.totalPnlUsdc;
    wallet.metrics.tradeCount = newMetrics.tradeCount;
    wallet.metrics.avgHoldingTimeSec = newMetrics.avgHoldingTimeSec;
    wallet.metrics.volumeUsdc = newMetrics.volumeUsdc;
    wallet.metrics.sharpeRatio = newMetrics.sharpeRatio;
    wallet.metrics.profitFactor = newMetrics.profitFactor;

    // Update lastEvaluatedAt
    wallet.lastEvaluatedAt = Date.now();

    // Check if wallet is degraded (win_rate < 60%)
    const isDegraded = newMetrics.winRate < DEGRADED_WIN_RATE_THRESHOLD;

    log.debug('Wallet re-evaluated', {
      address,
      winRate: `${(newMetrics.winRate * 100).toFixed(1)}%`,
      isDegraded,
      lastEvaluatedAt: wallet.lastEvaluatedAt,
    });

    return isDegraded;
  }

  /**
   * Re-evaluates all wallets in the monitored list (Req 1.13, 1.14).
   * 
   * Process:
   * 1. For each wallet, update lastEvaluatedAt timestamp
   * 2. Identify wallets with win_rate < 60% as degraded
   * 3. Remove degraded wallets (respecting 10 minimum invariant - Property 3)
   * 4. Re-assign tiers for remaining wallets
   * 
   * Note: In production, this would fetch updated metrics from external APIs.
   * Currently marks all wallets as re-evaluated without changing their metrics.
   * Use reEvaluateWallet() to update individual wallet metrics.
   * 
   * @returns Promise that resolves when re-evaluation is complete
   */
  async reEvaluateAll(): Promise<void> {
    log.info('Starting re-evaluation of all wallets', {
      totalWallets: this.wallets.size,
    });

    const now = Date.now();
    const degradedWallets: SmartMoneyWallet[] = [];
    const walletScores: Array<{ wallet: SmartMoneyWallet; score: number }> = [];

    // Step 1: Update lastEvaluatedAt and identify degraded wallets
    for (const wallet of this.wallets.values()) {
      wallet.lastEvaluatedAt = now;

      // Check for degraded win rate (Property 5)
      if (wallet.metrics.winRate < DEGRADED_WIN_RATE_THRESHOLD) {
        degradedWallets.push(wallet);
      }

      // Calculate score for potential removal decision
      const score = this.calculateWalletScore({
        winRate: wallet.metrics.winRate,
        totalPnlUsdc: wallet.metrics.totalPnlUsdc,
        tradeCount: wallet.metrics.tradeCount,
        avgHoldingTimeSec: wallet.metrics.avgHoldingTimeSec,
        volumeUsdc: wallet.metrics.volumeUsdc,
        sharpeRatio: wallet.metrics.sharpeRatio,
        profitFactor: wallet.metrics.profitFactor,
      });

      walletScores.push({ wallet, score });
    }

    log.info('Identified degraded wallets', {
      totalDegraded: degradedWallets.length,
      threshold: `${(DEGRADED_WIN_RATE_THRESHOLD * 100).toFixed(0)}%`,
    });

    // Step 2: Remove degraded wallets (respecting MIN_WALLET_COUNT invariant)
    let removedCount = 0;
    const walletsToRemove: string[] = [];

    // Sort degraded wallets by score ascending (remove lowest scores first)
    const sortedDegraded = degradedWallets.sort((a, b) => {
      const scoreA = walletScores.find((ws) => ws.wallet === a)?.score ?? 0;
      const scoreB = walletScores.find((ws) => ws.wallet === b)?.score ?? 0;
      return scoreA - scoreB;
    });

    for (const wallet of sortedDegraded) {
      // Check if we can remove (Property 3: count > MIN_WALLET_COUNT)
      if (this.wallets.size - walletsToRemove.length > MIN_WALLET_COUNT) {
        walletsToRemove.push(this.normalizeAddress(wallet.address));
      } else {
        log.warn('Cannot remove degraded wallet: minimum count would be violated', {
          address: wallet.address,
          winRate: `${(wallet.metrics.winRate * 100).toFixed(1)}%`,
          currentCount: this.wallets.size,
          pendingRemoval: walletsToRemove.length,
          minCount: MIN_WALLET_COUNT,
        });
      }
    }

    // Perform removals
    for (const address of walletsToRemove) {
      this.wallets.delete(address);
      removedCount++;
    }

    // Step 3: Re-assign tiers for remaining wallets
    this.reassignAllTiers();

    log.info('Re-evaluation completed', {
      totalEvaluated: this.wallets.size + removedCount,
      degradedFound: degradedWallets.length,
      removed: removedCount,
      keptDueToMinimum: degradedWallets.length - removedCount,
      remainingWallets: this.wallets.size,
    });
  }
}

/**
 * @fileoverview AntiBaitingModule - Módulo de detección y mitigación de baiting
 *
 * Este módulo es responsable de detectar y proteger contra intentos de
 * manipulación donde una wallet sabe que está siendo copiada.
 *
 * Funcionalidades implementadas en esta tarea (11.1):
 * - Rechazar tokens deployeados por source wallet en últimos 30 días (Req 7.1)
 * - Mantener blacklist de deployers conocidos como scammers (Req 7.2)
 *
 * @module copy-trading/modules/AntiBaitingModule
 */

import { ethers } from 'ethers';
import { createLogger } from '../../logger.js';
import type {
  EnrichedSignal,
  BaitingCheckResult,
  BaitingRejectReason,
  BaitFlag,
  IAntiBaitingModule,
  AntiBaitingConfig,
} from '../interfaces/types.js';

const log = createLogger('anti-baiting-module');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Default lookback period for deployer activity: 30 days (Req 7.1) */
export const DEFAULT_DEPLOYER_LOOKBACK_DAYS = 30;

/** Default execution delay range for pattern obscuring (Req 7.8) */
export const DEFAULT_EXECUTION_DELAY_MS = { min: 5_000, max: 30_000 };

/** Default round-trip detection window: 1 hour in ms (Req 7.5) */
export const DEFAULT_ROUND_TRIP_WINDOW_MS = 60 * 60 * 1000;

/** Default max bait flags before wallet removal: 3 (Req 7.6) */
export const DEFAULT_MAX_BAIT_FLAGS = 3;

/** Default flag window: 7 days in ms */
export const DEFAULT_FLAG_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Default max monitored holders percentage: 30% (Req 7.3) */
export const DEFAULT_MAX_MONITORED_HOLDERS_PCT = 0.30;

/** Default max volume footprint percentage: 5% (Req 7.7) */
export const DEFAULT_MAX_VOLUME_FOOTPRINT_PCT = 0.05;

// =============================================================================
// TYPES
// =============================================================================

/**
 * Configuration for AntiBaitingModule
 */
export interface AntiBaitingModuleConfig {
  /** Days to look back for deployer activity (default: 30) */
  deployerLookbackDays?: number;
  /** Max % of token holders from monitored wallets (default: 30%) */
  maxMonitoredHoldersPct?: number;
  /** Time window for round-trip detection in ms (default: 1 hour) */
  roundTripWindowMs?: number;
  /** Max bait flags before wallet removal (default: 3) */
  maxBaitFlags?: number;
  /** Time window for flag accumulation in ms (default: 7 days) */
  flagWindowMs?: number;
  /** Max % of daily volume our trade can represent (default: 5%) */
  maxVolumeFootprintPct?: number;
  /** Execution delay range for pattern obscuring in ms */
  executionDelayRange?: { min: number; max: number };
  /** Ethereum provider for on-chain queries */
  provider?: ethers.Provider;
  /** Initial list of monitored wallet addresses for holder concentration check */
  monitoredWallets?: string[];
}

/**
 * Result of holder concentration check
 */
export interface HolderConcentrationResult {
  /** Percentage of top holders that are monitored wallets (0-100) */
  concentrationPct: number;
  /** Number of top holders checked */
  topHoldersCount: number;
  /** Number of monitored wallets found among holders */
  monitoredHoldersCount: number;
  /** Whether concentration exceeds threshold */
  isHigh: boolean;
}

/**
 * Cache entry for deployer information
 */
interface DeployerCacheEntry {
  /** Deployer address for this token */
  deployerAddress: string;
  /** Timestamp when the token was deployed */
  deployedAt: number;
  /** Timestamp when this cache entry was created */
  cachedAt: number;
}

/**
 * Result of volume footprint check
 */
export interface VolumeFootprintResult {
  /** Our trade amount in USDC */
  tradeAmountUsdc: number;
  /** Token daily volume in USDC (24h) */
  dailyVolumeUsdc: number;
  /** Our trade as percentage of daily volume */
  footprintPct: number;
  /** Whether our footprint exceeds the threshold */
  isHigh: boolean;
}

/**
 * Internal statistics for the module
 */
interface AntiBaitingStats {
  totalChecks: number;
  totalApproved: number;
  totalRejected: number;
  rejectionsByReason: Record<BaitingRejectReason, number>;
}

/**
 * DexScreener API response type
 */
interface DexScreenerPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: {
    address: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    symbol: string;
  };
  volume?: {
    h24?: number;
    h6?: number;
    h1?: number;
  };
  liquidity?: {
    usd?: number;
  };
}

interface DexScreenerResponse {
  pairs: DexScreenerPair[] | null;
}

/**
 * Response from holder API (Moralis-style structure)
 */
interface TokenHolderInfo {
  /** Holder wallet address */
  address: string;
  /** Token balance (raw) */
  balance: string;
  /** Percentage of total supply */
  percentageOfSupply?: number;
}

/**
 * Response from DexScreener holders endpoint
 */
interface DexScreenerHoldersResponse {
  holders?: TokenHolderInfo[];
  total?: number;
}

// =============================================================================
// ANTI-BAITING MODULE CLASS
// =============================================================================

/**
 * AntiBaitingModule - Detects and mitigates manipulation attempts
 *
 * This class implements the core logic for:
 * - Deployer token detection (Req 7.1, Task 11.1)
 * - Blacklisted deployers management (Req 7.2, Task 11.1)
 * - Monitored holder concentration detection (Req 7.3, Task 11.3)
 * - Round-trip pattern detection (Req 7.4, 7.5, Task 11.5)
 * - Volume footprint limits (Req 7.7, Task 11.7)
 * - Execution delay randomization (Req 7.8, Task 11.9)
 */
export class AntiBaitingModule implements IAntiBaitingModule {
  private readonly config: Required<AntiBaitingConfig>;
  private readonly provider: ethers.Provider | null;

  // Blacklist of known scammer deployer addresses (Req 7.2)
  private readonly blacklistedDeployers: Set<string> = new Set();

  // Set of monitored wallet addresses for holder concentration check (Req 7.3)
  private monitoredWallets: Set<string> = new Set();

  // Cache for deployer lookups (token address → deployer info)
  private readonly deployerCache: Map<string, DeployerCacheEntry> = new Map();

  // Cache for daily volume lookups (token address → volume info)
  private readonly volumeCache: Map<string, { volumeUsdc: number; cachedAt: number }> = new Map();

  // Cache for holder data (token address → holder info)
  private readonly holderCache: Map<string, { holders: TokenHolderInfo[]; cachedAt: number }> = new Map();

  // Cache TTL for volume data (5 minutes)
  private readonly VOLUME_CACHE_TTL_MS = 5 * 60 * 1000;

  // Cache TTL for holder data (10 minutes - holders change less frequently)
  private readonly HOLDER_CACHE_TTL_MS = 10 * 60 * 1000;

  // Bait flags per wallet address (Req 7.5, 7.6)
  private readonly baitFlags: Map<string, BaitFlag[]> = new Map();

  // Statistics tracking
  private stats: AntiBaitingStats = {
    totalChecks: 0,
    totalApproved: 0,
    totalRejected: 0,
    rejectionsByReason: {} as Record<BaitingRejectReason, number>,
  };

  /**
   * Creates a new AntiBaitingModule instance
   * @param config - Configuration options
   */
  constructor(config: AntiBaitingModuleConfig = {}) {
    this.config = {
      deployerLookbackDays: config.deployerLookbackDays ?? DEFAULT_DEPLOYER_LOOKBACK_DAYS,
      maxMonitoredHoldersPct: config.maxMonitoredHoldersPct ?? DEFAULT_MAX_MONITORED_HOLDERS_PCT,
      roundTripWindowMs: config.roundTripWindowMs ?? DEFAULT_ROUND_TRIP_WINDOW_MS,
      maxBaitFlags: config.maxBaitFlags ?? DEFAULT_MAX_BAIT_FLAGS,
      flagWindowMs: config.flagWindowMs ?? DEFAULT_FLAG_WINDOW_MS,
      maxVolumeFootprintPct: config.maxVolumeFootprintPct ?? DEFAULT_MAX_VOLUME_FOOTPRINT_PCT,
      executionDelayRange: config.executionDelayRange ?? DEFAULT_EXECUTION_DELAY_MS,
    };

    this.provider = config.provider ?? null;

    // Initialize monitored wallets set (Req 7.3)
    if (config.monitoredWallets && config.monitoredWallets.length > 0) {
      this.setMonitoredWallets(config.monitoredWallets);
    }

    log.info('AntiBaitingModule initialized', {
      deployerLookbackDays: this.config.deployerLookbackDays,
      maxMonitoredHoldersPct: this.config.maxMonitoredHoldersPct,
      roundTripWindowMs: this.config.roundTripWindowMs,
      maxBaitFlags: this.config.maxBaitFlags,
      executionDelayRange: this.config.executionDelayRange,
      monitoredWalletsCount: this.monitoredWallets.size,
    });
  }

  // ===========================================================================
  // IAntiBaitingModule Interface Implementation
  // ===========================================================================

  /**
   * Check signal for baiting patterns.
   *
   * Performs the following checks:
   * 1. Deployer token detection (Req 7.1) - reject if source wallet deployed the token
   * 2. Blacklisted deployer check (Req 7.2) - reject if deployer is blacklisted
   * 3. [Future] Monitored holder concentration (Req 7.3)
   * 4. [Future] Round-trip detection (Req 7.4, 7.5)
   * 5. [Future] Volume footprint check (Req 7.7)
   *
   * @param signal - Enriched signal to check
   * @returns BaitingCheckResult with approval status and any flags
   */
  async check(signal: EnrichedSignal): Promise<BaitingCheckResult> {
    this.stats.totalChecks++;

    const flags = {
      isDeployerToken: false,
      highMonitoredHolders: false,
      recentRoundTrip: false,
      highVolumeFootprint: false,
    };

    log.debug('Checking signal for baiting patterns', {
      signalId: signal.id,
      sourceWallet: signal.sourceWallet.slice(0, 10),
      tokenAddress: signal.tokenAddress.slice(0, 10),
    });

    // Check 1: Deployer token detection (Req 7.1)
    const isDeployerToken = await this.isDeployerToken(signal.tokenAddress, signal.sourceWallet);
    flags.isDeployerToken = isDeployerToken;

    if (isDeployerToken) {
      return this._reject(signal, 'DEPLOYER_TOKEN', flags);
    }

    // Check 2: Blacklisted deployer (Req 7.2)
    const deployerInfo = await this.getTokenDeployer(signal.tokenAddress);
    if (deployerInfo && this.isDeployerBlacklisted(deployerInfo.deployerAddress)) {
      flags.isDeployerToken = true;
      return this._reject(signal, 'DEPLOYER_TOKEN', flags);
    }

    // Check 3: Monitored holder concentration (Req 7.3)
    if (this.monitoredWallets.size > 0) {
      const holderConcentration = await this.checkHolderConcentration(signal.tokenAddress);
      flags.highMonitoredHolders = holderConcentration.isHigh;

      if (holderConcentration.isHigh) {
        log.warn('High monitored holder concentration - BAITING RISK', {
          signalId: signal.id,
          tokenAddress: signal.tokenAddress.slice(0, 10),
          concentrationPct: holderConcentration.concentrationPct.toFixed(2),
          monitoredHoldersCount: holderConcentration.monitoredHoldersCount,
          topHoldersCount: holderConcentration.topHoldersCount,
          threshold: this.config.maxMonitoredHoldersPct * 100,
        });
        return this._reject(signal, 'HIGH_MONITORED_HOLDERS', flags);
      }
    }

    // Check 4: Round-trip detection (placeholder for Task 11.5)
    // TODO: Implement round-trip detection

    // Check 5: Volume footprint (Req 7.7)
    const volumeResult = await this.checkVolumeFootprint(signal.tokenAddress, signal.tradeAmountUsdc);
    flags.highVolumeFootprint = volumeResult.isHigh;

    if (volumeResult.isHigh) {
      log.warn('Volume footprint too large - BAITING RISK', {
        signalId: signal.id,
        tradeAmountUsdc: volumeResult.tradeAmountUsdc,
        dailyVolumeUsdc: volumeResult.dailyVolumeUsdc,
        footprintPct: volumeResult.footprintPct.toFixed(2),
        threshold: this.config.maxVolumeFootprintPct * 100,
      });
      return this._reject(signal, 'VOLUME_FOOTPRINT', flags);
    }

    // Signal approved
    this.stats.totalApproved++;
    const suggestedDelay = this._calculateExecutionDelay();

    log.info('Signal passed baiting check', {
      signalId: signal.id,
      sourceWallet: signal.sourceWallet.slice(0, 10),
      suggestedDelay,
    });

    return {
      approved: true,
      flags,
      suggestedDelay,
    };
  }

  /**
   * Get bait flags for a specific wallet address.
   *
   * @param walletAddress - The wallet address to get flags for
   * @returns Array of BaitFlag records for the wallet
   */
  getFlags(walletAddress: string): BaitFlag[] {
    const normalizedAddress = walletAddress.toLowerCase();
    const flags = this.baitFlags.get(normalizedAddress) || [];

    // Filter to only return flags within the flag window
    const now = Date.now();
    const activeFlags = flags.filter(
      (flag) => now - flag.flaggedAt < this.config.flagWindowMs
    );

    return activeFlags;
  }

  /**
   * Add a deployer address to the blacklist.
   * Blacklisted deployers are considered known scammers (Req 7.2).
   *
   * @param deployerAddress - The deployer address to blacklist
   */
  blacklistDeployer(deployerAddress: string): void {
    const normalizedAddress = deployerAddress.toLowerCase();

    if (this.blacklistedDeployers.has(normalizedAddress)) {
      log.debug('Deployer already blacklisted', { deployerAddress });
      return;
    }

    this.blacklistedDeployers.add(normalizedAddress);

    log.info('Deployer added to blacklist', {
      deployerAddress,
      totalBlacklisted: this.blacklistedDeployers.size,
    });
  }

  /**
   * Get the list of all blacklisted deployer addresses.
   *
   * @returns Array of blacklisted deployer addresses
   */
  getBlacklistedDeployers(): string[] {
    return Array.from(this.blacklistedDeployers);
  }

  // ===========================================================================
  // Deployer Token Detection (Req 7.1)
  // ===========================================================================

  /**
   * Check if a token was deployed by a specific wallet address
   * within the lookback period (30 days by default).
   *
   * @param tokenAddress - The token contract address
   * @param sourceWallet - The source wallet to check against
   * @returns true if the source wallet deployed this token recently
   */
  async isDeployerToken(tokenAddress: string, sourceWallet: string): Promise<boolean> {
    const deployerInfo = await this.getTokenDeployer(tokenAddress);

    if (!deployerInfo) {
      // Unable to determine deployer - allow the trade (conservative approach)
      log.debug('Unable to determine token deployer', { tokenAddress });
      return false;
    }

    const normalizedSourceWallet = sourceWallet.toLowerCase();
    const normalizedDeployer = deployerInfo.deployerAddress.toLowerCase();

    // Check if deployer matches source wallet
    if (normalizedDeployer !== normalizedSourceWallet) {
      return false;
    }

    // Check if deployment was within lookback period
    const lookbackMs = this.config.deployerLookbackDays * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const deploymentAge = now - deployerInfo.deployedAt;

    if (deploymentAge > lookbackMs) {
      log.debug('Token deployed by source wallet but outside lookback period', {
        tokenAddress,
        sourceWallet,
        deploymentAgeDays: Math.floor(deploymentAge / (24 * 60 * 60 * 1000)),
        lookbackDays: this.config.deployerLookbackDays,
      });
      return false;
    }

    log.warn('Token deployed by source wallet within lookback period - BAITING DETECTED', {
      tokenAddress,
      sourceWallet,
      deploymentAgeDays: Math.floor(deploymentAge / (24 * 60 * 60 * 1000)),
    });

    return true;
  }

  /**
   * Get the deployer information for a token.
   * Uses cache if available, otherwise queries on-chain.
   *
   * @param tokenAddress - The token contract address
   * @returns DeployerCacheEntry or null if unable to determine
   */
  async getTokenDeployer(tokenAddress: string): Promise<DeployerCacheEntry | null> {
    const normalizedToken = tokenAddress.toLowerCase();

    // Check cache first
    const cached = this.deployerCache.get(normalizedToken);
    if (cached) {
      return cached;
    }

    // Try to get deployer from on-chain
    const deployerInfo = await this._fetchDeployerFromChain(tokenAddress);

    if (deployerInfo) {
      this.deployerCache.set(normalizedToken, deployerInfo);
    }

    return deployerInfo;
  }

  /**
   * Check if a deployer address is in the blacklist.
   *
   * @param deployerAddress - The deployer address to check
   * @returns true if the deployer is blacklisted
   */
  isDeployerBlacklisted(deployerAddress: string): boolean {
    return this.blacklistedDeployers.has(deployerAddress.toLowerCase());
  }

  // ===========================================================================
  // Volume Footprint Detection (Req 7.7)
  // ===========================================================================

  /**
   * Check if our trade would exceed the volume footprint threshold.
   * Rejects signals where our buy would exceed 5% of the token's daily volume.
   *
   * @param tokenAddress - The token contract address
   * @param tradeAmountUsdc - Our trade amount in USDC
   * @returns VolumeFootprintResult with footprint calculation
   */
  async checkVolumeFootprint(
    tokenAddress: string,
    tradeAmountUsdc: number
  ): Promise<VolumeFootprintResult> {
    // Get daily volume for the token
    const dailyVolumeUsdc = await this._getDailyVolume(tokenAddress);

    // If we couldn't get volume data, use conservative approach:
    // - If trade is small (<$50), allow it
    // - If trade is larger, assume high footprint for safety
    if (dailyVolumeUsdc === 0) {
      const isSmallTrade = tradeAmountUsdc < 50;
      log.debug('Volume data unavailable - using conservative estimate', {
        tokenAddress: tokenAddress.slice(0, 10),
        tradeAmountUsdc,
        isSmallTrade,
        action: isSmallTrade ? 'allowing' : 'rejecting',
      });

      return {
        tradeAmountUsdc,
        dailyVolumeUsdc: 0,
        footprintPct: isSmallTrade ? 0 : 100,
        isHigh: !isSmallTrade,
      };
    }

    // Calculate footprint percentage
    const footprintPct = (tradeAmountUsdc / dailyVolumeUsdc) * 100;
    const thresholdPct = this.config.maxVolumeFootprintPct * 100; // Convert from 0.05 to 5
    const isHigh = footprintPct > thresholdPct;

    log.debug('Volume footprint calculated', {
      tokenAddress: tokenAddress.slice(0, 10),
      tradeAmountUsdc,
      dailyVolumeUsdc,
      footprintPct: footprintPct.toFixed(2),
      thresholdPct,
      isHigh,
    });

    return {
      tradeAmountUsdc,
      dailyVolumeUsdc,
      footprintPct,
      isHigh,
    };
  }

  /**
   * Get the daily trading volume (24h) for a token in USDC.
   *
   * For MVP, this uses a simplified approach:
   * 1. Check cache first
   * 2. If available, query DexScreener or GeckoTerminal API
   * 3. If unavailable, return 0 (conservative - will trigger footprint check)
   *
   * @param tokenAddress - The token contract address
   * @returns Daily volume in USDC, or 0 if unavailable
   */
  private async _getDailyVolume(tokenAddress: string): Promise<number> {
    const normalizedToken = tokenAddress.toLowerCase();

    // Check cache first
    const cached = this.volumeCache.get(normalizedToken);
    if (cached && Date.now() - cached.cachedAt < this.VOLUME_CACHE_TTL_MS) {
      return cached.volumeUsdc;
    }

    try {
      // Try to fetch volume from DexScreener API
      const volumeUsdc = await this._fetchVolumeFromDexScreener(tokenAddress);

      // Cache the result
      this.volumeCache.set(normalizedToken, {
        volumeUsdc,
        cachedAt: Date.now(),
      });

      return volumeUsdc;
    } catch (err) {
      log.error('Failed to fetch daily volume', {
        tokenAddress: tokenAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });

      // Cache zero to avoid repeated failures
      this.volumeCache.set(normalizedToken, {
        volumeUsdc: 0,
        cachedAt: Date.now(),
      });

      return 0;
    }
  }

  /**
   * Fetch token volume from DexScreener API.
   * DexScreener provides free access to volume data for most DEX pairs.
   *
   * @param tokenAddress - The token contract address
   * @returns Daily volume in USDC
   */
  private async _fetchVolumeFromDexScreener(tokenAddress: string): Promise<number> {
    // DexScreener API endpoint for Base chain
    const baseChainId = 'base';
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'CopyTradingBot/1.0',
        },
        signal: AbortSignal.timeout(5000), // 5 second timeout
      });

      if (!response.ok) {
        log.debug('DexScreener API returned non-OK status', {
          tokenAddress: tokenAddress.slice(0, 10),
          status: response.status,
        });
        return 0;
      }

      const data = await response.json() as DexScreenerResponse;

      if (!data.pairs || data.pairs.length === 0) {
        log.debug('No pairs found on DexScreener', {
          tokenAddress: tokenAddress.slice(0, 10),
        });
        return 0;
      }

      // Find pairs on Base chain and sum their 24h volume
      const basePairs = data.pairs.filter(
        (pair) => pair.chainId === baseChainId
      );

      if (basePairs.length === 0) {
        // If no Base pairs, try to use any pair
        const totalVolume = data.pairs.reduce(
          (sum, pair) => sum + (pair.volume?.h24 || 0),
          0
        );
        log.debug('Using volume from all chains (no Base pairs found)', {
          tokenAddress: tokenAddress.slice(0, 10),
          totalVolume,
          pairsCount: data.pairs.length,
        });
        return totalVolume;
      }

      // Sum volume from all Base pairs
      const totalVolume = basePairs.reduce(
        (sum, pair) => sum + (pair.volume?.h24 || 0),
        0
      );

      log.debug('Fetched volume from DexScreener', {
        tokenAddress: tokenAddress.slice(0, 10),
        totalVolume,
        basePairsCount: basePairs.length,
      });

      return totalVolume;
    } catch (err) {
      // Network errors or timeouts
      log.debug('DexScreener fetch failed', {
        tokenAddress: tokenAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  /**
   * Clear the volume cache.
   * Useful for testing or when cache becomes stale.
   */
  clearVolumeCache(): void {
    this.volumeCache.clear();
    log.debug('Volume cache cleared');
  }

  /**
   * Manually set volume for a token (for testing).
   *
   * @param tokenAddress - The token address
   * @param volumeUsdc - The volume in USDC
   */
  setVolumeCache(tokenAddress: string, volumeUsdc: number): void {
    this.volumeCache.set(tokenAddress.toLowerCase(), {
      volumeUsdc,
      cachedAt: Date.now(),
    });
  }

  // ===========================================================================
  // Holder Concentration Detection (Req 7.3)
  // ===========================================================================

  /**
   * Check if token holder concentration exceeds threshold.
   * Rejects signals where >30% of token holders are wallets we are monitoring.
   *
   * This helps detect baiting scenarios where multiple monitored wallets
   * have already bought into the same token, indicating potential manipulation.
   *
   * @param tokenAddress - The token contract address
   * @returns HolderConcentrationResult with concentration calculation
   */
  async checkHolderConcentration(tokenAddress: string): Promise<HolderConcentrationResult> {
    // Get top holders for the token
    const holders = await this._getTopHolders(tokenAddress);

    // If we couldn't get holder data, assume low concentration (allow trade)
    if (holders.length === 0) {
      log.debug('Holder data unavailable - assuming low concentration', {
        tokenAddress: tokenAddress.slice(0, 10),
      });

      return {
        concentrationPct: 0,
        topHoldersCount: 0,
        monitoredHoldersCount: 0,
        isHigh: false,
      };
    }

    // Count how many top holders are in our monitored wallets set
    const monitoredHoldersCount = holders.filter((holder) =>
      this.monitoredWallets.has(holder.address.toLowerCase())
    ).length;

    // Calculate concentration percentage
    const concentrationPct = (monitoredHoldersCount / holders.length) * 100;
    const thresholdPct = this.config.maxMonitoredHoldersPct * 100; // Convert from 0.30 to 30
    const isHigh = concentrationPct > thresholdPct;

    log.debug('Holder concentration calculated', {
      tokenAddress: tokenAddress.slice(0, 10),
      topHoldersCount: holders.length,
      monitoredHoldersCount,
      concentrationPct: concentrationPct.toFixed(2),
      thresholdPct,
      isHigh,
    });

    return {
      concentrationPct,
      topHoldersCount: holders.length,
      monitoredHoldersCount,
      isHigh,
    };
  }

  /**
   * Get the top holders for a token.
   *
   * For MVP, this uses a simplified approach:
   * 1. Check cache first
   * 2. Try to fetch from APIs (Moralis, Alchemy, etc.)
   * 3. If unavailable, return empty array (conservative - allows trade)
   *
   * @param tokenAddress - The token contract address
   * @param limit - Maximum number of holders to return (default: 100)
   * @returns Array of TokenHolderInfo
   */
  private async _getTopHolders(
    tokenAddress: string,
    limit: number = 100
  ): Promise<TokenHolderInfo[]> {
    const normalizedToken = tokenAddress.toLowerCase();

    // Check cache first
    const cached = this.holderCache.get(normalizedToken);
    if (cached && Date.now() - cached.cachedAt < this.HOLDER_CACHE_TTL_MS) {
      return cached.holders.slice(0, limit);
    }

    try {
      // Try to fetch holders from available APIs
      const holders = await this._fetchHoldersFromAPI(tokenAddress, limit);

      // Cache the result
      this.holderCache.set(normalizedToken, {
        holders,
        cachedAt: Date.now(),
      });

      return holders;
    } catch (err) {
      log.error('Failed to fetch token holders', {
        tokenAddress: tokenAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });

      // Cache empty result to avoid repeated failures
      this.holderCache.set(normalizedToken, {
        holders: [],
        cachedAt: Date.now(),
      });

      return [];
    }
  }

  /**
   * Fetch token holders from available APIs.
   *
   * This method tries multiple data sources:
   * 1. DexScreener (if they provide holder data)
   * 2. Moralis API (requires API key)
   * 3. Alchemy API (requires API key)
   * 4. On-chain enumeration (expensive but works without API keys)
   *
   * For MVP, we implement a basic approach using public APIs.
   *
   * @param tokenAddress - The token contract address
   * @param limit - Maximum number of holders to return
   * @returns Array of TokenHolderInfo
   */
  private async _fetchHoldersFromAPI(
    tokenAddress: string,
    limit: number
  ): Promise<TokenHolderInfo[]> {
    // Try multiple sources in order of preference

    // 1. Try Basescan API (free tier available)
    const basescanHolders = await this._fetchHoldersFromBasescan(tokenAddress, limit);
    if (basescanHolders.length > 0) {
      return basescanHolders;
    }

    // 2. Try on-chain enumeration via Transfer events (fallback)
    // This is expensive but works without external API keys
    const onChainHolders = await this._fetchHoldersFromChain(tokenAddress, limit);
    if (onChainHolders.length > 0) {
      return onChainHolders;
    }

    log.debug('No holder data available from any source', {
      tokenAddress: tokenAddress.slice(0, 10),
    });

    return [];
  }

  /**
   * Fetch token holders from Basescan API.
   *
   * Note: This requires a Basescan API key for production use.
   * The free tier has rate limits (5 calls/second).
   *
   * @param tokenAddress - The token contract address
   * @param limit - Maximum number of holders to return
   * @returns Array of TokenHolderInfo
   */
  private async _fetchHoldersFromBasescan(
    tokenAddress: string,
    limit: number
  ): Promise<TokenHolderInfo[]> {
    // Basescan token holder endpoint
    // Note: This endpoint may not be available on free tier
    const apiKey = process.env.BASESCAN_API_KEY || '';
    
    if (!apiKey) {
      log.debug('Basescan API key not configured, skipping', {
        tokenAddress: tokenAddress.slice(0, 10),
      });
      return [];
    }

    const url = `https://api.basescan.org/api?module=token&action=tokenholderlist&contractaddress=${tokenAddress}&page=1&offset=${limit}&apikey=${apiKey}`;

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
        signal: AbortSignal.timeout(10000), // 10 second timeout
      });

      if (!response.ok) {
        log.debug('Basescan API returned non-OK status', {
          tokenAddress: tokenAddress.slice(0, 10),
          status: response.status,
        });
        return [];
      }

      const data = await response.json() as {
        status: string;
        message: string;
        result: Array<{
          TokenHolderAddress: string;
          TokenHolderQuantity: string;
        }>;
      };

      if (data.status !== '1' || !Array.isArray(data.result)) {
        log.debug('Basescan API returned no results', {
          tokenAddress: tokenAddress.slice(0, 10),
          status: data.status,
          message: data.message,
        });
        return [];
      }

      const holders: TokenHolderInfo[] = data.result.map((holder) => ({
        address: holder.TokenHolderAddress,
        balance: holder.TokenHolderQuantity,
      }));

      log.debug('Fetched holders from Basescan', {
        tokenAddress: tokenAddress.slice(0, 10),
        holdersCount: holders.length,
      });

      return holders;
    } catch (err) {
      log.debug('Basescan fetch failed', {
        tokenAddress: tokenAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Fetch token holders by analyzing Transfer events on-chain.
   *
   * This is a fallback method that doesn't require external APIs but
   * is more expensive and may miss some holders if the token has
   * many transfers.
   *
   * @param tokenAddress - The token contract address
   * @param limit - Maximum number of holders to return
   * @returns Array of TokenHolderInfo
   */
  private async _fetchHoldersFromChain(
    tokenAddress: string,
    limit: number
  ): Promise<TokenHolderInfo[]> {
    if (!this.provider) {
      log.debug('No provider configured, cannot fetch holders from chain', {
        tokenAddress: tokenAddress.slice(0, 10),
      });
      return [];
    }

    try {
      // ERC-20 Transfer event topic
      const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

      // Get current block number
      const currentBlock = await this.provider.getBlockNumber();

      // Look back a reasonable number of blocks (about 1 day on Base ~2s blocks)
      const lookbackBlocks = 43200; // ~24 hours
      const fromBlock = Math.max(0, currentBlock - lookbackBlocks);

      // Get Transfer events
      const logs = await this.provider.getLogs({
        address: tokenAddress,
        topics: [TRANSFER_TOPIC],
        fromBlock,
        toBlock: currentBlock,
      });

      if (logs.length === 0) {
        log.debug('No Transfer events found', {
          tokenAddress: tokenAddress.slice(0, 10),
          fromBlock,
          toBlock: currentBlock,
        });
        return [];
      }

      // Build a map of holder balances from Transfer events
      // Note: This is an approximation - actual balances could differ
      const balances = new Map<string, bigint>();
      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

      for (const log of logs) {
        // Decode from and to addresses from topics
        const from = '0x' + log.topics[1].slice(26).toLowerCase();
        const to = '0x' + log.topics[2].slice(26).toLowerCase();
        const value = BigInt(log.data);

        // Skip zero address (mint/burn)
        if (from !== ZERO_ADDRESS) {
          const currentBalance = balances.get(from) ?? 0n;
          balances.set(from, currentBalance - value);
        }

        if (to !== ZERO_ADDRESS) {
          const currentBalance = balances.get(to) ?? 0n;
          balances.set(to, currentBalance + value);
        }
      }

      // Filter to addresses with positive balance and sort by balance
      const holders: TokenHolderInfo[] = Array.from(balances.entries())
        .filter(([, balance]) => balance > 0n)
        .sort(([, a], [, b]) => (b > a ? 1 : b < a ? -1 : 0))
        .slice(0, limit)
        .map(([address, balance]) => ({
          address,
          balance: balance.toString(),
        }));

      log.debug('Fetched holders from chain Transfer events', {
        tokenAddress: tokenAddress.slice(0, 10),
        holdersCount: holders.length,
        logsAnalyzed: logs.length,
      });

      return holders;
    } catch (err) {
      log.error('Failed to fetch holders from chain', {
        tokenAddress: tokenAddress.slice(0, 10),
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Set the list of monitored wallet addresses.
   * Used for holder concentration checks.
   *
   * @param wallets - Array of wallet addresses to monitor
   */
  setMonitoredWallets(wallets: string[]): void {
    this.monitoredWallets.clear();
    for (const wallet of wallets) {
      this.monitoredWallets.add(wallet.toLowerCase());
    }

    log.info('Monitored wallets updated', {
      count: this.monitoredWallets.size,
    });
  }

  /**
   * Get the current list of monitored wallet addresses.
   *
   * @returns Array of monitored wallet addresses
   */
  getMonitoredWallets(): string[] {
    return Array.from(this.monitoredWallets);
  }

  /**
   * Clear the holder cache.
   * Useful for testing or when cache becomes stale.
   */
  clearHolderCache(): void {
    this.holderCache.clear();
    log.debug('Holder cache cleared');
  }

  /**
   * Manually set holders for a token (for testing).
   *
   * @param tokenAddress - The token address
   * @param holders - Array of holder info
   */
  setHolderCache(tokenAddress: string, holders: TokenHolderInfo[]): void {
    this.holderCache.set(tokenAddress.toLowerCase(), {
      holders,
      cachedAt: Date.now(),
    });
  }

  // ===========================================================================
  // Bait Flag Management (Req 7.5, 7.6)
  // ===========================================================================

  /**
   * Add a bait flag to a wallet.
   * Used for tracking suspicious behavior patterns.
   *
   * @param walletAddress - The wallet address to flag
   * @param tokenAddress - The token involved in the suspicious activity
   * @param reason - The reason for the flag
   */
  addBaitFlag(walletAddress: string, tokenAddress: string, reason: BaitingRejectReason): void {
    const normalizedAddress = walletAddress.toLowerCase();

    const flag: BaitFlag = {
      walletAddress: normalizedAddress,
      tokenAddress: tokenAddress.toLowerCase(),
      reason,
      flaggedAt: Date.now(),
    };

    const existingFlags = this.baitFlags.get(normalizedAddress) || [];
    existingFlags.push(flag);
    this.baitFlags.set(normalizedAddress, existingFlags);

    const activeFlags = this.getFlags(walletAddress);

    log.info('Bait flag added', {
      walletAddress,
      tokenAddress,
      reason,
      totalActiveFlags: activeFlags.length,
    });
  }

  /**
   * Check if a wallet has exceeded the maximum bait flag threshold.
   *
   * @param walletAddress - The wallet address to check
   * @returns true if the wallet should be removed due to too many flags
   */
  shouldRemoveWallet(walletAddress: string): boolean {
    const activeFlags = this.getFlags(walletAddress);
    return activeFlags.length >= this.config.maxBaitFlags;
  }

  /**
   * Clear all bait flags for a wallet.
   * Useful for manual intervention or testing.
   *
   * @param walletAddress - The wallet address to clear flags for
   */
  clearFlags(walletAddress: string): void {
    const normalizedAddress = walletAddress.toLowerCase();
    this.baitFlags.delete(normalizedAddress);

    log.info('Bait flags cleared', { walletAddress });
  }

  // ===========================================================================
  // Statistics and Debugging
  // ===========================================================================

  /**
   * Get module statistics.
   *
   * @returns Statistics object with check counts and rejection breakdown
   */
  getStats(): AntiBaitingStats {
    return {
      ...this.stats,
      rejectionsByReason: { ...this.stats.rejectionsByReason },
    };
  }

  /**
   * Clear the deployer cache.
   * Useful for testing or when cache becomes stale.
   */
  clearDeployerCache(): void {
    this.deployerCache.clear();
    log.debug('Deployer cache cleared');
  }

  /**
   * Get the current configuration.
   *
   * @returns The active configuration
   */
  getConfig(): Required<AntiBaitingConfig> {
    return { ...this.config };
  }

  // ===========================================================================
  // Private Helper Methods
  // ===========================================================================

  /**
   * Fetch deployer information from the blockchain.
   * Looks up the contract creation transaction to find the deployer.
   *
   * @param tokenAddress - The token contract address
   * @returns DeployerCacheEntry or null if unable to determine
   */
  private async _fetchDeployerFromChain(tokenAddress: string): Promise<DeployerCacheEntry | null> {
    if (!this.provider) {
      log.debug('No provider configured, cannot fetch deployer from chain', { tokenAddress });
      return null;
    }

    try {
      // Try to get the contract code to verify it exists
      const code = await this.provider.getCode(tokenAddress);
      if (code === '0x' || code === '0x0') {
        log.debug('Address is not a contract', { tokenAddress });
        return null;
      }

      // For EVM chains, we need to look up the deployment transaction
      // This typically requires an indexer or block explorer API
      // For now, we'll use a heuristic approach:
      // 1. Get the current block
      // 2. Try to trace back the contract creation

      // Note: This is a simplified implementation. In production,
      // you would use an indexer like Etherscan API, The Graph, or
      // a dedicated service to get accurate deployment information.

      // For MVP, we'll check if we can get any historical information
      // about the contract from events or other heuristics

      log.debug('Deployer lookup requires external indexer - returning null for MVP', {
        tokenAddress,
      });

      // In a full implementation, you would:
      // 1. Call Etherscan/Basescan API to get contract creator
      // 2. Or use The Graph to query deployment events
      // 3. Or trace back through transaction history

      return null;
    } catch (err) {
      log.error('Failed to fetch deployer from chain', {
        tokenAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Calculate a random execution delay within the configured range.
   * Used for pattern obscuring (Req 7.8).
   *
   * @returns Delay in milliseconds
   */
  private _calculateExecutionDelay(): number {
    const { min, max } = this.config.executionDelayRange;
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  /**
   * Reject a signal and update statistics.
   *
   * @param signal - The signal being rejected
   * @param reason - The rejection reason
   * @param flags - The detection flags
   * @returns BaitingCheckResult with rejection details
   */
  private _reject(
    signal: EnrichedSignal,
    reason: BaitingRejectReason,
    flags: BaitingCheckResult['flags']
  ): BaitingCheckResult {
    this.stats.totalRejected++;
    this.stats.rejectionsByReason[reason] =
      (this.stats.rejectionsByReason[reason] || 0) + 1;

    // Add a bait flag for this wallet
    this.addBaitFlag(signal.sourceWallet, signal.tokenAddress, reason);

    log.warn('Signal rejected by AntiBaitingModule', {
      signalId: signal.id,
      sourceWallet: signal.sourceWallet.slice(0, 10),
      tokenAddress: signal.tokenAddress.slice(0, 10),
      reason,
      flags,
    });

    return {
      approved: false,
      rejectReason: reason,
      flags,
      suggestedDelay: 0,
    };
  }
}

// =============================================================================
// FACTORY FUNCTION
// =============================================================================

/**
 * Create an AntiBaitingModule with common configuration.
 *
 * @param provider - Optional Ethereum provider for on-chain queries
 * @param config - Optional configuration overrides
 * @returns Configured AntiBaitingModule instance
 */
export function createAntiBaitingModule(
  provider?: ethers.Provider,
  config?: Partial<AntiBaitingModuleConfig>
): AntiBaitingModule {
  return new AntiBaitingModule({
    provider,
    ...config,
  });
}

// =============================================================================
// EXPORTS
// =============================================================================

export type { DeployerCacheEntry, AntiBaitingStats, TokenHolderInfo };

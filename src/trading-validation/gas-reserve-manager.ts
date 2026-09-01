/**
 * Gas Reserve Manager - ETH balance monitoring and trade entry gating
 *
 * Monitors ETH balance to ensure sufficient gas for trade operations.
 * Blocks trade entry when ETH drops below minimum reserve (0.005 ETH).
 * Triggers SafeMode integration when ETH reaches critical threshold (0.002 ETH).
 * Estimates gas coverage for N full trade cycles (approval + entry + exit per cycle).
 *
 * Requirements: 21.1, 21.2, 21.3, 21.4, 21.5
 */

import type { EthAmount } from './types.js';
import type { GasReserveConfig } from './config.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Provider interface for querying on-chain ETH balance.
 * Compatible with ethers v6 Provider.getBalance().
 */
export interface IEthBalanceProvider {
  getBalance(address: string): Promise<bigint>;
}

/**
 * Callback interface for triggering safe mode on critical gas threshold.
 * SafeModeController doesn't exist yet — this decouples the dependency.
 */
export interface ISafeModeTrigger {
  onGasCritical(balance: EthAmount): void;
}

/**
 * Gas Reserve Manager interface.
 * Monitors ETH balance and gates trade entry based on gas reserve thresholds.
 */
export interface IGasReserveManager {
  /** Query current on-chain ETH balance via provider */
  getEthBalance(): Promise<EthAmount>;
  /** Returns true if balance >= minReserveEth AND covers estimated gas. Blocks if ETH < 0.005 */
  canEnterTrade(estimatedGas: EthAmount): boolean;
  /** Returns true if ETH < criticalReserveEth (0.002 ETH) */
  isCritical(): boolean;
  /** Returns true if balance covers N full trade cycles */
  coversNCycles(n: number, avgGasPerCycle: EthAmount): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Estimated gas per full trade cycle (approval + entry swap + exit swap).
 * - Approval: ~50,000 gas
 * - Entry swap: ~150,000 gas
 * - Exit swap: ~150,000 gas
 * Total: ~350,000 gas per cycle
 */
export const GAS_PER_CYCLE_UNITS = 350_000n;

/** Approval gas estimate in gas units */
export const APPROVAL_GAS_UNITS = 50_000n;

/** Swap gas estimate in gas units */
export const SWAP_GAS_UNITS = 150_000n;

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class GasReserveManager implements IGasReserveManager {
  private readonly config: GasReserveConfig;
  private readonly provider: IEthBalanceProvider;
  private readonly walletAddress: string;
  private readonly safeModeTrigger: ISafeModeTrigger | null;

  /** Cached balance from last getEthBalance() call */
  private lastKnownBalance: EthAmount = 0n;

  constructor(
    config: GasReserveConfig,
    provider: IEthBalanceProvider,
    walletAddress: string,
    safeModeTrigger?: ISafeModeTrigger,
  ) {
    this.config = config;
    this.provider = provider;
    this.walletAddress = walletAddress;
    this.safeModeTrigger = safeModeTrigger ?? null;
  }

  /**
   * Query on-chain ETH balance via provider.
   * Updates internal cache and triggers safe mode if critical.
   *
   * Requirements: 21.1
   */
  async getEthBalance(): Promise<EthAmount> {
    const balance = await this.provider.getBalance(this.walletAddress);
    this.lastKnownBalance = balance;

    // Check critical threshold and trigger safe mode if needed
    if (balance < this.config.criticalReserveEth && this.safeModeTrigger) {
      this.safeModeTrigger.onGasCritical(balance);
    }

    return balance;
  }

  /**
   * Returns true if the wallet can afford to enter a trade.
   * Blocks entry if ETH balance < minReserveEth (0.005 ETH).
   * Also checks that balance covers the estimated gas for this specific trade.
   *
   * Uses cached balance from last getEthBalance() call.
   *
   * Requirements: 21.2, 21.3
   */
  canEnterTrade(estimatedGas: EthAmount): boolean {
    // Block if below minimum reserve
    if (this.lastKnownBalance < this.config.minReserveEth) {
      return false;
    }

    // Block if estimated gas exceeds available balance
    if (estimatedGas > this.lastKnownBalance) {
      return false;
    }

    return true;
  }

  /**
   * Returns true if ETH balance is below critical threshold (0.002 ETH).
   * When critical, the system should enter SafeMode.
   *
   * Uses cached balance from last getEthBalance() call.
   *
   * Requirements: 21.4
   */
  isCritical(): boolean {
    return this.lastKnownBalance < this.config.criticalReserveEth;
  }

  /**
   * Returns true if the current balance covers N full trade cycles.
   * A full cycle = approval (~50k gas) + entry swap (~150k gas) + exit swap (~150k gas).
   * The avgGasPerCycle parameter is the estimated ETH cost per cycle (gas units × gas price).
   *
   * Requirements: 21.5
   */
  coversNCycles(n: number, avgGasPerCycle: EthAmount): boolean {
    if (n <= 0) {
      return true;
    }

    const totalRequired = avgGasPerCycle * BigInt(n);
    return this.lastKnownBalance >= totalRequired;
  }

  /**
   * Returns the last known cached balance without making an RPC call.
   * Useful for synchronous checks between explicit refresh calls.
   */
  getLastKnownBalance(): EthAmount {
    return this.lastKnownBalance;
  }
}

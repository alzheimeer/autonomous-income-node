/**
 * Survival Module
 *
 * Monitors the USDC balance on-chain (Base) via ethers.JsonRpcProvider,
 * evaluates the operational tier, and:
 *  - Emits `tier:transition` exactly ONCE per tier change
 *  - Emits `tier:emergency` when balance reaches $0
 *  - Saves a balance_history snapshot on every balance change
 *  - Notifies all CapabilityGates subscribers on tier changes
 *
 * In development / mock mode (NODE_ENV=development or MOCK_ONCHAIN_IDENTITY=true),
 * the module uses a configurable mock balance instead of querying the RPC.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 4.7
 */

import { EventEmitter } from 'node:events';
import { ethers } from 'ethers';

import {
  SurvivalTier,
  evaluateTier,
  evaluateTierWithLending,
  getCapabilityGates,
  type CapabilityGates,
  TIER_THRESHOLDS,
} from './tier-evaluator.js';
import { CapabilityGatesDistributor } from './capability-gates.js';

// ---------------------------------------------------------------------------
// Re-exports (convenience)
// ---------------------------------------------------------------------------

export { SurvivalTier, getCapabilityGates, evaluateTier, evaluateTierWithLending, TIER_THRESHOLDS };
export type { CapabilityGates };
export { CapabilityGatesDistributor };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** USDC contract address on Base mainnet */
const USDC_CONTRACT_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** Aave V3 aUSDC token address on Base mainnet (represents deposited USDC + interest) */
const A_USDC_BASE = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';

/** Minimal ERC-20 ABI — only `balanceOf` needed */
const ERC20_ABI = ['function balanceOf(address owner) view returns (uint256)'] as const;

/** Polling interval: 60 seconds (Requirement 4.7) */
const POLL_INTERVAL_MS = 60_000;

/** Default mock balance: 100 USDC in 6-decimal units */
const DEFAULT_MOCK_BALANCE_USDC = 100_000000n;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Payload emitted with the `tier:transition` event.
 */
export interface TierTransitionEvent {
  /** The tier active before this transition. */
  previousTier: SurvivalTier;
  /** The tier now active. */
  newTier: SurvivalTier;
  /** USDC balance (6-decimal bigint) that triggered the transition. */
  balance: bigint;
  /** Capability gates for the new tier. */
  gates: CapabilityGates;
  /** Unix epoch timestamp in milliseconds at the time of the transition. */
  timestamp: number;
}

/**
 * Optional database interface for persisting balance snapshots.
 * Injected to decouple the survival module from the database layer.
 */
export interface BalanceHistoryStore {
  insert(entry: { balanceUsdc: string; tier: number; blockNumber?: number; recordedAt?: number }): number;
}

/**
 * Construction options for {@link SurvivalModule}.
 */
export interface SurvivalModuleOptions {
  /**
   * Optional CapabilityGatesDistributor to share with other modules.
   * A fresh instance is created if not provided.
   */
  gatesDistributor?: CapabilityGatesDistributor;
  /**
   * Optional database store for balance_history persistence.
   * When omitted, balance history is not persisted.
   */
  balanceHistoryStore?: BalanceHistoryStore;
  /**
   * Override the polling interval in milliseconds (useful for tests).
   * Defaults to 60 seconds.
   */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Typed event map
// ---------------------------------------------------------------------------

interface SurvivalEvents {
  'tier:transition': [event: TierTransitionEvent];
  'tier:emergency': [balance: bigint];
  'balance:updated': [balance: bigint, tier: SurvivalTier];
}

// ---------------------------------------------------------------------------
// SurvivalModule class
// ---------------------------------------------------------------------------

/**
 * Full SurvivalModule implementation.
 *
 * Usage:
 * ```ts
 * const survival = new SurvivalModule(rpcUrl, walletAddress);
 * await survival.start();
 * // ...
 * await survival.stop();
 * ```
 */
export class SurvivalModule extends EventEmitter<SurvivalEvents> {
  private currentTier: SurvivalTier = SurvivalTier.EMERGENCY;
  private currentBalance: bigint = 0n;
  private lastWalletUsdc: bigint = 0n;
  private lastAaveUsdc: bigint = 0n;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private readonly gatesDistributor: CapabilityGatesDistributor;
  private readonly balanceHistoryStore: BalanceHistoryStore | null;
  private readonly pollIntervalMs: number;
  private readonly isMockMode: boolean;
  private readonly mockBalance: bigint;

  constructor(
    private readonly rpcUrl: string,
    private readonly walletAddress: string,
    options: SurvivalModuleOptions = {},
  ) {
    super();
    this.gatesDistributor = options.gatesDistributor ?? new CapabilityGatesDistributor();
    this.balanceHistoryStore = options.balanceHistoryStore ?? null;
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;

    // Determine mock mode
    const env = process.env;
    this.isMockMode =
      env['NODE_ENV'] === 'development' ||
      env['MOCK_ONCHAIN_IDENTITY'] === 'true';

    // Configurable mock balance via MOCK_USDC_BALANCE (raw 6-decimal string)
    const mockEnv = env['MOCK_USDC_BALANCE'];
    this.mockBalance = mockEnv ? BigInt(mockEnv) : DEFAULT_MOCK_BALANCE_USDC;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start polling the USDC balance.
   * Performs an immediate fetch, then polls every `pollIntervalMs`.
   */
  async start(): Promise<void> {
    if (this.pollHandle !== null) {
      throw new Error('SurvivalModule is already running. Call stop() first.');
    }

    // Immediate first fetch — establishes initial tier without emitting transition
    const initialBalance = await this.fetchBalance();
    this.currentBalance = initialBalance;
    this.currentTier = evaluateTier(initialBalance);

    // Persist initial snapshot
    this.persistSnapshot(initialBalance, this.currentTier);

    // Start recurring poll
    this.pollHandle = setInterval(() => {
      this.poll().catch((err) => {
        console.error('[SurvivalModule] Poll error:', err);
      });
    }, this.pollIntervalMs);

    // Keep the event loop alive only if intentional
    if (this.pollHandle.unref) {
      this.pollHandle.unref();
    }
  }

  /**
   * Stop polling and remove all listeners.
   */
  async stop(): Promise<void> {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    this.removeAllListeners();
  }

  /** Return the tier currently active. */
  getCurrentTier(): SurvivalTier {
    return this.currentTier;
  }

  /** Return the last known USDC balance (6-decimal bigint). */
  getCurrentBalance(): bigint {
    return this.currentBalance;
  }

  /** Return the balance breakdown (wallet USDC vs Aave aUSDC). */
  getBalanceBreakdown(): { walletUsdc: bigint; aaveUsdc: bigint } {
    return { walletUsdc: this.lastWalletUsdc, aaveUsdc: this.lastAaveUsdc };
  }

  /** Return the capability gates for the currently active tier. */
  getGates(): CapabilityGates {
    return getCapabilityGates(this.currentTier);
  }

  /**
   * Expose the CapabilityGatesDistributor so other modules can subscribe.
   */
  getGatesDistributor(): CapabilityGatesDistributor {
    return this.gatesDistributor;
  }

  /**
   * Whether the module is currently polling.
   */
  isRunning(): boolean {
    return this.pollHandle !== null;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Single poll tick: fetch balance and process any tier change.
   */
  private async poll(): Promise<void> {
    const newBalance = await this.fetchBalance();
    await this.processBalanceUpdate(newBalance);
  }

  /**
   * Process a new balance reading:
   *  1. Persist snapshot if balance changed
   *  2. Emit `tier:emergency` if balance is $0
   *  3. Emit `tier:transition` exactly once if tier changed
   *  4. Notify CapabilityGatesDistributor
   */
  private async processBalanceUpdate(newBalance: bigint): Promise<void> {
    const balanceChanged = newBalance !== this.currentBalance;

    this.currentBalance = newBalance;
    const newTier = evaluateTier(newBalance);

    // Persist snapshot whenever balance changes
    if (balanceChanged) {
      this.persistSnapshot(newBalance, newTier);
    }

    // Always emit balance:updated (useful for external monitoring)
    this.emit('balance:updated', newBalance, newTier);

    // Emit emergency event when balance hits $0 (Requirement 5.7)
    if (newBalance === TIER_THRESHOLDS.EMERGENCY) {
      this.emit('tier:emergency', newBalance);
    }

    // Only emit transition when tier actually changes
    if (newTier === this.currentTier) {
      return;
    }

    const previousTier = this.currentTier;
    this.currentTier = newTier;

    const event: TierTransitionEvent = {
      previousTier,
      newTier,
      balance: newBalance,
      gates: getCapabilityGates(newTier),
      timestamp: Date.now(),
    };

    // Emit transition event — synchronous, within the same tick (< 1 ms << 1 s req)
    this.emit('tier:transition', event);

    // Notify capability-gate subscribers
    this.gatesDistributor.notify(newTier);
  }

  /**
   * Fetch the current USDC balance (wallet + Aave deposits).
   * In mock mode, returns the configured mock balance immediately.
   * In production mode, queries USDC and aUSDC balances on Base via ethers.
   */
  private async fetchBalance(): Promise<bigint> {
    if (this.isMockMode) {
      return this.mockBalance;
    }

    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    const usdcContract = new ethers.Contract(USDC_CONTRACT_BASE, ERC20_ABI, provider);
    const walletUsdc: bigint = await (usdcContract['balanceOf'] as (addr: string) => Promise<bigint>)(
      this.walletAddress,
    );

    // Read Aave aUSDC balance — fallback to 0n on failure to avoid crashing
    let aUsdcBalance = 0n;
    try {
      const aUsdcContract = new ethers.Contract(A_USDC_BASE, ERC20_ABI, provider);
      aUsdcBalance = await (aUsdcContract['balanceOf'] as (addr: string) => Promise<bigint>)(
        this.walletAddress,
      );
    } catch (err) {
      console.warn('[SurvivalModule] Failed to read aUSDC balance, using 0:', err);
    }

    const totalCapital = walletUsdc + aUsdcBalance;

    // Store breakdown for external consumers (heartbeat, status endpoints)
    this.lastWalletUsdc = walletUsdc;
    this.lastAaveUsdc = aUsdcBalance;

    // Log breakdown only when balance changes by ≥$0.01 (reduces log spam)
    if (aUsdcBalance > 0n) {
      const prevTotal = (this as any)._lastLoggedTotal ?? 0n;
      const diff = totalCapital > prevTotal ? totalCapital - prevTotal : prevTotal - totalCapital;
      if (diff >= 10_000n) { // $0.01 threshold
        console.log(
          `[SurvivalModule] Balance: wallet=$${(Number(walletUsdc) / 1_000_000).toFixed(2)} aUSDC=$${(Number(aUsdcBalance) / 1_000_000).toFixed(2)} total=$${(Number(totalCapital) / 1_000_000).toFixed(2)}`,
        );
        (this as any)._lastLoggedTotal = totalCapital;
      }
    }

    return totalCapital;
  }

  /**
   * Persist a balance snapshot to the balance_history table.
   * No-op when no store is injected.
   */
  private persistSnapshot(balance: bigint, tier: SurvivalTier): void {
    if (!this.balanceHistoryStore) return;

    try {
      this.balanceHistoryStore.insert({
        balanceUsdc: balance.toString(),
        tier,
        recordedAt: Date.now(),
      });
    } catch (err) {
      // Non-fatal: log and continue
      console.error('[SurvivalModule] Failed to persist balance snapshot:', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy API shim — keeps the original SurvivalModuleImpl/createSurvivalModule
// interface working for existing consumers and tests.
// ---------------------------------------------------------------------------

/**
 * Public interface of the legacy Survival Module.
 * @deprecated Use {@link SurvivalModule} directly.
 */
export interface LegacySurvivalModule {
  start(initialBalance: bigint): void;
  stop(): void;
  updateBalance(newBalance: bigint): void;
  getCurrentTier(): SurvivalTier;
  getCapabilityGates(): CapabilityGates;
  onTierTransition(cb: (event: TierTransitionEvent) => void): () => void;
}

/**
 * Typed event map for the internal EventEmitter.
 */
interface SurvivalLegacyEvents {
  'tier:transition': [event: TierTransitionEvent];
}

/**
 * Concrete implementation of {@link LegacySurvivalModule}.
 * Kept for backward compatibility with existing tests and consumers.
 *
 * @deprecated Use {@link SurvivalModule} for new code.
 */
export class SurvivalModuleImpl
  extends EventEmitter<SurvivalLegacyEvents>
  implements LegacySurvivalModule
{
  private currentTier: SurvivalTier = SurvivalTier.EMERGENCY;
  private currentBalance: bigint = 0n;
  private running = false;
  private readonly gatesDistributor: CapabilityGatesDistributor;

  constructor(gatesDistributor?: CapabilityGatesDistributor) {
    super();
    this.gatesDistributor = gatesDistributor ?? new CapabilityGatesDistributor();
  }

  start(initialBalance: bigint): void {
    if (this.running) {
      throw new Error('SurvivalModule is already running. Call stop() first.');
    }
    this.currentBalance = initialBalance;
    this.currentTier = evaluateTier(initialBalance);
    this.running = true;
  }

  stop(): void {
    this.removeAllListeners();
    this.running = false;
  }

  updateBalance(newBalance: bigint): void {
    if (!this.running) {
      throw new Error('SurvivalModule is not running. Call start() first.');
    }

    this.currentBalance = newBalance;
    const newTier = evaluateTier(newBalance);

    if (newTier === this.currentTier) return;

    const previousTier = this.currentTier;
    this.currentTier = newTier;

    const event: TierTransitionEvent = {
      previousTier,
      newTier,
      balance: newBalance,
      gates: getCapabilityGates(newTier),
      timestamp: Date.now(),
    };

    this.emit('tier:transition', event);
    this.gatesDistributor.notify(newTier);
  }

  getCurrentTier(): SurvivalTier {
    return this.currentTier;
  }

  getCapabilityGates(): CapabilityGates {
    return getCapabilityGates(this.currentTier);
  }

  onTierTransition(cb: (event: TierTransitionEvent) => void): () => void {
    this.on('tier:transition', cb);
    return () => this.off('tier:transition', cb);
  }

  getGatesDistributor(): CapabilityGatesDistributor {
    return this.gatesDistributor;
  }

  isRunning(): boolean {
    return this.running;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new SurvivalModuleImpl instance (legacy sync API).
 * @deprecated Prefer {@link SurvivalModule} for new code.
 */
export function createSurvivalModule(
  gatesDistributor?: CapabilityGatesDistributor,
): SurvivalModuleImpl {
  return new SurvivalModuleImpl(gatesDistributor);
}

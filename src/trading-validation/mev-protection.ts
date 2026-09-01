/**
 * Trading Validation Phase - MEV Protection and Slippage Monitoring
 *
 * Implements explicit slippage bounds and MEV mitigation for the trade execution path:
 * - Always set minAmountOut = quote - configured slippage (40 bps with private RPC, 30 bps without)
 * - Reject if price impact > threshold (30 bps with private RPC, 20 bps without)
 * - Use private RPC if configured
 * - Log quoted vs executed for every trade
 * - 3 consecutive trades with slippage > 1.5x estimated → Safe_Mode + alert
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, E12
 */

import type { ExecutableQuote, WethAmount, UsdcAmount } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

export interface MevProtectionConfig {
  /** Whether a private/MEV-protected RPC is configured */
  hasPrivateRpc: boolean;
  /** Max slippage in bps: 40 with private RPC, 30 without */
  maxSlippageBps: number;
  /** Max price impact in bps: 30 with private RPC, 20 without */
  maxPriceImpactBps: number;
  /** Private RPC URL (used for submitting transactions if available) */
  privateRpcUrl?: string;
  /** Multiplier threshold for consecutive slippage deviation (default 1.5) */
  slippageDeviationMultiplier: number;
  /** Number of consecutive trades exceeding slippage threshold before Safe_Mode (default 3) */
  consecutiveSlippageThreshold: number;
}

/** Slippage log entry for a single trade */
export interface SlippageLogEntry {
  tradeId: string;
  timestamp: number;
  quotedAmountOut: bigint;
  executedAmountOut: bigint;
  estimatedSlippageBps: number;
  realizedSlippageBps: number;
  priceImpactBps: number;
  exceedsThreshold: boolean;
}

/** Result of MEV protection validation */
export interface MevValidationResult {
  approved: boolean;
  reason?: string;
  minAmountOut: bigint;
  maxSlippageBps: number;
  maxPriceImpactBps: number;
  usePrivateRpc: boolean;
}

/** Callback for Safe_Mode trigger */
export interface ISafeModeCallback {
  trigger(reason: 'deviation_alerts', details: string): void;
}

/** Callback for alert notifications */
export interface IAlertCallback {
  sendAlert(message: string): void | Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// Default Configuration Factory
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates default MEV protection config based on whether a private RPC is available.
 * Per E12: stricter limits without private RPC.
 */
export function createDefaultMevConfig(hasPrivateRpc: boolean, privateRpcUrl?: string): MevProtectionConfig {
  return {
    hasPrivateRpc,
    maxSlippageBps: hasPrivateRpc ? 40 : 30,
    maxPriceImpactBps: hasPrivateRpc ? 30 : 20,
    privateRpcUrl: privateRpcUrl ?? undefined,
    slippageDeviationMultiplier: 1.5,
    consecutiveSlippageThreshold: 3,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MEV Protection Engine
// ═══════════════════════════════════════════════════════════════════════════

export class MevProtectionEngine {
  private readonly config: MevProtectionConfig;
  private readonly safeModeCallback: ISafeModeCallback | null;
  private readonly alertCallback: IAlertCallback | null;

  /** Rolling log of recent slippage entries for consecutive deviation detection */
  private slippageHistory: SlippageLogEntry[] = [];

  /** Count of consecutive trades where realized slippage > 1.5x estimated */
  private consecutiveExcessiveSlippage = 0;

  constructor(
    config: MevProtectionConfig,
    safeModeCallback?: ISafeModeCallback | null,
    alertCallback?: IAlertCallback | null,
  ) {
    this.config = config;
    this.safeModeCallback = safeModeCallback ?? null;
    this.alertCallback = alertCallback ?? null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pre-trade validation (Req 22.1, 22.2, 22.3, E12)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Validates a trade quote for MEV protection and computes minAmountOut.
   *
   * - Sets minAmountOut = quote.amountOut - maxSlippageBps
   * - Rejects if price impact exceeds threshold
   * - Returns whether to use private RPC
   *
   * @param quote The executable quote from QuoterV2 or aggregator
   * @returns Validation result with computed minAmountOut
   */
  validateQuote(quote: ExecutableQuote): MevValidationResult {
    const { maxSlippageBps, maxPriceImpactBps, hasPrivateRpc } = this.config;

    // Reject if price impact exceeds threshold (Req 22.2)
    if (quote.priceImpactBps > maxPriceImpactBps) {
      return {
        approved: false,
        reason: `Price impact ${quote.priceImpactBps} bps exceeds max ${maxPriceImpactBps} bps` +
          (hasPrivateRpc ? '' : ' (stricter limit without private RPC)'),
        minAmountOut: 0n,
        maxSlippageBps,
        maxPriceImpactBps,
        usePrivateRpc: hasPrivateRpc,
      };
    }

    // Compute minAmountOut = quote - maxSlippageBps (Req 22.1)
    const minAmountOut = this.computeMinAmountOut(quote.amountOut, maxSlippageBps);

    // Ensure minAmountOut is positive
    if (minAmountOut <= 0n) {
      return {
        approved: false,
        reason: 'Computed minAmountOut is zero or negative after slippage deduction',
        minAmountOut: 0n,
        maxSlippageBps,
        maxPriceImpactBps,
        usePrivateRpc: hasPrivateRpc,
      };
    }

    return {
      approved: true,
      minAmountOut,
      maxSlippageBps,
      maxPriceImpactBps,
      usePrivateRpc: hasPrivateRpc,
    };
  }

  /**
   * Computes minAmountOut by deducting slippage tolerance from quoted amount.
   * minAmountOut = amountOut * (10000 - slippageBps) / 10000
   *
   * Uses BigInt arithmetic to preserve precision.
   */
  computeMinAmountOut(quotedAmountOut: bigint, slippageBps: number): bigint {
    if (quotedAmountOut <= 0n) return 0n;
    const bps = BigInt(slippageBps);
    // minAmountOut = quotedAmountOut * (10000 - slippageBps) / 10000
    return (quotedAmountOut * (10000n - bps)) / 10000n;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Post-trade slippage logging (Req 22.4, 22.5)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Logs the quoted vs executed amounts for a completed trade and checks
   * for consecutive excessive slippage.
   *
   * Realized slippage = (quotedOut - executedOut) / quotedOut * 10000 (in bps)
   * If realized slippage > 1.5x estimated on 3 consecutive trades → Safe_Mode + alert
   *
   * @param tradeId Unique trade identifier
   * @param quotedAmountOut Amount expected from quote
   * @param executedAmountOut Amount actually received on-chain
   * @param estimatedSlippageBps The slippage tolerance that was set (maxSlippageBps)
   * @param priceImpactBps The price impact at time of execution
   * @returns The slippage log entry
   */
  logTradeSlippage(
    tradeId: string,
    quotedAmountOut: bigint,
    executedAmountOut: bigint,
    estimatedSlippageBps: number,
    priceImpactBps: number,
  ): SlippageLogEntry {
    // Calculate realized slippage in bps
    const realizedSlippageBps = this.calculateRealizedSlippageBps(quotedAmountOut, executedAmountOut);

    // Determine if this exceeds the deviation threshold
    const exceedsThreshold = realizedSlippageBps > estimatedSlippageBps * this.config.slippageDeviationMultiplier;

    const entry: SlippageLogEntry = {
      tradeId,
      timestamp: Date.now(),
      quotedAmountOut,
      executedAmountOut,
      estimatedSlippageBps,
      realizedSlippageBps,
      priceImpactBps,
      exceedsThreshold,
    };

    // Add to history
    this.slippageHistory.push(entry);

    // Keep only recent entries (last 100 for memory efficiency)
    if (this.slippageHistory.length > 100) {
      this.slippageHistory = this.slippageHistory.slice(-100);
    }

    // Update consecutive counter (Req 22.5)
    if (exceedsThreshold) {
      this.consecutiveExcessiveSlippage++;
    } else {
      this.consecutiveExcessiveSlippage = 0;
    }

    // Log quoted vs executed (Req 22.4)
    console.log(
      `[MEV-PROTECTION] Trade ${tradeId}: ` +
      `quoted=${quotedAmountOut.toString()}, executed=${executedAmountOut.toString()}, ` +
      `realizedSlippage=${realizedSlippageBps.toFixed(2)}bps, ` +
      `estimated=${estimatedSlippageBps}bps, ` +
      `ratio=${(realizedSlippageBps / estimatedSlippageBps).toFixed(2)}x, ` +
      `consecutive=${this.consecutiveExcessiveSlippage}`,
    );

    // Check if we need to trigger Safe_Mode (Req 22.5)
    if (this.consecutiveExcessiveSlippage >= this.config.consecutiveSlippageThreshold) {
      this.triggerSlippageSafeMode();
    }

    return entry;
  }

  /**
   * Calculate realized slippage in basis points.
   * If executed >= quoted, slippage is 0 (favorable execution).
   */
  calculateRealizedSlippageBps(quotedAmountOut: bigint, executedAmountOut: bigint): number {
    if (quotedAmountOut <= 0n) return 0;
    if (executedAmountOut >= quotedAmountOut) return 0; // No slippage or favorable

    // slippage = (quoted - executed) / quoted * 10000
    const diff = quotedAmountOut - executedAmountOut;
    // Use fixed-point: multiply diff by 10000 first, then divide by quoted
    const slippageBps = Number((diff * 10000n) / quotedAmountOut);
    return slippageBps;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Safe_Mode trigger on consecutive slippage (Req 22.5)
  // ─────────────────────────────────────────────────────────────────────────

  private triggerSlippageSafeMode(): void {
    const details =
      `${this.consecutiveExcessiveSlippage} consecutive trades with realized slippage > ` +
      `${this.config.slippageDeviationMultiplier}x estimated. ` +
      `Recent trades: ${this.getRecentSlippageSummary()}`;

    console.error(`[MEV-PROTECTION] ALERT: Triggering Safe_Mode due to excessive slippage. ${details}`);

    // Trigger Safe_Mode (Req 22.5)
    if (this.safeModeCallback) {
      this.safeModeCallback.trigger('deviation_alerts', details);
    }

    // Send alert
    if (this.alertCallback) {
      void this.alertCallback.sendAlert(
        `⚠️ MEV/Slippage Alert: ${this.consecutiveExcessiveSlippage} consecutive trades ` +
        `exceeded ${this.config.slippageDeviationMultiplier}x estimated slippage. ` +
        `Entering Safe_Mode. ${details}`,
      );
    }

    // Reset counter after triggering (Safe_Mode will block new trades)
    this.consecutiveExcessiveSlippage = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // RPC routing (Req 22.3)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the RPC URL to use for submitting transactions.
   * Uses private RPC if configured (MEV protection), otherwise returns null
   * to indicate usage of default public RPC.
   */
  getSubmissionRpcUrl(): string | null {
    if (this.config.hasPrivateRpc && this.config.privateRpcUrl) {
      return this.config.privateRpcUrl;
    }
    return null;
  }

  /**
   * Whether transactions should be submitted via private/MEV-protected RPC.
   */
  shouldUsePrivateRpc(): boolean {
    return this.config.hasPrivateRpc && !!this.config.privateRpcUrl;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Accessors
  // ─────────────────────────────────────────────────────────────────────────

  /** Get current consecutive excessive slippage count */
  getConsecutiveExcessiveSlippage(): number {
    return this.consecutiveExcessiveSlippage;
  }

  /** Get the full slippage history */
  getSlippageHistory(): readonly SlippageLogEntry[] {
    return this.slippageHistory;
  }

  /** Get current configuration */
  getConfig(): Readonly<MevProtectionConfig> {
    return this.config;
  }

  /** Get effective slippage limits based on RPC availability */
  getEffectiveLimits(): { maxSlippageBps: number; maxPriceImpactBps: number } {
    return {
      maxSlippageBps: this.config.maxSlippageBps,
      maxPriceImpactBps: this.config.maxPriceImpactBps,
    };
  }

  /** Reset the consecutive slippage counter (e.g., after operator acknowledgment) */
  resetConsecutiveCounter(): void {
    this.consecutiveExcessiveSlippage = 0;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private getRecentSlippageSummary(): string {
    const recent = this.slippageHistory.slice(-this.config.consecutiveSlippageThreshold);
    return recent
      .map(
        (e) =>
          `[${e.tradeId}: realized=${e.realizedSlippageBps.toFixed(1)}bps, ` +
          `est=${e.estimatedSlippageBps}bps, ratio=${(e.realizedSlippageBps / e.estimatedSlippageBps).toFixed(2)}x]`,
      )
      .join(', ');
  }
}

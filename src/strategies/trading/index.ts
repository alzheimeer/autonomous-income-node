/**
 * Trading Strategy Module — barrel export
 *
 * Integrates with the SurvivalModule CapabilityGatesDistributor so that
 * trading is automatically gated when the agent's tier changes.
 *
 * Requirements: 6.1 – 6.8
 */

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export {
  RiskManagerImpl,
  createRiskManager,
  type ValidationResult,
  type RiskManager,
} from './risk-manager.js';

export {
  TradingKillSwitch,
  DEFAULT_KILL_SWITCH_CONFIG,
  type KillSwitchConfig,
  type KillSwitchStatus,
  type KillSwitchState,
} from './kill-switch.js';

export {
  scanOpportunities,
  type TradeOpportunity,
  type TradeNetwork,
  type TokenAddress,
  type TradeSource,
} from './opportunity-scanner.js';

export {
  TradeExecutor,
  createTradeExecutor,
  type TradeExecutorOptions,
} from './trade-executor.js';

// ---------------------------------------------------------------------------
// TradingModule — thin wrapper with capability-gate awareness
// ---------------------------------------------------------------------------

import type { CapabilityGatesDistributor } from '../../survival/capability-gates.js';
import type { CapabilityGates } from '../../survival/tier-evaluator.js';
import { SurvivalTier } from '../../survival/tier-evaluator.js';
import { TradeExecutor } from './trade-executor.js';
import type { TradeExecutorOptions } from './trade-executor.js';
import type { TradeRecord } from '../../state/repositories/trades.repo.js';

// Re-export TradeRecord for consumers of this module
export type { TradeRecord };

export interface TradingModuleOptions extends TradeExecutorOptions {
  /**
   * Subscribe to capability gate changes from the SurvivalModule.
   */
  gatesDistributor?: CapabilityGatesDistributor;
  /**
   * Initial tier (used before the first gate update arrives).
   */
  initialTier?: SurvivalTier;
  // signer and rpcUrl are inherited from TradeExecutorOptions
}

/**
 * TradingModule wraps TradeExecutor and respects capability gates emitted
 * by the SurvivalModule. If trading is disabled for the current tier,
 * `executeBestOpportunity` returns `null` immediately.
 */
export class TradingModule {
  private readonly executor: TradeExecutor;
  private tradingEnabled: boolean;
  private currentTier: SurvivalTier;
  private unsubscribe: (() => void) | null = null;

  constructor(options: TradingModuleOptions = {}) {
    this.executor = new TradeExecutor(options);
    this.currentTier = options.initialTier ?? SurvivalTier.TIER_1;
    // Start optimistic — let the first gate update correct this
    this.tradingEnabled = true;

    if (options.gatesDistributor) {
      this.unsubscribe = options.gatesDistributor.subscribe(
        (tier: SurvivalTier, gates: CapabilityGates) => {
          this.currentTier = tier;
          this.tradingEnabled = gates.tradingEnabled;
        }
      );
    }
  }

  /**
   * Execute the best available trade opportunity for the current tier.
   * Returns `null` if trading is disabled or no opportunity passes risk checks.
   */
  async executeBestOpportunity(
    walletAddress: string,
    balance: bigint
  ): Promise<TradeRecord | null> {
    if (!this.tradingEnabled) {
      console.info(
        `[TradingModule] Trading disabled for current tier (${SurvivalTier[this.currentTier]}). Skipping.`
      );
      return null;
    }

    return this.executor.executeBestOpportunity(walletAddress, balance, this.currentTier);
  }

  /** Whether trading is currently enabled for the active tier. */
  isTradingEnabled(): boolean {
    return this.tradingEnabled;
  }

  /** Current operational tier as tracked by the gates distributor. */
  getCurrentTier(): SurvivalTier {
    return this.currentTier;
  }

  /** Detach from the capability gates distributor. */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
}

/**
 * Create a production-ready TradingModule.
 */
export function createTradingModule(options?: TradingModuleOptions): TradingModule {
  return new TradingModule(options);
}

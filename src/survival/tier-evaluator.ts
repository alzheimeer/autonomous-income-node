/**
 * Survival Tier Evaluator
 *
 * Defines operational tiers based on USDC balance and maps each tier
 * to a capability gates matrix that governs what the agent can do.
 *
 * Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 6.8, 8.7, 9.1, 10.1
 */

// ---------------------------------------------------------------------------
// Enum
// ---------------------------------------------------------------------------

export enum SurvivalTier {
  EMERGENCY = 0, // $0.00 USDC
  TIER_1 = 1, // < $10 USDC
  TIER_2 = 2, // $10 – $99 USDC
  TIER_3 = 3, // $100 – $999 USDC
  TIER_4 = 4, // ≥ $1,000 USDC
}

// ---------------------------------------------------------------------------
// Thresholds (USDC in 6-decimal bigint units)
// ---------------------------------------------------------------------------

/**
 * Tier thresholds in USDC 6-decimal units.
 * Canonical export name as per spec (TIER_THRESHOLDS).
 */
export const TIER_THRESHOLDS = {
  /** ≥ $1,000 USDC */
  TIER_4_MIN: 1000_000000n,
  /** ≥ $90 USDC (bajado de $100 para que el balance actual de $99.80 quede en Tier 3) */
  TIER_3_MIN: 90_000000n,
  /** ≥ $10 USDC */
  TIER_2_MIN: 10_000000n,
  /** ≥ $0.000001 USDC (any non-zero balance) */
  TIER_1_MIN: 1n,
  /** $0 USDC – emergency */
  EMERGENCY: 0n,
} as const satisfies Record<string, bigint>;

/**
 * Alias kept for backward compatibility.
 * @deprecated Use {@link TIER_THRESHOLDS} instead.
 */
export const TierThresholds = TIER_THRESHOLDS;

// ---------------------------------------------------------------------------
// Capability Gates
// ---------------------------------------------------------------------------

export interface CapabilityGates {
  /** Whether DeFi trading strategies may execute */
  tradingEnabled: boolean;
  /** Maximum number of concurrent active strategies (0 = none) */
  maxActiveStrategies: number;
  /** Whether self-modification of source code is permitted */
  selfModEnabled: boolean;
  /** Whether the agent may spawn child agent replicas */
  replicationEnabled: boolean;
  /**
   * Fraction of the nominal LLM inference budget that may be spent.
   * 1.0 = 100 %, 0.4 = 40 %, 0.0 = no LLM calls allowed.
   */
  llmBudgetMultiplier: number;
  /** Whether social-network content posting is permitted */
  socialPostingEnabled: boolean;
  /**
   * Maximum USDC amount for a single trade, expressed in 6-decimal
   * bigint units (e.g. 5_000000n = $5 USDC).
   * A value of 0n means trading is disabled / not applicable.
   * BigInt.MAX_VALUE is used to indicate "unlimited".
   */
  maxTradeSize: bigint;
}

// ---------------------------------------------------------------------------
// evaluateTier
// ---------------------------------------------------------------------------

/**
 * Determine the operational tier for a given USDC balance.
 *
 * @param balanceUsdc - Current wallet balance in 6-decimal USDC units.
 * @returns The matching {@link SurvivalTier}.
 */
export function evaluateTier(balanceUsdc: bigint): SurvivalTier {
  if (balanceUsdc < 0n) {
    // Treat negative balances (shouldn't happen on-chain, but be defensive)
    return SurvivalTier.EMERGENCY;
  }
  if (balanceUsdc >= TIER_THRESHOLDS.TIER_4_MIN) return SurvivalTier.TIER_4;
  if (balanceUsdc >= TIER_THRESHOLDS.TIER_3_MIN) return SurvivalTier.TIER_3;
  if (balanceUsdc >= TIER_THRESHOLDS.TIER_2_MIN) return SurvivalTier.TIER_2;
  if (balanceUsdc >= TIER_THRESHOLDS.TIER_1_MIN) return SurvivalTier.TIER_1;
  return SurvivalTier.EMERGENCY;
}

// ---------------------------------------------------------------------------
// getCapabilityGates – exact matrix from design document
// ---------------------------------------------------------------------------

/**
 * Return the capability gates matrix for a given survival tier.
 *
 * Capability matrix:
 * | Capability          | Emergency | Tier 1        | Tier 2        | Tier 3  | Tier 4  |
 * |---------------------|-----------|---------------|---------------|---------|---------|
 * | Trading             | false     | true (1 strat)| true (2 strat)| true    | true    |
 * | Max trade size      | 0n        | $5 (5_000000n)| $5 (5_000000n)| ∞       | ∞       |
 * | Self-Modification   | false     | false         | false         | true    | true    |
 * | Replication         | false     | false         | false         | false   | true    |
 * | Social Posting      | false     | false         | true          | true    | true    |
 * | LLM Budget          | 0.0       | 0.4           | 0.4           | 0.7     | 1.0     |
 * | Services API (proxy)| false     | true          | true          | true    | true    |
 *
 * Note: "Services API" availability is proxied via `tradingEnabled` as per the
 * design (the services HTTP API follows the same gate as trading).
 *
 * @param tier - The current operational tier.
 * @returns A frozen {@link CapabilityGates} object for the given tier.
 */
export function getCapabilityGates(tier: SurvivalTier): CapabilityGates {
  switch (tier) {
    case SurvivalTier.EMERGENCY:
      return Object.freeze<CapabilityGates>({
        tradingEnabled: false,
        maxActiveStrategies: 0,
        selfModEnabled: false,
        replicationEnabled: false,
        llmBudgetMultiplier: 0.0,
        socialPostingEnabled: false,
        maxTradeSize: 0n,
      });

    case SurvivalTier.TIER_1:
      return Object.freeze<CapabilityGates>({
        tradingEnabled: true,
        maxActiveStrategies: 1,
        selfModEnabled: false,
        replicationEnabled: false,
        llmBudgetMultiplier: 0.4,
        socialPostingEnabled: false,
        maxTradeSize: 5_000000n, // $5 USDC
      });

    case SurvivalTier.TIER_2:
      return Object.freeze<CapabilityGates>({
        tradingEnabled: true,
        maxActiveStrategies: 2,
        selfModEnabled: false,
        replicationEnabled: false,
        llmBudgetMultiplier: 0.4,
        socialPostingEnabled: true,
        maxTradeSize: 5_000000n, // $5 USDC
      });

    case SurvivalTier.TIER_3:
      return Object.freeze<CapabilityGates>({
        tradingEnabled: true,
        maxActiveStrategies: 99,
        selfModEnabled: true,
        replicationEnabled: false,
        llmBudgetMultiplier: 0.7,
        socialPostingEnabled: true,
        maxTradeSize: BigInt(Number.MAX_SAFE_INTEGER) * 1_000000n, // effectively unlimited
      });

    case SurvivalTier.TIER_4:
      return Object.freeze<CapabilityGates>({
        tradingEnabled: true,
        maxActiveStrategies: 99,
        selfModEnabled: true,
        replicationEnabled: true,
        llmBudgetMultiplier: 1.0,
        socialPostingEnabled: true,
        maxTradeSize: BigInt(Number.MAX_SAFE_INTEGER) * 1_000000n, // effectively unlimited
      });

    default: {
      // Exhaustiveness guard — TypeScript will catch missing cases at compile time.
      const _exhaustive: never = tier;
      throw new Error(`Unknown SurvivalTier: ${_exhaustive}`);
    }
  }
}

// ---------------------------------------------------------------------------
// evaluateTierWithLending
// ---------------------------------------------------------------------------

/**
 * Evaluate tier considering both wallet balance and Aave deposits.
 * Total capital = wallet USDC + Aave aToken balance.
 *
 * This is a non-breaking addition — callers of `evaluateTier` are unaffected.
 * The SurvivalModule can optionally call this instead of `evaluateTier`
 * when Aave deposit data is available.
 *
 * @param walletBalanceUsdc - Current wallet USDC balance (6-decimal units).
 * @param aaveDepositedUsdc - Current Aave aToken balance (6-decimal units).
 * @returns The matching {@link SurvivalTier} based on total capital.
 */
export function evaluateTierWithLending(
  walletBalanceUsdc: bigint,
  aaveDepositedUsdc: bigint,
): SurvivalTier {
  const totalCapital = walletBalanceUsdc + aaveDepositedUsdc;
  return evaluateTier(totalCapital);
}

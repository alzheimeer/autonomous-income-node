/**
 * AutoLender — Deterministic pre-cycle hook for Aave deposit/withdraw
 *
 * Automatically manages USDC deposits into Aave V3 based on wallet balance
 * thresholds. Executes BEFORE the ReActLoop each cycle, without needing
 * LLM inference.
 *
 * Revenue Optimization Engine — Task 2
 */

import type { IAaveLendingModule } from './aave-lending.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface AutoLenderConfig {
  /** Minimum balance to trigger deposit (6 decimals). Default: 20_000000n ($20) */
  depositThreshold: bigint;
  /** Amount to keep liquid for gas/operations (6 decimals). Default: 15_000000n ($15) */
  operatingReserve: bigint;
  /** Balance below which emergency withdraw triggers (6 decimals). Default: 10_000000n ($10) */
  emergencyWithdrawBelow: bigint;
  /** Minimum APY to maintain position (basis points). Default: 200 (2%) */
  minApyBps: number;
}

export const DEFAULT_AUTO_LENDER_CONFIG: AutoLenderConfig = {
  depositThreshold: 20_000000n,
  operatingReserve: 15_000000n,
  emergencyWithdrawBelow: 10_000000n,
  minApyBps: 200,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Result type
// ═══════════════════════════════════════════════════════════════════════════════

export interface AutoLenderResult {
  action: 'deposit' | 'withdraw' | 'none';
  amount: bigint;
  txHash?: string;
  reason: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class AutoLender {
  constructor(
    private readonly aaveModule: IAaveLendingModule,
    private readonly config: AutoLenderConfig = DEFAULT_AUTO_LENDER_CONFIG,
  ) {}

  /**
   * Evaluates the current wallet balance and executes deposit/withdraw if needed.
   * Called as a pre-cycle hook BEFORE the ReActLoop each cycle.
   *
   * Decision logic:
   * 1. If walletBalance > depositThreshold + operatingReserve → deposit excess
   * 2. If walletBalance < emergencyWithdrawBelow AND has Aave position → withdraw
   * 3. If APY < minApyBps → withdraw all
   * 4. Else → no action
   */
  async evaluate(walletBalance: bigint): Promise<AutoLenderResult> {
    try {
      // Check APY first — if below minimum, withdraw everything
      const { apy, belowMinimum } = await this.aaveModule.checkApyThreshold();
      const position = await this.aaveModule.getPosition();
      const hasPosition = position.depositedUsdc > 0n;

      // Case 1: APY below minimum and we have a position → withdraw all
      if (belowMinimum && hasPosition) {
        const withdrawAmount = position.currentATokenBalance;
        const result = await this.aaveModule.withdraw(withdrawAmount);
        return {
          action: 'withdraw',
          amount: withdrawAmount,
          txHash: result.txHash,
          reason: `APY ${apy} bps below minimum ${this.config.minApyBps} bps — withdrawing all`,
        };
      }

      // Case 2: Emergency — balance critically low, need to withdraw from Aave
      if (walletBalance < this.config.emergencyWithdrawBelow && hasPosition) {
        const needed = this.config.operatingReserve - walletBalance;
        const withdrawAmount = needed > position.currentATokenBalance
          ? position.currentATokenBalance
          : needed;

        if (withdrawAmount > 0n) {
          const result = await this.aaveModule.withdraw(withdrawAmount);
          return {
            action: 'withdraw',
            amount: withdrawAmount,
            txHash: result.txHash,
            reason: `Emergency: balance ${walletBalance} below ${this.config.emergencyWithdrawBelow} — withdrawing ${withdrawAmount} to restore reserve`,
          };
        }
      }

      // Case 3: Excess balance — deposit into Aave
      const depositTrigger = this.config.depositThreshold + this.config.operatingReserve;
      if (walletBalance > depositTrigger) {
        const depositAmount = walletBalance - this.config.operatingReserve;
        const result = await this.aaveModule.supply(depositAmount);
        return {
          action: 'deposit',
          amount: depositAmount,
          txHash: result.txHash,
          reason: `Balance ${walletBalance} exceeds threshold — depositing ${depositAmount} at ${apy} bps APY`,
        };
      }

      // Case 4: No action needed
      return {
        action: 'none',
        amount: 0n,
        reason: `No action needed — balance: ${walletBalance}, APY: ${apy} bps, position: ${position.depositedUsdc}`,
      };
    } catch (error) {
      // AutoLender should never crash the agent cycle
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[AutoLender] Error during evaluate: ${msg}`);
      return {
        action: 'none',
        amount: 0n,
        reason: `Error: ${msg}`,
      };
    }
  }
}

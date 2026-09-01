/**
 * Aave V3 USDC Lending Module — Base Mainnet
 *
 * Deposits idle USDC into Aave V3 to earn passive yield (4-9% APY).
 * Monitors APY thresholds and automatically withdraws if returns
 * drop below configured minimum.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
 */

import { randomUUID } from 'node:crypto';
import { Contract, JsonRpcProvider, Wallet } from 'ethers';
import {
  AAVE_V3_POOL_ABI,
  ERC20_ABI,
  AAVE_V3_POOL_ADDRESS,
  A_USDC_ADDRESS,
  USDC_BASE,
} from '../../contracts/abis.js';
import type { AaveLendingConfig } from '../../config/income-sustainability.config.js';
import type { AavePositionsRepository } from '../../state/repositories/aave-positions.repo.js';
import type { IStrategyTracker } from '../../intelligence/strategy-tracker.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types & Interface
// ═══════════════════════════════════════════════════════════════════════════════

export interface AavePosition {
  depositedUsdc: bigint;
  currentATokenBalance: bigint;
  accruedInterest: bigint;
  currentApyBps: number;
  lastUpdated: number;
}

export interface IAaveLendingModule {
  supply(amount: bigint): Promise<{ txHash: string; deposited: bigint }>;
  withdraw(amount: bigint): Promise<{ txHash: string; withdrawn: bigint }>;
  getPosition(): Promise<AavePosition>;
  checkApyThreshold(): Promise<{ apy: number; belowMinimum: boolean }>;
  monitor(walletBalance: bigint): Promise<{
    action: 'supply' | 'withdraw' | 'none';
    amount: bigint;
    reason: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Aave V3 rates are in RAY (1e27) */
const RAY = 10n ** 27n;

/** Retry delay after a revert (ms) */
const RETRY_DELAY_MS = 60_000;

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class AaveLendingModule implements IAaveLendingModule {
  private readonly pool: Contract;
  private readonly usdc: Contract;
  private readonly aToken: Contract;
  private readonly walletAddress: string;
  private cachedApyBps: number = 0;

  constructor(
    private readonly config: AaveLendingConfig,
    private readonly signer: Wallet,
    private readonly repo: AavePositionsRepository,
    private readonly strategyTracker?: IStrategyTracker,
  ) {
    const provider = signer.provider ?? new JsonRpcProvider(config.rpcUrl);

    this.pool = new Contract(
      config.poolAddress || AAVE_V3_POOL_ADDRESS,
      AAVE_V3_POOL_ABI,
      signer,
    );

    this.usdc = new Contract(
      config.usdcAddress || USDC_BASE,
      ERC20_ABI,
      signer,
    );

    this.aToken = new Contract(
      config.aTokenAddress || A_USDC_ADDRESS,
      ERC20_ABI,
      provider,
    );

    this.walletAddress = signer.address;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // supply — Deposit USDC into Aave V3
  // ─────────────────────────────────────────────────────────────────────────

  async supply(amount: bigint): Promise<{ txHash: string; deposited: bigint }> {
    try {
      return await this._executeSupply(amount);
    } catch (error) {
      console.error('[AaveLending] Supply failed, retrying in 60s:', error);
      await this._delay(RETRY_DELAY_MS);

      try {
        return await this._executeSupply(amount);
      } catch (retryError) {
        console.error('[AaveLending] Supply retry failed:', retryError);
        throw retryError;
      }
    }
  }

  private async _executeSupply(amount: bigint): Promise<{ txHash: string; deposited: bigint }> {
    // Step 1: Approve USDC spend to Aave Pool
    const poolAddress = await this.pool.getAddress();
    const approveTx = await this.usdc.approve(poolAddress, amount);
    await approveTx.wait();

    // Step 2: Supply USDC to Aave V3 Pool
    const usdcAddress = await this.usdc.getAddress();
    const supplyTx = await this.pool.supply(
      usdcAddress,
      amount,
      this.walletAddress,
      0, // referralCode
    );
    const receipt = await supplyTx.wait();
    const txHash: string = receipt.hash;

    // Step 3: Get current APY for record-keeping
    const { apy } = await this.checkApyThreshold();

    // Step 4: Persist position in database
    const positionId = randomUUID();
    this.repo.insert({
      id: positionId,
      asset: usdcAddress,
      amount_deposited: amount.toString(),
      a_token_balance: amount.toString(),
      tx_hash_supply: txHash,
      status: 'active',
      apy_at_deposit: apy,
      deposited_at: Date.now(),
    });

    // Step 5: Record revenue in strategy tracker (interest will accrue)
    this.strategyTracker?.recordExecution('aave_lending', true);

    return { txHash, deposited: amount };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // withdraw — Remove USDC from Aave V3
  // ─────────────────────────────────────────────────────────────────────────

  async withdraw(amount: bigint): Promise<{ txHash: string; withdrawn: bigint }> {
    try {
      return await this._executeWithdraw(amount);
    } catch (error) {
      console.error('[AaveLending] Withdraw failed, retrying in 60s:', error);
      await this._delay(RETRY_DELAY_MS);

      try {
        return await this._executeWithdraw(amount);
      } catch (retryError) {
        console.error('[AaveLending] Withdraw retry failed:', retryError);
        throw retryError;
      }
    }
  }

  private async _executeWithdraw(amount: bigint): Promise<{ txHash: string; withdrawn: bigint }> {
    const usdcAddress = await this.usdc.getAddress();

    // Withdraw USDC from Aave V3 Pool
    const withdrawTx = await this.pool.withdraw(
      usdcAddress,
      amount,
      this.walletAddress,
    );
    const receipt = await withdrawTx.wait();
    const txHash: string = receipt.hash;

    // Calculate interest earned before closing positions
    const position = await this.getPosition();
    const interestEarned = position.accruedInterest > 0n ? position.accruedInterest : 0n;

    // Record interest as revenue
    if (interestEarned > 0n) {
      this.strategyTracker?.recordRevenue('aave_lending', interestEarned, txHash);
    }

    // Update active positions in DB
    const activePositions = this.repo.getActive();
    let remaining = amount;

    for (const pos of activePositions) {
      if (remaining <= 0n) break;

      const posDeposited = BigInt(pos.amount_deposited);
      const withdrawFromPos = remaining >= posDeposited ? posDeposited : remaining;
      remaining -= withdrawFromPos;

      if (withdrawFromPos >= posDeposited) {
        // Fully withdrawn
        this.repo.updateStatus(pos.id, 'withdrawn', {
          tx_hash_withdraw: txHash,
          withdrawn_at: Date.now(),
          withdraw_reason: 'user_or_monitor_withdrawal',
          a_token_balance: '0',
        });
      } else {
        // Partially withdrawn — update balance
        const newBalance = posDeposited - withdrawFromPos;
        this.repo.updateStatus(pos.id, 'active', {
          a_token_balance: newBalance.toString(),
        });
      }
    }

    this.strategyTracker?.recordExecution('aave_lending', true);

    return { txHash, withdrawn: amount };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getPosition — Read current Aave position state
  // ─────────────────────────────────────────────────────────────────────────

  async getPosition(): Promise<AavePosition> {
    // Read aToken balance (includes accrued interest)
    const aTokenBalance: bigint = await this.aToken.balanceOf(this.walletAddress);

    // Sum of all active deposits from DB
    const totalDepositedStr = this.repo.getTotalDeposited();
    const totalDeposited = BigInt(totalDepositedStr.split('.')[0] || '0');

    // Accrued interest = aToken balance - total deposited principal
    const accruedInterest = aTokenBalance > totalDeposited
      ? aTokenBalance - totalDeposited
      : 0n;

    // Current APY
    const { apy } = await this.checkApyThreshold();

    return {
      depositedUsdc: totalDeposited,
      currentATokenBalance: aTokenBalance,
      accruedInterest,
      currentApyBps: apy,
      lastUpdated: Date.now(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // checkApyThreshold — Query on-chain APY and compare to config minimum
  // ─────────────────────────────────────────────────────────────────────────

  async checkApyThreshold(): Promise<{ apy: number; belowMinimum: boolean }> {
    try {
      const usdcAddress = this.config.usdcAddress || USDC_BASE;
      const reserveData = await this.pool.getReserveData(usdcAddress);

      // currentLiquidityRate is at index 2 in the returned tuple
      const currentLiquidityRate: bigint = BigInt(reserveData[2]);

      // Convert RAY rate to APY percentage: rate / 1e27 * 100
      // Using bigint math to avoid precision loss then convert at the end
      const apyPercent = Number(currentLiquidityRate) / 1e27 * 100;

      // Convert to basis points (1 bps = 0.01%)
      const apyBps = Math.round(apyPercent * 100);

      // Cache the result for fallback
      this.cachedApyBps = apyBps;

      return {
        apy: apyBps,
        belowMinimum: apyBps < this.config.minApyBps,
      };
    } catch (error) {
      console.error('[AaveLending] getReserveData failed, using cached APY:', error);

      // Return last cached APY on failure
      return {
        apy: this.cachedApyBps,
        belowMinimum: this.cachedApyBps < this.config.minApyBps,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // monitor — Decide whether to supply, withdraw, or hold
  // ─────────────────────────────────────────────────────────────────────────

  async monitor(walletBalance: bigint): Promise<{
    action: 'supply' | 'withdraw' | 'none';
    amount: bigint;
    reason: string;
  }> {
    const { apy, belowMinimum } = await this.checkApyThreshold();
    const activePositions = this.repo.getActive();
    const hasActivePosition = activePositions.length > 0;

    // Case 1: APY below minimum and we have an active position → withdraw all
    if (belowMinimum && hasActivePosition) {
      const totalDeposited = BigInt(
        this.repo.getTotalDeposited().split('.')[0] || '0',
      );

      return {
        action: 'withdraw',
        amount: totalDeposited,
        reason: `APY ${apy} bps below minimum ${this.config.minApyBps} bps — withdrawing all funds`,
      };
    }

    // Case 2: Wallet balance exceeds threshold AND APY is acceptable → supply
    if (walletBalance > this.config.depositThreshold && !belowMinimum) {
      // Keep half the threshold as reserve, deposit the rest
      const reserve = this.config.depositThreshold / 2n;
      const supplyAmount = walletBalance - reserve;

      if (supplyAmount > 0n) {
        return {
          action: 'supply',
          amount: supplyAmount,
          reason: `Wallet balance ${walletBalance} exceeds threshold — supplying ${supplyAmount} at ${apy} bps APY`,
        };
      }
    }

    // Case 3: No action needed
    return {
      action: 'none',
      amount: 0n,
      reason: `No action needed — balance: ${walletBalance}, APY: ${apy} bps, positions: ${activePositions.length}`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

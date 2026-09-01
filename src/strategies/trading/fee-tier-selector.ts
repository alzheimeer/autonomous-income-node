/**
 * FeeTierSelector
 *
 * Queries Uniswap V3 Factory to find the best fee tier for a token pair
 * by comparing pool liquidity across all available tiers.
 *
 * Requirements: 1.1, 1.6
 */

import { Contract, JsonRpcProvider, ZeroAddress } from 'ethers';

import {
  UNISWAP_V3_FACTORY_ADDRESS,
  UNISWAP_FACTORY_ABI,
  UNISWAP_POOL_ABI,
} from '../../contracts/abis.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PoolLiquidityInfo {
  feeTier: number; // 500 | 3000 | 10000
  poolAddress: string;
  liquidity: bigint;
  exists: boolean;
}

export interface IFeeTierSelector {
  /**
   * Query all fee tiers for a token pair and return the pool with highest
   * liquidity. Returns null if no pool exists for the pair at any tier.
   * Req 1.1
   */
  selectBestFeeTier(
    tokenIn: string,
    tokenOut: string,
  ): Promise<PoolLiquidityInfo | null>;

  /**
   * Get all available pools for a pair, sorted by liquidity descending.
   * Used for retry logic when the best tier swap reverts. Req 1.4
   */
  getAvailablePools(
    tokenIn: string,
    tokenOut: string,
  ): Promise<PoolLiquidityInfo[]>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Uniswap V3 supported fee tiers on Base mainnet */
const FEE_TIERS = [500, 3000, 10000] as const;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class FeeTierSelector implements IFeeTierSelector {
  private readonly provider: JsonRpcProvider;
  private readonly factory: Contract;

  constructor(rpcUrl: string) {
    this.provider = new JsonRpcProvider(rpcUrl);
    this.factory = new Contract(
      UNISWAP_V3_FACTORY_ADDRESS,
      UNISWAP_FACTORY_ABI,
      this.provider,
    );
  }

  /**
   * Select the fee tier with the highest liquidity for the given token pair.
   * Returns null if no pool exists at any fee tier (Req 1.6).
   */
  async selectBestFeeTier(
    tokenIn: string,
    tokenOut: string,
  ): Promise<PoolLiquidityInfo | null> {
    const pools = await this.getAvailablePools(tokenIn, tokenOut);
    return pools.length > 0 ? pools[0] : null;
  }

  /**
   * Query all fee tiers and return existing pools sorted by liquidity
   * (highest first). Non-existent pools are excluded from the result.
   */
  async getAvailablePools(
    tokenIn: string,
    tokenOut: string,
  ): Promise<PoolLiquidityInfo[]> {
    const results: PoolLiquidityInfo[] = [];

    // Query all fee tiers in parallel for efficiency
    const poolQueries = FEE_TIERS.map(async (fee) => {
      try {
        return await this.queryPool(tokenIn, tokenOut, fee);
      } catch (error) {
        // Handle RPC timeout, contract revert, or network errors gracefully
        console.warn(
          `[FeeTierSelector] Error querying pool for fee tier ${fee}:`,
          (error as Error).message,
        );
        return null;
      }
    });

    const poolResults = await Promise.all(poolQueries);

    for (const pool of poolResults) {
      if (pool && pool.exists) {
        results.push(pool);
      }
    }

    // Sort by liquidity descending — highest liquidity first
    results.sort((a, b) => {
      if (b.liquidity > a.liquidity) return 1;
      if (b.liquidity < a.liquidity) return -1;
      return 0;
    });

    return results;
  }

  /**
   * Query a single pool for a given fee tier.
   * Returns pool info with exists=false if the pool address is zero.
   */
  private async queryPool(
    tokenIn: string,
    tokenOut: string,
    fee: number,
  ): Promise<PoolLiquidityInfo> {
    const poolAddress: string = await this.factory.getPool(tokenIn, tokenOut, fee);

    if (!poolAddress || poolAddress === ZeroAddress) {
      return {
        feeTier: fee,
        poolAddress: ZeroAddress,
        liquidity: 0n,
        exists: false,
      };
    }

    // Query pool liquidity
    const poolContract = new Contract(poolAddress, UNISWAP_POOL_ABI, this.provider);
    const liquidity: bigint = await poolContract.liquidity();

    return {
      feeTier: fee,
      poolAddress,
      liquidity,
      exists: true,
    };
  }
}

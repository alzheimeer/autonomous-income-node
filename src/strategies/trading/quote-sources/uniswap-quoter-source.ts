/**
 * UniswapQuoterSource — On-chain QuoterV2 quote adapter for Base
 *
 * Calls the Uniswap V3 QuoterV2 contract via ethers staticCall
 * to get swap quotes without spending gas.
 *
 * Revenue Optimization Engine — Task 3.4
 */

import { Contract, JsonRpcProvider } from 'ethers';
import type { QuoteSource, PriceQuote } from './types.js';
import { normalizeToE18 } from './types.js';

// QuoterV2 on Base
const QUOTER_V2_ADDRESS = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';

// Known token addresses on Base
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';

// Minimal QuoterV2 ABI for quoteExactInputSingle
const QUOTER_V2_ABI = [
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
];

export class UniswapQuoterSource implements QuoteSource {
  readonly name = 'uniswap_quoter';
  private readonly quoter: Contract;

  constructor(rpcUrl?: string) {
    const providerUrl = rpcUrl ?? process.env['RPC_PROVIDER_URL'] ?? 'https://mainnet.base.org';
    const provider = new JsonRpcProvider(providerUrl);
    this.quoter = new Contract(QUOTER_V2_ADDRESS, QUOTER_V2_ABI, provider);
  }

  async getQuote(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
  ): Promise<PriceQuote | null> {
    try {
      const fee = this.selectFee(tokenIn, tokenOut);

      const params = {
        tokenIn,
        tokenOut,
        amountIn,
        fee,
        sqrtPriceLimitX96: 0n,
      };

      // Use staticCall to simulate without gas
      const result = await this.quoter.quoteExactInputSingle.staticCall(params);
      const amountOut: bigint = result[0];

      if (amountOut === 0n) {
        return null;
      }

      const normalizedPriceE18 = normalizeToE18(amountOut, amountIn, 18);

      return {
        source: this.name,
        tokenIn,
        tokenOut,
        amountIn,
        expectedOut: amountOut,
        normalizedPriceE18,
        timestamp: Date.now(),
      };
    } catch {
      // staticCall reverted or network error — return null
      return null;
    }
  }

  /**
   * Select the fee tier based on the token pair.
   * USDC/WETH uses 500 (0.05%), others use 3000 (0.3%).
   */
  private selectFee(tokenIn: string, tokenOut: string): number {
    const lowerIn = tokenIn.toLowerCase();
    const lowerOut = tokenOut.toLowerCase();
    const usdcLower = USDC_ADDRESS.toLowerCase();
    const wethLower = WETH_ADDRESS.toLowerCase();

    const isUsdcWeth =
      (lowerIn === usdcLower && lowerOut === wethLower) ||
      (lowerIn === wethLower && lowerOut === usdcLower);

    return isUsdcWeth ? 500 : 3000;
  }
}

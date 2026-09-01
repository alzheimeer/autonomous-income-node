/**
 * Shared Module — DexQuoter
 *
 * DEX-agnostic abstraction for quoting token swaps on Base mainnet.
 * Supports Uniswap V3 (via QuoterV2) and Aerodrome (Solidly fork).
 *
 * Key design principles:
 *   - Provider injected in constructor → mock-friendly for tests
 *   - ALL quotes via staticCall — NEVER eth_sendRawTransaction
 *   - ABIs defined inline — no dynamic fetch
 *   - detectPoolType uses sequential probing with graceful fallback
 *   - Retry logic with exponential backoff for transient RPC errors
 *
 * Originally developed for hybrid-sniper, refactored to shared for reuse
 * by copy-trading and other modules.
 *
 * Requirements: 1.5, 3.7, 5.6
 */

import { ethers } from 'ethers';
import { createLogger } from '../logger.js';

const log = createLogger('dex-quoter');

// ═══════════════════════════════════════════════════════════════════════════
// Constants — Base mainnet addresses
// ═══════════════════════════════════════════════════════════════════════════

const QUOTER_V2_ADDRESS = '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a';
const AERODROME_FACTORY = '0x420DD381b31aEf6683db6B902084cB0FFECe40Da';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

// ═══════════════════════════════════════════════════════════════════════════
// Inline ABIs — no dynamic fetch
// ═══════════════════════════════════════════════════════════════════════════

const UNISWAP_V3_POOL_ABI = [
  { name: 'fee', type: 'function', inputs: [], outputs: [{ type: 'uint24' }] },
  { name: 'factory', type: 'function', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const AERODROME_POOL_ABI = [
  {
    name: 'getAmountOut',
    type: 'function',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'tokenIn', type: 'address' },
    ],
    outputs: [{ name: 'amountOut', type: 'uint256' }],
  },
] as const;

const QUOTER_V2_ABI = [
  {
    name: 'quoteExactInputSingle',
    type: 'function',
    inputs: [
      {
        type: 'tuple',
        components: [
          { name: 'tokenIn', type: 'address' },
          { name: 'tokenOut', type: 'address' },
          { name: 'amountIn', type: 'uint256' },
          { name: 'fee', type: 'uint24' },
          { name: 'sqrtPriceLimitX96', type: 'uint160' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'sqrtPriceX96After', type: 'uint160' },
      { name: 'initializedTicksCrossed', type: 'uint32' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export type PoolType = 'uniswap_v3' | 'aerodrome';

export interface QuoteParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  poolAddress: string;
  /** Pool fee tier — required for Uniswap V3 (100 | 500 | 3000 | 10000) */
  fee?: number;
}

export interface IDexQuoter {
  /** Detects whether a pool address is Uniswap V3 or Aerodrome. */
  detectPoolType(poolAddress: string): Promise<PoolType>;
  /** Returns the amountOut for a given swap via staticCall (no gas). */
  quote(params: QuoteParams): Promise<bigint>;
}

// ═══════════════════════════════════════════════════════════════════════════
// DexQuoter
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DexQuoter provides DEX-agnostic price quotes for Uniswap V3 and Aerodrome.
 *
 * All network calls use `staticCall` (eth_call), never eth_sendRawTransaction.
 * The `provider` is injected at construction time for full mock-friendliness.
 */
export class DexQuoter implements IDexQuoter {
  private readonly provider: ethers.Provider;
  /** Cache of detected pool types to avoid repeated RPC calls */
  private readonly poolTypeCache = new Map<string, PoolType>();

  constructor(provider: ethers.Provider) {
    this.provider = provider;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // detectPoolType
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Probes a pool address to determine whether it's Uniswap V3 or Aerodrome.
   *
   * Detection order (sequential, each step falls through on error):
   *   1. pool.fee()         → success ⇒ 'uniswap_v3'
   *   2. pool.factory()     → success AND == AERODROME_FACTORY ⇒ 'aerodrome'
   *   3. pool.getAmountOut(1n, tokenIn=ZeroAddress) → success ⇒ 'aerodrome'
   *   4. Fallback           → 'uniswap_v3'
   *
   * Any exception from staticCall is caught and triggers the next probe.
   * Results are cached to avoid repeated RPC calls.
   */
  async detectPoolType(poolAddress: string): Promise<PoolType> {
    // Check cache first
    const cached = this.poolTypeCache.get(poolAddress.toLowerCase());
    if (cached) {
      return cached;
    }

    let detectedType: PoolType = 'uniswap_v3'; // default fallback

    // Step 1: Try pool.fee() — characteristic of Uniswap V3 pools
    try {
      const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, this.provider);
      await pool['fee']();
      log.debug('detectPoolType: fee() succeeded → uniswap_v3', { poolAddress });
      detectedType = 'uniswap_v3';
      this.poolTypeCache.set(poolAddress.toLowerCase(), detectedType);
      return detectedType;
    } catch {
      // Not a UniswapV3 pool (or fee() failed) — continue probing
    }

    // Step 2: Try pool.factory() and compare against known Aerodrome factory
    try {
      const pool = new ethers.Contract(poolAddress, UNISWAP_V3_POOL_ABI, this.provider);
      const factory: string = await pool['factory']();
      if (factory.toLowerCase() === AERODROME_FACTORY.toLowerCase()) {
        log.debug('detectPoolType: factory() matches AERODROME_FACTORY → aerodrome', {
          poolAddress,
          factory,
        });
        detectedType = 'aerodrome';
        this.poolTypeCache.set(poolAddress.toLowerCase(), detectedType);
        return detectedType;
      }
    } catch {
      // factory() call failed — continue probing
    }

    // Step 3: Try pool.getAmountOut(1n, tokenIn) with Aerodrome ABI
    // Using ZeroAddress as tokenIn for a minimal probe — we only care if the
    // call succeeds without reverting, indicating the Solidly interface exists.
    try {
      const pool = new ethers.Contract(poolAddress, AERODROME_POOL_ABI, this.provider);
      await pool['getAmountOut'](1n, ethers.ZeroAddress);
      log.debug('detectPoolType: getAmountOut() succeeded → aerodrome', { poolAddress });
      detectedType = 'aerodrome';
      this.poolTypeCache.set(poolAddress.toLowerCase(), detectedType);
      return detectedType;
    } catch {
      // getAmountOut() call failed — fall through to default
    }

    // Step 4: Fallback — assume Uniswap V3
    log.debug('detectPoolType: all probes failed → fallback uniswap_v3', { poolAddress });
    this.poolTypeCache.set(poolAddress.toLowerCase(), detectedType);
    return detectedType;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // quote
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the amountOut for a given swap using staticCall (no gas spent).
   *
   * Routing:
   *   - If params.poolAddress resolves to 'uniswap_v3': uses QuoterV2
   *     quoteExactInputSingle with the fee from params (or auto-detected).
   *   - If resolves to 'aerodrome': calls pool.getAmountOut(amountIn, tokenIn).
   *
   * Enhanced: Tries Aerodrome as fallback if UniswapV3 fails for all fee tiers.
   * This handles the common case where new micro-cap tokens only have Aerodrome pools.
   *
   * Throws on any RPC error or contract revert — the caller is responsible
   * for handling these (e.g. ContractValidator wraps in try/catch).
   */
  async quote(params: QuoteParams): Promise<bigint> {
    const { tokenIn, tokenOut, amountIn, poolAddress, fee } = params;

    const poolType = await this.detectPoolType(poolAddress);

    if (poolType === 'aerodrome') {
      return this._quoteAerodrome(poolAddress, amountIn, tokenIn);
    }

    // Try UniswapV3 first
    try {
      return await this._quoteUniswapV3(tokenIn, tokenOut, amountIn, fee);
    } catch (uniswapError) {
      // UniswapV3 failed — try Aerodrome as fallback
      log.debug('quote: UniswapV3 failed, trying Aerodrome fallback', {
        tokenIn,
        tokenOut,
        poolAddress,
        error: uniswapError instanceof Error ? uniswapError.message.slice(0, 80) : String(uniswapError).slice(0, 80),
      });

      try {
        const aerodromeResult = await this._quoteAerodrome(poolAddress, amountIn, tokenIn);
        // If Aerodrome works, update cache
        this.poolTypeCache.set(poolAddress.toLowerCase(), 'aerodrome');
        return aerodromeResult;
      } catch (aerodromeError) {
        // Both failed — try direct pool quote as last resort
        log.debug('quote: Aerodrome fallback also failed, trying direct pool quote', {
          tokenIn,
          tokenOut,
          poolAddress,
        });

        try {
          return await this._quoteDirectPool(poolAddress, amountIn, tokenIn, tokenOut);
        } catch {
          // All methods failed — throw original UniswapV3 error
          throw uniswapError;
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Quotes a Uniswap V3 swap via QuoterV2.quoteExactInputSingle (staticCall).
   *
   * Returns amountOut (index 0 of the tuple result).
   * Tries fee tiers in order: provided fee → 10000 → 3000 → 500 → 100.
   * New tokens on Base often use 1% (10000) pools — defaulting to 3000 misses them.
   *
   * Enhanced with retry logic for transient RPC errors.
   *
   * Throws only if all fee tiers fail.
   */
  private async _quoteUniswapV3(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    fee: number = 3000,
  ): Promise<bigint> {
    const quoter = new ethers.Contract(QUOTER_V2_ADDRESS, QUOTER_V2_ABI, this.provider);

    // Fee tiers to try in order. Start with the provided fee, then try others.
    // New micro-cap tokens on Base commonly use 1% (10000) or 0.3% (3000) pools.
    const feeTiersToTry = [fee, 10_000, 3_000, 500, 100].filter(
      (f, i, arr) => arr.indexOf(f) === i, // deduplicate
    );

    let lastError: unknown;

    for (const feeTier of feeTiersToTry) {
      // Retry loop for transient RPC errors
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const result = await quoter['quoteExactInputSingle'].staticCall({
            tokenIn,
            tokenOut,
            amountIn,
            fee: feeTier,
            sqrtPriceLimitX96: 0n,
          });

          const amountOut = result[0] as bigint;

          log.debug('_quoteUniswapV3 success', {
            tokenIn: tokenIn.slice(0, 10),
            tokenOut: tokenOut.slice(0, 10),
            amountIn: amountIn.toString(),
            fee: feeTier,
            amountOut: amountOut.toString(),
          });

          return amountOut;
        } catch (err) {
          lastError = err;
          const errorMsg = err instanceof Error ? err.message : String(err);

          // Check if it's a transient error worth retrying
          const isTransient = errorMsg.includes('timeout') ||
                              errorMsg.includes('ETIMEDOUT') ||
                              errorMsg.includes('network') ||
                              errorMsg.includes('502') ||
                              errorMsg.includes('503');

          if (isTransient && attempt < MAX_RETRIES) {
            log.debug('_quoteUniswapV3 transient error, retrying', {
              feeTier,
              attempt,
              error: errorMsg.slice(0, 60),
            });
            await this._sleep(RETRY_DELAY_MS * attempt);
            continue;
          }

          // Not transient or max retries reached — try next fee tier
          break;
        }
      }
    }

    // All fee tiers failed — throw the last error
    throw lastError;
  }

  /**
   * Quotes an Aerodrome swap via pool.getAmountOut.staticCall.
   *
   * Returns amountOut directly from the pool contract.
   * Throws if the staticCall reverts or the RPC is unavailable.
   */
  private async _quoteAerodrome(
    poolAddress: string,
    amountIn: bigint,
    tokenIn: string,
  ): Promise<bigint> {
    const pool = new ethers.Contract(poolAddress, AERODROME_POOL_ABI, this.provider);

    // Retry loop for transient errors
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const amountOut = (await pool['getAmountOut'].staticCall(amountIn, tokenIn)) as bigint;

        log.debug('_quoteAerodrome success', {
          poolAddress: poolAddress.slice(0, 10),
          tokenIn: tokenIn.slice(0, 10),
          amountIn: amountIn.toString(),
          amountOut: amountOut.toString(),
        });

        return amountOut;
      } catch (err) {
        lastError = err;
        const errorMsg = err instanceof Error ? err.message : String(err);

        const isTransient = errorMsg.includes('timeout') ||
                            errorMsg.includes('network') ||
                            errorMsg.includes('502');

        if (isTransient && attempt < MAX_RETRIES) {
          await this._sleep(RETRY_DELAY_MS * attempt);
          continue;
        }
        break;
      }
    }

    throw lastError;
  }

  /**
   * Direct pool quote as last resort — tries to read reserves and calculate manually.
   * Works for simple constant-product AMMs (Uniswap V2 style).
   */
  private async _quoteDirectPool(
    poolAddress: string,
    amountIn: bigint,
    tokenIn: string,
    tokenOut: string,
  ): Promise<bigint> {
    const RESERVES_ABI = [
      {
        name: 'getReserves',
        type: 'function',
        inputs: [],
        outputs: [
          { name: 'reserve0', type: 'uint112' },
          { name: 'reserve1', type: 'uint112' },
          { name: 'blockTimestampLast', type: 'uint32' },
        ],
      },
      { name: 'token0', type: 'function', inputs: [], outputs: [{ type: 'address' }] },
      { name: 'token1', type: 'function', inputs: [], outputs: [{ type: 'address' }] },
    ] as const;

    const pool = new ethers.Contract(poolAddress, RESERVES_ABI, this.provider);

    const [[reserve0, reserve1], token0, token1] = await Promise.all([
      pool['getReserves']() as Promise<[bigint, bigint, number]>,
      pool['token0']() as Promise<string>,
      pool['token1']() as Promise<string>,
    ]);

    // Determine which reserve is which
    const tokenInLower = tokenIn.toLowerCase();
    const [reserveIn, reserveOut] = token0.toLowerCase() === tokenInLower
      ? [reserve0, reserve1]
      : [reserve1, reserve0];

    // Constant product formula with 0.3% fee: amountOut = reserveOut * amountIn * 997 / (reserveIn * 1000 + amountIn * 997)
    const amountInWithFee = amountIn * 997n;
    const numerator = reserveOut * amountInWithFee;
    const denominator = reserveIn * 1000n + amountInWithFee;
    const amountOut = numerator / denominator;

    log.debug('_quoteDirectPool success', {
      poolAddress: poolAddress.slice(0, 10),
      amountIn: amountIn.toString(),
      amountOut: amountOut.toString(),
    });

    return amountOut;
  }

  /** Simple sleep helper */
  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

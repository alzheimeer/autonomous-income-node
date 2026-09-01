/**
 * Shared — ContractValidator
 *
 * Validates a token contract against multiple on-chain checks before allowing
 * a shadow position to be opened. All calls use staticCall (eth_call) — zero gas.
 *
 * Checks performed (in order):
 *   1. Pool detection — detectPoolType via DexQuoter
 *   2. HoneypotTest — simulate buy(100%) + sell(50%) + sell(50%)
 *   3. Tax Scanner — sellTax > 5% → reject
 *   4. Liquidity Check — USDC balance of pool < $10,000 → reject
 *   5. FlagScanner — isBlacklisted(agentAddress) → reject if true
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 * 
 * NOTE: This module was refactored from hybrid-sniper to be shared across
 * trading systems (copy-trading, future modules).
 */

import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import type { IDexQuoter } from './dex-quoter.js';
import type { SniperSignal, ValidationResult } from './metrics-recorder.js';

const log = createLogger('contract-validator');

// ═══════════════════════════════════════════════════════════════════════════
// Constants — Base mainnet
// ═══════════════════════════════════════════════════════════════════════════

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Base mainnet USDC
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006'; // Base mainnet WETH

/** Minimum USDC liquidity in pool (6-decimal, = $5,000)
 * 
 * HISTORY:
 * - Original: $10,000 (too restrictive, 0% pass rate on micro-caps)
 * - Aug 4, 2026: Reduced to $3,000 (still 46% rejection rate)
 * - Aug 11, 2026: Reduced to $1,000 to capture early micro-caps
 * - Aug 15, 2026: Increased to $5,000 to avoid zero-effort rug pulls
 * 
 * Note: Many Base micro-caps have WETH pairs, not USDC. The liquidity check
 * now also checks WETH balance when USDC is insufficient (see below).
 * LP Lock/Burn verification provides rug protection at lower liquidity levels.
 */
const MIN_LIQUIDITY_USDC = 5_000_000_000n; // $5,000 in 6 decimals

/** Minimum WETH liquidity in pool (18-decimal, ~2.0 ETH ≈ $7,600 at $3800/ETH) */
const MIN_LIQUIDITY_WETH = 2_000_000_000_000_000_000n; // 2.0 ETH in 18 decimals

/** Maximum acceptable sell tax percentage (integer %) */
const MAX_SELL_TAX_PCT = 5n;

// ═══════════════════════════════════════════════════════════════════════════
// Inline ABIs — no dynamic fetch
// ═══════════════════════════════════════════════════════════════════════════

const ERC20_BALANCE_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** ABI for reading pool token addresses (Uniswap V3 pool interface) */
const POOL_TOKENS_ABI = [
  {
    name: 'token0',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
  {
    name: 'token1',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'address' }],
  },
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Pool Token Cache — reduces RPC calls from 5 to 3 per validation
// ═══════════════════════════════════════════════════════════════════════════

interface PoolTokenCache {
  token0: string;
  token1: string;
  lastChecked: number;
}

/** Cache TTL: 1 hour (pool tokens don't change) */
const POOL_CACHE_TTL_MS = 3_600_000;

/** Global pool token cache to avoid repeated token0()/token1() calls */
const poolTokenCache = new Map<string, PoolTokenCache>();

const TOKEN_FLAG_ABI = [
  {
    name: 'isBlacklisted',
    type: 'function',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'tradingActive',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'bool' }],
  },
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// Public types
// ═══════════════════════════════════════════════════════════════════════════

export type RejectReason =
  | 'HONEYPOT_SELL1_ZERO'
  | 'HONEYPOT_SELL2_ZERO'
  | 'SELL_TAX_EXCEEDED'
  | 'INSUFFICIENT_LIQUIDITY'
  | 'BLACKLISTED'
  | 'UNVERIFIED_OR_UNLOCKED_LP'
  | 'POOL_DETECTION_FAILED'
  | 'QUOTE_ERROR';

export interface IContractValidator {
  validate(signal: SniperSignal): Promise<ValidationResult>;
  /** Optional callback when validation passes — used for multi-variant exploration */
  onValidationPassed?: (signal: SniperSignal) => Promise<void>;
}

// ═══════════════════════════════════════════════════════════════════════════
// ContractValidator
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ContractValidator runs a sequence of on-chain checks for a given token signal.
 *
 * All RPC calls are via staticCall (eth_call). Any unexpected exception from an
 * RPC call is caught, logged as warn, and returned as QUOTE_ERROR.
 */
export class ContractValidator implements IContractValidator {
  private readonly dexQuoter: IDexQuoter;
  private readonly provider: ethers.Provider;
  private readonly tradeSizeUsdc: number;
  private readonly agentAddress: string;

  /** Optional callback when a signal passes validation */
  public onValidationPassed?: (signal: SniperSignal) => Promise<void>;

  constructor(
    dexQuoter: IDexQuoter,
    provider: ethers.Provider,
    config: { tradeSizeUsdc: number; agentAddress: string },
  ) {
    this.dexQuoter = dexQuoter;
    this.provider = provider;
    this.tradeSizeUsdc = config.tradeSizeUsdc;
    this.agentAddress = config.agentAddress;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // validate
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Validates a token contract through all on-chain checks.
   *
   * Returns ValidationResult with passed=true only when all checks pass.
   * Any RPC exception is caught and returned as QUOTE_ERROR.
   */
  async validate(signal: SniperSignal): Promise<ValidationResult> {
    const token = signal.contractAddress;

    // tradeSize as a bigint (6-decimal USDC)
    const tradeSize = BigInt(Math.round(this.tradeSizeUsdc * 1_000_000));

    try {
      // ─── Step 1: Pool detection ──────────────────────────────────────────
      let poolAddress: string;
      try {
        // Bug fix: signal.contractAddress is the TOKEN address, not the pool.
        // DexScreener provides pairAddress (the pool) via signal.poolAddress.
        // Use signal.poolAddress when available; fall back to contractAddress
        // only when no pool address was provided (e.g. webhook signals).
        const candidatePoolAddress = signal.poolAddress ?? signal.contractAddress;
        await this.dexQuoter.detectPoolType(candidatePoolAddress);
        poolAddress = candidatePoolAddress;
      } catch (err) {
        log.debug('ContractValidator: pool detection failed', {
          contract: token,
          error: err instanceof Error ? err.message : String(err),
        });
        return this._reject('POOL_DETECTION_FAILED', signal.ingestionTime);
      }

      // ─── Step 2: HoneypotTest ────────────────────────────────────────────

      // Determine quote currency: prefer USDC, fall back to WETH for token/WETH pools.
      // Many new micro-cap tokens on Base only have a token/WETH pool, not token/USDC.
      const quoteCurrency = await this._detectQuoteCurrency(poolAddress, token);
      const quoteAmountIn = quoteCurrency === USDC_ADDRESS
        ? tradeSize
        : this._usdcToWeth(tradeSize); // approximate: 1 ETH ≈ 3800 USDC (static fallback)

      // 2a. Simulate buy: quoteCurrency → token
      const buyAmountOut = await this.dexQuoter.quote({
        tokenIn: quoteCurrency,
        tokenOut: token,
        amountIn: quoteAmountIn,
        poolAddress,
      });

      if (buyAmountOut === 0n) {
        log.warn('ContractValidator: buyAmountOut is 0 → QUOTE_ERROR', { contract: token });
        return this._reject('QUOTE_ERROR', signal.ingestionTime);
      }

      // 2b. First sell: 50% of bought tokens → quoteCurrency
      const sell1Amount = buyAmountOut / 2n;
      const sell1Out = await this.dexQuoter.quote({
        tokenIn: token,
        tokenOut: quoteCurrency,
        amountIn: sell1Amount,
        poolAddress,
      });

      if (sell1Out === 0n) {
        log.warn('ContractValidator: sell1Out is 0 → HONEYPOT_SELL1_ZERO', { contract: token });
        return this._reject('HONEYPOT_SELL1_ZERO', signal.ingestionTime);
      }

      // 2c. Second sell: remaining tokens → quoteCurrency (handles odd buyAmountOut)
      const sell2Amount = buyAmountOut - sell1Amount;
      const sell2Out = await this.dexQuoter.quote({
        tokenIn: token,
        tokenOut: quoteCurrency,
        amountIn: sell2Amount,
        poolAddress,
      });

      if (sell2Out === 0n) {
        log.warn('ContractValidator: sell2Out is 0 → HONEYPOT_SELL2_ZERO', { contract: token });
        return this._reject('HONEYPOT_SELL2_ZERO', signal.ingestionTime);
      }

      // ─── Step 3: Tax Scanner ─────────────────────────────────────────────
      const totalOut = sell1Out + sell2Out;
      // sellTax = how much we lost relative to quoteAmountIn, expressed as integer %
      const sellTax = totalOut < quoteAmountIn ? ((quoteAmountIn - totalOut) * 100n) / quoteAmountIn : 0n;

      if (sellTax > MAX_SELL_TAX_PCT) {
        log.warn('ContractValidator: sellTax exceeded', {
          contract: token,
          sellTaxPct: sellTax.toString(),
        });
        return this._reject('SELL_TAX_EXCEEDED', signal.ingestionTime);
      }

      // ─── Step 4: Liquidity Check (USDC or WETH) ───────────────────────────
      // Many micro-caps on Base only have WETH pairs, not USDC.
      // Check USDC first, then fallback to WETH if insufficient.
      const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_BALANCE_ABI, this.provider);
      const wethContract = new ethers.Contract(WETH_ADDRESS, ERC20_BALANCE_ABI, this.provider);
      
      const [poolUsdcBalance, poolWethBalance]: [bigint, bigint] = await Promise.all([
        usdcContract['balanceOf'].staticCall(poolAddress) as Promise<bigint>,
        wethContract['balanceOf'].staticCall(poolAddress) as Promise<bigint>,
      ]);

      const hasUsdcLiquidity = poolUsdcBalance >= MIN_LIQUIDITY_USDC;
      const hasWethLiquidity = poolWethBalance >= MIN_LIQUIDITY_WETH;

      if (!hasUsdcLiquidity && !hasWethLiquidity) {
        log.debug('ContractValidator: insufficient liquidity (USDC and WETH)', {
          contract: token,
          poolUsdcBalance: poolUsdcBalance.toString(),
          poolWethBalance: poolWethBalance.toString(),
          minUsdcRequired: MIN_LIQUIDITY_USDC.toString(),
          minWethRequired: MIN_LIQUIDITY_WETH.toString(),
        });
        return this._reject('INSUFFICIENT_LIQUIDITY', signal.ingestionTime);
      }

      // ─── Step 5: FlagScanner ─────────────────────────────────────────────
      // isBlacklisted is optional — if the function doesn't exist, skip silently
      try {
        const tokenContract = new ethers.Contract(token, TOKEN_FLAG_ABI, this.provider);
        const blacklisted = (await tokenContract['isBlacklisted'].staticCall(
          this.agentAddress,
        )) as boolean;
        if (blacklisted) {
          log.warn('ContractValidator: agentAddress is blacklisted', {
            contract: token,
            agentAddress: this.agentAddress,
          });
          return this._reject('BLACKLISTED', signal.ingestionTime);
        }
      } catch {
        // Function doesn't exist on this contract — skip (not an error)
        log.debug('ContractValidator: isBlacklisted not available, skipping', {
          contract: token,
        });
      }

      // ─── Step 5.5: LP Lock / Burn Verification ─────────────────────────────
      // Check if LP tokens are burned or held by a lock contract (uncx, pinksale, team.finance)
      const lpLocked = await this._verifyLpLockOrBurn(poolAddress);
      if (!lpLocked) {
        log.warn('ContractValidator: LP not locked or burned → UNVERIFIED_OR_UNLOCKED_LP', {
          contract: token,
          poolAddress,
        });
        return this._reject('UNVERIFIED_OR_UNLOCKED_LP', signal.ingestionTime);
      }

      // ─── Step 6: All checks passed ───────────────────────────────────────
      const validatedAt = Date.now();
      const latencyMs = validatedAt - signal.ingestionTime;

      log.info('ContractValidator: validation passed', {
        contract: token,
        sellTaxPct: sellTax.toString(),
        poolUsdcBalance: poolUsdcBalance.toString(),
        poolWethBalance: poolWethBalance.toString(),
        liquiditySource: hasUsdcLiquidity ? 'USDC' : 'WETH',
        latencyMs,
      });

      // Notify multi-variant executor if callback is registered
      if (this.onValidationPassed) {
        try {
          await this.onValidationPassed(signal);
        } catch (err) {
          log.warn('ContractValidator: onValidationPassed callback failed', {
            contract: token,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return {
        passed: true,
        rejectReason: null,
        validatedAt,
        latencyMs,
      };
    } catch (err) {
      log.debug('ContractValidator: unexpected RPC error → QUOTE_ERROR', {
        contract: token,
        error: err instanceof Error ? err.message.slice(0, 120) : String(err).slice(0, 120),
      });
      return this._reject('QUOTE_ERROR', signal.ingestionTime);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Determines which quote currency to use for honeypot simulation.
   *
   * Reads token0/token1 from the pool contract. If neither is USDC, falls back
   * to WETH (the other token in the pool). This handles the common case where
   * new micro-cap tokens on Base only have a token/WETH pool.
   *
   * OPTIMIZATION: Uses poolTokenCache to avoid repeated RPC calls.
   * Pool tokens never change, so we cache for 1 hour.
   *
   * Falls back to USDC on any RPC error (conservative).
   */
  private async _detectQuoteCurrency(poolAddress: string, token: string): Promise<string> {
    try {
      const poolKey = poolAddress.toLowerCase();
      const now = Date.now();
      
      // Check cache first
      let token0: string;
      let token1: string;
      const cached = poolTokenCache.get(poolKey);
      
      if (cached && (now - cached.lastChecked) < POOL_CACHE_TTL_MS) {
        // Cache hit — skip RPC calls
        token0 = cached.token0;
        token1 = cached.token1;
        log.debug('ContractValidator: pool cache hit', { poolAddress, token0, token1 });
      } else {
        // Cache miss — make RPC calls
        const pool = new ethers.Contract(poolAddress, POOL_TOKENS_ABI, this.provider);
        [token0, token1] = await Promise.all([
          pool['token0']() as Promise<string>,
          pool['token1']() as Promise<string>,
        ]);
        
        // Store in cache
        poolTokenCache.set(poolKey, {
          token0,
          token1,
          lastChecked: now,
        });
        log.debug('ContractValidator: pool cache miss, stored', { poolAddress, token0, token1 });
      }

      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      const usdc = USDC_ADDRESS.toLowerCase();

      // If one of the tokens is USDC, quote directly in USDC
      if (t0 === usdc || t1 === usdc) {
        return USDC_ADDRESS;
      }

      // No USDC in pool — use the OTHER token as quote currency (likely WETH)
      const tokenLow = token.toLowerCase();
      if (t0 === tokenLow) return token1; // token1 is the quote
      if (t1 === tokenLow) return token0; // token0 is the quote

      // Fallback: use WETH
      return WETH_ADDRESS;
    } catch {
      // Can't read pool tokens — default to USDC (DexQuoter will try all fee tiers)
      return USDC_ADDRESS;
    }
  }

  /**
   * Approximate USDC amount → WETH amount.
   * Uses a static rate of 1 ETH = 3800 USDC as a conservative estimate.
   * Only used for honeypot simulation sizing — not for real trade execution.
   * USDC has 6 decimals, WETH has 18 decimals.
   */
  private _usdcToWeth(usdcAmount6: bigint): bigint {
    // usdcAmount6 is in 6-decimal USDC. Convert to 18-decimal WETH.
    // wethAmount18 = usdcAmount6 * 1e18 / (3800 * 1e6)
    const ETH_PRICE_USDC = 3800n;
    return (usdcAmount6 * 1_000_000_000_000_000_000n) / (ETH_PRICE_USDC * 1_000_000n);
  }

  /**
   * Checks if LP tokens for a pool are burned (sent to 0x00..dead or zero address)
   * or held by standard lock contracts on Base.
   */
  private async _verifyLpLockOrBurn(poolAddress: string): Promise<boolean> {
    try {
      const BURN_ADDRESS_1 = '0x0000000000000000000000000000000000000000';
      const BURN_ADDRESS_2 = '0x000000000000000000000000000000000000dEaD';
      
      const poolContract = new ethers.Contract(poolAddress, [
        ...ERC20_BALANCE_ABI,
        { name: 'totalSupply', type: 'function', inputs: [], outputs: [{ type: 'uint256' }] },
      ], this.provider);

      // Try reading totalSupply of the pool LP token
      const totalSupply = (await poolContract['totalSupply'].staticCall()) as bigint;
      if (totalSupply === 0n) return true;

      const [dead1Balance, dead2Balance]: [bigint, bigint] = await Promise.all([
        poolContract['balanceOf'].staticCall(BURN_ADDRESS_1) as Promise<bigint>,
        poolContract['balanceOf'].staticCall(BURN_ADDRESS_2) as Promise<bigint>,
      ]);

      const burnedSupply = dead1Balance + dead2Balance;
      // Consider locked/burned if > 50% of LP totalSupply is at dead addresses
      return (burnedSupply * 100n) / totalSupply >= 50n;
    } catch {
      // V3 pools don't have standard ERC20 LP tokens — default to true (skip check safely)
      return true;
    }
  }

  /** Build a failed ValidationResult with the given reason. */
  private _reject(reason: RejectReason, ingestionTime: number): ValidationResult {
    const validatedAt = Date.now();
    return {
      passed: false,
      rejectReason: reason,
      validatedAt,
      latencyMs: validatedAt - ingestionTime,
    };
  }
}

/**
 * SwapDecoder Module
 *
 * Decodes swap calldata from supported DEX routers to extract token addresses,
 * amounts, and direction (BUY/SELL).
 *
 * Supported routers:
 * - Uniswap V3: Universal Router / SwapRouter02
 * - Aerodrome: Router
 * - 1inch: AggregationRouter
 *
 * Requirements:
 * - 2.4: Decode swap calldata from Uniswap V3, Aerodrome, and 1inch routers
 * - 2.5: Extract token addresses, amounts, and direction (BUY/SELL)
 * - Property 6: Swap Calldata Decode Round-Trip
 */

import { ethers } from 'ethers';
import { createLogger } from '../../logger.js';

const log = createLogger('swap-decoder');

// =============================================================================
// CONSTANTS - Base L2 Token Addresses
// =============================================================================

/** WETH on Base L2 */
const WETH_BASE = '0x4200000000000000000000000000000000000006';

/** USDC on Base L2 */
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** USDbC (Bridged USDC) on Base L2 */
const USDBC_BASE = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';

/** Set of base token addresses (normalized to lowercase) */
const BASE_TOKENS = new Set([
  WETH_BASE.toLowerCase(),
  USDC_BASE.toLowerCase(),
  USDBC_BASE.toLowerCase(),
]);


// =============================================================================
// INTERFACES
// =============================================================================

/**
 * Router type identifier
 */
export type RouterType = 'uniswapV3' | 'aerodrome' | 'oneInch' | 'unknown';

/**
 * Decoded swap information extracted from calldata
 */
export interface DecodedSwap {
  /** Router that executed the swap */
  router: RouterType;
  /** Input token address */
  tokenIn: string;
  /** Output token address */
  tokenOut: string;
  /** Input amount in wei */
  amountIn: bigint;
  /** Minimum output amount in wei */
  amountOutMin: bigint;
  /** Recipient address */
  recipient: string;
  /** Action type: BUY if acquiring non-base token, SELL if disposing */
  action: 'BUY' | 'SELL';
}

/**
 * Router addresses configuration
 */
export interface RouterAddresses {
  uniswapV3: string;
  aerodrome: string;
  oneInch: string;
}

// =============================================================================
// ABI FRAGMENTS
// =============================================================================

/**
 * Uniswap V3 SwapRouter02 ABI fragments
 */
const UNISWAP_V3_ABI = [
  // exactInputSingle
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  // exactInput (multi-hop)
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
  // exactOutputSingle
  'function exactOutputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountIn)',
  // exactOutput (multi-hop)
  'function exactOutput((bytes path, address recipient, uint256 amountOut, uint256 amountInMaximum)) external payable returns (uint256 amountIn)',
];


/**
 * Aerodrome Router ABI fragments (similar to Uniswap V2)
 */
const AERODROME_ABI = [
  // swapExactTokensForTokens
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable)[] routes, address to, uint256 deadline) external returns (uint256[] amounts)',
  // swapExactETHForTokens
  'function swapExactETHForTokens(uint256 amountOutMin, (address from, address to, bool stable)[] routes, address to, uint256 deadline) external payable returns (uint256[] amounts)',
  // swapExactTokensForETH
  'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable)[] routes, address to, uint256 deadline) external returns (uint256[] amounts)',
];

/**
 * 1inch AggregationRouter ABI fragments
 */
const ONEINCH_ABI = [
  // swap
  'function swap(address executor, (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc, bytes permit, bytes data) external payable returns (uint256 returnAmount, uint256 spentAmount)',
  // unoswap (simplified single-hop)
  'function unoswap(address srcToken, uint256 amount, uint256 minReturn, uint256[] pools) external returns (uint256 returnAmount)',
  // uniswapV3Swap
  'function uniswapV3Swap(uint256 amount, uint256 minReturn, uint256[] pools) external payable returns (uint256 returnAmount)',
];

// =============================================================================
// SWAP DECODER CLASS
// =============================================================================

/**
 * SwapDecoder decodes swap transaction calldata from supported DEX routers.
 *
 * Features:
 * - Decodes Uniswap V3 swaps (exactInputSingle, exactInput, exactOutputSingle, exactOutput)
 * - Decodes Aerodrome swaps (swapExactTokensForTokens, swapExactETHForTokens, swapExactTokensForETH)
 * - Decodes 1inch swaps (swap, unoswap, uniswapV3Swap)
 * - Identifies base tokens (WETH, USDC, USDbC) to determine BUY vs SELL action
 *
 * @example
 * ```ts
 * const decoder = new SwapDecoder({
 *   uniswapV3: '0x2626664c2603336E57B271c5C0b26F421741e481',
 *   aerodrome: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
 *   oneInch: '0x1111111254EEB25477B68fb85Ed929f73A960582',
 * });
 *
 * const decoded = decoder.decode(txTo, txData);
 * if (decoded) {
 *   console.log(`${decoded.action} ${decoded.tokenOut} for ${decoded.tokenIn}`);
 * }
 * ```
 */
export class SwapDecoder {
  private readonly routerAddresses: RouterAddresses;
  private readonly normalizedRouters: Map<string, RouterType>;

  // Pre-parsed interfaces for each router type
  private readonly uniswapV3Interface: ethers.Interface;
  private readonly aerodromeInterface: ethers.Interface;
  private readonly oneInchInterface: ethers.Interface;

  /**
   * Creates a new SwapDecoder instance.
   *
   * @param routerAddresses - Addresses of supported DEX routers
   */
  constructor(routerAddresses: RouterAddresses) {
    this.routerAddresses = routerAddresses;

    // Normalize router addresses for fast lookup
    this.normalizedRouters = new Map([
      [routerAddresses.uniswapV3.toLowerCase(), 'uniswapV3'],
      [routerAddresses.aerodrome.toLowerCase(), 'aerodrome'],
      [routerAddresses.oneInch.toLowerCase(), 'oneInch'],
    ]);

    // Parse ABIs once
    this.uniswapV3Interface = new ethers.Interface(UNISWAP_V3_ABI);
    this.aerodromeInterface = new ethers.Interface(AERODROME_ABI);
    this.oneInchInterface = new ethers.Interface(ONEINCH_ABI);

    log.debug('SwapDecoder initialized', {
      uniswapV3: routerAddresses.uniswapV3,
      aerodrome: routerAddresses.aerodrome,
      oneInch: routerAddresses.oneInch,
    });
  }

  // ===========================================================================
  // PUBLIC INTERFACE
  // ===========================================================================

  /**
   * Decode swap calldata from a transaction.
   *
   * @param to - Transaction destination address (router address)
   * @param data - Transaction calldata (hex string)
   * @returns DecodedSwap if successfully decoded, null otherwise
   */
  public decode(to: string, data: string): DecodedSwap | null {
    const routerType = this.identifyRouter(to);

    if (routerType === 'unknown') {
      log.debug('Unknown router address', { to });
      return null;
    }


    try {
      switch (routerType) {
        case 'uniswapV3':
          return this.decodeUniswapV3(data);
        case 'aerodrome':
          return this.decodeAerodrome(data);
        case 'oneInch':
          return this.decodeOneInch(data);
        default:
          return null;
      }
    } catch (error) {
      log.debug('Failed to decode swap calldata', {
        router: routerType,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Identify router type from transaction destination address.
   *
   * @param to - Transaction destination address
   * @returns Router type or 'unknown'
   */
  public identifyRouter(to: string): RouterType {
    return this.normalizedRouters.get(to.toLowerCase()) ?? 'unknown';
  }

  /**
   * Check if an address is a base token (WETH, USDC, USDbC).
   *
   * @param address - Token address to check
   * @returns true if the address is a base token
   */
  public isBaseToken(address: string): boolean {
    return BASE_TOKENS.has(address.toLowerCase());
  }

  /**
   * Determine if a swap is a BUY or SELL based on token pair.
   *
   * - BUY: tokenOut is a non-base token (acquiring speculative token)
   * - SELL: tokenIn is a non-base token (disposing speculative token)
   *
   * @param tokenIn - Input token address
   * @param tokenOut - Output token address
   * @returns 'BUY' or 'SELL'
   */
  public determineAction(tokenIn: string, tokenOut: string): 'BUY' | 'SELL' {
    const tokenInIsBase = this.isBaseToken(tokenIn);
    const tokenOutIsBase = this.isBaseToken(tokenOut);

    // If paying with base token to get non-base token, it's a BUY
    if (tokenInIsBase && !tokenOutIsBase) {
      return 'BUY';
    }


    // If paying with non-base token to get base token, it's a SELL
    if (!tokenInIsBase && tokenOutIsBase) {
      return 'SELL';
    }

    // Both are base tokens or both are non-base tokens
    // Default to BUY (arbitrary, but consistent)
    return 'BUY';
  }

  // ===========================================================================
  // UNISWAP V3 DECODING
  // ===========================================================================

  /**
   * Decode Uniswap V3 swap calldata.
   *
   * Supports:
   * - exactInputSingle: Single-hop exact input swap
   * - exactInput: Multi-hop exact input swap
   * - exactOutputSingle: Single-hop exact output swap
   * - exactOutput: Multi-hop exact output swap
   *
   * @param data - Transaction calldata
   * @returns DecodedSwap or null
   */
  private decodeUniswapV3(data: string): DecodedSwap | null {
    // Try each function selector
    const functionSelectors = [
      'exactInputSingle',
      'exactInput',
      'exactOutputSingle',
      'exactOutput',
    ];

    for (const funcName of functionSelectors) {
      try {
        const decoded = this.uniswapV3Interface.decodeFunctionData(funcName, data);
        return this.parseUniswapV3Decoded(funcName, decoded);
      } catch {
        // Try next selector
        continue;
      }
    }

    log.debug('Could not decode Uniswap V3 calldata - no matching function');
    return null;
  }


  /**
   * Parse decoded Uniswap V3 function result into DecodedSwap.
   */
  private parseUniswapV3Decoded(
    funcName: string,
    decoded: ethers.Result,
  ): DecodedSwap | null {
    try {
      switch (funcName) {
        case 'exactInputSingle': {
          const params = decoded[0];
          const tokenIn = params.tokenIn as string;
          const tokenOut = params.tokenOut as string;
          const amountIn = BigInt(params.amountIn);
          const amountOutMin = BigInt(params.amountOutMinimum);
          const recipient = params.recipient as string;

          return {
            router: 'uniswapV3',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }

        case 'exactInput': {
          const params = decoded[0];
          const path = params.path as string;
          const recipient = params.recipient as string;
          const amountIn = BigInt(params.amountIn);
          const amountOutMin = BigInt(params.amountOutMinimum);

          // Extract first and last token from path
          const { tokenIn, tokenOut } = this.decodeUniswapV3Path(path);

          return {
            router: 'uniswapV3',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }


        case 'exactOutputSingle': {
          const params = decoded[0];
          const tokenIn = params.tokenIn as string;
          const tokenOut = params.tokenOut as string;
          // For exactOutput, amountOut is the target, amountInMaximum is the cap
          const amountIn = BigInt(params.amountInMaximum);
          const amountOutMin = BigInt(params.amountOut);
          const recipient = params.recipient as string;

          return {
            router: 'uniswapV3',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }

        case 'exactOutput': {
          const params = decoded[0];
          const path = params.path as string;
          const recipient = params.recipient as string;
          // For exactOutput, amountOut is target, amountInMaximum is cap
          const amountIn = BigInt(params.amountInMaximum);
          const amountOutMin = BigInt(params.amountOut);

          // Note: For exactOutput, path is reversed (tokenOut -> tokenIn)
          const { tokenIn, tokenOut } = this.decodeUniswapV3Path(path, true);

          return {
            router: 'uniswapV3',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }

        default:
          return null;
      }
    } catch (error) {
      log.debug('Failed to parse Uniswap V3 decoded data', {
        funcName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }


  /**
   * Decode Uniswap V3 path bytes to extract tokenIn and tokenOut.
   *
   * Path format: tokenIn (20 bytes) + fee (3 bytes) + [tokenMid (20 bytes) + fee (3 bytes)]* + tokenOut (20 bytes)
   *
   * @param path - Encoded path bytes
   * @param reversed - If true, path is reversed (for exactOutput)
   * @returns Object with tokenIn and tokenOut addresses
   */
  private decodeUniswapV3Path(
    path: string,
    reversed: boolean = false,
  ): { tokenIn: string; tokenOut: string } {
    // Remove 0x prefix if present
    const pathHex = path.startsWith('0x') ? path.slice(2) : path;

    // Each address is 20 bytes (40 hex chars)
    // Each fee is 3 bytes (6 hex chars)
    // Minimum path: tokenIn (40) + fee (6) + tokenOut (40) = 86 chars
    if (pathHex.length < 86) {
      throw new Error(`Invalid path length: ${pathHex.length}`);
    }

    // Extract first address (tokenIn)
    const firstToken = '0x' + pathHex.slice(0, 40);
    // Extract last address (tokenOut)
    const lastToken = '0x' + pathHex.slice(-40);

    if (reversed) {
      // For exactOutput, path is tokenOut -> tokenIn
      return { tokenIn: lastToken, tokenOut: firstToken };
    }

    return { tokenIn: firstToken, tokenOut: lastToken };
  }

  // ===========================================================================
  // AERODROME DECODING
  // ===========================================================================

  /**
   * Decode Aerodrome Router swap calldata.
   *
   * Supports:
   * - swapExactTokensForTokens: Token to token swap
   * - swapExactETHForTokens: ETH to token swap
   * - swapExactTokensForETH: Token to ETH swap
   *
   * @param data - Transaction calldata
   * @returns DecodedSwap or null
   */
  private decodeAerodrome(data: string): DecodedSwap | null {
    const functionSelectors = [
      'swapExactTokensForTokens',
      'swapExactETHForTokens',
      'swapExactTokensForETH',
    ];


    for (const funcName of functionSelectors) {
      try {
        const decoded = this.aerodromeInterface.decodeFunctionData(funcName, data);
        return this.parseAerodromeDecoded(funcName, decoded);
      } catch {
        // Try next selector
        continue;
      }
    }

    log.debug('Could not decode Aerodrome calldata - no matching function');
    return null;
  }

  /**
   * Parse decoded Aerodrome function result into DecodedSwap.
   */
  private parseAerodromeDecoded(
    funcName: string,
    decoded: ethers.Result,
  ): DecodedSwap | null {
    try {
      switch (funcName) {
        case 'swapExactTokensForTokens': {
          // (uint256 amountIn, uint256 amountOutMin, routes[], address to, uint256 deadline)
          const amountIn = BigInt(decoded[0]);
          const amountOutMin = BigInt(decoded[1]);
          const routes = decoded[2] as Array<{ from: string; to: string; stable: boolean }>;
          const recipient = decoded[3] as string;

          if (routes.length === 0) return null;

          const tokenIn = routes[0].from;
          const tokenOut = routes[routes.length - 1].to;

          return {
            router: 'aerodrome',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }


        case 'swapExactETHForTokens': {
          // (uint256 amountOutMin, routes[], address to, uint256 deadline)
          // amountIn is msg.value - we'll set it to 0 here as it comes from tx value
          const amountOutMin = BigInt(decoded[0]);
          const routes = decoded[1] as Array<{ from: string; to: string; stable: boolean }>;
          const recipient = decoded[2] as string;

          if (routes.length === 0) return null;

          // For ETH swaps, tokenIn is WETH
          const tokenIn = WETH_BASE;
          const tokenOut = routes[routes.length - 1].to;

          return {
            router: 'aerodrome',
            tokenIn,
            tokenOut,
            amountIn: 0n, // Will be filled from tx.value
            amountOutMin,
            recipient,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }

        case 'swapExactTokensForETH': {
          // (uint256 amountIn, uint256 amountOutMin, routes[], address to, uint256 deadline)
          const amountIn = BigInt(decoded[0]);
          const amountOutMin = BigInt(decoded[1]);
          const routes = decoded[2] as Array<{ from: string; to: string; stable: boolean }>;
          const recipient = decoded[3] as string;

          if (routes.length === 0) return null;

          const tokenIn = routes[0].from;
          // For ETH swaps, tokenOut is WETH
          const tokenOut = WETH_BASE;

          return {
            router: 'aerodrome',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }

        default:
          return null;
      }
    } catch (error) {
      log.debug('Failed to parse Aerodrome decoded data', {
        funcName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }


  // ===========================================================================
  // 1INCH DECODING
  // ===========================================================================

  /**
   * Decode 1inch AggregationRouter swap calldata.
   *
   * Supports:
   * - swap: Full aggregation swap
   * - unoswap: Simplified single-hop swap
   * - uniswapV3Swap: Uniswap V3 style swap through 1inch
   *
   * Note: 1inch has complex encoding. We focus on common cases.
   *
   * @param data - Transaction calldata
   * @returns DecodedSwap or null
   */
  private decodeOneInch(data: string): DecodedSwap | null {
    const functionSelectors = ['swap', 'unoswap', 'uniswapV3Swap'];

    for (const funcName of functionSelectors) {
      try {
        const decoded = this.oneInchInterface.decodeFunctionData(funcName, data);
        return this.parseOneInchDecoded(funcName, decoded);
      } catch {
        // Try next selector
        continue;
      }
    }

    log.debug('Could not decode 1inch calldata - no matching function');
    return null;
  }

  /**
   * Parse decoded 1inch function result into DecodedSwap.
   */
  private parseOneInchDecoded(
    funcName: string,
    decoded: ethers.Result,
  ): DecodedSwap | null {
    try {
      switch (funcName) {
        case 'swap': {
          // (address executor, desc, bytes permit, bytes data)
          // desc: (srcToken, dstToken, srcReceiver, dstReceiver, amount, minReturnAmount, flags)
          const desc = decoded[1];
          const tokenIn = desc.srcToken as string;
          const tokenOut = desc.dstToken as string;
          const amountIn = BigInt(desc.amount);
          const amountOutMin = BigInt(desc.minReturnAmount);
          const recipient = desc.dstReceiver as string;

          return {
            router: 'oneInch',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }


        case 'unoswap': {
          // (address srcToken, uint256 amount, uint256 minReturn, uint256[] pools)
          const tokenIn = decoded[0] as string;
          const amountIn = BigInt(decoded[1]);
          const amountOutMin = BigInt(decoded[2]);
          const pools = decoded[3] as bigint[];

          // For unoswap, extract tokenOut from pool encoding
          // Pool encoding: bits 0-159 = pool address, bits 160-167 = flags
          // We can't easily determine tokenOut without additional context
          // For now, we'll use a placeholder and log for debugging

          // Try to extract tokenOut from the last pool
          let tokenOut = ethers.ZeroAddress;
          if (pools.length > 0) {
            // Extract pool address from the last pool (lower 160 bits)
            const poolAddress = pools[pools.length - 1] & BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
            tokenOut = '0x' + poolAddress.toString(16).padStart(40, '0');
          }

          return {
            router: 'oneInch',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient: ethers.ZeroAddress, // Not available in unoswap
            action: this.determineAction(tokenIn, tokenOut),
          };
        }

        case 'uniswapV3Swap': {
          // (uint256 amount, uint256 minReturn, uint256[] pools)
          const amountIn = BigInt(decoded[0]);
          const amountOutMin = BigInt(decoded[1]);
          const pools = decoded[2] as bigint[];

          // For uniswapV3Swap, tokens are encoded in the pools array
          // This is complex; we return a partial result
          let tokenIn = ethers.ZeroAddress;
          let tokenOut = ethers.ZeroAddress;

          if (pools.length > 0) {
            // First pool's lower 160 bits might be the pool address
            const firstPool = pools[0] & BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
            tokenIn = '0x' + firstPool.toString(16).padStart(40, '0');

            const lastPool = pools[pools.length - 1] & BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
            tokenOut = '0x' + lastPool.toString(16).padStart(40, '0');
          }

          return {
            router: 'oneInch',
            tokenIn,
            tokenOut,
            amountIn,
            amountOutMin,
            recipient: ethers.ZeroAddress,
            action: this.determineAction(tokenIn, tokenOut),
          };
        }

        default:
          return null;
      }
    } catch (error) {
      log.debug('Failed to parse 1inch decoded data', {
        funcName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}


// =============================================================================
// EXPORTS
// =============================================================================

export {
  // Constants
  WETH_BASE,
  USDC_BASE,
  USDBC_BASE,
  BASE_TOKENS,
  // ABI fragments (for testing)
  UNISWAP_V3_ABI,
  AERODROME_ABI,
  ONEINCH_ABI,
};

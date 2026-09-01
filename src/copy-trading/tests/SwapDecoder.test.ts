/**
 * @fileoverview Unit tests for SwapDecoder - Swap Calldata Decoding
 *
 * Tests for Task 7.3: Implementar decodificación de swap calldata
 * Requirements: 2.4, 2.5
 *
 * @module copy-trading/tests/SwapDecoder.test
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { ethers } from 'ethers';
import {
  SwapDecoder,
  WETH_BASE,
  USDC_BASE,
  USDBC_BASE,
  BASE_TOKENS,
  UNISWAP_V3_ABI,
  AERODROME_ABI,
  type DecodedSwap,
  type RouterAddresses,
} from '../modules/SwapDecoder.js';

// =============================================================================
// TEST CONSTANTS
// =============================================================================

/** Test router addresses */
const TEST_ROUTERS: RouterAddresses = {
  uniswapV3: '0x2626664c2603336E57B271c5C0b26F421741e481',
  aerodrome: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
  oneInch: '0x1111111254EEB25477B68fb85Ed929f73A960582',
};

/** Sample token addresses for testing - using valid checksummed addresses */
const VALID_TEST_TOKENS = {
  RANDOM_TOKEN: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI on Base
  ANOTHER_TOKEN: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', // AERO on Base
};

/** Pre-built interfaces for encoding test data */
let uniswapV3Interface: ethers.Interface;
let aerodromeInterface: ethers.Interface;

beforeAll(() => {
  uniswapV3Interface = new ethers.Interface(UNISWAP_V3_ABI);
  aerodromeInterface = new ethers.Interface(AERODROME_ABI);
});


// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Encode a Uniswap V3 path for multi-hop swaps.
 * Path format: tokenIn (20 bytes) + fee (3 bytes) + tokenOut (20 bytes)
 */
function encodeUniswapV3Path(
  tokens: string[],
  fees: number[],
): string {
  let path = '';
  for (let i = 0; i < tokens.length; i++) {
    // Add token address (20 bytes, no 0x prefix)
    path += tokens[i].slice(2).toLowerCase();
    // Add fee if not the last token (3 bytes)
    if (i < fees.length) {
      path += fees[i].toString(16).padStart(6, '0');
    }
  }
  return '0x' + path;
}

// =============================================================================
// CONSTANTS TESTS
// =============================================================================

describe('SwapDecoder: BASE_TOKENS', () => {
  it('contains WETH_BASE', () => {
    expect(BASE_TOKENS.has(WETH_BASE.toLowerCase())).toBe(true);
  });

  it('contains USDC_BASE', () => {
    expect(BASE_TOKENS.has(USDC_BASE.toLowerCase())).toBe(true);
  });

  it('contains USDBC_BASE', () => {
    expect(BASE_TOKENS.has(USDBC_BASE.toLowerCase())).toBe(true);
  });

  it('has exactly 3 base tokens', () => {
    expect(BASE_TOKENS.size).toBe(3);
  });
});

// =============================================================================
// CONSTRUCTOR TESTS
// =============================================================================

describe('SwapDecoder: constructor', () => {
  it('initializes with provided router addresses', () => {
    const decoder = new SwapDecoder(TEST_ROUTERS);
    expect(decoder.identifyRouter(TEST_ROUTERS.uniswapV3)).toBe('uniswapV3');
    expect(decoder.identifyRouter(TEST_ROUTERS.aerodrome)).toBe('aerodrome');
    expect(decoder.identifyRouter(TEST_ROUTERS.oneInch)).toBe('oneInch');
  });

  it('handles lowercase addresses', () => {
    const decoder = new SwapDecoder(TEST_ROUTERS);
    expect(decoder.identifyRouter(TEST_ROUTERS.uniswapV3.toLowerCase())).toBe('uniswapV3');
  });

  it('handles uppercase addresses', () => {
    const decoder = new SwapDecoder(TEST_ROUTERS);
    expect(decoder.identifyRouter(TEST_ROUTERS.uniswapV3.toUpperCase())).toBe('uniswapV3');
  });
});


// =============================================================================
// ROUTER IDENTIFICATION TESTS
// =============================================================================

describe('SwapDecoder: identifyRouter', () => {
  const decoder = new SwapDecoder(TEST_ROUTERS);

  it('identifies Uniswap V3 router', () => {
    expect(decoder.identifyRouter(TEST_ROUTERS.uniswapV3)).toBe('uniswapV3');
  });

  it('identifies Aerodrome router', () => {
    expect(decoder.identifyRouter(TEST_ROUTERS.aerodrome)).toBe('aerodrome');
  });

  it('identifies 1inch router', () => {
    expect(decoder.identifyRouter(TEST_ROUTERS.oneInch)).toBe('oneInch');
  });

  it('returns unknown for unrecognized address', () => {
    expect(decoder.identifyRouter('0x0000000000000000000000000000000000000000')).toBe('unknown');
  });

  it('returns unknown for random address', () => {
    expect(decoder.identifyRouter(VALID_TEST_TOKENS.RANDOM_TOKEN)).toBe('unknown');
  });
});

// =============================================================================
// BASE TOKEN IDENTIFICATION TESTS
// =============================================================================

describe('SwapDecoder: isBaseToken', () => {
  const decoder = new SwapDecoder(TEST_ROUTERS);

  it('identifies WETH as base token', () => {
    expect(decoder.isBaseToken(WETH_BASE)).toBe(true);
  });

  it('identifies USDC as base token', () => {
    expect(decoder.isBaseToken(USDC_BASE)).toBe(true);
  });

  it('identifies USDbC as base token', () => {
    expect(decoder.isBaseToken(USDBC_BASE)).toBe(true);
  });

  it('handles lowercase addresses', () => {
    expect(decoder.isBaseToken(WETH_BASE.toLowerCase())).toBe(true);
  });

  it('handles uppercase addresses', () => {
    expect(decoder.isBaseToken(WETH_BASE.toUpperCase())).toBe(true);
  });

  it('returns false for non-base tokens', () => {
    expect(decoder.isBaseToken(VALID_TEST_TOKENS.RANDOM_TOKEN)).toBe(false);
  });

  it('returns false for zero address', () => {
    expect(decoder.isBaseToken(ethers.ZeroAddress)).toBe(false);
  });
});


// =============================================================================
// ACTION DETERMINATION TESTS
// =============================================================================

describe('SwapDecoder: determineAction', () => {
  const decoder = new SwapDecoder(TEST_ROUTERS);

  it('returns BUY when swapping base token for non-base token', () => {
    // WETH -> RANDOM_TOKEN = BUY (acquiring speculative token)
    expect(decoder.determineAction(WETH_BASE, VALID_TEST_TOKENS.RANDOM_TOKEN)).toBe('BUY');
    expect(decoder.determineAction(USDC_BASE, VALID_TEST_TOKENS.RANDOM_TOKEN)).toBe('BUY');
    expect(decoder.determineAction(USDBC_BASE, VALID_TEST_TOKENS.RANDOM_TOKEN)).toBe('BUY');
  });

  it('returns SELL when swapping non-base token for base token', () => {
    // RANDOM_TOKEN -> WETH = SELL (disposing speculative token)
    expect(decoder.determineAction(VALID_TEST_TOKENS.RANDOM_TOKEN, WETH_BASE)).toBe('SELL');
    expect(decoder.determineAction(VALID_TEST_TOKENS.RANDOM_TOKEN, USDC_BASE)).toBe('SELL');
    expect(decoder.determineAction(VALID_TEST_TOKENS.RANDOM_TOKEN, USDBC_BASE)).toBe('SELL');
  });

  it('returns BUY when swapping base token for base token', () => {
    // WETH -> USDC = BUY (default behavior for base-to-base)
    expect(decoder.determineAction(WETH_BASE, USDC_BASE)).toBe('BUY');
    expect(decoder.determineAction(USDC_BASE, WETH_BASE)).toBe('BUY');
  });

  it('returns BUY when swapping non-base for non-base', () => {
    // RANDOM_TOKEN -> ANOTHER_TOKEN = BUY (default)
    expect(decoder.determineAction(VALID_TEST_TOKENS.RANDOM_TOKEN, VALID_TEST_TOKENS.ANOTHER_TOKEN)).toBe('BUY');
  });
});

// =============================================================================
// UNISWAP V3: exactInputSingle DECODING TESTS
// =============================================================================

describe('SwapDecoder: Uniswap V3 exactInputSingle', () => {
  const decoder = new SwapDecoder(TEST_ROUTERS);

  it('decodes exactInputSingle swap (BUY)', () => {
    // Encode exactInputSingle calldata
    const params = {
      tokenIn: WETH_BASE,
      tokenOut: VALID_TEST_TOKENS.RANDOM_TOKEN,
      fee: 3000,
      recipient: '0x1234567890123456789012345678901234567890',
      amountIn: ethers.parseEther('1.0'),
      amountOutMinimum: ethers.parseUnits('1000', 18),
      sqrtPriceLimitX96: 0n,
    };

    const calldata = uniswapV3Interface.encodeFunctionData('exactInputSingle', [params]);
    const result = decoder.decode(TEST_ROUTERS.uniswapV3, calldata);

    expect(result).not.toBeNull();
    expect(result!.router).toBe('uniswapV3');
    expect(result!.tokenIn.toLowerCase()).toBe(WETH_BASE.toLowerCase());
    expect(result!.tokenOut.toLowerCase()).toBe(VALID_TEST_TOKENS.RANDOM_TOKEN.toLowerCase());
    expect(result!.amountIn).toBe(ethers.parseEther('1.0'));
    expect(result!.amountOutMin).toBe(ethers.parseUnits('1000', 18));
    expect(result!.action).toBe('BUY');
  });


  it('decodes exactInputSingle swap (SELL)', () => {
    const params = {
      tokenIn: VALID_TEST_TOKENS.RANDOM_TOKEN,
      tokenOut: WETH_BASE,
      fee: 3000,
      recipient: '0x1234567890123456789012345678901234567890',
      amountIn: ethers.parseUnits('1000', 18),
      amountOutMinimum: ethers.parseEther('0.9'),
      sqrtPriceLimitX96: 0n,
    };

    const calldata = uniswapV3Interface.encodeFunctionData('exactInputSingle', [params]);
    const result = decoder.decode(TEST_ROUTERS.uniswapV3, calldata);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('SELL');
    expect(result!.tokenIn.toLowerCase()).toBe(VALID_TEST_TOKENS.RANDOM_TOKEN.toLowerCase());
    expect(result!.tokenOut.toLowerCase()).toBe(WETH_BASE.toLowerCase());
  });

  it('extracts recipient correctly', () => {
    const recipient = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';
    const params = {
      tokenIn: WETH_BASE,
      tokenOut: VALID_TEST_TOKENS.RANDOM_TOKEN,
      fee: 3000,
      recipient,
      amountIn: ethers.parseEther('1.0'),
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const calldata = uniswapV3Interface.encodeFunctionData('exactInputSingle', [params]);
    const result = decoder.decode(TEST_ROUTERS.uniswapV3, calldata);

    expect(result).not.toBeNull();
    expect(result!.recipient.toLowerCase()).toBe(recipient.toLowerCase());
  });
});

// =============================================================================
// UNISWAP V3: exactInput (MULTI-HOP) DECODING TESTS
// =============================================================================

describe('SwapDecoder: Uniswap V3 exactInput (multi-hop)', () => {
  const decoder = new SwapDecoder(TEST_ROUTERS);

  it('decodes exactInput multi-hop swap', () => {
    // Path: WETH -> USDC -> RANDOM_TOKEN
    const path = encodeUniswapV3Path(
      [WETH_BASE, USDC_BASE, VALID_TEST_TOKENS.RANDOM_TOKEN],
      [3000, 500],
    );

    const params = {
      path,
      recipient: '0x1234567890123456789012345678901234567890',
      amountIn: ethers.parseEther('1.0'),
      amountOutMinimum: ethers.parseUnits('500', 18),
    };

    const calldata = uniswapV3Interface.encodeFunctionData('exactInput', [params]);
    const result = decoder.decode(TEST_ROUTERS.uniswapV3, calldata);

    expect(result).not.toBeNull();
    expect(result!.router).toBe('uniswapV3');
    expect(result!.tokenIn.toLowerCase()).toBe(WETH_BASE.toLowerCase());
    expect(result!.tokenOut.toLowerCase()).toBe(VALID_TEST_TOKENS.RANDOM_TOKEN.toLowerCase());
    expect(result!.amountIn).toBe(ethers.parseEther('1.0'));
    expect(result!.action).toBe('BUY');
  });
});


// =============================================================================
// AERODROME: swapExactTokensForTokens DECODING TESTS
// =============================================================================

describe('SwapDecoder: Aerodrome swapExactTokensForTokens', () => {
  const decoder = new SwapDecoder(TEST_ROUTERS);

  it('decodes swapExactTokensForTokens (BUY)', () => {
    const routes = [
      { from: WETH_BASE, to: VALID_TEST_TOKENS.RANDOM_TOKEN, stable: false },
    ];

    const calldata = aerodromeInterface.encodeFunctionData('swapExactTokensForTokens', [
      ethers.parseEther('1.0'), // amountIn
      ethers.parseUnits('900', 18), // amountOutMin
      routes,
      '0x1234567890123456789012345678901234567890', // recipient
      Math.floor(Date.now() / 1000) + 3600, // deadline
    ]);

    const result = decoder.decode(TEST_ROUTERS.aerodrome, calldata);

    expect(result).not.toBeNull();
    expect(result!.router).toBe('aerodrome');
    expect(result!.tokenIn.toLowerCase()).toBe(WETH_BASE.toLowerCase());
    expect(result!.tokenOut.toLowerCase()).toBe(VALID_TEST_TOKENS.RANDOM_TOKEN.toLowerCase());
    expect(result!.amountIn).toBe(ethers.parseEther('1.0'));
    expect(result!.amountOutMin).toBe(ethers.parseUnits('900', 18));
    expect(result!.action).toBe('BUY');
  });

  it('decodes swapExactTokensForTokens (SELL)', () => {
    const routes = [
      { from: VALID_TEST_TOKENS.RANDOM_TOKEN, to: WETH_BASE, stable: false },
    ];

    const calldata = aerodromeInterface.encodeFunctionData('swapExactTokensForTokens', [
      ethers.parseUnits('1000', 18), // amountIn
      ethers.parseEther('0.9'), // amountOutMin
      routes,
      '0x1234567890123456789012345678901234567890', // recipient
      Math.floor(Date.now() / 1000) + 3600, // deadline
    ]);

    const result = decoder.decode(TEST_ROUTERS.aerodrome, calldata);

    expect(result).not.toBeNull();
    expect(result!.action).toBe('SELL');
    expect(result!.tokenIn.toLowerCase()).toBe(VALID_TEST_TOKENS.RANDOM_TOKEN.toLowerCase());
    expect(result!.tokenOut.toLowerCase()).toBe(WETH_BASE.toLowerCase());
  });

  it('decodes multi-hop Aerodrome swap', () => {
    // WETH -> USDC -> RANDOM_TOKEN
    const routes = [
      { from: WETH_BASE, to: USDC_BASE, stable: true },
      { from: USDC_BASE, to: VALID_TEST_TOKENS.RANDOM_TOKEN, stable: false },
    ];

    const calldata = aerodromeInterface.encodeFunctionData('swapExactTokensForTokens', [
      ethers.parseEther('1.0'),
      ethers.parseUnits('500', 18),
      routes,
      '0x1234567890123456789012345678901234567890',
      Math.floor(Date.now() / 1000) + 3600,
    ]);

    const result = decoder.decode(TEST_ROUTERS.aerodrome, calldata);

    expect(result).not.toBeNull();
    expect(result!.tokenIn.toLowerCase()).toBe(WETH_BASE.toLowerCase());
    expect(result!.tokenOut.toLowerCase()).toBe(VALID_TEST_TOKENS.RANDOM_TOKEN.toLowerCase());
    expect(result!.action).toBe('BUY');
  });
});


// =============================================================================
// ERROR HANDLING TESTS
// =============================================================================

describe('SwapDecoder: Error Handling', () => {
  const decoder = new SwapDecoder(TEST_ROUTERS);

  it('returns null for unknown router address', () => {
    const calldata = '0x1234567890';
    const result = decoder.decode(VALID_TEST_TOKENS.RANDOM_TOKEN, calldata);
    expect(result).toBeNull();
  });

  it('returns null for invalid calldata', () => {
    const result = decoder.decode(TEST_ROUTERS.uniswapV3, '0xinvalid');
    expect(result).toBeNull();
  });

  it('returns null for empty calldata', () => {
    const result = decoder.decode(TEST_ROUTERS.uniswapV3, '0x');
    expect(result).toBeNull();
  });

  it('returns null for unrecognized function selector', () => {
    // Random 4-byte selector that doesn't match any known function
    const calldata = '0xdeadbeef0000000000000000000000000000000000000000';
    const result = decoder.decode(TEST_ROUTERS.uniswapV3, calldata);
    expect(result).toBeNull();
  });

  it('returns null for malformed Uniswap V3 calldata', () => {
    // Valid selector but invalid params
    const calldata = '0x04e45aaf'; // exactInputSingle selector, no params
    const result = decoder.decode(TEST_ROUTERS.uniswapV3, calldata);
    expect(result).toBeNull();
  });
});

// =============================================================================
// INTEGRATION TESTS
// =============================================================================

describe('SwapDecoder: Integration Tests', () => {
  const decoder = new SwapDecoder(TEST_ROUTERS);

  it('handles mixed case router addresses', () => {
    const params = {
      tokenIn: WETH_BASE,
      tokenOut: VALID_TEST_TOKENS.RANDOM_TOKEN,
      fee: 3000,
      recipient: '0x1234567890123456789012345678901234567890',
      amountIn: ethers.parseEther('1.0'),
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    const calldata = uniswapV3Interface.encodeFunctionData('exactInputSingle', [params]);

    // Test with lowercase
    const result1 = decoder.decode(TEST_ROUTERS.uniswapV3.toLowerCase(), calldata);
    expect(result1).not.toBeNull();

    // Test with uppercase
    const result2 = decoder.decode(TEST_ROUTERS.uniswapV3.toUpperCase(), calldata);
    expect(result2).not.toBeNull();
  });

  it('correctly determines action for all base token combinations', () => {
    // Test WETH -> non-base = BUY
    expect(decoder.determineAction(WETH_BASE, VALID_TEST_TOKENS.RANDOM_TOKEN)).toBe('BUY');
    
    // Test USDC -> non-base = BUY
    expect(decoder.determineAction(USDC_BASE, VALID_TEST_TOKENS.RANDOM_TOKEN)).toBe('BUY');
    
    // Test USDbC -> non-base = BUY
    expect(decoder.determineAction(USDBC_BASE, VALID_TEST_TOKENS.RANDOM_TOKEN)).toBe('BUY');
    
    // Test non-base -> WETH = SELL
    expect(decoder.determineAction(VALID_TEST_TOKENS.RANDOM_TOKEN, WETH_BASE)).toBe('SELL');
    
    // Test non-base -> USDC = SELL
    expect(decoder.determineAction(VALID_TEST_TOKENS.RANDOM_TOKEN, USDC_BASE)).toBe('SELL');
    
    // Test non-base -> USDbC = SELL
    expect(decoder.determineAction(VALID_TEST_TOKENS.RANDOM_TOKEN, USDBC_BASE)).toBe('SELL');
  });
});

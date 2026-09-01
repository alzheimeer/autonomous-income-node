/**
 * Rug Alert Service — Contract ABIs
 *
 * Minimal ABI fragments used by the on-chain detection components.
 * All calls are read-only (staticCall / event subscription) — no gas is spent.
 *
 * Requirements: 1.1, 2.1, 3.1
 */

// ═══════════════════════════════════════════════════════════════════════════
// Uniswap V2 / Aerodrome pool reserves ABI
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ABI for reading pool reserve balances and token slot mapping.
 *
 * Used by LiquidityMonitor to:
 *  - Fetch `reserve0` / `reserve1` on each poll tick via `getReserves()`
 *  - Determine which reserve slot holds USDC/WETH via `token0()` / `token1()`
 *    (called once at trackPosition time and cached in PoolRecord)
 *
 * Compatible with Uniswap V2 and Aerodrome (fork) pool contracts.
 */
export const RESERVES_ABI = [
  {
    name: 'getReserves',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'reserve0', type: 'uint112' },
      { name: 'reserve1', type: 'uint112' },
      { name: 'blockTimestampLast', type: 'uint32' },
    ],
  },
  {
    name: 'token0',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
  {
    name: 'token1',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'address' }],
  },
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// ERC-20 Transfer event + balanceOf + totalSupply ABI
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ABI for monitoring ERC-20 Transfer events and querying token balances.
 *
 * Used by LpRemovalDetector and LargeHolderSellDetector to:
 *  - Subscribe to `Transfer(from, to, value)` events on LP token / token contracts
 *  - Query `balanceOf(address)` for specific wallet balances when needed
 *  - Query `totalSupply()` to compute transfer percentage thresholds
 */
export const ERC20_TRANSFER_ABI = [
  {
    name: 'Transfer',
    type: 'event',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

// ═══════════════════════════════════════════════════════════════════════════
// ERC-20 totalSupply-only ABI
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Minimal ABI for fetching only the `totalSupply()` of an ERC-20 token.
 *
 * Used by LargeHolderSellDetector to refresh the cached total supply on a
 * 60-second interval without needing the full Transfer ABI.
 */
export const ERC20_SUPPLY_ABI = [
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

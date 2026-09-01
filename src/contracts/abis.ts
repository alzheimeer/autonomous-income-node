/**
 * Contract ABIs and address constants for Base mainnet (Chain ID: 8453).
 * Used across trading, lending, and LP modules.
 */

// ── Chain Configuration ───────────────────────────────────────────────────
export const BASE_CHAIN_ID = 8453;

// ── Contract Addresses (Base Mainnet) ─────────────────────────────────────
export const SWAP_ROUTER_ADDRESS = '0x2626664c2603336E57B271c5C0b26F421741e481';
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const WETH_BASE = '0x4200000000000000000000000000000000000006';
export const USDB_C_BASE = '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA';
export const AAVE_V3_POOL_ADDRESS = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
export const A_USDC_ADDRESS = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
export const NONFUNGIBLE_POSITION_MANAGER_ADDRESS = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
export const UNISWAP_V3_FACTORY_ADDRESS = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
export const AGENT_WALLET = '0xae36889c670CaA446bE18ECdC96f7c882e601D81';

// ── SwapRouter02 (Base — NO deadline in struct for this router version) ──
export const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
] as const;

// ── Uniswap V3 Factory ────────────────────────────────────────────────────
export const UNISWAP_FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
] as const;

// ── Uniswap V3 Pool (for liquidity query) ─────────────────────────────────
export const UNISWAP_POOL_ABI = [
  'function liquidity() external view returns (uint128)',
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
] as const;

// ── Aave V3 Pool ──────────────────────────────────────────────────────────
export const AAVE_V3_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
  'function getReserveData(address asset) external view returns (tuple(uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))',
] as const;

// ── ERC-20 (Approve + Balance) ────────────────────────────────────────────
export const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function balanceOf(address account) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
] as const;

// ── NonfungiblePositionManager (Uniswap v3 LP) ───────────────────────────
export const NONFUNGIBLE_POSITION_MANAGER_ABI = [
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
] as const;

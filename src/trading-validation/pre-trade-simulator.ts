/**
 * Pre-Trade Simulator - eth_call simulation before every broadcast
 *
 * Simulates ERC-20 approvals, Uniswap V3 swaps, and Aave V3 withdrawals
 * via eth_call before broadcasting transactions. Returns decoded revert
 * reasons on failure. Enforces gas category budgets and re-evaluates
 * through gate if quote drifts > 20 bps from gate evaluation.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5
 */

import type { UsdcAmount } from './types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════

/** Result of a pre-trade simulation via eth_call */
export interface SimulationResult {
  success: boolean;
  gasUsed: bigint;
  revertReason?: string;
  returnData?: string;
}

/** Gas category for budget enforcement */
export type GasCategory = 'entry' | 'safety_exit' | 'init';

/** Gas budget limits by category (in USDC 6 decimals) */
export const GAS_BUDGET_LIMITS: Record<GasCategory, UsdcAmount> = {
  entry: 50_000n,        // $0.05
  safety_exit: 100_000n, // $0.10
  init: 100_000n,        // $0.10
};

/** Parameters for simulating a Uniswap V3 exactInputSingle swap */
export interface SwapSimulationParams {
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
}

/**
 * Provider interface for making eth_call simulations.
 * Decoupled from direct ethers dependency for testability.
 */
export interface ISimulationProvider {
  /** Execute eth_call and return raw result or throw with revert data */
  ethCall(params: EthCallParams): Promise<EthCallResult>;
}

/** Parameters for an eth_call */
export interface EthCallParams {
  to: string;
  from: string;
  data: string;
}

/** Result of an eth_call */
export interface EthCallResult {
  data: string;
  gasUsed: bigint;
}

/**
 * Gas price provider for converting gas units to USD cost.
 */
export interface ISimulationGasPriceProvider {
  /** Returns current gas price in wei */
  getGasPrice(): Promise<bigint>;
  /** Returns current ETH/USD price for conversion */
  getEthUsdPrice(): number;
}

/**
 * Pre-Trade Simulator interface.
 * Simulates transactions via eth_call before broadcast.
 */
export interface IPreTradeSimulator {
  /** Simulate ERC-20 approve(spender, amount) */
  simulateApproval(token: string, spender: string, amount: bigint): Promise<SimulationResult>;
  /** Simulate Uniswap V3 exactInputSingle swap */
  simulateSwap(params: SwapSimulationParams): Promise<SimulationResult>;
  /** Simulate Aave V3 Pool withdraw(asset, amount, to) */
  simulateWithdrawal(asset: string, amount: bigint): Promise<SimulationResult>;
  /** Check if gas cost is within budget for the given category */
  isWithinGasBudget(gasUsed: bigint, category: GasCategory): Promise<boolean>;
  /** Check if quote drifted > 20 bps from gate evaluation */
  hasQuoteDrifted(gateAmountOut: bigint, currentAmountOut: bigint): boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// ABI Encoding Helpers
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Encodes ERC-20 approve(address spender, uint256 amount) calldata.
 * Function selector: 0x095ea7b3
 */
export function encodeApprove(spender: string, amount: bigint): string {
  const selector = '095ea7b3';
  const paddedSpender = spender.slice(2).toLowerCase().padStart(64, '0');
  const paddedAmount = amount.toString(16).padStart(64, '0');
  return `0x${selector}${paddedSpender}${paddedAmount}`;
}

/**
 * Encodes Uniswap V3 SwapRouter02 exactInputSingle calldata.
 * On Base, the struct does NOT include deadline.
 * Function selector: 0x04e45aaf
 * Params: (tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96)
 */
export function encodeExactInputSingle(params: SwapSimulationParams): string {
  const selector = '04e45aaf';
  const paddedTokenIn = params.tokenIn.slice(2).toLowerCase().padStart(64, '0');
  const paddedTokenOut = params.tokenOut.slice(2).toLowerCase().padStart(64, '0');
  const paddedFee = params.fee.toString(16).padStart(64, '0');
  const paddedRecipient = params.recipient.slice(2).toLowerCase().padStart(64, '0');
  const paddedAmountIn = params.amountIn.toString(16).padStart(64, '0');
  const paddedAmountOutMin = params.amountOutMinimum.toString(16).padStart(64, '0');
  const paddedSqrtPrice = params.sqrtPriceLimitX96.toString(16).padStart(64, '0');
  return `0x${selector}${paddedTokenIn}${paddedTokenOut}${paddedFee}${paddedRecipient}${paddedAmountIn}${paddedAmountOutMin}${paddedSqrtPrice}`;
}

/**
 * Encodes Aave V3 Pool withdraw(address asset, uint256 amount, address to) calldata.
 * Function selector: 0x69328dec
 */
export function encodeWithdraw(asset: string, amount: bigint, to: string): string {
  const selector = '69328dec';
  const paddedAsset = asset.slice(2).toLowerCase().padStart(64, '0');
  const paddedAmount = amount.toString(16).padStart(64, '0');
  const paddedTo = to.slice(2).toLowerCase().padStart(64, '0');
  return `0x${selector}${paddedAsset}${paddedAmount}${paddedTo}`;
}

/**
 * Attempts to decode a revert reason from raw error data.
 * Supports Error(string) format: 0x08c379a0 + offset + length + utf8
 * Also supports Panic(uint256): 0x4e487b71
 * Falls back to raw hex if unrecognized.
 */
export function decodeRevertReason(data: string): string {
  if (!data || data === '0x') {
    return 'Unknown revert (empty data)';
  }

  const hex = data.startsWith('0x') ? data.slice(2) : data;

  // Error(string) — selector 08c379a0
  if (hex.startsWith('08c379a0') && hex.length >= 136) {
    try {
      const offsetHex = hex.slice(8, 72);
      const offset = parseInt(offsetHex, 16) * 2; // byte offset → hex char offset
      const lengthStart = 8 + offset;
      const lengthHex = hex.slice(lengthStart, lengthStart + 64);
      const length = parseInt(lengthHex, 16);
      const dataStart = lengthStart + 64;
      const strHex = hex.slice(dataStart, dataStart + length * 2);
      const decoded = hexToUtf8(strHex);
      return decoded || 'Unknown revert (empty string)';
    } catch {
      return `Revert (Error decode failed): 0x${hex.slice(0, 40)}...`;
    }
  }

  // Panic(uint256) — selector 4e487b71
  if (hex.startsWith('4e487b71') && hex.length >= 72) {
    const code = parseInt(hex.slice(8, 72), 16);
    const panicReasons: Record<number, string> = {
      0x00: 'Generic compiler panic',
      0x01: 'Assert failed',
      0x11: 'Arithmetic overflow/underflow',
      0x12: 'Division by zero',
      0x21: 'Enum conversion error',
      0x22: 'Storage encoding error',
      0x31: 'Pop on empty array',
      0x32: 'Array index out of bounds',
      0x41: 'Too much memory allocated',
      0x51: 'Zero-initialized function pointer',
    };
    return `Panic(${code}): ${panicReasons[code] ?? 'Unknown panic code'}`;
  }

  // Custom error or unrecognized
  if (hex.length >= 8) {
    return `Custom error (selector 0x${hex.slice(0, 8)}): 0x${hex.slice(0, Math.min(hex.length, 80))}...`;
  }

  return `Unknown revert: 0x${hex}`;
}

/** Convert hex string to UTF-8 string */
function hexToUtf8(hex: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2) {
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum quote drift in basis points before requiring gate re-evaluation */
const MAX_QUOTE_DRIFT_BPS = 20n;

/** USDC decimals for gas cost conversion */
const USDC_DECIMALS = 6;

/** ETH decimals */
const ETH_DECIMALS = 18;

// ═══════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class PreTradeSimulator implements IPreTradeSimulator {
  private readonly provider: ISimulationProvider;
  private readonly gasProvider: ISimulationGasPriceProvider;
  private readonly walletAddress: string;
  private readonly swapRouterAddress: string;
  private readonly aavePoolAddress: string;

  constructor(
    provider: ISimulationProvider,
    gasProvider: ISimulationGasPriceProvider,
    walletAddress: string,
    swapRouterAddress: string,
    aavePoolAddress: string,
  ) {
    this.provider = provider;
    this.gasProvider = gasProvider;
    this.walletAddress = walletAddress;
    this.swapRouterAddress = swapRouterAddress;
    this.aavePoolAddress = aavePoolAddress;
  }

  /**
   * Simulate ERC-20 approve(spender, amount) via eth_call.
   * Requirement 16.1: simulate with exact parameters before broadcast.
   */
  async simulateApproval(token: string, spender: string, amount: bigint): Promise<SimulationResult> {
    const calldata = encodeApprove(spender, amount);

    try {
      const result = await this.provider.ethCall({
        to: token,
        from: this.walletAddress,
        data: calldata,
      });

      return {
        success: true,
        gasUsed: result.gasUsed,
        returnData: result.data,
      };
    } catch (error) {
      return this.handleSimulationError(error);
    }
  }

  /**
   * Simulate Uniswap V3 exactInputSingle swap via eth_call.
   * On Base, the struct does NOT include deadline.
   * Requirement 16.1, 16.2: verify minAmountOut met, balance sufficient.
   */
  async simulateSwap(params: SwapSimulationParams): Promise<SimulationResult> {
    const calldata = encodeExactInputSingle(params);

    try {
      const result = await this.provider.ethCall({
        to: this.swapRouterAddress,
        from: this.walletAddress,
        data: calldata,
      });

      return {
        success: true,
        gasUsed: result.gasUsed,
        returnData: result.data,
      };
    } catch (error) {
      return this.handleSimulationError(error);
    }
  }

  /**
   * Simulate Aave V3 Pool withdraw(asset, amount, to) via eth_call.
   * Uses init gas category ($0.10 max).
   * Requirement 16.1, 16.3.
   */
  async simulateWithdrawal(asset: string, amount: bigint): Promise<SimulationResult> {
    const calldata = encodeWithdraw(asset, amount, this.walletAddress);

    try {
      const result = await this.provider.ethCall({
        to: this.aavePoolAddress,
        from: this.walletAddress,
        data: calldata,
      });

      return {
        success: true,
        gasUsed: result.gasUsed,
        returnData: result.data,
      };
    } catch (error) {
      return this.handleSimulationError(error);
    }
  }

  /**
   * Check if estimated gas cost is within the budget for a given category.
   * Gas categories: entry=$0.05, safety_exit=$0.10, init=$0.10.
   * Requirement 16.3.
   */
  async isWithinGasBudget(gasUsed: bigint, category: GasCategory): Promise<boolean> {
    const gasPrice = await this.gasProvider.getGasPrice();
    const ethUsdPrice = this.gasProvider.getEthUsdPrice();
    const limit = GAS_BUDGET_LIMITS[category];

    const gasCostWei = gasUsed * gasPrice;
    const gasCostUsdc = weiToUsdc(gasCostWei, ethUsdPrice);

    return gasCostUsdc <= limit;
  }

  /**
   * Check if current quote has drifted > 20 bps from gate evaluation amount.
   * If true, caller should re-evaluate through the gate.
   * Requirement 16.5.
   */
  hasQuoteDrifted(gateAmountOut: bigint, currentAmountOut: bigint): boolean {
    if (gateAmountOut === 0n) return true;

    // Calculate absolute drift in basis points
    const diff = gateAmountOut > currentAmountOut
      ? gateAmountOut - currentAmountOut
      : currentAmountOut - gateAmountOut;

    // drift_bps = (diff * 10000) / gateAmountOut
    const driftBps = (diff * 10_000n) / gateAmountOut;

    return driftBps > MAX_QUOTE_DRIFT_BPS;
  }

  /**
   * Handle simulation error by extracting and decoding revert reason.
   * Requirement 16.4: return decoded revert reason on failure.
   */
  private handleSimulationError(error: unknown): SimulationResult {
    const revertData = extractRevertData(error);
    const revertReason = decodeRevertReason(revertData);

    return {
      success: false,
      gasUsed: 0n,
      revertReason,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utility Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Convert gas cost in wei to USDC amount (6 decimals).
 * Formula: (gasCostWei * ethUsdPrice * 10^USDC_DECIMALS) / 10^ETH_DECIMALS
 */
function weiToUsdc(gasCostWei: bigint, ethUsdPrice: number): UsdcAmount {
  // Use integer math: ethUsdPrice as fixed-point with 8 decimals precision
  const priceFactor = BigInt(Math.round(ethUsdPrice * 1e8));
  const usdcDecimals = BigInt(10 ** USDC_DECIMALS);
  const ethDecimals = BigInt(10 ** ETH_DECIMALS);
  const pricePrecision = BigInt(1e8);

  return (gasCostWei * priceFactor * usdcDecimals) / (ethDecimals * pricePrecision);
}

/**
 * Extract revert data from an error thrown by the provider.
 * Handles various error shapes from ethers v6 and custom providers.
 */
function extractRevertData(error: unknown): string {
  if (error instanceof Error) {
    // ethers v6 CallExceptionError pattern
    const anyError = error as unknown as Record<string, unknown>;
    if (typeof anyError['data'] === 'string') {
      return anyError['data'];
    }
    // Nested error.error.data pattern
    if (anyError['error'] && typeof (anyError['error'] as Record<string, unknown>)['data'] === 'string') {
      return (anyError['error'] as Record<string, unknown>)['data'] as string;
    }
    // Check message for hex data
    const match = error.message.match(/0x[0-9a-fA-F]+/);
    if (match) {
      return match[0];
    }
  }
  return '0x';
}

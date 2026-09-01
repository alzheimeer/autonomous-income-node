/**
 * Unit tests for PreTradeSimulator
 *
 * Tests eth_call simulation for ERC-20 approvals, Uniswap V3 swaps,
 * and Aave V3 withdrawals. Validates gas budget enforcement, quote drift
 * detection, and revert reason decoding.
 *
 * Requirements: 16.1, 16.2, 16.3, 16.4, 16.5
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  PreTradeSimulator,
  GAS_BUDGET_LIMITS,
  encodeApprove,
  encodeExactInputSingle,
  encodeWithdraw,
  decodeRevertReason,
  type ISimulationProvider,
  type ISimulationGasPriceProvider,
  type EthCallParams,
  type EthCallResult,
  type SwapSimulationParams,
} from '../../pre-trade-simulator.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Helpers
// ═══════════════════════════════════════════════════════════════════════════

const WALLET = '0x1234567890abcdef1234567890abcdef12345678';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const SWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const AAVE_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';

function createMockProvider(response?: Partial<EthCallResult>): ISimulationProvider {
  return {
    ethCall: vi.fn().mockResolvedValue({
      data: response?.data ?? '0x0000000000000000000000000000000000000000000000000000000000000001',
      gasUsed: response?.gasUsed ?? 50_000n,
    }),
  };
}

function createRevertingProvider(revertData: string): ISimulationProvider {
  const error = new Error('execution reverted');
  (error as Record<string, unknown>)['data'] = revertData;
  return {
    ethCall: vi.fn().mockRejectedValue(error),
  };
}

function createMockGasProvider(gasPrice = 100_000_000n, ethUsd = 2500): ISimulationGasPriceProvider {
  return {
    getGasPrice: vi.fn().mockResolvedValue(gasPrice),
    getEthUsdPrice: vi.fn().mockReturnValue(ethUsd),
  };
}

function createSimulator(
  provider?: ISimulationProvider,
  gasProvider?: ISimulationGasPriceProvider,
): PreTradeSimulator {
  return new PreTradeSimulator(
    provider ?? createMockProvider(),
    gasProvider ?? createMockGasProvider(),
    WALLET,
    SWAP_ROUTER,
    AAVE_POOL,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests: ABI Encoding
// ═══════════════════════════════════════════════════════════════════════════

describe('ABI Encoding', () => {
  describe('encodeApprove', () => {
    it('should produce correct function selector 0x095ea7b3', () => {
      const result = encodeApprove(SWAP_ROUTER, 1_000_000n);
      expect(result.startsWith('0x095ea7b3')).toBe(true);
    });

    it('should correctly encode spender address (left-padded to 32 bytes)', () => {
      const result = encodeApprove(SWAP_ROUTER, 1_000_000n);
      // Selector (4 bytes = 8 hex) + address padded to 32 bytes (64 hex)
      const spenderSlot = result.slice(10, 74); // skip 0x + selector
      expect(spenderSlot).toContain(SWAP_ROUTER.slice(2).toLowerCase());
    });

    it('should correctly encode amount as uint256', () => {
      const amount = 10_000_000n; // $10 USDC
      const result = encodeApprove(SWAP_ROUTER, amount);
      // Amount is in the second 32-byte slot
      const amountSlot = result.slice(74, 138);
      expect(BigInt('0x' + amountSlot)).toBe(amount);
    });
  });

  describe('encodeExactInputSingle', () => {
    const params: SwapSimulationParams = {
      tokenIn: USDC_ADDRESS,
      tokenOut: WETH_ADDRESS,
      fee: 500,
      recipient: WALLET,
      amountIn: 5_000_000n,
      amountOutMinimum: 2_000_000_000_000_000n,
      sqrtPriceLimitX96: 0n,
    };

    it('should produce correct function selector 0x04e45aaf', () => {
      const result = encodeExactInputSingle(params);
      expect(result.startsWith('0x04e45aaf')).toBe(true);
    });

    it('should have correct total length (selector + 7 params × 32 bytes)', () => {
      const result = encodeExactInputSingle(params);
      // 0x (2) + selector (8) + 7 × 64 = 458 chars
      expect(result.length).toBe(2 + 8 + 7 * 64);
    });

    it('should encode fee correctly', () => {
      const result = encodeExactInputSingle(params);
      // Fee is 3rd param (after tokenIn, tokenOut): offset = 10 + 64 + 64 = 138
      const feeSlot = result.slice(138, 202);
      expect(BigInt('0x' + feeSlot)).toBe(BigInt(params.fee));
    });
  });

  describe('encodeWithdraw', () => {
    it('should produce correct function selector 0x69328dec', () => {
      const result = encodeWithdraw(USDC_ADDRESS, 99_630_000n, WALLET);
      expect(result.startsWith('0x69328dec')).toBe(true);
    });

    it('should have correct total length (selector + 3 params × 32 bytes)', () => {
      const result = encodeWithdraw(USDC_ADDRESS, 99_630_000n, WALLET);
      // 0x (2) + selector (8) + 3 × 64 = 202 chars
      expect(result.length).toBe(2 + 8 + 3 * 64);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: Revert Reason Decoding
// ═══════════════════════════════════════════════════════════════════════════

describe('decodeRevertReason', () => {
  it('should decode Error(string) format', () => {
    // Error("Insufficient balance")
    // Selector: 08c379a0
    // Offset: 0x20 (32)
    // Length: 20 (0x14)
    // Data: "Insufficient balance" in hex
    const text = 'Insufficient balance';
    const textHex = Buffer.from(text).toString('hex');
    const data = '0x08c379a0' +
      '0000000000000000000000000000000000000000000000000000000000000020' + // offset
      '0000000000000000000000000000000000000000000000000000000000000014' + // length = 20
      textHex.padEnd(64, '0'); // padded text
    const result = decodeRevertReason(data);
    expect(result).toBe('Insufficient balance');
  });

  it('should decode Panic(uint256) format', () => {
    // Panic(0x11) = Arithmetic overflow
    const data = '0x4e487b71' +
      '0000000000000000000000000000000000000000000000000000000000000011';
    const result = decodeRevertReason(data);
    expect(result).toContain('Panic(17)');
    expect(result).toContain('Arithmetic overflow');
  });

  it('should handle empty data', () => {
    expect(decodeRevertReason('')).toBe('Unknown revert (empty data)');
    expect(decodeRevertReason('0x')).toBe('Unknown revert (empty data)');
  });

  it('should handle custom error selectors', () => {
    const data = '0xdeadbeef0000000000000000000000000000000000000000';
    const result = decodeRevertReason(data);
    expect(result).toContain('Custom error (selector 0xdeadbeef)');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tests: PreTradeSimulator - Approval Simulation
// ═══════════════════════════════════════════════════════════════════════════

describe('PreTradeSimulator', () => {
  describe('simulateApproval', () => {
    it('should return success=true when eth_call succeeds', async () => {
      const simulator = createSimulator();
      const result = await simulator.simulateApproval(USDC_ADDRESS, SWAP_ROUTER, 10_000_000n);

      expect(result.success).toBe(true);
      expect(result.gasUsed).toBe(50_000n);
      expect(result.revertReason).toBeUndefined();
    });

    it('should call provider with correct parameters', async () => {
      const provider = createMockProvider();
      const simulator = createSimulator(provider);

      await simulator.simulateApproval(USDC_ADDRESS, SWAP_ROUTER, 5_000_000n);

      expect(provider.ethCall).toHaveBeenCalledWith({
        to: USDC_ADDRESS,
        from: WALLET,
        data: expect.stringContaining('095ea7b3'),
      });
    });

    it('should return decoded revert reason on failure', async () => {
      const text = 'ERC20: approve to zero';
      const textHex = Buffer.from(text).toString('hex');
      const revertData = '0x08c379a0' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000016' +
        textHex.padEnd(64, '0');

      const provider = createRevertingProvider(revertData);
      const simulator = createSimulator(provider);
      const result = await simulator.simulateApproval(USDC_ADDRESS, SWAP_ROUTER, 0n);

      expect(result.success).toBe(false);
      expect(result.gasUsed).toBe(0n);
      expect(result.revertReason).toBe('ERC20: approve to zero');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tests: Swap Simulation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('simulateSwap', () => {
    const swapParams: SwapSimulationParams = {
      tokenIn: USDC_ADDRESS,
      tokenOut: WETH_ADDRESS,
      fee: 500,
      recipient: WALLET,
      amountIn: 5_000_000n,
      amountOutMinimum: 2_000_000_000_000_000n,
      sqrtPriceLimitX96: 0n,
    };

    it('should return success=true when eth_call succeeds', async () => {
      const provider = createMockProvider({ gasUsed: 150_000n });
      const simulator = createSimulator(provider);
      const result = await simulator.simulateSwap(swapParams);

      expect(result.success).toBe(true);
      expect(result.gasUsed).toBe(150_000n);
    });

    it('should call swap router address', async () => {
      const provider = createMockProvider();
      const simulator = createSimulator(provider);

      await simulator.simulateSwap(swapParams);

      expect(provider.ethCall).toHaveBeenCalledWith(
        expect.objectContaining({ to: SWAP_ROUTER }),
      );
    });

    it('should encode exactInputSingle selector', async () => {
      const provider = createMockProvider();
      const simulator = createSimulator(provider);

      await simulator.simulateSwap(swapParams);

      const call = (provider.ethCall as ReturnType<typeof vi.fn>).mock.calls[0][0] as EthCallParams;
      expect(call.data.startsWith('0x04e45aaf')).toBe(true);
    });

    it('should return revert reason on swap failure', async () => {
      const provider = createRevertingProvider('0x08c379a0' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000013' +
        Buffer.from('Too little received').toString('hex').padEnd(64, '0'));
      const simulator = createSimulator(provider);

      const result = await simulator.simulateSwap(swapParams);

      expect(result.success).toBe(false);
      expect(result.revertReason).toBe('Too little received');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tests: Withdrawal Simulation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('simulateWithdrawal', () => {
    it('should return success=true when eth_call succeeds', async () => {
      const provider = createMockProvider({ gasUsed: 200_000n });
      const simulator = createSimulator(provider);
      const result = await simulator.simulateWithdrawal(USDC_ADDRESS, 99_630_000n);

      expect(result.success).toBe(true);
      expect(result.gasUsed).toBe(200_000n);
    });

    it('should call Aave Pool address', async () => {
      const provider = createMockProvider();
      const simulator = createSimulator(provider);

      await simulator.simulateWithdrawal(USDC_ADDRESS, 99_630_000n);

      expect(provider.ethCall).toHaveBeenCalledWith(
        expect.objectContaining({ to: AAVE_POOL }),
      );
    });

    it('should encode withdraw selector 0x69328dec', async () => {
      const provider = createMockProvider();
      const simulator = createSimulator(provider);

      await simulator.simulateWithdrawal(USDC_ADDRESS, 99_630_000n);

      const call = (provider.ethCall as ReturnType<typeof vi.fn>).mock.calls[0][0] as EthCallParams;
      expect(call.data.startsWith('0x69328dec')).toBe(true);
    });

    it('should pass wallet address as withdrawal recipient', async () => {
      const provider = createMockProvider();
      const simulator = createSimulator(provider);

      await simulator.simulateWithdrawal(USDC_ADDRESS, 50_000_000n);

      const call = (provider.ethCall as ReturnType<typeof vi.fn>).mock.calls[0][0] as EthCallParams;
      // The 'to' field (3rd param in calldata) should contain wallet address
      expect(call.data.toLowerCase()).toContain(WALLET.slice(2).toLowerCase());
    });

    it('should return revert reason on withdrawal failure', async () => {
      const provider = createRevertingProvider('0x');
      const simulator = createSimulator(provider);

      const result = await simulator.simulateWithdrawal(USDC_ADDRESS, 99_630_000n);

      expect(result.success).toBe(false);
      expect(result.revertReason).toBe('Unknown revert (empty data)');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tests: Gas Budget Validation
  // ═══════════════════════════════════════════════════════════════════════════

  describe('isWithinGasBudget', () => {
    it('should approve entry gas within $0.05 budget', async () => {
      // gas=50000, gasPrice=100_000_000 (0.1 gwei), ETH=$2500
      // cost = 50000 * 100_000_000 = 5_000_000_000_000 wei = 0.000005 ETH = $0.0125
      const gasProvider = createMockGasProvider(100_000_000n, 2500);
      const simulator = createSimulator(undefined, gasProvider);

      const result = await simulator.isWithinGasBudget(50_000n, 'entry');
      expect(result).toBe(true);
    });

    it('should reject entry gas exceeding $0.05 budget', async () => {
      // gas=500000, gasPrice=50_000_000_000 (50 gwei), ETH=$2500
      // cost = 500000 * 50_000_000_000 = 25_000_000_000_000_000 wei = 0.025 ETH = $62.5
      const gasProvider = createMockGasProvider(50_000_000_000n, 2500);
      const simulator = createSimulator(undefined, gasProvider);

      const result = await simulator.isWithinGasBudget(500_000n, 'entry');
      expect(result).toBe(false);
    });

    it('should approve safety exit gas within $0.10 budget', async () => {
      // Higher budget for safety exits
      const gasProvider = createMockGasProvider(1_000_000_000n, 2500);
      const simulator = createSimulator(undefined, gasProvider);

      // cost = 150000 * 1_000_000_000 = 150_000_000_000_000 wei = 0.00015 ETH = $0.375
      // This is below $0.10... let's use smaller values
      // gas=100000, gasPrice=100_000_000 (0.1 gwei), ETH=$2500
      // cost = 100000 * 100_000_000 = 10_000_000_000_000 wei = 0.00001 ETH = $0.025
      const gasProvider2 = createMockGasProvider(100_000_000n, 2500);
      const simulator2 = createSimulator(undefined, gasProvider2);

      const result = await simulator2.isWithinGasBudget(100_000n, 'safety_exit');
      expect(result).toBe(true);
    });

    it('should use init budget ($0.10) for init category', async () => {
      expect(GAS_BUDGET_LIMITS['init']).toBe(100_000n);
      expect(GAS_BUDGET_LIMITS['safety_exit']).toBe(100_000n);
      expect(GAS_BUDGET_LIMITS['entry']).toBe(50_000n);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tests: Quote Drift Detection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('hasQuoteDrifted', () => {
    it('should return false when quotes are identical', () => {
      const simulator = createSimulator();
      expect(simulator.hasQuoteDrifted(1_000_000n, 1_000_000n)).toBe(false);
    });

    it('should return false for drift exactly at 20 bps', () => {
      const simulator = createSimulator();
      // 20 bps = 0.20% of 1_000_000 = 2000
      const gateAmount = 1_000_000n;
      const driftedAmount = 998_000n; // exactly 20 bps less
      expect(simulator.hasQuoteDrifted(gateAmount, driftedAmount)).toBe(false);
    });

    it('should return true for drift > 20 bps (adverse)', () => {
      const simulator = createSimulator();
      // 21 bps = 0.21% of 1_000_000 = 2100
      const gateAmount = 1_000_000n;
      const driftedAmount = 997_900n; // 21 bps less
      expect(simulator.hasQuoteDrifted(gateAmount, driftedAmount)).toBe(true);
    });

    it('should return true for drift > 20 bps (favorable)', () => {
      const simulator = createSimulator();
      // Also trigger on favorable drift (indicates volatile conditions)
      const gateAmount = 1_000_000n;
      const driftedAmount = 1_002_100n; // 21 bps more
      expect(simulator.hasQuoteDrifted(gateAmount, driftedAmount)).toBe(true);
    });

    it('should return true when gate amount is zero', () => {
      const simulator = createSimulator();
      expect(simulator.hasQuoteDrifted(0n, 1_000_000n)).toBe(true);
    });

    it('should handle large values correctly', () => {
      const simulator = createSimulator();
      // 2 ETH in wei
      const gateAmount = 2_000_000_000_000_000_000n;
      // 15 bps drift = well within threshold
      const driftedAmount = 2_000_000_000_000_000_000n - 300_000_000_000_000n; // 15 bps
      expect(simulator.hasQuoteDrifted(gateAmount, driftedAmount)).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tests: Error Handling
  // ═══════════════════════════════════════════════════════════════════════════

  describe('error handling', () => {
    it('should handle errors without data property', async () => {
      const provider: ISimulationProvider = {
        ethCall: vi.fn().mockRejectedValue(new Error('network error')),
      };
      const simulator = createSimulator(provider);

      const result = await simulator.simulateApproval(USDC_ADDRESS, SWAP_ROUTER, 1_000_000n);

      expect(result.success).toBe(false);
      expect(result.revertReason).toBeDefined();
    });

    it('should handle errors with nested error.data', async () => {
      const innerError = new Error('revert');
      (innerError as Record<string, unknown>)['data'] = '0x08c379a0' +
        '0000000000000000000000000000000000000000000000000000000000000020' +
        '0000000000000000000000000000000000000000000000000000000000000005' +
        Buffer.from('error').toString('hex').padEnd(64, '0');
      const outerError = new Error('call exception');
      (outerError as Record<string, unknown>)['error'] = innerError;

      const provider: ISimulationProvider = {
        ethCall: vi.fn().mockRejectedValue(outerError),
      };
      const simulator = createSimulator(provider);

      const result = await simulator.simulateSwap({
        tokenIn: USDC_ADDRESS,
        tokenOut: WETH_ADDRESS,
        fee: 500,
        recipient: WALLET,
        amountIn: 5_000_000n,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      });

      expect(result.success).toBe(false);
      expect(result.revertReason).toBe('error');
    });

    it('should handle non-Error thrown values', async () => {
      const provider: ISimulationProvider = {
        ethCall: vi.fn().mockRejectedValue('string error'),
      };
      const simulator = createSimulator(provider);

      const result = await simulator.simulateWithdrawal(USDC_ADDRESS, 99_630_000n);

      expect(result.success).toBe(false);
      expect(result.revertReason).toBe('Unknown revert (empty data)');
    });
  });
});

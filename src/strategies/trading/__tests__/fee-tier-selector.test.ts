/**
 * Unit tests for FeeTierSelector
 *
 * Validates: Requirements 1.1, 1.6
 *
 * Tests use mocked ethers contracts to verify:
 * - Correct fee tier selection based on liquidity
 * - Handling of non-existent pools
 * - Graceful error handling on RPC failures
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ZeroAddress } from 'ethers';

// Mock ethers module
vi.mock('ethers', async () => {
  const actual = await vi.importActual('ethers');
  return {
    ...actual,
    JsonRpcProvider: vi.fn().mockImplementation(() => ({})),
    Contract: vi.fn(),
  };
});

import { Contract } from 'ethers';
import { FeeTierSelector } from '../fee-tier-selector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_A = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC
const TOKEN_B = '0x4200000000000000000000000000000000000006'; // WETH

function setupMockFactory(poolMap: Record<number, { address: string; liquidity: bigint }>) {
  const mockGetPool = vi.fn().mockImplementation(
    (_tokenA: string, _tokenB: string, fee: number) => {
      const pool = poolMap[fee];
      return Promise.resolve(pool ? pool.address : ZeroAddress);
    },
  );

  const mockLiquidity = vi.fn().mockImplementation(function (this: { _address: string }) {
    for (const entry of Object.values(poolMap)) {
      if (entry.address === this._address) {
        return Promise.resolve(entry.liquidity);
      }
    }
    return Promise.resolve(0n);
  });

  const MockContract = vi.mocked(Contract);
  MockContract.mockImplementation((address: string) => {
    // If it's the factory address
    if (address === '0x33128a8fC17869897dcE68Ed026d694621f6FDfD') {
      return { getPool: mockGetPool } as unknown as Contract;
    }
    // Otherwise it's a pool contract
    return { liquidity: mockLiquidity, _address: address } as unknown as Contract;
  });

  return { mockGetPool, mockLiquidity };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeTierSelector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('selectBestFeeTier', () => {
    it('returns the pool with highest liquidity', async () => {
      setupMockFactory({
        500: { address: '0x1111111111111111111111111111111111111111', liquidity: 100_000n },
        3000: { address: '0x2222222222222222222222222222222222222222', liquidity: 500_000n },
        10000: { address: '0x3333333333333333333333333333333333333333', liquidity: 50_000n },
      });

      const selector = new FeeTierSelector('http://localhost:8545');
      const result = await selector.selectBestFeeTier(TOKEN_A, TOKEN_B);

      expect(result).not.toBeNull();
      expect(result!.feeTier).toBe(3000);
      expect(result!.liquidity).toBe(500_000n);
      expect(result!.poolAddress).toBe('0x2222222222222222222222222222222222222222');
      expect(result!.exists).toBe(true);
    });

    it('returns null when no pool exists for the pair (Req 1.6)', async () => {
      setupMockFactory({});

      const selector = new FeeTierSelector('http://localhost:8545');
      const result = await selector.selectBestFeeTier(TOKEN_A, TOKEN_B);

      expect(result).toBeNull();
    });

    it('skips pools that return zero address', async () => {
      setupMockFactory({
        500: { address: '0x1111111111111111111111111111111111111111', liquidity: 200_000n },
        // 3000 and 10000 not in map → will resolve to ZeroAddress
      });

      const selector = new FeeTierSelector('http://localhost:8545');
      const result = await selector.selectBestFeeTier(TOKEN_A, TOKEN_B);

      expect(result).not.toBeNull();
      expect(result!.feeTier).toBe(500);
      expect(result!.liquidity).toBe(200_000n);
    });
  });

  describe('getAvailablePools', () => {
    it('returns all existing pools sorted by liquidity descending', async () => {
      setupMockFactory({
        500: { address: '0x1111111111111111111111111111111111111111', liquidity: 100_000n },
        3000: { address: '0x2222222222222222222222222222222222222222', liquidity: 500_000n },
        10000: { address: '0x3333333333333333333333333333333333333333', liquidity: 250_000n },
      });

      const selector = new FeeTierSelector('http://localhost:8545');
      const pools = await selector.getAvailablePools(TOKEN_A, TOKEN_B);

      expect(pools).toHaveLength(3);
      expect(pools[0].feeTier).toBe(3000);
      expect(pools[0].liquidity).toBe(500_000n);
      expect(pools[1].feeTier).toBe(10000);
      expect(pools[1].liquidity).toBe(250_000n);
      expect(pools[2].feeTier).toBe(500);
      expect(pools[2].liquidity).toBe(100_000n);
    });

    it('returns empty array when no pool exists', async () => {
      setupMockFactory({});

      const selector = new FeeTierSelector('http://localhost:8545');
      const pools = await selector.getAvailablePools(TOKEN_A, TOKEN_B);

      expect(pools).toHaveLength(0);
    });

    it('handles RPC errors gracefully and returns available pools', async () => {
      const MockContract = vi.mocked(Contract);
      let callCount = 0;

      MockContract.mockImplementation((address: string) => {
        if (address === '0x33128a8fC17869897dcE68Ed026d694621f6FDfD') {
          return {
            getPool: vi.fn().mockImplementation(
              (_tokenA: string, _tokenB: string, fee: number) => {
                callCount++;
                // Simulate RPC timeout on first call (fee 500)
                if (fee === 500) {
                  return Promise.reject(new Error('RPC timeout'));
                }
                if (fee === 3000) {
                  return Promise.resolve('0x2222222222222222222222222222222222222222');
                }
                return Promise.resolve(ZeroAddress);
              },
            ),
          } as unknown as Contract;
        }
        return {
          liquidity: vi.fn().mockResolvedValue(300_000n),
          _address: address,
        } as unknown as Contract;
      });

      const selector = new FeeTierSelector('http://localhost:8545');
      const pools = await selector.getAvailablePools(TOKEN_A, TOKEN_B);

      // Should only return the 3000 tier pool (500 errored, 10000 doesn't exist)
      expect(pools).toHaveLength(1);
      expect(pools[0].feeTier).toBe(3000);
      expect(pools[0].liquidity).toBe(300_000n);
    });
  });
});

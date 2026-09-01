/**
 * Hybrid Sniper — ContractValidator Unit Tests (Tareas 5.3)
 *
 * Tests ContractValidator with mock DexQuoter and mock ethers Provider.
 * Covers: blacklist, Aerodrome, pool detection failure, buy quote=0.
 */

import { describe, it, expect, vi } from 'vitest';
import { ContractValidator } from '../../src/hybrid-sniper/contract-validator.js';
import type { IDexQuoter, QuoteParams } from '../../src/hybrid-sniper/dex-quoter.js';
import type { SniperSignal } from '../../src/hybrid-sniper/metrics-recorder.js';
import { ethers } from 'ethers';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const AGENT_ADDRESS = '0x' + 'a'.repeat(40);
const TOKEN_ADDRESS = '0x' + 'b'.repeat(40);
const POOL_ADDRESS = '0x' + 'c'.repeat(40);

/** ABI-encode a uint256 */
function encodeUint256(n: bigint): string {
  return '0x' + n.toString(16).padStart(64, '0');
}

/** ABI-encode a bool (true=1, false=0) */
function encodeBool(v: boolean): string {
  return '0x' + (v ? '1' : '0').padStart(64, '0');
}

/** Build a minimal SniperSignal */
function makeSignal(overrides: Partial<SniperSignal> = {}): SniperSignal {
  return {
    id: 'test-id',
    ticker: 'TEST',
    contractAddress: TOKEN_ADDRESS,
    poolAddress: POOL_ADDRESS,
    source: 'dexscreener',
    ingestionTime: 1000,
    ...overrides,
  };
}

/**
 * Build a passing mock quoter that simulates a healthy token:
 * buy → large amount, sell1 + sell2 → same as tradeSize (0% tax)
 */
function makePassingQuoter(tradeSize = 5_000_000n): IDexQuoter {
  const buyOut = tradeSize * 100n; // 100x tokens per USDC
  const sell1 = tradeSize / 2n;
  const sell2 = tradeSize - sell1;
  let callCount = 0;

  return {
    detectPoolType: vi.fn().mockResolvedValue('uniswap_v3'),
    quote: vi.fn().mockImplementation(async (_p: QuoteParams) => {
      callCount++;
      if (callCount === 1) return buyOut;
      if (callCount === 2) return sell1;
      return sell2;
    }),
  };
}

/**
 * Build a mock ethers.Provider that:
 *  - Returns `balanceResponse` for balanceOf calls (liquidity check)
 *  - Returns `blacklistResponse` for isBlacklisted calls
 */
function makeProvider(opts: {
  balanceResponse?: bigint;
  blacklistResponse?: boolean;
  failCalls?: boolean;
} = {}): ethers.Provider {
  const {
    balanceResponse = 100_000_000_000n, // 100_000 USDC → passes liquidity check
    blacklistResponse = false,
    failCalls = false,
  } = opts;

  return {
    call: vi.fn().mockImplementation(async (tx: { data?: string; to?: string }) => {
      if (failCalls) throw new Error('RPC error');
      const data = tx.data ?? '';
      // isBlacklisted selector: 0xfe575a87
      if (data.startsWith('0xfe575a87')) {
        return encodeBool(blacklistResponse);
      }
      // tradingActive selector: not used in validation but may be called
      if (data.startsWith('0x9a8a0592')) {
        return encodeBool(true);
      }
      // Default: assume balanceOf — return balance
      return encodeUint256(balanceResponse);
    }),
    getNetwork: vi.fn().mockResolvedValue({ chainId: 8453n }),
  } as unknown as ethers.Provider;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ContractValidator: all checks pass', () => {
  it('returns passed=true when all checks succeed', async () => {
    const validator = new ContractValidator(
      makePassingQuoter(),
      makeProvider(),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal());
    expect(result.passed).toBe(true);
    expect(result.rejectReason).toBeNull();
  });
});

describe('ContractValidator: BLACKLISTED', () => {
  it('returns BLACKLISTED when isBlacklisted returns true', async () => {
    const validator = new ContractValidator(
      makePassingQuoter(),
      makeProvider({ blacklistResponse: true }),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal());
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toBe('BLACKLISTED');
  });
});

describe('ContractValidator: POOL_DETECTION_FAILED', () => {
  it('returns POOL_DETECTION_FAILED when detectPoolType throws', async () => {
    const failingQuoter: IDexQuoter = {
      detectPoolType: vi.fn().mockRejectedValue(new Error('pool not found')),
      quote: vi.fn(),
    };

    const validator = new ContractValidator(
      failingQuoter,
      makeProvider(),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal());
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toBe('POOL_DETECTION_FAILED');
  });
});

describe('ContractValidator: QUOTE_ERROR', () => {
  it('returns QUOTE_ERROR when buy quote returns 0', async () => {
    const quoter: IDexQuoter = {
      detectPoolType: vi.fn().mockResolvedValue('uniswap_v3'),
      quote: vi.fn().mockResolvedValue(0n), // buy returns 0
    };

    const validator = new ContractValidator(
      quoter,
      makeProvider(),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal());
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toBe('QUOTE_ERROR');
  });

  it('returns QUOTE_ERROR when quote throws an unexpected error', async () => {
    const quoter: IDexQuoter = {
      detectPoolType: vi.fn().mockResolvedValue('uniswap_v3'),
      quote: vi.fn().mockRejectedValue(new Error('RPC timeout')),
    };

    const validator = new ContractValidator(
      quoter,
      makeProvider(),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal());
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toBe('QUOTE_ERROR');
  });
});

describe('ContractValidator: Aerodrome pool validation', () => {
  it('passes validation on an Aerodrome pool without errors', async () => {
    const tradeSize = 5_000_000n;
    const buyOut = tradeSize * 100n;
    const sell1 = tradeSize / 2n;
    const sell2 = tradeSize - sell1;
    let callCount = 0;

    const aerodromeQuoter: IDexQuoter = {
      detectPoolType: vi.fn().mockResolvedValue('aerodrome'),
      quote: vi.fn().mockImplementation(async (_p: QuoteParams) => {
        callCount++;
        if (callCount === 1) return buyOut;
        if (callCount === 2) return sell1;
        return sell2;
      }),
    };

    const validator = new ContractValidator(
      aerodromeQuoter,
      makeProvider(),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal());
    expect(result.passed).toBe(true);
    expect(result.rejectReason).toBeNull();
  });
});

describe('ContractValidator: INSUFFICIENT_LIQUIDITY', () => {
  it('returns INSUFFICIENT_LIQUIDITY when pool USDC balance < $3k', async () => {
    const validator = new ContractValidator(
      makePassingQuoter(),
      makeProvider({ balanceResponse: 2_000_000_000n }), // $2k → below $3k threshold
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal());
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toBe('INSUFFICIENT_LIQUIDITY');
  });
});

describe('ContractValidator: SELL_TAX_EXCEEDED', () => {
  it('returns SELL_TAX_EXCEEDED when sell proceeds < 95% of tradeSize', async () => {
    const tradeSize = 5_000_000n;
    const buyOut = tradeSize * 100n;
    // Total sell returns only 80% of tradeSize → 20% tax
    const sell1 = (tradeSize * 40n) / 100n;
    const sell2 = (tradeSize * 40n) / 100n;
    let callCount = 0;

    const taxQuoter: IDexQuoter = {
      detectPoolType: vi.fn().mockResolvedValue('uniswap_v3'),
      quote: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return buyOut;
        if (callCount === 2) return sell1;
        return sell2;
      }),
    };

    const validator = new ContractValidator(
      taxQuoter,
      makeProvider(),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal());
    expect(result.passed).toBe(false);
    expect(result.rejectReason).toBe('SELL_TAX_EXCEEDED');
  });
});

describe('ContractValidator: fallback to contractAddress when no poolAddress', () => {
  it('uses contractAddress as candidate when poolAddress is absent', async () => {
    const quoter: IDexQuoter = {
      detectPoolType: vi.fn().mockResolvedValue('uniswap_v3'),
      quote: vi.fn().mockResolvedValue(0n), // will fail validation, but detection should succeed
    };

    const validator = new ContractValidator(
      quoter,
      makeProvider(),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const signal = makeSignal({ poolAddress: undefined });
    const result = await validator.validate(signal);

    // detectPoolType should have been called with contractAddress (not poolAddress)
    expect(quoter.detectPoolType).toHaveBeenCalledWith(TOKEN_ADDRESS);
    // Still fails (buy=0), but the pool detection path was taken
    expect(result.rejectReason).toBe('QUOTE_ERROR');
  });
});

describe('ContractValidator: latency calculation', () => {
  it('latencyMs is always >= 0 and validatedAt >= ingestionTime', async () => {
    const ingestionTime = Date.now() - 500; // 500ms ago

    const validator = new ContractValidator(
      makePassingQuoter(),
      makeProvider(),
      { tradeSizeUsdc: 5, agentAddress: AGENT_ADDRESS },
    );

    const result = await validator.validate(makeSignal({ ingestionTime }));
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.validatedAt).toBeGreaterThanOrEqual(ingestionTime);
  });
});

/**
 * Unit tests for SwapReceiptParser
 *
 * Validates: Requirements 1.5
 *
 * Tests verify:
 * - Correct parsing of Transfer events from transaction receipts
 * - Filtering by tokenOut address and recipient
 * - Summation of multiple Transfer events
 * - Handling of receipts with no matching events
 * - Extraction of gasUsed and effectiveGasPrice
 */

import { describe, it, expect } from 'vitest';
import { Interface, type TransactionReceipt } from 'ethers';

import { SwapReceiptParser } from '../swap-receipt-parser.js';
import { ERC20_ABI } from '../../../contracts/abis.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const erc20Interface = new Interface(ERC20_ABI);
const TRANSFER_TOPIC = erc20Interface.getEvent('Transfer')!.topicHash;

const TOKEN_OUT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC
const RECIPIENT = '0xae36889c670CaA446bE18ECdC96f7c882e601D81'; // Agent wallet
const SOME_POOL = '0x1111111111111111111111111111111111111111';
const OTHER_TOKEN = '0x4200000000000000000000000000000000000006'; // WETH

function encodeTransferLog(from: string, to: string, value: bigint, contractAddress: string) {
  const data = erc20Interface.encodeEventLog(
    erc20Interface.getEvent('Transfer')!,
    [from, to, value],
  );
  return {
    address: contractAddress,
    topics: data.topics as string[],
    data: data.data,
    // Fields required by ethers Log but not relevant for parsing
    blockNumber: 1000,
    blockHash: '0x' + '00'.repeat(32),
    transactionHash: '0x' + '00'.repeat(32),
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    index: 0,
  };
}

function createMockReceipt(
  logs: ReturnType<typeof encodeTransferLog>[],
  gasUsed = 150_000n,
  gasPrice = 1_000_000_000n,
): TransactionReceipt {
  return {
    logs,
    gasUsed,
    gasPrice,
    // Minimal fields to satisfy TransactionReceipt type
    hash: '0x' + 'ab'.repeat(32),
    blockHash: '0x' + '00'.repeat(32),
    blockNumber: 1000,
    index: 0,
    from: RECIPIENT,
    to: '0x2626664c2603336E57B271c5C0b26F421741e481',
    contractAddress: null,
    status: 1,
    logsBloom: '0x',
    type: 2,
    cumulativeGasUsed: gasUsed,
    root: undefined,
    blobGasUsed: null,
    blobGasPrice: null,
  } as unknown as TransactionReceipt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SwapReceiptParser', () => {
  const parser = new SwapReceiptParser();

  describe('parseSwapReceipt', () => {
    it('extracts Transfer event matching tokenOut and recipient', () => {
      const logs = [
        encodeTransferLog(SOME_POOL, RECIPIENT, 1_000_000n, TOKEN_OUT),
      ];
      const receipt = createMockReceipt(logs);

      const result = parser.parseSwapReceipt(receipt, TOKEN_OUT, RECIPIENT);

      expect(result.actualAmountOut).toBe(1_000_000n);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].from).toBe(SOME_POOL.toLowerCase());
      expect(result.events[0].to).toBe(RECIPIENT.toLowerCase());
      expect(result.events[0].value).toBe(1_000_000n);
    });

    it('sums multiple Transfer events to the same recipient', () => {
      const logs = [
        encodeTransferLog(SOME_POOL, RECIPIENT, 500_000n, TOKEN_OUT),
        encodeTransferLog(
          '0x2222222222222222222222222222222222222222',
          RECIPIENT,
          300_000n,
          TOKEN_OUT,
        ),
      ];
      const receipt = createMockReceipt(logs);

      const result = parser.parseSwapReceipt(receipt, TOKEN_OUT, RECIPIENT);

      expect(result.actualAmountOut).toBe(800_000n);
      expect(result.events).toHaveLength(2);
    });

    it('ignores Transfer events from a different token contract', () => {
      const logs = [
        encodeTransferLog(SOME_POOL, RECIPIENT, 1_000_000n, OTHER_TOKEN),
        encodeTransferLog(SOME_POOL, RECIPIENT, 500_000n, TOKEN_OUT),
      ];
      const receipt = createMockReceipt(logs);

      const result = parser.parseSwapReceipt(receipt, TOKEN_OUT, RECIPIENT);

      expect(result.actualAmountOut).toBe(500_000n);
      expect(result.events).toHaveLength(1);
    });

    it('ignores Transfer events to a different recipient', () => {
      const OTHER_RECIPIENT = '0x9999999999999999999999999999999999999999';
      const logs = [
        encodeTransferLog(SOME_POOL, OTHER_RECIPIENT, 2_000_000n, TOKEN_OUT),
        encodeTransferLog(SOME_POOL, RECIPIENT, 750_000n, TOKEN_OUT),
      ];
      const receipt = createMockReceipt(logs);

      const result = parser.parseSwapReceipt(receipt, TOKEN_OUT, RECIPIENT);

      expect(result.actualAmountOut).toBe(750_000n);
      expect(result.events).toHaveLength(1);
    });

    it('returns actualAmountOut = 0n when no matching events found', () => {
      const logs = [
        encodeTransferLog(SOME_POOL, '0x5555555555555555555555555555555555555555', 1_000_000n, TOKEN_OUT),
      ];
      const receipt = createMockReceipt(logs);

      const result = parser.parseSwapReceipt(receipt, TOKEN_OUT, RECIPIENT);

      expect(result.actualAmountOut).toBe(0n);
      expect(result.events).toHaveLength(0);
    });

    it('returns actualAmountOut = 0n for empty logs', () => {
      const receipt = createMockReceipt([]);

      const result = parser.parseSwapReceipt(receipt, TOKEN_OUT, RECIPIENT);

      expect(result.actualAmountOut).toBe(0n);
      expect(result.events).toHaveLength(0);
    });

    it('extracts gasUsed and effectiveGasPrice from receipt', () => {
      const logs = [
        encodeTransferLog(SOME_POOL, RECIPIENT, 1_000_000n, TOKEN_OUT),
      ];
      const receipt = createMockReceipt(logs, 200_000n, 2_500_000_000n);

      const result = parser.parseSwapReceipt(receipt, TOKEN_OUT, RECIPIENT);

      expect(result.gasUsed).toBe(200_000n);
      expect(result.effectiveGasPrice).toBe(2_500_000_000n);
    });

    it('handles address comparison case-insensitively', () => {
      const logs = [
        encodeTransferLog(
          SOME_POOL,
          RECIPIENT,
          1_500_000n,
          TOKEN_OUT.toLowerCase(), // lowercase
        ),
      ];
      const receipt = createMockReceipt(logs);

      // Pass uppercase addresses
      const result = parser.parseSwapReceipt(
        receipt,
        TOKEN_OUT.toUpperCase().replace('0X', '0x'),
        RECIPIENT.toUpperCase().replace('0X', '0x'),
      );

      expect(result.actualAmountOut).toBe(1_500_000n);
      expect(result.events).toHaveLength(1);
    });

    it('skips logs with non-Transfer topics', () => {
      const approvalTopic = erc20Interface.getEvent('Transfer')!.topicHash;
      const logs = [
        // A real Transfer event
        encodeTransferLog(SOME_POOL, RECIPIENT, 1_000_000n, TOKEN_OUT),
        // A log with a different topic (simulated)
        {
          address: TOKEN_OUT,
          topics: ['0x' + 'ff'.repeat(32)],
          data: '0x',
          blockNumber: 1000,
          blockHash: '0x' + '00'.repeat(32),
          transactionHash: '0x' + '00'.repeat(32),
          transactionIndex: 0,
          logIndex: 1,
          removed: false,
          index: 1,
        },
      ];
      const receipt = createMockReceipt(logs as ReturnType<typeof encodeTransferLog>[]);

      const result = parser.parseSwapReceipt(receipt, TOKEN_OUT, RECIPIENT);

      expect(result.actualAmountOut).toBe(1_000_000n);
      expect(result.events).toHaveLength(1);
    });
  });
});

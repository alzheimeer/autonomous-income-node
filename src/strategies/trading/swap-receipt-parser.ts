/**
 * SwapReceiptParser
 *
 * Parses ERC-20 Transfer events from a transaction receipt to determine
 * the actual output amount of a Uniswap v3 swap.
 *
 * Requirements: 1.5
 */

import { Interface, type TransactionReceipt } from 'ethers';

import { ERC20_ABI } from '../../contracts/abis.js';

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface ParsedSwapResult {
  actualAmountOut: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  events: Array<{ from: string; to: string; value: bigint }>;
}

export interface ISwapReceiptParser {
  /**
   * Parse Transfer events from a tx receipt to determine actual output. Req 1.5
   */
  parseSwapReceipt(
    receipt: TransactionReceipt,
    tokenOut: string,
    recipient: string,
  ): ParsedSwapResult;
}

// ── Implementation ────────────────────────────────────────────────────────────

export class SwapReceiptParser implements ISwapReceiptParser {
  private readonly erc20Interface: Interface;

  constructor() {
    this.erc20Interface = new Interface(ERC20_ABI);
  }

  /**
   * Parse Transfer events from the transaction receipt to find the actual
   * amount of `tokenOut` received by `recipient`.
   *
   * Filters logs where:
   * - The topic[0] matches the Transfer(address,address,uint256) event signature
   * - The log address matches `tokenOut` (case-insensitive)
   * - The decoded `to` parameter matches `recipient` (case-insensitive)
   *
   * Sums all matching Transfer values to get `actualAmountOut`.
   * Returns 0n if no matching events are found.
   */
  parseSwapReceipt(
    receipt: TransactionReceipt,
    tokenOut: string,
    recipient: string,
  ): ParsedSwapResult {
    const transferTopic = this.erc20Interface.getEvent('Transfer')!.topicHash;
    const normalizedTokenOut = tokenOut.toLowerCase();
    const normalizedRecipient = recipient.toLowerCase();

    const matchedEvents: Array<{ from: string; to: string; value: bigint }> = [];

    for (const log of receipt.logs) {
      // Skip logs that don't match the Transfer event signature
      if (!log.topics[0] || log.topics[0] !== transferTopic) {
        continue;
      }

      // Skip logs from contracts other than tokenOut
      if (log.address.toLowerCase() !== normalizedTokenOut) {
        continue;
      }

      // Decode the Transfer event
      try {
        const decoded = this.erc20Interface.decodeEventLog(
          'Transfer',
          log.data,
          log.topics,
        );

        const from = (decoded[0] as string).toLowerCase();
        const to = (decoded[1] as string).toLowerCase();
        const value = decoded[2] as bigint;

        // Only include events where `to` matches the recipient
        if (to === normalizedRecipient) {
          matchedEvents.push({ from, to, value });
        }
      } catch {
        // Skip logs that can't be decoded as Transfer events
        continue;
      }
    }

    // Sum all matched Transfer values
    const actualAmountOut = matchedEvents.reduce(
      (sum, event) => sum + event.value,
      0n,
    );

    return {
      actualAmountOut,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.gasPrice,
      events: matchedEvents,
    };
  }
}

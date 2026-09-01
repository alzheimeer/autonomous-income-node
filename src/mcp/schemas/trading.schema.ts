/**
 * JSON Schema definitions for the MCP Trading server tools.
 * Abstracts Uniswap v3 SDK and 1inch API calls.
 * Requirements: 13.2, 13.8
 */

import type { JSONSchemaObject } from '../client/mcp-client.js';

// ---------------------------------------------------------------------------
// get_quote
// ---------------------------------------------------------------------------

export const getQuoteSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    tokenIn: {
      type: 'string',
      pattern: '^0x[0-9a-fA-F]{40}$',
      description: 'ERC-20 token address to swap from',
    },
    tokenOut: {
      type: 'string',
      pattern: '^0x[0-9a-fA-F]{40}$',
      description: 'ERC-20 token address to swap to',
    },
    amountIn: {
      type: 'string',
      pattern: '^[0-9]+$',
      description: 'Amount of tokenIn as a bigint string (no decimals)',
    },
    network: {
      type: 'string',
      enum: ['ethereum', 'base'],
      description: 'Target blockchain network',
    },
    source: {
      type: 'string',
      enum: ['uniswap_v3', '1inch', 'best'],
      default: 'best',
      description: 'DEX aggregator source. "best" tries all and picks optimal',
    },
  },
  required: ['tokenIn', 'tokenOut', 'amountIn', 'network'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// execute_swap
// ---------------------------------------------------------------------------

export const executeSwapSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    quoteId: {
      type: 'string',
      minLength: 1,
      description: 'Quote ID returned by get_quote',
    },
    slippageTolerance: {
      type: 'number',
      minimum: 0,
      maximum: 50,
      default: 0.5,
      description: 'Maximum acceptable slippage as a percentage (0-50)',
    },
    walletAddress: {
      type: 'string',
      pattern: '^0x[0-9a-fA-F]{40}$',
      description: 'Wallet address that will sign and send the transaction',
    },
  },
  required: ['quoteId', 'walletAddress'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const TRADING_SCHEMAS = {
  get_quote: getQuoteSchema,
  execute_swap: executeSwapSchema,
} as const satisfies Record<string, JSONSchemaObject>;

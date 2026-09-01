/**
 * MCP Trading Server
 *
 * Implements the MCP protocol via stdio, exposing two tools:
 *   - get_quote: obtain a swap quote from Uniswap v3 or 1inch
 *   - execute_swap: execute a token swap transaction
 *
 * Mock mode (MOCK_ONCHAIN_IDENTITY=true): returns simulated quotes / swaps.
 * Production mode: calls the 1inch API for Base (chainId 8453).
 *
 * Requirements: 13.2, 6.1, 6.6
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ONEINCH_BASE_URL = 'https://api.1inch.dev/swap/v6.0/8453'; // Base chainId
const MOCK_MODE = process.env['MOCK_ONCHAIN_IDENTITY'] === 'true';

// In-memory quote cache so execute_swap can reference a prior get_quote
const quoteCache = new Map<string, QuoteResult>();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QuoteResult {
  quoteId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedOut: string;
  estimatedGas: string;
  price: string;
  source: string;
  network: string;
  timestamp: number;
}

export interface SwapResult {
  txHash: string;
  status: 'success' | 'simulated' | 'pending';
  quoteId: string;
  walletAddress: string;
}

interface GetQuoteInput {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  network: string;
  source?: string;
}

interface ExecuteSwapInput {
  quoteId: string;
  slippageTolerance?: number;
  walletAddress: string;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'get_quote',
    description: 'Get a swap quote from Uniswap v3 or 1inch aggregator',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tokenIn: {
          type: 'string',
          description: 'Input token address (ERC-20) or "ETH"',
        },
        tokenOut: {
          type: 'string',
          description: 'Output token address (ERC-20) or "ETH"',
        },
        amountIn: {
          type: 'string',
          description: 'Amount of tokenIn to swap, in base units (bigint as string)',
        },
        network: {
          type: 'string',
          enum: ['ethereum', 'base'],
          description: 'Target network',
        },
        source: {
          type: 'string',
          enum: ['uniswap_v3', '1inch', 'best'],
          default: 'best',
          description: 'DEX aggregator to use for the quote',
        },
      },
      required: ['tokenIn', 'tokenOut', 'amountIn', 'network'],
      additionalProperties: false,
    },
  },
  {
    name: 'execute_swap',
    description: 'Execute a token swap using a previously obtained quote',
    inputSchema: {
      type: 'object' as const,
      properties: {
        quoteId: {
          type: 'string',
          description: 'Quote ID returned by get_quote',
        },
        slippageTolerance: {
          type: 'number',
          minimum: 0,
          maximum: 50,
          default: 0.5,
          description: 'Maximum acceptable slippage in percent (default 0.5%)',
        },
        walletAddress: {
          type: 'string',
          description: 'Wallet address that will sign and broadcast the swap',
        },
      },
      required: ['quoteId', 'walletAddress'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildMockQuote(input: GetQuoteInput): QuoteResult {
  const quoteId = randomUUID();
  const amountIn = BigInt(input.amountIn);
  // Simulate a 0.3% fee and small price impact → expectedOut ≈ amountIn * 0.997
  const expectedOut = ((amountIn * 997n) / 1000n).toString();
  const price = (Number(amountIn) / Number(expectedOut)).toFixed(6);

  return {
    quoteId,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amountIn: input.amountIn,
    expectedOut,
    estimatedGas: '150000',
    price,
    source: input.source ?? 'best',
    network: input.network,
    timestamp: Date.now(),
  };
}

function buildMockSwap(quote: QuoteResult, input: ExecuteSwapInput): SwapResult {
  // Generate a deterministic-looking fake tx hash
  const fakeTxHash = `0x${'ab12cd34ef56'.repeat(5).slice(0, 64)}`;
  return {
    txHash: fakeTxHash,
    status: 'simulated',
    quoteId: input.quoteId,
    walletAddress: input.walletAddress,
  };
}

// ---------------------------------------------------------------------------
// Production helpers — 1inch API for Base
// ---------------------------------------------------------------------------

async function fetchQuoteFrom1inch(input: GetQuoteInput): Promise<QuoteResult> {
  const apiKey = process.env['ONEINCH_API_KEY'] ?? '';

  const params: Record<string, string> = {
    src: input.tokenIn,
    dst: input.tokenOut,
    amount: input.amountIn,
  };

  const response = await axios.get<{
    dstAmount: string;
    gas: number;
    srcToken?: { address: string };
    dstToken?: { address: string };
  }>(`${ONEINCH_BASE_URL}/quote`, {
    params,
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    timeout: 10_000,
  });

  const data = response.data;
  const quoteId = randomUUID();
  const expectedOut = data.dstAmount;
  const estimatedGas = String(data.gas ?? 200_000);

  // price = amountIn / expectedOut (both as floating point)
  let price = 'N/A';
  try {
    const priceFl = Number(input.amountIn) / Number(expectedOut);
    price = isFinite(priceFl) ? priceFl.toFixed(6) : 'N/A';
  } catch {
    // Ignore
  }

  const result: QuoteResult = {
    quoteId,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amountIn: input.amountIn,
    expectedOut,
    estimatedGas,
    price,
    source: '1inch',
    network: input.network,
    timestamp: Date.now(),
  };

  quoteCache.set(quoteId, result);
  return result;
}

// ---------------------------------------------------------------------------
// Core tool handlers
// ---------------------------------------------------------------------------

async function handleGetQuote(input: GetQuoteInput): Promise<QuoteResult> {
  if (MOCK_MODE) {
    const quote = buildMockQuote(input);
    quoteCache.set(quote.quoteId, quote);
    return quote;
  }

  // Production: use 1inch for Base; Uniswap SDK integration would go here for 'uniswap_v3'
  const source = input.source ?? 'best';
  if (source === 'uniswap_v3') {
    // Uniswap v3 SDK integration — fall back to 1inch in this release
    // Full Uniswap v3 on-chain quote requires ethers + pool contracts; use 1inch as proxy
    return fetchQuoteFrom1inch({ ...input, source: '1inch' });
  }

  return fetchQuoteFrom1inch(input);
}

async function handleExecuteSwap(input: ExecuteSwapInput): Promise<SwapResult> {
  const quote = quoteCache.get(input.quoteId);

  if (!quote) {
    throw new Error(`Quote not found: ${input.quoteId}. Call get_quote first.`);
  }

  if (MOCK_MODE) {
    return buildMockSwap(quote, input);
  }

  // Production: build and broadcast transaction via ethers v6 + 1inch swap endpoint
  // This requires a signer/private key which is provided externally.
  // We return a structured 'pending' response; the caller is responsible for signing.
  const apiKey = process.env['ONEINCH_API_KEY'] ?? '';
  const slippage = input.slippageTolerance ?? 0.5;

  const params: Record<string, string> = {
    src: quote.tokenIn,
    dst: quote.tokenOut,
    amount: quote.amountIn,
    from: input.walletAddress,
    slippage: String(slippage),
    disableEstimate: 'true',
  };

  const response = await axios.get<{ tx: { hash?: string } }>(
    `${ONEINCH_BASE_URL}/swap`,
    {
      params,
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      timeout: 15_000,
    }
  );

  const txHash = response.data?.tx?.hash ?? `0x${'00'.repeat(32)}`;

  return {
    txHash,
    status: 'pending',
    quoteId: input.quoteId,
    walletAddress: input.walletAddress,
  };
}

// ---------------------------------------------------------------------------
// MCP Server bootstrap
// ---------------------------------------------------------------------------

function createTradingServer(): Server {
  const server = new Server(
    { name: 'trading-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case 'get_quote': {
          const input = args as unknown as GetQuoteInput;

          if (!input.tokenIn || !input.tokenOut || !input.amountIn || !input.network) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required fields: tokenIn, tokenOut, amountIn, network' }) }],
              isError: true,
            };
          }

          const result = await handleGetQuote(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'execute_swap': {
          const input = args as unknown as ExecuteSwapInput;

          if (!input.quoteId || !input.walletAddress) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required fields: quoteId, walletAddress' }) }],
              isError: true,
            };
          }

          const result = await handleExecuteSwap(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        default:
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }
    } catch (err) {
      // Requirement 13.6 — structured error, no unhandled exceptions
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startTradingServer(): Promise<void> {
  const server = createTradingServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('trading-server.ts') ||
    process.argv[1].endsWith('trading-server.js'));

if (isMain) {
  startTradingServer().catch((err) => {
    process.stderr.write(`Trading server fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}

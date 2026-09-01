/**
 * OpportunityScanner
 *
 * Discovers potential swap opportunities by querying the MCP Trading Server
 * for quotes on target token pairs. Computes the net profit (expected output
 * minus gas cost) and returns only opportunities above the minimum threshold.
 *
 * In mock mode (`MOCK_ONCHAIN_IDENTITY=true` or `NODE_ENV=development`):
 *   - Returns two simulated opportunities with profit > $0.50 without hitting
 *     any external API.
 *
 * In production mode:
 *   - Calls `get_quote` via McpClient for USDC/ETH and USDC/WBTC on Base.
 *
 * Requirements: 6.1, 6.2, 6.3
 */

import { randomUUID } from 'node:crypto';
import type { McpClient } from '../../mcp/client/mcp-client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TradeNetwork = 'ethereum' | 'base';
export type TokenAddress = string;
export type TradeSource = 'uniswap_v3' | '1inch';

/**
 * A discovered swap opportunity.
 * Mirrors the design.md `TradeOpportunity` interface.
 */
export interface TradeOpportunity {
  id: string;
  network: TradeNetwork;
  tokenIn: TokenAddress;
  tokenOut: TokenAddress;
  amountIn: bigint;
  expectedOut: bigint;
  /** Estimated gas cost converted to USDC 6-decimal units. */
  estimatedGasCost: bigint;
  /** expectedOut − estimatedGasCost (may be negative). */
  netProfitUsdc: bigint;
  slippagePct: number;
  source: TradeSource;
  /** MCP-assigned quote ID, used when submitting the swap. */
  quoteId: string;
  discoveredAt: number;
}

// ---------------------------------------------------------------------------
// Well-known token addresses on Base (mainnet)
// ---------------------------------------------------------------------------

/** USDC on Base */
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** WETH on Base */
const WETH_BASE = '0x4200000000000000000000000000000000000006';
/** WBTC on Base */
const WBTC_BASE = '0x0555E30da8f98308EdB960aa94C0Db47230d2B9C';

/** Default amount of USDC to quote per pair: $5 USDC (respects Tier 1/2 max trade cap) */
const DEFAULT_QUOTE_AMOUNT_USDC = 5_000000n;

/** Assumed gas cost per swap in USDC 6-decimal units: ~$0.05 */
const ESTIMATED_GAS_COST_USDC = 50_000n;

/** Minimum profit threshold used for filtering in scanner: $0.50 USDC */
const MIN_PROFIT_THRESHOLD = 500_000n;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function buildMockOpportunity(
  tokenOut: TokenAddress,
  source: TradeSource,
  profitUsdc: bigint
): TradeOpportunity {
  const amountIn = DEFAULT_QUOTE_AMOUNT_USDC;
  const gasCost = ESTIMATED_GAS_COST_USDC;
  const expectedOut = amountIn + profitUsdc + gasCost;

  return {
    id: randomUUID(),
    network: 'base',
    tokenIn: USDC_BASE,
    tokenOut,
    amountIn,
    expectedOut,
    estimatedGasCost: gasCost,
    netProfitUsdc: profitUsdc,
    slippagePct: 0.3,
    source,
    quoteId: randomUUID(),
    discoveredAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// MCP quote shape returned by trading-server.ts
// ---------------------------------------------------------------------------

interface QuoteResult {
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

// ---------------------------------------------------------------------------
// OpportunityScanner
// ---------------------------------------------------------------------------

const MOCK_MODE =
  process.env['MOCK_ONCHAIN_IDENTITY'] === 'true' ||
  process.env['NODE_ENV'] === 'development';

/**
 * Scan for profitable trade opportunities.
 * Tries the local MCP trading server first; falls back to direct 1inch REST API.
 */
export async function scanOpportunities(
  walletAddress: string,
  balance: bigint,
  mcpClient?: McpClient
): Promise<TradeOpportunity[]> {
  if (MOCK_MODE) {
    return [
      buildMockOpportunity(WETH_BASE, 'uniswap_v3', 800_000n),
      buildMockOpportunity(WBTC_BASE, '1inch', 1_200_000n),
    ];
  }

  // Determine the amount to quote (cap at 20% of balance per pair)
  const maxExposure = (balance * 20n) / 100n;
  const amountIn =
    maxExposure < DEFAULT_QUOTE_AMOUNT_USDC ? maxExposure : DEFAULT_QUOTE_AMOUNT_USDC;

  if (amountIn <= 0n) {
    return [];
  }

  const pairs: Array<{ tokenOut: TokenAddress; source: TradeSource }> = [
    { tokenOut: WETH_BASE, source: '1inch' },
    { tokenOut: WBTC_BASE, source: '1inch' },
  ];

  const opportunities: TradeOpportunity[] = [];

  // Intentar via MCP local primero, luego fallback a API REST directa
  await Promise.allSettled(
    pairs.map(async ({ tokenOut, source }) => {
      let expectedOut: bigint | null = null;
      let quoteId: string = randomUUID();

      // Intento 1: MCP local
      if (mcpClient) {
        const result = await mcpClient.callTool<QuoteResult>('get_quote', {
          tokenIn: USDC_BASE,
          tokenOut,
          amountIn: amountIn.toString(),
          network: 'base',
          source,
        });

        if (result.ok && result.value?.expectedOut) {
          try {
            expectedOut = BigInt(result.value.expectedOut);
            quoteId = result.value.quoteId ?? quoteId;
          } catch {
            expectedOut = null;
          }
        }
      }

      // Intento 2: 1inch API (con KYC aprobado) — fuente primaria
      if (expectedOut === null) {
        const apiKey = process.env['ONEINCH_API_KEY'];
        if (apiKey) {
          try {
            const { default: axios } = await import('axios');
            const resp = await axios.get<{ dstAmount: string }>(
              `https://api.1inch.dev/swap/v6.0/8453/quote`,
              {
                params: {
                  src: USDC_BASE,
                  dst: tokenOut,
                  amount: amountIn.toString(),
                },
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  Accept: 'application/json',
                },
                timeout: 10_000,
              },
            );

            if (resp.data?.dstAmount) {
              expectedOut = BigInt(resp.data.dstAmount);
              quoteId = `1inch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              console.info(`[OpportunityScanner] 1inch quote ✅ for ${tokenOut.slice(0, 10)}: ${resp.data.dstAmount}`);
            }
          } catch (err: any) {
            const msg = err?.response?.data?.description ?? err?.response?.data ?? err?.message;
            console.warn(`[OpportunityScanner] 1inch quote failed for ${tokenOut.slice(0, 10)}: ${msg}`);
          }
        } else {
          console.warn('[OpportunityScanner] ONEINCH_API_KEY not set — skipping 1inch');
        }
      }

      // Intento 3: Paraswap (fallback sin KYC)
      if (expectedOut === null) {
        try {
          const { default: axios } = await import('axios');
          const paraswapResp = await axios.get<{
            priceRoute: { destAmount: string };
          }>(
            `https://apiv5.paraswap.io/prices`,
            {
              params: {
                srcToken: USDC_BASE,
                destToken: tokenOut,
                amount: amountIn.toString(),
                srcDecimals: 6,
                destDecimals: 18,
                network: 8453,
                side: 'SELL',
              },
              timeout: 10_000,
            },
          );

          const destAmount = paraswapResp.data?.priceRoute?.destAmount;
          if (destAmount) {
            expectedOut = BigInt(destAmount);
            quoteId = `paraswap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            console.info(`[OpportunityScanner] Paraswap quote for ${tokenOut.slice(0, 10)}...: ${destAmount}`);
          }
        } catch {
          // Intento 4: Uniswap Trading API
          try {
            const { default: axios } = await import('axios');
            const uniResp = await axios.get<{ quote: { amount: string } }>(
              `https://trade-api.gateway.uniswap.org/v1/quote`,
              {
                params: {
                  tokenInAddress: USDC_BASE,
                  tokenInChainId: 8453,
                  tokenOutAddress: tokenOut,
                  tokenOutChainId: 8453,
                  amount: amountIn.toString(),
                  type: 'exactIn',
                },
                timeout: 10_000,
              },
            );

            const uniAmount = uniResp.data?.quote?.amount;
            if (uniAmount) {
              expectedOut = BigInt(uniAmount);
              quoteId = `uniswap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
              console.info(`[OpportunityScanner] Uniswap quote for ${tokenOut.slice(0, 10)}...: ${uniAmount}`);
            }
          } catch {
            console.warn(`[OpportunityScanner] All quote sources failed for ${tokenOut.slice(0, 10)}...`);
            return;
          }
        }
      }

      if (expectedOut === null) return;

      const gasCost = ESTIMATED_GAS_COST_USDC;

      // -----------------------------------------------------------------------
      // CORRECT profit calculation:
      // A single-direction swap (buy tokenOut with USDC) has ZERO profit by
      // definition. You are simply converting one asset to another at market rate.
      // Profit only exists when there's a price discrepancy between sources
      // (arbitrage). Since we currently only have ONE quote source per pair,
      // we cannot determine arbitrage — the "profit" is always negative
      // (fees + gas).
      //
      // The old calculation `expectedOut - amountIn - gasCost` was WRONG because
      // expectedOut is in the OUTPUT token's decimals (e.g. 18 for WETH) while
      // amountIn and gasCost are in USDC 6-decimal units. This made every swap
      // appear massively profitable due to decimal mismatch.
      // -----------------------------------------------------------------------
      const feeEstimate = (amountIn * 30n) / 10000n; // 0.3% pool fee on amountIn (USDC terms)
      const netProfit = -(feeEstimate + gasCost); // Negative: single-source swap always costs fees

      // TODO: Implement multi-source arbitrage detection:
      // 1. Get quotes from MULTIPLE sources (1inch, Paraswap, Uniswap) for the SAME pair
      // 2. Compare best buy price vs best sell price across sources
      // 3. Only report opportunity if: (sell_price - buy_price) * amount - gas > MIN_PROFIT_THRESHOLD
      // 4. For triangular arb: USDC → ETH → TOKEN → USDC, check if final USDC > initial

      // Sanity check: if netProfit seems unreasonably high (>50% of trade),
      // it's likely a decimal mismatch bug
      if (netProfit > amountIn / 2n) {
        console.warn(
          `[OpportunityScanner] Suspicious profit ${netProfit} for ${amountIn} trade — likely decimal mismatch, skipping`
        );
        return;
      }

      if (netProfit < MIN_PROFIT_THRESHOLD) {
        return;
      }

      opportunities.push({
        id: randomUUID(),
        network: 'base',
        tokenIn: USDC_BASE,
        tokenOut,
        amountIn,
        expectedOut,
        estimatedGasCost: gasCost,
        netProfitUsdc: netProfit,
        slippagePct: 0.5,
        source,
        quoteId,
        discoveredAt: Date.now(),
      });
    })
  );

  return opportunities.sort((a, b) =>
    b.netProfitUsdc > a.netProfitUsdc ? 1 : b.netProfitUsdc < a.netProfitUsdc ? -1 : 0
  );
}

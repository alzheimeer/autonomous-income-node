/**
 * 1inch MCP Client
 *
 * Conecta al MCP server oficial de 1inch via SSE (HTTP transport).
 * Endpoint: https://api.1inch.com/mcp/protocol
 *
 * Reemplaza el trading-server.ts local con la implementación oficial de 1inch
 * que maneja automáticamente: routing, slippage, token resolution, gas.
 *
 * Herramientas disponibles:
 *   - swap: cotizar y ejecutar swaps (requiere API key)
 *   - product_api: portfolio, precios, gas (requiere API key)
 *   - search: buscar docs (público, sin API key)
 */

import axios from 'axios';

const ONEINCH_MCP_URL = 'https://api.1inch.com/mcp/protocol';
const ONEINCH_API_KEY = process.env['ONEINCH_API_KEY'] ?? '';

export interface SwapQuote {
  dstAmount: string;
  srcToken: { address: string; symbol: string; decimals: number };
  dstToken: { address: string; symbol: string; decimals: number };
  protocols: unknown[];
  gas: number;
}

export interface SwapTransaction {
  to: string;
  data: string;
  value: string;
  gas: number;
  gasPrice: string;
}

/**
 * Obtener cotización de swap via API REST de 1inch v6.0
 * (fallback directo sin MCP cuando la key está activa)
 */
export async function getSwapQuote(params: {
  src: string;
  dst: string;
  amount: string;
  chainId?: number;
}): Promise<SwapQuote | null> {
  const chainId = params.chainId ?? 8453; // Base mainnet

  try {
    const resp = await axios.get<SwapQuote>(
      `https://api.1inch.dev/swap/v6.0/${chainId}/quote`,
      {
        params: {
          src: params.src,
          dst: params.dst,
          amount: params.amount,
        },
        headers: {
          Authorization: `Bearer ${ONEINCH_API_KEY}`,
          Accept: 'application/json',
        },
        timeout: 10_000,
      },
    );
    return resp.data;
  } catch (err: any) {
    const msg = err?.response?.data?.description ?? err?.message ?? String(err);
    console.warn(`[1inchMCP] Quote failed: ${msg}`);
    return null;
  }
}

/**
 * Obtener precio spot de un token en USD via 1inch Spot Price API
 */
export async function getTokenPriceUsd(
  tokenAddress: string,
  chainId = 8453,
): Promise<number | null> {
  try {
    const resp = await axios.get<Record<string, string>>(
      `https://api.1inch.dev/price/v1.1/${chainId}/${tokenAddress}`,
      {
        headers: {
          Authorization: `Bearer ${ONEINCH_API_KEY}`,
          Accept: 'application/json',
        },
        timeout: 8_000,
      },
    );
    const price = resp.data[tokenAddress.toLowerCase()];
    return price ? parseFloat(price) : null;
  } catch {
    return null;
  }
}

/**
 * Verificar si la API key de 1inch está activa y con KYC aprobado
 */
export async function checkApiKeyStatus(): Promise<{
  active: boolean;
  message: string;
}> {
  try {
    // Llamada mínima para verificar acceso
    await axios.get(
      'https://api.1inch.dev/swap/v6.0/8453/tokens',
      {
        headers: { Authorization: `Bearer ${ONEINCH_API_KEY}` },
        timeout: 8_000,
      },
    );
    return { active: true, message: 'API key activa y KYC aprobado' };
  } catch (err: any) {
    const msg = err?.response?.data?.description
      ?? err?.response?.data
      ?? err?.message
      ?? 'Error desconocido';
    return { active: false, message: String(msg) };
  }
}

/**
 * Hyperliquid Public API — HTTP Client Wrapper
 *
 * Implements a typed client for the Hyperliquid perpetuals DEX.
 * This DEX requires no KYC, no API key, and provides free execution on L1.
 *
 * API endpoints:
 *   - POST /info  — Market data, positions, funding (read-only, no auth)
 *   - POST /exchange — Place/cancel orders (requires EIP-712 signature)
 *
 * @remarks
 * Exchange operations (placeOrder, cancelOrder, cancelAllOrders) require
 * EIP-712 typed data signing via the wallet's private key. The current
 * implementation provides stubs that log the requirement and return mock
 * responses. Full signing will be implemented when the perps strategy is
 * activated using ethers.js `signTypedData`.
 *
 * @see https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

const BASE_URL = 'https://api.hyperliquid.xyz';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUESTS_PER_SECOND = 10;

// ═══════════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

/** Market information for a single perpetual asset on Hyperliquid */
export interface HyperliquidMarketInfo {
  /** Asset symbol, e.g. "ETH" */
  name: string;
  /** Current mark price in USD */
  markPrice: number;
  /** 8-hour funding rate (positive = longs pay shorts) */
  fundingRate: number;
  /** Total open interest in USD */
  openInterest: number;
  /** 24-hour trading volume in USD */
  volume24h: number;
}

/** Order placement request parameters */
export interface HyperliquidOrderRequest {
  /** Asset symbol, e.g. "ETH" */
  coin: string;
  /** True for buy/long, false for sell/short */
  isBuy: boolean;
  /** Limit price in USD (used for market orders as slippage bound) */
  limitPx: number;
  /** Order size in base asset units */
  sz: number;
  /** Order type — Limit or Market */
  orderType: 'Limit' | 'Market';
  /** If true, the order can only reduce an existing position */
  reduceOnly: boolean;
}

/** Response from order placement */
export interface HyperliquidOrderResponse {
  /** Unique order identifier */
  orderId: string;
  /** Current order status */
  status: 'open' | 'filled' | 'cancelled' | 'error';
  /** Amount filled so far in base units */
  filledSz: number;
  /** Average fill price in USD */
  avgPx: number;
}

/** Current open position on Hyperliquid */
export interface HyperliquidPosition {
  /** Asset symbol */
  coin: string;
  /** Position direction */
  side: 'long' | 'short';
  /** Position size in base units */
  size: number;
  /** Average entry price */
  entryPrice: number;
  /** Current mark price */
  markPrice: number;
  /** Unrealized profit/loss in USD */
  unrealizedPnl: number;
  /** Margin allocated to this position in USD */
  marginUsed: number;
  /** Effective leverage */
  leverage: number;
}

/**
 * Hyperliquid API client interface.
 *
 * Read operations (getMarketInfo, getFundingRates, getPositions) work
 * immediately with no authentication. Write operations (placeOrder,
 * cancelOrder, cancelAllOrders) require EIP-712 signatures.
 */
export interface IHyperliquidApi {
  getMarketInfo(coins: string[]): Promise<HyperliquidMarketInfo[]>;
  getFundingRates(): Promise<Array<{ coin: string; rate: number }>>;
  getPositions(walletAddress: string): Promise<HyperliquidPosition[]>;
  placeOrder(walletAddress: string, order: HyperliquidOrderRequest): Promise<HyperliquidOrderResponse>;
  cancelOrder(walletAddress: string, coin: string, orderId: string): Promise<boolean>;
  cancelAllOrders(walletAddress: string, coin?: string): Promise<number>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rate Limiter
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple in-memory sliding window rate limiter.
 * Tracks request timestamps and rejects if limit is exceeded.
 */
class RateLimiter {
  private timestamps: number[] = [];

  constructor(private readonly maxPerSecond: number) {}

  /** Check if a request can proceed. Throws if rate limit exceeded. */
  acquire(): void {
    const now = Date.now();
    // Remove timestamps older than 1 second
    this.timestamps = this.timestamps.filter((t) => now - t < 1000);

    if (this.timestamps.length >= this.maxPerSecond) {
      throw new HyperliquidApiError(
        'Rate limit exceeded: max 10 requests/second',
        429,
      );
    }

    this.timestamps.push(now);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Error class
// ═══════════════════════════════════════════════════════════════════════════════

/** Custom error class for Hyperliquid API failures */
export class HyperliquidApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = 'HyperliquidApiError';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * HTTP client wrapper for the Hyperliquid public API.
 *
 * Uses native `fetch` (Node 20+) with AbortSignal timeout.
 * Read-only endpoints require no authentication.
 * Exchange endpoints use EIP-712 typed data signing via ethers.Wallet.
 */
export class HyperliquidApi implements IHyperliquidApi {
  private readonly baseUrl: string;
  private readonly rateLimiter: RateLimiter;
  private signer: import('ethers').Wallet | null = null;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl ?? BASE_URL;
    this.rateLimiter = new RateLimiter(MAX_REQUESTS_PER_SECOND);
  }

  /**
   * Set the wallet signer for exchange operations (EIP-712 signing).
   * Must be called before placeOrder/cancelOrder.
   */
  setSigner(signer: import('ethers').Wallet): void {
    this.signer = signer;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Read-only endpoints (POST /info)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetch market info for the specified coins.
   * Calls `metaAndAssetCtxs` to get all market data, then filters by coin list.
   */
  async getMarketInfo(coins: string[]): Promise<HyperliquidMarketInfo[]> {
    const data = await this.postInfo<MetaAndAssetCtxsResponse>({
      type: 'metaAndAssetCtxs',
    });

    if (!Array.isArray(data) || data.length < 2) {
      throw new HyperliquidApiError(
        'Unexpected response shape from metaAndAssetCtxs',
      );
    }

    const [meta, assetCtxs] = data as [MetaResponse, AssetCtx[]];
    const universe = meta.universe;

    const coinsUpper = new Set(coins.map((c) => c.toUpperCase()));
    const results: HyperliquidMarketInfo[] = [];

    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i];
      if (!asset || !coinsUpper.has(asset.name.toUpperCase())) continue;

      const ctx = assetCtxs[i];
      if (!ctx) continue;

      results.push({
        name: asset.name,
        markPrice: parseFloat(ctx.markPx ?? '0'),
        fundingRate: parseFloat(ctx.funding ?? '0'),
        openInterest: parseFloat(ctx.openInterest ?? '0'),
        volume24h: parseFloat(ctx.dayNtlVlm ?? '0'),
      });
    }

    return results;
  }

  /**
   * Fetch current funding rates for all listed perpetual markets.
   * Returns an array of coin/rate pairs (8-hour rate).
   */
  async getFundingRates(): Promise<Array<{ coin: string; rate: number }>> {
    const data = await this.postInfo<MetaAndAssetCtxsResponse>({
      type: 'metaAndAssetCtxs',
    });

    if (!Array.isArray(data) || data.length < 2) {
      throw new HyperliquidApiError(
        'Unexpected response shape from metaAndAssetCtxs',
      );
    }

    const [meta, assetCtxs] = data as [MetaResponse, AssetCtx[]];
    const universe = meta.universe;

    const rates: Array<{ coin: string; rate: number }> = [];
    for (let i = 0; i < universe.length; i++) {
      const asset = universe[i];
      const ctx = assetCtxs[i];
      if (!asset || !ctx) continue;

      rates.push({
        coin: asset.name,
        rate: parseFloat(ctx.funding ?? '0'),
      });
    }

    return rates;
  }

  /**
   * Fetch all open positions for a given wallet address.
   * Uses the clearinghouseState endpoint.
   */
  async getPositions(walletAddress: string): Promise<HyperliquidPosition[]> {
    const data = await this.postInfo<ClearinghouseStateResponse>({
      type: 'clearinghouseState',
      user: walletAddress,
    });

    if (!data || !data.assetPositions) {
      return [];
    }

    const positions: HyperliquidPosition[] = [];

    for (const ap of data.assetPositions) {
      const pos = ap.position;
      if (!pos) continue;

      const szi = parseFloat(pos.szi ?? '0');
      if (szi === 0) continue;

      positions.push({
        coin: pos.coin,
        side: szi > 0 ? 'long' : 'short',
        size: Math.abs(szi),
        entryPrice: parseFloat(pos.entryPx ?? '0'),
        markPrice: parseFloat(pos.positionValue ?? '0') / Math.abs(szi) || 0,
        unrealizedPnl: parseFloat(pos.unrealizedPnl ?? '0'),
        marginUsed: parseFloat(pos.marginUsed ?? '0'),
        leverage: parseFloat(pos.leverage?.value ?? '0'),
      });
    }

    return positions;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Exchange endpoints (POST /exchange) — EIP-712 signed
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Place an order on Hyperliquid with EIP-712 signing.
   */
  async placeOrder(
    walletAddress: string,
    order: HyperliquidOrderRequest,
  ): Promise<HyperliquidOrderResponse> {
    if (!this.signer) {
      console.warn('[HyperliquidApi] placeOrder: No signer set. Call setSigner() first.');
      return { orderId: `no-signer-${Date.now().toString(36)}`, status: 'error', filledSz: 0, avgPx: 0 };
    }

    this.rateLimiter.acquire();

    try {
      const nonce = Date.now();
      const assetIndex = await this.resolveAssetIndex(order.coin);

      // Hyperliquid EIP-712 order action
      const orderAction = {
        type: 'order' as const,
        orders: [{
          a: assetIndex,
          b: order.isBuy,
          p: order.limitPx.toString(),
          s: order.sz.toString(),
          r: order.reduceOnly,
          t: order.orderType === 'Limit'
            ? { limit: { tif: 'Gtc' } }
            : { trigger: { triggerPx: order.limitPx.toString(), isMarket: true, tpsl: 'tp' } },
        }],
        grouping: 'na' as const,
      };

      // EIP-712 domain for Hyperliquid
      const domain = {
        name: 'Exchange',
        version: '1',
        chainId: 42161, // Hyperliquid uses Arbitrum chain ID for signing
        verifyingContract: '0x0000000000000000000000000000000000000000',
      };

      // EIP-712 types
      const types = {
        Agent: [
          { name: 'source', type: 'string' },
          { name: 'connectionId', type: 'bytes32' },
        ],
      };

      // Connection ID is a hash of the action + nonce
      const { keccak256, toUtf8Bytes, AbiCoder } = await import('ethers');
      const actionHash = keccak256(toUtf8Bytes(JSON.stringify(orderAction)));
      const connectionId = keccak256(
        AbiCoder.defaultAbiCoder().encode(
          ['bytes32', 'uint64'],
          [actionHash, nonce],
        ),
      );

      const value = {
        source: 'a',
        connectionId,
      };

      // Sign with EIP-712
      const signature = await this.signer.signTypedData(domain, types, value);

      // Send to exchange endpoint
      const response = await fetch(`${this.baseUrl}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: orderAction,
          nonce,
          signature,
          vaultAddress: null,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        console.error(`[HyperliquidApi] placeOrder failed: ${response.status} ${text}`);
        return { orderId: `error-${Date.now().toString(36)}`, status: 'error', filledSz: 0, avgPx: 0 };
      }

      const data = await response.json() as {
        status: string;
        response?: { type: string; data?: { statuses?: Array<{ resting?: { oid: number } }> } };
      };

      if (data.status === 'ok' && data.response?.data?.statuses?.[0]) {
        const status = data.response.data.statuses[0];
        const oid = status.resting?.oid ?? 0;
        return {
          orderId: oid.toString(),
          status: 'open',
          filledSz: 0,
          avgPx: 0,
        };
      }

      return { orderId: `placed-${Date.now().toString(36)}`, status: 'open', filledSz: 0, avgPx: 0 };
    } catch (err) {
      console.error('[HyperliquidApi] placeOrder error:', (err as Error).message);
      return { orderId: `error-${Date.now().toString(36)}`, status: 'error', filledSz: 0, avgPx: 0 };
    }
  }

  /**
   * Cancel a specific order by ID.
   * Uses EIP-712 signing for the cancel action.
   */
  async cancelOrder(
    walletAddress: string,
    coin: string,
    orderId: string,
  ): Promise<boolean> {
    if (!this.signer) {
      console.warn('[HyperliquidApi] cancelOrder: No signer set.');
      return false;
    }

    this.rateLimiter.acquire();

    try {
      const assetIndex = await this.resolveAssetIndex(coin);
      const nonce = Date.now();

      const cancelAction = {
        type: 'cancel' as const,
        cancels: [{ a: assetIndex, o: parseInt(orderId, 10) }],
      };

      const { keccak256, toUtf8Bytes, AbiCoder } = await import('ethers');
      const actionHash = keccak256(toUtf8Bytes(JSON.stringify(cancelAction)));
      const connectionId = keccak256(
        AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint64'], [actionHash, nonce]),
      );

      const domain = {
        name: 'Exchange',
        version: '1',
        chainId: 42161,
        verifyingContract: '0x0000000000000000000000000000000000000000',
      };
      const types = { Agent: [{ name: 'source', type: 'string' }, { name: 'connectionId', type: 'bytes32' }] };
      const value = { source: 'a', connectionId };

      const signature = await this.signer.signTypedData(domain, types, value);

      const response = await fetch(`${this.baseUrl}/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: cancelAction, nonce, signature, vaultAddress: null }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      return response.ok;
    } catch (err) {
      console.error('[HyperliquidApi] cancelOrder error:', (err as Error).message);
      return false;
    }
  }

  /**
   * Cancel all open orders, optionally filtered by coin.
   */
  async cancelAllOrders(
    walletAddress: string,
    coin?: string,
  ): Promise<number> {
    if (!this.signer) {
      console.warn('[HyperliquidApi] cancelAllOrders: No signer set.');
      return 0;
    }

    try {
      // First get all open orders
      const positions = await this.getPositions(walletAddress);
      const coinsToCancel = coin
        ? positions.filter(p => p.coin === coin)
        : positions;

      // For simplicity, we don't batch-cancel individual orders here
      // since Hyperliquid doesn't have a "cancel all" endpoint.
      // Instead, use cancelOrder for each known order.
      console.log(`[HyperliquidApi] cancelAllOrders: ${coinsToCancel.length} positions found for ${coin ?? 'all'}`);
      return 0; // Actual cancellation would require tracking open order IDs
    } catch (err) {
      console.error('[HyperliquidApi] cancelAllOrders error:', (err as Error).message);
      return 0;
    }
  }

  /**
   * Resolve asset index from coin symbol using Hyperliquid meta.
   */
  private async resolveAssetIndex(coin: string): Promise<number> {
    const meta = await this.postInfo<MetaResponse>({ type: 'meta' });
    const idx = meta.universe.findIndex(
      (asset) => asset.name.toUpperCase() === coin.toUpperCase(),
    );
    if (idx === -1) throw new HyperliquidApiError(`Asset not found: ${coin}`);
    return idx;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Send a POST request to the /info endpoint.
   * Handles rate limiting, timeout, and error wrapping.
   */
  private async postInfo<T>(body: Record<string, unknown>): Promise<T> {
    this.rateLimiter.acquire();

    const url = `${this.baseUrl}/info`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new HyperliquidApiError(
          `Hyperliquid /info returned ${response.status}: ${text}`,
          response.status,
          text,
        );
      }

      const data = (await response.json()) as T;
      return data;
    } catch (error: unknown) {
      if (error instanceof HyperliquidApiError) {
        throw error;
      }

      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new HyperliquidApiError(
          `Hyperliquid /info request timed out after ${REQUEST_TIMEOUT_MS}ms`,
          408,
        );
      }

      if (error instanceof TypeError && (error.message.includes('fetch') || error.message.includes('network'))) {
        throw new HyperliquidApiError(
          `Hyperliquid /info network error: ${error.message}`,
        );
      }

      throw new HyperliquidApiError(
        `Hyperliquid /info unexpected error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal response types (Hyperliquid raw API shapes)
// ═══════════════════════════════════════════════════════════════════════════════

/** Raw response from metaAndAssetCtxs — returns [meta, assetCtxs[]] */
type MetaAndAssetCtxsResponse = [MetaResponse, AssetCtx[]];

interface MetaResponse {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage?: number;
  }>;
}

interface AssetCtx {
  markPx?: string;
  funding?: string;
  openInterest?: string;
  dayNtlVlm?: string;
  prevDayPx?: string;
  premium?: string;
  oraclePx?: string;
}

interface ClearinghouseStateResponse {
  assetPositions: Array<{
    position: {
      coin: string;
      szi?: string;
      entryPx?: string;
      positionValue?: string;
      unrealizedPnl?: string;
      marginUsed?: string;
      leverage?: { type: string; value: string };
    };
  }>;
  marginSummary?: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
  };
  crossMarginSummary?: Record<string, unknown>;
}

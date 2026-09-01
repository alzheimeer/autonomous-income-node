/**
 * TradingScanner — P4 priority scanner for trading/DeFi opportunities.
 *
 * Sources:
 * - DeFiLlama yields API (expanded coverage for high-APY pools)
 * - Funding rates from multiple exchanges (Binance, Bybit, OKX)
 * - Volatility indicators (price movements, ATR-like metrics)
 * - New DEX listings (Uniswap, Aerodrome on Base)
 *
 * Priority: P4 (lowest, requires approval gate for execution)
 * All trading strategies require human approval before implementation.
 *
 * Never throws — returns empty array on failure.
 */

import type { IResearchScanner, RawOpportunity, Priority } from './types.js';

const TIMEOUT_MS = 20_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; ResearchAgent/1.0)';
const LOG_PREFIX = '[TradingScanner]';

// ── API Endpoints ──────────────────────────────────────────────────────────

const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools';
const DEFILLAMA_PROTOCOLS_URL = 'https://api.llama.fi/protocols';

// Funding rates endpoints (public APIs)
const BINANCE_FUNDING_URL = 'https://fapi.binance.com/fapi/v1/fundingRate';
const BYBIT_FUNDING_URL = 'https://api.bybit.com/v5/market/funding/history';
const OKX_FUNDING_URL = 'https://www.okx.com/api/v5/public/funding-rate';

// DEX subgraphs / APIs
const UNISWAP_V3_SUBGRAPH = 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3';
const AERODROME_API = 'https://api.aerodrome.finance/v1/pools';

// ── Thresholds ─────────────────────────────────────────────────────────────

const MIN_APY_THRESHOLD = 15; // Minimum 15% APY to consider
const HIGH_APY_THRESHOLD = 50; // Opportunities above this are high-yield
const MIN_TVL_USD = 100_000; // Minimum $100k TVL for legitimacy
const MAX_TVL_USD = 100_000_000; // Filter out mega pools (less opportunity)
const MIN_FUNDING_RATE_ANNUALIZED = 20; // 20% annualized funding rate
const MIN_VOLATILITY_PERCENT = 5; // 5% daily volatility for trading opportunities
const NEW_POOL_MAX_AGE_HOURS = 72; // Consider pools < 72h old as "new"

// ── Helper: Fetch with timeout ─────────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...options.headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Helper: Safe JSON fetch ────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      console.log(`${LOG_PREFIX} HTTP ${response.status} from ${url}`);
      return null;
    }
    return (await response.json()) as T;
  } catch (err) {
    console.log(`${LOG_PREFIX} Fetch failed for ${url}: ${(err as Error).message}`);
    return null;
  }
}

// ── Helper: Calculate risk level ───────────────────────────────────────────

function calculateRiskLevel(
  apy: number,
  tvl: number,
  isStablecoin: boolean,
): 'low' | 'medium' | 'high' {
  // High APY + low TVL = high risk
  if (apy > 100 || tvl < 500_000) return 'high';
  if (apy > 50 || tvl < 1_000_000) return 'medium';
  if (isStablecoin && apy < 20) return 'low';
  return 'medium';
}

// ── Main Scanner Class ─────────────────────────────────────────────────────

export class TradingScanner implements IResearchScanner {
  readonly name = 'trading-scanner';
  readonly priority: Priority = 'P4';

  async scan(): Promise<RawOpportunity[]> {
    console.log(`${LOG_PREFIX} Starting scan...`);
    const results: RawOpportunity[] = [];

    // Run all scanners in parallel, handle failures individually
    const scanners = [
      this.scanDeFiLlamaYields(),
      this.scanFundingRates(),
      this.scanVolatilityOpportunities(),
      this.scanNewDEXListings(),
    ];

    const settled = await Promise.allSettled(scanners);

    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const scannerNames = ['DeFiLlama', 'FundingRates', 'Volatility', 'NewDEX'];

      if (result.status === 'fulfilled') {
        console.log(
          `${LOG_PREFIX} ${scannerNames[i]} returned ${result.value.length} opportunities`,
        );
        results.push(...result.value);
      } else {
        console.log(
          `${LOG_PREFIX} ${scannerNames[i]} failed: ${result.reason}`,
        );
      }
    }

    console.log(
      `${LOG_PREFIX} Scan complete. Total opportunities: ${results.length}`,
    );
    return results;
  }

  // ── DeFiLlama Yields Scanner ─────────────────────────────────────────────

  private async scanDeFiLlamaYields(): Promise<RawOpportunity[]> {
    interface DefiLlamaPool {
      pool: string;
      chain: string;
      project: string;
      symbol: string;
      tvlUsd: number;
      apy: number | null;
      apyBase?: number | null;
      apyReward?: number | null;
      stablecoin: boolean;
      ilRisk?: string;
      exposure?: string;
      poolMeta?: string | null;
    }

    interface DefiLlamaResponse {
      status: string;
      data: DefiLlamaPool[];
    }

    const data = await fetchJson<DefiLlamaResponse>(DEFILLAMA_YIELDS_URL);
    if (!data || !Array.isArray(data.data)) {
      console.log(`${LOG_PREFIX} DeFiLlama yields API returned no data`);
      return [];
    }

    const opportunities: RawOpportunity[] = [];

    // Filter for Base and Ethereum chains with good APY and TVL
    const relevantChains = ['Base', 'Ethereum', 'Arbitrum', 'Optimism'];

    const filteredPools = data.data.filter((pool) => {
      const apy = pool.apy ?? 0;
      const tvl = pool.tvlUsd ?? 0;

      return (
        relevantChains.includes(pool.chain) &&
        apy >= MIN_APY_THRESHOLD &&
        tvl >= MIN_TVL_USD &&
        tvl <= MAX_TVL_USD
      );
    });

    // Sort by APY descending and take top opportunities
    filteredPools.sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0));

    for (const pool of filteredPools.slice(0, 15)) {
      const apy = pool.apy ?? 0;
      const tvl = pool.tvlUsd ?? 0;
      const isHighYield = apy >= HIGH_APY_THRESHOLD;

      const riskLevel = calculateRiskLevel(apy, tvl, pool.stablecoin);

      // Estimate revenue based on $99 capital at the given APY
      const annualReturn = 99 * (apy / 100);
      const monthlyReturn = annualReturn / 12;

      opportunities.push({
        title: `${pool.project}: ${pool.symbol} (${apy.toFixed(1)}% APY)`,
        source: 'defillama-yields',
        category: 'trading',
        description: `Yield farming opportunity on ${pool.chain}. Pool: ${pool.symbol} via ${pool.project}. TVL: $${(tvl / 1_000_000).toFixed(2)}M. ${pool.stablecoin ? 'Stablecoin pool (lower IL risk).' : 'Non-stable pool (IL risk present).'} ${isHighYield ? '⚠️ HIGH YIELD - verify sustainability.' : ''}`,
        estimatedRevenue: `~$${monthlyReturn.toFixed(2)}/month at ${apy.toFixed(1)}% APY`,
        capitalRequired: '$20-99 USDC',
        riskLevel,
        automationLevel: 'full',
        sourceUrl: `https://defillama.com/yields/pool/${pool.pool}`,
        metadata: {
          poolId: pool.pool,
          chain: pool.chain,
          project: pool.project,
          symbol: pool.symbol,
          apy,
          apyBase: pool.apyBase,
          apyReward: pool.apyReward,
          tvlUsd: tvl,
          stablecoin: pool.stablecoin,
          ilRisk: pool.ilRisk,
          exposure: pool.exposure,
        },
      });
    }

    return opportunities;
  }

  // ── Funding Rates Scanner ────────────────────────────────────────────────

  private async scanFundingRates(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    // Scan multiple exchanges in parallel
    const exchangeScans = [
      this.scanBinanceFunding(),
      this.scanBybitFunding(),
      this.scanOKXFunding(),
    ];

    const results = await Promise.allSettled(exchangeScans);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        opportunities.push(...result.value);
      }
    }

    // Sort by annualized rate and deduplicate by symbol
    const seen = new Set<string>();
    const deduplicated: RawOpportunity[] = [];

    for (const opp of opportunities) {
      const symbol = (opp.metadata.symbol as string) || opp.title;
      if (!seen.has(symbol)) {
        seen.add(symbol);
        deduplicated.push(opp);
      }
    }

    return deduplicated.slice(0, 10);
  }

  private async scanBinanceFunding(): Promise<RawOpportunity[]> {
    interface BinanceFundingRate {
      symbol: string;
      fundingRate: string;
      fundingTime: number;
    }

    // Get current funding rates for major pairs
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ARBUSDT', 'OPUSDT'];
    const opportunities: RawOpportunity[] = [];

    for (const symbol of symbols) {
      const data = await fetchJson<BinanceFundingRate[]>(
        `${BINANCE_FUNDING_URL}?symbol=${symbol}&limit=1`,
      );

      if (!data || data.length === 0) continue;

      const fundingRate = parseFloat(data[0].fundingRate);
      // Funding rate is every 8 hours, so annualized = rate * 3 * 365
      const annualizedRate = Math.abs(fundingRate) * 3 * 365 * 100;

      if (annualizedRate >= MIN_FUNDING_RATE_ANNUALIZED) {
        const direction = fundingRate > 0 ? 'LONG pays SHORT' : 'SHORT pays LONG';
        const strategy =
          fundingRate > 0
            ? 'short perps + long spot hedge'
            : 'long perps + short spot hedge';

        opportunities.push({
          title: `Binance ${symbol} funding: ${annualizedRate.toFixed(1)}% annual`,
          source: 'binance-funding',
          category: 'trading',
          description: `Funding rate arbitrage on Binance Futures. ${direction}. Strategy: ${strategy}. Current 8h rate: ${(fundingRate * 100).toFixed(4)}%. This is a delta-neutral strategy.`,
          estimatedRevenue: `~$${((99 * annualizedRate) / 100 / 12).toFixed(2)}/month`,
          capitalRequired: '$50-99 USDC (split between spot and perps)',
          riskLevel: 'medium',
          automationLevel: 'partial',
          sourceUrl: `https://www.binance.com/en/futures/${symbol}`,
          metadata: {
            exchange: 'binance',
            symbol,
            fundingRate,
            annualizedRate,
            direction,
            strategy,
          },
        });
      }
    }

    return opportunities;
  }

  private async scanBybitFunding(): Promise<RawOpportunity[]> {
    interface BybitFundingResponse {
      retCode: number;
      result: {
        list: Array<{
          symbol: string;
          fundingRate: string;
          fundingRateTimestamp: string;
        }>;
      };
    }

    const opportunities: RawOpportunity[] = [];
    const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

    for (const symbol of symbols) {
      const data = await fetchJson<BybitFundingResponse>(
        `${BYBIT_FUNDING_URL}?category=linear&symbol=${symbol}&limit=1`,
      );

      if (!data || data.retCode !== 0 || !data.result?.list?.length) continue;

      const fundingRate = parseFloat(data.result.list[0].fundingRate);
      const annualizedRate = Math.abs(fundingRate) * 3 * 365 * 100;

      if (annualizedRate >= MIN_FUNDING_RATE_ANNUALIZED) {
        const direction = fundingRate > 0 ? 'LONG pays SHORT' : 'SHORT pays LONG';

        opportunities.push({
          title: `Bybit ${symbol} funding: ${annualizedRate.toFixed(1)}% annual`,
          source: 'bybit-funding',
          category: 'trading',
          description: `Funding rate opportunity on Bybit. ${direction}. 8h rate: ${(fundingRate * 100).toFixed(4)}%. Can be combined with spot hedge for delta-neutral returns.`,
          estimatedRevenue: `~$${((99 * annualizedRate) / 100 / 12).toFixed(2)}/month`,
          capitalRequired: '$50-99 USDC',
          riskLevel: 'medium',
          automationLevel: 'partial',
          sourceUrl: `https://www.bybit.com/trade/usdt/${symbol}`,
          metadata: {
            exchange: 'bybit',
            symbol,
            fundingRate,
            annualizedRate,
            direction,
          },
        });
      }
    }

    return opportunities;
  }

  private async scanOKXFunding(): Promise<RawOpportunity[]> {
    interface OKXFundingResponse {
      code: string;
      data: Array<{
        instId: string;
        fundingRate: string;
        fundingTime: string;
        nextFundingRate?: string;
      }>;
    }

    const opportunities: RawOpportunity[] = [];
    const instIds = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP'];

    for (const instId of instIds) {
      const data = await fetchJson<OKXFundingResponse>(
        `${OKX_FUNDING_URL}?instId=${instId}`,
      );

      if (!data || data.code !== '0' || !data.data?.length) continue;

      const fundingRate = parseFloat(data.data[0].fundingRate);
      const annualizedRate = Math.abs(fundingRate) * 3 * 365 * 100;

      if (annualizedRate >= MIN_FUNDING_RATE_ANNUALIZED) {
        const direction = fundingRate > 0 ? 'LONG pays SHORT' : 'SHORT pays LONG';

        opportunities.push({
          title: `OKX ${instId} funding: ${annualizedRate.toFixed(1)}% annual`,
          source: 'okx-funding',
          category: 'trading',
          description: `Funding rate opportunity on OKX. ${direction}. 8h rate: ${(fundingRate * 100).toFixed(4)}%. Delta-neutral strategy possible with spot hedge.`,
          estimatedRevenue: `~$${((99 * annualizedRate) / 100 / 12).toFixed(2)}/month`,
          capitalRequired: '$50-99 USDC',
          riskLevel: 'medium',
          automationLevel: 'partial',
          sourceUrl: `https://www.okx.com/trade-swap/${instId.toLowerCase()}`,
          metadata: {
            exchange: 'okx',
            symbol: instId,
            fundingRate,
            annualizedRate,
            direction,
            nextFundingRate: data.data[0].nextFundingRate,
          },
        });
      }
    }

    return opportunities;
  }

  // ── Volatility Opportunities Scanner ─────────────────────────────────────

  private async scanVolatilityOpportunities(): Promise<RawOpportunity[]> {
    // Use CoinGecko for price data (free tier)
    interface CoinGeckoMarket {
      id: string;
      symbol: string;
      name: string;
      current_price: number;
      price_change_percentage_24h: number;
      price_change_percentage_7d_in_currency?: number;
      high_24h: number;
      low_24h: number;
      total_volume: number;
      market_cap: number;
    }

    const data = await fetchJson<CoinGeckoMarket[]>(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=50&page=1&sparkline=false&price_change_percentage=7d',
    );

    if (!data || !Array.isArray(data)) {
      console.log(`${LOG_PREFIX} CoinGecko API returned no data`);
      return [];
    }

    const opportunities: RawOpportunity[] = [];

    for (const coin of data) {
      const dailyRange =
        coin.high_24h && coin.low_24h
          ? ((coin.high_24h - coin.low_24h) / coin.low_24h) * 100
          : 0;

      const dailyChange = Math.abs(coin.price_change_percentage_24h || 0);

      // Look for high volatility coins (good for range trading)
      if (dailyRange >= MIN_VOLATILITY_PERCENT || dailyChange >= MIN_VOLATILITY_PERCENT) {
        const volatilityScore = Math.max(dailyRange, dailyChange);
        const direction =
          (coin.price_change_percentage_24h || 0) > 0 ? 'bullish' : 'bearish';

        // Only include reasonably liquid coins
        if (coin.total_volume < 10_000_000) continue;

        opportunities.push({
          title: `${coin.symbol.toUpperCase()} volatility: ${volatilityScore.toFixed(1)}% daily`,
          source: 'coingecko-volatility',
          category: 'trading',
          description: `High volatility detected in ${coin.name} (${coin.symbol.toUpperCase()}). 24h range: ${dailyRange.toFixed(2)}%. 24h change: ${coin.price_change_percentage_24h?.toFixed(2)}% (${direction}). Current: $${coin.current_price.toFixed(4)}. Volume: $${(coin.total_volume / 1_000_000).toFixed(1)}M. Opportunity for range trading or momentum strategies.`,
          estimatedRevenue: 'Variable based on strategy',
          capitalRequired: '$20-50 USDC',
          riskLevel: 'high',
          automationLevel: 'partial',
          sourceUrl: `https://www.coingecko.com/en/coins/${coin.id}`,
          metadata: {
            coinId: coin.id,
            symbol: coin.symbol,
            name: coin.name,
            currentPrice: coin.current_price,
            dailyChange: coin.price_change_percentage_24h,
            weeklyChange: coin.price_change_percentage_7d_in_currency,
            high24h: coin.high_24h,
            low24h: coin.low_24h,
            dailyRange,
            volume24h: coin.total_volume,
            marketCap: coin.market_cap,
            volatilityScore,
          },
        });
      }
    }

    // Sort by volatility and take top opportunities
    opportunities.sort(
      (a, b) =>
        ((b.metadata.volatilityScore as number) || 0) -
        ((a.metadata.volatilityScore as number) || 0),
    );

    return opportunities.slice(0, 8);
  }

  // ── New DEX Listings Scanner ─────────────────────────────────────────────

  private async scanNewDEXListings(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    // Scan multiple DEXes in parallel
    const dexScans = [
      this.scanAerodromePools(),
      this.scanDexScreenerNew(),
    ];

    const results = await Promise.allSettled(dexScans);

    for (const result of results) {
      if (result.status === 'fulfilled') {
        opportunities.push(...result.value);
      }
    }

    return opportunities.slice(0, 10);
  }

  private async scanAerodromePools(): Promise<RawOpportunity[]> {
    // Aerodrome is the main DEX on Base chain
    interface AerodromePool {
      address: string;
      symbol: string;
      token0: { symbol: string; address: string };
      token1: { symbol: string; address: string };
      tvl: number;
      apr: number;
      volume24h: number;
      isStable: boolean;
      createdAt?: number;
    }

    interface AerodromeResponse {
      data: AerodromePool[];
    }

    const data = await fetchJson<AerodromeResponse>(AERODROME_API);
    if (!data || !Array.isArray(data.data)) {
      console.log(`${LOG_PREFIX} Aerodrome API returned no data`);
      return [];
    }

    const opportunities: RawOpportunity[] = [];
    const now = Date.now();
    const maxAge = NEW_POOL_MAX_AGE_HOURS * 60 * 60 * 1000;

    for (const pool of data.data) {
      // Look for new pools or high APR pools
      const isNew = pool.createdAt && now - pool.createdAt < maxAge;
      const hasHighApr = pool.apr >= MIN_APY_THRESHOLD;

      if ((isNew || hasHighApr) && pool.tvl >= 10_000) {
        const riskLevel = calculateRiskLevel(
          pool.apr,
          pool.tvl,
          pool.isStable,
        );

        opportunities.push({
          title: `Aerodrome ${pool.symbol}: ${pool.apr.toFixed(1)}% APR${isNew ? ' (NEW)' : ''}`,
          source: 'aerodrome-base',
          category: 'trading',
          description: `${isNew ? 'New pool on Aerodrome (Base). ' : ''}Pair: ${pool.token0.symbol}/${pool.token1.symbol}. APR: ${pool.apr.toFixed(2)}%. TVL: $${(pool.tvl / 1000).toFixed(1)}k. 24h Volume: $${(pool.volume24h / 1000).toFixed(1)}k. ${pool.isStable ? 'Stable pool.' : 'Volatile pool.'}`,
          estimatedRevenue: `~$${((99 * pool.apr) / 100 / 12).toFixed(2)}/month`,
          capitalRequired: '$20-99 USDC',
          riskLevel,
          automationLevel: 'full',
          sourceUrl: `https://aerodrome.finance/pools/${pool.address}`,
          metadata: {
            poolAddress: pool.address,
            chain: 'base',
            dex: 'aerodrome',
            token0: pool.token0.symbol,
            token1: pool.token1.symbol,
            apr: pool.apr,
            tvl: pool.tvl,
            volume24h: pool.volume24h,
            isStable: pool.isStable,
            isNew,
          },
        });
      }
    }

    // Sort by APR
    opportunities.sort(
      (a, b) =>
        ((b.metadata.apr as number) || 0) - ((a.metadata.apr as number) || 0),
    );

    return opportunities.slice(0, 8);
  }

  private async scanDexScreenerNew(): Promise<RawOpportunity[]> {
    // DexScreener API for new pairs across chains
    interface DexScreenerPair {
      chainId: string;
      dexId: string;
      url: string;
      pairAddress: string;
      baseToken: { symbol: string; name: string };
      quoteToken: { symbol: string };
      priceUsd: string;
      txns: { h24: { buys: number; sells: number } };
      volume: { h24: number };
      priceChange: { h24: number };
      liquidity: { usd: number };
      pairCreatedAt?: number;
    }

    interface DexScreenerResponse {
      pairs: DexScreenerPair[];
    }

    // Look for new pairs on Base and Ethereum
    const chains = ['base', 'ethereum'];
    const opportunities: RawOpportunity[] = [];

    for (const chain of chains) {
      const data = await fetchJson<DexScreenerResponse>(
        `https://api.dexscreener.com/latest/dex/search?q=chain:${chain}`,
      );

      if (!data || !Array.isArray(data.pairs)) continue;

      const now = Date.now();
      const maxAge = NEW_POOL_MAX_AGE_HOURS * 60 * 60 * 1000;

      for (const pair of data.pairs.slice(0, 20)) {
        const isNew = pair.pairCreatedAt && now - pair.pairCreatedAt < maxAge;
        const liquidity = pair.liquidity?.usd || 0;
        const volume24h = pair.volume?.h24 || 0;
        const priceChange = pair.priceChange?.h24 || 0;

        // Filter for meaningful liquidity and activity
        if (liquidity < 50_000 || volume24h < 10_000) continue;
        if (!isNew && Math.abs(priceChange) < 10) continue;

        const riskLevel: 'low' | 'medium' | 'high' =
          liquidity > 500_000 ? 'medium' : 'high';

        opportunities.push({
          title: `${pair.baseToken.symbol}/${pair.quoteToken.symbol} on ${pair.dexId}${isNew ? ' (NEW)' : ''}`,
          source: `dexscreener-${chain}`,
          category: 'trading',
          description: `${isNew ? 'Newly listed pair. ' : ''}${pair.baseToken.name} on ${chain}. Price: $${parseFloat(pair.priceUsd).toFixed(6)}. 24h change: ${priceChange.toFixed(2)}%. Liquidity: $${(liquidity / 1000).toFixed(1)}k. 24h volume: $${(volume24h / 1000).toFixed(1)}k.`,
          estimatedRevenue: 'Variable (early-stage opportunity)',
          capitalRequired: '$10-50 USDC',
          riskLevel,
          automationLevel: 'partial',
          sourceUrl: pair.url,
          metadata: {
            chain,
            dex: pair.dexId,
            pairAddress: pair.pairAddress,
            baseToken: pair.baseToken.symbol,
            quoteToken: pair.quoteToken.symbol,
            priceUsd: pair.priceUsd,
            priceChange24h: priceChange,
            liquidity,
            volume24h,
            buys24h: pair.txns?.h24?.buys,
            sells24h: pair.txns?.h24?.sells,
            isNew,
            pairCreatedAt: pair.pairCreatedAt,
          },
        });
      }
    }

    return opportunities.slice(0, 8);
  }
}

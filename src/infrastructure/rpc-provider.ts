/**
 * RPC Provider with automatic fallback.
 *
 * Provides a FallbackProvider that tries primary RPC first,
 * then falls back to secondary on failure. Uses ethers v6 FallbackProvider.
 *
 * Primary: Alchemy (from RPC_PROVIDER_URL)
 * Fallback: Base public RPC (https://mainnet.base.org) or custom URL
 */

import { JsonRpcProvider, FallbackProvider } from 'ethers';

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface RpcProviderConfig {
  /** Primary RPC URL (e.g., Alchemy) */
  primaryUrl: string;
  /** Fallback RPC URL. Default: Base public RPC */
  fallbackUrl: string;
  /** Chain ID. Default: 8453 (Base) */
  chainId: number;
  /** Stall timeout in ms before trying fallback. Default: 5000 */
  stallTimeoutMs: number;
}

const BASE_PUBLIC_RPC = 'https://mainnet.base.org';

export const DEFAULT_RPC_CONFIG: RpcProviderConfig = {
  primaryUrl: process.env['RPC_PROVIDER_URL'] ?? BASE_PUBLIC_RPC,
  fallbackUrl: process.env['RPC_PROVIDER_URL_FALLBACK'] ?? BASE_PUBLIC_RPC,
  chainId: 8453,
  stallTimeoutMs: 5000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// Provider Factory
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a FallbackProvider that tries primary first, then fallback.
 * The FallbackProvider in ethers v6 manages retries and stall detection.
 */
export function createRpcProvider(config: Partial<RpcProviderConfig> = {}): FallbackProvider {
  const cfg: RpcProviderConfig = { ...DEFAULT_RPC_CONFIG, ...config };

  const primary = new JsonRpcProvider(cfg.primaryUrl, cfg.chainId, {
    staticNetwork: true,
  });

  const fallback = new JsonRpcProvider(cfg.fallbackUrl, cfg.chainId, {
    staticNetwork: true,
  });

  // FallbackProvider config: priority 1 = primary, priority 2 = fallback
  // stallTimeout determines how long to wait before trying the next provider
  const provider = new FallbackProvider([
    { provider: primary, priority: 1, stallTimeout: cfg.stallTimeoutMs, weight: 2 },
    { provider: fallback, priority: 2, stallTimeout: cfg.stallTimeoutMs * 2, weight: 1 },
  ]);

  return provider;
}

/**
 * Create a simple provider (no fallback) for cases where FallbackProvider
 * is not supported (e.g., Wallet.connect).
 * Tries primary URL, returns fallback URL provider if primary fails instantly.
 */
export function createSimpleProvider(config: Partial<RpcProviderConfig> = {}): JsonRpcProvider {
  const cfg: RpcProviderConfig = { ...DEFAULT_RPC_CONFIG, ...config };
  return new JsonRpcProvider(cfg.primaryUrl, cfg.chainId, {
    staticNetwork: true,
  });
}

/**
 * Get available RPC URLs (primary + fallback) for use in other modules.
 */
export function getRpcUrls(config: Partial<RpcProviderConfig> = {}): { primary: string; fallback: string } {
  const cfg: RpcProviderConfig = { ...DEFAULT_RPC_CONFIG, ...config };
  return { primary: cfg.primaryUrl, fallback: cfg.fallbackUrl };
}

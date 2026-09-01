/**
 * Web Scraping Service Handler
 *
 * Service ID : web-scraping
 * Price      : $0.20 USDC (200_000n in 6-decimal units)
 * Timeout    : 30 seconds
 *
 * Fetches a URL and optionally extracts structured data using CSS selectors.
 * Uses the MCP Web Scraping server functions (fetchPage / extractData / getJson)
 * directly — no subprocess round-trip is needed since we import the handlers.
 *
 * Requirement: 7.3, 13.3
 */

import { fetchPage, extractData, getJson } from '../../../mcp/servers/web-server.js';
import type { ServiceResult } from '../service-registry.js';

// ---------------------------------------------------------------------------
// Handler input schema
// ---------------------------------------------------------------------------

export interface ScrapeParams {
  url: string;
  /** Operation type: 'fetch' (raw HTML), 'extract' (CSS selectors), or 'json'. */
  operation?: 'fetch' | 'extract' | 'json';
  /**
   * CSS selector map for the 'extract' operation.
   * E.g. { title: 'h1', prices: '.price' }
   */
  selectors?: Record<string, string>;
  /** Extra HTTP headers to include in the request. */
  headers?: Record<string, string>;
  /** Request timeout override in milliseconds (max 20_000). */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// JSON Schema exported for ServiceDescriptor
// ---------------------------------------------------------------------------

export const SCRAPE_SCHEMA = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      description: 'The URL to scrape (must start with http:// or https://).',
    },
    operation: {
      type: 'string',
      enum: ['fetch', 'extract', 'json'],
      description: 'Operation: "fetch" returns raw HTML, "extract" applies CSS selectors, "json" parses JSON response. Defaults to "fetch".',
    },
    selectors: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'CSS selector map used when operation="extract". E.g. { title: "h1", prices: ".price" }.',
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Additional HTTP headers to send with the request.',
    },
    timeoutMs: {
      type: 'number',
      minimum: 500,
      maximum: 20000,
      description: 'Request timeout in milliseconds (default: 15000, max: 20000).',
    },
  },
  required: ['url'],
  additionalProperties: false,
} as const;

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Web scraping handler.
 * Delegates to the MCP web-server functions (fetchPage, extractData, getJson)
 * without spawning a subprocess.
 */
export async function scrapeHandler(params: unknown): Promise<ServiceResult> {
  const startMs = Date.now();

  const p = params as ScrapeParams;
  const url = typeof p?.url === 'string' ? p.url.trim() : '';

  if (!url) {
    return {
      success: false,
      error: 'Missing required parameter: url',
      latencyMs: Date.now() - startMs,
    };
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return {
      success: false,
      error: 'Parameter "url" must start with http:// or https://',
      latencyMs: Date.now() - startMs,
    };
  }

  const operation = p.operation ?? 'fetch';
  const timeoutMs = Math.min(p.timeoutMs ?? 15_000, 20_000);

  try {
    switch (operation) {
      case 'json': {
        const result = await getJson({ url, headers: p.headers });
        return {
          success: result.statusCode >= 200 && result.statusCode < 300,
          data: { statusCode: result.statusCode, data: result.data },
          error:
            result.statusCode < 200 || result.statusCode >= 300
              ? `HTTP ${result.statusCode} response from ${url}`
              : undefined,
          latencyMs: Date.now() - startMs,
        };
      }

      case 'extract': {
        if (!p.selectors || Object.keys(p.selectors).length === 0) {
          return {
            success: false,
            error: 'Parameter "selectors" is required and must be non-empty for operation="extract".',
            latencyMs: Date.now() - startMs,
          };
        }

        // First fetch the HTML
        const pageResult = await fetchPage({
          url,
          options: { timeoutMs, headers: p.headers },
        });

        if (pageResult.statusCode < 200 || pageResult.statusCode >= 300) {
          return {
            success: false,
            error: `HTTP ${pageResult.statusCode} response from ${url}`,
            data: { statusCode: pageResult.statusCode },
            latencyMs: Date.now() - startMs,
          };
        }

        // Then extract structured data
        const extractResult = extractData({
          html: pageResult.html,
          selectors: p.selectors,
        });

        return {
          success: true,
          data: {
            url,
            statusCode: pageResult.statusCode,
            extracted: extractResult.data,
          },
          latencyMs: Date.now() - startMs,
        };
      }

      case 'fetch':
      default: {
        const result = await fetchPage({
          url,
          options: { timeoutMs, headers: p.headers },
        });

        return {
          success: result.statusCode >= 200 && result.statusCode < 300,
          data: {
            url,
            statusCode: result.statusCode,
            html: result.html,
            headers: result.headers,
          },
          error:
            result.statusCode < 200 || result.statusCode >= 300
              ? `HTTP ${result.statusCode} response from ${url}`
              : undefined,
          latencyMs: Date.now() - startMs,
        };
      }
    }
  } catch (err) {
    return {
      success: false,
      error: `Web scraping failed: ${(err as Error).message}`,
      latencyMs: Date.now() - startMs,
    };
  }
}

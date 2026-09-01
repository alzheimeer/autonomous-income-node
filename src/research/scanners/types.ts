/**
 * Scanner interfaces and base types.
 *
 * Each scanner implements IResearchScanner to discover monetization opportunities
 * from different sources. Scanners are organized by priority:
 * - P1: A2A agent marketplaces (highest priority)
 * - P2: RPA browser automation
 * - P3: Content generation (YouTube/TikTok)
 * - P4: Trading (lowest priority, requires approval gate)
 */

import type { RawOpportunity, Priority } from '../comms/protocol.js';

// Re-export for convenience
export type { RawOpportunity, Priority } from '../comms/protocol.js';

// ── Scanner Interface ──────────────────────────────────────────────────────

/**
 * Interface that all research scanners must implement.
 * Each scanner discovers opportunities from specific sources.
 */
export interface IResearchScanner {
  /** Human-readable name for the scanner (e.g., "marketplace-scanner") */
  readonly name: string;

  /** Priority category for this scanner's opportunities */
  readonly priority: Priority;

  /**
   * Execute the scan to discover opportunities.
   * Should handle errors internally and return empty array on failure.
   * @returns Promise resolving to array of raw opportunities
   */
  scan(): Promise<RawOpportunity[]>;
}

// ── Scanner Configuration ──────────────────────────────────────────────────

/**
 * Common configuration options for scanners.
 */
export interface ScannerConfig {
  /** Whether the scanner is enabled */
  enabled: boolean;

  /** Request timeout in milliseconds */
  timeoutMs: number;

  /** Maximum number of opportunities to return per scan */
  maxResults: number;

  /** Delay between requests in milliseconds (rate limiting) */
  requestDelayMs: number;

  /** Optional API key for the scanner's data source */
  apiKey?: string;

  /** Optional base URL override for the scanner's data source */
  baseUrl?: string;

  /** Scanner-specific additional configuration */
  extra?: Record<string, unknown>;
}

/**
 * Default scanner configuration values.
 */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  enabled: true,
  timeoutMs: 30_000,
  maxResults: 50,
  requestDelayMs: 1_000,
};

// ── Scan Result ────────────────────────────────────────────────────────────

/**
 * Error details from a failed scan operation.
 */
export interface ScanError {
  /** Error code or type */
  code: string;

  /** Human-readable error message */
  message: string;

  /** Source that failed (e.g., specific API endpoint) */
  source?: string;

  /** Whether the error is retryable */
  retryable: boolean;

  /** Original error stack trace (for debugging) */
  stack?: string;
}

/**
 * Result wrapper for scanner output with metadata.
 * Provides context about the scan operation beyond just the opportunities.
 */
export interface ScanResult {
  /** Name of the scanner that produced this result */
  scannerName: string;

  /** Priority category of the scanner */
  priority: Priority;

  /** Discovered opportunities (empty array if scan failed) */
  opportunities: RawOpportunity[];

  /** Duration of the scan in milliseconds */
  durationMs: number;

  /** Unix timestamp when the scan started */
  startedAt: number;

  /** Unix timestamp when the scan completed */
  completedAt: number;

  /** Whether the scan completed successfully */
  success: boolean;

  /** Errors encountered during scanning (may have partial results) */
  errors: ScanError[];

  /** Number of sources checked by the scanner */
  sourcesChecked: number;

  /** Number of sources that failed */
  sourcesFailed: number;
}

// ── Helper Functions ───────────────────────────────────────────────────────

/**
 * Create a successful ScanResult with the given opportunities.
 */
export function createSuccessResult(
  scannerName: string,
  priority: Priority,
  opportunities: RawOpportunity[],
  startedAt: number,
  sourcesChecked: number = 1,
): ScanResult {
  const completedAt = Date.now();
  return {
    scannerName,
    priority,
    opportunities,
    durationMs: completedAt - startedAt,
    startedAt,
    completedAt,
    success: true,
    errors: [],
    sourcesChecked,
    sourcesFailed: 0,
  };
}

/**
 * Create a failed ScanResult with the given error.
 */
export function createErrorResult(
  scannerName: string,
  priority: Priority,
  error: Error | ScanError,
  startedAt: number,
  sourcesChecked: number = 1,
  partialOpportunities: RawOpportunity[] = [],
): ScanResult {
  const completedAt = Date.now();
  const scanError: ScanError = 'retryable' in error
    ? error
    : {
        code: error.name || 'UNKNOWN_ERROR',
        message: error.message,
        retryable: true,
        stack: error.stack,
      };

  return {
    scannerName,
    priority,
    opportunities: partialOpportunities,
    durationMs: completedAt - startedAt,
    startedAt,
    completedAt,
    success: false,
    errors: [scanError],
    sourcesChecked,
    sourcesFailed: 1,
  };
}

/**
 * Merge multiple ScanResults into a single aggregated result.
 * Useful for scanners that check multiple sources.
 */
export function mergeScanResults(
  scannerName: string,
  priority: Priority,
  results: ScanResult[],
): ScanResult {
  if (results.length === 0) {
    return {
      scannerName,
      priority,
      opportunities: [],
      durationMs: 0,
      startedAt: Date.now(),
      completedAt: Date.now(),
      success: true,
      errors: [],
      sourcesChecked: 0,
      sourcesFailed: 0,
    };
  }

  const startedAt = Math.min(...results.map((r) => r.startedAt));
  const completedAt = Math.max(...results.map((r) => r.completedAt));

  return {
    scannerName,
    priority,
    opportunities: results.flatMap((r) => r.opportunities),
    durationMs: completedAt - startedAt,
    startedAt,
    completedAt,
    success: results.every((r) => r.success),
    errors: results.flatMap((r) => r.errors),
    sourcesChecked: results.reduce((sum, r) => sum + r.sourcesChecked, 0),
    sourcesFailed: results.reduce((sum, r) => sum + r.sourcesFailed, 0),
  };
}

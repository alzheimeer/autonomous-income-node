/**
 * Process Monitor — Infrastructure Module
 *
 * Monitors a running process/service health via periodic HTTP polling.
 * Fires callbacks on health transitions (healthy→unhealthy or vice versa).
 *
 * Features:
 * - Configurable polling interval and request timeout
 * - Tracks consecutive failures and total check statistics
 * - Emits status change callback only on transitions
 * - Uses native fetch with AbortSignal.timeout (Node 20+)
 *
 * Requirements: 3.3, 3.5
 */

import { createLogger } from '../logger.js';

const log = createLogger('process-monitor');

// ═══════════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProcessMonitorConfig {
  /** URL to health-check */
  healthCheckUrl: string;
  /** Polling interval (ms). Default: 30_000 */
  intervalMs: number;
  /** Timeout for each health-check request (ms). Default: 5_000 */
  timeoutMs: number;
}

export interface ProcessMonitorStatus {
  healthy: boolean;
  lastCheckAt: number;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  totalChecks: number;
  totalSuccesses: number;
}

export interface IProcessMonitor {
  start(): void;
  stop(): void;
  getStatus(): ProcessMonitorStatus;
  isHealthy(): boolean;
  onStatusChange(callback: (healthy: boolean) => void): void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Default configuration values
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class ProcessMonitor implements IProcessMonitor {
  private readonly healthCheckUrl: string;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;

  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private healthy = false;
  private lastCheckAt = 0;
  private lastSuccessAt: number | null = null;
  private consecutiveFailures = 0;
  private totalChecks = 0;
  private totalSuccesses = 0;

  private readonly statusChangeCallbacks: Array<(healthy: boolean) => void> = [];

  constructor(config: Partial<ProcessMonitorConfig> & { healthCheckUrl: string }) {
    this.healthCheckUrl = config.healthCheckUrl;
    this.intervalMs = config.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Begin periodic health-check polling.
   */
  start(): void {
    if (this.intervalHandle) {
      log.warn('Process monitor already running', { url: this.healthCheckUrl });
      return;
    }

    log.info('Starting process monitor', {
      url: this.healthCheckUrl,
      intervalMs: this.intervalMs,
      timeoutMs: this.timeoutMs,
    });

    // Run first check immediately
    void this.performCheck();

    this.intervalHandle = setInterval(() => {
      void this.performCheck();
    }, this.intervalMs);
  }

  /**
   * Stop polling and clear interval.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info('Process monitor stopped', { url: this.healthCheckUrl });
    }
  }

  /**
   * Return current health status object.
   */
  getStatus(): ProcessMonitorStatus {
    return {
      healthy: this.healthy,
      lastCheckAt: this.lastCheckAt,
      lastSuccessAt: this.lastSuccessAt,
      consecutiveFailures: this.consecutiveFailures,
      totalChecks: this.totalChecks,
      totalSuccesses: this.totalSuccesses,
    };
  }

  /**
   * Simple boolean check for current health.
   */
  isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Register a callback fired when health transitions
   * (healthy→unhealthy or unhealthy→healthy).
   */
  onStatusChange(callback: (healthy: boolean) => void): void {
    this.statusChangeCallbacks.push(callback);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Perform a single health check by fetching the configured URL.
   * Response 200 → healthy, anything else → unhealthy.
   */
  private async performCheck(): Promise<void> {
    this.totalChecks++;
    this.lastCheckAt = Date.now();

    const previousHealthy = this.healthy;

    try {
      const response = await fetch(this.healthCheckUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (response.status === 200) {
        this.handleSuccess();
      } else {
        this.handleFailure(`HTTP ${response.status}`);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.handleFailure(message);
    }

    // Emit status change callback only on transitions
    if (previousHealthy !== this.healthy) {
      this.emitStatusChange(this.healthy);
    }
  }

  /**
   * Handle a successful health check (HTTP 200 response).
   */
  private handleSuccess(): void {
    this.healthy = true;
    this.lastSuccessAt = Date.now();
    this.consecutiveFailures = 0;
    this.totalSuccesses++;

    log.debug('Health check passed', {
      url: this.healthCheckUrl,
      totalChecks: this.totalChecks,
      totalSuccesses: this.totalSuccesses,
    });
  }

  /**
   * Handle a failed health check (non-200 or fetch error).
   */
  private handleFailure(reason: string): void {
    this.healthy = false;
    this.consecutiveFailures++;

    log.warn('Health check failed', {
      url: this.healthCheckUrl,
      reason,
      consecutiveFailures: this.consecutiveFailures,
      totalChecks: this.totalChecks,
    });
  }

  /**
   * Emit the status change to all registered callbacks.
   */
  private emitStatusChange(healthy: boolean): void {
    log.info('Health status changed', {
      url: this.healthCheckUrl,
      healthy,
      consecutiveFailures: this.consecutiveFailures,
    });

    for (const callback of this.statusChangeCallbacks) {
      try {
        callback(healthy);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Status change callback threw', { error: message });
      }
    }
  }
}

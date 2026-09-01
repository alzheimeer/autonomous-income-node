/**
 * OKX Heartbeat Service — Periodic heartbeat to maintain "online" status on OKX AI Marketplace.
 *
 * Sends heartbeat via the `onchainos` CLI tool every N minutes (default: 25 min).
 * OKX checks every 30 minutes, so 25 min ensures the agent stays "online".
 *
 * If `onchainos` binary is not available (e.g. inside Docker), the service
 * logs a warning and continues without crashing.
 *
 * Environment:
 * - OKX_AGENT_ID: Agent ID on OKX marketplace (default: '6740')
 * - OKX_HEARTBEAT_INTERVAL_MS: Interval between heartbeats (default: 1500000 = 25 min)
 * - OKX_HEARTBEAT_ENABLED: Enable/disable heartbeat (default: 'true')
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface OkxHeartbeatConfig {
  /** Interval between heartbeats in milliseconds. Default: 25 * 60 * 1000 (25 min) */
  intervalMs: number;
  /** OKX AI Marketplace agent ID. Default: '6740' */
  agentId: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Service
// ═══════════════════════════════════════════════════════════════════════════════

export class OkxHeartbeatService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private consecutiveFailures = 0;
  private lastSuccess: number | null = null;

  constructor(private readonly config: OkxHeartbeatConfig) {}

  /**
   * Start the heartbeat loop.
   * Sends an initial heartbeat immediately, then repeats at the configured interval.
   */
  start(): void {
    if (this.running) {
      console.warn('[OkxHeartbeat] Already running.');
      return;
    }

    this.running = true;

    // Send initial heartbeat immediately
    this.sendHeartbeat();

    // Schedule periodic heartbeats
    this.intervalHandle = setInterval(() => {
      this.sendHeartbeat();
    }, this.config.intervalMs);

    console.log(
      `[OkxHeartbeat] Started — agent #${this.config.agentId}, ` +
      `interval: ${Math.round(this.config.intervalMs / 60_000)}min`,
    );
  }

  /**
   * Stop the heartbeat loop.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.running = false;
    console.log('[OkxHeartbeat] Stopped.');
  }

  /**
   * Get current status info for health endpoints.
   */
  getStatus(): { running: boolean; lastSuccess: number | null; consecutiveFailures: number } {
    return {
      running: this.running,
      lastSuccess: this.lastSuccess,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Send a single heartbeat via `onchainos agent heartbeat` CLI command.
   * Handles gracefully:
   * - Command not found (Docker / no onchainos installed)
   * - Network errors
   * - Any other failures
   */
  private async sendHeartbeat(): Promise<void> {
    const command = `onchainos agent heartbeat --agent-id ${this.config.agentId}`;

    try {
      const { stdout, stderr } = await execAsync(command, {
        timeout: 30_000, // 30 second timeout
        env: { ...process.env },
      });

      this.consecutiveFailures = 0;
      this.lastSuccess = Date.now();

      const output = (stdout || '').trim();
      if (output) {
        console.log(`[OkxHeartbeat] ✓ Heartbeat sent (agent #${this.config.agentId}): ${output}`);
      } else {
        console.log(`[OkxHeartbeat] ✓ Heartbeat sent (agent #${this.config.agentId})`);
      }

      if (stderr && stderr.trim()) {
        console.warn(`[OkxHeartbeat] stderr: ${stderr.trim()}`);
      }
    } catch (err: unknown) {
      this.consecutiveFailures++;
      const error = err as Error & { code?: string; killed?: boolean };

      // Determine failure type and log appropriately
      if (error.code === 'ENOENT' || error.message?.includes('not found') || error.message?.includes('is not recognized')) {
        // onchainos binary not available — expected in Docker
        if (this.consecutiveFailures <= 1) {
          console.warn(
            '[OkxHeartbeat] ⚠ `onchainos` command not found. ' +
            'Heartbeat requires the OnchainOS CLI. ' +
            'Set OKX_HEARTBEAT_ENABLED=false in Docker environments.',
          );
        }
        // Don't spam logs — only warn on first failure
      } else if (error.killed) {
        console.warn('[OkxHeartbeat] ⚠ Heartbeat command timed out (30s).');
      } else {
        console.warn(
          `[OkxHeartbeat] ⚠ Heartbeat failed (attempt #${this.consecutiveFailures}): ` +
          `${error.message ?? 'Unknown error'}`,
        );
      }

      // After 5 consecutive failures, reduce log frequency
      if (this.consecutiveFailures === 5) {
        console.warn(
          '[OkxHeartbeat] 5 consecutive failures. Will continue retrying silently.',
        );
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Factory
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create an OkxHeartbeatService with configuration from environment variables.
 */
export function createOkxHeartbeatService(overrides?: Partial<OkxHeartbeatConfig>): OkxHeartbeatService {
  const config: OkxHeartbeatConfig = {
    agentId: overrides?.agentId ?? process.env['OKX_AGENT_ID'] ?? '6740',
    intervalMs: overrides?.intervalMs ?? parseInt(process.env['OKX_HEARTBEAT_INTERVAL_MS'] ?? '1500000', 10),
  };

  return new OkxHeartbeatService(config);
}

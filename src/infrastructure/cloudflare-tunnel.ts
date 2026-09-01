/**
 * Cloudflare Tunnel Manager — Infrastructure Module
 *
 * Manages a `cloudflared` child process to expose the agent's local HTTP API
 * via a permanent public URL. Supports both named tunnels (with token) and
 * quick tunnels (no token).
 *
 * Features:
 * - Auto-restart within 10 seconds on unexpected termination
 * - Falls back to unhealthy state after 3 failed restart attempts
 * - Tracks restart count and uptime
 * - Graceful stop (SIGTERM, then SIGKILL after 5s)
 * - Logs all lifecycle events
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createLogger } from '../logger.js';
import type { CloudflareTunnelConfig } from '../config/income-sustainability.config.js';

const log = createLogger('cloudflare-tunnel');

// ═══════════════════════════════════════════════════════════════════════════════
// Interfaces
// ═══════════════════════════════════════════════════════════════════════════════

export interface TunnelConfig {
  subdomain: string;
  localPort: number;
  cloudflaredPath?: string;
  tunnelToken: string;
}

export interface TunnelStatus {
  healthy: boolean;
  publicUrl: string;
  pid: number | null;
  uptimeMs: number;
  restartCount: number;
}

export interface ITunnelManager {
  start(): Promise<string>; // returns public URL
  stop(): Promise<void>;
  getStatus(): TunnelStatus;
  getPublicUrl(): string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════════

/** Maximum restart attempts before marking tunnel as unhealthy */
const MAX_RESTART_ATTEMPTS = 3;

/** Delay before auto-restart on unexpected exit (ms) */
const RESTART_DELAY_MS = 10_000;

/** Timeout for graceful shutdown before SIGKILL (ms) */
const KILL_TIMEOUT_MS = 5_000;

/** Timeout waiting for the public URL to appear in stdout (ms) */
const URL_PARSE_TIMEOUT_MS = 30_000;

/** Regex to match cloudflared's quick-tunnel URL output */
const URL_REGEX = /https?:\/\/[^\s]+\.trycloudflare\.com[^\s]*/;

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class CloudflareTunnelManager implements ITunnelManager {
  private process: ChildProcess | null = null;
  private publicUrl = '';
  private healthy = false;
  private restartCount = 0;
  private startedAt: number | null = null;
  private stopping = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly cloudflaredPath: string;
  private readonly localPort: number;
  private readonly tunnelToken: string;
  private readonly subdomain: string;

  constructor(config: TunnelConfig | CloudflareTunnelConfig, cloudflaredPath?: string) {
    this.localPort = config.localPort;
    this.tunnelToken = config.tunnelToken;
    this.subdomain = config.subdomain;
    this.cloudflaredPath =
      ('cloudflaredPath' in config && config.cloudflaredPath)
        ? config.cloudflaredPath
        : cloudflaredPath ?? 'cloudflared';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Start the cloudflared tunnel process.
   * Returns the public URL once cloudflared reports it.
   */
  async start(): Promise<string> {
    if (this.process) {
      log.warn('Tunnel process already running', { pid: this.process.pid });
      return this.publicUrl;
    }

    this.stopping = false;
    this.restartCount = 0;

    return this.spawnTunnel();
  }

  /**
   * Stop the cloudflared tunnel gracefully.
   * Sends SIGTERM first, then SIGKILL after 5 seconds if process doesn't exit.
   */
  async stop(): Promise<void> {
    this.stopping = true;

    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    if (!this.process) {
      log.info('No tunnel process to stop');
      return;
    }

    const proc = this.process;
    const pid = proc.pid;

    log.info('Stopping cloudflared tunnel', { pid });

    return new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        log.warn('Tunnel did not exit gracefully, sending SIGKILL', { pid });
        try {
          proc.kill('SIGKILL');
        } catch {
          // Process may have already exited
        }
      }, KILL_TIMEOUT_MS);

      proc.once('exit', () => {
        clearTimeout(killTimer);
        this.cleanup();
        log.info('Tunnel process stopped', { pid });
        resolve();
      });

      try {
        // On Windows, kill() sends a termination signal regardless of signal name
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(killTimer);
        this.cleanup();
        resolve();
      }
    });
  }

  /**
   * Get the current tunnel status including health, URL, PID, uptime.
   */
  getStatus(): TunnelStatus {
    return {
      healthy: this.healthy,
      publicUrl: this.publicUrl,
      pid: this.process?.pid ?? null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      restartCount: this.restartCount,
    };
  }

  /**
   * Get the public URL, or empty string if not connected.
   */
  getPublicUrl(): string {
    return this.publicUrl;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Spawn the cloudflared process and wait for the public URL.
   */
  private async spawnTunnel(): Promise<string> {
    const args = this.buildArgs();

    log.info('Spawning cloudflared', {
      path: this.cloudflaredPath,
      args,
      mode: this.tunnelToken ? 'named' : 'quick',
    });

    return new Promise<string>((resolve, reject) => {
      let urlResolved = false;
      let output = '';

      try {
        this.process = spawn(this.cloudflaredPath, args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: false,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Failed to spawn cloudflared — is it installed?', { error: message });
        this.healthy = false;
        reject(new Error(`Failed to spawn cloudflared: ${message}`));
        return;
      }

      const proc = this.process;
      const pid = proc.pid;

      if (!pid) {
        log.error('cloudflared process has no PID — spawn likely failed');
        this.healthy = false;
        reject(new Error('cloudflared spawn failed: no PID'));
        return;
      }

      log.info('cloudflared process spawned', { pid });

      // Timeout for URL parsing
      const urlTimeout = setTimeout(() => {
        if (!urlResolved) {
          urlResolved = true;
          // If we have a named tunnel with a known subdomain, use that
          if (this.tunnelToken && this.subdomain) {
            this.publicUrl = `https://${this.subdomain}`;
            this.healthy = true;
            this.startedAt = Date.now();
            log.info('URL parse timeout — using configured subdomain as public URL', {
              url: this.publicUrl,
            });
            resolve(this.publicUrl);
          } else {
            log.warn('Timed out waiting for cloudflared to report public URL');
            this.healthy = false;
            reject(new Error('Timed out waiting for cloudflared public URL'));
          }
        }
      }, URL_PARSE_TIMEOUT_MS);

      // Parse stdout for the public URL
      const handleOutput = (data: Buffer): void => {
        const chunk = data.toString();
        output += chunk;

        if (!urlResolved) {
          const url = this.parseUrl(output);
          if (url) {
            urlResolved = true;
            clearTimeout(urlTimeout);
            this.publicUrl = url;
            this.healthy = true;
            this.startedAt = Date.now();
            log.info('Tunnel established', { url, pid });
            resolve(url);
          }
        }
      };

      proc.stdout?.on('data', handleOutput);
      proc.stderr?.on('data', handleOutput);

      // Handle spawn error
      proc.on('error', (err: Error) => {
        log.error('cloudflared process error', { error: err.message, pid });
        if (!urlResolved) {
          urlResolved = true;
          clearTimeout(urlTimeout);
          this.healthy = false;
          reject(new Error(`cloudflared error: ${err.message}`));
        }
      });

      // Handle unexpected exit
      proc.on('exit', (code, signal) => {
        log.warn('cloudflared process exited', { code, signal, pid });

        if (!urlResolved) {
          urlResolved = true;
          clearTimeout(urlTimeout);
          this.healthy = false;
          reject(new Error(`cloudflared exited with code ${code}`));
          return;
        }

        // Unexpected exit after URL was established
        this.healthy = false;
        this.process = null;

        if (!this.stopping) {
          this.scheduleRestart();
        }
      });
    });
  }

  /**
   * Build command-line arguments for cloudflared.
   * Named tunnel mode: `tunnel --no-autoupdate run --token <token>`
   * Quick tunnel mode: `tunnel --no-autoupdate --url http://localhost:<port>`
   */
  private buildArgs(): string[] {
    if (this.tunnelToken) {
      // Named tunnel mode — tunnel is pre-configured in Cloudflare dashboard
      return ['tunnel', '--no-autoupdate', 'run', '--token', this.tunnelToken];
    }

    // Quick tunnel mode — cloudflared assigns a random *.trycloudflare.com URL
    return ['tunnel', '--no-autoupdate', '--url', `http://localhost:${this.localPort}`];
  }

  /**
   * Parse cloudflared output for a public URL.
   */
  private parseUrl(output: string): string | null {
    // Quick tunnel mode produces *.trycloudflare.com URLs
    const quickMatch = output.match(URL_REGEX);
    if (quickMatch) {
      return quickMatch[0].replace(/['"]+$/, '');
    }

    // Named tunnel mode — look for the configured subdomain or any https URL
    if (this.tunnelToken && this.subdomain) {
      if (output.includes(this.subdomain)) {
        return `https://${this.subdomain}`;
      }
    }

    // Fallback: look for "connector registered" or route info indicating readiness
    if (this.tunnelToken && output.includes('Connection')) {
      if (this.subdomain) {
        return `https://${this.subdomain}`;
      }
    }

    return null;
  }

  /**
   * Schedule a restart attempt after unexpected process exit.
   * Gives up after MAX_RESTART_ATTEMPTS consecutive failures.
   */
  private scheduleRestart(): void {
    this.restartCount++;

    if (this.restartCount > MAX_RESTART_ATTEMPTS) {
      log.error(
        'cloudflared exceeded maximum restart attempts — marking tunnel unhealthy',
        { restartCount: this.restartCount, maxAttempts: MAX_RESTART_ATTEMPTS },
      );
      this.healthy = false;
      this.publicUrl = '';
      return;
    }

    log.info('Scheduling cloudflared restart', {
      attempt: this.restartCount,
      maxAttempts: MAX_RESTART_ATTEMPTS,
      delayMs: RESTART_DELAY_MS,
    });

    this.restartTimer = setTimeout(() => {
      if (this.stopping) return;

      log.info('Attempting cloudflared restart', { attempt: this.restartCount });

      this.spawnTunnel().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error('cloudflared restart failed', {
          attempt: this.restartCount,
          error: message,
        });

        // If still under the limit, schedule another restart
        if (!this.stopping) {
          this.scheduleRestart();
        }
      });
    }, RESTART_DELAY_MS);
  }

  /**
   * Clean up internal state after process exit.
   */
  private cleanup(): void {
    this.process = null;
    this.healthy = false;
    this.startedAt = null;
  }
}

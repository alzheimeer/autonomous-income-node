/**
 * HealthChecker
 *
 * Emits a `heartbeat:health` event every 30 seconds via chained setTimeout
 * (not setInterval — matches the reference automaton pattern).
 *
 * Tracks per-module health and fires `alert:module-degraded` when a module
 * reports an unhealthy status in two consecutive cycles.
 *
 * Falls back to writing heartbeat events to a local log file when the SQLite
 * database is unavailable.
 *
 * On startup, checks for any unrecovered crash events and marks them as
 * recovered (Requirement 11.6).
 *
 * Requirements: 11.1, 11.2, 11.4, 11.6
 */

import { EventEmitter } from 'events';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { SurvivalTier } from '../survival/tier-evaluator.js';
import type { HeartbeatRepository } from '../state/repositories/heartbeat.repo.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ModuleHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  lastCheck: number;
  consecutiveFailures: number;
}

export interface HealthStatus {
  overall: 'healthy' | 'degraded' | 'unhealthy';
  modules: Record<string, ModuleHealthStatus>;
  usdcBalance: bigint;
  /** Balance breakdown: wallet USDC vs Aave aUSDC */
  balanceBreakdown?: {
    walletUsdc: bigint;
    aaveUsdc: bigint;
  };
  tier: SurvivalTier;
  llmAvailable: boolean;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds — Requirement 11.1
const DEGRADED_THRESHOLD = 2;          // consecutive unhealthy cycles — Req 11.2
const FALLBACK_LOG_PATH = './data/heartbeat.log'; // Requirement 11.4

// ---------------------------------------------------------------------------
// HealthChecker
// ---------------------------------------------------------------------------

export class HealthChecker extends EventEmitter {
  private modules: Map<string, ModuleHealthStatus> = new Map();
  private usdcBalance: bigint = 0n;
  private balanceBreakdown: { walletUsdc: bigint; aaveUsdc: bigint } = { walletUsdc: 0n, aaveUsdc: 0n };
  private tier: SurvivalTier = 0 as SurvivalTier; // EMERGENCY default
  private llmAvailable: boolean = false;
  private walletAddress: string = '0x0000000000000000000000000000000000000000';

  private running: boolean = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param repo - Optional heartbeat repository. When null or unavailable,
   *               the checker falls back to writing to the local log file.
   */
  constructor(private readonly repo: HeartbeatRepository | null = null) {
    super();
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start the heartbeat loop.
   * On first call, checks for unrecovered crashes and marks them recovered.
   * Requirement: 11.6
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Handle crash recovery on startup (Requirement 11.6)
    this.handleCrashRecovery();

    this.scheduleNext();
  }

  /** Stop the heartbeat loop. */
  stop(): void {
    this.running = false;
    if (this.timeoutHandle !== null) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }

  // ---------------------------------------------------------------------------
  // External interface
  // ---------------------------------------------------------------------------

  /** Return the current aggregated health status snapshot. */
  getHealthStatus(): HealthStatus {
    return {
      overall: this.computeOverall(),
      modules: Object.fromEntries(this.modules),
      usdcBalance: this.usdcBalance,
      balanceBreakdown: this.balanceBreakdown,
      tier: this.tier,
      llmAvailable: this.llmAvailable,
      timestamp: Date.now(),
    };
  }

  /**
   * Update the health status of a specific module.
   * Called by other modules to report their own status.
   * Accumulates consecutive failure counts for degradation detection.
   */
  setModuleStatus(module: string, status: ModuleHealthStatus): void {
    const existing = this.modules.get(module);

    let consecutiveFailures = status.consecutiveFailures;
    if (status.status === 'unhealthy') {
      consecutiveFailures =
        existing && existing.status === 'unhealthy'
          ? existing.consecutiveFailures + 1
          : 1;
    } else {
      consecutiveFailures = 0;
    }

    this.modules.set(module, {
      ...status,
      consecutiveFailures,
      lastCheck: status.lastCheck ?? Date.now(),
    });
  }

  /** Update the current USDC balance (called by the Survival/Payment module). */
  setUsdcBalance(balance: bigint): void {
    this.usdcBalance = balance;
  }

  /** Update the balance breakdown (wallet vs Aave). */
  setBalanceBreakdown(walletUsdc: bigint, aaveUsdc: bigint): void {
    this.balanceBreakdown = { walletUsdc, aaveUsdc };
  }

  /** Update the current survival tier. */
  setTier(tier: SurvivalTier): void {
    this.tier = tier;
  }

  /** Update LLM availability flag. */
  setLlmAvailable(available: boolean): void {
    this.llmAvailable = available;
  }

  /** Update the wallet address of the agent. */
  setWalletAddress(address: string): void {
    this.walletAddress = address;
  }

  /** Return the wallet address of the agent. */
  getWalletAddress(): string {
    return this.walletAddress;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Schedule the next heartbeat using setTimeout (not setInterval).
   * Requirement 11.1: "emit a health check event every 30 seconds".
   */
  private scheduleNext(): void {
    if (!this.running) return;

    this.timeoutHandle = setTimeout(() => {
      this.tick();
      this.scheduleNext(); // re-arm after tick
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Single heartbeat tick.
   * 1. Detect modules degraded in 2 consecutive cycles.
   * 2. Persist to DB (or fallback log).
   * 3. Emit `heartbeat:health` event.
   */
  private tick(): void {
    const now = Date.now();

    // Check for degraded modules (Requirement 11.2)
    for (const [moduleName, moduleStatus] of this.modules) {
      if (
        moduleStatus.status === 'unhealthy' &&
        moduleStatus.consecutiveFailures >= DEGRADED_THRESHOLD
      ) {
        this.emit('alert:module-degraded', {
          module: moduleName,
          consecutiveFailures: moduleStatus.consecutiveFailures,
          timestamp: now,
        });
      }
    }

    const snapshot = this.getHealthStatus();

    // Persist heartbeat event (with SQLite fallback) — Requirement 11.4
    this.persistHeartbeat(snapshot, now);

    // Emit the health event for subscribers
    this.emit('heartbeat:health', snapshot);
  }

  /**
   * Persist a heartbeat snapshot.
   * Falls back to local log file when SQLite is unavailable (Requirement 11.4).
   */
  private persistHeartbeat(snapshot: HealthStatus, now: number): void {
    const moduleStatusesRecord: Record<string, string> = {};
    for (const [name, ms] of Object.entries(snapshot.modules)) {
      moduleStatusesRecord[name] = ms.status;
    }

    if (this.repo !== null) {
      try {
        this.repo.insertHeartbeat({
          moduleStatuses: moduleStatusesRecord,
          tier: snapshot.tier as number,
          balanceUsdc: snapshot.usdcBalance.toString(),
          llmAvailable: snapshot.llmAvailable,
          recordedAt: now,
        });
        return; // success — no fallback needed
      } catch (err) {
        // SQLite unavailable — fall through to log file
        console.error('[HealthChecker] SQLite write failed, using fallback log:', err);
      }
    }

    // Fallback: write to local log file (Requirement 11.4)
    this.writeToFallbackLog(snapshot, now);
  }

  /**
   * Write a heartbeat line to the fallback log file.
   * Requirement 11.4: "write health events to a local fallback log file".
   */
  private writeToFallbackLog(snapshot: HealthStatus, now: number): void {
    try {
      mkdirSync(dirname(FALLBACK_LOG_PATH), { recursive: true });
      const line =
        JSON.stringify({
          timestamp: now,
          overall: snapshot.overall,
          tier: snapshot.tier,
          balanceUsdc: snapshot.usdcBalance.toString(),
          llmAvailable: snapshot.llmAvailable,
          modules: snapshot.modules,
        }) + '\n';
      appendFileSync(FALLBACK_LOG_PATH, line, 'utf8');
    } catch (logErr) {
      console.error('[HealthChecker] Fallback log write also failed:', logErr);
    }
  }

  /**
   * Compute the overall health by reducing all module statuses.
   * - Any module 'unhealthy' → overall 'unhealthy'
   * - Any module 'degraded' → overall 'degraded'
   * - All modules 'healthy' (or no modules) → overall 'healthy'
   */
  private computeOverall(): HealthStatus['overall'] {
    let hasUnhealthy = false;
    let hasDegraded = false;

    for (const ms of this.modules.values()) {
      if (ms.status === 'unhealthy') hasUnhealthy = true;
      else if (ms.status === 'degraded') hasDegraded = true;
    }

    if (hasUnhealthy) return 'unhealthy';
    if (hasDegraded) return 'degraded';
    return 'healthy';
  }

  /**
   * On startup, detect any crash event that lacks a `recovered_at` and mark it
   * as recovered now. Requirement 11.6.
   */
  private handleCrashRecovery(): void {
    if (this.repo === null) return;

    try {
      const unrecovered = this.repo.getUnrecoveredCrash();
      if (unrecovered !== null) {
        this.repo.markRecovered(unrecovered.id, Date.now());
        console.log(
          `[HealthChecker] Marked crash event #${unrecovered.id} as recovered (crashed_at=${unrecovered.crashedAt})`
        );
        this.emit('heartbeat:crash-recovered', {
          crashId: unrecovered.id,
          crashedAt: unrecovered.crashedAt,
          recoveredAt: Date.now(),
        });
      }
    } catch (err) {
      console.error('[HealthChecker] Could not check crash recovery state:', err);
    }
  }
}

/**
 * MetricsCollector
 *
 * Tracks node-level runtime metrics since the last startup:
 *   - uptimeMs         – milliseconds since start() was called
 *   - totalCycles      – number of ReAct loop cycles completed
 *   - totalIncomeUsdc  – cumulative USDC income (6-decimal bigint)
 *   - totalErrors      – total error count across all modules
 *   - cyclesPerHour    – rolling throughput based on elapsed time
 *   - successRate      – (totalCycles - totalErrors) / totalCycles
 *
 * Requirements: 11.5
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface MetricsSnapshot {
  uptimeMs: number;
  totalCycles: number;
  totalIncomeUsdc: bigint;
  totalErrors: number;
  cyclesPerHour: number;
  successRate: number;
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

export class MetricsCollector {
  private startedAt: number | null = null;

  private _totalCycles: number = 0;
  private _totalIncomeUsdc: bigint = 0n;
  private _totalErrors: number = 0;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Record the start timestamp. Must be called before recording any metrics. */
  start(): void {
    if (this.startedAt === null) {
      this.startedAt = Date.now();
    }
  }

  /** Reset all counters (useful for tests or controlled restarts). */
  stop(): void {
    this.startedAt = null;
    this._totalCycles = 0;
    this._totalIncomeUsdc = 0n;
    this._totalErrors = 0;
  }

  // ---------------------------------------------------------------------------
  // Recording helpers
  // ---------------------------------------------------------------------------

  /** Increment the completed cycle counter by one. */
  recordCycle(): void {
    this._totalCycles += 1;
  }

  /**
   * Add income earned in a single event.
   * @param amountUsdc – USDC amount in 6-decimal bigint units.
   */
  recordIncome(amountUsdc: bigint): void {
    if (amountUsdc > 0n) {
      this._totalIncomeUsdc += amountUsdc;
    }
  }

  /** Increment the error counter by one. */
  recordError(): void {
    this._totalErrors += 1;
  }

  // ---------------------------------------------------------------------------
  // Snapshot
  // ---------------------------------------------------------------------------

  /**
   * Return a point-in-time snapshot of all collected metrics.
   * Safe to call before start() — uptime will be 0.
   */
  getMetrics(): MetricsSnapshot {
    const now = Date.now();
    const uptimeMs = this.startedAt !== null ? now - this.startedAt : 0;

    const cyclesPerHour =
      uptimeMs > 0
        ? (this._totalCycles / uptimeMs) * 3_600_000
        : 0;

    const successfulCycles = this._totalCycles - this._totalErrors;
    const successRate =
      this._totalCycles > 0
        ? Math.max(0, successfulCycles) / this._totalCycles
        : 1; // 100 % if no cycles yet (no failures)

    return {
      uptimeMs,
      totalCycles: this._totalCycles,
      totalIncomeUsdc: this._totalIncomeUsdc,
      totalErrors: this._totalErrors,
      cyclesPerHour: Math.max(0, cyclesPerHour),
      successRate: Math.min(1, Math.max(0, successRate)),
    };
  }
}

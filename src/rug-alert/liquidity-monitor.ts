/**
 * Rug Alert Service — Liquidity Monitor
 *
 * Contains pure helper functions for computing reserve drop percentages and
 * classifying liquidity drops into alert severities.
 *
 * Also exports the PoolRecord interface and LiquidityMonitor class that poll
 * Uniswap V2 / Aerodrome pool reserves on a dual-interval schedule (standard
 * 15 000 ms and elevated 5 000 ms for CRITICAL pools).
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */

import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import type { AlertEmitter, AlertSeverity } from './types.js';
import { RESERVES_ABI } from './abis.js';

const log = createLogger('liquidity-monitor');

// ═══════════════════════════════════════════════════════════════════════════
// Pure helper functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Computes the percentage drop between a baseline and current reserve value.
 *
 * Uses bigint arithmetic to avoid floating-point precision loss throughout;
 * the final conversion to `number` happens only at the last step.
 *
 * Returns 0 when baseline is 0n to avoid division by zero.
 *
 * @param baseline - The reserve value at position open time
 * @param current  - The reserve value at the current polling cycle
 * @returns Drop percentage as a number (e.g. 50.0 means a 50% drop)
 */
export function computeDropPct(baseline: bigint, current: bigint): number {
  if (baseline === 0n) return 0;
  return Number((baseline - current) * 10_000n / baseline) / 100;
}

/**
 * Classifies a liquidity drop percentage into an alert severity.
 *
 * Thresholds (exclusive branches):
 * - < 50%          → null (no alert)
 * - ≥ 50% and < 80% → 'HIGH'
 * - ≥ 80%          → 'CRITICAL'
 *
 * @param pct - Drop percentage as returned by `computeDropPct`
 * @returns AlertSeverity ('HIGH' | 'CRITICAL') or null if no alert should be emitted
 */
export function classifyLiquidityDrop(pct: number): AlertSeverity | null {
  if (pct >= 80) return 'CRITICAL';
  if (pct >= 50) return 'HIGH';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// PoolRecord interface
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tracks everything LiquidityMonitor needs to poll a single DEX pool and
 * evaluate reserve drops against the entry baseline.
 *
 * `baselineReserve0` / `baselineReserve1` are captured once at
 * `addPool()` time (from the initial `getReserves()` call) and never updated
 * during the life of the position.
 *
 * `elevated = true` moves the record to the 5 000 ms polling tier after a
 * CRITICAL alert is emitted (Requirement 1.6).
 */
export interface PoolRecord {
  positionId: string;
  /** Token contract address — used for alert routing (contractAddress in AlertEvent). */
  contractAddress: string;
  poolAddress: string;
  /** USDC or WETH reserve value at position open time. */
  baselineReserve0: bigint;
  /** USDC or WETH reserve value at position open time. */
  baselineReserve1: bigint;
  token0: string;
  token1: string;
  consecutivePollFailures: number;
  /** true → record is moved to the 5 s elevated-polling tier. */
  elevated: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// Internal constants
// ═══════════════════════════════════════════════════════════════════════════

const STANDARD_INTERVAL_MS = 15_000;
const ELEVATED_INTERVAL_MS = 5_000;
const POLL_TIMEOUT_MS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;

// ═══════════════════════════════════════════════════════════════════════════
// LiquidityMonitor class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Polls pool reserve balances for all tracked positions and emits AlertEvents
 * when a significant drop is detected or when consecutive poll failures exceed
 * the threshold.
 *
 * Two setInterval ticks run independently:
 *  - Standard tick (15 000 ms): iterates all non-elevated PoolRecord entries.
 *  - Elevated tick (5 000 ms):  iterates only entries with `elevated === true`.
 *
 * Per-call timeout: `getReserves()` calls are raced against a 5-second
 * AbortSignal. On timeout or revert, `consecutivePollFailures` is incremented.
 * After 3 consecutive failures the monitor emits `RESERVE_POLL_FAILURE`
 * (CRITICAL) and marks the record elevated (Requirement 1.5, 1.6).
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
 */
/**
 * Factory function type for creating ethers Contract instances.
 * Provided as an optional constructor parameter so tests can inject a mock
 * without fighting ESM non-configurable module exports.
 *
 * @internal
 */
export type ContractFactory = (
  address: string,
  abi: unknown,
  provider: ethers.JsonRpcProvider,
) => {
  token0(): Promise<string>;
  token1(): Promise<string>;
  getReserves(): Promise<[bigint, bigint, number]>;
};

export class LiquidityMonitor {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly onAlert: AlertEmitter;
  private readonly contractFactory: ContractFactory;

  /** Standard-tier records (elevated === false). */
  private readonly standardRecords: Map<string, PoolRecord> = new Map();
  /** Elevated-tier records (elevated === true). */
  private readonly elevatedRecords: Map<string, PoolRecord> = new Map();

  private standardIntervalId: ReturnType<typeof setInterval> | null = null;
  private elevatedIntervalId: ReturnType<typeof setInterval> | null = null;

  constructor(
    provider: ethers.JsonRpcProvider,
    onAlert: AlertEmitter,
    contractFactory?: ContractFactory,
  ) {
    this.provider = provider;
    this.onAlert = onAlert;
    this.contractFactory = contractFactory ?? ((addr, abi, prov) =>
      new ethers.Contract(addr, abi as ethers.InterfaceAbi, prov) as unknown as ReturnType<ContractFactory>
    );
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Registers a pool for polling.
   *
   * - Calls `token0()` and `token1()` once to confirm the slot mapping (already
   *   stored in `record.token0` / `record.token1`, but this validates the data).
   * - If `baselineReserve0` and `baselineReserve1` are both `0n` (not yet
   *   recorded externally), fetches initial `getReserves()` to set them.
   * - Adds the record to the standard polling tier.
   *
   * Requirements: 1.1, 1.2
   */
  addPool(record: PoolRecord): void {
    // Work on a mutable copy so the caller's object is not mutated.
    const r: PoolRecord = { ...record };

    // Kick off async initialisation but do not block addPool() itself.
    this._initRecord(r).catch((err: unknown) => {
      log.warn('LiquidityMonitor.addPool: async init failed', {
        positionId: r.positionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Register in the appropriate tier right away so polling starts immediately
    // (initial baseline values will be in-place before first tick if init is fast).
    if (r.elevated) {
      this.elevatedRecords.set(r.positionId, r);
    } else {
      this.standardRecords.set(r.positionId, r);
    }
  }

  /**
   * Removes a pool from both polling tiers (called when a position is closed).
   *
   * Requirements: 1.1
   */
  removePool(positionId: string): void {
    this.standardRecords.delete(positionId);
    this.elevatedRecords.delete(positionId);
    log.debug('LiquidityMonitor.removePool', { positionId });
  }

  /**
   * Starts the standard and elevated polling intervals.
   * Calling `start()` while already started is a no-op (guards with null-check).
   *
   * Requirements: 1.1
   */
  start(): void {
    if (this.standardIntervalId !== null) return;

    this.standardIntervalId = setInterval(() => {
      this._runTick(this.standardRecords).catch((err: unknown) => {
        log.warn('LiquidityMonitor: standard tick error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, STANDARD_INTERVAL_MS);

    this.elevatedIntervalId = setInterval(() => {
      this._runTick(this.elevatedRecords).catch((err: unknown) => {
        log.warn('LiquidityMonitor: elevated tick error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, ELEVATED_INTERVAL_MS);

    log.info('LiquidityMonitor started', {
      standardIntervalMs: STANDARD_INTERVAL_MS,
      elevatedIntervalMs: ELEVATED_INTERVAL_MS,
    });
  }

  /**
   * Clears both polling intervals.
   *
   * Requirements: 1.1
   */
  stop(): void {
    if (this.standardIntervalId !== null) {
      clearInterval(this.standardIntervalId);
      this.standardIntervalId = null;
    }
    if (this.elevatedIntervalId !== null) {
      clearInterval(this.elevatedIntervalId);
      this.elevatedIntervalId = null;
    }
    log.info('LiquidityMonitor stopped');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Async initialisation for a newly added record.
   *
   * Validates token0 / token1 against the contract and fetches the initial
   * baseline reserves if they haven't been provided by the caller.
   */
  private async _initRecord(record: PoolRecord): Promise<void> {
    const contract = this.contractFactory(record.poolAddress, RESERVES_ABI, this.provider);

    // Confirm token slot mapping (called once at trackPosition time per design).
    // We store the result back on the record for consistency but the caller
    // should already have populated these fields.
    const [t0, t1] = await Promise.all([
      contract.token0(),
      contract.token1(),
    ]);
    record.token0 = t0;
    record.token1 = t1;

    // Fetch initial baseline reserves only when the caller hasn't set them.
    if (record.baselineReserve0 === 0n && record.baselineReserve1 === 0n) {
      const [r0, r1] = await this._fetchReserves(record);
      record.baselineReserve0 = r0;
      record.baselineReserve1 = r1;
      log.debug('LiquidityMonitor: baseline reserves fetched', {
        positionId: record.positionId,
        baselineReserve0: r0.toString(),
        baselineReserve1: r1.toString(),
      });
    }
  }

  /**
   * Iterates a set of records and polls each one.
   */
  private async _runTick(records: Map<string, PoolRecord>): Promise<void> {
    // Snapshot keys to avoid mutation during iteration.
    const positionIds = Array.from(records.keys());
    for (const positionId of positionIds) {
      const record = records.get(positionId);
      if (!record) continue;
      await this._pollRecord(record);
    }
  }

  /**
   * Calls `getReserves()` on a single pool with a 5-second timeout.
   *
   * On timeout or revert:
   *  - increments `consecutivePollFailures`
   *  - if failures reach MAX_CONSECUTIVE_FAILURES → emits RESERVE_POLL_FAILURE CRITICAL and elevates
   *
   * On success:
   *  - resets `consecutivePollFailures = 0`
   *  - evaluates reserve drops and emits alerts as needed
   *
   * Requirements: 1.3, 1.4, 1.5, 1.6, 1.7
   */
  private async _pollRecord(record: PoolRecord): Promise<void> {
    let reserve0: bigint;
    let reserve1: bigint;

    try {
      [reserve0, reserve1] = await this._fetchReserves(record);
    } catch (err: unknown) {
      record.consecutivePollFailures += 1;
      log.warn('LiquidityMonitor: getReserves failed', {
        positionId: record.positionId,
        poolAddress: record.poolAddress,
        consecutivePollFailures: record.consecutivePollFailures,
        error: err instanceof Error ? err.message : String(err),
      });

      if (record.consecutivePollFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Emit RESERVE_POLL_FAILURE exactly once per failure run (only when it
        // first reaches the threshold; subsequent failures in the same run are
        // already elevated so the deduplication map handles any extras).
        if (record.consecutivePollFailures === MAX_CONSECUTIVE_FAILURES) {
          await this._emitAlert(record, 'CRITICAL', 'RESERVE_POLL_FAILURE');
        }
        // Elevate the record so it moves to the 5 s tier.
        this._elevate(record);
      }
      return;
    }

    // Successful poll → reset failure counter.
    record.consecutivePollFailures = 0;

    // Skip drop evaluation if baseline is not yet set.
    if (record.baselineReserve0 === 0n && record.baselineReserve1 === 0n) return;

    // Compute drop on each reserve independently and take the higher severity.
    const drop0 = computeDropPct(record.baselineReserve0, reserve0);
    const drop1 = computeDropPct(record.baselineReserve1, reserve1);
    const severity0 = classifyLiquidityDrop(drop0);
    const severity1 = classifyLiquidityDrop(drop1);
    const severity = this._higherSeverity(severity0, severity1);

    if (severity === null) return; // No alert needed (< 50% drop on both reserves).

    const reason: 'LIQUIDITY_DROP_HIGH' | 'LIQUIDITY_DROP_CRITICAL' =
      severity === 'CRITICAL' ? 'LIQUIDITY_DROP_CRITICAL' : 'LIQUIDITY_DROP_HIGH';

    await this._emitAlert(record, severity, reason);

    // Elevate on CRITICAL (Requirement 1.6).
    if (severity === 'CRITICAL') {
      this._elevate(record);
    }
  }

  /**
   * Fetches `getReserves()` from the pool contract with a 5-second AbortSignal
   * timeout race. Returns `[reserve0, reserve1]` as bigints.
   */
  private async _fetchReserves(record: PoolRecord): Promise<[bigint, bigint]> {
    const contract = this.contractFactory(record.poolAddress, RESERVES_ABI, this.provider);

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`getReserves timeout after ${POLL_TIMEOUT_MS} ms`)),
        POLL_TIMEOUT_MS,
      );
    });

    const fetchPromise = contract.getReserves().then((result) => result);

    const result = await Promise.race([fetchPromise, timeoutPromise]);
    return [result[0], result[1]];
  }

  /**
   * Moves a record from the standard tier to the elevated tier (if not already there).
   */
  private _elevate(record: PoolRecord): void {
    if (record.elevated) return;
    record.elevated = true;
    this.standardRecords.delete(record.positionId);
    this.elevatedRecords.set(record.positionId, record);
    log.info('LiquidityMonitor: pool elevated to 5 s tier', {
      positionId: record.positionId,
      poolAddress: record.poolAddress,
    });
  }

  /**
   * Emits an AlertEvent via the onAlert callback.
   */
  private async _emitAlert(
    record: PoolRecord,
    severity: AlertSeverity,
    reason: 'LIQUIDITY_DROP_HIGH' | 'LIQUIDITY_DROP_CRITICAL' | 'RESERVE_POLL_FAILURE',
  ): Promise<void> {
    try {
      await this.onAlert({
        id: randomUUID(),
        contractAddress: record.contractAddress,
        severity,
        reason,
        detectedAt: Date.now(),
        positionId: record.positionId,
        pnlUsdc: null,
      });
    } catch (err: unknown) {
      log.warn('LiquidityMonitor: onAlert callback threw', {
        positionId: record.positionId,
        severity,
        reason,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Returns the higher of two optional severities.
   * Ranking: CRITICAL > HIGH > null
   */
  private _higherSeverity(
    a: AlertSeverity | null,
    b: AlertSeverity | null,
  ): AlertSeverity | null {
    if (a === 'CRITICAL' || b === 'CRITICAL') return 'CRITICAL';
    if (a === 'HIGH' || b === 'HIGH') return 'HIGH';
    return null;
  }
}

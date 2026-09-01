/**
 * Rug Alert Service — Large Holder Sell Detector
 *
 * Subscribes to `Transfer` events on each monitored token contract and
 * classifies transfers from the deployer wallet or large "whale" sells to
 * DEX router/pool addresses as rug pull signals.
 *
 * Detection channels:
 *  1. Deployer sell — if `from` matches the resolved deployer address, the
 *     transferred amount is compared against the cached total supply:
 *       < 10%              → skip
 *       ≥ 10% and < 30%   → HIGH   (DEPLOYER_SELL_HIGH)
 *       ≥ 30%             → CRITICAL (DEPLOYER_SELL_CRITICAL)
 *  2. Whale sell to DEX — if `to` is in `dexPoolAddresses` and the amount
 *     represents ≥ 20% of the cached total supply:
 *       ≥ 20%             → WARNING (WHALE_SELL_TO_DEX)
 *
 * Total supply is refreshed every 60 000 ms per token. On refresh failure the
 * last valid value is retained and ALL percentage-based alerts for that token
 * are suppressed until a valid supply is returned (Requirement 3.7).
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7
 */

import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import type { AlertEmitter } from './types.js';
import { ERC20_TRANSFER_ABI, ERC20_SUPPLY_ABI } from './abis.js';

const log = createLogger('large-holder-sell-detector');

// ═══════════════════════════════════════════════════════════════════════════
// Supply-refresh interval (ms)
// ═══════════════════════════════════════════════════════════════════════════

const SUPPLY_REFRESH_INTERVAL_MS = 60_000;

// ═══════════════════════════════════════════════════════════════════════════
// Internal record type
// ═══════════════════════════════════════════════════════════════════════════

interface TokenRecord {
  positionId: string;
  contractAddress: string;
  tokenContract: ethers.Contract;
  deployerAddress: string | null;
  cachedTotalSupply: bigint | null;
  /** Unix ms timestamp when the supply was last successfully fetched */
  supplyFetchedAt: number;
  supplyRefreshIntervalId: ReturnType<typeof setInterval> | null;
  /**
   * Set to true when the last supply refresh failed.
   * While true, all percentage-based alerts for this token are suppressed.
   * Reset to false on the next successful refresh.
   */
  supplyFetchFailed: boolean;
  /** Bound event handler reference — needed for removeAllListeners */
  transferHandler: (...args: unknown[]) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public input type for addToken
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Input record accepted by `LargeHolderSellDetector.addToken`.
 *
 * The class resolves the deployer address, fetches the initial total supply,
 * and wires the Transfer listener internally.  Callers only need to supply the
 * position identifier, token contract address, and an optional deployment
 * transaction hash (used for deployer resolution).
 */
export interface TokenAddInput {
  positionId: string;
  contractAddress: string;
  /**
   * Optional hash of the token contract's deployment transaction.
   * When provided the detector will attempt to resolve the deployer address.
   * If absent or if provider returns null, `deployerAddress` is stored as null
   * and deployer-based Transfer monitoring is skipped (Requirement 3.2).
   */
  deployerTxHash?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pure helper — deployer sell severity
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Computes the transfer percentage relative to total supply using bigint
 * arithmetic, converting to a `number` percentage only at the final step.
 *
 * @param amount      - Transferred amount (token smallest unit)
 * @param totalSupply - Cached total supply (token smallest unit)
 * @returns Percentage as a number (e.g. 10.5 means 10.5%)
 */
export function computeTransferPct(amount: bigint, totalSupply: bigint): number {
  if (totalSupply === 0n) return 0;
  return Number((amount * 10_000n) / totalSupply) / 100;
}

/**
 * Classifies a deployer sell percentage into an alert severity.
 *
 * Thresholds (exclusive, per Property 4):
 *  < 10%            → null  (skip)
 *  ≥ 10% and < 30%  → 'HIGH'
 *  ≥ 30%            → 'CRITICAL'
 *
 * @param pct - Transfer percentage as returned by `computeTransferPct`
 * @returns 'HIGH' | 'CRITICAL' or null if no deployer alert should fire
 */
export function classifyDeployerSell(pct: number): 'HIGH' | 'CRITICAL' | null {
  if (pct >= 30) return 'CRITICAL';
  if (pct >= 10) return 'HIGH';
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// LargeHolderSellDetector
// ═══════════════════════════════════════════════════════════════════════════

export class LargeHolderSellDetector {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly dexPoolAddresses: Set<string>;
  private readonly onAlert: AlertEmitter;
  private readonly records: Map<string, TokenRecord> = new Map();

  constructor(
    provider: ethers.JsonRpcProvider,
    dexPoolAddresses: string[],
    onAlert: AlertEmitter,
  ) {
    this.provider = provider;
    // Normalise addresses to lower-case for O(1) look-up
    this.dexPoolAddresses = new Set(dexPoolAddresses.map((a) => a.toLowerCase()));
    this.onAlert = onAlert;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Registers a token for monitoring.
   *
   * Steps:
   *  1. Creates an `ethers.Contract` instance for the token.
   *  2. Attempts to resolve the deployer address via `deployerTxHash`
   *     (stored as null if unresolvable — Requirement 3.2).
   *  3. Fetches the initial `totalSupply()` and caches it.
   *  4. Starts a 60-second supply-refresh interval.
   *  5. Attaches the `Transfer` event listener.
   *
   * @param input - See `TokenAddInput`
   */
  addToken(input: TokenAddInput): void {
    if (this.records.has(input.positionId)) {
      log.warn('addToken called for already-tracked positionId', {
        positionId: input.positionId,
      });
      return;
    }

    const tokenContract = new ethers.Contract(
      input.contractAddress,
      ERC20_TRANSFER_ABI,
      this.provider,
    );

    // Placeholder record — fields are filled in async steps below
    const record: TokenRecord = {
      positionId: input.positionId,
      contractAddress: input.contractAddress,
      tokenContract,
      deployerAddress: null,
      cachedTotalSupply: null,
      supplyFetchedAt: 0,
      supplyRefreshIntervalId: null,
      supplyFetchFailed: false,
      transferHandler: () => undefined, // replaced below
    };

    this.records.set(input.positionId, record);

    // Build the bound Transfer handler and attach it
    const handler = this._buildTransferHandler(record);
    record.transferHandler = handler;
    tokenContract.on('Transfer', handler);

    // Kick off async initialisation — errors are fully contained
    void this._initialise(record, input.deployerTxHash);
  }

  /**
   * Removes a token from monitoring.
   *
   * Detaches the Transfer listener, clears the supply-refresh interval,
   * and deletes the record from internal state.
   *
   * @param positionId - The position identifier used in `addToken`
   */
  removeToken(positionId: string): void {
    const record = this.records.get(positionId);
    if (!record) return;

    // Remove the Transfer event listener
    try {
      record.tokenContract.off('Transfer', record.transferHandler);
    } catch (err) {
      log.warn('Failed to remove Transfer listener on removeToken', {
        positionId,
        contractAddress: record.contractAddress,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Clear the supply-refresh interval
    if (record.supplyRefreshIntervalId !== null) {
      clearInterval(record.supplyRefreshIntervalId);
      record.supplyRefreshIntervalId = null;
    }

    this.records.delete(positionId);

    log.debug('Token removed from large-holder-sell monitoring', {
      positionId,
      contractAddress: record.contractAddress,
    });
  }

  /**
   * Stops the detector by removing all tracked tokens.
   *
   * Called by `RugAlertService.stop()` to clean up all listeners and intervals.
   */
  stop(): void {
    const positionIds = [...this.records.keys()];
    for (const positionId of positionIds) {
      this.removeToken(positionId);
    }
    log.debug('LargeHolderSellDetector stopped', { removed: positionIds.length });
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Performs async initialisation for a newly added token record:
   *  1. Resolves deployer address (best-effort; null on failure).
   *  2. Fetches initial total supply.
   *  3. Starts the periodic supply-refresh interval.
   *
   * All errors are caught and logged — this method must never throw.
   */
  private async _initialise(record: TokenRecord, deployerTxHash?: string): Promise<void> {
    // ── Step 1: resolve deployer address ──────────────────────────────────
    if (deployerTxHash) {
      try {
        const tx = await this.provider.getTransaction(deployerTxHash);
        if (tx && tx.from) {
          record.deployerAddress = tx.from.toLowerCase();
          log.debug('Deployer address resolved', {
            positionId: record.positionId,
            contractAddress: record.contractAddress,
            deployerAddress: record.deployerAddress,
          });
        } else {
          log.warn('Deployer address unresolvable — deployer-based monitoring skipped', {
            positionId: record.positionId,
            contractAddress: record.contractAddress,
            deployerTxHash,
          });
        }
      } catch (err) {
        log.warn('Failed to resolve deployer address', {
          positionId: record.positionId,
          contractAddress: record.contractAddress,
          deployerTxHash,
          error: err instanceof Error ? err.message : String(err),
        });
        // deployerAddress stays null (Requirement 3.2)
      }
    } else {
      log.debug('No deployerTxHash provided — deployer-based monitoring skipped', {
        positionId: record.positionId,
        contractAddress: record.contractAddress,
      });
    }

    // ── Step 2: fetch initial total supply ───────────────────────────────
    await this._refreshSupply(record);

    // ── Step 3: start periodic supply refresh ────────────────────────────
    const intervalId = setInterval(() => {
      void this._refreshSupply(record);
    }, SUPPLY_REFRESH_INTERVAL_MS);

    // Allow the process to exit even if this interval is still running
    if (typeof intervalId === 'object' && 'unref' in intervalId) {
      (intervalId as NodeJS.Timeout).unref();
    }

    record.supplyRefreshIntervalId = intervalId;
  }

  /**
   * Fetches `totalSupply()` from the token contract and updates the cached
   * value on the record.
   *
   * On failure (revert or network error):
   *  - Sets `supplyFetchFailed = true` so the Transfer handler suppresses
   *    percentage-based alerts.
   *  - Retains the last valid `cachedTotalSupply` value.
   *  - Logs a warning (Requirement 3.7).
   *
   * On success:
   *  - Updates `cachedTotalSupply` and `supplyFetchedAt`.
   *  - Clears `supplyFetchFailed` so percentage checks resume.
   */
  private async _refreshSupply(record: TokenRecord): Promise<void> {
    // Create a supply-only contract to call totalSupply()
    const supplyContract = new ethers.Contract(
      record.contractAddress,
      ERC20_SUPPLY_ABI,
      this.provider,
    );

    try {
      const supply = await supplyContract['totalSupply']() as bigint;
      record.cachedTotalSupply = supply;
      record.supplyFetchedAt = Date.now();
      record.supplyFetchFailed = false;

      log.debug('Total supply refreshed', {
        positionId: record.positionId,
        contractAddress: record.contractAddress,
        supply: supply.toString(),
      });
    } catch (err) {
      record.supplyFetchFailed = true;
      log.warn('Total supply refresh failed — percentage-based alerts suppressed', {
        positionId: record.positionId,
        contractAddress: record.contractAddress,
        error: err instanceof Error ? err.message : String(err),
        lastValidSupply: record.cachedTotalSupply?.toString() ?? 'none',
      });
      // cachedTotalSupply is intentionally NOT cleared (Requirement 3.7)
    }
  }

  /**
   * Builds and returns a bound Transfer event handler for the given record.
   *
   * The handler is stored on the record so it can be removed later via
   * `contract.off('Transfer', handler)`.
   *
   * Handler logic (per requirements 3.3, 3.4, 3.5):
   *  1. If `cachedTotalSupply` is valid AND `supplyFetchFailed` is false:
   *     a. If `from` is the deployer address: classify and emit deployer alert.
   *     b. If `to` is in `dexPoolAddresses` and amount ≥ 20% of supply: emit WARNING.
   *  2. If supply is unavailable / fetch failed: skip all percentage checks.
   */
  private _buildTransferHandler(record: TokenRecord): (...args: unknown[]) => void {
    return (...args: unknown[]): void => {
      // ethers v6 emits: (from, to, value, event)
      const [from, to, value] = args as [string, string, bigint];

      void this._handleTransfer(record, from, to, value).catch((err: unknown) => {
        log.warn('Unhandled error in Transfer event handler', {
          positionId: record.positionId,
          contractAddress: record.contractAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
  }

  /**
   * Core Transfer event processing logic.
   *
   * All errors from `onAlert` are caught to prevent unhandled rejections.
   */
  private async _handleTransfer(
    record: TokenRecord,
    from: string,
    to: string,
    amount: bigint,
  ): Promise<void> {
    const supply = record.cachedTotalSupply;

    // If supply is unavailable or last fetch failed, suppress percentage checks
    // (Requirement 3.7)
    if (supply === null || record.supplyFetchFailed) {
      return;
    }

    if (supply === 0n) {
      // Guard against division by zero
      return;
    }

    const fromLower = from.toLowerCase();
    const toLower = to.toLowerCase();
    const pct = computeTransferPct(amount, supply);

    // ── Channel 1: Deployer sell ─────────────────────────────────────────
    if (record.deployerAddress !== null && fromLower === record.deployerAddress) {
      const severity = classifyDeployerSell(pct);
      if (severity !== null) {
        const reason =
          severity === 'CRITICAL' ? ('DEPLOYER_SELL_CRITICAL' as const) : ('DEPLOYER_SELL_HIGH' as const);

        await this.onAlert({
          id: randomUUID(),
          contractAddress: record.contractAddress,
          severity,
          reason,
          detectedAt: Date.now(),
          positionId: record.positionId,
          pnlUsdc: null,
        });

        log.info('Deployer sell alert emitted', {
          positionId: record.positionId,
          contractAddress: record.contractAddress,
          severity,
          reason,
          pct,
          amount: amount.toString(),
          supply: supply.toString(),
        });
      }
      // Deployer sell check is exclusive — we do NOT also check whale-to-DEX
      // for the same event when the sender is the deployer.
      // However, per requirements, the whale-to-DEX check is independent
      // (different channel) and covers ANY address. We evaluate it anyway.
    }

    // ── Channel 2: Whale sell to DEX ────────────────────────────────────
    // Independent of deployer check — any address can trigger this.
    if (this.dexPoolAddresses.has(toLower) && pct >= 20) {
      await this.onAlert({
        id: randomUUID(),
        contractAddress: record.contractAddress,
        severity: 'WARNING',
        reason: 'WHALE_SELL_TO_DEX',
        detectedAt: Date.now(),
        positionId: record.positionId,
        pnlUsdc: null,
      });

      log.info('Whale sell to DEX alert emitted', {
        positionId: record.positionId,
        contractAddress: record.contractAddress,
        severity: 'WARNING',
        reason: 'WHALE_SELL_TO_DEX',
        pct,
        to,
        amount: amount.toString(),
        supply: supply.toString(),
      });
    }
  }
}

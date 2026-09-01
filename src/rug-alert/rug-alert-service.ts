/**
 * Rug Alert Service — Main Service Class
 *
 * Orchestrates LiquidityMonitor, LpRemovalDetector, LargeHolderSellDetector,
 * AlertDispatcher, DeduplicationMap, and TelegramNotifier into a single
 * lifecycle-managed module that monitors open shadow positions for rug pull
 * signals.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { ethers } from 'ethers';
import { createLogger } from '../logger.js';
import { DeduplicationMap } from './deduplication-map.js';
import { TelegramNotifier } from './telegram-notifier.js';
import { LiquidityMonitor } from './liquidity-monitor.js';
import type { PoolRecord } from './liquidity-monitor.js';
import { LpRemovalDetector } from './lp-removal-detector.js';
import type { LpRecord } from './lp-removal-detector.js';
import { LargeHolderSellDetector } from './large-holder-sell-detector.js';
import type { TokenAddInput } from './large-holder-sell-detector.js';
import { AlertDispatcher } from './alert-dispatcher.js';
import type {
  AlertEvent,
  AlertStats,
  IRugAlertService,
  MonitoredPosition,
  MutableAlertStats,
} from './types.js';
import type { IShadowExecutor } from '../hybrid-sniper/shadow-executor.js';
import type { ShadowPosition, IMetricsRecorder } from '../shared/metrics-recorder.js';
import type { IRiskBucket } from '../shared/risk-bucket.js';
import type { IDexQuoter } from '../shared/dex-quoter.js';
import type { TelegramClient } from '../social/telegram-client.js';

// ─── Lazy import for MultiVariantExecutor (avoids tight coupling) ─────────────

// We use a duck-typed interface instead of a direct import to avoid circular
// dependency issues. AlertDispatcher already accepts this shape.
interface IMultiVariantExecutor {
  closePosition?(
    position: ShadowPosition,
    reason: 'RUG_PULL',
    exitPrice: bigint,
  ): Promise<number | null>;
}

// ─── Logger ───────────────────────────────────────────────────────────────────

const log = createLogger('rug-alert-service');

// ─── Default DEX pool addresses for Base mainnet ──────────────────────────────

/**
 * Default list of known DEX router/pool factory addresses on Base mainnet.
 * Used by LargeHolderSellDetector to identify whale-to-DEX sells.
 *
 * - Uniswap V3 factory on Base
 * - Aerodrome factory on Base
 */
const DEFAULT_DEX_POOL_ADDRESSES = [
  '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24', // Uniswap V3 factory on Base
  '0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6', // Aerodrome factory on Base
];

// ─── RugAlertService ──────────────────────────────────────────────────────────

/**
 * RugAlertService orchestrates all rug pull detection components.
 *
 * Lifecycle:
 *  1. Constructor — instantiates all sub-components and wires them together.
 *  2. start() — validates provider connectivity, starts LiquidityMonitor;
 *               sets degradedMode = true and rethrows on any failure.
 *  3. trackPosition() — registers a position with all three detectors.
 *  4. untrackPosition() — removes a position from all three detectors.
 *  5. stop() — tears down all components and flushes pending Telegram notifications.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
export class RugAlertService implements IRugAlertService {
  // ── Injected provider (used by start() to validate connectivity) ───────────
  private readonly provider: ethers.JsonRpcProvider;

  // ── Sub-components ─────────────────────────────────────────────────────────
  private readonly deduplicationMap: DeduplicationMap;
  private readonly telegramNotifier: TelegramNotifier;
  private readonly liquidityMonitor: LiquidityMonitor;
  private readonly lpRemovalDetector: LpRemovalDetector;
  private readonly largeHolderSellDetector: LargeHolderSellDetector;
  private readonly alertDispatcher: AlertDispatcher;

  // ── Internal state ─────────────────────────────────────────────────────────

  /**
   * In-memory registry of positions currently being monitored.
   * Keyed by positionId.
   */
  private readonly monitoredPositions: Map<string, MonitoredPosition> = new Map();

  /**
   * Mutable stats accumulator. Shared by reference with AlertDispatcher so
   * that dispatched events automatically update the counters.
   */
  private readonly stats: MutableAlertStats;

  /**
   * True when start() has thrown — disables trackPosition so that the service
   * is a safe no-op rather than crashing on every call.
   *
   * Requirements: 6.3
   */
  private degradedMode: boolean = false;

  // ── Constructor ────────────────────────────────────────────────────────────

  /**
   * @param provider              - Injected ethers.JsonRpcProvider (shared, no new connections opened)
   * @param dexQuoter             - Used by AlertDispatcher to obtain exit prices
   * @param shadowExecutor        - Used by AlertDispatcher to close shadow positions
   * @param multiVariantExecutor  - Used by AlertDispatcher as a fallback executor; may be null
   * @param metricsRecorder       - Used by AlertDispatcher to persist AlertEvents
   * @param riskBucket            - Used by AlertDispatcher to update consecutive-loss counters
   * @param telegramClient        - Used by TelegramNotifier to send HTML notifications
   * @param env                   - Environment variable map (process.env or test substitute)
   *
   * Requirements: 6.1, 6.5
   */
  constructor(
    provider: ethers.JsonRpcProvider,
    dexQuoter: IDexQuoter,
    shadowExecutor: IShadowExecutor,
    multiVariantExecutor: IMultiVariantExecutor | null,
    metricsRecorder: IMetricsRecorder,
    riskBucket: IRiskBucket,
    telegramClient: TelegramClient,
    env: Record<string, string | undefined>,
  ) {
    this.provider = provider;

    // ── Initialise mutable stats (shared by reference with AlertDispatcher) ──
    this.stats = {
      WARNING: 0,
      HIGH: 0,
      CRITICAL: 0,
      positionsClosedByAlert: 0,
      suppressedAlerts: 0,
      lastAlertAt: null,
      degradedMode: false,
    };

    // ── Instantiate leaf components ───────────────────────────────────────────
    this.deduplicationMap = new DeduplicationMap();
    this.telegramNotifier = new TelegramNotifier(telegramClient);

    // ── Resolve USDC address from env (with Base mainnet fallback) ────────────
    const usdcAddress =
      env['USDC_ADDRESS'] ?? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    // ── Resolve DEX pool address list from env ────────────────────────────────
    const dexPoolAddresses: string[] = env['DEX_POOL_ADDRESSES']
      ? env['DEX_POOL_ADDRESSES'].split(',').map((a) => a.trim()).filter(Boolean)
      : DEFAULT_DEX_POOL_ADDRESSES;

    // ── Build the onAlert callback that routes events through AlertDispatcher ──
    //
    // The callback is invoked by all three detectors. It:
    //   1. Looks up the ShadowPosition by event.positionId in monitoredPositions.
    //   2. If not found → logs warning and returns (position already untracked).
    //   3. Delegates to alertDispatcher.dispatch(event, position.position).
    //
    // Using an arrow function so `this` is bound to the RugAlertService instance.
    const onAlert = async (event: AlertEvent): Promise<void> => {
      const monitored = this.monitoredPositions.get(event.positionId);
      if (!monitored) {
        log.warn('onAlert: received alert for untracked positionId — discarding', {
          positionId: event.positionId,
          contractAddress: event.contractAddress,
          reason: event.reason,
        });
        return;
      }
      await this.alertDispatcher.dispatch(event, monitored.position);
    };

    // ── Instantiate the three detector components ─────────────────────────────
    this.liquidityMonitor = new LiquidityMonitor(provider, onAlert);
    this.lpRemovalDetector = new LpRemovalDetector(provider, onAlert);
    this.largeHolderSellDetector = new LargeHolderSellDetector(
      provider,
      dexPoolAddresses,
      onAlert,
    );

    // ── Instantiate AlertDispatcher with all its dependencies ─────────────────
    this.alertDispatcher = new AlertDispatcher(
      this.deduplicationMap,
      shadowExecutor,
      multiVariantExecutor as { closePosition?: (...args: unknown[]) => Promise<number | null> } | null,
      metricsRecorder,
      riskBucket,
      this.telegramNotifier,
      this.stats,
      dexQuoter,
      usdcAddress,
    );
  }

  // ── IRugAlertService — start ───────────────────────────────────────────────

  /**
   * Starts the service.
   *
   * 1. Calls provider.getNetwork() to validate connectivity — throws on failure.
   * 2. Calls liquidityMonitor.start() to begin pool reserve polling.
   * 3. On any error: sets degradedMode = true and rethrows so the caller
   *    (initHybridSniper) can catch and log a warning.
   *
   * Requirements: 6.2, 6.3
   */
  async start(): Promise<void> {
    try {
      // Validate provider connectivity — fast-fails if the RPC is unreachable
      await this.provider.getNetwork();

      // Start the liquidity polling loop
      this.liquidityMonitor.start();

      log.info('RugAlertService started');
    } catch (err) {
      this.degradedMode = true;
      this.stats.degradedMode = true;

      log.warn('RugAlertService.start failed — entering DEGRADED mode', {
        error: err instanceof Error ? err.message : String(err),
      });

      throw err;
    }
  }

  // ── IRugAlertService — stop ────────────────────────────────────────────────

  /**
   * Stops the service and tears down all sub-components.
   *
   * Order:
   *  1. liquidityMonitor.stop()
   *  2. lpRemovalDetector.stop()
   *  3. largeHolderSellDetector.stop()
   *  4. deduplicationMap.clear()
   *  5. await telegramNotifier.flush(5000) — timeout discards remaining queue
   *
   * Requirements: 6.4
   */
  async stop(): Promise<void> {
    log.info('RugAlertService stopping…');

    this.liquidityMonitor.stop();
    this.lpRemovalDetector.stop();
    this.largeHolderSellDetector.stop();
    this.deduplicationMap.clear();

    // Flush remaining Telegram notifications with a 5 000 ms deadline.
    // If the deadline is reached, flush() discards remaining entries and resolves.
    try {
      await this.telegramNotifier.flush(5_000);
    } catch (err) {
      // flush() should not throw, but guard defensively
      log.warn('RugAlertService.stop: telegramNotifier.flush threw (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    log.info('RugAlertService stopped');
  }

  // ── IRugAlertService — trackPosition ──────────────────────────────────────

  /**
   * Registers an open position for rug pull monitoring.
   *
   * If the service is in DEGRADED mode, this is a silent no-op — the existing
   * MAX_QUOTE_FAILURES heuristic in ShadowExecutor remains the only guard.
   *
   * For each position, registers with all three detection channels:
   *  - LiquidityMonitor: polls pool reserves at 15 s (standard) interval.
   *  - LpRemovalDetector: subscribes to LP token Transfer events.
   *  - LargeHolderSellDetector: subscribes to token Transfer events.
   *
   * @param position       - The ShadowPosition that was just opened.
   * @param poolAddress    - The primary DEX pool address for this token.
   * @param lpTokenAddress - The LP token address for the pool.
   *
   * Requirements: 6.3
   */
  trackPosition(
    position: ShadowPosition,
    poolAddress: string,
    lpTokenAddress: string,
  ): void {
    if (this.degradedMode) {
      // Silent no-op in DEGRADED mode (Requirement 6.3)
      return;
    }

    // Register in the internal position registry
    const monitored: MonitoredPosition = {
      position,
      poolAddress,
      lpTokenAddress,
      ownerExecutor: 'shadow', // default; MultiVariantExecutor positions use the same service
    };
    this.monitoredPositions.set(position.id, monitored);

    // ── LiquidityMonitor registration ─────────────────────────────────────────
    //
    // baselineReserve0/1 = 0n signals LiquidityMonitor._initRecord to fetch
    // them via getReserves() on first poll.
    // token0/token1 = '' signals the same init to call token0()/token1().
    const poolRecord: PoolRecord = {
      positionId: position.id,
      contractAddress: position.contractAddress,
      poolAddress,
      baselineReserve0: 0n,
      baselineReserve1: 0n,
      token0: '',
      token1: '',
      consecutivePollFailures: 0,
      elevated: false,
    };
    this.liquidityMonitor.addPool(poolRecord);

    // ── LpRemovalDetector registration ───────────────────────────────────────
    const lpRecord: LpRecord = {
      positionId: position.id,
      contractAddress: position.contractAddress,
      lpTokenAddress,
      poolAddress,
    };
    this.lpRemovalDetector.addPool(lpRecord);

    // ── LargeHolderSellDetector registration ─────────────────────────────────
    //
    // deployerTxHash is not available at this stage; the detector handles null
    // gracefully by skipping deployer-based Transfer monitoring (Requirement 3.2).
    const tokenInput: TokenAddInput = {
      positionId: position.id,
      contractAddress: position.contractAddress,
      deployerTxHash: undefined,
    };
    this.largeHolderSellDetector.addToken(tokenInput);

    log.debug('RugAlertService.trackPosition: position registered', {
      positionId: position.id,
      contractAddress: position.contractAddress,
      poolAddress,
      lpTokenAddress,
    });
  }

  // ── IRugAlertService — untrackPosition ────────────────────────────────────

  /**
   * Unregisters a position from all three detection channels and removes it
   * from the internal position registry.
   *
   * Called by the executor after `closePosition` resolves (or by the caller
   * when the position is otherwise terminated).
   *
   * @param positionId - The UUID of the ShadowPosition to unregister.
   */
  untrackPosition(positionId: string): void {
    // Remove from all three detectors
    this.liquidityMonitor.removePool(positionId);
    this.lpRemovalDetector.removePool(positionId);
    this.largeHolderSellDetector.removeToken(positionId);

    // Remove from the internal registry
    this.monitoredPositions.delete(positionId);

    log.debug('RugAlertService.untrackPosition: position unregistered', { positionId });
  }

  // ── IRugAlertService — getAlertStats ──────────────────────────────────────

  /**
   * Returns a snapshot of alert statistics for the current session.
   *
   * Projects the internal MutableAlertStats onto the public AlertStats shape,
   * converting the Unix ms lastAlertAt timestamp to ISO 8601 (or null).
   *
   * Requirements: 6.6
   */
  getAlertStats(): AlertStats {
    return {
      alertsEmitted: {
        WARNING: this.stats.WARNING,
        HIGH: this.stats.HIGH,
        CRITICAL: this.stats.CRITICAL,
      },
      positionsClosedByAlert: this.stats.positionsClosedByAlert,
      suppressedAlerts: this.stats.suppressedAlerts,
      lastAlertAt:
        this.stats.lastAlertAt !== null
          ? new Date(this.stats.lastAlertAt).toISOString()
          : null,
      degradedMode: this.degradedMode,
    };
  }

  // ── IRugAlertService — getMonitoredCount ──────────────────────────────────

  /**
   * Returns the number of positions currently registered for monitoring.
   *
   * Requirements: 6.6
   */
  getMonitoredCount(): number {
    return this.monitoredPositions.size;
  }
}

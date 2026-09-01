/**
 * Hybrid Sniper — ShadowExecutor
 *
 * Opens and monitors simulated (shadow) positions using real on-chain prices
 * obtained via staticCall (no gas spent, no real transactions).
 *
 * Features:
 *   - Opens a ShadowPosition for each validated SniperSignal
 *   - Monitors open positions every `monitorIntervalMs` (default 10s)
 *   - Closes on TP_HIT, SL_HIT, or TIME_STOP
 *   - Notifies RiskBucket on every close
 *   - Persists all state changes via MetricsRecorder (INSERT OR REPLACE)
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import { type SniperSignal, type ShadowPosition, type IMetricsRecorder, type IDexQuoter, type IRiskBucket } from '../shared/index.js';

const log = createLogger('shadow-executor');

/**
 * FIX: Maximum consecutive quote failures before assuming rug pull.
 * When a position's quote fails this many times in a row, we close it as RUG_PULL
 * with 100% loss. This fixes the bug where rug pulls were never detected because
 * quote() kept failing silently and the position stayed OPEN forever.
 */
const MAX_QUOTE_FAILURES = 3;

// ═══════════════════════════════════════════════════════════════════════════
// Public interface
// ═══════════════════════════════════════════════════════════════════════════

export interface IShadowExecutor {
  openPosition(signal: SniperSignal): Promise<ShadowPosition | null>;
  /** Polling loop — checks all open positions and closes them on TP/SL/TimeStop */
  monitorPositions(): Promise<void>;
  getOpenPositions(): ShadowPosition[];
  /** Start the monitoring loop (async to restore positions from DB) */
  start(): Promise<void>;
  /** Stop the monitoring loop */
  stop(): void;
  /**
   * Force-closes a position with a given reason.
   * Called by RugAlertService when a rug pull is detected.
   *
   * Validates that position.status === 'OPEN' before acting (Requirement 4.7).
   * Returns the final pnlUsdc or null if the position was not found / already closed.
   *
   * Requirements: 4.1, 4.2
   */
  closePosition(
    position: ShadowPosition,
    reason: 'RUG_PULL',
    exitPrice: bigint,
  ): Promise<number | null>;
}

// ═══════════════════════════════════════════════════════════════════════════
// ShadowExecutor config
// ═══════════════════════════════════════════════════════════════════════════

export interface ShadowExecutorConfig {
  tradeSizeUsdc: number;
  tpPct: number;             // default 15
  slPct: number;             // default 5
  monitorIntervalMs: number; // default 10_000 (10s)
  usdcAddress: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// ShadowExecutor
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ShadowExecutor opens and monitors shadow (simulated) positions.
 *
 * All price quotes come from DexQuoter via staticCall — zero gas, no real
 * on-chain transactions at any point.
 *
 * Lifecycle:
 *   1. openPosition(signal) → creates a ShadowPosition, stores in Map
 *   2. start() → setInterval calls monitorPositions() every monitorIntervalMs
 *   3. monitorPositions() → checks prices, closes positions on TP/SL/TimeStop
 *   4. stop() → clearInterval
 */
export class ShadowExecutor implements IShadowExecutor {
  private readonly dexQuoter: IDexQuoter;
  private readonly riskBucket: IRiskBucket;
  private readonly metricsRecorder: IMetricsRecorder;
  private readonly config: Required<ShadowExecutorConfig>;

  /** Active open positions keyed by position id */
  private readonly openPositions: Map<string, ShadowPosition> = new Map();

  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    dexQuoter: IDexQuoter,
    riskBucket: IRiskBucket,
    metricsRecorder: IMetricsRecorder,
    config: {
      tradeSizeUsdc: number;
      tpPct?: number;
      slPct?: number;
      monitorIntervalMs?: number;
      usdcAddress: string;
    },
  ) {
    this.dexQuoter = dexQuoter;
    this.riskBucket = riskBucket;
    this.metricsRecorder = metricsRecorder;
    this.config = {
      tradeSizeUsdc: config.tradeSizeUsdc,
      tpPct: config.tpPct ?? 15,
      slPct: config.slPct ?? 5,
      monitorIntervalMs: config.monitorIntervalMs ?? 10_000,
      usdcAddress: config.usdcAddress,
    };
  }

  /**
   * Restore open positions from DB on startup.
   * This ensures positions survive container restarts.
   * Called automatically by start() before beginning the monitoring loop.
   * 
   * FIX: Now attempts to get real exit price for expired positions instead of
   * defaulting to entryPrice with $0 PnL. If quote fails, assumes rug pull
   * and records 100% loss.
   */
  async restoreOpenPositions(): Promise<void> {
    try {
      const openPositions = await this.metricsRecorder.getOpenPositions?.();
      if (!openPositions || openPositions.length === 0) {
        log.info('restoreOpenPositions: no open positions found in DB');
        return;
      }

      const now = Date.now();
      let restored = 0;
      let closedExpired = 0;
      let closedAsRugPull = 0;

      for (const pos of openPositions) {
        // Skip positions that already expired while container was down
        if (now > pos.timeStop) {
          // FIX: Try to get real exit price instead of assuming $0 PnL
          let exitPrice: bigint | null = null;
          let isRugPull = false;
          
          try {
            exitPrice = await this.dexQuoter.quote({
              tokenIn: this.config.usdcAddress,
              tokenOut: pos.contractAddress,
              amountIn: pos.tradeSize,
              poolAddress: pos.contractAddress,
            });
          } catch (err) {
            // Quote failed - this is likely a rug pull (no liquidity)
            log.warn('restoreOpenPositions: quote failed for expired position, assuming rug pull', {
              positionId: pos.id,
              contractAddress: pos.contractAddress,
              error: err instanceof Error ? err.message : String(err),
            });
            isRugPull = true;
          }
          
          if (isRugPull) {
            // FIX: Close as RUG_PULL with 100% loss instead of $0 PnL
            pos.status = 'RUG_PULL';
            pos.closedAt = now;
            pos.exitPrice = 0n;
            const tradeSizeUsdc = Number(pos.tradeSize) / 1_000_000;
            pos.pnlUsdc = -tradeSizeUsdc; // 100% loss
            this.metricsRecorder.recordPosition(pos);
            this.riskBucket.onPositionClosed('RUG_PULL');
            closedAsRugPull++;
            log.info('restoreOpenPositions: closed expired position as RUG_PULL', {
              positionId: pos.id,
              contractAddress: pos.contractAddress,
              pnlUsdc: pos.pnlUsdc,
            });
          } else {
            // FIX: Use real exit price to calculate actual PnL
            pos.status = 'TIME_STOP';
            pos.closedAt = now;
            pos.exitPrice = exitPrice!;
            
            // Calculate real PnL based on actual exit price
            // CRITICAL FIX (15 Ago 2026): Inverted PnL calculation!
            // Since entryPrice/exitPrice = "tokens received for X USDC":
            //   - FEWER tokens at exit = token went UP = PROFIT
            //   - MORE tokens at exit = token went DOWN = LOSS
            // PnL% = (entryPrice - exitPrice) / entryPrice  ← INVERTED!
            if (pos.entryPrice === 0n) {
              pos.pnlUsdc = 0;
            } else {
              // FIX: Inverted the subtraction order!
              const pctChange = Number(pos.entryPrice - exitPrice!) / Number(pos.entryPrice);
              const tradeSizeUsdc = Number(pos.tradeSize) / 1_000_000;
              pos.pnlUsdc = tradeSizeUsdc * pctChange;
            }
            
            this.metricsRecorder.recordPosition(pos);
            this.riskBucket.onPositionClosed('TIME_STOP');
            closedExpired++;
            log.info('restoreOpenPositions: closed expired position with real exit price', {
              positionId: pos.id,
              contractAddress: pos.contractAddress,
              expiredAt: new Date(pos.timeStop).toISOString(),
              entryPrice: pos.entryPrice.toString(),
              exitPrice: exitPrice!.toString(),
              pnlUsdc: pos.pnlUsdc,
            });
          }
          continue;
        }

        // Restore active position to memory (initialize quoteFailCount)
        pos.quoteFailCount = 0;
        this.openPositions.set(pos.id, pos);
        restored++;
      }

      log.info('restoreOpenPositions: completed', {
        total: openPositions.length,
        restored,
        closedExpired,
        closedAsRugPull,
      });
    } catch (err) {
      log.warn('restoreOpenPositions: failed (non-fatal)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // openPosition
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Opens a new shadow position for the given signal.
   *
   * Returns null (without counting as a loss) in the following cases:
   *   - RiskBucket has no available trades (budget exhausted or CB active)
   *   - DexQuoter.quote() throws (RPC error, contract revert)
   *
   * CRITICAL FIX (15 Ago 2026): Changed price representation.
   * Now we store the TOKEN amount received, and calculate TP/SL thresholds
   * such that a HIGHER currentTokenAmount = token LOST value (bearish).
   * 
   * The comparison logic in monitorPositions() is now:
   *   - TP_HIT when currentTokenAmount < takeProfit (token gained value)
   *   - SL_HIT when currentTokenAmount > stopLoss (token lost value)
   *
   * Requirements: 5.1, 5.2, 5.3, 5.5
   */
  async openPosition(signal: SniperSignal): Promise<ShadowPosition | null> {
    // Step 1: Check risk budget before doing anything
    if (this.riskBucket.availableTrades(this.openPositions.size) === 0) {
      log.debug('openPosition: no available trades — skipping', {
        signalId: signal.id,
        contractAddress: signal.contractAddress,
      });
      return null;
    }

    // Step 2: Get entry price via staticCall — if it fails, log warn and return null
    // (does NOT count as a loss — the position was never opened)
    let tokensReceived: bigint;
    const tradeSize = BigInt(Math.round(this.config.tradeSizeUsdc * 1_000_000));

    try {
      // Quote: How many TOKENS do we get for our USDC?
      tokensReceived = await this.dexQuoter.quote({
        tokenIn: this.config.usdcAddress,
        tokenOut: signal.contractAddress,
        amountIn: tradeSize,
        poolAddress: signal.contractAddress,
      });
    } catch (err) {
      log.warn('openPosition: quote failed — skipping (not counted as loss)', {
        signalId: signal.id,
        contractAddress: signal.contractAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    // Step 3: Calculate TP, SL, and TimeStop
    // CRITICAL FIX: The math is INVERTED because we're measuring tokens-per-USDC
    // 
    // If token GAINS value:
    //   - We get FEWER tokens per USDC (currentTokens < entryTokens)
    //   - TP_HIT when currentTokens < takeProfit threshold
    //
    // If token LOSES value:
    //   - We get MORE tokens per USDC (currentTokens > entryTokens)  
    //   - SL_HIT when currentTokens > stopLoss threshold
    //
    // So we need to INVERT the calculation:
    //   - takeProfit = entryTokens * (100 - tpPct) / 100  (FEWER tokens = token went UP)
    //   - stopLoss = entryTokens * (100 + slPct) / 100   (MORE tokens = token went DOWN)
    
    const tpPct = this.config.tpPct;
    const slPct = this.config.slPct;

    // FIXED: Inverted math
    // TP threshold: If token goes UP by tpPct%, we get FEWER tokens
    const takeProfit = (tokensReceived * BigInt(100 - tpPct)) / 100n;
    // SL threshold: If token goes DOWN by slPct%, we get MORE tokens  
    const stopLoss = (tokensReceived * BigInt(100 + slPct)) / 100n;
    
    // TIME_STOP: 4 hours (was 2h, increased to give micro-caps more time to pump)
    const timeStop = signal.ingestionTime + 14_400_000; // ingestionTime + 4 hours

    // Step 4: Create the ShadowPosition
    // entryPrice stores the tokens received for our USDC investment
    const position: ShadowPosition = {
      id: randomUUID(),
      signalId: signal.id,
      contractAddress: signal.contractAddress,
      entryPrice: tokensReceived,  // Tokens received for tradeSize USDC
      takeProfit,                   // Threshold: fewer tokens = token went UP
      stopLoss,                     // Threshold: more tokens = token went DOWN
      timeStop,
      tradeSize,
      status: 'OPEN',
      openedAt: Date.now(),
      closedAt: null,
      exitPrice: null,
      pnlUsdc: null,
      quoteFailCount: 0,
    };

    // Step 5: Track in the open positions Map
    this.openPositions.set(position.id, position);

    // Step 6: Persist initial state
    this.metricsRecorder.recordPosition(position);

    log.info('openPosition: position opened', {
      positionId: position.id,
      signalId: signal.id,
      contractAddress: signal.contractAddress,
      tokensReceived: tokensReceived.toString(),
      takeProfit: takeProfit.toString(),
      stopLoss: stopLoss.toString(),
      tpPct,
      slPct,
      timeStop,
      tradeSizeUsdc: this.config.tradeSizeUsdc,
    });

    return position;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // monitorPositions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Checks all OPEN positions against current on-chain prices and closes them
   * when TP, SL, or TimeStop conditions are met.
   *
   * Called internally on the interval set by start(). Can also be called
   * manually in tests.
   *
   * CRITICAL FIX (15 Ago 2026): Inverted comparison logic.
   * Since we measure "tokens received per USDC":
   *   - Token goes UP in value → we get FEWER tokens → currentTokens < entryTokens
   *   - Token goes DOWN in value → we get MORE tokens → currentTokens > entryTokens
   *
   * So the comparisons are:
   *   - TP_HIT: currentTokens < takeProfit (token gained value, we get fewer tokens)
   *   - SL_HIT: currentTokens > stopLoss (token lost value, we get more tokens)
   *
   * FIX: When DexQuoter.quote() fails for a position, we now track consecutive
   * failures. After MAX_QUOTE_FAILURES (3) failures, we assume rug pull and
   * close the position with 100% loss.
   *
   * Requirements: 5.2, 5.3, 5.4
   */
  async monitorPositions(): Promise<void> {
    const now = Date.now();

    for (const [id, position] of this.openPositions) {
      // Get current "price" = how many tokens do we get for our USDC now?
      let currentTokens: bigint;
      try {
        currentTokens = await this.dexQuoter.quote({
          tokenIn: this.config.usdcAddress,
          tokenOut: position.contractAddress,
          amountIn: position.tradeSize,
          poolAddress: position.contractAddress,
        });
        
        // FIX: Reset failure counter on successful quote
        position.quoteFailCount = 0;
        
      } catch (err) {
        // FIX: Track consecutive quote failures
        position.quoteFailCount = (position.quoteFailCount ?? 0) + 1;
        
        log.warn('monitorPositions: quote failed', {
          positionId: id,
          contractAddress: position.contractAddress,
          quoteFailCount: position.quoteFailCount,
          maxFailures: MAX_QUOTE_FAILURES,
          error: err instanceof Error ? err.message : String(err),
        });
        
        // FIX: After MAX_QUOTE_FAILURES consecutive failures, assume rug pull
        if (position.quoteFailCount >= MAX_QUOTE_FAILURES) {
          log.warn('monitorPositions: MAX_QUOTE_FAILURES reached, closing as RUG_PULL', {
            positionId: id,
            contractAddress: position.contractAddress,
          });
          this._closePositionAsRugPull(position);
        }
        // Otherwise skip this position and retry next cycle
        continue;
      }

      // Determine exit reason (in priority order)
      // CRITICAL FIX: Inverted comparisons!
      //   - FEWER tokens = token went UP = TP_HIT (we want currentTokens < takeProfit)
      //   - MORE tokens = token went DOWN = SL_HIT (we want currentTokens > stopLoss)
      let exitReason: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP' | null = null;

      if (currentTokens < position.takeProfit) {
        // Token GAINED value! We get fewer tokens per USDC = the token is worth more
        exitReason = 'TP_HIT';
      } else if (currentTokens > position.stopLoss) {
        // Token LOST value! We get more tokens per USDC = the token is worth less
        exitReason = 'SL_HIT';
      } else if (now > position.timeStop) {
        exitReason = 'TIME_STOP';
      }

      if (exitReason === null) {
        // Position still active — nothing to do
        continue;
      }

      // Close the position
      this._closePosition(position, exitReason, currentTokens);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getOpenPositions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns all currently open positions as an array.
   * The array is a snapshot — mutations to it do not affect the internal Map.
   */
  getOpenPositions(): ShadowPosition[] {
    return Array.from(this.openPositions.values());
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle — start / stop
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Starts the monitoring loop.
   * Safe to call multiple times — only one interval runs at a time.
   * 
   * NOTE: This method is now async and restores open positions from DB before
   * starting the monitoring loop. This ensures positions survive container restarts.
   */
  async start(): Promise<void> {
    if (this.intervalHandle !== null) {
      log.debug('start: monitoring loop already running');
      return;
    }

    // Restore open positions from DB before starting
    await this.restoreOpenPositions();

    this.intervalHandle = setInterval(
      () => void this.monitorPositions(),
      this.config.monitorIntervalMs,
    );
    log.info('start: monitoring loop started', {
      intervalMs: this.config.monitorIntervalMs,
    });
  }

  /**
   * Stops the monitoring loop.
   * Safe to call even if start() was never called.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      log.info('stop: monitoring loop stopped');
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * FIX: Closes a position as RUG_PULL with 100% loss.
   * 
   * Called when:
   *   - quote() fails MAX_QUOTE_FAILURES consecutive times (likely no liquidity)
   *   - Expired position cannot be quoted during restoreOpenPositions()
   * 
   * This fixes the critical bug where rug pulls were never detected and
   * positions stayed OPEN forever or closed with $0 PnL.
   */
  private _closePositionAsRugPull(position: ShadowPosition): void {
    position.status = 'RUG_PULL';
    position.closedAt = Date.now();
    position.exitPrice = 0n; // Token is worthless
    
    // Calculate 100% loss
    const tradeSizeUsdc = Number(position.tradeSize) / 1_000_000;
    position.pnlUsdc = -tradeSizeUsdc;

    // Notify RiskBucket (counts as SL_HIT for circuit breaker purposes)
    this.riskBucket.onPositionClosed('RUG_PULL');

    // Persist updated state
    this.metricsRecorder.recordPosition(position);

    // Remove from open positions Map
    this.openPositions.delete(position.id);

    log.info('_closePositionAsRugPull: position closed as rug pull', {
      positionId: position.id,
      contractAddress: position.contractAddress,
      entryPrice: position.entryPrice.toString(),
      tradeSizeUsdc,
      pnlUsdc: position.pnlUsdc,
    });
  }

  /**
   * Public API for RugAlertService to force-close a position due to a rug pull.
   *
   * Validates that the position is still OPEN (Requirement 4.7) — if not, logs
   * a warning and returns null so the caller can discard the alert.
   *
   * Delegates to _closePosition with reason='RUG_PULL' and the provided exitPrice.
   * Returns the resulting pnlUsdc, or null if the position was not in OPEN status.
   *
   * Requirements: 4.1, 4.2
   */
  async closePosition(
    position: ShadowPosition,
    reason: 'RUG_PULL',
    exitPrice: bigint,
  ): Promise<number | null> {
    // Verify the position is tracked and still OPEN
    const tracked = this.openPositions.get(position.id);
    if (!tracked || tracked.status !== 'OPEN') {
      log.warn('closePosition: position not OPEN — discarding alert', {
        positionId: position.id,
        status: tracked?.status ?? 'NOT_FOUND',
      });
      return null;
    }

    this._closePosition(tracked, reason, exitPrice);
    return tracked.pnlUsdc ?? null;
  }

  /**
   * Closes an open position with the given exit reason and price.
   *
   * Mutates the position in place, notifies RiskBucket, persists the updated
   * record, and removes it from the open positions Map.
   *
   * CRITICAL FIX (15 Ago 2026): Inverted PnL calculation!
   * 
   * Since entryPrice/exitPrice = "tokens received for X USDC":
   *   - Token goes UP in value → we get FEWER tokens → exitPrice < entryPrice → PROFIT
   *   - Token goes DOWN in value → we get MORE tokens → exitPrice > entryPrice → LOSS
   *
   * The CORRECT formula is INVERTED:
   *   pnlUsdc = tradeSizeUsdc * (entryPrice - exitPrice) / entryPrice
   *
   * Example:
   *   - Entry: 1000 tokens per $5 USDC
   *   - Exit: 500 tokens per $5 USDC (token DOUBLED in value)
   *   - PnL% = (1000 - 500) / 1000 = +50% → PROFIT ✓
   *
   * Requirements: 5.2, 5.3, 5.4
   */
  private _closePosition(
    position: ShadowPosition,
    exitReason: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP' | 'RUG_PULL',
    exitPrice: bigint,
  ): void {
    position.status = exitReason;
    position.closedAt = Date.now();
    position.exitPrice = exitPrice;

    // Calculate PnL in USDC
    // entryPrice/exitPrice = tokens received for tradeSize USDC
    // 
    // CRITICAL FIX: The math is INVERTED because we're measuring tokens-per-USDC!
    //   - FEWER tokens at exit = token went UP = PROFIT
    //   - MORE tokens at exit = token went DOWN = LOSS
    //
    // PnL% = (entryPrice - exitPrice) / entryPrice  ← INVERTED!
    // PnL in USDC = tradeSizeUsdc * PnL%
    if (position.entryPrice === 0n) {
      position.pnlUsdc = 0;
    } else {
      // FIX: Inverted the subtraction order!
      const pctChange = Number(position.entryPrice - exitPrice) / Number(position.entryPrice);
      const tradeSizeUsdc = Number(position.tradeSize) / 1_000_000;
      position.pnlUsdc = tradeSizeUsdc * pctChange;
    }

    // Notify RiskBucket (updates consecutiveLosses / CircuitBreaker)
    this.riskBucket.onPositionClosed(exitReason);

    // Persist updated state (INSERT OR REPLACE)
    this.metricsRecorder.recordPosition(position);

    // Remove from open positions Map
    this.openPositions.delete(position.id);

    log.info('_closePosition: position closed', {
      positionId: position.id,
      contractAddress: position.contractAddress,
      exitReason,
      entryPrice: position.entryPrice.toString(),
      exitPrice: exitPrice.toString(),
      pnlUsdc: position.pnlUsdc,
    });
  }
}

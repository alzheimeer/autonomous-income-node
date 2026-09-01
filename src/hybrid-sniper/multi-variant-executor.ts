/**
 * Hybrid Sniper — Multi-Variant Executor
 *
 * Executes shadow trades across multiple parameter configurations simultaneously.
 * For each incoming signal, opens positions with ALL active variants to compare
 * which configurations perform best.
 *
 * Features:
 *   - Opens parallel shadow positions for each variant
 *   - Tracks metrics per variant (win rate, PnL, exit reasons)
 *   - Monitors all positions with different TP/SL/TimeStop
 *   - Generates comparison reports
 *   - Persists variant metrics to database
 *
 * Requirements: Research mode multi-parameter exploration
 */

import { randomUUID } from 'node:crypto';
import { createLogger } from '../logger.js';
import type { SniperSignal, ShadowPosition, IMetricsRecorder, IDexQuoter, IRiskBucket } from '../shared/index.js';
import type { ExplorationVariant, ExplorationModeConfig, CryptoPair } from './exploration-config.js';
import { DEFAULT_EXPLORATION_CONFIG, BASE_ESTABLISHED_PAIRS } from './exploration-config.js';

const log = createLogger('multi-variant');

/**
 * FIX: Maximum consecutive quote failures before assuming rug pull.
 * When a position's quote fails this many times in a row, we close it as RUG_PULL
 * with 100% loss. This fixes the bug where rug pulls were never detected because
 * quote() kept failing silently and the position stayed OPEN forever.
 */
const MAX_QUOTE_FAILURES = 3;

// ═══════════════════════════════════════════════════════════════════════════
// Extended Position Type with Variant Info
// ═══════════════════════════════════════════════════════════════════════════

export interface VariantPosition extends ShadowPosition {
  /** Which variant configuration this position uses */
  variantId: string;
  /** Variant name for display */
  variantName: string;
  /** Source of the signal (micro-cap vs established pair) */
  signalSource: 'micro-cap' | 'established';
  /** For established pairs, which pair */
  pairId?: string;
  /** FIX: Counter for consecutive quote failures (rug pull detection) */
  quoteFailCount?: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Variant Performance Metrics
// ═══════════════════════════════════════════════════════════════════════════

export interface VariantMetrics {
  variantId: string;
  variantName: string;
  totalTrades: number;
  openPositions: number;
  wins: number;
  losses: number;
  timeStops: number;
  winRate: number;
  totalPnlUsdc: number;
  avgPnlUsdc: number;
  maxDrawdown: number;
  bestTrade: number;
  worstTrade: number;
  avgHoldingTimeMs: number;
  lastUpdated: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-Variant Executor
// ═══════════════════════════════════════════════════════════════════════════

export class MultiVariantExecutor {
  private readonly dexQuoter: IDexQuoter;
  private readonly riskBucket: IRiskBucket;
  private readonly metricsRecorder: IMetricsRecorder;
  private readonly config: ExplorationModeConfig;
  private readonly usdcAddress: string;

  /** All open positions across all variants: Map<positionId, VariantPosition> */
  private readonly openPositions: Map<string, VariantPosition> = new Map();

  /** Metrics per variant: Map<variantId, VariantMetrics> */
  private readonly variantMetrics: Map<string, VariantMetrics> = new Map();

  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private reportInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    dexQuoter: IDexQuoter,
    riskBucket: IRiskBucket,
    metricsRecorder: IMetricsRecorder,
    config: Partial<ExplorationModeConfig> = {},
  ) {
    this.dexQuoter = dexQuoter;
    this.riskBucket = riskBucket;
    this.metricsRecorder = metricsRecorder;
    this.config = { ...DEFAULT_EXPLORATION_CONFIG, ...config };
    this.usdcAddress = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

    // Initialize metrics for each variant
    for (const variant of this.config.variants) {
      this.variantMetrics.set(variant.id, this.createEmptyMetrics(variant));
    }

    log.info('MultiVariantExecutor initialized', {
      variantCount: this.config.variants.length,
      variants: this.config.variants.map(v => v.id),
      monitorEstablished: this.config.monitorEstablishedPairs,
      establishedPairs: this.config.establishedPairs.map(p => p.id),
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Restore open positions from DB on startup.
   * This ensures positions survive container restarts.
   * 
   * FIX: Now attempts to get real exit price for expired positions instead of
   * losing them. If quote fails, assumes rug pull and records 100% loss.
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
        // Cast to VariantPosition (may not have variant fields if old data)
        const position = pos as VariantPosition;
        
        // Skip positions that already expired while container was down
        if (now > position.timeStop) {
          // FIX: Try to get real exit price instead of losing the position
          let exitPrice: bigint | null = null;
          let isRugPull = false;
          
          try {
            exitPrice = await this.dexQuoter.quote({
              tokenIn: this.usdcAddress,
              tokenOut: position.contractAddress,
              amountIn: position.tradeSize,
              poolAddress: position.contractAddress,
            });
          } catch (err) {
            // Quote failed - this is likely a rug pull (no liquidity)
            log.warn('restoreOpenPositions: quote failed for expired position, assuming rug pull', {
              positionId: position.id,
              contractAddress: position.contractAddress,
              variantId: position.variantId,
              error: err instanceof Error ? err.message : String(err),
            });
            isRugPull = true;
          }
          
          if (isRugPull) {
            // FIX: Close as RUG_PULL with 100% loss instead of losing the position
            position.status = 'RUG_PULL';
            position.closedAt = now;
            position.exitPrice = 0n;
            const tradeSizeUsdc = Number(position.tradeSize) / 1_000_000;
            position.pnlUsdc = -tradeSizeUsdc; // 100% loss
            this.metricsRecorder.recordPosition(position);
            this.riskBucket.onPositionClosed('RUG_PULL');
            
            // Update variant metrics if we have the variantId
            if (position.variantId) {
              this._updateVariantMetricsOnClose(position, 'SL_HIT');
            }
            
            closedAsRugPull++;
            log.info('restoreOpenPositions: closed expired position as RUG_PULL', {
              positionId: position.id,
              contractAddress: position.contractAddress,
              variantId: position.variantId,
              pnlUsdc: position.pnlUsdc,
            });
          } else {
            // FIX: Use real exit price to calculate actual PnL
            position.status = 'TIME_STOP';
            position.closedAt = now;
            position.exitPrice = exitPrice!;
            
            // Calculate real PnL based on actual exit price (INVERTED formula)
            if (position.entryPrice === 0n) {
              position.pnlUsdc = 0;
            } else {
              const pctChange = Number(position.entryPrice - exitPrice!) / Number(position.entryPrice);
              const tradeSizeUsdc = Number(position.tradeSize) / 1_000_000;
              position.pnlUsdc = tradeSizeUsdc * pctChange;
            }
            
            this.metricsRecorder.recordPosition(position);
            this.riskBucket.onPositionClosed('TIME_STOP');
            
            // Update variant metrics if we have the variantId
            if (position.variantId) {
              this._updateVariantMetricsOnClose(position, 'TIME_STOP');
            }
            
            closedExpired++;
            log.info('restoreOpenPositions: closed expired position with real exit price', {
              positionId: position.id,
              contractAddress: position.contractAddress,
              variantId: position.variantId,
              entryPrice: position.entryPrice.toString(),
              exitPrice: exitPrice!.toString(),
              pnlUsdc: position.pnlUsdc,
            });
          }
          continue;
        }

        // Restore active position to memory (initialize quoteFailCount)
        position.quoteFailCount = 0;
        this.openPositions.set(position.id, position);
        
        // Update variant metrics for restored positions
        if (position.variantId) {
          const metrics = this.variantMetrics.get(position.variantId);
          if (metrics) {
            metrics.openPositions++;
          }
        }
        
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

  /**
   * Start the multi-variant executor.
   * - Restores open positions from DB (survives container restarts)
   * - Monitors positions every 10 seconds
   * - Reports metrics every reportIntervalMinutes
   * 
   * NOTE: Now async to support restoreOpenPositions()
   */
  async start(): Promise<void> {
    if (this.monitorInterval !== null) return;

    // FIX: Restore open positions from DB before starting
    await this.restoreOpenPositions();

    // Monitor positions every 10 seconds
    this.monitorInterval = setInterval(() => {
      void this.monitorAllPositions();
    }, 10_000);

    // Report metrics periodically
    this.reportInterval = setInterval(() => {
      this.logVariantComparison();
    }, this.config.reportIntervalMinutes * 60 * 1000);

    log.info('MultiVariantExecutor started', {
      monitorIntervalMs: 10_000,
      reportIntervalMinutes: this.config.reportIntervalMinutes,
      restoredPositions: this.openPositions.size,
    });
  }

  stop(): void {
    if (this.monitorInterval !== null) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    if (this.reportInterval !== null) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
    log.info('MultiVariantExecutor stopped');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Open positions for all variants
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Open shadow positions for a signal across ALL configured variants.
   * This is the core of multi-parameter exploration.
   *
   * @param signal - The incoming token signal
   * @returns Array of opened positions (one per variant that successfully opened)
   */
  async openMultiVariantPositions(signal: SniperSignal): Promise<VariantPosition[]> {
    const opened: VariantPosition[] = [];

    // Check total position limit
    if (this.openPositions.size >= this.config.maxTotalPositions) {
      log.debug('openMultiVariantPositions: total position limit reached', {
        current: this.openPositions.size,
        max: this.config.maxTotalPositions,
      });
      return opened;
    }

    // Get entry price once (shared across variants to ensure fair comparison)
    let entryPrice: bigint;
    const baseTradeSize = BigInt(5_000_000); // $5 for quote (actual size varies per variant)

    try {
      entryPrice = await this.dexQuoter.quote({
        tokenIn: this.usdcAddress,
        tokenOut: signal.contractAddress,
        amountIn: baseTradeSize,
        poolAddress: signal.poolAddress ?? signal.contractAddress,
      });
    } catch (err) {
      log.warn('openMultiVariantPositions: quote failed — skipping all variants', {
        signalId: signal.id,
        contractAddress: signal.contractAddress,
        error: err instanceof Error ? err.message : String(err),
      });
      return opened;
    }

    // Open position for each variant
    for (const variant of this.config.variants) {
      // Check per-variant position limit
      const variantPositionCount = this.countVariantPositions(variant.id);
      if (variantPositionCount >= this.config.maxPositionsPerVariant) {
        continue;
      }

      // Check total limit again (may have filled during loop)
      if (this.openPositions.size >= this.config.maxTotalPositions) {
        break;
      }

      const position = this.createVariantPosition(
        signal,
        variant,
        entryPrice,
        'micro-cap',
      );

      this.openPositions.set(position.id, position);
      this.metricsRecorder.recordPosition(position);

      // Update variant metrics
      const metrics = this.variantMetrics.get(variant.id);
      if (metrics) {
        metrics.totalTrades++;
        metrics.openPositions++;
        metrics.lastUpdated = Date.now();
      }

      opened.push(position);
    }

    if (opened.length > 0) {
      log.info('openMultiVariantPositions: opened positions for signal', {
        signalId: signal.id,
        contractAddress: signal.contractAddress,
        variantsOpened: opened.length,
        totalVariants: this.config.variants.length,
        variants: opened.map(p => p.variantId),
      });
    }

    return opened;
  }

  /**
   * Open positions for established pairs (WETH/USDC, etc.)
   * These run alongside micro-cap signals to validate parameters on
   * predictable, liquid pairs.
   */
  async openEstablishedPairPositions(): Promise<VariantPosition[]> {
    if (!this.config.monitorEstablishedPairs) {
      return [];
    }

    const opened: VariantPosition[] = [];

    for (const pair of this.config.establishedPairs) {
      // Check total position limit
      if (this.openPositions.size >= this.config.maxTotalPositions) {
        break;
      }

      // Check if we already have positions for this pair
      const existingPairPositions = Array.from(this.openPositions.values())
        .filter(p => p.pairId === pair.id).length;

      if (existingPairPositions >= this.config.variants.length) {
        // Already have positions for all variants on this pair
        continue;
      }

      // Get entry price for this pair
      let entryPrice: bigint;
      const baseTradeSize = BigInt(5_000_000);

      try {
        entryPrice = await this.dexQuoter.quote({
          tokenIn: pair.quoteAddress,
          tokenOut: pair.baseAddress,
          amountIn: baseTradeSize,
          poolAddress: pair.poolAddress,
        });
      } catch (err) {
        log.debug('openEstablishedPairPositions: quote failed for pair', {
          pair: pair.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Open for each variant that doesn't already have a position on this pair
      for (const variant of this.config.variants) {
        const hasExisting = Array.from(this.openPositions.values())
          .some(p => p.pairId === pair.id && p.variantId === variant.id);

        if (hasExisting) continue;

        // Check per-variant limit
        const variantCount = this.countVariantPositions(variant.id);
        if (variantCount >= this.config.maxPositionsPerVariant) continue;

        const signal: SniperSignal = {
          id: randomUUID(),
          ticker: pair.baseToken,
          contractAddress: pair.baseAddress,
          source: 'webhook', // Treat as internal signal
          ingestionTime: Date.now(),
          poolAddress: pair.poolAddress,
        };

        const position = this.createVariantPosition(
          signal,
          variant,
          entryPrice,
          'established',
          pair.id,
        );

        this.openPositions.set(position.id, position);
        this.metricsRecorder.recordPosition(position);

        const metrics = this.variantMetrics.get(variant.id);
        if (metrics) {
          metrics.totalTrades++;
          metrics.openPositions++;
          metrics.lastUpdated = Date.now();
        }

        opened.push(position);
      }
    }

    if (opened.length > 0) {
      log.info('openEstablishedPairPositions: opened positions', {
        count: opened.length,
        pairs: [...new Set(opened.map(p => p.pairId))],
      });
    }

    return opened;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Monitor all positions
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Monitor all open positions across all variants.
   * Each position is checked against its own TP/SL/TimeStop thresholds.
   * 
   * FIX: Now tracks consecutive quote failures and closes positions as RUG_PULL
   * after MAX_QUOTE_FAILURES (3) consecutive failures.
   */
  async monitorAllPositions(): Promise<void> {
    const now = Date.now();

    for (const [id, position] of this.openPositions) {
      // Get current price
      let currentPrice: bigint;
      try {
        currentPrice = await this.dexQuoter.quote({
          tokenIn: this.usdcAddress,
          tokenOut: position.contractAddress,
          amountIn: position.tradeSize,
          poolAddress: position.contractAddress,
        });
        
        // FIX: Reset failure counter on successful quote
        position.quoteFailCount = 0;
        
      } catch (err) {
        // FIX: Track consecutive quote failures
        position.quoteFailCount = (position.quoteFailCount ?? 0) + 1;
        
        log.warn('monitorAllPositions: quote failed', {
          positionId: id,
          variantId: position.variantId,
          quoteFailCount: position.quoteFailCount,
          maxFailures: MAX_QUOTE_FAILURES,
          error: err instanceof Error ? err.message : String(err),
        });
        
        // FIX: After MAX_QUOTE_FAILURES consecutive failures, assume rug pull
        if (position.quoteFailCount >= MAX_QUOTE_FAILURES) {
          log.warn('monitorAllPositions: MAX_QUOTE_FAILURES reached, closing as RUG_PULL', {
            positionId: id,
            variantId: position.variantId,
            contractAddress: position.contractAddress,
          });
          this._closePositionAsRugPull(position);
        }
        // Otherwise skip this position and retry next cycle
        continue;
      }

      // Check exit conditions
      // FIX CRÍTICO: Comparaciones INVERTIDAS
      // currentPrice = "cuántos TOKENS recibes ahora por X USDC"
      // Token SUBE → menos tokens → currentPrice < takeProfit → TP_HIT
      // Token BAJA → más tokens → currentPrice > stopLoss → SL_HIT
      let exitReason: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP' | null = null;

      if (currentPrice < position.takeProfit) {
        exitReason = 'TP_HIT';  // Menos tokens = token subió = GANANCIA
      } else if (currentPrice > position.stopLoss) {
        exitReason = 'SL_HIT';  // Más tokens = token bajó = PÉRDIDA
      } else if (now >= position.timeStop) {
        exitReason = 'TIME_STOP';
      }

      if (exitReason !== null) {
        this.closePosition(position, exitReason, currentPrice);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Close position and update metrics
  // ─────────────────────────────────────────────────────────────────────────

  public closePosition(
    position: VariantPosition,
    exitReason: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP',
    exitPrice: bigint,
  ): void {
    position.status = exitReason;
    position.closedAt = Date.now();
    position.exitPrice = exitPrice;

    // Calculate PnL in USDC
    // FIX CRÍTICO: Fórmula de PnL INVERTIDA
    // entryPrice/exitPrice = "tokens recibidos por X USDC"
    //   - MENOS tokens al salir = token subió = GANANCIA (pnl positivo)
    //   - MÁS tokens al salir = token bajó = PÉRDIDA (pnl negativo)
    // PnL% = (entryPrice - exitPrice) / entryPrice  ← INVERTIDO!
    // PnL in USDC = tradeSizeUsdc * PnL%
    if (position.entryPrice === 0n) {
      position.pnlUsdc = 0;
    } else {
      // FIX: Invertir el orden de la resta
      const pctChange = Number(position.entryPrice - exitPrice) / Number(position.entryPrice);
      // Apply to trade size (tradeSize is in 6-decimal USDC, so divide by 1e6)
      const tradeSizeUsdc = Number(position.tradeSize) / 1_000_000;
      position.pnlUsdc = tradeSizeUsdc * pctChange;
    }

    // Notify risk bucket
    this.riskBucket.onPositionClosed(exitReason);

    // Persist to DB
    this.metricsRecorder.recordPosition(position);

    // Update variant metrics
    this._updateVariantMetricsOnClose(position, exitReason);

    // Remove from open positions
    this.openPositions.delete(position.id);

    log.info('closePosition: variant position closed', {
      positionId: position.id,
      variantId: position.variantId,
      variantName: position.variantName,
      exitReason,
      pnlUsdc: position.pnlUsdc.toFixed(2),
      signalSource: position.signalSource,
    });
  }

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
  private _closePositionAsRugPull(position: VariantPosition): void {
    position.status = 'RUG_PULL';
    position.closedAt = Date.now();
    position.exitPrice = 0n; // Token is worthless
    
    // Calculate 100% loss
    const tradeSizeUsdc = Number(position.tradeSize) / 1_000_000;
    position.pnlUsdc = -tradeSizeUsdc;

    // Notify RiskBucket (counts as loss for circuit breaker)
    this.riskBucket.onPositionClosed('RUG_PULL');

    // Persist updated state
    this.metricsRecorder.recordPosition(position);

    // Update variant metrics (counts as a loss)
    this._updateVariantMetricsOnClose(position, 'SL_HIT'); // Treat as SL for metrics

    // Remove from open positions Map
    this.openPositions.delete(position.id);

    log.info('_closePositionAsRugPull: position closed as rug pull', {
      positionId: position.id,
      variantId: position.variantId,
      variantName: position.variantName,
      contractAddress: position.contractAddress,
      tradeSizeUsdc,
      pnlUsdc: position.pnlUsdc,
      signalSource: position.signalSource,
    });
  }

  /**
   * Helper to update variant metrics when a position closes.
   * Extracted to avoid code duplication between closePosition and _closePositionAsRugPull.
   */
  private _updateVariantMetricsOnClose(
    position: VariantPosition,
    exitReason: 'TP_HIT' | 'SL_HIT' | 'TIME_STOP',
  ): void {
    const metrics = this.variantMetrics.get(position.variantId);
    if (!metrics) return;

    metrics.openPositions--;
    metrics.totalPnlUsdc += position.pnlUsdc!;

    if (exitReason === 'TP_HIT') {
      metrics.wins++;
    } else if (exitReason === 'SL_HIT') {
      metrics.losses++;
    } else {
      metrics.timeStops++;
    }

    const closedTrades = metrics.wins + metrics.losses + metrics.timeStops;
    metrics.winRate = closedTrades > 0 ? metrics.wins / closedTrades : 0;
    metrics.avgPnlUsdc = closedTrades > 0 ? metrics.totalPnlUsdc / closedTrades : 0;

    if (position.pnlUsdc! > metrics.bestTrade) {
      metrics.bestTrade = position.pnlUsdc!;
    }
    if (position.pnlUsdc! < metrics.worstTrade) {
      metrics.worstTrade = position.pnlUsdc!;
    }

    // Track drawdown
    if (metrics.totalPnlUsdc < metrics.maxDrawdown) {
      metrics.maxDrawdown = metrics.totalPnlUsdc;
    }

    // Update avg holding time
    const holdingTime = (position.closedAt ?? Date.now()) - position.openedAt;
    const prevTotal = metrics.avgHoldingTimeMs * (closedTrades - 1);
    metrics.avgHoldingTimeMs = (prevTotal + holdingTime) / closedTrades;

    metrics.lastUpdated = Date.now();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Metrics and Reporting
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get all variant metrics sorted by performance.
   */
  getVariantMetrics(): VariantMetrics[] {
    return Array.from(this.variantMetrics.values())
      .sort((a, b) => b.totalPnlUsdc - a.totalPnlUsdc);
  }

  /**
   * Get the best performing variant based on total PnL.
   */
  getBestVariant(): VariantMetrics | null {
    const metrics = this.getVariantMetrics();
    return metrics.length > 0 ? metrics[0] : null;
  }

  /**
   * Log a comparison of all variant performances.
   */
  logVariantComparison(): void {
    const metrics = this.getVariantMetrics();

    if (metrics.every(m => m.totalTrades === 0)) {
      log.info('Variant comparison: No trades yet');
      return;
    }

    log.info('═══════════════════════════════════════════════════════════════');
    log.info('         MULTI-VARIANT EXPLORATION REPORT');
    log.info('═══════════════════════════════════════════════════════════════');

    for (const m of metrics) {
      if (m.totalTrades === 0) continue;

      log.info(`\n📊 ${m.variantName} (${m.variantId})`);
      log.info(`   Trades: ${m.totalTrades} | Open: ${m.openPositions}`);
      log.info(`   Win Rate: ${(m.winRate * 100).toFixed(1)}% (${m.wins}W / ${m.losses}L / ${m.timeStops}T)`);
      log.info(`   Total PnL: $${m.totalPnlUsdc.toFixed(2)} | Avg: $${m.avgPnlUsdc.toFixed(2)}`);
      log.info(`   Best: $${m.bestTrade.toFixed(2)} | Worst: $${m.worstTrade.toFixed(2)}`);
      log.info(`   Max Drawdown: $${m.maxDrawdown.toFixed(2)}`);
      log.info(`   Avg Hold: ${Math.round(m.avgHoldingTimeMs / 60000)}min`);
    }

    log.info('═══════════════════════════════════════════════════════════════');

    // Highlight best performer
    const best = this.getBestVariant();
    if (best && best.totalTrades > 0) {
      log.info(`🏆 Best Performer: ${best.variantName} with $${best.totalPnlUsdc.toFixed(2)} PnL`);
    }
  }

  /**
   * Generate a formatted report string for Telegram or other notifications.
   */
  generateReport(): string {
    const metrics = this.getVariantMetrics();
    const lines: string[] = [
      '📊 *MULTI-VARIANT EXPLORATION REPORT*',
      '',
      `Total Open Positions: ${this.openPositions.size}`,
      '',
    ];

    for (const m of metrics.slice(0, 5)) { // Top 5 variants
      if (m.totalTrades === 0) continue;

      const emoji = m.totalPnlUsdc >= 0 ? '🟢' : '🔴';
      lines.push(`${emoji} *${m.variantName}*`);
      lines.push(`   ${m.totalTrades} trades | WR: ${(m.winRate * 100).toFixed(0)}%`);
      lines.push(`   PnL: $${m.totalPnlUsdc.toFixed(2)}`);
      lines.push('');
    }

    const best = this.getBestVariant();
    if (best && best.totalTrades > 0) {
      lines.push(`🏆 *Best:* ${best.variantName}`);
    }

    return lines.join('\n');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helper methods
  // ─────────────────────────────────────────────────────────────────────────

  private createEmptyMetrics(variant: ExplorationVariant): VariantMetrics {
    return {
      variantId: variant.id,
      variantName: variant.name,
      totalTrades: 0,
      openPositions: 0,
      wins: 0,
      losses: 0,
      timeStops: 0,
      winRate: 0,
      totalPnlUsdc: 0,
      avgPnlUsdc: 0,
      maxDrawdown: 0,
      bestTrade: -Infinity,
      worstTrade: Infinity,
      avgHoldingTimeMs: 0,
      lastUpdated: Date.now(),
    };
  }

  private countVariantPositions(variantId: string): number {
    return Array.from(this.openPositions.values())
      .filter(p => p.variantId === variantId).length;
  }

  private createVariantPosition(
    signal: SniperSignal,
    variant: ExplorationVariant,
    entryPrice: bigint,
    signalSource: 'micro-cap' | 'established',
    pairId?: string,
  ): VariantPosition {
    const tradeSize = BigInt(Math.round(variant.tradeSizeUsdc * 1_000_000));
    
    // FIX CRÍTICO: Lógica de TP/SL INVERTIDA
    // entryPrice = "cuántos TOKENS recibes por X USDC"
    // Token SUBE de valor → recibes MENOS tokens → takeProfit debe ser MENOR
    // Token BAJA de valor → recibes MÁS tokens → stopLoss debe ser MAYOR
    const takeProfit = (entryPrice * BigInt(100 - variant.tpPct)) / 100n;  // MENOS tokens = UP
    const stopLoss = (entryPrice * BigInt(100 + variant.slPct)) / 100n;    // MÁS tokens = DOWN
    const timeStop = signal.ingestionTime + variant.timeStopMs;

    return {
      id: randomUUID(),
      signalId: signal.id,
      contractAddress: signal.contractAddress,
      entryPrice,
      takeProfit,
      stopLoss,
      timeStop,
      tradeSize,
      status: 'OPEN',
      openedAt: Date.now(),
      closedAt: null,
      exitPrice: null,
      pnlUsdc: null,
      variantId: variant.id,
      variantName: variant.name,
      signalSource,
      pairId,
      quoteFailCount: 0, // FIX: Initialize quote failure counter
    };
  }

  /**
   * Get all open positions.
   */
  getOpenPositions(): VariantPosition[] {
    return Array.from(this.openPositions.values());
  }

  /**
   * Get open positions for a specific variant.
   */
  getVariantPositions(variantId: string): VariantPosition[] {
    return Array.from(this.openPositions.values())
      .filter(p => p.variantId === variantId);
  }
}

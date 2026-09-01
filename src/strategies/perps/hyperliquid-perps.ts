/**
 * Hyperliquid Perpetuals Grid Trading Module
 *
 * Orchestrates the grid trading strategy on Hyperliquid DEX:
 *  1. Places a grid of buy/sell limit orders around the current mark price
 *  2. When a grid order fills, places a take-profit order in the opposite direction
 *  3. Monitors funding rates and closes positions if adversely funded
 *  4. Enforces stop-loss on total unrealized PnL
 *  5. Emergency close with strategy cooldown on critical failures
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5
 */

import { randomUUID } from 'node:crypto';

import { calculateGridLevels, calculateTakeProfitPrice } from './grid-strategy.js';
import type { GridConfig } from './grid-strategy.js';
import type {
  IHyperliquidApi,
  HyperliquidOrderResponse,
  HyperliquidPosition,
} from './hyperliquid-api.js';
import type { HyperliquidConfig } from '../../config/income-sustainability.config.js';
import type { HyperliquidOrdersRepository } from '../../state/repositories/hyperliquid-orders.repo.js';
import type { IStrategyTracker } from '../../intelligence/strategy-tracker.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** A grid order tracked by this module */
export interface GridOrder {
  /** Internal unique ID */
  id: string;
  /** Trading pair (e.g. "ETH-USD") */
  pair: string;
  /** Order side */
  side: 'buy' | 'sell';
  /** Limit price */
  price: number;
  /** Order size in base units */
  size: number;
  /** Order status */
  status: 'open' | 'filled' | 'cancelled';
  /** External order ID from Hyperliquid */
  externalOrderId: string | null;
  /** Whether this is a take-profit order */
  isTakeProfit: boolean;
}

/** Public interface for the Hyperliquid module */
export interface IHyperliquidModule {
  placeGrid(pair: string): Promise<GridOrder[]>;
  handleFill(order: GridOrder): Promise<GridOrder>;
  checkFundingRates(): Promise<{ closed: string[]; reason: string }>;
  emergencyClose(reason: string): Promise<void>;
  checkStopLoss(): Promise<{ triggered: boolean; totalLoss: bigint }>;
  getPositions(): Promise<HyperliquidPosition[]>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class HyperliquidPerpsModule implements IHyperliquidModule {
  constructor(
    private readonly api: IHyperliquidApi,
    private readonly config: HyperliquidConfig,
    private readonly repo: HyperliquidOrdersRepository,
    private readonly strategyTracker: IStrategyTracker,
    private readonly walletAddress: string,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Place Grid (Req 6.1)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Calculate and place a grid of limit orders around the current mark price.
   *
   * Steps:
   *  1. Fetch current mark price for the pair
   *  2. Calculate grid levels using the grid-strategy module
   *  3. Place each level as a limit order via the Hyperliquid API
   *  4. Persist each order in the database
   *
   * @param pair - Trading pair (e.g. "ETH-USD")
   * @returns Array of placed grid orders
   */
  async placeGrid(pair: string): Promise<GridOrder[]> {
    // Extract coin symbol from pair (e.g. "ETH-USD" → "ETH")
    const coin = pairToCoin(pair);

    // Get current mark price
    const [marketInfo] = await this.api.getMarketInfo([coin]);
    if (!marketInfo) {
      throw new Error(`Failed to fetch market info for ${coin}`);
    }

    const referencePrice = marketInfo.markPrice;

    // Build grid config
    const gridConfig: GridConfig = {
      referencePrice,
      gridSpacingBps: this.config.gridSpacingBps,
      numLevels: 5, // 5 levels above and below
      baseSize: this.calculateBaseSize(referencePrice),
      maxTotalMargin: this.config.maxMarginUsdc,
    };

    // Calculate grid levels
    const levels = calculateGridLevels(gridConfig);

    // Place each level as a limit order
    const orders: GridOrder[] = [];

    for (const level of levels) {
      const response = await this.api.placeOrder(this.walletAddress, {
        coin,
        isBuy: level.side === 'buy',
        limitPx: level.price,
        sz: level.size,
        orderType: 'Limit',
        reduceOnly: false,
      });

      const order: GridOrder = {
        id: randomUUID(),
        pair,
        side: level.side,
        price: level.price,
        size: level.size,
        status: response.status === 'filled' ? 'filled' : 'open',
        externalOrderId: response.orderId,
        isTakeProfit: false,
      };

      // Persist in database
      this.repo.insert({
        id: order.id,
        pair: order.pair,
        side: order.side,
        order_type: 'limit',
        price: order.price,
        size: order.size,
        margin_usdc: null,
        leverage: this.config.maxLeverage,
        status: order.status,
        external_order_id: order.externalOrderId,
      });

      orders.push(order);

      // If immediately filled, handle the fill
      if (response.status === 'filled') {
        await this.handleFill(order);
      }
    }

    // Record execution success
    this.strategyTracker.recordExecution('hyperliquid_perps', true);

    return orders;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Handle Fill — Place Take-Profit (Req 6.2)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * When a grid order fills, place a take-profit order in the opposite direction.
   *
   * For a buy fill → place a sell take-profit above the fill price.
   * For a sell fill → place a buy take-profit below the fill price.
   *
   * @param order - The filled grid order
   * @returns The newly placed take-profit order
   */
  async handleFill(order: GridOrder): Promise<GridOrder> {
    const coin = pairToCoin(order.pair);
    const tpSide: 'buy' | 'sell' = order.side === 'buy' ? 'sell' : 'buy';

    // Calculate take-profit price
    const tpPrice = calculateTakeProfitPrice(
      order.price,
      order.side,
      this.config.gridSpacingBps,
    );

    // Place take-profit limit order (reduce only)
    const response = await this.api.placeOrder(this.walletAddress, {
      coin,
      isBuy: tpSide === 'buy',
      limitPx: tpPrice,
      sz: order.size,
      orderType: 'Limit',
      reduceOnly: true,
    });

    const tpOrder: GridOrder = {
      id: randomUUID(),
      pair: order.pair,
      side: tpSide,
      price: tpPrice,
      size: order.size,
      status: response.status === 'filled' ? 'filled' : 'open',
      externalOrderId: response.orderId,
      isTakeProfit: true,
    };

    // Persist take-profit order
    this.repo.insert({
      id: tpOrder.id,
      pair: tpOrder.pair,
      side: tpOrder.side,
      order_type: 'take_profit',
      price: tpOrder.price,
      size: tpOrder.size,
      margin_usdc: null,
      leverage: this.config.maxLeverage,
      status: tpOrder.status,
      external_order_id: tpOrder.externalOrderId,
    });

    // Update original order status in DB
    this.repo.updateStatus(order.id, 'filled', {
      fill_price: order.price,
      filled_at: Date.now(),
    });

    // If TP was immediately filled, record the revenue
    if (response.status === 'filled') {
      this.recordTakeProfitRevenue(order.price, tpPrice, order.size, order.side);
    }

    return tpOrder;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Check Funding Rates (Req 6.3)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Monitor funding rates and close positions if adversely funded.
   *
   * Logic:
   *  - Positive funding rate → longs pay shorts (adverse for longs)
   *  - Negative funding rate → shorts pay longs (adverse for shorts)
   *  - If absolute rate exceeds threshold → close that position
   *
   * @returns List of closed positions and the reason
   */
  async checkFundingRates(): Promise<{ closed: string[]; reason: string }> {
    const fundingRates = await this.api.getFundingRates();
    const positions = await this.api.getPositions(this.walletAddress);
    const thresholdBps = this.config.fundingThresholdBps;

    const closed: string[] = [];

    for (const position of positions) {
      const funding = fundingRates.find(
        (f) => f.coin.toUpperCase() === position.coin.toUpperCase(),
      );
      if (!funding) continue;

      // Convert funding rate to bps (rate is already in decimal form, e.g. 0.0001 = 1 bps)
      const rateBps = Math.abs(funding.rate) * 10_000;

      // Check if funding is adverse to our position
      const isAdverse =
        (position.side === 'long' && funding.rate > 0) ||
        (position.side === 'short' && funding.rate < 0);

      if (isAdverse && rateBps >= thresholdBps) {
        // Close this position at market
        await this.api.placeOrder(this.walletAddress, {
          coin: position.coin,
          isBuy: position.side === 'short', // Buy to close short, sell to close long
          limitPx: position.markPrice, // Use mark price as limit for market-like execution
          sz: position.size,
          orderType: 'Market',
          reduceOnly: true,
        });

        closed.push(position.coin);
      }
    }

    const reason =
      closed.length > 0
        ? `Adverse funding rate exceeded ${thresholdBps} bps threshold`
        : 'All funding rates within acceptable range';

    return { closed, reason };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Emergency Close (Req 6.4)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Emergency shutdown: cancel all orders, close all positions, disable strategy.
   *
   * Steps:
   *  1. Cancel all open orders on Hyperliquid
   *  2. Close all open positions at market price
   *  3. Mark all DB orders as cancelled
   *  4. Record execution failure
   *  5. Disable the strategy with cooldown via strategy tracker
   *
   * @param reason - Human-readable reason for the emergency close
   */
  async emergencyClose(reason: string): Promise<void> {
    // 1. Cancel all open orders on the exchange
    await this.api.cancelAllOrders(this.walletAddress);

    // 2. Close all open positions at market
    const positions = await this.api.getPositions(this.walletAddress);

    for (const position of positions) {
      await this.api.placeOrder(this.walletAddress, {
        coin: position.coin,
        isBuy: position.side === 'short',
        limitPx: position.markPrice,
        sz: position.size,
        orderType: 'Market',
        reduceOnly: true,
      });
    }

    // 3. Mark all open DB orders as cancelled
    const openOrders = this.repo.getOpen();
    const now = Date.now();
    for (const dbOrder of openOrders) {
      this.repo.updateStatus(dbOrder.id, 'cancelled', {
        cancelled_at: now,
      });
    }

    // 4. Record execution failure
    this.strategyTracker.recordExecution('hyperliquid_perps', false);

    // 5. Record cost if there was unrealized loss
    const totalLoss = positions.reduce((sum, p) => {
      return p.unrealizedPnl < 0 ? sum + Math.abs(p.unrealizedPnl) : sum;
    }, 0);

    if (totalLoss > 0) {
      // Convert USD to USDC 6-decimal representation
      const lossUsdc = BigInt(Math.round(totalLoss * 1_000_000));
      this.strategyTracker.recordCost('hyperliquid_perps', lossUsdc, `emergency_close:${reason}`);
    }

    // Strategy tracker's evaluateAndDisable will handle cooldown on next tick
    // We record a failure which contributes to consecutive loss days
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stop-Loss Check (Req 6.5)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check total unrealized PnL across all positions.
   * If the total loss exceeds the configured stop-loss threshold,
   * trigger an emergency close.
   *
   * @returns Whether stop-loss was triggered and the total loss amount
   */
  async checkStopLoss(): Promise<{ triggered: boolean; totalLoss: bigint }> {
    const positions = await this.api.getPositions(this.walletAddress);

    // Sum unrealized PnL (negative values = losses)
    const totalUnrealizedPnl = positions.reduce(
      (sum, p) => sum + p.unrealizedPnl,
      0,
    );

    // Convert to USDC 6 decimals (negative = loss, so negate for positive loss amount)
    const totalLossUsdc =
      totalUnrealizedPnl < 0
        ? BigInt(Math.round(Math.abs(totalUnrealizedPnl) * 1_000_000))
        : 0n;

    const triggered = totalLossUsdc >= this.config.stopLossUsdc;

    if (triggered) {
      await this.emergencyClose(
        `Stop-loss triggered: unrealized loss $${(Number(totalLossUsdc) / 1_000_000).toFixed(2)} exceeds threshold`,
      );
    }

    return { triggered, totalLoss: totalLossUsdc };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Get Positions (delegated to API)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get all open positions for the configured wallet.
   */
  async getPositions(): Promise<HyperliquidPosition[]> {
    return this.api.getPositions(this.walletAddress);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calculate the base order size given a reference price and max margin.
   * Ensures the total grid doesn't exceed max margin allocation.
   *
   * Formula: baseSize = (maxMarginUsdc / (numLevels × 2)) / (referencePrice × leverage)
   * This distributes margin evenly across all grid levels.
   */
  private calculateBaseSize(referencePrice: number): number {
    const numLevels = 5; // 5 levels each side
    const totalOrders = numLevels * 2;
    const maxMarginUsd = Number(this.config.maxMarginUsdc) / 1_000_000;
    const marginPerOrder = maxMarginUsd / totalOrders;
    const leverage = this.config.maxLeverage;

    // Size in base units = margin × leverage / price
    const size = (marginPerOrder * leverage) / referencePrice;

    // Round to reasonable precision (4 decimal places for most assets)
    return Number(size.toFixed(4));
  }

  /**
   * Record revenue from a completed take-profit trade.
   */
  private recordTakeProfitRevenue(
    entryPrice: number,
    exitPrice: number,
    size: number,
    entrySide: 'buy' | 'sell',
  ): void {
    let profitUsd: number;

    if (entrySide === 'buy') {
      // Bought at entryPrice, sold at exitPrice
      profitUsd = (exitPrice - entryPrice) * size;
    } else {
      // Sold at entryPrice, bought back at exitPrice
      profitUsd = (entryPrice - exitPrice) * size;
    }

    if (profitUsd > 0) {
      const profitUsdc = BigInt(Math.round(profitUsd * 1_000_000));
      this.strategyTracker.recordRevenue('hyperliquid_perps', profitUsdc);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Convert a trading pair like "ETH-USD" to the coin symbol "ETH".
 */
function pairToCoin(pair: string): string {
  const parts = pair.split('-');
  if (!parts[0]) {
    throw new Error(`Invalid pair format: ${pair}`);
  }
  return parts[0].toUpperCase();
}

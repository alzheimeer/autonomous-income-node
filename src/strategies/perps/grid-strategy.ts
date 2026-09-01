/**
 * Grid Trading Strategy — Level Calculator
 *
 * Generates buy/sell grid levels around a reference price for the
 * Hyperliquid perpetuals grid-trading module.
 *
 * Grid mechanics:
 *  - Buy orders are placed BELOW the reference price
 *  - Sell orders are placed ABOVE the reference price
 *  - Spacing between levels is expressed in basis points (1 bps = 0.01%)
 *  - Take-profit targets mirror the grid spacing in the opposite direction
 *
 * Requirements: 6.1, 6.2
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

/** A single grid level representing a pending order */
export interface GridLevel {
  /** Limit price for this grid level */
  price: number;
  /** Order side: buy below reference, sell above reference */
  side: 'buy' | 'sell';
  /** Order size in base asset units */
  size: number;
}

/** Configuration for grid level generation */
export interface GridConfig {
  /** Mid-price around which the grid is centered */
  referencePrice: number;
  /** Spacing between grid levels in basis points (e.g. 50 = 0.5%) */
  gridSpacingBps: number;
  /** Number of levels above AND below the reference price */
  numLevels: number;
  /** Size per order in base asset units */
  baseSize: number;
  /** Maximum total margin in USDC (6 decimals) — used as a safety cap */
  maxTotalMargin: bigint;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Grid Level Calculation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate grid levels around a reference price.
 *
 * Generates `numLevels` buy orders below the reference and
 * `numLevels` sell orders above. Each level is spaced by
 * `gridSpacingBps` basis points from the previous.
 *
 * Formula per level:
 *   Buy:  price = referencePrice × (1 - level × gridSpacingBps / 10000)
 *   Sell: price = referencePrice × (1 + level × gridSpacingBps / 10000)
 *
 * Levels are numbered 1..numLevels (level 0 would be the reference itself).
 *
 * @param config - Grid configuration parameters
 * @returns Array of grid levels (buy levels first, then sell levels)
 */
export function calculateGridLevels(config: GridConfig): GridLevel[] {
  const { referencePrice, gridSpacingBps, numLevels, baseSize } = config;

  if (referencePrice <= 0) {
    throw new Error('referencePrice must be positive');
  }
  if (gridSpacingBps <= 0) {
    throw new Error('gridSpacingBps must be positive');
  }
  if (numLevels <= 0) {
    throw new Error('numLevels must be positive');
  }
  if (baseSize <= 0) {
    throw new Error('baseSize must be positive');
  }

  const levels: GridLevel[] = [];

  // Generate buy levels below the reference price
  for (let i = 1; i <= numLevels; i++) {
    const multiplier = 1 - (i * gridSpacingBps) / 10_000;
    const price = referencePrice * multiplier;

    levels.push({
      price: roundPrice(price),
      side: 'buy',
      size: baseSize,
    });
  }

  // Generate sell levels above the reference price
  for (let i = 1; i <= numLevels; i++) {
    const multiplier = 1 + (i * gridSpacingBps) / 10_000;
    const price = referencePrice * multiplier;

    levels.push({
      price: roundPrice(price),
      side: 'sell',
      size: baseSize,
    });
  }

  return levels;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Take-Profit Calculation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Calculate the take-profit price for a filled grid order.
 *
 * When a buy order fills, the take-profit is placed ABOVE the fill price.
 * When a sell order fills, the take-profit is placed BELOW the fill price.
 *
 * Formula:
 *   Buy fill:  TP = fillPrice × (1 + spacingBps / 10000)
 *   Sell fill: TP = fillPrice × (1 - spacingBps / 10000)
 *
 * @param fillPrice - The price at which the original order was filled
 * @param side - The side of the original filled order
 * @param spacingBps - Grid spacing in basis points (used as profit target)
 * @returns The take-profit price
 */
export function calculateTakeProfitPrice(
  fillPrice: number,
  side: 'buy' | 'sell',
  spacingBps: number,
): number {
  if (fillPrice <= 0) {
    throw new Error('fillPrice must be positive');
  }
  if (spacingBps <= 0) {
    throw new Error('spacingBps must be positive');
  }

  if (side === 'buy') {
    // Buy filled → take profit above (sell to close)
    return roundPrice(fillPrice * (1 + spacingBps / 10_000));
  }

  // Sell filled → take profit below (buy to close)
  return roundPrice(fillPrice * (1 - spacingBps / 10_000));
}

// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Round a price to 6 significant decimal places to avoid
 * floating-point noise in limit order prices.
 */
function roundPrice(price: number): number {
  // For prices >= 1, round to 2 decimal places
  // For prices < 1, use up to 6 decimal places
  const decimals = price >= 1 ? 2 : 6;
  return Number(price.toFixed(decimals));
}

/**
 * VerdictEngine — Determines backtesting viability verdict from computed metrics.
 *
 * Evaluates 5 ordered rules (first match wins):
 * 1. INSUFFICIENT_DATA — fewer than 10 trades
 * 2. NEGATIVE_EXPECTANCY — average P&L per trade is negative
 * 3. BREAKEVEN — profit factor < 1.2
 * 4. POSITIVE_EXPECTANCY — profit factor >= 1.2 AND max drawdown <= 30%
 * 5. PROMISING_BUT_NEEDS_SHADOW — profit factor >= 1.2 but drawdown > 30%
 *
 * Requirements: 14.1, 14.2, 14.3
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/** Minimum metrics shape needed for verdict computation */
export interface VerdictMetricsInput {
  totalTrades: number;
  avgPnlPerTrade: bigint;
  profitFactor: number;
  maxDrawdownPct: number;
}

export type Verdict =
  | 'INSUFFICIENT_DATA'
  | 'NEGATIVE_EXPECTANCY'
  | 'BREAKEVEN'
  | 'POSITIVE_EXPECTANCY'
  | 'PROMISING_BUT_NEEDS_SHADOW';

export interface VerdictResult {
  verdict: Verdict;
  rationale: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// VerdictEngine
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Computes a viability verdict from backtest metrics.
 * Rules are evaluated in strict order — first matching rule wins.
 */
export function computeVerdict(metrics: VerdictMetricsInput): VerdictResult {
  // Rule 1: Insufficient data (< 10 trades)
  if (metrics.totalTrades < 10) {
    return {
      verdict: 'INSUFFICIENT_DATA',
      rationale: `Only ${metrics.totalTrades} trades (minimum 10 required)`,
    };
  }

  // Rule 2: Negative expectancy (avg P&L per trade < 0)
  if (metrics.avgPnlPerTrade < 0n) {
    return {
      verdict: 'NEGATIVE_EXPECTANCY',
      rationale: `Average P&L per trade is negative (${formatUsdc(metrics.avgPnlPerTrade)})`,
    };
  }

  // Rule 3: Breakeven (profit factor < 1.2)
  if (metrics.profitFactor < 1.2) {
    return {
      verdict: 'BREAKEVEN',
      rationale: `Profit factor ${metrics.profitFactor.toFixed(2)} < 1.2 threshold`,
    };
  }

  // Rule 4: Positive expectancy (PF >= 1.2 AND max DD <= 30%)
  if (metrics.maxDrawdownPct <= 30) {
    return {
      verdict: 'POSITIVE_EXPECTANCY',
      rationale: `PF ${metrics.profitFactor.toFixed(2)} with max drawdown ${metrics.maxDrawdownPct.toFixed(1)}% (≤ 30%)`,
    };
  }

  // Rule 5: Promising but needs shadow (PF >= 1.2, DD > 30%)
  return {
    verdict: 'PROMISING_BUT_NEEDS_SHADOW',
    rationale: `PF ${metrics.profitFactor.toFixed(2)} but max drawdown ${metrics.maxDrawdownPct.toFixed(1)}% exceeds 30% limit`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Format a USDC BigInt (6 decimals) as a human-readable string */
function formatUsdc(amount: bigint): string {
  const isNegative = amount < 0n;
  const abs = isNegative ? -amount : amount;
  const dollars = abs / 1_000_000n;
  const cents = abs % 1_000_000n;
  const sign = isNegative ? '-' : '';
  return `${sign}$${dollars}.${cents.toString().padStart(6, '0').slice(0, 2)}`;
}

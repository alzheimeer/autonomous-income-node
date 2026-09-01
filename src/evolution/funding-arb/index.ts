/**
 * Funding Arbitrage Backtest — CLI Entry Point & Barrel Export
 *
 * Entry: pnpm backtest:funding --coins ETH,BTC --days 90 --capitals 99,200,500,1000,2000
 *
 * Flow:
 *   1. Parse CLI args (process.argv)
 *   2. Determine coin universe (auto-select OI > $10M or --coins override)
 *   3. For each coin: fetch funding + prices → simulate both scenarios → optimize bankroll
 *   4. Store results in FundingDatabase
 *   5. Register in Strategy Registry (EvolutionDatabase)
 *   6. Print summary table to stdout
 *
 * Requirements: 2.1, 2.2, 2.3, 2.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */

import axios from 'axios';
import { randomUUID } from 'node:crypto';

// ═══════════════════════════════════════════════════════════════════════════
// Barrel Exports — re-export all public interfaces from submodules
// ═══════════════════════════════════════════════════════════════════════════

export { FundingDatabase } from './database.js';
export type { FundingRateRow, BacktestResultRow } from './database.js';

export { FundingDataFetcher } from './data-fetcher.js';
export type { FundingRateRecord, FetchOptions } from './data-fetcher.js';

export { PriceDataFetcher } from './price-fetcher.js';

export {
  FundingArbCostModel,
  OPTIMISTIC_SCENARIO,
  PESSIMISTIC_SCENARIO,
} from './cost-model.js';
export type {
  CostScenario,
  OpenPositionCosts,
  ClosePositionCosts,
  RebalanceCosts,
} from './cost-model.js';

export { LiquidationModel } from './liquidation-model.js';
export type { MarginState, LiquidationEvent } from './liquidation-model.js';

export { FundingArbSimulator, BPS_DIVISOR, RATE_PRECISION, ONE_USDC } from './simulator.js';
export type { SimulatorConfig, SimulationStep, SimulationResult } from './simulator.js';

export { BankrollOptimizer } from './bankroll-optimizer.js';
export type { CapitalEvaluation, OptimizationResult } from './bankroll-optimizer.js';

export {
  registerFundingArbResult,
  buildBacktestMetadata,
  FUNDING_ARB_STRATEGY_ID,
} from './strategy-integration.js';
export type { BacktestMetadata, FundingArbEvidence } from './strategy-integration.js';

// ═══════════════════════════════════════════════════════════════════════════
// Internal imports for CLI execution
// ═══════════════════════════════════════════════════════════════════════════

import { FundingDatabase } from './database.js';
import { FundingDataFetcher } from './data-fetcher.js';
import { PriceDataFetcher } from './price-fetcher.js';
import {
  FundingArbCostModel,
  OPTIMISTIC_SCENARIO,
  PESSIMISTIC_SCENARIO,
} from './cost-model.js';
import type { CostScenario } from './cost-model.js';
import { LiquidationModel } from './liquidation-model.js';
import { FundingArbSimulator } from './simulator.js';
import type { SimulatorConfig } from './simulator.js';
import { BankrollOptimizer } from './bankroll-optimizer.js';
import type { OptimizationResult } from './bankroll-optimizer.js';
import { registerFundingArbResult, buildBacktestMetadata } from './strategy-integration.js';
import { EvolutionDatabase } from '../evolution-database.js';

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const HYPERLIQUID_INFO_URL = 'https://api.hyperliquid.xyz/info';
const OI_THRESHOLD_USD = 10_000_000; // $10M
const ONE_USDC_NUM = 1_000_000;
const DEFAULT_DAYS = 90;
const MAX_DAYS = 365;
const DEFAULT_CAPITALS = [99n, 200n, 500n, 1000n, 2000n];

/** Default simulator config (per design spec) */
const DEFAULT_SIM_CONFIG: Omit<SimulatorConfig, 'capitalUsdc' | 'costScenario'> = {
  positionSizeFraction: 80n,
  rebalanceTriggerMarginBps: 1250n,
  rebalanceTriggerDivergeBps: 500n,
  aaveApyBps: 500n,         // 5% APY
  holguraBps: 100n,         // 1% safety margin
};

// ═══════════════════════════════════════════════════════════════════════════
// CLI Arg Parsing
// ═══════════════════════════════════════════════════════════════════════════

interface CliArgs {
  coins: string[] | null;   // null = auto-select
  days: number;
  capitals: bigint[];
}

function printUsage(): void {
  console.log(`
Usage: pnpm backtest:funding [options]

Options:
  --coins <COIN1,COIN2,...>   Coins to backtest (comma-separated, uppercase)
                              If omitted, auto-selects coins with OI > $10M
  --days <number|max>         Number of days to simulate (default: 90, max: 365)
                              Use "max" for 365 days
  --capitals <N1,N2,...>      Capital levels in USD (comma-separated)
                              Default: 99,200,500,1000,2000
  --help                      Show this help message

Examples:
  pnpm backtest:funding --coins ETH,BTC --days 90 --capitals 500,1000,2000
  pnpm backtest:funding --days max
  pnpm backtest:funding --coins SOL
`);
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2); // skip node and script path

  // Check for --help
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return null;
  }

  let coins: string[] | null = null;
  let days: number = DEFAULT_DAYS;
  let capitals: bigint[] = DEFAULT_CAPITALS;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--coins') {
      const value = args[++i];
      if (!value || value.startsWith('--')) {
        console.error('Error: --coins requires a comma-separated list of coin symbols');
        return null;
      }
      coins = value.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
      if (coins.length === 0) {
        console.error('Error: --coins list is empty');
        return null;
      }
    } else if (arg === '--days') {
      const value = args[++i];
      if (!value || value.startsWith('--')) {
        console.error('Error: --days requires a number or "max"');
        return null;
      }
      if (value.toLowerCase() === 'max') {
        days = MAX_DAYS;
      } else {
        days = parseInt(value, 10);
        if (isNaN(days) || days <= 0 || days > MAX_DAYS) {
          console.error(`Error: --days must be a number between 1 and ${MAX_DAYS}`);
          return null;
        }
      }
    } else if (arg === '--capitals') {
      const value = args[++i];
      if (!value || value.startsWith('--')) {
        console.error('Error: --capitals requires a comma-separated list of numbers');
        return null;
      }
      const parsed = value.split(',').map((c) => c.trim()).filter(Boolean);
      const valid: bigint[] = [];
      for (const p of parsed) {
        const num = parseInt(p, 10);
        if (isNaN(num) || num <= 0) {
          console.error(`Error: invalid capital value "${p}" — must be a positive integer`);
          return null;
        }
        valid.push(BigInt(num));
      }
      if (valid.length === 0) {
        console.error('Error: --capitals list is empty');
        return null;
      }
      capitals = valid;
    } else if (arg?.startsWith('--')) {
      console.error(`Error: unknown option "${arg}"`);
      printUsage();
      return null;
    }
  }

  return { coins, days, capitals };
}

// ═══════════════════════════════════════════════════════════════════════════
// Auto Coin Universe Selection
// ═══════════════════════════════════════════════════════════════════════════

interface HyperliquidAssetCtx {
  dayNtlVlm: string;
  funding: string;
  impactPxs: string[];
  markPx: string;
  midPx: string;
  openInterest: string;
  oraclePx: string;
  premium: string;
  prevDayPx: string;
}

interface HyperliquidMeta {
  universe: Array<{
    name: string;
    szDecimals: number;
    maxLeverage: number;
  }>;
}

/**
 * Query Hyperliquid for markets with OI > $10M.
 * POST to https://api.hyperliquid.xyz/info with { "type": "metaAndAssetCtxs" }
 */
async function fetchCoinUniverse(): Promise<string[]> {
  console.log('[Auto-Select] Querying Hyperliquid for coin universe (OI > $10M)...');

  try {
    const response = await axios.post<[HyperliquidMeta, HyperliquidAssetCtx[]]>(
      HYPERLIQUID_INFO_URL,
      { type: 'metaAndAssetCtxs' },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30_000 },
    );

    const [meta, assetCtxs] = response.data;

    if (!meta?.universe || !Array.isArray(assetCtxs)) {
      console.error('[Auto-Select] Unexpected API response format');
      return [];
    }

    const eligibleCoins: string[] = [];

    for (let i = 0; i < meta.universe.length && i < assetCtxs.length; i++) {
      const coin = meta.universe[i]!;
      const ctx = assetCtxs[i]!;

      // OI is in units of the asset — need to multiply by mark price for USD value
      const oiUnits = parseFloat(ctx.openInterest);
      const markPrice = parseFloat(ctx.markPx);
      const oiUsd = oiUnits * markPrice;

      if (oiUsd > OI_THRESHOLD_USD) {
        eligibleCoins.push(coin.name);
      }
    }

    console.log(`[Auto-Select] Found ${eligibleCoins.length} coins with OI > $10M: ${eligibleCoins.join(', ')}`);
    return eligibleCoins;
  } catch (err) {
    console.error('[Auto-Select] Failed to query Hyperliquid:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Summary Table Printing
// ═══════════════════════════════════════════════════════════════════════════

interface TableRow {
  coin: string;
  capital: string;
  netPnl: string;
  alpha: string;
  drawdown: string;
  verdict: string;
}

function formatUsdc(value: bigint): string {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  const dollars = abs / BigInt(ONE_USDC_NUM);
  const cents = abs % BigInt(ONE_USDC_NUM);
  const centsStr = cents.toString().padStart(6, '0').slice(0, 2);
  return `${sign}$${dollars}.${centsStr}`;
}

function formatBps(bps: bigint): string {
  // bps to percentage: bps / 100
  const pct = Number(bps) / 100;
  return `${pct.toFixed(1)}%`;
}

function printSummaryTable(rows: TableRow[]): void {
  if (rows.length === 0) {
    console.log('\nNo results to display.');
    return;
  }

  // Column widths
  const colW = { coin: 8, capital: 15, netPnl: 12, alpha: 12, dd: 7, verdict: 13 };

  const line = (ch: string, joints: string[]) => {
    const parts = [
      ch.repeat(colW.coin),
      ch.repeat(colW.capital),
      ch.repeat(colW.netPnl),
      ch.repeat(colW.alpha),
      ch.repeat(colW.dd),
      ch.repeat(colW.verdict),
    ];
    return `║${parts.map((p, i) => p).join(joints[0] || '║')}║`;
  };

  const topBorder    = `╔${'═'.repeat(colW.coin)}╦${'═'.repeat(colW.capital)}╦${'═'.repeat(colW.netPnl)}╦${'═'.repeat(colW.alpha)}╦${'═'.repeat(colW.dd)}╦${'═'.repeat(colW.verdict)}╗`;
  const midBorder    = `╠${'═'.repeat(colW.coin)}╬${'═'.repeat(colW.capital)}╬${'═'.repeat(colW.netPnl)}╬${'═'.repeat(colW.alpha)}╬${'═'.repeat(colW.dd)}╬${'═'.repeat(colW.verdict)}╣`;
  const bottomBorder = `╚${'═'.repeat(colW.coin)}╩${'═'.repeat(colW.capital)}╩${'═'.repeat(colW.netPnl)}╩${'═'.repeat(colW.alpha)}╩${'═'.repeat(colW.dd)}╩${'═'.repeat(colW.verdict)}╝`;

  const pad = (s: string, w: number) => (' ' + s).padEnd(w);
  const padR = (s: string, w: number) => (s + ' ').padStart(w);

  const headerRow = `║${pad('Coin', colW.coin)}║${pad('Capital', colW.capital)}║${pad('Net PnL', colW.netPnl)}║${pad('Alpha', colW.alpha)}║${pad('DD%', colW.dd)}║${pad('Verdict', colW.verdict)}║`;

  // Title
  const titleWidth = colW.coin + colW.capital + colW.netPnl + colW.alpha + colW.dd + colW.verdict + 5; // 5 for inner borders
  const title = '  Funding Arb Backtest Results  ';
  const titlePadded = title.padStart(Math.floor((titleWidth + title.length) / 2)).padEnd(titleWidth);
  const titleBorder = `╔${'═'.repeat(titleWidth)}╗`;
  const titleRow = `║${titlePadded}║`;
  const titleClose = `╠${'═'.repeat(colW.coin)}╦${'═'.repeat(colW.capital)}╦${'═'.repeat(colW.netPnl)}╦${'═'.repeat(colW.alpha)}╦${'═'.repeat(colW.dd)}╦${'═'.repeat(colW.verdict)}╣`;

  console.log('');
  console.log(titleBorder);
  console.log(titleRow);
  console.log(titleClose);
  console.log(headerRow);
  console.log(midBorder);

  for (const row of rows) {
    const r = `║${pad(row.coin, colW.coin)}║${pad(row.capital, colW.capital)}║${pad(row.netPnl, colW.netPnl)}║${pad(row.alpha, colW.alpha)}║${pad(row.drawdown, colW.dd)}║${pad(row.verdict, colW.verdict)}║`;
    console.log(r);
  }

  console.log(bottomBorder);
  console.log('');
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Entry Point
// ═══════════════════════════════════════════════════════════════════════════

export async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  Funding Arbitrage Backtest Engine');
  console.log('═══════════════════════════════════════════════════════════');

  // ─── Phase 1: Parse CLI args ─────────────────────────────────────────
  console.log('\n[Phase 1] Parsing CLI arguments...');
  const cliArgs = parseArgs(process.argv);
  if (!cliArgs) {
    process.exit(1);
  }

  const { days, capitals } = cliArgs;
  // Convert capitals from USD integers to 6-decimal BigInt USDC
  const capitalsBigInt = capitals.map((c) => c * BigInt(ONE_USDC_NUM));

  console.log(`  Days: ${days}`);
  console.log(`  Capitals: ${capitals.map((c) => `$${c}`).join(', ')}`);

  // ─── Phase 2: Determine coin universe ────────────────────────────────
  console.log('\n[Phase 2] Determining coin universe...');
  let coins: string[];

  if (cliArgs.coins) {
    coins = cliArgs.coins;
    console.log(`  Using override: ${coins.join(', ')}`);
  } else {
    coins = await fetchCoinUniverse();
    if (coins.length === 0) {
      console.error('Error: Could not determine coin universe. Use --coins to specify manually.');
      process.exit(1);
    }
  }

  // ─── Phase 3: Initialize infrastructure ──────────────────────────────
  console.log('\n[Phase 3] Initializing infrastructure...');
  const fundingDb = new FundingDatabase();
  const evolutionDb = new EvolutionDatabase();
  const dataFetcher = new FundingDataFetcher(fundingDb);
  const priceFetcher = new PriceDataFetcher();
  const liquidationModel = new LiquidationModel();

  const scenarios: CostScenario[] = [OPTIMISTIC_SCENARIO, PESSIMISTIC_SCENARIO];
  const runId = randomUUID();
  const createdAt = new Date().toISOString();

  console.log(`  Run ID: ${runId}`);
  console.log(`  Scenarios: optimistic, pessimistic`);

  // ─── Phase 4: Fetch data & run simulations ───────────────────────────
  console.log('\n[Phase 4] Running simulations...');

  const allResults: Map<string, OptimizationResult> = new Map();
  const tableRows: TableRow[] = [];

  const endTime = Date.now();
  const startTime = endTime - days * 86_400_000;

  for (const coin of coins) {
    console.log(`\n  ┌─ ${coin} ──────────────────────────────────────`);

    // Fetch funding rates
    console.log(`  │ Fetching funding rates...`);
    let fundingRates;
    try {
      fundingRates = await dataFetcher.fetchFundingRates({
        coin,
        startTime,
        endTime,
      });
    } catch (err) {
      console.log(`  │ ⚠ Failed to fetch funding rates: ${err instanceof Error ? err.message : String(err)}`);
      console.log(`  └─ Skipping ${coin}`);
      continue;
    }

    if (fundingRates.length === 0) {
      console.log(`  │ ⚠ No funding rate data available`);
      console.log(`  └─ Skipping ${coin}`);
      continue;
    }

    // Fetch spot prices
    console.log(`  │ Fetching spot prices...`);
    const prices = await priceFetcher.getHourlyPrices(coin, days);

    if (!prices || prices.length === 0) {
      console.log(`  │ ⚠ No price data available from Binance`);
      console.log(`  └─ Skipping ${coin}`);
      continue;
    }

    console.log(`  │ Data: ${fundingRates.length} funding rates, ${prices.length} price candles`);

    // Run both scenarios
    for (const scenario of scenarios) {
      console.log(`  │ Running ${scenario.name} scenario...`);

      const costModel = new FundingArbCostModel(scenario);

      const baseConfig: SimulatorConfig = {
        ...DEFAULT_SIM_CONFIG,
        capitalUsdc: 0n, // Will be overridden by optimizer
        costScenario: scenario,
      };

      const optimizer = new BankrollOptimizer(
        baseConfig,
        costModel,
        liquidationModel,
        DEFAULT_SIM_CONFIG.holguraBps,
        1500n, // 15% max drawdown threshold
      );

      const result = optimizer.evaluate(coin, capitalsBigInt, fundingRates, prices);

      // Store individual results in FundingDatabase
      for (const evaluation of result.evaluations) {
        fundingDb.insertBacktestResult({
          run_id: runId,
          created_at: createdAt,
          coin,
          capital_usdc: evaluation.capitalUsdc,
          net_pnl: evaluation.netPnl,
          gross_funding: 0n, // Summary-level — detailed info in simulator steps
          total_costs: 0n,
          alpha: evaluation.alpha,
          max_drawdown_bps: Number(evaluation.maxDrawdownBps),
          liquidation_count: evaluation.liquidationCount,
          stress_events: 0,
          hours_simulated: fundingRates.length,
          verdict: evaluation.viable ? 'VIABLE' : 'UNVIABLE',
          cost_scenario: scenario.name,
          evidence: JSON.stringify({ runId, coin, scenario: scenario.name }),
        });

        // Add row to summary table
        tableRows.push({
          coin,
          capital: `$${evaluation.capitalUsdc / BigInt(ONE_USDC_NUM)} (${scenario.name.slice(0, 3)})`,
          netPnl: formatUsdc(evaluation.netPnl),
          alpha: formatUsdc(evaluation.alpha),
          drawdown: formatBps(evaluation.maxDrawdownBps),
          verdict: evaluation.viable ? 'VIABLE' : 'UNVIABLE',
        });
      }

      // Track for overall aggregation (use pessimistic as the conservative default)
      if (scenario.name === 'pessimistic') {
        allResults.set(coin, result);
      }

      const minCap = result.minimumViableCapital;
      console.log(`  │   Verdict: ${result.overallVerdict} | Min capital: ${minCap ? `$${minCap / BigInt(ONE_USDC_NUM)}` : 'N/A'}`);
    }

    console.log(`  └─ ${coin} complete`);
  }

  // ─── Phase 5: Register in Strategy Registry ──────────────────────────
  console.log('\n[Phase 5] Registering results in Strategy Registry...');

  if (allResults.size > 0) {
    // Use pessimistic results for the overall registration
    const metadata = buildBacktestMetadata(allResults, days);

    // Determine overall verdict: VIABLE if any coin is viable
    const anyViable = [...allResults.values()].some((r) => r.overallVerdict === 'VIABLE');
    const overallResult: OptimizationResult = {
      evaluations: [...allResults.values()].flatMap((r) => r.evaluations),
      minimumViableCapital: [...allResults.values()]
        .filter((r) => r.minimumViableCapital !== null)
        .reduce<bigint | null>((min, r) => {
          if (min === null) return r.minimumViableCapital;
          return r.minimumViableCapital! < min ? r.minimumViableCapital : min;
        }, null),
      overallVerdict: anyViable ? 'VIABLE' : 'UNVIABLE',
    };

    registerFundingArbResult(evolutionDb, overallResult, metadata);
    console.log(`  Strategy registered: ${overallResult.overallVerdict}`);
  } else {
    console.log('  No results to register (all coins skipped).');
  }

  // ─── Phase 6: Print summary ──────────────────────────────────────────
  console.log('\n[Phase 6] Results summary');
  printSummaryTable(tableRows);

  // Cleanup
  fundingDb.close();
  evolutionDb.close();

  console.log('Done.');
}

// ═══════════════════════════════════════════════════════════════════════════
// Execute main() only when this file is the entry point
// ═══════════════════════════════════════════════════════════════════════════

const isDirectExecution = process.argv[1] &&
  (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')) ||
   import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` ||
   import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href);

if (isDirectExecution) {
  main().catch((err) => {
    console.error('Fatal error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

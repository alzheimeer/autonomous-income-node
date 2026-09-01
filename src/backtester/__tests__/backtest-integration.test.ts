/**
 * Integration test: minimal 7-day backtest
 *
 * This test validates the complete backtest pipeline:
 * 1. Mock Binance API responses with known deterministic candle data
 * 2. Run complete backtest pipeline (7 days)
 * 3. Verify all 4 output files generated with valid structure
 * 4. Verify results persisted to MetricsDatabase
 *
 * Uses in-memory SQLite to avoid test pollution.
 *
 * **Validates: Requirements 16.3, 16.4**
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBacktest, computeMetrics } from '../backtest-runner.js';
import type { BacktestConfig } from '../backtest-runner.js';
import { DEFAULT_COST_PARAMS } from '../backtest-cost-model.js';
import { DEFAULT_RISK_LIMITS } from '../backtest-simulator.js';
import { MetricsDatabase, createMetricsDatabase } from '../../pipeline-metrics/metrics-database.js';
import { persistBacktestResults } from '../index.js';
import type { CandleData } from '../../trading-validation/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Test Configuration
// ═══════════════════════════════════════════════════════════════════════════

const DAYS = 7;
const WARMUP_CANDLES = 200;

// Generate deterministic test candles for 7 days
function generateTestCandles(
  interval: '15m' | '1h',
  days: number,
  warmupCandles: number,
): CandleData[] {
  const intervalMs = interval === '1h' ? 3_600_000 : 900_000;
  const totalCandles = Math.ceil((days * 24 * 3_600_000) / intervalMs) + warmupCandles;
  const endTime = Date.now();
  const startTime = endTime - totalCandles * intervalMs;

  const candles: CandleData[] = [];
  let basePrice = 2000;

  for (let i = 0; i < totalCandles; i++) {
    const timestamp = startTime + i * intervalMs;
    
    // Create deterministic price movement pattern:
    // - Trending up for first half of each day
    // - Trending down for second half
    const hourOfDay = new Date(timestamp).getUTCHours();
    const priceChange = hourOfDay < 12 ? 0.002 : -0.002;
    
    // Add some volatility based on index
    const volatility = 0.01 * Math.sin(i * 0.1);
    
    const open = basePrice;
    const change = basePrice * (priceChange + volatility);
    const close = basePrice + change;
    const high = Math.max(open, close) * (1 + 0.005);
    const low = Math.min(open, close) * (1 - 0.005);
    const volume = 100_000 + (i % 100) * 1000;

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    });

    basePrice = close;
  }

  return candles;
}

// Strategy config that will generate signals with test data
const TEST_STRATEGY_CONFIG = {
  pair: 'WETH/USDC' as const,
  regimeTimeframe: '1h' as const,
  entryTimeframe: '15m' as const,
  stopLossAtr: 1.8,
  takeProfitAtr: 2.5,
  cooldownMs: 3_600_000, // 1 hour
  warmup1h: 26, // Minimum for MACD
  warmup15m: 26,
  meanRevAtrMax: 2.0,
  minLiquidity: 30000,
  volumeZThreshold: 0.5,
};

// ═══════════════════════════════════════════════════════════════════════════
// Mock Setup
// ═══════════════════════════════════════════════════════════════════════════

// Generate mock candle data
const mockCandles15m = generateTestCandles('15m', DAYS, WARMUP_CANDLES);
const mockCandles1h = generateTestCandles('1h', DAYS, WARMUP_CANDLES);

// Mock axios for Binance API
vi.mock('axios', () => {
  return {
    default: {
      get: vi.fn((url: string, config?: { params?: Record<string, unknown> }) => {
        if (url.includes('/api/v3/klines')) {
          const params = config?.params || {};
          const interval = params.interval as string;
          const startTime = params.startTime as number;
          const endTime = params.endTime as number;
          const limit = (params.limit as number) || 1000;

          const sourceCandles = interval === '1h' ? mockCandles1h : mockCandles15m;
          
          // Filter candles within the requested time range
          const filtered = sourceCandles.filter(
            c => c.timestamp >= startTime && c.timestamp < endTime
          );
          
          // Limit results
          const result = filtered.slice(0, limit);

          // Convert to Binance kline format
          const binanceFormat = result.map(c => [
            c.timestamp,
            c.open.toString(),
            c.high.toString(),
            c.low.toString(),
            c.close.toString(),
            c.volume.toString(),
            c.timestamp + (interval === '1h' ? 3_600_000 : 900_000) - 1, // closeTime
            '0', // quoteAssetVolume
            100, // numberOfTrades
            '0', // takerBuyBaseAssetVolume
            '0', // takerBuyQuoteAssetVolume
            '0', // ignore
          ]);

          return Promise.resolve({ data: binanceFormat });
        }
        return Promise.reject(new Error('Unknown URL'));
      }),
    },
  };
});

describe('Integration: 7-Day Backtest Pipeline', () => {
  let outputDir: string;
  let metricsDb: MetricsDatabase;

  beforeEach(() => {
    // Create unique temp directory for each test
    outputDir = join(tmpdir(), `backtest-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(outputDir, { recursive: true });

    // Create in-memory database
    metricsDb = createMetricsDatabase(':memory:');
  });

  afterEach(() => {
    // Clean up temp directory
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
    }

    // Close database
    metricsDb.close();

    // Clear mocks
    vi.clearAllMocks();
  });

  it('runs complete backtest pipeline and generates all output files', async () => {
    const config: BacktestConfig = {
      days: DAYS,
      outputDir,
      strategyConfig: TEST_STRATEGY_CONFIG,
      costParams: DEFAULT_COST_PARAMS,
      riskLimits: DEFAULT_RISK_LIMITS,
      warmupCandles: WARMUP_CANDLES,
    };

    // Run the backtest
    const startTime = Date.now();
    const result = await runBacktest(config);
    const durationMs = Date.now() - startTime;

    // ─────────────────────────────────────────────────────────────────────
    // Verify BacktestResult structure
    // ─────────────────────────────────────────────────────────────────────
    expect(result).toBeDefined();
    expect(result.trades).toBeDefined();
    expect(Array.isArray(result.trades)).toBe(true);
    expect(result.metrics).toBeDefined();
    expect(result.verdict).toBeDefined();
    expect(result.metadata).toBeDefined();
    expect(result.equityCurve).toBeDefined();

    // ─────────────────────────────────────────────────────────────────────
    // Verify report.json structure
    // ─────────────────────────────────────────────────────────────────────
    const reportJsonPath = join(outputDir, 'report.json');
    expect(existsSync(reportJsonPath)).toBe(true);

    const reportJson = JSON.parse(readFileSync(reportJsonPath, 'utf-8'));
    
    // Verify metadata section
    expect(reportJson.metadata).toBeDefined();
    expect(reportJson.metadata.startDate).toBeDefined();
    expect(reportJson.metadata.endDate).toBeDefined();
    expect(reportJson.metadata.daysSimulated).toBe(DAYS);
    expect(reportJson.metadata.candlesProcessed).toBeGreaterThan(0);
    expect(reportJson.metadata.costModelParams).toBeDefined();
    expect(reportJson.metadata.riskLimits).toBeDefined();
    expect(reportJson.metadata.strategyConfigHash).toBeDefined();
    expect(typeof reportJson.metadata.strategyConfigHash).toBe('string');
    expect(reportJson.metadata.strategyConfigHash.length).toBe(64); // SHA-256 hex

    // Verify metrics section
    expect(reportJson.metrics).toBeDefined();
    expect(typeof reportJson.metrics.totalTrades).toBe('number');
    expect(typeof reportJson.metrics.winRate).toBe('number');
    expect(reportJson.metrics.profitFactor !== undefined).toBe(true);
    expect(typeof reportJson.metrics.maxDrawdownPct).toBe('number');
    expect(reportJson.metrics.maxDrawdownUsdc).toBeDefined();
    expect(typeof reportJson.metrics.sharpeRatio).toBe('number');
    expect(typeof reportJson.metrics.avgTradeDurationMs).toBe('number');
    expect(reportJson.metrics.avgPnlPerTrade).toBeDefined();
    expect(reportJson.metrics.totalPnlUsdc).toBeDefined();
    expect(reportJson.metrics.buyAndHoldPnlUsdc).toBeDefined();

    // Verify verdict section
    expect(reportJson.verdict).toBeDefined();
    expect(reportJson.verdict.verdict).toBeDefined();
    expect([
      'INSUFFICIENT_DATA',
      'NEGATIVE_EXPECTANCY',
      'BREAKEVEN',
      'POSITIVE_EXPECTANCY',
      'PROMISING_BUT_NEEDS_SHADOW',
    ]).toContain(reportJson.verdict.verdict);
    expect(typeof reportJson.verdict.rationale).toBe('string');

    // Verify trades array
    expect(reportJson.trades).toBeDefined();
    expect(Array.isArray(reportJson.trades)).toBe(true);

    // If there are trades, verify trade structure
    if (reportJson.trades.length > 0) {
      const trade = reportJson.trades[0];
      expect(typeof trade.entryTime).toBe('number');
      expect(typeof trade.exitTime).toBe('number');
      expect(typeof trade.entryPrice).toBe('number');
      expect(typeof trade.exitPrice).toBe('number');
      expect(trade.sizeUsdc).toBeDefined();
      expect(trade.pnlUsdc).toBeDefined();
      expect(typeof trade.pnlBps).toBe('number');
      expect(typeof trade.strategy).toBe('string');
      expect(typeof trade.regime).toBe('string');
      expect(typeof trade.exitReason).toBe('string');
    }

    // ─────────────────────────────────────────────────────────────────────
    // Verify report.md structure
    // ─────────────────────────────────────────────────────────────────────
    const reportMdPath = join(outputDir, 'report.md');
    expect(existsSync(reportMdPath)).toBe(true);

    const reportMd = readFileSync(reportMdPath, 'utf-8');
    
    // Check for required sections
    expect(reportMd).toContain('# Backtest Report');
    expect(reportMd).toContain('**Verdict:');
    expect(reportMd).toContain('## Metadata');
    expect(reportMd).toContain('## Performance Metrics');
    expect(reportMd).toContain('## Trade Summary');
    
    // Check for metadata fields
    expect(reportMd).toContain('Start Date');
    expect(reportMd).toContain('End Date');
    expect(reportMd).toContain('Days Simulated');
    expect(reportMd).toContain('Candles Processed');
    
    // Check for metrics fields
    expect(reportMd).toContain('Total Trades');
    expect(reportMd).toContain('Win Rate');
    expect(reportMd).toContain('Profit Factor');
    expect(reportMd).toContain('Total P&L');

    // ─────────────────────────────────────────────────────────────────────
    // Verify trades.csv structure
    // ─────────────────────────────────────────────────────────────────────
    const tradesCsvPath = join(outputDir, 'trades.csv');
    expect(existsSync(tradesCsvPath)).toBe(true);

    const tradesCsv = readFileSync(tradesCsvPath, 'utf-8');
    const csvLines = tradesCsv.trim().split('\n');
    
    // Check header
    const expectedHeader = 'entry_time,exit_time,entry_price,exit_price,size_usdc,pnl_usdc,pnl_bps,strategy,regime,exit_reason';
    expect(csvLines[0]).toBe(expectedHeader);

    // If there are trades, verify CSV row structure
    if (csvLines.length > 1 && result.trades.length > 0) {
      const dataRow = csvLines[1]!.split(',');
      expect(dataRow.length).toBe(10); // 10 columns
      
      // Verify numeric fields are parseable
      expect(parseInt(dataRow[0]!, 10)).not.toBeNaN(); // entry_time
      expect(parseInt(dataRow[1]!, 10)).not.toBeNaN(); // exit_time
      expect(parseFloat(dataRow[2]!)).not.toBeNaN(); // entry_price
      expect(parseFloat(dataRow[3]!)).not.toBeNaN(); // exit_price
    }

    // ─────────────────────────────────────────────────────────────────────
    // Verify equity_curve.json structure
    // ─────────────────────────────────────────────────────────────────────
    const equityCurvePath = join(outputDir, 'equity_curve.json');
    expect(existsSync(equityCurvePath)).toBe(true);

    const equityCurve = JSON.parse(readFileSync(equityCurvePath, 'utf-8'));
    
    expect(Array.isArray(equityCurve)).toBe(true);
    expect(equityCurve.length).toBeGreaterThan(0);

    // Check equity curve point structure
    const firstPoint = equityCurve[0];
    expect(typeof firstPoint.timestamp).toBe('number');
    expect(firstPoint.portfolio_value_usdc).toBeDefined();

    // Verify equity curve has initial point
    // (BacktestSimulator records initial equity on construction)
    expect(equityCurve[0].portfolio_value_usdc).toBeDefined();
  }, 60_000); // 60s timeout for integration test

  it('persists backtest results to MetricsDatabase correctly', async () => {
    const config: BacktestConfig = {
      days: DAYS,
      outputDir,
      strategyConfig: TEST_STRATEGY_CONFIG,
      costParams: DEFAULT_COST_PARAMS,
      riskLimits: DEFAULT_RISK_LIMITS,
      warmupCandles: WARMUP_CANDLES,
    };

    // Run the backtest
    const startTime = Date.now();
    const result = await runBacktest(config);
    const durationMs = Date.now() - startTime;

    // Persist to database
    persistBacktestResults(metricsDb, result, durationMs);

    // ─────────────────────────────────────────────────────────────────────
    // Verify backtest_runs record created
    // ─────────────────────────────────────────────────────────────────────
    // Query the database directly using internal methods
    // Note: We access the db via querying backtest_trades which has run_id FK
    const trades = metricsDb.queryBacktestTrades({ limit: 1000 });
    
    // If there were trades, verify they're persisted
    if (result.trades.length > 0) {
      expect(trades.length).toBe(result.trades.length);
      
      // Verify trade record structure
      const dbTrade = trades[0]!;
      expect(typeof dbTrade.id).toBe('number');
      expect(typeof dbTrade.run_id).toBe('number');
      expect(dbTrade.run_id).toBeGreaterThan(0); // run was created
      expect(typeof dbTrade.entry_time).toBe('number');
      expect(typeof dbTrade.exit_time).toBe('number');
      expect(typeof dbTrade.entry_price).toBe('number');
      expect(typeof dbTrade.exit_price).toBe('number');
      expect(typeof dbTrade.size_usdc).toBe('string'); // BigInt stored as TEXT
      expect(typeof dbTrade.pnl_usdc).toBe('string'); // BigInt stored as TEXT
      expect(typeof dbTrade.strategy).toBe('string');
      expect(typeof dbTrade.regime).toBe('string');
      expect(typeof dbTrade.exit_reason).toBe('string');

      // Verify BigInt values can be parsed back
      expect(BigInt(dbTrade.size_usdc)).not.toBeNaN();
      expect(BigInt(dbTrade.pnl_usdc)).not.toBeNaN();
    }

    // ─────────────────────────────────────────────────────────────────────
    // Verify backtest_trades records match original results
    // ─────────────────────────────────────────────────────────────────────
    if (result.trades.length > 0) {
      // Find matching trade by entry_time
      const originalTrade = result.trades[0]!;
      const matchingDbTrade = trades.find(t => t.entry_time === originalTrade.entryTime);
      
      expect(matchingDbTrade).toBeDefined();
      if (matchingDbTrade) {
        expect(matchingDbTrade.exit_time).toBe(originalTrade.exitTime);
        expect(matchingDbTrade.entry_price).toBeCloseTo(originalTrade.entryPrice, 4);
        expect(matchingDbTrade.exit_price).toBeCloseTo(originalTrade.exitPrice, 4);
        expect(BigInt(matchingDbTrade.size_usdc)).toBe(originalTrade.sizeUsdc);
        expect(BigInt(matchingDbTrade.pnl_usdc)).toBe(originalTrade.pnlUsdc);
        expect(matchingDbTrade.strategy).toBe(originalTrade.strategy);
        expect(matchingDbTrade.regime).toBe(originalTrade.regime);
        expect(matchingDbTrade.exit_reason).toBe(originalTrade.exitReason);
      }
    }
  }, 60_000);

  it('handles backtest with no trades gracefully', async () => {
    // Create config with very restrictive settings that won't generate trades
    const restrictiveStrategyConfig = {
      ...TEST_STRATEGY_CONFIG,
      warmup1h: 1000, // Very high warmup - won't have enough candles
      warmup15m: 2000,
    };

    const config: BacktestConfig = {
      days: DAYS,
      outputDir,
      strategyConfig: restrictiveStrategyConfig,
      costParams: DEFAULT_COST_PARAMS,
      riskLimits: DEFAULT_RISK_LIMITS,
      warmupCandles: 50, // Lower warmup to ensure some candles are processed
    };

    const result = await runBacktest(config);

    // Should complete without errors
    expect(result).toBeDefined();
    expect(result.trades).toHaveLength(0);
    
    // Verdict should be INSUFFICIENT_DATA
    expect(result.verdict.verdict).toBe('INSUFFICIENT_DATA');

    // All files should still be generated
    expect(existsSync(join(outputDir, 'report.json'))).toBe(true);
    expect(existsSync(join(outputDir, 'report.md'))).toBe(true);
    expect(existsSync(join(outputDir, 'trades.csv'))).toBe(true);
    expect(existsSync(join(outputDir, 'equity_curve.json'))).toBe(true);

    // CSV should only have header
    const tradesCsv = readFileSync(join(outputDir, 'trades.csv'), 'utf-8');
    const csvLines = tradesCsv.trim().split('\n');
    expect(csvLines.length).toBe(1); // Just header

    // Equity curve should have at least initial point
    const equityCurve = JSON.parse(readFileSync(join(outputDir, 'equity_curve.json'), 'utf-8'));
    expect(equityCurve.length).toBeGreaterThan(0);
  }, 60_000);

  it('produces deterministic results with same input data', async () => {
    const config: BacktestConfig = {
      days: DAYS,
      outputDir,
      strategyConfig: TEST_STRATEGY_CONFIG,
      costParams: DEFAULT_COST_PARAMS,
      riskLimits: DEFAULT_RISK_LIMITS,
      warmupCandles: WARMUP_CANDLES,
    };

    // Run first backtest
    const result1 = await runBacktest(config);

    // Create second output directory
    const outputDir2 = join(tmpdir(), `backtest-test2-${Date.now()}`);
    mkdirSync(outputDir2, { recursive: true });

    try {
      // Run second backtest with same config
      const config2 = { ...config, outputDir: outputDir2 };
      const result2 = await runBacktest(config2);

      // Results should be identical
      expect(result1.trades.length).toBe(result2.trades.length);
      expect(result1.metrics.totalTrades).toBe(result2.metrics.totalTrades);
      expect(result1.metrics.winRate).toBe(result2.metrics.winRate);
      expect(result1.verdict.verdict).toBe(result2.verdict.verdict);

      // Compare individual trades
      for (let i = 0; i < result1.trades.length; i++) {
        const t1 = result1.trades[i]!;
        const t2 = result2.trades[i]!;
        expect(t1.entryTime).toBe(t2.entryTime);
        expect(t1.exitTime).toBe(t2.exitTime);
        expect(t1.entryPrice).toBe(t2.entryPrice);
        expect(t1.exitPrice).toBe(t2.exitPrice);
        expect(t1.sizeUsdc).toBe(t2.sizeUsdc);
        expect(t1.pnlUsdc).toBe(t2.pnlUsdc);
      }
    } finally {
      // Clean up second output directory
      if (existsSync(outputDir2)) {
        rmSync(outputDir2, { recursive: true, force: true });
      }
    }
  }, 120_000); // 2min timeout for two backtests

  it('validates cost model parameters are included in metadata', async () => {
    const customCostParams = {
      gasPerTxUsdc: 20_000n, // $0.02
      slippageBps: 40n,
      dexFeeBps: 10n,
      safetyMarginBps: 25n,
    };

    const config: BacktestConfig = {
      days: DAYS,
      outputDir,
      strategyConfig: TEST_STRATEGY_CONFIG,
      costParams: customCostParams,
      riskLimits: DEFAULT_RISK_LIMITS,
      warmupCandles: WARMUP_CANDLES,
    };

    const result = await runBacktest(config);

    // Verify cost params in metadata
    expect(result.metadata.costModelParams.gasPerTxUsdc).toBe(customCostParams.gasPerTxUsdc);
    expect(result.metadata.costModelParams.slippageBps).toBe(customCostParams.slippageBps);
    expect(result.metadata.costModelParams.dexFeeBps).toBe(customCostParams.dexFeeBps);
    expect(result.metadata.costModelParams.safetyMarginBps).toBe(customCostParams.safetyMarginBps);

    // Verify in report.json
    const reportJson = JSON.parse(readFileSync(join(outputDir, 'report.json'), 'utf-8'));
    expect(reportJson.metadata.costModelParams.gasPerTxUsdc).toBe('20000');
    expect(reportJson.metadata.costModelParams.slippageBps).toBe('40');
    expect(reportJson.metadata.costModelParams.dexFeeBps).toBe('10');
    expect(reportJson.metadata.costModelParams.safetyMarginBps).toBe('25');
  }, 60_000);

  it('validates risk limits are included in metadata', async () => {
    const customRiskLimits = {
      ...DEFAULT_RISK_LIMITS,
      maxTradesPerDay: 3,
      maxDailyLossUsdc: 2_000_000n, // $2
      cooldownMs: 1_800_000, // 30 min
    };

    const config: BacktestConfig = {
      days: DAYS,
      outputDir,
      strategyConfig: TEST_STRATEGY_CONFIG,
      costParams: DEFAULT_COST_PARAMS,
      riskLimits: customRiskLimits,
      warmupCandles: WARMUP_CANDLES,
    };

    const result = await runBacktest(config);

    // Verify risk limits in metadata
    expect(result.metadata.riskLimits.maxTradesPerDay).toBe(3);
    expect(result.metadata.riskLimits.maxDailyLossUsdc).toBe(2_000_000n);
    expect(result.metadata.riskLimits.cooldownMs).toBe(1_800_000);

    // Verify in report.json
    const reportJson = JSON.parse(readFileSync(join(outputDir, 'report.json'), 'utf-8'));
    expect(reportJson.metadata.riskLimits.maxTradesPerDay).toBe(3);
    expect(reportJson.metadata.riskLimits.maxDailyLossUsdc).toBe('2000000');
    expect(reportJson.metadata.riskLimits.cooldownMs).toBe(1_800_000);
  }, 60_000);
});

describe('Integration: MetricsDatabase Persistence', () => {
  let metricsDb: MetricsDatabase;

  beforeEach(() => {
    metricsDb = createMetricsDatabase(':memory:');
  });

  afterEach(() => {
    metricsDb.close();
  });

  it('stores monetary values as TEXT and recovers BigInt correctly', () => {
    // Insert a test trade directly
    const runId = metricsDb.insertBacktestRun(
      Date.now(),
      7,
      10,
      60.0,
      1.5,
      15.0,
      '123456789012345678', // Large BigInt as string
      'POSITIVE_EXPECTANCY',
      'abc123',
      1000,
    );

    expect(runId).toBeGreaterThan(0);

    // Insert a trade with BigInt values
    const tradeId = metricsDb.insertBacktestTrade(
      runId,
      Date.now() - 1000,
      Date.now(),
      2000.5,
      2050.75,
      '10000000', // $10 as BigInt string
      '500000', // $0.50 profit as BigInt string
      'trend_pullback',
      'TRENDING_UP',
      'take_profit',
    );

    expect(tradeId).toBeGreaterThan(0);

    // Query back and verify
    const trades = metricsDb.queryBacktestTrades({ runId });
    expect(trades.length).toBe(1);

    const trade = trades[0]!;
    expect(trade.size_usdc).toBe('10000000');
    expect(trade.pnl_usdc).toBe('500000');

    // Verify BigInt conversion
    const sizeUsdc = BigInt(trade.size_usdc);
    const pnlUsdc = BigInt(trade.pnl_usdc);
    expect(sizeUsdc).toBe(10_000_000n);
    expect(pnlUsdc).toBe(500_000n);
  });

  it('persists negative P&L values correctly', () => {
    const runId = metricsDb.insertBacktestRun(
      Date.now(),
      7,
      5,
      40.0,
      0.8,
      25.0,
      '-1500000', // Negative total P&L
      'NEGATIVE_EXPECTANCY',
      'def456',
      500,
    );

    metricsDb.insertBacktestTrade(
      runId,
      Date.now() - 1000,
      Date.now(),
      2000.0,
      1960.0,
      '10000000',
      '-400000', // -$0.40 loss
      'mean_reversion',
      'RANGING',
      'stop_loss',
    );

    const trades = metricsDb.queryBacktestTrades({ runId });
    expect(trades.length).toBe(1);

    const trade = trades[0]!;
    const pnlUsdc = BigInt(trade.pnl_usdc);
    expect(pnlUsdc).toBe(-400_000n);
    expect(pnlUsdc < 0n).toBe(true);
  });
});

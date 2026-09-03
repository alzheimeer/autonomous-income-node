# Funding Arbitrage Backtest Module

## Purpose

The funding-arb backtest module simulates a **delta-neutral funding rate arbitrage strategy**: long spot on a Base DEX + short perpetual on Hyperliquid for the same asset at the same notional size. The only P&L driver is the funding rate — directional price exposure cancels out.

The module evaluates historical profitability across multiple capital levels, accounting for realistic transaction costs, liquidation risk, and opportunity cost (Aave USDC APY as benchmark). It determines the minimum bankroll required for the strategy to be viable and integrates with the Strategy Registry for lifecycle management.

**Key characteristics:**
- Hour-by-hour simulation with strict no-lookahead constraint
- Two parallel cost scenarios (optimistic/pessimistic) per coin
- All monetary arithmetic uses BigInt (6-decimal USDC precision)
- No real trades, no secrets, no API keys required
- Data cached in SQLite for offline reproducibility

---

## Architecture

The module lives in `src/evolution/funding-arb/` with 8 submodules:

```
src/evolution/funding-arb/
├── database.ts            # FundingDatabase — SQLite at data/funding.db
├── data-fetcher.ts        # Hyperliquid funding rate history retrieval + caching
├── price-fetcher.ts       # Binance spot prices via existing CandleCache
├── cost-model.ts          # BigInt transaction cost computations (2 scenarios)
├── liquidation-model.ts   # Margin tracking, stress detection, forced closures
├── simulator.ts           # Hour-by-hour backtest engine
├── bankroll-optimizer.ts  # Minimum viable capital determination
├── index.ts               # Barrel exports + CLI entry point
└── api-route.ts           # Fastify GET /evolution/funding-arb
```

### Module Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI (index.ts)                            │
│  pnpm backtest:funding --coins ETH --days 90 --capitals 99,500  │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
┌─────────────────┐ ┌──────────────┐ ┌──────────────────┐
│  data-fetcher   │ │ price-fetcher│ │  api-route       │
│  (Hyperliquid)  │ │  (Binance)   │ │  GET /evolution/ │
└────────┬────────┘ └──────┬───────┘ │  funding-arb     │
         │                 │         └──────────────────┘
         ▼                 ▼
┌──────────────────────────────────────┐
│           FundingDatabase            │
│         data/funding.db              │
│  ┌──────────────┐ ┌───────────────┐ │
│  │funding_rates │ │backtest_results│ │
│  └──────────────┘ └───────────────┘ │
└────────────────────┬─────────────────┘
                     │
                     ▼
┌──────────────────────────────────────┐
│            Simulator                 │
│  Hour-by-hour loop (no lookahead)   │
│  ┌────────────┐  ┌────────────────┐ │
│  │ cost-model │  │liquidation-model│ │
│  └────────────┘  └────────────────┘ │
└────────────────────┬─────────────────┘
                     │
                     ▼
┌──────────────────────────────────────┐
│       Bankroll Optimizer             │
│  Min capital T: edge>0, no liq,     │
│  drawdown<15%                        │
└────────────────────┬─────────────────┘
                     │
                     ▼
┌──────────────────────────────────────┐
│     Strategy Registry Integration    │
│  DORMANT | ARCHIVED_BASELINE         │
└──────────────────────────────────────┘
```

### Submodule Responsibilities

| Submodule | Responsibility |
|-----------|---------------|
| `database.ts` | SQLite persistence (funding rates + backtest results), degraded mode fallback |
| `data-fetcher.ts` | Hyperliquid API pagination, caching, retry logic |
| `price-fetcher.ts` | Binance hourly OHLCV via CandleCache, symbol mapping |
| `cost-model.ts` | BigInt fee computation for open/close/rebalance (2 scenarios) |
| `liquidation-model.ts` | Margin ratio tracking, stress/liquidation detection, penalty computation |
| `simulator.ts` | Sequential hour-by-hour loop, position state machine, PnL tracking |
| `bankroll-optimizer.ts` | Evaluate capital levels against viability criteria, find minimum T |
| `index.ts` | CLI argument parsing, orchestration, barrel exports |
| `api-route.ts` | Fastify route registration, result serialization |

---

## Data Sources

### Hyperliquid — Funding Rate History

**Endpoint:** `POST https://api.hyperliquid.xyz/info`

**Request bodies:**

```json
// Funding rate history (paginated, up to 500 records per call)
{
  "type": "fundingHistory",
  "coin": "ETH",
  "startTime": 1700000000000
}

// Market metadata + open interest (for coin universe selection)
{
  "type": "metaAndAssetCtxs"
}
```

**Response format (fundingHistory):**
```json
[
  { "coin": "ETH", "fundingRate": "0.000125", "time": 1700000000000 },
  { "coin": "ETH", "fundingRate": "-0.000050", "time": 1700003600000 }
]
```

**Pagination:** Returns up to 500 records per call. Use the last record's timestamp as the next `startTime` to fetch subsequent pages.

**Error handling:** 3 retries with exponential backoff (1s, 2s, 4s). On failure, log and skip coin.

**Coin universe filter:** Only markets with open interest > $10M USD are selected.

### Binance — Spot Price Data

**Method:** Hourly OHLCV candles via the existing `CandleCache` infrastructure (reuses `binance-downloader.ts`).

**Symbol mapping:** Coin symbol → Binance pair (e.g., `ETH` → `ETHUSDC`, `BTC` → `BTCUSDC`).

**Caching:** Results stored in `data/candle-cache/` directory, automatically reused on subsequent runs.

**Fallback:** If Binance data is unavailable for a coin, that coin is excluded from simulation with a logged warning.

---

## Cost Model Parameters

All costs are computed in BigInt with 6-decimal USDC precision (`1_000_000n = $1.00`).

### Two Scenarios

| Parameter | Optimistic | Pessimistic |
|-----------|-----------|-------------|
| Bridge fee | $1 (`1_000_000n`) | $5 (`5_000_000n`) |
| DEX swap fee | 5 bps | 5 bps |
| Slippage | 20 bps | 30 bps |
| Perp taker fee | 0.035% | 0.035% |
| Gas per transaction | $0.01 (`10_000n`) | $0.01 (`10_000n`) |
| Rebalance fraction | 25% of round-trip | 25% of round-trip |

### Cost Formulas

```typescript
// Position Open:
bridge_fee   = scenario.bridgeCostUsdc                              // Fixed
dex_fee      = positionSize * scenario.dexFeeBps / 10_000n          // 5 bps
slippage     = positionSize * scenario.slippageBps / 10_000n        // 20 or 30 bps
perp_fee     = positionSize * 35n / 100_000n                        // 0.035%
gas          = scenario.gasPerTxUsdc * 2n                           // 2 txs (approve + swap)
open_total   = bridge_fee + dex_fee + slippage + perp_fee + gas

// Position Close:
dex_fee      = positionSize * scenario.dexFeeBps / 10_000n
slippage     = positionSize * scenario.slippageBps / 10_000n
perp_fee     = positionSize * 35n / 100_000n
gas          = scenario.gasPerTxUsdc * 2n
close_total  = dex_fee + slippage + perp_fee + gas

// Rebalance (when triggered):
round_trip   = open_total + close_total
rebalance    = round_trip * 25n / 100n
```

### Rebalance Triggers

Rebalancing occurs when (within an ACTIVE position):
1. **Margin utilization > 80%** — margin ratio drops below 1250 bps (12.5%)
2. **Basis drift > 5%** — spot/perp notional sizes diverge by more than 500 bps

---

## Liquidation Model

### Thresholds

| Parameter | Value | Description |
|-----------|-------|-------------|
| Maintenance margin | 6% (600 bps) | Forced closure trigger |
| Stress threshold | 10% (1000 bps) | Risk incident recording |
| Liquidation penalty | 0.5% of position value | Deducted on forced closure |

### Liquidation Math

```typescript
// Margin Ratio (in bps):
margin_ratio_bps = equity * 10_000n / positionValue

// Liquidation triggers when:
margin_ratio_bps < 600n    // Below 6% maintenance margin

// Stress event when:
margin_ratio_bps < 1000n   // Below 10% (but not yet liquidated)

// Maximum adverse move before liquidation (in bps):
max_adverse_bps = margin_ratio_bps - 600n

// Penalty on forced closure:
penalty = positionValue * 50n / 10_000n    // 0.5% of position
```

### Post-Liquidation State

After a forced closure:
1. Penalty deducted from equity
2. Position size set to `0n`
3. Event recorded in liquidation log

---

## CLI Usage

### Command

```bash
pnpm backtest:funding [options]
```

### Options

| Flag | Description | Example |
|------|-------------|---------|
| `--coins` | Comma-separated coin symbols (overrides auto-selection) | `--coins ETH,BTC` |
| `--days` | Backtest duration in days, or `max` for full history (up to 365) | `--days 90` |
| `--capitals` | Comma-separated capital amounts in USD | `--capitals 500,1000,2000` |
| `--help` | Print usage information | `--help` |

### Examples

```bash
# Backtest ETH and BTC over 90 days with three capital levels
pnpm backtest:funding --coins ETH,BTC --days 90 --capitals 500,1000,2000

# Full history for ETH with granular capital sweep
pnpm backtest:funding --days max --coins ETH --capitals 99,200,500,1000,2000

# Show help
pnpm backtest:funding --help
```

### Execution Flow

1. Parse CLI arguments (`process.argv`)
2. Determine coin universe (auto-select by OI, or `--coins` override)
3. For each coin:
   - Fetch/cache funding rates from Hyperliquid
   - Fetch/cache spot prices from Binance
   - For each cost scenario (optimistic, pessimistic):
     - Run simulator for each capital level
     - Bankroll optimizer determines minimum viable capital
4. Store results in `data/funding.db`
5. Register results in Strategy Registry (`data/evolution.db`)
6. Print summary table to stdout

---

## API Endpoint

### `GET /evolution/funding-arb`

Returns the latest backtest results from the database.

### Response Format

**Success (results available):**

```json
{
  "status": "ok",
  "results": {
    "runId": "run_2024-01-15T10:30:00Z",
    "timestamp": "2024-01-15T10:30:00.000Z",
    "coins": [
      {
        "coin": "ETH",
        "netPnl": "125000000",
        "alpha": "85000000",
        "maxDrawdownBps": 450,
        "liquidations": 0,
        "verdict": "VIABLE"
      }
    ],
    "optimalCapital": "1000000000",
    "overallVerdict": "VIABLE",
    "costScenario": "pessimistic"
  }
}
```

**No data available:**

```json
{
  "status": "no_data",
  "message": "No backtest results found. Run pnpm backtest:funding first."
}
```

### Integration

The route is registered on the Fastify HTTP server alongside other evolution endpoints. No authentication is required (internal use only).

---

## Strategy Registry Integration

After each backtest run, results are registered in the existing Strategy Registry (`src/evolution/strategy-registry.ts`).

### Verdict Mapping

| Backtest Verdict | Registry Status | Reason |
|-----------------|-----------------|--------|
| `VIABLE` (any capital passes) | `DORMANT` | Strategy has positive edge, awaiting activation |
| `UNVIABLE` (all capitals fail) | `ARCHIVED_BASELINE` | `NEGATIVE_EXPECTANCY` |

### Evidence Schema

The strategy record's `evidence` field contains:

```json
{
  "period": "90d",
  "coins": ["ETH", "BTC"],
  "optimal_capital": "1000",
  "alpha": "85.50",
  "max_drawdown": "4.5%"
}
```

### Viability Criteria

All three conditions must pass simultaneously for a capital level to be viable:

1. **Positive edge with safety margin:** `alpha > capital * holguraBps / 10_000n`
2. **Zero liquidations:** `liquidationCount === 0`
3. **Drawdown below threshold:** `maxDrawdownBps < 1500n` (15%)

The minimum viable capital (T) is the smallest tested amount satisfying all three criteria. If none passes, the strategy is `UNVIABLE`.

---

## BigInt Precision Convention

```typescript
const USDC_DECIMALS = 6n;
const ONE_USDC = 1_000_000n;                 // $1.00
const BPS_DIVISOR = 10_000n;                 // 1 bps = 1/10000
const RATE_PRECISION = 1_000_000_000_000n;   // 12 decimals for funding rate
```

All monetary values throughout the module use this convention. No floating-point arithmetic is used for financial calculations.

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Hyperliquid API error/timeout | Retry 3x (exponential backoff), then skip coin |
| Binance data unavailable | Exclude coin, log warning |
| Database inaccessible | Degraded mode: no-op writes, in-memory compute |
| Division by zero (BigInt) | Guard all divisions, return `0n` |
| Negative equity | Cap at `0n`, trigger forced closure |
| No viable capital found | Report `UNVIABLE`, register as `ARCHIVED_BASELINE` |
| Invalid CLI arguments | Print usage help, exit with code 1 |

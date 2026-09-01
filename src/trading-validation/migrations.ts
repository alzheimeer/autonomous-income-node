/**
 * Trading Validation Phase - Database Migrations
 *
 * Creates all tables for the trading validation system with idempotent
 * `IF NOT EXISTS` semantics. Includes all indexes from the design schema.
 *
 * BigInt values are stored as TEXT in SQLite and converted at read/write time.
 *
 * Requirements: 34.1, 28.1
 */

import type { TradingDatabase } from './db.js';

// ═══════════════════════════════════════════════════════════════════════════
// Table Definitions
// ═══════════════════════════════════════════════════════════════════════════

const CREATE_TRADING_PHASE = `
CREATE TABLE IF NOT EXISTS trading_phase (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode IN ('shadow', 'micro')),
  config_hash TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  safe_mode INTEGER NOT NULL DEFAULT 0,
  safe_mode_reason TEXT,
  safe_mode_since INTEGER,
  low_cost_mode INTEGER NOT NULL DEFAULT 0,
  kill_switch_triggered INTEGER NOT NULL DEFAULT 0,
  auto_lender_disabled INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);`;

const CREATE_BANKROLL = `
CREATE TABLE IF NOT EXISTS bankroll (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  total_usdc TEXT NOT NULL,
  active_usdc TEXT NOT NULL,
  reserve_usdc TEXT NOT NULL,
  daily_realized_pnl TEXT NOT NULL DEFAULT '0',
  daily_gas_spent TEXT NOT NULL DEFAULT '0',
  experiment_total_pnl TEXT NOT NULL DEFAULT '0',
  day_start_bankroll TEXT NOT NULL,
  day_utc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);`;

const CREATE_TX_INTENTS = `
CREATE TABLE IF NOT EXISTS tx_intents (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'created','approval_pending','approval_submitted',
    'swap_pending','confirmed','reverted','dropped','cancelled','replaced'
  )),
  nonce INTEGER NOT NULL,
  tx_hash TEXT,
  contract_address TEXT NOT NULL,
  function_name TEXT NOT NULL,
  gas_limit TEXT NOT NULL,
  max_fee_per_gas TEXT,
  max_priority_fee TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  block_number INTEGER,
  revert_reason TEXT,
  operation_type TEXT NOT NULL
);`;

const CREATE_POSITIONS = `
CREATE TABLE IF NOT EXISTS positions (
  id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES tx_intents(id),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'micro')),
  strategy TEXT NOT NULL CHECK (strategy IN ('trend_pullback', 'mean_reversion', 'momentum_breakout', 'dip_buying')),
  pair TEXT NOT NULL DEFAULT 'WETH/USDC',
  entry_price REAL NOT NULL,
  entry_timestamp INTEGER NOT NULL,
  size_usdc TEXT NOT NULL,
  size_weth TEXT NOT NULL,
  stop_loss REAL NOT NULL,
  take_profit REAL NOT NULL,
  max_holding_ms INTEGER NOT NULL,
  entry_regime TEXT NOT NULL,
  exit_reason TEXT,
  exit_price REAL,
  exit_timestamp INTEGER,
  gross_pnl TEXT,
  net_pnl TEXT,
  mfe REAL,
  mae REAL,
  gas_entry TEXT,
  gas_exit TEXT,
  config_hash TEXT NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);`;

const CREATE_QUOTES_LOG = `
CREATE TABLE IF NOT EXISTS quotes_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('entry', 'exit')),
  amount_in TEXT NOT NULL,
  amount_out TEXT NOT NULL,
  price_impact_bps REAL,
  gas_estimate TEXT,
  gas_usd REAL,
  timestamp INTEGER NOT NULL,
  selected INTEGER NOT NULL DEFAULT 0,
  reject_reason TEXT
);`;

const CREATE_RECONCILIATION_LOG = `
CREATE TABLE IF NOT EXISTS reconciliation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_type TEXT NOT NULL,
  intent_id TEXT REFERENCES tx_intents(id),
  expected_usdc TEXT NOT NULL,
  actual_usdc TEXT NOT NULL,
  expected_weth TEXT NOT NULL,
  actual_weth TEXT NOT NULL,
  deviation_usdc TEXT NOT NULL,
  gas_eth_spent TEXT,
  matched INTEGER NOT NULL,
  allowance_verified INTEGER,
  timestamp INTEGER NOT NULL
);`;

const CREATE_APPROVALS = `
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  spender TEXT NOT NULL,
  amount TEXT NOT NULL,
  tx_hash TEXT,
  timestamp INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);`;

const CREATE_DAILY_METRICS = `
CREATE TABLE IF NOT EXISTS daily_metrics (
  day_utc TEXT PRIMARY KEY,
  trades_count INTEGER NOT NULL DEFAULT 0,
  failed_tx_count INTEGER NOT NULL DEFAULT 0,
  evaluations_count INTEGER NOT NULL DEFAULT 0,
  signals_generated INTEGER NOT NULL DEFAULT 0,
  trades_rejected INTEGER NOT NULL DEFAULT 0,
  total_gas_usd TEXT NOT NULL DEFAULT '0',
  total_pnl TEXT NOT NULL DEFAULT '0',
  ai_cost_trading TEXT NOT NULL DEFAULT '0',
  ai_cost_services TEXT NOT NULL DEFAULT '0',
  ai_cost_diagnostics TEXT NOT NULL DEFAULT '0',
  safe_mode_events INTEGER NOT NULL DEFAULT 0,
  alerts_sent INTEGER NOT NULL DEFAULT 0
);`;

const CREATE_NONCE_REGISTRY = `
CREATE TABLE IF NOT EXISTS nonce_registry (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_confirmed_nonce INTEGER NOT NULL,
  next_nonce INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);`;

const CREATE_EVENT_LOG = `
CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  details TEXT NOT NULL,
  timestamp INTEGER NOT NULL
);`;

const CREATE_OPERATOR_COMMANDS = `
CREATE TABLE IF NOT EXISTS operator_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command TEXT NOT NULL,
  source TEXT NOT NULL,
  chat_id TEXT,
  authorized INTEGER NOT NULL,
  timestamp INTEGER NOT NULL
);`;

// ═══════════════════════════════════════════════════════════════════════════
// Index Definitions
// ═══════════════════════════════════════════════════════════════════════════

const CREATE_INDEXES = [
  // tx_intents: unique nonce for active intents
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_intents_nonce
   ON tx_intents(nonce) WHERE state NOT IN ('reverted','dropped','cancelled');`,

  // tx_intents: lookup by state for pending resolution
  `CREATE INDEX IF NOT EXISTS idx_tx_intents_state
   ON tx_intents(state);`,

  // positions: open positions lookup
  `CREATE INDEX IF NOT EXISTS idx_positions_open
   ON positions(closed) WHERE closed = 0;`,

  // positions: filter by mode and status
  `CREATE INDEX IF NOT EXISTS idx_positions_mode
   ON positions(mode, closed);`,

  // reconciliation_log: time-range queries
  `CREATE INDEX IF NOT EXISTS idx_reconciliation_timestamp
   ON reconciliation_log(timestamp);`,

  // event_log: type + timestamp for filtered queries
  `CREATE INDEX IF NOT EXISTS idx_event_log_type
   ON event_log(event_type, timestamp);`,
];

// ═══════════════════════════════════════════════════════════════════════════
// Migration Runner
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run all trading validation migrations.
 *
 * - Uses `IF NOT EXISTS` for idempotent re-runs.
 * - Runs PRAGMA integrity_check on startup.
 * - All DDL is wrapped in a transaction for atomicity.
 *
 * @throws Error if integrity check fails
 */
export function runMigrations(db: TradingDatabase): void {
  // Integrity check before any schema changes
  const integrityResult = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
  const isOk = integrityResult.length === 1 && integrityResult[0].integrity_check === 'ok';

  if (!isOk) {
    const details = integrityResult.map((r) => r.integrity_check).join('; ');
    throw new Error(`Database integrity check failed: ${details}`);
  }

  // Run all table creations and indexes in a transaction
  const migrate = db.transaction(() => {
    // Create tables
    db.exec(CREATE_TRADING_PHASE);
    db.exec(CREATE_BANKROLL);
    db.exec(CREATE_TX_INTENTS);
    db.exec(CREATE_POSITIONS);
    db.exec(CREATE_QUOTES_LOG);
    db.exec(CREATE_RECONCILIATION_LOG);
    db.exec(CREATE_APPROVALS);
    db.exec(CREATE_DAILY_METRICS);
    db.exec(CREATE_NONCE_REGISTRY);
    db.exec(CREATE_EVENT_LOG);
    db.exec(CREATE_OPERATOR_COMMANDS);

    // Create indexes
    for (const indexSql of CREATE_INDEXES) {
      db.exec(indexSql);
    }
  });

  migrate();
}

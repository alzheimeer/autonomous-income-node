-- migrations/001_initial.sql
-- Initial schema for autonomous-income-node agent state

-- Wallet & Identity
CREATE TABLE IF NOT EXISTS identity (
  id INTEGER PRIMARY KEY,
  wallet_address TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  registration_tx_hash TEXT,
  registration_block INTEGER,
  confirmed BOOLEAN DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- USDC Balance History
CREATE TABLE IF NOT EXISTS balance_history (
  id INTEGER PRIMARY KEY,
  balance_usdc TEXT NOT NULL,  -- stored as string (bigint)
  tier INTEGER NOT NULL,
  block_number INTEGER,
  recorded_at INTEGER NOT NULL
);

-- Payment Ledger
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
  amount_usdc TEXT NOT NULL,
  counterparty_address TEXT NOT NULL,
  tx_hash TEXT,
  block_number INTEGER,
  service_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  timestamp INTEGER NOT NULL
);

-- ReAct Observations
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  module TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_summary TEXT,
  success BOOLEAN NOT NULL,
  result_summary TEXT,
  error TEXT,
  latency_ms INTEGER,
  timestamp INTEGER NOT NULL
);

-- Trade History
CREATE TABLE IF NOT EXISTS trades (
  id TEXT PRIMARY KEY,
  network TEXT NOT NULL,
  token_in TEXT NOT NULL,
  token_out TEXT NOT NULL,
  amount_in TEXT NOT NULL,
  expected_out TEXT,
  actual_out TEXT,
  tx_hash TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  net_profit_usdc TEXT,
  gas_cost_usdc TEXT,
  slippage_pct REAL,
  source TEXT,
  executed_at INTEGER NOT NULL
);

-- Income Records
CREATE TABLE IF NOT EXISTS income_records (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,  -- 'trading' | 'service' | 'content'
  amount_usdc TEXT NOT NULL,
  reference_id TEXT,
  recorded_at INTEGER NOT NULL
);

-- Service Invocations
CREATE TABLE IF NOT EXISTS service_invocations (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  payment_id TEXT REFERENCES payments(id),
  success BOOLEAN NOT NULL,
  latency_ms INTEGER,
  invoked_at INTEGER NOT NULL
);

-- Social Posts
CREATE TABLE IF NOT EXISTS social_posts (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  post_id TEXT,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  engagement_url TEXT,
  published_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Self-Modification Audit Log
CREATE TABLE IF NOT EXISTS self_mod_history (
  id TEXT PRIMARY KEY,
  file_path TEXT NOT NULL,
  diff TEXT NOT NULL,
  backup_path TEXT NOT NULL,
  llm_reasoning TEXT,
  sandbox_output TEXT,
  status TEXT NOT NULL DEFAULT 'applied',
  applied_at INTEGER,
  reverted_at INTEGER
);

-- Child Agent Registry
CREATE TABLE IF NOT EXISTS child_agents (
  id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL UNIQUE,
  container_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  initial_funding TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  spawned_at INTEGER NOT NULL,
  last_heartbeat INTEGER
);

-- MCP Invocation Log
CREATE TABLE IF NOT EXISTS mcp_invocations (
  id TEXT PRIMARY KEY,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  input_summary TEXT,
  output_summary TEXT,
  success BOOLEAN NOT NULL,
  latency_ms INTEGER,
  error TEXT,
  invoked_at INTEGER NOT NULL
);

-- Heartbeat / Module Health
CREATE TABLE IF NOT EXISTS heartbeat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module_statuses TEXT NOT NULL,  -- JSON
  tier INTEGER NOT NULL,
  balance_usdc TEXT NOT NULL,
  llm_available BOOLEAN NOT NULL,
  recorded_at INTEGER NOT NULL
);

-- Crash Events
CREATE TABLE IF NOT EXISTS crash_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  last_known_state TEXT,  -- JSON snapshot
  crashed_at INTEGER NOT NULL,
  recovered_at INTEGER
);

-- Schema migrations tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at INTEGER NOT NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_observations_cycle ON observations(cycle_id);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_payments_direction ON payments(direction);
CREATE INDEX IF NOT EXISTS idx_mcp_server_tool ON mcp_invocations(server, tool);
CREATE INDEX IF NOT EXISTS idx_balance_history_time ON balance_history(recorded_at);

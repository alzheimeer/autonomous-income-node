-- migrations/002_income_sustainability.sql
-- Income Sustainability Engine schema additions

-- ══════════════════════════════════════════════════════════════════════════════
-- Strategy Performance Tracking (Requirement 8)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS strategy_performance (
  source TEXT PRIMARY KEY,  -- 'trading_uniswap' | 'aave_lending' | etc.
  total_revenue_usdc TEXT NOT NULL DEFAULT '0',    -- bigint as string
  total_costs_usdc TEXT NOT NULL DEFAULT '0',      -- bigint as string
  net_pnl_usdc TEXT NOT NULL DEFAULT '0',          -- bigint as string
  execution_count INTEGER NOT NULL DEFAULT 0,
  success_count INTEGER NOT NULL DEFAULT 0,
  last_executed_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,              -- boolean
  disabled_at INTEGER,
  disabled_reason TEXT,
  trial_mode INTEGER NOT NULL DEFAULT 0,           -- boolean
  consecutive_loss_days INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Granular P&L events (for daily aggregation)
CREATE TABLE IF NOT EXISTS strategy_events (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('revenue', 'cost', 'execution')),
  amount_usdc TEXT,           -- bigint as string (null for execution events)
  success INTEGER,            -- boolean (only for execution events)
  reference_id TEXT,
  recorded_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_strategy_events_source ON strategy_events(source, recorded_at);
CREATE INDEX IF NOT EXISTS idx_strategy_events_type ON strategy_events(event_type, recorded_at);

-- ══════════════════════════════════════════════════════════════════════════════
-- Knowledge Base (Requirements 9, 10)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS knowledge_base (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,               -- 'defillama' | 'x402_bazaar' | 'hyperliquid' | 'scrape'
  type TEXT NOT NULL,                 -- 'defi_yield' | 'marketplace_task' | 'funding_arb' | etc.
  title TEXT NOT NULL,
  description TEXT,
  protocol_name TEXT,                 -- for deduplication (Req 10.6)
  estimated_yield_bps INTEGER,        -- annual yield in basis points
  risk_level TEXT CHECK(risk_level IN ('low', 'medium', 'high')),
  required_capital_usdc TEXT,         -- bigint as string
  viability_score INTEGER DEFAULT 0,  -- 0-100 (LLM-evaluated)
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new', 'actionable', 'expired', 'executed', 'dismissed', 'integrated')),
  metadata TEXT,                      -- JSON blob
  discovered_at INTEGER NOT NULL,
  last_evaluated_at INTEGER,
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_knowledge_status ON knowledge_base(status, viability_score DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_base(source, discovered_at DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_dedup ON knowledge_base(protocol_name, type);

-- ══════════════════════════════════════════════════════════════════════════════
-- Marketplace Tasks (Requirement 5)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS marketplace_tasks (
  id TEXT PRIMARY KEY,
  marketplace TEXT NOT NULL,          -- 'x402_bazaar' | 'clawlancer' | '0xwork'
  external_task_id TEXT,              -- ID on the marketplace
  title TEXT NOT NULL,
  description TEXT,
  required_capability TEXT NOT NULL,  -- 'text-gen' | 'code-gen' | 'summarize' | 'scrape'
  payment_usdc TEXT NOT NULL,         -- bigint as string
  estimated_cost_usdc TEXT,           -- bigint as string
  deadline INTEGER,                   -- unix timestamp
  status TEXT NOT NULL DEFAULT 'discovered' CHECK(status IN ('discovered', 'accepted', 'executing', 'submitted', 'completed', 'failed', 'expired')),
  result_summary TEXT,
  execution_time_ms INTEGER,
  accepted_at INTEGER,
  completed_at INTEGER,
  discovered_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_marketplace_status ON marketplace_tasks(status);
CREATE INDEX IF NOT EXISTS idx_marketplace_deadline ON marketplace_tasks(deadline);

-- ══════════════════════════════════════════════════════════════════════════════
-- Aave Positions (Requirement 4)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS aave_positions (
  id TEXT PRIMARY KEY,
  asset TEXT NOT NULL,                -- token address (USDC)
  amount_deposited TEXT NOT NULL,     -- bigint as string
  a_token_balance TEXT NOT NULL,      -- bigint as string (current)
  tx_hash_supply TEXT,
  tx_hash_withdraw TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'withdrawn', 'failed')),
  apy_at_deposit INTEGER,            -- basis points
  deposited_at INTEGER NOT NULL,
  withdrawn_at INTEGER,
  withdraw_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_aave_status ON aave_positions(status);

-- ══════════════════════════════════════════════════════════════════════════════
-- LP Positions (Requirement 7)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS lp_positions (
  id TEXT PRIMARY KEY,
  token_id TEXT NOT NULL,             -- NFT token ID (bigint as string)
  token0 TEXT NOT NULL,
  token1 TEXT NOT NULL,
  fee_tier INTEGER NOT NULL,
  tick_lower INTEGER NOT NULL,
  tick_upper INTEGER NOT NULL,
  liquidity TEXT NOT NULL,            -- bigint as string
  amount0_deposited TEXT NOT NULL,
  amount1_deposited TEXT NOT NULL,
  fees_earned_0 TEXT NOT NULL DEFAULT '0',
  fees_earned_1 TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'removed', 'rebalancing')),
  impermanent_loss_bps INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  remove_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_lp_status ON lp_positions(status);

-- ══════════════════════════════════════════════════════════════════════════════
-- Hyperliquid Orders (Requirement 6)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS hyperliquid_orders (
  id TEXT PRIMARY KEY,
  pair TEXT NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
  order_type TEXT NOT NULL DEFAULT 'limit' CHECK(order_type IN ('limit', 'market', 'take_profit', 'stop_loss')),
  price REAL NOT NULL,
  size REAL NOT NULL,
  margin_usdc TEXT,                   -- bigint as string
  leverage REAL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'filled', 'cancelled', 'expired')),
  fill_price REAL,
  pnl_usdc TEXT,                      -- bigint as string
  external_order_id TEXT,
  placed_at INTEGER NOT NULL,
  filled_at INTEGER,
  cancelled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_hyper_pair_status ON hyperliquid_orders(pair, status);
CREATE INDEX IF NOT EXISTS idx_hyper_status ON hyperliquid_orders(status);

-- ══════════════════════════════════════════════════════════════════════════════
-- Bazaar Listings (Requirement 2)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bazaar_listings (
  id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  listing_id TEXT NOT NULL,           -- from Bazaar API
  endpoint_url TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_updated_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'expired', 'deregistered'))
);

CREATE INDEX IF NOT EXISTS idx_bazaar_service ON bazaar_listings(service_id);

-- ══════════════════════════════════════════════════════════════════════════════
-- Cloudflare Tunnel State (Requirement 3)
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS cloudflare_tunnels (
  id INTEGER PRIMARY KEY,
  public_url TEXT NOT NULL,
  tunnel_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'failed', 'stopped')),
  restart_count INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  last_health_check INTEGER
);

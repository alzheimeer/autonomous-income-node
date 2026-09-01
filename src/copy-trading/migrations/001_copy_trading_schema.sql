-- ============================================================================
-- Copy Trading Smart Money Schema Migration
-- Version: 001
-- Date: 2025-01-20
-- Purpose: Creates all required tables for the copy trading smart money system
-- Requirements: 8.1 (Data Persistence), 8.2 (Signal Tracking), 8.3 (Metrics)
-- ============================================================================

-- ============================================================================
-- TABLE: copy_wallets
-- Purpose: Monitored smart money wallets with performance metrics and filters
-- ============================================================================
CREATE TABLE IF NOT EXISTS copy_wallets (
  address VARCHAR(42) PRIMARY KEY,
  tier VARCHAR(10) NOT NULL CHECK (tier IN ('S_TIER', 'A_TIER', 'B_TIER')),
  win_rate DECIMAL(5,4) NOT NULL,
  total_pnl_usdc DECIMAL(18,2) NOT NULL,
  trade_count INTEGER NOT NULL,
  avg_holding_time_sec INTEGER NOT NULL,
  volume_usdc DECIMAL(18,2) NOT NULL,
  sharpe_ratio DECIMAL(8,4),
  max_drawdown_pct DECIMAL(5,2),
  profit_factor DECIMAL(8,4),
  profitable_weeks_pct DECIMAL(5,2),
  is_mev_bot BOOLEAN DEFAULT FALSE,
  is_token_deployer BOOLEAN DEFAULT FALSE,
  has_honeypot_exposure BOOLEAN DEFAULT FALSE,
  is_wash_trader BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  added_at BIGINT NOT NULL,
  last_evaluated_at BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- TABLE: copy_signals
-- Purpose: Copy trading signals with full pipeline tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS copy_signals (
  id UUID PRIMARY KEY,
  source_wallet VARCHAR(42) NOT NULL,
  wallet_tier VARCHAR(10) NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  pool_address VARCHAR(42) NOT NULL,
  action VARCHAR(4) NOT NULL CHECK (action IN ('BUY', 'SELL')),
  trade_amount_usdc DECIMAL(18,2) NOT NULL,
  entry_price VARCHAR(78) NOT NULL,
  block_number BIGINT NOT NULL,
  tx_hash VARCHAR(66) NOT NULL,
  detected_at BIGINT NOT NULL,
  detection_latency_ms INTEGER NOT NULL,
  enrichment_result VARCHAR(30),
  enrichment_reject_reason VARCHAR(50),
  baiting_result VARCHAR(30),
  baiting_reject_reason VARCHAR(50),
  execution_result VARCHAR(30),
  execution_reject_reason VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- TABLE: copy_positions
-- Purpose: Open and closed copy positions with exit tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS copy_positions (
  id UUID PRIMARY KEY,
  signal_id UUID NOT NULL,
  source_wallet VARCHAR(42) NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  pool_address VARCHAR(42) NOT NULL,
  entry_price VARCHAR(78) NOT NULL,
  position_size_usdc DECIMAL(18,2) NOT NULL,
  token_amount VARCHAR(78) NOT NULL,
  take_profit VARCHAR(78) NOT NULL,
  stop_loss VARCHAR(78) NOT NULL,
  trailing_stop_trigger VARCHAR(78) NOT NULL,
  trailing_stop_level VARCHAR(78),
  time_stop BIGINT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'OPEN',
  opened_at BIGINT NOT NULL,
  closed_at BIGINT,
  exit_price VARCHAR(78),
  pnl_usdc DECIMAL(18,2),
  exit_reason VARCHAR(30),
  highest_price VARCHAR(78),
  quote_fail_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- TABLE: bait_flags
-- Purpose: Anti-baiting tracking for suspicious wallet behavior
-- ============================================================================
CREATE TABLE IF NOT EXISTS bait_flags (
  id SERIAL PRIMARY KEY,
  wallet_address VARCHAR(42) NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  reason VARCHAR(50) NOT NULL,
  flagged_at BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- TABLE: blacklisted_deployers
-- Purpose: Known malicious token deployers to avoid
-- ============================================================================
CREATE TABLE IF NOT EXISTS blacklisted_deployers (
  address VARCHAR(42) PRIMARY KEY,
  reason VARCHAR(200),
  flagged_at BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- TABLE: copy_daily_metrics
-- Purpose: Daily aggregate metrics for performance tracking
-- ============================================================================
CREATE TABLE IF NOT EXISTS copy_daily_metrics (
  date DATE NOT NULL,
  total_signals INTEGER DEFAULT 0,
  approved_signals INTEGER DEFAULT 0,
  executed_trades INTEGER DEFAULT 0,
  total_pnl_usdc DECIMAL(18,2) DEFAULT 0,
  win_count INTEGER DEFAULT 0,
  loss_count INTEGER DEFAULT 0,
  avg_holding_time_ms BIGINT,
  best_wallet VARCHAR(42),
  worst_wallet VARCHAR(42),
  PRIMARY KEY (date)
);

-- ============================================================================
-- INDEXES: Performance optimization for common queries
-- ============================================================================

-- copy_wallets indexes
CREATE INDEX IF NOT EXISTS idx_copy_wallets_tier ON copy_wallets(tier);
CREATE INDEX IF NOT EXISTS idx_copy_wallets_active ON copy_wallets(is_active);

-- copy_signals indexes
CREATE INDEX IF NOT EXISTS idx_copy_signals_wallet ON copy_signals(source_wallet);
CREATE INDEX IF NOT EXISTS idx_copy_signals_token ON copy_signals(token_address);
CREATE INDEX IF NOT EXISTS idx_copy_signals_detected ON copy_signals(detected_at DESC);

-- copy_positions indexes
CREATE INDEX IF NOT EXISTS idx_copy_positions_status ON copy_positions(status);
CREATE INDEX IF NOT EXISTS idx_copy_positions_source ON copy_positions(source_wallet);
CREATE INDEX IF NOT EXISTS idx_copy_positions_token ON copy_positions(token_address);

-- bait_flags composite index
CREATE INDEX IF NOT EXISTS idx_bait_flags_wallet ON bait_flags(wallet_address, flagged_at);

-- ============================================================================
-- NOTES:
-- - No foreign keys to copy_wallets as source wallets may not be pre-registered
-- - VARCHAR(78) used for bigint prices (max 78 digits for uint256)
-- - VARCHAR(66) for tx_hash (0x + 64 hex chars)
-- - VARCHAR(42) for addresses (0x + 40 hex chars)
-- - BIGINT for timestamps (Unix milliseconds)
-- ============================================================================

-- ============================================================================
-- Copy Trading Smart Money Schema Migration
-- Version: 002
-- Date: 2025-01-21
-- Purpose: Extends copy_daily_metrics for per-wallet and per-tier aggregate metrics
-- Requirements: 8.3 (Daily/weekly/monthly aggregates), 8.4 (Per-wallet metrics), 8.5 (Per-tier metrics)
-- ============================================================================

-- ============================================================================
-- TABLE: copy_aggregate_metrics
-- Purpose: Extended aggregate metrics with wallet and tier dimensions
-- Replaces the simpler copy_daily_metrics structure with a more flexible schema
-- ============================================================================
CREATE TABLE IF NOT EXISTS copy_aggregate_metrics (
  id SERIAL PRIMARY KEY,
  -- Date of the metrics period
  date DATE NOT NULL,
  -- Optional wallet address (NULL for global aggregates)
  wallet_address VARCHAR(42),
  -- Optional tier (NULL for global or wallet-only aggregates)
  tier VARCHAR(10) CHECK (tier IS NULL OR tier IN ('S_TIER', 'A_TIER', 'B_TIER')),
  -- Period type: DAILY, WEEKLY, MONTHLY
  period_type VARCHAR(10) NOT NULL DEFAULT 'DAILY' CHECK (period_type IN ('DAILY', 'WEEKLY', 'MONTHLY')),
  
  -- Trade counts
  total_trades INTEGER NOT NULL DEFAULT 0,
  winning_trades INTEGER NOT NULL DEFAULT 0,
  losing_trades INTEGER NOT NULL DEFAULT 0,
  
  -- Win rate (calculated: winning_trades / total_trades * 100)
  win_rate DECIMAL(5,2),
  
  -- PnL metrics
  total_pnl_usdc DECIMAL(18,2) DEFAULT 0,
  avg_pnl_usdc DECIMAL(18,2) DEFAULT 0,
  max_pnl_usdc DECIMAL(18,2),
  min_pnl_usdc DECIMAL(18,2),
  
  -- Risk-adjusted metrics
  sharpe_ratio DECIMAL(10,4),
  
  -- Additional metrics
  total_volume_usdc DECIMAL(18,2) DEFAULT 0,
  avg_holding_time_ms BIGINT,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  
  -- Unique constraint: one record per date+wallet+tier+period combination
  UNIQUE(date, wallet_address, tier, period_type)
);

-- ============================================================================
-- INDEXES: Performance optimization for common queries
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_aggregate_metrics_date ON copy_aggregate_metrics(date);
CREATE INDEX IF NOT EXISTS idx_aggregate_metrics_wallet ON copy_aggregate_metrics(wallet_address);
CREATE INDEX IF NOT EXISTS idx_aggregate_metrics_tier ON copy_aggregate_metrics(tier);
CREATE INDEX IF NOT EXISTS idx_aggregate_metrics_period ON copy_aggregate_metrics(period_type);
CREATE INDEX IF NOT EXISTS idx_aggregate_metrics_composite ON copy_aggregate_metrics(date, period_type);

-- ============================================================================
-- NOTES:
-- - wallet_address NULL + tier NULL = global aggregate
-- - wallet_address SET + tier NULL = per-wallet aggregate
-- - wallet_address NULL + tier SET = per-tier aggregate
-- - wallet_address SET + tier SET = per-wallet-tier aggregate (optional)
-- - period_type allows daily, weekly, monthly rollups
-- - Sharpe ratio calculated as (avg_return - risk_free_rate) / stddev_return
-- - Risk-free rate assumed to be 0 for simplicity
-- ============================================================================


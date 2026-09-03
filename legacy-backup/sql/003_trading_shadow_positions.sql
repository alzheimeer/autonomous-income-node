-- Migration: Create separate table for trading-validation ShadowTrader
-- Date: 2026-08-12
-- Reason: The trading-validation's ShadowTrader was incorrectly using the 
--         hybrid-sniper's shadow_positions table with incompatible columns.
--         This creates a dedicated table with the correct schema.

CREATE TABLE IF NOT EXISTS trading_shadow_positions (
  id VARCHAR(255) PRIMARY KEY,
  token_address VARCHAR(100),
  direction VARCHAR(50),
  entry_price REAL,
  size_usd REAL,
  leverage REAL DEFAULT 1,
  status VARCHAR(50) DEFAULT 'OPEN',
  created_at BIGINT,
  updated_at BIGINT,
  closed_at BIGINT,
  close_price REAL,
  pnl_usd REAL,
  close_reason VARCHAR(100)
);

-- Index for quick lookup of open positions
CREATE INDEX IF NOT EXISTS idx_trading_shadow_status ON trading_shadow_positions(status);

-- Note: The original shadow_positions table is used by hybrid-sniper with this schema:
-- id, signal_id, contract_address, entry_price, take_profit, stop_loss, 
-- time_stop, trade_size, status, opened_at, closed_at, exit_price, pnl_usdc,
-- created_at, variant_id, variant_name, signal_source, signal_type

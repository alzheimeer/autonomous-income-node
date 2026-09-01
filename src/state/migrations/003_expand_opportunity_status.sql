-- Migration 003: Expand knowledge_base status CHECK constraint
-- 
-- The original constraint was too restrictive for the full opportunity lifecycle.
-- This migration expands it to support the complete OpportunityStatus type from protocol.ts:
-- 
-- Lifecycle:
--   new → activa → profundización → pendiente_aprobacion → aprobada → code_generated
--       → revenue_tracking → implementada
--       → failed_no_revenue (no revenue after 7 days)
--       → descartada (rejected or timeout)
--
-- SQLite doesn't support ALTER CONSTRAINT, so we need to recreate the table.

-- Step 1: Rename old table
ALTER TABLE knowledge_base RENAME TO knowledge_base_old;

-- Step 2: Create new table with expanded status constraint
CREATE TABLE IF NOT EXISTS knowledge_base (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  description TEXT,
  protocol_name TEXT,
  estimated_yield_bps INTEGER,
  risk_level TEXT,
  required_capital_usdc TEXT,
  viability_score INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN (
    -- Original values (for backwards compatibility)
    'new', 'actionable', 'expired', 'executed', 'dismissed', 'integrated',
    -- New lifecycle values from OpportunityStatus
    'activa', 'profundización', 'pendiente_aprobacion', 'aprobada',
    'code_generated', 'revenue_tracking', 'implementada', 
    'failed_no_revenue', 'descartada'
  )),
  metadata TEXT,
  discovered_at INTEGER NOT NULL,
  last_evaluated_at INTEGER,
  expires_at INTEGER
);

-- Step 3: Copy data from old table
INSERT INTO knowledge_base 
SELECT * FROM knowledge_base_old;

-- Step 4: Drop old table
DROP TABLE knowledge_base_old;

-- Step 5: Recreate index
CREATE INDEX IF NOT EXISTS idx_knowledge_base_status ON knowledge_base(status);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_viability ON knowledge_base(viability_score DESC);
CREATE INDEX IF NOT EXISTS idx_knowledge_base_discovered ON knowledge_base(discovered_at DESC);

-- ═══════════════════════════════════════════════════════════════════════════
-- Migration 002: Scanner Health Tracking + Revenue Lifecycle + Dedup Key
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Scanner Health: Track success/failure of each scanner per cycle ────────
CREATE TABLE IF NOT EXISTS scanner_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanner TEXT NOT NULL,
  status TEXT NOT NULL,           -- 'ok' | 'failed'
  results_count INTEGER DEFAULT 0,
  error TEXT,
  cycle_id TEXT,                  -- links to scan_history.id
  timestamp INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scanner_health_scanner ON scanner_health(scanner);
CREATE INDEX IF NOT EXISTS idx_scanner_health_timestamp ON scanner_health(timestamp DESC);

-- ── Dedup Key: Normalized fingerprint for better deduplication ─────────────
-- Add dedup_key column to opportunities (nullable for existing rows)
ALTER TABLE opportunities ADD COLUMN dedup_key TEXT;

CREATE INDEX IF NOT EXISTS idx_opp_dedup_key ON opportunities(dedup_key);

-- ── Revenue Tracking: Lifecycle columns for implemented opportunities ──────
-- Tracks when code was generated and when revenue was first confirmed
ALTER TABLE opportunities ADD COLUMN code_generated_at INTEGER;
ALTER TABLE opportunities ADD COLUMN revenue_check_at INTEGER;
ALTER TABLE opportunities ADD COLUMN actual_revenue TEXT;

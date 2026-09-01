CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL,
  score INTEGER DEFAULT 0,
  score_viability INTEGER DEFAULT 0,
  score_risk INTEGER DEFAULT 0,
  score_capital INTEGER DEFAULT 0,
  score_automation INTEGER DEFAULT 0,
  status TEXT DEFAULT 'new',
  description TEXT,
  estimated_revenue TEXT,
  capital_required TEXT,
  risk_level TEXT,
  automation_level TEXT,
  source_url TEXT,
  metadata TEXT,
  reasoning TEXT,
  discovered_at INTEGER NOT NULL,
  last_evaluated_at INTEGER,
  status_changed_at INTEGER
);

CREATE TABLE IF NOT EXISTS scan_history (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  sources_scanned INTEGER DEFAULT 0,
  sources_failed INTEGER DEFAULT 0,
  opportunities_found INTEGER DEFAULT 0,
  opportunities_actionable INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  strategy TEXT NOT NULL,
  risk_percent INTEGER NOT NULL,
  capital_required TEXT NOT NULL,
  best_case TEXT,
  worst_case TEXT,
  telegram_message_id INTEGER,
  status TEXT DEFAULT 'pending',
  responded_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS strategies (
  id TEXT PRIMARY KEY,
  opportunity_id TEXT NOT NULL,
  status TEXT DEFAULT 'proposed',
  implementation TEXT,
  file_written TEXT,
  operator_ack TEXT,
  approved_at INTEGER,
  implemented_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_opp_status ON opportunities(status);
CREATE INDEX IF NOT EXISTS idx_opp_priority ON opportunities(priority);
CREATE INDEX IF NOT EXISTS idx_opp_score ON opportunities(score DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

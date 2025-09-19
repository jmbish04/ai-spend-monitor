-- Initial schema for AI Spend Monitor D1 database
-- Tracks spend snapshots, cron executions, and billing data sources/hooks.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS billing_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('email', 'api', 'webhook', 'manual', 'other')),
  display_name TEXT,
  hook_reference TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS billing_hooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_type TEXT NOT NULL CHECK (hook_type IN ('slack', 'email', 'webhook', 'other')),
  target TEXT NOT NULL,
  description TEXT,
  metadata TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spend_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  model TEXT,
  day TEXT NOT NULL,
  source TEXT NOT NULL,
  cost_usd_cents INTEGER NOT NULL CHECK (cost_usd_cents >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  billing_source_id INTEGER,
  hook_id INTEGER,
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider, model, day, source),
  FOREIGN KEY (billing_source_id) REFERENCES billing_sources(id) ON DELETE SET NULL,
  FOREIGN KEY (hook_id) REFERENCES billing_hooks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_started_at TEXT NOT NULL,
  run_completed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  rows_ingested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hook_dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id INTEGER NOT NULL,
  cron_run_id INTEGER,
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
  response_status INTEGER,
  error TEXT,
  payload TEXT,
  FOREIGN KEY (hook_id) REFERENCES billing_hooks(id) ON DELETE CASCADE,
  FOREIGN KEY (cron_run_id) REFERENCES cron_runs(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_spend_snapshots_day ON spend_snapshots(day);
CREATE INDEX IF NOT EXISTS idx_spend_snapshots_provider_day ON spend_snapshots(provider, day);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at ON cron_runs(run_started_at);
CREATE INDEX IF NOT EXISTS idx_hook_dispatches_hook ON hook_dispatches(hook_id);

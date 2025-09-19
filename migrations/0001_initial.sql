-- Revised schema for AI Spend Monitor D1 database
-- Tracks spend snapshots, cron executions, and billing data sources/hooks.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Manages the sources of billing data (e.g., APIs, webhooks).
CREATE TABLE IF NOT EXISTS billing_sources (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('openai', 'anthropic', 'google_vertex_ai')),
    source_type TEXT NOT NULL CHECK (source_type IN ('email', 'api', 'webhook', 'manual', 'other')),
    display_name TEXT NOT NULL,
    hook_reference TEXT,
    metadata JSON,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Manages outgoing notification hooks (e.g., Slack, email).
CREATE TABLE IF NOT EXISTS billing_hooks (
    id INTEGER PRIMARY KEY,
    hook_type TEXT NOT NULL CHECK (hook_type IN ('slack', 'email', 'webhook', 'other')),
    target TEXT NOT NULL,
    description TEXT,
    metadata JSON,
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Stores individual spend data points.
CREATE TABLE IF NOT EXISTS spend_snapshots (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    model TEXT,
    day DATE NOT NULL,
    source TEXT NOT NULL,
    source_record_id TEXT, -- To link back to the original record in the source system
    cost_usd_cents INTEGER NOT NULL CHECK (cost_usd_cents >= 0),
    input_tokens INTEGER,
    output_tokens INTEGER,
    billing_source_id INTEGER,
    hook_id INTEGER,
    captured_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    UNIQUE(provider, model, day, source, source_record_id),
    FOREIGN KEY (billing_source_id) REFERENCES billing_sources(id) ON DELETE SET NULL,
    FOREIGN KEY (hook_id) REFERENCES billing_hooks(id) ON DELETE SET NULL
);

-- Logs the execution of cron jobs.
CREATE TABLE IF NOT EXISTS cron_runs (
    id INTEGER PRIMARY KEY,
    run_started_at INTEGER NOT NULL,
    run_completed_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('success', 'error', 'in_progress')),
    rows_ingested INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

-- Tracks the dispatch of notifications.
CREATE TABLE IF NOT EXISTS hook_dispatches (
    id INTEGER PRIMARY KEY,
    hook_id INTEGER NOT NULL,
    cron_run_id INTEGER,
    dispatched_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
    status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
    response_status INTEGER,
    error TEXT,
    payload JSON,
    FOREIGN KEY (hook_id) REFERENCES billing_hooks(id) ON DELETE CASCADE,
    FOREIGN KEY (cron_run_id) REFERENCES cron_runs(id) ON DELETE SET NULL
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_spend_snapshots_day ON spend_snapshots(day);
CREATE INDEX IF NOT EXISTS idx_spend_snapshots_provider_day ON spend_snapshots(provider, day);
CREATE INDEX IF NOT EXISTS idx_cron_runs_started_at ON cron_runs(run_started_at);
CREATE INDEX IF NOT EXISTS idx_hook_dispatches_hook ON hook_dispatches(hook_id);

-- Triggers for automatic timestamp updates
CREATE TRIGGER IF NOT EXISTS update_billing_hooks_updated_at
AFTER UPDATE ON billing_hooks
FOR EACH ROW
BEGIN
    UPDATE billing_hooks SET updated_at = strftime('%s', 'now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS update_spend_snapshots_updated_at
AFTER UPDATE ON spend_snapshots
FOR EACH ROW
BEGIN
    UPDATE spend_snapshots SET updated_at = strftime('%s', 'now') WHERE id = OLD.id;
END;

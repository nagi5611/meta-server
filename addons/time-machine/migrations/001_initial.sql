CREATE TABLE IF NOT EXISTS storage_settings (
    mount_id TEXT PRIMARY KEY NOT NULL,
    role TEXT NOT NULL DEFAULT 'off',
    hourly_retention INTEGER NOT NULL DEFAULT 48,
    daily_retention INTEGER NOT NULL DEFAULT 14,
    daily_hour INTEGER NOT NULL DEFAULT 3,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS backup_runs (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    scope TEXT NOT NULL,
    mount_id TEXT NOT NULL,
    snapshot_dir TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    bytes INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_started ON backup_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_runs_mount ON backup_runs(mount_id, started_at DESC);

CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE TABLE IF NOT EXISTS bench_runs (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    phase TEXT NOT NULL DEFAULT 'idle',
    bot_count INTEGER NOT NULL DEFAULT 50,
    scores_json TEXT,
    metrics_json TEXT,
    report_filename TEXT,
    error_message TEXT,
    started_at INTEGER,
    finished_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_bench_runs_status ON bench_runs(status);
CREATE INDEX IF NOT EXISTS idx_bench_runs_created ON bench_runs(created_at);

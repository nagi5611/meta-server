CREATE TABLE IF NOT EXISTS nfc_spawns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spawn_token TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    nfc_tag_uid TEXT,
    world_id TEXT NOT NULL,
    x REAL NOT NULL,
    y REAL NOT NULL,
    z REAL NOT NULL,
    yaw REAL NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_nfc_spawns_token ON nfc_spawns(spawn_token);

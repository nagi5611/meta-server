CREATE TABLE IF NOT EXISTS qr_ar_cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    model_filename TEXT,
    model_scale REAL NOT NULL DEFAULT 1.0,
    offset_x REAL NOT NULL DEFAULT 0,
    offset_y REAL NOT NULL DEFAULT 0.05,
    offset_z REAL NOT NULL DEFAULT 0,
    qr_physical_size_m REAL NOT NULL DEFAULT 0.02,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_qr_ar_cards_card_id ON qr_ar_cards(card_id);

ALTER TABLE nfc_spawns ADD COLUMN type TEXT NOT NULL DEFAULT 'teleport';
ALTER TABLE nfc_spawns ADD COLUMN load_radius REAL;
ALTER TABLE nfc_spawns ADD COLUMN instance_manifest_path TEXT;
ALTER TABLE nfc_spawns ADD COLUMN baked_at TEXT;
ALTER TABLE nfc_spawns ADD COLUMN bake_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS nfc_instance_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    spawn_id INTEGER NOT NULL REFERENCES nfc_spawns(id) ON DELETE CASCADE,
    world_model_index INTEGER NOT NULL,
    entry_kind TEXT NOT NULL,
    prefab_manifest TEXT,
    part_indices TEXT,
    source_path TEXT
);

CREATE INDEX IF NOT EXISTS idx_nfc_instance_entries_spawn ON nfc_instance_entries(spawn_id);

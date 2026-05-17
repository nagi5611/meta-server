-- addons/aircraft — 機体ライブラリ（prefab マニフェスト + バインド + アニメ JSON）
CREATE TABLE IF NOT EXISTS aircraft_airframe (
    id TEXT PRIMARY KEY NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    prefab_manifest TEXT NOT NULL DEFAULT '',
    bindings_json TEXT NOT NULL DEFAULT '{}',
    animation_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

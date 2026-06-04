-- ワールド別飛行ミニマップ（地図画像 + スポット + 座標キャリブレーション）
CREATE TABLE IF NOT EXISTS aircraft_world_flight_map (
    world_id TEXT PRIMARY KEY NOT NULL,
    image_path TEXT NOT NULL DEFAULT '',
    config_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 操縦モード hard/easy と easy 用プロファイル列
ALTER TABLE aircraft_airframe ADD COLUMN control_mode TEXT NOT NULL DEFAULT 'hard';
ALTER TABLE aircraft_airframe ADD COLUMN physics_easy_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE aircraft_airframe ADD COLUMN camera_easy_json TEXT NOT NULL DEFAULT '{}';

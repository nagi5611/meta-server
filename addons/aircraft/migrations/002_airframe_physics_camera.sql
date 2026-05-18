-- 機体ライブラリに操縦パラメータ・カメラ定義を保持
ALTER TABLE aircraft_airframe ADD COLUMN physics_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE aircraft_airframe ADD COLUMN camera_json TEXT NOT NULL DEFAULT '{}';

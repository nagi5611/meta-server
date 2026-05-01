# メタバース アドオン（addons）

リポジトリ直下の `addons/<plugin-id>/` に配置します。各アドオンは `plugin.json` とエントリ（既定 `server.js`）を必須とします。

## plugin.json（必須フィールド）

| フィールド | 説明 |
|-----------|------|
| `id` | ディレクトリ名と一致する kebab-case |
| `version` | アドオン独自のセマンティックバージョン |
| `main` | サーバー側エントリ（ESM）。ルートからの相対パス |
| `engines.meta-server` | 対応する meta-server の semver レンジ（`package.json` の `version` と照合） |

任意: `socketPrefix`（省略時は `addon:<id>`）、`migrationsDir`（既定 `migrations`）

## 設定のマージ

1. `addons/<id>/config.json`（JSON。任意）
2. 環境変数 `ADDON_<UPPER_SNAKE_ID>_<KEY>` があれば上書き（例: `ADDON_SAMPLE_ECHO_GREETING=hi`）

機密値は環境変数を推奨します。

## HTTP / Socket の規約

- HTTP は **`/api/addons/<id>/...`** 以下に限定してください。
- Socket イベント名は **`addon:<id>:...`** または manifest の `socketPrefix` を接頭辞にしてください。

## 有効化とプロセス再起動

管理画面で有効／無効を保存したあと、**Node プロセス全体を再起動**しないと読み込みは変わりません（動的アンロードはしません）。

詳細は `docs/addons-restart-policy.md` を参照してください。

## サンプル

`addons/sample-echo/` — `GET /api/addons/sample-echo/hello` と Socket `addon:sample-echo:ping` / `addon:sample-echo:pong`。

`addons/aircraft/` — ワールド設定の機体載せ・複数ユーザー同期・`players-update.aircraft`。詳細は `addons/aircraft/README.md`。

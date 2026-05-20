# matsuyama-flights（松山空港 発着情報）

公共交通オープンデータセンター（ODPT）の JAL / ANA リアルタイム発着 API に加え、Jetstar（松山→成田 GK 便）のフライトステータス API から松山空港（MYJ）の便を取得し、ワールド内の 3D パネルに表示します。

## 有効化

1. 管理画面「アドオン」で `matsuyama-flights` を有効化
2. **Node プロセスを再起動**
3. [ODPT 開発者サイト](https://developer.odpt.org/) で登録し `acl:consumerKey` を取得

## 環境変数

| 変数 | 説明 |
|------|------|
| `ADDON_MATSUYAMA_FLIGHTS_ODPT_CONSUMER_KEY` | ODPT API キー（必須） |
| `ADDON_MATSUYAMA_FLIGHTS_POLL_INTERVAL_MS` | サーバー側ポーリング間隔（既定 60000） |
| `ADDON_MATSUYAMA_FLIGHTS_AIRPORT_IATA` | 空港 IATA（既定 MYJ） |
| `ADDON_MATSUYAMA_FLIGHTS_JETSTAR_ENABLED` | Jetstar 取得（既定有効。`0` / `false` で無効） |
| `ADDON_MATSUYAMA_FLIGHTS_JETSTAR_DESTINATION` | Jetstar 行先 IATA（既定 NRT） |

## HTTP

- `GET /api/addons/matsuyama-flights/board` — 正規化済み発着 JSON

## ワールド編集

管理画面 → ワールド編集 → 左「発着情報」→「発着情報メニューパネルを追加」→ 保存。

`worlds.json` に `flightBoards[]`（位置・回転・スケール）が記録されます。

## ライセンス

データは [公共交通オープンデータ基本ライセンス](https://developer.odpt.org/terms) に従って利用してください。JAL/ANA 以外・コードシェア便は ODPT では表示されない場合があります。Jetstar は公式予約サイト向け API をサーバー経由で参照します（非公開 API のため仕様変更の可能性あり）。

## データソース

- 日本航空 / 全日空 リアルタイム出発・到着情報（ODPT）
- ジェットスター・ジャパン 松山発成田行き出発便（`digitalapi.jetstar.com`、サーバー側取得）

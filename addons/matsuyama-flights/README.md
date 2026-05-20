# matsuyama-flights（松山空港 発着情報）v2.0

[松山空港公式「本日のフライト情報」](https://www.matsuyama-airport.co.jp/flight/timetable.html) を主データ源とし、国内線・国際線（EVA 等）と時刻変更をワールド内の 3D パネルに表示します。

HTML レイアウトが想定と異なる場合は **ODPT（JAL/ANA）+ Jetstar** バックアップに自動切り替えし、サーバーコンソールに警告を出します。

## 有効化

1. 管理画面「アドオン」で `matsuyama-flights` を有効化
2. **Node プロセスを再起動**
3. バックアップ利用時のみ [ODPT 開発者サイト](https://developer.odpt.org/) で `acl:consumerKey` を取得

## 環境変数

| 変数 | 説明 |
|------|------|
| `ADDON_MATSUYAMA_FLIGHTS_TIMETABLE_URL` | 公式運行状況 URL（既定: 上記 timetable.html） |
| `ADDON_MATSUYAMA_FLIGHTS_POLL_INTERVAL_MS` | ポーリング間隔 ms（既定 60000） |
| `ADDON_MATSUYAMA_FLIGHTS_AIRPORT_IATA` | 空港 IATA（既定 MYJ） |
| `ADDON_MATSUYAMA_FLIGHTS_BACKUP_ENABLED` | レイアウト変更時 ODPT バックアップ（既定有効） |
| `ADDON_MATSUYAMA_FLIGHTS_ODPT_CONSUMER_KEY` | **バックアップ用** ODPT キー |
| `ADDON_MATSUYAMA_FLIGHTS_JETSTAR_ENABLED` | バックアップ時 Jetstar 併用（既定有効） |
| `ADDON_MATSUYAMA_FLIGHTS_JETSTAR_DESTINATION` | Jetstar 行先 IATA（既定 NRT） |

通常運用では ODPT キーは不要です。レイアウト検知時のみ必要です。

## HTTP

- `GET /api/addons/matsuyama-flights/board` — 正規化済み発着 JSON（`dataSource`: `airport` | `backup`, `layoutAlert` 等）

## ワールド編集

管理画面 → ワールド編集 → 左「発着情報」→「発着情報メニューパネルを追加」→ 保存。

## データソース

- **主**: 松山空港公式 timetable.html（サーバー側取得・HTML パース）
- **バックアップ**: ODPT リアルタイム発着 + Jetstar flight-status API

## 注意

- 公式サイトの HTML 構造変更時は `lib/layout-signature.js` の更新が必要になる場合があります。
- 公式ページの利用条件は未確認です。アクセス頻度は `pollIntervalMs` で控えめにしてください。
- バックアップ利用時の ODPT データは [公共交通オープンデータ基本ライセンス](https://developer.odpt.org/terms) に従ってください。

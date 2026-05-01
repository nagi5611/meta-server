# addons/aircraft — エアークラフト（飛行機）マルチ同期

## 有効化

管理画面アドオン一覧で `aircraft` を有効にし、**Node プロセスを再起動**してください。初回セットアップでは `sample-echo` と同様にレジストリが空なら `aircraft` を自動有効化するシードがあります。

## サーバー

- `lib/aircraft-server/` — ルーム状態・worlds 検証・ソケットの `aircraft-board` / `aircraft-exit`
- イベント名（互換維持）: `aircraft-board`, `aircraft-exit`, `aircraft-initial`, `aircraft-released`, `players-update` の `aircraft` 配列, `player-update` の `aircraftPose`

## クライアント

- `client/init.js` が `MetaverseApp` に `AircraftController` / `AircraftManager` を結線
- `public/js/addons/registry-game.js` から `game.js` を読み込み、Vite の依存グラフに載せる

## データ契約（コア）

`worlds.json` の `models[].aircraft` とワールド共通 `aircraftPhysics` は変更しません（設定は従来どおり POST `/admin/worlds` で検証）。

## 手動回帰観点（要約）

搭乗・離脱、二重搭乗拒否、切断・ワールド変更・管理 tp での機体解放、リモート機体姿勢、モバイルで搭乗プロンプト非表示、テレポート E キーと搭乗の競合。

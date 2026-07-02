# meta-benchR1 実装計画書

**文書バージョン**: 1.0  
**最終更新**: 2026-07-02  
**根拠要件**: [要件定義書(本番)](./要件定義書(本番).md) v1.1  
**対象読者**: 実装者・レビュアー

---

## 0. 本書の位置づけ

本書は要件定義書 v1.1 を実装するための**技術的実装計画**である。  
公式ドキュメントおよび運用実績のある OSS を参照し、**大きく手を入れる箇所を先に明示**したうえで、マイルストーン M1〜M5 に沿った作業順序を定める。

---

## 1. 大きく改良される部分（優先着手領域）

以下 6 領域が本機能の中核であり、工数・リスクともに大きい。**M1 から順に着手**し、領域 A・B は M1 と同時、領域 D は M3〜M4 で最大の不確実性がある。

### 1.1 領域 A — `server.js` コア改修（メンテナンス・認証・計測フック）

| 項目 | 現状 | 改修内容 |
|------|------|----------|
| 接続ゲート | `io.use` は `AUTH_REQUIRED` のみ（ゲスト無効時） | ベンチ中は `benchToken` / `adminToken` 以外の**新規接続を拒否**（`BENCH_MAINTENANCE`） |
| メンテフラグ | なし | `lib/bench-maintenance.js` に状態管理を集約し、addon から API 経由で ON/OFF |
| 既存ユーザー警告 | なし | メンテ ON 時に全実ユーザーへ `bench-maintenance-warning` を 1 回 emit |
| TPS 計測 | `players-update` は 33ms 間隔で emit のみ | ルーム別 emit カウンタ + 秒次集計 API（addon が読み取り） |
| bench bot 物理補正 | 非 admin は `player-update` で Y クランプ等 | `socket.data.isBenchBot` 時は admin 同等に補正スキップ |
| mediasoup 起動確認 | ワーカー配列はあるがフラグ未公開 | `isMediasoupReady()` を export（P-05 用） |

**改修方針**: `server.js` への diff を最小化するため、ロジックは `lib/bench-maintenance.js`・`lib/bench-tick-metrics.js` に切り出す。`server.js` 側は `io.use` 1 ブロック追加、`setInterval` 内カウンタ 1 行、`player-update` 内条件 1 箇所に留める。

**参照**:

- 既存 `io.use` + `AUTH_REQUIRED` パターン: `server.js`（`peekAdminToken` / `verifySocketAuthToken`）
- Socket.IO ミドルウェア: [Socket.IO Server API — Middlewares](https://socket.io/docs/v4/server-api/#serverusefn)
- 既存 HMAC トークン: `lib/socket-auth-token.js`（`benchToken` も同様の署名方式で実装）

---

### 1.2 領域 B — 新規 addon `addons/meta-benchR1/`（オーケストレーション本体）

addon が担う責務:

- run ライフサイクル（開始・進行・中止・タイムアウト 6 分・`finally` でメンテ OFF）
- プリフライト P-01〜P-07
- サーバ側ベンチ（hw-cpu / hw-mem / db-sqlite）実行とスコア正規化
- Runner 登録・heartbeat・ジョブ配信（Socket）
- メトリクス受信・集計・HTML レポート生成
- `bench_runs` SQLite メタデータ

**既存パターンに合わせる点**:

| パターン | 参照実装 |
|----------|----------|
| addon 骨格 | `addons/sample-echo/server.js` |
| 管理 API（`/admin/addons/...`） | `addons/nfc-spawn/server.js` |
| 管理 UI パネル | `addons/nfc-spawn/client/admin.js` |
| DB マイグレーション | `addons/sample-echo/migrations/` + `lib/plugin-migrations.js` |
| 有効 addon 一覧（P-07） | `lib/plugin-bootstrap.js` → `getAddonCatalogSnapshot()` |

**新規で設計が必要な部分**:

- run ステートマシン（`idle` → `preflight` → `phase-N` → `aggregating` → `completed|partial|failed`）
- Runner との Socket ジョブプロトコル（`addon:meta-benchR1:job` / `metrics`）
- スコア正規化モジュール（要件 §7 の線形 clamp 式を pure function 化）

---

### 1.3 領域 C — `db/users.js` 拡張（一時 bench ユーザー）

| 項目 | 内容 |
|------|------|
| 現状 | `students` / `teachers` テーブルのみ |
| 改修 | `bench_users` テーブル追加、または `students` に `is_bench` フラグ付き一時行（**推奨: 専用テーブル**で本番アカウントと分離） |
| API | `createBenchUsers(runId, count)` / `deleteBenchUsers(runId)`（3 回リトライは addon 側） |

**参照**: 既存 CRUD パターン `db/users.js`（`better-sqlite3` 同期 API）

---

### 1.4 領域 D — Bench Runner（手元 PC 常駐・最大リスク）

Runner は**本番と別プロセス**で、次を並列実行する:

1. **Socket bot プール**（N=20/50/100）— 接続・`player-update`・`report-ping`
2. **mediasoup bot プール**（10）— VC / PDF VC / Video VC

#### D-1 Socket bot プール

**参照（公式）**:

- [Socket.IO v4 — Load testing](https://socket.io/docs/v4/load-testing/)  
  - 段階的クライアント生成（`CLIENT_CREATION_INTERVAL_IN_MS`）  
  - `auth` ペイロード付き handshake  
  - WebSocket トランスポート固定（本番は polling 混在不要）

**本プロジェクトへの適用**:

```text
socket.io-client.connect(serverUrl, {
  transports: ['websocket'],
  auth: { benchToken, username: `bench-{runId}-{n}` },
});
// 接続後: set-username → change-world → player-update @ ~30Hz
// report-ping を Socket.IO 公式 RTT パターン（ping/pong ではなく既存 report-ping）で送信
```

既存クライアントのイベント名は `public/js/network-manager.js`・`server.js` の `player-update` / `report-ping` に合わせる（要件 §7.3）。

**補助参照（OSS）**:

- [scriptoLLC/hammer-time](https://github.com/scriptollc/hammer-time) — generator による認証付き大量接続（CLI ツールだが設計参考）
- 現リポジトリ `scripts/stress-chrome-tabs.bat` はブラウザ手動負荷であり、**本 Runner では採用しない**

#### D-2 mediasoup bot プール（技術選定が必要）

本番クライアントはブラウザ + `mediasoup-client`（`voice-chat-manager.js` 等）。Runner は **Node.js** のため Handler の選択が必要。

| 方式 | 公式性 | メリット | デメリット | R1 推奨 |
|------|--------|----------|------------|---------|
| **mediasoup-client-aiortc** | versatica 公式 | 実 WebRTC・`getStats()` で packetLoss 取得可能 | Python 3 + aiortc 依存（Windows Runner にセットアップ必要） | **本番計測用（推奨）** |
| **FakeHandler** | mediasoup-client 内蔵（テスト用） | 依存少・実装速い | 実 RTP が流れにくく transport stats が意味を持たない可能性 | **M4 プロトタイプのみ** |
| Puppeteer + 実ブラウザ | — | 本番と同一コードパス | 10 bot で重い・運用複雑 | 採用しない |

**参照（公式・実績）**:

- [mediasoup-client API — FakeHandler](https://mediasoup.org/documentation/v3/mediasoup-client/api/)（テスト用）
- [versatica/mediasoup-client-aiortc](https://github.com/versatica/mediasoup-client-aiortc)（Node 本番 WebRTC）
- [versatica/mediasoup-demo](https://github.com/versatica/mediasoup-demo) の `aiortc/` ディレクトリ（Node クライアント実装例）
- [mediasoup RTC Statistics — WebRtcTransport](https://mediasoup.org/documentation/v3/mediasoup/rtc-statistics/)（`rtpPacketLossReceived` / `rtpPacketLossSent`）
- [versatica/mediasoup PR #648](https://github.com/versatica/mediasoup/pull/648)（transport レベル packetLoss の意味と transport-cc 前提）
- [arcas-io/arcas-load-test-mediasoup-example](https://github.com/arcas-io/arcas-load-test-mediasoup-example)（N producer 負荷の soak テスト構成参考。プロトコルは本プロジェクトの `vc-*` に合わせて書き換え）

**本プロジェクト VC イベント（Runner が再実装する順序）**:

| 系統 | join | transport | produce | consume | stats |
|------|------|-----------|---------|---------|-------|
| 通常 VC | `vc-join` | `vc-create-transport` 等 | `vc-produce-audio` | `vc-consume` | transport.getStats |
| PDF VC | `pdf-vc-join`（`pdfPath` 要） | `pdf-vc-*` | `pdf-vc-produce-audio` | `pdf-vc-consume` | 同上 |
| Video VC | `video-vc-join` | `video-vc-*` | `video-vc-set-video` 等 | `video-vc-consume` | 同上 |

参照クライアント: `public/js/voice-chat-manager.js`, `pdf-viewer-voice-chat-manager.js`, `video-chat-manager.js`

**PDF VC の `pdfPath`**: Runner 用にベンチ専用 PDF を 1 つサーバに配置するか、config で既存 PDF パスを指定（プリフライトで存在確認）。

**TURN**: 手元 PC から本番へ UDP が届かない場合は既存 [CLOUDFLARE_TURN_SETUP.md](../CLOUDFLARE_TURN_SETUP.md) の ICE を `vc-join` 応答の `iceServers` 経由で利用（本番 `server.js` 既存実装に合わせる）。

---

### 1.5 領域 E — クライアント（メタバース接続中ユーザーへの警告）

| 項目 | 内容 |
|------|------|
| 対象 | `public/js/network-manager.js` または `main.js` |
| イベント | `bench-maintenance-warning` 受信時にトースト／`alert`（要件 D-03） |
| 影響範囲 | 小（10〜20 行程度） |

---

### 1.6 領域 E — 管理画面 UI

| 項目 | 内容 |
|------|------|
| 新規 | `addons/meta-benchR1/client/admin.js` |
| 登録 | `public/js/addons/registry-admin.js` に import 追加 |
| API ベース | `/admin/addons/meta-benchR1/`（`credentials: 'include'`） |
| P-07 不合格時 | §4.2 の再起動手順をパネル内に常時表示 |

**参照**: `addons/nfc-spawn/client/admin.js`（`apiFetch` + パネルマウントパターン）

---

## 2. 参照資料一覧

### 2.1 本リポジトリ内

| ドキュメント / コード | 用途 |
|----------------------|------|
| [要件定義書(本番).md](./要件定義書(本番).md) | 機能要件の正 |
| [addons/README.md](../addons/README.md) | addon 規約 |
| [addons-restart-policy.md](./addons-restart-policy.md) | D-13 / P-07 運用 |
| `server.js` | Socket / mediasoup / tick |
| `lib/plugin-loader.js`, `lib/plugin-bootstrap.js` | addon 読み込み・カタログ |
| `lib/socket-auth-token.js` | benchToken 設計の雛形 |
| `addons/nfc-spawn/server.js` | `/admin/addons/` API パターン |
| `db/users.js`, `db/addons-registry.js` | SQLite ベンチ対象 |

### 2.2 公式ドキュメント（外部）

| URL | 用途 |
|-----|------|
| https://socket.io/docs/v4/load-testing/ | Socket bot プール設計 |
| https://socket.io/docs/v4/server-api/#serverusefn | 接続ミドルウェア |
| https://nodejs.org/api/worker_threads.html | hw-cpu マルチコア |
| https://nodejs.org/api/process.html#processcpuusagepreviousvalue | mv-degrade CPU 成分 |
| https://nodejs.org/api/os.html#oscpus | サーバスペック・コア数 |
| https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md | db-sqlite 計測（`.prepare().get()` の同期計測） |
| https://mediasoup.org/documentation/v3/mediasoup/rtc-statistics/ | transport.getStats |
| https://mediasoup.org/documentation/v3/mediasoup-client/api/ | Device / Transport / Produce |
| https://github.com/versatica/mediasoup-client-aiortc | Node Runner WebRTC |

### 2.3 OSS（設計参考・プロトコルは本プロジェクトに合わせて移植）

| リポジトリ | 参考にする点 | 採用しない点 |
|-----------|--------------|--------------|
| [versatica/mediasoup-demo](https://github.com/versatica/mediasoup-demo) | aiortc Node クライアント、`aiortc/` サンプル | demo 独自シグナリング |
| [arcas-io/arcas-load-test-mediasoup-example](https://github.com/arcas-io/arcas-load-test-mediasoup-example) | N producer soak、stats ポーリング間隔 | Arcas 固有 API |
| [mkhahani/mediasoup-sample-app](https://github.com/mkhahani/mediasoup-sample-app) | Socket.io + mediasoup 最小構成 | v1/v2 用・イベント名不一致 |
| [scriptollc/hammer-time](https://github.com/scriptollc/hammer-time) | 段階接続・generator 認証 | 汎用 CLI のままでは使わない |

---

## 3. ファイル構成（新規・変更）

```text
lib/
  bench-maintenance.js      # NEW: フラグ、benchToken 検証、メンテ ON/OFF API
  bench-tick-metrics.js     # NEW: ルーム別 tick カウンタ・秒次集計

db/
  users.js                  # MODIFY: bench_users CRUD

server.js                   # MODIFY: io.use、tick カウンタ、isBenchBot、警告 emit フック

addons/meta-benchR1/        # NEW
  plugin.json
  config.json.example
  server.js
  migrations/001_bench_runs.sql
  lib/
    run-orchestrator.js     # run ステートマシン + try/finally
    preflight.js            # P-01〜P-07
    benchmarks/
      hw-cpu.js             # Worker Threads
      hw-mem.js             # 512MB Buffer + checksum
      db-sqlite.js
    scoring.js              # 要件 §7 正規化
    report-html.js          # 日本語 HTML
    runner-registry.js
    bench-token.js          # run スコープ token 発行
  client/
    admin.js
  runner/
    serve.js                # CLI 常駐
    socket-bot-pool.js
    mediasoup-bot-pool.js   # aiortc または FakeHandler（段階導入）
    protocol.js             # 本番 vc-* イベント列の共通化
  reports/                  # .gitkeep

public/js/
  addons/registry-admin.js  # MODIFY: import admin.js
  network-manager.js        # MODIFY: bench-maintenance-warning

docs/
  meta-benchR1-implementation-plan.md  # 本書
```

---

## 4. マイルストーン別実装計画

### M1 — 骨格・メンテ・管理 API（目安 1〜2 週）

**ゴール**: 管理画面から run を作成・参照でき、メンテ ON/OFF が安全に動く（ベンチ本体はダミーフェーズでも可）。

| # | タスク | 領域 | 完了条件 |
|---|--------|------|----------|
| M1-1 | `lib/bench-maintenance.js` 実装 | A | addon から ON/OFF、`io.use` で `BENCH_MAINTENANCE` 拒否、admin/benchToken は通過 |
| M1-2 | `benchToken` 発行・検証（HMAC、TTL） | A | `socket.handshake.auth.benchToken` で `isBenchBot=true` |
| M1-3 | `bench-maintenance-warning` + クライアント受信 | A,E | メンテ ON 時に既存接続へ警告表示 |
| M1-4 | addon 骨格 + migration `bench_runs` | B | `plugin.json`、DB テーブル作成 |
| M1-5 | 管理 API `/admin/addons/meta-benchR1/*` | B | status, pairing-code, runs CRUD, abort |
| M1-6 | 管理 UI タブ（Runner 状態・開始ボタン・P-07 手順表示） | E | registry-admin 登録済み |
| M1-7 | プリフライト P-02,03,04,07 | B | 不合格理由を UI に日本語リスト |
| M1-8 | run タイムアウト 6 分 + `finally` メンテ OFF | B | 異常終了でも D-05 満たす |

**参照**: `nfc-spawn` 管理 API、`socket-auth-token.js`

---

### M2 — サーバ側ベンチ・TPS（目安 1 週）

**ゴール**: hw-cpu / hw-mem / db-sqlite / mv-tps を計測し、部分レポート HTML を出力できる。

| # | タスク | 領域 | 完了条件 |
|---|--------|------|----------|
| M2-1 | `lib/bench-tick-metrics.js` + server フック | A | ベンチ中のみ秒次 tick/s 記録 |
| M2-2 | `hw-cpu.js` | B | `os.cpus().length` ワーカーで CPU-bound タスク、ops/s 算出 |
| M2-3 | `hw-mem.js` | B | 512MB 読み書き + checksum、速度・整合性スコア |
| M2-4 | `db-sqlite.js` | B,C | users / addons_registry / meta-benchR1.db の SELECT+INSERT/DELETE 計測 |
| M2-5 | `scoring.js`（mv-tps, mv-degrade のサーバ側成分） | B | 要件 §7.2 の式を unit test |
| M2-6 | `report-html.js` 最小版 | B | `partial` でも HTML 出力、D-12 項目 |

**hw-cpu 実装指針**（[Node.js worker_threads](https://nodejs.org/api/worker_threads.html)）:

- 親: `os.availableParallelism()` または `os.cpus().length` でワーカー数決定
- 子: 固定回数の素数判定 / 整数演算ループ（I/O なし）
- 計測: `process.hrtime.bigint()` で壁時計時間 → ops/s
- `mv-degrade` 用: ベンチ前 30 秒 `process.cpuUsage()` サンプリングを addon 起動時からバックグラウンドで収集

**hw-mem 実装指針**:

- `Buffer.alloc(512 * 1024 * 1024)` 読み書き
- checksum: `crypto.createHash('sha256').update(buf).digest('hex')` を書き込み前後で比較

---

### M3 — Runner 基盤 + Socket bot（目安 1〜2 週）

**ゴール**: 手元 PC から N bot が接続・移動・ping し、メトリクスが本番に届く。

| # | タスク | 領域 | 完了条件 |
|---|--------|------|----------|
| M3-1 | `POST /api/.../runner/register` + pairing | B | heartbeat 30s、最大 1 台 |
| M3-2 | `runner/serve.js` 常駐 + 本番への Socket 接続 | D | ジョブ受信 `addon:meta-benchR1:job` |
| M3-3 | `socket-bot-pool.js` | D | 公式 load-testing パターンで段階接続 |
| M3-4 | `bench_users` 作成・削除連携 | C | D-09 満たす |
| M3-5 | `POST .../runs/:id/metrics` | B | mv-connect 用 JSON 受信 |
| M3-6 | プリフライト P-01, P-06 | B | Runner 未接続・botCount 超過で開始不可 |

**Socket bot 接続レート**（[Socket.IO load testing](https://socket.io/docs/v4/load-testing/) より）:

- `CLIENT_CREATION_INTERVAL_IN_MS = 50` 程度から開始（100 bot で約 5 秒）
- 全 bot 同時接続は Runner / 本番双方にスパイクを起こすため避ける

---

### M4 — mediasoup bot + audio-vc（目安 2〜3 週・最大リスク）

**ゴール**: 10 bot が VC / PDF VC / Video VC を通し、packetLoss ベースのサブスコアが取れる。

| # | タスク | 領域 | 完了条件 |
|---|--------|------|----------|
| M4-0 | **技術検証スパイク**（1〜2 日） | D | 手元 PC で aiortc 1 本が `vc-join`〜produce〜consume 完了 |
| M4-1 | `runner/protocol.js` | D | 3 系統のイベント列を voice-chat-manager から移植 |
| M4-2 | `mediasoup-bot-pool.js`（aiortc） | D | 10 bot 相互 subscribe |
| M4-3 | transport stats ポーリング | D | 1 秒間隔 `getStats()` → packetLoss 平均 |
| M4-4 | プリフライト P-05 | B | mediasoup 未起動で開始不可 |
| M4-5 | `audio-vc` スコア合成 | B | 3 サブスコア均等平均 |

**スパイク失敗時のフォールバック**（計画として明記）:

1. FakeHandler でパイプラインのみ検証（スコアは参考値、レポートに注記）
2. Runner を Linux + Python 環境に移す（aiortc 公式要件）
3. 要件見直しは**最後の手段**（D-07 は 3 系統必須のため）

---

### M5 — 仕上げ（目安 1 週）

| # | タスク | 完了条件 |
|---|--------|----------|
| M5-1 | HTML レポート完成（日本語・変動注記・マスク） | D-11, D-12 |
| M5-2 | 保持ポリシー（30 件 / 90 日） | §10 |
| M5-3 | `config.json` 校正定数（hw-cpu 80 点基準） | §7.6 |
| M5-4 | 手動テスト手順書（§4.2 運用フロー） | 運用者が再現可能 |
| M5-5 | `node --test` ユニット（scoring, preflight, bench-token） | CI 可能範囲 |

---

## 5. API・プロトコル詳細（実装時の正）

### 5.1 管理 API（`/admin/addons/meta-benchR1/`）

要件 §12.1 のとおり。実装は `HOOKS.EXPRESS_SETUP` 内で **フルパス**登録（`nfc-spawn` と同じ）。

```javascript
app.get('/admin/addons/meta-benchR1/runner/status', ...);
app.post('/admin/addons/meta-benchR1/runs', ...);
// 以下同様
```

### 5.2 Runner API（`/api/addons/meta-benchR1/`）

```javascript
app.post(`${ctx.paths.httpBasePath}/runner/register`, ...);
app.post(`${ctx.paths.httpBasePath}/runs/:id/metrics`, ...);
```

`metrics` は `Authorization: Bearer <benchToken>` または body の `benchToken`（実装時にどちらかに統一）。

### 5.3 Socket ジョブペイロード（案）

```javascript
// 本番 → Runner
socket.emit('addon:meta-benchR1:job', {
  runId,
  benchToken,
  phase: 'socket-bots' | 'audio-vc',
  botCount: 50,
  vcBotCount: 10,
  pdfPath: '/pdfs/bench-dummy.pdf',
  worlds: ['lobby', '...'],
  deadlineMs: 360000,
});

// Runner → 本番（HTTP metrics が主。Socket は進捗通知用 optional）
socket.emit('addon:meta-benchR1:progress', { runId, phase, percent });
```

---

## 6. テスト計画

| 層 | 内容 | ツール |
|----|------|--------|
| 単体 | `scoring.js`, `preflight.js`, `bench-token.js` | `node --test` |
| 統合（ローカル） | M1: メンテ ON → 新規 Socket 拒否、admin 通過 | 手動 + 小さな socket.io-client スクリプト |
| 統合 | M2: ダミー run で HTML 生成 | curl + Basic 認証 |
| E2E | M3〜4: Runner + 本番（meta-benchR1 のみ有効で再起動後） | 手元 PC + ステージング |
| 回帰 | 通常時（ベンチ OFF）既存 VC・ログイン | 既存手動 QA |

**負荷テストの期待値**: Socket.IO 公式ドキュメントの記述どおり、**自前クライアントで十分**であり、Artillery は server-to-client イベントの検証に弱いため R1 では採用しない（[Load testing — Artillery の制限](https://socket.io/docs/v4/load-testing/)）。

---

## 7. 依存関係・環境

### 7.1 本番サーバ（追加 npm）

| パッケージ | 用途 | 備考 |
|-----------|------|------|
| なし（既存で足りる） | mediasoup, better-sqlite3, socket.io は済 | worker_threads は標準ライブラリ |

### 7.2 Runner PC（追加）

| 依存 | 用途 |
|------|------|
| Node.js（本番と同メジャー推奨） | Runner 実行 |
| `socket.io-client`（既に root deps） | Socket bot |
| `mediasoup-client`（既に root deps） | VC bot |
| `mediasoup-client-aiortc` + Python 3 + aiortc | **M4 本番計測用（推奨）** |

Runner はリポジトリ内 `addons/meta-benchR1/runner/` から実行し、root の `node_modules` を参照する形でよい（別 package.json は作らない）。

---

## 8. リスクと対策（実装観点）

| リスク | 影響 | 対策 |
|--------|------|------|
| aiortc が Windows Runner で動かない | M4 遅延 | M4-0 スパイクを最優先。Linux Runner 手順を §4.2 に追記 |
| FakeHandler では packetLoss が取れない | スコア無意味 | 本番は aiortc 必須。Fake は開発のみ |
| 100 bot で Runner メモリ不足 | 接続失敗 | Runner が `recommendedMaxBots` を起動時に宣言（P-06） |
| server.js 改修の回帰 | 本番障害 | bench ロジックは lib に分離。`benchActive` 時のみ分岐 |
| addon 再起動忘れ | P-07 不合格 | 管理 UI に手順常時表示（要件 §13） |
| transport-cc 無効時 packetLoss null | audio-vc N/A | mediasoup 設定確認。stats null 時はレポートに明記 |

---

## 9. 実装順序サマリ（推奨）

```text
Week 1-2:  M1（A + B 骨格 + E 管理 UI）
Week 3:    M2（A tick + B サーバベンチ）
Week 4-5:  M3（D Socket Runner）+ M4-0 スパイク並行
Week 6-7:  M4（D mediasoup Runner）
Week 8:    M5（レポート・運用ドキュメント）
```

**並行作業の推奨**:

- M1 中: 領域 C（bench_users）は M3 直前でも可だが、M2 の db-sqlite テスト用 INSERT に必要なら M2 前に実装
- M4-0 スパイクは M3 と並行し、遅れる場合は早めにフォールバック判断

---

## 10. 変更履歴

| 版 | 日付 | 内容 |
|----|------|------|
| 1.0 | 2026-07-02 | 初版（要件 v1.1 ベース） |

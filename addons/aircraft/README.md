# addons/aircraft — エアークラフト（飛行機）マルチ同期

## バージョン

- **1.1.0** — 管理パネル「飛行機」タブで機体ライブラリ（prefab ZIP・パーツロール・アニメ JSON）を SQLite に保存。`prefabManifest` と `aircraft` の併用、`aircraftLibraryId` による操縦中のエンジンブレード等のローカル表示。

## 有効化

管理画面アドオン一覧で `aircraft` を有効にし、**Node プロセスを再起動**してください。初回セットアップではレジストリが空なら `aircraft` を自動有効化するシードがあります。

## サーバー

- `lib/aircraft-server/` — ルーム状態・worlds 検証・ソケットの `aircraft-board` / `aircraft-exit`
- `server.js` — 上記に加え、機体ライブラリ API（`data/plugin-databases/aircraft.db`）
- イベント名（互換維持）: `aircraft-board`, `aircraft-exit`, `aircraft-initial`, `aircraft-released`, `players-update` の `aircraft` 配列, `player-update` の `aircraftPose`

### HTTP API（アドオン）

| メソッド | パス | 用途 |
|---------|------|------|
| GET | `/admin/addons/aircraft/airframes` | 一覧（Basic 認証） |
| GET | `/admin/addons/aircraft/airframes/:id` | 1 件（Basic 認証） |
| PUT | `/admin/addons/aircraft/airframes/:id` | 作成・更新（JSON、Basic 認証） |
| DELETE | `/admin/addons/aircraft/airframes/:id` | 削除（Basic 認証） |
| GET | `/api/addons/aircraft/airframes/:id` | ゲーム用読み取り専用（定義のみ） |

機体 ID `:id` は `^[a-zA-Z0-9_-]{1,64}$`。

## クライアント

- `client/init.js` が `MetaverseApp` に `AircraftController` / `AircraftManager` を結線
- `public/js/addons/registry-game.js` から `game.js` を読み込み
- 管理画面は `public/js/admin.js` が「飛行機」タブ初回表示時に `client/admin-panel.js` を動的 import

## データ契約（コア）

`worlds.json` の `models[].aircraft` とワールド共通 `aircraftPhysics` は従来どおり。v1.1 から次を追加で利用できます。

### prefab 飛行機（マニフェスト + 操縦）

同一 `models[]` エントリに **`prefabManifest`** と **`aircraft`** を両方指定できます。ZIP アップロードは従来どおり `POST /admin/upload-prefab-zip`（ワールド編集と同じ）。

### 機体ライブラリ ID（任意）

`models[].aircraft.aircraftLibraryId` に、管理画面「飛行機」で登録した機体 ID（例: `b787`）を書くと、クライアントが `GET /api/addons/aircraft/airframes/b787` で定義を取得し、**エンジンブレード**（`bindings.engineBlade` の名前パス + `animation.engineBlade`）に基づきローカルで回転表示します。ネットワークにはプロペラ角を載せません（各クライアントが同じ定義で再現）。

### worlds.json の例

```json
{
  "prefabManifest": "models/MyJet_v_abc123_prefab-manifest.json",
  "position": { "x": 0, "y": 2, "z": 0 },
  "aircraft": {
    "id": "slot1",
    "aircraftLibraryId": "b787",
    "radius": 6,
    "label": "操縦する",
    "cockpitOffset": { "x": 0, "y": 1.5, "z": 0 },
    "chaseOffset": { "x": 0, "y": 4, "z": 14 }
  }
}
```

## パーツロール（管理 UI）

Blender 側で **オブジェクト名をユニークに**し、階層パス（親から `/` 連結）で参照します。再エクスポートで GLTF の `uuid` は変わるため、uuid ではなく名前パスを保存します。

定義可能なロール（v1.1）:

- `engineBlade` — 操縦中のアニメーション実装あり（他は保存のみ）
- `aileron_L` / `aileron_R`
- `flap_L` / `flap_R`
- `landingGear`

## アニメーション JSON（例）

`animation.engineBlade`:

- `maxAccelRadPerS2` — 目標角速度への角加速度上限
- `maxOmegaRadPerS` — 推力相当 1 のときの目標角速度
- `spinAxis` — ローカル軸 `x` | `y` | `z`

操縦中のスロットル相当は「前進方向への速度成分 / `maxSpeed`」と `W` キー押下のブーストから算出します（`aircraft-controller.js` 内コメント参照）。

## Blender / 命名の注意

- 同じ階層に同じ `name` のオブジェクトを置かない（パスが一意でなくなる）。
- 空名は `_unnamed_` としてパス化されるため、意味のある名前を付与すること。

## 手動回帰観点（要約）

搭乗・離脱、二重搭乗拒否、切断・ワールド変更・管理 tp での機体解放、リモート機体姿勢、モバイルで搭乗プロンプト非表示、テレポート E キーと搭乗の競合。v1.1 追加: prefab+aircraft 併用ワールドの読込、ライブラリ API、管理「飛行機」ZIP→ビューア→保存→ゲーム内プロペラ表示。

# SmokeView（smoke-view アドオン）

OpenVDB 系ボリュームを WebGPU（PicoVDB）で表示するアドオン。Phase 1 では **変換ツール** と **Play_VDB 検証ページ** のみ提供します。

## 有効化

1. 管理画面 → アドオン → `smoke-view` を有効化
2. **Node プロセスを再起動**（[addons 再起動ポリシー](../README.md)）

## Phase 1 構成

| パス | 説明 |
|------|------|
| `tools/convert-nvdb-to-pvdb/` | PC 上で `.nvdb` → `.pvdb` 変換（Zig） |
| `play_vdb/` | `/play_vdb` — ローカル `.pvdb` の WebGPU 描画検証 |
| `vendor/picovdb/` | [emcfarlane/picovdb](https://github.com/emcfarlane/picovdb) @ `0.0.1`（submodule） |
| `client/game.js` | 本番メタバース統合は Phase 2（現状スタブ） |

## 検証手順（手持ち OpenVDB から）

### 1. submodule と Zig

```bash
git submodule update --init addons/smoke-view/vendor/picovdb
cd addons/smoke-view/vendor/picovdb
git checkout 0.0.1
```

[Zig](https://ziglang.org/download/) をインストールし、`zig version` が通ることを確認します。

### 2. OpenVDB → NanoVDB（既存ツール）

Houdini 出力や ASWF `nanovdb_convert` 等で `.vdb` → `.nvdb` に変換します（本アドオンの範囲外）。

例:

```bash
nanovdb_convert input.vdb output.nvdb
```

### 3. NanoVDB → PicoVDB（本リポジトリのツール）

```bash
node addons/smoke-view/tools/convert-nvdb-to-pvdb/convert.mjs output.nvdb output.pvdb

# 任意: gzip
node addons/smoke-view/tools/convert-nvdb-to-pvdb/convert.mjs --gzip output.nvdb output.pvdb.gz
```

Windows PowerShell:

```powershell
.\addons\smoke-view\tools\convert-nvdb-to-pvdb\convert.ps1 output.nvdb output.pvdb
```

初回は `vendor/picovdb` で `zig build` が自動実行されます。

### 4. Play_VDB で描画確認

1. サーバー起動、`smoke-view` アドオン有効化済みであること
2. Chrome / Edge で `http://localhost:3000/play_vdb` を開く（**localhost または HTTPS** — WebGPU 要件）
3. 「.pvdb / .pvdb.gz を開く」から変換済みファイルを選択
4. ボリュームが表示され、パネルにグリッド型（`FOG_FLOAT` 等）・ボクセル数が出れば成功

**操作**: ドラッグ=回転、ホイール=ズーム、Alt+ドラッグ=パン

### 失敗時の切り分け

| 症状 | 原因の例 |
|------|----------|
| `/play_vdb` が 404 | アドオン未有効化 or サーバー未再起動 |
| WebGPU 非対応 | Firefox 古い版、非 secure context |
| シェーダーエラー | ブラウザの WebGPU 実装差（Chrome/Edge 推奨） |
| Invalid PicoVDB magic | `.nvdb` をそのまま開いている（`.pvdb` に変換が必要） |
| zig build 失敗 | Zig 未インストール / vendor submodule 未取得 |

## ライセンス（vendor）

PicoVDB コンバータ・WGSL・パーサーは `vendor/picovdb`（submodule）に含まれます。利用時は同梱のライセンス表記に従ってください。

## Phase 2（未実装）

- Three.js WebGL + WebGPU オーバーレイ（案 A）
- ワールド編集・`.vdb` アップロード・`worlds.json` 統合
- 本番メタバース `client/game.js` でのボリューム表示

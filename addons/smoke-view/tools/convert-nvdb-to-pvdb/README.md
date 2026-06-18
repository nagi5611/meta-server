# nvdb → pvdb 変換ツール

PC 上で NanoVDB (`.nvdb`) を PicoVDB (`.pvdb`) に変換します。SmokeView Play_VDB は `.pvdb` / `.pvdb.gz` を読み込みます。

## 前提

1. **Zig 0.15.2**（PicoVDB 0.0.1 は 0.16 / 0.17 dev 非対応）
   - 推奨: [Zig 0.15.2](https://ziglang.org/download/0.15.2/) を解凍し  
     `addons/smoke-view/tools/zig-0.15.2/zig-x86_64-windows-0.15.2/` に配置
   - `C:\Program Files\zig` の **0.17 dev** は `lib/std` が欠けていることがあり、このツールでは使えません
2. リポジトリで submodule を取得済みであること:

```bash
git submodule update --init addons/smoke-view/vendor/picovdb
cd addons/smoke-view/vendor/picovdb
git checkout 0.0.1
```

## 全体ワークフロー（OpenVDB から）

```text
your.smoke.vdb
  └─ nanovdb_convert your.smoke.vdb out.nvdb   # ASWF 公式（本ツールの範囲外）
       └─ node convert.mjs out.nvdb out.pvdb
            └─ Play_VDB でファイルピッカーから開く
```

## 使い方

```bash
# リポジトリルートから
node addons/smoke-view/tools/convert-nvdb-to-pvdb/convert.mjs input.nvdb output.pvdb

# gzip 圧縮
node addons/smoke-view/tools/convert-nvdb-to-pvdb/convert.mjs --gzip input.nvdb output.pvdb.gz
```

Windows PowerShell:

```powershell
.\addons\smoke-view\tools\convert-nvdb-to-pvdb\convert.ps1 input.nvdb output.pvdb
.\addons\smoke-view\tools\convert-nvdb-to-pvdb\convert.ps1 --gzip input.nvdb output.pvdb.gz
```

初回実行時、`vendor/picovdb` で `zig build --fetch` と `zig build` が自動実行されます（Windows では OpenVDB ヘッダーのパッチも実行）。

## トラブルシュート

### `unable to find zig installation directory 'C:\Program Files\zig\zig.exe'`

`Program Files` 配下の Zig で `ZIG_LIB_DIR` 解決に失敗することがあります。  
**Zig 0.15.2** をスペースのないパス（`addons/smoke-view/tools/zig-0.15.2/...`）に置くか、`convert.mjs` が同梱 Zig を優先します。

### `hash mismatch` on openvdb

`vendor/picovdb/build.zig.zon` の OpenVDB 依存は smoke-view 用に **master 固定ハッシュ**へ更新済みです。  
再取得時は `zig fetch` で新ハッシュを確認してください。

### Windows で `static` / `__forceinline` の C import エラー

初回ビルド時に `patch-openvdb-headers.mjs` が Zig キャッシュ内の `PNanoVDB.h` を自動パッチします。  
手動: `node addons/smoke-view/tools/convert-nvdb-to-pvdb/patch-openvdb-headers.mjs`

### 変換結果が 0 grids

入力 `.nvdb` が空、または `nanovdb_convert` の出力形式が PicoVDB コンバータの想定と異なる可能性があります。  
別の `.nvdb` で試すか、`nanovdb_convert` のオプションを確認してください。

## ライセンス

コンバータ本体は [emcfarlane/picovdb](https://github.com/emcfarlane/picovdb)（vendor submodule）に含まれます。

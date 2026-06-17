# nvdb → pvdb 変換ツール

PC 上で NanoVDB (`.nvdb`) を PicoVDB (`.pvdb`) に変換します。SmokeView Play_VDB は `.pvdb` / `.pvdb.gz` を読み込みます。

## 前提

1. [Zig](https://ziglang.org/download/) が `PATH` にあること
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

初回実行時、`vendor/picovdb` で `zig build` が自動実行されます。

## ライセンス

コンバータ本体は [emcfarlane/picovdb](https://github.com/emcfarlane/picovdb)（vendor submodule）に含まれます。

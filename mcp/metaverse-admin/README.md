# metaverse-admin MCP

Cursor から家メタバースの**管理パネルと同じ HTTP API**（`/admin/*`・`/host-monitor/*`）を呼び出す MCP サーバーです。**SSH ではありません。**

## meta / metair の 2 本立て（パスワード別）

同一物理サーバー上の **別 Node プロセス**向けに MCP を 2 つ登録します。パスワードは **インスタンスごとに別 env / Secret** にします（チャットに書かない）。

| MCP 名（例） | `META_ADMIN_INSTANCE` | `META_ADMIN_BASE_URL` | パスワード env |
|--------------|----------------------|------------------------|----------------|
| `metaverse-admin-meta` | `meta` | `https://meta.mmh-virtual.jp` | `META_ADMIN_PASSWORD` または `_B64` |
| `metaverse-admin-metair` | `metair` | `https://metair.mmh-virtual.jp` | `METAIR_ADMIN_PASSWORD` または `_B64` |

任意: metair だけユーザー名が違う場合は `METAIR_ADMIN_USERNAME`（未設定時は `META_ADMIN_USERNAME` → `admin`）。

判定順: `META_ADMIN_INSTANCE` → `META_ADMIN_BASE_URL` のホスト名 → 既定は meta。

## 前提

- 各インスタンスの `.env` にある **ADMIN_USERNAME / ADMIN_PASSWORD** と同じ値
- POST 等は **CSRF**（MCP 側で自動取得）

## セットアップ（Desktop）

1. `cd mcp/metaverse-admin && npm install`

2. env ファイル（**gitignore。コミットしない**）:

   ```bash
   cp .env.mcp.meta.example .env.mcp.meta
   cp .env.mcp.metair.example .env.mcp.metair
   ```

   各ファイルにパスワード（平文または Base64）を入れる。

3. `.cursor/mcp.json.example` → `.cursor/mcp.json`（`envFile` が `.env.mcp.meta` / `.env.mcp.metair` を指す）

4. Cursor 再読み込み → 両 MCP が接続済みになることを確認。

## Cloud Agent

Environment Secrets（**ダッシュボード登録。チャット不要**）:

| Secret | 用途 |
|--------|------|
| `META_ADMIN_PASSWORD` または `META_ADMIN_PASSWORD_B64` | meta MCP |
| `METAIR_ADMIN_PASSWORD` または `METAIR_ADMIN_PASSWORD_B64` | metair MCP |

MCP 子プロセスに Secret が渡る構成なら、`envFile` は空でも `META_ADMIN_INSTANCE` + 上記 Secret で動作します。ローカルと同様に `.env.mcp.*` を使っても構いません。

## ツール

| ツール | 用途 |
|--------|------|
| `metaverse_admin_get` | GET（`/admin/stats`, `/admin/worlds`, …） |
| `metaverse_admin_write` | 変更系（`confirmWrite: true` 必須） |

## 環境変数一覧

| 変数 | 用途 |
|------|------|
| `META_ADMIN_INSTANCE` | `meta` / `metair`（推奨） |
| `META_ADMIN_BASE_URL` | origin |
| `META_ADMIN_USERNAME` / `META_ADMIN_PASSWORD` / `_B64` | meta 用 Basic |
| `METAIR_ADMIN_USERNAME` | metair 用ユーザー（任意） |
| `METAIR_ADMIN_PASSWORD` / `METAIR_ADMIN_PASSWORD_B64` | metair 用 Basic |

## セキュリティ

- パスワードをチャット・リポジトリ・ログに載せない
- `metaverse_admin_write` は破壊的操作を含む — 実行前に意図を確認すること

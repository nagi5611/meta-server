# metaverse-admin MCP

Cursor から家メタバースの**管理パネルと同じ HTTP API**（`/admin/*`・`/host-monitor/*`）を呼び出す MCP サーバーです。**SSH ではありません。**

## meta / metair の 2 本立て

同一サーバー上の **別 Node プロセス**（別ドメイン・別 `.env`）向けに、Cursor では **MCP エントリを 2 つ**登録します（中身は同じ `index.js`、環境変数 `META_ADMIN_BASE_URL` だけ変える）。

| MCP 名（例） | `META_ADMIN_BASE_URL` |
|--------------|------------------------|
| `metaverse-admin-meta` | `https://meta.mmh-virtual.jp` |
| `metaverse-admin-metair` | `https://metair.mmh-virtual.jp` |

リポジトリの [.cursor/mcp.json.example](../../.cursor/mcp.json.example) を参照。

## 前提

- 管理画面と同じ **Basic 認証**（`ADMIN_USERNAME` / `ADMIN_PASSWORD`）
- POST 等は管理画面と同様 **CSRF**（MCP 側で自動取得）

## セットアップ

1. 依存関係（初回のみ）:

   ```bash
   cd mcp/metaverse-admin
   npm install
   ```

2. 認証用 env ファイル:

   ```bash
   cp .env.mcp.example .env.mcp
   ```

   `.env.mcp` に `META_ADMIN_PASSWORD` または `META_ADMIN_PASSWORD_B64` を設定（**git にコミットしない**）。

3. Cursor MCP 設定（プロジェクト例）:

   - リポジトリの `.cursor/mcp.json.example` を `.cursor/mcp.json` にコピー
   - または Cursor Settings → MCP に同等のエントリを追加

   Windows パス例:

   ```json
   {
     "mcpServers": {
       "metaverse-admin": {
         "command": "node",
         "args": ["D:/myprojects/meta/server/metaverse-simple/mcp/metaverse-admin/index.js"],
         "envFile": "D:/myprojects/meta/server/metaverse-simple/mcp/metaverse-admin/.env.mcp"
       }
     }
   }
   ```

4. Cursor を再読み込みし、MCP `metaverse-admin` が緑（接続済み）になることを確認。

## ツール

| ツール | 用途 |
|--------|------|
| `metaverse_admin_get` | GET（`/admin/stats`, `/admin/worlds`, `/admin/players`, `/host-monitor/api/status` 等） |
| `metaverse_admin_write` | POST/PUT/PATCH/DELETE（`confirmWrite: true` 必須） |

## 環境変数

| 変数 | 既定 | 説明 |
|------|------|------|
| `META_ADMIN_BASE_URL` | `https://meta.mmh-virtual.jp` | サーバー origin（末尾 `/` なし） |
| `META_ADMIN_USERNAME` | `admin` | Basic ユーザー |
| `META_ADMIN_PASSWORD` | — | Basic パスワード（平文） |
| `META_ADMIN_PASSWORD_B64` | — | パスワードの Base64（平文と排他推奨） |

## セキュリティ

- パスワードをチャット・リポジトリ・ログに載せない
- `metaverse_admin_write` はキック・再起動・ワールド上書き等を含む — エージェントに任せる前に意図を確認すること

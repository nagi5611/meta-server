# 管理・非常用ライン（nagi-s1.f5.si）— **廃止（2026-11）**

**`nagi-s1.f5.si` 向けの HTTP hub（`hub-server.service` / 127.0.0.1:3000）は廃止しました。**  
メインのメタバース（`https://meta.mmh-virtual.jp/` → nginx → `127.0.0.1:3001` / `meta-server.service`）は従来どおりです。

## 廃止したもの（meta-server 同一台）

| 項目 | 内容 |
|------|------|
| systemd | `hub-server.service`（停止・無効化・ユニット削除） |
| 環境 | `/home/nagi/hub-server/hub.env` |
| nginx | `sites-enabled/nagi-s1-f5si.conf`（および sites-available の同ファイル） |
| meta `.env` | `PROXY_DOMAIN_PORT_MAP` から `nagi-s1.f5.si=3000` を削除 |

## DNS（リポジトリ外・手動）

このリポジトリには **DNS レコードの API や IaC はありません**。`nagi-s1.f5.si` の A/AAAA レコードは、運用中の DNS 管理（例: さくらの DNS、`f5.si` ゾーン）で **削除または無効化**してください。  
削除前は名前解決だけ残り、nginx 上の vhost が無いため **301/404/502 など不定**になり得ます。

## ホスト監視（`/host-monitor/`）を使う場合

別ホスト名は使わず、次のいずれかを検討してください。

- 管理用 VPN / SSH トンネル経由で `127.0.0.1:3001/host-monitor/`（`HOST_MONITOR_UNITS` を meta 用 `.env` に設定）
- 新しい管理専用 vhost を **HTTPS + 認証** で設計し直す（旧 nagi-s1 平文 HTTP hub は復活させない）

## meta / metair（2 インスタンス）

同一物理サーバー（`meta-server`）上の **別 git clone・別 systemd・別 nginx バックエンド** です。

| 名前 | systemd | ディレクトリ | ドメイン | ローカル port |
|------|---------|--------------|----------|---------------|
| meta | `meta-server.service` | `/home/nagi/meta-server` | `meta.mmh-virtual.jp` | 3001 |
| metair | `metair-server.service` | `/home/nagi/diorama/meta-server` | `metair.mmh-virtual.jp` | 3002 |

リモートはいずれも `https://github.com/nagi5611/meta-server`（本番時点の commit はインスタンスごとに異なり得る）。

## Cloud Agent からの SSH（シェル）

環境 Secrets（例）:

- `META_PROD_SSH_HOST` — 通常 `meta.mmh-virtual.jp` または `nagi-s1.f5.si`（同一ホスト）
- `META_PROD_SSH_USER` — `cursor`
- `META_PROD_SSH_PASSWORD`

`cursor` ユーザーは **passwordless sudo (ALL)** のため、上記 3 つがあれば Cloud Agent は `sshpass` + SSH で **systemctl / nginx / `/home/nagi/*` の読み取り・編集** が可能です（本番 `.env` は `nagi` 所有のため sudo が必要）。

SSH だけでは **管理 API の Basic パスワードは取れない**（`.env` に平文があるが、エージェントは Secrets または MCP 経由が望ましい）。

## Cloud Agent / Cursor Desktop 向け MCP（HTTP 管理 API）

SSH MCP ではなく、リポジトリ内 **`mcp/metaverse-admin`**（stdio MCP）が **HTTPS の `/admin/*`・`/host-monitor/*`** を呼びます。

1. `cd mcp/metaverse-admin && npm install`
2. `cp .env.mcp.example .env.mcp` に `META_ADMIN_PASSWORD` または `META_ADMIN_PASSWORD_B64`（**git 禁止**）
3. `.cursor/mcp.json.example` を `.cursor/mcp.json` にコピー（**meta / metair の 2 エントリ** — `META_ADMIN_BASE_URL` のみ差し替え）
4. **Cloud Agent**: ダッシュボード Environment Secrets に `META_ADMIN_PASSWORD`（または `_B64`）を追加。MCP を有効化したうえで `.cursor/mcp.json` 相当を環境に登録

ツール: `metaverse_admin_get` / `metaverse_admin_write`（変更系は `confirmWrite: true`）。

詳細: [../../mcp/metaverse-admin/README.md](../../mcp/metaverse-admin/README.md)


- [../sites-available/nagi-s1-f5si.conf.example](../sites-available/nagi-s1-f5si.conf.example) — **RETIRED** 注記付き
- [../../systemd/hub-server.service.example](../../systemd/hub-server.service.example) — **RETIRED** 注記付き
- [../sites-available/metaverse-proxy.ex01.conf.example](../sites-available/metaverse-proxy.ex01.conf.example) — ex01 ポート分離の参考（hub 行は廃止）

旧ハンドオフ手順の詳細は git 履歴を参照してください。

---
name: home-meta-server
description: >-
  SSH to the home metaverse server (192.168.0.74 / meta.mmh-virtual.jp) as user
  cursor using Base64-encoded credentials and paramiko, then report OS, disk,
  memory, services, and Node metaverse processes. Use when the user asks about
  the home server, meta-server, 192.168.0.74, meta.mmh-virtual.jp SSH, or server
  health checks on that host.
---

# home-meta-server（家のメタバースサーバー SSH・状態確認）

## 接続先

1. 家のメタバースサーバーへは **192.168.0.74** または **meta.mmh-virtual.jp** に SSH する。
2. ユーザー名は **cursor**。

## 認証（パスワードの扱い）

3. パスワードはチャットに **Base64（UTF-8）** で送ってもらい、エージェント側でデコードして **paramiko** 等で SSH 接続する。
   - 平文パスワードは **チャット・ログ・コマンドライン引数に書かない**。
   - 推奨: 環境変数 `META_SSH_PASS_B64` にユーザーがセットするか、チャットで受け取った Base64 を **プロセス環境変数経由のみ** Python スクリプトに渡す（`python script.py` の argv にパスワードを載せない）。
   - デコード例（スクリプト内）: `base64.b64decode(padded, validate=True).decode("utf-8")`。Base64 が不正な場合はユーザーに再送を依頼する（平文フォールバックは使わない）。

## 接続後に確認して報告する項目

4. 接続後は次を確認し、結果を報告する。
   - **OS**: `uname -a`, `/etc/os-release`
   - **ディスク**: `df -h /`
   - **メモリ**: `free -h`
   - **主要サービス**: 少なくとも `nginx`, `apache2` の `systemctl is-active`、必要なら `systemctl list-units --type=service --state=running` のサンプル
   - **メタバース関連**: `meta-server.service`, `metair-server.service`, `metadogo-server.service`, `metapre-server.service` 等の状態、`pgrep -af 'node server'`（`node server.js`）
   - **待ち受け**: `ss -tlnp` で `:80`, `:443`, `:3001`〜等（nginx → Node バックエンド構成を想定）

## 認証失敗時

5. 認証失敗時は **試したユーザー名**（通常 `cursor`）を報告し、サーバー側での **パスワード確認**（`passwd cursor`、sshd の `PasswordAuthentication`、ユーザー存在）を促す。

## メモ（履歴）

6. 以前 **`nagi`** ユーザーでも接続実績があった。現在の標準ユーザーは **cursor** とする。`nagi` は診断時のみ、ユーザー指示がある場合に限り試行してよい。

## Cursor MCP（管理パネル API）

SSH の代わりに **管理 HTTP API** を Cursor から触る場合は、リポジトリの MCP サーバー `mcp/metaverse-admin` を使う。

1. `mcp/metaverse-admin` で `npm install`、`.env.mcp.example` → `.env.mcp` に `META_ADMIN_PASSWORD` または `META_ADMIN_PASSWORD_B64` を設定。
2. `.cursor/mcp.json.example` を `.cursor/mcp.json` にコピー（または Cursor Settings → MCP に同内容を登録）。
3. ツール: `metaverse_admin_get`（例 `/admin/stats`）、`metaverse_admin_write`（変更系は `confirmWrite: true` 必須）。

詳細は `mcp/metaverse-admin/README.md`。

## 実装メモ

- 鍵認証のみ（`ssh -o BatchMode=yes`）が失敗する場合は、上記 Base64 + paramiko 方式を使う。
- 一時的な接続用 Python スクリプトをワークスペースに置く場合は、実行後に削除するか、リポジトリにコミットしない（秘密をハードコードしない）。
- 本番 Web は nginx が 443/80、Node は `127.0.0.1:300x` で待ち受ける構成が多い（Apache を有効にすると 80 番競合で nginx が落ちる事例あり）。

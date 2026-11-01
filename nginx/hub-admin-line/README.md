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

## 歴史資料（テンプレのみ・デプロイしない）

- [../sites-available/nagi-s1-f5si.conf.example](../sites-available/nagi-s1-f5si.conf.example) — **RETIRED** 注記付き
- [../../systemd/hub-server.service.example](../../systemd/hub-server.service.example) — **RETIRED** 注記付き
- [../sites-available/metaverse-proxy.ex01.conf.example](../sites-available/metaverse-proxy.ex01.conf.example) — ex01 ポート分離の参考（hub 行は廃止）

旧ハンドオフ手順の詳細は git 履歴を参照してください。

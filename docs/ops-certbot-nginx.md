# 本番 SSL / certbot 運用（再発防止）

家サーバー（nginx TLS 終端）向け。詳細は [nginx/README.md](../nginx/README.md) の Let's Encrypt 節。

## 一度だけ（本番）

```bash
cd /home/nagi/meta-server   # 実際の clone パス
git pull
sudo bash scripts/ops/install-certbot-nginx-hooks.sh
```

## 日常

| 確認 | コマンド |
|------|----------|
| 証明書パス + nginx 構文 | `sudo /usr/local/bin/mmh-verify-nginx-ssl` |
| 更新ドライラン | `sudo certbot renew --dry-run` |

## 障害パターン（2026-11 実例）

1. **standalone renew** → 80 番競合 → meta/metair 失効 → TLS/526
2. **旧 lineage 削除** 後、`metaprehub` vhost が `/etc/letsencrypt/live/meta.mmh-virtual.jp/` を参照 → **nginx 起動失敗** → 全 URL 不通（証明書自体は VALID でも 443 が死ぬ）

## スクリプト

| ファイル | 役割 |
|----------|------|
| `certbot-deploy-reload-nginx.sh` | certbot deploy-hook: `nginx -t` 後 reload |
| `verify-nginx-ssl-paths.sh` | `ssl_certificate` 先の実ファイル + `nginx -t` |
| `install-certbot-nginx-hooks.sh` | 上記を `/etc/letsencrypt/...` と cron に配置 |

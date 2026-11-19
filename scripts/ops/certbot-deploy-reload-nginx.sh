#!/usr/bin/env bash
# scripts/ops/certbot-deploy-reload-nginx.sh — certbot renew 成功後に nginx を検証して reload
set -euo pipefail

if ! command -v nginx >/dev/null 2>&1; then
  echo "[certbot-deploy] nginx not installed; skip" >&2
  exit 0
fi

if ! nginx -t 2>&1; then
  echo "[certbot-deploy] nginx -t failed after cert renew; NOT reloading (fix ssl_certificate paths)" >&2
  exit 1
fi

systemctl reload nginx
echo "[certbot-deploy] nginx reloaded OK"

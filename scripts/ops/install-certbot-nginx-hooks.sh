#!/usr/bin/env bash
# scripts/ops/install-certbot-nginx-hooks.sh — 本番サーバーで certbot deploy-hook と日次 SSL 監査を入れる
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_HOOK_SRC="$ROOT/scripts/ops/certbot-deploy-reload-nginx.sh"
VERIFY_SRC="$ROOT/scripts/ops/verify-nginx-ssl-paths.sh"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

install -m 755 "$DEPLOY_HOOK_SRC" /etc/letsencrypt/renewal-hooks/deploy/99-mmh-reload-nginx.sh
install -m 755 "$VERIFY_SRC" /usr/local/bin/mmh-verify-nginx-ssl

CRON_FILE="/etc/cron.d/mmh-nginx-ssl-verify"
cat > "$CRON_FILE" << 'EOF'
# 証明書パス欠落で nginx が起動不能になるのを早めに検知（毎日 06:30 JST = 21:30 UTC）
30 21 * * * root /usr/local/bin/mmh-verify-nginx-ssl || logger -t mmh-verify-nginx-ssl "nginx SSL path check FAILED"
EOF
chmod 644 "$CRON_FILE"

# standalone 更新設定を nginx プラグインへ（80 番競合で renew 失敗しないように）
if command -v certbot >/dev/null 2>&1; then
  for conf in /etc/letsencrypt/renewal/*.conf; do
    [[ -f "$conf" ]] || continue
    if grep -q '^authenticator = standalone' "$conf"; then
      echo "WARN: $conf still uses standalone — run: certbot certonly --nginx -d <domains> --force-renewal" >&2
    fi
  done
fi

/usr/local/bin/mmh-verify-nginx-ssl
echo "Installed deploy hook and daily verify cron."

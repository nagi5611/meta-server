#!/usr/bin/env bash
# scripts/ops/verify-nginx-ssl-paths.sh — nginx が参照する証明書ファイルの存在と nginx -t を確認
set -euo pipefail

shopt -s nullglob
conf_dirs=(/etc/nginx/sites-enabled /etc/nginx/conf.d)

missing=0
for dir in "${conf_dirs[@]}"; do
  [[ -d "$dir" ]] || continue
  while IFS= read -r line; do
    path="${line#*ssl_certificate[[:space:]]}"
    path="${path%;*}"
    path="${path%%#*}"
    path="$(echo "$path" | tr -d '[:space:]')"
    [[ -z "$path" || "$path" == *_key* ]] && continue
    if [[ ! -f "$path" ]]; then
      echo "MISSING: $path (from $line)" >&2
      missing=1
    fi
  done < <(grep -Rh 'ssl_certificate[[:space:]]' "$dir" 2>/dev/null || true)
done

if [[ "$missing" -ne 0 ]]; then
  echo "[verify-nginx-ssl] one or more certificate files are missing" >&2
  exit 1
fi

if ! nginx -t 2>&1; then
  echo "[verify-nginx-ssl] nginx -t failed" >&2
  exit 1
fi

echo "[verify-nginx-ssl] OK"

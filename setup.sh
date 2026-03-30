#!/usr/bin/env bash
set -euo pipefail

# 起動中の Node サーバー（npm run start / node server.js）を停止
if command -v pgrep >/dev/null 2>&1; then
  mapfile -t TARGET_PIDS < <(
    {
      pgrep -f "npm(\\.cmd)?(\\s+run)?\\s+start" || true
      pgrep -f "node(\\.exe)?\\s+server\\.js" || true
    } | sort -u
  )

  if [ "${#TARGET_PIDS[@]}" -gt 0 ]; then
    echo "Stopping existing Node server processes: ${TARGET_PIDS[*]}"
    kill "${TARGET_PIDS[@]}" 2>/dev/null || true
    sleep 2

    for pid in "${TARGET_PIDS[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi
fi

# 日付フォーマット: 月日-時間（例: 0311-2244）
TS="$(date +'%m%d-%H%M')"
# 既存フォルダをバックアップ
cp -r meta-server "meta-server-old${TS}"
# 既存フォルダを削除
rm -rf meta-server
# 再クローン
git clone https://github.com/nagi5611/meta-server
cd meta-server
# 依存関係インストール（package-lock.json 前提）
npm ci
# 脆弱性の自動修正
npm audit fix
# ビルド
npm run build

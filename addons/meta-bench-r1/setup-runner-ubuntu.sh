#!/usr/bin/env bash
# addons/meta-bench-r1/setup-runner-ubuntu.sh — Ubuntu / EC2 向け Bench Runner セットアップ
#
# 使い方（例）:
#   export BENCH_SERVER=https://metapre.mmh-virtual.jp
#   export BENCH_RUNNER_SECRET='サーバー config.json の runnerSecret'
#   export BENCH_RUNNER_NAME=ec2-runner-a
#   bash addons/meta-bench-r1/setup-runner-ubuntu.sh
#
# クローンから全部やる場合:
#   export REPO_URL=https://github.com/your-org/metaverse-simple.git
#   export REPO_DIR=$HOME/metaverse-simple
#   bash setup-runner-ubuntu.sh
#
# 依存だけ入れて Runner は起動しない:
#   INSTALL_ONLY=1 bash setup-runner-ubuntu.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

REPO_URL="${REPO_URL:-}"
REPO_DIR="${REPO_DIR:-$DEFAULT_REPO_ROOT}"
BENCH_SERVER="${BENCH_SERVER:-https://metapre.mmh-virtual.jp}"
BENCH_RUNNER_SECRET="${BENCH_RUNNER_SECRET:-}"
BENCH_RUNNER_NAME="${BENCH_RUNNER_NAME:-ec2-runner}"
BENCH_MAX_BOTS="${BENCH_MAX_BOTS:-50}"
INSTALL_ONLY="${INSTALL_ONLY:-0}"
NODE_MAJOR="${NODE_MAJOR:-22}"

log() {
    printf '[setup-runner] %s\n' "$*"
}

die() {
    printf '[setup-runner] ERROR: %s\n' "$*" >&2
    exit 1
}

if [[ "$(uname -s)" != "Linux" ]]; then
    die "このスクリプトは Linux（Ubuntu 等）専用です。"
fi

log "システム依存をインストールします…"
sudo apt-get update -qq
sudo apt-get install -y \
    git curl ca-certificates \
    build-essential python3 python3-pip python3-venv pkg-config

if ! command -v node >/dev/null 2>&1 || ! node -v | grep -q "v${NODE_MAJOR}\\."; then
    log "Node.js ${NODE_MAJOR}.x をインストールします…"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
    sudo apt-get install -y nodejs
fi

log "Node: $(node -v) / npm: $(npm -v)"

if [[ -f "$REPO_DIR/package.json" ]] && grep -q '"meta-server"' "$REPO_DIR/package.json" 2>/dev/null; then
    log "既存リポジトリを使用: $REPO_DIR"
else
    [[ -n "$REPO_URL" ]] || die "REPO_URL が未設定です。clone 先 URL を export REPO_URL=... で指定するか、リポジトリ root で実行してください。"
    if [[ -d "$REPO_DIR/.git" ]]; then
        log "既存 clone を更新: $REPO_DIR"
        git -C "$REPO_DIR" pull --ff-only
    else
        log "clone: $REPO_URL -> $REPO_DIR"
        git clone "$REPO_URL" "$REPO_DIR"
    fi
fi

cd "$REPO_DIR"

log "npm install（Runner 用: mediasoup worker 等の postinstall をスキップ）…"
log "※ 通常の npm install は mediasoup の Python/pip ビルドが走り EC2 で失敗しやすいです"
npm run bench:install-runner-deps

log "mediasoup-client-aiortc をインストール…"
npm run bench:install-aiortc

if [[ "$INSTALL_ONLY" == "1" ]]; then
    log "INSTALL_ONLY=1 のため Runner は起動しません。"
    log "EC2 1時間自動停止（任意）: sudo bash $SCRIPT_DIR/install-ec2-max-uptime-guard.sh"
    log "起動例:"
    log "  cd $REPO_DIR"
    log "  node addons/meta-bench-r1/runner/serve.js \\"
    log "    --server $BENCH_SERVER \\"
    log "    --secret \"\$BENCH_RUNNER_SECRET\" \\"
    log "    --name $BENCH_RUNNER_NAME \\"
    log "    --max-bots $BENCH_MAX_BOTS \\"
    log "    --debug"
    exit 0
fi

[[ -n "$BENCH_RUNNER_SECRET" ]] || die "BENCH_RUNNER_SECRET が未設定です（サーバー addons/meta-bench-r1/config.json の runnerSecret）。"

log "EC2 1時間自動停止（推奨）: sudo bash $SCRIPT_DIR/install-ec2-max-uptime-guard.sh"

log "Bench Runner を起動します（Ctrl+C で停止）…"
exec node addons/meta-bench-r1/runner/serve.js \
    --server "$BENCH_SERVER" \
    --secret "$BENCH_RUNNER_SECRET" \
    --name "$BENCH_RUNNER_NAME" \
    --max-bots "$BENCH_MAX_BOTS" \
    --debug

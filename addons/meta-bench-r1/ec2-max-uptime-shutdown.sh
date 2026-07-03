#!/usr/bin/env bash
# addons/meta-bench-r1/ec2-max-uptime-shutdown.sh
# EC2 Bench Runner 用: 起動から MAX_UPTIME_SECONDS 経過で強制シャットダウン
#
# cron から毎分実行する想定（root）。手動確認:
#   sudo MAX_UPTIME_SECONDS=3600 bash ec2-max-uptime-shutdown.sh
#
# インストール:
#   sudo bash addons/meta-bench-r1/install-ec2-max-uptime-guard.sh

set -euo pipefail

MAX_UPTIME_SECONDS="${MAX_UPTIME_SECONDS:-3600}"
LOG_TAG="[ec2-max-uptime]"
LOG_FILE="${LOG_FILE:-/var/log/ec2-max-uptime-shutdown.log}"

log() {
    local line
    line="$(date -Is) ${LOG_TAG} $*"
    echo "$line"
    if [[ -w "$(dirname "$LOG_FILE")" ]] 2>/dev/null || [[ "$EUID" -eq 0 ]]; then
        echo "$line" >>"$LOG_FILE" 2>/dev/null || true
    fi
}

read_uptime_seconds() {
    awk '{print int($1)}' /proc/uptime
}

main() {
    if [[ ! -r /proc/uptime ]]; then
        log "ERROR: /proc/uptime を読めません"
        exit 1
    fi

    local uptime_sec
    uptime_sec="$(read_uptime_seconds)"

    if [[ "$uptime_sec" -lt "$MAX_UPTIME_SECONDS" ]]; then
        exit 0
    fi

    log "uptime=${uptime_sec}s >= limit=${MAX_UPTIME_SECONDS}s — 強制シャットダウンします"
    /sbin/shutdown -h now "ec2-max-uptime: ${MAX_UPTIME_SECONDS}s exceeded"
}

main "$@"

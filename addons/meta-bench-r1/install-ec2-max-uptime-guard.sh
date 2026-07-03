#!/usr/bin/env bash
# addons/meta-bench-r1/install-ec2-max-uptime-guard.sh
# EC2 に「起動から最大1時間」ガードを入れる（cron + 起動時 shutdown 予約）
#
#   sudo bash addons/meta-bench-r1/install-ec2-max-uptime-guard.sh
#
# 上限秒数を変える場合:
#   sudo MAX_UPTIME_SECONDS=3600 bash install-ec2-max-uptime-guard.sh

set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    echo "root で実行してください: sudo bash $0" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MAX_UPTIME_SECONDS="${MAX_UPTIME_SECONDS:-3600}"
INSTALL_DIR="/usr/local/sbin"
SHUTDOWN_SCRIPT="${INSTALL_DIR}/ec2-max-uptime-shutdown.sh"
BOOT_SCRIPT="${INSTALL_DIR}/ec2-max-uptime-schedule-at-boot.sh"
CRON_FILE="/etc/cron.d/meta-bench-ec2-max-uptime"
LOG_FILE="/var/log/ec2-max-uptime-shutdown.log"

install -d -m 0755 "$INSTALL_DIR"
install -m 0755 "$SCRIPT_DIR/ec2-max-uptime-shutdown.sh" "$SHUTDOWN_SCRIPT"

cat >"$BOOT_SCRIPT" <<EOF
#!/usr/bin/env bash
# 起動直後に ${MAX_UPTIME_SECONDS}s 後のシャットダウンを予約（cron 抜け道対策の二重化）
set -euo pipefail
MAX_UPTIME_SECONDS=${MAX_UPTIME_SECONDS}
LOG_FILE=${LOG_FILE}
log() { echo "\$(date -Is) [ec2-max-uptime-boot] \$*" | tee -a "\$LOG_FILE"; }
minutes=\$(( (MAX_UPTIME_SECONDS + 59) / 60 ))
log "scheduling shutdown in \${minutes} minute(s) (max uptime \${MAX_UPTIME_SECONDS}s)"
/sbin/shutdown -c 2>/dev/null || true
/sbin/shutdown -h +\${minutes} "ec2-max-uptime: auto stop after \${MAX_UPTIME_SECONDS}s"
EOF
chmod 0755 "$BOOT_SCRIPT"

touch "$LOG_FILE"
chmod 0644 "$LOG_FILE"

cat >"$CRON_FILE" <<EOF
# meta-bench-r1 EC2 Runner: 起動から ${MAX_UPTIME_SECONDS}s 超過で強制停止（毎分チェック）
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

* * * * * root MAX_UPTIME_SECONDS=${MAX_UPTIME_SECONDS} LOG_FILE=${LOG_FILE} ${SHUTDOWN_SCRIPT} >/dev/null 2>&1
@reboot root ${BOOT_SCRIPT} >/dev/null 2>&1
EOF
chmod 0644 "$CRON_FILE"

# 既に1時間超えている場合は即停止
MAX_UPTIME_SECONDS="$MAX_UPTIME_SECONDS" LOG_FILE="$LOG_FILE" "$SHUTDOWN_SCRIPT" || true

# 今からの上限も予約
"$BOOT_SCRIPT"

echo "Installed:"
echo "  shutdown check: ${SHUTDOWN_SCRIPT}"
echo "  boot schedule:  ${BOOT_SCRIPT}"
echo "  cron:           ${CRON_FILE}"
echo "  log:            ${LOG_FILE}"
echo "  max uptime:     ${MAX_UPTIME_SECONDS}s"
echo ""
echo "確認:"
echo "  sudo tail -f ${LOG_FILE}"
echo "  cat ${CRON_FILE}"

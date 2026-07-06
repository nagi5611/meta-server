#!/usr/bin/env bash
# addons/time-machine/scripts/rollback-exec.sh — stop → restore → start
set -euo pipefail

PLAN_PATH="${1:-}"
if [[ -z "$PLAN_PATH" || ! -f "$PLAN_PATH" ]]; then
    echo "[time-machine-rollback] plan file missing: $PLAN_PATH" >&2
    exit 1
fi

SERVICE=$(node -e "const p=require('fs').readFileSync(process.argv[1],'utf8'); console.log(JSON.parse(p).systemdServiceName||'metaverse-simple')" "$PLAN_PATH")

echo "[time-machine-rollback] stopping $SERVICE"
systemctl stop "$SERVICE" || true
sleep 2

node -e "
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const plan = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));

function restoreDbBackups(fromDir, toDir, recursive) {
  if (!fs.existsSync(fromDir)) return;
  fs.mkdirSync(toDir, { recursive: true });
  for (const ent of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const srcPath = path.join(fromDir, ent.name);
    if (ent.isDirectory()) {
      if (recursive) restoreDbBackups(srcPath, path.join(toDir, ent.name), true);
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith('.bak')) continue;
    const base = ent.name.replace(/\\.bak\$/, '');
    const destPath = path.join(toDir, base);
    fs.copyFileSync(srcPath, destPath);
    console.log('[time-machine-rollback] db', srcPath, '->', destPath);
  }
}

for (const item of plan.copies || []) {
  const { from, to, type } = item;
  if (!fs.existsSync(from)) {
    console.warn('[time-machine-rollback] skip missing:', from);
    continue;
  }
  if (fs.statSync(from).isFile()) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    console.log('[time-machine-rollback] file', from, '->', to);
    continue;
  }
  if (type === 'db') {
    const recursive = from.replace(/\\\\/g, '/').includes('plugin-databases');
    restoreDbBackups(from, to, recursive);
    continue;
  }
  fs.mkdirSync(to, { recursive: true });
  const rsync = spawnSync('rsync', ['-a', '--delete', from.replace(/\\\\/g,'/') + '/', to.replace(/\\\\/g,'/') + '/'], { stdio: 'inherit' });
  if (rsync.status !== 0) {
    console.error('[time-machine-rollback] rsync failed', from, '->', to);
    process.exit(rsync.status || 1);
  }
  console.log('[time-machine-rollback] restored', from, '->', to);
}
" "$PLAN_PATH"

echo "[time-machine-rollback] starting $SERVICE"
systemctl start "$SERVICE"

echo "[time-machine-rollback] done"

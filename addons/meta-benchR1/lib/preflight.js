// addons/meta-benchR1/lib/preflight.js — ベンチ開始前チェック P-01〜P-07
import fs from 'node:fs';
import path from 'node:path';
import { getAddonCatalogSnapshot } from '../../../lib/plugin-bootstrap.js';
import { isBenchMaintenance, isMediasoupReady } from '../../../lib/bench-maintenance.js';
import { getRunnerStatus, isRunnerConnected } from './runner-registry.js';

const PLUGIN_ID = 'meta-benchR1';
const MIN_REPORT_BYTES = 50 * 1024 * 1024;

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.reportsDir
 * @param {number} opts.botCount
 * @param {boolean} opts.hasActiveRun
 */
export function runPreflightChecks(opts) {
    const { db, reportsDir, botCount, hasActiveRun } = opts;
    /** @type {string[]} */
    const failures = [];

    if (!isRunnerConnected(30_000)) {
        failures.push('Bench Runner が未接続、または最終 heartbeat が 30 秒を超えています。');
    }

    if (hasActiveRun) {
        failures.push('別のベンチ run が実行中です。完了または中止してから再試行してください。');
    }

    if (isBenchMaintenance()) {
        failures.push('既にベンチメンテナンスモードが ON です。前回 run のクリーンアップを確認してください。');
    }

    try {
        const parent = path.dirname(reportsDir);
        if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
        if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
        const st = fs.statfsSync ? fs.statfsSync(reportsDir) : null;
        if (st && typeof st.bfree === 'number' && typeof st.bsize === 'number') {
            const freeBytes = st.bfree * st.bsize;
            if (freeBytes < MIN_REPORT_BYTES) {
                failures.push(`レポート保存先の空き容量が不足しています（最低 50 MB 必要）。`);
            }
        }
    } catch {
        failures.push('レポート保存先を確認できませんでした。');
    }

    if (!isMediasoupReady()) {
        failures.push('mediasoup / VC 系が起動していません。サーバログを確認してください。');
    }

    const runner = getRunnerStatus();
    if (runner.recommendedMaxBots != null && botCount > runner.recommendedMaxBots) {
        failures.push(
            `bot 数 ${botCount} が Runner の推奨 max ${runner.recommendedMaxBots} を超えています。`
        );
    }

    const catalog = getAddonCatalogSnapshot();
    const loaded = catalog.addons.filter((a) => a.enabled && a.manifestOk && a.engineOk !== false);
    const loadedIds = loaded.map((a) => a.id);
    if (loadedIds.length !== 1 || loadedIds[0] !== PLUGIN_ID) {
        failures.push(
            `読み込み addon が meta-benchR1 のみではありません（現在: ${loadedIds.join(', ') || 'なし'}）。` +
                ' 他 addon を無効化し、Node プロセスを再起動してください。'
        );
    }

    if (db) {
        try {
            db.prepare('SELECT 1').get();
        } catch {
            failures.push('ベンチ用 DB に接続できません。');
        }
    }

    return { ok: failures.length === 0, failures };
}

// addons/meta-bench-r1/lib/preflight.js — ベンチ開始前チェック P-01〜P-06
import fs from 'node:fs';
import path from 'node:path';
import { isBenchMaintenance, isMediasoupReady } from '../../../lib/bench-maintenance.js';
import {
    getRunnerStatusByName,
    isRunnerConnected,
    listRunners,
} from './runner-registry.js';
import { normalizeBenchPhases } from './bench-phases.js';
const MIN_REPORT_BYTES = 50 * 1024 * 1024;

/**
 * @param {object} opts
 * @param {import('better-sqlite3').Database} opts.db
 * @param {string} opts.reportsDir
 * @param {number} opts.botCount
 * @param {boolean} opts.hasActiveRun
 * @param {string} [opts.runnerName]
 * @param {string[]} [opts.phases]
 */
export function runPreflightChecks(opts) {
    const { db, reportsDir, botCount, hasActiveRun } = opts;
    const phases = normalizeBenchPhases(opts.phases);
    const runnerName = typeof opts.runnerName === 'string' ? opts.runnerName.trim() : '';
    /** @type {string[]} */
    const failures = [];

    if (!runnerName) {
        failures.push('実行する Bench Runner を選択してください。');
    } else {
        const runner = getRunnerStatusByName(runnerName);
        if (!runner) {
            failures.push(`Bench Runner「${runnerName}」が登録されていません。`);
        } else if (!isRunnerConnected(runnerName, 30_000)) {
            failures.push(
                `Bench Runner「${runnerName}」が未接続、または最終 heartbeat が 30 秒を超えています。`
            );
        } else if (!runner.socketConnected) {
            failures.push(
                `Bench Runner「${runnerName}」の Socket.IO が未接続です。Runner ログで connect_error を確認してください。`
            );
        } else if (runner.recommendedMaxBots != null && botCount > runner.recommendedMaxBots) {
            failures.push(
                `bot 数 ${botCount} が Runner「${runnerName}」の推奨 max ${runner.recommendedMaxBots} を超えています。`
            );
        }
    }

    if (listRunners().length === 0) {
        failures.push('Bench Runner が 1 台も登録されていません。手元 PC で runner/serve.js を起動してください。');
    }

    if (phases.length === 0) {
        failures.push('実行するチェック項目を 1 つ以上選択してください。');
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

    const needsMediasoup = phases.includes('audio-vc');
    if (needsMediasoup && !isMediasoupReady()) {
        failures.push('mediasoup / VC 系が起動していません。サーバログを確認してください。');
    }

    if (db) {
        try {
            db.prepare('SELECT 1').get();
        } catch {
            failures.push('ベンチ用 DB に接続できません。');
        }
    }

    return { ok: failures.length === 0, failures, phases };
}

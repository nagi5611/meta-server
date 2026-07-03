// lib/bench-tick-metrics.js — players-update tick 実測（meta-benchR1 用）
import { isBenchMaintenance } from './bench-maintenance.js';

const TICK_INTERVAL_MS = 33;
const THEORETICAL_MAX_TPS = 1000 / TICK_INTERVAL_MS;
const PERIODIC_LOG_MS = 10_000;

/** @type {Map<string, number>} roomId -> emit count in current second bucket */
const roomTickCounts = new Map();
/** @type {Map<string, number[]>} roomId -> last N seconds tick/s samples */
const roomTickHistory = new Map();

let bucketStartMs = Date.now();
let sampling = false;
let activeRunId = null;
let totalHookCalls = 0;
let totalRecordedEmits = 0;
let skippedNotSampling = 0;
let hookInstalled = false;
/** @type {ReturnType<typeof setInterval> | null} */
let periodicLogTimer = null;

/**
 * @returns {boolean}
 */
function isVerboseTickLog() {
    const v = process.env.BENCH_TICK_DEBUG;
    return v === '1' || v === 'true';
}

/**
 * @param {string} msg
 * @param {unknown} [data]
 */
function tickLog(msg, data) {
    if (data !== undefined) {
        console.log(`[bench-tick] ${msg}`, data);
    } else {
        console.log(`[bench-tick] ${msg}`);
    }
}

/**
 * @returns {object}
 */
function getInternalDebugState() {
    let secondsSampled = 0;
    for (const hist of roomTickHistory.values()) {
        if (hist.length) secondsSampled = Math.max(secondsSampled, hist.length);
    }
    return {
        pid: process.pid,
        activeRunId,
        hookInstalled,
        sampling,
        maintenanceActive: isBenchMaintenance(),
        totalHookCalls,
        totalRecordedEmits,
        skippedNotSampling,
        roomHistoryCount: roomTickHistory.size,
        secondsSampled,
        verbose: isVerboseTickLog(),
    };
}

/**
 * server.js の setInterval 登録後に 1 回呼ぶ（フック有無の診断用）
 */
export function registerTickHookInstalled() {
    hookInstalled = true;
    tickLog('hook-installed', { pid: process.pid });
}

/**
 * ベンチ run 開始時に呼ぶ
 * @param {string} [runId]
 */
export function startTickSampling(runId) {
    sampling = true;
    activeRunId = runId ? String(runId) : null;
    totalHookCalls = 0;
    totalRecordedEmits = 0;
    skippedNotSampling = 0;
    roomTickCounts.clear();
    roomTickHistory.clear();
    bucketStartMs = Date.now();

    if (periodicLogTimer) clearInterval(periodicLogTimer);
    periodicLogTimer = setInterval(() => {
        if (!sampling) return;
        tickLog('periodic', getInternalDebugState());
    }, PERIODIC_LOG_MS);

    tickLog('start', getInternalDebugState());
}

/**
 * ベンチ run 終了時に呼ぶ
 */
export function stopTickSampling() {
    if (periodicLogTimer) {
        clearInterval(periodicLogTimer);
        periodicLogTimer = null;
    }
    const finalState = getInternalDebugState();
    tickLog('stop', finalState);

    sampling = false;
    activeRunId = null;
    totalHookCalls = 0;
    totalRecordedEmits = 0;
    skippedNotSampling = 0;
    roomTickCounts.clear();
    roomTickHistory.clear();
}

/**
 * players-update emit 時に server.js から呼ぶ
 * @param {string} roomId
 */
export function recordTickEmit(roomId) {
    totalHookCalls++;
    if (!sampling) {
        skippedNotSampling++;
        if (isVerboseTickLog() && skippedNotSampling <= 5) {
            tickLog('skip-not-sampling', { roomId, skippedNotSampling, totalHookCalls });
        }
        return;
    }
    totalRecordedEmits++;
    const rid = String(roomId || 'default');
    const now = Date.now();
    if (now - bucketStartMs >= 1000) {
        flushTickBucket();
        bucketStartMs = now;
    }
    roomTickCounts.set(rid, (roomTickCounts.get(rid) || 0) + 1);
}

/**
 * 1 秒バケットを履歴へ反映
 */
function flushTickBucket() {
    for (const [roomId, count] of roomTickCounts.entries()) {
        if (!roomTickHistory.has(roomId)) roomTickHistory.set(roomId, []);
        const hist = roomTickHistory.get(roomId);
        hist.push(count);
        if (hist.length > 120) hist.shift();
    }
    roomTickCounts.clear();
}

/**
 * @returns {number}
 */
export function getTheoreticalMaxTps() {
    return THEORETICAL_MAX_TPS;
}

/**
 * TPS=0 時の人間向け診断文
 * @param {object} [debug]
 * @param {Record<string, number>} [byRoom]
 * @returns {string}
 */
export function diagnoseTickMetrics(debug, byRoom = {}) {
    if (!debug) {
        return 'デバッグ情報なし。サーバーが古いコードの可能性があります（lib/bench-tick-metrics.js を更新して再起動してください）。';
    }
    if (!debug.hookInstalled) {
        return 'server.js に TPS 計測フックが未登録です。recordTickEmit の import と setInterval 内呼び出しを確認し、サーバーを再起動してください。';
    }
    if (debug.totalHookCalls === 0) {
        return 'players-update が 1 回も emit されていません。全ルームが空か、tick ループが停止している可能性があります。';
    }
    if (debug.totalRecordedEmits === 0 && debug.skippedNotSampling > 0) {
        return (
            `recordTickEmit は ${debug.totalHookCalls} 回呼ばれましたが、 sampling=false のため全て無視されました。` +
            ` ベンチ開始プロセス (pid=${debug.pid}) と Socket 接続先が別 Node プロセスの可能性があります（ロードバランサ・複数 start:prod 起動を確認）。`
        );
    }
    if (debug.totalRecordedEmits > 0 && Object.keys(byRoom).length === 0) {
        return 'emit は記録されたが秒次履歴が空です。計測ウィンドウが極端に短いか、内部集計の不具合の可能性があります。';
    }
    return '原因不明。BENCH_TICK_DEBUG=1 でサーバーを再起動し、次回ベンチの [bench-tick] ログを確認してください。';
}

/**
 * 全ルームの実測 tick/s（各ルームの秒次平均のうち最小 = スコア用 worst-room 平均）
 * @returns {{ avgTickPerSec: number, minTickPerSec: number, byRoom: Record<string, number>, byRoomMin: Record<string, number>, debug: object, diagnosis?: string }}
 */
export function getTickMetricsSnapshot() {
    flushTickBucket();
    /** @type {Record<string, number>} */
    const byRoom = {};
    /** @type {Record<string, number>} */
    const byRoomMin = {};
    let avgTickPerSec = THEORETICAL_MAX_TPS;
    let minTickPerSec = THEORETICAL_MAX_TPS;
    let secondsSampled = 0;

    for (const [roomId, hist] of roomTickHistory.entries()) {
        if (!hist.length) continue;
        secondsSampled = Math.max(secondsSampled, hist.length);
        const roomAvg = hist.reduce((sum, n) => sum + n, 0) / hist.length;
        const roomMin = Math.min(...hist);
        byRoom[roomId] = Math.round(roomAvg * 10) / 10;
        byRoomMin[roomId] = roomMin;
        if (roomAvg < avgTickPerSec) avgTickPerSec = roomAvg;
        if (roomMin < minTickPerSec) minTickPerSec = roomMin;
    }

    if (Object.keys(byRoom).length === 0) {
        avgTickPerSec = 0;
        minTickPerSec = 0;
    } else {
        avgTickPerSec = Math.round(avgTickPerSec * 10) / 10;
    }

    const debug = {
        ...getInternalDebugState(),
        secondsSampled,
        byRoomKeys: Object.keys(byRoom),
        byRoomMin,
    };

    const snap = {
        avgTickPerSec,
        minTickPerSec,
        byRoom,
        byRoomMin,
        debug,
        diagnosis: avgTickPerSec <= 0 ? diagnoseTickMetrics(debug, byRoom) : undefined,
    };

    tickLog('snapshot', snap);
    return snap;
}

// lib/bench-tick-metrics.js — players-update tick 実測（meta-benchR1 用）
import { isBenchMaintenance } from './bench-maintenance.js';

const TICK_INTERVAL_MS = 33;
const THEORETICAL_MAX_TPS = 1000 / TICK_INTERVAL_MS;

/** @type {Map<string, number>} roomId -> emit count in current second bucket */
const roomTickCounts = new Map();
/** @type {Map<string, number[]>} roomId -> last N seconds tick/s samples */
const roomTickHistory = new Map();

let bucketStartMs = Date.now();
let sampling = false;

/**
 * ベンチ run 開始時に呼ぶ
 */
export function startTickSampling() {
    sampling = true;
    roomTickCounts.clear();
    roomTickHistory.clear();
    bucketStartMs = Date.now();
}

/**
 * ベンチ run 終了時に呼ぶ
 */
export function stopTickSampling() {
    sampling = false;
    roomTickCounts.clear();
    roomTickHistory.clear();
}

/**
 * players-update emit 時に server.js から呼ぶ
 * @param {string} roomId
 */
export function recordTickEmit(roomId) {
    if (!sampling || !isBenchMaintenance()) return;
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
 * 全ルームの直近実測 tick/s（最小値 = 最悪ルーム）
 * @returns {{ minTickPerSec: number, byRoom: Record<string, number> }}
 */
export function getTickMetricsSnapshot() {
    flushTickBucket();
    /** @type {Record<string, number>} */
    const byRoom = {};
    let minTickPerSec = THEORETICAL_MAX_TPS;

    for (const [roomId, hist] of roomTickHistory.entries()) {
        if (!hist.length) continue;
        const last = hist[hist.length - 1];
        byRoom[roomId] = last;
        if (last < minTickPerSec) minTickPerSec = last;
    }

    if (Object.keys(byRoom).length === 0) {
        minTickPerSec = 0;
    }

    return { minTickPerSec, byRoom };
}

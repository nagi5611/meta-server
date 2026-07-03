// addons/meta-bench-r1/lib/runner-registry.js — Bench Runner 登録状態（複数台・メモリ）

/**
 * @typedef {{
 *   name: string,
 *   socketId: string | null,
 *   lastHeartbeatAt: number,
 *   recommendedMaxBots: number,
 *   hostInfo?: object | null,
 * }} RunnerEntry
 */

/** @type {Map<string, RunnerEntry>} */
const runners = new Map();

/** @type {{ code: string, expiresAt: number } | null} */
let pairingCode = null;

/**
 * @param {string} name
 * @returns {string}
 */
function runnerKey(name) {
    const n = String(name || 'runner').trim();
    return (n || 'runner').toLowerCase();
}

/**
 * @param {RunnerEntry} entry
 * @param {number} [maxAgeMs]
 */
function isEntryLive(entry, maxAgeMs = 30_000) {
    return Date.now() - entry.lastHeartbeatAt <= maxAgeMs;
}

/**
 * @param {{ name: string, recommendedMaxBots?: number, socketId?: string | null, hostInfo?: object | null }} info
 */
export function registerRunner(info) {
    const displayName = String(info.name || 'runner').trim() || 'runner';
    const key = runnerKey(displayName);
    const prev = runners.get(key);
    runners.set(key, {
        name: displayName,
        socketId: info.socketId ?? prev?.socketId ?? null,
        lastHeartbeatAt: Date.now(),
        recommendedMaxBots:
            typeof info.recommendedMaxBots === 'number' && info.recommendedMaxBots > 0
                ? Math.floor(info.recommendedMaxBots)
                : (prev?.recommendedMaxBots ?? 50),
        hostInfo:
            info.hostInfo && typeof info.hostInfo === 'object'
                ? { ...info.hostInfo }
                : (prev?.hostInfo ?? null),
    });
}

/**
 * @param {string} name
 * @param {string} socketId
 * @returns {boolean}
 */
export function attachRunnerSocket(name, socketId) {
    const key = runnerKey(name);
    const entry = runners.get(key);
    if (!entry) return false;
    entry.socketId = socketId;
    entry.lastHeartbeatAt = Date.now();
    return true;
}

/**
 * @param {string} socketId
 */
export function detachRunnerSocket(socketId) {
    for (const entry of runners.values()) {
        if (entry.socketId === socketId) {
            entry.socketId = null;
        }
    }
}

/**
 * @param {string} [name]
 * @returns {boolean}
 */
export function heartbeatRunner(name) {
    if (name) {
        const entry = runners.get(runnerKey(name));
        if (!entry) return false;
        entry.lastHeartbeatAt = Date.now();
        return true;
    }
    // 後方互換: 名前なしは唯一の Runner に heartbeat
    if (runners.size === 1) {
        const entry = runners.values().next().value;
        if (entry) {
            entry.lastHeartbeatAt = Date.now();
            return true;
        }
    }
    return false;
}

export function clearRunners() {
    runners.clear();
}

/**
 * @param {string} name
 * @returns {RunnerEntry | null}
 */
export function getRunnerByName(name) {
    return runners.get(runnerKey(name)) ?? null;
}

/**
 * @param {number} [maxAgeMs]
 * @returns {object[]}
 */
export function listRunners(maxAgeMs = 30_000) {
    return Array.from(runners.values()).map((entry) => {
        const heartbeatOk = isEntryLive(entry, maxAgeMs);
        const socketOk = heartbeatOk && !!entry.socketId;
        return {
            name: entry.name,
            connected: heartbeatOk,
            socketConnected: socketOk,
            lastHeartbeatAt: entry.lastHeartbeatAt,
            recommendedMaxBots: entry.recommendedMaxBots,
            socketId: entry.socketId,
        };
    });
}

/**
 * @param {string} name
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
export function isRunnerConnected(name, maxAgeMs = 30_000) {
    const entry = getRunnerByName(name);
    if (!entry) return false;
    return isEntryLive(entry, maxAgeMs);
}

/**
 * 後方互換: 最初の接続済み Runner、なければ先頭
 * @returns {object}
 */
export function getRunnerStatus() {
    const list = listRunners();
    if (!list.length) {
        return {
            connected: false,
            socketConnected: false,
            name: null,
            lastHeartbeatAt: null,
            recommendedMaxBots: null,
            socketId: null,
        };
    }
    const picked = list.find((r) => r.socketConnected) || list.find((r) => r.connected) || list[0];
    return picked;
}

/**
 * @param {string} name
 * @param {number} [maxAgeMs]
 * @returns {object | null}
 */
export function getRunnerStatusByName(name, maxAgeMs = 30_000) {
    const entry = getRunnerByName(name);
    if (!entry) return null;
    const heartbeatOk = isEntryLive(entry, maxAgeMs);
    return {
        name: entry.name,
        connected: heartbeatOk,
        socketConnected: heartbeatOk && !!entry.socketId,
        lastHeartbeatAt: entry.lastHeartbeatAt,
        recommendedMaxBots: entry.recommendedMaxBots,
        socketId: entry.socketId,
        hostInfo: entry.hostInfo ?? null,
    };
}

/**
 * レポート用 Runner スナップショット
 * @param {string} [name]
 * @returns {object | null}
 */
export function buildRunnerReportInfo(name) {
    const entry = name ? getRunnerByName(name) : null;
    if (!entry) {
        const n = String(name || '').trim();
        return n ? { name: n, missing: true } : null;
    }
    const hi = entry.hostInfo && typeof entry.hostInfo === 'object' ? entry.hostInfo : {};
    return {
        name: entry.name,
        recommendedMaxBots: entry.recommendedMaxBots,
        hostname: hi.hostname,
        cpuModel: hi.cpuModel,
        cpuCores: hi.cpuCores,
        totalMemGb: hi.totalMemGb,
        platform: hi.platform,
        nodeVersion: hi.nodeVersion,
        arch: hi.arch,
        mediasoupMode: hi.mediasoupMode,
        collectedAt: hi.collectedAt,
    };
}

/**
 * @returns {string}
 */
export function createPairingCode() {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    pairingCode = { code, expiresAt: Date.now() + 10 * 60 * 1000 };
    return code;
}

/**
 * @returns {{ code: string, expiresAt: number } | null}
 */
export function getPairingCode() {
    if (!pairingCode || Date.now() >= pairingCode.expiresAt) return null;
    return { ...pairingCode };
}

/**
 * @param {string} code
 * @returns {boolean}
 */
export function consumePairingCode(code) {
    if (!pairingCode || Date.now() >= pairingCode.expiresAt) return false;
    if (pairingCode.code !== String(code || '').trim()) return false;
    pairingCode = null;
    return true;
}

/**
 * @param {string} secret
 * @param {string} expected
 * @returns {boolean}
 */
export function safeEqualSecret(secret, expected) {
    if (typeof secret !== 'string' || typeof expected !== 'string') return false;
    if (secret.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
}

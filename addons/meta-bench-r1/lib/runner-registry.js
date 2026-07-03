// addons/meta-benchR1/lib/runner-registry.js — Bench Runner 登録状態（メモリ）

/** @type {{ name: string, socketId: string | null, lastHeartbeatAt: number, recommendedMaxBots: number, pairingUsed: boolean } | null} */
let activeRunner = null;

/** @type {{ code: string, expiresAt: number } | null} */
let pairingCode = null;

/**
 * @param {{ name: string, recommendedMaxBots?: number, socketId?: string | null }} info
 */
export function registerRunner(info) {
    activeRunner = {
        name: String(info.name || 'runner'),
        socketId: info.socketId ?? null,
        lastHeartbeatAt: Date.now(),
        recommendedMaxBots:
            typeof info.recommendedMaxBots === 'number' && info.recommendedMaxBots > 0
                ? Math.floor(info.recommendedMaxBots)
                : 50,
        pairingUsed: true,
    };
}

/**
 * @param {string} socketId
 */
export function attachRunnerSocket(socketId) {
    if (!activeRunner) return;
    activeRunner.socketId = socketId;
    activeRunner.lastHeartbeatAt = Date.now();
}

export function heartbeatRunner() {
    if (!activeRunner) return false;
    activeRunner.lastHeartbeatAt = Date.now();
    return true;
}

export function clearRunner() {
    activeRunner = null;
}

/**
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
export function isRunnerConnected(maxAgeMs = 30_000) {
    if (!activeRunner) return false;
    return Date.now() - activeRunner.lastHeartbeatAt <= maxAgeMs;
}

/**
 * @returns {object | null}
 */
export function getRunnerStatus() {
    if (!activeRunner) {
        return { connected: false, name: null, lastHeartbeatAt: null, recommendedMaxBots: null };
    }
    return {
        connected: isRunnerConnected(),
        name: activeRunner.name,
        lastHeartbeatAt: activeRunner.lastHeartbeatAt,
        recommendedMaxBots: activeRunner.recommendedMaxBots,
        socketId: activeRunner.socketId,
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

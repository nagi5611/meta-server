// lib/bench-maintenance.js — ベンチメンテナンスモード・benchToken（meta-benchR1 用）
import crypto from 'node:crypto';

const BENCH_TOKEN_VERSION = 1;
/** ベンチ所要 + 5 分（要件 D-09） */
export const BENCH_TOKEN_DEFAULT_TTL_MS = 11 * 60 * 1000;

export const BENCH_MAINTENANCE_CODE = 'BENCH_MAINTENANCE';
export const BENCH_MAINTENANCE_MESSAGE =
    '現在ベンチマーク実行中のため接続できません。しばらくしてから再度お試しください。';

let benchActive = false;
let activeRunId = null;

/** @type {() => boolean} */
let mediasoupReadyChecker = () => false;

let cachedBenchSecret = null;
let warnedBenchEphemeral = false;

/**
 * @returns {string}
 */
function getBenchSecret() {
    if (cachedBenchSecret != null) return cachedBenchSecret;
    const fromEnv = String(process.env.BENCH_TOKEN_SECRET || process.env.SOCKET_AUTH_SECRET || '').trim();
    if (fromEnv.length > 0) {
        cachedBenchSecret = fromEnv;
        return cachedBenchSecret;
    }
    cachedBenchSecret = crypto.randomBytes(32).toString('hex');
    if (!warnedBenchEphemeral) {
        warnedBenchEphemeral = true;
        console.warn(
            '[bench] BENCH_TOKEN_SECRET unset; using ephemeral secret (restart invalidates bench tokens).'
        );
    }
    return cachedBenchSecret;
}

/**
 * @param {Buffer} buf
 * @returns {string}
 */
function toBase64Url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

/**
 * @param {string} s
 * @returns {Buffer}
 */
function fromBase64Url(s) {
    const pad = 4 - (s.length % 4);
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + (pad < 4 ? '='.repeat(pad) : '');
    return Buffer.from(b64, 'base64');
}

/**
 * @returns {boolean}
 */
export function isBenchMaintenance() {
    return benchActive;
}

/**
 * @returns {string | null}
 */
export function getActiveBenchRunId() {
    return activeRunId;
}

/**
 * @param {() => boolean} fn
 */
export function setMediasoupReadyChecker(fn) {
    mediasoupReadyChecker = typeof fn === 'function' ? fn : () => false;
}

/**
 * @returns {boolean}
 */
export function isMediasoupReady() {
    return mediasoupReadyChecker();
}

/**
 * ベンチメンテナンス ON/OFF。ON 時は既存実ユーザーへ警告を 1 回 emit。
 * @param {{ active: boolean, runId?: string | null, io?: import('socket.io').Server }} opts
 */
export function setBenchMaintenance(opts) {
    const { active, runId = null, io = null } = opts;
    const wasActive = benchActive;
    benchActive = !!active;
    activeRunId = benchActive && runId ? String(runId) : null;

    if (benchActive && !wasActive && io) {
        for (const socket of io.sockets.sockets.values()) {
            if (socket.data?.isAdmin || socket.data?.isBenchBot) continue;
            socket.emit('bench-maintenance-warning', {
                message: '現在ベンチマーク実行中です。接続は維持されますが、性能に影響が出る場合があります。',
            });
        }
    }
}

/**
 * run 用 benchToken を発行する
 * @param {string} runId
 * @param {number} [ttlMs]
 * @returns {string}
 */
export function signBenchToken(runId, ttlMs = BENCH_TOKEN_DEFAULT_TTL_MS) {
    const rid = String(runId || '').trim();
    if (!rid) throw new Error('signBenchToken: runId required');
    const ttl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : BENCH_TOKEN_DEFAULT_TTL_MS;
    const payloadObj = { v: BENCH_TOKEN_VERSION, runId: rid, exp: Date.now() + ttl };
    const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payloadObj), 'utf8'));
    const sig = crypto.createHmac('sha256', getBenchSecret()).update(payloadB64).digest();
    return `${payloadB64}.${toBase64Url(sig)}`;
}

/**
 * @param {unknown} token
 * @returns {{ runId: string } | null}
 */
export function verifyBenchToken(token) {
    if (!token || typeof token !== 'string') return null;
    const dot = token.indexOf('.');
    if (dot < 1 || dot === token.length - 1) return null;
    const payloadB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    let sigBuf;
    try {
        sigBuf = fromBase64Url(sigB64);
    } catch {
        return null;
    }
    const expectedSig = crypto.createHmac('sha256', getBenchSecret()).update(payloadB64).digest();
    if (sigBuf.length !== expectedSig.length || !crypto.timingSafeEqual(sigBuf, expectedSig)) {
        return null;
    }
    let payloadObj;
    try {
        payloadObj = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
    } catch {
        return null;
    }
    if (!payloadObj || payloadObj.v !== BENCH_TOKEN_VERSION) return null;
    if (typeof payloadObj.exp !== 'number' || Date.now() >= payloadObj.exp) return null;
    if (typeof payloadObj.runId !== 'string' || !payloadObj.runId.trim()) return null;
    return { runId: payloadObj.runId };
}

/**
 * io.use 用（消費しない）
 * @param {unknown} token
 * @returns {boolean}
 */
export function peekBenchToken(token) {
    return verifyBenchToken(token) != null;
}

/**
 * Socket 接続ミドルウェア: ベンチ中は admin / benchToken のみ許可
 * @param {import('socket.io').Socket} socket
 * @param {(err?: Error) => void} next
 * @param {{ peekAdminToken: (t: unknown) => boolean, peekBenchRunnerSecret?: (auth: unknown) => boolean }} deps
 */
export function benchMaintenanceSocketMiddleware(socket, next, deps) {
    if (!benchActive) return next();

    const adminToken = socket.handshake.auth?.adminToken;
    if (deps.peekAdminToken(adminToken)) return next();

    const benchToken = socket.handshake.auth?.benchToken;
    if (peekBenchToken(benchToken)) return next();

    if (deps.peekBenchRunnerSecret?.(socket.handshake.auth)) return next();

    const err = new Error(BENCH_MAINTENANCE_MESSAGE);
    err.data = { code: BENCH_MAINTENANCE_CODE, message: BENCH_MAINTENANCE_MESSAGE };
    return next(err);
}

/**
 * 接続後に bench bot フラグを設定
 * @param {import('socket.io').Socket} socket
 */
export function applyBenchBotSocketData(socket) {
    const benchToken = socket.handshake.auth?.benchToken;
    const verified = verifyBenchToken(benchToken);
    if (verified) {
        socket.data.isBenchBot = true;
        socket.data.benchRunId = verified.runId;
    } else {
        socket.data.isBenchBot = false;
        socket.data.benchRunId = null;
    }
}

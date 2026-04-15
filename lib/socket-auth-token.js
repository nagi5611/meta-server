// lib/socket-auth-token.js — HMAC 署名付き Socket 接続用ロールトークン（依存なし）
import crypto from 'node:crypto';

const TOKEN_VERSION = 1;
/** 既定 TTL（ms）。ログインからこの期間内のみ Socket でロールを引き受ける（Cookie maxAge と一致） */
export const SOCKET_AUTH_TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let cachedSecret = null;
let warnedEphemeral = false;

/**
 * 署名用シークレットを返す。未設定時は起動ごとにランダム（開発用）。
 * @returns {string}
 */
function getSecret() {
    if (cachedSecret != null) return cachedSecret;
    const fromEnv = String(process.env.SOCKET_AUTH_SECRET || '').trim();
    if (fromEnv.length > 0) {
        cachedSecret = fromEnv;
        return cachedSecret;
    }
    cachedSecret = crypto.randomBytes(32).toString('hex');
    if (!warnedEphemeral) {
        warnedEphemeral = true;
        console.warn(
            '[socket-auth] SOCKET_AUTH_SECRET is unset; using ephemeral secret (restart invalidates all socket auth tokens). Set SOCKET_AUTH_SECRET in production.'
        );
    }
    return cachedSecret;
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
 * ログイン成功時に付与する Socket 用トークンを生成する
 * @param {{ role: 'student' | 'teacher', ttlMs?: number }} opts
 * @returns {string}
 */
export function signSocketAuthToken({ role, ttlMs } = {}) {
    if (role !== 'student' && role !== 'teacher') {
        throw new Error('signSocketAuthToken: invalid role');
    }
    const ttl = typeof ttlMs === 'number' && ttlMs > 0 ? ttlMs : SOCKET_AUTH_TOKEN_MAX_AGE_MS;
    const payloadObj = {
        v: TOKEN_VERSION,
        role,
        exp: Date.now() + ttl,
    };
    const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payloadObj), 'utf8'));
    const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
    return `${payloadB64}.${toBase64Url(sig)}`;
}

/**
 * Socket 接続時にトークンを検証し、有効ならロールを返す
 * @param {unknown} token
 * @returns {{ role: 'student' | 'teacher' } | null}
 */
export function verifySocketAuthToken(token) {
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
    const expectedSig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
    if (sigBuf.length !== expectedSig.length || !crypto.timingSafeEqual(sigBuf, expectedSig)) {
        return null;
    }
    let payloadObj;
    try {
        payloadObj = JSON.parse(fromBase64Url(payloadB64).toString('utf8'));
    } catch {
        return null;
    }
    if (!payloadObj || payloadObj.v !== TOKEN_VERSION) return null;
    if (typeof payloadObj.exp !== 'number' || Date.now() >= payloadObj.exp) return null;
    const role = payloadObj.role;
    if (role !== 'student' && role !== 'teacher') return null;
    return { role };
}

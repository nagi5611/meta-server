// lib/bench-runner-auth.js — Bench Runner の Socket.IO handshake 認証（addon が secret を登録）

/** @type {string} */
let expectedSecret = '';

/**
 * meta-bench-r1 addon 起動時に runnerSecret を登録する
 * @param {string} secret
 */
export function setBenchRunnerSecret(secret) {
    expectedSecret = typeof secret === 'string' ? secret : '';
}

/**
 * io.use 用: handshake.auth.runnerSecret を検証（消費しない）
 * @param {unknown} auth
 * @returns {boolean}
 */
export function peekBenchRunnerSecret(auth) {
    if (!expectedSecret || !auth || typeof auth !== 'object') return false;
    const secret = /** @type {{ runnerSecret?: unknown }} */ (auth).runnerSecret;
    if (typeof secret !== 'string') return false;
    if (secret.length !== expectedSecret.length) return false;
    let diff = 0;
    for (let i = 0; i < secret.length; i++) {
        diff |= secret.charCodeAt(i) ^ expectedSecret.charCodeAt(i);
    }
    return diff === 0;
}

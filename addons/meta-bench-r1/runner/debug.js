// addons/meta-bench-r1/runner/debug.js — Runner 共通ログ（--debug）

let debugEnabled = false;

/**
 * @param {boolean} enabled
 */
export function configureRunnerDebug(enabled) {
    debugEnabled = !!enabled;
}

/**
 * @returns {boolean}
 */
export function isRunnerDebug() {
    return debugEnabled;
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function runnerDebug(tag, ...args) {
    if (!debugEnabled) return;
    console.log(`[runner:debug:${tag}]`, ts(), ...args);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function runnerInfo(tag, ...args) {
    console.log(`[runner:${tag}]`, ts(), ...args);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function runnerWarn(tag, ...args) {
    console.warn(`[runner:warn:${tag}]`, ts(), ...args);
}

/**
 * @param {string} tag
 * @param {...unknown} args
 */
export function runnerError(tag, ...args) {
    console.error(`[runner:error:${tag}]`, ts(), ...args);
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function formatError(err) {
    if (err instanceof Error) {
        const parts = [err.message];
        if (err.cause) parts.push(`cause=${formatError(err.cause)}`);
        return parts.join(' | ');
    }
    return String(err);
}

/**
 * @param {string | undefined} secret
 */
export function maskSecret(secret) {
    if (!secret || typeof secret !== 'string') return '(none)';
    if (secret.length <= 4) return '****';
    return `${secret.slice(0, 2)}…${secret.slice(-2)} (${secret.length} chars)`;
}

/**
 * @returns {string}
 */
function ts() {
    return new Date().toISOString();
}
